#!/usr/bin/env node
// Fetches the Rijkswaterstaat (Dutch) water-level archive for the ten Dutch
// partner gauges PEGELONLINE relays live but WSV keeps no multi-year archive
// for, and condenses it into the same static bundle format fetch-wsv-archive.mjs
// emits, so the page serves them same-origin exactly like the WSV stations:
//
//   archive/<station-uuid>/closed.json   [{y,min:[...],max:[...]}, ...]  completed years
//   archive/<station-uuid>/current.json  {"y":2026,"min":[...],"max":[...]} running year
//   archive/<station-uuid>/meta.json     {name,fetchedFrom,fetchedThrough,
//                                          source:"Rijkswaterstaat",datumOffsetCm:0,water}
//   archive/manifest.json                per-station entry gains  "source":"Rijkswaterstaat"
//
// The bundle writer (writeStation), the daily min/max condense (day boundaries
// in MEZ/UTC+1) and the manifest source field are shared with
// fetch-wsv-archive.mjs — this adapter only differs in the data source and the
// station registry. buildManifest there reads meta.json's `source`, so the WSV
// monthly rebuild and this adapter's refresh are order-independent: neither
// strips the other's stations.
//
// ---- Source: Rijkswaterstaat DD-API (post-2025 migration) ----
// Endpoint: https://ddapi20-waterwebservices.rijkswaterstaat.nl
//   POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen
//   body {Locatie:{Code}, AquoPlusWaarnemingMetadata:{AquoMetadata:{
//         Compartiment:{Code:"OW"},Grootheid:{Code:"WATHTE"}}},
//         Periode:{Begindatumtijd,Einddatumtijd}}
//   -> WaarnemingenLijst[].MetingenLijst[].{Meetwaarde.Waarde_Numeriek (cm NAP),
//      Tijdstip}. 204 No Content = no data in the window (not an error).
// The classic waterwebservices.rijkswaterstaat.nl endpoint was decommissioned
// mid-2025 (now redirects to the migration notice); this is its replacement.
// The server rejects any request over 263088 observations ("Het maximaal aantal
// waarnemingen is overschreden"), so we fetch one calendar year at a time — a
// year of the densest gauge (tidal Rotterdam, ~3-min sampling) is ~105k, safely
// under the cap. License: CC0 (Rijkswaterstaat open data, no attribution
// required — we attribute anyway, see the archive-branch README).
//
// ---- Datum: values are kept raw (NAP), verified seamless with the live feed ----
// RWS reports cm relative to NAP. PEGELONLINE relays these ten foreign gauges at
// RWS's own NAP datum, NOT a station Pegelnullpunkt: cross-checking ~2800-4300
// overlapping points per station (2026-07) gave a median (RWS - live PEGELONLINE)
// offset of 0 cm for every station (MAD 0-4 cm, i.e. timestamp jitter only). So
// the archived series stitches seamlessly onto the live 30-day PEGELONLINE feed
// the client already backfills — no datum shift is applied (datumOffsetCm: 0).
// The per-station offsetCm below is the knob to turn should a future gauge ever
// need reconciliation; leave it 0 unless a value cross-check proves otherwise.
//
// ---- Station identity: every code was value-verified, not just name-matched ----
// Each WSV uuid was paired to its RWS location by name + coordinate, then
// CONFIRMED by the offset cross-check above (a stable ~0 offset across thousands
// of points = same gauge). Two coordinate-nearest guesses were wrong and the
// value check caught them: TIEL is `tiel.waal` (tiel.sluis.waal returns 204 no
// data) and LOBITH is `lobith.bovenrijn.tolkamer` (lobith.bovenrijn.haven is a
// real gauge 2 km away, consistent -13 cm). VUREN resolved to `dalem` (its RWS
// Omschrijving literally reads "voorheen Vuren" = formerly Vuren). All ten
// verified with high confidence; none skipped.
//
// One gauge changed RWS code mid-life: TIEL's history lives under
// `tiel.sluis.waal` (1989..early 2026) and continues under `tiel.waal` (2026->,
// the live code). They are the same gauge at the same datum (offset 0, verified
// on their early-2026 overlap), so `code` holds the live one and `histCodes`
// the retired one; fetchStation unions every code per day. The other nine are a
// single code each carrying both history and the live feed.
//
// ---- Data depth ----
// Dense 10-min/hourly data reaches back to ~1989 for all ten (the default
// backfill start). Sparse daily observations exist further back for some (e.g.
// Zaltbommel to ~1901, with gaps), fetch with --from 1901 to include them.
//
// Usage:
//   node scripts/fetch-rws-archive.mjs                     # backfill 1989..now
//   node scripts/fetch-rws-archive.mjs --current           # refresh running year
//   node scripts/fetch-rws-archive.mjs --station LOBITH    # one station
//   node scripts/fetch-rws-archive.mjs --from 1901 --out archive
//
// ---- Live archive-branch push runbook (mirrors fetch-wsv-archive.mjs) ----
// The backfill writes into a scratch --out dir; pushing to the GitHub-only
// orphan `archive` branch is a separate, higher-blast-radius step:
//
//   git worktree add /tmp/arch archive && cd /tmp/arch
//   node <repo>/scripts/fetch-rws-archive.mjs --out archive   # fill the 10 dirs + upsert manifest
//   git add archive && git commit -m "Add Rijkswaterstaat archive for 10 Dutch gauges"
//   git push origin archive        # (and the github mirror) — pushing here triggers no workflow
//   gh workflow run pages.yml --ref main   # required — deploys the new data
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { condense, writeStation } from './fetch-wsv-archive.mjs';

