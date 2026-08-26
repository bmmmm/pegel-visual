// tests/archive-consistency.test.mjs — every rule of the consistency gate must
// be able to turn red (a gate that cannot fail proves nothing): the 2026-08-23
// reset base, the silent totals skip, a station dropout, a deleted file, a
// shrunken closed.json, and the month-boundary edge on day 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// pin the clock before the module (and its fetch-wsv-archive import) reads it
const NOW = '2026-08-21T16:00:00Z'; // 17:00 MEZ -> 2026-08-21, dayIdx 20
process.env.PEGEL_NOW = NOW;
const nowDate = new Date(NOW);
const {
  capturedDays, checkRecency, checkTotalsLiveness, checkCoverage,
  checkChangeStatuses, compareShard, compareCurrent, compareClosed,
  checkShardShape, checkCurrentShape, checkClosedShape,
  checkManifestShape, checkOverviewShape,
} = await import('../scripts/check-archive-consistency.mjs');

// shard fixture: counts[i] = stations reporting on day i, null = day not captured
function mkShard(y, m, counts) {
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const total = Math.max(0, ...counts.filter(c => c != null));
  const days = Array(n).fill(null);
  const stations = {};
  for (let s = 0; s < total; s++) stations['u' + s] = { n: 'S' + s, w: 'RHEIN', v: Array(n).fill(null) };
  counts.forEach((c, i) => {
    if (c == null) return;
    days[i] = `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}T15:17:00Z`;
    for (let s = 0; s < c; s++) stations['u' + s].v[i] = 100 + s;
  });
  return { y, m, days, stations };
}

// ---------- R1 recency ----------

test('R1: an up-to-date shard is green, lag 2 is the edge, lag 3 is red', () => {
  const upToDate = capturedDays([mkShard(2026, 8, Array(21).fill(5))]); // through dayIdx 20
  assert.deepEqual(checkRecency(upToDate, nowDate), []);
  const lag2 = capturedDays([mkShard(2026, 8, Array(19).fill(5))]); // through dayIdx 18
  assert.deepEqual(checkRecency(lag2, nowDate), []);
  const lag3 = capturedDays([mkShard(2026, 8, Array(18).fill(5))]);
  assert.equal(checkRecency(lag3, nowDate).length, 1);
});

test('R1: the reset base — an internally valid shard 19 days behind — is red', () => {
  const days = capturedDays([mkShard(2026, 8, [730, 731])]); // last capture Aug 2
  const v = checkRecency(days, nowDate);
  assert.equal(v.length, 1);
  assert.match(v[0], /2026-08-02, 19 days behind/);
});

test('R1: day 1 of a month falls back to the previous month shard', () => {
  const sep1 = new Date('2026-09-01T12:00:00Z'); // MEZ dayIdx 0 of September
  const withPrev = capturedDays([mkShard(2026, 8, Array(31).fill(5)), null]);
  assert.deepEqual(checkRecency(withPrev, sep1), [], 'Aug 31 is 1 day behind Sep 1');
  assert.equal(checkRecency(capturedDays([null, null]), sep1).length, 1, 'no shard at all is a violation');
  assert.equal(checkRecency(capturedDays([mkShard(2026, 8, [])]), sep1).length, 1, 'an all-null shard too');
});

test('R1: the year boundary works the same way', () => {
  const jan1 = new Date('2027-01-01T12:00:00Z');
  const days = capturedDays([mkShard(2026, 12, Array(31).fill(5))]);
  assert.deepEqual(checkRecency(days, jan1), []);
});

// ---------- R2 totals liveness ----------

const totalsFix = () => ({
  overview: { generated: '2026-08-21T15:20:00Z', rivers: {} },
  units: { generated: '2026-08-03T04:00:00Z', units: { a: 'cm' }, excluded: [] },
  yearTotals: { y: 2026, rivers: {} },
  currentYear: 2026,
  nowDate,
});

test('R2: fresh totals are green', () => {
  assert.deepEqual(checkTotalsLiveness(totalsFix()), []);
});

test('R2: missing units.json (the silent-skip path) is red', () => {
  const v = checkTotalsLiveness({ ...totalsFix(), units: null });
  assert.equal(v.length, 1);
  assert.match(v[0], /units\.json/);
});

test('R2: missing overview.json (the silent-rebuild fallback base) is red', () => {
  const v = checkTotalsLiveness({ ...totalsFix(), overview: null });
  assert.match(v[0], /overview\.json missing/);
});

test('R2: an overview generated 7h ago proves the build skipped this pass', () => {
  const v = checkTotalsLiveness({ ...totalsFix(), overview: { generated: '2026-08-21T09:00:00Z' } });
  assert.equal(v.length, 1);
  assert.match(v[0], /7\.0h old/);
});

test('R2: a year-totals file for the wrong year is red', () => {
  const v = checkTotalsLiveness({ ...totalsFix(), yearTotals: { y: 2025 } });
  assert.match(v[0], /totals\/2026\.json/);
});

// ---------- R3 coverage ----------

