#!/usr/bin/env node
// Bakes areal precipitation per LANUK NRW gauge out of the mirrored `nrw/` tree:
// which rain gauges drain into which level gauge, the daily areal mean over that
// set, and the measured rain -> level response. Deliberately a SEPARATE script
// from the collector, not a step inside it: the product is a pure function of the
// committed `nrw/` tree, so any checkout can recompute it byte-for-byte and
// `--check` can prove the committed bytes are the ones the rule produces.
//
//   nrw/precip/index.json          the rule, its counts, and every receiving gauge
//   nrw/precip/<no>/meta.json      the rain set behind one gauge (who, how far, why)
//   nrw/precip/<no>/<YYYY>.json    { id, y, mm[], n[], med[], mx[] }, daysInYear long
//   nrw/precip/<no>/response.json  lag correlation rain -> level change, always written
//   nrw/precip/basins/<b>/…        the same two files per basin (overview rows)
//   nrw/precip/overview.json       the last 90 rain days per basin, for the ?rain plate
//
// Usage (CI runs it between "Collect" and the consistency gate in nrw-update.yml):
//   node scripts/build-nrw-precip.mjs --tree nrw-branch/nrw
//   node scripts/build-nrw-precip.mjs --tree nrw --check     # recompute, write nothing,
//                                                            # exit 1 listing what differs
//
// TWO CLOCKS, and they do not line up. A LANUK rain day `d` is
// [d 07:00, d+1 07:00) MEZ; a level day `d` is [d 00:00, d+1 00:00) MEZ. Rain day d
// therefore overlaps level day d by 17 h and level day d+1 by 7 h, and it CLOSES
// after level day d has closed. That asymmetry is why the response statistic below
// peaks at lag 1 and why the forecast covariate may only ever see rain day t-1 at
// context position t (a leak assert lives in the forecast loaders, not here).
//
// AREAL MEAN = UNWEIGHTED MEAN over the reporting stations of the set. That is
// Thiessen with equal polygon areas; the source ships no sub-catchment polygons, so
// any weighting would be invented. `med`/`mx` ride along as diagnostics — the
// covariate and the plate both use `mm`.
//
// n[] IS THE NUMBER OF STATIONS BEHIND THE PRINTED VALUE, not the number that
// reported. When the day misses the reporting threshold the day is a non-day:
// mm/med/mx null AND n 0, so `mm === null <=> n === 0` holds as an invariant the
// gate can assert (N8b) and the plate can draw (`pr-nd` = a column no gauge stands
// behind). Keeping a "2 of 5 reported" count here would buy a diagnostic and cost
// the invariant; the coverage detail is one level down in `nrw/rain/`.
//
// NESTING IS REAL AND INTENDED: rainSet(g) is the union over the whole upstream
// closure of g, so rainSet(Schermbeck_1) ⊇ rainSet(Kesseler_3) ⊇ …. Two gauges on
// one river do NOT have disjoint rain. Every legend that prints a set size says so,
// and WP3's station rule picks one gauge per basin precisely to get disjoint sets.
//
// The down-edge graph has a 2-CYCLE (2739229000100 Erkrath <-> 2739230000100 Eigen),
// which is why `closure()` carries a seen-set instead of recursing on a tree. The
// WSV relay nodes (siteNo 102) and the one gauge with Gauss-Krueger coordinates
// (2728510000200 Ruenderoth) stay IN the routing graph — they forward upstream rain
// downstream — but they never RECEIVE a product of their own; dropping Ruenderoth
// from the graph would cost Menden_1 four upstream nodes and one rain gauge.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { daysInYear } from './fetch-wsv-archive.mjs';

export const SCHEMA = 1;

// ---------- the rule, pre-registered ----------

