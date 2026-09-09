#!/usr/bin/env node
// The measurement bench for the hourly response time. NOT in CI, NOT deployed —
// it exists to decide whether the product may be built and to keep deciding
// whether it may stay.
//
//   node scripts/probe-hourly-lag.mjs --tree /tmp/nrwtree/nrw --hires /tmp/nrwhires/nrw-hires
//   … --split      the stability gate: estimate each half of the window separately
//   … --churn 14   the churn gate: replay the last N daily windows, count rewrites
//   … --control    the negative control: rotate the level series against the rain
//   … --permute    the publication filter: 99 rotations + Benjamini-Hochberg
//   … --variant '{"localKm":null,"knnFloor":0}'   measure under a different rule
//
// IT IMPORTS THE SHIPPING ESTIMATOR from scripts/build-nrw-hourly-lag.mjs and
// never restates it — the same direction probe-precip-rule.mjs runs in. The
// other way round the probe would be de facto deployed while its own header
// claimed "NOT in CI, NOT deployed". What lives HERE is the gates and their
// pre-registered thresholds, and nothing else.
//
// IT PRINTS THE RULE IT USED, and that line is not decoration. This probe takes
// its membership from the shipping `RULE`, and on 2026-09-08 it was run BEFORE
// that constant was flipped to version 2 — so it measured the old thin sets,
// reached 28 gauges, and killed the stage at 64.3 % against a floor of 66.7 %.
// Re-run against the shipped rule on the same data: 81 gauges, 71.6 %, PASS.
// The verdict was an artefact of an input the output did not name.
//
// THE GATES, all pre-registered, each able to kill the stage:
//   STABILITY  the two halves of the rolling window must agree within +/-3 h on
//              at least 2/3 of the gauges. A window that cannot reproduce its
//              own number across its own halves may not print one.
//   CHURN      replaying day by day, the published product may not rewrite more
//              than ~10 values a day. A product that churns cannot be diffed,
//              and this branch keeps its history forever.
//   CONTROL    rotate the level against the rain and the signal must collapse.
//              An estimator without one is a hypothesis.
//
// The hires window ROLLS (63 days). Everything here is therefore a statement
// about a window, never about the gauge — which is exactly why the stability
// gate exists.
import { pathToFileURL } from 'node:url';
import { median, RULE } from './build-nrw-precip.mjs';
import {
  loadBench, estimateAll, publish, classOf, rotationShifts, dailyGauges,
  MAX_LAG_H, MIN_PEAK_R, CLASSES, ROTATIONS, FDR_Q,
} from './build-nrw-hourly-lag.mjs';
import { parseArgs } from './lib/cli.mjs';

const HOUR_MS = 36e5;
export const STABILITY_TOL_H = 3;
export const STABILITY_MIN_FRAC = 2 / 3;
export const CHURN_MAX_PER_DAY = 10;

const iso = h => new Date(h * HOUR_MS).toISOString().slice(0, 13) + 'Z';
const pct = (a, b) => `${(100 * a / (b || 1)).toFixed(1)} %`;

// The classes as a map id -> class, which is what the product ships and what the
// churn criterion counts. `estimateAll` gives hours; this gives published values.
const classMap = est => {
  const out = new Map();
  for (const [no, x] of est) {
    if (x.h == null || !(x.r >= MIN_PEAK_R)) continue;
    const c = classOf(x.h);
    if (c != null) out.set(no, c);
  }
  return out;
};