test('R3: a station dropout below 0.9x the median of the prior days is red', () => {
  const days = capturedDays([mkShard(2026, 8, [738, 738, 737, 738, 736, 738, 738, 500])]);
  const v = checkCoverage(days);
  assert.equal(v.length, 1);
  assert.match(v[0], /only 500 stations/);
  assert.match(v[0], /threshold 665/); // ceil(0.9 * 738)
});

test('R3: normal jitter stays green', () => {
  const days = capturedDays([mkShard(2026, 8, [738, 738, 737, 738, 736, 738, 738, 700])]);
  assert.deepEqual(checkCoverage(days), []);
});

test('R3: with no prior days only the 400 floor applies', () => {
  assert.deepEqual(checkCoverage(capturedDays([mkShard(2026, 8, [450])])), []);
  assert.equal(checkCoverage(capturedDays([mkShard(2026, 8, [350])])).length, 1);
});

// ---------- R4 regression vs. HEAD ----------

test('R4: deletions and renames are violations, additions and edits are not', () => {
  assert.equal(checkChangeStatuses([{ status: 'D', path: 'archive/totals/units.json' }]).length, 1);
  assert.equal(checkChangeStatuses([{ status: 'R', path: 'archive/x.json' }]).length, 1);
  assert.deepEqual(checkChangeStatuses([
    { status: 'A', path: 'archive/snapshots/2026-09.json' },
    { status: 'M', path: 'archive/snapshots/2026-08.json' },
  ]), []);
});

test('R4: a shard losing a captured day or a station is red', () => {
  const head = mkShard(2026, 8, [5, 5, 5]);
  const lostDay = mkShard(2026, 8, [5, null, 5]);
  assert.match(compareShard(head, lostDay, 'p')[0], /day 2 lost/);
  const lostStation = mkShard(2026, 8, [5, 5, 5]);
  delete lostStation.stations.u4;
  assert.match(compareShard(head, lostStation, 'p')[0], /u4 vanished/);
  assert.deepEqual(compareShard(head, mkShard(2026, 8, [5, 5, 5, 6]), 'p'), [], 'growth is fine');
  assert.deepEqual(compareShard(null, lostDay, 'p'), [], 'a brand-new shard has no baseline');
});

test('R4: a station value may only null out where the day was re-captured', () => {
  const head = mkShard(2026, 8, [5, 5]);
  const silentNull = structuredClone(head);
  silentNull.stations.u3.v[1] = null; // same capture timestamp -> data loss
  assert.match(compareShard(head, silentNull, 'p')[0], /u3 day 2 went non-null -> null/);
  const recaptured = structuredClone(silentNull);
  recaptured.days[1] = '2026-08-02T18:00:00Z'; // re-run overwrote the slot
  assert.deepEqual(compareShard(head, recaptured, 'p'), [], 'the same-day re-run may drop a stale station');
});

test('R4: current.json slots never regress, years never move backwards', () => {
  const head = { y: 2026, min: [10, 20, null], max: [11, 21, null] };
  assert.deepEqual(compareCurrent(head, { y: 2026, min: [10, 20, 30], max: [11, 21, 31] }, 'p'), []);
  const v = compareCurrent(head, { y: 2026, min: [10, null, null], max: [11, 21, null] }, 'p');
  assert.equal(v.length, 1);
  assert.match(v[0], /min\[1\] went non-null -> null/);
  assert.match(compareCurrent(head, { y: 2025, min: [], max: [] }, 'p')[0], /backwards/);
});

test('R4: the January rollover needs the old year frozen into closed.json', () => {
  const head = { y: 2026, min: [10], max: [11] };
  const rolled = { y: 2027, min: [1], max: [2] };
  assert.deepEqual(compareCurrent(head, rolled, 'p', new Set([2025, 2026])), []);
  assert.match(compareCurrent(head, rolled, 'p', new Set([2025]))[0], /freeze lost a year/);
});

test('R4: a shrunken closed.json is red — the freeze is irreversible', () => {
  const head = [{ y: 2024 }, { y: 2025 }];
  assert.match(compareClosed(head, [{ y: 2024 }], 'p')[0], /closed year 2025 disappeared/);
  assert.deepEqual(compareClosed(head, [{ y: 2024 }, { y: 2025 }, { y: 2026 }], 'p'), []);
});

// ---------- R5 shapes ----------

test('R5: shard shape — month length, aligned stations, filename identity', () => {
  const ok = mkShard(2026, 8, [5]);
  assert.deepEqual(checkShardShape(ok, 'archive/snapshots/2026-08.json'), []);
  const short = mkShard(2026, 8, [5]);
  short.days = short.days.slice(0, 28);
  assert.match(checkShardShape(short, 'archive/snapshots/2026-08.json')[0], /days\.length 28 != 31/);
  const misaligned = mkShard(2026, 8, [5]);
  misaligned.stations.u2.v = [1, 2, 3];
  assert.match(checkShardShape(misaligned, 'archive/snapshots/2026-08.json')[0], /u2 v\.length misaligned/);
  assert.match(checkShardShape(ok, 'archive/snapshots/2026-09.json')[0], /names itself 2026-8/);
  assert.match(checkShardShape({ y: 2026 }, 'p')[0], /not a snapshot shard/);
});