const RWS = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
const OPHALEN = RWS + '/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';
const MAX_VALID_CM = 5000; // clamp RWS gap sentinels (large magic numbers); real range is -72..716

// verified WSV uuid <-> RWS location code. offsetCm is subtracted from the raw
// NAP value before condensing; 0 for all ten (see the datum note above). Keep
// `water` so the manifest upsert can label the entry without the PEGELONLINE list.
export const STATIONS = [
  { uuid: '3a8c82a6-51a6-48fa-a81c-b9e7288093a4', name: 'ZALTBOMMEL',      water: 'WAAL',      code: 'zaltbommel',                        offsetCm: 0 },
  { uuid: '46f3bfc1-05ee-4809-bdd3-1a46b0a17fb7', name: 'NIJMEGEN HAVEN',  water: 'WAAL',      code: 'nijmegen.waal',                     offsetCm: 0 },
  { uuid: '3046493f-971f-4d22-9f29-7ef8e3b645a4', name: 'PANNERDENSE KOP', water: 'RHEIN',     code: 'millingenaanderijn.pannerdensekop', offsetCm: 0 },
  { uuid: 'efe13a3d-f239-4655-9c13-4ac56dfa4478', name: 'LOBITH',          water: 'RHEIN',     code: 'lobith.bovenrijn.tolkamer',         offsetCm: 0 },
  { uuid: 'bd4bb467-45f1-490d-a212-49412fcca219', name: 'TIEL',            water: 'WAAL',      code: 'tiel.waal', histCodes: ['tiel.sluis.waal'], offsetCm: 0 },
  { uuid: 'a9f6664a-58bf-4a96-8c32-f606bbae8eaf', name: 'VUREN',           water: 'WAAL',      code: 'dalem',                             offsetCm: 0 },
  { uuid: 'bbaefa8e-b13f-4058-b86f-11d19e9ed17e', name: 'IJSSELKOP',       water: 'IJSSEL',    code: 'westervoort.ijsselkop',             offsetCm: 0 },
  { uuid: '6c6f84c2-b7ea-4720-8ecd-a83c100c6291', name: 'DORDRECHT',       water: 'ALTE_MAAS', code: 'dordrecht.oudemaas.benedenmerwede', offsetCm: 0 },
  { uuid: 'f5c96f13-c058-477a-931b-b6d623d18960', name: 'KRIMPEN',         water: 'LEK',       code: 'krimpenaandelek.lek',               offsetCm: 0 },
  { uuid: 'a269e3be-426b-4491-9cb3-37eca988a715', name: 'ROTTERDAM',       water: 'NEUE_MAAS', code: 'rotterdam.nieuwemaas.boerengat',    offsetCm: 0 },
];
const SOURCE = 'Rijkswaterstaat';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);

const now = process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date();
const CURRENT_YEAR = now.getUTCFullYear();
const OUT = opt('out', 'archive');
const FROM = Number(opt('from', 1989));
const TO = Number(opt('to', CURRENT_YEAR));
const CURRENT_ONLY = has('current');
const THROTTLE_MS = Number(opt('throttle', 1200));
const ONLY = (opt('station', '') || '').toLowerCase();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// one calendar year, boundaries in +01:00 so condense's MEZ bucketing keeps every
// point inside year y (no spill into the neighbouring year's bundle)
export async function fetchYear(code, y, doFetch = fetch) {
  const body = {
    Locatie: { Code: code },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } } },
    Periode: { Begindatumtijd: `${y}-01-01T00:00:00+01:00`, Einddatumtijd: `${y}-12-31T23:59:59+01:00` },
  };
  const res = await doFetch(OPHALEN, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240000),
  });
  if (res.status === 204) return [];
  const j = await res.json();
  if (!j.Succesvol) throw new Error(`RWS ${code} ${y}: ${j.Foutmelding || 'Succesvol=false'}`);
  const out = [];
  for (const w of j.WaarnemingenLijst || []) for (const m of w.MetingenLijst || []) {
    const v = m.Meetwaarde && m.Meetwaarde.Waarde_Numeriek;
    if (v == null || Math.abs(v) > MAX_VALID_CM) continue; // gap sentinel — dropped, values kept raw
    out.push({ timestamp: m.Tijdstip, value: v });
  }
  return out;
}

