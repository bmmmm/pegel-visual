#!/usr/bin/env node
// Weekly 15-minute collector for the short-horizon forecast gate.
//
// The daily archive keeps day extremes only — condense() in fetch-wsv-archive.mjs
// throws the 15-minute readings away on arrival — so a short-horizon forecast
// (hours to two days) cannot be judged on anything the repo stores today. One
// ?start=P35D request returns ~31 days of 15-minute readings (~2976 points; the
// server clamps P35D silently, see fetchCurrentViaRest). A backtest window eats
// 1024 context + 192 horizon steps, so one fetch yields ~9 independent origins
// per station and the short gate needs 60 per station. Hence a weekly run,
// merged idempotently by timestamp, for roughly 16 weeks before gate.py can say
// anything but PROVISIONAL.
//
// Output: <out>/<uuid>.json
//   { name, updated, runs: [{ at, fetched, added }...], points: [[isoUtc, value], ...] }
// under tmp-forecast/hires/ (gitignored) — never under archive/: that bundle
// has a published contract and check-archive-consistency.mjs guards it.
//
//   node scripts/forecast/collect-hires.mjs [--out tmp-forecast/hires] [--stations uuid,uuid]
//
// Sandbox note: Node's fetch ignores HTTP_PROXY, so a manual run from a sandboxed
// session needs the bypass; launchd runs it unsandboxed (collect-hires.sh).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAUSIBLE_MAX_CM, PLAUSIBLE_MIN_CM } from '../fetch-wsv-archive.mjs';

const API = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STEP_MS = 15 * 60 * 1000;

// mirrors COLLECTED in scripts/forecast/stations.py: the measured set, the
// delivered set and the upstream reference (MAXAU for KÖLN). By UUID, never by
// name — `KOBLENZ` is the Rhine gauge; the Mosel has a `Koblenz UP` that is not
// even a cm gauge.
export const STATIONS = {
  'a6ee8177-107b-47dd-bcfd-30960ccc6e9c': 'KÖLN',
  '593647aa-9fea-43ec-a7d6-6476a76ae868': 'BONN',
  '4c7d796a-39f2-4f26-97a9-3aad01713e29': 'KOBLENZ',
  '70272185-b2b3-4178-96b8-43bea330dcae': 'DRESDEN',
  '33ceb441-23bc-4ca6-9fcd-ac35d41ef117': 'PASSAU ILZSTADT',
  'fe72ee98-88e9-4d19-aba1-f97f61b7d4de': 'FREMERSDORF',
  'aad49293-242a-43ad-a8b1-e91d7792c4b2': 'CUXHAVEN STEUBENHÖFT',
  'b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea': 'MAXAU',
};

// raw REST measurements -> sorted, de-duplicated [isoUtc, value] pairs; sentinels
// and unparsable stamps dropped, a repeated stamp keeps the LAST reading
export function normalize(measurements) {
  const byTs = new Map();
  for (const m of measurements || []) {
    const t = Date.parse(m && m.timestamp);
    const v = m && m.value;
    if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < PLAUSIBLE_MIN_CM || v > PLAUSIBLE_MAX_CM) continue; // sentinel, not water
    byTs.set(new Date(t).toISOString(), v);
  }
  return [...byTs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// idempotent union by timestamp; a fresh reading for a known stamp wins (WSV
// occasionally revises the last hours), order stays chronological
export function merge(existing, fresh) {
  const byTs = new Map(existing || []);
  for (const [ts, v] of fresh || []) byTs.set(ts, v);
  return [...byTs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// how many holes wider than one step the series has — the collector's own
// health line, so a silently thinning feed shows up in the log, not in 16 weeks
export function gapCount(points, stepMs = STEP_MS) {
  let gaps = 0;
  for (let i = 1; i < points.length; i++) {
    if (Date.parse(points[i][0]) - Date.parse(points[i - 1][0]) > stepMs) gaps++;
  }
  return gaps;
}

export function readDoc(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export async function collectStation(uuid, { out, fetchImpl = fetch, now = new Date() } = {}) {
  const url = `${API}/stations/${uuid}/W/measurements.json?start=P35D`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${STATIONS[uuid] || uuid}`);
  const fresh = normalize(await res.json());
  const path = join(out, `${uuid}.json`);
  const prev = readDoc(path);
  const before = prev && Array.isArray(prev.points) ? prev.points : [];
  const points = merge(before, fresh);
  const run = { at: now.toISOString(), fetched: fresh.length, added: points.length - before.length };
  const doc = {
    name: STATIONS[uuid] || (prev && prev.name) || uuid,
    updated: now.toISOString(),
    runs: [...((prev && prev.runs) || []), run].slice(-60),
    points,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(path, JSON.stringify(doc));
  return { uuid, name: doc.name, ...run, total: points.length, gaps: gapCount(points) };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const out = opt('out', join(REPO, 'tmp-forecast', 'hires'));
  const uuids = opt('stations', null) ? opt('stations').split(',') : Object.keys(STATIONS);
  let ok = 0;
  let failed = 0;
  let total = 0;
  for (const uuid of uuids) {
    try {
      const r = await collectStation(uuid, { out });
      total += r.total;
      ok++;
      console.log(`${r.name}: fetched ${r.fetched}, added ${r.added}, total ${r.total}, gaps ${r.gaps}`);
    } catch (e) {
      failed++;
      console.error(`${STATIONS[uuid] || uuid}: ${e.message}`);
    }
  }
  console.log(`done · ${ok} stations · ${total} points on disk · ${failed} failed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
}
