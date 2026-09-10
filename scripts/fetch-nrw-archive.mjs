#!/usr/bin/env node
// Mirrors the LANUK NRW gauge, rain and water-temperature data of
// https://hochwasserportal.nrw/data (KISTERS WISKI-WEB) into two static trees
// the page can serve same-origin — the second gauge source next to WSV, and
// the ONLY source for rivers that are not federal waterways (Erft, Sieg, …
// 0 of the 738 PEGELONLINE stations are on them).
//
//   <out>/manifest.json                 { schema, generated, sourceExportAt, license, window,
//                                         counts, coverage, gauges:{…}, rain:{…}, temp:{…} }
//   <out>/registry.json                 union of stations.json and the three bulk station
//                                       tables, keyed on station_no, raw-near (64 columns
//                                       where temp_stationen.txt carries them)
//   <out>/topology.json                 { basins:{<catchment_no>:{name,names,river,rivers,
//                                         gauges,rain,temp,mouth}}, gauges:{<no>:{…,down}} }
//   <out>/gauges/<no>/meta.json         { id,name,water,siteNo,lat,lon,catchmentNo,catchmentName,
//                                         basinSrc,catchmentKm2,distToConflKm,unit:"cm",
//                                         info:[i1,i2,i3],mw,mnw,mhw,note,src,from,to,
//                                         dayBoundary:"00:00+01:00",down,downSrc }
//   <out>/gauges/<no>/<YYYY>.json       { id,y, min:[…],mean:[…],max:[…],n:[…], acc:{"<d>":pct} }
//   <out>/rain/<no>/<YYYY>.json         { id,y, mm:[…],imax:[…], cov:{"<d>":pct} }   day starts 07:00
//   <out>/temp/<no>/<YYYY>.json         { id,y, mean:[…],max:[…], acc:{…} }             unit °C
//   <out>/runs.json                     last RUNS_KEPT runs
//   <out-hires>/gauges/<no>/<YYYY-MM>.json   { id,month,step:900|300, start, v:[…] }   15-min (5-min at 53 gauges)
//   <out-hires>/rain/<no>/<YYYY-MM>.json     { id,month,step:3600, start, v:[…] }      hourly mm/h
//   <out-hires>/temp/<no>/<YYYY-MM>.json     { id,month,step:3600, start, v:[…] }      hourly °C
//
// Year shards are day-indexed by daysInYear(y), day 0 = Jan 1, day boundary
// MEZ (UTC+1) — the same convention as current.json in the WSV archive. Month
// shards are a dense grid from `start` in steps of `step` seconds, trailing
// nulls trimmed. Everything is keyed on the LANUK `station_no`: the one id that
// appears identically in every artefact and is operator-independent.
// `station_id` is a WISKI surrogate, `station_name` is ambiguous (Weidenau /
// Weidenau2, Bliesheim / Bliesheim_2). Careful: a station_no can LOOK like a
// site_no — Bad-Honnef's station_no is "104" — so a composite key needs a
// separator, and ids stay strings ("0037122044" has a leading zero).
//
// ---- The source, measured 2026-09-04 ----
// License: dl-de/zero-2.0, declared in the portal for the DOWNLOAD page only
// ("Die Möglichkeiten für den Datendownload … stehen unter der OpenData
// Lizenz (Deutschland Zero 2.0)"). The per-station JSONs carry no license
// statement, so the bulk ZIPs are the primary source (tier 1) and the
// per-station fetch (tier 2) stays the exception, tracked per station in
// meta.src. Zero needs no attribution; we name the source anyway.
//
// /data/ is a DAILY EXPORT, not a live system: the ZIPs' inner stamps read
// 14:10–15:10 UTC, the last 15-minute reading sits ~10 minutes before the
// stamp, the daily tables end on the previous full day (mean) or the running
// day as a partial (max, accuracy 63.55 % = 15.25 h of 24 at the 15:11 MEZ
// export — which is also the proof that a daily row's stamp is the START of
// its day, not the end). Pulling more than once a day buys nothing; "current"
// means ~24 h here and the manifest says so (sourceExportAt).
//
// No CORS header on any endpoint: the browser can never fetch this directly,
// everything is pre-baked here. The ZIPs carry neither etag nor last-modified,
// but max-age=2592000 — the ?cb= cache-buster is mandatory, not caution.
//
// Tier 1 — four requests, ~14.4 MB/day:
//   internet/stations/stations.json      617 stations (310 Oberflächengewässer, 308
//                                        Klimastation, ONE carries both: Aue, so the
//                                        two are not a partition and 310+308 = 618)
//   downloads/pegeldaten.zip             pegel_stationen.txt (16 cols, catchment_no is col 5),
//                                        pegel_tagesmittelwerte.txt, pegel_tagesmaxima.txt
//                                        (730 days), pegel_messwerte.txt (15-min, 63 days, 108 MB)
//   downloads/niederschlagsdaten.zip     nieder_stationen.txt (13 cols), nieder_tageswerte.txt
//                                        (mm/24h + coverage %), nieder_messwerte.txt (hourly)
//   downloads/temperaturdaten.zip        temp_stationen.txt (64 cols — the best metadata row
//                                        of the source), temp_tagesmittelwerte.txt,
//                                        temp_tagesmaxima.txt, temp_messwerte.txt (hourly)
// grundwasserdaten, abflussdaten, schneedaten, meldestufen and five more names
// were tried and answer 404 — it is exactly these four products.
//
// Tier 2 — index.json-driven per-station fetch for every station no bulk
// product carries (56 gauges + 6 rain gauges on 2026-09-04): read
// internet/stations/<site_no>/<station_no>/index.json, then EXACTLY the
// advertised 1Y year.json links with station_parameter in {S, N, WT}. The
// /data/ prefix is mandatory — without it the host answers 404, and so does a
// WRONG site_no (verified: 100/2765190000100 → 200, 104/2765190000100 → 404),
// which reads like a missing station. Never guess: read index.json. Eight
// gauges advertise no S at all (water-quality stations such as Mülheim_Güte,
// WT only) — "no S" is a finding (meta.noSeries, meta.params), never a
// failure, or every scheduled run dies red the way the 111 WSV lock gauges
// once killed archive-update. The six rain-only tier-2 stations advertise a
// 7D week.json only, no year.json: noSeries as well, by the same rule. And
// four Rur gauges (123456, 1234567, 2821790000100, 2829724000100, site 104)
// advertise S and deliver a year of [ts, null, accuracy] rows — a series
// without a value (measured 2026-09-06): meta.empty, counted in
// coverage.<kind>.empty, no level node, no station success (seriesHasValues).
//
// The 310 per-station alarmlevel.json are NOT fetched: LANUV_Info_1/2/3 in
// stations.json ARE the Meldestufen (Menden_1: 250/410/440, identical to its
// S/alarmlevel.json, verified 2026-09-04). week.json and messwerte.zip are
// subsets of the bulk and skipped too.
//
// ---- Parser traps, all measured on the 2026-09-04 seed ----
//   - CRLF line endings, UTF-8, no BOM, `;` separated, `.` decimals in the
//     data rows but `,` in the metadata ("2825,00 km²", "8,60 km", "250,0")
//   - the daily gauge tables name 3 columns and deliver 4 fields: the fourth is
//     the undeclared `Aggregation Accuracy %`
//   - 2-field lines (`<station_no>;`) terminate a station's block and carry no
//     value; a station can consist of a terminator alone (rain: 3 such in the
//     daily table, 8 in the hourly one) — rows are keyed by their own station_no
//     and the terminators are ignored
//   - an empty value OR accuracy 0 means "no measurement", never 0 cm
//     (rain has 14 rows `0.00;0.0`, the gauge tables none with a value at 0 %)
//   - negative stages are real (−97.55 … 679.50 cm daily; −128.4 in the 15-min table)
//   - two day boundaries in one source: gauges and temperature T00:00:00+01:00,
//     rain T07:00:00+01:00 (a 07:00 row covers 07:00 → 07:00 next day; its
//     coverage reads 33.34 % at a 15:10 MEZ export = 8 h of 24, so the stamp is
//     the day's START); every stamp is fixed +01:00 all year (2.1 M rows, one
//     suffix), so the string IS the MEZ wall clock
//   - temp_tagesmaxima.txt mixes three shapes: one midnight row per day (105
//     stations), the maximum stamped at its time of occurrence (2736790000,
//     "2024-09-04T19:06"), and a raw 15-minute series (702705, 29 014 rows)
//     — folded per MEZ calendar day with max(), which treats all three alike
//   - 53 of 253 gauges publish 5-minute readings (288 samples/day), 200 at
//     15 minutes (96): `n` runs 1..288, and the month shard's `step` is 300
//     at those gauges
//   - one temperature sentinel pair (2728930000200 on 2025-11-28: max 3822.00,
//     mean 165.34) beside a real 28 °C: PLAUSIBLE_TEMP_C drops it on arrival.
//     Rain is kept raw above 0 — 595.9 mm/24h (39169741, 2026-06-30) or three
//     consecutive February days above 220 mm (53030041) are sensor faults to a
//     reader, but no bound separates them from a real cloudburst, and the
//     coverage column already says which days are partial
//   - the header of every temperature table reads `mean(cm)` / `value(cm)`;
//     the values are °C (year.json says ts_unitsymbol "°C")
//   - `catchment_no` is NOT in stations.json (36 columns); it is column 5 of
//     pegel_stationen.txt and nieder_stationen.txt, i.e. known only for bulk
//     stations. At 7 of 254 bulk gauges station_no does not even start with
//     it (Veert 2850000000200 → 286, Soestbach with the placeholder id
//     1234512345 → 278) — the GKZ prefix repairs, it never replaces the field
//   - `catchment_name` can be "---" (three gauges: Heimborn, Betzdorf — both
//     upper Sieg, Rhineland-Palatinate — and WSV_Andernach; nine rain gauges)
//   - `DIST_TO_CONFL` ("207,66 km") and temp_stationen's `station_dist_to_conf`
//     (780.2) are NOT the same quantity; the Rhine gauges (site 102) carry the
//     Rhine-km from Konstanz instead of a distance to the mouth (Andernach
//     613,78 km), so their chain runs the other way (RIVER_KM_RIVERS)
//
// ---- Basin assignment (topology.json) ----
// The 14 gauge basins are distinct catchment_no values of pegel_stationen.txt
// (2, 3, 4, 44, 258, 272, 274, 276, 278, 282, 286, 428, 928, 2736); the rain
// table adds 2772 (Emscher) and 2781 (Ahr — the source's number, whatever it
// means). Distinct catchment_name values are 17 (+ "---") because several names
// share a number (Siegeinzugsgebiet Östlich and Westlich are both 272). Per
// station: catchment_no from the bulk table where present (basinSrc "bulk");
// else the number other stations of the same catchment_name carry ("name");
// else, for gauges only, the longest known number that prefixes station_no
// ("gkz" — the three "---" gauges); else null. A guessed basin never looks
// like a read one.
//
// `down` (next gauge downstream) comes from the LAWA Gewässerkennzahl inside
// station_no: the first 10 digits minus trailing zeros are the stretch code
// (2729100000100 → 27291), and after the basin's own code every ODD digit is a
// stretch of the same river (9 = mouth stretch) while every EVEN digit descends
// into a tributary (Weidenau2 272149 → Ferndorfbach 27214; Nierenhof 2769649 →
// Felderbach 276964, which matches its river_code column). Along one river
// (WTO_OBJECT) the chain is DIST_TO_CONFL descending ("river"); a tributary's
// last gauge continues at the first parent-river gauge whose stretch code sorts
// after the tributary's code ("gkz" — the Ferndorfbach joins the Sieg between
// Weidenau 27213 and Niederschelden 27217); a basin's main-river mouth is
// "mouth"; anything else stays null with downSrc null. The Sieg chain on the
// seed: Weidenau → Niederschelden → Betzdorf → Eitorf → Siegburg_Kald. →
// Menden_1 → (mouth).
//
// ---- Merge policy (the inverse of the WSV extreme-value union) ----
// The source declares unchecked raw data and revises a day inside its window
// up AND down, so inside the delivered window the fresh value wins; outside it
// the stored value is frozen (the source can never deliver it again); and a
// fresh null never overwrites a stored non-null — a truncated ZIP is a no-op,
// not a loss. Tier 2 is written first, the bulk day tables after (730 days and
// the accuracy column beat 364 days), the fields derived from the fine series
// (min, n, imax) last and additively — they never touch mean/max. An unchanged
// shard is not rewritten (no branch churn), manifest.generated is a DATE, and
// runs.json only grows when something changed or the day did, so a second run
// on the same seed changes 0 files.
//
// `min` is not delivered (the source has TagMittel and TagMax): it is
// aggregated from the 15-minute series. Cross-check on the 2026-09-04 seed,
// Menden_1, 62 full days: median |Δmean| 0.003 cm, median |Δmax| 0.000 cm,
// 96 samples/day — the same aggregation reproduces the source's own day
// values, so the derived min carries the same authority and the same MEZ day
// boundary. Days before the fine window carry min null (honest, visible in
// the schema; the page draws mean as the lower edge there and says so), and
// so does every PARTIAL day — the window's edge days, the first from 15:15
// and the last up to the export hour: on the seed the first day's 35-sample
// "min" sat above the source's day mean at 9 of 252 gauges (condenseHires
// `full`, dayMin). `n` is written for such days regardless, honestly partial.
// Since 2026-09-10 `full` also demands 90 % of the samples the step implies:
// spanning a day is not covering it, and a day whose samples run from 00:00
// to 23:45 around a hole in the middle passed the span test and shipped its
// min anyway — 4 of 15 411 days on the 2026-09-06 mirror. The failure mode is
// N5 (a min above the source's own day mean) going red on a run nobody
// touched, so the floor sits at the point the min is derived, not at the gate.
//
// ---- Usage ----
//   node scripts/fetch-nrw-archive.mjs --out nrw-branch/nrw --out-hires nrw-hires-branch/nrw-hires
//   node scripts/fetch-nrw-archive.mjs --raw tmp-nrw/raw/2026-09-04 --out /tmp/nrw --dry-run
//       # --raw reads stations.json + the three ZIPs from a directory (the
//       # stage-0 seed on the nrw-hires branch) instead of fetching tier 1
//   node scripts/fetch-nrw-archive.mjs --raw … --out … --bulk-only          # skip tier 2 (no network)
//   node scripts/fetch-nrw-archive.mjs … --station-cache tmp-nrw/t2         # replay tier 2 from disk
//   node scripts/fetch-nrw-archive.mjs … --max-years 2 --allow-prune        # the pruning lever
//   node scripts/fetch-nrw-archive.mjs … --max-months 24 --allow-prune      # its hires sibling
// Both levers are OFF by default and never passed by the workflow (same
// construction as --max-months in snapshot-wsv.mjs); without --allow-prune
// they refuse, because the consistency gate forbids deletions (N4).
// PEGEL_NOW pins the clock. Node's fetch ignores HTTP_PROXY: a run from a
// sandboxed session needs the bypass; curl reaches the host either way.
//
// ---- Push runbook (both branches GitHub-only, like `archive` and `hires`) ----
// Data branches live on the `github` remote alone — `origin` is the Forgejo
// CODE mirror and must never carry one (a stale copy there is what enabled the
// 2026-08-23 force-push reset). `nrw` is mounted by pages.yml under /nrw/;
// `nrw-hires` (raw seed + fine series, ~75 MB/year) is kept, never deployed.
//
//   for B in nrw nrw-hires; do
//     SINK=tmp-nrw/$B-branch
//     git clone --quiet --origin github --branch $B --single-branch \
//         https://github.com/bmmmm/pegel-visual.git "$SINK" 2>/dev/null || {
//       git init -b $B "$SINK"; git -C "$SINK" remote add github https://github.com/bmmmm/pegel-visual.git; }
//     git -C "$SINK" config credential.https://github.com.helper '!gh auth git-credential'
//   done
//   node scripts/fetch-nrw-archive.mjs --out tmp-nrw/nrw-branch/nrw --out-hires tmp-nrw/nrw-hires-branch/nrw-hires
//   node scripts/check-nrw-consistency.mjs --tree tmp-nrw/nrw-branch/nrw --git tmp-nrw/nrw-branch
//   git -C tmp-nrw/nrw-branch add -A && git -C tmp-nrw/nrw-branch commit -m "nrw: collect $(date -u +%F)"
//   git -C tmp-nrw/nrw-branch push github HEAD:nrw          # fast-forward only
//   (same for nrw-hires-branch)
//   gh workflow run pages.yml --ref main                     # a data push never triggers a deploy
//   # protection, once per branch, the exact call from fetch-wsv-archive.mjs:
//   gh api -X PUT repos/bmmmm/pegel-visual/branches/<b>/protection \
//     -H "Accept: application/vnd.github+json" --input - <<'JSON'
//   {"required_status_checks":null,"enforce_admins":true,
//    "required_pull_request_reviews":null,"restrictions":null,
//    "allow_force_pushes":false,"allow_deletions":false}
//   JSON
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  daysInYear, zipEntries, unzipNamed, reportRunOutcome, PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM,
} from './fetch-wsv-archive.mjs';
// The coordinate box belongs to the areal-rain rule, so it is defined there and
// imported here rather than restated: a station the map places must be a station
// the rule can assign, and one definition cannot drift from the other.
import { usableCoords } from './build-nrw-precip.mjs';
import { parseArgs, pinnedNow, readJson, listDirs, listFiles, sleep, writeJson, writeText } from './lib/cli.mjs';
export { writeJson };

