#!/usr/bin/env node
// Drives the two new plates (PRECIPITATION/RESPONSE on a station, and ?rain) in
// a real headless Chrome over CDP — the recipe of .claude/domains/browser-verify.md:
// serve the worktree, Runtime + Log + Network enabled BEFORE navigating, wait
// for the loader, renderNow(), screenshot, then MEASURE through Runtime.evaluate.
// `--headless=new --screenshot` alone proves nothing here: scheduleRender() rides
// on rAF, which a headless page never serves.
//
// Needs the sandbox bypass (loopback bind + connect). `nrw/` in the worktree must
// hold the tree under test, with nrw/precip/ built by scripts/build-nrw-precip.mjs.
// nrw/hourly/lag.json is read too, for the RESPONSE plate's response class — but
// it is OPTIONAL here, because it is derived from `nrw-hires`, which no CI job
// mounts. Absent, its checks are skipped loudly and counted in the last line;
// present, they run and are anchored against the file rather than against a
// string this script also knows.
//   node scripts/verify-precip.mjs
//   LANUK_BASE_URL=https://bmmmm.github.io/pegel-visual/ node scripts/verify-precip.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, serve, chrome, session, checker, killChildren } from './lib/cdp.mjs';
import { parseArgs } from './lib/cli.mjs';

// the checkout this file lives in — a worktree runs its own copy, and a
// hardcoded path would send every worktree's run at the main checkout
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { opt } = parseArgs();
const SHOTS = resolve(opt('shots', join(ROOT, 'tmp-shots')));  // gitignored: pictures are evidence, not source
mkdirSync(SHOTS, { recursive: true });
const BASE_URL = process.env.LANUK_BASE_URL || null;
// A missing tree has to say WHAT is missing, and it must be RED rather than a
// quiet pass. This script reads the worktree's own nrw/, which only exists once
// the data branch is mounted there; an ENOENT on a shard 200 lines down reads
// like a broken product instead of a setup step nobody ran.
if (!BASE_URL && !existsSync(join(ROOT, 'nrw', 'precip', 'index.json'))) {
  console.error('FAIL: no nrw/precip/ in this checkout — mount the `nrw` data branch under ./nrw and run\n' +
    '      node scripts/build-nrw-precip.mjs --tree nrw\n' +
    '      (or point LANUK_BASE_URL at a deployed site). Refusing to pass without checking anything.');
  process.exit(1);
}
const manifest = BASE_URL
  ? await (await fetch(BASE_URL + 'nrw/manifest.json')).json()
  : JSON.parse(readFileSync(join(ROOT, 'nrw', 'manifest.json'), 'utf8'));
const overview = BASE_URL
  ? await (await fetch(BASE_URL + 'nrw/precip/overview.json')).json()
  : JSON.parse(readFileSync(join(ROOT, 'nrw', 'precip', 'overview.json'), 'utf8'));
// The hourly response class. Read here so every assertion below compares the
// plate against the PRODUCT rather than against a string this script also
// knows — which is what keeps a fixture from going stale as the window rolls.
//
// It may be ABSENT, and that is not a failure: unlike nrw/precip/, which this
// checkout rebuilds from the mounted tree, the lag is derived from `nrw-hires`,
// which no CI job mounts — so on a branch collected before the product existed
// (or a fork, or the run that first lands the code) the file is simply not
// there yet. The response-class checks are then SKIPPED, loudly, and the run
// says how many; every other check still runs. Once the collector has written
// it once, it is there every day and this branch never runs again.
const lagPath = join(ROOT, 'nrw', 'hourly', 'lag.json');
const lag = await (async () => {
  try {
    return BASE_URL
      ? await (await fetch(BASE_URL + 'nrw/hourly/lag.json')).json()
      : JSON.parse(readFileSync(lagPath, 'utf8'));
  } catch (e) {
    console.log(`::warning::no nrw/hourly/lag.json (${e.code || e.message}) — the RESPONSE plate's response-class checks are SKIPPED on this run. `
      + 'It is built by scripts/build-nrw-hourly-lag.mjs from BOTH data branches, so a branch collected before that existed does not carry it.');
    return null;
  }
})();
const classHours = ([lo, hi]) => (hi == null ? `${lo}+ h` : `${lo}–${hi} h`);
let lagSkipped = 0;
// Which branch of the class check runs is decided by the weather — today three
// fixtures carry a class and one does not. Both have to actually happen, or
// half these assertions go dark the day the window rolls and nobody is told.
const lagBranches = { withClass: 0, withoutClass: 0 };
console.log(`nrw: export ${manifest.sourceExportAt}, precip ${manifest.counts.precip} gauges; overview ${overview.window.from}…${overview.window.to}, bins ${overview.bins.join('/')}`);
console.log(lag
  ? `     hourly lag ${lag.window.from}…${lag.window.to}, ${lag.counts.published} published, classes ${lag.counts.byClass.join('/')} (${lag.rule.classes.map(classHours).join(', ')})`
  : '     hourly lag: ABSENT — response-class checks skipped');

