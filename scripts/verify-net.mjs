#!/usr/bin/env node
// Drives ?river=…&view=net (the basin's gauge network) in a real headless Chrome
// over CDP — the recipe of .claude/domains/browser-verify.md. `--headless=new
// --screenshot` proves nothing here: scheduleRender() rides on rAF, which a
// headless page never serves, so the plate would screenshot as "loading…".
//
// Every cross-origin request is ANSWERED here, never forwarded: the PEGELONLINE
// water list is fulfilled with a list that does NOT name the NRW basins, which
// is exactly the condition under which loadRiver hands the water to the LANUK
// mirror. An unmatched cross-origin URL FAILS the run rather than reaching the
// real network — a check that quietly went live would look healthiest and prove
// least. Same-origin nrw/ comes off the served worktree and is recorded too.
//
// Needs the sandbox bypass (loopback bind + connect). `nrw/` in the worktree
// must hold the data branch:
//   git worktree add --detach "$SOME_TMP/nrwtree" github/nrw && ln -s "$SOME_TMP/nrwtree/nrw" nrw
//   node scripts/verify-net.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, serve, chrome, session, checker, killChildren } from './lib/cdp.mjs';
import { parseArgs } from './lib/cli.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { opt } = parseArgs();
const TREE = resolve(opt('tree', join(ROOT, 'nrw')));
const SHOTS = resolve(opt('shots', join(ROOT, 'tmp-shots')));
const TOPO_PATH = join(TREE, 'topology.json');
// A missing tree must be RED and must say WHAT is missing: an ENOENT 200 lines
// down reads like a broken product instead of a setup step nobody ran.
if (!existsSync(TOPO_PATH)) {
  console.error(`FAIL: no topology.json under ${TREE} — mount the \`nrw\` data branch there.\n` +
    '      git worktree add --detach "$SOME_TMP/nrwtree" github/nrw && ln -s "$SOME_TMP/nrwtree/nrw" nrw\n' +
    '      Refusing to pass without checking anything.');
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

// The file is the authority on what the drawing must contain — never a number
// typed into this script, which goes stale the day the mirror gains a gauge.
const topo = JSON.parse(readFileSync(TOPO_PATH, 'utf8'));
const MOUTH = 'mouth';
const basinOf = name => Object.values(topo.basins).find(b => String(b.name || '').toUpperCase() === name);
// the same walk the page does, done independently here: a gauge is DRAWN only
// if its chain of `down` pointers ends at a gauge the file marks as the mouth
const placedCount = basin => {
  const ids = new Set(basin.gauges.map(g => (g && typeof g === 'object' ? g.id : g)));
  const ok = id => {
    let n = topo.gauges[id], seen = new Set();
    while (n && !seen.has(n.id)) {
      if (!Number.isFinite(n.distKm)) return false;
      if (n.down == null) return n.downSrc === MOUTH;
      seen.add(n.id);
      n = topo.gauges[n.down];
    }
    return false;
  };
  return [...ids].filter(ok).length;
};

const RIVERS = ['ERFT', 'SIEG'];
const EXPECT = Object.fromEntries(RIVERS.map(r => {
  const b = basinOf(r);
  return [r, { total: b.gauges.length, placed: placedCount(b) }];
}));
console.log(`topology ${topo.generated}: ` +
  RIVERS.map(r => `${r} ${EXPECT[r].total} in basin / ${EXPECT[r].placed} placed`).join(', '));

// A water list the PEGELONLINE API really could answer with — and deliberately
// WITHOUT the NRW basins, because `wsvWaters.size && !wsvWaters.has(river)` is
// the condition that routes a water to the mirror. An empty list would mean
// "unknown", not "WSV has none", and the page would keep waiting.
const WATERS = ['RHEIN', 'ELBE', 'WESER', 'EMS', 'DONAU', 'MOSEL'].map(shortname => ({ shortname, longname: shortname }));

const FREEZE = `(() => {
  const FIXED = Date.parse('2026-09-10T09:00:00Z');
  const R = Date;
  function D(...a) { return a.length ? new R(...a) : new R(FIXED); }
  D.prototype = R.prototype; D.now = () => FIXED; D.parse = R.parse; D.UTC = R.UTC;
  globalThis.Date = D;
})()`;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
];