export const BASE = 'https://hochwasserportal.nrw/data';
export const LICENSE = 'dl-de/zero-2.0';
export const SCHEMA = 1;
export const RUNS_KEPT = 400;
const THROTTLE_MS = 300;
const FETCH_TIMEOUT_MS = 120000;

// water temperature in °C: the one sentinel pair of the 2026-09-04 seed sits at
// 3822 / 165.34 next to a real 28; nothing real in NRW leaves this range
export const PLAUSIBLE_TEMP_C = [-2, 40];
// rivers whose DIST_TO_CONFL is a river-km counted from the source (the Rhine
// gauges, site 102: Andernach 613,78 km) — their chain runs ascending
export const RIVER_KM_RIVERS = new Set(['Rhein']);
// a distance past this is a placeholder, not a position (Espeln: "353725,00 km")
const MAX_DIST_KM = 2000;

// PEGEL_NOW pins the clock (same convention as the other scripts)
const now = pinnedNow();

export const PRODUCTS = {
  gauges: {
    zip: 'pegeldaten.zip',
    tables: { stations: 'pegel_stationen.txt', mean: 'pegel_tagesmittelwerte.txt', max: 'pegel_tagesmaxima.txt', hires: 'pegel_messwerte.txt' },
    boundaryHour: 0, dayBoundary: '00:00+01:00', unit: 'cm', hiresStep: null, // null: detected per gauge (900 or 300)
  },
  rain: {
    zip: 'niederschlagsdaten.zip',
    tables: { stations: 'nieder_stationen.txt', daily: 'nieder_tageswerte.txt', hires: 'nieder_messwerte.txt' },
    boundaryHour: 7, dayBoundary: '07:00+01:00', unit: 'mm', hiresStep: 3600,
  },
  temp: {
    zip: 'temperaturdaten.zip',
    tables: { stations: 'temp_stationen.txt', mean: 'temp_tagesmittelwerte.txt', max: 'temp_tagesmaxima.txt', hires: 'temp_messwerte.txt' },
    boundaryHour: 0, dayBoundary: '00:00+01:00', unit: '°C', hiresStep: 3600,
  },
};

