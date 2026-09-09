#!/usr/bin/env node
// Bakes the HOURLY RESPONSE TIME of each LANUK NRW gauge out of the `nrw-hires`
// tree: how long after rain over the gauge's rain field the gauge itself moves.
// This is the one piece of hydrology the daily product cannot see — on a day
// axis the travel time is invisible (measured: 0 of 42 gauges show the far part
// of their set responding later than the near part).
//
//   nrw/hourly/lag.json    ONE file: id -> response class, plus the rule,
//                          the window, an input digest and the counts
//
// Usage (CI runs it after build-nrw-precip.mjs and before the gate):
//   node scripts/build-nrw-hourly-lag.mjs --tree nrw-branch/nrw --hires nrw-hires-branch/nrw-hires
//   node scripts/build-nrw-hourly-lag.mjs --tree nrw --hires nrw-hires --check   # writes nothing
//   … --report            the per-gauge diagnostics (r, h, n, wet, p) to stdout
//
// WHY ITS OWN SCRIPT, and not a key inside nrw/precip/<no>/response.json, which
// is where it obviously belongs. Three independent reasons, each fatal:
//   1. build-nrw-precip.mjs's Out.prune() walks nrw/precip/ and unlinks every
//      file it did not write itself; under --check the intruder lands in
//      `diffs` as `stale:` and N8(e) goes red. No second script may write there.
//   2. N8(e) proves "the committed precip bytes are a pure function of the
//      committed `nrw` tree". A second input tree makes that claim false. It is
//      not widened, it is left alone.
//   3. pages.yml mounts `nrw`, never `nrw-hires`, so the product has to land
//      INSIDE nrw/ or it never reaches a browser.
//
// MEMBERSHIP IS THE SHIPPED RULE, imported and never restated. The gauge's rain
// field here is precipMembers() under build-nrw-precip's own `RULE`, because the
// PRECIPITATION block directly above this one on the station plate draws exactly
// that field. A lag measured over a different field would put two definitions of
// "this gauge's rain" into two neighbouring blocks of one plate — which is what
// T.precipNotCatchment and T.precipNested exist to prevent. (25 km publishes 23
// gauges more and is still not on the table for that reason; if it is
// interesting, it is interesting for probe-precip-rule.mjs and the DAILY rule,
// on that rule's own criteria.)
//
// WHAT IS PUBLISHED, and what is deliberately withheld:
//   - published: the CLASS, one of three, and nothing else. Measured over 14
//     daily replay steps with a fixed window length, the number of gauges whose
//     published value changes per day is 14.6 for the raw peak lag in hours,
//     21.6 for r at one decimal, 75.6 for r at two — against a pre-registered
//     churn ceiling of ~10/day. Only the class label comes in under it (8.2,
//     7.1 with the permutation filter). The second `r` or `h` rides along "for
//     traceability", the file churns with 21-76 lines a day and breaks the very
//     criterion the classes were introduced for.
//   - withheld to stdout under --report: r, h, n, wet, p. CI keeps its logs for
//     90 days; the data branch keeps its history forever.
//
// AND THE FILE IS NOT MINIFIED. Every other product here writes
// JSON.stringify(obj) because nobody diffs a year shard. This is the one file
// whose DIFFABILITY is the acceptance criterion — 4 kB on one line has no diff
// granularity, git would report "whole file changed" every day, and the 8.2
// would describe nothing a human can see.
//
// ONE FILE, not 161. The churn yardstick is "how many VALUES move", not "how
// many files", so one file does not dodge the criterion — it only makes the
// diff readable. Per-gauge files fail additionally on their own content: carry
// the window or the digest and all 161 rewrite themselves daily; leave them out
// and each file points at a sibling for what it was made from.
//
// THE WINDOW ROLLS (63 days of high summer). Every number here is a statement
// about a window, never about the gauge — which is why the stability gate in
// scripts/probe-hourly-lag.mjs exists, and why the seasonal re-test is
// pre-registered in `note` rather than promised.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, pinnedNow, readJson, listDirs } from './lib/cli.mjs';
import {
  readTree, assignRain, buildUp, precipMembers, pearson, cmpNo,
  MIN_SET_FOR_SERIES, RULE, RULE_VERSION, PLAUSIBLE_MAX_MM_DAY,
} from './build-nrw-precip.mjs';

