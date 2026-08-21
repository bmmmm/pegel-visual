// scripts/fetch-wsv-archive.mjs — the three defects the 2026-08-21 data audit
// found in the archived bundles, each pinned at its root:
//   1. sensor sentinels (99999, -32753, 65250, 1300000, 2568900) bucketed as
//      water — 83 values across 23 stations
//   2. every requested range's Dec 31 flattened to min == max, because the ZIP
//      prepare endpoint reads `end` as midnight — ~2076 station-years
//   3. a station leaving the live WSV list losing its manifest entry while its
//      data directory stays on disk — ILMENAU, 14 closed years, invisible
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAUSIBLE_MIN_CM as RIVER_MIN_CM, PLAUSIBLE_MAX_CM as RIVER_MAX_CM }
  from '../scripts/build-river-totals.mjs';

// pin the clock before the module reads it: CURRENT_YEAR decides which year a
// current.json counts as in the manifest
process.env.PEGEL_NOW = '2026-08-21T09:00:00Z';
const CURRENT_YEAR = 2026;
const {
  condense, daysInYear, buildManifest, freezeFromZip,
  requestEnd, lastYearOf, planChunks, dropSpillYears,
  PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM,
} = await import('../scripts/fetch-wsv-archive.mjs');

const tmp = prefix => mkdtempSync(join(tmpdir(), prefix));
const doy = (y, m, d) => Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5);

// ---------- 1. sentinel filter ----------

test('condense drops sensor sentinels and keeps the real readings around them', () => {
  const years = condense([
    { timestamp: '2025-06-10T00:15:00+01:00', value: 312 },
    { timestamp: '2025-06-10T06:00:00+01:00', value: 99999 },
    { timestamp: '2025-06-10T07:00:00+01:00', value: -32753 },
    { timestamp: '2025-06-10T08:00:00+01:00', value: 65250 },
    { timestamp: '2025-06-10T09:00:00+01:00', value: 1300000 },
    { timestamp: '2025-06-10T10:00:00+01:00', value: 2568900 },
    { timestamp: '2025-06-10T18:00:00+01:00', value: 341 },
  ]);
  const d = doy(2025, 6, 10);
  assert.equal(years.get(2025).min[d], 312, 'the -32753 family must not become the day min');
  assert.equal(years.get(2025).max[d], 341, 'the 99999 family must not become the day max');
});

test('condense leaves a sentinel-only day as a gap rather than a lie', () => {
  const years = condense([
    { timestamp: '2025-06-11T06:00:00+01:00', value: 99999 },
    { timestamp: '2025-06-11T18:00:00+01:00', value: 99999 },
    { timestamp: '2025-06-12T12:00:00+01:00', value: 404 },
  ]);
  const bad = doy(2025, 6, 11);
  assert.equal(years.get(2025).min[bad], null);
  assert.equal(years.get(2025).max[bad], null);
  assert.equal(years.get(2025).max[doy(2025, 6, 12)], 404, 'the next day is untouched');
});

test('the sentinel filter is unit-agnostic: m+NN magnitudes and the bounds themselves survive', () => {
  // gauges reporting m+NN send values like -0.87 — tiny, real, and inside the bounds
  const years = condense([
    { timestamp: '2025-02-03T06:00:00+01:00', value: -0.87 },
    { timestamp: '2025-02-03T12:00:00+01:00', value: 0 },
    { timestamp: '2025-02-04T12:00:00+01:00', value: PLAUSIBLE_MIN_CM },
    { timestamp: '2025-02-05T12:00:00+01:00', value: PLAUSIBLE_MAX_CM },
    { timestamp: '2025-02-06T12:00:00+01:00', value: PLAUSIBLE_MAX_CM + 1 },
  ]);
  assert.equal(years.get(2025).min[doy(2025, 2, 3)], -0.87);
  assert.equal(years.get(2025).max[doy(2025, 2, 3)], 0);
  assert.equal(years.get(2025).min[doy(2025, 2, 4)], PLAUSIBLE_MIN_CM, 'bounds are inclusive');
  assert.equal(years.get(2025).max[doy(2025, 2, 5)], PLAUSIBLE_MAX_CM, 'bounds are inclusive');
  assert.equal(years.get(2025).max[doy(2025, 2, 6)], null, 'one past the bound is dropped');
});

test('the archive filter and build-river-totals describe the same physical range', () => {
  // the two run over the same numbers at different stages; drifting apart would
  // let a value into the bundle that the totals then silently skip
  assert.equal(PLAUSIBLE_MIN_CM, RIVER_MIN_CM);
  assert.equal(PLAUSIBLE_MAX_CM, RIVER_MAX_CM);
});

// ---------- 2. the Dec-31 midnight request boundary ----------