// ---------- text tables ----------

// a `;`-separated table with a header row (the three *_stationen.txt files)
export function parseTable(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(';');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split(';');
    const row = {};
    header.forEach((h, k) => { row[h] = cells[k] ?? ''; });
    rows.push(row);
  }
  return { header, rows };
}

// a value table: `station_no;time;value[;accuracy]` rows keyed by their own
// station_no; 2-field block terminators skipped. Returns Map no -> [[ts, v|null, acc|null], …].
// Scans by index rather than split(): the 15-minute table is 2.1 M lines.
export function parseSeries(text) {
  const nl = text.indexOf('\n');
  const header = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, '').split(';');
  const stations = new Map();
  let pos = nl < 0 ? text.length : nl + 1;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    let line = text.slice(pos, end);
    pos = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    const a = line.indexOf(';');
    const b = line.indexOf(';', a + 1);
    if (a < 0 || b < 0) continue; // `<no>;` — a block terminator, no value
    const c = line.indexOf(';', b + 1);
    const id = line.slice(0, a);
    const ts = line.slice(a + 1, b);
    const vs = c < 0 ? line.slice(b + 1) : line.slice(b + 1, c);
    const as = c < 0 ? '' : line.slice(c + 1);
    const acc = as === '' ? null : Number(as);
    let v = vs === '' ? null : Number(vs);
    if (v != null && !Number.isFinite(v)) v = null;
    if (acc === 0) v = null; // accuracy 0 % is "not measured", never 0 cm / 0 mm
    let rows = stations.get(id);
    if (!rows) { rows = []; stations.set(id, rows); }
    rows.push([ts, v, Number.isFinite(acc) ? acc : null]);
  }
  return { header, stations };
}

// "2825,00 km²" | "8,60 km" | "4485.94" -> number, anything else null
export function parseKm(s) {
  if (s == null) return null;
  const m = String(s).trim().replace(/\s*km²?\s*$/u, '').replace(',', '.');
  if (m === '') return null;
  const v = Number(m);
  return Number.isFinite(v) ? v : null;
}

// "250,0" -> 250; "" -> null
export function parseNum(s) {
  if (s == null || s === '') return null;
  const v = Number(String(s).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// ---------- MEZ calendar helpers ----------

// wall-clock parts of a source stamp. Every stamp of the source is fixed
// +01:00 (measured 2026-09-04 across 2.1 M rows), so the string is the MEZ
// clock; anything else is parsed and shifted.
export function mezParts(ts) {
  if (typeof ts !== 'string') return null;
  if (ts.endsWith('+01:00')) {
    const p = { y: +ts.slice(0, 4), m: +ts.slice(5, 7), d: +ts.slice(8, 10), hh: +ts.slice(11, 13), mm: +ts.slice(14, 16) };
    if ([p.y, p.m, p.d, p.hh, p.mm].every(Number.isFinite)) return p;
  }
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const x = new Date(t + 36e5);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), hh: x.getUTCHours(), mm: x.getUTCMinutes() };
}

export const isoDay = (y, d) => new Date(Date.UTC(y, 0, 1) + d * 864e5).toISOString().slice(0, 10);

// the (year, day index) a stamp belongs to under a day boundary: a rain stamp
// before 07:00 belongs to the day that started at 07:00 the day before
export function dayOf(ts, boundaryHour = 0) {
  const p = mezParts(ts);
  if (!p) return null;
  let t = Date.UTC(p.y, p.m - 1, p.d);
  if (p.hh < boundaryHour) t -= 864e5;
  const y = new Date(t).getUTCFullYear();
  return { y, d: (t - Date.UTC(y, 0, 1)) / 864e5 };
}

// ---------- registry: the union of the four station tables ----------

export const isGauge = st => /Oberflächengewässer/u.test(st.object_type || '');
export const isClimate = st => /Klimastation/u.test(st.object_type || '');

// keyed on station_no; stations.json first, table columns fill what it lacks
// (catchment_no, the 64 temp columns); `_src` records which tables carry it
export function buildRegistry({ stations, tables }) {
  const reg = new Map();
  const put = (src, row) => {
    const no = row.station_no;
    if (!no) return;
    let e = reg.get(no);
    if (!e) { e = { station_no: no, _src: [] }; reg.set(no, e); }
    e._src.push(src);
    for (const [k, v] of Object.entries(row)) {
      if (k === 'station_no' || k === '_src') continue;
      if (e[k] == null || e[k] === '') e[k] = v;
    }
  };
  for (const s of stations || []) put('stations', s);
  for (const r of (tables && tables.gauges) || []) put('pegel', r);
  for (const r of (tables && tables.rain) || []) put('nieder', r);
  for (const r of (tables && tables.temp) || []) put('temp', r);
  return reg;
}

export const inTable = (e, src) => e._src.includes(src);
export const isGaugeLike = e => isGauge(e) || inTable(e, 'pegel') || inTable(e, 'temp');
export const isRainLike = e => isClimate(e) || inTable(e, 'nieder');

// name -> number from every station that carries both; the known numbers
export function basinIndex(registry) {
  const nameToNo = new Map();
  const nos = new Set();
  for (const e of registry.values()) {
    if (!e.catchment_no) continue;
    nos.add(e.catchment_no);
    if (e.catchment_name && e.catchment_name !== '---' && !nameToNo.has(e.catchment_name)) {
      nameToNo.set(e.catchment_name, e.catchment_no);
    }
  }
  return { nameToNo, nos };
}

// the assignment rule, with its provenance
export function assignBasin(e, { nameToNo, nos }) {
  if (e.catchment_no) return { no: e.catchment_no, src: 'bulk' };
  if (e.catchment_name && nameToNo.has(e.catchment_name)) return { no: nameToNo.get(e.catchment_name), src: 'name' };
  if (isGaugeLike(e) && /^\d+$/.test(e.station_no)) {
    let best = null;
    for (const no of nos) if (e.station_no.startsWith(no) && (!best || no.length > best.length)) best = no;
    if (best) return { no: best, src: 'gkz' };
  }
  return { no: null, src: null };
}

// ---------- topology ----------

// the LAWA stretch code inside a station_no (see the header)
export function stretchOf(no, siteNo) {
  if (/^\d{13}$/.test(no)) return no.slice(0, 10).replace(/0+$/, '');
  if (siteNo === '102' && /^\d{7,8}$/.test(no)) return no.slice(0, 3);
  return null;
}

// the river a stretch belongs to, relative to its basin: the prefix up to the
// last even digit (a tributary), or the basin itself
export function riverCodeOf(stretch, basin) {
  if (!stretch || !basin || !stretch.startsWith(basin)) return null;
  let code = basin;
  for (let i = basin.length; i < stretch.length; i++) {
    if (Number(stretch[i]) % 2 === 0) code = stretch.slice(0, i + 1);
  }
  return code;
}

function gaugeNode(e, basin) {
  const river = e.WTO_OBJECT || e.river_name || '';
  let dist = parseKm(e.DIST_TO_CONFL);
  if (dist != null && dist > MAX_DIST_KM) dist = null;
  const stretch = stretchOf(e.station_no, e.site_no);
  return {
    id: e.station_no, name: e.station_name || '', water: river, basin: basin.no, basinSrc: basin.src,
    siteNo: e.site_no || null, km2: parseKm(e.CATCHMENT_SIZE), distKm: dist,
    stretch, riverCode: riverCodeOf(stretch, basin.no), down: null, downSrc: null,
  };
}