export const SCHEMA = 1;
const HOUR_MS = 36e5;

// ---------- the estimator, pre-registered ----------

export const MAX_LAG_H = 48;
// Floors as FRACTIONS of the window, not absolute counts. The stability gate in
// the probe estimates each HALF of the window separately, and an absolute floor
// tuned to the full window rejects every half — which would report "stable" by
// having nothing left to compare. That is exactly what the first run of the
// probe did (0 gauges estimable in both halves), and a gate that passes by
// emptiness is the failure mode the house rules name.
export const MIN_PAIR_FRAC = 0.30;
export const MIN_RAIN_HOUR_FRAC = 0.05;
export const RAIN_HOUR_MM = 0.1;

// ---------- the publication rule, version 1 (2026-09-08) ----------
//
// Three classes, not hours. The two halves of the window disagree by 8 h at the
// p90, so an hour is false precision — and it churns at 14.6 gauges a day
// against a ceiling of ~10. Three, not six and not two: measured over 14 replay
// steps, 3 classes churn at 8.6/day with 75.0 % class stability, 6 at 9.1/day
// with 67.9 % (which sits on the 2/3 floor), and 2 at 8.3/day with 82.1 % while
// saying almost nothing.
//
// [lo, hi] inclusive; a null `hi` is open-ended.
export const CLASSES = [[0, 1], [2, 8], [9, null]];
// A lag read off a correlation this weak is not a measurement. Independently
// argued, not fitted: it removes 54 of 222 gauges and it was set before the
// churn was counted.
export const MIN_PEAK_R = 0.25;
// The winner's curse is real here: the estimator takes a MAXIMUM over 49 lags
// with no correction. 99 deterministic rotations give a smallest attainable p of
// 1/100, which Benjamini-Hochberg at q = 0.05 over the whole fleet can actually
// use. TWELVE rotations cannot: the smallest p is then 1/13 = 0.077, so over 222
// gauges ~17 false positives are expected under the global null — a WEAKER
// filter than the r cut beside it. "163 of 168 significant" was not a statement
// 12 rotations could make.
export const ROTATIONS = 99;
export const FDR_Q = 0.05;
// The rotations need a guard band inside (0, span), for two reasons that both
// bite. A rotation by the window LENGTH is the identity — the first run of this
// filter reported 1.8 % significant instead of 87.8 % for exactly that. And
// weather autocorrelates on the synoptic scale: a rotation of 50 h can still
// line the same front up with the same flood, so a null built from near
// rotations is not a null. A week clears both, and it must exceed MAX_LAG_H by
// construction or a rotation would put real rain inside the searched lag range.
export const ROTATION_GUARD_H = 168;
// Bumped whenever anything above moves. The gate compares a run against HEAD,
// which is meaningless across a rule change; on a version change it demands
// PRE-REGISTERED numbers instead (LAG_RULE_BASELINES in the gate).
export const LAG_RULE_VERSION = 1;
// THE WINDOW IS BOUNDED HERE, and it has to be. The source offers a rolling 63
// days of fine resolution; the MIRROR only grows — the collector is run without
// any pruning lever on purpose, so a day that has rolled out of the source is
// kept forever. Read the window off the mirror's extent (which is what the
// measurement bench did) and it therefore grows by 24 h every day, silently,
// away from the 63 days every constant, every caveat and the shipped `note`
// were calibrated on. Measured on 2026-09-08: the mirror already reached back
// 66.5 days, four days past what the source still offered, and a doubling of
// the window costs ~43 published gauges — which walks the product towards
// MIN_HOURLY_PUBLISHED, and the gate that would then fire runs BEFORE both
// pushes, so the day's fine resolution would be lost rather than merely
// unpublished. The right edge rolls with the data; the left edge is derived
// from it, never from how much history the mirror happens to hold.
export const WINDOW_DAYS = 63;
export const WINDOW_H = WINDOW_DAYS * 24;
// Pre-registered on 2026-09-08, and it belongs in the FILE, not in anyone's
// memory: the window is 63 days of high summer. In February the estimator sees
// frontal rain, snow (which produces no response at any lag) and melt (which
// produces a response with no rain). The stability gate compared two halves of
// ONE summer window and can say nothing about that.
export const SEASONAL_RETEST = '2027-02';
// The stability gate's result, measured by scripts/probe-hourly-lag.mjs on
// 2026-09-08 (--split under the shipping RULE, on the bounded window): 29 of 38
// gauges agreed within ±3 h across the two halves. It rides in the FILE and onto
// the plate because it is the product's headline caveat — and the DENOMINATOR is
// the caveat, not the percentage. Measured: the first half of this window is
// dry. Mean wet hours per gauge are 26.8 in half A against 71.9 in half B, the
// wet-hour floor for a half is 38, and so 213 of 251 gauges are not estimable in
// half A at all. The split therefore compares a dry half against a wet one on
// the best-covered gauges only — 38 of 224 — and that is what 76.3 % describes.
// Constants, not recomputed here: the split is the probe's measurement, not this
// run's, and a number this file cannot check is better named than silently
// regenerated.
export const STABILITY_PCT = 76.3;
export const STABILITY_N = 38;
export const STABILITY_OF = 224;

