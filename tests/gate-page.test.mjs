// The gate page renders the committed reports without a browser: buildModel and
// renderPage are pure, so the page's own tests run against the real JSON.
// Runtime behaviour (focus after a re-render, popstate, the cursor) has no DOM
// here — scripts/gate-check.mjs drives a real Chrome for that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS, LABEL_GAP, LINKS, MODEL_MARKS, NC_GLYPH, PANEL_IDS, TARGETS, buildModel, leadSay, markOf, parseState, renderPage, screenSummary, stackLabels, stateHref } from '../gate/gate.js';

const ROOT = new URL('../gate/', import.meta.url).pathname;
// the page is manifest-driven, so its tests read the same manifest the browser does
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8'));
const MODEL_KEYS = MANIFEST.models.map(mo => mo.key);
const readReport = rel => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const at = (mo, dir) => (mo.files[dir] ? readReport(mo.files[dir].json) : undefined);
const reportsFor = keys => {
  const models = MANIFEST.models.filter(mo => keys.includes(mo.key));
  const byKey = {};
  for (const mo of models) byKey[mo.key] = { seasonal: { mid: at(mo, 'seasonal-mid'), max: at(mo, 'seasonal-max') }, short: at(mo, 'short-mid') };
  return { models, byKey };
};
const reports = reportsFor(MODEL_KEYS);              // what the deployed page loads
const shipped = reportsFor([MANIFEST.shipped]);      // the sheet read for one model alone
const load = name => readReport(`${name}/report.json`);
const MID = reports.byKey[MANIFEST.shipped].seasonal.mid;
const MAX = reports.byKey[MANIFEST.shipped].seasonal.max;
const STATIONS = Object.keys(MID.stations);

const everyState = [];
for (const target of Object.keys(TARGETS)) for (const block of BLOCKS) everyState.push({ target, block, lead: 'pooled', panel: null });

const words = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').trim().split(/\s+/).filter(Boolean).length;
const section = (html, id) => (html.match(new RegExp(`<section id="${id}"[\\s\\S]*?<\\/section>`)) || [''])[0];
const panel = (html, id) => (html.match(new RegExp(`<details class="panel" id="${id}">[\\s\\S]*?<\\/details>`)) || [''])[0];