// per-day min/max union so an accidental cross-year sliver never overwrites a
// real year (belt-and-braces; the +01:00 boundaries already keep years separate)
function unionYear(a, b) {
  const min = a.min.slice(), max = a.max.slice();
  for (let d = 0; d < b.min.length; d++) {
    if (b.min[d] != null && (min[d] == null || b.min[d] < min[d])) min[d] = b.min[d];
    if (b.max[d] != null && (max[d] == null || b.max[d] > max[d])) max[d] = b.max[d];
  }
  return { min, max };
}

// fetch year-by-year (freeing each year's raw before the next) and condense into
// one {y -> {min,max}} map; offsetCm shifts NAP->target datum (0 for all ten).
// A gauge whose RWS code changed over time (e.g. TIEL: historical tiel.sluis.waal
// -> current tiel.waal from 2026, same gauge/datum, verified offset 0) lists the
// extra codes in histCodes; every code's year is unioned per day.
export async function fetchStation(st, fromY, toY, doFetch = fetch) {
  const years = new Map();
  const codes = [st.code, ...(st.histCodes || [])];
  let pts = 0;
  for (let y = fromY; y <= toY; y++) {
    for (const code of codes) {
      const raw = await fetchYear(code, y, doFetch);
      pts += raw.length;
      if (raw.length) {
        const mapped = st.offsetCm ? raw.map(m => ({ timestamp: m.timestamp, value: m.value - st.offsetCm })) : raw;
        for (const [yy, data] of condense(mapped)) {
          const ex = years.get(yy);
          years.set(yy, ex ? unionYear(ex, data) : data);
        }
      }
      await sleep(THROTTLE_MS);
    }
  }
  return { years, pts };
}

// upsert only the touched stations into manifest.json (leaving the WSV entries
// untouched) — keeps this incremental adapter from needing the full station list
export function updateManifest(out, stations) {
  const path = join(out, 'manifest.json');
  const manifest = readJson(path) || { generated: '', stations: {} };
  manifest.generated = new Date().toISOString();
  for (const st of stations) {
    const dir = join(out, st.uuid);
    const years = [];
    let gaps = 0;
    for (const yr of readJson(join(dir, 'closed.json')) || []) {
      years.push(yr.y);
      for (let d = 0; d < yr.min.length; d++) if (yr.min[d] == null && yr.max[d] == null) gaps++;
    }
    if (existsSync(join(dir, 'current.json'))) years.push(CURRENT_YEAR);
    const meta = readJson(join(dir, 'meta.json')) || {};
    const entry = { n: st.name, w: st.water };
    if (years.length) {
      entry.from = Math.min(...years);
      entry.to = Math.max(...years);
      if (gaps) entry.gaps = gaps;
    } else {
      entry.none = true;
    }
    if (meta.source) entry.source = meta.source;
    manifest.stations[st.uuid] = entry;
  }
  writeFileSync(path, JSON.stringify(manifest));
  return manifest;
}

// importable as a module (tests); the CLI only runs when invoked directly
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();

async function main() {
  const stations = STATIONS.filter(s => !ONLY || s.name.toLowerCase() === ONLY || s.uuid === ONLY);
  if (!stations.length) { console.error(`no station matches --station ${ONLY}`); process.exitCode = 1; return; }
  // --current: running year (in January also the just-completed one, so it
  // graduates into closed.json); backfill: FROM..TO. writeStation caps
  // fetchedThrough at the last completed year regardless.
  const fromY = CURRENT_ONLY ? (now.getUTCMonth() === 0 ? CURRENT_YEAR - 1 : CURRENT_YEAR) : FROM;
  const toY = CURRENT_ONLY ? CURRENT_YEAR : TO;
  const fetchedThrough = Math.min(toY, CURRENT_YEAR - 1);
  console.log(`${stations.length} RWS station(s) · mode: ${CURRENT_ONLY ? 'current refresh' : `backfill ${fromY}-${toY}`} · out: ${OUT}/`);

  let ok = 0, failed = 0;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const tag = `[${i + 1}/${stations.length}] ${st.name} (${st.code})`;
    try {
      const { years, pts } = await fetchStation(st, fromY, toY);
      const touched = writeStation(join(OUT, st.uuid), st.name, years, fromY, fetchedThrough,
        { source: SOURCE, datumOffsetCm: st.offsetCm, water: st.water });
      const ys = [...years.keys()].sort((a, b) => a - b);
      console.log(`${tag} · ${pts} pts -> ${touched} year(s)${ys.length ? ` (${ys[0]}-${ys[ys.length - 1]})` : ''}`);
      ok++;
    } catch (e) {
      console.log(`${tag} · FAILED: ${e.message}`);
      failed++;
    }
  }
  updateManifest(OUT, stations);
  console.log(`done · ${ok} fetched · ${failed} failed${failed ? ' (re-run to retry)' : ''} · manifest upserted`);
}
