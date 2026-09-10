#!/usr/bin/env node
// Drives the Meldestufen (alert stage) marks in a real headless Chrome over
// CDP — the recipe of .claude/domains/browser-verify.md. `node --test` proves
// the strings; only a browser proves the SWATCH is not empty, the pattern fill
// really resolves, and the 12 px mark is separable at all.
//
//     node scripts/verify-alert-stages.mjs
//     node scripts/verify-alert-stages.mjs --shots DIR
//     node scripts/verify-alert-stages.mjs --cdp http://127.0.0.1:9333
//
// Needs the sandbox bypass: it binds a loopback port and connects to one.
//
// THE DATA IS FROZEN, NOT MOCKED IN THE PAGE. Every request — the LANUK mirror
// included, which is same-origin and would otherwise be served (or 404ed) by
// the local http.server — is answered over Fetch.enable from the tree below.
// An unmatched URL FAILS the run rather than reaching the real network.
//
// It is a SYNTHETIC mirror on purpose. The real Menden_1 stands near 44 cm and
// is MS0 every day of a normal year, so a check against live data would never
// see MS1–MS3 drawn at all; the shapes here are the ones tests/logic.test.mjs
// uses, with the levels raised until the ladder is inside the window.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, serve, chrome, session, checker, helpers, killChildren } from './lib/cdp.mjs';
import { parseArgs } from './lib/cli.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { opt } = parseArgs();
const shots = resolve(opt('shots', join(ROOT, 'tmp-shots', 'alert-stages')));
mkdirSync(shots, { recursive: true });
const check = checker();

// 2026-09-04 12:00 UTC — two days after the mirror's newest day, the way a
// reader meets the site the morning after the daily run.
const CLOCK = Date.UTC(2026, 8, 4, 12);
const MENDEN = '2729100000100', WEIDENAU = '2721390000100';

// day-of-year index of 2026-09-02 in a non-leap year
const LAST = 244;
// A rising Sieg: 200 cm a month ago, 460 at the crest, 420 now. That puts all
// three of Menden_1's thresholds (250 / 410 / 440) inside the drawn window,
// which is the only way the .href-line rules can be looked at at all.
function shard(no, level) {
  const n = 365, mk = () => Array(n).fill(null);
  const min = mk(), mean = mk(), max = mk(), cnt = mk();
  for (let d = 200; d <= LAST; d++) {
    const t = (d - 200) / (LAST - 200);
    // up to the crest at 460 by d-1, then back to `level`
    mean[d] = d === LAST ? level : Math.round(200 + t * 260);
    max[d] = mean[d] + 3;
    min[d] = mean[d] - 2;
    cnt[d] = 96;
  }
  return { id: no, y: 2026, min, mean, max, n: cnt, acc: {} };
}
const META = {
  [MENDEN]: {
    id: MENDEN, name: 'Menden_1', water: 'Sieg', siteNo: '100', lat: 50.7979, lon: 7.1591,
    catchmentNo: '272', catchmentName: 'Siegeinzugsgebiet Westlich', catchmentKm2: 2825,
    distToConflKm: 8.6, unit: 'cm', info: [250, 410, 440], mw: 66, mnw: 18, mhw: 364,
    gaugeDatum: null, dayBoundary: '00:00+01:00', src: 'bulk', down: null,
  },
  // no `info`: the gauge publishes no ladder, so it must carry NO stage mark —
  // the control that keeps the mark from being drawn for everyone
  [WEIDENAU]: {
    id: WEIDENAU, name: 'Weidenau', water: 'Sieg', lat: 50.9, lon: 8.0, distToConflKm: 130.83,
    unit: 'cm', mw: 27, mnw: 6, mhw: 129, down: MENDEN,
  },
};
const MANIFEST = {
  schema: 1, generated: '2026-09-03T17:41:00Z', sourceExportAt: '2026-09-03T14:11:00Z',
  license: 'dl-de/zero-2.0', window: { from: '2026-01-01', to: '2026-09-02' },
  gauges: {
    [MENDEN]: { n: 'Menden_1', w: 'Sieg', b: '272', site: '100', src: 'bulk', from: '2026-01-01', to: '2026-09-02', days: 245 },
    [WEIDENAU]: { n: 'Weidenau', w: 'Sieg', b: '272', from: '2026-01-01', to: '2026-09-02', days: 245 },
  },
};

