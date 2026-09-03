// scripts/fetch-wsv-archive.mjs — the three defects the 2026-08-21 data audit
// found in the archived bundles, each pinned at its root:
//   1. sensor sentinels (99999, -32753, 65250, 1300000, 2568900) bucketed as
//      water — 83 values across 23 stations
//   2. every requested range's Dec 31 flattened to min == max, because the ZIP
//      prepare endpoint reads `end` as midnight — ~2076 station-years
//   3. a station leaving the live WSV list losing its manifest entry while its
//      data directory stays on disk — ILMENAU, 14 closed years, invisible
//   4. (from the 2026-08-19 logic audit) a repeat January run reopening the
//      frozen year: freezeFromZip answers false once current.json moved on,
//      so the REST tail was folded back over the validated ZIP values
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
  condense, daysInYear, buildManifest, freezeFromZip, healRunningYearFromZip, fetchRawRange,
  requestEnd, lastYearOf, planChunks, dropSpillYears,
  writeStation, graduateCompletedYear, hasClosedYears,
  PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM,
  failureVerdict, reportRunOutcome,
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

test('fetchRawRange sends the start DAY it was given, not a Jan 1 derived from it', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    return { status: 500, headers: { get: () => null } }; // stop before the download
  };
  try {
    await assert.rejects(() => fetchRawRange('uuid-x', '2026-08-01', '2026-08-13'), /prepare failed/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen[0].start, '2026-08-01', 'the snapshot heal asks for a window inside the year');
  assert.equal(seen[0].end, '2026-08-13');
  assert.equal(seen[0].parameter, 'WASSERSTAND ROHDATEN');
});

test('fetchRawRange tells "WSV has no archive for this gauge" apart from a real failure', async () => {
  const realFetch = globalThis.fetch;
  const withLocation = loc => async () => ({ status: 303, headers: { get: () => loc } });
  const rejection = async () => {
    try { await fetchRawRange('uuid-x', '2026-01-01', '2027-01-01'); } catch (e) { return e; }
    throw new Error('expected a rejection');
  };
  try {
    // the steady state of ~111 lock and weir gauges: live on REST, never archived
    globalThis.fetch = withLocation('/errorpages/errorException');
    assert.equal((await rejection()).noArchive, true);
    globalThis.fetch = withLocation('/some/other/error');
    assert.equal((await rejection()).noArchive, false, 'only the error page means "nothing here"');
    globalThis.fetch = async () => ({ status: 502, headers: { get: () => null } });
    assert.equal((await rejection()).noArchive, false, 'an outage must stay a failure');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- 2b. the running year's heal (--running) ----------

// the shape --running found in production on 2026-09-03: a current.json whose
// only data is the REST window's last ~48 days
const runningYear = (fill = {}) => {
  const n = daysInYear(CURRENT_YEAR);
  const yr = { y: CURRENT_YEAR, min: Array(n).fill(null), max: Array(n).fill(null) };
  for (const [d, [lo, hi]] of Object.entries(fill)) { yr.min[d] = lo; yr.max[d] = hi; }
  return yr;
};

test('healRunningYearFromZip: the ZIP day wins over a differing existing day', () => {
  const dir = tmp('pegel-running-win-');
  const jul10 = doy(CURRENT_YEAR, 7, 10);
  writeFileSync(join(dir, 'current.json'), JSON.stringify(runningYear({ [jul10]: [480, 490] })));
  const zy = runningYear({ [jul10]: [470, 515] });

  assert.equal(healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, zy), true);
  const out = JSON.parse(readFileSync(join(dir, 'current.json')));
  assert.equal(out.min[jul10], 470, 'an extreme union would keep the old 480 as the minimum');
  assert.equal(out.max[jul10], 515);
});

test('healRunningYearFromZip: a day only the existing file has survives (R4 would block the push)', () => {
  const dir = tmp('pegel-running-keep-');
  const jan5 = doy(CURRENT_YEAR, 1, 5), aug20 = doy(CURRENT_YEAR, 8, 20);
  writeFileSync(join(dir, 'current.json'), JSON.stringify(runningYear({ [aug20]: [300, 320] })));
  const zy = runningYear({ [jan5]: [610, 640] }); // ZIP has the winter, not the tail

  healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, zy);
  const out = JSON.parse(readFileSync(join(dir, 'current.json')));
  assert.equal(out.min[jan5], 610, 'the half-year the ZIP brings is what the heal is for');
  assert.equal(out.min[aug20], 300, 'non-null -> null is exactly what compareCurrent rejects');
  assert.equal(out.max[aug20], 320);
});

test('healRunningYearFromZip: writes a current.json that does not exist yet', () => {
  const dir = tmp('pegel-running-new-');
  const jan5 = doy(CURRENT_YEAR, 1, 5);
  assert.equal(healRunningYearFromZip(dir, 'NEUSTADT', CURRENT_YEAR, runningYear({ [jan5]: [1, 2] })), true);
  const out = JSON.parse(readFileSync(join(dir, 'current.json')));
  assert.equal(out.y, CURRENT_YEAR);
  assert.equal(out.min[jan5], 1);
  assert.equal(JSON.parse(readFileSync(join(dir, 'meta.json'))).name, 'NEUSTADT');
});

test('healRunningYearFromZip leaves meta.json byte-identical', () => {
  const dir = tmp('pegel-running-meta-');
  // fetchedThrough is a claim about COMPLETED years — bumping it to the running
  // year would tell the January gap sweep this station is done
  const meta = '{"name":"BONN","fetchedFrom":2000,"fetchedThrough":2025}';
  writeFileSync(join(dir, 'meta.json'), meta);
  writeFileSync(join(dir, 'current.json'), JSON.stringify(runningYear()));

  healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, runningYear({ [doy(CURRENT_YEAR, 1, 5)]: [1, 2] }));
  assert.equal(readFileSync(join(dir, 'meta.json'), 'utf8'), meta);
});