const check = checker();

const STATION_READY = 'state.gauge && state.gauge.currentMeasurement && state.archive.length > 100 && state.precip';
const PAGES = [
  { q: '?station=MENDEN_1', ready: STATION_READY, name: 'menden', kind: 'station', no: '2729100000100' },
  { q: '?station=MENDEN_1&history=1y', ready: STATION_READY, name: 'menden-1y', kind: 'station', no: '2729100000100' },
  // One gauge per response class, so all three are DRAWN at least once rather
  // than only described in the key. The classes themselves are NOT pinned here:
  // the check reads lag.gauges[no] and asserts the plate agrees with it, so a
  // gauge that changes class as the window rolls stays a valid fixture. Pinning
  // "MONSCHAU is class 0" would be a fixture that goes red on the weather.
  { q: '?station=MONSCHAU', ready: STATION_READY, name: 'monschau', kind: 'station', no: '2821530000200' },
  { q: '?station=HALTERN', ready: STATION_READY, name: 'haltern', kind: 'station', no: '2789100000100' },
  // The two states that are NOT "a normal gauge with a normal set", picked
  // fresh for rule version 2 — under version 1 ARLOFF stood here as the gauge
  // with no product, and version 2 gave it one (its 15 km ring holds nine).
  // A fixture that quietly starts testing the ordinary case is worse than no
  // fixture: it stays green and covers nothing.
  //   LINNENKAMP  the ONE receiving gauge still without a product: three rain
  //               gauges in reach, one of which reports nothing at all
  //   OEDT        a set the knn floor built (local/knn/knn at 12.3/16.2/16.9
  //               km) — the thin-set caveat has to be on the plate, and the
  //               chart has to be there too
  { q: '?station=OEDT', ready: STATION_READY, name: 'oedt-floored', kind: 'station', thin: true, no: '2861700000100' },
  //   BETZDORF    a daily rain field but NO hourly series, so it is classless by
  //               STRUCTURE, not by weather. The "no response time" branch used
  //               to rest on OEDT alone, which sits three wet hours over the
  //               floor (76 against 76), a hundredth of r over the cut and a
  //               step over the BH threshold — the window rolls, OEDT gains a
  //               class, and CI goes red with no code change. That is the
  //               fixture the plan itself forbade; this one cannot move unless
  //               the SOURCE starts publishing hourly data for it.
  { q: '?station=BETZDORF', ready: STATION_READY, name: 'betzdorf-nohires', kind: 'station', no: '27200500' },
  { q: '?station=LINNENKAMP', ready: STATION_READY, name: 'linnenkamp-none', kind: 'station', noProduct: true, no: '3215510000100' },
  { q: '?station=BONN', ready: 'state.gauge && state.gauge.currentMeasurement', name: 'bonn-wsv', kind: 'wsv' },
  { q: '?rain', ready: 'state.rain && state.rain.data', name: 'rain-30', kind: 'rain' },
  { q: '?rain&w=90', ready: 'state.rain && state.rain.data', name: 'rain-90', kind: 'rain' },
];

