#!/usr/bin/env node
// Content-level consistency gate for the `archive` data branch, run by
// snapshot-update.yml and archive-update.yml after the build steps and before
// the push. The 2026-08-23 force-push incident stayed invisible for three
// days because every run was green while the month shard had lost its recent
// days (reset base) and totals/ was missing entirely — build-river-totals
// --append skips silently without units.json and silently rebuilds without
// overview.json, and data-freshness.yml only checks commit age. This gate
// checks the data itself:
//
//   R1 recency        latest captured snapshot day lags today (MEZ) by <= 2
//                     days — catches a reset base whose shard is internally
//                     valid but weeks behind (self-healing, no "yesterday
//                     must exist" ratchet that would stay red forever)
//   R2 totals alive   totals/{overview,units,<currentYear>}.json exist and
//                     parse, and overview.generated is <= 6h old — proves the
//                     append/rebuild really ran in THIS pass
//   R3 coverage       stations reporting on the latest day >= max(400,
//                     0.9 * median of the preceding non-null days)
//   R4 regression     vs. git HEAD as the baseline: nothing deleted or
//                     renamed, captured snapshot days and stations never
//                     vanish, current.json slots never go non-null -> null,
//                     closed.json year sets only grow (the January freeze is
//                     irreversible)
//   R5 shapes         changed JSONs parse; shard days/station arrays sized to
//                     the month, current.json arrays to the year; manifest
//                     >= 700 stations, overview >= 80 rivers
//   R6 running year   across the stations with pre-running-year history, the
//                     running current.json starts in the first week of the
//                     year, still reaches the last few days, and holds few
//                     null days in between — the rule that would have caught
//                     Jan-Jul 2026 sitting empty in every file for half a year
//                     while R1-R5 stayed green. Opt out with --skip R6.
//   R7 no-archive     the manifest still marks the gauges WSV keeps no archive
//                     for. The marker used to be derived from the file listing,
//                     so the weekly REST refresh erased it by succeeding — 0 of
//                     739 marked, and the client caveat that depends on it dead
//                     site-wide. Opt out with --skip R7 (same reason as R6).
//
// Deliberate limits: the diff part (R4/R5) compares against the branch's own
// HEAD, so a base poisoned by a force-push looks clean to it — branch
// protection plus R1/R2 stand against that. Value plausibility (is 99999 cm
// water?) stays out of scope here; see the open "snapshot plausibility gate"
// idea and the sentinel filters in the fetchers.
//
//   node scripts/check-archive-consistency.mjs --tree archive-branch/archive --git archive-branch
//
// PEGEL_NOW pins the clock (same convention as the other scripts) — required
// for green runs against a checkout whose last CI run is hours in the past.
// Violations print as ::error:: lines and the process exits 1.
import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { daysInYear } from './fetch-wsv-archive.mjs';
import { daysInMonth, mezParts, shardName } from './snapshot-wsv.mjs';