test('healRunningYearFromZip refuses to overwrite a completed year still awaiting the freeze', () => {
  const dir = tmp('pegel-running-freeze-');
  const prev = { y: CURRENT_YEAR - 1, min: [7], max: [9] };
  writeFileSync(join(dir, 'current.json'), JSON.stringify(prev));

  assert.equal(healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, runningYear({ 0: [1, 2] })), false,
    'that year lives nowhere else yet — writeStation graduates it, not the heal');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'current.json'))), prev);

  // once closed.json holds it, the slot is free for the new running year
  writeFileSync(join(dir, 'closed.json'), JSON.stringify([prev]));
  assert.equal(healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, runningYear({ 0: [1, 2] })), true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'current.json'))).y, CURRENT_YEAR);
});

test('healRunningYearFromZip: the ZIP day WSV is still ingesting unions instead of truncating', () => {
  const dir = tmp('pegel-running-tail-');
  const today = doy(CURRENT_YEAR, 8, 21), before = doy(CURRENT_YEAR, 8, 20);
  writeFileSync(join(dir, 'current.json'),
    JSON.stringify(runningYear({ [before]: [300, 400], [today]: [280, 460] })));
  // the ZIP's last day stops at the last ingested reading, so its span is a
  // prefix of the REST accumulation's
  const zy = runningYear({ [before]: [305, 390], [today]: [300, 310] });

  healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, zy);
  const out = JSON.parse(readFileSync(join(dir, 'current.json')));
  assert.deepEqual([out.min[before], out.max[before]], [305, 390], 'a settled day is still ZIP-wins');
  assert.deepEqual([out.min[today], out.max[today]], [280, 460], 'the unfinished day keeps the wider span');
});

test('healRunningYearFromZip refuses a current.json it cannot line up day-for-day', () => {
  const dir = tmp('pegel-running-shape-');
  const n = daysInYear(CURRENT_YEAR);
  for (const broken of [{ y: CURRENT_YEAR }, { y: CURRENT_YEAR, min: Array(n + 1).fill(null), max: Array(n + 1).fill(null) }]) {
    const before = JSON.stringify(broken);
    writeFileSync(join(dir, 'current.json'), before);
    assert.equal(healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, runningYear({ 5: [1, 2] })), false);
    assert.equal(readFileSync(join(dir, 'current.json'), 'utf8'), before,
      'writing the ZIP year over it would null every day it holds');
  }
});

test('healRunningYearFromZip leaves an UNPARSEABLE meta.json alone', () => {
  const dir = tmp('pegel-running-badmeta-');
  // truncated mid-write; readJson cannot tell it from a missing file, and
  // {name} alone would drop fetchedThrough (a full 2000-> re-backfill next
  // sweep) and source (the Rijkswaterstaat marker)
  const broken = '{"name":"BONN","fetchedThrough":2025,"source":"Rijkswater';
  writeFileSync(join(dir, 'meta.json'), broken);
  writeFileSync(join(dir, 'current.json'), JSON.stringify(runningYear()));
  assert.equal(healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, runningYear({ 5: [1, 2] })), true);
  assert.equal(readFileSync(join(dir, 'meta.json'), 'utf8'), broken);
});

test('hasClosedYears: only a bundle with years counts as "WSV archived this gauge"', () => {
  const dir = tmp('pegel-closed-');
  assert.equal(hasClosedYears(dir), false, 'no file at all');
  writeFileSync(join(dir, 'closed.json'), '[]');
  assert.equal(hasClosedYears(dir), false, 'an empty bundle is not a history');
  writeFileSync(join(dir, 'closed.json'), JSON.stringify([{ y: 2024, min: [1], max: [2] }]));
  assert.equal(hasClosedYears(dir), true);
});

