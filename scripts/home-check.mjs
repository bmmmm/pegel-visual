#!/usr/bin/env node
// Drives the START PAGE — index.html with no query string — in a real headless
// Chrome, and checks the handful of things tests/home.test.mjs structurally
// cannot: that a render happens at all (the Node harness's requestAnimationFrame
// never fires, so scheduleRender() is a no-op there and a loader that forgot it
// would still pass), that nothing overflows a phone, that a range chip is a real
// link you can go back from, and that the console stays quiet.
//
//     node scripts/home-check.mjs                 # desktop 1240 + phone 390
//     node scripts/home-check.mjs --shots DIR     # screenshots elsewhere
//     node scripts/home-check.mjs --url http://127.0.0.1:8765/ --cdp http://127.0.0.1:9333
//
// Needs the sandbox bypass: it binds a loopback port and connects to one.
//
// THE RULE FOR THIS FILE: it must never evaluate renderNow(). Calling it would
// paint the page from the outside and destroy the only reason the script exists.
// Wait for the page to paint itself, or fail.
//
// The network is frozen, not mocked in the page: every request to PEGELONLINE
// and open-meteo is answered over CDP from tests/fixtures/home/ — real Response
// objects, so getJson's res.ok branch and the cross-origin contract are exercised
// rather than bypassed. A request no fixture describes FAILS the run; it is
// never let through to the real network, because a check that quietly goes green
// off live data is the one that looks healthiest and proves least.
//
// REFRESHING THE FIXTURES (they are a frozen instant; regenerate all of them
// together, then update `clock` in scenario.json to ~7 min past the newest
// reading and re-run both layers):
//
//   B=https://www.pegelonline.wsv.de/webservices/rest-api/v2
//   curl -sS "$B/stations/BONN.json?includeTimeseries=true"                     -o tests/fixtures/home/station-info.json
//   curl -sS "$B/stations/BONN/W.json?includeCurrentMeasurement=true&includeCharacteristicValues=true" -o tests/fixtures/home/w.json
//   curl -sS "$B/stations/BONN/W/measurements.json?start=P30D"                  -o tests/fixtures/home/measurements-p30d.json
//   curl -sS "$B/stations/BONN/Q.json?includeCurrentMeasurement=true"           -o tests/fixtures/home/q.json
//   curl -sS "$B/stations.json?waters=RHEIN&includeTimeseries=true"             -o /tmp/rhein.json   # then trim to ~9 gauges around BONN
//   curl -sS "$B/stations/OBERWINTER/W.json?includeCurrentMeasurement=true"     # and KÖLN → neighbor-gauges.json
//   curl -sS "https://api.open-meteo.com/v1/forecast?latitude=50.736398&longitude=7.108045&current=precipitation,snowfall,cloud_cover,wind_speed_10m" -o tests/fixtures/home/weather.json
//
// (Node's fetch ignores HTTP_PROXY, so from an agent sandbox these are curl, not
// a script — see the project notes.)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sleep, serve, chrome, session, checker, helpers, killChildren } from './lib/cdp.mjs';
import { CLOCK, scenario, fixtures, routeFor, EXPECTED } from '../tests/fixtures/home/router.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(x => x.length));
const shots = resolve(args.shots || join(ROOT, 'tmp-shots', 'home-check'));
mkdirSync(shots, { recursive: true });
const check = checker();

// Both edges of the fixture window, and the hero the page must end up showing.
const NEWEST = fixtures.measurements[fixtures.measurements.length - 1];
const LEVEL = String(fixtures.w.currentMeasurement.value);

// The clock, frozen before the page's own script runs. Byte for byte the
// DateStub of tests/extract.mjs, so both layers stand on one time model: the
// argumentless constructor and Date.now() give the scenario instant, while
// parse/UTC/explicit arguments stay real.
//
// NOT Emulation.setVirtualTimePolicy — that also drives task and rAF scheduling,
// and rAF firing normally is the whole claim of check 1.
const FREEZE = `(() => {
  const R = Date, FIXED = ${CLOCK};
  class D extends R {
    constructor(...a) { a.length ? super(...a) : super(FIXED); }
    static now() { return FIXED; }
  }
  window.Date = D;
})();`

// ---------- one run ----------

