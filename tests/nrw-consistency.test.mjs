// tests/nrw-consistency.test.mjs — every rule of the `nrw` gate must be able to
// turn red on a NON-EMPTY input (a gate that cannot fail proves nothing): a
// thin registry, a stale export, a truncated delivery, a deleted shard, a slot
// nulled by a merge bug, a swapped column, dropped alert stages, and a ZIP that
// quietly loses stations. Each rule is shown green on the healthy fixture and
// red on exactly the defect it was written for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// pin the clock before the module (and its sibling imports) read it
const NOW = '2026-09-04T12:00:00Z'; // 13:00 MEZ -> 2026-09-04
process.env.PEGEL_NOW = NOW;
const nowDate = new Date(NOW);
const {
  checkFleetSize, checkFleetEdge, checkWindowDepth, collectionStart,
  checkRegressionStatuses, compareSeries, compareRange, metaRevisions, compareManifest,
  checkShardShape, checkMetaShape, checkAlertStages, checkCoverageMarks, highWaterRatio, highWaterMark,
  storedDays, registrySize, readProduct, isoDayNum, slotNum,
  MIN_FULL_TRIPLES, MIN_GAUGES,
} = await import('../scripts/check-nrw-consistency.mjs');
const { daysInYear } = await import('../scripts/fetch-wsv-archive.mjs');
const { buildTopology, basinIndex, assignBasin } = await import('../scripts/fetch-nrw-archive.mjs');
const { build: buildPrecip } = await import('../scripts/build-nrw-precip.mjs');

// ---------- fixtures ----------

// the source window measured 2026-09-04: 2024-09-04 .. 2026-09-02 (729 days)
const WINDOW = { from: '2024-09-04', to: '2026-09-02' };
const SEP4_2024 = 247; // day index of Sep 4 in a leap year
const SEP4_2025 = 246;
const SEP2_2026 = 244;
const FULL_YEARS = [[2024, { from: SEP4_2024 }], [2025, {}], [2026, { to: SEP2_2026 }]];
const STATION_YEARS = [[2025, { from: SEP4_2025 }], [2026, { to: SEP2_2026 }]]; // Tier 2: one year of year.json

function mkShard(kind, id, y, { from = 0, to = daysInYear(y) - 1, seedMin = false } = {}) {
  const n = daysInYear(y);
  const fill = f => Array.from({ length: n }, (_, d) => (d >= from && d <= to ? f(d) : null));
  if (kind === 'gauges') {
    return {
      id, y,
      min: seedMin ? fill(() => null) : fill(d => 45 + (d % 3)),
      mean: fill(d => 50 + (d % 3)), max: fill(d => 55 + (d % 3)), n: fill(() => 96), acc: {},
    };
  }
  if (kind === 'rain') return { id, y, mm: fill(d => d % 3), imax: fill(d => d % 3), cov: {} };
  return { id, y, mean: fill(() => 10), max: fill(() => 12) };
}

function mkStation(kind, id, { years = FULL_YEARS, meta = {}, entry = null } = {}) {
  const shards = new Map(years.map(([y, o]) => [y, mkShard(kind, id, y, o)]));
  return { meta: { id, ...meta }, shards, days: storedDays(kind, shards), entry };
}

const FULL_INFO = [250, 410, 440];
// n gauges: the first `stationCount` are Tier-2 (one year, src station), the
// first `triples` carry a full alert triple
function mkGauges(n, { stationCount = 48, triples = 130, years = FULL_YEARS } = {}) {
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const tier2 = i < stationCount;
    map.set('g' + i, mkStation('gauges', 'g' + i, {
      years: tier2 ? STATION_YEARS : years,
      meta: { src: tier2 ? 'station' : 'bulk', info: i < triples ? FULL_INFO : (i % 2 ? [100, null, null] : [null, null, null]) },
    }));
  }
  return map;
}
const mkMany = (kind, n, years = [[2026, { to: SEP2_2026 }]]) =>
  new Map(Array.from({ length: n }, (_, i) => [kind[0] + i, mkStation(kind, kind[0] + i, { years })]));

// Coordinates the fixture needs since N8: the areal rule places every station
// on the NRW box, and a gauge without a usable pair never receives rain. Rain
// gauge j sits exactly on a gauge cluster, so the assignment is unambiguous and
// no nearest-neighbour tie is ever needed.
//
// SPREAD ACROSS THE WHOLE FLEET, not over its first third. Until rule version 2
// this was floor(j/3), which piled all 313 rain gauges onto gauges 0..104 and
// left the other 195 with no product at all — 104 of 300, comfortably over the
// floor of 80 that N8 had then. Version 2 raised the floor to 260 (measured 275
// of 276 on the real mirror), and a fixture that is two thirds desert cannot
// reach it: the 15 km ring plus the 45 km knn cap got to 184 and the CLI tests
// went red. That is a property of a straight line of gauges 108 km long, not of
// the rule — the real fleet has rain gauges throughout — so the fixture now
// spreads them, and every gauge has one within a cluster or two.
const RAIN_PER_GAUGE = 3;
// 0.005 deg ~ 556 m between clusters — 300 gauges have to fit inside the box's
// 2.8 degrees of latitude, and a rain gauge sits ON its cluster, so the nearest
// neighbour is never a tie.
const fixLat = i => 51 + i * 0.005;
export const gaugeCoords = i => ({ lat: fixLat(i), lon: 7 });
const rainCoords = j => ({ lat: fixLat(Math.floor(j * N_GAUGES / N_RAIN)), lon: 7 });

// The graph the collector's own builder makes of this fleet — not a
// hand-written one. Until 2026-09-09 this was 300 gauges with `down: null`,
// so N8 had never seen a chain buildTopology built. The registry is the
// fleet as the source would describe it: one river, every gauge `i` at
// `i/2 + 1` km above the mouth with a catchment that grows downstream, so
// the builder chains g299 -> ... -> g0 and marks g0 the mouth.
const registryOf = gauges => new Map([
  ...[...gauges.keys()].map((no, i) => [no, {
    station_no: no, _src: ['stations', 'pegel'], object_type: 'Oberflächengewässer', station_name: no,
    site_no: '100', catchment_no: '272', catchment_name: 'Sieg', WTO_OBJECT: 'Sieg',
    DIST_TO_CONFL: `${(i / 2 + 1).toFixed(2)} km`, CATCHMENT_SIZE: `${400 - i},00 km²`,
  }]),
  ...Array.from({ length: N_RAIN }, (_, j) => ['r' + j, {
    station_no: 'r' + j, _src: ['stations', 'nieder'], object_type: 'Klimastation', station_name: 'r' + j,
    site_no: '100', catchment_no: '272', catchment_name: 'Sieg',
  }]),
]);
const topologyOf = gauges => {
  const registry = registryOf(gauges);
  const bidx = basinIndex(registry);
  return { schema: 1, ...buildTopology(registry, e => assignBasin(e, bidx), () => true) };
};

function healthyFleet() {
  const gauges = mkGauges(300);
  return { registryCount: 617, gauges, rain: mkMany('rain', 313), temp: mkMany('temp', 108), topology: topologyOf(gauges) };
}

const coverage = () => ({
  gauges: { registry: 310, bulk: 254, station: 48, noSeries: 8, highWater: 254 / 310 },
  rain: { registry: 319, bulk: 313, station: 6, noSeries: 0, highWater: 313 / 319 },
  temp: { registry: 108, bulk: 108, station: 0, noSeries: 0, highWater: 1 },
});
const manifestOf = (cov = coverage()) => ({ schema: 1, generated: NOW, window: WINDOW, coverage: cov, gauges: {}, rain: {}, temp: {} });

// ---------- N1 fleet size ----------

test('N1: the measured fleet is green', () => {
  assert.deepEqual(checkFleetSize(healthyFleet()), []);
});

test('N1: an empty tree is red on every count and on the topology', () => {
  const v = checkFleetSize({ registryCount: 0, gauges: new Map(), rain: new Map(), temp: new Map(), topology: null });
  assert.equal(v.length, 5, v.join('\n'));
  assert.match(v[0], /registry\.json lists 0 stations \(min 600\)/);
  assert.match(v[4], /topology\.json missing/);
});

test('N1: 599 registry rows, 289 gauges with data, 299 rain, 99 temp are each red', () => {
  const f = healthyFleet();
  assert.match(checkFleetSize({ ...f, registryCount: 599 })[0], /599 stations \(min 600\)/);
  assert.match(checkFleetSize({ ...f, gauges: mkGauges(289), topology: { basins: {} } })[0], /only 289 gauges/);
  assert.match(checkFleetSize({ ...f, rain: mkMany('rain', 299) })[0], /only 299 rain/);
  assert.match(checkFleetSize({ ...f, temp: mkMany('temp', 99) })[0], /only 99 temp/);
});

test('N1: a gauge with a directory but no stored day does not count', () => {
  const f = healthyFleet();
  const dark = mkStation('gauges', 'dark', { years: [[2026, { from: 300, to: 200 }]] }); // empty arrays
  assert.equal(dark.days.length, 0);
  f.gauges = new Map([...mkGauges(289), ['dark', dark]]);
  f.topology = { basins: {} };
  assert.match(checkFleetSize(f)[0], /only 289 gauges/);
});

test('N1: a topology gauge without meta.json or without a shard is red', () => {
  const f = healthyFleet();
  f.topology.basins[272].gauges.push('ghost');
  assert.match(checkFleetSize(f)[0], /names gauge ghost, which has no gauges\/ghost\/meta\.json/);
  f.topology.basins[272].gauges.pop();
  f.gauges.set('g0', { meta: { id: 'g0' }, shards: new Map(), days: [] });
  assert.match(checkFleetSize(f)[0], /names gauge g0, which has no year shard/);
});

test('N1: topology entries may be objects carrying an id', () => {
  const f = healthyFleet();
  f.topology.basins[272].gauges = [{ id: 'g1', name: 'X' }, { id: 'nope' }];
  const v = checkFleetSize(f);
  assert.equal(v.length, 1);
  assert.match(v[0], /gauge nope/);
});

// ---------- N2 fleet edge ----------

test('N2: a fleet ending on 09-02 is green, 09-01 is the edge, 08-31 is red', () => {
  assert.deepEqual(checkFleetEdge(mkGauges(300), nowDate), []);
  const lag3 = mkGauges(300, { years: [[2024, { from: SEP4_2024 }], [2025, {}], [2026, { to: SEP2_2026 - 1 }]] });
  for (const s of lag3.values()) if (s.meta.src === 'station') s.shards.get(2026).mean[SEP2_2026] = null, s.shards.get(2026).max[SEP2_2026] = null;
  assert.deepEqual(checkFleetEdge(new Map([...lag3].map(([k, s]) => [k, { ...s, days: storedDays('gauges', s.shards) }])), nowDate), []);
  const lag4 = mkGauges(300, { stationCount: 0, years: [[2024, { from: SEP4_2024 }], [2025, {}], [2026, { to: SEP2_2026 - 2 }]] });
  const v = checkFleetEdge(lag4, nowDate);
  assert.equal(v.length, 1);
  assert.match(v[0], /newest stored gauge day is 2026-08-31, 4 days behind today \(max 3\)/);
});

test('N2: the fleet edge is fine but 15% of the gauges stopped ten days earlier — red', () => {
  const gauges = mkGauges(300, { stationCount: 0 });
  let i = 0;
  for (const s of gauges.values()) {
    if (i++ >= 45) break;
    const doc = s.shards.get(2026);
    for (let d = SEP2_2026 - 9; d <= SEP2_2026; d++) doc.mean[d] = null, doc.max[d] = null;
    s.days = storedDays('gauges', s.shards);
  }
  const v = checkFleetEdge(gauges, nowDate);
  assert.equal(v.length, 1);
  assert.match(v[0], /only 85\.0% of 300 gauges reach the fleet edge 2026-09-02 minus 3 days/);
});

test('N2: a fleet without a stored day is a violation, never a silent pass', () => {
  assert.match(checkFleetEdge(new Map(), nowDate)[0], /cannot be measured/);
});

// ---------- N3 window depth ----------

const mature = new Date('2025-06-01T00:00:00Z'); // collection older than a year

test('N3 mature: 729 stored days per bulk gauge is green', () => {
  assert.deepEqual(checkWindowDepth(mkGauges(300), { nowDate, window: WINDOW, collectionStart: mature }), []);
});

test('N3 mature: a fleet whose median drops to 650 days is red', () => {
  const gauges = mkGauges(300, { stationCount: 0, years: [[2024, { from: SEP4_2024 + 79 }], [2025, {}], [2026, { to: SEP2_2026 }]] });
  const v = checkWindowDepth(gauges, { nowDate, window: WINDOW, collectionStart: mature });
  assert.equal(v.length, 2, v.join('\n'));
  assert.match(v[0], /median of 650 stored days over the trailing 730 across 300 gauges \(min 700\)/);
});

test('N3 mature: a full median but only 55% of the gauges at >= 700 days is red on the share alone', () => {
  const gauges = mkGauges(300, { stationCount: 135 }); // 135 one-year gauges, 165 full
  const v = checkWindowDepth(gauges, { nowDate, window: WINDOW, collectionStart: mature });
  assert.equal(v.length, 1, v.join('\n'));
  assert.match(v[0], /only 55\.0% of 300 gauges hold >= 700/);
});