// chains per (basin, river name) in flow order, `down` along the chain, the
// tributary mouths hooked onto the parent river via the GKZ, the basin's
// main-river mouth marked. Returns { basins, gauges }. Only gauges that carry
// a level series (`hasLevel`) are nodes — the topology follows the data, so a
// chain never points at a station the page cannot draw; the rest of the
// registry's gauges are listed per basin under `noLevel`.
export function buildTopology(registry, basinOf, hasLevel = () => true) {
  const gauges = {};
  const byBasin = new Map();
  const noLevel = new Map();
  for (const e of registry.values()) {
    if (!isGaugeLike(e)) continue;
    const basin = basinOf(e);
    if (!hasLevel(e)) {
      if (basin.no) { if (!noLevel.has(basin.no)) noLevel.set(basin.no, []); noLevel.get(basin.no).push(e.station_no); }
      continue;
    }
    const g = gaugeNode(e, basin);
    gauges[g.id] = g;
    if (g.basin) {
      if (!byBasin.has(g.basin)) byBasin.set(g.basin, []);
      byBasin.get(g.basin).push(g);
    }
  }
  const basins = {};
  for (const [no, list] of byBasin) {
    // chains by river name
    const chains = new Map();
    for (const g of list) {
      if (!chains.has(g.water)) chains.set(g.water, []);
      chains.get(g.water).push(g);
    }
    const order = new Map(); // river name -> sorted gauges with a position
    for (const [river, members] of chains) {
      const sorted = members.filter(g => g.distKm != null);
      sorted.sort((a, b) => RIVER_KM_RIVERS.has(river) ? a.distKm - b.distKm : b.distKm - a.distKm);
      // a catchment only grows downstream: a gauge whose area is smaller than
      // an upstream neighbour's does not sit where its distance says (the
      // Lippstadt-Nordumflut bypass reports 0,45 km to ITS confluence next to
      // 1385 km² — 168 km up the Lippe, not at the mouth) and stays off the chain
      const positioned = [];
      let km2 = null;
      for (const g of sorted) {
        if (g.km2 != null && km2 != null && g.km2 < km2 * 0.95) { g.flag = 'km2-order'; continue; }
        if (g.km2 != null) km2 = Math.max(km2 ?? 0, g.km2);
        positioned.push(g);
      }
      order.set(river, positioned);
      for (let i = 0; i + 1 < positioned.length; i++) {
        positioned[i].down = positioned[i + 1].id;
        positioned[i].downSrc = 'river';
      }
    }
    // the basin's main river: the name whose gauges carry the basin's own code
    const mainVotes = new Map();
    for (const g of list) if (g.riverCode === no && g.water) mainVotes.set(g.water, (mainVotes.get(g.water) || 0) + 1);
    let mainRiver = null;
    for (const [river, n] of mainVotes) if (!mainRiver || n > mainVotes.get(mainRiver)) mainRiver = river;
    if (!mainRiver) {
      for (const [river, members] of chains) if (river && (!mainRiver || members.length > chains.get(mainRiver).length)) mainRiver = river;
    }
    const riverByCode = new Map(); // river code -> river name (majority)
    for (const g of list) {
      if (!g.riverCode || !g.water) continue;
      const votes = riverByCode.get(g.riverCode) || new Map();
      votes.set(g.water, (votes.get(g.water) || 0) + 1);
      riverByCode.set(g.riverCode, votes);
    }
    const nameOfCode = code => {
      const votes = riverByCode.get(code);
      if (!votes) return null;
      let best = null;
      for (const [river, n] of votes) if (!best || n > votes.get(best)) best = river;
      return best;
    };
    // tributary mouths: the last positioned gauge of every non-main chain
    for (const [river, positioned] of order) {
      if (!positioned.length) continue;
      const last = positioned[positioned.length - 1];
      if (river === mainRiver) { last.downSrc = 'mouth'; continue; }
      const code = last.riverCode || positioned.map(g => g.riverCode).find(Boolean);
      if (!code || code === no) continue;
      const parentCode = riverCodeOf(code.slice(0, -1), no);
      const parentRiver = nameOfCode(parentCode);
      const parentChain = parentRiver ? order.get(parentRiver) || [] : [];
      const next = parentChain.find(g => g.stretch && g.stretch > code && g.riverCode === parentCode);
      if (next) { last.down = next.id; last.downSrc = 'gkz'; }
    }
    const mainChain = (mainRiver && order.get(mainRiver)) || [];
    const names = [...new Set(list.map(g => registry.get(g.id).catchment_name).filter(n => n && n !== '---'))].sort();
    const rivers = [...chains.entries()].filter(([r]) => r).sort((a, b) => b[1].length - a[1].length).map(([r]) => r);
    basins[no] = {
      name: mainRiver || names[0] || no, names, river: mainRiver, rivers,
      gauges: list.map(g => g.id).sort(), noLevel: (noLevel.get(no) || []).sort(), rain: [], temp: [],
      mouth: mainChain.length ? mainChain[mainChain.length - 1].id : null,
    };
  }
  for (const [no, ids] of noLevel) {
    if (basins[no]) continue;
    const names = [...new Set(ids.map(id => registry.get(id).catchment_name).filter(n => n && n !== '---'))].sort();
    basins[no] = { name: names[0] || no, names, river: null, rivers: [], gauges: [], noLevel: ids.sort(), rain: [], temp: [], mouth: null };
  }
  for (const e of registry.values()) {
    const b = basinOf(e);
    if (!b.no) continue;
    if (!basins[b.no]) {
      const name = e.catchment_name && e.catchment_name !== '---' ? e.catchment_name : b.no;
      basins[b.no] = { name, names: name === b.no ? [] : [name], river: null, rivers: [], gauges: [], noLevel: [], rain: [], temp: [], mouth: null };
    }
    if (isRainLike(e)) basins[b.no].rain.push(e.station_no);
    if (inTable(e, 'temp')) basins[b.no].temp.push(e.station_no);
  }
  for (const b of Object.values(basins)) { b.rain.sort(); b.temp.sort(); }
  return { basins, gauges };
}

// ---------- condense to day-indexed year shards ----------

function yearSlot(map, y, fields) {
  let yr = map.get(y);
  if (!yr) {
    const n = daysInYear(y);
    yr = { y };
    for (const f of fields) yr[f] = Array(n).fill(null);
    yr.acc = {};
    map.set(y, yr);
  }
  return yr;
}

// fold one value table into year arrays: `reduce` 'last' for a one-row-per-day
// series, 'max' where several rows may land on one day (temp maxima). The
// accuracy of a kept value is remembered where it is not 100 %.
export function foldDaily(rows, { boundaryHour = 0, field, reduce = 'last', plausible = null, into = new Map() }) {
  for (const [ts, v, acc] of rows) {
    if (v == null) continue;
    if (plausible && !(v >= plausible[0] && v <= plausible[1])) continue;
    const day = dayOf(ts, boundaryHour);
    if (!day) continue;
    const yr = yearSlot(into, day.y, [field]);
    if (!Array.isArray(yr[field])) yr[field] = Array(daysInYear(day.y)).fill(null);
    const cur = yr[field][day.d];
    if (reduce === 'max' && cur != null && cur >= v) continue;
    yr[field][day.d] = v;
    if (acc != null && acc !== 100) yr.acc[day.d] = Math.min(yr.acc[day.d] ?? 100, acc);
    else if (reduce === 'last') delete yr.acc[day.d];
  }
  return into;
}

// the day extremes of a fine series: min/max/mean/n per MEZ day — min and n
// are what the source does not deliver, mean and max are the cross-check.
// `full[d]` says whether the kept samples COVER the whole day: first sample
// within one `step` of the day boundary, last within one `step` of the next,
// AND at least FULL_DAY_SAMPLE_SHARE of the samples the step implies. Only
// then is the day's min a day minimum. The window's edge days are partial
// by construction (the 2026-09-04 seed starts 15:15, an export ends ~15:05),
// and on that seed the first day's "min" sat ABOVE the source's own day mean
// at 9 of 252 gauges — 35 afternoon samples of 96 — which is exactly what the
// gate's N5 refuses. A gap INSIDE the day is the source's, not the edge's —
// but it hides from the span test, which sees only the two outer samples, so
// the count floor is what catches it.
const FULL_DAY_SAMPLE_SHARE = 0.9;
export function condenseHires(rows, { boundaryHour = 0, plausible = null, step = null } = {}) {
  const years = new Map();
  const DAY_S = 86400;
  if (step == null) step = stepOf(rows);
  for (const [ts, v] of rows) {
    if (v == null) continue;
    if (plausible && !(v >= plausible[0] && v <= plausible[1])) continue;
    const day = dayOf(ts, boundaryHour);
    if (!day) continue;
    const p = mezParts(ts);
    let sec = (p.hh * 60 + p.mm) * 60 - boundaryHour * 3600;
    if (sec < 0) sec += DAY_S;
    const yr = yearSlot(years, day.y, ['min', 'max', 'sum', 'n', 'first', 'last']);
    const d = day.d;
    if (yr.n[d] == null) { yr.min[d] = v; yr.max[d] = v; yr.sum[d] = v; yr.n[d] = 1; yr.first[d] = sec; yr.last[d] = sec; continue; }
    if (v < yr.min[d]) yr.min[d] = v;
    if (v > yr.max[d]) yr.max[d] = v;
    yr.sum[d] += v;
    yr.n[d]++;
    if (sec < yr.first[d]) yr.first[d] = sec;
    if (sec > yr.last[d]) yr.last[d] = sec;
  }
  for (const yr of years.values()) {
    yr.mean = yr.sum.map((s, d) => (yr.n[d] ? Math.round((s / yr.n[d]) * 1000) / 1000 : null));
    // spanning the day is not covering it: the first and the last sample say
    // nothing about a hole between them, so a count floor has to stand beside
    // the span (measured 2026-09-06: 4 of 15 411 days span the day on under
    // 90 % of its samples, and each of them shipped a `min` off a partial day)
    const floor = Math.ceil((DAY_S / step) * FULL_DAY_SAMPLE_SHARE);
    yr.full = yr.n.map((n, d) => n != null && n >= floor && yr.first[d] <= step && yr.last[d] >= DAY_S - step);
    delete yr.sum; delete yr.first; delete yr.last;
  }
  return years;
}

// the minima a gauge shard may carry: full days only — a partial day's min is
// not the day's minimum and stays null; `n` is still written, honestly partial
export const dayMin = yr => yr.min.map((v, d) => (yr.full && yr.full[d] ? v : null));

// whether a folded series carries a single value. The portal advertises S for
// four Rur gauges (123456 St. Obermaubach UW, 1234567 St. Heimbach UW,
// 2821790000100 Dedenborn, 2829724000100 Birgeler Bach Kirche — all site 104)
// whose year.json is 164–364 rows of [ts, null, accuracy]: the accuracy column
// is filled, the value never (measured 2026-09-06; a healthy single-station
// series, 102/2710080, has the same columns with values). Such a station is
// `empty` — neither a tier-2 success nor a level node in the topology, and
// never a red run, by the same rule as "no S".
export const seriesHasValues = years => [...years.values()].some(yr => ['mean', 'max', 'mm'].some(f => Array.isArray(yr[f]) && yr[f].some(v => v != null)));

// ---------- merge: fresh wins where it has a value, stored stays otherwise ----------

// `fields` are merged slot-wise: fresh non-null wins, a fresh null never
// overwrites a stored non-null (which also freezes everything outside the
// delivered window — the delivery has no values there). `acc` follows the
// value it belongs to: a fresh value brings its own accuracy or clears the
// stored one.
export function mergeDaily(existing, fresh, fields, sparse = 'acc') {
  const y = fresh.y;
  const n = daysInYear(y);
  const out = { id: fresh.id ?? existing?.id, y };
  const ex = existing && existing.y === y ? existing : null;
  for (const f of fields) {
    const a = (ex && Array.isArray(ex[f]) && ex[f].length === n) ? ex[f] : Array(n).fill(null);
    const b = Array.isArray(fresh[f]) ? fresh[f] : null;
    out[f] = b ? a.map((v, d) => (b[d] != null ? b[d] : v)) : a.slice();
  }
  const acc = { ...((ex && ex[sparse]) || {}) };
  // only a delivery that carries accuracies may touch them: the fields
  // derived from the fine series (min, n, imax) bring none and leave the
  // stored ones alone
  if (fresh[sparse] && typeof fresh[sparse] === 'object') {
    for (let d = 0; d < n; d++) {
      const freshHasValue = fields.some(f => Array.isArray(fresh[f]) && fresh[f][d] != null);
      if (!freshHasValue) continue;
      const fa = fresh[sparse] && fresh[sparse][d];
      if (fa != null && fa !== 100) acc[d] = fa; else delete acc[d];
    }
  }
  out[sparse] = acc;
  return out;
}