async function open(cdp, url, vp) {
  const s = await session(cdp);
  const asked = [], unexpected = [], local = [];

  // enabled BEFORE navigating, or the console and the response codes of the
  // first load — the only load that matters — are already gone
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  await s.send('Network.enable');
  // Load 1 is uncontrolled and load 2 (the chip's) would be service-worker
  // controlled: two code paths in one run, and a routed request can escape the
  // page target's interception entirely. Bypass rather than block — blocking
  // sw.js would surface a registration rejection the page deliberately swallows.
  await s.send('Network.setBypassServiceWorker', { bypass: true });
  await s.send('Page.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: !!vp.mobile });
  // (pointer: coarse) is not a feature setEmulatedMedia can override — Chrome derives it from touch emulation
  if (vp.mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (vp.dark) await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE });

  s.on('Fetch.requestPaused', p => {
    const { requestId, request } = p;
    const done = promise => promise.catch(e => { console.log(`   (interception: ${e.message})`); });
    // the page itself, its stylesheet, sw.js: served by the local http.server.
    // Recorded even so — the archive lives on the SAME origin, so a ledger that
    // only watched the cross-origin API would never see it being fetched.
    if (request.url.startsWith(url) || request.url.startsWith('http://127.0.0.1')) {
      local.push(new URL(request.url).pathname);
      return done(s.send('Fetch.continueRequest', { requestId }));
    }
    const sabotaged = vp.failInfo && request.url.includes('/stations/BONN.json');
    const hit = sabotaged ? null : routeFor(request.url);
    if (!hit) {
      // an unexpected URL is a failure, never a trip to the real network
      if (!sabotaged) unexpected.push(request.url);
      return done(s.send('Fetch.fulfillRequest', {
        requestId, responseCode: sabotaged ? 500 : 502,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from('{}').toString('base64'),
      }));
    }
    asked.push(hit.name);
    return done(s.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      // the page is cross-origin to PEGELONLINE, so the CORS contract is part of
      // what is being exercised — omit this header and the fetch rejects
      responseHeaders: [
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      body: Buffer.from(JSON.stringify(hit.body)).toString('base64'),
    }));
  });
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  // Every run is a COLD boot. The profile outlives one page, so without this the
  // second viewport inherits the first's archive in localStorage, `start` becomes
  // an ISO instant instead of P30D, and the run quietly measures a returning
  // visitor while claiming to measure a first one.
  await s.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
  await s.send('Page.navigate', { url });
  return { s, asked, unexpected, local };
}

// Polling that survives a navigation: an evaluate in flight when the document
// swaps comes back "Inspected target navigated or closed", which is a fact about
// timing, not a failure. Returns the last value seen either way.
async function until(s, expr, want, tries = 40) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await s.evaluate(expr).catch(() => undefined);
    if (last !== undefined && want(last)) return last;
    await sleep(250);
  }
  return last;
}

// The page paints itself or it does not. No renderNow(), and a predicate rather
// than a sleep — with the last thing seen carried into the failure line, because
// "the page never rendered" is unreadable without it.
async function painted(s, want, tries = 60) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    last = await s.evaluate(`(document.getElementById('screen') || {}).innerText || ''`).catch(() => '');
    if (want(last)) return { ok: true, last };
    await sleep(250);
  }
  return { ok: false, last };
}

const isPlate = t => !/loading|one moment/i.test(t) && t.includes(LEVEL);

