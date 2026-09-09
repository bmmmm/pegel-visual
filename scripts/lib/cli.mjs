// The helpers every collector, builder and checker in scripts/ carried as its
// own copy — argv parsing, the pinned clock, JSON I/O, directory listing, and
// the git probes of the two consistency checkers. Factored out on 2026-09-09
// (audit item C4) from twelve files; behaviour is the one the copies shared,
// and where the copies had drifted the choice is written at the helper.
//
// Not a framework: no subcommands, no help text, no validation beyond what the
// scripts already did. A script that needs more should still not need this
// file to grow.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------- argv ----------

// Three readers over one argv, with the semantics the scripts already had:
//   opt(name, fallback)  `--name value`, or fallback when absent or valueless
//   has(name)            `--name` present at all (a switch)
//   flag(name)           `--name value`, null when absent, THROWS when the
//                        value is missing — the strict form of the nrw
//                        builders and probes, where a `--tree` without a path
//                        must not silently mean the default tree
// A value never starts with `--`, so `--out --check` reads `--out` as absent.
// `--out=x` is `--out x`: before 2026-09-10 the `=` form passed every
// unknown-flag sweep (they compare the key) and then fell silently onto the
// default — `--heal-source=zip` healed via REST, `--current=1` ran a full
// backfill (reviewer, measured).
export function parseArgs(argv = process.argv.slice(2)) {
  const args = argv.flatMap(a => {
    const m = /^--([^=]+)=(.*)$/s.exec(a);
    return m ? ['--' + m[1], m[2]] : [a];
  });
  const valueAt = i => (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined);
  return {
    args,
    opt: (name, fallback) => { const v = valueAt(args.indexOf('--' + name)); return v === undefined ? fallback : v; },
    has: name => args.includes('--' + name),
    flag: name => {
      const i = args.indexOf('--' + name);
      if (i < 0) return null;
      const v = valueAt(i);
      if (v === undefined) throw new Error(`--${name} needs a value`);
      return v;
    },
  };
}

// ---------- clock ----------

// PEGEL_NOW pins the clock for tests and rehearsals (e.g. PEGEL_NOW=2027-01-03
// to rehearse a year turn). Read once at import by each script, as before.
export const pinnedNow = () => (process.env.PEGEL_NOW ? new Date(process.env.PEGEL_NOW) : new Date());

// ---------- files ----------

// null for a missing or malformed file — every caller treats both the same
export const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// Sorted, always: the nrw collector's copy iterated in readdir order and wrote
// the manifest from it, so the key order of manifest.json depended on the
// runner's filesystem. Its next run rewrites the manifest once (sorted), then
// it is stable.
export const listDirs = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; } };
// sorted too, for the same reason: build-nrw-precip's yearsIn reads it, and
// the collector's manifest counts must not depend on readdir order either
export const listFiles = dir => { try { return readdirSync(dir).sort(); } catch { return []; } };

// write only when the content changed: a data branch that is rewritten daily
// with identical bytes still grows its history. Returns whether it wrote.
export function writeText(path, text) {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}
export const writeJson = (path, obj) => writeText(path, JSON.stringify(obj));

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- git probes of the consistency checkers ----------

// LC_ALL=C pins git's messages to English, because UNBORN_HEAD below matches
// their text. Measured 2026-09-10 under LC_ALL=de_DE.UTF-8: `diff HEAD -- x`
// says "Schwerwiegend: bad revision 'HEAD'" (head translated, body not, so the
// regex still matches today), `diff HEAD` says "mehrdeutiges Argument 'HEAD'"
// (fully translated). The pin keeps the regex true whichever form git picks.
// maxBuffer 256 MB: the first diff of a large nrw-hires tree can exceed the
// default 1 MB, and that ENOBUFS must crash — see listChanges.
export function git(gitDir, gitArgs, stdio) {
  return execFileSync('git', ['-C', gitDir, ...gitArgs],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }, ...(stdio ? { stdio } : {}) });
}

// changed = diff vs HEAD plus untracked files (a brand-new month shard or
// station dir is invisible to `git diff HEAD`); a repo without a commit yet
// has no baseline at all, so everything in it is new. ONLY that case is
// swallowed: any other git failure (no such directory, a corrupt HEAD) must
// stay a crash, or a checker comparing against HEAD would read "nothing
// changed" off a broken repo and pass it. That includes ENOBUFS from a diff
// larger than maxBuffer: an earlier version swallowed it as "no HEAD" and
// reported a huge first run as nothing changed — do not widen the regex.
const UNBORN_HEAD = /bad revision 'HEAD'|unknown revision|ambiguous argument 'HEAD'/;
export function listChanges(gitDir, prefix) {
  const changes = [];
  let diff = '';
  try { diff = git(gitDir, ['diff', '--name-status', 'HEAD', '--', prefix], ['ignore', 'pipe', 'pipe']); }
  catch (e) {
    if (!UNBORN_HEAD.test(String(e.stderr || ''))) throw e;
    console.log('note: no HEAD to compare against — every file counts as new');
  }
  for (const line of diff.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    changes.push({ status: parts[0][0], path: parts[parts.length - 1] });
  }
  for (const line of git(gitDir, ['ls-files', '--others', '--exclude-standard', '--', prefix]).split('\n')) {
    if (line) changes.push({ status: 'A', path: line });
  }
  return changes;
}

// a file that is new in this run has no HEAD version — git says so on stderr,
// and that is not a finding, so its stderr stays out of the log
export function readHead(gitDir, path) {
  try { return JSON.parse(git(gitDir, ['show', `HEAD:${path}`], ['ignore', 'pipe', 'ignore'])); }
  catch { return null; }
}
