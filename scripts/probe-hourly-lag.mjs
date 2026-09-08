#!/usr/bin/env node
// The measurement bench for the ONE piece of hydrology the daily product cannot
// see: how many hours pass between rain over a gauge's set and the gauge
// reacting. NOT in CI, NOT deployed — it exists to decide whether stage 3 of
// .claude/plans/ may be built at all.
//
//   node scripts/probe-hourly-lag.mjs --tree /tmp/nrwtree/nrw --hires /tmp/nrwhires/nrw-hires
//   … --split      the stability gate: estimate each half of the window separately
//   … --churn 14   the churn gate: replay the last N daily windows, count rewrites
//   … --control    the negative control: rotate the level series against the rain
//   … --variant '{"localKm":null,"knnFloor":0}'   measure under a different rule
//
// IT PRINTS THE RULE IT USED, and that line is not decoration. This probe takes
// its membership from the shipping `RULE`, and on 2026-09-08 it was run BEFORE
// that constant was flipped to version 2 — so it measured the old thin sets,
// reached 28 gauges, and killed the stage at 64.3 % against a floor of 66.7 %.
// Re-run against the shipped rule on the same data: 81 gauges, 71.6 %, PASS.
// The verdict was an artefact of an input the output did not name.
//
// TWO GATES, both pre-registered, both able to kill the stage:
//   STABILITY  the two halves of the rolling window must agree within +/-3 h on
//              at least 2/3 of the gauges. A window that cannot reproduce its
//              own number across its own halves may not print one.
//   CHURN      replaying day-by-day, even a +/-3 h hysteresis may not rewrite
//              more than ~10 files a day. A product that churns cannot be diffed,
//              and this branch keeps its history forever.
//
// The hires window ROLLS (63 days). Everything here is therefore a statement
// about a window, never about the gauge — which is exactly why the stability
// gate exists.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readTree, assignRain, buildUp, precipMembers, pearson, median, cmpNo,
  MIN_SET_FOR_SERIES, RULE, MIN_COVERAGE_PCT, PLAUSIBLE_MAX_MM_DAY,
} from './build-nrw-precip.mjs';

const HOUR_MS = 36e5;
export const MAX_LAG_H = 48;
// Floors as FRACTIONS of the window, not absolute counts. The stability gate
// estimates each HALF of the window separately, and an absolute floor tuned to
// the full window rejects every half — which would report "stable" by having
// nothing left to compare. That is exactly what the first run of this probe did
// (0 gauges estimable in both halves), and a gate that passes by emptiness is
// the failure mode the house rules name.
export const MIN_PAIR_FRAC = 0.30;
export const MIN_RAIN_HOUR_FRAC = 0.05;
export const RAIN_HOUR_MM = 0.1;
export const STABILITY_TOL_H = 3;
export const STABILITY_MIN_FRAC = 2 / 3;
export const CHURN_MAX_PER_DAY = 10;

const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const listDirs = d => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; } };

// Every hires shard is { start, step, v[] } over a contiguous grid. Fold each
// onto one absolute hourly axis: a sub-hour series (Wupperverband samples every
// 15 min) is averaged into its hour for a level and SUMMED for rain, because
// rain is a quantity per interval and a level is a state.
export function hourlyAxis(dir, no, kind) {
  const d = join(dir, kind, no);
  const files = (() => { try { return readdirSync(d).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort(); } catch { return []; } })();
  const acc = new Map();
  for (const f of files) {
    const s = readJson(join(d, f));
    if (!s || !Array.isArray(s.v) || !s.step || !s.start) continue;
    const t0 = Date.parse(s.start);
    if (!Number.isFinite(t0)) continue;
    const per = 3600 / s.step;   // `step` is SECONDS: 3600 -> 1 sample/hour, 900 -> 4
    for (let i = 0; i < s.v.length; i++) {
      const x = s.v[i];
      if (x == null || !Number.isFinite(x)) continue;
      const h = Math.floor((t0 + i * s.step * 1000) / HOUR_MS);
      const cur = acc.get(h) || { sum: 0, n: 0, per };
      cur.sum += x; cur.n++; acc.set(h, cur);
    }
  }
  const out = new Map();
  for (const [h, c] of acc) {
    if (kind === 'rain') {
      // a partly reported hour is not an hour: 15-min rain needs all four slots
      if (c.per > 1 && c.n < c.per) continue;
      if (c.sum < 0 || c.sum > PLAUSIBLE_MAX_MM_DAY) continue;
      out.set(h, c.sum);
    } else {
      out.set(h, c.sum / c.n);
    }
  }
  return out;
}

