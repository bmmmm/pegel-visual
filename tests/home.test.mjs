// The start page — index.html opened with no query string at all. It is the
// most-seen state of the app and was the only large one nothing asserted: every
// other test names a station or a mode, so the defaults at the top of the
// script (station || 'BONN', the mode chain falling through to 'station') and
// the dispatcher's final branch in render() were reached by nobody.
//
// The boot runs for real here rather than by seeding state: `fetch` is pointed
// at tests/fixtures/home/ and loadData() is allowed to do its own work, so what
// these tests read out of #screen came through the same path a reader's browser
// takes. What this file structurally CANNOT see — that a render ever happens,
// since the harness's requestAnimationFrame never fires — is scripts/home-check.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp } from './extract.mjs';
import { CLOCK, fixtures, routeFor, EXPECTED, scenario } from './fixtures/home/router.mjs';

// the page around the script: extract.mjs evaluates only the inline <script>,
// so anything the static markup owns has to be read from the file itself
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// ---------- the harness ----------

// Node-side ticks. The app's own timers are no-op stubs, so anything waiting on
// one waits forever; the fixture fetches resolve without IO, so a handful of
// macrotasks is enough to let loadData's fan-out (neighbours, weather) land.
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// Which fixture answered, in request order — the same ledger scripts/home-check.mjs
// keeps from Fetch.requestPaused, so both layers can say what a cold boot asked for.
// The ledger has TWO sides: `unmatched` is the one that matters, because a URL
// nobody expected would otherwise just 599 into a `.catch` and prove nothing.
function bootApp() {
  const asked = [], unmatched = [];
  const app = loadApp({ search: '', now: CLOCK });
  globalThis.__homeFetch = url => {
    const hit = routeFor(url);
    if (!hit) {
      unmatched.push(String(url));
      return Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve(null) });
    }
    asked.push(hit.name);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hit.body) });
  };
  app.run('fetch = url => globalThis.__homeFetch(url)');
  return { app, asked, unmatched };
}

// a full cold boot, rendered
async function home() {
  const { app, asked, unmatched } = bootApp();
  await app.run('loadData()');
  await settle();
  app.run('renderNow()');
  return { app, asked, unmatched, html: app.el('screen').innerHTML };
}

const attrsOf = (html, re) => [...html.matchAll(re)].map(m => m[1]);

// ---------- the boot, before anything is drawn ----------

test('the start page needs no query string: BONN, station mode, live, 30 days', () => {
  const app = loadApp({ search: '', now: CLOCK });
  assert.equal(app.run('station'), 'BONN');
  assert.equal(app.run('mode'), 'station');
  assert.equal(app.run('viewMode'), 'live');
  assert.equal(app.run('historyKey'), '30d');
});

test('the first paint is the loading plate, not an empty screen', () => {
  // synchronous on purpose: the boot's own loadData is still a pending promise
  // here, so this is the frame a reader gets before any answer comes back
  const app = loadApp({ search: '', now: CLOCK });
  app.run('renderNow()');
  const html = app.el('screen').innerHTML;
  assert.match(html, /class="plate state-plate"/);
  assert.match(html, /<p class="state-title">[^<]*BONN/);
  assert.equal(app.el('source-line').textContent, app.run('T.sourceWsv'));
});

test('a failing network gives the error plate, with a way out of it', async () => {
  const app = loadApp({ search: '', now: CLOCK });   // the harness's fetch rejects by default
  await settle();
  app.run('renderNow()');
  const html = app.el('screen').innerHTML;
  assert.match(html, /<p class="state-title">No reading\.<\/p>/);
  assert.match(html, /<p class="state-body">station &quot;BONN&quot; failed:/);
  // the retry has to be reachable, or the plate is a dead end
  assert.match(html, /data-nav="cmd:retry"/);
  assert.match(html, /id="state-report"/);
});

// ---------- the plate a reader actually gets ----------

test('a cold boot draws the station plate through the dispatcher', async () => {
  const { app, html } = await home();
  assert.equal(app.run('state.error'), null);
  assert.match(html, /^<section class="plate">/);
  assert.doesNotMatch(html, /state-plate/);
  // the hero is the newest reading in the fixture, formatted by the app itself
  const newest = fixtures.w.currentMeasurement.value;
  assert.equal(app.run(`fmtLevel(${newest}, ${JSON.stringify(fixtures.w.unit)})`), String(newest));
  assert.match(html, new RegExp(`<span class="hero-n">${newest}</span><span class="hero-u">cm</span>`));
});

