#!/usr/bin/env node
// Aggregates the per-station archive into river-level daily totals for the
// ?total view ("Summe der Pegelstände"): for every day, the summed daily mid
// value ((min+max)/2, cm) of all reporting gauges, grouped by river. This is a
// transparent gauge-reading sum, not a hydrological volume — gauge zeros are
// arbitrary datums — and the client labels it as such.
//
//   archive/totals/overview.json   { generated, fromYear, months, currentYear,
//                                    excludedStations,
//                                    rivers: { RHEIN: [cm|null per month], ... } }
//                                  every river, monthly grain: MEAN of the
//                                  month's daily sums, so bar heights compare
//                                  across zoom levels (a 28-day February is not
//                                  systematically shorter than a 31-day March)
//   archive/totals/<year>.json     { y, generated, provisionalFrom?,
//                                    rivers: { RHEIN: { v: [cm|null per day],
//                                                       n: [gauges|null] }, ... } }
//                                  every river, daily grain, for the day drilldown
//   archive/totals/units.json      { generated, units: {uuid: unit}, excluded: [uuid] }
//                                  sidecar persisting each station's live-API unit
//
// The unit sidecar exists because the archive itself never records units: 68
// gauges report metres of absolute elevation (m+NN / m+PNP — reservoirs,
// barrages), stored indistinguishably from cm values. Summing those raw would
// corrupt the totals, so every station whose unit is not exactly 'cm' is
// excluded (unknown unit = excluded, fail closed). --fetch-units refreshes the
// sidecar from the live bulk feed; stations that vanished from the live feed
// keep their last known unit, so decommissioned gauges' history still counts.
//
// Sums are float-accumulated and rounded once per day (never round-then-sum).
// v null = no gauge of that river reported that day (n is null too). Day
// boundaries are MEZ/UTC+1 like every other archive file. For the running year
// the monthly-refreshed current.json mid is preferred; days it does not cover
// yet fall back to the daily snapshot's point-in-time value (provisional —
// `provisionalFrom` marks the first such day, cured by the next --rebuild).
//
// Usage (CI passes the archive-branch checkout, see archive-update.yml /
// snapshot-update.yml; the seed is simply the first monthly rebuild):
//   node scripts/build-river-totals.mjs --rebuild --archive archive-branch/archive \
//        --out archive-branch/archive/totals --fetch-units
//   node scripts/build-river-totals.mjs --append --archive archive-branch/archive \
//        --out archive-branch/archive/totals
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { daysInYear } from './fetch-wsv-archive.mjs';
import { daysInMonth, shardName } from './snapshot-wsv.mjs';

const API = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2';
// PEGEL_NOW pins the clock for tests and deterministic rebuilds
const now = process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);

const OUT = opt('out', 'archive/totals');
const ARCHIVE_DIR = opt('archive', join(OUT, '..'));

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// anything that is not literally centimetres is excluded — m+NN / m+PNP are
// absolute elevations, and an unknown unit could be either, so it fails closed
export const isExcludedUnit = unit => unit !== 'cm';

export const midOf = (min, max) => min != null && max != null ? (min + max) / 2 : null;

export const dayOfYear = (y, m, d) => Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5);

// same W-timeseries walk as snapshot-wsv.mjs' parseBulkForSnapshot — the unit
// rides on the W timeseries object of the bulk feed
export function parseLiveUnits(raw) {
  return raw
    .map(s => ({ s, w: (s.timeseries || []).find(t => t.shortname === 'W') }))
    .filter(({ w }) => w)
    .map(({ s, w }) => ({ uuid: s.uuid, unit: w.unit ?? null }));
}

// fresh entries overwrite, absent stations keep their last known unit — a
// decommissioned gauge's historical values still need their classification
export function mergeUnitsDoc(prevDoc, freshUnits, nowIso) {
  const units = { ...((prevDoc && prevDoc.units) || {}) };
  for (const { uuid, unit } of freshUnits) if (unit != null) units[uuid] = unit;
  const excluded = Object.keys(units).filter(u => isExcludedUnit(units[u])).sort();
  return { generated: nowIso, units, excluded };
}

// one station's float daily mids for one year: archived min/max mid first,
// then (running year only) the daily snapshot's point value for days the
// monthly refresh has not covered yet. Returns the first snapshot-sourced day
// index, or null when nothing was provisional.
export function stationYearMids(bundle, year, shardsByMonth, uuid) {
  const n = daysInYear(year);
  const mid = Array(n).fill(null);
  if (bundle && bundle.y === year && Array.isArray(bundle.min)) {
    for (let d = 0; d < n && d < bundle.min.length; d++) mid[d] = midOf(bundle.min[d], bundle.max[d]);
  }
  let provisionalFrom = null;
  if (shardsByMonth) {
    for (const [m, shard] of shardsByMonth) {
      const st = shard.stations && shard.stations[uuid];
      if (!st || !Array.isArray(st.v)) continue;
      const start = dayOfYear(year, m, 1);
      for (let i = 0; i < st.v.length; i++) {
        if (st.v[i] == null || mid[start + i] != null) continue;
        mid[start + i] = st.v[i];
        if (provisionalFrom == null || start + i < provisionalFrom) provisionalFrom = start + i;
      }
    }
  }
  return { mid, provisionalFrom };
}