// url -> body, or null for "answer 404". Everything else fails the run.
function route(u) {
  const p = new URL(u).pathname.replace(/^\/+/, '');
  if (p === 'nrw/manifest.json') return MANIFEST;
  if (p === 'archive/manifest.json') return { stations: {} };
  let m = /^nrw\/gauges\/(\d+)\/meta\.json$/.exec(p);
  if (m) return META[m[1]] || null;
  m = /^nrw\/gauges\/(\d+)\/(\d{4})\.json$/.exec(p);
  if (m && META[m[1]]) return m[2] === '2026' ? shard(m[1], m[1] === MENDEN ? 420 : 30) : null;
  if (/^nrw\/(precip|hourly)\//.test(p)) return null; // no rain product in this tree
  // The live API. `waters.json` must answer a NON-EMPTY list: an empty set
  // means "the WSV water list is unknown", and the mirror is deliberately not
  // asked in that state (a cold cache with the API down would otherwise draw
  // the Rhine from the wrong source). SIEG is absent from it, which is what
  // makes SIEG a water only the mirror knows.
  if (u.includes('/waters.json')) return [{ shortname: 'RHEIN', longname: 'RHEIN' }, { shortname: 'MOSEL', longname: 'MOSEL' }];
  // `?waters=SIEG` comes back empty (WSV has no Sieg gauges) and the gauge
  // itself 404s — exactly the cold-boot path a LANUK deep link takes
  if (u.includes('pegelonline')) return /\/stations\.json/.test(u) ? [] : null;
  return undefined;
}

const FREEZE = `(() => {
  const R = Date, FIXED = ${CLOCK};
  class D extends R {
    constructor(...a) { a.length ? super(...a) : super(FIXED); }
    static now() { return FIXED; }
  }
  window.Date = D;
})();`;

async function open(cdp, base, query, vp) {
  const s = await session(cdp);
  const unexpected = [];
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  await s.send('Network.enable');
  await s.send('Network.setBypassServiceWorker', { bypass: true });
  await s.send('Page.enable');
  await s.send('Emulation.setDeviceMetricsOverride',
    { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: !!vp.mobile });
  if (vp.mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (vp.scheme) await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: vp.scheme }] });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE });

  s.on('Fetch.requestPaused', p => {
    const { requestId, request } = p;
    const done = q => q.catch(e => console.log(`   (interception: ${e.message})`));
    const fulfill = (code, body) => done(s.send('Fetch.fulfillRequest', {
      requestId, responseCode: code,
      responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    }));
    const path = request.url.startsWith(base) ? new URL(request.url).pathname.replace(/^\/+/, '') : null;
    // the page, its stylesheet, sw.js: the local server's job
    if (path != null && !/^(nrw|archive)\//.test(path)) return done(s.send('Fetch.continueRequest', { requestId }));
    const body = route(request.url);
    if (body === undefined) { unexpected.push(request.url); return fulfill(502, {}); }
    if (body === null) return fulfill(404, {});
    return fulfill(200, body);
  });
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await s.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' });
  await s.send('Page.navigate', { url: base + query });
  return { s, unexpected };
}

// The page paints itself or it does not — no renderNow(), or the check would
// prove nothing about scheduleRender().
// It reads ELEMENTS, not the screen's text: the first assertion of this script
// ran against a half-loaded plate and reported "no alert fact" for a page that
// printed one 300 ms later — the predicate matched a digit anywhere on screen.
async function painted(s, want, tries = 80) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await s.evaluate(`(() => {
      const sc = document.getElementById('screen');
      const h = sc && sc.querySelector('.hero .hero-n');
      return {
        txt: sc ? sc.innerText.slice(0, 300) : '',
        hero: h ? h.textContent.trim() : null,
        rows: sc ? sc.querySelectorAll('ol.pf-list > li').length : 0,
      };
    })()`).catch(() => last);
    if (last && want(last)) return { ok: true, last };
    await sleep(250);
  }
  return { ok: false, last };
}