test('requestEnd/lastYearOf: a window is named by its last full year, sent as the next Jan 1', () => {
  assert.equal(requestEnd(2025), '2026-01-01', 'end=2025-12-31 would return only Dec 31 00:00');
  assert.equal(lastYearOf('2026-01-01'), 2025, 'the Jan-1 boundary belongs to the previous year');
  assert.equal(lastYearOf(requestEnd(2000)), 2000, 'round trip');
  assert.equal(lastYearOf('2026-08-21'), 2026, 'a mid-year window ends inside its own year');
  assert.equal(lastYearOf('2025-12-31'), 2025, 'a legacy year-end date still names its own year');
});

test('a full Dec-31 series condenses to a real span and the Jan-1 spill is dropped', () => {
  const years = condense([
    { timestamp: '2025-12-31T00:00:00+01:00', value: 480 }, // all the old request returned
    { timestamp: '2025-12-31T12:00:00+01:00', value: 512 },
    { timestamp: '2025-12-31T23:45:00+01:00', value: 495 },
    { timestamp: '2026-01-01T00:00:00+01:00', value: 494 }, // the sliver the wider window drags in
  ]);
  const dec31 = daysInYear(2025) - 1;
  assert.equal(years.get(2025).min[dec31], 480);
  assert.equal(years.get(2025).max[dec31], 512, 'not the flattened min == max of the midnight-end bug');
  assert.ok(years.has(2026), 'the Jan-1 end drags a 1-value sliver year in');

  assert.equal(dropSpillYears(years, 2025), years, 'mutates and returns the same map');
  assert.deepEqual([...years.keys()], [2025], 'no year past the requested range reaches writeStation');
  assert.equal(years.get(2025).max[dec31], 512, 'the requested years are untouched');
});

test('planChunks: no chunk ends on Dec 31, and the ascending order lets full years beat slivers', () => {
  const plan = planChunks(2000, requestEnd(2025));
  assert.deepEqual(plan.map(c => c.startYear), [2000, 2003, 2006, 2009, 2012, 2015, 2018, 2021, 2024]);
  assert.equal(plan.at(-1).lastYear, 2025, 'never reaches past the requested last year');
  assert.equal(plan.at(-1).end, '2026-01-01');
  for (const c of plan) assert.ok(!c.end.endsWith('-12-31'), `${c.end} would flatten its Dec 31`);
  // each chunk runs exactly one day into the next chunk's first year, which the
  // next chunk then re-fetches in full — the fold's years.set lets the later,
  // complete year overwrite the sliver
  for (let i = 0; i < plan.length - 1; i++) {
    assert.equal(plan[i].end, `${plan[i + 1].startYear}-01-01`);
    assert.equal(plan[i].lastYear, plan[i + 1].startYear - 1, 'chunks tile the range without a hole');
  }
});

test('planChunks keeps a mid-year window from being widened into the future', () => {
  assert.deepEqual(planChunks(2024, '2026-08-21'), [
    { startYear: 2024, lastYear: 2026, end: '2026-08-21' },
  ]);
  assert.deepEqual(planChunks(2025, requestEnd(2025)), [
    { startYear: 2025, lastYear: 2025, end: '2026-01-01' },
  ]);
  assert.deepEqual(planChunks(2026, requestEnd(2025)), [], 'nothing left to fetch');
});

test("an earlier chunk's sliver year never survives the next chunk's full year", () => {
  // the exact fold fetchCondensed runs over the ascending plan above
  const chunkA = condense([
    { timestamp: '2002-07-01T12:00:00+01:00', value: 300 },
    { timestamp: '2003-01-01T00:00:00+01:00', value: 250 }, // sliver from this chunk's Jan-1 end
  ]);
  const chunkB = condense([
    { timestamp: '2003-01-01T00:00:00+01:00', value: 250 },
    { timestamp: '2003-07-01T12:00:00+01:00', value: 700 },
  ]);
  const years = new Map();
  for (const [y, data] of chunkA) years.set(y, data);
  for (const [y, data] of chunkB) years.set(y, data);
  assert.equal(years.get(2003).max[doy(2003, 7, 1)], 700, 'the full year overwrote the 1-day sliver');
  assert.equal(years.get(2003).min[0], 250, 'and still carries Jan 1');
  assert.equal(years.get(2002).max[doy(2002, 7, 1)], 300);
});