test('R5: current.json arrays must span exactly their year', () => {
  const n = 365;
  assert.deepEqual(checkCurrentShape({ y: 2026, min: Array(n).fill(null), max: Array(n).fill(null) }, 'p'), []);
  assert.equal(checkCurrentShape({ y: 2024, min: Array(n).fill(null), max: Array(n).fill(null) }, 'p').length, 2,
    '2024 is a leap year — 365 is wrong for both arrays');
  assert.match(checkCurrentShape(null, 'p')[0], /not a year bundle/);
});

test('R5: closed.json bundles must span their years too', () => {
  assert.deepEqual(checkClosedShape([{ y: 2025, min: Array(365).fill(null), max: Array(365).fill(null) }], 'p'), []);
  assert.match(checkClosedShape([{ y: 2024, min: Array(365).fill(null), max: Array(365).fill(null) }], 'p')[0],
    /malformed bundle for year 2024/);
  assert.match(checkClosedShape({}, 'p')[0], /not an array/);
});

test('R5: manifest and overview floors', () => {
  const stations = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['u' + i, { n: 'X', w: 'Y' }]));
  assert.deepEqual(checkManifestShape({ stations: stations(700) }), []);
  assert.match(checkManifestShape({ stations: stations(600) })[0], /600 stations/);
  assert.match(checkManifestShape(null)[0], /manifest\.json missing/);
  const rivers = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['R' + i, []]));
  assert.deepEqual(checkOverviewShape({ rivers: rivers(80) }), []);
  assert.match(checkOverviewShape({ rivers: rivers(79) })[0], /79 rivers/);
  assert.deepEqual(checkOverviewShape(null), [], 'a missing overview is R2 business, not double-reported');
});

// ---------- CLI integration: a real git baseline, green then sabotaged ----------

const SCRIPT = new URL('../scripts/check-archive-consistency.mjs', import.meta.url).pathname;

function gitIn(dir, ...gitArgs) {
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...gitArgs],
    { encoding: 'utf8' });
}

function runChecker(repo, env = {}) {
  try {
    const stdout = execFileSync(process.execPath,
      [SCRIPT, '--tree', join(repo, 'archive'), '--git', repo],
      { encoding: 'utf8', env: { ...process.env, PEGEL_NOW: NOW, ...env } });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout) };
  }
}

function seedRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'pegel-consistency-'));
  const arch = join(repo, 'archive');
  mkdirSync(join(arch, 'snapshots'), { recursive: true });
  mkdirSync(join(arch, 'totals'), { recursive: true });
  writeFileSync(join(arch, 'snapshots', '2026-08.json'),
    JSON.stringify(mkShard(2026, 8, Array(21).fill(450)))); // through today, 450 stations
  writeFileSync(join(arch, 'manifest.json'), JSON.stringify({
    generated: NOW,
    stations: Object.fromEntries(Array.from({ length: 700 }, (_, i) => ['u' + i, { n: 'X', w: 'Y' }])),
  }));
  writeFileSync(join(arch, 'totals', 'overview.json'), JSON.stringify({
    generated: '2026-08-21T15:20:00Z', fromYear: 2000, months: 324, currentYear: 2026,
    excludedStations: 0,
    rivers: Object.fromEntries(Array.from({ length: 85 }, (_, i) => ['R' + i, []])),
  }));
  writeFileSync(join(arch, 'totals', 'units.json'),
    JSON.stringify({ generated: NOW, units: { u0: 'cm' }, excluded: [] }));
  writeFileSync(join(arch, 'totals', '2026.json'), JSON.stringify({ y: 2026, generated: NOW, rivers: {} }));
  gitIn(repo, 'init', '-q');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

test('CLI: an untouched healthy checkout is green', () => {
  const repo = seedRepo();
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /consistency ok: 0 changed files, latest snapshot 2026-08-21 with 450 stations/);
});

test('CLI: the incident replayed — reset shard + missing units.json — is red', () => {
  const repo = seedRepo();
  rmSync(join(repo, 'archive', 'totals', 'units.json')); // the silent-skip precondition
  writeFileSync(join(repo, 'archive', 'snapshots', '2026-08.json'),
    JSON.stringify(mkShard(2026, 8, [450, 450]))); // reset base: valid but Aug 2
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::R4: archive\/totals\/units\.json: git status D/);
  assert.match(stdout, /::error::R2: totals\/units\.json missing/);
  assert.match(stdout, /::error::R1: latest snapshot day is 2026-08-02, 19 days behind/);
  assert.match(stdout, /::error::R4: archive\/snapshots\/2026-08\.json: captured day 3 lost/);
});

test('CLI: a brand-new month shard (untracked) is still shape-checked', () => {
  const repo = seedRepo();
  const broken = mkShard(2026, 9, [450]);
  broken.days = broken.days.slice(0, 12); // wrong month length
  writeFileSync(join(repo, 'archive', 'snapshots', '2026-09.json'), JSON.stringify(broken));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::R5: archive\/snapshots\/2026-09\.json: days\.length 12 != 30/);
});