async function shoot(s, name) {
  const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const f = join(shots, `${name}.png`);
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log(`     shot ${f}`);
}

// ---------- the station plate ----------

async function station(cdp, base, vp, tag) {
  console.log(`\n?station=MENDEN_1 (${tag}) — the gauge standing at MS2`);
  // 1Y, not the default 30D: the window has to reach down to 200 cm or MS1
  // (250) is below the drawn minimum and only two rules are on the chart
  const { s, unexpected } = await open(cdp, base, '?station=MENDEN_1&history=1y', vp);
  const p = await painted(s, l => l.hero === '420');
  check(p.ok, `${tag}: the page paints itself (rAF, no renderNow)`, p.ok ? '' : JSON.stringify(p.last).slice(0, 200));
  if (!p.ok) return s;

  // 1. the title block. Anchored at the <dl class="facts"> of the head — the
  //    string "MS2" also lives in the key below, so a page-wide search would
  //    pass on a head that prints nothing.
  const fact = await s.evaluate(`(() => {
    const dl = document.querySelector('.station-head .facts');
    if (!dl) return null;
    for (const row of dl.querySelectorAll('div')) {
      if (row.querySelector('dt').textContent.trim() === 'alert') return row.querySelector('dd').textContent.trim();
    }
    return null;
  })()`);
  check(fact === 'MS2 of 3', `${tag}: the title block prints the stage`, `alert = ${JSON.stringify(fact)}`);

  // 2. the drawing: three reference rules over the history curve. Anchored at
  //    svg.chart.hist, never at the page — the key's own swatch is a
  //    .href-line too, and would answer for a chart that drew none.
  const lines = await s.evaluate(`(() => {
    const c = document.querySelector('#screen svg.chart.hist');
    if (!c) return null;
    return [...c.querySelectorAll('line.href-line')].map(l => Math.round(+l.getAttribute('y1')));
  })()`);
  check(Array.isArray(lines) && lines.length === 3, `${tag}: three MS rules ride the history drawing`, `y = ${JSON.stringify(lines)}`);
  // drawn in ladder order, and a higher threshold sits HIGHER on the page, so
  // the y values must fall strictly. Three identical rules would be a chart
  // that lost its scale and still passed a count.
  check(Array.isArray(lines) && lines.length === 3 && lines[0] > lines[1] && lines[1] > lines[2],
    `${tag}: MS1 is the lowest rule and MS3 the highest`, JSON.stringify(lines));

  // 3. the key of the history block — the section the chart itself is in
  const key = await s.evaluate(`(() => {
    const c = document.querySelector('#screen svg.chart.hist');
    const sec = c && c.closest('section.p-block');
    const dl = sec && sec.querySelector('dl.p-key');
    if (!dl) return null;
    // the MARK rows and the NOTE rows are different claims: a note may well
    // name MNW/MW/MHW (the caveat says the ladder replaces them), while a mark
    // row naming one would be the key promising a rule the chart never drew
    return {
      marks: [...dl.querySelectorAll('dd .lgn')].map(e => e.textContent.trim()),
      notes: [...dl.querySelectorAll('dd')].filter(d => !d.querySelector('.lgn')).map(d => d.textContent.trim()),
    };
  })()`);
  const marks = ((key || {}).marks || []).join(' | ');
  check(/MS1/.test(marks) && /MS2/.test(marks) && /MS3/.test(marks),
    `${tag}: the history key names every rule the chart drew`, marks.slice(0, 120));
  check(!/\bMHW\b|\bMNW\b|\bMW\b/.test(marks),
    `${tag}: no mark row promises a mean this chart no longer draws`, marks.slice(0, 120));
  check(((key || {}).notes || []).some(n => /alert stage/i.test(n)),
    `${tag}: a note says they are alert stages, not long-term means`);

  // the alert fact is a fifth field in the head's flex row — a width it has
  // never been measured at is a width where it can push the km sign off
  const over = await s.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check(over <= 0, `${tag}: the station plate does not scroll sideways`, `${over}px`);
  await shoot(s, `station-menden1-ms2-${tag}`);
  check(unexpected.length === 0, `${tag}: no request escaped to the real network`, unexpected.join(' '));
  check(s.events.exceptions.length === 0, `${tag}: no uncaught exception`, s.events.exceptions.join(' | ').slice(0, 200));
  return s;
}