// ---------- the hourly axis ----------


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

// Hourly rain over a set, on the same acceptance rule the daily product uses:
// below half the set reporting, the hour is a non-hour rather than a thinner mean.
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

// Peak cross-correlation of hourly rain against the hourly level CHANGE. The
// level change, not the level: a level series is dominated by its own slow
// baseline and would correlate with anything that has a trend.
//
// `code` rides beside `why` because the counts block has to add up in a file a
// diff is read on: the sentence carries the gauge's own numbers ("only 77 wet
// hours (needs 80)") and would churn every day if it were counted by message.
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
  // KNOWN AND CONSERVATIVE, stated rather than fixed: `minPairs` is applied to
  // the argmax lag AFTER the maximum is taken, not per lag before it. A single
  // thin lag with a spuriously high r can therefore win the argmax and then fail
  // the floor, withholding a gauge whose other lags were solid. The direction is
  // always "publish less", never "publish a worse number", and it does not fire
  // on the real mirror — `counts.noPeakWhy.pairs` is 0 there. Filtering per lag
  // first would be one line and a different product; it is not worth
  // re-registering every calibrated constant for a clause that never runs.
  if (!best || best.n < minPairs || wet < minWet || !(best.r > 0)) {
    return {
      h: null, r: null, n: best ? best.n : 0, wet,
      code: !best ? 'noPair' : wet < minWet ? 'wetHours' : best.n < minPairs ? 'pairs' : 'noPositiveLag',
      why: !best ? 'no pair'
        : wet < minWet ? `only ${wet} wet hours (needs ${minWet})`
          : best.n < minPairs ? `only ${best.n} pairs (needs ${minPairs})`
            : 'no positive lag',
    };
  }
  return { h: best.lag, r: Math.round(best.r * 1e4) / 1e4, n: best.n, wet, code: null };
}

// ---------- the bench: both trees, read once ----------

export function loadBench(tree, hires) {
  const { nodes, rain, manifest } = readTree(tree);
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
  // The right edge is read off the data; the left edge is WINDOW_H back from it,
  // never the mirror's own extent — see WINDOW_DAYS above for why that
  // difference is the whole point. `held` is kept so a caller can see how much
  // history was there to ignore.
  let lo = Infinity, hi = -Infinity;
  for (const no of haveRain) for (const h of rainOf(no).keys()) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const from = Number.isFinite(hi) ? Math.max(lo, hi - WINDOW_H + 1) : lo;
  return { nodes, rain, manifest, assign, up, rainOf, levelOf, from, to: hi, held: Number.isFinite(hi) ? hi - lo + 1 : 0 };
}

