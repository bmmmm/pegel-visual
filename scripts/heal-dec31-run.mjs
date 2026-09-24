#!/usr/bin/env node
// Runbook for the one-off Dec-31 heal of the archive branch (issue #17), as a
// command: it checks the dispatch window, dispatches .github/workflows/
// archive-heal.yml, waits for it, and verifies the result against the branch.
// Needs `gh` (logged in) and the `github` remote; run it from a checkout.
//
//   node scripts/heal-dec31-run.mjs probe          # ONE station (BONN), ~15 min
//   node scripts/heal-dec31-run.mjs full           # all 2143 years, ~35-45 min
//   node scripts/heal-dec31-run.mjs full --running # + Jan..May 2026 re-read, ~+17 min
//   node scripts/heal-dec31-run.mjs check          # verification only, no dispatch
//   (--force skips the clock window only; the live busy check always runs)
//
// Order: probe, then full; `full` exits 0 only when the branch is actually
// healed (see Success below). The run is resumable — a full run stopped by its
// budget, or red on its failure rate, keeps what it healed and this command
// exits 1 with "dispatch full again".
//
// Why a window: archive-heal holds the `archive-branch-write` concurrency group
// while it runs, shared with snapshot-update (05:17 and 15:17 UTC daily) and
// archive-update (Mon 04:23 UTC). GitHub keeps ONE pending run per group and
// silently cancels it when another arrives, so the heal starts right after the
// morning snapshot: Tue..Sun, start between 05:30 and 13:30 UTC. A typical full
// run (35-45 min) ends long before the 15:17 snapshot; one that runs into its
// 240-min budget can overlap it, which only parks that snapshot as pending (it
// is lost solely if a third group member arrives meanwhile). The window alone
// is not enough — a snapshot dispatched by hand, or a slow one, holds the group
// too — so the live check refuses while any of the three workflows is waiting.
//
// Success looks like: BONN (593647aa-…) 2025 Dec 31 reads [168,172] instead of
// [172,172], and a dry run over the healed branch selects only the ~59 years
// whose Dec 31 really was flat (they stay selected forever; see heal-dec31.mjs)
// — `full` passes at <= MAX_LEFT, measured before the heal: 2143.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = process.env.PEGEL_GH_REPO || 'bmmmm/pegel-visual';
const WORKFLOW = 'archive-heal.yml';
const GROUP = ['archive-heal.yml', 'snapshot-update.yml', 'archive-update.yml'];
const BONN = '593647aa-9fea-43ec-a7d6-6476a76ae868';
const BONN_HEALED = [168, 172]; // live probe 2026-09-24 on a scratch copy
const MAX_LEFT = 100; // ~59 genuinely flat Dec 31 stay selected, plus margin
const BUSY = ['in_progress', 'queued', 'pending', 'requested', 'waiting'];

// Tue..Sun (UTC), start in [05:30, 13:30]. Returns null when allowed, else why not.
export function windowBlock(date) {
  const day = date.getUTCDay(); // 0 Sun .. 6 Sat
  const min = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (day === 1) return 'Monday: archive-update (04:23 UTC) may still hold the group — pick Tue..Sun';
  if (min < 5 * 60 + 30) return 'before 05:30 UTC: the 05:17 snapshot may still run';
  if (min > 13 * 60 + 30) return 'after 13:30 UTC: a full run would reach the 15:17 snapshot';
  return null;
}

// Dec 31 [min, max] of year y from a closed.json bundle (array of {y, min, max}).
export function dec31(closed, y) {
  const yr = closed.find(e => e.y === y);
  if (!yr) return null;
  return [yr.min.at(-1), yr.max.at(-1)];
}

export function dispatchArgs(mode, running) {
  const a = ['-f', 'dec31=true', '-f', `running=${running === true}`];
  if (mode === 'probe') a.push('-f', 'station=BONN');
  else if (mode === 'full') a.push('-f', 'parallel=2', '-f', 'budget_minutes=240');
  else throw new Error(`dispatchArgs: unknown mode ${mode}`);
  return a;
}

// the year count out of heal-dec31.mjs --dry-run ("2143 flattened Dec 31 across …")
export function parseSelected(out) {
  const m = /^(\d+) flattened Dec 31 across/m.exec(out || '');
  return m ? Number(m[1]) : null;
}

// probe: BONN healed. full: BONN healed AND the whole branch down to the
// genuinely flat remainder — a budget-stopped run heals BONN early and exits 0.
export function passed(mode, bonnOk, selected) {
  if (!bonnOk) return false;
  if (mode === 'probe') return true;
  return selected !== null && selected <= MAX_LEFT;
}

