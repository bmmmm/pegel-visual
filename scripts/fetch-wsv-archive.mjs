#!/usr/bin/env node
// Fetches the WSV/PEGELONLINE historical raw archive (water levels since 2000,
// DL-DE->Zero-2.0) and condenses it into small static files the page serves
// same-origin:
//
//   archive/<station-uuid>/closed.json   [{y:2000,min:[...],max:[...]}, ...]
//                                        immutable bundle of every completed
//                                        year, sorted; rewritten only when a
//                                        year is added or the January freeze
//                                        graduates the running year into it
//   archive/<station-uuid>/current.json  {"y":2026,"min":[...],"max":[...]}
//                                        running year, refreshed monthly
//   archive/<station-uuid>/meta.json     {"name":"BONN","fetchedThrough":2025}
//   archive/manifest.json                {n,w,from,to[,gaps]} | {n,w,none} per station
//
// min/max are ints (cm) or null per day (day boundaries in MEZ, matching the
// archive's year-round UTC+1 timestamps); daily min+max keeps floods and
// droughts visible at ~1/300 the raw size. One closed.json bundle means the
// client fetches 3 files (manifest + closed + current), not 27.
//
// Two sources, one per run mode:
//  - full backfill / gap sweep: the /gast/ ZIP endpoint (all years at once).
//    Browsers cannot fetch it (doubled CORS header), so this runs locally / in
//    CI. Be polite: sequential, throttled, resumable.
//  - monthly --current refresh: the official REST API (30 days at 15-min
//    resolution, ?start=P35D) — no CORS quirk, no ZIP prepare step. Condensed
//    to daily min/max and upserted into current.json. In January the completed
//    year graduates from current.json into closed.json (the freeze).
//
// Usage:
//   node scripts/fetch-wsv-archive.mjs                    # backfill 2000..last year (ZIP)
//   node scripts/fetch-wsv-archive.mjs --current          # refresh running year (REST;
//                                        # January: ZIP re-backfill of the completed
//                                        # year, REST accumulation as fallback)
//   node scripts/fetch-wsv-archive.mjs --station BONN     # one station
//   node scripts/fetch-wsv-archive.mjs --from 2020 --to 2024 --out archive
//   node scripts/fetch-wsv-archive.mjs --migrate --out archive  # year files -> bundles
//
// ---- Seed migration + deploy runbook (per-year files -> bundles, Plan A) ----
// --migrate is a pure reformat of the existing per-year files into closed.json
// bundles: NO WSV refetch. Run it against a checkout of the data branch and
// reseed the branch as one fresh commit (copy-pasteable):
//
//   git worktree add /tmp/arch archive && cd /tmp/arch
//   node <repo>/scripts/fetch-wsv-archive.mjs --migrate --out archive
//     # writes every archive/<uuid>/closed.json, deletes the <year>.json files,
//     # regenerates archive/manifest.json (from/to/gaps derived from bundles)
//   # update the branch README to the closed.json layout, then reseed:
//   git checkout --orphan seed && git add -A && git commit -m "Seed archive: year bundles (Plan A)"
//   git branch -M seed archive
//   # deploy order: main FIRST — the new client degrades gracefully on the old
//   # data (closed.json 404 is swallowed, current.json still renders), while
//   # the old client on reseeded data would 404 on every deleted year file.
//   # a push to the data branch can NOT trigger pages.yml (the orphan branch
//   # carries no workflow files — verified 2026-07-17: the force-push produced
//   # no run), so the dispatch below is what actually deploys the new data:
//   git push origin main
//   git push --force origin archive
//   gh workflow run pages.yml --ref main   # required — deploys the reseeded data
//   # verify live as a fresh visitor: pick 20Y, the Network panel shows exactly
//   # 3 archive requests (manifest.json, closed.json, current.json) and fills.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
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
const MIGRATE = has('migrate');
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

// the monthly refresh's source: the official REST API at 15-min resolution —
// no doubled-CORS quirk, no ZIP prepare step. The cron fires on the 3rd of
// each month, so consecutive runs sit 31 days apart after a 31-day month: a
// P30D window would leave the boundary day between two runs thinly sampled
// (missing its afternoon peak). We request P35D for margin, but measured
// 2026-07-17 the server silently clamps to ~31 days — enough to cover the
// cadence exactly, with no slack for a delayed run. That residual risk is
// deliberate: the January ZIP re-backfill (freezeFromZip) heals any hole in
// the completed year, and if WSV ever lifts the cap the wider window starts
// working for free. Overlap is harmless — writeStation's merge is idempotent.
// condense buckets by MEZ day, so the live data's DST offset (+02:00 in
// summer) folds onto the same day boundaries as the ZIP archive's year-round
// UTC+1 timestamps.
async function fetchCurrentViaRest(uuid) {
  const url = `${API}/stations/${uuid}/W/measurements.json?start=P35D`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('REST measurements HTTP ' + res.status);
  const measurements = await res.json();
  return { years: condense(measurements), pts: measurements.length };
}

