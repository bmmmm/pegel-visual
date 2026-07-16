#!/usr/bin/env node
// Fetches the WSV/PEGELONLINE historical raw archive (water levels since 2000,
// DL-DE->Zero-2.0) and condenses it into small static year files the page can
// serve same-origin:
//
//   archive/<station-uuid>/<year>.json    {"y":2024,"min":[...],"max":[...]}
//   archive/<station-uuid>/current.json   same shape, running year, refreshed
//   archive/<station-uuid>/meta.json      {"name":"BONN","fetchedThrough":2025}
//
// min/max are ints (cm) or null per day (day boundaries in MEZ, matching the
// archive's year-round UTC+1 timestamps); daily min+max keeps floods and
// droughts visible at ~1/300 the raw size.
//
// The endpoint sends its CORS header twice, so browsers cannot fetch it —
// this script (run locally for the backfill, monthly via CI for the running
// year) is the workaround. Be polite: sequential, throttled, resumable.
//
// Usage:
//   node scripts/fetch-wsv-archive.mjs                    # backfill 2000..last year
//   node scripts/fetch-wsv-archive.mjs --current          # refresh running year only
//   node scripts/fetch-wsv-archive.mjs --station BONN     # one station
//   node scripts/fetch-wsv-archive.mjs --from 2020 --to 2024 --out archive
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const API = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2';
const PREPARE = 'https://www.pegelonline.wsv.de/gast/historische-zeitreihen/prepare-download';
const THROTTLE_MS = 1500;
// PEGEL_NOW pins the clock for tests (e.g. PEGEL_NOW=2027-01-03 to rehearse the
// January year-freeze); production runs use the real clock
const now = process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date();
const CURRENT_YEAR = now.getUTCFullYear();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);

const OUT = opt('out', 'archive');
const FROM = Number(opt('from', 2000));
const TO = Number(opt('to', CURRENT_YEAR - 1));
const CURRENT_ONLY = has('current');
const ONLY_STATION = (opt('station', '') || '').toUpperCase();
// workers overlap the server-side zip preparation (the actual bottleneck);
// keep the default sequential so the monthly CI refresh stays extra polite
const PARALLEL = Math.max(1, Number(opt('parallel', 1)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- zip (central directory + deflate-raw, same layout as in-page) ----------

export function unzipJsonEntry(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no zip directory');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = Buffer.from(bytes.subarray(off + 46, off + 46 + nameLen)).toString();
    if (name.endsWith('.json')) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('no json entry in zip');
}

// ---------- condense to daily min/max, day boundaries in MEZ (UTC+1) ----------

export const daysInYear = y => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;

export function condense(measurements) {
  const years = new Map(); // y -> {min:[], max:[]}
  for (const m of measurements) {
    const t = Date.parse(m.timestamp);
    if (!Number.isFinite(t) || m.value == null) continue;
    const mez = t + 36e5;
    const y = new Date(mez).getUTCFullYear();
    const day = Math.floor((mez - Date.UTC(y, 0, 1)) / 864e5);
    let yr = years.get(y);
    if (!yr) {
      const n = daysInYear(y);
      yr = { min: Array(n).fill(null), max: Array(n).fill(null) };
      years.set(y, yr);
    }
    if (yr.min[day] == null || m.value < yr.min[day]) yr.min[day] = m.value;
    if (yr.max[day] == null || m.value > yr.max[day]) yr.max[day] = m.value;
  }
  return years;
}

// ---------- fetch one station range and write its files ----------

async function fetchRange(uuid, startYear, endDate) {
  const body = new URLSearchParams({
    uuid,
    parameter: 'WASSERSTAND ROHDATEN',
    start: `${startYear}-01-01`,
    end: endDate,
    format: 'json',
  });
  const res = await fetch(PREPARE, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(180000) });
  const loc = res.headers.get('location');
  if (!loc || loc.includes('error')) throw new Error(`prepare failed (${res.status}, ${loc || 'no redirect'})`);
  const zipRes = await fetch(new URL(loc, PREPARE), { signal: AbortSignal.timeout(300000) });
  if (!zipRes.ok) throw new Error('download failed HTTP ' + zipRes.status);
  const bytes = new Uint8Array(await zipRes.arrayBuffer());
  const text = unzipJsonEntry(bytes).toString();
  try {
    return JSON.parse(text);
  } catch {
    // some stations' generated JSON is not valid JSON: a bare minus for
    // missing values ("value":-,) and leading-dot decimals ("value":-.87,
    // seen on m+NN gauges) — patch both and try once more
    return JSON.parse(text
      .replace(/("value"\s*:\s*)-(?=\s*[,}\]])/g, '$1null')
      .replace(/("value"\s*:\s*-?)\.(?=\d)/g, '$10.'));
  }
}

// full range in one request where possible; coastal gauges measure every
// minute, whose 26-year JSON exceeds node's max string length — those fall
// back to 3-year chunks (year files never straddle a chunk boundary)
async function fetchCondensed(uuid, startYear, endDate) {
  try {
    const measurements = await fetchRange(uuid, startYear, endDate);
    return { years: condense(measurements), pts: measurements.length };
  } catch (e) {
    if (!/string longer|Invalid string length/i.test(e.message)) throw e;
    const endYear = Number(endDate.slice(0, 4));
    const years = new Map();
    let pts = 0;
    for (let y = startYear; y <= endYear; y += 3) {
      const to = Math.min(y + 2, endYear);
      await sleep(THROTTLE_MS);
      const chunk = await fetchRange(uuid, y, to === endYear ? endDate : `${to}-12-31`);
      pts += chunk.length;
      for (const [yy, data] of condense(chunk)) years.set(yy, data);
    }
    return { years, pts };
  }
}

