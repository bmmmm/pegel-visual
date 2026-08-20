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
// days[i] null = no successful run on day i+1; stations[uuid].v[i] null = the
// station was missing from an otherwise-successful capture. Day boundaries in
// MEZ (fixed UTC+1), the same convention as fetch-wsv-archive.mjs' condense().
// Re-running on the same day overwrites only that day's slot (idempotent).
// Shards accumulate forever; --max-months is the pruning lever, deliberately
// not passed by the CI workflow.
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
//   node scripts/snapshot-wsv.mjs --out archive-branch/archive/snapshots
//   node scripts/snapshot-wsv.mjs --out archive/snapshots --max-months 24
//   node scripts/snapshot-wsv.mjs --out /tmp/snaps --archive /tmp/archive
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function stationDailySpan(archiveDir, uuid) {
  const read = f => {
    try { return JSON.parse(readFileSync(join(archiveDir, uuid, f), 'utf8')); }
    catch { return null; }
  };
  const fromCurrent = medianDailySpan(read('current.json'));
  if (fromCurrent != null) return fromCurrent;
  const closed = read('closed.json');
  return Array.isArray(closed) && closed.length ? medianDailySpan(closed[closed.length - 1]) : null;
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

async function main() {
  const res = await fetch(
    `${API}/stations.json?includeTimeseries=true&includeCurrentMeasurement=true`,
    { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('bulk stations HTTP ' + res.status);
  const stations = parseBulkForSnapshot(await res.json());
  let flagged = 0;
  for (const s of stations) {
    const span = stationDailySpan(ARCHIVE_DIR, s.uuid);
    if (span != null && span >= TIDAL_SPAN_CM) { s.t = 1; flagged++; }
  }

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

  // the pinned clock stamps the capture too — a PEGEL_NOW rehearsal must yield
  // a slot that is old enough to serve as a baseline, not one stamped "now"
  const next = applySnapshot(shard, { dayIdx, captureIso: now.toISOString(), stations });
  writeFileSync(path, JSON.stringify(next));
  const captured = stations.filter(s => s.v != null).length;
  console.log(`snapshot ${shardName(y, m)} day ${dayIdx + 1}: ${captured}/${stations.length} stations captured, ${flagged} tidal-flagged`);

  if (MAX_MONTHS > 0) pruneOldShards(OUT, MAX_MONTHS, now);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