async function run(cdp, url, vp) {
  console.log(`\n== ${vp.name} (${vp.width}×${vp.height}${vp.mobile ? ', mobile, coarse pointer' : ''}${vp.dark ? ', dark' : ''})`);
  const { s, asked, unexpected, local } = await open(cdp, url, vp);
  const { rect, click } = helpers(s);
  const tag = `${vp.name}:`;

  // 1. THE CHECK THIS FILE EXISTS FOR. scheduleRender() rides on rAF; a loader
  //    that never calls it, or a page whose frames never come, sits on "loading…"
  //    with the data already in state — and no Node test can see the difference.
  const first = await painted(s, isPlate);
  check(first.ok, `${tag} the page paints itself, with no renderNow() from here`,
    first.ok ? `hero ${LEVEL}` : `#screen still reads: ${JSON.stringify(first.last.slice(0, 120))}`);
  if (!first.ok) { await s.close(); return; }

  // 2. the ledger, from both ends. The page paints as soon as the gauge is
  //    there, while the profile's fetches are still out, so wait for the set to
  //    close rather than reading it at the first frame — a ledger measured mid
  //    flight reports a page that never asked.
  const done = [...new Set(EXPECTED)];
  await until(s, '1', () => done.every(n => asked.includes(n)), 24);
  check(unexpected.length === 0, `${tag} every request a cold boot makes is one the fixtures describe`, unexpected.join(', '));
  const missing = done.filter(n => !asked.includes(n));
  check(missing.length === 0, `${tag} and every fixture was actually asked for`, `never requested: ${missing.join(', ')}`);
  // The archive is same-origin, so this reads the LOCAL side of the ledger. It
  // was worth finding out the hard way: with the check written against the API
  // ledger it went green while the page happily fetched the archive, and only a
  // 404 from the bare worktree made the run fail at all — on a checkout that has
  // archive/ lying around, nothing would have complained.
  // the two hosted data trees — NOT `manifest`, which also names the PWA's
  // manifest.webmanifest and made this fire on a perfectly good page
  const arc = local.filter(p => /^\/(archive|nrw|nrw-hires)\//.test(p));
  check(arc.length === 0, `${tag} the start page fetches no archive`, arc.slice(0, 3).join(', '));

  // 3. overflow, against the EMULATED width — window.innerWidth grows with the
  //    overflow on a phone, so measuring against it can never go red
  const box = await s.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })');
  check(box.scroll <= vp.width + 1, `${tag} the page does not scroll sideways`, `scrollWidth ${box.scroll} vs ${vp.width}`);
  // HTML only: inside an SVG the viewBox clips, and the scene's `drift` carries
  // a wave a full scene width past its box on purpose — every animated mark
  // would report as sticking out, which is why className there is not even a
  // string. What overflows a layout is the layout's own boxes.
  const wide = await s.evaluate('[...document.querySelectorAll("#screen *")].filter(e => !(e.ownerSVGElement || e.tagName === "svg") && e.checkVisibility() && !e.closest(".wave-wrap") && !e.closest(".tblwrap") && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.tagName + "." + e.className).slice(0, 5)');
  check(wide.length === 0, `${tag} nothing sticks out to the right`, wide.join(', '));

  // 4. the drawing, and the key that has to name it. Anchored at .scene-plot
  //    against .p-key .sw: a swatch reuses the drawing's classes AND its element,
  //    so anchoring at svg.scene would compare the legend with itself.
  const plot = await rect('#screen .scene-plot svg');
  check(!!plot && plot.w > 0 && plot.h > 0, `${tag} the scene is drawn`, plot ? `${Math.round(plot.w)}×${Math.round(plot.h)}` : 'no .scene-plot svg');
  // no pixel budget here: a layout measured on a Mac is not a measurement of the
  // runner's fonts. "It starts on the first screen" is the fontless half of the
  // claim; the string budgets that keep it true live in tests/home.test.mjs.
  const vh = await s.evaluate('innerHeight');
  check(!!plot && plot.y < vh * 0.85, `${tag} the drawing starts on the first screen`, plot ? `y ${Math.round(plot.y)} of ${vh}` : '');
  const emptySw = await s.evaluate(`[...document.querySelectorAll('#screen .p-key .sw')].filter(sw => { const b = sw.getBoundingClientRect(); return b.width < 1 || b.height < 1; }).length`);
  check(emptySw === 0, `${tag} no legend swatch is an empty box`, String(emptySw));

  // 5. both edges of the series the page actually drew. Not the fixture's 2880
  //    readings: mergeIntoArchive thins on the way into storage — full cadence
  //    for 16 days, hourly beyond — so a whole 30-day window is 16×96 + 14×24 =
  //    1872 points plus the boundary. tests/home.test.mjs guards the raw fixture;
  //    this guards what the page kept.
  const edges = await s.evaluate(`(() => { const a = state.archive; return a.length ? { n: a.length, oldest: a[0][0], newest: a[a.length - 1][0], now: Date.now() } : null; })()`);
  check(!!edges && edges.n >= 1800, `${tag} the window survived thinning whole`, edges ? `${edges.n} readings` : 'no archive');
  const span = edges ? (edges.newest - edges.oldest) / 864e5 : 0;
  check(span >= 29 && span <= 31, `${tag} and it spans the month`, `${span.toFixed(2)} days`);
  // the edge a window-only check never looks at
  check(!!edges && edges.now - edges.newest <= 30 * 60000, `${tag} and it reaches the clock`,
    edges ? `${Math.round((edges.now - edges.newest) / 60000)} min behind` : '');

  // 6. the console. The Node harness's fetch rejects for everything, which hides
  //    any real error behind expected noise; here there is no excuse for one.
  check(s.events.exceptions.length === 0, `${tag} no uncaught exception`, s.events.exceptions.join(' | '));
  const errs = s.events.console.filter(c => /^error/i.test(c));
  check(errs.length === 0, `${tag} nothing logged an error`, errs.slice(0, 3).join(' | '));
  const bad = s.events.responses.filter(r => r.status >= 400 && !r.url.includes('favicon'));
  check(bad.length === 0, `${tag} every response is under 400`, bad.map(r => `${r.status} ${r.url}`).slice(0, 3).join(', '));

  const shot = async name => {
    const full = await s.evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })');
    const png = await s.send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: full.w, height: Math.min(full.h, 6000), scale: 1 } });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(png.data, 'base64'));
  };
  await shot(`home-${vp.name}`);

  // 7. A chip is a real link, and the URL it leaves behind is the whole point:
  //    what the reader copies has to reproduce what the reader sees. The Node
  //    harness cannot reach any of this — its history is a no-op pair of stubs,
  //    and a shared link is a SECOND BOOT, which only a browser can perform.
  if (!vp.dark) {
    const LIT = `[...document.querySelectorAll('#screen a.on[data-nav]')].map(a => a.dataset.nav).join(',')`;
    const before = await s.evaluate('history.length');
    await click('#screen a[data-nav="cmd:h:24h"]');
    const search = await until(s, 'location.search', v => v === '?history=24h');
    check(search === '?history=24h', `${tag} a range chip rewrites the URL`, search || '(empty)');
    const lit = await until(s, LIT, v => v.includes('cmd:h:24h'));
    check(String(lit).includes('cmd:h:24h'), `${tag} and the new range comes up lit`, String(lit));

    // setHistory replaces rather than pushes, on purpose — a range is a view of
    // one page, not a place you travelled to, so Back leaves the gauge instead of
    // stepping through every range you tried. Pinned because it is a decision:
    // switching to pushState would silently turn Back into a range undo.
    const after = await s.evaluate('history.length');
    check(after === before, `${tag} and it replaces rather than stacking a history entry`, `${before} → ${after}`);

    // the shareability claim, exercised the only way that proves it: load the
    // URL cold and see whether it comes back as the same view
    await s.send('Page.navigate', { url: url.replace(/\/$/, '/') + '?history=24h' });
    const shared = await painted(s, isPlate);
    const sharedLit = await until(s, LIT, v => v.includes('cmd:h:24h'));
    check(shared.ok && String(sharedLit).includes('cmd:h:24h'),
      `${tag} and that URL, opened cold, is the same view`, String(sharedLit));
    const day = await s.evaluate(`(() => { const h = historyViewModel(); return { label: h.label, empty: h.empty }; })()`).catch(() => null);
    check(!!day && !day.empty && /24/.test(day.label), `${tag} and it really is the 24-hour window`, day ? day.label : 'no view model');
  }

  // 8. dark is a real second rendering, invisible to a DOM test
  if (vp.dark) {
    const ink = await s.evaluate(`(() => { const b = getComputedStyle(document.body); return { fg: b.color, bg: b.backgroundColor }; })()`);
    check(ink.fg !== ink.bg, `${tag} the page paints ink against a ground`, `${ink.fg} on ${ink.bg}`);
    check(/^rgb\(\s*(\d+)/.test(ink.bg) && Number(RegExp.$1) < 120, `${tag} and the ground really is dark`, ink.bg);
  }

  await s.close();
}