// one map over all W stations: archived ones carry their year range, the rest
// are marked none — WSV simply has no pre-30-day archive for them (lock/weir
// operating gauges, foreign partner gauges, some harbor and barrage gauges).
// The client uses this to skip pointless fetches and to say so precisely.
export function buildManifest(stations, out) {
  const manifest = { generated: new Date().toISOString(), stations: {} };
  for (const s of stations) {
    const dir = join(out, s.uuid);
    const years = [];
    let gaps = 0; // honesty metadata: missing days within the closed bundle
    for (const yr of readJson(join(dir, 'closed.json')) || []) {
      years.push(yr.y);
      for (let d = 0; d < yr.min.length; d++) if (yr.min[d] == null && yr.max[d] == null) gaps++;
    }
    if (existsSync(join(dir, 'current.json'))) years.push(CURRENT_YEAR);
    const entry = { n: s.shortname, w: (s.water && s.water.shortname) || '' };
    if (years.length) {
      entry.from = Math.min(...years);
      entry.to = Math.max(...years);
      if (gaps) entry.gaps = gaps;
    } else {
      entry.none = true; // WSV keeps no pre-30-day archive for this station
    }
    // a sibling adapter (e.g. fetch-rws-archive.mjs) records a non-WSV origin in
    // meta.json; surface it so the client can attribute correctly. Absent = WSV,
    // so the 618 WSV stations stay untouched and this rebuild never strips a
    // source a sibling adapter wrote (order-independent with the RWS refresh).
    const src = (readJson(join(dir, 'meta.json')) || {}).source;
    if (src) entry.source = src;
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

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// merge a condensed year (per-day min/max) into an existing {y,min,max}, keeping
// the extreme per day so an overlapping refetch never drops a peak or a trough
export function mergeYear(existing, y, data) {
  const n = data.min.length;
  if (!existing || existing.y !== y || existing.min.length !== n) {
    return { y, min: data.min.slice(), max: data.max.slice() };
  }
  const min = existing.min.slice(), max = existing.max.slice();
  for (let d = 0; d < n; d++) {
    if (data.min[d] != null && (min[d] == null || data.min[d] < min[d])) min[d] = data.min[d];
    if (data.max[d] != null && (max[d] == null || data.max[d] > max[d])) max[d] = data.max[d];
  }
  return { y, min, max };
}

// one code path for all three run modes (backfill, monthly --current, January
// freeze): upsert the freshly condensed years into the immutable closed.json
// bundle and the running-year current.json. A current.json holding a
// now-completed year graduates into the bundle first (the freeze); years equal
// to CURRENT_YEAR stay in current.json.
export function writeStation(dir, name, years, fetchedFrom, fetchedThrough, extraMeta = null) {
  mkdirSync(dir, { recursive: true });
  const closedPath = join(dir, 'closed.json');
  const currentPath = join(dir, 'current.json');
  const closed = new Map((readJson(closedPath) || []).map(yr => [yr.y, yr]));
  let current = readJson(currentPath);
  let closedChanged = false;

  if (current && current.y < CURRENT_YEAR) {
    closed.set(current.y, mergeYear(closed.get(current.y), current.y, current));
    closedChanged = true;
    current = null; // the slot reopens for the new running year below
  }

  let touched = 0;
  for (const [y, data] of years) {
    if (!data.min.some(v => v != null)) continue; // station not live that year
    if (y === CURRENT_YEAR) {
      current = mergeYear(current, y, data);
    } else {
      closed.set(y, mergeYear(closed.get(y), y, data));
      closedChanged = true;
    }
    touched++;
  }

  if (closedChanged && closed.size) {
    writeFileSync(closedPath, JSON.stringify([...closed.values()].sort((a, b) => a.y - b.y)));
  }
  if (current) writeFileSync(currentPath, JSON.stringify(current));
  else if (existsSync(currentPath)) unlinkSync(currentPath); // graduated, nothing new yet

  const metaPath = join(dir, 'meta.json');
  const meta = readJson(metaPath) || {};
  meta.name = name;
  meta.fetchedFrom = Math.min(meta.fetchedFrom ?? fetchedFrom, fetchedFrom);
  meta.fetchedThrough = Math.max(meta.fetchedThrough || 0, fetchedThrough);
  if (extraMeta) Object.assign(meta, extraMeta); // e.g. { source, datumOffsetCm, water }
  writeFileSync(metaPath, JSON.stringify(meta));
  return touched;
}

// January freeze, ZIP-first: re-backfill the completed year from the archive
// download (the same raw series the backfill uses; measured 27/29 overlap days
// byte-identical to REST) before the REST accumulation graduates. Where the ZIP
// has data its day wins — an extreme-union would let a since-corrected outlier
// from the monthly snapshots survive into the immutable bundle — and the REST
// accumulation only fills days the ZIP is missing (receiver outages, late
// telemetry). Returns true when current.json was rewritten to the ZIP-backed
// year (the caller may then claim fetchedThrough = y); false when there is
// nothing to freeze; throws when the ZIP path fails (the caller graduates the
// REST accumulation as before and leaves meta low so the gap sweep retries).
export async function freezeFromZip(dir, uuid, y, fetchYear = fetchCondensed) {
  const cur = readJson(join(dir, 'current.json'));
  if (!cur || cur.y !== y) return false; // already graduated or never accumulated
  const { years } = await fetchYear(uuid, y, `${y}-12-31`);
  const zy = years.get(y);
  if (!zy || !zy.min.some(v => v != null)) return false; // ZIP has nothing better
  const min = zy.min.slice(), max = zy.max.slice();
  for (let d = 0; d < min.length; d++) {
    if (min[d] == null) min[d] = cur.min[d];
    if (max[d] == null) max[d] = cur.max[d];
  }
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ y, min, max }));
  return true;
}

