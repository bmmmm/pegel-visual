#!/usr/bin/env node
// The negative control for `risePer10mm`, the event-rise estimator of the
// station plate's RESPONSE block. NOT in CI, NOT deployed: it exists so a
// number that is printed on every plate can be shown to say something about
// the gauge and not about its own construction.
//
//   node scripts/probe-response-null.mjs                 # the shipped estimator
//   node scripts/probe-response-null.mjs --variant peak  # rise at the gauge's own peakLag
//   node scripts/probe-response-null.mjs --variant lag1  # rise at a fixed lag of one day
//   node scripts/probe-response-null.mjs --variant null  # printed only above its own permutation null
//   node scripts/probe-response-null.mjs --all
//
// IT IMPORTS THE SHIPPING ESTIMATOR — `responseStats` — and never restates it.
// The variants are selected by its own `eventLag` option or wrap it (the
// permutation null calls it on shuffled rain); no copy of the event loop
// lives here.
//
// THE SETUP: 200 trials. Rain is white, round(U * 20) mm per day, so ~half the
// days clear the 10 mm event threshold. The level is a random walk that never
// reads the rain — level[i] = level[i-1] + (U - 0.5) * 2. Whatever the
// estimator prints on this input is what it prints on nothing.
//
// PRE-REGISTERED CRITERION (2026-09-09, before the first run): an estimator
// that is not sign-biased on noise prints a POSITIVE rise in at most 55 % of
// the trials — the 95 % one-sided binomial bound at p = 0.5, n = 200 is
// 56 %. Above that, the sign the plate prints is the estimator's, not the
// catchment's. Exit 1 when the shipped estimator fails; the variants only
// report.
//
// First run (audit finding A3): the shipped 'max' estimator, a maximum over
// four lag candidates, had to FAIL here — a maximum of four zero-mean draws
// is positive most of the time — and the fix was chosen from the table this
// bench prints, not argued.
import { pathToFileURL } from 'node:url';
import { responseStats } from './build-nrw-precip.mjs';
import { parseArgs } from './lib/cli.mjs';

export const TRIALS = 200;
export const N_DAYS = 500;
export const LIMIT_POSITIVE_PCT = 55;
export const NULL_PERMUTATIONS = 100;

// Numerical-recipes LCG, seeded per trial: every run of this bench is exact
export function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function trialInput(seed, n = N_DAYS) {
  const rnd = lcg(seed);
  const rain = Array.from({ length: n }, () => Math.round(rnd() * 20));
  const level = new Float64Array(n);
  level[0] = 100;
  for (let i = 1; i < n; i++) level[i] = level[i - 1] + (rnd() - 0.5) * 2;
  return { rain, level, rnd };
}

const stats = (rain, level, eventLag) =>
  responseStats(rain, level, { from: 0, to: rain.length - 1, id: 'null', nRain: 5, unit: 'cm', eventLag });

function shuffled(xs, rnd) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// one number per trial, or null when the variant declines to print one
export const VARIANTS = {
  // the shipped estimator: the largest rise over lags 0..3 after each event
  max: ({ rain, level }) => stats(rain, level, 'max').events.risePer10mm,
  // the rise at the gauge's own peakLag alone — one lag per gauge, but that
  // lag is itself the maximum of eight correlations
  peak: ({ rain, level }) => stats(rain, level, 'peak').events.risePer10mm,
  // the rise at lag 1 for every gauge — a lag registered here, never chosen
  lag1: ({ rain, level }) => stats(rain, level, 1).events.risePer10mm,
  // the shipped number, printed only when it clears the 95th percentile of
  // the same estimator on NULL_PERMUTATIONS shuffles of the rain
  null: ({ rain, level, rnd }) => {
    const v = stats(rain, level, 'max').events.risePer10mm;
    if (v == null) return null;
    const nulls = [];
    for (let k = 0; k < NULL_PERMUTATIONS; k++) {
      const u = stats(shuffled(rain, rnd), level, 'max').events.risePer10mm;
      if (u != null) nulls.push(u);
    }
    nulls.sort((a, b) => a - b);
    const p95 = nulls[Math.min(nulls.length - 1, Math.floor(nulls.length * 0.95))];
    return v > p95 ? v : null;
  },
};

export function runVariant(name, trials = TRIALS) {
  const fn = VARIANTS[name];
  const values = [];
  let positive = 0, printed = 0;
  for (let t = 0; t < trials; t++) {
    const v = fn(trialInput(12345 + t));
    if (v == null) continue;
    printed++;
    if (v > 0) positive++;
    values.push(v);
  }
  values.sort((a, b) => a - b);
  const median = values.length ? values[Math.floor(values.length / 2)] : null;
  const pct = trials ? (positive / trials) * 100 : 0;
  return { name, trials, printed, positive, pct, median, pass: pct <= LIMIT_POSITIVE_PCT };
}

export const line = r => `${r.name.padEnd(5)} null-control: ${r.trials} trials · printed ${r.printed} · positive ${r.positive} (${r.pct.toFixed(1)} %)`
  + ` · median ${r.median == null ? '—' : (r.median >= 0 ? '+' : '') + r.median.toFixed(2)} · ${r.pass ? 'PASS' : 'FAIL'} (limit ${LIMIT_POSITIVE_PCT} %)`;

function main(argv) {
  const { flag, has } = parseArgs(argv.slice(2));
  const want = has('all') ? Object.keys(VARIANTS) : [flag('variant') || 'max'];
  let shippedFailed = false;
  for (const name of want) {
    if (!VARIANTS[name]) throw new Error(`unknown variant ${name}; one of ${Object.keys(VARIANTS).join(', ')}`);
    const r = runVariant(name);
    console.log(line(r));
    if (name === 'max' && !r.pass) shippedFailed = true;
  }
  return shippedFailed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv));