// NRW plus a border strip: contains Hann-Muenden (lon 9.64) and the RLP Sieg gauges,
// excludes the two Gauss-Krueger / garbage coordinate sets and the 0/0 stations.
export const LAT_BOX = [50.0, 52.8];
export const LON_BOX = [5.5, 9.8];
export const MAX_ASSIGN_KM = 100;   // a rain gauge may join a gauge of its own basin this far away
export const MAX_ORPHAN_KM = 10;    // …a gauge of ANY basin only this far (Emscher -> Lippe would be wrong)
export const MIN_COVERAGE_PCT = 50; // a day aggregated from less than half a day is not a day
export const PLAUSIBLE_MAX_MM_DAY = 400; // above the German record (312 mm); 595.9 mm exists in the source
export const MIN_SET_FOR_SERIES = 3;
export const MIN_RESPONSE_DAYS = 120;
export const EVENT_MM = 10;
export const MIN_EVENTS = 10;
export const OVERVIEW_DAYS = 90;
export const OVERVIEW_SUM_DAYS = 7;
export const ACC_MIN = 95;          // level day observed only at >= 95 % aggregation accuracy
export const RELAY_SITE_NO = '102'; // federal (WSV) relay nodes: route, never receive

export const RAIN_DAY_BOUNDARY = '07:00+01:00';
export const LEVEL_DAY_BOUNDARY = '00:00+01:00';
export const ALIGN_NOTE = 'rain day d = [d 07:00, d+1 07:00) MEZ; overlaps level day d 17 h, d+1 7 h';

const DAY_MS = 864e5;

// ---------- small pure helpers ----------

export const usableCoords = m =>
  !!m && Number.isFinite(m.lat) && Number.isFinite(m.lon) &&
  m.lat >= LAT_BOX[0] && m.lat <= LAT_BOX[1] &&
  m.lon >= LON_BOX[0] && m.lon <= LON_BOX[1];

