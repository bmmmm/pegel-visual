import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isExcludedUnit, midOf, dayOfYear, parseLiveUnits, mergeUnitsDoc,
  stationYearMids, loadSnapshotShards, buildOverview, accumulateTotals,
  finalizeYear, rebuildAll, appendCurrent,
} from '../scripts/build-river-totals.mjs';
import { daysInYear } from '../scripts/fetch-wsv-archive.mjs';

test('isExcludedUnit: only literal cm passes, unknown fails closed', () => {
  assert.equal(isExcludedUnit('cm'), false);
  assert.equal(isExcludedUnit('m+NN'), true);
  assert.equal(isExcludedUnit('m+PNP'), true);
  assert.equal(isExcludedUnit(null), true);
  assert.equal(isExcludedUnit(undefined), true);
});

test('midOf: averages, null when either side is missing', () => {
  assert.equal(midOf(100, 101), 100.5);
  assert.equal(midOf(100, null), null);
  assert.equal(midOf(null, 101), null);
  assert.equal(midOf(0, 0), 0); // zero is a value, not a gap
});

test('dayOfYear: leap Feb 29 indexes cleanly', () => {
  assert.equal(dayOfYear(2024, 1, 1), 0);
  assert.equal(dayOfYear(2024, 2, 29), 59);
  assert.equal(dayOfYear(2024, 3, 1), 60);
  assert.equal(dayOfYear(2025, 3, 1), 59); // non-leap
  assert.equal(dayOfYear(2024, 12, 31), 365);
});

test('parseLiveUnits: unit rides on the W timeseries only', () => {
  const raw = [
    { uuid: 'a', timeseries: [{ shortname: 'Q', unit: 'm³/s' }, { shortname: 'W', unit: 'cm' }] },
    { uuid: 'b', timeseries: [{ shortname: 'W', unit: 'm+NN' }] },
    { uuid: 'c', timeseries: [{ shortname: 'Q' }] }, // no W: dropped
    { uuid: 'd', timeseries: [{ shortname: 'W' }] }, // W without unit
  ];
  assert.deepEqual(parseLiveUnits(raw), [
    { uuid: 'a', unit: 'cm' },
    { uuid: 'b', unit: 'm+NN' },
    { uuid: 'd', unit: null },
  ]);
});

test('mergeUnitsDoc: fresh overwrites, vanished stations keep their last unit', () => {
  const prev = { generated: 'old', units: { a: 'cm', gone: 'm+NN' }, excluded: ['gone'] };
  const doc = mergeUnitsDoc(prev, [{ uuid: 'a', unit: 'm+NN' }, { uuid: 'b', unit: 'cm' }, { uuid: 'd', unit: null }], 'now');
  assert.equal(doc.generated, 'now');
  assert.deepEqual(doc.units, { a: 'm+NN', gone: 'm+NN', b: 'cm' }); // d's null never lands
  assert.deepEqual(doc.excluded, ['a', 'gone']);
  // first run: no previous doc
  const first = mergeUnitsDoc(null, [{ uuid: 'x', unit: 'cm' }], 'now');
  assert.deepEqual(first.units, { x: 'cm' });
  assert.deepEqual(first.excluded, []);
});

test('stationYearMids: archived mid wins, snapshots only fill its gaps', () => {
  const n = daysInYear(2026);
  const bundle = { y: 2026, min: Array(n).fill(null), max: Array(n).fill(null) };
  bundle.min[0] = 100; bundle.max[0] = 110; // Jan 1 archived
  const shard = { y: 2026, m: 1, stations: { u: { v: Array(31).fill(null) } } };
  shard.stations.u.v[0] = 999; // snapshot also has Jan 1 — must lose
  shard.stations.u.v[1] = 120; // Jan 2 only in the snapshot — provisional
  const { mid, provisionalFrom } = stationYearMids(bundle, 2026, new Map([[1, shard]]), 'u');
  assert.equal(mid[0], 105);
  assert.equal(mid[1], 120);
  assert.equal(mid[2], null, 'a gap in both sources stays a gap');
  assert.equal(provisionalFrom, 1);
  // no snapshots at all (closed years): nothing provisional
  const closedOnly = stationYearMids(bundle, 2026, null, 'u');
  assert.equal(closedOnly.mid[1], null);
  assert.equal(closedOnly.provisionalFrom, null);
  // bundle for the wrong year is ignored entirely
  const wrongYear = stationYearMids({ ...bundle, y: 2025 }, 2026, null, 'u');
  assert.ok(wrongYear.mid.every(v => v == null));
});

