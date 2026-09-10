#!/usr/bin/env node
// Content-level consistency gate for the `nrw` data branch — the LANUK NRW
// mirror written by scripts/fetch-nrw-archive.mjs — run by nrw-update.yml
// after the collector and before the push. A sibling of
// check-archive-consistency.mjs, deliberately its own file: the `nrw` tree has
// a rolling two-year source window instead of closed years since 2000, a 07:00
// day boundary for rain, and a daily minimum derived from the 15-minute series
// rather than delivered. Mixed into archive/ it would put R1-R6 at risk for
// the whole WSV fleet; kept apart, each gate measures one contract.
//
//   N1 fleet size     registry.json >= 600 rows; >= 290 gauges, >= 300 rain
//                     gauges and >= 100 temperature stations carry data on
//                     disk; every gauge topology.json names has a meta.json
//                     and a year shard. Exact counts, never shares — an empty
//                     tree is red by construction.
//   N2 fleet edge     the newest stored gauge day is <= 3 days behind today
//                     (MEZ), and >= 90 % of the gauges reach the fleet edge
//                     minus 3. Three, not two: the export carries completed
//                     days only — on 2026-09-03 the whole fleet ended on 09-02,
//                     a two-day rule would have been born red.
//   N3 window depth   once the collection is a year old: median stored days
//                     over the trailing 730 >= 700 and >= 60 % of the gauges
//                     at >= 700. Younger than that it degrades to "the median
//                     stored span of the bulk gauges covers the span the
//                     source offered (manifest.window)" — red when the
//                     collector truncates a delivery, never red for youth.
//   N4 regression     against git HEAD: nothing deleted or renamed (unless
//                     --allow-prune, which CI never passes), no series slot
//                     goes non-null -> null (a fresh null never overwrites a
//                     stored value — that is what makes a truncated ZIP a
//                     no-op instead of a loss), `from` only sinks, `to` only
//                     rises, no manifest entry vanishes. Revised info / mw /
//                     mnw / mhw values are PRINTED, not refused: the operator
//                     revises them, and a silent swallow is the failure mode.
//   N5 shape          every shard names its own station and year, its arrays
//                     are daysInYear(y) long, levels sit inside the plausibility
//                     bounds, min <= mean <= max on every day, n in 1..288
//                     (53 gauges publish every 5 minutes), rain
//                     mm / imax >= 0, acc / cov in 0..100, temperature
//                     mean <= max — the rule a swapped column trips, which a
//                     3-column header over 4-field rows invites.
//   N6 alert stages   LANUV_Info_1/2/3 strictly increasing where present,
//                     partial triples legal (Weidenau2 has Info_1 only), and
//                     >= 110 gauges NRW-wide carry a full triple — the silent
//                     failure nothing else sees when the source drops the Info
//                     columns while every series keeps flowing.
//   N7 bulk coverage  manifest.coverage per product: the bulk COUNT at most
//                     3 % of the registry (in stations: 9.3 of 310) under the
//                     high-water mark's count, which only ever rises — a
//                     bare-number mark is a share and is compared as one;
//                     noSeries grows by <= 2 per run, successful single-station
//                     fetches fall by <= 5 per run, and registry >= bulk and
//                     >= station (the rain registry is the UNION of both
//                     station tables, neither is a superset of the other). The
//                     failure no other gate sees: the ZIP silently losing
//                     stations while every single series looks healthy.
//   N8 areal rain     the derived `precip/` product of build-nrw-precip.mjs.
//                     (a) shape: arrays daysInYear long, 0 <= mm <= the
//                     estimator's own PLAUSIBLE_MAX_MM_DAY (imported, never
//                     restated), 0 <= n <= |set|, and mean/median never above
//                     the day's own maximum — the one rule here that can catch
//                     the ESTIMATOR being wrong, since (e) recomputes with the
//                     same code; (b) `mm === null <=> n === 0`, and med/mx
//                     follow mm — the invariant that lets the plate draw a
//                     no-data column and the gate tell a thin day from a
//                     missing one; (c) MEMBERSHIP, three clauses since rule
//                     version 2 replaced the old single "one station, one
//                     owner" partition — membership is many-to-many now, and a
//                     partition test over it would simply be false: (c1) no
//                     station twice in ONE set (it would enter the mean twice
//                     while n and |set| both rise, so every other rule stays
//                     green); (c2) every member holds the bound its own `via`
//                     allows — basin <= maxAssignKm, orphan <= maxOrphanKm,
//                     local <= localKm, knn only in a set of exactly knnFloor
//                     and never past the rule's own knnMaxKm — all four bounds READ OUT
//                     OF index.json's own `rule` block, never restated here,
//                     and a `via` the rule does not enable is a violation;
//                     (c3) the HYDROLOGICAL origin is still a partition: a
//                     basin/orphan member names the same owning node `at` in
//                     every set it appears in; (c4) the REVERSE INDEX
//                     `precip/used-by/<rainNo>.json` is the same relation read
//                     backwards, so it is compared against the forward sets as
//                     a set, in BOTH directions and field for field
//                     (`name`/`via`/`km`/`at`; `at` is what makes `km`
//                     readable, since on a basin/orphan member it is the
//                     distance to the OWNING NODE and not to the gauge the
//                     entry names) — a second copy of a relation is a second
//                     chance to be wrong, and every other clause here reads
//                     only the forward side. (d) references
//                     resolve — every product gauge is in topology.json, every
//                     `set[].no` exists under `nrw/rain/`; (e) the committed
//                     bytes ARE what the rule produces, proven by running the
//                     builder in --check mode (writes nothing); (f)/(g)/(h)
//                     the three "how much reality is broken" counters may only
//                     drift by 2 against HEAD — bad coordinates, unassignable
//                     rain gauges, and the down-edge cycle, which must match
//                     HEAD in COUNT and in MEMBERS (a repaired cycle plus a new
//                     one elsewhere leaves the count at 2), and the list of rain
//                     stations that land in NO set may not grow; (i) floors, not
//                     shares: withSeries >= 260 and receivingNodes >= 260;
//                     (j) a RULE CHANGE does not get to move the counters
//                     quietly — when index.json's `rule.ruleVersion` differs
//                     from HEAD's, the drift comparison against HEAD is
//                     meaningless, so the gate demands the version's
//                     PRE-REGISTERED numbers from RULE_BASELINES instead. A
//                     bumped version with no entry is red; a bumped version
//                     whose numbers disagree with the entry is red.
//                     Measured 2026-09-08 under rule version 2: 298 routing
//                     nodes, 276 receiving (21 WSV relays + 1 Gauss-Krueger
//                     gauge excluded), rain 302 basin + 12 orphan + 5
//                     unassigned, 275 gauges with a series, 0 with no rain
//                     gauge in reach, 2 cyclic nodes, memberships 949 basin /
//                     45 orphan / 1406 local / 42 knn, 5 rain stations in no
//                     set at all.
//                     Three notes on the numbers, all measured, all surprising:
//                     the two Issel-registered rain gauges in the Eifel
//                     (55040051, 55048925 — 150 km from the nearest Issel
//                     gauge) take the ORPHAN path by construction, so the
//                     basin/orphan split is 302/12, not the 304/10 a reading
//                     that ignores MAX_ASSIGN_KM predicts. 275, not 276:
//                     3215510000100's three nearest rain gauges all report
//                     nothing, so three in reach can never make three
//                     REPORTING and the builder withdraws the product rather
//                     than advertise 1096 null days. And "every rain station
//                     lands in at least one set" is FALSE and cannot be made
//                     true — 42188260, 43170736 and 44206586 sit at 0/0,
//                     42182880 carries Gauss-Krueger coordinates, and
//                     44075066 (Bottrop-Eigen, Emscher) is 15.5 km from the
//                     nearest gauge of any basin, just past the 15 km ring.
//                     So the gate watches that list rather than asserting the
//                     wish.
//   N9 hourly lag    the derived `hourly/lag.json` of build-nrw-hourly-lag.mjs:
//                     ONE file mapping a gauge id onto a response CLASS.
//                     (a) it exists, is schema 1, and carries `window`, `rule`,
//                     `counts`, `gauges` plus BOTH versions — the presence of
//                     `lagRuleVersion`/`ruleVersion` is checked because without
//                     them clause (f) reads the same value on both sides and
//                     switches itself off, which is the mistake N8's own first
//                     cut made; (b) FRESHNESS — `window.to` is at most 48 h
//                     behind PEGEL_NOW and never in the future, `window.hours`
//                     >= 960 and equals the span the two stamps actually
//                     describe. This is the clause that makes a run which
//                     mirrors `nrw` without rebuilding the lag go red, and it
//                     needs no second tree to do it; (c) VOCABULARY — every
//                     value in `gauges` is a class id of `rule.classes` (never
//                     an hour, a null or free text), every key is a gauge in
//                     topology.json AND carries `manifest.precip[no].series`,
//                     and `counts.byClass` survives a recount; (d) FLOORS —
//                     published >= 100, the counts nest (published <= withPeak
//                     <= attempted <= daily), and no single class holds more
//                     than 90 % of the published gauges, because a three-class
//                     product collapsed onto one is not a product; (e) DRIFT
//                     against HEAD — at most 50 gauges change class, at most 20
//                     lose one, and the published count may not fall by more
//                     than 20; (f) a RULE CHANGE does not ride in on that
//                     allowance: when either version differs from HEAD's the
//                     gate demands LAG_RULE_BASELINES instead, keyed on BOTH
//                     versions because a membership bump moves these counts too;
//                     (g) the INPUT DIGEST over the hires tree matches the one
//                     the file was built with; (h) the committed bytes ARE what
//                     the rule produces, proven by re-running the builder in
//                     --check mode with the committed `generated` passed back in.
//                     (g) and (h) are the only two clauses that need the second
//                     data branch: without `--hires` they print a SKIPPED
//                     warning and the green summary line says "N9 partial", so a
//                     partial run can never be mistaken for a complete one.
//                     `hourly/` is deliberately NOT in N4's precip exception —
//                     the rain field may shrink, this product is one file that
//                     always exists, so a deletion is a regression and gets a
//                     second guard N9 knows nothing about.
//                     Measured 2026-09-08 on the bounded 63-day window: 275
//                     gauges with a rain field, 24 not in nrw-hires, 251
//                     attempted, 224 with a peak, 56 under r 0.25, 6 not clear
//                     of chance, 162 published as 101/49/12.
//
// Deliberate limits, as in the sibling gate: N4 compares against the branch's
// own HEAD, so a base poisoned by a force-push looks clean to it — branch
// protection plus N1-N3 stand against that. On the branch's very first run
// HEAD carries README + .gitignore only, every data file is status A, and N4
// has nothing to compare; N1-N3 and N5-N7 still measure the tree.
//
//   PEGEL_NOW=2026-09-04T12:00:00Z node scripts/check-nrw-consistency.mjs \
//       --tree nrw-branch/nrw --git nrw-branch \
//       [--hires nrw-hires-branch/nrw-hires] [--skip N3,N6] [--allow-prune]
//
// PEGEL_NOW pins the clock (N2 and N3 measure against today, MEZ) — required
// for a reproducible run against an older tree. Violations print as ::error::
// lines and the process exits 1; a green run prints one line with the measured
// fleet numbers.
//
// Calibration: the thresholds below were set from the 2026-09-04 measurements
// in the plan (617 registry rows, 302 gauges with data of 310, 313 rain, 108
// temperature, 130 gauges with Info_1). They are to be re-checked against the
// first real collector output — see the "calibrated against" note at the
// bottom of this header once that run exists.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, pinnedNow, readJson, listChanges, readHead } from './lib/cli.mjs';
import { checkChangeStatuses, dayNum } from './check-archive-consistency.mjs';
import { daysInYear, PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM } from './fetch-wsv-archive.mjs';
import { build as buildPrecip, PLAUSIBLE_MAX_MM_DAY } from './build-nrw-precip.mjs';
import { buildHourlyLag, inputsDigest } from './build-nrw-hourly-lag.mjs';
import { mezParts } from './snapshot-wsv.mjs';