const RAD = Math.PI / 180;
export function haversineKm(a, b) {
  const R = 6371.0088;
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Ties go to the smaller station number. Ids are numeric strings of differing
// length ("43" vs "2739229000100"), so a plain string compare would call "43"
// the larger; compare numerically when both parse, lexically otherwise.
export function cmpNo(a, b) {
  const na = /^\d+$/.test(a) ? Number(a) : null, nb = /^\d+$/.test(b) ? Number(b) : null;
  if (na !== null && nb !== null && Number.isSafeInteger(na) && Number.isSafeInteger(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export const round = (v, p) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p;

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Nearest-rank quantile on a sorted copy; used for the overview's fixed mm ramp.
export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

// Two-pass Pearson: the one-pass form loses the correlation of two nearly
// constant series to cancellation, and rain series are mostly zeros.
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// ---------- the day axis ----------
// Year shards are indexed day 0 = Jan 1 (same convention as the collector). The
// aggregation needs one continuous axis across year boundaries, so everything
// runs on absolute day numbers (days since the epoch, UTC) and only the writers
// fold back into per-year arrays.

export const dayNum = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS;
export const yearStartDay = y => Date.UTC(y, 0, 1) / DAY_MS;
export const dayToISO = a => new Date(a * DAY_MS).toISOString().slice(0, 10);
export const isoToDay = iso => Date.parse(iso + 'T00:00:00Z') / DAY_MS;

// ---------- reading the tree ----------

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const listDirs = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; } };
const listFiles = dir => { try { return readdirSync(dir).sort(); } catch { return []; } };

const yearsIn = dir => listFiles(dir).map(f => /^(\d{4})\.json$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort();

// A flat series over [from, to] absolute days: values plus a validity mask, so a
// real 0 mm and a missing day never collapse into the same number.
function flatSeries(dir, from, to, pick) {
  const v = new Float64Array(to - from + 1).fill(NaN);
  for (const y of yearsIn(dir)) {
    const shard = readJson(join(dir, `${y}.json`));
    if (!shard) continue;
    const base = yearStartDay(y);
    pick(shard, (i, value) => {
      const a = base + i;
      if (a >= from && a <= to) v[a - from] = value;
    });
  }
  return v;
}

export function readRainSeries(tree, no, from, to) {
  return flatSeries(join(tree, 'rain', no), from, to, (shard, put) => {
    const mm = shard.mm, cov = shard.cov || {};
    if (!Array.isArray(mm)) return;
    for (let i = 0; i < mm.length; i++) {
      const x = mm[i];
      if (x == null || !Number.isFinite(x)) continue;
      // A day the source aggregated from less than half its hours is not a day,
      // and 42180356 proves it: 20-30 mm reported at cov 0.01 %.
      const c = cov[i] ?? cov[String(i)];
      if (c != null && c < MIN_COVERAGE_PCT) continue;
      if (x < 0 || x > PLAUSIBLE_MAX_MM_DAY) continue;
      put(i, x);
    }
  });
}

export function readLevelSeries(tree, no, from, to) {
  return flatSeries(join(tree, 'gauges', no), from, to, (shard, put) => {
    const v = shard.mean, acc = shard.acc || {};
    if (!Array.isArray(v)) return;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (x == null || !Number.isFinite(x)) continue;
      const a = acc[i] ?? acc[String(i)];
      if (a != null && a < ACC_MIN) continue;
      put(i, x);
    }
  });
}

// ---------- 1.1 assignment ----------

// nodes: { no -> { basin, siteNo, lat, lon, … } } for all routing nodes
// rain:  { no -> { name, catchmentNo, lat, lon } }
export function assignRain(nodes, rain) {
  const relayed = [], badCoord = [], recv = [];
  for (const no of Object.keys(nodes).sort(cmpNo)) {
    const g = nodes[no];
    if (g.siteNo === RELAY_SITE_NO) { relayed.push(no); continue; }
    if (!usableCoords(g)) { badCoord.push(no); continue; }
    recv.push(no);
  }
  const byBasin = new Map();
  for (const no of recv) {
    const b = nodes[no].basin == null ? null : String(nodes[no].basin);
    if (b == null) continue;
    if (!byBasin.has(b)) byBasin.set(b, []);
    byBasin.get(b).push(no);
  }

  const nearest = (r, pool) => {
    let best = null;
    for (const no of pool) {
      const km = haversineKm(r, nodes[no]);
      if (best === null || km < best.km - 1e-9 || (Math.abs(km - best.km) <= 1e-9 && cmpNo(no, best.no) < 0)) {
        best = { no, km };
      }
    }
    return best;
  };

  const own = new Map(recv.map(no => [no, []]));
  const assigned = [], unassigned = [], far = [];
  for (const no of Object.keys(rain).sort(cmpNo)) {
    const r = rain[no];
    if (!usableCoords(r)) { unassigned.push({ no, name: r.name || '', why: 'coords' }); continue; }
    const b = r.catchmentNo == null ? null : String(r.catchmentNo);
    const pool = b != null ? byBasin.get(b) : null;
    let hit = null, via = null;
    if (pool && pool.length) {
      const c = nearest(r, pool);
      if (c && c.km <= MAX_ASSIGN_KM) { hit = c; via = 'basin'; }
    }
    if (!hit) {
      // No basin, or a basin without a single gauge (Emscher). Only a very short
      // hop is defensible then: 44075066 Bottrop-Eigen is 15.5 km from the nearest
      // Lippe gauge, and Emscher rain is not Lippe rain.
      const c = nearest(r, recv);
      if (c && c.km <= MAX_ORPHAN_KM) { hit = c; via = 'orphan'; }
      else {
        unassigned.push({ no, name: r.name || '', why: pool && pool.length ? 'far' : 'orphan-far', km: c ? round(c.km, 2) : null, to: c ? c.no : null });
        continue;
      }
    }
    own.get(hit.no).push(no);
    assigned.push({ no, to: hit.no, km: round(hit.km, 2), via });
    if (hit.km > 25) far.push({ no, km: round(hit.km, 2), to: hit.no });
  }
  return { recv, relayed, badCoord, own, assigned, unassigned, far };
}

// ---------- 1.2 upstream closure and areal mean ----------

export function buildUp(nodes) {
  const up = new Map(Object.keys(nodes).map(no => [no, []]));
  for (const [no, g] of Object.entries(nodes)) {
    const d = g.down;
    if (d != null && up.has(String(d))) up.get(String(d)).push(no);
  }
  for (const list of up.values()) list.sort(cmpNo);
  return up;
}

// Iterative with a seen-set: the down graph carries a 2-cycle, so a recursive
// walk would not terminate.
export function closure(no, up) {
  const seen = new Set([no]);
  const stack = [no];
  while (stack.length) {
    for (const u of up.get(stack.pop()) || []) {
      if (seen.has(u)) continue;
      seen.add(u); stack.push(u);
    }
  }
  return seen;
}

// values: the day's readings of the set's reporting stations (already filtered).
// Below the threshold the day is a non-day, not a thin day — see the header.
export function arealDay(values, setSize) {
  const need = Math.max(MIN_SET_FOR_SERIES, Math.ceil(0.5 * setSize));
  if (values.length < need) return { mm: null, n: 0, med: null, mx: null };
  return {
    mm: round(mean(values), 2),
    n: values.length,
    med: round(median(values), 2),
    mx: round(Math.max(...values), 2),
  };
}

// set: [{ no, series: Float64Array }] over the same [from, to] axis.
export function arealSeries(set, from, to) {
  const len = to - from + 1;
  const mm = new Array(len).fill(null), n = new Array(len).fill(0),
    med = new Array(len).fill(null), mx = new Array(len).fill(null);
  const buf = [];
  for (let i = 0; i < len; i++) {
    buf.length = 0;
    for (const s of set) { const v = s.series[i]; if (!Number.isNaN(v)) buf.push(v); }
    const d = arealDay(buf, set.length);
    mm[i] = d.mm; n[i] = d.n; med[i] = d.med; mx[i] = d.mx;
  }
  return { mm, n, med, mx };
}

// ---------- 1.4 response ----------

// rain: areal mm[] over [from, to]; level: Float64Array of observed daily means.
export function responseStats(rainMm, level, { from, to, id, nRain, unit }) {
  const out = {
    schema: SCHEMA, id, window: { from: dayToISO(from), to: dayToISO(to), days: to - from + 1 },
    nRain, minCoveragePct: MIN_COVERAGE_PCT, align: ALIGN_NOTE,
    lags: [], peakLag: null, rPeak: null, nPeak: 0,
    events: { thresholdMm: EVENT_MM, n: 0, risePer10mm: null },
    unit: { r: 'pearson', rise: `${unit} per 10 mm areal rain` },
  };
  const len = rainMm.length;
  const obs = i => i >= 0 && i < len && !Number.isNaN(level[i]);
  const delta = i => (obs(i) && obs(i - 1)) ? level[i] - level[i - 1] : null;

  for (let lag = 0; lag <= 7; lag++) {
    const xs = [], ys = [];
    for (let d = 0; d < len; d++) {
      if (rainMm[d] == null) continue;
      const dv = delta(d + lag);
      if (dv == null) continue;
      xs.push(rainMm[d]); ys.push(dv);
    }
    const r = pearson(xs, ys);
    out.lags.push({ lag, r: round(r, 4), n: xs.length });
  }
  let best = null;
  for (const l of out.lags) if (l.r != null && (best === null || l.r > best.r)) best = l;
  if (best && best.n >= MIN_RESPONSE_DAYS) { out.peakLag = best.lag; out.rPeak = best.r; out.nPeak = best.n; }
  else if (best) { out.reason = `too few pairs at the peak lag (${best.n} < ${MIN_RESPONSE_DAYS})`; }
  else { out.reason = 'no rain/level pair in the window'; }

  // Event response: how many cm does the level climb per 10 mm of areal rain?
  // Bars above show Pearson r; this number is a slope. Two estimators, and the
  // legend has to say which is which.
  const rises = [];
  for (let d = 0; d < len; d++) {
    if (rainMm[d] == null || rainMm[d] < EVENT_MM) continue;
    let rise = null;
    for (let lag = 0; lag <= 3; lag++) {
      const dv = delta(d + lag);
      if (dv != null && (rise === null || dv > rise)) rise = dv;
    }
    if (rise == null) continue;
    rises.push(rise / (rainMm[d] / 10));
  }
  out.events.n = rises.length;
  if (rises.length >= MIN_EVENTS) out.events.risePer10mm = round(median(rises), 2);
  else if (!out.reason) out.reason = `too few rain events (${rises.length} < ${MIN_EVENTS})`;
  return out;
}

// ---------- writing ----------

class Out {
  constructor(root, check) { this.root = root; this.check = check; this.written = new Set(); this.diffs = []; this.changed = 0; }
  put(rel, obj) {
    const path = join(this.root, rel);
    const text = JSON.stringify(obj);
    this.written.add(rel);
    const old = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (old === text) return;
    if (this.check) { this.diffs.push(old === null ? `missing: ${rel}` : `differs: ${rel}`); return; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    this.changed++;
  }
  // A derived product may not keep history its inputs no longer imply: a gauge that
  // drops below three rain gauges loses its files.
  //
  // This unlinks, so it is fenced first. `--out nrw` would otherwise delete
  // gauges/, rain/, topology.json and the README — the one data set in the repo
  // that cannot be re-fetched, because the source window rolls and a missed day
  // is gone for good. The fence is on the directory NAME, not on a comment.
  prune() {
    const leaf = this.root.replace(/\/+$/, '').split('/').pop();
    if (leaf !== 'precip') throw new Error(`refusing to prune ${this.root}: an output directory must be named "precip", or a stray --out deletes the mirror`);
    for (const forbidden of ['gauges', 'rain', 'temp']) {
      if (existsSync(join(this.root, forbidden))) throw new Error(`refusing to prune ${this.root}: it holds ${forbidden}/, so it is a mirror, not a product`);
    }
    return this.pruneChecked();
  }
  pruneChecked() {
    const walk = dir => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); try { if (!readdirSync(p).length) rmdirSync(p); } catch { /* not empty */ } continue; }
        const rel = p.slice(this.root.length + 1);
        if (this.written.has(rel)) continue;
        if (this.check) { this.diffs.push(`stale: ${rel}`); continue; }
        unlinkSync(p); this.changed++;
      }
    };
    if (existsSync(this.root)) walk(this.root);
  }
}