const now = process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
// --skip R6[,R…]: for a caller that cannot act on a rule's finding (see R6)
const SKIP = new Set(opt('skip', '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

// absolute day number of a shard slot — comparable across month boundaries
export const dayNum = (y, m, dayIdx) => Date.UTC(y, m - 1, dayIdx + 1) / 864e5;

const isoDay = (y, m, dayIdx) =>
  `${y}-${String(m).padStart(2, '0')}-${String(dayIdx + 1).padStart(2, '0')}`;

// flatten shards into the chronological list of captured days, each with its
// reporting-station count — the shared substrate of R1 and R3
export function capturedDays(shards) {
  const out = [];
  for (const shard of shards) {
    if (!shard || !Array.isArray(shard.days)) continue;
    for (let i = 0; i < shard.days.length; i++) {
      if (shard.days[i] == null) continue;
      let count = 0;
      for (const st of Object.values(shard.stations || {})) {
        if (Array.isArray(st.v) && st.v[i] != null) count++;
      }
      out.push({ num: dayNum(shard.y, shard.m, i), day: isoDay(shard.y, shard.m, i), count });
    }
  }
  return out.sort((a, b) => a.num - b.num);
}

// R1 — the latest captured day must be at most maxLagDays behind today (MEZ)
export function checkRecency(days, nowDate, maxLagDays = 2) {
  if (!days.length) return ['R1: no captured snapshot day in the current or previous month shard'];
  const mez = mezParts(nowDate);
  const lag = dayNum(mez.y, mez.m, mez.dayIdx) - days[days.length - 1].num;
  return lag > maxLagDays
    ? [`R1: latest snapshot day is ${days[days.length - 1].day}, ${lag} days behind today — reset base or stalled captures`]
    : [];
}

// R2 — the totals really rebuilt in this pass (the silent-skip paths leave an
// old or missing overview.generated behind)
export function checkTotalsLiveness({ overview, units, yearTotals, currentYear, nowDate, maxAgeHours = 6 }) {
  const v = [];
  if (!units || typeof units.units !== 'object') {
    v.push('R2: totals/units.json missing or unparseable — the daily append silently skips without it');
  }
  if (!yearTotals || yearTotals.y !== currentYear) {
    v.push(`R2: totals/${currentYear}.json missing, unparseable or for the wrong year`);
  }
  if (!overview) {
    v.push('R2: totals/overview.json missing or unparseable');
    return v;
  }
  const gen = Date.parse(overview.generated ?? '');
  if (!Number.isFinite(gen)) {
    v.push('R2: totals/overview.json has no parseable generated timestamp');
  } else {
    const ageH = (nowDate.getTime() - gen) / 36e5;
    if (ageH > maxAgeHours) {
      v.push(`R2: totals/overview.json generated ${overview.generated} is ${ageH.toFixed(1)}h old (max ${maxAgeHours}h) — the totals build did not run in this pass`);
    }
  }
  return v;
}

// R3 — station coverage on the latest day, measured against the median of the
// up to `window` captured days before it (the median shrugs off single dips;
// the 400 floor guards the very first days when no baseline exists yet)
export function checkCoverage(days, { minStations = 400, ratio = 0.9, window = 7 } = {}) {
  if (!days.length) return []; // R1 already flags the empty archive
  const latest = days[days.length - 1];
  const prior = days.slice(0, -1).slice(-window).map(d => d.count).sort((a, b) => a - b);
  const median = prior.length ? prior[Math.floor(prior.length / 2)] : 0;
  const threshold = Math.max(minStations, Math.ceil(ratio * median));
  return latest.count < threshold
    ? [`R3: only ${latest.count} stations reported on ${latest.day} (threshold ${threshold}, median of ${prior.length} prior days ${median})`]
    : [];
}

// day index of a date inside its own year — the coordinate current.json uses
const dayOfYear = d => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5);

// R6 — the running year is continuous, across the whole fleet at once.
//
// R1/R3 watch the SNAPSHOTS and R4 only forbids regressions against HEAD, so
// nothing ever asked whether current.json actually covers the year. It did not:
// on 2026-09-03 the running year of every WSV station began on 2026-07-10,
// half a year after Jan 1, because two cancelled runs had torn a hole the
// REST refresh's ~31-day window could never reach back over. 628 candidates,
// 10 of them continuous — the ten Rijkswaterstaat gauges a different adapter
// feeds. Everything below is measured on that fleet, not on one station: a
// single gauge may legitimately go dark for a month.
//
// `entries` are the manifest's stations that have pre-running-year history,
// each with its parsed current.json (or null). The candidates are the ones
// whose file is actually there and names the running year.
//
// The thresholds are calibrated on a year that is complete and validated:
// closed.json for 2025, a random 120 of the 628 candidates sampled 2026-09-03.
// 118/120 started inside the first week (the stragglers: first readings on day
// 34 and day 125), 118/120 kept their inner null days at or below 21 (the
// worst two: 39 and 22), and 119/120 ran to Dec 31. Two failures in 120 puts
// the 95% interval at roughly 0.2%..5.9%, so minShare 0.9 sits clear of the
// upper end rather than of the point estimate. The broken state scored 1.6%.
export function checkRunningYearContinuity(entries, {
  year, nowDate, minCandidates = 400, minShare = 0.9, maxHoles = 21, startBy = 7, maxLag = 10,
} = {}) {
  // In the first days of a year there is nothing to be continuous with: the
  // January freeze graduates the completed year and leaves current.json absent
  // until the next refresh writes the new one.
  if (nowDate.getUTCFullYear() === year && dayOfYear(nowDate) < 14) return [];
  const cands = entries.filter(e => e.cur && e.cur.y === year && Array.isArray(e.cur.min));
  if (cands.length < minCandidates) {
    return [`R6: only ${cands.length} stations carry a ${year} current.json (min ${minCandidates}) `
      + '— the running-year check must never pass on an empty input'];
  }
  const measured = cands.map(e => {
    const min = e.cur.min;
    let first = -1, last = -1;
    for (let i = 0; i < min.length; i++) if (min[i] != null) { if (first < 0) first = i; last = i; }
    if (first < 0) return { first: Infinity, last: -Infinity, holes: Infinity };
    let holes = 0;
    for (let i = first; i <= last; i++) if (min[i] == null) holes++;
    // a trailing edge is not a hole of its own: a decommissioned gauge simply
    // stops. Whether the FLEET's edge keeps up is the separate check below.
    return { first, last, holes };
  });
  const v = [];
  const share = p => measured.filter(p).length / measured.length;
  const pct = x => (x * 100).toFixed(1);
  const floor = `min ${(minShare * 100).toFixed(0)}%`;
  const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const startShare = share(m => m.first <= startBy);
  if (startShare < minShare) {
    v.push(`R6: only ${pct(startShare)}% of ${measured.length} stations have ${year} data `
      + `from day ${startBy + 1} on (${floor}), median first day `
      + `${median(measured.map(m => m.first)) + 1} — the running year is not being backfilled`);
  }
  // The leading edge alone would have caught the 2026 incident and nothing
  // else: a cron that simply STOPS leaves every file starting on Jan 1 and
  // ending months ago, which the start check calls perfect. So the fleet's
  // trailing edge has to keep up with the clock too. Measured on the validated
  // 2025 bundles (120 stations): 119 of 120 ran to Dec 31, so a fleet-level
  // floor here costs nothing against gauges that legitimately went dark.
  const today = nowDate.getUTCFullYear() === year ? dayOfYear(nowDate) : daysInYear(year) - 1;
  const lagShare = share(m => m.last >= today - maxLag);
  if (lagShare < minShare) {
    const lags = measured.map(m => today - m.last);
    v.push(`R6: only ${pct(lagShare)}% of ${measured.length} stations carry ${year} data from the `
      + `last ${maxLag} days (${floor}), median lag ${median(lags)} days — the running year stopped growing`);
  }
  // holes is the TOTAL number of null days between the first and the last
  // reading, not the longest run — twenty scattered one-day dropouts count the
  // same as one twenty-day outage. That is the quantity the 2025 calibration
  // above measured, so the threshold means what it was measured against.
  const holeShare = share(m => m.holes <= maxHoles);
  if (holeShare < minShare) {
    v.push(`R6: only ${pct(holeShare)}% of ${measured.length} stations keep their ${year} `
      + `null days between first and last reading at or below ${maxHoles} (${floor})`);
  }
  return v;
}

// R4 — the archive only ever grows: no deletions, no renames
export function checkChangeStatuses(changes) {
  return changes
    .filter(c => c.status !== 'A' && c.status !== 'M')
    .map(c => `R4: ${c.path}: git status ${c.status} — the archive only grows, nothing is deleted or renamed`);
}

// R4 — a changed month shard keeps every captured day and station; a station
// value may only go non-null -> null where the day slot was re-captured (the
// same-day re-run legitimately nulls a station that went stale)
export function compareShard(head, tree, path) {
  if (!head || !Array.isArray(head.days)) return [];
  const v = [];
  const treeDays = (tree && tree.days) || [];
  for (let i = 0; i < head.days.length; i++) {
    if (head.days[i] != null && treeDays[i] == null) v.push(`R4: ${path}: captured day ${i + 1} lost`);
  }
  for (const [uuid, st] of Object.entries(head.stations || {})) {
    const cur = ((tree && tree.stations) || {})[uuid];
    if (!cur) { v.push(`R4: ${path}: station ${uuid} vanished`); continue; }
    for (let i = 0; i < (st.v || []).length; i++) {
      if (st.v[i] == null || (cur.v || [])[i] != null) continue;
      if (treeDays[i] !== head.days[i]) continue; // re-captured slot
      v.push(`R4: ${path}: station ${uuid} day ${i + 1} went non-null -> null without a re-capture`);
    }
  }
  return v;
}

// R4 — current.json slots never regress; on the January rollover the previous
// year must have landed in closed.json first (treeClosedYears)
export function compareCurrent(head, tree, path, treeClosedYears = null) {
  if (!head || typeof head.y !== 'number') return [];
  if (!tree || typeof tree.y !== 'number') return [`R4: ${path}: unreadable while HEAD had year ${head.y}`];
  if (tree.y < head.y) return [`R4: ${path}: year moved backwards (${head.y} -> ${tree.y})`];
  if (tree.y > head.y) {
    return treeClosedYears && treeClosedYears.has(head.y)
      ? []
      : [`R4: ${path}: rolled over ${head.y} -> ${tree.y} but ${head.y} is not in closed.json — the freeze lost a year`];
  }
  const v = [];
  for (const k of ['min', 'max']) {
    const h = head[k] || [], t = (tree[k] || []);
    for (let i = 0; i < h.length; i++) {
      if (h[i] != null && t[i] == null) v.push(`R4: ${path}: ${k}[${i}] went non-null -> null`);
    }
  }
  return v;
}

// R4 — closed.json year sets only grow (the January freeze is irreversible)
export function compareClosed(head, tree, path) {
  const years = doc => new Set((Array.isArray(doc) ? doc : []).map(b => b && b.y));
  const treeYears = years(tree);
  return [...years(head)]
    .filter(y => !treeYears.has(y))
    .map(y => `R4: ${path}: closed year ${y} disappeared`);
}

// R5 shapes
export function checkShardShape(shard, path) {
  if (!shard || typeof shard.y !== 'number' || typeof shard.m !== 'number' || !Array.isArray(shard.days)) {
    return [`R5: ${path}: not a snapshot shard`];
  }
  const v = [];
  if (basename(path) !== shardName(shard.y, shard.m)) v.push(`R5: ${path}: names itself ${shard.y}-${shard.m}`);
  if (shard.days.length !== daysInMonth(shard.y, shard.m)) {
    v.push(`R5: ${path}: days.length ${shard.days.length} != ${daysInMonth(shard.y, shard.m)}`);
  }
  for (const [uuid, st] of Object.entries(shard.stations || {})) {
    if (!st || !Array.isArray(st.v) || st.v.length !== shard.days.length) {
      v.push(`R5: ${path}: station ${uuid} v.length misaligned`);
    }
  }
  return v;
}

export function checkCurrentShape(cur, path) {
  if (!cur || typeof cur.y !== 'number') return [`R5: ${path}: not a year bundle`];
  const n = daysInYear(cur.y);
  const v = [];
  for (const k of ['min', 'max']) {
    if (!Array.isArray(cur[k]) || cur[k].length !== n) v.push(`R5: ${path}: ${k}.length != ${n} for ${cur.y}`);
  }
  return v;
}

export function checkClosedShape(closed, path) {
  if (!Array.isArray(closed)) return [`R5: ${path}: not an array of year bundles`];
  const v = [];
  for (const b of closed) {
    if (!b || typeof b.y !== 'number' || !Array.isArray(b.min) || b.min.length !== daysInYear(b.y)
      || !Array.isArray(b.max) || b.max.length !== daysInYear(b.y)) {
      v.push(`R5: ${path}: malformed bundle for year ${b && b.y}`);
    }
  }
  return v;
}

export function checkManifestShape(manifest, minStations = 700) {
  if (!manifest || typeof manifest.stations !== 'object') return ['R5: manifest.json missing or unparseable'];
  const n = Object.keys(manifest.stations).length;
  return n < minStations ? [`R5: manifest.json lists ${n} stations (min ${minStations})`] : [];
}

// R7 — the manifest still knows which gauges WSV keeps no archive for.
//
// This one has a scar. `none` was derived from the file listing ("no
// closed.json years and no current.json"), so the weekly REST refresh erased it
// simply by succeeding: it writes a current.json for the ~111 lock, weir and
// foreign gauges WSV serves live but never archived. The deployed manifest
// marked 0 of 739, the client's "WSV keeps no multi-year archive" caveat was
// dead code site-wide, and readers of a gauge like Neuwied Stadt were told to
// "import the WSV archive" — an import that answers 303 to an error page.
// Nothing went red. The fetcher's own summary printed `0 without WSV archive`
// in every run and no one reads a log line.
//
// The marker is a recorded fact now (markNoArchive -> meta.json -> manifest),
// and this is the rule that notices when it stops being one. The floor is
// deliberately far below the count it guards: the real quantity is a property
// of WSV's station set and drifts by ones, while the failure mode this exists
// for is a collapse to zero.
export function checkNoArchiveMarkers(manifest, minMarked = 80) {
  if (!manifest || typeof manifest.stations !== 'object') return []; // R5 already flags that
  const n = Object.values(manifest.stations).filter(e => e && (e.noArchive || e.none)).length;
  return n < minMarked
    ? [`R7: manifest.json marks ${n} stations as having no WSV archive (min ${minMarked}) `
      + '— the marker is being derived away again, and the client caveat that depends on it is dead']
    : [];
}

export function checkOverviewShape(overview, minRivers = 80) {
  if (!overview || typeof overview.rivers !== 'object') return []; // R2 already flags a missing overview
  const n = Object.keys(overview.rivers).length;
  return n < minRivers ? [`R5: totals/overview.json carries ${n} rivers (min ${minRivers})`] : [];
}

// ---------- CLI loader: working tree + `git show HEAD:` as the baseline ----------

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

function git(gitDir, gitArgs) {
  return execFileSync('git', ['-C', gitDir, ...gitArgs],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// changed = diff vs HEAD plus untracked files (a brand-new month shard or
// station dir is invisible to `git diff HEAD`)
function listChanges(gitDir, prefix) {
  const changes = [];
  for (const line of git(gitDir, ['diff', '--name-status', 'HEAD', '--', prefix]).split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    changes.push({ status: parts[0][0], path: parts[parts.length - 1] });
  }
  for (const line of git(gitDir, ['ls-files', '--others', '--exclude-standard', '--', prefix]).split('\n')) {
    if (line) changes.push({ status: 'A', path: line });
  }
  return changes;
}

function readHead(gitDir, path) {
  try { return JSON.parse(git(gitDir, ['show', `HEAD:${path}`])); } catch { return null; }
}

async function main() {
  const treeDir = resolve(opt('tree', 'archive-branch/archive'));
  const gitDir = resolve(opt('git', join(treeDir, '..')));
  const prefix = relative(gitDir, treeDir).split(sep).join('/');
  const violations = [];

  const changes = listChanges(gitDir, prefix);
  violations.push(...checkChangeStatuses(changes));

  for (const { status, path } of changes) {
    if ((status !== 'A' && status !== 'M') || !path.endsWith('.json')) continue;
    const rel = path.slice(prefix.length + 1);
    const tree = readJson(join(gitDir, path));
    if (!tree) { violations.push(`R5: ${path}: does not parse as JSON`); continue; }
    const head = status === 'M' ? readHead(gitDir, path) : null;
    if (/^snapshots\/\d{4}-\d{2}\.json$/.test(rel)) {
      violations.push(...checkShardShape(tree, path), ...compareShard(head, tree, path));
    } else if (rel.endsWith('/current.json')) {
      const closed = readJson(join(gitDir, path.replace(/current\.json$/, 'closed.json')));
      const closedYears = new Set((Array.isArray(closed) ? closed : []).map(b => b && b.y));
      violations.push(...checkCurrentShape(tree, path), ...compareCurrent(head, tree, path, closedYears));
    } else if (rel.endsWith('/closed.json')) {
      violations.push(...checkClosedShape(tree, path), ...compareClosed(head, tree, path));
    }
  }

  // R1 + R3 over the current and previous month shard (MEZ)
  const { y, m } = mezParts(now);
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const days = capturedDays([
    readJson(join(treeDir, 'snapshots', shardName(py, pm))),
    readJson(join(treeDir, 'snapshots', shardName(y, m))),
  ]);
  violations.push(...checkRecency(days, now), ...checkCoverage(days));

  // R2 + R6 + the always-on shapes (single files, checked changed or not)
  const currentYear = now.getUTCFullYear(); // build-river-totals names the year file in UTC
  const manifest = readJson(join(treeDir, 'manifest.json'));
  const overview = readJson(join(treeDir, 'totals', 'overview.json'));
  violations.push(...checkTotalsLiveness({
    overview,
    units: readJson(join(treeDir, 'totals', 'units.json')),
    yearTotals: readJson(join(treeDir, 'totals', `${currentYear}.json`)),
    currentYear, nowDate: now,
  }));
  violations.push(...checkManifestShape(manifest));
  // R7 belongs to archive-update for the same reason R6 does: only that job
  // writes manifest.json, so a red R7 in the daily snapshot job would block a
  // push it cannot fix and cost that day's slot for good.
  if (!SKIP.has('R7')) violations.push(...checkNoArchiveMarkers(manifest));
  violations.push(...checkOverviewShape(overview));

  // R6 — only current.json is read (739 x 77KB of closed.json would be a
  // minute of I/O for a question about the running year alone).
  //
  // Skipped by the DAILY snapshot job, deliberately: current.json is written
  // by archive-update alone, so a red R6 there would block a push the snapshot
  // job cannot possibly fix — and a blocked snapshot loses its day slot for
  // good once the hole ages past the 7-day REST self-heal. The rule gates the
  // job that owns the file, where refusing to push a half-healed year is the
  // right answer and the workflow's failure step opens the watchdog issue.
  if (!SKIP.has('R6')) {
    const runningEntries = Object.entries((manifest || {}).stations || {})
      .filter(([, e]) => e && !e.none && (e.from ?? 9999) <= currentYear - 1)
      .map(([uuid]) => ({ uuid, cur: readJson(join(treeDir, uuid, 'current.json')) }));
    violations.push(...checkRunningYearContinuity(runningEntries, { year: currentYear, nowDate: now }));
  }

  if (violations.length) {
    for (const v of violations.slice(0, 40)) console.log(`::error::${v}`);
    if (violations.length > 40) console.log(`::error::... and ${violations.length - 40} more violations`);
    process.exit(1);
  }
  const latest = days[days.length - 1];
  console.log(`consistency ok: ${changes.length} changed files, latest snapshot ${latest.day} `
    + `with ${latest.count} stations, overview generated ${overview.generated}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
