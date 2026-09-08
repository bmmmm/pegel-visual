// tests/nrw-precip.test.mjs — the rain-field rule of scripts/build-nrw-precip.mjs,
// each clause on a fixture built to sit exactly on its edge. The rule is
// pre-registered (see the script's header), so these tests are the rule written
// twice: once as code, once as the cases it must decide. Everything runs on
// synthetic trees under a temp dir — no network, no mirror, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  build, assignRain, buildUp, closure, precipMembers, arealDay, arealSeries, responseStats,
  usableCoords, haversineKm, cmpNo, pearson, median, quantile,
  LAT_BOX, LON_BOX, MAX_ASSIGN_KM, MAX_ORPHAN_KM, MIN_COVERAGE_PCT,
  PLAUSIBLE_MAX_MM_DAY, MIN_SET_FOR_SERIES, MIN_RESPONSE_DAYS, MIN_EVENTS,
  MAX_LOCAL_KM, MAX_KNN_KM,
  yearStartDay, dayToISO,
} = await import('../scripts/build-nrw-precip.mjs');
const { daysInYear } = await import('../scripts/fetch-wsv-archive.mjs');

// A degree of latitude on the rule's own sphere. Two points on one meridian are
// exactly this far apart, so a fixture can sit on 9.99 km and mean it.
const latOffset = km => (km / 6371.0088) * 180 / Math.PI;
const BASE = { lat: 51.0, lon: 7.0 };
const northOf = (p, km) => ({ lat: p.lat + latOffset(km), lon: p.lon });

// ---------- 1.1 assignment ----------

test('assignment: two basins, three gauges, five rain gauges — exact owners', () => {
  const nodes = {
    '100': { basin: '1', siteNo: '100', ...BASE },                    // basin 1, south
    '200': { basin: '1', siteNo: '100', ...northOf(BASE, 20) },       // basin 1, north
    '300': { basin: '2', siteNo: '100', ...northOf(BASE, 60) },       // basin 2
  };
  const rain = {
    r1: { name: 'r1', catchmentNo: '1', ...northOf(BASE, 1) },        // -> 100
    r2: { name: 'r2', catchmentNo: '1', ...northOf(BASE, 19) },       // -> 200
    r3: { name: 'r3', catchmentNo: '2', ...northOf(BASE, 61) },       // -> 300
    r4: { name: 'r4', catchmentNo: '2', ...northOf(BASE, 2) },        // basin 2 gauge is 58 km away, still <= 100 -> 300
    r5: { name: 'r5', catchmentNo: null, ...northOf(BASE, 21) },      // no basin -> orphan, 1 km to 200
  };
  const a = assignRain(nodes, rain);
  const own = Object.fromEntries([...a.own].map(([g, rs]) => [g, rs]));
  assert.deepEqual(own, { '100': ['r1'], '200': ['r2', 'r5'], '300': ['r3', 'r4'] });
  assert.deepEqual(a.assigned.map(x => x.via), ['basin', 'basin', 'basin', 'basin', 'orphan']);
  assert.equal(a.unassigned.length, 0);
});

test('assignment: a tie goes to the smaller station number, numerically not lexically', () => {
  // "43" must beat "2739229000100": a string compare would call it the larger.
  const nodes = {
    '2739229000100': { basin: '1', siteNo: '100', ...northOf(BASE, 5) },
    '43': { basin: '1', siteNo: '100', ...northOf(BASE, 5) },
  };
  const a = assignRain(nodes, { r: { name: 'r', catchmentNo: '1', ...BASE } });
  assert.equal(a.assigned[0].to, '43');
  assert.equal(cmpNo('43', '2739229000100') < 0, true);
});

test('the coordinate box is inclusive on all four edges, and one step out is out', () => {
  for (const p of [{ lat: LAT_BOX[0], lon: LON_BOX[0] }, { lat: LAT_BOX[1], lon: LON_BOX[1] }]) {
    assert.equal(usableCoords(p), true, `${p.lat}/${p.lon} is on the edge and inside`);
  }
  assert.equal(usableCoords({ lat: LAT_BOX[0] - 1e-9, lon: LON_BOX[0] }), false);
  assert.equal(usableCoords({ lat: LAT_BOX[1] + 1e-9, lon: LON_BOX[0] }), false);
  assert.equal(usableCoords({ lat: LAT_BOX[0], lon: LON_BOX[0] - 1e-9 }), false);
  assert.equal(usableCoords({ lat: LAT_BOX[0], lon: LON_BOX[1] + 1e-9 }), false);
  assert.equal(usableCoords({ lat: 0, lon: 0 }), false, 'the three null-island rain gauges');
  assert.equal(usableCoords({ lat: null, lon: 7 }), false);
  assert.equal(usableCoords({ lat: 2570000, lon: 5670000 }), false, 'Ruenderoth, Gauss-Krueger');
});

test('orphan hop: 9.99 km is taken, 10.01 km is refused with a reason and a distance', () => {
  const nodes = { g: { basin: '1', siteNo: '100', ...BASE } };
  const near = assignRain(nodes, { r: { name: 'r', catchmentNo: null, ...northOf(BASE, MAX_ORPHAN_KM - 0.01) } });
  assert.equal(near.assigned.length, 1);
  assert.equal(near.assigned[0].via, 'orphan');
  const far = assignRain(nodes, { r: { name: 'r', catchmentNo: null, ...northOf(BASE, MAX_ORPHAN_KM + 0.01) } });
  assert.equal(far.assigned.length, 0);
  assert.equal(far.unassigned[0].why, 'orphan-far');
  assert.ok(far.unassigned[0].km > MAX_ORPHAN_KM, 'the refusal carries the distance it refused');
});