// ---------- the build ----------

export function build({ tree, out, check = false, generated }) {
  const topo = readJson(join(tree, 'topology.json'));
  const manifest = readJson(join(tree, 'manifest.json'));
  if (!topo || !topo.gauges) throw new Error(`no topology.json under ${tree}`);
  if (!manifest) throw new Error(`no manifest.json under ${tree}`);

  // Routing nodes keep their topology fields and gain the coordinates the
  // topology does not carry.
  const nodes = {};
  for (const [no, g] of Object.entries(topo.gauges)) {
    const meta = readJson(join(tree, 'gauges', no, 'meta.json')) || {};
    nodes[no] = { ...g, lat: meta.lat, lon: meta.lon, name: g.name || meta.name || '', unit: meta.unit || 'cm', km2: g.km2 ?? meta.catchmentKm2 ?? null };
  }
  const rain = {};
  for (const no of listDirs(join(tree, 'rain'))) {
    const meta = readJson(join(tree, 'rain', no, 'meta.json'));
    if (meta) rain[no] = { no, name: meta.name || '', catchmentNo: meta.catchmentNo, lat: meta.lat, lon: meta.lon };
  }

  const a = assignRain(nodes, rain);
  const up = buildUp(nodes);

  // The day axis spans every year present in the mirror.
  let minY = Infinity, maxY = -Infinity;
  for (const no of Object.keys(rain)) for (const y of yearsIn(join(tree, 'rain', no))) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (!Number.isFinite(minY)) throw new Error('no rain shards found');
  const from = yearStartDay(minY), to = yearStartDay(maxY) + daysInYear(maxY) - 1;

  const rainSeries = new Map();
  const seriesOf = no => {
    if (!rainSeries.has(no)) rainSeries.set(no, readRainSeries(tree, no, from, to));
    return rainSeries.get(no);
  };

  const owner = new Map();       // rain no -> gauge no
  const via = new Map();         // rain no -> 'basin' | 'orphan'
  const kmTo = new Map();
  for (const x of a.assigned) { owner.set(x.no, x.to); via.set(x.no, x.via); kmTo.set(x.no, x.km); }

  const o = new Out(out, check);
  const gauges = {};
  const perGaugeSet = new Map();
  let withSeries = 0, withoutRain = 0;

  for (const no of a.recv) {
    const cl = [...closure(no, up)].sort(cmpNo);
    const set = [];
    for (const s of cl) for (const r of (a.own.get(s) || [])) set.push({ no: r, at: s });
    set.sort((x, y) => cmpNo(x.no, y.no));
    perGaugeSet.set(no, set);
    const entry = { n: set.length, up: cl.length, series: set.length >= MIN_SET_FOR_SERIES };
    if (!entry.series) entry.why = set.length === 0 ? 'no rain gauge upstream' : `only ${set.length} rain gauge${set.length === 1 ? '' : 's'} upstream (needs ${MIN_SET_FOR_SERIES})`;
    gauges[no] = entry;
    if (set.length === 0) withoutRain++;
    if (!entry.series) continue;

    const node = nodes[no];
    const loaded = set.map(s => ({ no: s.no, series: seriesOf(s.no) }));
    const ser = arealSeries(loaded, from, to);
    // Three ASSIGNED rain gauges are not three REPORTING ones: a station can
    // have a meta.json and no year shard at all (three do in the mirror), and
    // then a set of three can never clear a threshold of three. The product
    // would be 1096 null days advertised as a series, and the plate would fetch
    // three files to draw nothing. Counted as no product, with the reason.
    const anyDay = ser.mm.some(v => v != null);
    if (!anyDay) {
      const silent = loaded.filter(s => s.series.every(Number.isNaN)).map(s => s.no);
      entry.series = false;
      entry.why = silent.length
        ? `${set.length} rain gauges upstream, but ${silent.length} of them report nothing (${silent.join(', ')})`
        : `${set.length} rain gauges upstream, but no day ever reached the reporting threshold`;
      continue;
    }
    withSeries++;
    writeSeries(o, `${no}`, ser, minY, maxY, from, no);
    o.put(join(no, 'meta.json'), {
      schema: SCHEMA, id: no, name: node.name, water: node.water || '', basin: node.basin ?? null,
      km2: node.km2 ?? null, unit: 'mm/d',
      // Say what the rule does, not what it sounds like: a rain gauge joins the
      // NEAREST receiving gauge of its own basin within 100 km, and the set is
      // the union of those over the upstream closure. That is not a catchment
      // intersection — 17 of 94 sets hold a station further from its owner than
      // the radius of a circle of the owner's own km², and the extreme is a
      // 19.65 km² catchment owning a station 48.9 km away. The km² beside it is
      // the gauge's real catchment area, which is why the two must not be read
      // as one statement.
      method: 'unweighted mean over the reporting rain gauges assigned to this gauge and to every gauge upstream of it; a rain gauge joins the nearest receiving gauge of its own basin (Thiessen with equal areas, not a catchment intersection)',
      dayBoundary: RAIN_DAY_BOUNDARY, levelDayBoundary: LEVEL_DAY_BOUNDARY, align: ALIGN_NOTE,
      minCoveragePct: MIN_COVERAGE_PCT, maxMmPerDay: PLAUSIBLE_MAX_MM_DAY,
      nRain: set.length, nUpstream: cl.length, upstream: cl,
      set: set.map(s => ({ no: s.no, name: rain[s.no].name, km: kmTo.get(s.no) ?? null, via: via.get(s.no) ?? null, at: s.at })),
    });
    // response.json is written even when it cannot be computed: a 404 under
    // /nrw/precip/ would make the browser check "every /nrw/ response is 2xx" red,
    // and "why not" is information the plate has to print.
    const level = readLevelSeries(tree, no, from, to);
    // no `generated` here on purpose: it would rewrite all 94 files every day
    // for a date the run's own index.json already carries, and this branch keeps
    // its history forever
    o.put(join(no, 'response.json'), responseStats(ser.mm, level, { from, to, id: no, nRain: set.length, unit: node.unit || 'cm' }));
  }

  // Basin products: the same shape, but the set is the basin's own rain gauges,
  // not an upstream closure — a basin has no downstream node to close towards.
  const basins = [];
  for (const [b, info] of Object.entries(topo.basins)) {
    const set = (info.rain || []).filter(r => rain[r] && usableCoords(rain[r])).sort(cmpNo);
    // the same floor the gauges use: a basin of two rain gauges can never clear
    // a threshold of three, so its series would be 1096 nulls under a name
    const hasSeries = set.length >= MIN_SET_FOR_SERIES;
    const rel = join('basins', b);
    const mouth = info.mouth && nodes[info.mouth] ? nodes[info.mouth] : null;
    o.put(join(rel, 'meta.json'), {
      schema: SCHEMA, id: b, name: info.name || '', water: info.river || '', basin: b,
      km2: mouth ? mouth.km2 ?? null : null, unit: 'mm/d',
      method: 'unweighted mean over the reporting rain gauges of the basin (Thiessen with equal areas)',
      note: 'a basin is the source\'s own grouping; this is not one gauge\'s catchment',
      dayBoundary: RAIN_DAY_BOUNDARY, levelDayBoundary: LEVEL_DAY_BOUNDARY, align: ALIGN_NOTE,
      minCoveragePct: MIN_COVERAGE_PCT, maxMmPerDay: PLAUSIBLE_MAX_MM_DAY,
      nRain: set.length, nUpstream: (info.gauges || []).length, upstream: info.gauges || [],
      set: set.map(r => ({ no: r, name: rain[r].name, km: kmTo.get(r) ?? null, via: via.get(r) ?? null, at: owner.get(r) ?? null })),
    });
    const ser = hasSeries ? arealSeries(set.map(r => ({ no: r, series: seriesOf(r) })), from, to)
      : { mm: new Array(to - from + 1).fill(null), n: new Array(to - from + 1).fill(0), med: [], mx: [] };
    if (hasSeries) writeSeries(o, rel, ser, minY, maxY, from, b);
    basins.push({ b, info, set, ser, mouth });
  }

  // ---------- overview.json ----------
  // The right edge is the newest rain day the MIRROR has, never the clock: the
  // export lags ~24 h and a plate that ends at "today" would draw a phantom gap.
  let lastDay = from - 1;
  for (const no of Object.keys(rain)) {
    const s = seriesOf(no);
    for (let i = s.length - 1; i > lastDay - from; i--) if (!Number.isNaN(s[i])) { lastDay = from + i; break; }
  }
  const winTo = lastDay, winFrom = Math.max(from, winTo - OVERVIEW_DAYS + 1);
  const slice = arr => arr.slice(winFrom - from, winTo - from + 1);
  const all = [];
  for (const x of basins) for (const v of slice(x.ser.mm)) if (v != null && v > 0) all.push(v);
  const bins = [0.5, 0.8, 0.95].map(q => round(Math.round((quantile(all, q) ?? 0) * 2) / 2, 1));
  const rows = basins.map(x => {
    const mm = slice(x.ser.mm), n = slice(x.ser.n);
    const tail = mm.slice(-OVERVIEW_SUM_DAYS);
    const have = tail.filter(v => v != null);
    return {
      no: x.b, name: x.info.name || '', river: x.info.river ? String(x.info.river).toUpperCase() : null,
      km2: x.mouth ? x.mouth.km2 ?? null : null, set: x.set.length, gauges: (x.info.gauges || []).length,
      mm, n, sum7: have.length ? round(have.reduce((s, v) => s + v, 0), 1) : null, n7: have.length,
    };
  }).sort((p, q) => cmpNo(p.no, q.no));
  o.put('overview.json', {
    schema: SCHEMA, generated, sourceExportAt: manifest.sourceExportAt || null,
    window: { from: dayToISO(winFrom), to: dayToISO(winTo), days: winTo - winFrom + 1 },
    align: ALIGN_NOTE, bins, basins: rows,
  });

  // ---------- index.json ----------
  const cyclic = [];
  for (const [no, g] of Object.entries(nodes)) {
    const d = g.down == null ? null : String(d0(g.down));
    if (d && nodes[d] && String(d0(nodes[d].down)) === no) cyclic.push(no);
  }
  const counts = {
    routingNodes: Object.keys(nodes).length,
    receivingNodes: a.recv.length,
    relayedExcluded: a.relayed.length,
    badCoordNodes: a.badCoord.length,
    rainAssignedBasin: a.assigned.filter(x => x.via === 'basin').length,
    rainAssignedOrphan: a.assigned.filter(x => x.via === 'orphan').length,
    rainUnassigned: a.unassigned.length,
    withSeries, withoutRain,
    cyclicNodes: cyclic.sort(cmpNo).length,
    // the members, not only how many: the source could repair Erkrath/Eigen and
    // grow a different 2-cycle in the same run, and a count would not notice
    cyclicIds: cyclic.sort(cmpNo),
    // The newest rain day with a READING, which is not the newest day the source
    // window names: the export runs mid-afternoon and a rain day starts at 07:00,
    // so the current day is always half a day old and filtered out by coverage.
    // Both the overview and every station plate hang their right edge on this one
    // value — one picture, one estimator, and the plate that reads it prints the
    // date it stands for.
    lastRainDay: dayToISO(lastDay),
  };
  o.put('index.json', {
    schema: SCHEMA, generated,
    rule: {
      latBox: LAT_BOX, lonBox: LON_BOX, maxAssignKm: MAX_ASSIGN_KM, maxOrphanKm: MAX_ORPHAN_KM,
      minCoveragePct: MIN_COVERAGE_PCT, maxMmPerDay: PLAUSIBLE_MAX_MM_DAY, minSetForSeries: MIN_SET_FOR_SERIES,
    },
    counts,
    unassigned: a.unassigned,
    far: a.far.sort((x, y) => y.km - x.km),
    gauges,
  });

  o.prune();

  // The manifest is the collector's file, but the precip block is this script's
  // fact, so this script writes it — CI runs `Collect` then this then the gate,
  // and a manifest that advertised a product built by a later step would be a
  // promise, not a reading. The app reads `manifest.precip[no].series` to decide
  // whether a station plate may ask for a shard at all.
  const mPath = join(tree, 'manifest.json');
  const patched = { ...manifest, precip: gauges, counts: { ...manifest.counts, precip: withSeries }, coverage: { ...manifest.coverage, precip: counts } };
  const mText = JSON.stringify(patched);
  const mOld = existsSync(mPath) ? readFileSync(mPath, 'utf8') : null;
  if (mOld !== mText) {
    if (check) o.diffs.push('differs: ../manifest.json (precip block)');
    else { writeFileSync(mPath, mText); o.changed++; }
  }

  return { out: o, counts, from, to, winFrom, winTo, bins, assign: a, perGaugeSet };
}