// The negative arm: a check that only ever sees one outcome cannot show that it
// distinguishes anything. Same page, the station call answered with a 500.
async function runError(cdp, url) {
  console.log('\n== error (desktop, /stations/BONN.json → 500)');
  const { s } = await open(cdp, url, { name: 'error', width: 1240, height: 900, failInfo: true });
  const got = await painted(s, t => /No reading/i.test(t));
  check(got.ok, 'error: a failing station call raises the error plate', got.ok ? '' : JSON.stringify(got.last.slice(0, 120)));
  if (got.ok) {
    const retry = await s.evaluate(`!!document.querySelector('#screen [data-nav="cmd:retry"]')`);
    check(retry, 'error: and it offers a way out');
    check(!(await s.evaluate(`document.getElementById('screen').innerText.includes(${JSON.stringify(LEVEL)})`)),
      'error: no stale reading is left standing under it');
  }
  await s.close();
}

const url = await serve({ root: ROOT, path: '/', url: args.url === true ? null : args.url });
const cdp = await chrome({ tag: 'home-check', cdp: args.cdp === true ? null : args.cdp });
console.log(`page  ${url}\ncdp   ${cdp}\nclock ${scenario.clock} (newest reading ${NEWEST.timestamp})\nshots ${shots}`);
try {
  for (const vp of [
    { name: 'desktop', width: 1240, height: 900 },
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'dark', width: 1240, height: 900, dark: true },
  ]) {
    try { await run(cdp, url, vp); } catch (e) { check(false, `${vp.name}: the run threw`, String(e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  }
  try { await runError(cdp, url); } catch (e) { check(false, 'the error pass threw', String(e.stack || e).split('\n').slice(0, 3).join(' | ')); }
} finally {
  killChildren();
}
console.log(check.failures ? `\n${check.failures} check(s) FAILED` : '\nall checks passed');
process.exit(check.failures ? 1 : 0);