test('the plate is assembled in one order, and it is the order that reads', async () => {
  const { html } = await home();
  // index-ordering, not includes(): swapping two sections keeps every
  // containment assertion green and changes what the reader is told first
  const at = needle => {
    const i = html.indexOf(needle);
    assert.notEqual(i, -1, `missing from the plate: ${needle}`);
    return i;
  };
  const order = [
    ['<p class="vh">', at('<p class="vh">')],
    ['header', at('<header class="p-head station-head">')],
    ['scene', at('<div class="scene-wrap">')],
    ['history', at(`<h2 class="p-h2">${'HISTORY'}`)],
    ['profile', at('NEIGHBOURS')],
  ];
  const sorted = [...order].sort((a, b) => a[1] - b[1]);
  assert.deepEqual(sorted.map(x => x[0]), order.map(x => x[0]),
    `the plate came out as ${sorted.map(x => x[0]).join(' → ')}`);
});

test('a first visit shows no readout and no rain blocks, and that is the design', async () => {
  const { app, html } = await home();
  // 30 days of live API is below HIST_MIN_DAYS, so unusualNow() has nothing to
  // say yet — the section must be absent rather than present and empty
  assert.equal(app.run('unusualNow()'), null);
  assert.doesNotMatch(html, /class="p-block readout"/);
  // BONN is a WSV gauge; the LANUK products are the mirror's, and loadPrecip is
  // only ever called from loadLanukStation
  assert.equal(app.run('precipViewModel()'), null);
  assert.equal(app.run('responseViewModel()'), null);
  assert.doesNotMatch(html, /PRECIPITATION/);
  assert.doesNotMatch(html, /RESPONSE/);
});

// ---------- the controls on the plate ----------

test('the history chips are the plate\'s only control row, and 30D is the one lit', async () => {
  const { html } = await home();
  const rows = [...html.matchAll(/<nav class="p-tabs"/g)];
  assert.equal(rows.length, 1, 'the start page steers exactly one drawing');

  const targets = attrsOf(html, /data-nav="(cmd:[^"]+)"/g);
  assert.deepEqual(targets, [
    'cmd:h:24h', 'cmd:h:3d', 'cmd:h:7d', 'cmd:h:15d', 'cmd:h:30d',
    'cmd:h:1y', 'cmd:h:5y', 'cmd:h:10y', 'cmd:h:20y', 'cmd:h:all', 'cmd:years',
  ]);

  const lit = attrsOf(html, /<a class="on"[^>]*data-nav="(cmd:[^"]+)"/g);
  assert.deepEqual(lit, ['cmd:h:30d'], 'exactly the active range is lit');
  assert.match(html, /<a class="on"[^>]*data-nav="cmd:h:30d"[^>]*aria-current="true"/);
});

test('on the start page a range chip is a bare path or a lone ?history=', async () => {
  const { app } = await home();
  // historyHref deletes the default rather than spelling it out, so the active
  // chip on a bare URL points at the bare URL — and no chip carries a station=
  // it never got. Under ?station=BONN every one of these gains that parameter,
  // which is why no existing deep-link test covers this.
  assert.equal(app.run("navHref('cmd:h:30d')"), '/');
  assert.equal(app.run("navHref('cmd:h:24h')"), '?history=24h');
  assert.equal(app.run("navHref('cmd:h:all')"), '?history=all');
  assert.equal(app.run("navHref('cmd:years')"), '?view=years');
  for (const t of ['cmd:h:24h', 'cmd:h:all', 'cmd:years']) {
    assert.doesNotMatch(app.run(`navHref(${JSON.stringify(t)})`), /station=/);
  }
});

test('every chip is a link, so the reader can share and go back', async () => {
  const { html } = await home();
  const buttons = [...html.matchAll(/<button[^>]*data-nav="(cmd:h:[^"]+|cmd:years)"/g)];
  assert.deepEqual(buttons.map(m => m[1]), [],
    'a control with a URL of its own must render as <a>, never as a button');
});

// ---------- the chrome around the plate ----------

test('the permalink and the title name the station the URL left implicit', async () => {
  const { app } = await home();
  // applyStationChrome runs at boot for every non-river mode; the permalink is
  // where the implicit default becomes something a reader can copy
  assert.equal(app.el('station-link').textContent, '?station=BONN');
  assert.equal(app.el('station-link').href, '?station=BONN');
  assert.equal(app.el('footer-perma-label').textContent, 'station link:');
  assert.match(app.document.title, /^PEGEL:\/\/BONN · 88cm/);
});

test('the app bar\'s station item is static markup, so it must agree with the default', () => {
  // applyModeChrome is what fills that item — and on a plain WSV start page
  // nothing calls it: the boot's final branch only arms the poll and loads, and
  // the one call inside a loader sits in loadLanukStation. So the header a first
  // visitor reads is the markup in index.html, and it hardcodes a station name.
  // Change the default in the script alone and the app bar keeps pointing at the
  // old gauge, silently — which is exactly what this pins.
  const home = indexHtml.match(/<a id="home-btn" href="\?station=([^"]+)" data-nav="([^"]+)">([^<]+)<\/a>/);
  assert.ok(home, 'the static app-bar item still looks the way this test reads it');
  const [, href, nav, label] = home;
  const dflt = loadApp({ search: '', now: CLOCK }).run('station');
  assert.deepEqual([href, nav, label], [dflt, dflt, dflt],
    `the app bar says ${label} but a bare URL boots ${dflt}`);
});