// The measurement, in the page. Anchored to the elements it is about — a
// class-name grep over the whole document would match the legend's own swatches.
const MEASURE = `(() => {
  const el = s => document.querySelector(s);
  const all = s => [...document.querySelectorAll(s)];
  const txt = document.getElementById('screen').innerText;
  const out = { mode, station, error: state.error, title: document.title,
    scroll: { w: document.documentElement.scrollWidth, inner: window.innerWidth },
    sourceLine: (el('#source-line') || {}).textContent || '',
    // an off-origin mark scaled by transform instead of its own viewBox draws
    // an EMPTY 12px box, and no test can see that — only a real layout can
    // a horizontal <line> has zero HEIGHT and is still a visible mark, so the
    // test is "no extent in either direction", not "no extent in both"
    emptySwatches: all('.p-key .sw').filter(sw => {
      const r = sw.getBoundingClientRect();
      if (!r.width) return true;
      return [...sw.children].every(c => { const b = c.getBoundingClientRect(); return b.width < 0.5 && b.height < 0.5; });
    }).map(sw => (sw.parentElement.querySelector('.lgn') || {}).textContent || '?'),
    swatches: all('.p-key .sw').length,
    // nothing may stick out to the right of the viewport
    // .wave-wrap scrolls on purpose; the scene's cloud and boat DRIFT past the
    // right edge by design (a CSS keyframe on transform), and are clipped by the
    // SVG viewport — neither is an overflowing layout
    wide: all('#screen *').filter(e => e.checkVisibility && e.checkVisibility()
        && !e.closest('.wave-wrap') && !e.closest('.scene-wrap')
        && e.getBoundingClientRect().right > window.innerWidth + 1)
      .map(e => (e.getAttribute('class') || e.tagName) + '@' + Math.round(e.getBoundingClientRect().right)).slice(0, 6),
  };
  const chart = el('.chart.precip');
  if (chart) {
    const vm = precipViewModel();
    out.precip = {
      bars: chart.querySelectorAll('.pr-bar').length,
      expectBars: vm.cols.filter(c => c.mm != null && c.mm > 0).length,
      nd: chart.querySelectorAll('.pr-nd').length,
      expectNd: vm.cols.filter(c => c.mm == null).length,
      levelRuns: chart.querySelectorAll('.pr-level').length,
      sumPrinted: (txt.match(/Σ ([\\d.]+) mm/) || [])[1],
      sumVm: String(vm.sumMm),
      edgePrinted: (txt.match(/newest rain day, not today: (\\d{4}-\\d{2}-\\d{2})/) || [])[1],
      barHeights: [...chart.querySelectorAll('.pr-bar')].map(r => r.getBoundingClientRect().height).sort((a, b) => a - b),
      chartH: chart.getBoundingClientRect().height,
    };
  }
  const resp = el('.chart.response');
  if (resp) {
    out.response = {
      bars: resp.querySelectorAll('.rs-bar, .rs-neg').length,
      peak: resp.querySelectorAll('.rs-peak').length,
      minBarW: Math.min(...[...resp.querySelectorAll('.rs-bar, .rs-neg')].map(r => r.getBoundingClientRect().width)),
      sentence: (el('.resp-wrap') && el('.resp-wrap').parentElement.querySelector('.say') || {}).textContent || '',
    };
  }
  // THE RESPONSE PLATE'S OWN TEXT, anchored at the section that holds the
  // response chart — never at #screen and never at a bare .p-key, both of which
  // sweep in the precipitation plate's key three blocks up. The class sentence
  // gets its own class name (.rs-class) so it cannot be confused with the slope
  // sentence, which is also a .say.
  const respSection = [...document.querySelectorAll('#screen section.p-block')]
    .find(s => s.querySelector('.chart.response') || /^RESPONSE/.test((s.querySelector('.p-h2') || {}).textContent || ''));
  out.respPlate = respSection ? {
    key: [...respSection.querySelectorAll('.p-key dd')].map(e => e.textContent),
    cls: (respSection.querySelector('.rs-class') || {}).textContent || null,
    clsIsDim: !!respSection.querySelector('.p-dim.rs-class'),
    text: respSection.innerText,
  } : null;
  const table = el('table.heat.rain');
  if (table) {
    const vm = rainViewModel();
    const rows = [...table.querySelectorAll('tbody tr')];
    out.rain = {
      rows: rows.length, days: vm.days,
      cols: rows[0] ? rows[0].querySelectorAll('td').length : 0,
      links: table.querySelectorAll('th a[data-nav^="river:"]').length,
      nolink: table.querySelectorAll('th span.nolink').length,
      lastCellTitle: rows[0] ? rows[0].querySelectorAll('td')[vm.days - 1].getAttribute('title') : null,
      noLiveFeed: txt.includes('no live feed') || (el('#source-line') || {}).textContent.includes('no live feed'),
      sums: rows.map(r => r.querySelector('.rsum').textContent),
      wrapScrolls: (() => { const w = el('.rain-wrap'); return w ? { sw: w.scrollWidth, cw: w.clientWidth, left: w.scrollLeft } : null; })(),
      stickyName: rows[0] ? getComputedStyle(rows[0].querySelector('th')).position : null,
    };
  }
  out.precipRequests = 'see network';
  // THE PRECIPITATION PLATE'S OWN TEXT, anchored at the section that holds the
  // precip chart — not at #screen and not at a bare .p-key, both of which sweep in
  // the scene's key, the history plate's and the response plate's. A caveat
  // asserted against the whole page passes on any plate printing anything
  // similar, which is the failure the house rules name by name.
  const precipSection = [...document.querySelectorAll('#screen section.p-block')]
    .find(s => s.querySelector('.chart.precip') || /^PRECIPITATION/.test((s.querySelector('.p-h2') || {}).textContent || ''));
  // Every <dd> of the key, not only the .lgn labels: plateKey renders a
  // { note } entry as a bare <dd> with no .lgn inside it, and the caveats this
  // plate has to print are ALL notes. A first cut read .lgn and reported "the
  // retired wording is gone" against a list that could not contain it.
  out.precipPlate = precipSection ? {
    key: [...precipSection.querySelectorAll('.p-key dd')].map(e => e.textContent),
    dim: [...precipSection.querySelectorAll('.p-dim')].map(e => e.textContent),
    text: precipSection.innerText,
  } : null;
  return out;
})()`;