// ---------- the river plate: the mark itself ----------

async function river(cdp, base, vp, tag) {
  console.log(`\n?river=SIEG (${tag}) — the stage mark in the flow-ordered index`);
  const { s, unexpected } = await open(cdp, base, '?river=SIEG', vp);
  const p = await painted(s, l => l.rows === 2);
  check(p.ok, `${tag}: the river plate paints itself`, p.ok ? '' : JSON.stringify(p.last).slice(0, 200));
  if (!p.ok) return s;
  const { rect } = helpers(s);

  // Which rows carry a mark, and which do not. Anchored at .pf-list — for a
  // source with no gauge datum the LIST is the drawing, and the key's swatches
  // are the same call, so a page-wide count compares the legend with itself.
  const rows = await s.evaluate(`(() => [...document.querySelectorAll('#screen ol.pf-list > li')].map(li => ({
    name: li.querySelector('.name').textContent,
    ms: [...li.querySelectorAll('g.ms-dot')].map(g => g.getAttribute('class')),
  })))()`);
  check(rows.length === 2 && rows[0].name === 'Weidenau' && rows[1].name === 'Menden_1',
    `${tag}: both gauges are listed, upstream first`, JSON.stringify(rows.map(r => r.name)));
  check(rows[0] && rows[0].ms.length === 0, `${tag}: the gauge without a ladder carries no stage mark`);
  check(rows[1] && rows[1].ms.join() === 'ms-dot k-ms2', `${tag}: Menden_1 carries the stage-2 mark`, JSON.stringify(rows[1] && rows[1].ms));

  // THE SWATCH TRAP: a mark that reuses the drawing's classes inherits its CSS,
  // and an off-origin or transform-animated mark screenshots as an empty box.
  // Only a browser can say the thing has a size at all.
  const box = await rect('#screen ol.pf-list g.ms-dot');
  check(!!box && box.w >= 8 && box.h >= 8, `${tag}: the mark has a real size in the row`, JSON.stringify(box));
  const swBox = await rect('#screen dl.p-key g.ms-dot');
  check(!!swBox && swBox.w >= 8 && swBox.h >= 8, `${tag}: and so does the legend swatch`, JSON.stringify(swBox));

  // The hatch ramp must actually RESOLVE: fill: url(#ms-fslash) is inert if the
  // <defs> never made it onto the page, and the pattern's ground is a
  // color-mix() that a browser resolves and Node never sees.
  const fills = await s.evaluate(`(() => {
    const sec = document.querySelector('#screen ol.pf-list g.ms-dot path.ms-sec');
    const out = { sector: sec ? getComputedStyle(sec).fill : null, defs: {} };
    for (const id of ['none', 'dots', 'fslash', 'cross']) {
      const pat = document.getElementById('ms-' + id);
      const r = pat && pat.querySelector('rect');
      out.defs[id] = r ? getComputedStyle(r).fill : null;
    }
    return out;
  })()`);
  check(/url\(.*#ms-fslash.*\)/.test(String(fills.sector)), `${tag}: the sector is painted through the second hatch`, String(fills.sector));
  const ramp = ['none', 'dots', 'fslash', 'cross'].map(k => fills.defs[k]);
  check(ramp.every(v => v && v !== 'none'), `${tag}: every rung of the ramp resolves to a real colour`, JSON.stringify(fills.defs));
  check(new Set(ramp).size === 4, `${tag}: and the four rungs are four different colours`, JSON.stringify(ramp));

  // FOUR DIFFERENT COLOURS IS NOT A RAMP. Swapping .mf-dots with .mf-cross
  // keeps the set of four intact and runs the lightness light→dark→light;
  // node --test never sees CSS at all, so that sabotage stays green in both
  // gates unless the luminance itself is measured. Read through a canvas: the
  // computed value is an unresolved oklab() for the mixed rungs, and only a
  // painted pixel is the colour the reader actually gets.
  const lum = await s.evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    return ${JSON.stringify(ramp)}.map(col => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = col;
      g.fillRect(0, 0, 1, 1);
      const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return Math.round((0.2126 * f(r) + 0.7152 * f(gr) + 0.0722 * f(b)) * 1000) / 1000;
    });
  })()`);
  const down = lum.every((v, i) => i === 0 || v < lum[i - 1]);
  const up = lum.every((v, i) => i === 0 || v > lum[i - 1]);
  check(down || up, `${tag}: the ramp is monotone in lightness, MS0 → MS3`, JSON.stringify(lum));
  check(Math.abs(lum[3] - lum[0]) > 0.25, `${tag}: and it spans enough of the range to be read`, JSON.stringify(lum));

  // The legend gate in its browser form: the DRAWING against the KEY, the two
  // anchored separately (browser-verify.md — they live one node apart, and one
  // selector for both compares the legend with itself).
  const named = await s.evaluate(`(() => {
    const cls = els => new Set([...els].flatMap(e => (e.getAttribute('class') || '').split(/\\s+/)).filter(Boolean));
    const drawn = cls(document.querySelectorAll('#screen ol.pf-list g.ms-dot, #screen ol.pf-list g.ms-dot *'));
    const keyed = cls(document.querySelectorAll('#screen dl.p-key .sw g.ms-dot, #screen dl.p-key .sw g.ms-dot *'));
    return { drawn: [...drawn], missing: [...drawn].filter(c => !keyed.has(c)), keyed: [...keyed] };
  })()`);
  check(named.drawn.length >= 4, `${tag}: the mark really is drawn`, named.drawn.join(' '));
  check(named.missing.length === 0, `${tag}: every class the drawing uses is in the key's swatches`, named.missing.join(' '));
  check([0, 1, 2, 3].every(n => named.keyed.includes('k-ms' + n)),
    `${tag}: the key spells all four rungs of the vocabulary`, named.keyed.join(' '));

  // no horizontal overflow: the row grew by a 12 px swatch
  const over = await s.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check(over <= 0, `${tag}: the page does not scroll sideways`, `${over}px`);

  await shoot(s, `river-sieg-${tag}`);
  check(unexpected.length === 0, `${tag}: no request escaped to the real network`, unexpected.join(' '));
  check(s.events.exceptions.length === 0, `${tag}: no uncaught exception`, s.events.exceptions.join(' | ').slice(0, 200));
  return s;
}

