#!/usr/bin/env node
// The measurement bench for the rain-set rule. NOT in CI, NOT deployed: it
// exists so a proposal about which rain stations belong to a gauge can be
// measured before it is believed.
//
//   node scripts/probe-precip-rule.mjs --tree /tmp/nrwtree/nrw --variant identity
//   node scripts/probe-precip-rule.mjs --tree /tmp/nrwtree/nrw --all
//   node scripts/probe-precip-rule.mjs --tree /tmp/nrwtree/nrw --all --json out.json
//
// IT IMPORTS THE SHIPPING ESTIMATOR — `precipMembers`, `arealSeries`,
// `responseStats` — and never restates it. A bench with its own copy of the
// rule measures the copy, and the copy is always the one that agrees with the
// hypothesis.
//
// THE SELF-TEST IS THE FIRST THING TO RUN AND THE ONLY ONE THAT CAN INVALIDATE
// EVERY OTHER NUMBER: `--variant identity` re-derives the CURRENT rule through
// the variant machinery and must report delta 0.0000 on every gauge that has a
// product today. If it does not, the machinery — not the variants — is what
// the numbers below describe.
//
// The statistic is peak Pearson r of areal rain against the daily level change,
// the same `rPeak` the station plate prints. Delta is per gauge against
// identity, pooled over the gauges that carry a product under BOTH rules.
// Gauges that gain a product under a variant have NO comparison and are
// counted separately — for them the alternative is not a worse number, it is
// no number at all.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  readTree, dayAxis, assignRain, buildUp, precipMembers, arealSeries, responseStats,
  readRainSeries, readLevelSeries, closure, haversineKm, usableCoords, median, cmpNo,
  MIN_SET_FOR_SERIES,
} from './build-nrw-precip.mjs';

// Each variant is only ever a pair of options handed to the shipping
// `precipMembers`. Adding one here cannot change what the others measure.
// The self-test's own floors. Deliberately far below the mirror's 276 / 92, so
// they catch "the tree fell apart" rather than police the source — but not zero,
// which is what they were, and zero is a check that passes on nothing.
export const MIN_SELF_TEST_GAUGES = 50;
export const MIN_SELF_TEST_R = 20;

export const VARIANTS = {
  identity: { localKm: null, knnFloor: 0 },
  knn3: { localKm: null, knnFloor: 3 },
  knn5: { localKm: null, knnFloor: 5 },
  km10: { localKm: 10, knnFloor: 0 },
  km15: { localKm: 15, knnFloor: 0 },
  km25: { localKm: 25, knnFloor: 0 },
  'km15+knn3': { localKm: 15, knnFloor: 3 },
  'km25+knn3': { localKm: 25, knnFloor: 3 },
};

const p90 = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
};

export function loadBench(tree) {
  const { nodes, rain } = readTree(tree);
  const assign = assignRain(nodes, rain);
  const up = buildUp(nodes);
  const { from, to } = dayAxis(tree, rain);
  const rainCache = new Map(), levelCache = new Map();
  return {
    nodes, rain, assign, up, from, to,
    rainOf: no => {
      if (!rainCache.has(no)) rainCache.set(no, readRainSeries(tree, no, from, to));
      return rainCache.get(no);
    },
    levelOf: no => {
      if (!levelCache.has(no)) levelCache.set(no, readLevelSeries(tree, no, from, to));
      return levelCache.get(no);
    },
  };
}

// One variant over every receiving gauge: who is in the set, and what the
// response statistic says. Same acceptance test as the builder — a set of three
// stations that never report is no product, not a product of nulls.
export function runVariant(bench, opts) {
  const { nodes, rain, assign, up, from, to } = bench;
  const out = new Map();
  for (const no of assign.recv) {
    const set = precipMembers(no, { nodes, rain, assign, up, ...opts });
    const rec = { no, n: set.length, set: set.map(s => s.no), via: set.map(s => s.via), rPeak: null, peakLag: null, product: false };
    out.set(no, rec);
    if (set.length < MIN_SET_FOR_SERIES) continue;
    const ser = arealSeries(set.map(s => ({ no: s.no, series: bench.rainOf(s.no) })), from, to);
    if (!ser.mm.some(v => v != null)) continue;
    rec.product = true;
    const r = responseStats(ser.mm, bench.levelOf(no), { from, to, id: no, nRain: set.length, unit: nodes[no].unit || 'cm' });
    rec.rPeak = r.rPeak; rec.peakLag = r.peakLag;
  }
  return out;
}

// THE REFERENCE, open-coded on purpose — the one function in this file that
// does NOT go through precipMembers. Without it the self-test compares the
// identity variant against itself and reports delta 0 whatever the machinery
// does, which is the "green by construction" failure this repo has already been
// bitten by four times. This is the pre-2026-09-08 rule written out: the union
// of the OWNED stations over the upstream closure, nothing else.
export function referenceRun(bench) {
  const { nodes, assign, up, from, to } = bench;
  const out = new Map();
  for (const no of assign.recv) {
    const set = [...closure(no, up)].sort(cmpNo)
      .flatMap(s => (assign.own.get(s) || []))
      .sort(cmpNo);
    const rec = { no, n: set.length, set, rPeak: null, product: false };
    out.set(no, rec);
    if (set.length < MIN_SET_FOR_SERIES) continue;
    const ser = arealSeries(set.map(r => ({ no: r, series: bench.rainOf(r) })), from, to);
    if (!ser.mm.some(v => v != null)) continue;
    rec.product = true;
    rec.rPeak = responseStats(ser.mm, bench.levelOf(no), { from, to, id: no, nRain: set.length, unit: nodes[no].unit || 'cm' }).rPeak;
  }
  return out;
}

