#!/usr/bin/env node
// One-off repair of the archive branch's closed.json bundles (issue #17): heals
// the Dec 31 that every ZIP request ending at `Y-12-31` flattened to its 00:00
// reading (min == max). requestEnd in fetch-wsv-archive.mjs stops NEW damage
// since 2026-08-21; this script repairs what was committed before. Measured on
// the branch 2026-09-24: 2143 selected closed years across 613 stations (2148
// flat Dec 31 in total; the other 5 are coarse gauges, see below) — every third
// year (the old 3-year chunk boundaries of the coastal gauges) plus nearly every
// station's 2025 (BONN 2025: 172/172).
//
// Per affected year ONE small ZIP request: Dec 30 through Jan 1 of the next
// year. Not the whole year, for two reasons:
//  - the coastal gauges measure every minute and would need nine 3-year chunks
//    each to be re-read in full — the same repair at a fraction of the load;
//  - only Dec 31 is touched. A whole-year extreme union would re-admit every
//    outlier WSV has corrected since the backfill (the reason freezeFromZip
//    lets the ZIP day win instead of merging).
// The window starts a day early so Dec 31 is complete whatever clock the
// endpoint reads `start` in; the Dec 30 bucket that comes back is ignored, and
// the Jan 1 sliver never leaves this file. The fetched day is merged with
// mergeYear's extreme union, so the midnight reading the flat day already
// holds can never be lost.
//
// Which years: Dec 31 min == max, both non-null, and at least one other day of
// the same year showing a real span — a coarse gauge that reports flat days all
// year is not flattened by the request window, and refetching it would change
// nothing. Resumable by construction: a healed year no longer matches, so a
// re-run (or a run stopped by --budget-minutes) continues where it left off,
// and an already-good year is never requested, let alone rewritten. The one
// exception: a year whose Dec 31 really WAS flat (~59 of the 2143 sit in a
// mostly flat December) stays selected and is asked again on every re-run —
// a few dozen wasted requests, not a loop. Stations
// written by a sibling adapter (meta.source, e.g. Rijkswaterstaat) are skipped:
// their uuid means nothing to the WSV endpoint.
//
// Usage:
//   node scripts/heal-dec31.mjs --out archive-branch/archive --dry-run   # count, no network
//   node scripts/heal-dec31.mjs --out archive-branch/archive --station BONN
//   node scripts/heal-dec31.mjs --out archive-branch/archive --parallel 2 --budget-minutes 240
//   (--budget-minutes 0 or absent = no deadline; the run exits 1 when >= 10% of
//   the requested years failed — see reportRunOutcome — while every year healed
//   before that is already written)
//
// Runs in CI via .github/workflows/archive-heal.yml (workflow_dispatch only).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fetchRawRange, condense, mergeYear, requestEnd, daysInYear, reportRunOutcome,
} from './fetch-wsv-archive.mjs';
import { parseArgs, readJson, writeJson, listDirs, sleep } from './lib/cli.mjs';

const THROTTLE_MS = 1500; // same politeness as fetch-wsv-archive.mjs

// the years of one closed.json bundle whose Dec 31 is the flattened midnight
// reading (see the header for why coarse gauges are left out)
export function flattenedYears(closed) {
  const out = [];
  for (const yr of Array.isArray(closed) ? closed : []) {
    const n = daysInYear(yr.y);
    if (!Array.isArray(yr.min) || !Array.isArray(yr.max) || yr.min.length !== n || yr.max.length !== n) continue;
    const lo = yr.min[n - 1], hi = yr.max[n - 1];
    if (lo == null || hi == null || lo !== hi) continue;
    let spans = false;
    for (let d = 0; d < n - 1 && !spans; d++) spans = yr.min[d] != null && yr.max[d] != null && yr.max[d] > yr.min[d];
    if (spans) out.push(yr.y);
  }
  return out;
}

// Dec 31 of year y from the ZIP archive: {min, max}, or null when the answer
// holds no reading for that day
export async function fetchDec31(uuid, y, fetchRange = fetchRawRange) {
  const zy = condense(await fetchRange(uuid, `${y}-12-30`, requestEnd(y))).get(y);
  const n = daysInYear(y);
  if (!zy || zy.min[n - 1] == null) return null;
  return { min: zy.min[n - 1], max: zy.max[n - 1] };
}

