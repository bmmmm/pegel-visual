#!/usr/bin/env node
// Captures every PEGELONLINE station's current water level into a daily
// snapshot on the `archive` branch — the "yesterday" baseline for the global
// ?rising overview (the REST API exposes no bulk history, only the current
// value per station, so the baseline has to be accumulated here day by day).
//
// One bulk request per run (unlike fetch-wsv-archive.mjs there is nothing to
// throttle), appended as one day slot into a month-sharded file:
//
//   archive/snapshots/YYYY-MM.json
//     { y, m,
//       days:     [iso-capture-timestamp | null, ...],   one slot per day of month
//       stations: { <uuid>: { n, w, v: [cm | null, ...], t?: 1 } } }
//
// days[i] null = no value could be obtained for day i+1 (no run landed on it
// and the self-heal below found no data); stations[uuid].v[i] null = the
// station was missing from an otherwise-successful capture. Day boundaries in
// MEZ (fixed UTC+1), the same convention as fetch-wsv-archive.mjs' condense().
// Re-running on the same day overwrites only that day's slot (idempotent).
// Shards accumulate forever; --max-months is the pruning lever, deliberately
// not passed by the CI workflow.
//
// Self-heal: GitHub cron drift reached 3-9h in late August 2026 and twice
// pushed the daily run past MEZ midnight — the run then lands in the NEXT
// day's slot and the scheduled day stays null (2026-08-27 was lost this way).
// So after the live capture, every run scans the last BACKFILL_WINDOW_DAYS
// for null day slots and refills them from the per-station timeseries
// endpoint (raw data is retained ~30 days), picking the measurement nearest
// the nominal capture instant and passing it through the same plausibility
// gate. The drifted run that skipped a day repairs it in the same breath.
// A healed slot is stamped with the exact nominal instant (…T15:17:00.000Z) —
// the too-round timestamp marks it as backfilled.
//
// A station entry gains `t: 1` when its own archived daily min/max record says
// the tide dominates it (median daily span >= TIDAL_SPAN_CM — rivers measure
// 3-6 cm, tidal gauges 195-280, checked against the real archive 2026-08).
// The client needs this because the bulk API marks only some tidal gauges
// with an MThw characteristic value (Rotterdam, Helgoland and every barrage
// gauge carry none at all), and a day-apart point diff at a tidal gauge
// measures the tide, not the river. The archive dir defaults to the snapshot
// dir's parent — exactly where the CI checkout has it; without an archive
// the flags are simply omitted.
//
// Captured values pass a plausibility gate before they land in the slot: the
// raw bulk feed occasionally serves a single wild point well inside the
// absolute sentinel bounds (LOBITH 2026-08-18/19: 2000+cm beside a real 614),
// and a day-apart diff against such a point poisons the ?rising board. The
// gate reads the station's own archived record (envelope) and yesterday's
// captured value — see implausibleCapture() for the exact verdict. Without
// an archive checkout only the absolute bounds apply.
//
//   node scripts/snapshot-wsv.mjs --out archive-branch/archive/snapshots
//   node scripts/snapshot-wsv.mjs --out archive/snapshots --max-months 24
//   node scripts/snapshot-wsv.mjs --out /tmp/snaps --archive /tmp/archive
//   node scripts/snapshot-wsv.mjs --heal-days 33 --heal-source zip
//     # one-off: slots older than the REST retention, out of the ZIP archive
//     # (2026-08-01..08-12 — the days before the capture existed)
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM, fetchRawRange } from './fetch-wsv-archive.mjs';

const API = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2';
// PEGEL_NOW pins the clock for tests and local two-day rehearsals
const now = process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const OUT = opt('out', 'archive/snapshots');
const ARCHIVE_DIR = opt('archive', join(OUT, '..')); // per-station daily min/max bundles
const MAX_MONTHS = Number(opt('max-months', 0)); // 0 = keep everything

export const TIDAL_SPAN_CM = 40;

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function mezParts(d) {
  const mez = new Date(d.getTime() + 36e5);
  return { y: mez.getUTCFullYear(), m: mez.getUTCMonth() + 1, dayIdx: mez.getUTCDate() - 1 };
}

