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
// the same two-key match the app makes (name OR river), or this script and the
// page can disagree about which basin a water belongs to without either failing
const basinOf = name => Object.values(topo.basins).find(b =>
  String(b.name || '').toUpperCase() === name || String(b.river || '').toUpperCase() === name);
// a basin entry may carry ids or objects carrying an id — normalise once, here,
// so no call site indexes topo.gauges with an object and silently reads nothing
const gaugeIds = basin => (basin.gauges || []).map(g => (g && typeof g === 'object' ? g.id : g)).filter(Boolean);
// the same walk the page does, done independently here: a gauge is DRAWN only
// if its chain of `down` pointers ends at a gauge the file marks as the mouth
const placedCount = basin => {
  const ids = new Set(gaugeIds(basin));
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
  return [r, { total: gaugeIds(b).length, placed: placedCount(b) }];
}));
// The mirror carries far more WATERS than basins, so most mirrored rivers have
// no network of their own — and that path, not the two happy ones, is where the
// view crashed render() and froze the plate. Pick such a water from the file
// itself rather than naming one here, so this keeps checking the real majority
// case as the mirror changes.
// Take the BUSIEST such water, not the first: the first is a one-gauge water
// that the river loader cannot draw at all, so the run would measure "no river"
// instead of "a river with no basin" — measured 2026-09-10, SOESTBACH (a single
// placeholder-id gauge) reported "No reading" and never reached the net view.
const NO_BASIN = process.env.NET_NO_BASIN_RIVER || (() => {
  const byWater = new Map();
  for (const g of Object.values(topo.gauges)) {
    const w = String(g.water || '').toUpperCase();
    if (w) byWater.set(w, (byWater.get(w) || 0) + 1);
  }
  const cands = [...byWater].filter(([w]) => !basinOf(w)).sort((a, b) => b[1] - a[1]);
  return cands.length ? cands[0][0] : null;
})();
console.log(`topology ${topo.generated}: ` +
  RIVERS.map(r => `${r} ${EXPECT[r].total} in basin / ${EXPECT[r].placed} placed`).join(', ') +
  `; no-basin water: ${NO_BASIN || 'NONE FOUND'}`);

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
    // TWO forms of node since the seam: a plain circle where the mirror gives
    // the gauge no reading or the operator no ladder, the alert disc where it
    // gives both. Counting only one of them would report half a network.
    nodes: draw ? draw.querySelectorAll('circle.net-dot').length + draw.querySelectorAll('g.ms-dot').length : -1,
    plainNodes: draw ? draw.querySelectorAll('circle.net-dot').length : -1,
    stageNodes: draw ? draw.querySelectorAll('g.ms-dot').length : -1,
    // every disc's own centre, in DOCUMENT coordinates: msMark fed the wrong
    // option names draws every one of them at its default origin, and a pile of
    // discs in the top-left corner is invisible to a count
    stageCentres: draw ? [...draw.querySelectorAll('g.ms-dot circle.ms-ring')]
      .map(c => { const r = c.getBoundingClientRect(); return r.x.toFixed(1) + ',' + r.y.toFixed(1); }) : [],
    // the hatch ramp resolves through url(#ms-…), which is silent when the defs
    // are missing: the sector then paints as nothing at all
    msDefs: document.querySelectorAll('#screen svg.defs-only pattern[id^="ms-"]').length,
    msKeyRows: key ? [...key.querySelectorAll('dd')].filter(d => /^MS\\d/.test(d.textContent.trim())).length : -1,
    // area unknown has two carriers now — the hollow dot and the halo ring
    noArea: draw ? draw.querySelectorAll('.net-dot.no-area').length + draw.querySelectorAll('circle.net-halo').length : -1,
    halos: draw ? draw.querySelectorAll('circle.net-halo').length : -1,
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
    for (const river of [...RIVERS, NO_BASIN].filter(Boolean)) {
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
      // "the page never painted" on a loaded machine. A water with no basin
      // never grows a chart, so the plate's own heading is the ready signal
      // for it — waiting on the chart there would just time out and report
      // "the page never painted" for a view that rendered correctly.
      const noBasin = river === NO_BASIN;
      const readyExpr = noBasin
        ? '!!(document.querySelector("#screen .p-head h1") && /NETWORK/.test(document.querySelector("#screen .p-head h1").innerText))'
        : '!!(document.querySelector("#screen svg.chart.net"))';
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) {
        ready = await s.evaluate(readyExpr);
        if (!ready) await sleep(150);
      }
      const tag = `${river.toLowerCase()}-${vp.name}`;
      // A throw out of render() is the failure this view actually had, so it is
      // a FAILED CHECK, not a dead run: let it be reported and let the other
      // rivers still be measured.
      let renderErr = null;
      try {
        await s.evaluate('typeof renderNow === "function" && renderNow()');
      } catch (err) {
        renderErr = String(err.message || err);
      }
      check(!renderErr, `${tag}: render() does not throw`, renderErr || '');
      // The readings are loadNet's SECOND pass — the chart is on the page before
      // they land, so waiting on the chart alone measures the plate one repaint
      // too early and reports "no stage anywhere" for a seam that works. Poll
      // through renderNow(), because scheduleRender() rides rAF.
      if (!noBasin) {
        for (let i = 0; i < 60; i++) {
          await s.evaluate('typeof renderNow === "function" && renderNow()');
          const n = await s.evaluate('document.querySelectorAll("#screen svg.chart.net g.ms-dot").length');
          if (n > 0) break;
          await sleep(200);
        }
      }
      await sleep(200);
      const m = await s.evaluate(MEASURE).catch(() => ({
        text: '', h1: null, sub: null, foot: null, hasDraw: false, drawBox: null,
        nodes: -1, plainNodes: -1, stageNodes: -1, stageCentres: [], msDefs: -1, msKeyRows: -1,
        noArea: -1, halos: -1, edges: -1, hits: -1, edgePts: [], rows: -1, rowLinks: -1,
        offRows: -1, keyEntries: -1, swatches: [], emptySwatches: [], tabs: [], tabOn: [],
        wide: [], scroll: { w: 0, inner: 1 },
      }));

      const shot = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(SHOTS, `net-${tag}.png`), Buffer.from(shot.data, 'base64'));

      if (noBasin) {
        // the case that used to throw out of render() and freeze the plate
        check(ready, `${tag}: a water with no basin still renders a titled plate`, m.text.slice(0, 160));
        check(s.events.exceptions.length === 0, `${tag}: no uncaught exception`, s.events.exceptions.join(' | '));
        check(!m.hasDraw, `${tag}: it draws no network`, 'a chart appeared where the file has no basin');
        check(/carry no network of their own|no gauge in this basin/.test(m.text),
          `${tag}: and it says WHY there is nothing to draw`, m.text.slice(0, 200));
        check(/topology 20\d\d-\d\d-\d\d/.test(m.foot || ''), `${tag}: the foot still names source and age`, m.foot || '-');
        check(m.scroll.w <= m.scroll.inner + 1, `${tag}: the page does not scroll sideways`, `${m.scroll.w} > ${m.scroll.inner}`);
        await s.close();
        continue;
      }

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
      const noArea = [...new Set(gaugeIds(basinOf(river)))].filter(id => {
        const g = topo.gauges[id];
        return g && Number.isFinite(g.distKm) && !Number.isFinite(g.km2);
      }).length;
      check(m.noArea > 0 === noArea > 0, `${tag}: the unknown-area mark appears exactly where the file has one`,
        `${m.noArea} drawn, ${noArea} in the file`);

      // ---- the seam: stage 10's alert mark on stage 11's network ----
      // The readings come off the SAME mounted tree, two files per gauge. That
      // they are local is not a detail: `unexpected` above is the assertion that
      // nothing left for the real portal, and these two say the requests were
      // really made rather than quietly skipped.
      // NOT anchored at the start: the served base already ends in a slash, so
      // every recorded pathname here begins `//` — an anchored `^/nrw/` matches
      // nothing and the ledger silently reports zero requests (measured).
      const metaReqs = local.filter(p => /\/nrw\/gauges\/\d+\/meta\.json$/.test(p));
      const shardReqs = local.filter(p => /\/nrw\/gauges\/\d+\/\d{4}\.json$/.test(p));
      check(metaReqs.length > 0 && shardReqs.length > 0,
        `${tag}: the readings came off the mounted tree`, `${metaReqs.length} meta, ${shardReqs.length} shard`);
      check(new Set(metaReqs).size === metaReqs.length,
        `${tag}: no gauge's meta is fetched twice`, `${metaReqs.length} requests, ${new Set(metaReqs).size} gauges`);
      check(m.plainNodes + m.stageNodes === m.nodes && m.nodes === e.placed,
        `${tag}: every placed gauge carries exactly one node, plain or staged`,
        `${m.plainNodes} plain + ${m.stageNodes} staged vs ${e.placed} placed`);
      check(m.stageNodes > 0, `${tag}: the mirror's readings really reach the drawing as stage marks`,
        `no alert disc on ${e.placed} placed gauges — the seam is dead`);
      if (m.stageNodes > 0) {
        // the defect this seam started from: msMark fed x/y instead of cx/cy
        // draws every disc at its own default origin, one on top of the other
        check(new Set(m.stageCentres).size === m.stageNodes,
          `${tag}: each disc sits at its own node, not piled on one origin`,
          `${new Set(m.stageCentres).size} distinct centres for ${m.stageNodes} discs`);
        check(m.msKeyRows === 4, `${tag}: the key names all four rungs MS0–MS3`, String(m.msKeyRows));
        check(m.msDefs === 4, `${tag}: the hatch ramp's defs are on the plate`, String(m.msDefs));
        check(/MS0|alert/.test(m.text), `${tag}: and the plate says in words what the mark counts`,
          m.text.slice(0, 160));
      }
      check(m.halos === 0 || m.stageNodes > 0,
        `${tag}: a halo only ever rings a disc`, `${m.halos} halos, ${m.stageNodes} discs`);

      // The view has to be REACHABLE, not only addressable. Every check above
      // landed straight on ?view=net, which would pass just as well if the chip
      // never appeared on the plate a reader actually starts from — so go to
      // the profile, find the chip there, and press it.
      await s.send('Page.navigate', { url: `${base}/?river=${river}` });
      let onProfile = false;
      for (let i = 0; i < 80 && !onProfile; i++) {
        onProfile = await s.evaluate('!!document.querySelector("#screen .p-tabs")');
        if (!onProfile) await sleep(150);
      }
      await s.evaluate('typeof renderNow === "function" && renderNow()');
      const chip = await s.evaluate(`(() => {
        const a = document.querySelector('#screen .p-tabs [data-nav="cmd:net"]');
        return a ? { href: a.getAttribute('href'), text: a.textContent.trim() } : null;
      })()`);
      check(!!chip, `${tag}: the profile plate offers the net chip`, JSON.stringify(chip));
      check(!!chip && /view=net/.test(chip.href || ''), `${tag}: and the chip is a real, shareable link`, chip ? chip.href : '-');
      if (chip) {
        await s.evaluate('document.querySelector(\'#screen .p-tabs [data-nav="cmd:net"]\').click()');
        await sleep(600);
        await s.evaluate('typeof renderNow === "function" && renderNow()');
        const after = await s.evaluate(`(() => ({
          drawn: !!document.querySelector('#screen svg.chart.net'),
          search: location.search,
        }))()`);
        check(after.drawn, `${tag}: pressing it really draws the network`, JSON.stringify(after));
        check(/view=net/.test(after.search), `${tag}: and the address bar followed the press`, after.search);
      }
      await s.close();
    }
  }
  console.log(`\nshots in ${SHOTS}`);
} finally {
  killChildren();
}
console.log(check.failures ? `\n${check.failures} FAILED` : '\nall checks passed');
process.exit(check.failures ? 1 : 0);
