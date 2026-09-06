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
//   node scripts/verify-precip.mjs
//   LANUK_BASE_URL=https://bmmmm.github.io/pegel-visual/ node scripts/verify-precip.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

// the checkout this file lives in — a worktree runs its own copy, and a
// hardcoded path would send every worktree's run at the main checkout
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'tmp-shots');  // gitignored: pictures are evidence, not source
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(SHOTS, { recursive: true });
const BASE_URL = process.env.LANUK_BASE_URL || null;
const manifest = BASE_URL
  ? await (await fetch(BASE_URL + 'nrw/manifest.json')).json()
  : JSON.parse(readFileSync(join(ROOT, 'nrw', 'manifest.json'), 'utf8'));
const overview = BASE_URL
  ? await (await fetch(BASE_URL + 'nrw/precip/overview.json')).json()
  : JSON.parse(readFileSync(join(ROOT, 'nrw', 'precip', 'overview.json'), 'utf8'));
console.log(`nrw: export ${manifest.sourceExportAt}, precip ${manifest.counts.precip} gauges; overview ${overview.window.from}…${overview.window.to}, bins ${overview.bins.join('/')}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const children = [];
let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

async function serve() {
  const port = await freePort();
  const p = spawn('python3', ['-m', 'http.server', String(port), '--directory', ROOT, '--bind', '127.0.0.1'], { stdio: 'ignore' });
  children.push(p);
  await sleep(700);
  return `http://127.0.0.1:${port}/`;
}
async function chrome() {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'precip-check-'));
  const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(p);
  p.stderr.on('data', () => {});
  p.on('exit', () => rmSync(profile, { recursive: true, force: true }));
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try { await fetch(`http://127.0.0.1:${port}/json/version`); return `http://127.0.0.1:${port}`; } catch { /* not up yet */ }
  }
  throw new Error('Chrome did not open its debugging port');
}
async function session(cdp) {
  const t = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = { console: [], responses: [], exceptions: [] };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') events.console.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    if (m.method === 'Log.entryAdded') events.console.push(`${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
    if (m.method === 'Runtime.exceptionThrown') events.exceptions.push(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception || {}).description || ''));
    if (m.method === 'Network.responseReceived') events.responses.push({ url: m.params.response.url, status: m.params.response.status });
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''} — in: ${expr.slice(0, 140)}`);
    return r.result.value;
  };
  const close = async () => { ws.close(); await fetch(`${cdp}/json/close/${t.id}`).catch(() => {}); };
  return { send, evaluate, close, events };
}

const STATION_READY = 'state.gauge && state.gauge.currentMeasurement && state.archive.length > 100 && state.precip';
const PAGES = [
  { q: '?station=MENDEN_1', ready: STATION_READY, name: 'menden', kind: 'station' },
  { q: '?station=MENDEN_1&history=1y', ready: STATION_READY, name: 'menden-1y', kind: 'station' },
  { q: '?station=ARLOFF', ready: STATION_READY, name: 'arloff-thin', kind: 'station' },
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
      const bad = s.events.responses.filter(r => r.url.includes('/nrw/') && r.status >= 400);
      console.log(`-- ${pg.name}: ${JSON.stringify({ mode: m.mode, error: m.error, title: m.title })}`);

      check(!m.error, `${pg.name}: no page error`, m.error || '');
      check(s.events.exceptions.length === 0, `${pg.name}: no uncaught exception`, s.events.exceptions.join(' | '));
      check(bad.length === 0, `${pg.name}: every /nrw/ response is 2xx`, bad.map(r => `${r.status} ${r.url}`).join(', '));
      check(m.emptySwatches.length === 0, `${pg.name}: no empty legend swatch (${m.swatches} drawn)`, m.emptySwatches.join(' | '));
      check(m.wide.length === 0, `${pg.name}: nothing sticks out to the right`, m.wide.join(', '));
      check(m.scroll.w <= m.scroll.inner + 1, `${pg.name}: the page does not scroll sideways`, `${m.scroll.w} > ${m.scroll.inner}`);

      if (pg.kind === 'station' && pg.name !== 'arloff-thin') {
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
        check(!!r && /per 10 mm areal rain/.test(r.sentence), `${pg.name}: the slope sentence names its unit`, r ? r.sentence : '-');
      }
      if (pg.name === 'arloff-thin') {
        check(!m.precip, 'arloff: no chart, because there is no product');
        check(precipReqs.filter(r => !r.url.endsWith('overview.json')).length === 0,
          'arloff: the manifest said no, so no /precip/ shard was fetched', precipReqs.map(r => r.url).join(', '));
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

const base = BASE_URL || await serve();
const cdp = await chrome();
console.log(`serving ${base}`);
await run(cdp, base, { name: 'desktop', width: 1280, height: 900 });
await run(cdp, base, { name: 'phone', width: 390, height: 844, mobile: true });
for (const c of children) c.kill();
console.log(`\n${failures ? `${failures} FAILURES` : 'all checks green'} — screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);