test('N3 young: the offered span stored whole is green, a truncated delivery is red', () => {
  const young = collectionStart({ runs: [{ at: NOW }] }, null);
  assert.deepEqual(checkWindowDepth(mkGauges(300), { nowDate, window: WINDOW, collectionStart: young }), []);
  const truncated = mkGauges(300, { years: STATION_YEARS }); // bulk gauges written like Tier 2: 364 days
  const v = checkWindowDepth(truncated, { nowDate, window: WINDOW, collectionStart: young });
  assert.equal(v.length, 1);
  assert.match(v[0], /median stored span of 252 bulk gauges is 364 days, the source offered 729 \(2024-09-04\.\.2026-09-02, slack 2\)/);
});

test('N3 young: gaps inside the span are the source\'s, not the collector\'s', () => {
  const gauges = mkGauges(300);
  for (const s of gauges.values()) {
    const doc = s.shards.get(2025);
    for (let d = 100; d < 160; d++) doc.mean[d] = null, doc.max[d] = null;
    s.days = storedDays('gauges', s.shards);
  }
  assert.deepEqual(checkWindowDepth(gauges, { nowDate, window: WINDOW, collectionStart: nowDate }), []);
});

test('N3 young: no window, no src bulk, or no gauge at all is a violation', () => {
  assert.match(checkWindowDepth(mkGauges(300), { nowDate, window: null, collectionStart: nowDate })[0], /manifest\.window missing/);
  const onlyTier2 = mkGauges(50, { stationCount: 50 });
  assert.match(checkWindowDepth(onlyTier2, { nowDate, window: WINDOW, collectionStart: nowDate })[0], /no gauge is marked src "bulk"/);
  assert.match(checkWindowDepth(new Map(), { nowDate, window: WINDOW })[0], /cannot be measured/);
});

test('N3: collectionStart reads the oldest run, else the manifest stamp', () => {
  assert.equal(collectionStart({ runs: [{ at: '2026-09-10T00:00:00Z' }, { at: '2026-09-04T17:41:00Z' }] }, null).toISOString(), '2026-09-04T17:41:00.000Z');
  assert.equal(collectionStart([{ at: '2026-09-05T00:00:00Z' }], null).toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(collectionStart(null, { generated: NOW }).toISOString(), '2026-09-04T12:00:00.000Z');
  assert.equal(collectionStart(null, null), null);
});

// ---------- N4 regression ----------

test('N4: a deleted or renamed file is red, --allow-prune lets it through', () => {
  const changes = [{ status: 'M', path: 'nrw/gauges/a/2026.json' }, { status: 'D', path: 'nrw/gauges/b/2025.json' }, { status: 'R', path: 'nrw/rain/c/2026.json' }];
  const v = checkRegressionStatuses(changes);
  assert.equal(v.length, 2);
  assert.match(v[0], /^N4: nrw\/gauges\/b\/2025\.json: git status D/);
  assert.deepEqual(checkRegressionStatuses(changes, true), []);
});

test('N4: a slot going non-null -> null is red, a revised value is not', () => {
  const head = mkShard('gauges', 'a', 2026, { to: SEP2_2026 });
  const revised = mkShard('gauges', 'a', 2026, { to: SEP2_2026 });
  revised.mean[100] = 99; revised.max[100] = 120; revised.min[100] = 1;
  assert.deepEqual(compareSeries('gauges', head, revised, 'p'), []);
  const nulled = mkShard('gauges', 'a', 2026, { to: SEP2_2026 });
  nulled.mean[100] = null; nulled.mean[101] = null; nulled.n[5] = null;
  const v = compareSeries('gauges', head, nulled, 'p');
  assert.equal(v.length, 2, v.join('\n'));
  assert.match(v[0], /^N4: p: mean: 2 slot\(s\) went non-null -> null \(first day index 100\)/);
  assert.match(v[1], /n: 1 slot/);
  assert.match(compareSeries('gauges', head, null, 'p')[0], /unreadable while HEAD had year 2026/);
  assert.deepEqual(compareSeries('gauges', null, nulled, 'p'), [], 'no baseline, nothing to compare');
});

test('N4: rain and temperature shards are compared on their own keys', () => {
  const head = mkShard('rain', 'r', 2026, { to: SEP2_2026 });
  const tree = mkShard('rain', 'r', 2026, { to: SEP2_2026 });
  tree.imax[3] = null;
  assert.match(compareSeries('rain', head, tree, 'p')[0], /imax: 1 slot/);
  const th = mkShard('temp', 't', 2026), tt = mkShard('temp', 't', 2026);
  tt.max[0] = null;
  assert.match(compareSeries('temp', th, tt, 'p')[0], /max: 1 slot/);
});

test('N4: from only sinks, to only rises', () => {
  assert.deepEqual(compareRange({ from: '2024-09-04', to: '2026-09-02' }, { from: '2024-09-03', to: '2026-09-03' }, 'p'), []);
  const v = compareRange({ from: '2024-09-04', to: '2026-09-02' }, { from: '2024-09-05', to: '2026-09-01' }, 'p');
  assert.equal(v.length, 2);
  assert.match(v[0], /from moved later \(2024-09-04 -> 2024-09-05\)/);
  assert.match(v[1], /to moved earlier \(2026-09-02 -> 2026-09-01\)/);
  assert.match(compareRange({ from: 2024 }, { from: 2025 }, 'p')[0], /from moved later/, 'years compare as numbers');
});

test('N4: revised characteristic values are printed as notes, not violations', () => {
  const head = { mw: 66, mnw: 18, mhw: 364, info: [250, 410, 440] };
  const notes = metaRevisions(head, { mw: 67, mnw: 18, mhw: 364, info: [250, 415, 440] }, 'p');
  assert.deepEqual(notes, ['p: mw 66 -> 67', 'p: info [250,410,440] -> [250,415,440]']);
  assert.deepEqual(metaRevisions(head, { ...head }, 'p'), []);
});

test('N4: a manifest entry that vanishes is red unless pruning is allowed', () => {
  const head = { gauges: { a: { from: '2024-09-04', to: '2026-09-02' }, b: { from: '2024-09-04', to: '2026-09-02' } }, rain: {}, temp: {} };
  const tree = { gauges: { a: { from: '2024-09-04', to: '2026-09-01' } }, rain: {}, temp: {} };
  const v = compareManifest(head, tree);
  assert.equal(v.length, 2, v.join('\n'));
  assert.match(v[0], /manifest\.json gauges\/a: to moved earlier/);
  assert.match(v[1], /gauges\/b vanished from the manifest/);
  assert.equal(compareManifest(head, tree, { allowPrune: true }).length, 1);
  assert.deepEqual(compareManifest(null, tree), []);
});

// ---------- N5 shape + plausibility ----------

test('N5: a healthy shard is green, seeded history with min null too', () => {
  assert.deepEqual(checkShardShape('gauges', mkShard('gauges', 'a', 2026, { to: SEP2_2026 }), 'p', { id: 'a', y: 2026 }), []);
  assert.deepEqual(checkShardShape('gauges', mkShard('gauges', 'a', 2024, { from: SEP4_2024, seedMin: true }), 'p', { id: 'a', y: 2024 }), []);
  assert.deepEqual(checkShardShape('rain', mkShard('rain', 'r', 2026), 'p', { id: 'r', y: 2026 }), []);
  assert.deepEqual(checkShardShape('temp', mkShard('temp', 't', 2026), 'p', { id: 't', y: 2026 }), []);
});

test('N5: the swapped column — max under mean — is red, and so is min over mean', () => {
  const doc = mkShard('gauges', 'a', 2026);
  [doc.mean, doc.max] = [doc.max, doc.mean];
  const v = checkShardShape('gauges', doc, 'p', { id: 'a', y: 2026 });
  assert.equal(v.length, 1, v.join('\n'));
  assert.match(v[0], /^N5: p: mean > max on 365 day\(s\), first at day index 0/);
  const doc2 = mkShard('gauges', 'a', 2026);
  doc2.min[7] = doc2.mean[7] + 0.02;
  assert.match(checkShardShape('gauges', doc2, 'p')[0], /min > mean on 1 day\(s\), first at day index 7/);
  doc2.min[7] = doc2.mean[7] + 0.005; // inside the rounding slack
  assert.deepEqual(checkShardShape('gauges', doc2, 'p'), []);
});

test('N5: sentinels, sample counts, sparse accuracy and array lengths', () => {
  const doc = mkShard('gauges', 'a', 2026);
  doc.max[10] = 99999;
  assert.match(checkShardShape('gauges', doc, 'p')[0], /level outside -2000\.\.20000 cm or not a number on 1 day\(s\), first at day index 10/);
  const n289 = mkShard('gauges', 'a', 2026);
  n289.n[0] = 289; n289.n[1] = 0; n289.n[2] = 1.5; n289.n[3] = 288; // 288 = a 5-minute gauge, legal
  assert.match(checkShardShape('gauges', n289, 'p')[0], /n outside 1\.\.288 on 3 day\(s\)/);
  const acc = mkShard('gauges', 'a', 2026);
  acc.acc = { 3: 87.5, 400: 50, 5: 120 };
  assert.match(checkShardShape('gauges', acc, 'p')[0], /acc: 2 entr\(ies\) outside day 0\.\.364 \/ 0\.\.100 %, first at key 5|first at key 400/);
  const short = mkShard('gauges', 'a', 2024);
  short.mean = short.mean.slice(0, 365);
  assert.match(checkShardShape('gauges', short, 'p')[0], /mean\.length != 366 for 2024/);
  const partial = mkShard('gauges', 'a', 2026);
  partial.mean[3] = null; // max without mean: the export's own partial last day looks like this
  assert.deepEqual(checkShardShape('gauges', partial, 'p'), []);
});

test('N5: a shard that names the wrong station or year is red', () => {
  const v = checkShardShape('gauges', mkShard('gauges', 'b', 2025), 'p', { id: 'a', y: 2026 });
  assert.equal(v.length, 2);
  assert.match(v[0], /names itself year 2025/);
  assert.match(v[1], /names itself station b/);
  assert.match(checkShardShape('gauges', null, 'p')[0], /not a year shard/);
});

test('N5: rain and temperature plausibility', () => {
  const rain = mkShard('rain', 'r', 2026);
  rain.mm[1] = -0.1; rain.imax[2] = 'x'; rain.cov = { 1: 101 };
  const v = checkShardShape('rain', rain, 'p');
  assert.equal(v.length, 3, v.join('\n'));
  assert.match(v[0], /mm outside 0\.\.1000 or not a number on 1 day/);
  assert.match(v[1], /imax negative or not a number on 1 day/);
  assert.match(v[2], /cov: 1 entr/);
  const temp = mkShard('temp', 't', 2026);
  temp.mean[4] = 13; // above max 12: the source itself does this (702705), so it is not a finding
  assert.deepEqual(checkShardShape('temp', temp, 'p'), []);
  temp.max[5] = 'warm';
  assert.match(checkShardShape('temp', temp, 'p')[0], /temperature not a number on 1 day/);
});

test('N5: meta.json shape', () => {
  assert.deepEqual(checkMetaShape('gauges', { id: 'a', info: [250, null, null] }, 'p', 'a'), []);
  assert.deepEqual(checkMetaShape('gauges', { id: 'a' }, 'p', 'a'), [], 'no info at all is legal');
  assert.match(checkMetaShape('gauges', null, 'p', 'a')[0], /meta\.json missing/);
  assert.match(checkMetaShape('gauges', { id: 'b' }, 'p', 'a')[0], /names itself station b/);
  assert.match(checkMetaShape('gauges', { id: 'a', info: [1, 2, 3, 4] }, 'p', 'a')[0], /info is not an array/);
  assert.match(checkMetaShape('gauges', { id: 'a', info: '250' }, 'p', 'a')[0], /info is not an array/);
});

// ---------- N6 alert stages ----------

test('N6: 130 full triples are green, 109 are red', () => {
  assert.deepEqual(checkAlertStages(mkGauges(300, { triples: 130 })), []);
  assert.deepEqual(checkAlertStages(mkGauges(300, { triples: MIN_FULL_TRIPLES })), []);
  const v = checkAlertStages(mkGauges(300, { triples: 109 }));
  assert.equal(v.length, 1);
  assert.match(v[0], /only 109 gauges carry a full Info_1 < Info_2 < Info_3 triple \(min 110\)/);
});

test('N6: the order of the present entries is checked, partial triples are legal', () => {
  const gauges = mkGauges(300);
  gauges.get('g200').meta.info = [250, 250, 440];
  gauges.get('g201').meta.info = [250, null, 200];
  gauges.get('g202').meta.info = [null, 410, 440];
  gauges.get('g203').meta.info = [100];
  const v = checkAlertStages(gauges);
  assert.equal(v.length, 2, v.join('\n'));
  assert.match(v[0], /g200\/meta\.json: info \[250,250,440\] is not strictly increasing/);
  assert.match(v[1], /g201\/meta\.json: info \[250,null,200\]/);
});

test('N6: a fleet whose meta.json files carry no info at all is red', () => {
  const gauges = mkGauges(300, { triples: 0 });
  for (const s of gauges.values()) delete s.meta.info;
  assert.match(checkAlertStages(gauges)[0], /only 0 gauges/);
});

// ---------- N7 bulk coverage ----------

test('N7: the measured coverage is green against its own mark and against an identical HEAD', () => {
  assert.deepEqual(checkCoverageMarks(manifestOf()), []);
  assert.deepEqual(checkCoverageMarks(manifestOf(), manifestOf()), []);
});

test('N7: bulk 3 pp under the mark is the edge, 3.5 pp under is red', () => {
  const edge = coverage();
  edge.gauges.bulk = 245; // 245/310 = 79.03%, mark 81.94% -> 2.9 pp under
  assert.deepEqual(checkCoverageMarks(manifestOf(edge)), []);
  const red = coverage();
  red.gauges.bulk = 243; // 78.39% -> 3.55 pp under
  const v = checkCoverageMarks(manifestOf(red));
  assert.equal(v.length, 1, v.join('\n'));
  assert.match(v[0], /coverage\.gauges: bulk covers 78\.4% of the registry, 3\.5 pp under the high-water mark 81\.9%/);
});

test('N7: a missing, unraised or sunken mark is red', () => {
  const missing = coverage();
  delete missing.gauges.highWater;
  assert.match(checkCoverageMarks(manifestOf(missing))[0], /coverage\.gauges\.highWater missing/);
  const unraised = coverage();
  unraised.gauges.bulk = 260; // share rose to 83.9% while the mark stayed at 81.9%
  assert.match(checkCoverageMarks(manifestOf(unraised))[0], /highWater 81\.9% sits below the current share 83\.9%/);
  const sunk = coverage();
  sunk.rain.highWater = 0.95; sunk.rain.bulk = 303;
  const head = manifestOf();
  assert.match(checkCoverageMarks(manifestOf(sunk), head)[0], /coverage\.rain\.highWater sank 98\.1% -> 95\.0%/);
});

test('N7: noSeries may grow by two per run, three is red; station successes may fall by five, six is red', () => {
  const head = manifestOf();
  const ok = coverage();
  ok.gauges.noSeries = 10; ok.gauges.station = 43;
  assert.deepEqual(checkCoverageMarks(manifestOf(ok), head), []);
  const bad = coverage();
  bad.gauges.noSeries = 11; bad.gauges.station = 42;
  const v = checkCoverageMarks(manifestOf(bad), head);
  assert.equal(v.length, 2, v.join('\n'));
  assert.match(v[0], /noSeries grew 8 -> 11 in one run \(max \+2\)/);
  assert.match(v[1], /successful single-station fetches fell 48 -> 42 in one run \(max -5\)/);
});

test('N7: the registry must be the union — bulk above registry is red, and a missing block too', () => {
  const cov = coverage();
  cov.rain.registry = 308; // the Klimastation count, not the union: 313 bulk cannot fit
  cov.rain.highWater = 313 / 308;
  const v = checkCoverageMarks(manifestOf(cov));
  assert.match(v[0], /coverage\.rain: bulk 313 \/ station 6 exceed registry 308 — the registry must be the union/);
  assert.match(checkCoverageMarks({ schema: 1 })[0], /manifest\.coverage missing/);
  assert.match(checkCoverageMarks(manifestOf({ gauges: coverage().gauges }))[0], /coverage\.rain missing/);
  const empty = coverage();
  empty.temp.registry = 0;
  assert.match(checkCoverageMarks(manifestOf(empty))[0], /coverage\.temp: registry 0/);
});

test('N7: the mark may be stored as a ratio, a percentage or an object', () => {
  assert.equal(highWaterRatio(0.819), 0.819);
  assert.ok(Math.abs(highWaterRatio(81.9) - 0.819) < 1e-9);
  assert.equal(highWaterRatio({ ratio: 0.5 }), 0.5);
  assert.equal(highWaterRatio(null), null);
  assert.equal(highWaterRatio('x'), null);
  assert.deepEqual(highWaterMark({ bulk: 254, bulkPct: 81.9, station: 0 }, 310), { ratio: 0.819, bulk: 254 });
  assert.deepEqual(highWaterMark({ bulk: 108 }, 108), { ratio: 1, bulk: 108 });
});

// the collector's own mark shape, {bulk, bulkPct, station}, measured 2026-09-04
const collectorCoverage = () => ({
  gauges: { registry: 310, bulk: 254, station: 48, noSeries: 8, highWater: { bulk: 254, bulkPct: 81.9, station: 48 } },
  rain: { registry: 319, bulk: 310, station: 5, noSeries: 1, highWater: { bulk: 311, bulkPct: 97.5, station: 5 } },
  temp: { registry: 125, bulk: 108, station: 20, noSeries: 0, highWater: { bulk: 108, bulkPct: 100, station: 20 } },
});

test('N7 with count marks: a registry that grew by discovery is green, a ZIP that lost stations is red', () => {
  // temp: registry 108 -> 125 through Tier 2, bulk unchanged at 108 — the
  // share fell 13.6 pp, the count fell by nothing; rain: mark 311, bulk 310
  assert.deepEqual(checkCoverageMarks(manifestOf(collectorCoverage())), []);
  const lost = collectorCoverage();
  lost.gauges.bulk = 244; // 10 under the mark, max 9.3
  const v = checkCoverageMarks(manifestOf(lost));
  assert.equal(v.length, 1, v.join('\n'));
  assert.match(v[0], /coverage\.gauges: the bulk product carries 244 of 310 registered stations, 10 under its high-water mark 254 \(max 9\.3\)/);
  const edge = collectorCoverage();
  edge.gauges.bulk = 245; // 9 under: inside the slack
  assert.deepEqual(checkCoverageMarks(manifestOf(edge)), []);
});

test('N7 with count marks: an unraised or sunken mark is red, rising station successes are not', () => {
  const head = manifestOf(collectorCoverage());
  const more = collectorCoverage();
  more.gauges.station = 52; more.gauges.highWater.station = 52; // Tier 2 found four more
  assert.deepEqual(checkCoverageMarks(manifestOf(more), head), []);
  const unraised = collectorCoverage();
  unraised.gauges.bulk = 260;
  assert.match(checkCoverageMarks(manifestOf(unraised), head)[0], /highWater\.bulk 254 sits below the current bulk count 260/);
  const sunk = collectorCoverage();
  sunk.gauges.highWater.bulk = 250;
  assert.match(checkCoverageMarks(manifestOf(sunk), head)[0], /highWater\.bulk sank 254 -> 250/);
});

// ---------- loader helpers ----------

test('registrySize counts rows however registry.json is shaped', () => {
  assert.equal(registrySize([1, 2, 3]), 3);
  assert.equal(registrySize({ stations: [1, 2] }), 2);
  assert.equal(registrySize({ stations: { a: 1, b: 2, c: 3 } }), 3);
  assert.equal(registrySize({ a: 1, b: 2 }), 2);
  assert.equal(registrySize(null), 0);
});

test('storedDays counts the source\'s own values, never the derived min', () => {
  const shards = new Map([[2026, mkShard('gauges', 'a', 2026, { from: 10, to: 12, seedMin: true })]]);
  assert.deepEqual(storedDays('gauges', shards), [slotNum(2026, 10), slotNum(2026, 11), slotNum(2026, 12)]);
  assert.equal(slotNum(2026, 0), isoDayNum('2026-01-01'));
});

// ---------- CLI integration: a real git baseline, green then sabotaged ----------

const SCRIPT = fileURLToPath(new URL('../scripts/check-nrw-consistency.mjs', import.meta.url));

// hooksPath is not cosmetic: the machine's global template installs a
// pre-commit scanner, and committing ~2000 fixture files through it is slow
function gitIn(dir, ...gitArgs) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t',
    '-c', 'core.hooksPath=/dev/null', ...gitArgs], { encoding: 'utf8' });
}