// Heals one station directory in place. closed.json is rewritten only when a
// day actually changed, and then only that day differs. Per-year failures are
// counted, not thrown: the years healed before them are kept.
export async function healStation(dir, uuid, { fetchRange = fetchRawRange, throttleMs = THROTTLE_MS, deadline = Infinity, log = () => {} } = {}) {
  const r = { targets: 0, fetched: 0, healed: 0, failed: 0, stopped: false };
  const closedPath = join(dir, 'closed.json');
  const closed = readJson(closedPath);
  const years = flattenedYears(closed);
  r.targets = years.length;
  for (const y of years) {
    if (Date.now() >= deadline) { r.stopped = true; break; }
    try {
      const day = await fetchDec31(uuid, y, fetchRange);
      // this year HAS a Dec 31 reading (the flat one) — an answer without it
      // is the endpoint failing, not the gauge being silent
      if (!day) throw new Error('no Dec 31 reading in the answer');
      r.fetched++;
      const i = closed.findIndex(yr => yr.y === y);
      const yr = closed[i], n = yr.min.length;
      const data = { min: Array(n).fill(null), max: Array(n).fill(null) };
      data.min[n - 1] = day.min; data.max[n - 1] = day.max;
      const merged = mergeYear(yr, y, data);
      if (merged.min[n - 1] !== yr.min[n - 1] || merged.max[n - 1] !== yr.max[n - 1]) {
        log(`  ${y}-12-31: ${yr.min[n - 1]}/${yr.max[n - 1]} -> ${merged.min[n - 1]}/${merged.max[n - 1]}`);
        closed[i] = merged;
        r.healed++;
      }
    } catch (e) {
      log(`  ${y}: FAILED: ${e.message}`);
      r.failed++;
    }
    if (throttleMs) await sleep(throttleMs);
  }
  if (r.healed) writeJson(closedPath, closed);
  return r;
}

// importable as a module (tests): the CLI part only runs when invoked directly
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();

async function main() {
  const { opt, has, args } = parseArgs();
  const KNOWN = new Set(['out', 'station', 'parallel', 'budget-minutes', 'dry-run']);
  for (const a of args) {
    if (a.startsWith('--') && !KNOWN.has(a.slice(2))) {
      console.error(`unknown flag ${a} — known are ${[...KNOWN].map(k => '--' + k).join(', ')}`);
      process.exit(2);
    }
  }
  const OUT = opt('out', 'archive');
  const ONLY = (opt('station', '') || '').toUpperCase();
  // validated, not coerced: `--parallel two` used to become NaN, i.e. ZERO
  // workers and a green run that healed nothing (reviewer, reproduced)
  const PARALLEL = Number(opt('parallel', 1));
  const budget = Number(opt('budget-minutes', 0)); // 0 = no deadline
  const bad = [];
  if (!Number.isInteger(PARALLEL) || PARALLEL < 1) bad.push(`--parallel ${opt('parallel', '')}: want an integer >= 1`);
  if (!Number.isFinite(budget) || budget < 0) bad.push(`--budget-minutes ${opt('budget-minutes', '')}: want minutes >= 0`);
  if (has('station') && !ONLY) bad.push('--station needs a name or uuid');
  if (bad.length) { console.error(bad.join('\n')); process.exit(2); }
  const deadline = budget > 0 ? Date.now() + budget * 6e4 : Infinity;

  const dirs = listDirs(OUT);
  if (!dirs.length) {
    console.error(`no station directories under ${OUT}`);
    process.exit(1);
  }
  const stations = [];
  let matched = 0;
  for (const uuid of dirs) {
    const meta = readJson(join(OUT, uuid, 'meta.json')) || {};
    if (meta.source) continue; // not a WSV gauge
    if (ONLY && (meta.name || '').toUpperCase() !== ONLY && uuid !== ONLY.toLowerCase()) continue;
    matched++;
    const n = flattenedYears(readJson(join(OUT, uuid, 'closed.json'))).length;
    if (n) stations.push({ uuid, name: meta.name || uuid, n });
  }
  // a typo in a probe run must not read like "nothing left to heal"
  if (ONLY && !matched) {
    console.error(`--station ${ONLY}: no WSV station of that name or uuid under ${OUT}`);
    process.exit(1);
  }
  const total = stations.reduce((s, x) => s + x.n, 0);
  console.log(`${total} flattened Dec 31 across ${stations.length} station(s) · out: ${OUT}/ · ${PARALLEL} worker(s)`
    + (budget > 0 ? ` · budget ${budget} min` : ''));
  if (has('dry-run')) return;

  let fetched = 0, healed = 0, failed = 0, stopped = false, cursor = 0;
  async function worker(w) {
    await sleep(w * 2000); // staggered starts, as in fetch-wsv-archive.mjs
    while (cursor < stations.length && !stopped) {
      const i = cursor++;
      const s = stations[i];
      const lines = [];
      const r = await healStation(join(OUT, s.uuid), s.uuid, { deadline, log: l => lines.push(l) });
      console.log(`[${i + 1}/${stations.length}] ${s.name} · ${r.fetched}/${r.targets} fetched · ${r.healed} healed`
        + (r.failed ? ` · ${r.failed} failed` : '') + (lines.length ? '\n' + lines.join('\n') : ''));
      fetched += r.fetched; healed += r.healed; failed += r.failed;
      if (r.stopped) stopped = true;
      await sleep(Math.random() * 500);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, (_, w) => worker(w)));
  console.log(`done · ${healed} Dec 31 healed · ${fetched} fetched · ${failed} failed`
    + (stopped ? ` · stopped at the ${budget}-minute budget — re-run to continue` : ''));
  // counted per requested YEAR, not per station
  reportRunOutcome('Dec-31 heal (years)', fetched, failed);
}
