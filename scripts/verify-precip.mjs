#!/usr/bin/env node
// Drives the station plate's mirror-fed blocks (PRECIPITATION/RESPONSE and
// WATER TEMPERATURE, the last of which reads nrw/temp/) and ?rain in
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
// One gauge's rain-field product, read straight from the tree under test. The
// member list on the plate is checked against THIS, never against a set of
// names this script also knows — a fixture like that goes stale the day the
// rule reshuffles a set and stays green while the plate lists the wrong gauges.
const precipMetaOf = async no => (BASE_URL
  ? await (await fetch(`${BASE_URL}nrw/precip/${no}/meta.json`)).json()
  : JSON.parse(readFileSync(join(ROOT, 'nrw', 'precip', no, 'meta.json'), 'utf8')));
// the reverse index behind the ?rain=<no> page's "in the rain field of" list —
// read from the tree under test for the same reason: a list of names this
// script also knows goes stale the day the rule reshuffles a set.
const usedByOf = async no => (BASE_URL
  ? await (await fetch(`${BASE_URL}nrw/precip/used-by/${no}.json`)).json()
  : JSON.parse(readFileSync(join(ROOT, 'nrw', 'precip', 'used-by', `${no}.json`), 'utf8')));
// the plate's own reading order, restated here so the check compares the drawn
// list against the RULE rather than against the first row it happens to find
const VIA_RANK = { basin: 0, orphan: 0, local: 1, knn: 2 };
const setInOrder = set => [...set].sort((a, b) =>
  (VIA_RANK[a.via] ?? 0) - (VIA_RANK[b.via] ?? 0) ||
  // plain code-unit compare, exactly as the page does it: localeCompare would
  // put Node's default locale against the browser's on a tie
  (a.km ?? Infinity) - (b.km ?? Infinity) ||
  (String(a.no) < String(b.no) ? -1 : String(a.no) > String(b.no) ? 1 : 0));

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
  //   ARLOFF      the WATER TEMPERATURE fixture, and deliberately not a healthy
  //               one: its temperature record stops on 2025-11-07 (ten months
  //               before the clock) and its meta carries an operator note. A
  //               station whose record ends TODAY would let a drawing hung on
  //               the clock pass, which is the one thing this page has to prove
  //               it does not do. The date is not pinned here — the check reads
  //               manifest.temp[no].to, so a station that starts reporting again
  //               stays a valid fixture.
  { q: '?station=ARLOFF', ready: STATION_READY + ' && state.temp', name: 'arloff-temp', kind: 'station', temp: '2741500000100', no: '2741500000100' },
  { q: '?station=BONN', ready: 'state.gauge && state.gauge.currentMeasurement', name: 'bonn-wsv', kind: 'wsv' },
  { q: '?rain', ready: 'state.rain && state.rain.data', name: 'rain-30', kind: 'rain' },
  { q: '?rain&w=90', ready: 'state.rain && state.rain.data', name: 'rain-90', kind: 'rain' },
  // ONE rain gauge as its own page. 51141131 is MENDEN_1's nearest member
  // (km 0.05, via basin) — the row the member-list click below lands on, so the
  // page under test and the navigation into it are the same gauge.
  { q: '?rain=51141131', ready: 'state.rainGauge && state.rainGauge.entry', name: 'raingauge', kind: 'raingauge', no: '51141131' },
  // A gauge that fell SILENT sixteen months before the mirror did (2025-05-16
  // against 2026-09-09) and is reachable from 23 station plates. Its right edge
  // is the one place the per-gauge clamp is visible at all — 51141131's own `to`
  // happens to equal lastRainDay, so that page never exercises it.
  { q: '?rain=42180046', ready: 'state.rainGauge && state.rainGauge.entry', name: 'raingauge-silent', kind: 'raingauge', no: '42180046' },
  // One of the five rain gauges the collector's own coverage counts as
  // unassigned: it has no used-by file, on a mirror that has 314 of them. Its
  // own `to` also runs a day PAST lastRainDay, so the mirror cap is live here.
  { q: '?rain=44075066', ready: 'state.rainGauge && state.rainGauge.entry', name: 'raingauge-noset', kind: 'raingauge', no: '44075066', noSet: true },
  // A registry entry with no window at all: a finding of the source, and it must
  // cost no shard request and no reverse-index request.
  { q: '?rain=43120089', ready: 'state.rainGauge && state.rainGauge.reason', name: 'raingauge-noseries', kind: 'raingauge-none', no: '43120089' },
];