test('basin hop: 99.9 km stays in the basin, 100.1 km falls through to the orphan path', () => {
  // This is the clause the two Eifel rain gauges registered to the Issel basin
  // (55040051, 55048925, 150 km from the nearest Issel gauge) actually take.
  const nodes = {
    far: { basin: '1', siteNo: '100', ...northOf(BASE, MAX_ASSIGN_KM - 0.1) },
    near: { basin: '2', siteNo: '100', ...northOf(BASE, 5) },
  };
  const inside = assignRain(nodes, { r: { name: 'r', catchmentNo: '1', ...BASE } });
  assert.equal(inside.assigned[0].via, 'basin');
  assert.equal(inside.assigned[0].to, 'far');

  const outside = assignRain(
    { far: { basin: '1', siteNo: '100', ...northOf(BASE, MAX_ASSIGN_KM + 0.1) }, near: nodes.near },
    { r: { name: 'r', catchmentNo: '1', ...BASE } });
  assert.equal(outside.assigned[0].via, 'orphan', 'own basin too far -> nearest gauge of any basin');
  assert.equal(outside.assigned[0].to, 'near');
});

test('a WSV relay routes but never receives, and a broken-coordinate gauge neither', () => {
  const nodes = {
    relay: { basin: '1', siteNo: '102', ...BASE },
    broken: { basin: '1', siteNo: '100', lat: 2570000, lon: 5670000 },
    ok: { basin: '1', siteNo: '100', ...northOf(BASE, 30) },
  };
  const a = assignRain(nodes, { r: { name: 'r', catchmentNo: '1', ...BASE } });
  assert.deepEqual(a.recv, ['ok']);
  assert.deepEqual(a.relayed, ['relay']);
  assert.deepEqual(a.badCoord, ['broken']);
  assert.equal(a.assigned[0].to, 'ok', 'the rain goes past both, 30 km away');
});

// ---------- 1.2 closure ----------

test('closure walks the chain and the side tributary, and terminates on the 2-cycle', () => {
  const nodes = {
    mouth: { down: null }, mid: { down: 'mouth' }, headA: { down: 'mid' }, headB: { down: 'mid' },
    // the real defect: 2739229000100 Erkrath <-> 2739230000100 Eigen
    cycA: { down: 'cycB' }, cycB: { down: 'cycA' },
  };
  const up = buildUp(nodes);
  assert.deepEqual([...closure('mouth', up)].sort(), ['headA', 'headB', 'mid', 'mouth']);
  assert.deepEqual([...closure('mid', up)].sort(), ['headA', 'headB', 'mid']);
  assert.deepEqual([...closure('headA', up)], ['headA']);
  // no timeout, no stack overflow: the seen-set is what makes this finish
  assert.deepEqual([...closure('cycA', up)].sort(), ['cycA', 'cycB']);
});

test('a rain gauge upstream is in every downstream gauge set exactly once (nesting)', () => {
  const nodes = {
    low: { basin: '1', siteNo: '100', down: null, ...BASE },
    high: { basin: '1', siteNo: '100', down: 'low', ...northOf(BASE, 10) },
  };
  const a = assignRain(nodes, { r: { name: 'r', catchmentNo: '1', ...northOf(BASE, 10) } });
  const up = buildUp(nodes);
  const setOf = g => [...closure(g, up)].flatMap(s => a.own.get(s) || []);
  assert.deepEqual(setOf('high'), ['r']);
  assert.deepEqual(setOf('low'), ['r'], 'downstream inherits it — once, not twice');
});

// ---------- 1.3 membership (rule version 2) ----------
// Three ways into a set, and each one has to be shown doing exactly its own job
// and nothing else. The whole point of `via` is that a reader can tell a
// hydrological member from a geometric one from a last-resort fill; a test suite
// that only counted members would let the three blur into each other.

const membersOf = (nodes, rain, no, opts) => {
  const assign = assignRain(nodes, rain);
  return precipMembers(no, { nodes, rain, assign, up: buildUp(nodes), ...opts });
};

test('membership: with both knobs off the rule is exactly the pre-version-2 union over the closure', () => {
  const nodes = {
    low: { basin: '1', siteNo: '100', down: null, ...BASE },
    high: { basin: '1', siteNo: '100', down: 'low', ...northOf(BASE, 10) },
  };
  const rain = {
    r1: { name: 'r1', catchmentNo: '1', ...northOf(BASE, 10) },   // owned by high
    r2: { name: 'r2', catchmentNo: '1', ...northOf(BASE, 1) },    // owned by low
  };
  const off = { localKm: null, knnFloor: 0 };
  assert.deepEqual(membersOf(nodes, rain, 'high', off).map(m => [m.no, m.via, m.at]), [['r1', 'basin', 'high']]);
  assert.deepEqual(membersOf(nodes, rain, 'low', off).map(m => [m.no, m.via, m.at]),
    [['r1', 'basin', 'high'], ['r2', 'basin', 'low']], 'downstream still inherits, and the member still names its owner');
});