const now = pinnedNow();

const { opt, has } = parseArgs();
// --skip N3[,N…]: for a caller that cannot act on a rule's finding
const SKIP = new Set(opt('skip', '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

// ---------- thresholds (named, exact, non-empty by construction) ----------

export const MIN_REGISTRY = 600;      // measured 617 (310 gauges + 308 climate, one carries both)
export const MIN_GAUGES = 290;        // measured 302 with data (254 bulk + 48 single-station)
export const MIN_RAIN = 300;          // measured 313 bulk (+ 6 single-station)
export const MIN_TEMP = 100;          // measured 108
export const MAX_EDGE_LAG_DAYS = 3;   // the export ends on the last COMPLETED day
export const EDGE_SHARE = 0.9;
export const EDGE_TOLERANCE_DAYS = 3;
export const WINDOW_DAYS = 730;
export const MIN_WINDOW_MEDIAN = 700;
export const MIN_WINDOW_SHARE = 0.6;
export const MATURE_AFTER_DAYS = 365; // before that N3 runs in its degraded form
// the source's window ends on the export day itself, a PARTIAL day most
// gauges do not carry (measured 2026-09-04: window.to 09-03, fleet on 09-02),
// and its first day is not guaranteed on every gauge either — two days of
// slack keep that from reading as a truncated delivery, a 364-day one still does
export const OFFERED_SPAN_SLACK_DAYS = 2;
// 288, not 96: the plan's 35..96 was measured on Erft/Sieg gauges, but 53 of
// the 254 bulk gauges (Wupper, Wupperverband) sample every FIVE minutes —
// 288 raw rows per day in pegel_messwerte.txt (Egerpohl, 2026-07-10), 200
// gauges at 96, 43 without a fine series in the 63-day window
export const MAX_SAMPLES_PER_DAY = 288;
// min comes out of the 15-minute samples, mean and max out of the source's own
// daily files (mean reproduced to 0.003 cm) — one rounding unit of slack keeps
// a 0.003 cm disagreement from reading as a swapped column
export const ORDER_EPS_CM = 0.01;
export const MIN_FULL_TRIPLES = 110;  // measured 130 gauges with Info_1
export const HIGH_WATER_SLACK = 0.03; // 3 percentage points
export const MAX_NO_SERIES_GROWTH = 2;
export const MAX_STATION_DROP = 5;
// N5 rain ceiling: not weather, a defect. Measured maximum in the mirror is
// 595.9 mm (39169741, 2026-06-30); the German record is 312 mm.
export const MAX_MM_DAY_RAW = 1000;
// N8 drift allowances — the counters of what is broken in the source may move,
// but not silently. Measured 2026-09-06: 1 bad-coordinate node, 5 unassignable
// rain gauges (4 coords + Bottrop-Eigen at 15.5 km), 2 cyclic nodes, 1 day over
// the areal plausibility bound.
export const MAX_BROKEN_DRIFT = 2;
export const MAX_BAD_COORDS_TOTAL = 8;   // 1 node + 4 rain gauges today
// Re-based in the same commit as rule version 2. It was 80 against a measured
// 94; under a rule that floors every reachable gauge to three rain gauges,
// 80 could not go red on anything short of the mirror vanishing. Measured 275
// of 276 receiving nodes on 2026-09-08 — the one gap is a gauge whose three
// nearest stations all report nothing, and the floor is set to catch the loss
// of a dozen more, not to leave room for the product to quietly halve.
export const MIN_PRECIP_SERIES = 260;    // measured 275 (was 80 against 94 under rule version 1)
export const MIN_RECEIVING_NODES = 260;  // measured 276
export const MAX_IMPLAUSIBLE_RAIN_DAYS = 3; // measured 1 (the 595.9 mm day)
// The knn floor's bound is the estimator's, imported like every other one: a
// gate with its own copy of a threshold goes red on legitimate output the day
// the rule moves. Measured maximum 29.05 km against a bound of 45.
// Pre-registered counts per rule version. A rule change makes the HEAD
// comparison meaningless — every drift counter reads as a regression on the
// run that ships it — so on a version change the gate compares against THESE
// instead. Registering them is the price of changing the rule; a bump without
// an entry here is red, and so is an entry that disagrees with the run.
export const RULE_BASELINES = {
  // measured 2026-09-08 on the `nrw` mirror of the 2026-09-07 export
  2: { withSeries: 275, receivingNodes: 276, rainUnassigned: 5, badCoordNodes: 1, cyclicNodes: 2, stationsInNoSet: 5 },
};
// Slack on a pre-registered baseline: the source moves between the run that
// registers the numbers and the run that first ships them. Two, the same
// allowance the HEAD drift comparison gives.
export const RULE_BASELINE_SLACK = 2;

// N9 hourly response — every one of these is calibrated on a measurement made
// on 2026-09-08 against the real mirror, and the obvious number would have been
// wrong in three of the five cases.
//
// PUBLISHED FLOOR. Measured over 21 distinct windows (six lengths from 40 to
// 66.5 days ending at the newest hour, plus a 15-step daily replay at a fixed
// 52.5-day window): 119 to 201. It does NOT fall with the window getting
// shorter — the short windows sit on the recent, wetter fortnight and publish
// MORE (201 at 40 days against 162 at 66.5) — so the floor cannot be derived
// from the window length and has to sit under the whole measured range. 120,
// the number this looked like it should be, goes red on the 119 window.
export const MIN_HOURLY_PUBLISHED = 100;      // 62 % of today's 162, under every window measured
// FRESHNESS. The hires export is ~24 h old by construction; 48 h leaves room
// for one late run and no more. This is the clause that makes a run which
// mirrors `nrw` without rebuilding the lag go red WITHOUT the hires tree.
export const MAX_HOURLY_WINDOW_LAG_H = 48;
// 40 days. Measured: the product still publishes 201 gauges at that length, so
// the floor is not cutting into a working regime — it is there to catch a
// collector that delivered a stump.
export const MIN_HOURLY_WINDOW_HOURS = 960;
// …and a CEILING, which the first cut of this clause did not have. The builder
// cuts the window to the source's own 63 rolling days; the MIRROR grows without
// limit, so "the builder stopped bounding the window" is a real failure mode and
// it moves this number UP, where a floor cannot see it. Two days of slack over
// the builder's own 1512 h, for a run that reads a shard stamped slightly wide.
export const MAX_HOURLY_WINDOW_HOURS = 63 * 24 + 48;
// Measured largest class share 63.0 % (at the longest window); 57-60 % at the
// others. A three-class product in which nine of ten readers see one class is a
// one-class product wearing a legend.
export const MAX_HOURLY_CLASS_SHARE = 0.9;
// CLASS DRIFT. Measured over 14 daily replay steps: 1, 6, 8, 29, 16, 2, 20, 2,
// 1, 4, 18, 4, 2, 6 — mean 8.5, median 5, MAXIMUM 29. The pre-registered churn
// criterion judges the mean; a single-run gate is a different statistic with a
// far wider spread, and a ceiling on the observed maximum goes red on a normal
// day. 50 is 1.7x the measured maximum and still 31 % of the whole product, so
// a builder bug or a smuggled rule change — which move hundreds — cannot pass.
export const MAX_HOURLY_CLASS_DRIFT = 50;
// Measured largest fall in published gauges over one day step: 5 (the steps run
// -1, -5, +1, +26, +13, +2, +18, +2, -1, +4, -3, +3, -1, +4). Four times that.
export const MAX_HOURLY_PUBLISHED_DROP = 20;
// Pre-registered counts per LAG rule version, the same construction as
// RULE_BASELINES above and for the same reason. Measured 2026-09-08 on the
// `nrw` f3277984 / `nrw-hires` d2ba38b6 mirrors.
// Keyed on BOTH versions joined, not on the lag version alone: the hourly
// product's counts move when the daily MEMBERSHIP rule moves too (that is the
// whole reason it imports it), so an entry registered under "1" would be
// consulted after a membership bump and compared against numbers measured for a
// different set of rain fields.
export const LAG_RULE_BASELINES = {
  '1.2': { daily: 275, attempted: 251, withPeak: 224, published: 162 },
};
// Thirty, not the two RULE_BASELINE_SLACK gives the daily product, and the
// difference is measured rather than generous: `published` is a STATISTIC over
// a rolling window, not a membership count, and one day of roll moved it by as
// much as 26 in the replay. A slack of two would make this clause born red on
// the first legitimate run and it would be skipped forever after.
export const LAG_RULE_BASELINE_SLACK = 30;

// series keys per product; the sparse per-day object rides alongside
export const PRODUCTS = {
  gauges: { keys: ['min', 'mean', 'max', 'n'], sparse: 'acc' },
  rain: { keys: ['mm', 'imax'], sparse: 'cov' },
  temp: { keys: ['mean', 'max'], sparse: null },
};
const KINDS = Object.keys(PRODUCTS);

// ---------- day arithmetic (absolute day numbers, MEZ day boundary) ----------

// a year-shard slot as an absolute day number — comparable across years
export const slotNum = (y, dayIdx) => dayNum(y, 1, dayIdx);
// a plain day or a full source stamp (`2024-09-04T00:00:00.000+01:00`): the
// date part IS the MEZ day, which is the calendar the shards are indexed in
export const isoDayNum = iso => Date.parse(`${String(iso ?? '').slice(0, 10)}T00:00:00Z`) / 864e5;
export const isoOfNum = n => new Date(n * 864e5).toISOString().slice(0, 10);
export function todayNum(nowDate) {
  const { y, m, dayIdx } = mezParts(nowDate);
  return dayNum(y, m, dayIdx);
}

const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = x => (x * 100).toFixed(1);

// a day counts as stored when the source's own daily values are there; `min`
// is derived (null on the seeded history) and never decides presence
export function hasDay(kind, doc, d) {
  if (!doc) return false;
  if (kind === 'rain') return doc.mm?.[d] != null;
  return doc.mean?.[d] != null || doc.max?.[d] != null;
}

// every stored day of one station across its year shards, ascending
export function storedDays(kind, shards) {
  const days = [];
  for (const [y, doc] of shards) {
    if (!doc || !Number.isFinite(y)) continue;
    const n = daysInYear(y);
    for (let d = 0; d < n; d++) if (hasDay(kind, doc, d)) days.push(slotNum(y, d));
  }
  return days.sort((a, b) => a - b);
}

// ---------- N1 fleet size ----------

export function checkFleetSize({ registryCount, gauges, rain, temp, topology }, {
  minRegistry = MIN_REGISTRY, minGauges = MIN_GAUGES, minRain = MIN_RAIN, minTemp = MIN_TEMP,
} = {}) {
  const v = [];
  if (!(registryCount >= minRegistry)) {
    v.push(`N1: registry.json lists ${registryCount} stations (min ${minRegistry})`);
  }
  const withData = map => [...map.values()].filter(s => s.days && s.days.length).length;
  for (const [kind, map, min] of [['gauges', gauges, minGauges], ['rain', rain, minRain], ['temp', temp, minTemp]]) {
    const n = withData(map);
    if (n < min) v.push(`N1: only ${n} ${kind} stations carry data on disk (min ${min})`);
  }
  const basins = topology && typeof topology.basins === 'object' ? topology.basins : null;
  if (!basins || !Object.keys(basins).length) {
    v.push('N1: topology.json missing or names no basin');
    return v;
  }
  for (const [no, basin] of Object.entries(basins)) {
    for (const g of basin.gauges || []) {
      const id = String(typeof g === 'object' && g ? (g.id ?? g.no) : g);
      const st = gauges.get(id);
      if (!st || !st.meta) v.push(`N1: topology basin ${no} names gauge ${id}, which has no gauges/${id}/meta.json`);
      else if (!st.shards.size) v.push(`N1: topology basin ${no} names gauge ${id}, which has no year shard`);
    }
  }
  return v;
}

// ---------- N2 fleet edge ----------

export function checkFleetEdge(gauges, nowDate, {
  maxLag = MAX_EDGE_LAG_DAYS, share = EDGE_SHARE, tolerance = EDGE_TOLERANCE_DAYS,
} = {}) {
  const last = [...gauges.values()].filter(s => s.days && s.days.length).map(s => s.days[s.days.length - 1]);
  if (!last.length) return ['N2: no gauge carries a single stored day — the fleet edge cannot be measured'];
  const edge = Math.max(...last);
  const lag = todayNum(nowDate) - edge;
  const v = [];
  if (lag > maxLag) {
    v.push(`N2: newest stored gauge day is ${isoOfNum(edge)}, ${lag} days behind today (max ${maxLag}) `
      + '— a stale export or a collector that stopped');
  }
  const atEdge = last.filter(x => x >= edge - tolerance).length / last.length;
  if (atEdge < share) {
    v.push(`N2: only ${pct(atEdge)}% of ${last.length} gauges reach the fleet edge ${isoOfNum(edge)} `
      + `minus ${tolerance} days (min ${pct(share)}%) — most of the fleet fell behind`);
  }
  return v;
}

// ---------- N3 window depth ----------

// the collection's age: from the oldest run on record, else the manifest stamp
export function collectionStart(runs, manifest) {
  const list = Array.isArray(runs) ? runs : (runs && Array.isArray(runs.runs) ? runs.runs : []);
  const stamps = list.map(r => Date.parse(r && r.at)).filter(Number.isFinite);
  if (stamps.length) return new Date(Math.min(...stamps));
  const gen = Date.parse(manifest && manifest.generated);
  return Number.isFinite(gen) ? new Date(gen) : null;
}

const srcOf = s => (s.meta && s.meta.src) ?? (s.entry && s.entry.src) ?? null;

// the offered window of one product: manifest.window.<kind> (the collector
// writes one per product, the gauges' day starts 00:00, the rain's 07:00), or
// a single manifest.window {from,to}
export function windowOf(manifest, kind) {
  const w = manifest && manifest.window;
  if (!w || typeof w !== 'object') return null;
  if (w[kind] && typeof w[kind] === 'object') return w[kind];
  return w.from != null && w.to != null ? w : null;
}

export function checkWindowDepth(gauges, { nowDate, window, collectionStart: start = null,
  windowDays = WINDOW_DAYS, minMedian = MIN_WINDOW_MEDIAN, minShare = MIN_WINDOW_SHARE,
  matureAfter = MATURE_AFTER_DAYS, spanSlack = OFFERED_SPAN_SLACK_DAYS,
} = {}) {
  const stations = [...gauges.values()].filter(s => s.days && s.days.length);
  if (!stations.length) return ['N3: no gauge carries a stored day — window depth cannot be measured'];
  const today = todayNum(nowDate);
  const ageDays = start ? (nowDate.getTime() - start.getTime()) / 864e5 : 0;
  const v = [];
  if (ageDays >= matureAfter) {
    const counts = stations.map(s => s.days.filter(n => n > today - windowDays && n <= today).length);
    const med = median(counts);
    const share = counts.filter(c => c >= minMedian).length / counts.length;
    if (med < minMedian) {
      v.push(`N3: median of ${med} stored days over the trailing ${windowDays} across ${counts.length} gauges (min ${minMedian})`);
    }
    if (share < minShare) {
      v.push(`N3: only ${pct(share)}% of ${counts.length} gauges hold >= ${minMedian} of the trailing ${windowDays} days (min ${pct(minShare)}%)`);
    }
    return v;
  }
  // young collection: the source offers a rolling window, and whatever it
  // offered must have been stored whole — a bulk gauge's stored span has to
  // reach the offered span (gaps inside it are the source's, a shorter span
  // is the collector's)
  if (!window || !Number.isFinite(isoDayNum(window.from)) || !Number.isFinite(isoDayNum(window.to))) {
    return ['N3: manifest.window missing or unparseable — a young collection is measured against the offered span'];
  }
  const offered = isoDayNum(window.to) - isoDayNum(window.from) + 1;
  const anySrc = stations.some(s => srcOf(s) != null);
  const bulk = anySrc ? stations.filter(s => srcOf(s) === 'bulk') : stations;
  if (!bulk.length) return ['N3: no gauge is marked src "bulk" — the offered span cannot be checked against anything'];
  const spans = bulk.map(s => s.days[s.days.length - 1] - s.days[0] + 1);
  const med = median(spans);
  if (med < offered - spanSlack) {
    v.push(`N3: median stored span of ${bulk.length} bulk gauges is ${med} days, the source offered ${offered} `
      + `(${String(window.from).slice(0, 10)}..${String(window.to).slice(0, 10)}, slack ${spanSlack}) `
      + '— the collector stored less than it was handed');
  }
  return v;
}

// ---------- N4 regression against HEAD ----------

export function checkRegressionStatuses(changes, allowPrune = false) {
  if (allowPrune) return [];
  // precip/ is DERIVED and may shrink: a gauge that drops below three upstream
  // rain gauges loses its files, and a product that kept history its inputs no
  // longer imply would be a promise, not a reading. N8's floors (withSeries,
  // receivingNodes) are what stops it shrinking to nothing.
  const mirrored = changes.filter(c => !/(^|\/)precip\//.test(c.path));
  return checkChangeStatuses(mirrored).map(m => m.replace(/^R4:/, 'N4:'));
}

// a changed year shard keeps every stored value: a slot goes non-null -> null
// only through a bug in the merge (a fresh null must never win)
export function compareSeries(kind, head, tree, path) {
  if (!head || typeof head.y !== 'number') return [];
  if (!tree || typeof tree.y !== 'number') return [`N4: ${path}: unreadable while HEAD had year ${head.y}`];
  const v = [];
  for (const k of PRODUCTS[kind].keys) {
    const h = Array.isArray(head[k]) ? head[k] : [];
    const t = Array.isArray(tree[k]) ? tree[k] : [];
    let lost = 0, first = -1;
    for (let i = 0; i < h.length; i++) {
      if (h[i] != null && t[i] == null) { lost++; if (first < 0) first = i; }
    }
    if (lost) v.push(`N4: ${path}: ${k}: ${lost} slot(s) went non-null -> null (first day index ${first}) — a stored value is never overwritten by a fresh null`);
  }
  return v;
}

const cmpEdge = (a, b) => (typeof a === 'number' && typeof b === 'number')
  ? a - b
  : (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

// `from` only ever sinks, `to` only ever rises (meta.json and manifest entries)
export function compareRange(head, tree, path) {
  if (!head || !tree) return [];
  const v = [];
  if (head.from != null && tree.from != null && cmpEdge(tree.from, head.from) > 0) {
    v.push(`N4: ${path}: from moved later (${head.from} -> ${tree.from}) — from only ever sinks`);
  }
  if (head.to != null && tree.to != null && cmpEdge(tree.to, head.to) < 0) {
    v.push(`N4: ${path}: to moved earlier (${head.to} -> ${tree.to}) — to only ever rises`);
  }
  return v;
}

// operator revisions of the characteristic values and alert stages — printed,
// never refused
export function metaRevisions(head, tree, path) {
  if (!head || !tree) return [];
  const notes = [];
  for (const k of ['mw', 'mnw', 'mhw']) {
    if (head[k] !== tree[k] && (head[k] != null || tree[k] != null)) notes.push(`${path}: ${k} ${head[k]} -> ${tree[k]}`);
  }
  if (JSON.stringify(head.info ?? null) !== JSON.stringify(tree.info ?? null)) {
    notes.push(`${path}: info ${JSON.stringify(head.info ?? null)} -> ${JSON.stringify(tree.info ?? null)}`);
  }
  return notes;
}

// the manifest never loses an entry and never narrows a range
export function compareManifest(head, tree, { allowPrune = false } = {}) {
  if (!head || !tree) return [];
  const v = [];
  for (const kind of KINDS) {
    for (const [id, he] of Object.entries(head[kind] || {})) {
      const te = (tree[kind] || {})[id];
      if (!te) {
        if (!allowPrune) v.push(`N4: manifest.json: ${kind}/${id} vanished from the manifest`);
        continue;
      }
      v.push(...compareRange(he, te, `manifest.json ${kind}/${id}`));
    }
  }
  return v;
}

// ---------- N5 shape + plausibility ----------

const isNum = x => typeof x === 'number' && Number.isFinite(x);

function checkSparse(obj, label, path, n) {
  if (obj == null) return [];
  if (typeof obj !== 'object' || Array.isArray(obj)) return [`N5: ${path}: ${label} is not a sparse day object`];
  let bad = 0, firstKey = null;
  for (const [k, val] of Object.entries(obj)) {
    const d = Number(k);
    if (!Number.isInteger(d) || d < 0 || d >= n || !isNum(val) || val < 0 || val > 100) { bad++; if (firstKey == null) firstKey = k; }
  }
  return bad ? [`N5: ${path}: ${label}: ${bad} entr(ies) outside day 0..${n - 1} / 0..100 %, first at key ${firstKey}`] : [];
}

export function checkShardShape(kind, doc, path, { id = null, y = null } = {}) {
  if (!doc || typeof doc.y !== 'number') return [`N5: ${path}: not a year shard`];
  const v = [];
  if (y != null && doc.y !== y) v.push(`N5: ${path}: names itself year ${doc.y}`);
  if (id != null && String(doc.id) !== String(id)) v.push(`N5: ${path}: names itself station ${doc.id}`);
  const n = daysInYear(doc.y);
  const spec = PRODUCTS[kind];
  for (const k of spec.keys) {
    if (!Array.isArray(doc[k]) || doc[k].length !== n) v.push(`N5: ${path}: ${k}.length != ${n} for ${doc.y}`);
  }
  const arr = k => (Array.isArray(doc[k]) ? doc[k] : []);
  // one line per finding kind, with the count and the first offending slot —
  // 40 lines of the same swapped column would drown every other rule
  const sweep = (label, pred) => {
    let c = 0, first = -1;
    for (let d = 0; d < n; d++) if (pred(d)) { c++; if (first < 0) first = d; }
    if (c) v.push(`N5: ${path}: ${label} on ${c} day(s), first at day index ${first}`);
  };
  const notNum = x => x != null && !isNum(x);
  if (kind === 'gauges') {
    const min = arr('min'), mean = arr('mean'), max = arr('max'), cnt = arr('n');
    const out = x => x != null && (!isNum(x) || x < PLAUSIBLE_MIN_CM || x > PLAUSIBLE_MAX_CM);
    sweep(`level outside ${PLAUSIBLE_MIN_CM}..${PLAUSIBLE_MAX_CM} cm or not a number`, d => out(min[d]) || out(mean[d]) || out(max[d]));
    sweep('min > mean', d => isNum(min[d]) && isNum(mean[d]) && min[d] > mean[d] + ORDER_EPS_CM);
    sweep('mean > max', d => isNum(mean[d]) && isNum(max[d]) && mean[d] > max[d] + ORDER_EPS_CM);
    sweep('min > max', d => isNum(min[d]) && isNum(max[d]) && min[d] > max[d] + ORDER_EPS_CM);
    sweep(`n outside 1..${MAX_SAMPLES_PER_DAY}`, d => cnt[d] != null && !(Number.isInteger(cnt[d]) && cnt[d] >= 1 && cnt[d] <= MAX_SAMPLES_PER_DAY));
    // a day with max but no mean is NOT a defect: the export's own partial
    // last day comes with a maximum (232 rows for 2026-09-03 in
    // pegel_tagesmaxima.txt) and no mean at all (0 rows) — so no rule here
  } else if (kind === 'rain') {
    const mm = arr('mm'), imax = arr('imax');
    // An upper bound as well as a lower one — but NOT the areal rule's 400 mm.
    // The mirror holds a real 595.9 mm/24h day (39169741, 2026-06-30) against a
    // German record of 312 mm, so a 400 mm rule here would be red from birth,
    // and a rule that is born red is a rule that gets skipped. 1000 mm is not
    // weather in Germany under any circumstance; it is a sensor or a parser.
    // The areal builder drops everything over 400 from its mean (that is the
    // estimator's business), the mirror keeps the reading raw, and the growth
    // of the implausible stock is watched by N8 instead of forbidden here.
    const outMm = x => x != null && (!isNum(x) || x < 0 || x > MAX_MM_DAY_RAW);
    sweep(`mm outside 0..${MAX_MM_DAY_RAW} or not a number`, d => outMm(mm[d]));
    sweep('imax negative or not a number', d => imax[d] != null && (!isNum(imax[d]) || imax[d] < 0));
  } else {
    const mean = arr('mean'), max = arr('max');
    sweep('temperature not a number', d => notNum(mean[d]) || notNum(max[d]));
    // no mean <= max here, on purpose: the source's own products disagree for
    // Porta Westfalica (702705, Weser) — temp_tagesmaxima.txt carries a
    // 15-minute series stuck at 9.49 °C for 22 days in Oct 2024 while the
    // daily mean reads 11.4..12.6 °C. A rule that is red on a source defect
    // from day one is a rule that gets skipped; the mean/max shards stay as
    // delivered and the swapped-column guard lives on the gauges.
  }
  if (spec.sparse) v.push(...checkSparse(doc[spec.sparse], spec.sparse, path, n));
  return v;
}

export function checkMetaShape(kind, meta, path, id = null) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [`N5: ${path}: meta.json missing or not an object`];
  const v = [];
  if (id != null && meta.id != null && String(meta.id) !== String(id)) v.push(`N5: ${path}: names itself station ${meta.id}`);
  if (kind === 'gauges' && meta.info != null) {
    const ok = Array.isArray(meta.info) && meta.info.length <= 3 && meta.info.every(x => x == null || isNum(x));
    if (!ok) v.push(`N5: ${path}: info is not an array of up to three nullable numbers`);
  }
  return v;
}

// ---------- N6 alert stages ----------

export function checkAlertStages(gauges, { minFullTriples = MIN_FULL_TRIPLES } = {}) {
  const v = [];
  let full = 0;
  for (const [no, s] of gauges) {
    const info = s.meta && s.meta.info;
    if (!Array.isArray(info)) continue;
    const present = info.filter(x => x != null);
    if (present.length >= 3) full++;
    for (let i = 1; i < present.length; i++) {
      if (!(present[i] > present[i - 1])) {
        v.push(`N6: gauges/${no}/meta.json: info ${JSON.stringify(info)} is not strictly increasing`);
        break;
      }
    }
  }
  if (full < minFullTriples) {
    v.push(`N6: only ${full} gauges carry a full Info_1 < Info_2 < Info_3 triple (min ${minFullTriples}) `
      + '— did the source drop its alert-stage columns?');
  }
  return v;
}

// ---------- N7 bulk coverage ----------

// the high-water mark. The collector stores it as {bulk, bulkPct, station}
// (measured 2026-09-04: gauges {254, 81.9, 48}); a bare number is accepted
// too (a share, above 1 read as percent), or an object's .ratio. Returns
// { ratio, bulk } — `bulk` is the count when the mark carries one, else null.
export function highWaterMark(hw, registry = null) {
  let ratio = null, bulk = null;
  if (hw && typeof hw === 'object') {
    if (isNum(hw.bulk)) bulk = hw.bulk;
    if (isNum(hw.ratio)) ratio = hw.ratio;
    else if (isNum(hw.bulkPct)) ratio = hw.bulkPct / 100;
    else if (bulk != null && registry > 0) ratio = bulk / registry;
  } else if (isNum(hw)) {
    ratio = hw;
  }
  if (ratio != null && ratio > 1) ratio /= 100;
  if (ratio != null && ratio < 0) ratio = null;
  if (ratio != null) ratio = Math.round(ratio * 1e6) / 1e6; // 81.9 / 100 is 0.8190000000000001 in binary
  return ratio == null && bulk == null ? null : { ratio, bulk };
}
export const highWaterRatio = (hw, registry = null) => (highWaterMark(hw, registry) || {}).ratio ?? null;

// A mark that carries the bulk COUNT is compared in counts, not shares: the
// registry grows by discovery (on 2026-09-04 tier 2 found 17 water-temperature
// stations the ZIP never had, 108 -> 125, and the share fell 13.6 pp while the
// ZIP lost nothing), so a share against a count mark reads growth as loss. The
// slack is the same 3 % — of the registry, in stations. A bare-number mark
// (a share) keeps the share comparison.
export function checkCoverageMarks(tree, head = null, {
  slack = HIGH_WATER_SLACK, maxNoSeriesGrowth = MAX_NO_SERIES_GROWTH, maxStationDrop = MAX_STATION_DROP,
} = {}) {
  const cov = tree && tree.coverage;
  if (!cov || typeof cov !== 'object') return ['N7: manifest.coverage missing — bulk coverage cannot be measured'];
  const v = [];
  const ROUND = 0.005; // the collector may store the mark rounded
  for (const kind of KINDS) {
    const c = cov[kind];
    if (!c || typeof c !== 'object') { v.push(`N7: manifest.coverage.${kind} missing`); continue; }
    const registry = c.registry, bulk = c.bulk, station = c.station ?? 0, noSeries = c.noSeries ?? 0;
    if (!(registry > 0) || !isNum(bulk)) {
      v.push(`N7: coverage.${kind}: registry ${registry} / bulk ${bulk} — an empty registry cannot be covered`);
      continue;
    }
    if (bulk > registry || station > registry) {
      v.push(`N7: coverage.${kind}: bulk ${bulk} / station ${station} exceed registry ${registry} — the registry must be the union of every station table`);
    }
    const h = head && head.coverage && head.coverage[kind];
    const ratio = bulk / registry;
    const mark = highWaterMark(c.highWater, registry);
    const headMark = h ? highWaterMark(h.highWater, h.registry) : null;
    if (!mark) {
      v.push(`N7: coverage.${kind}.highWater missing — the mark is set on the first run and only ever raised`);
    } else if (mark.bulk != null) {
      if (headMark && headMark.bulk != null && mark.bulk < headMark.bulk) {
        v.push(`N7: coverage.${kind}.highWater.bulk sank ${headMark.bulk} -> ${mark.bulk} — the mark is only ever raised`);
      }
      if (mark.bulk < bulk) {
        v.push(`N7: coverage.${kind}.highWater.bulk ${mark.bulk} sits below the current bulk count ${bulk} — the mark is only ever raised`);
      }
      const maxUnder = slack * registry;
      if (mark.bulk - bulk > maxUnder) {
        v.push(`N7: coverage.${kind}: the bulk product carries ${bulk} of ${registry} registered stations, ${mark.bulk - bulk} under its `
          + `high-water mark ${mark.bulk} (max ${maxUnder.toFixed(1)}) — the ZIP is losing stations`);
      }
    } else {
      const hw = mark.ratio;
      if (ratio < hw - slack) {
        v.push(`N7: coverage.${kind}: bulk covers ${pct(ratio)}% of the registry, ${pct(hw - ratio)} pp under the `
          + `high-water mark ${pct(hw)}% (max ${pct(slack)} pp) — the ZIP is losing stations`);
      }
      if (hw < ratio - ROUND) {
        v.push(`N7: coverage.${kind}.highWater ${pct(hw)}% sits below the current share ${pct(ratio)}% — the mark is only ever raised`);
      }
      const hhw = headMark ? headMark.ratio : null;
      if (hhw != null && hw < hhw - ROUND) {
        v.push(`N7: coverage.${kind}.highWater sank ${pct(hhw)}% -> ${pct(hw)}% — the mark is only ever raised`);
      }
    }
    if (!h) continue;
    if (isNum(h.noSeries) && noSeries - h.noSeries > maxNoSeriesGrowth) {
      v.push(`N7: coverage.${kind}: noSeries grew ${h.noSeries} -> ${noSeries} in one run (max +${maxNoSeriesGrowth})`);
    }
    if (isNum(h.station) && h.station - station > maxStationDrop) {
      v.push(`N7: coverage.${kind}: successful single-station fetches fell ${h.station} -> ${station} in one run (max -${maxStationDrop})`);
    }
  }
  return v;
}

// ---------- tree loader ----------

export const isYearShard = name => /^\d{4}\.json$/.test(name);

// registry.json is "raw-near": a row array, or an object keyed by station_no,
// or {stations: …} — count rows whichever way it comes
// ---------- N8 areal rain ----------

// Structural rules over the committed precip tree. These hold even if the
// BUILDER is wrong — `--check` only proves "the bytes are what the generator
// makes today", which is a different claim from "the product is coherent".
export function checkPrecipShape(index, products, rainIds, topologyGauges, {
  // the estimator's own bound, imported rather than restated: a gate that keeps
  // its own copy of a threshold goes red on legitimate output the day the
  // estimator moves, or silent the day it tightens
  minSeries = MIN_PRECIP_SERIES, minReceiving = MIN_RECEIVING_NODES, maxMm = PLAUSIBLE_MAX_MM_DAY,
} = {}) {
  const v = [];
  if (!index || index.schema !== 1 || !index.counts || !index.gauges) return ['N8: precip/index.json missing, unparseable or not schema 1'];
  const c = index.counts;

  // (i) floors, exact counts — an empty product cannot pass
  if (!(c.withSeries >= minSeries)) v.push(`N8: precip: only ${c.withSeries} gauges carry a series, floor is ${minSeries}`);
  if (!(c.receivingNodes >= minReceiving)) v.push(`N8: precip: only ${c.receivingNodes} receiving nodes, floor is ${minReceiving}`);

  // (c) membership. Rule version 2 made this many-to-many, so the old single
  // "one station, one owner" partition is gone — it would now be false by
  // construction, and a check that cannot hold is worse than none. Three
  // clauses replace it, and each one has to be broken by hand and watched go
  // red before it is believed.
  //
  // The bounds come OUT of the product's own `rule` block. A gate that keeps a
  // second copy of a threshold goes red on legitimate output the day the rule
  // moves, and silent the day it tightens.
  const R = (index.rule || {});
  // Read out of the product, with NO fallback to the estimator's constant: a
  // `??` here would let a rule block that stopped publishing its own bound sail
  // past on the importer's value, which is the same "green because the field
  // vanished" failure as (j) below.
  const bound = {
    basin: R.maxAssignKm, orphan: R.maxOrphanKm,
    local: R.localKm ?? null, knn: R.knnFloor ? R.knnMaxKm : null,
  };
  if (R.knnFloor && R.knnMaxKm == null) v.push('N8: index.json rule enables a knn floor but publishes no knnMaxKm — the one membership with no bound of its own would then have none here either');
  // The builder writes `ruleVersion`; if it ever stops, clause (j) below reads
  // 1 on both sides, decides nothing changed, and switches itself off for good.
  // Nothing else would notice, so the field's PRESENCE is checked here.
  if (!(typeof R.ruleVersion === 'number' && R.ruleVersion >= 1)) {
    v.push(`N8: precip/index.json rule carries no ruleVersion — without it a rule change reads as no change and the pre-registered-counts clause can never fire (got ${JSON.stringify(R.ruleVersion)})`);
  }
  const ownerOf = new Map();
  for (const [no, p] of products) {
    if (!p.meta) { v.push(`N8: precip/${no}/meta.json: missing`); continue; }
    // (d) references
    if (topologyGauges && !topologyGauges[no]) v.push(`N8: precip/${no}: not a gauge in topology.json`);
    const seenHere = new Set();
    const set = p.meta.set || [];
    const hydro = set.filter(s => s.via === 'basin' || s.via === 'orphan').length;
    for (const s of set) {
      if (rainIds && !rainIds.has(String(s.no))) v.push(`N8: precip/${no}/meta.json: set names rain station ${s.no}, which has no nrw/rain/ directory`);
      // (c1) one set may not name a station twice. That is the double count —
      // it enters mean/med/mx twice while n and setSize both rise, so every
      // other rule stays green.
      if (seenHere.has(String(s.no))) v.push(`N8: precip/${no}/meta.json: rain station ${s.no} is in the set twice — it would be counted twice in the mean`);
      seenHere.add(String(s.no));

      // (c2) every member holds the bound its OWN via allows
      if (!(s.via in bound)) { v.push(`N8: precip/${no}/meta.json: rain station ${s.no} has via "${s.via}", which is not a way into a set`); continue; }
      if (bound[s.via] == null) { v.push(`N8: precip/${no}/meta.json: rain station ${s.no} arrived via "${s.via}", which this rule version does not enable`); continue; }
      if (!(typeof s.km === 'number' && s.km >= 0)) v.push(`N8: precip/${no}/meta.json: rain station ${s.no} carries no distance — a guess must not look like a measurement`);
      else if (s.km > bound[s.via] + 1e-9) v.push(`N8: precip/${no}/meta.json: rain station ${s.no} is ${s.km} km away via "${s.via}", over that via's bound of ${bound[s.via]} km`);
      // local and knn attach to the gauge itself; basin/orphan name the
      // upstream node that owns them
      if ((s.via === 'local' || s.via === 'knn') && String(s.at) !== String(no)) {
        v.push(`N8: precip/${no}/meta.json: rain station ${s.no} arrived via "${s.via}" but names ${s.at} as its node, not this gauge`);
      }
      // the floor fills a set to exactly knnFloor and fires ONLY where
      // everything else came up short — a knn member in a set that is already
      // big enough means the floor ran where it had no business running
      if (s.via === 'knn') {
        if (set.length !== R.knnFloor) v.push(`N8: precip/${no}/meta.json: the knn floor filled the set to ${set.length}, not to ${R.knnFloor}`);
        // Against knnFloor, NOT minSetForSeries: the builder fires the floor at
        // `members.size < knnFloor` (build-nrw-precip.mjs), and while the two
        // constants are both 3 today, reading the wrong one turns a legitimate
        // product red the moment they diverge — measured on a probe with
        // knnFloor 5 / minSetForSeries 3.
        const withoutKnn = set.length - set.filter(x => x.via === 'knn').length;
        if (!(R.knnFloor > 0)) v.push(`N8: precip/${no}/meta.json: a member arrived via "knn" but the rule publishes no knnFloor to have fired`);
        else if (withoutKnn >= R.knnFloor) v.push(`N8: precip/${no}/meta.json: the knn floor fired on a set that already had ${withoutKnn} members`);
      }
      // (c3) the hydrological origin is STILL a partition: basin/orphan
      // membership carries the one node that owns the station, and that node
      // must be the same in every set the station appears in
      if (s.via === 'basin' || s.via === 'orphan') {
        // A missing `at` used to make this clause blind: String(undefined) ===
        // String(undefined), so two gauges both claiming a station with no `at`
        // compared equal and the partition test returned nothing at all.
        if (s.at == null) { v.push(`N8: precip/${no}/meta.json: rain station ${s.no} arrived via "${s.via}" but names no owning node`); continue; }
        const prev = ownerOf.get(String(s.no));
        if (prev == null) ownerOf.set(String(s.no), String(s.at));
        else if (prev !== String(s.at)) v.push(`N8: rain station ${s.no} is owned by both ${prev} and ${s.at}`);
      }
    }
    const setSize = (p.meta.set || []).length;
    for (const [y, doc] of p.shards) {
      const path = `precip/${no}/${y}.json`;
      if (!doc || doc.y !== y || String(doc.id) !== String(no)) { v.push(`N8: ${path}: does not name itself`); continue; }
      const n = daysInYear(y);
      for (const k of ['mm', 'n', 'med', 'mx']) {
        if (!Array.isArray(doc[k]) || doc[k].length !== n) v.push(`N8: ${path}: ${k}.length != ${n}`);
      }
      const mm = doc.mm || [], cnt = doc.n || [], med = doc.med || [], mx = doc.mx || [];
      let bad = 0, inv = 0, cntBad = 0, sib = 0, order = 0, firstInv = -1, firstSib = -1, firstOrder = -1;
      for (let d = 0; d < n; d++) {
        // (a) shape
        if (mm[d] != null && (!isNum(mm[d]) || mm[d] < 0 || mm[d] > maxMm)) bad++;
        if (!(Number.isInteger(cnt[d]) && cnt[d] >= 0 && cnt[d] <= setSize)) cntBad++;
        // (b) the invariant the plate draws and the estimator relies on
        if ((mm[d] == null) !== (cnt[d] === 0)) { inv++; if (firstInv < 0) firstInv = d; }
        if ((mm[d] == null) !== (med[d] == null) || (mm[d] == null) !== (mx[d] == null)) { sib++; if (firstSib < 0) firstSib = d; }
        // (a) again, and this one is the only independent check on the estimator
        // itself: a mean above its own maximum is arithmetic that cannot happen,
        // whatever the rule. Without it, clause (e) recomputing with the SAME
        // builder is the only thing standing between a wrong mean and the branch.
        if (mm[d] != null && mx[d] != null && (mm[d] > mx[d] + 1e-9 || (med[d] != null && med[d] > mx[d] + 1e-9))) {
          order++; if (firstOrder < 0) firstOrder = d;
        }
      }
      if (bad) v.push(`N8: ${path}: mm outside 0..${maxMm} on ${bad} day(s)`);
      if (cntBad) v.push(`N8: ${path}: n outside 0..${setSize} on ${cntBad} day(s)`);
      if (inv) v.push(`N8: ${path}: mm null <=> n 0 violated on ${inv} day(s), first at day index ${firstInv}`);
      if (sib) v.push(`N8: ${path}: med/mx do not follow mm on ${sib} day(s), first at day index ${firstSib}`);
      if (order) v.push(`N8: ${path}: mean or median above the day's maximum on ${order} day(s), first at day index ${firstOrder}`);
    }
  }
  return v;
}

// The three counters of what is broken in the SOURCE. They are allowed to move
// — a station gets new coordinates, a new one arrives broken — but only by two
// per run, and the down-edge cycle count not at all: a third cycle is a
// topology change that has to be read before it is mirrored.
export function checkPrecipDrift(index, head, {
  maxDrift = MAX_BROKEN_DRIFT, maxBadCoords = MAX_BAD_COORDS_TOTAL,
  baselines = RULE_BASELINES, slack = RULE_BASELINE_SLACK,
} = {}) {
  const v = [];
  if (!index || !index.counts) return v;
  const c = index.counts, headCounts = head && head.counts ? head.counts : null;
  const coordsTotal = c.badCoordNodes + (index.unassigned || []).filter(u => u.why === 'coords').length;
  if (coordsTotal > maxBadCoords) v.push(`N8: ${coordsTotal} stations have unusable coordinates, ceiling is ${maxBadCoords}`);

  // (j) A RULE CHANGE MAY NOT RIDE IN ON ITS OWN DRIFT ALLOWANCE. Every counter
  // below is a comparison against HEAD, and on the run that changes the rule
  // that comparison says nothing: the numbers are SUPPOSED to move. So on a
  // version change the gate stops comparing against HEAD and demands the
  // version's pre-registered numbers instead. A bump with no entry is red, and
  // a bump whose numbers disagree with the entry is red — which is what keeps
  // "register the numbers" from meaning "write down whatever came out".
  // Read the SAME way on both sides. The first cut defaulted HEAD's version to
  // the current one when HEAD carried no `rule` block at all, which made the
  // two equal and switched this whole clause off — an index without a rule
  // block is version 1, exactly as it is for the index in hand.
  const verOf = ix => (ix && ix.rule ? ix.rule.ruleVersion ?? 1 : 1);
  const ver = verOf(index);
  const headVer = head ? verOf(head) : null;
  // A pre-registered baseline describes THIS mirror under THIS rule, so it is
  // only meaningful as "the run that moved the rule". Without a HEAD there is
  // no move to check and no drift to measure — a fresh branch, a fork or a
  // fixture tree must not be measured against the production mirror's counts.
  // The floors in checkPrecipShape are what stand there instead.
  const changed = headVer != null && ver !== headVer;
  if (changed) {
    const b = baselines[ver];
    if (!b) {
      v.push(`N8: rule version ${headVer} -> ${ver} with no pre-registered counts — add an entry to RULE_BASELINES in the same commit that moves the rule`);
    } else {
      for (const [k, want] of Object.entries(b)) {
        const got = c[k];
        if (typeof got !== 'number') v.push(`N8: rule version ${ver}: index.json has no numeric \`${k}\` to compare against the pre-registered ${want}`);
        else if (Math.abs(got - want) > slack) v.push(`N8: rule version ${ver}: ${k} is ${got}, pre-registered ${want} (slack ${slack}) — the rule change does not produce what was registered for it`);
      }
    }
  }
  // A rain station that lands in NO set at all is not forbidden — four have
  // unusable coordinates and one sits just past the ring — but the list may not
  // grow. This is the second half of "a station belongs to at least one gauge"
  // in the only form that can actually be true, and the only form that can go
  // red when the source moves a station.
  if (typeof c.stationsInNoSet === 'number') {
    const headNoSet = changed ? (baselines[ver] || {}).stationsInNoSet : headCounts ? headCounts.stationsInNoSet : null;
    if (typeof headNoSet === 'number' && c.stationsInNoSet > headNoSet + maxDrift) {
      v.push(`N8: rain stations in no set at all ${headNoSet} -> ${c.stationsInNoSet}, drift over ${maxDrift} (${(c.stationsInNoSetIds || []).join(', ')})`);
    }
  }

  const h = changed ? null : headCounts;
  if (h) {
    if (c.badCoordNodes > h.badCoordNodes + maxDrift) v.push(`N8: badCoordNodes ${h.badCoordNodes} -> ${c.badCoordNodes}, drift over ${maxDrift}`);
    if (c.rainUnassigned > h.rainUnassigned + maxDrift) v.push(`N8: rainUnassigned ${h.rainUnassigned} -> ${c.rainUnassigned}, drift over ${maxDrift}`);
    if (c.cyclicNodes !== h.cyclicNodes) v.push(`N8: cyclicNodes ${h.cyclicNodes} -> ${c.cyclicNodes} — a changed cycle set is read, not mirrored`);
    // the members, not the count: a repaired cycle plus a new one elsewhere
    // leaves the number at 2 and would slip past
    else if (Array.isArray(c.cyclicIds) && Array.isArray(h.cyclicIds) && c.cyclicIds.join(',') !== h.cyclicIds.join(',')) {
      v.push(`N8: the cycle members changed: ${h.cyclicIds.join(',')} -> ${c.cyclicIds.join(',')}`);
    }
  }
  if (c.cyclicNodes > 2) v.push(`N8: ${c.cyclicNodes} cyclic nodes, the known set is 2 (Erkrath <-> Eigen)`);
  return v;
}

// How many raw rain days sit above the areal plausibility bound. Not forbidden
// (the mirror is raw), but a growing stock is a source or parser change.
export function checkImplausibleRainStock(rain, { maxDays = MAX_IMPLAUSIBLE_RAIN_DAYS, bound = 400 } = {}) {
  let n = 0;
  const where = [];
  for (const [no, s] of rain) {
    for (const [y, doc] of s.shards) {
      for (const x of (doc.mm || [])) if (x != null && isNum(x) && x > bound) { n++; if (where.length < 3) where.push(`${no}/${y} ${x} mm`); }
    }
  }
  return n > maxDays ? [`N8: ${n} rain days over ${bound} mm, ceiling is ${maxDays} (${where.join(', ')})`] : [];
}

// The precip tree's own reader: same per-station shape as readProduct, but the
// `basins/` subtree is a sibling product, not a station, and index/overview are
// files at the root — none of them a gauge directory.
export function readPrecip(precipDir) {
  const out = new Map();
  if (!existsSync(precipDir)) return out;
  for (const ent of readdirSync(precipDir, { withFileTypes: true })) {
    // `basins` and `used-by` are the two directories under precip/ that are not
    // a gauge product; read as one, they would be a gauge with no meta.json and
    // no entry in topology.json — two violations invented by the reader.
    if (!ent.isDirectory() || ent.name === 'basins' || ent.name === 'used-by') continue;
    const dir = join(precipDir, ent.name);
    const shards = new Map();
    for (const f of readdirSync(dir)) if (isYearShard(f)) shards.set(Number(f.slice(0, 4)), readJson(join(dir, f)));
    out.set(ent.name, { meta: readJson(join(dir, 'meta.json')), shards, response: readJson(join(dir, 'response.json')) });
  }
  return out;
}

// (c4) THE REVERSE INDEX. `precip/used-by/<rainNo>.json` is the same membership
// relation read the other way round, and a second copy of a relation is a second
// chance to be wrong: the page that draws it would show a rain gauge feeding a
// gauge whose own meta.json never named it, and every other N8 clause would stay
// green, because they all read the forward side. So the two are compared as SETS,
// in BOTH directions — a membership with no entry and an entry with no membership
// are two different bugs and get two different lines — and each entry has to
// carry the same `name`/`via`/`km`/`at` the set does.
export function readUsedBy(precipDir) {
  const out = new Map();
  const dir = join(precipDir, 'used-by');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    out.set(f.slice(0, -5), readJson(join(dir, f)));
  }
  return out;
}

// The membership fields, copied from the forward set entry for entry. `at` is in
// here for the reason `km` cannot be read without it: on a basin/orphan member
// `km` is the distance to the OWNING NODE, not to the gauge the entry names, so
// an entry that kept `km` and dropped `at` would state a distance between two
// things that never stood that far apart.
//
// `name` is NOT one of them, and that is the trap: the two files use the field
// for two different subjects. In `precip/<no>/meta.json` the set's `name` is the
// RAIN station's; in the reverse index it is the receiving GAUGE's, because that
// is the one the reader of a rain page does not otherwise have. It is checked —
// against the gauge product's own `meta.json` name, one line below.
const USED_BY_FIELDS = ['via', 'km', 'at'];

export function checkPrecipUsedBy(usedBy, products, rainIds, { maxList = 5 } = {}) {
  const v = [];
  // What the forward side says, keyed rain station -> gauge. Only the gauges
  // that SHIPPED a product have a directory to be read here, which is the same
  // universe the builder counts memberships over.
  const forward = new Map();
  // the gauge's OWN name, which is what an entry's `name` states — not the rain
  // station's name the forward set carries under the same key
  const gaugeName = new Map();
  for (const [no, p] of products) {
    gaugeName.set(String(no), (p.meta || {}).name ?? null);
    for (const s of ((p.meta || {}).set || [])) {
      const r = String(s.no);
      if (!forward.has(r)) forward.set(r, new Map());
      forward.get(r).set(String(no), s);
    }
  }
  const missingFiles = [], extraFiles = [];
  for (const r of forward.keys()) if (!usedBy.has(r)) missingFiles.push(r);
  for (const [r, rows] of usedBy) {
    if (rainIds && !rainIds.has(r)) v.push(`N8: precip/used-by/${r}.json: ${r} has no nrw/rain/ directory`);
    if (!Array.isArray(rows)) { v.push(`N8: precip/used-by/${r}.json: not an array of memberships`); continue; }
    if (!rows.length) v.push(`N8: precip/used-by/${r}.json: empty — a rain gauge in no set carries no file at all`);
    const want = forward.get(r);
    if (!want) { extraFiles.push(r); continue; }
    const seen = new Set();
    for (const e of rows) {
      const g = String(e.no);
      if (seen.has(g)) { v.push(`N8: precip/used-by/${r}.json: gauge ${g} listed twice`); continue; }
      seen.add(g);
      const s = want.get(g);
      if (!s) { v.push(`N8: precip/used-by/${r}.json: names gauge ${g}, whose own meta.json does not hold ${r} in its set`); continue; }
      const bad = USED_BY_FIELDS.filter(k => (e[k] ?? null) !== (s[k] ?? null));
      if (bad.length) {
        v.push(`N8: precip/used-by/${r}.json: gauge ${g} disagrees with the set on `
          + bad.map(k => `${k} (${JSON.stringify(e[k] ?? null)} vs ${JSON.stringify(s[k] ?? null)})`).join(', '));
      }
      // the entry's own added field: the receiving gauge's name, which the page
      // prints without a second fetch and so must be the gauge's own
      const gn = gaugeName.get(g) ?? null;
      if ((e.name ?? null) !== gn) {
        v.push(`N8: precip/used-by/${r}.json: gauge ${g} is named ${JSON.stringify(e.name ?? null)} here `
          + `and ${JSON.stringify(gn)} in precip/${g}/meta.json`);
      }
    }
    for (const g of want.keys()) {
      if (!seen.has(g)) v.push(`N8: precip/used-by/${r}.json: precip/${g}/meta.json holds ${r} in its set, but the reverse index does not name ${g}`);
    }
  }
  const lst = a => a.slice(0, maxList).join(', ') + (a.length > maxList ? `, … and ${a.length - maxList} more` : '');
  if (missingFiles.length) v.push(`N8: precip/used-by/: ${missingFiles.length} rain station(s) are in a set but have no file: ${lst(missingFiles.sort())}`);
  if (extraFiles.length) v.push(`N8: precip/used-by/: ${extraFiles.length} file(s) for a rain station no set holds: ${lst(extraFiles.sort())}`);
  return v;
}

// ---------- N9 hourly response class ----------

// The product is ONE file, nrw/hourly/lag.json, written by
// scripts/build-nrw-hourly-lag.mjs out of BOTH data branches. The clauses are
// cut so that (a)-(f) need only the `nrw` tree and (g)-(h) need `--hires`: a
// caller without the second branch still gets everything except the two rules
// that literally cannot be evaluated without it, and it is told so out loud.
export function checkHourlyShape(lag, {
  topologyGauges = null, precip = null, nowDate = null,
  minPublished = MIN_HOURLY_PUBLISHED, maxWindowLagH = MAX_HOURLY_WINDOW_LAG_H,
  minWindowHours = MIN_HOURLY_WINDOW_HOURS, maxWindowHours = MAX_HOURLY_WINDOW_HOURS,
  maxClassShare = MAX_HOURLY_CLASS_SHARE,
} = {}) {
  // (a) presence and schema
  if (!lag || lag.schema !== 1) return ['N9: hourly/lag.json missing, unparseable or not schema 1'];
  const v = [];
  for (const k of ['window', 'rule', 'counts', 'gauges']) {
    if (!lag[k] || typeof lag[k] !== 'object') v.push(`N9: hourly/lag.json carries no \`${k}\` block`);
  }
  // Both versions, PRESENCE checked, for the reason N8 learned the hard way: if
  // the builder ever stops writing one, clause (f) reads the same value on both
  // sides, decides nothing changed, and switches itself off for good.
  for (const k of ['ruleVersion', 'lagRuleVersion']) {
    if (!(typeof lag[k] === 'number' && lag[k] >= 1)) v.push(`N9: hourly/lag.json carries no numeric \`${k}\` — without it a rule change reads as no change (got ${JSON.stringify(lag[k])})`);
  }
  if (v.length) return v;

  const w = lag.window, R = lag.rule, c = lag.counts, g = lag.gauges;

  // (b) FRESHNESS — the clause that makes a skipped build red without needing
  // the hires tree at all. A run that mirrors `nrw` but never rebuilds the lag
  // leaves yesterday's window standing, and every other clause here would still
  // be perfectly happy with it.
  const to = Date.parse(String(w.to)), from = Date.parse(String(w.from));
  if (!Number.isFinite(to) || !Number.isFinite(from)) {
    v.push(`N9: hourly window is not a readable pair of timestamps (${JSON.stringify(w.from)} … ${JSON.stringify(w.to)})`);
  } else {
    if (nowDate) {
      const lagH = (nowDate.getTime() - to) / 36e5;
      if (!(lagH <= maxWindowLagH)) v.push(`N9: the hourly window ends ${lagH.toFixed(1)} h before now (${w.to}), ceiling is ${maxWindowLagH} h — the lag was not rebuilt on this run`);
      // A window that ends in the future is not fresh, it is broken — and a
      // one-sided "not too old" test passes it with room to spare. One hour of
      // slack for the clock, no more.
      if (lagH < -1) v.push(`N9: the hourly window ends ${(-lagH).toFixed(1)} h in the FUTURE (${w.to}) — that is a corrupt file, not a fresh one`);
    }
    // `hours` is what (d) and the plate both read, so it may not be a number
    // the file merely asserts about itself
    const spanned = (to - from) / 36e5 + 1;
    if (w.hours !== spanned) v.push(`N9: hourly window says ${w.hours} hours but spans ${spanned} (${w.from} … ${w.to})`);
  }
  if (!(w.hours >= minWindowHours)) v.push(`N9: the hourly window is ${w.hours} h, floor is ${minWindowHours} (${(minWindowHours / 24).toFixed(0)} days)`);
  // A CEILING as well as a floor, because the mirror only grows. The source
  // offers 63 rolling days and the builder cuts to them; a window that ran past
  // that means the builder stopped bounding it, and every constant here — and
  // every caveat on the plate — was calibrated on the shorter one. A floor alone
  // cannot see that: the number it watches would be moving the OTHER way.
  if (!(w.hours <= maxWindowHours)) {
    v.push(`N9: the hourly window is ${w.hours} h (${(w.hours / 24).toFixed(1)} days), ceiling is ${maxWindowHours} — `
      + 'the mirror grows and the source does not, so a window past this is history the source no longer offers');
  }

  // The RULE itself, and not only its shape. The plate binds its three words to
  // the class INDEX positionally, so a `classes` list that is reordered,
  // overlapping or gapped makes the plate print a true class id under the wrong
  // words — "within the hour (9+ h)" — with every other clause here green.
  const classes = Array.isArray(R.classes) ? R.classes : null;
  if (!classes || !classes.length || !classes.every(x => Array.isArray(x) && x.length === 2 && Number.isInteger(x[0]) && (x[1] === null || Number.isInteger(x[1])))) {
    v.push(`N9: rule.classes is not a list of [lo, hi] pairs (${JSON.stringify(R.classes)})`);
    return v;
  }
  if (classes[0][0] !== 0) v.push(`N9: rule.classes starts at ${classes[0][0]} h, so a lag of 0 falls through it`);
  if (classes[classes.length - 1][1] !== null) v.push('N9: the last of rule.classes is bounded, so a lag past it has no class at all');
  for (let i = 0; i < classes.length; i++) {
    const [lo, hi] = classes[i];
    if (hi != null && hi < lo) v.push(`N9: rule.classes[${i}] is empty (${lo}..${hi})`);
    if (i && classes[i - 1][1] !== lo - 1) {
      v.push(`N9: rule.classes[${i - 1}] ends at ${classes[i - 1][1]} and [${i}] starts at ${lo} — the classes must be ascending, adjacent and non-overlapping, because the plate binds its words to the INDEX`);
    }
  }
  // The filters have to be able to filter. A run with 0 rotations marks every
  // gauge significant and reports notSignificant 0, which reads exactly like a
  // filter that found nothing to drop.
  if (!(typeof R.minR === 'number' && R.minR > 0 && R.minR <= 1)) v.push(`N9: rule.minR is ${JSON.stringify(R.minR)}, which is not a correlation cut in (0, 1]`);
  if (!(Number.isInteger(R.rotations) && R.rotations >= 1)) v.push(`N9: rule.rotations is ${JSON.stringify(R.rotations)} — a permutation filter that ran no rotations calls everything significant`);
  if (!(typeof R.fdrQ === 'number' && R.fdrQ > 0 && R.fdrQ < 1)) v.push(`N9: rule.fdrQ is ${JSON.stringify(R.fdrQ)}, which is not a false-discovery rate in (0, 1)`);

  // The run's own provenance. Without these the file can claim anything about
  // where it came from and (g) has nothing to compare against — and (g) is
  // exactly the clause that does not run without --hires.
  if (!/^[0-9a-f]{64}$/.test(String((lag.inputs || {}).sha256))) v.push(`N9: inputs.sha256 is not a sha256 digest (${JSON.stringify((lag.inputs || {}).sha256)})`);
  if (!(Number.isInteger((lag.inputs || {}).files) && lag.inputs.files > 0)) v.push(`N9: inputs.files is ${JSON.stringify((lag.inputs || {}).files)} — a digest over no files is not a digest`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lag.generated))) v.push(`N9: generated is ${JSON.stringify(lag.generated)}, not a date`);
  const byClass = classes.map(() => 0);
  let bad = 0;
  for (const [no, cls] of Object.entries(g)) {
    if (!(Number.isInteger(cls) && cls >= 0 && cls < classes.length)) {
      if (bad++ < 3) v.push(`N9: hourly/lag.json: gauge ${no} carries ${JSON.stringify(cls)}, which is not a class id of rule.classes`);
      continue;
    }
    byClass[cls]++;
    if (topologyGauges && !topologyGauges[no]) v.push(`N9: hourly/lag.json: ${no} is not a gauge in topology.json`);
    // The hourly class sits UNDER the daily rain field on the plate; a class for
    // a gauge with no field would be a response to rain the reader cannot see.
    if (precip && !(precip[no] && precip[no].series === true)) v.push(`N9: hourly/lag.json: ${no} has an hourly class but no daily rain field`);
  }
  if (bad > 3) v.push(`N9: … and ${bad - 3} more gauges carry something that is not a class id`);
  if (!Array.isArray(c.byClass) || c.byClass.length !== classes.length || c.byClass.some((n, i) => n !== byClass[i])) {
    v.push(`N9: counts.byClass is ${JSON.stringify(c.byClass)}, a recount of \`gauges\` gives ${JSON.stringify(byClass)}`);
  }

  // (d) FLOORS, exact counts — an empty or collapsed product cannot pass
  const published = Object.keys(g).length;
  if (c.published !== published) v.push(`N9: counts.published is ${c.published}, \`gauges\` holds ${published}`);
  if (!(published >= minPublished)) v.push(`N9: only ${published} gauges carry a response class, floor is ${minPublished}`);
  if (!(c.published <= c.withPeak && c.withPeak <= c.attempted && c.attempted <= c.daily)) {
    v.push(`N9: the counts do not nest: published ${c.published} <= withPeak ${c.withPeak} <= attempted ${c.attempted} <= daily ${c.daily}`);
  }
  // THE ACCOUNTING IDENTITY. Nesting alone leaves every drop-out counter free:
  // `weak` could read 99999 and nothing here would notice — and the plate prints
  // those four numbers to the reader as the fleet split. Each gauge leaves the
  // pipeline exactly once, so the three balances below must close exactly.
  const balances = [
    ['daily', c.daily, ['notInHires', 'noDailySet', 'attempted']],
    ['attempted', c.attempted, ['noPeak', 'withPeak']],
    ['withPeak', c.withPeak, ['weak', 'notSignificant', 'unclassed', 'published']],
  ];
  for (const [name, total, parts] of balances) {
    const nums = parts.map(k => c[k]);
    if (!nums.every(n => Number.isInteger(n) && n >= 0)) {
      v.push(`N9: counts.${parts.filter(k => !(Number.isInteger(c[k]) && c[k] >= 0)).join('/')} is not a count (${JSON.stringify(nums)})`);
      continue;
    }
    const sum = nums.reduce((a, n) => a + n, 0);
    if (sum !== total) v.push(`N9: counts do not balance: ${parts.join(' + ')} = ${sum}, but ${name} is ${total} — every gauge leaves the pipeline exactly once`);
  }
  // A three-class product in which everyone is in one class is a one-class
  // product wearing a legend.
  const biggest = Math.max(...byClass);
  if (published && biggest > maxClassShare * published) {
    v.push(`N9: one class holds ${biggest} of ${published} published gauges (${(100 * biggest / published).toFixed(1)} %), ceiling is ${(100 * maxClassShare).toFixed(0)} % — a product collapsed onto one class is not a product`);
  }
  return v;
}