async function run(cdp, base, vp) {
  console.log(`\n== ${vp.name} (${vp.width}×${vp.height}${vp.mobile ? ', mobile, touch' : ''})`);
  for (const pg of PAGES) {
    const s = await session(cdp);
    try {
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      await s.send('Log.enable');
      await s.send('Network.enable');
      await s.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: !!vp.mobile });
      if (vp.mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await s.send('Page.navigate', { url: base + pg.q });
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) { await sleep(250); try { ready = !!(await s.evaluate(`!!(${pg.ready})`)); } catch { /* not booted yet */ } }
      await sleep(600);
      await s.evaluate('renderNow()');
      await sleep(300);
      const full = await s.evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })');
      const shot = await s.send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: full.w, height: Math.min(full.h, 6000), scale: 1 } });
      writeFileSync(join(SHOTS, `${vp.name}-${pg.name}.png`), Buffer.from(shot.data, 'base64'));
      const m = await s.evaluate(MEASURE);
      const precipReqs = s.events.responses.filter(r => r.url.includes('/nrw/precip/'));
      // `lag === null` is the branch that has not collected the hourly product
      // yet (the ::warning:: above). Its 404 is then the EXPECTED state, and
      // counting it here made the skip branch unreachable: the run failed on
      // the very absence it says it tolerates — so the first commit to land
      // this code would have failed its own page gate and blocked the deploy.
      // Narrow on purpose: any other 404 still fails, and once the file exists
      // `lag` is non-null and a 404 on it fails again.
      const lagAbsent = r => lag === null && r.url.includes('/nrw/hourly/lag.json');
      const bad = s.events.responses.filter(r => r.url.includes('/nrw/') && r.status >= 400 && !lagAbsent(r));
      console.log(`-- ${pg.name}: ${JSON.stringify({ mode: m.mode, error: m.error, title: m.title })}`);

      check(!m.error, `${pg.name}: no page error`, m.error || '');
      check(s.events.exceptions.length === 0, `${pg.name}: no uncaught exception`, s.events.exceptions.join(' | '));
      check(bad.length === 0, `${pg.name}: every /nrw/ response is 2xx`, bad.map(r => `${r.status} ${r.url}`).join(', '));
      check(m.emptySwatches.length === 0, `${pg.name}: no empty legend swatch (${m.swatches} drawn)`, m.emptySwatches.join(' | '));
      check(m.wide.length === 0, `${pg.name}: nothing sticks out to the right`, m.wide.join(', '));
      check(m.scroll.w <= m.scroll.inner + 1, `${pg.name}: the page does not scroll sideways`, `${m.scroll.w} > ${m.scroll.inner}`);

      if (pg.kind === 'station' && !pg.noProduct) {
        const p = m.precip;
        check(!!p, `${pg.name}: the precipitation chart is drawn`);
        if (p) {
          check(p.bars === p.expectBars, `${pg.name}: one bar per column with rain`, `${p.bars} drawn, ${p.expectBars} in the model`);
          check(p.nd === p.expectNd, `${pg.name}: one outline per no-data column`, `${p.nd} vs ${p.expectNd}`);
          check(p.sumPrinted === p.sumVm, `${pg.name}: the printed Σ is the drawn row's sum`, `${p.sumPrinted} vs ${p.sumVm}`);
          check(p.edgePrinted === overview.window.to, `${pg.name}: the key names the mirror's newest rain day`, `${p.edgePrinted} vs ${overview.window.to}`);
          check(p.barHeights.length === 0 || p.barHeights[p.barHeights.length - 1] > 4, `${pg.name}: the tallest bar is visible`, `max ${p.barHeights.at(-1)} px of ${p.chartH}`);
          check(p.levelRuns > 0, `${pg.name}: the level line is drawn`, String(p.levelRuns));
        }
        const r = m.response;
        check(!!r && r.bars === 8, `${pg.name}: eight response bars, lag 0 through 7`, r ? String(r.bars) : 'no chart');
        check(!!r && r.peak === 1, `${pg.name}: exactly one peak marker`, r ? String(r.peak) : '-');
        check(!!r && r.minBarW >= 8, `${pg.name}: every response bar is at least 8 px wide`, r ? `min ${r.minBarW.toFixed(1)}` : '-');
        check(!!r && /per 10 mm of rain around the gauge/.test(r.sentence), `${pg.name}: the slope sentence names its unit`, r ? r.sentence : '-');

        // ---- the third estimator: the hourly response class ----
        if (!lag) { lagSkipped++; } else {
        const k = (m.respPlate && m.respPlate.key) || [];
        const joined = k.join(' | ');
        // The plate rule: a section that cannot name its own marks does not
        // ship. There are three estimators on this plate now, and the key has
        // to keep them apart in one line each.
        check(/three estimators: the bars are Pearson r over DAYS.*the sentence is a slope.*the response time is a class measured on HOURLY data/.test(joined),
          `${pg.name}: the key names all THREE estimators, not two`, joined.slice(0, 300));
        // The class vocabulary, with the hour bounds taken from the FILE. A
        // check that spelled "2–8 h" out itself would stay green after the rule
        // moved and the plate went on printing the old span.
        const vocab = lag.rule.classes.map(classHours);
        check(vocab.every(v => joined.includes(v)),
          `${pg.name}: the key names every class with the file's own hour bounds (${vocab.join(', ')})`, joined.slice(0, 400));
        check(/measured on hourly data over a rolling window of \d+ days, ending \d{4}-\d{2}-\d{2}/.test(joined),
          `${pg.name}: and says the class comes off a different resolution and window`, joined.slice(0, 400));

        const want = lag.gauges[pg.no];
        const cls = (m.respPlate && m.respPlate.cls) || '';
        if (want != null) {
          lagBranches.withClass++;
          // The plate's class must be the PRODUCT's class for this gauge.
          check(!m.respPlate.clsIsDim && cls.includes(classHours(lag.rule.classes[want])),
            `${pg.name}: prints class ${want} = ${classHours(lag.rule.classes[want])}, as lag.json says`, cls || '(no class line)');
          // …and not one of the other two, which a lookup off by one would give
          const others = lag.rule.classes.filter((_, i) => i !== want).map(classHours);
          check(!others.some(o => cls.includes(o)),
            `${pg.name}: and names no OTHER class in the same sentence`, `${cls} vs ${others.join(', ')}`);
        } else {
          lagBranches.withoutClass++;
          check(m.respPlate.clsIsDim && /no response time for this gauge/.test(cls),
            `${pg.name}: has no class in lag.json, and the plate says so`, cls || '(no class line)');
          // the fleet split, with the file's own counts — so "no response time"
          // is a place in a distribution rather than a shrug
          const c = lag.counts;
          check(joined.includes(`${c.weak} rain explains too little`) && joined.includes(`${c.notInHires} no hourly series`),
            `${pg.name}: and names the fleet split with lag.json's own counts`, joined.slice(0, 400));
        }
        }
      }
      if (pg.noProduct) {
        check(!m.precip, `${pg.name}: no chart, because there is no product`);
        // The fleet-wide lag file is fetched on the station path, so a gauge the
        // manifest already said no to must not pull it either — the same "costs
        // no request" property the precip shards have.
        check(s.events.responses.filter(r => r.url.includes('/nrw/hourly/')).length === 0,
          `${pg.name}: and no hourly lag file was fetched for it`,
          s.events.responses.filter(r => r.url.includes('/nrw/hourly/')).map(r => r.url).join(', '));
        check(precipReqs.filter(r => !r.url.endsWith('overview.json')).length === 0,
          `${pg.name}: the manifest said no, so no /precip/ shard was fetched`, precipReqs.map(r => r.url).join(', '));
        // The COLLECTOR's own words, compared against the collector's own file —
        // not against a string this script also knows. A plate that invented a
        // plausible reason would pass a `/no product/` regex.
        const why = ((manifest.precip || {})[pg.no] || {}).why || '';
        check(!!why, `${pg.name}: the manifest carries a reason at all`, JSON.stringify((manifest.precip || {})[pg.no]));
        check(!!m.precipPlate && m.precipPlate.dim.some(t => t.trim() === why.trim()),
          `${pg.name}: the plate prints the collector's own reason, word for word`,
          `wanted "${why}" — plate has ${JSON.stringify(m.precipPlate && m.precipPlate.dim)}`);
      }
      if (pg.thin) {
        // A set the knn floor had to build is the weakest thing this product
        // ships, and the plate has to say so ON THE PLATE — anchored at the
        // precipitation section, not at #screen.
        const k = (m.precipPlate && m.precipPlate.key) || [];
        check(k.some(t => /thin set/.test(t)), `${pg.name}: the thin-set caveat is in the precipitation key`, k.join(' | ').slice(0, 300));
        check(k.some(t => /a rain field around the gauge — not areal rain over its catchment/.test(t)),
          `${pg.name}: the key names what the number IS — a field, not a catchment mean`, k.join(' | ').slice(0, 400));
        // The floor reaches PAST the 15 km the key promises (measured max 29.05
        // km on the mirror), so on a gauge it built, the key has to say so and
        // name the real distance. Without this the plate states a rule that is
        // false for exactly the 28 gauges that most need the caveat.
        check(k.some(t => /nothing lay within 15 km, so the nearest gauges stand in/.test(t)) &&
          k.some(t => /furthest \d/.test(t)),
        `${pg.name}: the key admits the floor fired, and names how far it reached`, k.join(' | ').slice(0, 500));
        // "…not areal rain over its catchment: 8 gauges over 300 km²" reads as
        // one sentence and undoes the denial. The area belongs on its own line.
        check(!k.some(t => /not areal rain over its catchment[:,]\s*\d/.test(t)),
          `${pg.name}: the catchment area is not glued onto the sentence denying it`, k.join(' | ').slice(0, 500));
        check(!k.some(t => /areal rain per column|of the upstream catchment/.test(t)),
          `${pg.name}: and the retired wording is gone from it`, k.join(' | ').slice(0, 400));
      }
      if (pg.kind === 'wsv') {
        check(precipReqs.length === 0, 'BONN asks the mirror for nothing', precipReqs.map(r => r.url).join(', '));
        check(!m.precip && !m.response, 'BONN draws neither new block');
      }
      if (pg.kind === 'rain') {
        const r = m.rain;
        check(!!r, `${pg.name}: the basin grid is drawn`);
        if (r) {
          check(r.rows === overview.basins.length, `${pg.name}: one row per basin`, `${r.rows} vs ${overview.basins.length}`);
          check(r.cols === r.days + 1, `${pg.name}: ${r.days} day columns plus the Σ7d column`, String(r.cols));
          check(String(r.lastCellTitle || '').includes(overview.window.to),
            `${pg.name}: the newest column is the export's rain day`, String(r.lastCellTitle));
          check(r.noLiveFeed, `${pg.name}: the foot says there is no live feed`);
          check(r.links === overview.basins.filter(b => b.river).length, `${pg.name}: a basin with a river is a link`, `${r.links} links`);
          check(r.nolink === overview.basins.filter(b => !b.river).length, `${pg.name}: and one without is not`, `${r.nolink} plain`);
          check(r.stickyName === 'sticky', `${pg.name}: the name column stays put when the grid scrolls`, String(r.stickyName));
          const fileSums = overview.basins.map(b => (b.sum7 == null ? '—' : String(b.sum7)));
          check(JSON.stringify(r.sums) === JSON.stringify(fileSums), `${pg.name}: Σ7d is the collector's own number`, `${r.sums.join(',')} vs ${fileSums.join(',')}`);
        }
      }
      if (s.events.console.filter(c => /error|warn/i.test(c)).length) {
        console.log(`   console: ${s.events.console.filter(c => /error|warn/i.test(c)).slice(0, 4).join(' | ')}`);
      }
    } catch (e) {
      check(false, `${pg.name}: threw`, String(e.message).slice(0, 300));
    } finally {
      await s.close();
    }
  }
}