test('membership: the local ring adds a neighbour that drains nowhere near, and says so', () => {
  // `far` is 12 km from `g` but belongs to another basin's gauge 1 km from it,
  // so the hydrological rule never gives it to `g`. The 15 km ring does — and
  // the member carries via "local" and the distance to THE GAUGE, not to its
  // hydrological owner.
  const nodes = {
    g: { basin: '1', siteNo: '100', down: null, ...BASE },
    other: { basin: '2', siteNo: '100', down: null, ...northOf(BASE, 13) },
  };
  const rain = { far: { name: 'far', catchmentNo: '2', ...northOf(BASE, 12) } };
  assert.deepEqual(membersOf(nodes, rain, 'g', { localKm: null, knnFloor: 0 }), [], 'hydrology alone gives g nothing');
  const withRing = membersOf(nodes, rain, 'g', { localKm: 15, knnFloor: 0 });
  assert.equal(withRing.length, 1);
  assert.equal(withRing[0].via, 'local');
  assert.equal(withRing[0].at, 'g', 'a local member attaches to the gauge itself');
  assert.ok(Math.abs(withRing[0].km - 12) < 0.05, `12 km to the gauge, got ${withRing[0].km}`);
  assert.deepEqual(membersOf(nodes, rain, 'g', { localKm: 11, knnFloor: 0 }), [], 'and the ring is a real edge');
});

test('membership: the local ring is a real edge, taken from one side and refused from the other', () => {
  const nodes = { g: { basin: '1', siteNo: '100', down: null, ...BASE } };
  const at = km => ({ r: { name: 'r', catchmentNo: '9', ...northOf(BASE, km) } });
  const ring = { localKm: MAX_LOCAL_KM, knnFloor: 0 };
  assert.equal(membersOf(nodes, at(MAX_LOCAL_KM - 0.01), 'g', ring).length, 1, `${MAX_LOCAL_KM - 0.01} km is inside`);
  assert.equal(membersOf(nodes, at(MAX_LOCAL_KM + 0.01), 'g', ring).length, 0, `${MAX_LOCAL_KM + 0.01} km is out`);
});

test('membership: the knn floor fills to exactly knnFloor and never touches a set that has enough', () => {
  const nodes = { g: { basin: '1', siteNo: '100', down: null, ...BASE } };
  // five stations spread past the ring, all in another basin so hydrology gives
  // g nothing at all
  const rain = Object.fromEntries([20, 22, 24, 26, 28].map((km, i) =>
    [`r${i}`, { name: `r${i}`, catchmentNo: '9', ...northOf(BASE, km) }]));
  const filled = membersOf(nodes, rain, 'g', { localKm: 15, knnFloor: 3 });
  assert.deepEqual(filled.map(m => m.no), ['r0', 'r1', 'r2'], 'the three NEAREST, in station order');
  assert.deepEqual(filled.map(m => m.via), ['knn', 'knn', 'knn']);
  assert.deepEqual(filled.map(m => m.at), ['g', 'g', 'g']);

  // Now give the ring three of its own. They sit past the 10 km orphan hop, so
  // hydrology still gives g nothing and they can only arrive via the ring — and
  // once they have, the floor must not add a fourth.
  const near = Object.fromEntries([12, 13, 14].map((km, i) =>
    [`n${i}`, { name: `n${i}`, catchmentNo: '9', ...northOf(BASE, km) }]));
  const full = membersOf(nodes, { ...rain, ...near }, 'g', { localKm: 15, knnFloor: 3 });
  assert.deepEqual(full.map(m => m.via), ['local', 'local', 'local'], 'the floor stayed out of it');
  assert.equal(full.length, 3);
});

test('membership: the knn floor stops at its own bound — no product beats a set from 50 km away', () => {
  const nodes = { g: { basin: '1', siteNo: '100', down: null, ...BASE } };
  const rain = Object.fromEntries([50, 52, 54].map((km, i) =>
    [`r${i}`, { name: `r${i}`, catchmentNo: '9', ...northOf(BASE, km) }]));
  assert.deepEqual(membersOf(nodes, rain, 'g', { localKm: 15, knnFloor: 3, knnMaxKm: MAX_KNN_KM }), [],
    'nothing within 45 km means no rain field, not a rain field from the next state');
  assert.equal(membersOf(nodes, rain, 'g', { localKm: 15, knnFloor: 3, knnMaxKm: 60 }).length, 3,
    'and the bound is the only thing stopping it');
});

test('membership: a member added twice by two different ways is still one member', () => {
  // r is inside the ring AND assigned to g by basin. It must appear once, and
  // the hydrological origin wins — that is the one a reader can act on.
  const nodes = { g: { basin: '1', siteNo: '100', down: null, ...BASE } };
  const rain = { r: { name: 'r', catchmentNo: '1', ...northOf(BASE, 5) } };
  const m = membersOf(nodes, rain, 'g', { localKm: 15, knnFloor: 3 });
  assert.equal(m.length, 1);
  assert.equal(m[0].via, 'basin', 'hydrology is not overwritten by geometry');
});

// ---------- 1.2 areal mean ----------

