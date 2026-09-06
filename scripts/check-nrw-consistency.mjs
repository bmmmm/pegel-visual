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
//
// Deliberate limits, as in the sibling gate: N4 compares against the branch's
// own HEAD, so a base poisoned by a force-push looks clean to it — branch
// protection plus N1-N3 stand against that. On the branch's very first run
// HEAD carries README + .gitignore only, every data file is status A, and N4
// has nothing to compare; N1-N3 and N5-N7 still measure the tree.
//
//   PEGEL_NOW=2026-09-04T12:00:00Z node scripts/check-nrw-consistency.mjs \
//       --tree nrw-branch/nrw --git nrw-branch [--skip N3,N6] [--allow-prune]
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkChangeStatuses, dayNum } from './check-archive-consistency.mjs';
import { daysInYear, PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM } from './fetch-wsv-archive.mjs';
import { mezParts } from './snapshot-wsv.mjs';

const now = process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);
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
  return checkChangeStatuses(changes).map(m => m.replace(/^R4:/, 'N4:'));
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
    sweep('mm negative or not a number', d => mm[d] != null && (!isNum(mm[d]) || mm[d] < 0));
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

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const isYearShard = name => /^\d{4}\.json$/.test(name);

// registry.json is "raw-near": a row array, or an object keyed by station_no,
// or {stations: …} — count rows whichever way it comes
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

// ---------- CLI loader: working tree + `git show HEAD:` as the baseline ----------

function git(gitDir, gitArgs) {
  return execFileSync('git', ['-C', gitDir, ...gitArgs], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// changed = diff vs HEAD plus untracked files; a repo without a commit yet
// has no baseline at all, so everything in it is new
function listChanges(gitDir, prefix) {
  const changes = [];
  let diff = '';
  try { diff = git(gitDir, ['diff', '--name-status', 'HEAD', '--', prefix]); }
  catch { console.log('note: no HEAD to compare against — every file counts as new'); }
  for (const line of diff.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    changes.push({ status: parts[0][0], path: parts[parts.length - 1] });
  }
  for (const line of git(gitDir, ['ls-files', '--others', '--exclude-standard', '--', prefix]).split('\n')) {
    if (line) changes.push({ status: 'A', path: line });
  }
  return changes;
}

// a file that is new in this run has no HEAD version — git says so on stderr,
// and that is not a finding, so its stderr stays out of the log
function readHead(gitDir, path) {
  try {
    return JSON.parse(execFileSync('git', ['-C', gitDir, 'show', `HEAD:${path}`],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

async function main() {
  const treeDir = resolve(opt('tree', 'nrw-branch/nrw'));
  const gitDir = resolve(opt('git', join(treeDir, '..')));
  const prefix = relative(gitDir, treeDir).split(sep).join('/');
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

  for (const n of notes) console.log(`note: ${n}`);
  if (violations.length) {
    for (const v of violations.slice(0, 40)) console.log(`::error::${v}`);
    if (violations.length > 40) console.log(`::error::... and ${violations.length - 40} more violations`);
    process.exit(1);
  }
  const s = measure(fleet, manifest, now);
  console.log(`nrw consistency ok: ${changes.length} changed files, registry ${s.registry}, `
    + `gauges ${s.gauges} with data (bulk ${s.bulk}, station ${s.station}, noSeries ${s.noSeries} of ${s.gaugeRegistry} registered), `
    + `rain ${s.rain}, temp ${s.temp}, fleet edge ${s.edge} (${s.lag} d behind today), `
    + `window median ${s.windowMedian} d, full alert triples ${s.fullTriples}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