// Every gauge's inputs, computed ONCE: the rain field's hourly mean and the
// gauge's own hourly level. Separated from the estimate because the permutation
// filter runs the estimate a hundred times over inputs that do not move — the
// membership and the areal mean are the expensive half.
//
// A gauge that cannot be attempted says WHY. The daily product covers 275
// gauges; the hires tree is thinner (it carries the 15-minute series, not every
// station), and "not in nrw-hires" has to be a reading, not a silent skip.
export function gaugeInputs(bench, { from, to, opts = RULE, only = null } = {}) {
  const rows = [];
  for (const no of bench.assign.recv) {
    if (only && !only.has(no)) continue;
    const set = precipMembers(no, { nodes: bench.nodes, rain: bench.rain, assign: bench.assign, up: bench.up, ...opts });
    if (set.length < MIN_SET_FOR_SERIES) { rows.push({ no, skip: 'noDailySet', why: `only ${set.length} rain gauges in reach (needs ${MIN_SET_FOR_SERIES})` }); continue; }
    const series = set.map(s => bench.rainOf(s.no)).filter(m => m.size);
    if (series.length < MIN_SET_FOR_SERIES) { rows.push({ no, skip: 'notInHires', why: `only ${series.length} of ${set.length} rain gauges report hourly (needs ${MIN_SET_FOR_SERIES})` }); continue; }
    const level = bench.levelOf(no);
    if (!level.size) { rows.push({ no, skip: 'notInHires', why: 'this gauge has no hourly level series' }); continue; }
    rows.push({ no, nSet: set.length, nHires: series.length, areal: arealHourly(series, from, to), level });
  }
  return rows;
}

// `levelShift` rotates the level series against the rain by that many hours —
// the negative control, and the null distribution of the permutation filter.
// Zero is the real measurement.
//
// Only hours INSIDE [from, to] are rotated; anything the mirror holds outside
// the analysed window is dropped rather than folded into it.
//
// It used to rotate the whole level map, on a comment claiming that meant "1 of
// 1597" — the one hour before the window that lagStats reads for its first
// difference. Measured 2026-09-09 on the real mirror: the map holds a median of
// 1598 hours against a 1512 h window, so **85** of them sat outside it, not 1,
// and that slab grows by 24 h a day while the window stays fixed. Those hours
// carry a correctly-aligned rain/level relationship into the null, which is the
// one thing a null may not contain. It stayed invisible because the map
// iterates ascending and the gap-free in-window series overwrote the folded
// values — an invariant nobody stated, depending on insertion order, and true
// only while the series has no gaps.
//
// The cost is that the rotated map has no [from-1], so the null loses its first
// difference: 1511 pairs against the real measurement's 1512. That is the right
// direction to be wrong in — the null is slightly SMALLER, never contaminated.
export function rotateLevel(level, from, to, shift) {
  if (!shift) return level;
  const span = to - from + 1;
  const out = new Map();
  for (const [h, v] of level) {
    if (h < from || h > to) continue;
    out.set(from + (((h - from + shift) % span) + span) % span, v);
  }
  return out;
}

export function estimateAll(bench, { from, to, opts = RULE, levelShift = 0, only = null } = {}) {
  const out = new Map();
  for (const g of gaugeInputs(bench, { from, to, opts, only })) {
    if (g.skip) continue;
    const st = lagStats(g.areal, rotateLevel(g.level, from, to, levelShift), from, to);
    out.set(g.no, { no: g.no, nSet: g.nSet, nHires: g.nHires, ...st });
  }
  return out;
}

// ---------- the publication rule ----------

// Which class a peak lag falls into, or null if the classes do not cover it.
export function classOf(h, classes = CLASSES) {
  if (h == null) return null;
  for (let i = 0; i < classes.length; i++) {
    const [lo, hi] = classes[i];
    if (h >= lo && (hi == null || h <= hi)) return i;
  }
  return null;
}

// The rotation set. DETERMINISTIC by construction — a Math.random() here would
// silently kill the --check purity claim and look green for weeks.
//
// Evenly spread strictly inside [guard, span - guard]: the identity (a rotation
// by 0 or by the span) is unreachable, and no rotation lands near enough to the
// origin for the same weather system to line up with the same flood.
// ALL of them or NONE, and the distinctness is the reason. `hi > lo` alone is
// not enough: at a span of 337 the band is one hour wide and the formula below
// returns 99 shifts of which 2 are distinct — a null distribution with a
// hundredth of the draws it advertises, which no clause downstream could see
// because the count still read 99. Either the window carries the whole
// pre-registered rotation set or it carries no product at all.
export function rotationShifts(span, count = ROTATIONS, guard = ROTATION_GUARD_H) {
  const lo = guard, hi = span - guard;
  if (!(hi > lo) || count < 1) return [];
  const out = [];
  for (let k = 1; k <= count; k++) out.push(lo + Math.round((k * (hi - lo)) / (count + 1)));
  return new Set(out).size === count ? out : [];
}