export function loadSnapshotShards(snapshotsDir, year) {
  const shards = new Map();
  for (let m = 1; m <= 12; m++) {
    const shard = readJson(join(snapshotsDir, shardName(year, m)));
    if (shard && shard.y === year) shards.set(m, shard);
  }
  return shards;
}

// core pass: fold every included station's daily mids into per-year per-river
// float accumulators. Stations are visited in sorted-uuid order and rivers are
// written sorted, so a rebuild against identical input is byte-identical.
export function accumulateTotals({ manifest, unitsDoc, archiveDir, currentYear, shardsByMonth, onlyCurrentYear = false }) {
  const byYear = new Map(); // y -> Map(river -> {sumF:[], n:[]})
  let provisionalFrom = null;
  let included = 0, excluded = 0, unattributed = 0;
  for (const uuid of Object.keys(manifest.stations).sort()) {
    const entry = manifest.stations[uuid];
    if (isExcludedUnit(unitsDoc.units[uuid])) { excluded++; continue; }
    const river = entry.w || '';
    if (!river) { unattributed++; continue; }
    const bundles = [];
    if (!onlyCurrentYear) for (const b of readJson(join(archiveDir, uuid, 'closed.json')) || []) bundles.push(b);
    const current = readJson(join(archiveDir, uuid, 'current.json'));
    if (current) bundles.push(current);
    const byBundleYear = new Map(bundles.filter(b => b && Array.isArray(b.min)).map(b => [b.y, b]));
    const years = onlyCurrentYear ? [currentYear] : [...new Set([...byBundleYear.keys(), currentYear])];
    let contributed = false;
    for (const y of years) {
      const { mid, provisionalFrom: pf } = stationYearMids(
        byBundleYear.get(y), y, y === currentYear ? shardsByMonth : null, uuid);
      if (pf != null) provisionalFrom = provisionalFrom == null ? pf : Math.min(provisionalFrom, pf);
      let yr = null, acc = null;
      for (let d = 0; d < mid.length; d++) {
        if (mid[d] == null) continue;
        if (!acc) {
          yr = byYear.get(y) || byYear.set(y, new Map()).get(y);
          acc = yr.get(river) || yr.set(river, {
            sumF: Array(mid.length).fill(0), n: Array(mid.length).fill(0),
          }).get(river);
        }
        acc.sumF[d] += mid[d];
        acc.n[d]++;
        contributed = true;
      }
    }
    if (contributed) included++;
  }
  return { byYear, provisionalFrom, included, excluded, unattributed };
}

// year-file JSON: round the float sums once, null where no gauge reported
export function finalizeYear(y, yearAcc, provisionalFrom, nowIso) {
  const rivers = {};
  for (const river of [...yearAcc.keys()].sort()) {
    const { sumF, n } = yearAcc.get(river);
    rivers[river] = {
      v: sumF.map((s, d) => n[d] ? Math.round(s) : null),
      n: n.map(c => c || null),
    };
  }
  const out = { y, generated: nowIso };
  if (provisionalFrom != null) out.provisionalFrom = provisionalFrom;
  out.rivers = rivers;
  return out;
}

// monthly grain = MEAN of the month's daily sums (comparable across month
// lengths and across zoom levels), computed from the float accumulators so
// rounding happens exactly once
export function buildOverview(byYear, currentYear, excludedStations, nowIso) {
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const fromYear = years.length ? years[0] : currentYear;
  const months = (currentYear - fromYear + 1) * 12;
  const names = [...new Set(years.flatMap(y => [...byYear.get(y).keys()]))].sort();
  const rivers = {};
  for (const name of names) rivers[name] = Array(months).fill(null);
  for (const y of years) {
    for (const [name, { sumF, n }] of byYear.get(y)) {
      for (let m = 1; m <= 12; m++) {
        const start = dayOfYear(y, m, 1);
        let sum = 0, cnt = 0;
        for (let d = start; d < start + daysInMonth(y, m); d++) {
          if (n[d]) { sum += sumF[d]; cnt++; }
        }
        if (cnt) rivers[name][(y - fromYear) * 12 + (m - 1)] = Math.round(sum / cnt);
      }
    }
  }
  return { generated: nowIso, fromYear, months, currentYear, excludedStations, rivers };
}

