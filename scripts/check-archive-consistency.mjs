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

  // R2 + the always-on shapes (single files, checked changed or not)
  const currentYear = now.getUTCFullYear(); // build-river-totals names the year file in UTC
  const overview = readJson(join(treeDir, 'totals', 'overview.json'));
  violations.push(...checkTotalsLiveness({
    overview,
    units: readJson(join(treeDir, 'totals', 'units.json')),
    yearTotals: readJson(join(treeDir, 'totals', `${currentYear}.json`)),
    currentYear, nowDate: now,
  }));
  violations.push(...checkManifestShape(readJson(join(treeDir, 'manifest.json'))));
  violations.push(...checkOverviewShape(overview));

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