// Benjamini-Hochberg at level q over m p-values: returns the set of indices that
// are rejected (i.e. significant). m is the number of gauges TESTED, which is
// every gauge with a peak — not the number that survived the r cut, or the
// correction would be computed over a set chosen by looking at the data.
export function benjaminiHochberg(ps, q = FDR_Q) {
  const m = ps.length;
  const ok = new Set();
  if (!m) return ok;
  const order = ps.map((p, i) => ({ p, i })).filter(x => x.p != null).sort((a, b) => a.p - b.p || a.i - b.i);
  let kMax = -1;
  for (let k = 0; k < order.length; k++) if (order[k].p <= ((k + 1) / m) * q) kMax = k;
  for (let k = 0; k <= kMax; k++) ok.add(order[k].i);
  return ok;
}

// The whole rule, in one place: estimate, rotate, correct, classify.
//
// The permutation p is (1 + #{rotations at least as strong}) / (1 + rotations),
// the standard bound that never reports p = 0 for a statistic drawn from a
// finite null.
export function publish(bench, {
  from, to, opts = RULE, only = null,
  classes = CLASSES, minR = MIN_PEAK_R, rotations = ROTATIONS, q = FDR_Q, guard = ROTATION_GUARD_H,
  permute = true,
} = {}) {
  const shifts = permute ? rotationShifts(to - from + 1, rotations, guard) : [];
  // A window too short to rotate safely produces NO rotations, and then every
  // gauge that reached a peak would be marked significant and `notSignificant`
  // would read 0 — a filter that silently stopped filtering, under a file still
  // claiming 99 rotations. Refuse instead: there is no product to make here.
  if (permute && !shifts.length) {
    throw new Error(`a ${to - from + 1} h window cannot carry ${rotations} rotations outside a ${guard} h guard band — no permutation filter means no product`);
  }
  const rows = [];
  for (const g of gaugeInputs(bench, { from, to, opts, only })) {
    if (g.skip) { rows.push({ no: g.no, skip: g.skip, why: g.why }); continue; }
    const st = lagStats(g.areal, g.level, from, to);
    const row = { no: g.no, nSet: g.nSet, nHires: g.nHires, ...st, p: null, ge: null, rotations: shifts.length };
    if (st.h != null && shifts.length) {
      let ge = 0;
      for (const s of shifts) {
        const alt = lagStats(g.areal, rotateLevel(g.level, from, to, s), from, to);
        if (alt.r != null && alt.r >= st.r) ge++;
      }
      row.ge = ge;
      row.p = (1 + ge) / (1 + shifts.length);
    }
    rows.push(row);
  }

  // The correction runs over every gauge that produced a peak — the whole family
  // of tests actually performed.
  const tested = rows.filter(x => !x.skip && x.h != null);
  const sig = shifts.length ? benjaminiHochberg(tested.map(x => x.p), q) : null;
  tested.forEach((x, i) => { x.significant = sig ? sig.has(i) : true; });

  const gauges = {};
  const counts = {
    daily: 0, notInHires: 0, noDailySet: 0, attempted: 0, withPeak: 0, noPeak: 0,
    weak: 0, notSignificant: 0, published: 0,
    noPeakWhy: { wetHours: 0, pairs: 0, noPositiveLag: 0, noPair: 0 },
    byClass: classes.map(() => 0),
  };
  for (const x of rows) {
    counts.daily++;
    if (x.skip) { counts[x.skip]++; continue; }
    counts.attempted++;
    if (x.h == null) {
      counts.noPeak++;
      if (counts.noPeakWhy[x.code] != null) counts.noPeakWhy[x.code]++;
      continue;
    }
    counts.withPeak++;
    if (!(x.r >= minR)) { x.reject = 'weak'; counts.weak++; continue; }
    if (!x.significant) { x.reject = 'notSignificant'; counts.notSignificant++; continue; }
    const c = classOf(x.h, classes);
    if (c == null) { x.reject = 'unclassed'; continue; }   // classes that do not cover the search range
    gauges[x.no] = c;
    counts.byClass[c]++;
    counts.published++;
  }
  return { rows, gauges, counts, shifts };
}

