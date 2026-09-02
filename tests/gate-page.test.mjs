// The gate page renders the committed reports without a browser: buildModel and
// renderPage are pure, so the page's own tests run against the real JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS, TARGETS, buildModel, parseState, renderPage, screenSummary, stateHref } from '../gate/gate.js';

const ROOT = new URL('../gate/', import.meta.url).pathname;
const load = name => JSON.parse(readFileSync(join(ROOT, name, 'report.json'), 'utf8'));
const reports = { seasonal: { mid: load('seasonal-mid'), max: load('seasonal-max') }, short: load('short-mid') };

const everyState = [];
for (const target of Object.keys(TARGETS)) for (const block of BLOCKS) everyState.push({ target, block });

test('the committed reports say NO-SHIP, seven clauses, five regimes, seven gauges', () => {
  const m = buildModel(reports, { target: 'mid', block: 'h1-14' });
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
    assert.ok(html.includes(`· ${state.target === 'mid' ? 'daily mid' : 'daily max'} ·`), 'the skill heading names the target');
    seen.add(m.skill.pooled.ss.toFixed(4) + state.target);
  }
  assert.equal(seen.size, 6, 'six distinct pooled skills — one per target and block');
  const long = buildModel(reports, { target: 'mid', block: 'h31-90' });
  assert.ok(long.skill.pooled.ss < 0, 'at three months the model is behind the blend');
  const short = buildModel(reports, { target: 'mid', block: 'h1-14' });
  assert.ok(short.skill.pooled.ss > 0.05 && short.skill.pooled.ss < 0.10, 'a real but sub-bar win at two weeks');
});