// How far a member sits from its gauge relative to the radius of a circle of
// the gauge's own catchment area — the plan's honesty test. A member outside
// that radius is not necessarily wrong, but it is not "the catchment" either.
function outsideEquivalentRadius(bench, run) {
  let inside = 0, outside = 0;
  for (const [no, rec] of run) {
    const g = bench.nodes[no];
    const km2 = g && g.km2;
    if (!km2 || !(km2 > 0) || !usableCoords(g) || !rec.product) continue;
    const req = Math.sqrt(km2 / Math.PI);
    for (const r of rec.set) {
      const st = bench.rain[r];
      if (!usableCoords(st)) continue;
      if (haversineKm(st, g) <= req) inside++; else outside++;
    }
  }
  return { inside, outside, pct: inside + outside ? Math.round(1000 * outside / (inside + outside)) / 10 : null };
}

// Nesting: down-edge neighbours whose sets are literally the same list draw two
// plates that are one measurement. Counted, plus the median Jaccard over those
// same pairs — `precipNested` is the caveat this number stands behind.
function nesting(bench, run) {
  const pairs = [];
  const seen = new Set();
  for (const [no, g] of Object.entries(bench.nodes)) {
    const d = g.down == null ? null : String(g.down);
    if (!d || !run.has(no) || !run.has(d)) continue;
    // One UNORDERED pair per neighbouring gauge. The down-graph carries a
    // 2-cycle (Erkrath <-> Eigen), which offers the same pair from both ends
    // and would count it twice under a name that says "neighbours".
    const key = [no, d].sort().join('~');
    if (seen.has(key)) continue;
    seen.add(key);
    const a = run.get(no), b = run.get(d);
    if (!a.product || !b.product) continue;
    const A = new Set(a.set), B = new Set(b.set);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    pairs.push({ key, identical: A.size === B.size && inter === A.size, j: inter / (A.size + B.size - inter) });
  }
  return {
    pairs: pairs.length, identical: pairs.filter(p => p.identical).length,
    jaccardMedian: median(pairs.map(p => p.j)),
    byKey: new Map(pairs.map(p => [p.key, p])),
  };
}

// THE PAIRED nesting comparison, and it is the only one that supports a
// sentence of the form "the nesting got better". The unpaired medians compare
// 63 pairs against 181, and 119 of those 181 are gauges that had no plate at
// all before — they can pull the median without a single old pair improving.
function nestingPaired(baseNest, runNest) {
  const both = [];
  for (const [k, b] of baseNest.byKey) {
    const r = runNest.byKey.get(k);
    if (r) both.push({ base: b.j, run: r.j, wasIdentical: b.identical, isIdentical: r.identical });
  }
  if (!both.length) return null;
  return {
    pairs: both.length,
    jBase: median(both.map(x => x.base)), jRun: median(both.map(x => x.run)),
    better: both.filter(x => x.run < x.base - 1e-12).length,
    worse: both.filter(x => x.run > x.base + 1e-12).length,
    identicalBase: both.filter(x => x.wasIdentical).length,
    identicalRun: both.filter(x => x.isIdentical).length,
  };
}

export function compare(bench, base, run, baseNest = null) {
  const deltas = [], gained = [], lost = [];
  for (const [no, rec] of run) {
    const b = base.get(no);
    if (b && b.rPeak != null && rec.rPeak != null) deltas.push({ no, d: rec.rPeak - b.rPeak, from: b.rPeak, to: rec.rPeak });
    else if ((!b || b.rPeak == null) && rec.rPeak != null) gained.push(no);
    else if (b && b.rPeak != null && rec.rPeak == null) lost.push(no);
  }
  const ds = deltas.map(x => x.d);
  const better = ds.filter(d => d > 1e-12).length, worse = ds.filter(d => d < -1e-12).length;
  const n = better + worse;
  const sizes = [...run.values()].filter(r => r.product).map(r => r.n);
  const nest = nesting(bench, run);
  return {
    compared: deltas.length, gained: gained.length, lost: lost.length, lostIds: lost,
    medianDelta: median(ds), meanDelta: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null,
    better, worse, z: n ? (better - n / 2) / Math.sqrt(n / 4) : null,
    withProduct: sizes.length, setMedian: median(sizes), setP90: p90(sizes),
    radius: outsideEquivalentRadius(bench, run), nesting: nest,
    nestingPaired: baseNest ? nestingPaired(baseNest, nest) : null,
    deltas,
  };
}

const f = (v, p = 4) => v == null ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(p);