// Why a gauge has no class, in the product's OWN words — so a check can compare
// the plate against this file instead of against a string it also knows.
export function reasonFor(row, { minR = MIN_PEAK_R } = {}) {
  if (!row) return 'this gauge is not in the hourly product';
  if (row.skip) return row.why;
  if (row.h == null) return row.why;
  if (!(row.r >= minR)) return `the rain explains too little of this gauge's movement (peak r ${row.r.toFixed(2)}, needs ${minR})`;
  if (!row.significant) return 'the peak does not survive a rotation test against chance';
  return 'no response class for this gauge';
}

// ---------- the input digest ----------

// NOT a commit SHA, and that is not a nicety: this runs BEFORE either push, the
// `nrw` push can land while the `nrw-hires` push fails, and at build time no
// hires SHA exists at all. A SHA filled in afterwards could name a commit that
// never existed. The digest is over the bytes that were actually read.
//
// rain/ and gauges/ only — temp/ and raw/ are not inputs, and a temperature
// shard moving must not churn this file.
export function hiresFiles(hires) {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.name.endsWith('.json')) out.push({ path: p, rel: r });
    }
  };
  for (const kind of ['gauges', 'rain']) walk(join(hires, kind), kind);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export function inputsDigest(hires) {
  const files = hiresFiles(hires);
  const h = createHash('sha256');
  for (const f of files) {
    const bytes = readFileSync(f.path);
    // path AND length before the bytes: without a length the concatenation is
    // ambiguous and two different trees could hash the same
    h.update(`${f.rel}\0${bytes.length}\0`);
    h.update(bytes);
  }
  return { sha256: h.digest('hex'), files: files.length };
}

// ---------- writing ----------

// Hour resolution, but a string Date.parse can actually read: "2026-09-08T03Z"
// is not a valid Date Time String and every later reader — the gate's freshness
// clause, the plate's age line — would get NaN out of it.
const iso = h => new Date(h * HOUR_MS).toISOString().slice(0, 13) + ':00Z';