function runChecker(repo, extra = [], env = {}) {
  try {
    const stdout = execFileSync(process.execPath,
      [SCRIPT, '--tree', join(repo, 'nrw'), '--git', repo, ...extra],
      { encoding: 'utf8', env: { ...process.env, PEGEL_NOW: NOW, ...env } });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout) };
  }
}

const N_GAUGES = 300, N_RAIN = 313, N_TEMP = 108;

// the healthy tree, written once; every CLI test copies it
function writeTree(root) {
  const nrw = join(root, 'nrw');
  const manifest = manifestOf();
  const write = (kind, no, s, coords) => {
    const dir = join(nrw, kind, no);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...s.meta, ...coords, catchmentNo: '272', unit: kind === 'rain' ? 'mm' : 'cm' }));
    for (const [y, doc] of s.shards) writeFileSync(join(dir, `${y}.json`), JSON.stringify(doc));
    manifest[kind][no] = { n: no, w: 'W', b: '272', src: s.meta.src || 'bulk', from: WINDOW.from, to: WINDOW.to, days: s.days.length };
  };
  const gauges = mkGauges(N_GAUGES);
  let i = 0;
  for (const [no, s] of gauges) write('gauges', no, s, gaugeCoords(i++));
  let j = 0;
  for (const [no, s] of mkMany('rain', N_RAIN)) write('rain', no, s, rainCoords(j++));
  for (const [no, s] of mkMany('temp', N_TEMP)) write('temp', no, s, {});
  writeFileSync(join(nrw, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(nrw, 'registry.json'), JSON.stringify(Array.from({ length: 617 }, (_, i2) => ({ station_no: 's' + i2 }))));
  writeFileSync(join(nrw, 'topology.json'), JSON.stringify(topologyOf(gauges)));
  writeFileSync(join(nrw, 'runs.json'), JSON.stringify({ runs: [{ at: NOW, fetched: 4 }] }));
  // N8 reads a product the collector does not write: the fixture has to build it
  // the same way CI does, between the collector and the gate.
  buildPrecip({ tree: nrw, out: join(nrw, 'precip'), generated: NOW.slice(0, 10) });
  writeHourlyLag(nrw);
}

// N9's sibling of the above. The CLI runs WITHOUT --hires here — this fixture
// carries no nrw-hires tree — so clauses (a)-(f) are what these tests exercise;
// (g) and (h) are the two that need the second branch, and they are proven
// against the real mirror, not against a fixture. The ids come out of the
// fixture's OWN precip manifest, so N9(c)'s two reference checks have something
// real to resolve instead of a list this helper made up.
export function hourlyLagFor(nrw, { to = new Date(Date.parse(NOW) - 9 * 36e5), n = 120, over = {} } = {}) {
  const manifest = JSON.parse(readFileSync(join(nrw, 'manifest.json'), 'utf8'));
  const ids = Object.keys(manifest.precip || {}).filter(no => manifest.precip[no].series === true).sort().slice(0, n);
  assert.equal(ids.length, n, 'the fixture must carry enough gauges with a rain field to clear the N9 floor');
  const gauges = Object.fromEntries(ids.map((no, i) => [no, i < n * 0.5 ? 0 : i < n * 0.85 ? 1 : 2]));
  const byClass = [0, 0, 0];
  for (const c of Object.values(gauges)) byClass[c]++;
  const hourIso = d => d.toISOString().slice(0, 13) + ':00Z';
  const hours = 63 * 24;
  const daily = Object.keys(manifest.precip || {}).length;
  // the counts have to BALANCE, or N9(d)'s accounting identity is red on the
  // fixture every other CLI test depends on
  const notInHires = 24, attempted = daily - notInHires, noPeak = 20;
  const withPeak = attempted - noPeak, notSignificant = 6;
  return {
    schema: 1, generated: NOW.slice(0, 10), ruleVersion: 2, lagRuleVersion: 1,
    rule: { classes: [[0, 1], [2, 8], [9, null]], minR: 0.25, rotations: 99, fdrQ: 0.05 },
    window: { from: hourIso(new Date(to.getTime() - (hours - 1) * 36e5)), to: hourIso(to), hours },
    inputs: { sha256: 'f'.repeat(64), files: 1674 },
    counts: {
      daily, notInHires, noDailySet: 0, attempted, withPeak, noPeak,
      weak: withPeak - notSignificant - n, notSignificant, unclassed: 0, published: n,
      noPeakWhy: { wetHours: noPeak, pairs: 0, noPositiveLag: 0, noPair: 0 },
      byClass,
    },
    gauges,
    ...over,
  };
}
function writeHourlyLag(nrw, opts = {}) {
  mkdirSync(join(nrw, 'hourly'), { recursive: true });
  writeFileSync(join(nrw, 'hourly', 'lag.json'), JSON.stringify(hourlyLagFor(nrw, opts), null, 1) + '\n');
}

const SEED = mkdtempSync(join(tmpdir(), 'pegel-nrw-seed-'));
writeFileSync(join(SEED, 'README.md'), '# nrw\n');
gitIn(SEED, 'init', '-q');
gitIn(SEED, 'add', '-A');
gitIn(SEED, 'commit', '-q', '-m', 'branch skeleton'); // what the first CI run sees as HEAD
const FIRST_RUN = gitIn(SEED, 'rev-parse', 'HEAD');
writeTree(SEED);
gitIn(SEED, 'add', '-A');
gitIn(SEED, 'commit', '-q', '-m', 'seed');