test('the foot names the source and carries an absolute reading time', async () => {
  const { app } = await home();
  const src = app.el('source-line').textContent;
  assert.match(src, /^PEGELONLINE \(WSV\)/);
  // an absolute stamp out of the fixture, never "3 minutes ago": a relative
  // string would rot into a lie the day this file stops being touched
  const stamp = new Date(fixtures.w.currentMeasurement.timestamp).toISOString().slice(0, 16).replace('T', ' ');
  assert.ok(src.includes(stamp), `${src} should carry ${stamp}`);
  assert.match(src, /refreshes every/);
});

test('the screen reader gets the same reading the hero shows', async () => {
  const { app, html } = await home();
  const summary = app.run('screenSummary()');
  assert.match(summary, /BONN/);
  assert.match(summary, /88/);
  assert.equal(app.el('screen').getAttribute('aria-label'), summary);
  assert.ok(html.includes(`<p class="vh">${summary}</p>`), 'the visually-hidden line is that summary');
});

// ---------- what a cold boot is allowed to cost ----------

test('a cold start page asks for exactly its own data — and never the archive', async () => {
  const { asked, unmatched } = await home();
  // The 30-day default is exactly the live API's reach, so loadRepoArchive must
  // not run: the archive is megabytes and every reader would pay for it. It is a
  // performance contract, and it regresses in silence — an extra fetch costs the
  // reader and changes no pixel, so only the ledger can see it.
  assert.deepEqual(unmatched, [], 'a cold boot requested something no fixture describes');
  assert.deepEqual([...new Set(asked)].sort(), [...new Set(EXPECTED)].sort());
});

test('the refresh poll asks for a delta, not a second full window', async () => {
  const { app, asked } = await home();
  asked.length = 0;
  await app.run('loadData()');
  await settle();
  // the archive is seeded now, so `start` is an ISO instant rather than P30D —
  // a different URL, and one the router has to answer or the poll 599s
  assert.ok(asked.includes('measurements-delta'), `asked: ${asked.join(', ')}`);
  assert.ok(!asked.includes('measurements'), 'the full window is fetched once, not on every tick');
  assert.equal(app.run('state.error'), null);
});

// ---------- the strings, budgeted here rather than in a browser ----------

test('nothing above the drawing can grow enough to push it off the first screen', async () => {
  const { app } = await home();
  // A layout measured on one machine is not a measurement of the CI runner —
  // same Chrome, different fonts, and gate-check's "whole on the first screen"
  // once went 819 px here and 884 px there. So the budget lives in a unit test,
  // which runs the same everywhere, and the browser only asserts that the
  // drawing starts on the first screen at all.
  const vm = app.run('stationViewModel()');
  assert.ok(app.run('screenSummary()').length <= 160, 'the summary line');
  assert.ok(vm.scene.caption.length <= 120, `the scene caption: ${vm.scene.caption}`);
  const chips = app.run('HISTORY_PRESETS.map(p => p.label).concat([T.yearsChip])');
  for (const c of chips) assert.ok(c.length <= 8, `chip label ${c}`);
});

// ---------- the fixtures themselves ----------

test('the fixture is a full 30-day window, or these tests prove nothing', () => {
  const m = fixtures.measurements;
  // "an input set that cannot be empty": every assertion above passes happily
  // on a thinned or emptied fixture, by falling back to the loading plate
  assert.ok(m.length >= 2500, `only ${m.length} readings`);
  assert.ok(m.every(p => Number.isFinite(p.value)), 'every reading is a number');
  const ts = m.map(p => Date.parse(p.timestamp));
  assert.ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), 'timestamps are strictly increasing');

  // BOTH edges: a series ending cleanly a month ago passes any check that only
  // measures the oldest point against the window
  const newest = ts[ts.length - 1], oldest = ts[0];
  assert.ok(CLOCK - newest <= 30 * 60000, `newest reading is ${(CLOCK - newest) / 60000} min before the clock`);
  const span = (newest - oldest) / 864e5;
  assert.ok(span >= 29 && span <= 31, `the window spans ${span.toFixed(2)} days`);
  assert.equal(fixtures.w.currentMeasurement.value, m[m.length - 1].value,
    'the gauge and the series agree on the newest reading');
});

test('the scenario names a clock, and it is the one the tests run on', () => {
  assert.equal(Date.parse(scenario.clock), CLOCK);
  assert.equal(scenario.station, 'BONN');
  const app = loadApp({ search: '', now: CLOCK });
  assert.equal(app.run('Date.now()'), CLOCK);
});