// one map over all W stations: archived ones carry their year range, the rest
// are marked none — WSV simply has no pre-30-day archive for them (lock/weir
// operating gauges, foreign partner gauges, some harbor and barrage gauges).
// The client uses this to skip pointless fetches and to say so precisely.
export function buildManifest(stations, out) {
  const manifest = { generated: new Date().toISOString(), stations: {} };
  for (const s of stations) {
    const dir = join(out, s.uuid);
    let years = [];
    try {
      years = readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)).map(f => Number(f.slice(0, 4)));
      if (existsSync(join(dir, 'current.json'))) years.push(CURRENT_YEAR);
    } catch { /* no directory: never archived */ }
    const entry = { n: s.shortname, w: (s.water && s.water.shortname) || '' };
    if (years.length) { entry.from = Math.min(...years); entry.to = Math.max(...years); }
    else entry.none = true;
    manifest.stations[s.uuid] = entry;
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

// what a --current run fetches: normally the running year; in January also the
// just-completed one, so it gets frozen into its immutable file
export function currentRunPlan() {
  return {
    startYear: now.getUTCMonth() === 0 ? CURRENT_YEAR - 1 : CURRENT_YEAR,
    fetchedThrough: CURRENT_YEAR - 1,
    endDate: now.toISOString().slice(0, 10),
  };
}

export function writeStation(dir, name, years, fetchedFrom, fetchedThrough) {
  mkdirSync(dir, { recursive: true });
  let files = 0;
  for (const [y, data] of years) {
    if (!data.min.some(v => v != null)) continue; // station not live that year
    const file = y === CURRENT_YEAR ? 'current.json' : `${y}.json`;
    writeFileSync(join(dir, file), JSON.stringify({ y, min: data.min, max: data.max }));
    files++;
  }
  const metaPath = join(dir, 'meta.json');
  let meta = {};
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
  meta.name = name;
  meta.fetchedFrom = Math.min(meta.fetchedFrom ?? fetchedFrom, fetchedFrom);
  meta.fetchedThrough = Math.max(meta.fetchedThrough || 0, fetchedThrough);
  writeFileSync(metaPath, JSON.stringify(meta));
  return files;
}

// ---------- main ----------

// importable as a module (tests): the CLI part only runs when invoked directly
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();

async function main() {
  const stations = (await (await fetch(`${API}/stations.json?includeTimeseries=true`)).json())
    .filter(s => (s.timeseries || []).some(ts => ts.shortname === 'W'))
    .filter(s => !ONLY_STATION || s.shortname.toUpperCase() === ONLY_STATION || s.uuid === ONLY_STATION.toLowerCase())
    .sort((a, b) => a.shortname.localeCompare(b.shortname));

  console.log(`${stations.length} stations · mode: ${CURRENT_ONLY ? 'current year refresh' : `backfill ${FROM}-${TO}`} · out: ${OUT}/ · ${PARALLEL} worker(s)`);

  let ok = 0, skipped = 0, failed = 0, cursor = 0;
  async function processStation(s, i) {
    const dir = join(OUT, s.uuid);
    const tag = `[${i + 1}/${stations.length}] ${s.shortname}`;
    try {
      let startYear, fetchedThrough;
      if (CURRENT_ONLY) {
        ({ startYear, fetchedThrough } = currentRunPlan());
      } else {
        let meta = {};
        try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch {}
        // resume only counts when the earlier fetch started at (or before) our
        // FROM — a partial smoke run (e.g. --from 2023) must not masquerade as
        // a completed backfill
        const resumable = (meta.fetchedFrom ?? 2000) <= FROM;
        if (resumable && (meta.fetchedThrough || 0) >= TO) { skipped++; return; }
        startYear = resumable ? Math.max(FROM, (meta.fetchedThrough || 0) + 1) : FROM;
        fetchedThrough = TO;
      }
      const endDate = CURRENT_ONLY ? currentRunPlan().endDate : `${TO}-12-31`;
      const { years, pts } = await fetchCondensed(s.uuid, startYear, endDate);
      const files = writeStation(dir, s.shortname, years, startYear, fetchedThrough);
      console.log(`${tag} · ${pts} pts -> ${files} file(s)`);
      ok++;
    } catch (e) {
      console.log(`${tag} · FAILED: ${e.message}`);
      failed++;
    }
    await sleep(THROTTLE_MS);
  }
  async function worker(w) {
    // staggered starts + a little jitter per request keep the prepare calls
    // from bursting at the server simultaneously — bursts are what it rejects
    await sleep(w * 2000);
    while (cursor < stations.length) {
      const i = cursor++;
      await processStation(stations[i], i);
      await sleep(Math.random() * 500);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, (_, w) => worker(w)));
  if (!ONLY_STATION) {
    const m = buildManifest(stations, OUT);
    const none = Object.values(m.stations).filter(e => e.none).length;
    console.log(`manifest: ${stations.length} stations, ${stations.length - none} archived, ${none} without WSV archive`);
  }
  console.log(`done · ${ok} fetched · ${skipped} already complete · ${failed} failed${failed ? ' (re-run to retry)' : ''}`);
}