// The temperature meta of every page that carries the WATER TEMPERATURE block,
// read from the TREE — so the operator's note and the unit on the plate are
// compared against the file rather than against a string this script knows too.
// …and the same station's GAUGE meta beside it, because the note the block may
// print is only the one the plate does not already carry: measured 2026-09-10,
// all 20 temperature notes on the branch are byte-identical to the gauge note
// the scene key prints, and a block repeating it says the same sentence twice.
const tempMetas = {}, gaugeMetas = {};
const readMirror = async p => (BASE_URL
  ? (await fetch(BASE_URL + p)).json()
  : JSON.parse(readFileSync(join(ROOT, ...p.split('/')), 'utf8')));
for (const pg of PAGES) {
  if (!pg.temp) continue;
  tempMetas[pg.temp] = await readMirror(`nrw/temp/${pg.temp}/meta.json`);
  gaugeMetas[pg.temp] = await readMirror(`nrw/gauges/${pg.temp}/meta.json`).catch(() => null);
}

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
  // the STATION plate's chart. ?rain=<no> draws the same marks through the same
  // renderer (class="chart precip raingauge"), so the selector has to exclude it
  // — otherwise precipViewModel() is called on a page that has no state.precip.
  const chart = el('.chart.precip:not(.raingauge)');
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
  // ---- ?rain=<no>: one rain gauge's own page ----
  // Anchored at ITS chart and ITS own <ol>, never at #screen: the used-by list
  // and the station plate's member list are the two directions of one relation
  // and would otherwise be read for each other.
  const rgChart = el('.chart.precip.raingauge');
  if (rgChart) {
    const vm = rainGaugeViewModel();
    const plate = rgChart.closest('section.plate');
    const ol = plate && plate.querySelector('ol.rain-usedby');
    const rows = ol ? [...ol.querySelectorAll('li')] : [];
    const cell = (li, sel) => { const e = li.querySelector(sel); return e ? e.textContent.trim() : null; };
    out.rainGauge = {
      name: vm.name, no: vm.no, window: rainDays,
      cols: vm.cols.length,
      bars: rgChart.querySelectorAll('.pr-bar').length,
      expectBars: vm.cols.filter(c => c.mm != null && c.mm > 0).length,
      nd: rgChart.querySelectorAll('.pr-nd').length,
      expectNd: vm.cols.filter(c => c.mm == null).length,
      newest: rainDayISO(vm.cols[vm.cols.length - 1].to),
      oldest: rainDayISO(vm.cols[0].from),
      barHeights: [...rgChart.querySelectorAll('.pr-bar')].map(r => r.getBoundingClientRect().height).sort((a, b) => a - b),
      chartH: rgChart.getBoundingClientRect().height,
      usedByRows: rows.length,
      usedByVm: vm.usedBy == null ? null : vm.usedBy.length,
      usedByNavs: rows.map(li => { const a = li.querySelector('a.name'); return a ? a.getAttribute('data-nav') : null; }),
      names: rows.map(li => cell(li, '.name')),
      rawTags: rows.filter(li => /<[a-z]/i.test(cell(li, '.name') || '')).length,
      key: plate ? [...plate.querySelectorAll('.p-key dd')].map(e => e.textContent) : [],
      title: plate && plate.querySelector('h1') ? plate.querySelector('h1').textContent : null,
      plateText: plate ? plate.innerText : '',
    };
  }
  // the plate that draws NOTHING: a registry entry with no series. Anchored at
  // the rain-gauge title block, not at #screen, which carries the app bar too.
  const rgHead = [...document.querySelectorAll('#screen section.plate')]
    .find(s => /^rain gauge · /.test(((s.querySelector('h1') || {}).textContent) || ''));
  out.rainGaugeReason = rgHead
    ? { title: rgHead.querySelector('h1').textContent,
      dim: [...rgHead.querySelectorAll('.p-dim')].map(e => e.textContent.trim()),
      svgs: rgHead.querySelectorAll('svg').length }
    : null;
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
  // THE WATER-TEMPERATURE PLATE, anchored at its own section. The drawing is
  // .chart.wtemp and the key is .p-key .sw inside the same section: a
  // swatch reuses the drawing's classes, so a sweep over the section as a whole
  // would compare the legend against itself and pass by construction.
  const tempSection = [...document.querySelectorAll('#screen section.p-block')]
    .find(s => s.querySelector('.chart.wtemp') || /^WATER TEMPERATURE/.test((s.querySelector('.p-h2') || {}).textContent || ''));
  const cls = els => [...new Set(els.map(e => e.getAttribute('class')).filter(Boolean)
    .flatMap(c => c.split(/\\s+/)))];
  out.tempPlate = tempSection ? {
    band: tempSection.querySelectorAll('.chart.wtemp .wt-band').length,
    mean: tempSection.querySelectorAll('.chart.wtemp .wt-mean').length,
    nd: tempSection.querySelectorAll('.chart.wtemp .wt-nd').length,
    drawn: cls([...tempSection.querySelectorAll('.chart.wtemp *')]),
    named: cls([...tempSection.querySelectorAll('.p-key .sw *')]),
    key: [...tempSection.querySelectorAll('.p-key dd')].map(e => e.textContent),
    warn: [...tempSection.querySelectorAll('.p-key dd.warn')].map(e => e.textContent),
    dim: [...tempSection.querySelectorAll('.p-dim')].map(e => e.textContent),
    edgePrinted: (tempSection.innerText.match(/newest temperature day, not today: (\\d{4}-\\d{2}-\\d{2})/) || [])[1],
    // the edge of the DRAWING, off the model the marks are built from — and the
    // model's own edge beside it, so the two cannot drift apart unseen
    vm: (() => {
      const vm = tempViewModel();
      return vm && !vm.empty
        ? { last: rainDayISO(vm.cols.at(-1).to), to: rainDayISO(vm.to), unit: vm.unit, cols: vm.cols.length, hasBand: vm.hasBand }
        : null;
    })(),
  } : null;
  // every key row on the WHOLE plate, for the "said once, not twice" check
  out.allKeyRows = [...document.querySelectorAll('#screen .p-key dd')].map(e => e.textContent);
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
  // THE MEMBER LIST, anchored at the precipitation section's own <ol>. Read
  // through the DOM, not off innerText: the rows are what has to be counted,
  // and the whole page carries three other .pf-list lists.
  out.precipSet = null;
  if (precipSection) {
    const ol = precipSection.querySelector('ol.precip-set');
    // The control, or — for a set that fits on the plate and has nothing to
    // toggle — the plain readout that stands in its place. Both are read out of
    // the member list's OWN ctlRow (the <nav> immediately before the <ol>), not
    // by class name across the block: a second ctlRow on this plate would
    // otherwise silently become the thing measured.
    const ctl = ol && ol.previousElementSibling && ol.previousElementSibling.matches('nav.p-tabs')
      ? ol.previousElementSibling : null;
    const chip = ctl && (ctl.querySelector('[data-nav="cmd:rset"]') || ctl.querySelector('.p-tabs-val'));
    if (ol) {
      const rows = [...ol.querySelectorAll('li')];
      const cell = (li, sel) => { const e = li.querySelector(sel); return e ? e.textContent.trim() : null; };
      out.precipSet = {
        rows: rows.length,
        vmRows: precipViewModel().set.length,
        chip: chip ? chip.textContent.trim() : null,
        chipIsButton: !!chip && chip.tagName === 'BUTTON',
        names: rows.map(li => cell(li, '.name')),
        kms: rows.map(li => cell(li, '.km')),
        vias: rows.map(li => cell(li, '.via')),
        atNavs: rows.map(li => { const a = li.querySelector('.at a'); return a ? a.getAttribute('data-nav') : null; }),
        // nothing in a row may be markup the product wrote
        rawTags: rows.filter(li => /<[a-z]/i.test(cell(li, '.name') || '')).length,
      };
    }
  }
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
      // A rain gauge the collector's own coverage counts as unassigned has no
      // reverse-index entry, by construction — the 404 IS the fact this page
      // tests, and the plate turns it into the collector's own sentence. Narrow
      // on purpose: a 404 on used-by/ for any OTHER gauge still fails.
      const noSetAbsent = r => pg.noSet && r.url.endsWith(`/nrw/precip/used-by/${pg.no}.json`);
      const bad = s.events.responses.filter(r => r.url.includes('/nrw/') && r.status >= 400
        && !lagAbsent(r) && !noSetAbsent(r));
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
        // ---- the member list: WHICH rain gauges the field is made of ----
        // Against the product's own meta.json, on a plate wide enough to draw
        // the whole set. On the phone pass the list is CUT on purpose, and the
        // chip has to say by how much — a row count of 12 is the pass there.
        const set = await precipMetaOf(pg.no).catch(() => null);
        const ms = m.precipSet;
        // `detail` is printed whether the check passes or fails, so it carries
        // the MEASUREMENT — a detail phrased as a failure reads as a broken run
        // when green (the same trap the lag-branch check names below).
        check(!!set && !!ms, `${pg.name}: the member list is on the plate`,
          `meta.json ${set ? 'read' : 'MISSING'}, <ol class="precip-set"> ${ms ? 'drawn' : 'ABSENT'}`);
        if (set && ms) {
          const ordered = setInOrder(set.set || []);
          check(ms.vmRows === ordered.length, `${pg.name}: the view model carries every member`, `${ms.vmRows} vs ${ordered.length}`);
          const cut = ordered.length > 12 && vp.mobile;
          const want = cut ? 12 : ordered.length;
          check(ms.rows === want, `${pg.name}: ${want} rows drawn of ${ordered.length}`, `${ms.rows} drawn`);
          check(ms.chip === (cut ? `first 12 of ${ordered.length}` : `all ${ordered.length}`),
            `${pg.name}: the chip states what is on the plate`, String(ms.chip));
          // A set longer than the cut gets a real control (URL-less, so a
          // button); one that fits gets a readout, because a chip that cannot
          // change what is under it is a control the reader learns to distrust.
          check(ms.chipIsButton === (ordered.length > 12),
            `${pg.name}: ${ordered.length > 12 ? 'a real button' : 'a plain readout, nothing to toggle'}`,
            `${ms.chip} (${ms.chipIsButton ? 'button' : 'readout'})`);
          // the first row is the rule's own first: the route that IS a
          // measurement, nearest inside it
          check(ms.names[0] === ordered[0].name, `${pg.name}: the first row is the set's own first`, `${ms.names[0]} vs ${ordered[0].name}`);
          // …and the expectations tolerate exactly what the renderer tolerates:
          // a member without `km` or without `at` draws an em dash, so a mirror
          // that carries neither must not be reported as a broken plate.
          const wantKm = s => (typeof s.km === 'number' && Number.isFinite(s.km) ? `km ${s.km}` : '—');
          check(ms.kms[0] === wantKm(ordered[0]), `${pg.name}: with its own distance`, `${ms.kms[0]} vs ${wantKm(ordered[0])}`);
          // …and on this product that first row also carries the SMALLEST
          // distance in the set (measured on all five station fixtures
          // 2026-09-10): a basin member sits closer than any 15 km neighbour.
          // It is implied by the order, not asserted instead of it — if the two
          // ever part, the check above still pins the rule and this one says so.
          const withKm = (set.set || []).filter(s => typeof s.km === 'number' && Number.isFinite(s.km));
          const minKm = withKm.length ? Math.min(...withKm.map(s => s.km)) : null;
          check(minKm == null || ms.kms[0] === `km ${minKm}`, `${pg.name}: which is the smallest km in the product`,
            minKm == null ? 'no member carries a distance' : `${ms.kms[0]} vs km ${minKm}`);
          check(ms.rawTags === 0, `${pg.name}: no member name reached the page as markup`, String(ms.rawTags));
          // a member the mirror routed nowhere gets no link at all, and the
          // expectation says so rather than asking for "lanuk-undefined"
          const wantNavs = ordered.slice(0, ms.rows).map(s => (s.at ? `lanuk-${s.at}` : null));
          check(JSON.stringify(ms.atNavs) === JSON.stringify(wantNavs),
            `${pg.name}: every row links to the gauge its rain is routed to`,
            `${ms.atNavs.slice(0, 3).join(',')} vs ${wantNavs.slice(0, 3).join(',')}`);
        }
        // …and the link is one this app can actually reach. Clicked for real,
        // once per viewport, on the page that has the biggest set: an href that
        // resolves to a station nobody has is a dead link a DOM check cannot see.
        if (pg.name === 'menden') {
          // An input set that can be empty is exactly what a gate may not have.
          // The first member could carry no `at` (the renderer handles it), and
          // then this check would vanish without a word — the run would go
          // green having never clicked the link it exists to click.
          const target = ms && ms.atNavs.find(Boolean);
          check(!!target, `${pg.name}: there is a member gauge link to click at all`,
            ms ? `${ms.atNavs.filter(Boolean).length} of ${ms.rows} rows link out` : 'no member list');
          if (target) {
          const before = await s.evaluate('station');
          await s.evaluate('document.querySelector(\'#screen ol.precip-set li .at a\').click()');
          await sleep(1200);
          await s.evaluate('renderNow()');
          const after = await s.evaluate('JSON.stringify({ station, mode, id: stationId(), err: !!state.error })');
          const a = JSON.parse(after);
          check(a.mode === 'station' && !a.err && a.station !== before && a.id === target,
            `${pg.name}: clicking a member's gauge lands on that gauge`, `${before} -> ${JSON.stringify(a)}`);
          }
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
      // ---- WATER TEMPERATURE, and the request a gauge without a record must not make ----
      if (pg.kind === 'station' || pg.kind === 'wsv') {
        const tempReqs = s.events.responses.filter(r => r.url.includes('/nrw/temp/'));
        const entry = (manifest.temp || {})[pg.no] || null;
        const hasTemp = !!(entry && entry.days && entry.to);
        if (!hasTemp) {
          // the same "costs no request" property the precip shards have: the
          // manifest is read before a byte of /temp/ is fetched
          check(tempReqs.length === 0, `${pg.name}: not in manifest.temp, so no /nrw/temp/ request`, tempReqs.map(r => r.url).join(', '));
          if (pg.kind === 'station') {
            check(!!m.tempPlate && m.tempPlate.dim.some(t => /carries no record for this station/.test(t)),
              `${pg.name}: and the block says so instead of drawing nothing`, JSON.stringify(m.tempPlate && m.tempPlate.dim));
          } else {
            check(!m.tempPlate, 'BONN draws no temperature block either');
          }
        } else {
          const tp = m.tempPlate;
          // The band is drawn exactly where the model says there IS one — a
          // station whose maxima all equal their means (or are missing, as at
          // Bad-Honnef) has no span to draw, and must not get a zero-height
          // polygon lying on its own line. Both branches are real on this tree.
          check(!!tp && tp.mean > 0 && (tp.vm && tp.vm.hasBand ? tp.band > 0 : tp.band === 0),
            `${pg.name}: the mean line is drawn, and the band exactly where there is a span (hasBand=${tp && tp.vm && tp.vm.hasBand})`,
            JSON.stringify(tp && { band: tp.band, mean: tp.mean, nd: tp.nd }));
          check(!!tp && (tp.vm && tp.vm.hasBand
            ? tp.key.some(t => /the day’s span/.test(t))
            : tp.key.some(t => /no band over this window: the daily maxima never rise above the daily means/.test(t))),
          `${pg.name}: and the key names the band only when one is drawn`, (tp ? tp.key.join(' | ') : '').slice(0, 300));
          if (tp) {
            // every mark the DRAWING carries is named by a swatch in the key —
            // the two anchored at different elements, or the check is circular
            const unnamed = tp.drawn.filter(c => !tp.named.includes(c));
            check(unnamed.length === 0, `${pg.name}: every temperature mark is named in this plate's own key`,
              `${unnamed.join(', ')} — key has ${tp.named.join(', ')}`);
            // the right edge is THIS station's own last day, from the manifest —
            // not the clock, not window.temp.to, and not a date this file knows
            check(!!tp.vm && tp.vm.last === entry.to, `${pg.name}: the drawn right edge is manifest.temp.to (${entry.to})`,
              `${tp.vm && tp.vm.last} vs ${entry.to}`);
            check(!!tp.vm && tp.vm.to === entry.to, `${pg.name}: and the model agrees with its own drawing`, `${tp.vm && tp.vm.to}`);
            check(tp.edgePrinted === entry.to, `${pg.name}: and the key prints that same day`, `${tp.edgePrinted} vs ${entry.to}`);
            const meta = tempMetas[pg.temp] || null;
            if (meta) {
              check(tp.key.some(t => t.includes(meta.unit || '°C')), `${pg.name}: the key names the record's own unit (${meta.unit})`,
                tp.key.join(' | ').slice(0, 300));
              // The operator's note: on the plate exactly ONCE, and never in
              // warning ink here. All 20 temperature notes on this branch equal
              // the gauge note the scene key already prints — this check reads
              // both files and compares, so a mirror where they differ would
              // demand the temperature block print its own.
              const note = (meta.note || '').trim();
              const gaugeNote = ((gaugeMetas[pg.temp] || {}).note || '').trim();
              if (note) {
                const onPlate = m.allKeyRows.filter(t => t.includes(note)).length;
                check(onPlate === 1, `${pg.name}: the operator's note stands on the plate exactly once`, `${onPlate} rows carry it`);
                check(note === gaugeNote
                  ? !tp.key.some(t => t.includes(note))
                  : tp.key.some(t => t.includes(note)),
                `${pg.name}: and the temperature key prints it only where the plate does not already carry it`,
                `temp note "${note}" vs gauge note "${gaugeNote}"`);
                check(!tp.warn.some(t => t.includes(note)),
                  `${pg.name}: never in warning ink — 13 of the 20 notes are administrative, not a fault`, JSON.stringify(tp.warn));
              }
            }
            check(tp.key.some(t => /no live feed/.test(t)), `${pg.name}: and says it is not a live temperature`, tp.key.join(' | ').slice(0, 300));
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
      if (pg.kind === 'raingauge') {
        const g = m.rainGauge;
        check(!!g, `${pg.name}: the rain gauge's own chart is drawn`);
        if (g) {
          const entry = (manifest.rain || {})[pg.no] || {};
          const file = await usedByOf(pg.no).catch(() => null);
          check(g.bars === g.expectBars, `${pg.name}: one bar per day with rain`, `${g.bars} drawn, ${g.expectBars} in the model`);
          check(g.nd === g.expectNd, `${pg.name}: one outline per day it reported nothing`, `${g.nd} vs ${g.expectNd}`);
          // the drawn column count IS the window the chip asks for — the mirror
          // holds two years, so nothing is clamped at 30/60/90 days
          check(g.cols === g.window, `${pg.name}: ${g.window} columns for the ${g.window}D window`, String(g.cols));
          // BOTH edges. The newest against the collector's own last complete
          // rain day (capped by this gauge's own `to`, which is what makes a
          // silent gauge stop where it fell silent); the oldest against the
          // window, counted inclusively from that edge.
          const edge = [entry.to, manifest.coverage.precip.lastRainDay].filter(Boolean).sort()[0];
          check(g.newest === edge, `${pg.name}: the newest column is the gauge's own last rain day`,
            `${g.newest} vs ${edge} (gauge ${entry.to}, mirror ${manifest.coverage.precip.lastRainDay})`);
          const wantOldest = new Date(Date.parse(edge + 'T00:00:00Z') - (g.window - 1) * 864e5).toISOString().slice(0, 10);
          check(g.oldest === wantOldest, `${pg.name}: and the oldest is ${g.window} days back, inclusive`, `${g.oldest} vs ${wantOldest}`);
          // THIS gauge's edge, in its own words: 9 of 319 rain gauges stand
          // behind the collector's last rain day, and the station plate's
          // wording ("the mirror's newest rain day") is false on those.
          check(g.key.some(t => t.includes(`right edge is this gauge’s own newest rain day, not today: ${edge}`)),
            `${pg.name}: the key names that edge too, as the GAUGE's`, g.key.join(' | ').slice(0, 300));
          const behind = entry.to && entry.to < manifest.coverage.precip.lastRainDay;
          check(g.key.some(t => /it has reported nothing since — the mirror’s own newest rain day is/.test(t)) === !!behind,
            `${pg.name}: the gap to the mirror is named exactly when there is one`,
            `gauge ${entry.to}, mirror ${manifest.coverage.precip.lastRainDay}`);
          check(g.barHeights.length === 0 || g.barHeights[g.barHeights.length - 1] > 4,
            `${pg.name}: the tallest bar is visible`, `max ${g.barHeights[g.barHeights.length - 1]} px of ${g.chartH}`);
          check(g.title === `rain gauge · ${entry.n}`, `${pg.name}: the title block names the gauge`, `${g.title} vs ${entry.n}`);
          // …and so does the TAB. The chrome is dressed before the index lands,
          // so this said "PEGEL://RAIN · 51141131" until the loader re-dressed it.
          check(m.title === `PEGEL://RAIN · ${entry.n}`, `${pg.name}: and so does the tab title`, m.title);
          // ---- the reverse index, against the FILE ----
          // A gauge the collector counts as unassigned has none, on purpose, and
          // the plate has to say THAT rather than "this mirror carries no
          // reverse index" — one 404, two entirely different facts.
          if (pg.noSet) {
            check(file === null, `${pg.name}: has no used-by file, as its coverage entry says`, file ? `${file.length} entries` : 'MISSING');
            check(g.usedByVm === null, `${pg.name}: and the view model carries no list`, String(g.usedByVm));
            check((m.rainGauge.plateText || '').includes('counts this rain gauge as unassigned'),
              `${pg.name}: the plate names the collector's own reason`, (m.rainGauge.plateText || '').slice(0, 200));
            check(!(m.rainGauge.plateText || '').includes('this mirror does not carry'),
              `${pg.name}: and makes no claim about the branch, which carries 314 of them`, '');
          }
          check(pg.noSet || !!file, `${pg.name}: nrw/precip/used-by/${pg.no}.json is in the tree`, file ? `${file.length} entries` : 'MISSING');
          if (file && !pg.noSet) {
            check(g.usedByVm === file.length, `${pg.name}: the view model carries every user`, `${g.usedByVm} vs ${file.length}`);
            check(g.usedByRows === file.length, `${pg.name}: and every one is drawn`, `${g.usedByRows} vs ${file.length}`);
            const ordered = setInOrder(file);
            check(g.names[0] === ordered[0].name, `${pg.name}: the first row is the rule's own first`, `${g.names[0]} vs ${ordered[0].name}`);
            check(g.rawTags === 0, `${pg.name}: no gauge name reached the page as markup`, String(g.rawTags));
          }
          check(/no live feed/.test(m.sourceLine), `${pg.name}: the foot says there is no live feed`, m.sourceLine);
          // ---- and back OUT of the rain page, onto a gauge ----
          const target = pg.noSet ? null : g.usedByNavs.find(Boolean);
          check(pg.noSet || !!target, `${pg.name}: there is a gauge link to click at all`,
            `${g.usedByNavs.filter(Boolean).length} of ${g.usedByRows} rows link out`);
          if (target) {
            await s.evaluate('document.querySelector(\'#screen ol.rain-usedby li a.name\').click()');
            await sleep(1500);
            await s.evaluate('renderNow()');
            const a = JSON.parse(await s.evaluate('JSON.stringify({ station, mode, id: stationId(), err: !!state.error })'));
            check(a.mode === 'station' && !a.err && a.id === target,
              `${pg.name}: clicking a user lands on that gauge`, `${JSON.stringify(a)} wanted ${target}`);
          }
        }
      }
      if (pg.kind === 'raingauge-none') {
        // A registry entry the source carries without a series. It is a FINDING,
        // not a failed fetch, and it must cost no request at all — the index
        // already said so.
        const r = m.rainGaugeReason;
        check(!!r, `${pg.name}: the title block is there`, r ? r.title : 'no plate');
        check(!!r && r.dim.some(t => /a finding of the source, not a failed fetch/.test(t)),
          `${pg.name}: and states the finding rather than blaming the network`, r ? r.dim.join(' | ') : '-');
        check(!!r && !r.dim.some(t => /did not load/.test(t)), `${pg.name}: never "did not load"`, r ? r.dim.join(' | ') : '-');
        check(!!r && r.svgs === 0, `${pg.name}: nothing is drawn for it`, r ? String(r.svgs) : '-');
        const asked = s.events.responses.filter(rr => rr.url.includes(`/nrw/rain/${pg.no}/`) || rr.url.includes(`used-by/${pg.no}.json`));
        check(asked.length === 0, `${pg.name}: and no shard or reverse entry was fetched for it`,
          asked.map(rr => rr.url).join(', '));
      }
      // ---- INTO the rain page, from the station plate's member list ----
      if (pg.name === 'menden-1y') {
        const first = m.precipSet && m.precipSet.names[0];
        const nav = await s.evaluate('(() => { const a = document.querySelector(\'#screen ol.precip-set li a.name\'); return a ? a.getAttribute("data-nav") : null; })()');
        check(!!nav && /^rain-\d+$/.test(nav), `${pg.name}: the member name is a link to its own ?rain page`, String(nav));
        if (nav) {
          await s.evaluate('document.querySelector(\'#screen ol.precip-set li a.name\').click()');
          await sleep(1500);
          await s.evaluate('renderNow()');
          const a = JSON.parse(await s.evaluate(
            'JSON.stringify({ mode, no: rainGaugeNo, err: !!state.error, name: state.rainGauge && state.rainGauge.entry && state.rainGauge.entry.n, plate: !!document.querySelector(".chart.precip.raingauge") })'));
          check(a.mode === 'rain' && a.no === nav.slice(5) && !a.err && a.plate,
            `${pg.name}: clicking "${first}" opens that rain gauge's own page`, JSON.stringify(a));
        }
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