// (e) drift against HEAD, and (f) the rule-change clause. Copied in FORM from
// N8's own (j), including the lesson that made N8's first cut useless: read the
// version the SAME way on both sides, or a HEAD without the field defaults to
// the current one, the two compare equal, and the clause switches itself off.
export function checkHourlyDrift(lag, head, {
  maxClassDrift = MAX_HOURLY_CLASS_DRIFT, maxPublishedDrop = MAX_HOURLY_PUBLISHED_DROP,
  baselines = LAG_RULE_BASELINES, slack = LAG_RULE_BASELINE_SLACK,
} = {}) {
  const v = [];
  if (!lag || !lag.gauges || !lag.counts) return v;
  const verOf = ix => (ix ? [ix.lagRuleVersion ?? 1, ix.ruleVersion ?? 1].join('.') : null);
  const ver = verOf(lag), headVer = head ? verOf(head) : null;
  const changed = headVer != null && ver !== headVer;

  // (f) A RULE CHANGE MAY NOT RIDE IN ON ITS OWN DRIFT ALLOWANCE. On the run
  // that moves the rule every counter below is SUPPOSED to move, so the HEAD
  // comparison says nothing and pre-registered numbers stand in its place.
  if (changed) {
    const b = baselines[ver];
    if (!b) {
      v.push(`N9: lag rule ${headVer} -> ${ver} with no pre-registered counts — add an entry to LAG_RULE_BASELINES in the same commit that moves the rule`);
    } else {
      for (const [k, want] of Object.entries(b)) {
        const got = lag.counts[k];
        if (typeof got !== 'number') v.push(`N9: lag rule ${ver}: counts has no numeric \`${k}\` to compare against the pre-registered ${want}`);
        else if (Math.abs(got - want) > slack) v.push(`N9: lag rule ${ver}: ${k} is ${got}, pre-registered ${want} (slack ${slack}) — the rule change does not produce what was registered for it`);
      }
    }
    return v;
  }
  if (!head || !head.gauges) return v;

  // (e) DRIFT. The unit is the gauge whose PUBLISHED VALUE moved — a class that
  // changed, one that appeared, one that vanished — because that is exactly one
  // line of the diff each, and the diff is this product's acceptance criterion.
  const ids = new Set([...Object.keys(lag.gauges), ...Object.keys(head.gauges)]);
  let moved = 0, gone = 0;
  for (const no of ids) {
    if (lag.gauges[no] !== head.gauges[no]) moved++;
    if (!(no in lag.gauges) && (no in head.gauges)) gone++;
  }
  if (moved > maxClassDrift) v.push(`N9: ${moved} gauges changed response class against HEAD, ceiling is ${maxClassDrift}`);
  if (gone > maxPublishedDrop) v.push(`N9: ${gone} gauges lost their response class against HEAD, ceiling is ${maxPublishedDrop}`);
  const drop = Object.keys(head.gauges).length - Object.keys(lag.gauges).length;
  if (drop > maxPublishedDrop) v.push(`N9: published gauges ${Object.keys(head.gauges).length} -> ${Object.keys(lag.gauges).length}, a fall of ${drop} over the ceiling of ${maxPublishedDrop}`);
  return v;
}