class Out {
  constructor(root, check) {
    // The fence is on the directory NAME, the same one build-nrw-precip.mjs
    // carries: a stray --out must not drop a lag.json into the mirror's root,
    // where nothing would ever prune it and N4 would carry it forever.
    const leaf = String(root).replace(/\/+$/, '').split('/').pop();
    if (leaf !== 'hourly') throw new Error(`refusing to write to ${root}: an output directory must be named "hourly"`);
    this.root = root; this.check = check; this.diffs = []; this.changed = 0;
  }
  put(rel, text) {
    const path = join(this.root, rel);
    const old = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (old === text) return;
    if (this.check) { this.diffs.push(old === null ? `missing: ${rel}` : `differs: ${rel}`); return; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    this.changed++;
  }
}

// The universe: the gauges the DAILY product actually ships a rain field for.
// Reading it out of the manifest rather than recomputing it keeps the two
// products on one membership — `manifest.precip[no].series` is the same flag the
// browser reads before it asks for a shard.
export function dailyGauges(manifest) {
  const p = (manifest && manifest.precip) || {};
  return new Set(Object.keys(p).filter(no => p[no] && p[no].series === true));
}

export function buildHourlyLag({ tree, hires, out, check = false, generated, bench = null }) {
  const b = bench || loadBench(tree, hires);
  if (!Number.isFinite(b.from)) throw new Error(`no hourly rain read under ${hires}/rain — wrong --hires path, or the shard shape changed`);
  const only = dailyGauges(b.manifest);
  if (!only.size) throw new Error(`no gauge in ${tree}/manifest.json carries precip.series — run scripts/build-nrw-precip.mjs first`);
  const r = publish(b, { from: b.from, to: b.to, only });
  // `unclassed` is a row that reached a peak, cleared both filters and still got
  // no class, which only a `classes` list that does not cover the search range
  // can produce. It is counted so the gate's accounting identity closes without
  // a remainder nobody can name.
  const unclassed = r.rows.filter(x => x.reject === 'unclassed').length;

  const doc = {
    schema: SCHEMA,
    generated,
    // the membership, imported — never restated here
    ruleVersion: RULE_VERSION,
    lagRuleVersion: LAG_RULE_VERSION,
    rule: {
      classes: CLASSES, minR: MIN_PEAK_R,
      // what actually RAN, not the constant that was asked for: a file saying 99
      // while 0 rotations happened is the one way this filter can stop working
      // and still look like it is working
      rotations: r.shifts.length, fdrQ: FDR_Q,
      rotationGuardH: ROTATION_GUARD_H, maxLagH: MAX_LAG_H, windowDays: WINDOW_DAYS,
      minPairFrac: MIN_PAIR_FRAC, minRainHourFrac: MIN_RAIN_HOUR_FRAC, rainHourMm: RAIN_HOUR_MM,
    },
    window: { from: iso(b.from), to: iso(b.to), hours: b.to - b.from + 1 },
    inputs: inputsDigest(hires),
    counts: { ...r.counts, unclassed },
    // The product's headline caveat, in the FILE rather than in the display
    // layer: the plate prints it word for word, so a later reader cannot get
    // the class without it, and a browser check can compare the two.
    note: `a class describes this rolling ${WINDOW_DAYS}-day window of high summer, not the gauge. `
      + `Pre-registered: re-tested across the season in ${SEASONAL_RETEST}, and withdrawn below 2/3 class agreement across it. `
      + `Its two halves agree on ${STABILITY_PCT} % of gauges — but on only ${STABILITY_N} of ${STABILITY_OF}, because the first half is dry and most gauges cannot be estimated in it at all.`,
    gauges: Object.fromEntries(Object.keys(r.gauges).sort(cmpNo).map(no => [no, r.gauges[no]])),
  };

  const o = new Out(out, check);
  o.put('lag.json', JSON.stringify(doc, null, 1) + '\n');
  return { out: o, doc, held: b.held, ...r };
}

// ---------- CLI ----------

function main(argv) {
  const { flag, has } = parseArgs(argv.slice(2));
  const tree = flag('tree') || 'nrw';
  const hires = flag('hires') || 'nrw-hires';
  const out = flag('out') || join(tree, 'hourly');
  const check = has('check');
  const generated = pinnedNow().toISOString().slice(0, 10);

  const t0 = Date.now();
  const r = buildHourlyLag({ tree, hires, out, check, generated });
  const c = r.counts;
  console.log(`hourly lag: window ${r.doc.window.from} … ${r.doc.window.to} = ${(r.doc.window.hours / 24).toFixed(1)} days `
    + `of the ${(r.held / 24).toFixed(1)} the mirror holds, ${r.shifts.length} rotations`);
  console.log(`  ${c.daily} gauges with a daily rain field: ${c.notInHires} not in nrw-hires, ${c.attempted} attempted, ${c.withPeak} with a peak`);
  console.log(`  dropped: ${c.noPeak} no peak (${Object.entries(c.noPeakWhy).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), ${c.weak} peak r < ${MIN_PEAK_R}, ${c.notSignificant} not significant at q=${FDR_Q}`);
  console.log(`  published: ${c.published} — classes ${c.byClass.join(' / ')} (${CLASSES.map(([lo, hi]) => hi == null ? `${lo}+ h` : `${lo}-${hi} h`).join(', ')})`);
  console.log(`  inputs: ${r.doc.inputs.files} hires files, sha256 ${r.doc.inputs.sha256.slice(0, 16)}… (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  if (has('report')) {
    // The diagnostics the FILE deliberately does not carry — r, h, n, wet, p
    // churn 21-76 lines a day on the branch, and CI keeps its log for 90 days.
    console.log('\nno\tclass\th\tr\tn\twet\tp\tsig\tstate');
    for (const x of r.rows.sort((a, b) => cmpNo(a.no, b.no))) {
      const cls = r.gauges[x.no];
      console.log([x.no, cls == null ? '-' : cls, x.h ?? '-', x.r ?? '-', x.n ?? '-', x.wet ?? '-',
        x.p == null ? '-' : x.p.toFixed(3), x.significant == null ? '-' : x.significant ? 'y' : 'n',
        x.skip || x.reject || (cls == null ? 'unpublished' : 'published')].join('\t'));
    }
  }

  if (check) {
    if (r.out.diffs.length) {
      console.error(`--check: ${r.out.diffs.length} file(s) differ from the rule:`);
      for (const d of r.out.diffs) console.error(`  ${d}`);
      process.exit(1);
    }
    console.log('--check: tree matches the rule');
  } else {
    console.log(`  ${r.out.changed} file(s) written`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv);