test('arealDay: [10, null, 20] over a set of 3 is 15 from 2 stations', () => {
  // the null never reaches arealDay — a missing reading is not a zero
  const d = arealDay([10, 20], 3);
  assert.equal(d.mm, null, 'a set of 3 needs 3 reporting stations');
  const d2 = arealDay([10, 20], 2);
  assert.equal(d2.mm, null, 'and the floor of 3 stations holds even for a set of 2');
  const d3 = arealDay([10, 20, 30], 3);
  assert.deepEqual([d3.mm, d3.n, d3.med, d3.mx], [20, 3, 20, 30]);
});

test('the reporting threshold is max(3, ceil(half the set))', () => {
  assert.equal(arealDay([1, 2, 3], 3).n, 3, '3 of 3');
  assert.equal(arealDay([1, 2, 3], 5).n, 3, 'ceil(2.5) = 3');
  assert.equal(arealDay([1, 2, 3], 6).n, 3, 'ceil(3.0) = 3, exactly met');
  assert.equal(arealDay([1, 2, 3], 7).mm, null, 'ceil(3.5) = 4, and 3 is one short');
  assert.equal(arealDay([1, 2, 3, 4], 8).n, 4, 'a set of 8 needs 4');
  assert.equal(arealDay([1, 2, 3], 8).mm, null, 'a set of 8 refuses 3');
  assert.equal(arealDay([1, 2], 2).mm, null, 'never below three stations, whatever the set');
  assert.equal(arealDay([1, 2], 2).n, 0, 'a refused day carries no count either — that is the N8b invariant');
});

test('a day where everything is filtered out is mm null AND n 0, never 0 mm', () => {
  const d = arealDay([], 5);
  assert.deepEqual([d.mm, d.n, d.med, d.mx], [null, 0, null, null]);
  const real = arealDay([0, 0, 0], 3);
  assert.deepEqual([real.mm, real.n], [0, 3], 'three stations reporting a dry day IS 0 mm');
});

// ---------- filters, through the real reader ----------

function writeTree(dir, { gauges = {}, rain = {}, basins = {}, manifest = {} }) {
  mkdirSync(dir, { recursive: true });
  const topo = { schema: 1, generated: '2026-09-06', basins, gauges: {} };
  for (const [no, g] of Object.entries(gauges)) {
    topo.gauges[no] = { id: no, name: g.name || no, water: g.water || 'W', basin: g.basin ?? null, siteNo: g.siteNo || '100', km2: g.km2 ?? null, down: g.down ?? null };
    const d = join(dir, 'gauges', no); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'meta.json'), JSON.stringify({ id: no, name: g.name || no, water: g.water || 'W', siteNo: g.siteNo || '100', lat: g.lat, lon: g.lon, catchmentNo: g.basin ?? null, catchmentKm2: g.km2 ?? null, unit: 'cm', dayBoundary: '00:00+01:00' }));
    for (const [y, s] of Object.entries(g.years || {})) {
      const n = daysInYear(Number(y));
      writeFileSync(join(d, `${y}.json`), JSON.stringify({ id: no, y: Number(y), min: Array(n).fill(null), mean: s.mean || Array(n).fill(null), max: Array(n).fill(null), n: Array(n).fill(null), acc: s.acc || {} }));
    }
  }
  for (const [no, r] of Object.entries(rain)) {
    const d = join(dir, 'rain', no); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'meta.json'), JSON.stringify({ id: no, name: r.name || no, siteNo: '100', lat: r.lat, lon: r.lon, catchmentNo: r.basin ?? null, unit: 'mm', dayBoundary: '07:00+01:00' }));
    for (const [y, s] of Object.entries(r.years || {})) {
      const n = daysInYear(Number(y));
      writeFileSync(join(d, `${y}.json`), JSON.stringify({ id: no, y: Number(y), mm: s.mm || Array(n).fill(null), imax: Array(n).fill(null), cov: s.cov || {} }));
    }
  }
  writeFileSync(join(dir, 'topology.json'), JSON.stringify(topo));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, generated: '2026-09-06', sourceExportAt: '2026-09-06T19:03:54.000Z', counts: {}, coverage: {}, gauges: {}, rain: {}, temp: {}, ...manifest }));
  return dir;
}

// N rain gauges around one gauge, one year. Four is the useful size for the
// filter tests: the threshold is max(3, ceil(4/2)) = 3, so exactly one station
// may be filtered out and the day still reports — which is what makes "one of
// four dropped" visible as n = 3 rather than as a vanished day.
function gaugeTree(tmp, rainYears) {
  const Y = 2025, n = daysInYear(Y);
  const rain = {};
  rainYears.forEach((yr, i) => { rain[`r${i + 1}`] = { basin: '1', ...northOf(BASE, i + 1), years: { [Y]: yr } }; });
  return writeTree(join(tmp, 'nrw'), {
    gauges: { g1: { ...BASE, basin: '1', km2: 100, years: { [Y]: { mean: Array(n).fill(50) } } } },
    rain,
    basins: { 1: { name: 'B', river: 'B', gauges: ['g1'], noLevel: [], rain: Object.keys(rain), temp: [], mouth: 'g1' } },
  });
}
const threeGaugeTree = gaugeTree;

const readShard = (tmp, no, y) => JSON.parse(readFileSync(join(tmp, 'nrw', 'precip', String(no), `${y}.json`), 'utf8'));