// ---------- month shards for the fine series ----------

// the cadence of a series: the modal spacing, snapped to 5 / 15 / 60 minutes
export function stepOf(rows) {
  const counts = new Map();
  let prev = null;
  for (const [ts] of rows) {
    const p = mezParts(ts);
    if (!p) continue;
    const t = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) / 1000;
    if (prev != null && t > prev) counts.set(t - prev, (counts.get(t - prev) || 0) + 1);
    prev = t;
  }
  let mode = 900, best = -1;
  for (const [d, c] of counts) if (c > best) { best = c; mode = d; }
  let snapped = 900, err = Infinity;
  for (const s of [300, 900, 3600]) if (Math.abs(s - mode) < err) { err = Math.abs(s - mode); snapped = s; }
  return snapped;
}

const monthKey = p => `${p.y}-${String(p.m).padStart(2, '0')}`;
const monthStartIso = p => `${monthKey(p)}-01T00:00:00+01:00`;

// a dense grid per MEZ month: v[i] is the reading at start + i*step, a stamp
// off the grid snaps to the nearest slot, a repeated slot keeps the LAST value
export function toMonthShards(rows, step) {
  const months = new Map();
  for (const [ts, v] of rows) {
    if (v == null) continue;
    const p = mezParts(ts);
    if (!p) continue;
    const key = monthKey(p);
    let sh = months.get(key);
    if (!sh) { sh = { month: key, step, start: monthStartIso(p), v: [] }; months.set(key, sh); }
    const slot = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Date.UTC(p.y, p.m - 1, 1)) / (step * 1000));
    if (slot < 0) continue;
    while (sh.v.length < slot) sh.v.push(null);
    sh.v[slot] = v;
  }
  return months;
}

const regrid = (v, from, to) => {
  if (from === to) return v.slice();
  const ratio = from / to; // >1: coarser -> finer
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const j = Math.round(i * ratio);
    while (out.length < j) out.push(null);
    out[j] = v[i];
  }
  return out;
};

// slot-wise: fresh non-null wins, stored stays; the finer step of the two is
// kept if a gauge ever changes cadence
export function mergeMonthShard(existing, fresh) {
  if (!existing || !Array.isArray(existing.v)) return { ...fresh, v: trimNulls(fresh.v) };
  const step = Math.min(existing.step || fresh.step, fresh.step);
  const a = regrid(existing.v, existing.step || fresh.step, step);
  const b = regrid(fresh.v, fresh.step, step);
  const n = Math.max(a.length, b.length);
  const v = [];
  for (let i = 0; i < n; i++) v.push(b[i] != null ? b[i] : (a[i] ?? null));
  return { ...existing, ...fresh, step, v: trimNulls(v) };
}

function trimNulls(v) {
  let end = v.length;
  while (end > 0 && v[end - 1] == null) end--;
  return v.slice(0, end);
}

// ---------- files ----------

// upsert year shards for one station; returns the number of files written
export function upsertYears(dir, id, years, fields, sparse = 'acc') {
  let written = 0;
  for (const [y, fresh] of years) {
    if (!fields.some(f => Array.isArray(fresh[f]) && fresh[f].some(v => v != null))) continue;
    const path = join(dir, `${y}.json`);
    const merged = mergeDaily(readJson(path), { ...fresh, id }, fields, sparse);
    if (writeJson(path, merged)) written++;
  }
  return written;
}

export function upsertMonths(dir, id, months) {
  let written = 0;
  for (const [month, fresh] of months) {
    if (!fresh.v.some(v => v != null)) continue;
    const path = join(dir, `${month}.json`);
    const merged = mergeMonthShard(readJson(path), { id, ...fresh });
    if (writeJson(path, merged)) written++;
  }
  return written;
}

// first/last day with a value, and how many days carry one — over every
// year shard of a station directory
export function spanOf(dir, fields) {
  let from = null, to = null, days = 0;
  for (const f of listFiles(dir)) {
    const hit = /^(\d{4})\.json$/.exec(f);
    if (!hit) continue;
    const yr = readJson(join(dir, f));
    if (!yr) continue;
    const y = Number(hit[1]);
    const n = daysInYear(y);
    for (let d = 0; d < n; d++) {
      if (!fields.some(k => Array.isArray(yr[k]) && yr[k][d] != null)) continue;
      const iso = isoDay(y, d);
      if (!from) from = iso;
      to = iso;
      days++;
    }
  }
  return { from, to, days };
}

// ---------- station metadata ----------

const infoOf = e => [e.LANUV_Info_1, e.LANUV_Info_2, e.LANUV_Info_3].map(parseNum);

export function gaugeMeta(e, node, product, extra = {}) {
  const meta = {
    id: e.station_no, name: e.station_name || '', water: node ? node.water : (e.WTO_OBJECT || e.river_name || ''),
    siteNo: e.site_no || null, lat: parseNum(e.station_latitude), lon: parseNum(e.station_longitude),
    catchmentNo: node ? node.basin : null, catchmentName: e.catchment_name && e.catchment_name !== '---' ? e.catchment_name : null,
    basinSrc: node ? node.basinSrc : null, catchmentKm2: node ? node.km2 : parseKm(e.CATCHMENT_SIZE),
    distToConflKm: node ? node.distKm : parseKm(e.DIST_TO_CONFL),
    unit: product.unit, info: infoOf(e), mw: parseNum(e.LANUV_MW), mnw: parseNum(e.LANUV_MNW), mhw: parseNum(e.LANUV_MHW),
    gaugeDatum: parseNum(e.station_gauge_datum || e.GAUGE_DATUM), note: e.INTERNET_BEMERKUNG || null,
    dayBoundary: product.dayBoundary, ...extra,
  };
  if (node) { meta.down = node.down; meta.downSrc = node.downSrc; }
  return meta;
}

export function rainMeta(e, basin, extra = {}) {
  return {
    id: e.station_no, name: e.station_name || '', siteNo: e.site_no || null,
    lat: parseNum(e.station_latitude), lon: parseNum(e.station_longitude),
    catchmentNo: basin.no, catchmentName: e.catchment_name && e.catchment_name !== '---' ? e.catchment_name : null, basinSrc: basin.src,
    unit: 'mm', dayBoundary: PRODUCTS.rain.dayBoundary, ...extra,
  };
}

// merge a fresh meta over the stored one: from/to/src are recomputed by the
// caller, everything else is the registry's current word (the operator
// revises Info values; the gate prints such changes, it does not block them)
function upsertMeta(dir, fresh) {
  const path = join(dir, 'meta.json');
  const prev = readJson(path) || {};
  const merged = { ...prev, ...fresh };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return writeJson(path, merged);
}

// ---------- tier 1: the four downloads ----------

async function fetchBytes(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 3) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchBulk(fetchImpl = fetch) {
  const cb = Date.now();
  const stations = JSON.parse(Buffer.from(await fetchBytes(`${BASE}/internet/stations/stations.json?cb=${cb}`, fetchImpl)).toString('utf8'));
  const zips = {};
  for (const [key, p] of Object.entries(PRODUCTS)) {
    await sleep(THROTTLE_MS);
    zips[key] = await fetchBytes(`${BASE}/downloads/${p.zip}?cb=${cb}`, fetchImpl);
  }
  return { stations, zips };
}

// a raw seed directory: stations.json plus the three product ZIPs, and — when
// the seed carries one — a SHA256SUMS the four are checked against, so a
// truncated or tampered seed refuses to replay instead of merging silently
export function readRawDir(dir) {
  const sums = readSha256Sums(join(dir, 'SHA256SUMS'));
  const checked = name => {
    const bytes = readFileSync(join(dir, name));
    const want = sums && sums.get(name);
    if (want) {
      const got = createHash('sha256').update(bytes).digest('hex');
      if (got !== want) throw new Error(`raw seed ${name}: sha256 ${got} does not match SHA256SUMS (${want})`);
    }
    return bytes;
  };
  const stations = JSON.parse(checked('stations.json').toString('utf8'));
  const zips = {};
  for (const [key, p] of Object.entries(PRODUCTS)) zips[key] = new Uint8Array(checked(p.zip));
  return { stations, zips };
}

// SHA256SUMS as `shasum -a 256` writes it — "<hex>  <path>" per line, the path
// however the writer's cwd spelled it — keyed on the basename; null when absent
export function readSha256Sums(path) {
  if (!existsSync(path)) return null;
  const sums = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (m) sums.set(m[2].split('/').pop(), m[1]);
  }
  return sums;
}

// pull exactly the named tables out of one product ZIP; the export stamp is
// the newest entry's DOS time, which the source writes in UTC (14:11:10 for a
// table whose last reading is 15:00+01:00 = 14:00Z, measured 2026-09-04)
export function openProduct(zip, product, names = Object.values(product.tables)) {
  const entries = zipEntries(zip);
  let exportAt = null;
  for (const e of entries) if (!exportAt || e.mtime > exportAt) exportAt = e.mtime;
  const bufs = unzipNamed(zip, names);
  const text = {};
  for (const [role, name] of Object.entries(product.tables)) {
    if (bufs.has(name)) text[role] = bufs.get(name).toString('utf8');
  }
  const missing = names.filter(n => !bufs.has(n));
  return { text, exportAt, missing };
}

// ---------- tier 2: index.json-driven per-station fetch ----------