// Plan A seed reformat: fold one station's per-year files into a single sorted
// closed.json bundle and delete them. Pure reformat — no WSV data changes.
export function migrateStation(dir) {
  let files;
  try { files = readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)); }
  catch { return 0; }
  if (!files.length) return 0;
  const bundle = files
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); }
      catch (e) { throw new Error(`${join(dir, f)}: ${e.message} — fix or remove the file, then re-run --migrate`); }
    })
    .sort((a, b) => a.y - b.y);
  writeFileSync(join(dir, 'closed.json'), JSON.stringify(bundle));
  for (const f of files) unlinkSync(join(dir, f));
  return bundle.length;
}

// migrate every station dir under `out`, then rebuild manifest.json from the
// station names/waters already recorded there (no network) so from/to/gaps
// reflect the new bundles
function migrateAll(out) {
  let dirs = [];
  try { dirs = readdirSync(out, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { console.log(`no archive dir at ${out}/`); return; }
  let migrated = 0, entries = 0;
  const failed = [];
  for (const uuid of dirs) {
    try {
      const n = migrateStation(join(out, uuid));
      if (n) { migrated++; entries += n; }
    } catch (e) { failed.push(e.message); } // keep migrating; the thrower's year files are untouched
  }
  const old = readJson(join(out, 'manifest.json'));
  if (old && old.stations) {
    const stations = Object.entries(old.stations)
      .map(([uuid, e]) => ({ uuid, shortname: e.n, water: { shortname: e.w } }));
    buildManifest(stations, out);
    console.log(`migrated ${migrated} stations (${entries} year entries) · manifest rebuilt for ${stations.length} stations`);
  } else {
    console.log(`migrated ${migrated} stations (${entries} year entries) · no manifest.json to rebuild`);
  }
  if (failed.length) {
    console.error(`error: ${failed.length} stations failed to migrate (their year files are left in place):\n  ${failed.join('\n  ')}`);
    process.exitCode = 1;
  }
}

// ---------- main ----------

// importable as a module (tests): the CLI part only runs when invoked directly
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();

async function main() {
  if (MIGRATE) return migrateAll(OUT);
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
      const { years, pts } = CURRENT_ONLY
        ? await fetchCurrentViaRest(s.uuid)
        : await fetchCondensed(s.uuid, startYear, `${TO}-12-31`);
      if (CURRENT_ONLY) {
        // a REST refresh proves nothing about closed years, so it must not bump
        // meta.fetchedThrough — that would cancel the gap sweep for stations
        // whose ZIP backfill is still pending. Only a successful January ZIP
        // freeze of the completed year may claim it.
        fetchedThrough = 0;
        if (startYear < CURRENT_YEAR) {
          try {
            if (await freezeFromZip(dir, s.uuid, startYear)) {
              fetchedThrough = startYear;
              // the ZIP spans all of December — drop the REST tail of the frozen
              // year so writeStation's extreme-union cannot reintroduce it
              years.delete(startYear);
            }
          } catch (e) {
            console.log(`${tag} · zip freeze failed (${e.message}) — REST accumulation graduates, gap sweep heals ${startYear}`);
          }
        }
      }
      const touched = writeStation(dir, s.shortname, years, startYear, fetchedThrough);
      console.log(`${tag} · ${pts} pts -> ${touched} year(s)`);
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