// fixture archive: RHEIN with two cm gauges (one archived, one snapshot-only
// none:true), EDER with an m+NN reservoir that must never leak into the sums
function fixtureArchive() {
  const dir = mkdtempSync(join(tmpdir(), 'pegel-totals-'));
  const arch = join(dir, 'archive');
  mkdirSync(join(arch, 'snapshots'), { recursive: true });
  const manifest = { generated: 'x', stations: {
    a: { n: 'BONN', w: 'RHEIN', from: 2024, to: 2026 },
    b: { n: 'KÖLN', w: 'RHEIN', from: 2024, to: 2024 },
    c: { n: 'EDERTALSPERRE', w: 'EDER', from: 2024, to: 2026 },
    d: { n: 'SPERRWERK', w: 'RHEIN', none: true },
  } };
  writeFileSync(join(arch, 'manifest.json'), JSON.stringify(manifest));
  const year = (y, fill) => {
    const n = daysInYear(y);
    return { y, min: Array(n).fill(fill), max: Array(n).fill(fill + 1) };
  };
  mkdirSync(join(arch, 'a')); // 2024 closed + running 2026
  writeFileSync(join(arch, 'a', 'closed.json'), JSON.stringify([year(2024, 200)]));
  const aCur = year(2026, 210);
  for (let d = 220; d < aCur.min.length; d++) { aCur.min[d] = null; aCur.max[d] = null; }
  writeFileSync(join(arch, 'a', 'current.json'), JSON.stringify(aCur));
  mkdirSync(join(arch, 'b'));
  writeFileSync(join(arch, 'b', 'closed.json'), JSON.stringify([year(2024, 100)]));
  mkdirSync(join(arch, 'c')); // metres of elevation, stored bare — the trap
  writeFileSync(join(arch, 'c', 'closed.json'), JSON.stringify([year(2024, 239)]));
  writeFileSync(join(arch, 'c', 'current.json'), JSON.stringify(year(2026, 239)));
  const shard = { y: 2026, m: 8, days: Array(31).fill(null), stations: { d: { n: 'SPERRWERK', w: 'RHEIN', v: Array(31).fill(null) } } };
  shard.stations.d.v[19] = 500; // Aug 20
  writeFileSync(join(arch, 'snapshots', '2026-08.json'), JSON.stringify(shard));
  const unitsDoc = { generated: 'x', units: { a: 'cm', b: 'cm', c: 'm+NN', d: 'cm' }, excluded: ['c'] };
  return { arch, out: join(dir, 'totals'), unitsDoc };
}

const NOW = new Date('2026-08-20T12:00:00Z');

test('rebuildAll: sums cm gauges per river, excludes the elevation gauge, snapshots reach none-stations', () => {
  const { arch, out, unitsDoc } = fixtureArchive();
  const res = rebuildAll({ archiveDir: arch, outDir: out, unitsDoc, nowDate: NOW });
  assert.equal(res.excluded, 1);
  assert.equal(res.included, 3);
  assert.deepEqual(res.years, [2024, 2026]);

  const y2024 = JSON.parse(readFileSync(join(out, '2024.json'), 'utf8'));
  assert.deepEqual(Object.keys(y2024.rivers), ['RHEIN'], 'the m+NN EDER gauge left no river behind');
  assert.equal(y2024.rivers.RHEIN.v[0], Math.round(200.5 + 100.5), 'sum-then-round of both mids');
  assert.equal(y2024.rivers.RHEIN.n[0], 2);
  assert.equal(y2024.rivers.RHEIN.v.length, 366, 'leap year length');
  assert.equal(y2024.provisionalFrom, undefined);

  const y2026 = JSON.parse(readFileSync(join(out, '2026.json'), 'utf8'));
  const aug20 = dayOfYear(2026, 8, 20);
  assert.equal(y2026.rivers.RHEIN.v[aug20], 500, 'snapshot-only none-station carries the day alone');
  assert.equal(y2026.rivers.RHEIN.n[aug20], 1);
  assert.equal(y2026.rivers.RHEIN.v[0], 211, 'a single gauge: mid 210.5 rounds half-up');
  assert.equal(y2026.provisionalFrom, aug20);

  const ov = JSON.parse(readFileSync(join(out, 'overview.json'), 'utf8'));
  assert.equal(ov.fromYear, 2024);
  assert.equal(ov.months, 36);
  assert.equal(ov.currentYear, 2026);
  assert.equal(ov.excludedStations, 1);
  assert.equal(ov.rivers.RHEIN[0], 301, 'January 2024: every day the same sum, so the mean equals it');
  assert.equal(ov.rivers.RHEIN[12], null, 'no 2025 data anywhere');
  // Aug 2026: doy 212..219 report the archived 210.5 (current.json ends at 220),
  // doy 231 reports the snapshot 500 — the mean runs over those 9 days only
  assert.equal(ov.rivers.RHEIN[24 + 7], Math.round((210.5 * 8 + 500) / 9), 'Aug 2026 mean over reporting days only');
});