// the run this dispatch created: a workflow_dispatch run created at/after the
// dispatch; null rather than a guess (an older probe run would pass the check)
export function pickRun(runs, sinceIso) {
  const fresh = runs.filter(r => r.event === 'workflow_dispatch' && r.createdAt >= sinceIso)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return fresh.length ? String(fresh[0].databaseId) : null;
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
};
const must = (cmd, args, opts) => {
  const r = sh(cmd, args, opts);
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`); process.exit(1); }
  return r.stdout;
};

function busyRuns() {
  const busy = [];
  for (const wf of GROUP) {
    for (const status of BUSY) {
      const out = must('gh', ['run', 'list', '-R', REPO, '--workflow', wf, '--status', status, '--json', 'databaseId', '--jq', '.[].databaseId']);
      for (const id of out.split('\n').filter(Boolean)) busy.push(`${wf} ${status} ${id}`);
    }
  }
  return busy;
}

function check(mode) {
  must('git', ['fetch', '-q', 'github', 'archive']);
  const closed = JSON.parse(must('git', ['show', `github/archive:archive/${BONN}/closed.json`]));
  const got = dec31(closed, 2025);
  const ok = JSON.stringify(got) === JSON.stringify(BONN_HEALED);
  console.log(`BONN 2025 Dec 31: ${JSON.stringify(got)} — ${ok ? 'healed' : `NOT healed (expected ${JSON.stringify(BONN_HEALED)})`}`);
  const dir = mkdtempSync(join(tmpdir(), 'heal-check-'));
  let selected = null;
  try {
    const add = sh('git', ['worktree', 'add', '-q', '--detach', dir, 'github/archive']);
    if (add.status !== 0) throw new Error(`git worktree add failed:\n${add.stderr}`);
    const dry = sh('node', [join(dirname(fileURLToPath(import.meta.url)), 'heal-dec31.mjs'), '--out', join(dir, 'archive'), '--dry-run']);
    if (dry.status !== 0) throw new Error(`dry run failed:\n${dry.stdout}${dry.stderr}`);
    selected = parseSelected(dry.stdout);
    console.log(`still selected: ${selected ?? '?'} years (<= ${MAX_LEFT} after a complete full run; 2143 before)`);
  } finally {
    sh('git', ['worktree', 'remove', '--force', dir]);
    sh('git', ['worktree', 'prune']);
    rmSync(dir, { recursive: true, force: true });
  }
  return passed(mode, ok, selected);
}

function run(mode, { running, force }) {
  const why = windowBlock(new Date());
  if (why && !force) { console.error(`not now: ${why} (--force overrides the window)`); process.exit(3); }
  const busy = busyRuns();
  if (busy.length) { console.error(`not now: archive-branch-write is in use:\n  ${busy.join('\n  ')}`); process.exit(3); }
  const since = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, 'Z');
  const out = must('gh', ['workflow', 'run', WORKFLOW, '-R', REPO, '--ref', 'main', ...dispatchArgs(mode, running)]);
  let id = out.match(/runs\/(\d+)/)?.[1] ?? null;
  for (let i = 0; !id && i < 12; i++) {
    sleep(5000);
    const runs = JSON.parse(must('gh', ['run', 'list', '-R', REPO, '--workflow', WORKFLOW, '-L', '10', '--json', 'databaseId,event,createdAt']));
    id = pickRun(runs, since);
  }
  if (!id) { console.error(`dispatched, but no new ${WORKFLOW} run showed up within 60 s — look at https://github.com/${REPO}/actions and run \`check\` afterwards`); process.exit(1); }
  console.log(`dispatched ${mode}${running ? ' +running' : ''}: https://github.com/${REPO}/actions/runs/${id} — waiting…`);
  sh('gh', ['run', 'watch', '-R', REPO, id, '--interval', '30'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const conclusion = must('gh', ['run', 'view', '-R', REPO, id, '--json', 'conclusion', '--jq', '.conclusion']).trim();
  console.log(`run ${id}: ${conclusion}${conclusion === 'cancelled' ? ' — nothing ran to completion; dispatch again'
    : conclusion === 'success' ? '' : ' — partial progress is committed; read the log, then dispatch again'}`);
  const healed = check(mode);
  if (!healed && mode === 'full') console.log('not fully healed yet — dispatch full again (it resumes)');
  process.exit(conclusion === 'success' && healed ? 0 : 1);
}

// argv → { mode, running, force }, or null for anything else: a typo must never
// reach the dispatch.
export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!['probe', 'full', 'check'].includes(mode)) return null;
  if (rest.some(f => !['--running', '--force'].includes(f))) return null;
  if (mode === 'check' && rest.length) return null;
  return { mode, running: rest.includes('--running'), force: rest.includes('--force') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: node scripts/heal-dec31-run.mjs probe|full|check [--running] [--force]');
    process.exit(2);
  }
  if (args.mode === 'check') process.exit(check('full') ? 0 : 1);
  run(args.mode, args);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