test('healRunningYearFromZip: an empty ZIP year changes nothing', () => {
  const dir = tmp('pegel-running-empty-');
  const before = JSON.stringify(runningYear({ 5: [10, 20] }));
  writeFileSync(join(dir, 'current.json'), before);
  assert.equal(healRunningYearFromZip(dir, 'BONN', CURRENT_YEAR, runningYear()), false);
  assert.equal(readFileSync(join(dir, 'current.json'), 'utf8'), before);
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

// ---------- 4. repeat January runs must not reopen the frozen year ----------

// freezeFromZip returns false both when nothing was ever accumulated AND when
// the year already graduated, so a second January run (workflow re-run, manual
// dispatch, the local runbook) used to skip years.delete(y) and let
// writeStation's extreme union fold the raw REST December back over the
// corrected ZIP values the first run had frozen into the immutable bundle.
test('graduateCompletedYear: a repeat run drops the REST tail of an already-frozen year', async () => {
  const dir = tmp('pegel-refreeze-');
  const blank = () => Array(365).fill(null);
  // state after a successful January run: 2025 frozen from the ZIP, day 340
  // carrying the validated 81/95 rather than the raw REST spike
  const frozen = { y: 2025, min: blank(), max: blank() };
  frozen.min[340] = 81; frozen.max[340] = 95;
  writeFileSync(join(dir, 'closed.json'), JSON.stringify([frozen]));
  const cur = { y: CURRENT_YEAR, min: blank(), max: blank() };
  cur.min[0] = 261; cur.max[0] = 265;
  writeFileSync(join(dir, 'current.json'), JSON.stringify(cur));

  // the repeat run re-pulls 2025 over REST and still holds the raw outlier
  const rest2025 = { y: 2025, min: blank(), max: blank() };
  rest2025.min[340] = 80; rest2025.max[340] = 300;
  const years = new Map([[2025, rest2025], [CURRENT_YEAR, cur]]);

  const calls = [];
  const through = await graduateCompletedYear(dir, 'uuid-x', 2025, years, 'test',
    async (...a) => { calls.push(a); return { years: new Map() }; });
  assert.equal(through, 2025, 'the already-frozen year is still claimed as fetchedThrough');
  assert.deepEqual(calls, [], 'the ZIP path is not re-fetched — current.json has moved on');
  assert.ok(!years.has(2025), 'the REST tail of the frozen year left the map');

  writeStation(dir, 'BONN', years, null, through);
  const closed = JSON.parse(readFileSync(join(dir, 'closed.json')));
  const y25 = closed.find(b => b.y === 2025);
  assert.equal(y25.min[340], 81, 'the frozen minimum survives the repeat run');
  assert.equal(y25.max[340], 95, 'the raw REST spike stays out of the immutable bundle');
});

test('graduateCompletedYear: a failed ZIP freeze of a never-frozen year claims nothing', async () => {
  const dir = tmp('pegel-nofreeze-');
  const cur = { y: 2025, min: [100], max: [110] };
  writeFileSync(join(dir, 'current.json'), JSON.stringify(cur));
  const years = new Map([[2025, cur]]);
  const through = await graduateCompletedYear(dir, 'uuid-x', 2025, years, 'test',
    async () => { throw new Error('zip down'); });
  assert.equal(through, 0, 'no fetchedThrough claim — the gap sweep must retry');
  assert.ok(years.has(2025), 'the REST accumulation still graduates as before');
});

// ---------- 5. a run that fetched nothing must not read as a success ----------

test('failureVerdict: a WSV outage is red, a handful of bad stations is not', () => {
  // the shape that used to go green: every attempted station failed, the
  // manifest and totals were rebuilt off untouched files, the gate passed
  assert.equal(failureVerdict(0, 737).red, true, 'a total outage is red');
  assert.equal(failureVerdict(90, 10).red, true, 'exactly at the 10% limit is red');
  assert.equal(failureVerdict(91, 9).red, false, 'just under the limit stays green');
  assert.equal(failureVerdict(700, 37).red, false, '37 of 737 is 5%, still green');
  assert.equal(failureVerdict(700, 3).red, false, 'three flaky stations stay green');
  assert.equal(failureVerdict(737, 0).red, false, 'a clean run is green');

  // `skipped` is not in the denominator, so an almost-complete archive cannot
  // dilute a bad run: 2 of 4 actually attempted is still half
  const v = failureVerdict(2, 2);
  assert.equal(v.attempted, 4);
  assert.equal(v.rate, 0.5);
  assert.equal(v.red, true);

  // a run with nothing to do is not a failure
  assert.equal(failureVerdict(0, 0).red, false);
  assert.equal(failureVerdict(0, 0).rate, 0);

  // --station runs are small on purpose: one requested station, one failure
  assert.equal(failureVerdict(0, 1).red, true, 'the only station you asked for failed');

  // the limit is a knob, not a constant
  assert.equal(failureVerdict(90, 10, 0.5).red, false);
  assert.equal(failureVerdict(40, 60, 0.5).red, true);
});

test('reportRunOutcome sets a non-zero exit code exactly when the verdict is red', () => {
  const before = process.exitCode;
  try {
    process.exitCode = 0;
    reportRunOutcome('test', 700, 3);
    assert.equal(process.exitCode, 0, 'a tolerable failure rate leaves the run green');

    reportRunOutcome('test', 0, 737);
    assert.equal(process.exitCode, 1, 'a wiped-out run exits non-zero');
  } finally {
    process.exitCode = before;
  }
});