test('freezeFromZip requests through Jan 1 and ignores the spill year', async () => {
  const dir = tmp('pegel-freeze-dec31-');
  const n = daysInYear(2025);
  const cur = { y: 2025, min: Array(n).fill(null), max: Array(n).fill(null) };
  cur.min[n - 1] = 480; cur.max[n - 1] = 480; // the REST accumulation's thin Dec 31
  writeFileSync(join(dir, 'current.json'), JSON.stringify(cur));
  const zy = { min: Array(n).fill(null), max: Array(n).fill(null) };
  zy.min[n - 1] = 470; zy.max[n - 1] = 515; // the full day only the wider window returns
  const sliver = { min: Array(daysInYear(2026)).fill(null), max: Array(daysInYear(2026)).fill(null) };
  sliver.min[0] = 511; sliver.max[0] = 511;

  const calls = [];
  const frozen = await freezeFromZip(dir, 'uuid-x', 2025, async (uuid, y, endDate) => {
    calls.push({ uuid, y, endDate });
    return { years: new Map([[2025, zy], [2026, sliver]]) };
  });

  assert.equal(frozen, true);
  assert.deepEqual(calls, [{ uuid: 'uuid-x', y: 2025, endDate: '2026-01-01' }],
    'end=2025-12-31 would freeze Dec 31 as its 00:00 reading twice');
  const out = JSON.parse(readFileSync(join(dir, 'current.json')));
  assert.equal(out.y, 2025);
  assert.equal(out.min.length, n, 'the 2026 sliver never leaks into the frozen year');
  assert.equal(out.min[n - 1], 470);
  assert.equal(out.max[n - 1], 515, 'Dec 31 is a real span');
});

// ---------- 3. manifest keeps orphaned station dirs ----------

test('buildManifest keeps an orphaned station dir listed and still marks empty stations none', () => {
  const out = tmp('pegel-orphan-');
  mkdirSync(join(out, 'uuid-live'));
  writeFileSync(join(out, 'uuid-live', 'closed.json'), JSON.stringify([{ y: 2024, min: [10], max: [20] }]));
  // gone from the live WSV list, 2 closed years + a running year still on disk
  mkdirSync(join(out, 'uuid-orphan'));
  writeFileSync(join(out, 'uuid-orphan', 'closed.json'), JSON.stringify([
    { y: 2011, min: [100, null], max: [110, null] },
    { y: 2012, min: [120], max: [130] },
  ]));
  writeFileSync(join(out, 'uuid-orphan', 'current.json'), JSON.stringify({ y: CURRENT_YEAR, min: [5], max: [7] }));
  writeFileSync(join(out, 'uuid-orphan', 'meta.json'), JSON.stringify({ name: 'ILMENAU', source: 'Rijkswaterstaat' }));
  // a directory without data files must not be resurrected
  mkdirSync(join(out, 'uuid-nodata'));
  writeFileSync(join(out, 'uuid-nodata', 'meta.json'), JSON.stringify({ name: 'GHOST' }));
  // the manifest about to be overwritten is the last record of the orphan's water
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({
    generated: '', stations: { 'uuid-orphan': { n: 'ILMENAU', w: 'ILMENAU', from: 2011, to: 2012 } },
  }));

  const m = buildManifest([
    { uuid: 'uuid-live', shortname: 'BONN', water: { shortname: 'RHEIN' } },
    { uuid: 'uuid-empty', shortname: 'Marburg', water: { shortname: 'LAHN' } },
  ], out);

  assert.deepEqual(m.stations['uuid-empty'], { n: 'Marburg', w: 'LAHN', none: true },
    'a live station without any data file still reads as none');
  assert.equal(m.stations['uuid-live'].from, 2024);
  const orphan = m.stations['uuid-orphan'];
  assert.equal(orphan.n, 'ILMENAU', 'name from meta.json');
  assert.equal(orphan.w, 'ILMENAU', 'water carried over from the previous manifest');
  assert.equal(orphan.from, 2011, 'from/to/gaps derive from the data files like any entry');
  assert.equal(orphan.to, CURRENT_YEAR, 'current.json counts as the running year');
  assert.equal(orphan.gaps, 1);
  assert.equal(orphan.source, 'Rijkswaterstaat', "a sibling adapter's origin survives too");
  assert.equal(orphan.none, undefined);
  assert.equal(m.stations['uuid-nodata'], undefined, 'no data files, no resurrection');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'manifest.json'))).stations['uuid-orphan'], orphan,
    'written to disk');
});

test('buildManifest survives an orphan with neither meta.json nor a previous manifest entry', () => {
  const out = tmp('pegel-orphan-bare-');
  mkdirSync(join(out, 'uuid-bare'));
  writeFileSync(join(out, 'uuid-bare', 'current.json'), JSON.stringify({ y: CURRENT_YEAR, min: [3], max: [4] }));
  const m = buildManifest([], out);
  assert.deepEqual(m.stations['uuid-bare'], { n: '', w: '', from: CURRENT_YEAR, to: CURRENT_YEAR },
    'listed with what is knowable — the data stays reachable');
});