export const shardName = (y, m) => `${y}-${String(m).padStart(2, '0')}.json`;

export function emptyShard(y, m) {
  const n = daysInMonth(y, m);
  return { y, m, days: Array(n).fill(null), stations: {} };
}

// same W-timeseries filter as fetch-wsv-archive.mjs' station discovery; a
// station with no finite current value still gets an entry so its name/water
// survive in the shard — only its day slot stays null
export function parseBulkForSnapshot(raw) {
  return raw
    .map(s => ({ s, w: (s.timeseries || []).find(t => t.shortname === 'W') }))
    .filter(({ w }) => w)
    .map(({ s, w }) => ({
      uuid: s.uuid,
      n: s.shortname,
      w: (s.water && s.water.shortname) || '',
      v: w.currentMeasurement && Number.isFinite(w.currentMeasurement.value)
        ? w.currentMeasurement.value : null,
    }));
}

// pure upsert of one capture into a shard; earlier days of stations absent
// from this run survive untouched. The tidal flag reflects only the current
// run — deterministic, never sticky.
export function applySnapshot(shard, { dayIdx, captureIso, stations }) {
  const n = shard.days.length;
  const days = shard.days.slice();
  days[dayIdx] = captureIso;
  const out = { y: shard.y, m: shard.m, days, stations: { ...shard.stations } };
  for (const s of stations) {
    const cur = out.stations[s.uuid] || { n: s.n, w: s.w, v: Array(n).fill(null) };
    const v = cur.v.slice();
    v[dayIdx] = s.v;
    out.stations[s.uuid] = { n: s.n, w: s.w, v, ...(s.t ? { t: 1 } : {}) };
  }
  return out;
}

// median daily min/max span of a year bundle ({y,min,max}); null when the
// record is too thin to judge (a fresh January current.json has a handful
// of days — the caller then falls back to the last closed year)
export function medianDailySpan(bundle, minDays = 14) {
  if (!bundle || !Array.isArray(bundle.min) || !Array.isArray(bundle.max)) return null;
  const spans = [];
  for (let i = 0; i < bundle.min.length; i++) {
    if (bundle.min[i] != null && bundle.max[i] != null) spans.push(bundle.max[i] - bundle.min[i]);
  }
  if (spans.length < minDays) return null;
  spans.sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)];
}

// a station's recent archived record: the running year plus the last closed
// one — shared substrate of the tidal flag and the plausibility envelope
function stationRecordBundles(archiveDir, uuid) {
  const read = f => {
    try { return JSON.parse(readFileSync(join(archiveDir, uuid, f), 'utf8')); }
    catch { return null; }
  };
  const closed = read('closed.json');
  return [read('current.json'), Array.isArray(closed) && closed.length ? closed[closed.length - 1] : null];
}

// Plausibility envelope from the station's own archived record: observed
// min/max across the bundles, widened by a margin scaled to how this gauge
// actually moves (4x its median daily span, a quarter of its observed range,
// at least ENVELOPE_FLOOR_CM — whichever is widest, so quiet canal gauges,
// tidal gauges and flood-prone rivers each get sensible headroom). Values in
// the gauge's own unit, like the archive. Null when fewer than minDays days
// are on record — a fresh station is not judged. Exists because the raw feed
// occasionally serves a single wild point that is well inside the absolute
// sentinel bounds (LOBITH 2026-08-18/19: 2000+cm next to a real 614) and
// would poison the day slot the ?rising baseline is built from.
export const ENVELOPE_FLOOR_CM = 100;
export function plausibilityEnvelope(bundles, { minDays = 14 } = {}) {
  let lo = Infinity, hi = -Infinity;
  const spans = [];
  for (const b of bundles) {
    if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) continue;
    for (let i = 0; i < b.min.length; i++) {
      if (b.min[i] == null || b.max[i] == null) continue;
      if (b.min[i] < lo) lo = b.min[i];
      if (b.max[i] > hi) hi = b.max[i];
      spans.push(b.max[i] - b.min[i]);
    }
  }
  if (spans.length < minDays) return null;
  spans.sort((a, b) => a - b);
  const margin = Math.max(4 * spans[Math.floor(spans.length / 2)], 0.25 * (hi - lo), ENVELOPE_FLOOR_CM);
  return { lo: lo - margin, hi: hi + margin };
}