function cloneSeed() {
  const repo = mkdtempSync(join(tmpdir(), 'pegel-nrw-consistency-'));
  cpSync(SEED, repo, { recursive: true });
  return repo;
}
const shardPath = (repo, kind, no, y) => join(repo, 'nrw', kind, no, `${y}.json`);
const readShard = (repo, kind, no, y) => JSON.parse(execFileSync('cat', [shardPath(repo, kind, no, y)], { encoding: 'utf8' }));
const writeShard = (repo, kind, no, y, doc) => writeFileSync(shardPath(repo, kind, no, y), JSON.stringify(doc));
const manifestPath = repo => join(repo, 'nrw', 'manifest.json');
// Every hand-edit of the mirror changes what the areal rule would produce from
// it. CI rebuilds between the collector and the gate; a test that edits the
// tree and then expects a green gate has to do the same, or it is asserting
// that N8(e) is asleep.
const rebuildPrecip = repo => buildPrecip({ tree: join(repo, 'nrw'), out: join(repo, 'nrw', 'precip'), generated: NOW.slice(0, 10) });
const readManifest = repo => JSON.parse(execFileSync('cat', [manifestPath(repo)], { encoding: 'utf8' }));

test('CLI: an untouched healthy checkout is green and prints the fleet numbers', () => {
  const { code, stdout } = runChecker(cloneSeed());
  assert.equal(code, 0, stdout);
  // 728, not 729: the trailing 730 days end today (09-04) and begin 2024-09-05,
  // one day after the source window opens
  // "(N9 partial: no --hires)" is part of the contract, not noise: this fixture
  // carries no nrw-hires tree, and a green run that skipped two clauses must not
  // be mistakable for a complete one.
  assert.match(stdout, /nrw consistency ok \(N9 partial: no --hires\): 0 changed files, registry 617, gauges 300 with data \(bulk 254, station 48, noSeries 8 of 310 registered\), rain 313, temp 108, fleet edge 2026-09-02 \(2 d behind today\), window median 728 d, full alert triples 130/);
  assert.match(stdout, /::warning::N9\(g\) input digest and N9\(h\) recomputation SKIPPED/);
});

test('CLI: the very first run — HEAD holds the skeleton, every data file is new — is green', () => {
  const repo = cloneSeed();
  gitIn(repo, 'reset', '-q', '--soft', FIRST_RUN.trim()); // data staged as A against the skeleton
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /nrw consistency ok(?: \(N9 partial: no --hires\))?: \d+ changed files/);
  assert.doesNotMatch(stdout, /N4/);
});

test('CLI: a repository without any commit still runs (everything counts as new)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pegel-nrw-nohead-'));
  writeTree(repo);
  gitIn(repo, 'init', '-q');
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /note: no HEAD to compare against/);
});

test('CLI: verification item 7 — a deleted shard, noSeries 11 and max under mean are all red', () => {
  const repo = cloneSeed();
  rmSync(shardPath(repo, 'gauges', 'g5', 2025)); // g5 is a topology gauge (Tier 2, shards 2025 + 2026): N4
  const m = readManifest(repo);
  m.coverage.gauges.noSeries = 11;
  writeFileSync(manifestPath(repo), JSON.stringify(m));
  const doc = readShard(repo, 'gauges', 'g100', 2026);
  [doc.mean, doc.max] = [doc.max, doc.mean];
  writeShard(repo, 'gauges', 'g100', 2026, doc);
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::N4: nrw\/gauges\/g5\/2025\.json: git status D/);
  assert.match(stdout, /::error::N7: coverage\.gauges: noSeries grew 8 -> 11 in one run/);
  assert.match(stdout, /::error::N5: nrw\/gauges\/g100\/2026\.json: mean > max on 245 day\(s\), first at day index 0/);
});

test('CLI: deleting every shard of a topology gauge is red on N1 as well as N4', () => {
  const repo = cloneSeed();
  for (const y of [2025, 2026]) rmSync(shardPath(repo, 'gauges', 'g5', y));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::N1: topology basin 272 names gauge g5, which has no year shard/);
  assert.match(stdout, /::error::N4: nrw\/gauges\/g5\/2026\.json: git status D/);
});

test('CLI: a merge that nulls a stored slot is red, a merge that revises it is green', () => {
  const repo = cloneSeed();
  const doc = readShard(repo, 'gauges', 'g60', 2026);
  doc.mean[50] = 77; doc.max[50] = 80; doc.min[50] = 70; // revision inside the window
  writeShard(repo, 'gauges', 'g60', 2026, doc);
  rebuildPrecip(repo);
  let r = runChecker(repo);
  assert.equal(r.code, 0, r.stdout);
  // two, not one: revising a level day also moves that gauge's response.json,
  // because the derived product is a function of the mirror and gets rebuilt
  assert.match(r.stdout, /2 changed files/);
  doc.mean[51] = null; doc.max[51] = null;
  writeShard(repo, 'gauges', 'g60', 2026, doc);
  rebuildPrecip(repo);
  r = runChecker(repo);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error::N4: nrw\/gauges\/g60\/2026\.json: mean: 1 slot\(s\) went non-null -> null \(first day index 51\)/);
  assert.match(r.stdout, /::error::N4: nrw\/gauges\/g60\/2026\.json: max: 1 slot/);
});

test('CLI: a manifest range that narrows or an entry that vanishes is red', () => {
  const repo = cloneSeed();
  const m = readManifest(repo);
  m.gauges.g70.to = '2026-08-01';
  delete m.rain.r3;
  writeFileSync(manifestPath(repo), JSON.stringify(m));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::N4: manifest\.json gauges\/g70: to moved earlier \(2026-09-02 -> 2026-08-01\)/);
  assert.match(stdout, /::error::N4: manifest\.json: rain\/r3 vanished from the manifest/);
});

test('CLI: revised alert stages are printed as notes on a green run', () => {
  const repo = cloneSeed();
  const metaPath = join(repo, 'nrw', 'gauges', 'g0', 'meta.json');
  const meta = JSON.parse(execFileSync('cat', [metaPath], { encoding: 'utf8' }));
  meta.info = [250, 415, 440]; meta.mw = 70;
  writeFileSync(metaPath, JSON.stringify(meta));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /note: nrw\/gauges\/g0\/meta\.json: mw undefined -> 70/);
  assert.match(stdout, /note: nrw\/gauges\/g0\/meta\.json: info \[250,410,440\] -> \[250,415,440\]/);
});

test('CLI: --allow-prune lets a deliberate deletion through, --skip silences a rule', () => {
  const repo = cloneSeed();
  rmSync(join(repo, 'nrw', 'gauges', 'g250'), { recursive: true });
  const m = readManifest(repo);
  delete m.gauges.g250;
  writeFileSync(manifestPath(repo), JSON.stringify(m));
  // a pruned gauge leaves the topology too — the collector rebuilds it from
  // the registry every run, and N1 holds the basin list to the directories
  const rest = mkGauges(N_GAUGES);
  rest.delete('g250');
  writeFileSync(join(repo, 'nrw', 'topology.json'), JSON.stringify(topologyOf(rest)));
  rebuildPrecip(repo);
  let r = runChecker(repo);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /git status D/);
  r = runChecker(repo, ['--allow-prune']);
  assert.equal(r.code, 0, r.stdout);
  const stale = cloneSeed();
  const sm = readManifest(stale);
  sm.coverage.gauges.noSeries = 20;
  writeFileSync(manifestPath(stale), JSON.stringify(sm));
  assert.equal(runChecker(stale).code, 1);
  r = runChecker(stale, ['--skip', 'N7']);
  assert.equal(r.code, 0, r.stdout);
});

test('CLI: a stale export (the fleet ends 2026-08-31) is red on N2', () => {
  const { code, stdout } = runChecker(cloneSeed(), [], { PEGEL_NOW: '2026-09-06T12:00:00Z' });
  assert.equal(code, 1);
  assert.match(stdout, /::error::N2: newest stored gauge day is 2026-09-02, 4 days behind today/);
});

test('CLI: dropped alert columns are red on N6 while every series stays healthy', () => {
  const repo = cloneSeed();
  for (let i = 0; i < 25; i++) {
    const p = join(repo, 'nrw', 'gauges', 'g' + i, 'meta.json');
    const meta = JSON.parse(execFileSync('cat', [p], { encoding: 'utf8' }));
    meta.info = [null, null, null];
    writeFileSync(p, JSON.stringify(meta));
  }
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::N6: only 105 gauges carry a full Info_1 < Info_2 < Info_3 triple \(min 110\)/);
});

test('CLI: readProduct attaches manifest entries and stored days', () => {
  const repo = cloneSeed();
  const gauges = readProduct(join(repo, 'nrw'), 'gauges', readManifest(repo));
  assert.equal(gauges.size, N_GAUGES);
  const g0 = gauges.get('g0');
  assert.equal(g0.entry.src, 'station');
  assert.equal(g0.days.length, 364);
  assert.equal(gauges.get('g100').days.length, 729);
  assert.equal(gauges.get('g100').shards.size, 3);
});

// ---------- N8: the derived areal-rain product ----------
// Each clause on a hand-broken product, so the rule is shown red on exactly the
// defect it exists for. The three counters (f/g/h) are drift rules and need a
// HEAD to drift against; the shape rules stand on their own.

const {
  checkPrecipShape, checkPrecipDrift, checkPrecipUsedBy, checkImplausibleRainStock,
  MIN_PRECIP_SERIES, MIN_RECEIVING_NODES, MAX_MM_DAY_RAW,
} = await import('../scripts/check-nrw-consistency.mjs');

// The rule block is part of the fixture, not decoration: since version 2 the
// gate reads its per-member distance bounds out of it rather than keeping a
// second copy, so an index without one has to be able to say so.
const HEALTHY_RULE = {
  ruleVersion: 2, maxAssignKm: 100, maxOrphanKm: 10,
  localKm: 15, knnFloor: 3, knnMaxKm: 45, minSetForSeries: 3,
};
const HEALTHY_INDEX = {
  schema: 1, rule: HEALTHY_RULE, counts: {
    routingNodes: 298, receivingNodes: 276, relayedExcluded: 21, badCoordNodes: 1,
    rainAssignedBasin: 302, rainAssignedOrphan: 12, rainUnassigned: 5,
    withSeries: 275, withoutRain: 0, cyclicNodes: 2,
    memberships: { basin: 949, orphan: 45, local: 1406, knn: 42 },
    stationsInNoSet: 5, stationsInNoSetIds: ['a', 'b', 'c', 'd', 'e'],
  },
  unassigned: [{ no: 'x', why: 'coords' }], far: [], gauges: {},
};
// one gauge, one 2025 shard, a set of two rain gauges it owns
const precipProduct = (over = {}) => new Map([['g1', {
  meta: { set: [{ no: 'r1', at: 'g1', via: 'basin', km: 4 }, { no: 'r2', at: 'g1', via: 'basin', km: 9 }], ...(over.meta || {}) },
  shards: new Map([[2025, {
    id: 'g1', y: 2025,
    mm: Array(365).fill(5), n: Array(365).fill(2),
    med: Array(365).fill(5), mx: Array(365).fill(5),
    ...(over.shard || {}),
  }]]),
}]]);
const RAIN_IDS = new Set(['r1', 'r2']);
const TOPO_GAUGES = { g1: {} };

// the reverse index the collector writes beside the sets: the SAME two
// memberships, read from the rain gauge's side
const usedByOf = (over = {}) => new Map([
  ['r1', [{ no: 'g1', via: 'basin', km: 4, at: 'g1' }]],
  ['r2', [{ no: 'g1', via: 'basin', km: 9, at: 'g1' }]],
  ...Object.entries(over),
]);

test('N8: the healthy product is green', () => {
  assert.deepEqual(checkPrecipShape(HEALTHY_INDEX, precipProduct(), RAIN_IDS, TOPO_GAUGES), []);
  assert.deepEqual(checkPrecipUsedBy(usedByOf(), precipProduct(), RAIN_IDS), []);
  assert.deepEqual(checkPrecipDrift(HEALTHY_INDEX, HEALTHY_INDEX), []);
});

// ---------- N8c4: the reverse index, compared in BOTH directions ----------
// A second copy of a relation is a second chance to be wrong, and every other
// N8 clause reads only the forward side — so each direction is broken by hand
// here and watched go red.

test('N8c4: a membership with no entry in the reverse index', () => {
  const short = usedByOf({ r2: [] });
  const v = checkPrecipUsedBy(short, precipProduct(), RAIN_IDS).join('\n');
  assert.match(v, /precip\/used-by\/r2\.json: precip\/g1\/meta\.json holds r2 in its set, but the reverse index does not name g1/);
  // …and a whole missing FILE is its own line, not silence
  const gone = usedByOf(); gone.delete('r2');
  assert.match(checkPrecipUsedBy(gone, precipProduct(), RAIN_IDS).join('\n'),
    /1 rain station\(s\) are in a set but have no file: r2/);
});