// Anchored at the DRAWING, never at the page: `svg.sw.net` is the key's own
// swatch and reuses the drawing's classes, so `#screen svg.net circle.net-dot`
// would count the legend's marks as gauges and the check would pass by
// construction (browser-verify.md, measured 2026-09-07).
const MEASURE = `(() => {
  const q = s => document.querySelectorAll(s);
  const screen = document.getElementById('screen');
  const draw = document.querySelector('#screen svg.chart.net');
  const list = document.querySelector('#screen ol.pf-list.net-list');
  const key = document.querySelector('#screen dl.p-key');
  const box = e => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x, y: r.y }; };
  const swatches = [...q('#screen .p-key .sw')].map(e => ({ cls: e.getAttribute('class'), ...box(e) }));
  return {
    text: screen ? screen.innerText : '',
    h1: document.querySelector('#screen .p-head h1') ? document.querySelector('#screen .p-head h1').innerText : null,
    sub: document.querySelector('#screen .p-head .p-sub') ? document.querySelector('#screen .p-head .p-sub').innerText : null,
    foot: (document.getElementById('source-line') || {}).textContent || null,
    hasDraw: !!draw,
    drawBox: draw ? box(draw) : null,
    nodes: draw ? draw.querySelectorAll('circle.net-dot').length : -1,
    noArea: draw ? draw.querySelectorAll('.net-dot.no-area').length : -1,
    edges: draw ? draw.querySelectorAll('polyline.net-edge').length : -1,
    hits: draw ? draw.querySelectorAll('rect.hit').length : -1,
    // an elbow is three points; a diagonal is two
    edgePts: draw ? [...draw.querySelectorAll('polyline.net-edge')].map(p => p.getAttribute('points').trim().split(/\\s+/).length) : [],
    rows: list ? list.querySelectorAll(':scope > li').length : -1,
    rowLinks: list ? list.querySelectorAll('a[href]').length : -1,
    offRows: list ? list.querySelectorAll('li.off').length : -1,
    keyEntries: key ? key.querySelectorAll('dd').length : -1,
    swatches,
    emptySwatches: swatches.filter(s => s.w < 4 || s.h < 4).map(s => s.cls),
    tabs: [...q('#screen .p-tabs a, #screen .p-tabs button')].map(e => e.textContent.trim()),
    tabOn: [...q('#screen .p-tabs [aria-current="true"]')].map(e => e.textContent.trim()),
    // nothing may stick out to the right of the viewport
    wide: [...q('#screen *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 5).map(e => e.tagName + '.' + (e.getAttribute('class') || '')),
    scroll: { w: document.documentElement.scrollWidth, inner: window.innerWidth },
  };
})()`;