export async function fetchJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export const TIER2_PARAMS = ['S', 'N', 'WT'];

// the year.json links index.json actually advertises — nothing is guessed
export function tier2Links(index) {
  return ((index && index._links) || [])
    .filter(l => l && l.type === 'resource' && l.mime_type === 'application/json'
      && l.period_alias === '1Y' && TIER2_PARAMS.includes(l.station_parameter) && l.href)
    .map(l => ({ param: l.station_parameter, href: l.href }));
}

export const tier2Params = index => [...new Set(((index && index._links) || [])
  .filter(l => l && l.type === 'resource' && l.station_parameter).map(l => l.station_parameter))].sort();

// year.json is an array of series; the role of each comes from ts_shortname:
// Day.Mean.B.Inter.W / Day.Max.B.Inter.W (S and, as .TW, water temperature),
// 7hDay.Total.B.Inter.N for rain — measured 2026-09-04. Only DAY series are
// read: the rain document also carries 7hMonth.Total.B.Inter.N, a monthly sum
// stamped on the 1st at 07:00, which would overwrite that day's value.
export function tier2Series(doc, boundaryHour = 0, plausible = null) {
  const years = new Map();
  const unknown = [];
  for (const s of Array.isArray(doc) ? doc : []) {
    const short = s.ts_shortname || s.ts_name || '';
    if (!/(^|\d+h)Day\./u.test(short)) continue; // Month.* and friends: not a day value
    let field, reduce = 'last';
    if (/\.Mean\./u.test(short)) field = 'mean';
    else if (/\.Max\./u.test(short)) { field = 'max'; reduce = 'max'; }
    else if (/\.Total\.|\.Sum\./u.test(short) || s.ts_unitsymbol === 'mm') field = 'mm';
    else { unknown.push(short); continue; }
    const rows = (s.data || []).map(r => [r[0], typeof r[1] === 'number' ? r[1] : null, typeof r[2] === 'number' ? r[2] : null]);
    foldDaily(rows, { boundaryHour, field, reduce, plausible, into: years });
  }
  return { years, unknown };
}

async function cachedJson(cacheDir, name, url, fetchImpl) {
  const path = cacheDir ? join(cacheDir, name) : null;
  if (path && existsSync(path)) return readJson(path);
  await sleep(THROTTLE_MS);
  const doc = await fetchJson(url, fetchImpl);
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(doc)); }
  return doc;
}

// one station: its index and the advertised year.json of every parameter in
// `params` (the ones no bulk product carries for it — a WT the temperature ZIP
// already delivers is not fetched again, or tier 2 and bulk would rewrite the
// same shard against each other on every run); null index = the station has
// no page (counted, not red)
export async function fetchTier2(e, { fetchImpl = fetch, cacheDir = null, params = TIER2_PARAMS } = {}) {
  const key = `${e.site_no}-${e.station_no}`;
  const index = await cachedJson(cacheDir, `${key}/index.json`, `${BASE}/internet/stations/${e.site_no}/${e.station_no}/index.json`, fetchImpl);
  if (!index) return { id: e.station_no, index: null, params: [], docs: {} };
  const docs = {};
  for (const { param, href } of tier2Links(index)) {
    if (!params.includes(param)) continue;
    docs[param] = await cachedJson(cacheDir, `${key}/${param}-year.json`, `${BASE}/${href.replace(/^\/+/, '')}`, fetchImpl);
  }
  return { id: e.station_no, index, params: tier2Params(index), docs };
}

// ---------- pruning levers (off by default, refused without --allow-prune) ----------

export function pruneYears(out, maxYears, refDate) {
  const keepFrom = refDate.getUTCFullYear() - maxYears + 1;
  let pruned = 0;
  for (const kind of ['gauges', 'rain', 'temp']) {
    for (const no of listDirs(join(out, kind))) {
      for (const f of listFiles(join(out, kind, no))) {
        const hit = /^(\d{4})\.json$/.exec(f);
        if (hit && Number(hit[1]) < keepFrom) { unlinkSync(join(out, kind, no, f)); pruned++; console.log(`pruned ${kind}/${no}/${f}`); }
      }
    }
  }
  return pruned;
}

export const monthIsPrunable = (y, m, refDate, maxMonths) => {
  const ref = new Date(refDate.getTime() + 36e5); // MEZ
  return (ref.getUTCFullYear() - y) * 12 + (ref.getUTCMonth() + 1 - m) > maxMonths;
};

export function pruneMonths(outHires, maxMonths, refDate) {
  let pruned = 0;
  for (const kind of ['gauges', 'rain', 'temp']) {
    for (const no of listDirs(join(outHires, kind))) {
      for (const f of listFiles(join(outHires, kind, no))) {
        const hit = /^(\d{4})-(\d{2})\.json$/.exec(f);
        if (hit && monthIsPrunable(Number(hit[1]), Number(hit[2]), refDate, maxMonths)) {
          unlinkSync(join(outHires, kind, no, f)); pruned++; console.log(`pruned ${kind}/${no}/${f}`);
        }
      }
    }
  }
  return pruned;
}

// ---------- manifest ----------

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function buildManifest({ out, registry, topo, basinOf, coverage, exportAt, window, generated, tier2 }) {
  const previous = readJson(join(out, 'manifest.json')) || {};
  const prevCov = previous.coverage || {};
  const manifest = {
    schema: SCHEMA, generated, sourceExportAt: exportAt, license: LICENSE, source: BASE,
    window, counts: {}, coverage: {}, gauges: {}, rain: {}, temp: {},
  };
  for (const [kind, cov] of Object.entries(coverage)) {
    const prevHigh = (prevCov[kind] && prevCov[kind].highWater) || {};
    const bulkPct = pct(cov.bulk, cov.registry);
    manifest.coverage[kind] = {
      ...cov,
      highWater: {
        bulk: Math.max(prevHigh.bulk || 0, cov.bulk),
        bulkPct: Math.max(prevHigh.bulkPct || 0, bulkPct),
        station: Math.max(prevHigh.station || 0, cov.station),
      },
    };
  }
  const entryFor = (kind, no, fields) => {
    const dir = join(out, kind, no);
    const meta = readJson(join(dir, 'meta.json'));
    if (!meta) return null;
    const span = spanOf(dir, fields);
    const e = { n: meta.name };
    if (kind !== 'rain') e.w = meta.water || '';
    e.b = meta.catchmentNo ?? null;
    // Coordinates, but only the ones inside the NRW box: without them every
    // LANUK gauge sits unplaced on the ?rivers map (mergeLanukIndex reads la/lo),
    // and with the unfiltered ones Ruenderoth's Gauss-Krueger pair would place a
    // gauge in the Atlantic. Same predicate the areal-rain assignment uses, so a
    // station is either placed AND assignable or neither.
    if (usableCoords(meta)) { e.la = meta.lat; e.lo = meta.lon; }
    // Distance to the mouth — deliberately NOT `km`: the app reads `km` as river
    // kilometre FROM THE SOURCE, and these two run in opposite directions.
    if (kind === 'gauges' && meta.distToConflKm != null) e.dc = meta.distToConflKm;
    if (kind === 'gauges') { e.site = meta.siteNo; e.src = meta.src; }
    if (span.from) { e.from = span.from; e.to = span.to; e.days = span.days; }
    if (meta.noSeries) e.noSeries = true;
    if (meta.empty) e.empty = true;
    return e;
  };
  for (const no of listDirs(join(out, 'gauges'))) { const e = entryFor('gauges', no, ['mean', 'max']); if (e) manifest.gauges[no] = e; }
  for (const no of listDirs(join(out, 'rain'))) { const e = entryFor('rain', no, ['mm']); if (e) manifest.rain[no] = e; }
  for (const no of listDirs(join(out, 'temp'))) { const e = entryFor('temp', no, ['mean', 'max']); if (e) manifest.temp[no] = e; }
  manifest.counts = {
    registry: registry.size,
    gauges: Object.values(manifest.gauges).filter(e => e.days).length,
    rain: Object.values(manifest.rain).filter(e => e.days).length,
    temp: Object.values(manifest.temp).filter(e => e.days).length,
    basins: Object.keys(topo.basins).length,
    tier2: tier2 || null,
  };
  return manifest;
}

const README = `# nrw — LANUK NRW gauges, rain and water temperature (daily level)

Data branch, written daily by \`.github/workflows/nrw-update.yml\` with
\`scripts/fetch-nrw-archive.mjs\`, mounted by \`pages.yml\` under \`/nrw/\`.
GitHub-only like \`archive\`; only ever fast-forwarded. Its sibling
\`nrw-hires\` holds the raw seed and the 15-minute / hourly series and is
never deployed.

Source: https://hochwasserportal.nrw/data (KISTERS WISKI-WEB, LANUK NRW),
bulk downloads under dl-de/zero-2.0. The source is a daily export with a
rolling 730-day window; \`manifest.sourceExportAt\` is the export's own
stamp, so nothing here is more current than ~24 h. The full schema, the
merge policy and every parser trap live in the script header.

Layout: \`manifest.json\`, \`registry.json\`, \`topology.json\`, \`runs.json\`,
then \`gauges/<station_no>/{meta.json,<YYYY>.json}\` (min/mean/max/n per MEZ
day; \`min\` and \`n\` derived from the fine series, null before its window),
\`rain/<station_no>/…\` (mm per day starting 07:00 MEZ, imax = max hourly
mm/h, coverage %) and \`temp/<station_no>/…\` (°C). Nothing is thinned or
deleted by the workflow; the pruning levers exist and are never passed.

\`precip/\` is the one DERIVED tree here, written by
\`scripts/build-nrw-precip.mjs\` in the same run, right after this collector
and before the gate. It holds the areal daily rainfall over each gauge's
upstream catchment (\`precip/<station_no>/{meta.json,<YYYY>.json,response.json}\`),
the same per basin (\`precip/basins/<no>/…\`), and \`precip/{index.json,overview.json}\`.
It is a pure function of the rest of this branch: \`--check\` recomputes it and
exits 1 with a list of what differs, and gate rule N8 runs exactly that before
every push. Unlike the mirrored trees it may SHRINK — a gauge that drops below
three upstream rain gauges loses its files, because a derived product must not
keep history its inputs no longer imply.

Two clocks: a rain day is [d 07:00, d+1 07:00) MEZ, a gauge day
[d 00:00, d+1 00:00). Rain day d closes seven hours into gauge day d+1, so
\`coverage.precip.lastRainDay\` — the newest rain day with a reading — is what
every drawing hangs its right edge on, not \`window.rain.to\` and not the clock.
`;