// Areal hourly rain over a set, on the same acceptance rule the daily product
// uses: below half the set reporting, the hour is a non-hour rather than a
// thinner mean.
export function arealHourly(setSeries, from, to) {
  const need = Math.max(MIN_SET_FOR_SERIES, Math.ceil(0.5 * setSeries.length));
  const out = new Array(to - from + 1).fill(null);
  for (let h = from; h <= to; h++) {
    let sum = 0, n = 0;
    for (const m of setSeries) { const v = m.get(h); if (v != null) { sum += v; n++; } }
    if (n >= need) out[h - from] = sum / n;
  }
  return out;
}

// Peak cross-correlation of hourly areal rain against the hourly level CHANGE.
// The level change, not the level: a level series is dominated by its own slow
// baseline and would correlate with anything that has a trend.
export function lagStats(rain, level, from, to) {
  const len = to - from + 1;
  const dl = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const a = level.get(from + i), b = level.get(from + i - 1);
    if (a != null && b != null) dl[i] = a - b;
  }
  const wet = rain.filter(v => v != null && v >= RAIN_HOUR_MM).length;
  const minPairs = Math.ceil(MIN_PAIR_FRAC * len), minWet = Math.ceil(MIN_RAIN_HOUR_FRAC * len);
  const lags = [];
  for (let lag = 0; lag <= MAX_LAG_H; lag++) {
    const xs = [], ys = [];
    for (let i = 0; i < len; i++) {
      if (rain[i] == null) continue;
      const j = i + lag;
      if (j >= len || dl[j] == null) continue;
      xs.push(rain[i]); ys.push(dl[j]);
    }
    lags.push({ lag, r: pearson(xs, ys), n: xs.length });
  }
  let best = null;
  for (const l of lags) if (l.r != null && (best === null || l.r > best.r)) best = l;
  if (!best || best.n < minPairs || wet < minWet || !(best.r > 0)) {
    return {
      h: null, r: null, n: best ? best.n : 0, wet,
      why: !best ? 'no pair'
        : wet < minWet ? `only ${wet} wet hours (needs ${minWet})`
          : best.n < minPairs ? `only ${best.n} pairs (needs ${minPairs})`
            : 'no positive lag',
    };
  }
  return { h: best.lag, r: Math.round(best.r * 1e4) / 1e4, n: best.n, wet };
}

export function loadBench(tree, hires) {
  const { nodes, rain } = readTree(tree);
  const assign = assignRain(nodes, rain);
  const up = buildUp(nodes);
  const rainH = new Map(), levelH = new Map();
  const haveRain = new Set(listDirs(join(hires, 'rain')));
  const rainOf = no => {
    if (!rainH.has(no)) rainH.set(no, haveRain.has(no) ? hourlyAxis(hires, no, 'rain') : new Map());
    return rainH.get(no);
  };
  const levelOf = no => {
    if (!levelH.has(no)) levelH.set(no, existsSync(join(hires, 'gauges', no)) ? hourlyAxis(hires, no, 'gauges') : new Map());
    return levelH.get(no);
  };
  // the window the hires tree actually covers, read off the data
  let lo = Infinity, hi = -Infinity;
  for (const no of haveRain) for (const h of rainOf(no).keys()) { if (h < lo) lo = h; if (h > hi) hi = h; }
  return { nodes, rain, assign, up, rainOf, levelOf, from: lo, to: hi };
}