const check = checker();
try {
  const base = await serve({ root: ROOT });
  const cdp = await chrome({ tag: 'net-check' });
  for (const vp of VIEWPORTS) {
    for (const river of RIVERS) {
      const s = await session(cdp);
      const local = [], unexpected = [], answered = [];
      await s.send('Runtime.enable');
      await s.send('Log.enable');
      await s.send('Network.enable');
      await s.send('Network.setBypassServiceWorker', { bypass: true });
      await s.send('Page.enable');
      await s.send('Emulation.setDeviceMetricsOverride',
        { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: vp.mobile });
      if (vp.mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await s.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE });

      s.on('Fetch.requestPaused', p => {
        const { requestId, request } = p;
        const done = pr => pr.catch(e => console.log(`   (interception: ${e.message})`));
        if (request.url.startsWith(base) || request.url.startsWith('http://127.0.0.1')) {
          local.push(new URL(request.url).pathname);
          return done(s.send('Fetch.continueRequest', { requestId }));
        }
        const hdrs = [
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Content-Type', value: 'application/json' },
        ];
        // the water list, and only the water list, gets a real answer
        if (/\/waters\.json/.test(request.url)) {
          answered.push('waters.json');
          return done(s.send('Fetch.fulfillRequest',
            { requestId, responseCode: 200, responseHeaders: hdrs, body: Buffer.from(JSON.stringify(WATERS)).toString('base64') }));
        }
        // a stations query for an NRW water: WSV really has none, and an empty
        // array is the honest answer that sends loadRiver to the mirror
        if (/\/stations\.json/.test(request.url)) {
          answered.push('stations.json');
          return done(s.send('Fetch.fulfillRequest',
            { requestId, responseCode: 200, responseHeaders: hdrs, body: Buffer.from('[]').toString('base64') }));
        }
        unexpected.push(request.url);
        return done(s.send('Fetch.fulfillRequest',
          { requestId, responseCode: 502, responseHeaders: hdrs, body: Buffer.from('{}').toString('base64') }));
      });
      await s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await s.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' });

      const url = `${base}/?river=${river}&view=net`;
      await s.send('Page.navigate', { url });
      // wait for the loader, not for a fixed sleep: a blind wait reads as
      // "the page never painted" on a loaded machine
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) {
        ready = await s.evaluate('!!(document.querySelector("#screen svg.chart.net"))');
        if (!ready) await sleep(150);
      }
      await s.evaluate('typeof renderNow === "function" && renderNow()');
      await sleep(200);
      const m = await s.evaluate(MEASURE);
      const tag = `${river.toLowerCase()}-${vp.name}`;

      const shot = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(SHOTS, `net-${tag}.png`), Buffer.from(shot.data, 'base64'));

      const e = EXPECT[river];
      check(ready, `${tag}: the network drawing is on the page`, m.text.slice(0, 120));
      check(s.events.exceptions.length === 0, `${tag}: no uncaught exception`, s.events.exceptions.join(' | '));
      check(unexpected.length === 0, `${tag}: no request reached the real network`, unexpected.join(', '));
      check(local.some(p => p.endsWith('/nrw/topology.json')), `${tag}: the page really fetched nrw/topology.json`, local.join(' '));
      check(m.rows === e.total, `${tag}: the list carries every gauge in the basin`, `${m.rows} rows, ${e.total} in the file`);
      check(m.nodes === e.placed, `${tag}: one node per placed gauge`, `${m.nodes} drawn, ${e.placed} placed in the file`);
      check(m.rowLinks === e.total, `${tag}: every row is tappable`, `${m.rowLinks} of ${m.rows}`);
      check(m.offRows === e.total - e.placed, `${tag}: the unplaced gauges are marked in the list`, `${m.offRows} vs ${e.total - e.placed}`);
      check(m.edges === e.placed - 1, `${tag}: a tree of n nodes has n-1 edges`, `${m.edges} vs ${e.placed - 1}`);
      check(m.edgePts.every(n => n === 3), `${tag}: every edge is an elbow, not a diagonal`, m.edgePts.join(','));
      check(m.hits === m.nodes, `${tag}: every node carries a touch target`, `${m.hits} vs ${m.nodes}`);
      check(!!m.h1 && m.h1.includes('NETWORK'), `${tag}: the plate has a title block`, m.h1 || '-');
      check(!!m.sub && m.sub.includes(`${e.total} gauges in the basin`), `${tag}: the title block prints the BASIN total`, m.sub || '-');
      check(m.keyEntries >= 5, `${tag}: the key names its marks`, String(m.keyEntries));
      check(/topology 20\d\d-\d\d-\d\d/.test(m.foot || ''), `${tag}: the foot names source and age`, m.foot || '-');
      check(m.emptySwatches.length === 0, `${tag}: no empty legend swatch (${m.swatches.length} drawn)`, m.emptySwatches.join(' | '));
      check(m.tabs.join('/').includes('net'), `${tag}: the tab row offers the net chip`, m.tabs.join('/'));
      check(m.tabOn.join() === 'net', `${tag}: and marks it as the current view`, m.tabOn.join());
      check(m.wide.length === 0, `${tag}: nothing sticks out to the right`, m.wide.join(', '));
      check(m.scroll.w <= m.scroll.inner + 1, `${tag}: the page does not scroll sideways`, `${m.scroll.w} > ${m.scroll.inner}`);
      check(m.drawBox.w > 100 && m.drawBox.h > 20, `${tag}: the drawing has a real box`, JSON.stringify(m.drawBox));
      // the Sieg carries two gauges without a catchment area, the Erft none —
      // the hollow mark is an inventory entry, so it must appear on one and not
      // on the other
      const noArea = [...new Set(basinOf(river).gauges)].filter(id => {
        const g = topo.gauges[id];
        return g && Number.isFinite(g.distKm) && !Number.isFinite(g.km2);
      }).length;
      check(m.noArea > 0 === noArea > 0, `${tag}: the unknown-area mark appears exactly where the file has one`,
        `${m.noArea} drawn, ${noArea} in the file`);
      await s.close();
    }
  }
  console.log(`\nshots in ${SHOTS}`);
} finally {
  killChildren();
}
console.log(check.failures ? `\n${check.failures} FAILED` : '\nall checks passed');
process.exit(check.failures ? 1 : 0);