test('coverage below 50 % drops the reading; 50.0 keeps it; a missing cov key is 100 %', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-cov-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array(n).fill(null); mm[0] = 10; mm[1] = 10; mm[2] = 10;
  const tree = gaugeTree(tmp, [
    { mm: [...mm], cov: { 0: MIN_COVERAGE_PCT - 0.1, 1: MIN_COVERAGE_PCT } },  // day 0 dropped, day 1 kept
    { mm: [...mm], cov: {} },                                                   // no cov key at all = 100 %
    { mm: [...mm], cov: { 0: 100, 1: 100 } },
    { mm: [...mm], cov: { 0: 100, 1: 100 } },
  ]);
  build({ tree, out: join(tree, 'precip'), generated: '2026-09-06' });
  const s = readShard(tmp, 'g1', Y);
  assert.deepEqual([s.mm[0], s.n[0]], [10, 3], 'one of four dropped at 49.9 %, three still report');
  assert.deepEqual([s.mm[1], s.n[1]], [10, 4], '50.0 % is inclusive');
  assert.deepEqual([s.mm[2], s.n[2]], [10, 4], 'a missing cov key is a full day');
  rmSync(tmp, { recursive: true, force: true });
});

test('401 mm is dropped from the areal mean and the day is counted without it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-max-'));
  const Y = 2025, n = daysInYear(Y);
  const at = v => { const a = Array(n).fill(null); a[0] = v; a[1] = 10; return a; };
  const tree = gaugeTree(tmp, [
    { mm: at(PLAUSIBLE_MAX_MM_DAY + 1) }, { mm: at(PLAUSIBLE_MAX_MM_DAY) }, { mm: at(10) }, { mm: at(10) },
  ]);
  build({ tree, out: join(tree, 'precip'), generated: '2026-09-06' });
  const s = readShard(tmp, 'g1', Y);
  assert.equal(s.n[0], 3, '401 mm is out, 400 mm is in');
  assert.equal(s.mm[0], 140, 'the mean of 400, 10 and 10 — the outlier never entered it');
  assert.deepEqual([s.mm[1], s.n[1]], [10, 4]);
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- 1.4 response ----------

const flat = (n, v) => { const a = new Float64Array(n); a.fill(v); return a; };

test('response: a single impulse puts the peak at the lag it was built at', () => {
  const N = 400;
  const rain = Array(N).fill(0);
  rain[200] = 20;
  const level = flat(N, 100);
  for (let i = 202; i < N; i++) level[i] = 130;    // +30 cm on day 202 = lag 2
  const r = responseStats(rain, level, { from: 0, to: N - 1, id: 'x', nRain: 3, unit: 'cm' });
  assert.equal(r.peakLag, 2);
  assert.ok(r.rPeak > 0.99, `rPeak ${r.rPeak} is essentially 1 — one impulse, one response`);
  assert.equal(r.events.n, 1, 'one day over 10 mm');
  assert.equal(r.events.risePer10mm, null, `${MIN_EVENTS} events needed, not 1`);
});

test('response: a linear rain -> level system reads r(1) = 1 and nothing at the other lags', () => {
  const N = 500;
  // A plain modulo ramp is autocorrelated, and its own autocorrelation would
  // show up at every lag — the series has to be white for "nothing at the other
  // lags" to mean anything. Numerical-recipes LCG, seeded, so the test is exact.
  let seed = 12345;
  const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const rain = Array.from({ length: N }, () => Math.round(rnd() * 20));
  const level = new Float64Array(N);
  level[0] = 100;
  for (let i = 1; i < N; i++) level[i] = level[i - 1] + 0.8 * rain[i - 1];  // delta[i] = 0.8 * rain[i-1]
  const r = responseStats(rain, level, { from: 0, to: N - 1, id: 'x', nRain: 5, unit: 'cm' });
  assert.equal(r.peakLag, 1);
  assert.ok(r.rPeak > 0.999, `r(1) = ${r.rPeak}`);
  for (const l of r.lags) if (l.lag !== 1) assert.ok(Math.abs(l.r) < 0.2, `r(${l.lag}) = ${l.r} must be noise`);
  assert.equal(r.events.risePer10mm, 8, '0.8 cm per mm is 8 cm per 10 mm');
});

test('response: below the pair floor there is no peak, and the reason says so', () => {
  const N = MIN_RESPONSE_DAYS + 10;
  const rain = Array(N).fill(null);
  const level = flat(N, 100);
  for (let i = 0; i < MIN_RESPONSE_DAYS - 1; i++) { rain[i] = i % 5; level[i + 1] = 100 + (i % 5); }
  const r = responseStats(rain, level, { from: 0, to: N - 1, id: 'x', nRain: 3, unit: 'cm' });
  assert.equal(r.peakLag, null);
  assert.match(r.reason, /too few pairs/);
});

test('response: 9 events is null, 10 is a number', () => {
  const mk = events => {
    const N = 400;
    const rain = Array(N).fill(0);
    const level = flat(N, 100);
    for (let e = 0; e < events; e++) { const d = 10 + e * 20; rain[d] = 20; level[d + 1] = 100 + 30; level[d + 2] = 100; }
    for (let i = 1; i < N; i++) if (level[i] === 0) level[i] = 100;
    return responseStats(rain, level, { from: 0, to: N - 1, id: 'x', nRain: 3, unit: 'cm' });
  };
  assert.equal(mk(MIN_EVENTS - 1).events.risePer10mm, null);
  assert.equal(mk(MIN_EVENTS - 1).events.n, MIN_EVENTS - 1);
  assert.equal(typeof mk(MIN_EVENTS).events.risePer10mm, 'number');
});