export function registrySize(doc) {
  if (Array.isArray(doc)) return doc.length;
  if (!doc || typeof doc !== 'object') return 0;
  const inner = doc.stations;
  if (Array.isArray(inner)) return inner.length;
  if (inner && typeof inner === 'object') return Object.keys(inner).length;
  return Object.keys(doc).length;
}

// <tree>/<kind>/<no>/{meta.json,<YYYY>.json} -> Map<no, {meta, shards, days}>
export function readProduct(treeDir, kind, manifest = null) {
  const root = join(treeDir, kind);
  const out = new Map();
  if (!existsSync(root)) return out;
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    const shards = new Map();
    for (const f of readdirSync(dir)) {
      if (isYearShard(f)) shards.set(Number(f.slice(0, 4)), readJson(join(dir, f)));
    }
    const entry = manifest && manifest[kind] && manifest[kind][ent.name] || null;
    out.set(ent.name, { meta: readJson(join(dir, 'meta.json')), shards, days: storedDays(kind, shards), entry });
  }
  return out;
}

// the numbers the summary line and the calibration note are made of
export function measure(fleet, manifest, nowDate) {
  const withData = map => [...map.values()].filter(s => s.days.length).length;
  const last = [...fleet.gauges.values()].filter(s => s.days.length).map(s => s.days[s.days.length - 1]);
  const edge = last.length ? Math.max(...last) : null;
  const today = todayNum(nowDate);
  const counts = [...fleet.gauges.values()].filter(s => s.days.length)
    .map(s => s.days.filter(n => n > today - WINDOW_DAYS && n <= today).length);
  let full = 0;
  for (const s of fleet.gauges.values()) {
    if (Array.isArray(s.meta && s.meta.info) && s.meta.info.filter(x => x != null).length >= 3) full++;
  }
  const cov = (manifest && manifest.coverage && manifest.coverage.gauges) || {};
  return {
    registry: fleet.registryCount,
    gauges: withData(fleet.gauges), rain: withData(fleet.rain), temp: withData(fleet.temp),
    bulk: cov.bulk ?? null, station: cov.station ?? null, noSeries: cov.noSeries ?? null, gaugeRegistry: cov.registry ?? null,
    edge: edge == null ? null : isoOfNum(edge), lag: edge == null ? null : today - edge,
    windowMedian: counts.length ? median(counts) : null, fullTriples: full,
  };
}