test('the committed reports say NO-SHIP, seven clauses, five regimes, seven gauges', () => {
  const m = buildModel(reports, parseState(''));
  assert.equal(m.verdict, 'NO-SHIP');
  assert.equal(m.clauses.length, 7);
  assert.deepEqual(m.clauses.map(c => c.id), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
  assert.equal(m.clauses.filter(c => c.pass).length, 2, 'A5 and A7 passed');
  assert.equal(m.skill.rows.length, 7);
  assert.equal(m.skill.regimes.length, 5);
  assert.equal(m.head.windows, 7 * 509);
  assert.ok(m.head.reproduced, 'the mid report carries the second-run reproduction');
});

test('every target × block renders, and the numbers follow the chips', () => {
  const seen = new Set();
  for (const state of everyState) {
    const m = buildModel(reports, state);
    const html = renderPage(m);
    assert.ok(html.includes(`<span class="word">${m.verdict}</span>`));
    assert.ok(html.includes(`Skill by gauge · ${m.drawn.map(x => x.label).join(' + ')} · ${state.target === 'mid' ? 'daily mid' : 'daily max'} ·`), 'the skill panel names every model it draws AND the target');
    seen.add(m.skill.pooled.ss.toFixed(4) + state.target);
  }
  assert.equal(seen.size, 6, 'six distinct pooled skills — one per target and block');
  const long = buildModel(reports, parseState('?block=h31-90'));
  assert.ok(long.skill.pooled.ss < 0, 'at three months the model is behind the blend');
  const short = buildModel(reports, parseState(''));
  assert.ok(short.skill.pooled.ss > 0.05 && short.skill.pooled.ss < 0.10, 'a real but sub-bar win at two weeks');
});

test('the report carries a curve over the lead day, and the curve tells the story', () => {
  const mid = MID;
  for (const s of Object.values(mid.stations)) {
    assert.equal(Object.keys(s.per_h).length, 6);
    for (const v of Object.values(s.per_h)) assert.equal(v.length, 90);
  }
  assert.equal(mid.pooled.per_h.blend.length, 90);
  assert.ok(mid.pooled.per_h_ratio_median.blend.every(v => Math.abs(v - 1) < 1e-9), 'the blend is the unit');
  const L = buildModel(reports, parseState('')).lead;
  assert.equal(L.station, 'pooled');
  assert.deepEqual(L.stations, STATIONS);
  // read the curve that is DRAWN, not a parallel field: the three sentences this
  // test is named for must be checked against what reaches the page
  const drawnRatios = L.curves[0].ratios;
  assert.ok(drawnRatios[0] < 0.9, `the model wins on day 1 (×${drawnRatios[0]})`);
  assert.ok(drawnRatios[13] < 1, 'still ahead at day 14');
  assert.ok(Math.abs(drawnRatios[89] - 1) < 0.05, 'a draw by day 90');
  const leadHtml = section(renderPage(buildModel(shipped, parseState(''))), 'lead');
  assert.ok(leadHtml.includes(`×${drawnRatios[0].toFixed(2)}`), 'and that curve is the one the table twin prints');
  assert.ok(L.series.clim[0] > 2 && Math.abs(L.series.clim[89] - 1) < 0.02, 'Finding 2: climatology starts far off and ends on the blend');
  assert.ok(L.series.persist[89] > 1.3, 'persistence never recovers');
  assert.deepEqual(L.blocks.map(b => [b.from, b.to]), [[1, 14], [15, 30], [31, 90]]);
  assert.equal(L.cursor, 14, 'the cursor starts on the last day of the picked block');
  assert.equal(buildModel(reports, parseState('?block=h31-90')).lead.cursor, 90);
  const oneModel = buildModel(shipped, parseState('')).lead;
  assert.match(leadSay(oneModel, 14), /^day 14: TimesFM 2\.5 ×0\.\d\d · climatology ×\d\.\d\d · persistence ×\d\.\d\d · blend MAE \d+\.\d cm pooled$/);
  // with both candidates drawn the readout names each of them, in the curve's order
  const rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(leadSay(L, 14), new RegExp('^day 14: ' + L.curves.map(c => `${rx(c.label)} ×\\d\\.\\d\\d`).join(' · ') + ' · climatology'));
  const D = buildModel(reports, parseState('?lead=DRESDEN', '', STATIONS)).lead;
  assert.equal(D.station, 'DRESDEN');
  assert.ok(D.series.clim[0] > 4, 'Dresden’s climatology on day 1 lies above the frame — the clip mark has a job');
  assert.ok(!leadSay(D, 1).endsWith('pooled'));
});

test('the curve draws three lines, the bands, the bar and a cursor, each named in its key', () => {
  const html = renderPage(buildModel(reports, parseState('?lead=DRESDEN', '', STATIONS)));
  const lead = section(html, 'lead');
  assert.ok(lead, 'a lead section');
  for (const k of ['tfm', 'clim', 'persist']) assert.match(lead, new RegExp(`<path class="ln ln-${k}" d="M[\\d. ]+L[\\d. L]+"/>`), `a path for ${k}`);
  assert.equal((lead.match(/<span class="lb( on)?" style="left:/g) || []).length, 3, 'three block bands');
  assert.equal((lead.match(/class="lb on"/g) || []).length, 1 + 1, 'the picked block is hatched — once in the drawing, once in the key');
  assert.ok(lead.includes('<line class="ln-blend"'), 'the blend is a line at ×1');
  assert.ok(lead.includes('<line class="ln-cur" data-cur'), 'the cursor');
  assert.match(lead, /<span class="clip up ln-clim" style="left:[\d.]+%" title="climatology beyond ×4 on days 1–\d+">/, 'the clipped first days of climatology are marked');
  assert.match(lead, /<svg viewBox="0 0 320 120" preserveAspectRatio="none" tabindex="0" role="slider" data-lead data-core aria-valuemin="1" aria-valuemax="90" aria-valuenow="14" aria-valuetext="day 14: /);
  // data-core is what focusTo measures before deciding to scroll: the drawing, not the section
  assert.equal((lead.match(/data-core/g) || []).length, 1, 'exactly one part of the curve claims to be the one that must stay in view');
  assert.ok(lead.includes('<h2 class="p-h2" tabindex="-1">Error by lead day · DRESDEN</h2>'));
  // the settings fold holds two rows — the sheet-wide one and the gauge chips;
  // the gauge row is the second, and its own chip is the one that is current
  const gaugeRow = (lead.match(/<nav class="p-tabs"[\s\S]*?<\/nav>/g) || []).pop() || '';
  assert.match(gaugeRow, /aria-label="gauge drawn in the curve"/, 'the last row in the fold is the gauge row');
  assert.equal((gaugeRow.match(/<a href="[^"]*#lead" class="on" aria-current="true"/g) || []).length, 1, 'the DRESDEN chip is on');
  const bands = (lead.match(/<div class="lead-bands">[\s\S]*?<\/div>/) || [''])[0];
  assert.equal((bands.match(/<a href="[^"]*#lead"/g) || []).length, 3, 'the three band labels are the block links of this chart');
  assert.ok(bands.includes('<a href="?block=h15-30&amp;lead=DRESDEN#lead" data-focus="lead"'), 'a band link keeps the gauge and names the block');
  assert.ok(bands.includes('<a href="?lead=DRESDEN#lead" class="on" aria-current="true" data-focus="lead"'), 'the picked band is current');
  assert.match(lead, /<details class="tbl"><summary>table — every lead day<\/summary>[\s\S]*?<tr><td>90<\/td><td>×\d\.\d\d<\/td>/, 'the curve has its table twin, all 90 days');
  assert.match(lead, /<a href="\.\/#lead"[^>]*data-focus="lead">five regimes<\/a>/, 'the pooled chip drops the lead from the URL');
  assert.ok(lead.includes('<a href="?lead=K%C3%96LN#lead" data-focus="lead">KÖLN</a>'));
  const key = (lead.match(/<dl class="p-key">[\s\S]*?<\/dl>/) || [''])[0];
  for (const cls of ['ln ln-tfm', 'ln ln-clim', 'ln ln-persist', 'ln-blend', 'ln-cur', 'lb on', 'class="lb"']) assert.ok(key.includes(cls), `${cls} in the key`);
  assert.ok(key.includes('▴'), 'the clip glyph is explained');
  const pooled = section(renderPage(buildModel(reports, parseState(''))), 'lead');
  assert.ok(!pooled.includes('class="clip'), 'the median curve stays inside the frame');
  assert.ok(pooled.includes('median of the five regime gauges'), 'the pooled key says what pooled means');
});

// Mechanical, like the app's own gate in logic.test.mjs: pull every class out of
// the drawing, every class out of its <dl class="p-key">, and demand the second
// set covers the first. A renderer that gains a mark without a legend entry — a
// fourth curve, a new bar state — turns this red without anyone editing a list.
const classesIn = html => { const out = new Set(); for (const m of html.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) out.add(c); return out; };
// What counts as the DRAWING of a section: everything before its key, minus the
// table twin and minus any control row. A control row is not a drawing — it has
// lived inside the section since the settings moved into a fold, and its chips
// wear the model hues, which the key already explains under the class the CURVE
// carries. Cutting it structurally beats growing NOT_A_MARK a name per model.
const drawingOf = s => s.slice(0, s.indexOf('<dl class="p-key">'))
  .replace(/<details class="tbl">[\s\S]*?<\/details>/g, '')
  .replace(/<nav class="p-tabs"[\s\S]*?<\/nav>/g, '');
// not marks: layout, text, hit targets and states the key spells out in words (▸ ◂ ▴ ▾ are glyphs in the notes)
const NOT_A_MARK = new Set(['p-block', 'row', 'pooled', 'head', 'lbl', 'rg', 'track', 'two', 'val', 'vm', 'axis', 'ticks', 'mk', 'sw', 'hint', 'p-readout', 'p-dim', 'p-tabs', 'p-tabs-lbl', 'on', 'off', 'rows', 'pits', 'pit', 'nm', 'mn',
  'plot', 'vscale', 'plot-box', 'lead-bands', 'lbn', 'lead-ticks', 'clip', 'lo', 'hi', 'up', 'dn', 'vh', 'p-h2',
  'ends', 'end',   // the direct labels: containers for a swatch whose OWN class is a mark and is in the key
  'fold', 'fl', 'fs', 'foldbody',   // a drawer and its lid, not something the drawing draws
  'prose', 'flow', 'fn']);  // prose/flow/fn are the model chain's containers; its four node kinds ARE marks
test('every mark a section draws is named in that section’s key — mechanically', () => {
  let drawings = 0;
  for (const state of [...everyState, parseState('?lead=DRESDEN', '', STATIONS)]) {
    const html = renderPage(buildModel(reports, state));
    const sections = html.split(/<details class="panel"|<section id="lead"/).slice(1).filter(s => s.includes('class="rows"') || s.includes('class="pits"') || s.includes('class="plot"') || s.includes('class="flow"'));
    assert.ok(sections.length >= 6, 'lead, skill, error, calibration, finding 2, the model chain (and short)');
    for (const s of sections) {
      const key = (s.match(/<dl class="p-key">[\s\S]*?<\/dl>/) || [''])[0];
      assert.ok(key, 'a section with a drawing has a key');
      const drawing = drawingOf(s);
      const named = classesIn(key);
      const missing = [...classesIn(drawing)].filter(c => !NOT_A_MARK.has(c) && !named.has(c));
      assert.deepEqual(missing, [], `drawn but not in the key of: ${s.slice(0, 50)}`);
      drawings++;
    }
  }
  assert.ok(drawings >= 35, `the gate saw ${drawings} drawings`);
  // and it can go red: a mark class the key does not know
  const html = renderPage(buildModel(reports, parseState(''))).replace('<path class="ln ln-tfm"', '<path class="ln ln-ghost"');
  const lead = html.split('<section id="lead"')[1];
  const missing = [...classesIn(drawingOf(lead))].filter(c => !NOT_A_MARK.has(c) && !classesIn(lead.match(/<dl class="p-key">[\s\S]*?<\/dl>/)[0]).has(c));
  assert.deepEqual(missing, ['ln-ghost']);
});

test('every row carries its readout sentence, every chart its table twin', () => {
  const html = renderPage(buildModel(reports, parseState('?target=max&block=h15-30')));
  const rows = html.match(/<div class="row[^"]*" tabindex="0" role="button" data-say="[^"]+">/g) || [];
  assert.ok(rows.length >= 7 * 4 + 1 + 7, `rows: ${rows.length}`);
  assert.ok(!/<div class="row[^"]*" tabindex="0" role="button">/.test(html), 'no silent row');
  assert.equal((html.match(/<details class="tbl">/g) || []).length, 5, 'the curve, skill, error, calibration, short');
  assert.equal((html.match(/data-readout/g) || []).length, 6, 'the curve, skill, error, calibration, finding 2, short');
  for (const c of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) assert.ok(html.includes(`>${c} `), `${c} chip`);
  assert.ok(html.includes('<span class="g" aria-hidden="true">✗</span>') && html.includes('<span class="g" aria-hidden="true">✓</span>'), 'pass and fail carry a glyph, not only a colour');
});

test('state round-trips through the URL: query for the data, hash for the panel', () => {
  assert.deepEqual(parseState(''), { target: 'mid', block: 'h1-14', lead: 'pooled', panel: null, models: null });
  assert.deepEqual(parseState('?target=max&block=h31-90', '#calib'), { target: 'max', block: 'h31-90', lead: 'pooled', panel: 'calib', models: null });
  assert.deepEqual(parseState('?target=bogus&block=nope&lead=', '#nowhere'), { target: 'mid', block: 'h1-14', lead: 'pooled', panel: null, models: null });
  for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(parseState(`?target=${t}`).target, 'mid', `${t} is not a target`);
  assert.ok(renderPage(buildModel(reports, parseState('?target=constructor'))).includes('daily mid'), 'and the page still renders');
  assert.equal(parseState('', '#writeup').panel, 'basics', 'the old write-up anchor still lands');
  assert.equal(parseState('?lead=DRESDEN').lead, 'DRESDEN');
  assert.equal(parseState('?lead=DRESDEN', '', STATIONS).lead, 'DRESDEN');
  assert.equal(parseState('?lead=ATLANTIS', '', STATIONS).lead, 'pooled', 'an unknown gauge falls back to the median');
  assert.equal(parseState('?lead=PASSAU+ILZSTADT', '', STATIONS).lead, 'PASSAU ILZSTADT');
  assert.equal(buildModel(reports, { target: 'mid', block: 'h1-14', lead: 'ATLANTIS', panel: null }).lead.station, 'pooled', 'buildModel guards too');
  const base = parseState('');
  assert.equal(stateHref(base), './');
  assert.equal(stateHref(base, { block: 'h31-90' }), '?block=h31-90');
  assert.equal(stateHref(base, { panel: 'skill' }), './#skill');
  assert.equal(stateHref(base, { block: 'h31-90', panel: 'skill' }), '?block=h31-90#skill');
  assert.equal(stateHref({ target: 'max', block: 'h15-30', lead: 'DRESDEN', panel: 'lead' }), '?target=max&block=h15-30&lead=DRESDEN#lead');
  assert.equal(stateHref({ target: 'max', block: 'h15-30', lead: 'DRESDEN', panel: 'lead' }, { lead: 'pooled', panel: null }), '?target=max&block=h15-30');
  const html = renderPage(buildModel(reports, parseState('?target=max&block=h15-30')));
  assert.ok(html.includes('<a href="?target=max&amp;block=h31-90#lead" data-focus="lead" data-ctl="block">'), 'the block chip keeps the target and holds the reader on the curve');
  assert.ok(html.includes('class="on" aria-current="true"'), 'the active chip is marked');
});

test('every chip and index link says what to focus, and the way back is there twice', () => {
  const html = renderPage(buildModel(reports, parseState('')));
  const chips = html.match(/<nav class="p-tabs"[\s\S]*?<\/nav>/g) || [];
  assert.equal(chips.length, 2, 'the gauge row on the curve and the filter row');
  for (const nav of chips) for (const a of nav.match(/<a [^>]+>/g)) assert.match(a, / data-focus="(lead|skill)"/, a);
  for (const a of (html.match(/<div class="lead-bands">[\s\S]*?<\/div>/) || [''])[0].match(/<a [^>]+>/g)) assert.match(a, / data-focus="lead"/, a);
  const index = (html.match(/<nav class="index"[\s\S]*?<\/nav>/) || [''])[0];
  assert.ok(index, 'an index');
  const links = index.match(/<a href="[^"]+" data-focus="[^"]+">/g) || [];
  assert.equal(links.length, 8, 'one per panel');
  assert.equal((html.match(/<nav class="p-back" aria-label="back"><a href="\.\.\/">/g) || []).length, 2, 'above the title and in the foot');
  assert.ok(html.indexOf('class="p-back"') < html.indexOf('<h1'), 'the first way back precedes the title');
  assert.ok(html.includes('<h1 tabindex="-1">'), 'the h1 can take the fallback focus');
  assert.ok(!html.includes('aria-live'), 'no live region inside the plate — the status line lives outside it');
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(!page.includes('<main id="plate" aria-live'), 'the plate no longer re-reads itself on every chip');
  assert.ok(page.includes('<p class="vh" id="gate-status" aria-live="polite"></p>'), 'one small polite status line');
});

test('the panels come closed, in the order of the index, every summary a link target', () => {
  const m = buildModel(reports, parseState(''));
  const html = renderPage(m);
  const ids = [...html.matchAll(/<details class="panel" id="([\w-]+)">/g)].map(x => x[1]);
  assert.deepEqual(ids, ['skill', 'error', 'calib', 'clim', 'short', 'model', 'method', 'basics']);
  assert.deepEqual(m.panels.map(p => p.id), ids, 'the index is built from what is rendered');
  for (const id of ids) assert.ok(PANEL_IDS.includes(id), `${id} is a known hash`);
  assert.ok(!html.includes('<details class="panel" id="skill" open'), 'nothing is open on load');
  assert.ok(!/<details class="panel"[^>]*\sopen/.test(html));
  const indexLinks = [...(html.match(/<nav class="index"[\s\S]*?<\/nav>/) || [''])[0].matchAll(/data-focus="([\w-]+)"/g)].map(x => x[1]);
  assert.deepEqual(indexLinks, ids, 'index order = panel order');
  for (const id of ids) {
    const p = panel(html, id);
    assert.match(p, /^<details class="panel" id="[\w-]+"><summary>[^<]+<\/summary><section><h2 class="vh">/, `${id}: summary, then a hidden h2 for the outline`);
    assert.equal(p.match(/<summary>([^<]+)<\/summary>/)[1], p.match(/<h2 class="vh">([^<]+)<\/h2>/)[1], 'summary and heading agree');
  }
  const at = needle => html.indexOf(needle);
  const filterRow = 'aria-label="model, target and horizon block"';
  assert.ok(at('class="verdict"') < at('id="lead"'), 'the verdict comes first');
  // the controls live inside the settings fold, and that fold sits above the
  // drawing it relabels — folded, but never below it
  assert.ok(at('id="settings"') < at(filterRow), 'the filter row is inside the settings fold');
  assert.ok(at(filterRow) < at('class="plot"'), 'and the fold sits ABOVE the curve it relabels, not a screen below it');
  // and the words agree with the layout: nothing may send the reader downwards for it
  const curveText = html.slice(at('id="lead"'), at('class="facts"'));
  assert.ok(!/filter row (further )?(down|below)/.test(curveText), 'the curve does not send the reader down to a row that is above it');
  assert.match(curveText, /the settings fold above the chart/, 'it names where the row actually is');
  // the clauses now come AFTER the drawing: the first screen is a verdict and a picture
  assert.ok(at('id="lead"') < at('id="clauses"'), 'the drawing comes before its evidence');
  assert.ok(at('id="clauses"') < at('class="facts"') && at('class="facts"') < at('class="index"') && at('class="index"') < at('<details class="panel"'),
    'verdict · curve · clauses · in brief · index · panels');
});

test('a hostile station name never reaches the markup unescaped', () => {
  const evil = JSON.parse(JSON.stringify(reports));
  const bad = '<img src=x onerror=alert(1)>';
  for (const key of MODEL_KEYS) {
    const r = evil.byKey[key].seasonal.mid;
    r.stations[bad] = r.stations['KÖLN'];
    r.station_info[bad] = r.station_info['a6ee8177-107b-47dd-bcfd-30960ccc6e9c'];
    r.regimes['Mittelrhein'].members.push(bad);
  }
  // and a hostile MODEL name must not reach the chips either
  evil.models = evil.models.map(mo => ({ ...mo, label: mo.label + bad }));
  for (const lead of ['pooled', bad]) {
    const html = renderPage(buildModel(evil, { target: 'mid', block: 'h1-14', lead, panel: null }));
    assert.ok(!html.includes(bad));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  }
});

test('the page survives a missing max or short report — one panel fewer, no dead index link, no relabelled run', () => {
  const only = MANIFEST.shipped;
  const m = buildModel({ models: [MANIFEST.models.find(mo => mo.key === only)], byKey: { [only]: { seasonal: { mid: MID } } } }, parseState('?target=max'));
  assert.equal(m.verdict, 'NO-SHIP');
  assert.equal(m.target, 'mid', 'the mid run is not passed off as the max run');
  assert.equal(m.state.target, 'mid');
  assert.ok(m.gist.startsWith('On the daily mid target'));
  const html = renderPage(m);
  assert.ok(html.includes('<span class="off" aria-disabled="true" title="the daily max report did not load" data-ctl="target">daily max</span>'), 'the max chip is there, but not a link');
  assert.ok(!html.includes('daily max ·'), 'no panel title claims the max run');
  assert.ok(html.includes('<a href="./#lead" class="on" aria-current="true"'), 'the mid chip is current');
  assert.ok(!html.includes('Short horizon'), 'no short panel without its report');
  assert.ok(!html.includes('#short"'), 'and no index link to it');
  assert.deepEqual(m.panels.map(p => p.id), ['skill', 'error', 'calib', 'clim', 'model', 'method', 'basics']);
  assert.ok(html.includes('FORECAST GATE'));
  assert.equal((html.match(/data-readout/g) || []).length, 5);
});

test('the summary spoken to screen readers names verdict, target, block and the interval', () => {
  const m = buildModel(reports, parseState('?block=h31-90'));
  const s = screenSummary(m);
  assert.match(s, /NO-SHIP/);
  assert.match(s, /daily mid target, days 31–90/);
  assert.match(s, /95 % interval from -0\.\d+ to \+?0\.\d+/);
  // a reader who cannot see the bars still has to be told there are two, and
  // which pooled number belongs to which candidate
  assert.ok(m.drawn.length > 1);
  assert.match(s, new RegExp(`${m.drawn.length} candidates`));
  for (const b of m.skill.pooled.bars) assert.ok(s.includes(`${b.label} pooled skill ${b.ss > 0 ? '+' : ''}${b.ss.toFixed(3)}`), `${b.label} with its own skill: ${s}`);
  assert.equal(new Set(m.skill.pooled.bars.map(b => b.ss)).size, m.skill.pooled.bars.length, 'the two numbers differ, so the sentence cannot pass by accident');
  // and with one model on it speaks in the singular, without the label twice
  const one = screenSummary(buildModel(reports, parseState(`?models=${MANIFEST.shipped}`, '', null, MODEL_KEYS)));
  const label = MANIFEST.models.find(mo => mo.key === MANIFEST.shipped).label;
  assert.equal(one.split(label).length - 1, 1, `the shipped label appears once: ${one}`);
});

test('gist, facts and basics quote the report, not a remembered number', () => {
  const mid = MID, max = MAX;
  const pc = v => `${Math.round(Math.abs(v) * 100)} %`;
  const NAME = MANIFEST.models.find(mo => mo.key === MANIFEST.shipped).label;
  // the gist follows the target
  const gm = buildModel(reports, parseState('')), gx = buildModel(reports, parseState('?target=max'));
  assert.notEqual(gm.gist, gx.gist);
  // with two candidates the gist leads with the one that cannot ship, and quotes
  // EACH of them out of its own report — the failure this guards is one label
  // over another model's numbers
  const chal = MANIFEST.models.find(mo => !mo.shippable);
  const cm = reports.byKey[chal.key].seasonal.mid, cx = reports.byKey[chal.key].seasonal.max;
  assert.ok(gm.gist.startsWith(`On the daily mid target ${chal.label} beats the blend by ` + pc(cm.pooled.blocks['h1-14'].ss) + ' at two weeks'), gm.gist);
  assert.ok(gx.gist.startsWith(`On the daily max target ${chal.label} beats the blend by ` + pc(cx.pooled.blocks['h1-14'].ss) + ' at two weeks'), gx.gist);
  assert.ok(gm.gist.includes('measured here, never shipped'), 'and says it cannot ship');
  assert.ok(gm.gist.includes(`the shipped ${NAME} by ` + pc(mid.pooled.blocks['h1-14'].ss) + ' at two weeks'), gm.gist);
  assert.ok(gm.gist.includes(`is ${pc(mid.pooled.blocks['h31-90'].ss)} behind by three months`));
  assert.notEqual(pc(cm.pooled.blocks['h31-90'].ss), pc(mid.pooled.blocks['h31-90'].ss), 'the two runs differ there, so the sentence cannot pass by accident');
  // one model on: the old single-subject sentence, with that model's own numbers
  const only = buildModel(reports, parseState(`?models=${MANIFEST.shipped}`, '', null, MODEL_KEYS));
  assert.ok(only.gist.startsWith(`On the daily mid target ${NAME} beats the blend by ` + pc(mid.pooled.blocks['h1-14'].ss) + ' at two weeks'), only.gist);
  assert.ok(!only.gist.includes(chal.label), 'and does not name the model it is not drawing');
  assert.ok(renderPage(gm).includes(`<p class="p-sub">${gm.gist}</p>`), 'the gist sits under the title');
  // the facts follow target and block
  const f1 = buildModel(reports, parseState('')).facts, f3 = buildModel(reports, parseState('?block=h31-90')).facts;
  assert.equal(f1.length, 5);
  assert.equal(f1[1].k, 'days 1–14'); assert.equal(f3[1].k, 'days 31–90');
  assert.notEqual(f1[1].html, f3[1].html); assert.notEqual(f1[2].html, f3[2].html);
  assert.equal(f1[0].html, f3[0].html, 'the setup line does not move with the block');
  const p = mid.pooled.blocks['h31-90'];
  assert.ok(f3[1].html.includes(`<b>${(p.ss > 0 ? '+' : '') + p.ss.toFixed(2)}</b>`), 'pooled skill from the report');
  assert.ok(f3[1].html.includes(`<b>${(p.ci95[0] > 0 ? '+' : '') + p.ci95[0].toFixed(2)}</b>`), 'CI from the report');
  assert.ok(f3[2].html.includes(`<b>${Math.round(p.picp80.tfm * 100)} %</b>`), 'coverage from the report');
  assert.ok(f1[3].html.includes('<b>DRESDEN</b>'), 'the one gauge where climatology is not a near-tie');
  assert.ok(f1[4].html.includes(`<b>${mid.header.model}</b>`) && f1[4].html.includes(`<b>${mid.header.model_license}</b>`),
    'the run fact names the model of the run in view and its licence');
  assert.ok(f1[4].html.includes('pinned exactly'), 'the shipped line says its version is pinned');
  const ncFacts = buildModel(reports, parseState(`?models=${MODEL_KEYS.find(k => k !== MANIFEST.shipped)}`, '', null, MODEL_KEYS)).facts;
  assert.ok(ncFacts[4].html.includes('never shipped') && !ncFacts[4].html.includes('pinned exactly'),
    'and a non-commercial line says THAT instead, rather than blaming a pin it does not honour');
  assert.ok(f1[0].html.includes('<b>3 563</b>') && f1[0].html.includes('<b>509</b>'));
  const html = renderPage(gm);
  assert.equal((html.match(/<li><span class="fk">/g) || []).length, 5);
  // the basics quote the primary run whatever the chips say, in three short paragraphs
  const m = buildModel(reports, parseState('?target=max&block=h31-90'));
  const basics = panel(renderPage(m), 'basics');
  assert.equal(m.story.verdict, mid.verdict);
  assert.equal(m.story.h1, pc(mid.pooled.blocks['h1-14'].ss));
  assert.ok(basics.includes(`beats the blend by ${m.story.h1}`));
  assert.ok(basics.includes(`at three months it is ${m.story.h90} ${m.story.h90sign}`));
  assert.equal(m.story.climWorst, 'DRESDEN');
  assert.ok(basics.includes('TimesFM 2.5') && basics.includes('zero-shot'));
  assert.equal((basics.match(/<p><b>/g) || []).length, 3, 'three paragraphs');
  const prose = basics.slice(basics.indexOf('<div class="prose">'), basics.indexOf('<p class="p-dim">'));
  assert.ok(words(prose) <= 150, `basics: ${words(prose)} words`);
  // the main page links here — from its app bar, not from the foot of the page
  const page = readFileSync(join(ROOT, '..', 'index.html'), 'utf8');
  const appbar = page.slice(page.indexOf('<header id="appbar">'), page.indexOf('</header>'));
  const footNav = page.slice(page.indexOf('<nav id="footer-nav"'), page.indexOf('</nav>', page.indexOf('<nav id="footer-nav"')));
  assert.match(appbar, /<a id="gate-link" href="gate\/"[^>]*>forecast gate<\/a>/, 'the app bar links the gate');
  assert.ok(!footNav.includes('gate'), 'and the footer no longer does');
  assert.ok(page.includes('<dt>forecast gate</dt>'), 'the feature guide explains it');
  assert.equal((page.match(/href="gate\/"/g) || []).length, 2, 'app bar and guide, relative — the site lives on a subpath');
});

test('the model panel names the model, links its three sources, and never invents a number', () => {
  const m = buildModel(reports, parseState(''));
  const html = renderPage(m);
  const panel = html.slice(html.indexOf('<details class="panel" id="model">'), html.indexOf('<details class="panel" id="method">'));
  const h = MID.header;
  // the model, said in the page's own words and backed by the run's header
  assert.match(panel, /decoder-only, 200M parameters/, 'what it is');
  assert.match(panel, /<em>zero-shot<\/em>/, 'and how it was applied');
  assert.ok(panel.includes(h.checkpoint) && panel.includes(h.model_license), 'checkpoint and licence come from the header');
  assert.ok(panel.includes(`pinned to ${h.versions.timesfm}`), 'and the pinned package version');
  // the three off-site sources a reader needs to check the model claim itself
  for (const [what, href] of [['model card', LINKS.card], ['paper', LINKS.paper], ['package', LINKS.pkg], ['our code', LINKS.code]]) {
    assert.ok(panel.includes(`href="${href}"`), `${what} is linked`);
  }
  assert.match(LINKS.card, /huggingface\.co\/google\/timesfm-2\.5-200m-pytorch$/, 'the card is the 2.5 checkpoint we actually load');
  assert.match(LINKS.paper, /arxiv\.org\/abs\/2310\.10688$/, 'the decoder-only paper');
  // every figure in the chain is the run's own, so a re-run redraws instead of lying
  for (const [what, v] of [['context', h.protocol.context], ['horizon', h.protocol.horizon], ['step', h.protocol.step],
    ['batch', h.forecast_config.per_core_batch_size], ['threads', h.torch_threads], ['fingerprint', h.config_fingerprint]]) {
    assert.ok(panel.includes(String(v)) || panel.includes(String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')), `${what} (${v}) is drawn from the header`);
  }
  assert.ok(!panel.includes('2000–2025'), 'the header carries no year range, so the chain does not claim one');
  // greping for the right number would also pass on a hard-coded one: bend the
  // header and demand the drawing follows it
  const bent = structuredClone(MID);
  bent.header.protocol.context = 777;
  bent.header.forecast_config.per_core_batch_size = 3;
  bent.header.config_fingerprint = 'deadbeefdeadbeef';
  const only = MANIFEST.shipped;
  const bentPanel = (html => html.slice(html.indexOf('<details class="panel" id="model">'), html.indexOf('<details class="panel" id="method">')))(
    renderPage(buildModel({ models: [MANIFEST.models.find(mo => mo.key === only)], byKey: { [only]: { seasonal: { mid: bent } } } }, parseState(''))));
  assert.ok(bentPanel.includes('777 days of context'), 'the context length is the run’s, not a literal');
  assert.ok(bentPanel.includes('3 per batch'), 'so is the batch size');
  assert.ok(bentPanel.includes('deadbeefdeadbeef') && !bentPanel.includes(h.config_fingerprint), 'and the fingerprint');
});

test('the chain says what our workflow does with the model, in order, and marks the one foreign link', () => {
  const html = renderPage(buildModel(reports, parseState('')));
  const panel = html.slice(html.indexOf('<details class="panel" id="model">'), html.indexOf('<details class="panel" id="method">'));
  const chain = panel.slice(panel.indexOf('<ol class="flow">'), panel.indexOf('</ol>'));
  const nodes = [...chain.matchAll(/<li class="fn (\w+)"><b>([^<]+)<\/b>/g)].map(x => [x[1], x[2]]);
  assert.deepEqual(nodes.map(n => n[1]), [
    'PEGELONLINE daily archive', 'loaders.py — windows', 'baselines.py — the bar',
    'tfm.py — TimesFM 2.5', 'metrics.py — the scores', 'gate.py — the clauses', 'report.json — this page',
  ], 'archive to page, every step of ours named by its file');
  assert.deepEqual(nodes.map(n => n[0]), ['src', 'step', 'step', 'model', 'step', 'step', 'out']);
  assert.equal(nodes.filter(n => n[0] === 'model').length, 1, 'exactly one foreign link');
  // what the model is NOT given is as much a result as what it is
  assert.match(chain, /no rain, no upstream gauge, no calendar feature/);
  assert.match(chain, /the point forecast is the median/, 'which channel gets scored');
  // and the commands, so a reader can re-run it — in their own fold, not counted as a table twin
  const cmds = panel.slice(panel.indexOf('<details class="cmds">'));
  assert.match(cmds, /uv run python backtest\.py --horizon seasonal --target mid/);
  assert.match(cmds, /uv run python gate\.py --results/);
  assert.match(cmds, /--compare/, 'including the second run that must reproduce it');
  assert.match(cmds, /CI installs the same environment <em>without<\/em> the model group/, 'and that CI does not run the model');
});

test('nothing the deploy stamps appears here, and no closing script tag is ever emitted', () => {
  const html = renderPage(buildModel(reports, parseState('')));
  assert.ok(!html.includes('__COMMIT__') && !html.includes('__LASTMOD__'));
  assert.ok(!html.includes('</script'));
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(page.includes('href="gate.css"') && page.includes('src="gate.js"'), 'relative asset paths — the site lives on a subpath');
  assert.ok(!/href="\/|src="\//.test(page), 'no root-absolute URLs');
});

// ---------- more than one candidate on the sheet ----------

const chipRow = html => (html.match(/<nav class="p-tabs" aria-label="model[^"]*">[\s\S]*?<\/nav>/) || [''])[0];

test('the model chips are state in the URL, and the last one on cannot be switched off', () => {
  assert.ok(MODEL_KEYS.length >= 2, 'this whole section is vacuous with one model');
  // the default is every model that loaded, and the default carries no parameter —
  // so every URL that predates the toggle still means exactly what it said
  assert.equal(parseState('', '', null, MODEL_KEYS).models, null);
  assert.equal(stateHref(parseState('', '', null, MODEL_KEYS)), './');
  assert.deepEqual(parseState('?models=3p0', '', null, MODEL_KEYS).models, ['3p0']);
  assert.equal(parseState(`?models=${MODEL_KEYS.join(',')}`, '', null, MODEL_KEYS).models, null, 'all of them IS the default');
  assert.equal(parseState('?models=nonsense', '', null, MODEL_KEYS).models, null, 'an unknown key selects nothing, so everything');
  assert.equal(stateHref(parseState('?models=3p0', '', null, MODEL_KEYS)), '?models=3p0');
  assert.equal(stateHref(parseState('?models=3p0&block=h31-90', '', null, MODEL_KEYS), { panel: 'lead' }), '?models=3p0&block=h31-90#lead');

  const row = chipRow(renderPage(buildModel(reports, parseState('', '', null, MODEL_KEYS))));
  assert.ok(row, 'the chips live in the one filter row, not a nav of their own');
  for (const mo of MANIFEST.models) assert.ok(row.includes(mo.label), `${mo.key} has a chip`);
  // and each carries the curve it switches — the chip's hue alone would be a
  // colour with nothing to attach it to, and hue alone is not how this sheet means
  for (const mo of MANIFEST.models) {
    const mark = markOf(MANIFEST.models, mo.key);
    assert.match(row, new RegExp(`class="mchip m-${mark}[^"]*"[^>]*>\\s*<span class="sw"><svg[^>]*><line class="ln ln-${mark}"`),
      `${mo.key}'s chip shows its own line, in its own dash`);
  }

  // with one model left on, its own chip is disabled rather than gone: a control
  // that vanishes when you use it cannot be found again, and an empty sheet is
  // not a state this page can reach
  const alone = renderPage(buildModel(reports, parseState('?models=3p0', '', null, MODEL_KEYS)));
  // disabled AND still marked current: the model in view must not be painted
  // like an unavailable one while the model switched off looks available
  assert.match(chipRow(alone), /<span class="mchip m-[a-z0-9-]+ off on" aria-disabled="true" aria-current="true" title="TimesFM 3\.0 is the only model in view[^"]*" data-ctl="model">.*?TimesFM 3\.0/);
  // an UNAVAILABLE chip stays plainly off — the two states must not look alike
  const noMax = JSON.parse(JSON.stringify(reports));
  delete noMax.byKey[MODEL_KEYS.find(k => k !== MANIFEST.shipped)].seasonal.max;
  const rowMax = chipRow(renderPage(buildModel(noMax, parseState('?target=max', '', null, MODEL_KEYS))));
  assert.match(rowMax, /<span class="mchip m-[a-z0-9-]+ off" aria-disabled="true"/, 'unavailable is a different state from locked-on');
  const dead = (rowMax.match(/<span class="mchip[^"]*off"[\s\S]*?<\/span>/) || [''])[0];
  assert.ok(dead, 'the dead chip is one element, and these read it, not the row around it');
  assert.ok(!/aria-current/.test(dead), 'and it is not marked current');
  // …and it shows no curve swatch: the model it names is not drawn on this sheet
  assert.ok(!dead.includes('class="sw"'), 'a dead chip does not advertise a line that is nowhere in the drawing');
  assert.ok(chipRow(alone).includes('title="draw TimesFM 2.5 too"'), 'and the other one invites you back');
  // switching the second one on returns to the parameter-free default
  assert.ok(chipRow(alone).includes('href="./#lead"'), 'the way back is the bare URL');
});

test('every model in view is drawn, named in the key, and a model that cannot ship says so', () => {
  const both = buildModel(reports, parseState('', '', null, MODEL_KEYS));
  const html = renderPage(both);
  const lead = section(html, 'lead');
  assert.equal(both.lead.curves.length, MODEL_KEYS.length, 'one curve per model in view');
  assert.deepEqual(both.lead.curves.map(c => c.mark), MODEL_MARKS.slice(0, MODEL_KEYS.length),
    'the mark is bound to the model, not to its position');
  for (const c of both.lead.curves) {
    assert.ok(new RegExp(`<path class="ln ln-${c.mark}"`).test(lead), `${c.label} is drawn`);
    const key = (lead.match(/<dl class="p-key">[\s\S]*?<\/dl>/) || [''])[0];
    assert.ok(key.includes(`ln ln-${c.mark}`) && key.includes(c.label), `${c.label} is in the key`);
  }
  // the non-commercial line carries a glyph, not a colour, and the key says why
  const nc = MANIFEST.models.find(mo => mo.shippable === false);
  if (nc) {
    assert.ok(html.includes(`${nc.label} ${NC_GLYPH}`), 'the chip carries the mark');
    assert.match(html, new RegExp(`${NC_GLYPH} — measured here, never shipped`), 'and the key spells it out');
    assert.ok(html.includes('measured, never shipped'), 'the foot says it too');
  }
  // each model states its own verdict rather than sharing one word
  assert.equal(both.verdicts.length, MODEL_KEYS.length);
  const vlist = (html.match(/<ul class="vmodels"[\s\S]*?<\/ul>/) || [''])[0];
  for (const v of both.verdicts) assert.ok(vlist.includes(v.label) && vlist.includes(v.verdict), `${v.label}: ${v.verdict}`);
  // and the foot names every model in view, with its own licence
  const foot = (html.match(/<footer id="plate-foot">[\s\S]*?<\/footer>/) || [''])[0];
  for (const v of both.verdicts) assert.ok(foot.includes(v.head.checkpoint), `${v.label}'s checkpoint is in the foot`);
});

test('switching a model off makes the WHOLE sheet speak for the other one', () => {
  // the failure this guards: the plate drawing one model's numbers under prose,
  // links and panel titles that name another
  for (const mo of MANIFEST.models) {
    const m = buildModel(reports, parseState(`?models=${mo.key}`, '', null, MODEL_KEYS));
    const html = renderPage(m);
    assert.equal(m.primary.key, mo.key);
    assert.equal(m.lead.curves.length, 1);
    const others = MANIFEST.models.filter(x => x.key !== mo.key);
    assert.ok(html.includes(`Skill by gauge · ${mo.label} ·`), `${mo.key}: the skill panel names it`);
    assert.ok(html.includes(`Calibration · ${mo.label} ·`), `${mo.key}: calibration names it`);
    if (m.short) assert.ok(html.includes(`Short horizon · ${mo.label} ·`), `${mo.key}: the short-horizon panel names it`);
    assert.ok(screenSummary(m).startsWith(`Forecast gate, ${m.verdict}. ${mo.label} against`), `${mo.key}: the screen-reader summary names it`);
    assert.ok(m.gist.includes(`target ${mo.label} beats`), `${mo.key}: the gist names it`);
    const modelPanel = html.slice(html.indexOf('<details class="panel" id="model">'), html.indexOf('<details class="panel" id="method">'));
    assert.ok(modelPanel.includes(mo.checkpoint), `${mo.key}: the model panel shows its own checkpoint`);
    assert.ok(modelPanel.includes(`href="https://huggingface.co/${mo.checkpoint}"`), `${mo.key}: and links its own card`);
    // everything BUT the control row, which legitimately names every model you
    // could switch on — the rest of the sheet must belong to the one in view
    const sheet = html.replace(/<nav class="p-tabs"[\s\S]*?<\/nav>/g, '');
    for (const other of others) {
      assert.ok(!sheet.includes(other.checkpoint), `${mo.key}: ${other.key}'s checkpoint survives somewhere on the sheet`);
      assert.ok(!sheet.includes(other.label), `${mo.key}: ${other.key}'s NAME survives somewhere on the sheet`);
      assert.ok(!sheet.includes(other.files['seasonal-mid'].json), `${mo.key}: a link to ${other.key}'s report survives`);
      if (other.files['seasonal-mid'].md) assert.ok(!sheet.includes(other.files['seasonal-mid'].md), `${mo.key}: a link to ${other.key}'s write-up survives`);
    }
    // and the write-ups the foot offers are the ones of the model in view
    const foot = (html.match(/<footer id="plate-foot">[\s\S]*?<\/footer>/) || [''])[0];
    for (const [, f] of Object.entries(mo.files)) if (f.md) assert.ok(foot.includes(f.md), `${mo.key}: the foot links ${f.md}`);
  }
});

test('skill and calibration draw one bar per model, each out of its own report', () => {
  const both = buildModel(reports, parseState(''));
  assert.ok(both.drawn.length > 1, 'the default sheet draws every candidate');
  const html = renderPage(both);
  const skill = panel(html, 'skill');
  // two bars per gauge row, and the slot classes that place and colour them
  const bars = skill.match(/<span class="bar [^"]*"/g) || [];
  assert.equal(bars.length, (both.skill.rows.length + 1) * both.drawn.length, 'a bar per gauge and per model, plus the pooled row');
  assert.ok(bars.every(b => /\bm[12]\b/.test(b)), 'every bar says which model it is');
  assert.equal((skill.match(/class="ci m[12]"/g) || []).length, both.drawn.length, 'a bootstrap interval per model');
  // the numbers are each model's own, not the primary's repeated
  for (const r of both.skill.rows) {
    const own = both.drawn.map(mo => readReport(mo.files['seasonal-mid'].json).stations[r.station].blocks[both.block].ss);
    assert.deepEqual(r.bars.map(b => b.ss), own, `${r.station}: each bar is its model's own skill`);
  }
  assert.deepEqual(both.skill.pooled.bars.map(b => b.key), both.drawn.map(mo => mo.key));
  assert.notEqual(both.skill.pooled.bars[0].ss, both.skill.pooled.bars[1].ss, 'the pooled bars are not the same number twice');
  // calibration: a mark and a PIT histogram per model, named
  const calib = panel(html, 'calib');
  assert.equal((calib.match(/<div class="pit">/g) || []).length, both.calib.length * both.drawn.length, 'a PIT histogram per gauge and model');
  // the visible caption, not just the aria-label: the model sits on its own line
  for (const mo of both.drawn) assert.ok(calib.includes(`${both.calib[0].station}<span class="mn">${mo.label}</span>`), `the histograms name ${mo.key} where a reader can see it`);
  // and with one model on, the row goes back to a single bar with no slot class
  const one = buildModel(reports, parseState(`?models=${MANIFEST.shipped}`, '', null, MODEL_KEYS));
  const oneSkill = panel(renderPage(one), 'skill');
  assert.equal((oneSkill.match(/<span class="bar [^"]*"/g) || []).length, one.skill.rows.length + 1);
  assert.ok(!/\bbar [a-z]+ m[12]\b/.test(oneSkill), 'no slot class when there is nothing to tell apart');
});

test('the short-horizon panel draws the run of the model in view, not the shipped one', () => {
  // the 15-minute grid is its own test set: a second candidate measured there
  // must reach the panel, or switching models would silently keep 2.5's numbers
  const withShort = MANIFEST.models.filter(mo => mo.files['short-mid']);
  assert.ok(withShort.length > 1, 'more than one candidate has been measured on the 15-minute grid');
  const own = new Map();
  for (const mo of withShort) {
    const m = buildModel(reports, parseState(`?models=${mo.key}`, '', null, MODEL_KEYS));
    const rep = readReport(mo.files['short-mid'].json);
    assert.equal(m.short.generated, rep.header.generated, `${mo.key}: the panel reads its own run`);
    assert.equal(rep.header.model_key || MANIFEST.shipped, mo.key, `${mo.key}: and that run is its own`);
    const mae = rep.stations.KOBLENZ.blocks['h1-6h'].mae.tfm_point;
    assert.equal(m.short.stations.find(s => s.name === 'KOBLENZ').blocks['h1-6h'].mae.tfm_point, mae);
    assert.ok(panel(renderPage(m), 'short').includes(mae.toFixed(1)), `${mo.key}: and prints it`);
    own.set(mo.key, mae);
  }
  assert.equal(new Set(own.values()).size, own.size, 'the candidates are not showing each other’s numbers');
});

test('the manifest decides what is offered — a model whose report did not load is not a chip', () => {
  const only = MANIFEST.shipped;
  const half = { models: MANIFEST.models, byKey: { [only]: reports.byKey[only] } };  // the challenger answered nothing
  const m = buildModel(half, parseState('', '', null, MODEL_KEYS));
  assert.deepEqual(m.models.map(mo => mo.key), [only], 'only what loaded is offered');
  assert.equal(m.lead.curves.length, 1);
  const html = renderPage(m);
  assert.ok(!chipRow(html), 'with one model there is no model row at all');
  assert.ok(html.includes('aria-label="target and horizon block"'), 'and the filter row is what it always was');
  // asking for the model that did not load still renders, on the one that did
  const asked = buildModel(half, parseState('?models=3p0', '', null, MODEL_KEYS));
  assert.equal(asked.primary.key, only, 'a selection that matches nothing falls back to what exists');
});

test('with two candidates drawn the sheet measures how far apart they are', () => {
  const both = buildModel(reports, parseState('', '', null, MODEL_KEYS));
  const g = both.lead.gap;
  assert.ok(g, 'two curves get a measured gap');
  assert.ok(g.d > 0 && g.d < 1, `a ratio difference, not a percentage (${g.d})`);
  assert.ok(g.day >= 1 && g.day <= both.lead.H);
  assert.ok(both.lead.curves.some(c => c.label === g.ahead), 'the lower curve is one of the drawn ones');
  // the number reaches the reader, and it is the measured one
  const lead = section(renderPage(both), 'lead');
  assert.ok(lead.includes(`${(g.d * 100).toFixed(1)} points of the blend`), 'the key prints the gap it measured');
  assert.ok(lead.includes(`on day ${g.day}`) && lead.includes(g.ahead), 'and where, and which curve is lower');
  // one model alone has nothing to compare, and says nothing
  const alone = buildModel(reports, parseState(`?models=${MANIFEST.shipped}`, '', null, MODEL_KEYS));
  assert.equal(alone.lead.gap, null);
  assert.ok(!section(renderPage(alone), 'lead').includes('points of the blend'));
  // and it must move with the data, not be a literal
  const bent = structuredClone(reports);
  const other = MODEL_KEYS.find(k => k !== MANIFEST.shipped);
  bent.byKey[other].seasonal.mid.pooled.per_h_ratio_median.tfm_point =
    bent.byKey[MANIFEST.shipped].seasonal.mid.pooled.per_h_ratio_median.tfm_point.map(v => v + 0.5);
  const wide = buildModel(bent, parseState('', '', null, MODEL_KEYS)).lead.gap;
  assert.ok(Math.abs(wide.d - 0.5) < 1e-9, `the gap follows the data (${wide.d})`);
  assert.equal(wide.ahead, MANIFEST.models.find(mo => mo.key === MANIFEST.shipped).label, 'and names the lower curve');
});

test('the table twin carries every model the drawing carries', () => {
  // the drawing gained a mark per model while its table kept one hardcoded
  // column, so a reader who opened it got a different sheet
  for (const q of ['', ...MODEL_KEYS.map(k => `?models=${k}`)]) {
    const m = buildModel(reports, parseState(q, '', null, MODEL_KEYS));
    const html = renderPage(m);
    const errPanel = html.slice(html.indexOf('<details class="panel" id="error">'), html.indexOf('<details class="panel" id="calib">'));
    const head = (errPanel.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
    for (const mo of m.drawn) assert.ok(head.includes(`<th>${mo.label}</th>`), `${q || 'default'}: ${mo.label} has a column`);
    const body = (errPanel.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0];
    const firstRow = (body.match(/<tr>[\s\S]*?<\/tr>/) || [''])[0];
    const cells = [...firstRow.matchAll(/<td>([^<]*)<\/td>/g)].map(x => x[1]);
    for (let i = 0; i < m.drawn.length; i++) {
      assert.notEqual(cells[2 + i], '—', `${q || 'default'}: ${m.drawn[i].label}'s MAE is in the table, not a dash`);
      const mark = m.error[0].marks.find(k => k.kind === m.drawn[i].mark);
      assert.equal(cells[2 + i], mark.mae.toFixed(1), 'and it is the number the drawing plotted');
    }
  }
});

test('every candidate gets a mark of its own, or none at all', () => {
  // clamping to the last mark would draw two models with the SAME line and the
  // same point, and the legend gate would stay green because the class is named
  const fake = n => Array.from({ length: n }, (_, i) => ({ key: `m${i}` }));
  const marks = n => fake(n).map(mo => markOf(fake(n), mo.key));
  for (const n of [1, 2, MODEL_MARKS.length]) {
    assert.equal(new Set(marks(n)).size, n, `${n} models get ${n} distinct marks`);
    assert.ok(marks(n).every(Boolean));
  }
  assert.equal(markOf(fake(MODEL_MARKS.length + 1), `m${MODEL_MARKS.length}`), null,
    'one model more than there are marks gets none — a thing to notice, not a lookalike');
  assert.ok(MODEL_MARKS.length >= MANIFEST.models.length, 'the manifest fits inside the marks that exist');
});

// A mark of its own is only half of it. For as long as there were two candidates
// all four marks resolved to the SAME --water-line, so the sheet drew two curves
// that lie on each other in one hue and asked the reader to follow a dash pattern
// through the overlap. This reads the stylesheet the browser reads and demands a
// colour of its own per mark — for the line, for the point, and for the `--mc`
// every label that names the model inherits.
const CSS = readFileSync(join(ROOT, 'gate.css'), 'utf8');
function modelColours(css) {
  // comments first, or every selector comes back with the paragraph above it attached
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = [];
  for (const r of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const sel of r[1].split(',').map(s => s.trim())) rules.push([sel, r[2]]);
  // LAST wins, both ways the cascade does: a later declaration inside one body,
  // and a later rule for the same selector. Reading the first of either is how a
  // parser stays green while the browser paints something else.
  const declOf = (body, name) => {
    let last = null;
    for (const d of body.matchAll(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'g'))) last = d[1].trim();
    return last;
  };
  const prop = (sel, name) => {
    const hits = rules.filter(([s]) => s === sel);
    assert.ok(hits.length, `gate.css has no rule for ${sel}`);
    let last = null;
    for (const [, body] of hits) { const d = declOf(body, name); if (d != null) last = d; }
    return last;
  };
  // every rule that could repaint a CURVE, whatever its selector — a more
  // specific `.plot-box .ln-tfm-alt { stroke: … }` bypasses a lookup keyed on
  // the plain class name. Only `.ln-*`: on a point mark the stroke is the ink
  // outline around the fill, not the model's identity.
  const touching = mk => rules
    .filter(([s]) => new RegExp(`(?:^|[\\s>+~.])ln-${mk}(?![a-z0-9-])`).test(s))
    .map(([s, body]) => [s, declOf(body, 'stroke')])
    .filter(([, d]) => d != null);
  const rootBody = rules.filter(([s]) => s === ':root').map(([, b]) => b).join(';');
  const tokens = {};
  for (const t of rootBody.matchAll(/(--m\d)\s*:\s*([^;]+)/g)) tokens[t[1]] = t[2].trim();
  // the token's own two hex values, so the test can measure colour, not text
  const hexes = {};
  for (const [k, v] of Object.entries(tokens)) {
    const src = v.startsWith('var(') ? (rootBody.match(new RegExp(`${v.slice(4, -1).trim()}\\s*:\\s*([^;]+)`)) || [, ''])[1] : v;
    const hit = String(src).match(/light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/i);
    if (hit) hexes[k] = { light: hit[1].toLowerCase(), dark: hit[2].toLowerCase() };
  }
  return { tokens, hexes,
    marks: MODEL_MARKS.map(mk => ({
      mk,
      mc: prop(`.m-${mk}`, '--mc'),
      line: prop(`.ln-${mk}`, 'stroke'),
      // the fourth mark is drawn as strokes, not a filled shape, so its colour rides there
      point: prop(`.mk-${mk}`, 'fill') === 'none' ? prop(`.mk-${mk}`, 'stroke') : prop(`.mk-${mk}`, 'fill'),
      strokes: touching(mk),
    })),
  };
}
const distinct = (list, pick) => new Set(list.map(pick)).size;

// WCAG 2.x relative luminance, and OKLCH hue for how far two marks sit apart on
// the wheel. Both live here rather than in a comment in gate.css: a number a
// stylesheet only claims is a number nothing keeps true.
const chan = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const relLum = h => { const [r, g, b] = chan(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const wcag = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
function oklchHue(h) {
  const [r, g, b] = chan(h).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
}
const hueGap = (a, b) => { const d = Math.abs(oklchHue(a) - oklchHue(b)) % 360; return d > 180 ? 360 - d : d; };

test('every mark carries a colour of its own, and no two candidates share one', () => {
  const { tokens, marks } = modelColours(CSS);
  assert.equal(Object.keys(tokens).length, MODEL_MARKS.length, 'one --m token per mark slot, declared on :root');
  for (const m of marks) {
    assert.ok(m.mc && m.line && m.point, `${m.mk}: --mc, its line and its point all name a colour`);
    assert.equal(m.mc, m.line, `${m.mk}: the label's hue IS the curve's hue`);
    assert.equal(m.mc, m.point, `${m.mk}: and the point mark's too`);
    assert.match(m.mc, /^var\(--m\d\)$/, `${m.mk} resolves to one of the model tokens, not to a shared one`);
    // …and NOTHING else repaints it. A rule with a longer selector wins in the
    // browser and is invisible to a lookup keyed on the plain class name.
    assert.deepEqual(m.strokes.filter(([, d]) => d !== m.line), [],
      `${m.mk}: a second rule paints its stroke something else`);
  }
  assert.equal(distinct(marks, m => m.mc), MODEL_MARKS.length, 'no two marks resolve to the same token');

  // and it can go red, four ways it broke or could break. A curve pointed at its
  // neighbour's token — the drawing and the labels drift apart:
  const bentLine = modelColours(CSS.replace('.ln-tfm-alt { stroke: var(--m2)', '.ln-tfm-alt { stroke: var(--m1)'));
  assert.notEqual(bentLine.marks[1].mc, bentLine.marks[1].line, 'the equality above is one an edit can break');
  // a SECOND declaration in the same body, which the browser takes and a
  // first-match parser does not:
  const bentDup = modelColours(CSS.replace('.ln-tfm-alt { stroke: var(--m2);', '.ln-tfm-alt { stroke: var(--m2); stroke: var(--m1);'));
  assert.notEqual(bentDup.marks[1].mc, bentDup.marks[1].line, 'the LAST declaration is the one read');
  // a more specific rule elsewhere in the sheet:
  const bentSpec = modelColours(CSS + '\n.plot-box .ln-tfm-alt { stroke: var(--m1); }\n');
  assert.ok(bentSpec.marks[1].strokes.some(([, d]) => d !== bentSpec.marks[1].line), 'a repaint under any selector is seen');
  // and two tokens holding one colour, which is how all four marks were one blue:
  const bentTok = modelColours(CSS.replace(/--m2:[^;]+/, '--m2: var(--water-line)'));
  assert.equal(bentTok.hexes['--m2'].light, bentTok.hexes['--m1'].light, 'two tokens can hold one colour — the test below is what catches that');
});

// The stylesheet used to CLAIM its separations in a comment, and one of the
// claims was measurably false. The numbers live here instead, off the token hex
// values themselves: a contrast against both papers, and how far apart the marks
// sit on the OKLCH wheel — including from the ochre the climatology baseline
// draws in, which shares the axis with every candidate curve.
test('the model hues are far enough apart, and each is readable on both papers', () => {
  const { hexes } = modelColours(CSS);
  const paper = { light: '#fbfbf9', dark: '#121417' };
  const dry = { light: '#8f6410', dark: '#e3bb63' };   // --dry-line: climatology, drawn on the same axis
  const slots = MODEL_MARKS.map((_, i) => `--m${i + 1}`);
  assert.deepEqual(Object.keys(hexes).sort(), [...slots].sort(), 'every slot resolves to a light/dark hex pair');

  for (const scheme of ['light', 'dark']) {
    for (const s of slots) {
      const r = wcag(hexes[s][scheme], paper[scheme]);
      assert.ok(r >= 4.5, `${s} on ${scheme} paper is ${r.toFixed(2)}:1 — a mark that also carries text needs 4.5`);
    }
    // the pair that is actually drawn together today
    const drawn = hueGap(hexes['--m1'][scheme], hexes['--m2'][scheme]);
    assert.ok(drawn >= 120, `m1 vs m2 on ${scheme} is ${drawn.toFixed(0)}° — the two candidates on one axis need the wide gap`);
    // and every other pair, the ochre baseline included. Five marks on one wheel
    // cannot all sit 90° apart; 55° is what this palette actually holds, and the
    // dash patterns carry the rest.
    const all = { ...Object.fromEntries(slots.map(s => [s, hexes[s][scheme]])), '--dry-line': dry[scheme] };
    const names = Object.keys(all);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const g = hueGap(all[names[i]], all[names[j]]);
      assert.ok(g >= 55, `${names[i]} vs ${names[j]} on ${scheme} is only ${g.toFixed(0)}° apart`);
    }
  }
  // red-proof: the state this sheet shipped in — the second candidate in the first's blue
  const bent = modelColours(CSS.replace(/--m2:[^;]+/, '--m2: light-dark(#2f6d8f, #9fd4ec)'));
  assert.equal(hueGap(bent.hexes['--m1'].light, bent.hexes['--m2'].light), 0, 'one blue for two candidates is 0° apart, and this test is what says so');
});

// The end labels are the picture's own key, so what they may and may not do to a
// value is a contract. The one that matters: a spread label may sit some way from
// its line, but never on the wrong side of the ×1 bar — the boundary the shaded
// half gives a meaning to. Shipped without this, 13 of 40 labels crossed it.
test('a spread label never crosses the bar it is spread around', () => {
  const at = y => ({ y });
  const SPLIT = 66.67;   // leadY(1) as a percentage, with LEAD_DOMAIN = [0.5, 4]
  // four names all ending a hair apart, two either side of the bar
  const packed = stackLabels([at(66.0), at(66.4), at(67.0), at(67.2)], LABEL_GAP, 0, 100, SPLIT);
  assert.equal(packed.length, 4, 'every label survives the spread');
  for (const p of packed) assert.ok(p.y >= 0 && p.y <= 100, `${p.y} stays inside the frame`);
  const [above, below] = [packed.filter(p => p.y <= SPLIT), packed.filter(p => p.y > SPLIT)];
  assert.equal(above.length, 2, 'the two worse-than-the-blend names stay above the bar');
  assert.equal(below.length, 2, 'and the two better-than-the-blend names below it');

  // and it can go red: without the wall, everything is pushed downwards — into
  // the shaded half — whatever side of the bar the line itself ended on
  const noWall = stackLabels([at(66.0), at(66.4), at(67.0), at(67.2)], LABEL_GAP, 0, 100);
  assert.ok(noWall.filter(p => p.y > SPLIT).length > 2, 'unwalled, names cross the bar — which is the bug this guards');

  // the ordering is honest whatever happens: names never swap relative to each other
  const many = stackLabels([at(80), at(10), at(50), at(50), at(51)], LABEL_GAP, 0, 100, SPLIT);
  for (let i = 1; i < many.length; i++) assert.ok(many[i].y >= many[i - 1].y, 'the stack stays monotonic');

  // degenerate input is dropped, not rendered as NaN%
  assert.deepEqual(stackLabels([], LABEL_GAP, 0, 100, SPLIT), []);
  assert.equal(stackLabels([{ y: null }, { y: NaN }, { y: undefined }, { y: '40' }], LABEL_GAP, 0, 100, SPLIT).length, 0,
    'null, NaN, undefined and a string are all not a position');
  // more names than a band can hold crowd, they do not escape the plot
  const crowded = stackLabels(Array.from({ length: 13 }, () => at(50)), LABEL_GAP, 0, 100, SPLIT);
  for (const p of crowded) assert.ok(p.y >= 0 && p.y <= 100, `${p.y} is still inside the frame`);
});

// The whole sheet, not three states: for every gauge × target × block, take each
// end label's rendered top:%, take the value its own line actually ended on, and
// demand they agree about which side of the ×1 bar they are on. Shipped without
// this, 33 of 192 disagreed — climatology ending at ×1.004, worse than the blend,
// with its name printed inside the half painted "better than the blend".
const SPLIT_PCT = 200 / 3;   // leadY(1) as a percentage of the plot height, LEAD_DOMAIN [0.5, 4]
test('no end label sits on the other side of the bar from the line it names', () => {
  let checked = 0, wrong = [];
  for (const target of Object.keys(TARGETS)) for (const block of BLOCKS) for (const lead of ['pooled', ...STATIONS]) {
    const q = `?target=${target}&block=${block}` + (lead === 'pooled' ? '' : `&lead=${encodeURIComponent(lead)}`);
    const m = buildModel(reports, parseState(q, '', STATIONS));
    const lead2 = section(renderPage(m), 'lead');
    const ends = [...lead2.matchAll(/<span class="end" style="top:([\d.]+)%"><span class="sw"><svg[^>]*><line class="ln (ln-[a-z0-9-]+)"/g)]
      .map(x => ({ y: Number(x[1]), cls: x[2] }));
    const drawn = [...lead2.matchAll(/<path class="ln (ln-[a-z0-9-]+)"/g)].map(x => x[1]);
    assert.deepEqual(new Set(ends.map(e => e.cls)), new Set(drawn), `${q}: one name per drawn line, and nothing named that is not drawn`);
    const series = { 'ln-persist': m.lead.series.persist, 'ln-clim': m.lead.series.clim };
    for (const c of m.lead.curves) series['ln-' + c.mark] = c.ratios;
    for (const e of ends) {
      assert.ok(e.y >= 0 && e.y <= 100, `${q}: ${e.cls} at ${e.y}% is outside the plot`);
      const vals = series[e.cls];
      let last = null;
      for (let i = vals.length - 1; i >= 0; i--) { const v = vals[i]; if (v != null && !Number.isNaN(v) && v > 0) { last = v; break; } }
      if (last == null) continue;
      checked++;
      if ((last < 1) !== (e.y > SPLIT_PCT)) wrong.push(`${q} ${e.cls}: ends ×${last.toFixed(3)}, name at ${e.y}%`);
    }
  }
  assert.ok(checked >= 150, `the sweep saw ${checked} labels`);
  assert.deepEqual(wrong, [], 'a name in the shaded half belongs to a line that ended in it');
});

test('a model with no report for the target in view has a dead chip, not a lit one', () => {
  const other = MODEL_KEYS.find(k => k !== MANIFEST.shipped);
  const half = JSON.parse(JSON.stringify(reports));
  delete half.byKey[other].seasonal.max;                       // it has mid, but no max
  const m = buildModel(half, parseState('?target=max', '', null, MODEL_KEYS));
  assert.equal(m.state.target, 'max', 'the shipped model still has the max report');
  assert.deepEqual(m.drawn.map(mo => mo.key), [MANIFEST.shipped], 'only what can be drawn is drawn');
  const row = chipRow(renderPage(m));
  const label = MANIFEST.models.find(mo => mo.key === other).label;
  assert.match(row, new RegExp(`<span class="mchip m-[a-z0-9-]+ off"[^>]*title="${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has no daily max report[^"]*"`),
    'its chip is dead and says why, instead of staying lit over a sheet that is silent about it');
  assert.ok(!/class="mchip m-[a-z0-9-]+ off on"/.test(row), 'dead is not the locked-on state, whatever hue the chip wears');
  // and on the target it does have, it is a live chip again
  assert.ok(chipRow(renderPage(buildModel(half, parseState('', '', null, MODEL_KEYS)))).includes(label), 'on the target it does have, it is live again');
});

test('a licence link that is not plain https never reaches an href', () => {
  const bent = JSON.parse(JSON.stringify(reports));
  const other = MODEL_KEYS.find(k => k !== MANIFEST.shipped);
  for (const rep of Object.values(bent.byKey[other].seasonal)) if (rep) rep.header.model_license_url = 'javascript:alert(1)';
  const html = renderPage(buildModel(bent, parseState('', '', null, MODEL_KEYS)));
  assert.ok(!html.includes('javascript:'), 'the scheme is dropped, not escaped and kept');
  assert.ok(html.includes(`href="${LINKS.card}"`), 'and the foot falls back to a link it trusts');
});

