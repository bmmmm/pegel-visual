// The gate page renders the committed reports without a browser: buildModel and
// renderPage are pure, so the page's own tests run against the real JSON.
// Runtime behaviour (focus after a re-render, popstate, the cursor) has no DOM
// here — scripts/gate-check.mjs drives a real Chrome for that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS, PANEL_IDS, TARGETS, buildModel, leadSay, parseState, renderPage, screenSummary, stateHref } from '../gate/gate.js';

const ROOT = new URL('../gate/', import.meta.url).pathname;
const load = name => JSON.parse(readFileSync(join(ROOT, name, 'report.json'), 'utf8'));
const reports = { seasonal: { mid: load('seasonal-mid'), max: load('seasonal-max') }, short: load('short-mid') };
const STATIONS = Object.keys(reports.seasonal.mid.stations);

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
    assert.ok(html.includes(`Skill by gauge · ${state.target === 'mid' ? 'daily mid' : 'daily max'} ·`), 'the skill panel names the target');
    seen.add(m.skill.pooled.ss.toFixed(4) + state.target);
  }
  assert.equal(seen.size, 6, 'six distinct pooled skills — one per target and block');
  const long = buildModel(reports, parseState('?block=h31-90'));
  assert.ok(long.skill.pooled.ss < 0, 'at three months the model is behind the blend');
  const short = buildModel(reports, parseState(''));
  assert.ok(short.skill.pooled.ss > 0.05 && short.skill.pooled.ss < 0.10, 'a real but sub-bar win at two weeks');
});