test('response: the unit rides along with the gauge, it is not assumed to be cm', () => {
  const r = responseStats([null], flat(1, 0), { from: 0, to: 0, id: 'x', nRain: 3, unit: 'm+NN' });
  assert.equal(r.unit.rise, 'm+NN per 10 mm of rain around the gauge');
});

test('a level day the source aggregated below 95 % accuracy is not observed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-acc-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array(n).fill(5);
  const mean = Array.from({ length: n }, (_, d) => 100 + d);
  const tree = writeTree(join(tmp, 'nrw'), {
    gauges: { g1: { ...BASE, basin: '1', years: { [Y]: { mean, acc: { 10: 94.9, 11: 95 } } } } },
    rain: {
      r1: { basin: '1', ...northOf(BASE, 1), years: { [Y]: { mm } } },
      r2: { basin: '1', ...northOf(BASE, 2), years: { [Y]: { mm } } },
      r3: { basin: '1', ...northOf(BASE, 3), years: { [Y]: { mm } } },
    },
    basins: { 1: { name: 'B', river: 'B', gauges: ['g1'], noLevel: [], rain: ['r1', 'r2', 'r3'], temp: [], mouth: 'g1' } },
  });
  build({ tree, out: join(tree, 'precip'), generated: '2026-09-06' });
  const resp = JSON.parse(readFileSync(join(tree, 'precip', 'g1', 'response.json'), 'utf8'));
  // Jan 1 has no previous day, so a full year yields n-1 lag-0 pairs at most.
  // Day 10 falling below 95 % kills delta(10) AND delta(11); day 11 sits at
  // exactly 95 and survives. Two more pairs gone: n-3.
  assert.equal(resp.lags[0].n, n - 3, 'the unobserved day costs two pairs, Jan 1 costs the third');
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- the measurement bench ----------
// scripts/probe-precip-rule.mjs decided which rule ships. Every number it
// printed is worthless if its `identity` variant is not the shipping rule, so
// that claim gets a test of its own rather than a line in a report: identity
// through the variant machinery must reproduce, to 1e-9, the peak r that
// responseStats gives when driven straight off the union over the closure.
//
// The real check ran on the mirror (92 of 92 gauges at delta exactly 0). This
// is its CI-able twin: a synthetic tree, three named gauges, no network.

test('bench: the identity variant IS the pre-version-2 rule, to 1e-9, on three named gauges', async () => {
  const { loadBench, runVariant, VARIANTS, referenceRun } = await import('../scripts/probe-precip-rule.mjs');
  const { readRainSeries, readLevelSeries, dayAxis, readTree } = await import('../scripts/build-nrw-precip.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'precip-bench-'));
  const Y = 2025, n = daysInYear(Y);
  // rain that actually drives the level, so rPeak is a number and not a null
  const mm = Array.from({ length: n }, (_, d) => (d % 11 === 0 ? 12 : d % 3));
  const mean = Array.from({ length: n }, (_, d) => 50 + (d > 0 && (d - 1) % 11 === 0 ? 20 : 0));
  // EACH STATION GETS ITS OWN SERIES, not `mm + i`. Pearson r is invariant
  // under an additive constant, so a set whose members differ only by an offset
  // has the SAME peak r whatever its membership — the first cut of this test
  // did that, and its two 1e-9 assertions could not fail: with the closure walk
  // sabotaged the set went from 9 members to 3 and r stayed bit-identical. The
  // per-station phase shift is what makes the mean depend on WHO is in the set.
  const rainOf = i => ({
    basin: '1', ...northOf(BASE, i),
    years: { [Y]: { mm: Array.from({ length: n }, (_, d) => mm[(d + i * 3) % n] * (1 + (i % 5) / 4)) } },
  });
  const tree = writeTree(join(tmp, 'nrw'), {
    gauges: {
      low: { ...BASE, basin: '1', km2: 300, down: null, years: { [Y]: { mean } } },
      mid: { ...northOf(BASE, 40), basin: '1', km2: 200, down: 'low', years: { [Y]: { mean } } },
      high: { ...northOf(BASE, 80), basin: '1', km2: 100, down: 'mid', years: { [Y]: { mean } } },
    },
    // three clusters, one per gauge, far enough apart that the nesting is the
    // only thing that grows a set: low sees 9, mid 6, high 3
    rain: {
      r1: rainOf(1), r2: rainOf(2), r3: rainOf(3),
      r4: rainOf(41), r5: rainOf(42), r6: rainOf(43),
      r7: rainOf(81), r8: rainOf(82), r9: rainOf(83),
    },
    basins: { 1: { name: 'B', river: 'B', gauges: ['low', 'mid', 'high'], noLevel: [], rain: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'], temp: [], mouth: 'low' } },
  });

  const bench = loadBench(tree);
  const run = runVariant(bench, VARIANTS.identity);
  const { from, to } = dayAxis(tree, readTree(tree).rain);

  for (const no of ['low', 'mid', 'high']) {
    // the OLD rule, written out here by hand rather than imported: union of the
    // owned stations over the upstream closure, nothing else
    const set = [...closure(no, bench.up)].sort(cmpNo)
      .flatMap(s => (bench.assign.own.get(s) || []))
      .sort(cmpNo);
    assert.ok(set.length >= MIN_SET_FOR_SERIES, `${no} needs a set to compare at all`);
    const ser = arealSeries(set.map(r => ({ no: r, series: readRainSeries(tree, r, from, to) })), from, to);
    const want = responseStats(ser.mm, readLevelSeries(tree, no, from, to),
      { from, to, id: no, nRain: set.length, unit: 'cm' });
    assert.deepEqual(run.get(no).set, set, `${no}: the bench builds the same set`);
    assert.ok(want.rPeak != null, `${no}: the fixture has to produce a peak, or this proves nothing`);
    assert.ok(Math.abs(run.get(no).rPeak - want.rPeak) < 1e-9,
      `${no}: bench ${run.get(no).rPeak} vs rule ${want.rPeak}`);
  }

  // The CLI's own self-test path, on the same tree. `referenceRun` is the one
  // function in the bench that does not go through `precipMembers` — the first
  // cut of this bench compared the identity variant against ITSELF and printed
  // "delta 0" no matter what the machinery did.
  const ref = referenceRun(bench);
  for (const no of ['low', 'mid', 'high']) {
    assert.deepEqual(ref.get(no).set, run.get(no).set, `${no}: reference and variant build the same set`);
    assert.ok(Math.abs(ref.get(no).rPeak - run.get(no).rPeak) < 1e-9, `${no}: and the same peak r`);
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('bench: a variant that adds members changes the sets it was asked to change, and no others', async () => {
  const { loadBench, runVariant, VARIANTS, compare } = await import('../scripts/probe-precip-rule.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'precip-bench2-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array.from({ length: n }, (_, d) => (d % 11 === 0 ? 12 : d % 3));
  const mean = Array.from({ length: n }, (_, d) => 50 + (d > 0 && (d - 1) % 11 === 0 ? 20 : 0));
  // per-station series, not `mm + i` — see the note in the test above
  const rainOf = i => ({
    basin: '1', ...northOf(BASE, i),
    years: { [Y]: { mm: Array.from({ length: n }, (_, d) => mm[(d + i * 3) % n] * (1 + (i % 5) / 4)) } },
  });
  // `far` has three of its own; `near` has none and sits 8 km from far's cluster
  const tree = writeTree(join(tmp, 'nrw'), {
    gauges: {
      far: { ...BASE, basin: '1', km2: 100, down: null, years: { [Y]: { mean } } },
      near: { ...northOf(BASE, 8), basin: '2', km2: 100, down: null, years: { [Y]: { mean } } },
    },
    rain: { r1: rainOf(1), r2: rainOf(2), r3: rainOf(3) },
    basins: { 1: { name: 'B', river: 'B', gauges: ['far'], noLevel: [], rain: ['r1', 'r2', 'r3'], temp: [], mouth: 'far' } },
  });
  const bench = loadBench(tree);
  const base = runVariant(bench, VARIANTS.identity);
  assert.equal(base.get('near').product, false, 'near has no rain field under the old rule');
  assert.equal(base.get('far').product, true);

  const ring = runVariant(bench, VARIANTS.km15);
  const c = compare(bench, base, ring);
  assert.equal(c.gained, 1, 'the ring gives near a number it did not have');
  assert.equal(c.lost, 0, 'and takes none away');
  assert.equal(ring.get('far').set.length, base.get('far').set.length, 'far already had all three — nothing to add');
  assert.equal(c.compared, 1, 'only far can be compared: the gained gauge has no baseline, by construction');
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- the product as a whole ----------

test('a second run writes nothing and --check exits clean; a hand-edit makes it list the file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-idem-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array.from({ length: n }, (_, d) => d % 17);
  const tree = threeGaugeTree(tmp, [{ mm }, { mm }, { mm }]);
  const out = join(tree, 'precip');
  const first = build({ tree, out, generated: '2026-09-06' });
  assert.ok(first.out.changed > 0, 'the first run writes');
  const second = build({ tree, out, generated: '2026-09-06' });
  assert.equal(second.out.changed, 0, 'the second writes nothing — writeJson compares content');
  const checked = build({ tree, out, check: true, generated: '2026-09-06' });
  assert.deepEqual(checked.out.diffs, []);

  const p = join(out, 'g1', `${Y}.json`);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  doc.mm[3] = 999;
  writeFileSync(p, JSON.stringify(doc));
  const dirty = build({ tree, out, check: true, generated: '2026-09-06' });
  assert.deepEqual(dirty.out.diffs, [`differs: g1/${Y}.json`]);
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).mm[3], 999, '--check wrote nothing back');
  rmSync(tmp, { recursive: true, force: true });
});

test('a gauge that falls below three rain gauges loses its files, it does not keep stale ones', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-prune-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array(n).fill(3);
  const tree = threeGaugeTree(tmp, [{ mm }, { mm }, { mm }]);
  const out = join(tree, 'precip');
  build({ tree, out, generated: '2026-09-06' });
  assert.ok(existsSync(join(out, 'g1', `${Y}.json`)));

  rmSync(join(tree, 'rain', 'r3'), { recursive: true, force: true });
  build({ tree, out, generated: '2026-09-06' });
  assert.equal(existsSync(join(out, 'g1', `${Y}.json`)), false, 'two rain gauges is no product');
  assert.equal(existsSync(join(out, 'g1', 'response.json')), false);
  const ix = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.equal(ix.gauges.g1.series, false);
  // "in reach", not "upstream": since rule version 2 a member can also be a
  // neighbour inside the 15 km ring or a knn-floor fill
  assert.match(ix.gauges.g1.why, /only 2 rain gauges in reach/);
  rmSync(tmp, { recursive: true, force: true });
});

test('the manifest gains a precip block naming every receiving gauge and the rule counts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-manifest-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array(n).fill(2);
  const tree = threeGaugeTree(tmp, [{ mm }, { mm }, { mm }]);
  build({ tree, out: join(tree, 'precip'), generated: '2026-09-06' });
  const m = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.precip.g1, { n: 3, up: 1, series: true });
  assert.equal(m.counts.precip, 1);
  assert.equal(m.coverage.precip.receivingNodes, 1);
  assert.equal(m.schema, 1, 'the collector fields survive the patch');
  rmSync(tmp, { recursive: true, force: true });
});

test('response.json is written even when it cannot be computed — a 404 would be a lie', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-resp-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array(n).fill(null); mm[0] = 5;
  const tree = threeGaugeTree(tmp, [{ mm }, { mm }, { mm }]);
  build({ tree, out: join(tree, 'precip'), generated: '2026-09-06' });
  const r = JSON.parse(readFileSync(join(tree, 'precip', 'g1', 'response.json'), 'utf8'));
  assert.equal(r.peakLag, null);
  assert.ok(r.reason, 'and it says why');
  rmSync(tmp, { recursive: true, force: true });
});

test('overview: the right edge is the mirror’s newest rain day, not the clock', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-ov-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array(n).fill(null);
  for (let d = 0; d < 100; d++) mm[d] = 4;          // the series stops on day index 99
  const tree = threeGaugeTree(tmp, [{ mm }, { mm }, { mm }]);
  build({ tree, out: join(tree, 'precip'), generated: '2026-09-06' });
  const ov = JSON.parse(readFileSync(join(tree, 'precip', 'overview.json'), 'utf8'));
  assert.equal(ov.window.to, dayToISO(yearStartDay(Y) + 99));
  assert.equal(ov.window.days, 90);
  assert.equal(ov.basins.length, 1);
  assert.equal(ov.basins[0].mm.length, 90);
  assert.equal(ov.basins[0].sum7, 28, 'seven days of 4 mm');
  assert.equal(ov.basins[0].n7, 7);
  assert.equal(ov.sourceExportAt, '2026-09-06T19:03:54.000Z');
  rmSync(tmp, { recursive: true, force: true });
});

test('a basin without a river is null, not the empty string the map would try to link', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'precip-emscher-'));
  const Y = 2025, n = daysInYear(Y);
  const mm = Array(n).fill(1);
  const tree = writeTree(join(tmp, 'nrw'), {
    gauges: { g1: { ...BASE, basin: '1', years: { [Y]: { mean: Array(n).fill(50) } } } },
    rain: {
      r1: { basin: '1', ...northOf(BASE, 1), years: { [Y]: { mm } } },
      r2: { basin: '1', ...northOf(BASE, 2), years: { [Y]: { mm } } },
      r3: { basin: '1', ...northOf(BASE, 3), years: { [Y]: { mm } } },
      r9: { basin: '2', ...northOf(BASE, 4), years: { [Y]: { mm } } },
    },
    basins: {
      1: { name: 'B', river: 'sieg', gauges: ['g1'], noLevel: [], rain: ['r1', 'r2', 'r3'], temp: [], mouth: 'g1' },
      2: { name: 'Emschereinzugsgebiet', river: null, gauges: [], noLevel: [], rain: ['r9'], temp: [], mouth: null },
    },
  });
  build({ tree, out: join(tree, 'precip'), generated: '2026-09-06' });
  const ov = JSON.parse(readFileSync(join(tree, 'precip', 'overview.json'), 'utf8'));
  const [b1, b2] = ov.basins;
  assert.equal(b1.river, 'SIEG', 'the river is upper-cased for the app’s river links');
  assert.equal(b2.river, null);
  assert.equal(b2.gauges, 0);
  assert.deepEqual(b2.mm.filter(v => v != null), [], 'one rain gauge never reaches the floor of three');
  assert.equal(b2.sum7, null);
  assert.equal(b2.n7, 0);
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- small helpers that carry weight ----------

test('pearson is two-pass: it survives a series far from zero', () => {
  const xs = Array.from({ length: 200 }, (_, i) => 1e6 + (i % 7));
  const ys = xs.map(x => 3 * x + 5);
  assert.ok(pearson(xs, ys) > 0.9999999, 'a one-pass form loses this to cancellation');
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null, 'no variance, no correlation');
  assert.equal(pearson([1], [1]), null);
});

test('median and quantile agree with hand arithmetic on both parities', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(quantile([], 0.5), null);
});

test('haversine reproduces a known distance on the rule’s own sphere', () => {
  assert.ok(Math.abs(haversineKm(BASE, northOf(BASE, 100)) - 100) < 1e-6);
  assert.equal(haversineKm(BASE, BASE), 0);
});