// ---------- run ----------

const base = await serve({ root: ROOT, url: opt('url', null) });
const cdp = await chrome({ tag: 'alert-stages', cdp: opt('cdp', null) });
console.log(`serving ${base}`);
const sessions = [];
try {
  sessions.push(await station(cdp, base, { width: 1240, height: 1600 }, 'desktop'));
  sessions.push(await station(cdp, base, { width: 390, height: 844, mobile: true }, 'phone'));
  sessions.push(await station(cdp, base, { width: 1240, height: 1600, scheme: 'light' }, 'light'));
  sessions.push(await river(cdp, base, { width: 1240, height: 1200 }, 'desktop'));
  sessions.push(await river(cdp, base, { width: 390, height: 844, mobile: true }, 'phone'));
  // the ramp is a color-mix() per scheme: the light one has to be measured on
  // its own, or "four different colours" is one theme's claim standing for two
  sessions.push(await river(cdp, base, { width: 1240, height: 1200, scheme: 'light' }, 'light'));
  sessions.push(await river(cdp, base, { width: 1240, height: 1200, scheme: 'dark' }, 'dark'));
} finally {
  for (const s of sessions) await s.close().catch(() => {});
  killChildren();
}
console.log(`\n${check.failures ? `${check.failures} FAILED` : 'all checks passed'}`);
process.exit(check.failures ? 1 : 0);