// absolute sentinel bounds, shared with condense() and the totals build —
// the coarse outer gate for stations too fresh to have an envelope
export const plausibleAbs = v => v >= PLAUSIBLE_MIN_CM && v <= PLAUSIBLE_MAX_CM;

// the station's most recent captured value, scanning the given shards in
// order (current month first, then the previous one for day-1 runs)
export function lastCapturedValue(shards, uuid) {
  for (const shard of shards) {
    const v = shard && shard.stations && shard.stations[uuid] && shard.stations[uuid].v;
    if (!Array.isArray(v)) continue;
    for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i];
  }
  return null;
}

// The gate's verdict. Outside its own envelope a value is believed only when
// yesterday vouches for it: a record flood arrives over days (yesterday was
// already high, the daily jump is moderate), a sensor artifact stands alone
// (LOBITH: 614 -> 2013 overnight). Calibrated 2026-08-27 against the real
// archive: 0 of 10286 captured August values dropped, the LOBITH spike is.
// No envelope (fresh station) -> only the absolute sentinel bounds; outside
// the envelope with no previous capture at all -> dropped (nobody vouches).
export function implausibleCapture({ v, envelope, prev, span }) {
  if (!envelope) return !plausibleAbs(v);
  if (v >= envelope.lo && v <= envelope.hi) return false;
  if (prev == null) return true;
  return Math.abs(v - prev) > Math.max(10 * (span ?? 0), 2 * ENVELOPE_FLOOR_CM);
}

// ---------- self-heal backfill (pure parts) ----------

// how far back a run tries to refill null day slots; well inside the WSV
// API's ~30-day raw retention, small enough to bound the daily retry cost
// when a day is permanently unobtainable
export const BACKFILL_WINDOW_DAYS = 7;
// a healed day is only written when at least this share of the roster
// yielded a point — a thin day would block future heal attempts while
// serving as a worse baseline than an honest null
export const BACKFILL_MIN_COVERAGE = 0.5;
// How far this run looks back, and where it takes its points from. The daily
// job stays on the defaults: REST reaches ~30 days back and costs one request
// per station, while the ZIP path needs a prepare POST per station and would
// spend 739 of them every day on a hole that may well be unhealable. A wider
// window is a one-off dispatch for slots OLDER than the REST retention — those
// are reachable only through the ZIP archive (2026-08-01..08-12 was the case
// this was built for).
// validated, not defaulted: heal-days arrives as free text from a workflow
// dispatch input, and "3O" or "33 days" quietly becoming 7 would be a green
// run that healed nothing anyone asked for
const HEAL_DAYS = (() => {
  const raw = opt('heal-days', '');
  if (raw === '') return BACKFILL_WINDOW_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 400) throw new Error(`--heal-days ${raw}: want a whole number of days, 1..400`);
  return n;
})();
const HEAL_SOURCE = opt('heal-source', 'rest');
if (HEAL_SOURCE !== 'rest' && HEAL_SOURCE !== 'zip') throw new Error(`--heal-source ${HEAL_SOURCE}: want rest or zip`);
// the ZIP prepare endpoint rejects bursts (see fetch-wsv-archive.mjs, worker())
const HEAL_POOL = HEAL_SOURCE === 'zip' ? 2 : 10;
const HEAL_THROTTLE_MS = HEAL_SOURCE === 'zip' ? 1500 : 0;
// the nominal capture instant of a day, mirroring the primary cron slot —
// backfilled values stay comparable to their live-captured neighbours
export const CAPTURE_UTC = { hour: 15, minute: 17 };

const nominalCaptureIso = (y, m, dayIdx) =>
  new Date(Date.UTC(y, m - 1, dayIdx + 1, CAPTURE_UTC.hour, CAPTURE_UTC.minute)).toISOString();