test('N8c4: an entry no meta.json holds, and a file for a station in no set at all', () => {
  const ghost = usedByOf({ r1: [{ no: 'g1', via: 'basin', km: 4, at: 'g1' }, { no: 'g9', via: 'local', km: 1, at: 'g9' }] });
  assert.match(checkPrecipUsedBy(ghost, precipProduct(), RAIN_IDS).join('\n'),
    /precip\/used-by\/r1\.json: names gauge g9, whose own meta\.json does not hold r1 in its set/);
  const extra = usedByOf({ r3: [{ no: 'g1', via: 'local', km: 2, at: 'g1' }] });
  const v = checkPrecipUsedBy(extra, new Map([...precipProduct()]), new Set(['r1', 'r2', 'r3'])).join('\n');
  assert.match(v, /1 file\(s\) for a rain station no set holds: r3/);
});

test('N8c4: every field of the entry is the set\'s own — name, via, km and at', () => {
  const skew = usedByOf({ r1: [{ no: 'g1', via: 'local', km: 4, at: 'g1' }] });
  assert.match(checkPrecipUsedBy(skew, precipProduct(), RAIN_IDS).join('\n'),
    /precip\/used-by\/r1\.json: gauge g1 disagrees with the set on via \("local" vs "basin"\)/);
  // `at` is the one that makes `km` readable: on a basin member the distance is
  // to the OWNING NODE, so an entry that keeps km and moves at states a span
  // between two gauges that never stood that far apart
  const moved = usedByOf({ r1: [{ no: 'g1', via: 'basin', km: 4, at: 'g7' }] });
  assert.match(checkPrecipUsedBy(moved, precipProduct(), RAIN_IDS).join('\n'),
    /gauge g1 disagrees with the set on at \("g7" vs "g1"\)/);
  // `name` is the one field that is NOT the set's: the set's name is the RAIN
  // station's, the entry's is the receiving GAUGE's, so it is checked against
  // the gauge product's own meta.json instead
  const named = usedByOf({ r1: [{ no: 'g1', name: 'Wesel', via: 'basin', km: 4, at: 'g1' }] });
  assert.match(checkPrecipUsedBy(named, precipProduct({ meta: { name: 'Menden' } }), RAIN_IDS).join('\n'),
    /gauge g1 is named "Wesel" here and "Menden" in precip\/g1\/meta\.json/);
  const alien = usedByOf({ ghost: [] });
  assert.match(checkPrecipUsedBy(alien, precipProduct(), RAIN_IDS).join('\n'),
    /precip\/used-by\/ghost\.json: ghost has no nrw\/rain\/ directory/);
});

test('N8c4: an unparseable or duplicated reverse index is not read as an empty one', () => {
  assert.match(checkPrecipUsedBy(usedByOf({ r1: null }), precipProduct(), RAIN_IDS).join('\n'),
    /precip\/used-by\/r1\.json: not an array of memberships/);
  const twice = usedByOf({ r1: [{ no: 'g1', via: 'basin', km: 4, at: 'g1' }, { no: 'g1', via: 'basin', km: 4, at: 'g1' }] });
  assert.match(checkPrecipUsedBy(twice, precipProduct(), RAIN_IDS).join('\n'),
    /precip\/used-by\/r1\.json: gauge g1 listed twice/);
});

test('N8c4: a precip/ tree with no used-by at all is red, not vacuously green', () => {
  const v = checkPrecipUsedBy(new Map(), precipProduct(), RAIN_IDS).join('\n');
  assert.match(v, /2 rain station\(s\) are in a set but have no file: r1, r2/);
});

test('N8a: an mm value over the areal bound, and an n over the set size', () => {
  const mm = Array(365).fill(5); mm[7] = 401;
  const v = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { mm } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(v.join('\n'), /mm outside 0\.\.400 on 1 day\(s\)/);
  const n = Array(365).fill(2); n[7] = 3;
  const w = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { n } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(w.join('\n'), /n outside 0\.\.2 on 1 day\(s\)/);
});

test('N8a: an array that is not daysInYear long', () => {
  const v = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { mm: Array(300).fill(5) } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(v.join('\n'), /mm\.length != 365/);
});

test('N8b: mm null with a non-zero n, and n 0 with a value — both directions', () => {
  const mm = Array(365).fill(5); mm[3] = null;                    // n stays 2
  const a = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { mm } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(a.join('\n'), /mm null <=> n 0 violated on \d+ day\(s\), first at day index 3/);
  const n = Array(365).fill(2); n[3] = 0;                         // mm stays 5
  const b = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { n } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(b.join('\n'), /mm null <=> n 0 violated/);
});

test('N8b: med and mx follow mm — a value under a null day is a leak from the filter', () => {
  const mm = Array(365).fill(5), n = Array(365).fill(2), med = Array(365).fill(5);
  mm[9] = null; n[9] = 0;                                          // a legitimate non-day…
  const v = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { mm, n, med } }), RAIN_IDS, TOPO_GAUGES);
  // its own finding, with its own day index: sharing a counter with the mm/n
  // clause used to print "first at day index -1"
  assert.match(v.join('\n'), /med\/mx do not follow mm on 1 day\(s\), first at day index 9/, '…but med still carries a number');
  assert.doesNotMatch(v.join('\n'), /mm null <=> n 0 violated/, 'and the mm/n invariant is NOT what broke');
});

test('N8a: a mean above the day’s own maximum — the one rule that can catch the estimator', () => {
  const mm = Array(365).fill(5), mx = Array(365).fill(5);
  mm[4] = 30;                                     // a mean of 30 over a maximum of 5
  const v = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { mm, mx } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(v.join('\n'), /mean or median above the day's maximum on 1 day\(s\), first at day index 4/);
  const med = Array(365).fill(5); med[4] = 9;
  const w = checkPrecipShape(HEALTHY_INDEX, precipProduct({ shard: { med } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(w.join('\n'), /above the day's maximum/, 'the median is checked too');
});

test('N8c: the same rain station listed twice in ONE set is the double count', () => {
  const dup = precipProduct({ meta: { set: [{ no: 'r1', at: 'g1' }, { no: 'r1', at: 'g1' }] } });
  const v = checkPrecipShape(HEALTHY_INDEX, dup, RAIN_IDS, TOPO_GAUGES);
  assert.match(v.join('\n'), /rain station r1 is in the set twice/);
});

test('N8h: the cycle members are compared, not only how many there are', () => {
  const withIds = ids => ({ ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, cyclicIds: ids } });
  const head = withIds(['a', 'b']);
  assert.deepEqual(checkPrecipDrift(withIds(['a', 'b']), head), []);
  // the source repairs one cycle and grows another: the COUNT is still 2
  const moved = withIds(['c', 'd']);
  assert.match(checkPrecipDrift(moved, head).join('\n'), /the cycle members changed: a,b -> c,d/);
});

test('N8c: a rain station owned by two gauges', () => {
  const products = precipProduct();
  products.set('g2', {
    meta: { set: [{ no: 'r1', at: 'g2', via: 'basin', km: 4 }] },   // r1 already belongs to g1
    shards: new Map(),
  });
  const v = checkPrecipShape(HEALTHY_INDEX, products, RAIN_IDS, { g1: {}, g2: {} });
  assert.match(v.join('\n'), /rain station r1 is owned by both g1 and g2/);
});

// ---------- N8c: membership, the three clauses that replaced the partition ----------
// The old rule was "one station, one owner", and it was a partition. Version 2
// makes membership many-to-many, so that check would now be false by
// construction — these are what stand in its place, and each is broken by hand
// here so it is known to be able to go red.

const memberSet = set => new Map([['g1', { meta: { set }, shards: new Map() }]]);
const RAIN_IDS3 = new Set(['r1', 'r2', 'r3']);
const TOPO_G1 = { g1: {} };
const shapeOf = (index, set) => checkPrecipShape(index, memberSet(set), RAIN_IDS3, TOPO_G1).join('\n');

test('N8c2: every member is held to the bound of its OWN via, read out of the product', () => {
  const over = v => shapeOf(HEALTHY_INDEX, [{ no: 'r1', at: 'g1', via: v.via, km: v.km }]);
  assert.match(over({ via: 'basin', km: 101 }), /r1 is 101 km away via "basin", over that via's bound of 100 km/);
  assert.match(over({ via: 'orphan', km: 11 }), /r1 is 11 km away via "orphan", over that via's bound of 10 km/);
  assert.match(over({ via: 'local', km: 16 }), /r1 is 16 km away via "local", over that via's bound of 15 km/);
  // …and each of those is green one step inside its own bound
  for (const ok of [{ via: 'basin', km: 100 }, { via: 'orphan', km: 10 }, { via: 'local', km: 15 }]) {
    assert.doesNotMatch(over(ok), /over that via's bound/, `${ok.via} at ${ok.km} km is legal`);
  }
});

test('N8c2: the bounds come from the PRODUCT, so a rule that widens its ring is not red for it', () => {
  const wide = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, localKm: 25 } };
  const member = [{ no: 'r1', at: 'g1', via: 'local', km: 22 }];
  assert.match(shapeOf(HEALTHY_INDEX, member), /over that via's bound of 15 km/, '22 km is out under a 15 km rule');
  assert.doesNotMatch(shapeOf(wide, member), /over that via's bound/, 'and in under a 25 km one — one copy of the number, not two');
});

test('N8c2: a via the rule does not enable, and a via that is no way in at all', () => {
  const v1 = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, localKm: null } };
  assert.match(shapeOf(v1, [{ no: 'r1', at: 'g1', via: 'local', km: 4 }]),
    /r1 arrived via "local", which this rule version does not enable/);
  assert.match(shapeOf(HEALTHY_INDEX, [{ no: 'r1', at: 'g1', via: 'sympathy', km: 4 }]),
    /r1 has via "sympathy", which is not a way into a set/);
  assert.match(shapeOf(HEALTHY_INDEX, [{ no: 'r1', at: 'g1', via: 'basin' }]),
    /r1 carries no distance — a guess must not look like a measurement/);
});

test('N8c2: the knn floor has a distance bound too, and it is the PRODUCT’s', () => {
  // The bound with no test was the one finding of the 2026-09-08 review that
  // could actually ship broken: no fixture ever put a knn member past 45 km, so
  // neutralising the clause left the whole suite green.
  const three = km => [
    { no: 'r1', at: 'g1', via: 'knn', km }, { no: 'r2', at: 'g1', via: 'knn', km: 20 },
    { no: 'r3', at: 'g1', via: 'knn', km: 21 },
  ];
  assert.doesNotMatch(shapeOf(HEALTHY_INDEX, three(45)), /over that via's bound/, '45 km is the bound and is inside it');
  assert.match(shapeOf(HEALTHY_INDEX, three(45.01)),
    /r1 is 45\.01 km away via "knn", over that via's bound of 45 km/);
  // a rule that widens its own floor is not red for it — one copy of the number
  const wide = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, knnMaxKm: 60 } };
  assert.doesNotMatch(shapeOf(wide, three(50)), /over that via's bound/);
  // and a rule that enables the floor without publishing its bound is red, not
  // silently fixed up from the estimator's own constant
  const noBound = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, knnMaxKm: undefined } };
  assert.match(shapeOf(noBound, three(20)), /enables a knn floor but publishes no knnMaxKm/);
});

test('N8: an index that stops publishing ruleVersion is red — it would switch clause (j) off', () => {
  // Nothing else can see this: with the field gone both sides read version 1,
  // `changed` is false for ever, and a rule change is compared against a HEAD
  // that the rule change just invalidated.
  const gone = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, ruleVersion: undefined } };
  assert.match(shapeOf(gone, [{ no: 'r1', at: 'g1', via: 'basin', km: 4 }]), /carries no ruleVersion/);
  const text = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, ruleVersion: '2' } };
  assert.match(shapeOf(text, [{ no: 'r1', at: 'g1', via: 'basin', km: 4 }]), /carries no ruleVersion.*"2"/s);
});

test('N8c3: a basin member with no owning node is red, not silently equal to every other one', () => {
  // String(undefined) === String(undefined): before this clause, two gauges
  // both claiming r1 with no `at` compared EQUAL and the partition test
  // returned nothing at all.
  const two = new Map([
    ['g1', { meta: { set: [{ no: 'r1', via: 'basin', km: 4 }] }, shards: new Map() }],
    ['g2', { meta: { set: [{ no: 'r1', via: 'basin', km: 5 }] }, shards: new Map() }],
  ]);
  const v = checkPrecipShape(HEALTHY_INDEX, two, RAIN_IDS3, { g1: {}, g2: {} }).join('\n');
  assert.match(v, /rain station r1 arrived via "basin" but names no owning node/);
});

test('N8j: a counter that disappears from index.json is red, not skipped', () => {
  const v1 = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, ruleVersion: 1 } };
  const gone = { ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, withSeries: undefined } };
  assert.match(checkPrecipDrift(gone, v1).join('\n'),
    /rule version 2: index\.json has no numeric `withSeries` to compare against the pre-registered 275/);
});