test('the report carries a curve over the lead day, and the curve tells the story', () => {
  const mid = reports.seasonal.mid;
  for (const s of Object.values(mid.stations)) {
    assert.equal(Object.keys(s.per_h).length, 6);
    for (const v of Object.values(s.per_h)) assert.equal(v.length, 90);
  }
  assert.equal(mid.pooled.per_h.blend.length, 90);
  assert.ok(mid.pooled.per_h_ratio_median.blend.every(v => Math.abs(v - 1) < 1e-9), 'the blend is the unit');
  const L = buildModel(reports, parseState('')).lead;
  assert.equal(L.station, 'pooled');
  assert.deepEqual(L.stations, STATIONS);
  assert.ok(L.series.tfm[0] < 0.9, `TimesFM wins on day 1 (×${L.series.tfm[0]})`);
  assert.ok(L.series.tfm[13] < 1, 'still ahead at day 14');
  assert.ok(Math.abs(L.series.tfm[89] - 1) < 0.05, 'a draw by day 90');
  assert.ok(L.series.clim[0] > 2 && Math.abs(L.series.clim[89] - 1) < 0.02, 'Finding 2: climatology starts far off and ends on the blend');
  assert.ok(L.series.persist[89] > 1.3, 'persistence never recovers');
  assert.deepEqual(L.blocks.map(b => [b.from, b.to]), [[1, 14], [15, 30], [31, 90]]);
  assert.equal(L.cursor, 14, 'the cursor starts on the last day of the picked block');
  assert.equal(buildModel(reports, parseState('?block=h31-90')).lead.cursor, 90);
  assert.match(leadSay(L, 14), /^day 14: TimesFM ×0\.\d\d · climatology ×\d\.\d\d · persistence ×\d\.\d\d · blend MAE \d+\.\d cm pooled$/);
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
  assert.match(lead, /<svg viewBox="0 0 320 120" preserveAspectRatio="none" tabindex="0" role="slider" data-lead aria-valuemin="1" aria-valuemax="90" aria-valuenow="14" aria-valuetext="day 14: /);
  assert.ok(lead.includes('<h2 class="p-h2" tabindex="-1">Error by lead day · DRESDEN</h2>'));
  const gaugeRow = (lead.match(/<nav class="p-tabs"[\s\S]*?<\/nav>/) || [''])[0];
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
// not marks: layout, text, hit targets and states the key spells out in words (▸ ◂ ▴ ▾ are glyphs in the notes)
const NOT_A_MARK = new Set(['p-block', 'row', 'pooled', 'head', 'lbl', 'rg', 'track', 'val', 'axis', 'ticks', 'mk', 'sw', 'hint', 'p-readout', 'p-dim', 'p-tabs', 'p-tabs-lbl', 'on', 'off', 'rows', 'pits', 'pit', 'nm',
  'plot', 'vscale', 'plot-box', 'lead-bands', 'lbn', 'lead-ticks', 'clip', 'lo', 'hi', 'up', 'dn', 'vh', 'p-h2']);
test('every mark a section draws is named in that section’s key — mechanically', () => {
  let drawings = 0;
  for (const state of [...everyState, parseState('?lead=DRESDEN', '', STATIONS)]) {
    const html = renderPage(buildModel(reports, state));
    const sections = html.split(/<details class="panel"|<section id="lead"/).slice(1).filter(s => s.includes('class="rows"') || s.includes('class="pits"') || s.includes('class="plot"'));
    assert.ok(sections.length >= 5, 'lead, skill, error, calibration, finding 2 (and short)');
    for (const s of sections) {
      const key = (s.match(/<dl class="p-key">[\s\S]*?<\/dl>/) || [''])[0];
      assert.ok(key, 'a section with a drawing has a key');
      const drawing = s.slice(0, s.indexOf('<dl class="p-key">')).replace(/<details class="tbl">[\s\S]*?<\/details>/g, '');
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
  const missing = [...classesIn(lead.slice(0, lead.indexOf('<dl class="p-key">')))].filter(c => !NOT_A_MARK.has(c) && !classesIn(lead.match(/<dl class="p-key">[\s\S]*?<\/dl>/)[0]).has(c));
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
  assert.deepEqual(parseState(''), { target: 'mid', block: 'h1-14', lead: 'pooled', panel: null });
  assert.deepEqual(parseState('?target=max&block=h31-90', '#calib'), { target: 'max', block: 'h31-90', lead: 'pooled', panel: 'calib' });
  assert.deepEqual(parseState('?target=bogus&block=nope&lead=', '#nowhere'), { target: 'mid', block: 'h1-14', lead: 'pooled', panel: null });
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
  assert.ok(html.includes('<a href="?target=max&amp;block=h31-90#skill" data-focus="skill">'), 'the block chip keeps the target and names the panel it opens');
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
  assert.equal(links.length, 7);
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
  assert.deepEqual(ids, ['skill', 'error', 'calib', 'clim', 'short', 'method', 'basics']);
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
  assert.ok(html.indexOf('id="lead"') < html.indexOf('class="facts"') && html.indexOf('class="facts"') < html.indexOf('class="index"') && html.indexOf('class="index"') < html.indexOf('<nav class="p-tabs" aria-label="target and horizon block">') && html.indexOf('aria-label="target and horizon block"') < html.indexOf('<details class="panel"'), 'curve · in brief · index · filter row · panels');
});

test('a hostile station name never reaches the markup unescaped', () => {
  const evil = JSON.parse(JSON.stringify(reports));
  const bad = '<img src=x onerror=alert(1)>';
  const r = evil.seasonal.mid;
  r.stations[bad] = r.stations['KÖLN'];
  r.station_info[bad] = r.station_info['a6ee8177-107b-47dd-bcfd-30960ccc6e9c'];
  r.regimes['Mittelrhein'].members.push(bad);
  for (const lead of ['pooled', bad]) {
    const html = renderPage(buildModel(evil, { target: 'mid', block: 'h1-14', lead, panel: null }));
    assert.ok(!html.includes(bad));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  }
});

test('the page survives a missing max or short report — one panel fewer, no dead index link, no relabelled run', () => {
  const m = buildModel({ seasonal: { mid: reports.seasonal.mid } }, parseState('?target=max'));
  assert.equal(m.verdict, 'NO-SHIP');
  assert.equal(m.target, 'mid', 'the mid run is not passed off as the max run');
  assert.equal(m.state.target, 'mid');
  assert.ok(m.gist.startsWith('On the daily mid target'));
  const html = renderPage(m);
  assert.ok(html.includes('<span class="off" aria-disabled="true" title="the daily max report did not load">daily max</span>'), 'the max chip is there, but not a link');
  assert.ok(!html.includes('daily max ·'), 'no panel title claims the max run');
  assert.ok(html.includes('<a href="./#skill" class="on" aria-current="true"'), 'the mid chip is current');
  assert.ok(!html.includes('Short horizon'), 'no short panel without its report');
  assert.ok(!html.includes('#short"'), 'and no index link to it');
  assert.deepEqual(m.panels.map(p => p.id), ['skill', 'error', 'calib', 'clim', 'method', 'basics']);
  assert.ok(html.includes('FORECAST GATE'));
  assert.equal((html.match(/data-readout/g) || []).length, 5);
});

test('the summary spoken to screen readers names verdict, target, block and the interval', () => {
  const s = screenSummary(buildModel(reports, parseState('?block=h31-90')));
  assert.match(s, /NO-SHIP/);
  assert.match(s, /daily mid target, days 31–90/);
  assert.match(s, /95 % interval from -0\.\d+ to \+?0\.\d+/);
});

test('gist, facts and basics quote the report, not a remembered number', () => {
  const mid = reports.seasonal.mid, max = reports.seasonal.max;
  const pc = v => `${Math.round(Math.abs(v) * 100)} %`;
  // the gist follows the target
  const gm = buildModel(reports, parseState('')), gx = buildModel(reports, parseState('?target=max'));
  assert.notEqual(gm.gist, gx.gist);
  assert.ok(gm.gist.startsWith('On the daily mid target TimesFM beats the blend by ' + pc(mid.pooled.blocks['h1-14'].ss) + ' at two weeks'));
  assert.ok(gx.gist.startsWith('On the daily max target TimesFM beats the blend by ' + pc(max.pooled.blocks['h1-14'].ss) + ' at two weeks'));
  assert.ok(gm.gist.includes(`is ${pc(mid.pooled.blocks['h31-90'].ss)} behind by three months`));
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
  assert.ok(f1[4].html.includes('<b>2026-08-28</b>') && f1[4].html.includes(`<b>${mid.header.model}</b>`));
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

test('nothing the deploy stamps appears here, and no closing script tag is ever emitted', () => {
  const html = renderPage(buildModel(reports, parseState('')));
  assert.ok(!html.includes('__COMMIT__') && !html.includes('__LASTMOD__'));
  assert.ok(!html.includes('</script'));
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(page.includes('href="gate.css"') && page.includes('src="gate.js"'), 'relative asset paths — the site lives on a subpath');
  assert.ok(!/href="\/|src="\//.test(page), 'no root-absolute URLs');
});