function row(name, c) {
  return [
    name.padEnd(11),
    `d_med ${f(c.medianDelta)}`,
    `d_mean ${f(c.meanDelta)}`,
    `${String(c.better).padStart(3)}+/${String(c.worse).padStart(3)}-`,
    `z ${f(c.z, 2)}`,
    `prod ${String(c.withProduct).padStart(3)}`,
    `(+${c.gained} -${c.lost} vs base)`,
    `set ${c.setMedian}/${c.setP90}`,
    `outside ${c.radius.pct}%`,
    `same-set ${c.nesting.identical}/${c.nesting.pairs}`,
    `J ${f(c.nesting.jaccardMedian, 3)}`,
    // the only column that supports "the nesting got better": the same pairs,
    // before and after
    c.nestingPaired
      ? `paired ${c.nestingPaired.pairs}: J ${f(c.nestingPaired.jBase, 3)}->${f(c.nestingPaired.jRun, 3)} ` +
        `(${c.nestingPaired.better} better/${c.nestingPaired.worse} worse, same-set ${c.nestingPaired.identicalBase}->${c.nestingPaired.identicalRun})`
      : '',
  ].join('  ');
}

function main(argv) {
  const args = argv.slice(2);
  const flag = name => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const tree = flag('--tree') || 'nrw';
  const jsonOut = flag('--json');
  const all = args.includes('--all');
  const want = all ? Object.keys(VARIANTS) : [flag('--variant') || 'identity'];
  for (const v of want) if (!VARIANTS[v]) throw new Error(`unknown variant ${v}; have ${Object.keys(VARIANTS).join(', ')}`);

  const bench = loadBench(tree);
  const base = runVariant(bench, VARIANTS.identity);
  const baseProducts = [...base.values()].filter(r => r.product).length;
  const baseR = [...base.values()].filter(r => r.rPeak != null).length;
  console.log(`bench: ${bench.assign.recv.length} receiving gauges, ${Object.keys(bench.rain).length} rain stations, ` +
    `axis ${bench.to - bench.from + 1} days`);
  console.log(`identity: ${baseProducts} gauges with a product, ${baseR} of them with a peak r`);

  // THE SELF-TEST, and it runs whether or not `identity` was asked for: the
  // variant machinery against a reference that never touches it. Comparing the
  // identity variant to `base` would be comparing it to itself.
  const ref = referenceRun(bench);
  const mismatched = [], setDiff = [];
  let rCompared = 0;
  for (const [no, r] of ref) {
    const b = base.get(no);
    if (!b) { setDiff.push(`${no}: missing from the variant run`); continue; }
    if (b.set.join(',') !== r.set.join(',')) setDiff.push(`${no}: ${b.set.length} vs ${r.set.length} members`);
    if (r.rPeak == null && b.rPeak == null) continue;
    rCompared++;
    if (r.rPeak == null || b.rPeak == null || Math.abs(r.rPeak - b.rPeak) > 1e-9) mismatched.push(`${no}: ${b.rPeak} vs ${r.rPeak}`);
  }
  // A CHECK THAT CANNOT BE EMPTY. A tree whose `assign.recv` falls out empty —
  // a shifted siteNo column, a moved coordinate box, a topology.json that
  // parsed but held nothing — used to produce "0 gauges, 0 differences" and
  // exit 0, with variant rows printed under it out of nothing at all.
  const enough = ref.size >= MIN_SELF_TEST_GAUGES && rCompared >= MIN_SELF_TEST_R;
  const identityClean = mismatched.length === 0 && setDiff.length === 0 && enough;
  console.log(`self-test: the identity variant against an independent reading of the old rule — ` +
    `${ref.size} gauges (${rCompared} of them with a peak r on either side), ` +
    `${setDiff.length} with a different set, ${mismatched.length} with a different peak r` +
    (mismatched.length + setDiff.length ? `: ${[...setDiff, ...mismatched].slice(0, 5).join('; ')}` : ''));
  if (!enough) {
    console.log(`  !! too little to check: needs >= ${MIN_SELF_TEST_GAUGES} gauges and >= ${MIN_SELF_TEST_R} with a peak r — ` +
      'a self-test that passes on an empty tree checks nothing');
  }
  if (!identityClean) console.log('  !! the bench does not reproduce the rule it claims to — every number below is void');

  const dump = { tree, generated: new Date().toISOString(), baseline: { products: baseProducts, withR: baseR }, selfTest: { ok: identityClean, gauges: ref.size, withR: rCompared }, variants: {} };
  const baseNest = nesting(bench, base);
  for (const name of want) {
    const run = name === 'identity' ? base : runVariant(bench, VARIANTS[name]);
    const c = compare(bench, base, run, baseNest);
    console.log(row(name, c));
    dump.variants[name] = { opts: VARIANTS[name], ...c, deltas: c.deltas.map(x => ({ no: x.no, d: x.d, from: x.from, to: x.to })) };
  }
  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(dump, null, 1)); console.log(`wrote ${jsonOut}`); }
  // A failed self-test exits non-zero whatever was asked for — the numbers above
  // are void, and a bench that prints them under exit 0 is worse than none.
  if (!identityClean) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv);