const base = await serve({ root: ROOT, url: BASE_URL });
const cdp = await chrome({ tag: 'precip-check' });
console.log(`serving ${base}`);
await run(cdp, base, { name: 'desktop', width: 1280, height: 900 });
await run(cdp, base, { name: 'phone', width: 390, height: 844, mobile: true });
killChildren();

// The class check has two branches and the WEATHER decides which one a page
// takes. If every fixture happens to carry a class, the "no response time"
// branch — the reason line and the fleet split — is never executed and nobody
// is told; if none does, every positive assertion goes dark. An input set that
// can be empty is exactly what a new gate may not have, so it is checked.
if (lag) {
  // `detail` is printed whether the check passes or fails, so it carries the
  // MEASUREMENT and the consequence lives in the name — a detail phrased as a
  // failure ("every fixture lost its class") reads as a broken run when green.
  const branches = `${lagBranches.withClass} with a class, ${lagBranches.withoutClass} without`;
  check(lagBranches.withClass > 0,
    'some fixture carries a response class — else the positive half of the class check runs on nothing', branches);
  check(lagBranches.withoutClass > 0,
    'and some fixture carries none — else the reason line and the fleet split are never checked', branches);
}

console.log(`\n${check.failures ? `${check.failures} FAILURES` : 'all checks green'}`
  + `${lagSkipped ? `, ${lagSkipped} response-class check(s) SKIPPED (no nrw/hourly/lag.json)` : ''}`
  + ` — screenshots in ${SHOTS}`);
process.exit(check.failures ? 1 : 0);