test('N8j: HEAD and the run are read the same way — a HEAD with no rule block is version 1', () => {
  // The first cut defaulted HEAD's version to the CURRENT one when HEAD carried
  // no `rule` block, which made them equal and switched clause (j) off entirely.
  const headNoRule = { schema: 1, counts: { ...HEALTHY_INDEX.counts, withSeries: 94 }, gauges: {} };
  assert.match(checkPrecipDrift({ ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, withSeries: 200 } }, headNoRule).join('\n'),
    /rule version 2: withSeries is 200, pre-registered 275/);
  // …and with no HEAD at all there is no rule change to check and no drift to
  // measure: a fresh branch or a fork is not measured against this mirror's counts
  assert.deepEqual(checkPrecipDrift({ ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, withSeries: 3 } }, null), []);
});

test('N8c2: a local or knn member that names someone else as its node', () => {
  assert.match(shapeOf(HEALTHY_INDEX, [{ no: 'r1', at: 'g9', via: 'local', km: 4 }]),
    /r1 arrived via "local" but names g9 as its node, not this gauge/);
  // …while a basin member naming an upstream node is exactly right
  assert.doesNotMatch(shapeOf(HEALTHY_INDEX, [{ no: 'r1', at: 'g9', via: 'basin', km: 4 }]), /names g9 as its node/);
});

test('N8c2: the knn floor may only fire where nothing else reached, and only up to the floor', () => {
  // a knn member in a set that already had three of its own
  const tooMany = [
    { no: 'r1', at: 'g1', via: 'local', km: 4 }, { no: 'r2', at: 'g1', via: 'local', km: 5 },
    { no: 'r3', at: 'g1', via: 'local', km: 6 }, { no: 'r1', at: 'g1', via: 'knn', km: 20 },
  ];
  assert.match(shapeOf(HEALTHY_INDEX, tooMany), /the knn floor fired on a set that already had 3 members/);
  // a floor that filled past its own size
  const four = [
    { no: 'r1', at: 'g1', via: 'knn', km: 20 }, { no: 'r2', at: 'g1', via: 'knn', km: 21 },
    { no: 'r3', at: 'g1', via: 'knn', km: 22 }, { no: 'ghost', at: 'g1', via: 'knn', km: 23 },
  ];
  assert.match(shapeOf(HEALTHY_INDEX, four), /the knn floor filled the set to 4, not to 3/);
  // and the legitimate case is green
  const three = [
    { no: 'r1', at: 'g1', via: 'knn', km: 20 }, { no: 'r2', at: 'g1', via: 'knn', km: 21 },
    { no: 'r3', at: 'g1', via: 'knn', km: 22 },
  ];
  assert.doesNotMatch(shapeOf(HEALTHY_INDEX, three), /knn floor/);
});

test('N8c3: the HYDROLOGICAL origin is still a partition, and geometry is deliberately not', () => {
  const two = new Map([
    ['g1', { meta: { set: [{ no: 'r1', at: 'g1', via: 'basin', km: 4 }] }, shards: new Map() }],
    ['g2', { meta: { set: [{ no: 'r1', at: 'g2', via: 'basin', km: 5 }] }, shards: new Map() }],
  ]);
  assert.match(checkPrecipShape(HEALTHY_INDEX, two, RAIN_IDS3, { g1: {}, g2: {} }).join('\n'),
    /rain station r1 is owned by both g1 and g2/);
  // the same station as a LOCAL member of two gauges is the whole point of
  // version 2 — many-to-many membership — and must not be flagged
  const shared = new Map([
    ['g1', { meta: { set: [{ no: 'r1', at: 'g1', via: 'local', km: 4 }] }, shards: new Map() }],
    ['g2', { meta: { set: [{ no: 'r1', at: 'g2', via: 'local', km: 5 }] }, shards: new Map() }],
  ]);
  assert.deepEqual(checkPrecipShape(HEALTHY_INDEX, shared, RAIN_IDS3, { g1: {}, g2: {} }), []);
});

test('N8j: a rule change may not ride in on its own drift allowance', () => {
  const v1 = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, ruleVersion: 1 } };
  const at = (ver, counts = {}) => ({
    ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, ruleVersion: ver },
    counts: { ...HEALTHY_INDEX.counts, ...counts },
  });
  // a bump with no pre-registered entry
  assert.match(checkPrecipDrift(at(7), v1).join('\n'),
    /rule version 1 -> 7 with no pre-registered counts/);
  // a bump whose numbers disagree with what was registered for it
  assert.match(checkPrecipDrift(at(2, { withSeries: 200 }), v1).join('\n'),
    /rule version 2: withSeries is 200, pre-registered 275 \(slack 2\)/);
  // the real thing: version 2's own numbers against a version 1 HEAD
  assert.deepEqual(checkPrecipDrift(at(2), v1), []);
  // and the version change suppresses the HEAD drift comparison, which would
  // otherwise read every intended move as a regression
  assert.deepEqual(checkPrecipDrift(at(2), { ...v1, counts: { ...v1.counts, cyclicNodes: 9 } }), [],
    'a HEAD from before the rule change is not a baseline');
});

test('N8g: the list of rain stations in no set at all may not grow', () => {
  const noSet = n => ({ ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, stationsInNoSet: n, stationsInNoSetIds: ['a', 'b'] } });
  assert.deepEqual(checkPrecipDrift(noSet(7), HEALTHY_INDEX), [], 'two more is the same slack every counter gets');
  assert.match(checkPrecipDrift(noSet(8), HEALTHY_INDEX).join('\n'),
    /rain stations in no set at all 5 -> 8, drift over 2 \(a, b\)/);
  // across a rule change the comparison is against the pre-registered number,
  // not against a HEAD that predates the rule
  const v1 = { ...HEALTHY_INDEX, rule: { ...HEALTHY_RULE, ruleVersion: 1 } };
  const bumped = { ...noSet(9), rule: HEALTHY_RULE };
  assert.match(checkPrecipDrift(bumped, v1).join('\n'), /rain stations in no set at all 5 -> 9/);
});

test('N8d: a set naming a rain station with no directory, and a gauge not in the topology', () => {
  const v = checkPrecipShape(HEALTHY_INDEX, precipProduct({ meta: { set: [{ no: 'ghost', at: 'g1' }] } }), RAIN_IDS, TOPO_GAUGES);
  assert.match(v.join('\n'), /set names rain station ghost, which has no nrw\/rain\/ directory/);
  const w = checkPrecipShape(HEALTHY_INDEX, precipProduct(), RAIN_IDS, {});
  assert.match(w.join('\n'), /precip\/g1: not a gauge in topology\.json/);
});

test('N8i: the floors are exact counts, and an empty product cannot pass them', () => {
  const thin = { ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, withSeries: MIN_PRECIP_SERIES - 1, receivingNodes: MIN_RECEIVING_NODES - 1 } };
  const v = checkPrecipShape(thin, precipProduct(), RAIN_IDS, TOPO_GAUGES);
  assert.match(v.join('\n'), new RegExp(`only ${MIN_PRECIP_SERIES - 1} gauges carry a series, floor is ${MIN_PRECIP_SERIES}`));
  assert.match(v.join('\n'), new RegExp(`only ${MIN_RECEIVING_NODES - 1} receiving nodes, floor is ${MIN_RECEIVING_NODES}`));
  const empty = { ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, withSeries: 0, receivingNodes: 0 } };
  assert.equal(checkPrecipShape(empty, new Map(), RAIN_IDS, TOPO_GAUGES).length, 2);
});

test('N8: a missing or wrong-schema index is one violation, not a silent pass', () => {
  assert.deepEqual(checkPrecipShape(null, new Map(), RAIN_IDS, TOPO_GAUGES), ['N8: precip/index.json missing, unparseable or not schema 1']);
  assert.deepEqual(checkPrecipShape({ schema: 2, counts: {}, gauges: {} }, new Map(), RAIN_IDS, TOPO_GAUGES).length, 1);
});

test('N8f/g: bad coordinates and unassignable rain gauges may drift by two, not three', () => {
  const drift = d => ({ ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, badCoordNodes: 1 + d } });
  assert.deepEqual(checkPrecipDrift(drift(2), HEALTHY_INDEX), []);
  assert.match(checkPrecipDrift(drift(3), HEALTHY_INDEX).join('\n'), /badCoordNodes 1 -> 4, drift over 2/);
  const un = d => ({ ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, rainUnassigned: 5 + d } });
  assert.deepEqual(checkPrecipDrift(un(2), HEALTHY_INDEX), []);
  assert.match(checkPrecipDrift(un(3), HEALTHY_INDEX).join('\n'), /rainUnassigned 5 -> 8, drift over 2/);
});

test('N8f: the total count of unusable coordinates has a hard ceiling, HEAD or no HEAD', () => {
  const many = { ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, badCoordNodes: 5 }, unassigned: Array.from({ length: 5 }, (_, i) => ({ no: `x${i}`, why: 'coords' })) };
  assert.match(checkPrecipDrift(many, null).join('\n'), /10 stations have unusable coordinates, ceiling is 8/);
});

test('N8h: the cycle set must equal HEAD exactly — a changed one is read, not mirrored', () => {
  const three = { ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, cyclicNodes: 3 } };
  const v = checkPrecipDrift(three, HEALTHY_INDEX);
  assert.match(v.join('\n'), /cyclicNodes 2 -> 3/);
  assert.match(v.join('\n'), /3 cyclic nodes, the known set is 2/);
  // a cycle that DISAPPEARS is also a change worth reading
  const one = { ...HEALTHY_INDEX, counts: { ...HEALTHY_INDEX.counts, cyclicNodes: 0 } };
  assert.match(checkPrecipDrift(one, HEALTHY_INDEX).join('\n'), /cyclicNodes 2 -> 0/);
});

test('N8: the stock of implausible raw rain days is watched, not forbidden', () => {
  const shard = mm => new Map([['r1', { shards: new Map([[2025, { mm }]]) }]]);
  // the mirror's own 595.9 mm day must not make the gate red
  assert.deepEqual(checkImplausibleRainStock(shard([595.9, 1, 2])), []);
  const many = [595.9, 500, 450, 420];
  assert.match(checkImplausibleRainStock(shard(many)).join('\n'), /4 rain days over 400 mm, ceiling is 3/);
});

test('N5: the raw rain ceiling is 1000 mm — the 595.9 mm day in the mirror stays green', () => {
  const n = daysInYear(2026);
  const mk = v => { const mm = Array(n).fill(0); mm[0] = v; return { id: 'r', y: 2026, mm, imax: Array(n).fill(0), cov: {} }; };
  assert.deepEqual(checkShardShape('rain', mk(595.9), 'p', { id: 'r', y: 2026 }), []);
  assert.match(checkShardShape('rain', mk(MAX_MM_DAY_RAW + 1), 'p', { id: 'r', y: 2026 }).join('\n'), /mm outside 0\.\.1000/);
  assert.match(checkShardShape('rain', mk(-1), 'p', { id: 'r', y: 2026 }).join('\n'), /mm outside 0\.\.1000/);
});

test('N4: precip/ may shrink — it is derived, and N8 floors are what stop it vanishing', () => {
  const changes = [{ status: 'D', path: 'nrw/precip/g1/2025.json' }, { status: 'D', path: 'nrw/gauges/g1/2025.json' }];
  const v = checkRegressionStatuses(changes);
  assert.equal(v.length, 1, 'the mirrored gauge deletion is still red');
  assert.match(v[0], /nrw\/gauges\/g1\/2025\.json/);
});

// The CLI half of N8. Without these, the whole `if (on('N8')) { … }` block can be
// deleted and every other test stays green — measured, not assumed: mutating it
// to `if (false && on('N8'))` left 68 of 68 tests passing while the same mutation
// on N6 turned one red. A rule nothing dispatches is a rule that is not there.

test('CLI: N8 runs — a hand-edited precip shard is red through the real dispatcher', () => {
  const repo = cloneSeed();
  const p = join(repo, 'nrw', 'precip', 'g0', '2026.json');
  const doc = JSON.parse(execFileSync('cat', [p], { encoding: 'utf8' }));
  const i = doc.mm.findIndex(v => v !== null);
  doc.mm[i] = null;                       // mm null while n stays > 0
  writeFileSync(p, JSON.stringify(doc));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::N8: precip\/g0\/2026\.json: mm null <=> n 0 violated/);
  // and clause (e) sees the same edit from the other side
  assert.match(stdout, /::error::N8: precip is not what the rule produces — differs: g0\/2026\.json/);
});

test('CLI: N8(e) alone catches a stale product the shape rules would pass', () => {
  const repo = cloneSeed();
  const p = join(repo, 'nrw', 'precip', 'g0', '2026.json');
  const doc = JSON.parse(execFileSync('cat', [p], { encoding: 'utf8' }));
  const i = doc.mm.findIndex(v => v !== null);
  // a perfectly well-formed day that is simply not the one the rule computes:
  // mm, med and mx moved together, n untouched — every invariant still holds
  doc.mm[i] = doc.mm[i] + 1; doc.med[i] = doc.mm[i]; doc.mx[i] = doc.mm[i] + 1;
  writeFileSync(p, JSON.stringify(doc));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::N8: precip is not what the rule produces — differs: g0\/2026\.json/);
  assert.doesNotMatch(stdout, /mm null <=>/, 'the shape rules are green — only (e) can see this');
});