// `levelShift` rotates the level series against the rain by that many hours,
// for the negative control. Zero is the real measurement.
export function estimateAll(bench, { from, to, opts = RULE, levelShift = 0 } = {}) {
  const out = new Map();
  const span = to - from + 1;
  for (const no of bench.assign.recv) {
    const set = precipMembers(no, { nodes: bench.nodes, rain: bench.rain, assign: bench.assign, up: bench.up, ...opts });
    if (set.length < MIN_SET_FOR_SERIES) continue;
    const series = set.map(s => bench.rainOf(s.no)).filter(m => m.size);
    if (series.length < MIN_SET_FOR_SERIES) continue;
    let level = bench.levelOf(no);
    if (!level.size) continue;
    if (levelShift) {
      level = new Map([...level].map(([h, v]) => [from + (((h - from + levelShift) % span) + span) % span, v]));
    }
    const areal = arealHourly(series, from, to);
    const st = lagStats(areal, level, from, to);
    out.set(no, { no, nSet: set.length, nHires: series.length, ...st });
  }
  return out;
}

const iso = h => new Date(h * HOUR_MS).toISOString().slice(0, 13) + 'Z';

function main(argv) {
  const args = argv.slice(2);
  const flag = n => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`${n} needs a value`); return v; };
  const tree = flag('--tree') || 'nrw';
  const hires = flag('--hires') || 'nrw-hires';
  const variant = flag('--variant');
  const opts = variant ? JSON.parse(variant) : RULE;

  const bench = loadBench(tree, hires);
  if (!Number.isFinite(bench.from)) throw new Error(`no hourly rain read under ${hires}/rain — wrong --hires path, or the shard shape changed`);
  const days = (bench.to - bench.from + 1) / 24;
  console.log(`hires window ${iso(bench.from)} … ${iso(bench.to)} = ${days.toFixed(1)} days`);
  // The rule is an INPUT of every number below, so it is printed with them.
  console.log(`membership rule: ${JSON.stringify(opts)}${variant ? ' (--variant)' : ' (the shipping RULE)'}`);

  const full = estimateAll(bench, { from: bench.from, to: bench.to, opts });
  const ok = [...full.values()].filter(x => x.h != null);
  console.log(`full window: ${full.size} gauges attempted, ${ok.length} with a lag`);
  if (ok.length) {
    const hs = ok.map(x => x.h).sort((a, b) => a - b);
    console.log(`  lag h: min ${hs[0]}, median ${median(hs)}, p90 ${hs[Math.ceil(0.9 * hs.length) - 1]}, max ${hs[hs.length - 1]}`);
    console.log(`  r at peak: median ${median(ok.map(x => x.r)).toFixed(3)}`);
    // Two ways this estimator can print a number that is not one, both worth
    // seeing next to the medians rather than in a follow-up investigation.
    const edge = ok.filter(x => x.h >= MAX_LAG_H).length;
    const zero = ok.filter(x => x.h === 0).length;
    const weak = ok.filter(x => x.r < 0.25).length;
    console.log(`  at the search edge (${MAX_LAG_H} h): ${edge} — a maximum at the edge is a truncation, not a peak`);
    console.log(`  at lag 0: ${zero} (${(100 * zero / ok.length).toFixed(1)} %) — see --control before believing them`);
    console.log(`  peak r below 0.25: ${weak} (${(100 * weak / ok.length).toFixed(1)} %) — a lag off a correlation that weak is not a measurement`);
  }

  if (args.includes('--split')) {
    const mid = bench.from + Math.floor((bench.to - bench.from) / 2);
    const A = estimateAll(bench, { from: bench.from, to: mid, opts });
    const B = estimateAll(bench, { from: mid + 1, to: bench.to, opts });
    const both = [...A.keys()].filter(no => B.has(no) && A.get(no).h != null && B.get(no).h != null);
    const agree = both.filter(no => Math.abs(A.get(no).h - B.get(no).h) <= STABILITY_TOL_H);
    const frac = both.length ? agree.length / both.length : 0;
    console.log(`STABILITY: ${both.length} gauges estimable in both halves, ` +
      `${agree.length} agree within +/-${STABILITY_TOL_H} h = ${(100 * frac).toFixed(1)} %`);
    const diffs = both.map(no => Math.abs(A.get(no).h - B.get(no).h)).sort((a, b) => a - b);
    if (diffs.length) console.log(`  |A-B| median ${median(diffs)} h, p90 ${diffs[Math.ceil(0.9 * diffs.length) - 1]} h, max ${diffs[diffs.length - 1]} h`);
    console.log(`  gate: ${frac >= STABILITY_MIN_FRAC ? 'PASS' : 'FAIL'} (needs >= ${(100 * STABILITY_MIN_FRAC).toFixed(0)} %)`);
  }

  if (args.includes('--control')) {
    // THE NEGATIVE CONTROL. 40 % of the gauges put their response at lag 0, and
    // the only way to tell a very fast catchment from an artefact is to destroy
    // the timing and see whether the estimator still finds it. The level series
    // is ROTATED against the rain, so every marginal — values, variance, wet
    // hours, missingness — is untouched and only the alignment dies. Anything
    // that survives that is not a response time.
    //
    // This repo already knows why: the forecast gate's R5 exists because R1 can
    // insist on noise, and the 2026-09-07 run's shuffled control scored BETTER
    // than the real rain. An estimator without one is a hypothesis.
    const span = bench.to - bench.from + 1;
    const rows = [];
    for (const shift of [0, 601, 1009, 1511]) {
      const est = estimateAll(bench, {
        from: bench.from, to: bench.to, opts,
        levelShift: shift === 0 ? 0 : shift,
      });
      const ok2 = [...est.values()].filter(x => x.h != null);
      rows.push({ shift, n: ok2.length, zero: ok2.filter(x => x.h === 0).length, r: median(ok2.map(x => x.r)), h: median(ok2.map(x => x.h)) });
    }
    console.log(`CONTROL (level rotated against rain over a ${span} h window):`);
    for (const r of rows) {
      console.log(`  shift ${String(r.shift).padStart(4)} h: ${String(r.n).padStart(3)} with a lag, ` +
        `${String(r.zero).padStart(3)} at lag 0 (${(100 * r.zero / (r.n || 1)).toFixed(1)} %), median r ${r.r.toFixed(3)}, median lag ${r.h} h` +
        (r.shift === 0 ? '   <- the real thing' : ''));
    }
    const real = rows[0], fake = rows.slice(1);
    const worst = Math.max(...fake.map(x => x.r));
    console.log(`  gate: ${real.r > 2 * worst ? 'PASS' : 'FAIL'} — the real median r (${real.r.toFixed(3)}) ` +
      `${real.r > 2 * worst ? 'is more than double' : 'does NOT clear double'} the best shuffled one (${worst.toFixed(3)})`);
  }

  const churnDays = Number(flag('--churn') || 0);
  if (churnDays > 0) {
    // Replay the product as CI would write it: one estimate per day, over the
    // window that day would have had.
    const runs = [];
    for (let d = churnDays; d >= 0; d--) {
      const to = bench.to - d * 24;
      const from = bench.from;  // the window's left edge rolls too, but only the right edge moves within this tree
      runs.push({ day: iso(to).slice(0, 10), est: estimateAll(bench, { from, to, opts }) });
    }
    for (const tol of [0, 1, 2, 3]) {
      let rewrites = 0, transitions = 0;
      for (let i = 1; i < runs.length; i++) {
        const prev = runs[i - 1].est, cur = runs[i].est;
        for (const [no, c] of cur) {
          const p = prev.get(no);
          if (!p) continue;
          if (p.h == null && c.h == null) continue;
          transitions++;
          if (p.h == null || c.h == null || Math.abs(p.h - c.h) > tol) rewrites++;
        }
      }
      const perDay = rewrites / (runs.length - 1);
      console.log(`CHURN +/-${tol} h: ${rewrites} rewrites over ${runs.length - 1} day steps = ${perDay.toFixed(1)}/day ` +
        `(of ${(transitions / (runs.length - 1)).toFixed(0)} gauges) — ${perDay <= CHURN_MAX_PER_DAY ? 'PASS' : 'FAIL'} (ceiling ${CHURN_MAX_PER_DAY}/day)`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv);