// null day slots of the last windowDays MEZ days (today excluded — that is
// the live capture's slot), oldest first so a later hole finds a healed
// witness. Days of months without a shard on disk are pre-history, not holes.
export function missingRecentDays(shards, refDate, windowDays = BACKFILL_WINDOW_DAYS) {
  const out = [];
  for (let k = windowDays; k >= 1; k--) {
    const { y, m, dayIdx } = mezParts(new Date(refDate.getTime() - k * 864e5));
    const shard = shards.find(s => s && s.y === y && s.m === m);
    // a shapeless shard (the previous month loads unvalidated) cannot be
    // healed into — treat it like pre-history
    if (!shard || !Array.isArray(shard.days) || shard.days[dayIdx] != null) continue;
    out.push({ y, m, dayIdx, targetIso: nominalCaptureIso(y, m, dayIdx) });
  }
  return out;
}

// the finite measurement closest to the target instant, taken only from the
// target's own MEZ day — a neighbouring day's point must never impersonate a
// missing one
export function pickNearestMeasurement(measurements, targetIso) {
  const target = new Date(targetIso);
  const day = mezParts(target);
  let best = null, bestDist = Infinity;
  for (const p of measurements || []) {
    if (!p || !Number.isFinite(p.value)) continue;
    const t = new Date(p.timestamp);
    if (Number.isNaN(t.getTime())) continue;
    const d = mezParts(t);
    if (d.y !== day.y || d.m !== day.m || d.dayIdx !== day.dayIdx) continue;
    const dist = Math.abs(t - target);
    if (dist < bestDist) { bestDist = dist; best = p.value; }
  }
  return best;
}

// the station's last non-null value strictly BEFORE the given day — the
// plausibility witness for a backfilled slot (lastCapturedValue would happily
// testify with a value from AFTER the hole)
export function lastValueBefore(shards, uuid, { y, m, dayIdx }) {
  const key = y * 12 + m;
  const ordered = shards
    .filter(s => s && s.y * 12 + s.m <= key)
    .sort((a, b) => (b.y * 12 + b.m) - (a.y * 12 + a.m));
  for (const shard of ordered) {
    const v = shard.stations && shard.stations[uuid] && shard.stations[uuid].v;
    if (!Array.isArray(v)) continue;
    const from = (shard.y * 12 + shard.m === key ? dayIdx : v.length) - 1;
    for (let i = from; i >= 0; i--) if (v[i] != null) return v[i];
  }
  return null;
}

// assemble one healed day from per-station point lists: nearest-to-nominal
// point, gated exactly like a live capture. records maps uuid to the
// {envelope, span} the live loop already derived from the archive.
export function backfillDayStations(roster, points, hole, records, shards) {
  let dropped = 0;
  const stations = roster.map(s => {
    let v = pickNearestMeasurement(points.get(s.uuid), hole.targetIso);
    if (v != null) {
      const rec = records.get(s.uuid) || {};
      if (implausibleCapture({ v, envelope: rec.envelope, span: rec.span, prev: lastValueBefore(shards, s.uuid, hole) })) {
        v = null;
        dropped++;
      }
    }
    return { uuid: s.uuid, n: s.n, w: s.w, v, ...(s.t ? { t: 1 } : {}) };
  });
  return { stations, captured: stations.filter(x => x.v != null).length, dropped };
}

export function shardIsPrunable(y, m, refDate, maxMonths) {
  const ref = mezParts(refDate);
  return (ref.y - y) * 12 + (ref.m - m) > maxMonths;
}

function pruneOldShards(dir, maxMonths, refDate) {
  for (const f of readdirSync(dir)) {
    const hit = /^(\d{4})-(\d{2})\.json$/.exec(f);
    if (hit && shardIsPrunable(Number(hit[1]), Number(hit[2]), refDate, maxMonths)) {
      unlinkSync(join(dir, f));
      console.log(`pruned ${f}`);
    }
  }
}