function main(argv) {
  const { flag, has } = parseArgs(argv.slice(2));
  const tree = flag('tree') || 'nrw';
  const hires = flag('hires') || 'nrw-hires';
  const variant = flag('variant');
  const opts = variant ? JSON.parse(variant) : RULE;

  const bench = loadBench(tree, hires);
  if (!Number.isFinite(bench.from)) throw new Error(`no hourly rain read under ${hires}/rain — wrong --hires path, or the shard shape changed`);
  const span = bench.to - bench.from + 1;
  const days = span / 24;
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
    const weak = ok.filter(x => x.r < MIN_PEAK_R).length;
    console.log(`  at the search edge (${MAX_LAG_H} h): ${edge} — a maximum at the edge is a truncation, not a peak`);
    console.log(`  at lag 0: ${zero} (${pct(zero, ok.length)}) — see --control before believing them`);
    console.log(`  peak r below ${MIN_PEAK_R}: ${weak} (${pct(weak, ok.length)}) — a lag off a correlation that weak is not a measurement`);
  }

  if (has('split')) {
    const mid = bench.from + Math.floor((bench.to - bench.from) / 2);
    const A = estimateAll(bench, { from: bench.from, to: mid, opts });
    const B = estimateAll(bench, { from: mid + 1, to: bench.to, opts });
    const both = [...A.keys()].filter(no => B.has(no) && A.get(no).h != null && B.get(no).h != null);
    const agree = both.filter(no => Math.abs(A.get(no).h - B.get(no).h) <= STABILITY_TOL_H);
    const frac = both.length ? agree.length / both.length : 0;
    console.log(`STABILITY: ${both.length} gauges estimable in both halves, ` +
      `${agree.length} agree within +/-${STABILITY_TOL_H} h = ${pct(agree.length, both.length)}`);
    const diffs = both.map(no => Math.abs(A.get(no).h - B.get(no).h)).sort((a, b) => a - b);
    if (diffs.length) console.log(`  |A-B| median ${median(diffs)} h, p90 ${diffs[Math.ceil(0.9 * diffs.length) - 1]} h, max ${diffs[diffs.length - 1]} h`);
    console.log(`  gate: ${frac >= STABILITY_MIN_FRAC ? 'PASS' : 'FAIL'} (needs >= ${(100 * STABILITY_MIN_FRAC).toFixed(0)} %)`);
    // The same halves read through the PUBLICATION rule: the product ships a
    // class, so what has to be stable is the class, not the hour. Smaller
    // denominator (the r cut applies in both halves), and that is the point —
    // it drops exactly the gauges whose hour was never a measurement.
    const ca = classMap(A), cb = classMap(B);
    const shared = [...ca.keys()].filter(no => cb.has(no));
    const same = shared.filter(no => ca.get(no) === cb.get(no));
    console.log(`  class agreement (${CLASSES.length} classes, r >= ${MIN_PEAK_R}): ${same.length}/${shared.length} = ${pct(same.length, shared.length)}`);
  }

  if (has('control')) {
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
    //
    // THE SHIFTS ARE DERIVED FROM THE SPAN, never written down — and that is a
    // repair, not a tidy-up. The list used to be [0, 601, 1009, 1511], picked
    // by hand for a 1597 h window. Against the bounded 1512 h one, 1511 is a
    // rotation by MINUS ONE HOUR: the identity in all but name. It duly
    // "survived" the shuffle at median r 0.261 with 34 % of gauges still at lag
    // 0, and the gate read FAIL — the control was measuring the real signal and
    // reporting it as noise. The publication filter already solves exactly this
    // with a guard band, so the control takes three of ITS rotations.
    const shifts = rotationShifts(span);
    if (!shifts.length) throw new Error(`a ${span} h window cannot carry a rotation set — the control cannot run`);
    const rows = [];
    for (const shift of [0, ...[0.25, 0.5, 0.75].map(q => shifts[Math.floor(shifts.length * q)])]) {
      const est = estimateAll(bench, { from: bench.from, to: bench.to, opts, levelShift: shift });
      const ok2 = [...est.values()].filter(x => x.h != null);
      rows.push({ shift, n: ok2.length, zero: ok2.filter(x => x.h === 0).length, r: median(ok2.map(x => x.r)), h: median(ok2.map(x => x.h)) });
    }
    console.log(`CONTROL (level rotated against rain over a ${span} h window):`);
    for (const r of rows) {
      console.log(`  shift ${String(r.shift).padStart(4)} h: ${String(r.n).padStart(3)} with a lag, ` +
        `${String(r.zero).padStart(3)} at lag 0 (${pct(r.zero, r.n)}), median r ${r.r.toFixed(3)}, median lag ${r.h} h` +
        (r.shift === 0 ? '   <- the real thing' : ''));
    }
    const real = rows[0], fake = rows.slice(1);
    const worst = Math.max(...fake.map(x => x.r));
    console.log(`  gate: ${real.r > 2 * worst ? 'PASS' : 'FAIL'} — the real median r (${real.r.toFixed(3)}) ` +
      `${real.r > 2 * worst ? 'is more than double' : 'does NOT clear double'} the best shuffled one (${worst.toFixed(3)})`);
  }

  if (has('permute')) {
    // The winner's curse, corrected — and the correction has to be able to do
    // work. 99 rotations, not 12: with 12 the smallest attainable p is 1/13,
    // over 222 gauges ~17 false positives are expected under the global null,
    // and the "filter" would be weaker than the r cut standing next to it.
    const shifts = rotationShifts(span);
    console.log(`PERMUTATION: ${shifts.length} deterministic rotations in [${shifts[0]}, ${shifts[shifts.length - 1]}] h of a ${span} h window, BH at q=${FDR_Q}`);
    const t0 = Date.now();
    const r = publish(bench, { from: bench.from, to: bench.to, opts, only: dailyGauges(bench.manifest) });
    const tested = r.rows.filter(x => !x.skip && x.h != null);
    const strong = tested.filter(x => x.r >= MIN_PEAK_R);
    console.log(`  ${tested.length} gauges tested, ${strong.length} over r ${MIN_PEAK_R}, ` +
      `${strong.filter(x => x.significant).length} of those significant after BH`);
    console.log(`  p: min ${Math.min(...tested.map(x => x.p)).toFixed(3)}, median ${median(tested.map(x => x.p)).toFixed(3)}, ` +
      `at the floor (${(1 / (shifts.length + 1)).toFixed(3)}): ${tested.filter(x => x.p <= 1 / (shifts.length + 1) + 1e-12).length}`);
    console.log(`  published: ${r.counts.published} — classes ${r.counts.byClass.join(' / ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }

  const churnDays = Number(flag('churn') || 0);
  if (churnDays > 0) {
    // Replay the product as CI would write it: one estimate per day, over the
    // window that day would have had.
    //
    // FIXED window length, not a growing one. The right edge rolls but so does
    // the left; the earlier form held `from` still, so day d back was estimated
    // over 63-d days and the earliest replays were the noisiest. Direction of
    // the error: conservative (8.6/day growing vs 8.2 fixed), but a replay whose
    // steps are not the same measurement is not a replay.
    const W = span - churnDays * 24;
    if (W < 24 * 14) throw new Error(`--churn ${churnDays} leaves only ${(W / 24).toFixed(1)} days per window`);
    const permute = !has('no-permute');
    const only = dailyGauges(bench.manifest);
    console.log(`CHURN: ${churnDays} day steps over a FIXED ${(W / 24).toFixed(1)}-day window${permute ? ', with the permutation filter' : ', WITHOUT the permutation filter'}`);
    const runs = [];
    for (let d = churnDays; d >= 0; d--) {
      const to = bench.to - d * 24, from = to - W + 1;
      const est = estimateAll(bench, { from, to, opts });
      const pub = publish(bench, { from, to, opts, only, permute });
      runs.push({ day: iso(to).slice(0, 10), est, cls: new Map(Object.entries(pub.gauges)), published: pub.counts.published });
      process.stderr.write(`  … ${runs[runs.length - 1].day}: ${pub.counts.published} published\r`);
    }
    process.stderr.write('\n');

    // The raw hour churn, on the criterion as it was originally written.
    for (const tol of [0, 3]) {
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
      console.log(`  raw hours +/-${tol} h: ${rewrites} rewrites over ${runs.length - 1} steps = ${perDay.toFixed(1)}/day ` +
        `(of ${(transitions / (runs.length - 1)).toFixed(0)} gauges) — ${perDay <= CHURN_MAX_PER_DAY ? 'PASS' : 'FAIL'}`);
    }

    // And the churn of what is actually WRITTEN: the class, per gauge, counting
    // a gauge that appears or disappears as a change, because both are a line in
    // the diff.
    const steps = [];
    for (let i = 1; i < runs.length; i++) {
      const prev = runs[i - 1].cls, cur = runs[i].cls;
      const ids = new Set([...prev.keys(), ...cur.keys()]);
      let n = 0;
      for (const no of ids) if (prev.get(no) !== cur.get(no)) n++;
      steps.push(n);
    }
    const perDay = steps.reduce((a, b) => a + b, 0) / steps.length;
    console.log(`  PUBLISHED CLASSES: ${steps.join(', ')}`);
    console.log(`  mean ${perDay.toFixed(1)}/day, median ${median(steps)}, max ${Math.max(...steps)}; published ${Math.min(...runs.map(r => r.published))}..${Math.max(...runs.map(r => r.published))}`);
    // The criterion judges the MEAN. Holding the single worst day against the
    // ceiling kills a stage that passes — the days scatter from 2 to 23.
    console.log(`  gate: ${perDay <= CHURN_MAX_PER_DAY ? 'PASS' : 'FAIL'} (ceiling ${CHURN_MAX_PER_DAY}/day, judged on the mean)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv);