// The c4 dispatch, which nothing else reaches: the clause's own unit tests call
// checkPrecipUsedBy directly, so deleting its line in main() left the suite
// green — measured. This runs the real binary over a real tree.
test('CLI: N8c4 runs — a reverse index that contradicts the sets is red through the dispatcher', () => {
  const repo = cloneSeed();
  const dir = join(repo, 'nrw', 'precip', 'used-by');
  const f = readdirSync(dir)[0];
  const p = join(dir, f);
  const rows = JSON.parse(readFileSync(p, 'utf8'));
  rows.push({ no: 'ghost', name: 'Ghost', via: 'local', km: 1, at: 'ghost' });
  writeFileSync(p, JSON.stringify(rows));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, new RegExp(`::error::N8: precip/used-by/${f.replace('.json', '')}\\.json: names gauge ghost, `
    + 'whose own meta\\.json does not hold'));
});

test('CLI: a precip tree that was never built is red, not silently skipped', () => {
  const repo = cloneSeed();
  rmSync(join(repo, 'nrw', 'precip'), { recursive: true });
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, /::error::N8: precip\/ missing — run scripts\/build-nrw-precip\.mjs before the gate/);
});

test('CLI: --skip N8 silences it, and the rest of the gate still runs', () => {
  const repo = cloneSeed();
  rmSync(join(repo, 'nrw', 'precip'), { recursive: true });
  const { code, stdout } = runChecker(repo, ['--skip', 'N8']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /nrw consistency ok/);
});

test('CLI: a stale hourly lag is red even though nothing else in the tree moved', () => {
  // THE CLAUSE THIS PRODUCT MOST NEEDS: a CI run that mirrors `nrw` but never
  // rebuilds the lag leaves yesterday's window standing, and every other rule
  // here — shape, references, counts, drift — is perfectly happy with it.
  const repo = cloneSeed();
  const stale = new Date(Date.parse(NOW) - 72 * 36e5);
  writeFileSync(join(repo, 'nrw', 'hourly', 'lag.json'),
    JSON.stringify(hourlyLagFor(join(repo, 'nrw'), { to: stale }), null, 1) + '\n');
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /::error::N9: the hourly window ends 72\.0 h before now .* the lag was not rebuilt on this run/);
});

test('CLI: deleting the hourly lag is red TWICE — N9 misses it, and N4 refuses the deletion', () => {
  // `hourly/` is deliberately NOT in N4's precip exception. The daily rain field
  // may shrink (a gauge that loses its rain gauges loses its files); this
  // product is one file that always exists, so a deletion is a regression and
  // gets a second, independent guard.
  const repo = cloneSeed();
  rmSync(join(repo, 'nrw', 'hourly'), { recursive: true });
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /::error::N9: hourly\/lag\.json missing — run scripts\/build-nrw-hourly-lag\.mjs/);
  assert.match(stdout, /::error::N4: .*hourly\/lag\.json/, 'N4 must see the deletion too');
});

test('CLI: --skip N9 silences it, and the rest of the gate still runs', () => {
  const repo = cloneSeed();
  rmSync(join(repo, 'nrw', 'hourly'), { recursive: true });
  const { code, stdout } = runChecker(repo, ['--skip', 'N9', '--allow-prune']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /nrw consistency ok/);
  assert.doesNotMatch(stdout, /N9 partial/, 'a rule that was skipped outright is not a partial run');
});

test('CLI: a nonexistent --hires is red, not a quiet skip', () => {
  const repo = cloneSeed();
  const { code, stdout } = runChecker(repo, ['--hires', join(repo, 'no-such-tree')]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /::error::N9: --hires .* does not exist/);
  assert.doesNotMatch(stdout, /SKIPPED/, 'a wrong path must not read as "no path given"');
});

// The CLI half of N9(g) and N9(h). Their CONTENT is proven against the real
// mirror (see this file's N9 header) — but that proves nothing about their
// DISPATCH, and a clause nothing dispatches is a clause that is not there. The
// same hole was measured on N8 once and closed with the pair of tests above.
// Measured here before this test existed: deleting the (g) digest block, or the
// (h) recompute block, or both, left all 105 tests in this file green.
//
// A minimal hires tree is enough, and deliberately so: the fixture's lag.json is
// SYNTHETIC (hourlyLagFor, not the builder), so the digest cannot match and the
// rebuild cannot agree — which is precisely what makes both clauses speak.
test('CLI: N9(g) and N9(h) are dispatched — a --hires tree the product was not built over is red', () => {
  const repo = cloneSeed();
  const hires = join(repo, 'nrw-hires');
  // Shards for the fixture's OWN stations, and enough of them that the builder
  // RUNS instead of throwing. That distinction is the test: with a tree the
  // builder cannot read, the catch block below reports "could not recompute"
  // and a dead diffs loop passes unnoticed — measured, which is why the last
  // assertion here forbids that wording. The window must also clear the
  // rotation guard band (2*168 + 99 + 1 h), or publish() refuses outright.
  const month = '2026-08', start = '2026-08-01T00:00:00+01:00', N = 24 * 30;
  const shard = (id, v) => JSON.stringify({ id, month, step: 3600, start, v });
  for (const id of readdirSync(join(repo, 'nrw', 'rain')).slice(0, 20)) {
    mkdirSync(join(hires, 'rain', id), { recursive: true });
    writeFileSync(join(hires, 'rain', id, `${month}.json`),
      shard(id, Array.from({ length: N }, (_, i) => (i % 7 === 0 ? 0.5 : 0))));
  }
  const precip = readManifest(repo).precip || {};
  for (const no of Object.keys(precip).filter(k => precip[k].series === true).slice(0, 5)) {
    mkdirSync(join(hires, 'gauges', no), { recursive: true });
    writeFileSync(join(hires, 'gauges', no, `${month}.json`),
      shard(no, Array.from({ length: N }, (_, i) => 100 + (i % 13))));
  }
  const { code, stdout } = runChecker(repo, ['--hires', hires]);
  assert.equal(code, 1, stdout);
  // (g): the digest of the bytes actually read cannot match a synthetic file
  assert.match(stdout, /::error::N9: hourly\/lag\.json was built over different hires bytes than the tree holds/);
  // (h): the rebuild must REPORT ITS DIFFS, not merely fail to start
  assert.match(stdout, /::error::N9: hourly lag is not what the rule produces/);
  assert.doesNotMatch(stdout, /could not recompute the hourly lag/,
    'the builder has to actually run here, or (h) is pinned by its catch block instead of by its diffs');
  // and with a tree given, neither clause may report itself as skipped
  assert.doesNotMatch(stdout, /N9 partial/);
  assert.doesNotMatch(stdout, /N9\(g\) input digest and N9\(h\) recomputation SKIPPED/);
});

test('CLI: N8 counters are red when the product shrinks below its floor', () => {
  const repo = cloneSeed();
  const p = join(repo, 'nrw', 'precip', 'index.json');
  const ix = JSON.parse(execFileSync('cat', [p], { encoding: 'utf8' }));
  ix.counts.withSeries = 3;
  writeFileSync(p, JSON.stringify(ix));
  const { code, stdout } = runChecker(repo);
  assert.equal(code, 1);
  assert.match(stdout, new RegExp(`::error::N8: precip: only 3 gauges carry a series, floor is ${MIN_PRECIP_SERIES}`));
});

const { buildManifest } = await import('../scripts/fetch-nrw-archive.mjs');

test('the collector places every station inside the box, and no station outside it', () => {
  // P2-1: la/lo/dc had no test at all — the manifest in the mirror predates them,
  // so a broken entryFor would have shipped invisibly.
  const repo = cloneSeed();
  const m = readManifest(repo);
  const placed = Object.values(m.gauges).filter(e => e.la != null);
  assert.equal(placed.length, 0, 'the fixture manifest is written by the test, not by buildManifest');
  const topo = JSON.parse(execFileSync('cat', [join(repo, 'nrw', 'topology.json')], { encoding: 'utf8' }));
  const built = buildManifest({
    out: join(repo, 'nrw'), registry: new Map(Array.from({ length: 617 }, (_, i) => ['s' + i, {}])),
    topo, basinOf: () => '272', coverage: coverage(), exportAt: NOW, window: WINDOW, generated: NOW, tier2: null,
  });
  const g0 = built.gauges.g0;
  assert.deepEqual([g0.la, g0.lo], [gaugeCoords(0).lat, 7], 'a gauge inside the box carries its coordinates');
  const r0 = built.rain.r0;
  assert.ok(r0.la != null && r0.lo != null, 'and so does a rain gauge');
  // …and one outside it does not: Ruenderoth's Gauss-Krueger pair must not place a gauge
  writeFileSync(join(repo, 'nrw', 'gauges', 'g1', 'meta.json'),
    JSON.stringify({ id: 'g1', name: 'g1', lat: 5650772.5, lon: 32392464, catchmentNo: '272', distToConflKm: 12.5 }));
  const again = buildManifest({
    out: join(repo, 'nrw'), registry: new Map(), topo, basinOf: () => '272',
    coverage: coverage(), exportAt: NOW, window: WINDOW, generated: NOW, tier2: null,
  });
  assert.equal(again.gauges.g1.la, undefined, 'a Gauss-Krueger pair places nothing');
  assert.equal(again.gauges.g1.dc, 12.5, 'but the distance to the mouth still rides along');
  assert.equal(again.gauges.g1.km, undefined, 'and never as `km`, which the app reads as river km from the source');
});

// ---------- N9: the hourly response class ----------
// One file, nrw/hourly/lag.json, and every clause below is shown red on exactly
// the defect it exists for. (a)-(f) need only the `nrw` tree; (g) and (h) need
// the hires tree and are exercised against the real mirror, not here.

const {
  checkHourlyShape, checkHourlyDrift,
  MIN_HOURLY_PUBLISHED, MIN_HOURLY_WINDOW_HOURS, MAX_HOURLY_WINDOW_HOURS, MAX_HOURLY_WINDOW_LAG_H,
  MAX_HOURLY_CLASS_DRIFT, MAX_HOURLY_PUBLISHED_DROP, MAX_HOURLY_CLASS_SHARE,
} = await import('../scripts/check-nrw-consistency.mjs');

// 120 gauges — over the published floor, and split 60/40/20 so no class is
// anywhere near the 90 % collapse ceiling.
const LAG_IDS = Array.from({ length: 120 }, (_, i) => `h${i}`);
const lagGauges = () => Object.fromEntries(LAG_IDS.map((no, i) => [no, i < 60 ? 0 : i < 100 ? 1 : 2]));
const LAG_TOPO = Object.fromEntries(LAG_IDS.map(no => [no, {}]));
const LAG_PRECIP = Object.fromEntries(LAG_IDS.map(no => [no, { series: true }]));

// The window ends 9 h before the pinned clock and spans the builder's own 63
// days, inside both the floor and the ceiling; derived rather than typed, so the
// span and the two stamps can never disagree by a typo.
const LAG_HOURS = 63 * 24;
const LAG_TO = new Date(nowDate.getTime() - 9 * 36e5);
const hourIso = d => d.toISOString().slice(0, 13) + ':00Z';
const LAG_WINDOW = { from: hourIso(new Date(LAG_TO.getTime() - (LAG_HOURS - 1) * 36e5)), to: hourIso(LAG_TO), hours: LAG_HOURS };

const healthyLag = (over = {}) => ({
  schema: 1, generated: '2026-09-04', ruleVersion: 2, lagRuleVersion: 1,
  rule: { classes: [[0, 1], [2, 8], [9, null]], minR: 0.25, rotations: 99, fdrQ: 0.05 },
  window: { ...LAG_WINDOW },
  inputs: { sha256: 'f'.repeat(64), files: 1674 },
  // The counts BALANCE: 251 = 24 + 0 + 227, 227 = 29 + 198, 198 = 54 + 6 + 0 +
  // 138 … which is not 120, so the fixture uses its own consistent set rather
  // than the mirror's. A fixture that could not satisfy the accounting identity
  // would make every test below pass or fail for the wrong reason.
  counts: {
    daily: 200, notInHires: 24, noDailySet: 0, attempted: 176, withPeak: 160,
    noPeak: 16, weak: 34, notSignificant: 6, unclassed: 0, published: 120,
    noPeakWhy: { wetHours: 16, pairs: 0, noPositiveLag: 0, noPair: 0 },
    byClass: [60, 40, 20],
  },
  gauges: lagGauges(),
  ...over,
});
const shapeLag = (over = {}, opts = {}) => checkHourlyShape(healthyLag(over), {
  topologyGauges: LAG_TOPO, precip: LAG_PRECIP, nowDate, ...opts,
}).join('\n');

test('N9: the healthy product is green, and the fixture really is at the floor it claims', () => {
  assert.deepEqual(checkHourlyShape(healthyLag(), { topologyGauges: LAG_TOPO, precip: LAG_PRECIP, nowDate }), []);
  assert.deepEqual(checkHourlyDrift(healthyLag(), healthyLag()), []);
  // a fixture that sat under the floor would make every test below pass for the
  // wrong reason
  assert.ok(120 >= MIN_HOURLY_PUBLISHED, 'the fixture must clear the published floor');
  assert.ok(60 <= MAX_HOURLY_CLASS_SHARE * 120, 'and sit under the class-share ceiling');
});