// ---------- the run ----------

export async function collect(o) {
  const {
    out, outHires = null, raw = null, stationCache = null, bulkOnly = false, dryRun = false,
    fetchImpl = fetch, log = console.log, err = console.error,
  } = o;
  const src = raw ? readRawDir(raw) : await fetchBulk(fetchImpl);
  const products = {};
  let exportAt = null;
  for (const [key, p] of Object.entries(PRODUCTS)) {
    const opened = openProduct(src.zips[key], p);
    if (opened.missing.length) throw new Error(`${p.zip}: missing ${opened.missing.join(', ')}`);
    products[key] = opened;
    if (!exportAt || opened.exportAt > exportAt) exportAt = opened.exportAt;
  }
  // one row per station_no: nieder_stationen.txt lists 50140112 twice
  // (Vormwald / Hilchenbach-Vormwald_HB_NRW, 2026-09-04) and a per-row loop
  // would count that station's coverage twice
  const tables = {
    gauges: uniqueBy(parseTable(products.gauges.text.stations).rows, r => r.station_no),
    rain: uniqueBy(parseTable(products.rain.text.stations).rows, r => r.station_no),
    temp: uniqueBy(parseTable(products.temp.text.stations).rows, r => r.station_no),
  };
  const registry = buildRegistry({ stations: src.stations, tables });
  const bidx = basinIndex(registry);
  const basinOf = e => assignBasin(e, bidx);
  const bulkGaugeIds = new Set(tables.gauges.map(r => r.station_no));
  const bulkRainIds = new Set(tables.rain.map(r => r.station_no));
  const bulkTempIds = new Set(tables.temp.map(r => r.station_no));
  const gaugeEntries = [...registry.values()].filter(isGaugeLike);
  const rainEntries = [...registry.values()].filter(isRainLike);
  // tier 2 = every station no bulk product carries (56 gauges + 6 rain on 2026-09-04)
  const tier2Gauges = gaugeEntries.filter(e => isGauge(e) && !bulkGaugeIds.has(e.station_no));
  const tier2Rain = rainEntries.filter(e => !bulkRainIds.has(e.station_no));
  const levelIds = new Set(bulkGaugeIds); // gauges with an S series: bulk, plus tier 2 below
  const wtIds = new Set(bulkTempIds);

  const window = {};
  const summary = { exportAt: exportAt ? exportAt.toISOString() : null, written: 0, tier2: null };

  if (dryRun) {
    // the dry run reads tier 1 only: the basins it prints are the bulk view
    const topo = buildTopology(registry, basinOf, e => levelIds.has(e.station_no));
    summary.basins = Object.keys(topo.basins).length;
    log(`registry ${registry.size} stations (${gaugeEntries.length} gauges, ${rainEntries.length} rain, ${tables.temp.length} temperature), export ${summary.exportAt}`);
    log(`basins ${summary.basins}:`);
    for (const [no, b] of Object.entries(topo.basins).sort((a, b2) => a[0].localeCompare(b2[0], undefined, { numeric: true }))) {
      const mouth = b.mouth ? topo.gauges[b.mouth].name : '—';
      log(`  ${no.padStart(4)}  ${b.name.padEnd(12)} gauges ${String(b.gauges.length).padStart(3)}  rain ${String(b.rain.length).padStart(3)}  temp ${String(b.temp.length).padStart(3)}  mouth ${mouth}  [${b.names.join(' | ')}]`);
    }
    const unplaced = gaugeEntries.filter(e => !basinOf(e).no).map(e => e.station_name);
    log(`gauges without a basin: ${unplaced.length} ${unplaced.length ? JSON.stringify(unplaced) : ''}`);
    log('coverage (tier 1 only — the dry run fetches nothing per station):');
    log(`  gauges  registry ${gaugeEntries.filter(isGauge).length}  bulk ${bulkGaugeIds.size}  tier-2 candidates ${tier2Gauges.length}`);
    log(`  rain    registry ${rainEntries.length}  bulk ${bulkRainIds.size}  tier-2 candidates ${tier2Rain.length}`);
    log(`  temp    registry ${bulkTempIds.size}  bulk ${bulkTempIds.size}`);
    const sieg = [];
    for (let g = Object.values(topo.gauges).find(x => x.name === 'Weidenau'); g; g = g.down ? topo.gauges[g.down] : null) {
      sieg.push(`${g.name}${g.downSrc ? ` (${g.downSrc})` : ''}`);
      if (sieg.length > 20) break;
    }
    log(`Sieg chain: ${sieg.join(' → ')}`);
    return { registry, topo, summary };
  }

  mkdirSync(out, { recursive: true });
  let written = 0;
  const coverage = {
    gauges: { registry: gaugeEntries.filter(isGauge).length, bulk: 0, station: 0, noSeries: 0, empty: 0 },
    rain: { registry: rainEntries.length, bulk: 0, station: 0, noSeries: 0, empty: 0 },
    temp: { registry: bulkTempIds.size, bulk: 0, station: 0, noSeries: 0, empty: 0 },
  };

  // --- tier 2 first: its shards land before the bulk overwrites them inside
  // the bulk window; its metas wait for the topology below ---
  let tier2 = null;
  const tier2Metas = []; // [dir, meta] once the topology exists
  if (!bulkOnly) {
    tier2 = { attempted: 0, ok: 0, failed: 0, noIndex: 0, unknownSeries: new Set() };
    for (const e of [...tier2Gauges, ...tier2Rain]) {
      tier2.attempted++;
      let r;
      const params = TIER2_PARAMS.filter(p => (p === 'S' && !bulkGaugeIds.has(e.station_no))
        || (p === 'WT' && !bulkTempIds.has(e.station_no)) || (p === 'N' && !bulkRainIds.has(e.station_no)));
      try {
        r = await fetchTier2(e, { fetchImpl, cacheDir: stationCache, params });
      } catch (x) {
        tier2.failed++;
        err(`tier 2 ${e.station_name} (${e.site_no}/${e.station_no}): ${x.message}`);
        continue;
      }
      tier2.ok++;
      if (!r.index) { tier2.noIndex++; continue; }
      const has = p => Object.prototype.hasOwnProperty.call(r.docs, p);
      if (isGauge(e)) {
        const dir = join(out, 'gauges', e.station_no);
        if (has('S')) {
          const { years, unknown } = tier2Series(r.docs.S, 0, [PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM]);
          unknown.forEach(u => tier2.unknownSeries.add(u));
          if (seriesHasValues(years)) {
            written += upsertYears(dir, e.station_no, [...years].map(([y, yr]) => [y, { y, mean: yr.mean, max: yr.max, acc: yr.acc }]), ['min', 'mean', 'max', 'n']);
            levelIds.add(e.station_no);
            coverage.gauges.station++;
            tier2Metas.push([dir, e, PRODUCTS.gauges, { src: 'station', noSeries: undefined, empty: undefined, params: r.params }]);
          } else {
            // advertised, delivered, and nothing in it (see seriesHasValues):
            // a finding like "no S", so no level node and no station success
            coverage.gauges.empty++;
            tier2Metas.push([dir, e, PRODUCTS.gauges, { src: 'station', noSeries: undefined, empty: true, params: r.params }]);
          }
        } else {
          coverage.gauges.noSeries++;
          tier2Metas.push([dir, e, PRODUCTS.gauges, { src: 'none', noSeries: true, empty: undefined, params: r.params }]);
        }
        if (has('WT')) {
          const tdir = join(out, 'temp', e.station_no);
          const { years, unknown } = tier2Series(r.docs.WT, 0, PLAUSIBLE_TEMP_C);
          unknown.forEach(u => tier2.unknownSeries.add(u));
          wtIds.add(e.station_no);
          if (seriesHasValues(years)) {
            written += upsertYears(tdir, e.station_no, [...years].map(([y, yr]) => [y, { y, mean: yr.mean, max: yr.max, acc: yr.acc }]), ['mean', 'max']);
            coverage.temp.station++;
            tier2Metas.push([tdir, e, PRODUCTS.temp, { src: 'station', empty: undefined, params: r.params }]);
          } else {
            coverage.temp.empty++;
            tier2Metas.push([tdir, e, PRODUCTS.temp, { src: 'station', empty: true, params: r.params }]);
          }
        }
      }
      if (isClimate(e) || has('N')) {
        const rdir = join(out, 'rain', e.station_no);
        if (has('N')) {
          const { years, unknown } = tier2Series(r.docs.N, PRODUCTS.rain.boundaryHour, [0, Infinity]);
          unknown.forEach(u => tier2.unknownSeries.add(u));
          if (seriesHasValues(years)) {
            written += upsertYears(rdir, e.station_no, [...years].map(([y, yr]) => [y, { y, mm: yr.mm, cov: yr.acc }]), ['mm', 'imax'], 'cov');
            coverage.rain.station++;
            if (upsertMeta(rdir, rainMeta(e, basinOf(e), { src: 'station', noSeries: undefined, empty: undefined, params: r.params }))) written++;
          } else {
            coverage.rain.empty++;
            if (upsertMeta(rdir, rainMeta(e, basinOf(e), { src: 'station', noSeries: undefined, empty: true, params: r.params }))) written++;
          }
        } else if (isClimate(e)) {
          coverage.rain.noSeries++;
          if (upsertMeta(rdir, rainMeta(e, basinOf(e), { src: 'none', noSeries: true, params: r.params }))) written++;
        }
      }
    }
    tier2.unknownSeries = [...tier2.unknownSeries];
    if (tier2.unknownSeries.length) err(`tier 2: unrecognised series ${tier2.unknownSeries.join(', ')}`);
    reportRunOutcome('tier 2', tier2.ok, tier2.failed);
    summary.tier2 = tier2;
  }
  coverage.temp.registry = wtIds.size;

  // the topology follows the data: nodes are the gauges that have a level series now
  const topo = buildTopology(registry, basinOf, e => levelIds.has(e.station_no));
  summary.basins = Object.keys(topo.basins).length;
  for (const [dir, e, product, extra] of tier2Metas) {
    if (upsertMeta(dir, gaugeMeta(e, topo.gauges[e.station_no] || null, product, extra))) written++;
  }

  // --- gauges: daily mean/max, then min/n from the 15-minute series ---
  {
    const p = PRODUCTS.gauges;
    const mean = parseSeries(products.gauges.text.mean).stations;
    const max = parseSeries(products.gauges.text.max).stations;
    products.gauges.text.mean = products.gauges.text.max = null;
    window.gauges = spanOfRows([...mean.values(), ...max.values()]);
    for (const r of tables.gauges) {
      const e = registry.get(r.station_no);
      const node = topo.gauges[r.station_no] || null;
      const years = new Map();
      foldDaily(mean.get(r.station_no) || [], { field: 'mean', plausible: [PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM], into: years });
      foldDaily(max.get(r.station_no) || [], { field: 'max', reduce: 'max', plausible: [PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM], into: years });
      const dir = join(out, 'gauges', r.station_no);
      const n = upsertYears(dir, r.station_no, years, ['min', 'mean', 'max', 'n']);
      written += n;
      const hasData = [...years.values()].some(yr => yr.mean.some(v => v != null) || yr.max.some(v => v != null));
      if (hasData) coverage.gauges.bulk++;
      if (upsertMeta(dir, gaugeMeta(e, node, p, { src: 'bulk', noSeries: undefined, params: undefined }))) written++;
    }
    mean.clear(); max.clear();
    const hires = parseSeries(products.gauges.text.hires).stations;
    products.gauges.text.hires = null;
    window.gaugesHires = spanOfRows([...hires.values()]);
    for (const [no, rows] of hires) {
      const dir = join(out, 'gauges', no);
      const cond = condenseHires(rows, { plausible: [PLAUSIBLE_MIN_CM, PLAUSIBLE_MAX_CM], step: stepOf(rows) });
      // additive: only min and n, mean/max stay the source's own day values;
      // min only where the samples span the whole day (dayMin), n regardless
      written += upsertYears(dir, no, [...cond].map(([y, yr]) => [y, { y, min: dayMin(yr), n: yr.n }]), ['min', 'mean', 'max', 'n']);
      if (outHires) written += upsertMonths(join(outHires, 'gauges', no), no, toMonthShards(rows, stepOf(rows)));
    }
    hires.clear();
  }

  // --- rain: daily sums + coverage, imax from the hourly series ---
  {
    const p = PRODUCTS.rain;
    const daily = parseSeries(products.rain.text.daily).stations;
    products.rain.text.daily = null;
    window.rain = spanOfRows([...daily.values()]);
    for (const r of tables.rain) {
      const e = registry.get(r.station_no);
      const years = foldDaily(daily.get(r.station_no) || [], { boundaryHour: p.boundaryHour, field: 'mm', plausible: [0, Infinity] });
      const dir = join(out, 'rain', r.station_no);
      written += upsertYears(dir, r.station_no, [...years].map(([y, yr]) => [y, { y, mm: yr.mm, cov: yr.acc }]), ['mm', 'imax'], 'cov');
      if ([...years.values()].some(yr => yr.mm.some(v => v != null))) coverage.rain.bulk++;
      if (upsertMeta(dir, rainMeta(e, basinOf(e), { src: 'bulk', noSeries: undefined, params: undefined }))) written++;
    }
    daily.clear();
    const hires = parseSeries(products.rain.text.hires).stations;
    products.rain.text.hires = null;
    window.rainHires = spanOfRows([...hires.values()]);
    for (const [no, rows] of hires) {
      const cond = condenseHires(rows, { boundaryHour: p.boundaryHour, plausible: [0, Infinity] });
      written += upsertYears(join(out, 'rain', no), no, [...cond].map(([y, yr]) => [y, { y, imax: yr.max }]), ['mm', 'imax'], 'cov');
      if (outHires) written += upsertMonths(join(outHires, 'rain', no), no, toMonthShards(rows, p.hiresStep));
    }
    hires.clear();
  }

  // --- water temperature: daily mean/max, hourly series ---
  {
    const p = PRODUCTS.temp;
    const mean = parseSeries(products.temp.text.mean).stations;
    const max = parseSeries(products.temp.text.max).stations;
    products.temp.text.mean = products.temp.text.max = null;
    window.temp = spanOfRows([...mean.values(), ...max.values()]);
    for (const r of tables.temp) {
      const e = registry.get(r.station_no);
      const node = topo.gauges[r.station_no] || null;
      const years = new Map();
      foldDaily(mean.get(r.station_no) || [], { field: 'mean', plausible: PLAUSIBLE_TEMP_C, into: years });
      foldDaily(max.get(r.station_no) || [], { field: 'max', reduce: 'max', plausible: PLAUSIBLE_TEMP_C, into: years });
      const dir = join(out, 'temp', r.station_no);
      written += upsertYears(dir, r.station_no, years, ['mean', 'max']);
      if ([...years.values()].some(yr => yr.mean.some(v => v != null) || yr.max.some(v => v != null))) coverage.temp.bulk++;
      if (upsertMeta(dir, gaugeMeta(e, node, p, { src: 'bulk' }))) written++;
    }
    mean.clear(); max.clear();
    if (outHires) {
      const hires = parseSeries(products.temp.text.hires).stations;
      products.temp.text.hires = null;
      window.tempHires = spanOfRows([...hires.values()]);
      for (const [no, rows] of hires) {
        const clean = rows.filter(([, v]) => v != null && v >= PLAUSIBLE_TEMP_C[0] && v <= PLAUSIBLE_TEMP_C[1]);
        written += upsertMonths(join(outHires, 'temp', no), no, toMonthShards(clean, p.hiresStep));
      }
      hires.clear();
    }
  }

  // --- the run's paperwork ---
  const generated = now.toISOString().slice(0, 10);
  const regOut = {};
  for (const [no, e] of registry) regOut[no] = e;
  if (writeJson(join(out, 'registry.json'), { schema: SCHEMA, generated, stations: regOut })) written++;
  if (writeJson(join(out, 'topology.json'), { schema: SCHEMA, generated, basins: topo.basins, gauges: topo.gauges })) written++;
  const manifest = buildManifest({ out, registry, topo, basinOf, coverage, exportAt: summary.exportAt, window, generated, tier2 });
  if (writeJson(join(out, 'manifest.json'), manifest)) written++;
  if (writeText(join(out, 'README.md'), README)) written++;
  const runsPath = join(out, 'runs.json');
  const runs = (readJson(runsPath) || { runs: [] }).runs || [];
  const last = runs[runs.length - 1];
  if (written > 0 || !last || last.day !== generated) {
    runs.push({
      day: generated, at: now.toISOString(), sourceExportAt: summary.exportAt, mode: bulkOnly ? 'bulk' : 'bulk+station',
      written, window, coverage: manifest.coverage, tier2: tier2 ? { attempted: tier2.attempted, ok: tier2.ok, failed: tier2.failed, noIndex: tier2.noIndex } : null,
    });
    writeJson(runsPath, { schema: SCHEMA, runs: runs.slice(-RUNS_KEPT) });
    written++;
  }
  summary.written = written;
  summary.coverage = manifest.coverage;
  summary.counts = manifest.counts;
  summary.window = window;
  log(`nrw: export ${summary.exportAt}, ${written} files written, gauges ${manifest.counts.gauges}/${coverage.gauges.registry} `
    + `(bulk ${coverage.gauges.bulk}, station ${coverage.gauges.station}, no S ${coverage.gauges.noSeries}), rain ${manifest.counts.rain}, temp ${manifest.counts.temp}, basins ${manifest.counts.basins}`);
  return { registry, topo, manifest, summary };
}