// ---------- self-heal backfill (network side) ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// raw 15-min points for one station over the heal window; 404 means WSV keeps
// no history timeseries for this gauge — an empty list, not a failure
async function fetchStationMeasurements(uuid, startIso, endIso) {
  const url = `${API}/stations/${uuid}/W/measurements.json`
    + `?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('measurements HTTP ' + res.status);
  return res.json();
}

// The month shards a heal window of `days` reaches back over, newest first —
// index 0 is the current month, which the caller replaces with the shard it
// has just written the live capture into. A month with no file on disk stays
// null in the list; missingRecentDays reads that as pre-history, which is what
// it is.
export function healWindowMonths(refDate, days) {
  const out = [];
  for (let k = 0; k <= days; k++) {
    const { y, m } = mezParts(new Date(refDate.getTime() - k * 864e5));
    if (!out.some(p => p.y === y && p.m === m)) out.push({ y, m });
  }
  return out;
}

function healWindowShards(dir, refDate, days) {
  return healWindowMonths(refDate, days).map(({ y, m }) => {
    try { return JSON.parse(readFileSync(join(dir, shardName(y, m)), 'utf8')); } catch { return null; }
  });
}

// the same window out of the ZIP archive, for holes the REST retention no
// longer covers. fetchRawRange takes whole days and the endpoint reads both
// ends as MIDNIGHT, so the end has to be the day AFTER the last hole or that
// day comes back as its 00:00 reading alone (the trap requestEnd documents).
// The points come back in the archive's own {timestamp, value} shape, which is
// what pickNearestMeasurement already reads. The start rounds down to the
// calendar day holding the MEZ boundary (23:00Z of the day before) and so
// drags in one extra day — harmless, pickNearestMeasurement takes points only
// from the hole's own MEZ day.
export function zipWindowDays(startIso, endIso) {
  return [startIso.slice(0, 10), new Date(Date.parse(endIso) + 36e5).toISOString().slice(0, 10)];
}

async function fetchStationMeasurementsZip(uuid, startIso, endIso) {
  const [start, end] = zipWindowDays(startIso, endIso);
  return fetchRawRange(uuid, start, end);
}

// refill recent null day slots from the raw timeseries. One request per
// station spanning all holes; per-station failures degrade to an empty point
// list, so a broad outage simply fails the coverage floor instead of writing
// a thin day. Returns the (possibly replaced) shards plus which shard files
// were healed into.
async function healMissingDays(shards, roster, records) {
  const holes = missingRecentDays(shards, now, HEAL_DAYS);
  const healedMonths = new Set();
  // before the early return: a dispatch that found nothing must say so, or a
  // wide --heal-days that reached nothing looks exactly like a normal run
  console.log(`backfill: ${holes.length} hole(s) in the last ${HEAL_DAYS} days`
    + ` across ${shards.filter(Boolean).length} shard(s), source ${HEAL_SOURCE}`);
  if (!holes.length) return { shards, healedMonths };
  const first = holes[0], last = holes[holes.length - 1];
  // a MEZ day starts at 23:00Z of the previous calendar day
  const startIso = new Date(Date.UTC(first.y, first.m - 1, first.dayIdx + 1) - 36e5).toISOString();
  const endIso = new Date(Date.UTC(last.y, last.m - 1, last.dayIdx + 1) - 36e5 + 864e5).toISOString();
  const fetchOne = HEAL_SOURCE === 'zip' ? fetchStationMeasurementsZip : fetchStationMeasurements;
  console.log(`backfill: ${first.y}-${first.m}-${first.dayIdx + 1} .. ${last.y}-${last.m}-${last.dayIdx + 1}`
    + `, ${roster.length} stations at pool ${HEAL_POOL}`);
  const points = new Map(await mapPool(roster, HEAL_POOL, async s => {
    if (HEAL_THROTTLE_MS) await sleep(HEAL_THROTTLE_MS);
    return [s.uuid, await fetchOne(s.uuid, startIso, endIso).catch(() => [])];
  }));
  for (const hole of holes) {
    const label = hole.targetIso.slice(0, 10);
    const { stations, captured, dropped } = backfillDayStations(roster, points, hole, records, shards);
    if (captured < BACKFILL_MIN_COVERAGE * roster.length) {
      console.log(`backfill ${label} skipped: ${captured}/${roster.length} stations below coverage floor`);
      continue;
    }
    const i = shards.findIndex(s => s && s.y === hole.y && s.m === hole.m);
    shards[i] = applySnapshot(shards[i], { dayIdx: hole.dayIdx, captureIso: hole.targetIso, stations });
    healedMonths.add(shardName(hole.y, hole.m));
    console.log(`backfill ${label}: ${captured}/${roster.length} stations, ${dropped} implausible dropped`);
  }
  return { shards, healedMonths };
}

async function main() {
  const res = await fetch(
    `${API}/stations.json?includeTimeseries=true&includeCurrentMeasurement=true`,
    { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('bulk stations HTTP ' + res.status);
  const stations = parseBulkForSnapshot(await res.json());

  const { y, m, dayIdx } = mezParts(now);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, shardName(y, m));
  let shard;
  try {
    shard = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // never silently reinitialize: the shard is accumulated-forever history
      throw new Error(`${path} exists but is unreadable — refusing to overwrite: ${e.message}`);
    }
    shard = emptyShard(y, m);
  }
  if (!Array.isArray(shard.days) || shard.days.length !== daysInMonth(y, m)) {
    throw new Error(`${path}: shard shape mismatch for ${y}-${m}`);
  }
  // the previous month's shard backs the gate's "yesterday" on day-1 runs
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  let prevShard = null;
  try { prevShard = JSON.parse(readFileSync(join(OUT, shardName(py, pm)), 'utf8')); } catch {}

  let flagged = 0, dropped = 0;
  const records = new Map(); // uuid -> {envelope, span}, reused by the self-heal
  for (const s of stations) {
    const [current, lastClosed] = stationRecordBundles(ARCHIVE_DIR, s.uuid);
    const span = medianDailySpan(current) ?? medianDailySpan(lastClosed);
    const envelope = plausibilityEnvelope([current, lastClosed]);
    records.set(s.uuid, { envelope, span });
    if (span != null && span >= TIDAL_SPAN_CM) { s.t = 1; flagged++; }
    if (s.v == null) continue;
    // plausibility gate — an implausible point becomes a gap in the day
    // slot, never the ?rising baseline
    if (implausibleCapture({ v: s.v, envelope, span, prev: lastCapturedValue([shard, prevShard], s.uuid) })) {
      console.log(`implausible: ${s.n} ${s.v}${envelope ? ` (envelope ${Math.round(envelope.lo)}..${Math.round(envelope.hi)})` : ' (sentinel bounds)'}`);
      s.v = null;
      dropped++;
    }
  }

  // the pinned clock stamps the capture too — a PEGEL_NOW rehearsal must yield
  // a slot that is old enough to serve as a baseline, not one stamped "now"
  const next = applySnapshot(shard, { dayIdx, captureIso: now.toISOString(), stations });
  // self-heal AFTER the live capture: the very run whose drift skipped a day
  // repairs it in the same breath, and a later hole sees the healed witness.
  // Every month the window touches has to be on the list — missingRecentDays
  // treats a month with no shard here as pre-history, so handing it only the
  // current and previous month would let a wide --heal-days report a window it
  // never actually searched.
  const window = healWindowShards(OUT, now, HEAL_DAYS);
  const { shards: healed, healedMonths } = await healMissingDays([next, ...window.slice(1)], stations, records);
  for (let i = 0; i < healed.length; i++) {
    const s = healed[i];
    if (!s) continue;
    const file = shardName(s.y, s.m);
    if (i === 0 || healedMonths.has(file)) writeFileSync(join(OUT, file), JSON.stringify(s));
  }
  const captured = stations.filter(s => s.v != null).length;
  console.log(`snapshot ${shardName(y, m)} day ${dayIdx + 1}: ${captured}/${stations.length} stations captured, ${flagged} tidal-flagged, ${dropped} implausible dropped`);

  if (MAX_MONTHS > 0) pruneOldShards(OUT, MAX_MONTHS, now);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