async function fetchLiveUnits() {
  const res = await fetch(`${API}/stations.json?includeTimeseries=true`,
    { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('bulk stations HTTP ' + res.status);
  return parseLiveUnits(await res.json());
}

export function rebuildAll({ archiveDir, outDir, unitsDoc, nowDate }) {
  const manifest = readJson(join(archiveDir, 'manifest.json'));
  if (!manifest) throw new Error(`no manifest.json under ${archiveDir}`);
  const currentYear = nowDate.getUTCFullYear();
  const shardsByMonth = loadSnapshotShards(join(archiveDir, 'snapshots'), currentYear);
  const nowIso = nowDate.toISOString();
  const { byYear, provisionalFrom, included, excluded, unattributed } =
    accumulateTotals({ manifest, unitsDoc, archiveDir, currentYear, shardsByMonth });

  mkdirSync(outDir, { recursive: true });
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    const yearFile = finalizeYear(y, byYear.get(y), y === currentYear ? provisionalFrom : null, nowIso);
    writeFileSync(join(outDir, `${y}.json`), JSON.stringify(yearFile));
  }
  const overview = buildOverview(byYear, currentYear, excluded, nowIso);
  writeFileSync(join(outDir, 'overview.json'), JSON.stringify(overview));
  writeFileSync(join(outDir, 'units.json'), JSON.stringify(unitsDoc));
  return { overview, years: [...byYear.keys()].sort((a, b) => a - b), included, excluded, unattributed };
}

// cheap daily path: recompute only the running year (current.json + snapshots,
// no closed.json scan) and patch its months into the stored overview. Falls
// back to a full rebuild when no overview exists yet.
export function appendCurrent({ archiveDir, outDir, unitsDoc, nowDate }) {
  const overview = readJson(join(outDir, 'overview.json'));
  if (!overview) return rebuildAll({ archiveDir, outDir, unitsDoc, nowDate });
  const manifest = readJson(join(archiveDir, 'manifest.json'));
  if (!manifest) throw new Error(`no manifest.json under ${archiveDir}`);
  const currentYear = nowDate.getUTCFullYear();
  const shardsByMonth = loadSnapshotShards(join(archiveDir, 'snapshots'), currentYear);
  const nowIso = nowDate.toISOString();
  const { byYear, provisionalFrom, included, excluded, unattributed } = accumulateTotals({
    manifest, unitsDoc, archiveDir, currentYear, shardsByMonth, onlyCurrentYear: true,
  });

  const yearAcc = byYear.get(currentYear) || new Map();
  writeFileSync(join(outDir, `${currentYear}.json`),
    JSON.stringify(finalizeYear(currentYear, yearAcc, provisionalFrom, nowIso)));

  // patch: extend every series to cover the (possibly rolled-over) year, then
  // overwrite just the running year's twelve monthly cells
  const months = (currentYear - overview.fromYear + 1) * 12;
  for (const name of Object.keys(overview.rivers)) {
    while (overview.rivers[name].length < months) overview.rivers[name].push(null);
  }
  const patch = buildOverview(byYear, currentYear, excluded, nowIso);
  const base = (currentYear - overview.fromYear) * 12;
  const patchBase = (currentYear - patch.fromYear) * 12;
  // clear first: a river that lost its last reporting gauge this year must not
  // keep stale monthly cells from the previous append
  for (const name of Object.keys(overview.rivers)) {
    for (let m = 0; m < 12; m++) overview.rivers[name][base + m] = null;
  }
  for (const name of Object.keys(patch.rivers)) {
    if (!overview.rivers[name]) overview.rivers[name] = Array(months).fill(null);
    for (let m = 0; m < 12; m++) overview.rivers[name][base + m] = patch.rivers[name][patchBase + m];
  }
  overview.generated = nowIso;
  overview.months = months;
  overview.currentYear = currentYear;
  overview.excludedStations = excluded;
  writeFileSync(join(outDir, 'overview.json'), JSON.stringify(overview));
  return { overview, years: [currentYear], included, excluded, unattributed };
}

async function main() {
  const rebuild = has('rebuild'), append = has('append');
  if (rebuild === append) throw new Error('pass exactly one of --rebuild / --append');

  let unitsDoc = readJson(join(OUT, 'units.json'));
  if (has('fetch-units')) {
    unitsDoc = mergeUnitsDoc(unitsDoc, await fetchLiveUnits(), now.toISOString());
  } else if (!unitsDoc) {
    if (append) {
      // pre-seed window: the daily append runs before the first monthly
      // rebuild has persisted the unit sidecar — skip quietly, stay green
      console.log(`${join(OUT, 'units.json')} missing — totals not seeded yet, skipping append`);
      return;
    }
    throw new Error(`${join(OUT, 'units.json')} missing — run once with --fetch-units`);
  }

  const run = rebuild ? rebuildAll : appendCurrent;
  const { overview, years, included, excluded, unattributed } =
    run({ archiveDir: ARCHIVE_DIR, outDir: OUT, unitsDoc, nowDate: now });
  console.log(`${rebuild ? 'rebuilt' : 'appended'} totals: ${Object.keys(overview.rivers).length} rivers, `
    + `years ${years[0]}..${years[years.length - 1]}, ${included} stations in, `
    + `${excluded} excluded (non-cm unit), ${unattributed} without a water name`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