test('every mark a section draws is named in that section’s key', () => {
  for (const state of everyState) {
    const html = renderPage(buildModel(reports, state));
    const sections = html.split('<section class="p-block"').slice(1).filter(s => s.includes('class="rows"') || s.includes('class="pits"'));
    assert.ok(sections.length >= 4, 'skill, error, calibration, finding 2 (and short)');
    for (const s of sections) {
      const key = (s.match(/<dl class="p-key">[\s\S]*?<\/dl>/) || [''])[0];
      assert.ok(key, 'a section with a drawing has a key');
      const drawing = s.slice(0, s.indexOf('<dl class="p-key">'));
      const marks = new Set();
      for (const mm of drawing.matchAll(/class="(?:mk mk-|sw mk-|bar |band|thr|ci|zero|one|link|meter|pb|pu)([\w-]*)"?/g)) marks.add(mm[0].replace(/"$/, ''));
      for (const cls of ['mk-tfm', 'mk-persist', 'mk-clim', 'mk-snaive', 'mk-up', 'mk-picp-t', 'mk-picp-b', 'bar pos', 'bar neg', 'bar tie', 'class="band', 'class="thr', 'class="ci', 'class="meter', 'class="pb', 'class="pu']) {
        if (drawing.includes(cls)) assert.ok(key.includes(cls), `${cls} is drawn but not in the key of: ${s.slice(0, 60)}`);
      }
    }
  }
});

test('every row carries its readout sentence, every chart its table twin', () => {
  const html = renderPage(buildModel(reports, { target: 'max', block: 'h15-30' }));
  const rows = html.match(/<div class="row[^"]*" tabindex="0" role="button" data-say="[^"]+">/g) || [];
  assert.ok(rows.length >= 7 * 4 + 1 + 7, `rows: ${rows.length}`);
  assert.ok(!/<div class="row[^"]*" tabindex="0" role="button">/.test(html), 'no silent row');
  assert.equal((html.match(/<details class="tbl">/g) || []).length, 4, 'skill, error, calibration, short');
  assert.equal((html.match(/data-readout/g) || []).length, 5);
  for (const c of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) assert.ok(html.includes(`>${c} `), `${c} chip`);
  assert.ok(html.includes('<span class="g" aria-hidden="true">✗</span>') && html.includes('<span class="g" aria-hidden="true">✓</span>'), 'pass and fail carry a glyph, not only a colour');
});

test('state round-trips through the URL, chips are real links', () => {
  assert.deepEqual(parseState(''), { target: 'mid', block: 'h1-14' });
  assert.deepEqual(parseState('?target=max&block=h31-90'), { target: 'max', block: 'h31-90' });
  assert.deepEqual(parseState('?target=bogus&block=nope'), { target: 'mid', block: 'h1-14' });
  assert.equal(stateHref({ target: 'mid', block: 'h1-14' }), './');
  assert.equal(stateHref({ target: 'mid', block: 'h1-14' }, { block: 'h31-90' }), '?block=h31-90');
  assert.equal(stateHref({ target: 'max', block: 'h15-30' }), '?target=max&block=h15-30');
  const html = renderPage(buildModel(reports, { target: 'max', block: 'h15-30' }));
  assert.ok(html.includes('<a href="?target=max&amp;block=h31-90"'), 'the block chip keeps the target');
  assert.ok(html.includes('class="on" aria-current="true"'), 'the active chip is marked');
});

test('a hostile station name never reaches the markup unescaped', () => {
  const evil = JSON.parse(JSON.stringify(reports));
  const bad = '<img src=x onerror=alert(1)>';
  const r = evil.seasonal.mid;
  r.stations[bad] = r.stations['KÖLN'];
  r.station_info[bad] = r.station_info['a6ee8177-107b-47dd-bcfd-30960ccc6e9c'];
  r.regimes['Mittelrhein'].members.push(bad);
  const html = renderPage(buildModel(evil, { target: 'mid', block: 'h1-14' }));
  assert.ok(!html.includes(bad));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('the page survives a missing max or short report', () => {
  const m = buildModel({ seasonal: { mid: reports.seasonal.mid } }, { target: 'max', block: 'h1-14' });
  assert.equal(m.verdict, 'NO-SHIP');
  const html = renderPage(m);
  assert.ok(!html.includes('Short horizon'), 'no short section without its report');
  assert.ok(html.includes('FORECAST GATE'));
});

test('the summary spoken to screen readers names verdict, target, block and the interval', () => {
  const s = screenSummary(buildModel(reports, { target: 'mid', block: 'h31-90' }));
  assert.match(s, /NO-SHIP/);
  assert.match(s, /daily mid target, days 31–90/);
  assert.match(s, /95 % interval from -0\.\d+ to \+?0\.\d+/);
});

test('the write-up quotes the report, not a remembered number, and the main page links to it', () => {
  const m = buildModel(reports, { target: 'max', block: 'h31-90' });
  const html = renderPage(m);
  const story = (html.match(/<section class="p-block prose" id="writeup">[\s\S]*?<\/section>/) || [''])[0];
  assert.ok(story, 'a write-up section with an anchor');
  const mid = reports.seasonal.mid;
  assert.equal(m.story.verdict, mid.verdict, 'the story tells the primary run whatever the chips say');
  assert.equal(m.story.h1, `${Math.round(mid.pooled.blocks['h1-14'].ss * 100)} %`);
  assert.ok(story.includes(`beats the blend by ${m.story.h1}`));
  assert.ok(story.includes(`${m.story.rhine90} behind on the Rhine`));
  assert.equal(m.story.climWorst, 'DRESDEN', 'the one gauge where climatology is not a near-tie');
  assert.ok(story.includes('TimesFM 2.5') && story.includes('zero-shot') && story.includes('2026-08-28'));
  assert.ok(html.indexOf('id="writeup"') < html.indexOf('<nav class="p-tabs"'), 'the write-up sits before the filter row');
  const page = readFileSync(join(ROOT, '..', 'index.html'), 'utf8');
  assert.ok(page.includes('<a href="gate/" id="gate-link"'), 'the site footer links the gate');
  assert.ok(page.includes('<dt>forecast gate</dt>'), 'the feature guide explains it');
  assert.equal((page.match(/href="gate\/"/g) || []).length, 2, 'footer and guide, relative — the site lives on a subpath');
});

test('nothing the deploy stamps appears here, and no closing script tag is ever emitted', () => {
  const html = renderPage(buildModel(reports, { target: 'mid', block: 'h1-14' }));
  assert.ok(!html.includes('__COMMIT__') && !html.includes('__LASTMOD__'));
  assert.ok(!html.includes('</script'));
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(page.includes('href="gate.css"') && page.includes('src="gate.js"'), 'relative asset paths — the site lives on a subpath');
  assert.ok(!/href="\/|src="\//.test(page), 'no root-absolute URLs');
});