test('rebuildAll: byte-identical on identical input', () => {
  const { arch, out, unitsDoc } = fixtureArchive();
  rebuildAll({ archiveDir: arch, outDir: out, unitsDoc, nowDate: NOW });
  const first = ['overview.json', '2024.json', '2026.json', 'units.json']
    .map(f => readFileSync(join(out, f), 'utf8'));
  rebuildAll({ archiveDir: arch, outDir: out, unitsDoc, nowDate: NOW });
  const second = ['overview.json', '2024.json', '2026.json', 'units.json']
    .map(f => readFileSync(join(out, f), 'utf8'));
  assert.deepEqual(first, second);
});

test('appendCurrent: rewrites only the running year and clears stale cells', () => {
  const { arch, out, unitsDoc } = fixtureArchive();
  rebuildAll({ archiveDir: arch, outDir: out, unitsDoc, nowDate: NOW });
  const before2024 = readFileSync(join(out, '2024.json'), 'utf8');

  // the running year loses its archived gauge (simulates a shrunken current.json)
  writeFileSync(join(arch, 'a', 'current.json'), JSON.stringify({ y: 2026, min: [null], max: [null] }));
  const res = appendCurrent({ archiveDir: arch, outDir: out, unitsDoc, nowDate: NOW });
  assert.deepEqual(res.years, [2026]);
  assert.equal(readFileSync(join(out, '2024.json'), 'utf8'), before2024, 'closed years untouched');

  const y2026 = JSON.parse(readFileSync(join(out, '2026.json'), 'utf8'));
  const aug20 = dayOfYear(2026, 8, 20);
  assert.equal(y2026.rivers.RHEIN.v[0], null, 'the archived January days are gone');
  assert.equal(y2026.rivers.RHEIN.v[aug20], 500, 'the snapshot day survives');

  const ov = JSON.parse(readFileSync(join(out, 'overview.json'), 'utf8'));
  assert.equal(ov.rivers.RHEIN[24], null, 'stale Jan 2026 cell cleared, not kept');
  assert.equal(ov.rivers.RHEIN[24 + 7], 500);
  assert.equal(ov.rivers.RHEIN[0], 301, '2024 cells untouched');
});

test('appendCurrent: falls back to a full rebuild when no overview exists yet', () => {
  const { arch, out, unitsDoc } = fixtureArchive();
  const res = appendCurrent({ archiveDir: arch, outDir: out, unitsDoc, nowDate: NOW });
  assert.deepEqual(res.years, [2024, 2026], 'the fallback covered every year');
  assert.ok(JSON.parse(readFileSync(join(out, 'overview.json'), 'utf8')).rivers.RHEIN);
});

test('buildOverview: a river absent in one year still spans all months', () => {
  const n24 = daysInYear(2024), n25 = daysInYear(2025);
  const acc = (len, fill) => ({ sumF: Array(len).fill(fill), n: Array(len).fill(fill ? 1 : 0) });
  const byYear = new Map([
    [2024, new Map([['RHEIN', acc(n24, 100)], ['ELBE', acc(n24, 50)]])],
    [2025, new Map([['RHEIN', acc(n25, 110)]])],
  ]);
  const ov = buildOverview(byYear, 2025, 0, 'now');
  assert.equal(ov.rivers.ELBE.length, 24);
  assert.equal(ov.rivers.ELBE[0], 50);
  assert.equal(ov.rivers.ELBE[12], null, 'absent year reads null, not 0');
  assert.equal(ov.rivers.RHEIN[23], 110);
});
