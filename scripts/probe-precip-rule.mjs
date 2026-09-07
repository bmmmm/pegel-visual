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
  for (const [no, g] of Object.entries(bench.nodes)) {
    const d = g.down == null ? null : String(g.down);
    if (!d || !run.has(no) || !run.has(d)) continue;
    const a = run.get(no), b = run.get(d);
    if (!a.product || !b.product) continue;
    const A = new Set(a.set), B = new Set(b.set);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    pairs.push({ identical: A.size === B.size && inter === A.size, j: inter / (A.size + B.size - inter) });
  }
  return { pairs: pairs.length, identical: pairs.filter(p => p.identical).length, jaccardMedian: median(pairs.map(p => p.j)) };
}

export function compare(bench, base, run) {
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
  return {
    compared: deltas.length, gained: gained.length, lost: lost.length, lostIds: lost,
    medianDelta: median(ds), meanDelta: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null,
    better, worse, z: n ? (better - n / 2) / Math.sqrt(n / 4) : null,
    withProduct: sizes.length, setMedian: median(sizes), setP90: p90(sizes),
    radius: outsideEquivalentRadius(bench, run), nesting: nesting(bench, run),
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

  const dump = { tree, generated: new Date().toISOString(), baseline: { products: baseProducts, withR: baseR }, variants: {} };
  let identityClean = null;
  for (const name of want) {
    const run = name === 'identity' ? base : runVariant(bench, VARIANTS[name]);
    const c = compare(bench, base, run);
    if (name === 'identity') {
      const off = c.deltas.filter(x => Math.abs(x.d) > 1e-12);
      identityClean = off.length === 0 && c.compared === baseR;
      console.log(`self-test: identity through the variant machinery — ${c.compared}/${baseR} gauges compared, ` +
        `${off.length} with a non-zero delta` + (off.length ? `: ${off.slice(0, 5).map(x => `${x.no} ${x.d}`).join(', ')}` : ''));
      if (!identityClean) console.log('  !! the bench does not reproduce the shipping rule — every number below is void');
    }
    console.log(row(name, c));
    dump.variants[name] = { opts: VARIANTS[name], ...c, deltas: c.deltas.map(x => ({ no: x.no, d: x.d, from: x.from, to: x.to })) };
  }
  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(dump, null, 1)); console.log(`wrote ${jsonOut}`); }
  if (want.includes('identity') && !identityClean) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv);