test('N9a: a missing, unparseable or unversioned file', () => {
  assert.match(checkHourlyShape(null).join('\n'), /missing, unparseable or not schema 1/);
  assert.match(checkHourlyShape({ schema: 2 }).join('\n'), /not schema 1/);
  assert.match(shapeLag({ gauges: undefined }), /carries no `gauges` block/);
  assert.match(shapeLag({ window: undefined }), /carries no `window` block/);
  // THE TRAP N8 WALKED INTO: a builder that stops writing the version makes the
  // rule-change clause read the same value on both sides forever after
  assert.match(shapeLag({ lagRuleVersion: undefined }), /carries no numeric `lagRuleVersion`/);
  assert.match(shapeLag({ ruleVersion: undefined }), /carries no numeric `ruleVersion`/);
});

test('N9b: a window that was not rebuilt, one from the future, and one too short', () => {
  const old = hourIso(new Date(nowDate.getTime() - (MAX_HOURLY_WINDOW_LAG_H + 2) * 36e5));
  assert.match(shapeLag({ window: { ...LAG_WINDOW, to: old } }), /the lag was not rebuilt on this run/);
  // and the run one hour inside the ceiling is NOT red, or the clause is just a
  // slow-moving trip-wire
  const fresh = hourIso(new Date(nowDate.getTime() - (MAX_HOURLY_WINDOW_LAG_H - 1) * 36e5));
  assert.doesNotMatch(shapeLag({ window: { ...LAG_WINDOW, to: fresh } }), /was not rebuilt/);
  const future = hourIso(new Date(nowDate.getTime() + 5 * 36e5));
  assert.match(shapeLag({ window: { ...LAG_WINDOW, to: future } }), /ends 5\.0 h in the FUTURE/);
  const short = { from: LAG_WINDOW.from, to: LAG_WINDOW.to, hours: MIN_HOURLY_WINDOW_HOURS - 1 };
  assert.match(shapeLag({ window: short }), /the hourly window is 959 h, floor is 960/);
  // `hours` may not be a number the file merely asserts about itself
  assert.match(shapeLag({ window: { ...LAG_WINDOW, hours: 1200 } }), new RegExp(`says 1200 hours but spans ${LAG_HOURS}`));
  assert.match(shapeLag({ window: { from: 'never', to: 'never', hours: 1597 } }), /not a readable pair of timestamps/);
});

test('N9c: an hour where a class id belongs, and the two reference checks', () => {
  // the whole reason the file ships a class and not an hour — a 7 here would
  // print as a fourth, non-existent class on the plate
  assert.match(shapeLag({ gauges: { ...lagGauges(), h0: 7 } }), /h0 carries 7, which is not a class id/);
  assert.match(shapeLag({ gauges: { ...lagGauges(), h0: null } }), /h0 carries null/);
  assert.match(shapeLag({ gauges: { ...lagGauges(), h0: 'fast' } }), /h0 carries "fast"/);
  assert.match(shapeLag({ gauges: { ...lagGauges(), h0: 1.5 } }), /h0 carries 1\.5/);
  assert.match(shapeLag({ gauges: { ...lagGauges(), ghost: 0 } }), /ghost is not a gauge in topology\.json/);
  // a class for a gauge with no rain field would be a response to rain the
  // reader cannot see anywhere on the plate
  assert.match(shapeLag({}, { precip: { ...LAG_PRECIP, h0: { series: false } } }), /h0 has an hourly class but no daily rain field/);
  assert.match(shapeLag({ counts: { ...healthyLag().counts, byClass: [60, 40, 21] } }),
    /counts\.byClass is \[60,40,21\], a recount of `gauges` gives \[60,40,20\]/);
  assert.match(shapeLag({ rule: { classes: 'three' } }), /rule\.classes is not a list of \[lo, hi\] pairs/);
});

test('N9c: the RULE itself, not only its shape — reordered classes make the plate lie', () => {
  // The plate binds its three words to the class INDEX positionally, so a
  // `classes` list that is reordered, gapped or overlapping makes it print a
  // real class id under the wrong words ("within the hour (9+ h)") with every
  // other clause green.
  const rule = classes => ({ rule: { ...healthyLag().rule, classes } });
  assert.match(shapeLag(rule([[9, null], [2, 8], [0, 1]])), /must be ascending, adjacent and non-overlapping/);
  assert.match(shapeLag(rule([[0, 1], [0, 1], [2, null]])), /must be ascending, adjacent and non-overlapping/);
  assert.match(shapeLag(rule([[0, 1], [4, 8], [9, null]])), /ends at 1 and \[1\] starts at 4/, 'a gap swallows lags 2 and 3');
  assert.match(shapeLag(rule([[2, 8], [9, null]])), /starts at 2 h, so a lag of 0 falls through it/);
  assert.match(shapeLag(rule([[0, 1], [2, 8], [9, 48]])), /the last of rule.classes is bounded/);
  assert.match(shapeLag(rule([[0, 1], [2, 8], [9, 8]])), /rule.classes\[2\] is empty/);
  // and the filters have to be able to filter
  const R = over => ({ rule: { ...healthyLag().rule, ...over } });
  assert.match(shapeLag(R({ rotations: 0 })), /a permutation filter that ran no rotations calls everything significant/);
  assert.match(shapeLag(R({ minR: 0 })), /rule.minR is 0, which is not a correlation cut/);
  assert.match(shapeLag(R({ fdrQ: 1 })), /rule.fdrQ is 1, which is not a false-discovery rate/);
});

test('N9: the run\'s own provenance is checked, because (g) does not run without --hires', () => {
  assert.match(shapeLag({ inputs: { sha256: 'nope', files: 10 } }), /inputs.sha256 is not a sha256 digest/);
  assert.match(shapeLag({ inputs: undefined }), /inputs.sha256 is not a sha256 digest/);
  assert.match(shapeLag({ inputs: { sha256: 'f'.repeat(64), files: 0 } }), /a digest over no files is not a digest/);
  assert.match(shapeLag({ generated: 'banana' }), /generated is "banana", not a date/);
});

test('N9d: the counts BALANCE — a drop-out counter cannot be invented', () => {
  // Nesting alone leaves every drop-out counter free, and the plate prints four
  // of them to the reader as the fleet split. Measured against the real file
  // before this clause existed: weak = 99999 was green.
  const c = healthyLag().counts;
  const sum = (...ks) => ks.reduce((a, k) => a + c[k], 0);
  assert.match(shapeLag({ counts: { ...c, weak: 99999 } }),
    new RegExp(`weak \\+ notSignificant \\+ unclassed \\+ published = ${99999 + sum('notSignificant', 'unclassed', 'published')}, but withPeak is ${c.withPeak}`));
  assert.match(shapeLag({ counts: { ...c, notInHires: 0 } }),
    new RegExp(`notInHires \\+ noDailySet \\+ attempted = ${sum('noDailySet', 'attempted')}, but daily is ${c.daily}`));
  assert.match(shapeLag({ counts: { ...c, noPeak: 0 } }),
    new RegExp(`noPeak \\+ withPeak = ${c.withPeak}, but attempted is ${c.attempted}`));
  assert.match(shapeLag({ counts: { ...c, weak: -1, notSignificant: 41 } }), /counts.weak is not a count/);
  assert.match(shapeLag({ counts: { ...c, unclassed: undefined } }), /counts.unclassed is not a count/);
});

test('N9b: a window past the source\'s own length is red, which a floor cannot see', () => {
  // The mirror only grows and the source does not. A builder that stopped
  // bounding the window moves this number UP; the floor watches it going down.
  const long = { ...LAG_WINDOW, hours: MAX_HOURLY_WINDOW_HOURS + 1 };
  const v = shapeLag({ window: { from: hourIso(new Date(LAG_TO.getTime() - MAX_HOURLY_WINDOW_HOURS * 36e5)), to: LAG_WINDOW.to, hours: MAX_HOURLY_WINDOW_HOURS + 1 } });
  assert.match(v, /ceiling is 1560/);
  assert.match(v, /the mirror grows and the source does not/);
  assert.doesNotMatch(shapeLag({}), /ceiling is/, 'and the healthy window is well inside it');
  assert.ok(long.hours > MIN_HOURLY_WINDOW_HOURS, 'the case really is above the floor, so only the ceiling can catch it');
});

test('N9d: the floors, the nesting and the one-class collapse', () => {
  const few = Object.fromEntries(LAG_IDS.slice(0, MIN_HOURLY_PUBLISHED - 1).map((no, i) => [no, i < 50 ? 0 : 1]));
  const v = shapeLag({ gauges: few, counts: { ...healthyLag().counts, published: 99, byClass: [50, 49, 0] } });
  assert.match(v, new RegExp(`only 99 gauges carry a response class, floor is ${MIN_HOURLY_PUBLISHED}`));
  assert.match(shapeLag({ counts: { ...healthyLag().counts, published: 119 } }), /counts\.published is 119, `gauges` holds 120/);
  assert.match(shapeLag({ counts: { ...healthyLag().counts, withPeak: 100 } }), /the counts do not nest/);
  assert.match(shapeLag({ counts: { ...healthyLag().counts, attempted: 300 } }), /the counts do not nest/);
  // a three-class product where nine of ten readers see one class
  const collapsed = Object.fromEntries(LAG_IDS.map((no, i) => [no, i < 115 ? 0 : 1]));
  assert.match(shapeLag({ gauges: collapsed, counts: { ...healthyLag().counts, byClass: [115, 5, 0] } }),
    /one class holds 115 of 120 published gauges \(95\.8 %\)/);
});

test('N9e: drift against HEAD — reclassified, withdrawn, and the count falling', () => {
  const head = healthyLag();
  const moveN = n => healthyLag({
    gauges: Object.fromEntries(Object.entries(lagGauges()).map(([no, c], i) => [no, i < n ? (c + 1) % 3 : c])),
  });
  assert.deepEqual(checkHourlyDrift(moveN(MAX_HOURLY_CLASS_DRIFT), head), [], 'exactly at the ceiling is inside it');
  assert.match(checkHourlyDrift(moveN(MAX_HOURLY_CLASS_DRIFT + 1), head).join('\n'),
    new RegExp(`${MAX_HOURLY_CLASS_DRIFT + 1} gauges changed response class against HEAD`));
  // withdrawn gauges are counted twice over, as a class change and as a loss —
  // a product that quietly stops publishing is the failure this catches
  const dropN = n => healthyLag({ gauges: Object.fromEntries(Object.entries(lagGauges()).slice(n)) });
  assert.deepEqual(checkHourlyDrift(dropN(MAX_HOURLY_PUBLISHED_DROP), head), []);
  const bad = checkHourlyDrift(dropN(MAX_HOURLY_PUBLISHED_DROP + 1), head).join('\n');
  assert.match(bad, new RegExp(`${MAX_HOURLY_PUBLISHED_DROP + 1} gauges lost their response class`));
  assert.match(bad, /a fall of 21 over the ceiling/);
  // and with no HEAD at all — a fresh branch — there is nothing to drift from
  assert.deepEqual(checkHourlyDrift(dropN(60), null), []);
});

test('N9f: a rule change may not ride in on its own drift allowance', () => {
  const head = healthyLag();
  const bumped = healthyLag({ lagRuleVersion: 2, gauges: {}, counts: { ...head.counts, published: 0 } });
  assert.match(checkHourlyDrift(bumped, head, { baselines: {} }).join('\n'),
    /lag rule 1\.2 -> 2\.2 with no pre-registered counts/);
  // an entry that disagrees with the run is red — that is what keeps "register
  // the numbers" from meaning "write down whatever came out"
  assert.match(checkHourlyDrift(bumped, head, { baselines: { '2.2': { published: 150 } }, slack: 30 }).join('\n'),
    /published is 0, pre-registered 150/);
  assert.deepEqual(checkHourlyDrift(bumped, head, { baselines: { '2.2': { published: 25 } }, slack: 30 }), []);
  // A MEMBERSHIP bump moves these counts too, so it must ask for its own entry
  // rather than being answered by the lag version's
  const membership = healthyLag({ ruleVersion: 3 });
  assert.match(checkHourlyDrift(membership, head, { baselines: { '1.2': { published: 120 } } }).join('\n'),
    /lag rule 1\.2 -> 1\.3 with no pre-registered counts/);
  // THE TRAP N8's FIRST CUT FELL INTO: read the version the same way on both
  // sides. A HEAD with no version field is version 1, exactly as the file in
  // hand would be — not "whatever the current one is", which compares equal and
  // switches the clause off for good.
  const headNoVer = { ...healthyLag(), lagRuleVersion: undefined, ruleVersion: undefined };
  assert.match(checkHourlyDrift(healthyLag({ lagRuleVersion: 4 }), headNoVer, { baselines: {} }).join('\n'),
    /lag rule 1\.1 -> 4\.2 with no pre-registered counts/);
});