const d0 = v => v == null ? null : String(v);

function writeSeries(o, rel, ser, minY, maxY, from, id) {
  for (let y = minY; y <= maxY; y++) {
    const n = daysInYear(y), base = yearStartDay(y) - from;
    const cut = (arr, fill) => Array.from({ length: n }, (_, i) => {
      const j = base + i;
      return j >= 0 && j < arr.length ? arr[j] : fill;
    });
    o.put(join(rel, `${y}.json`), {
      id, y,
      mm: cut(ser.mm, null), n: cut(ser.n, 0), med: cut(ser.med, null), mx: cut(ser.mx, null),
    });
  }
}

// ---------- CLI ----------

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
  const out = flag('--out') || join(tree, 'precip');
  const check = args.includes('--check');
  const generated = (process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date()).toISOString().slice(0, 10);

  const r = build({ tree, out, check, generated });
  const c = r.counts;
  console.log(`precip: ${c.routingNodes} routing nodes, ${c.receivingNodes} receiving (${c.relayedExcluded} relayed, ${c.badCoordNodes} bad coords)`);
  console.log(`  rain: ${c.rainAssignedBasin} basin + ${c.rainAssignedOrphan} orphan assigned, ${c.rainUnassigned} unassigned`);
  console.log(`  series: ${c.withSeries} gauges (>= ${MIN_SET_FOR_SERIES} rain gauges), ${c.withoutRain} with none; ${c.cyclicNodes} cyclic nodes`);
  console.log(`  window ${dayToISO(r.winFrom)} … ${dayToISO(r.winTo)}, ramp ${r.bins.join(' / ')} mm`);
  if (check) {
    if (r.out.diffs.length) {
      console.error(`--check: ${r.out.diffs.length} file(s) differ from the rule:`);
      for (const d of r.out.diffs.slice(0, 40)) console.error(`  ${d}`);
      if (r.out.diffs.length > 40) console.error(`  … and ${r.out.diffs.length - 40} more`);
      process.exit(1);
    }
    console.log('--check: tree matches the rule');
  } else {
    console.log(`  ${r.out.changed} file(s) written`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv);