// ---------- CLI loader: working tree + `git show HEAD:` as the baseline (lib/cli.mjs) ----------

async function main() {
  const treeDir = resolve(opt('tree', 'nrw-branch/nrw'));
  const gitDir = resolve(opt('git', join(treeDir, '..')));
  const prefix = relative(gitDir, treeDir).split(sep).join('/');
  // optional: N9(g) and N9(h) are the only two clauses that need it, and they
  // say so out loud when it is absent rather than passing quietly
  const hiresOpt = opt('hires', null);
  const hiresDir = hiresOpt ? resolve(hiresOpt) : null;
  const allowPrune = has('allow-prune');
  const on = r => !SKIP.has(r);
  const violations = [];
  const notes = [];

  const manifest = readJson(join(treeDir, 'manifest.json'));
  if (!manifest || manifest.schema !== 1) violations.push('N5: manifest.json missing, unparseable or not schema 1');
  const topology = readJson(join(treeDir, 'topology.json'));
  const fleet = {
    registryCount: registrySize(readJson(join(treeDir, 'registry.json'))),
    gauges: readProduct(treeDir, 'gauges', manifest),
    rain: readProduct(treeDir, 'rain', manifest),
    temp: readProduct(treeDir, 'temp', manifest),
    topology,
  };

  // N4 — the diff against HEAD
  const changes = listChanges(gitDir, prefix);
  const headManifest = readHead(gitDir, `${prefix}/manifest.json`);
  if (on('N4')) {
    violations.push(...checkRegressionStatuses(changes, allowPrune));
    for (const { status, path } of changes) {
      if (status !== 'M' || !path.endsWith('.json')) continue; // an added file has no baseline
      const rel = path.slice(prefix.length + 1);
      const m = rel.match(/^(gauges|rain|temp)\/([^/]+)\/(\d{4}|meta)\.json$/);
      if (!m) continue;
      const tree = readJson(join(gitDir, path));
      const head = readHead(gitDir, path);
      if (m[3] === 'meta') {
        violations.push(...compareRange(head, tree, path));
        notes.push(...metaRevisions(head, tree, path));
      } else {
        violations.push(...compareSeries(m[1], head, tree, path));
      }
    }
    violations.push(...compareManifest(headManifest, manifest, { allowPrune }));
  }

  // N5 — the whole tree, changed or not (3 MB a year; a rule that only reads
  // the diff would let a bad seed through forever)
  if (on('N5')) {
    for (const kind of KINDS) {
      for (const [no, s] of fleet[kind]) {
        violations.push(...checkMetaShape(kind, s.meta, `${prefix}/${kind}/${no}/meta.json`, no));
        for (const [y, doc] of s.shards) {
          violations.push(...checkShardShape(kind, doc, `${prefix}/${kind}/${no}/${y}.json`, { id: no, y }));
        }
      }
    }
  }

  if (on('N1')) violations.push(...checkFleetSize(fleet));
  if (on('N2')) violations.push(...checkFleetEdge(fleet.gauges, now));
  if (on('N3')) {
    violations.push(...checkWindowDepth(fleet.gauges, {
      nowDate: now, window: windowOf(manifest, 'gauges'),
      collectionStart: collectionStart(readJson(join(treeDir, 'runs.json')), manifest),
    }));
  }
  if (on('N6')) violations.push(...checkAlertStages(fleet.gauges));
  if (on('N7')) violations.push(...checkCoverageMarks(manifest, headManifest));
  if (on('N8')) {
    const precipDir = join(treeDir, 'precip');
    if (!existsSync(precipDir)) {
      violations.push('N8: precip/ missing — run scripts/build-nrw-precip.mjs before the gate');
    } else {
      const index = readJson(join(precipDir, 'index.json'));
      const rainIds = new Set(fleet.rain.keys());
      const products = readPrecip(precipDir);
      violations.push(...checkPrecipShape(index, products, rainIds, topology && topology.gauges));
      violations.push(...checkPrecipUsedBy(readUsedBy(precipDir), products, rainIds));
      violations.push(...checkPrecipDrift(index, readHead(gitDir, `${prefix}/precip/index.json`)));
      violations.push(...checkImplausibleRainStock(fleet.rain));
      // (e) the committed bytes ARE the rule's output. A tree that merely looks
      // coherent can still be stale — a hand-edited shard, a builder change
      // nobody re-ran. --check writes nothing and lists what differs.
      try {
        const r = buildPrecip({ tree: treeDir, out: precipDir, check: true, generated: (index && index.generated) || isoOfNum(todayNum(now)) });
        for (const d of r.out.diffs.slice(0, 10)) violations.push(`N8: precip is not what the rule produces — ${d}`);
        if (r.out.diffs.length > 10) violations.push(`N8: ... and ${r.out.diffs.length - 10} more precip files differ from the rule`);
      } catch (e) {
        violations.push(`N8: could not recompute precip: ${e.message}`);
      }
    }
  }

  // N9 — the hourly response class, nrw/hourly/lag.json. (a)-(f) read the `nrw`
  // tree only; (g) and (h) need the hires tree and are SKIPPED, loudly, without
  // it. A green run without --hires must not be mistakable for a complete one.
  let n9Partial = false;
  if (on('N9')) {
    const lagPath = join(treeDir, 'hourly', 'lag.json');
    const lag = readJson(lagPath);
    if (!existsSync(lagPath)) {
      violations.push('N9: hourly/lag.json missing — run scripts/build-nrw-hourly-lag.mjs before the gate');
    } else {
      violations.push(...checkHourlyShape(lag, {
        topologyGauges: topology && topology.gauges, precip: manifest && manifest.precip, nowDate: now,
      }));
      violations.push(...checkHourlyDrift(lag, readHead(gitDir, `${prefix}/hourly/lag.json`)));
      if (!hiresDir) {
        n9Partial = true;
        console.log('::warning::N9(g) input digest and N9(h) recomputation SKIPPED — no --hires <dir> was given, '
          + 'so the two clauses that need the nrw-hires tree could not run. Pass --hires, or --skip N9 to mean it.');
      } else if (!existsSync(hiresDir)) {
        violations.push(`N9: --hires ${hiresDir} does not exist`);
      } else {
        // (g) the digest of the bytes the run actually read
        try {
          const d = inputsDigest(hiresDir);
          if (!lag.inputs || lag.inputs.sha256 !== d.sha256) {
            violations.push(`N9: hourly/lag.json was built over different hires bytes than the tree holds `
              + `(file ${(lag.inputs || {}).sha256 || 'none'} over ${(lag.inputs || {}).files} files, tree ${d.sha256} over ${d.files})`);
          }
        } catch (e) {
          violations.push(`N9: could not digest the hires tree: ${e.message}`);
        }
        // (h) the committed bytes ARE what the rule produces. `generated` is
        // passed through from the committed file for the reason N8(e) already
        // knows: without it the date alone turns this red every single day.
        try {
          const r = buildHourlyLag({
            tree: treeDir, hires: hiresDir, out: join(treeDir, 'hourly'), check: true,
            generated: lag.generated || isoOfNum(todayNum(now)),
          });
          for (const d of r.out.diffs) violations.push(`N9: hourly lag is not what the rule produces — ${d}`);
        } catch (e) {
          violations.push(`N9: could not recompute the hourly lag: ${e.message}`);
        }
      }
    }
  }

  for (const n of notes) console.log(`note: ${n}`);
  if (violations.length) {
    for (const v of violations.slice(0, 40)) console.log(`::error::${v}`);
    if (violations.length > 40) console.log(`::error::... and ${violations.length - 40} more violations`);
    process.exit(1);
  }
  const s = measure(fleet, manifest, now);
  console.log(`nrw consistency ok${n9Partial ? ' (N9 partial: no --hires)' : ''}: ${changes.length} changed files, registry ${s.registry}, `
    + `gauges ${s.gauges} with data (bulk ${s.bulk}, station ${s.station}, noSeries ${s.noSeries} of ${s.gaugeRegistry} registered), `
    + `rain ${s.rain}, temp ${s.temp}, fleet edge ${s.edge} (${s.lag} d behind today), `
    + `window median ${s.windowMedian} d, full alert triples ${s.fullTriples}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