export function uniqueBy(rows, keyOf) {
  const seen = new Set();
  return rows.filter(r => { const k = keyOf(r); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

// oldest and newest stamp across row lists — the delivered window
export function spanOfRows(rowLists) {
  let from = null, to = null;
  for (const rows of rowLists) {
    for (const [ts, v] of rows) {
      if (v == null) continue;
      if (!from || ts < from) from = ts;
      if (!to || ts > to) to = ts;
    }
  }
  return { from, to };
}

// ---------- CLI ----------

async function main() {
  const { opt, has } = parseArgs();
  const out = opt('out', 'nrw');
  const outHires = opt('out-hires', null);
  const maxYears = Number(opt('max-years', 0));
  const maxMonths = Number(opt('max-months', 0));
  if ((maxYears > 0 || maxMonths > 0) && !has('allow-prune')) {
    console.error('refusing: --max-years / --max-months delete data and need --allow-prune (the gate forbids deletions)');
    process.exit(2);
  }
  const r = await collect({
    out, outHires, raw: opt('raw', null), stationCache: opt('station-cache', null),
    bulkOnly: has('bulk-only'), dryRun: has('dry-run'),
  });
  if (!has('dry-run')) {
    if (maxYears > 0) console.log(`pruned ${pruneYears(out, maxYears, now)} year shard(s)`);
    if (maxMonths > 0 && outHires) console.log(`pruned ${pruneMonths(outHires, maxMonths, now)} month shard(s)`);
  }
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
