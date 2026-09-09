// scripts/lib/cli.mjs — the helpers twelve scripts share since 2026-09-09
// (audit C4), and the three decisions written into them: a value never
// starts with `--`, flag() throws on a missing value, listDirs is sorted.
// Plus the git probe's one swallowed failure, and a smoke import of
// lib/cdp.mjs, which no browser check can gate inside `node --test`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, listDirs, listFiles, listChanges, readHead, readJson, git } from '../scripts/lib/cli.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

// every scratch tree this file makes, removed once at the end (they used to pile up in $TMPDIR)
const scratch = [];
const tmp = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); scratch.push(d); return d; };
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

test('parseArgs: opt falls back, has is a switch, flag throws on a missing value', () => {
  const p = parseArgs(['--out', 'x', '--check', '--tree']);
  assert.equal(p.opt('out', 'd'), 'x');
  assert.equal(p.opt('tree', 'd'), 'd', 'valueless --tree falls back');
  assert.equal(p.opt('nope', 'd'), 'd');
  assert.equal(p.has('check'), true);
  assert.equal(p.has('out'), true);
  assert.equal(p.has('x'), false);
  assert.equal(p.flag('out'), 'x');
  assert.equal(p.flag('nope'), null);
  assert.throws(() => p.flag('tree'), /--tree needs a value/);
});

test('parseArgs: --out=x is --out x, for opt, has and flag alike', () => {
  const p = parseArgs(['--out=a=b', '--max-months=6', '--current=1', '--tree=']);
  assert.equal(p.opt('out', 'd'), 'a=b', 'split on the first = only');
  assert.equal(p.flag('max-months'), '6');
  assert.equal(p.has('current'), true);
  assert.equal(p.opt('tree', 'd'), 'd', 'an empty value counts as absent, as a bare --tree does');
  assert.deepEqual(p.args, ['--out', 'a=b', '--max-months', '6', '--current', '1', '--tree', '']);
});

test('parseArgs: a value never starts with --, so `--out --check` reads --out as absent', () => {
  const p = parseArgs(['--out', '--check']);
  assert.equal(p.opt('out', null), null);
  assert.throws(() => p.flag('out'), /--out needs a value/);
  assert.equal(p.has('check'), true);
  // the first occurrence wins, as the copies did
  assert.equal(parseArgs(['--a', '1', '--a', '2']).opt('a', null), '1');
});

// (APFS already hands names back sorted, so this goes red only on a
// hash-ordered filesystem — ext4 on the CI runner is one)
test('listDirs and listFiles are sorted whatever order the filesystem hands back', () => {
  const dir = tmp('cli-dirs-');
  for (const n of ['b', '10', 'a', '2']) mkdirSync(join(dir, n));
  for (const n of ['2024.json', 'x', '2019.json']) writeFileSync(join(dir, n), '');
  assert.deepEqual(listDirs(dir), ['10', '2', 'a', 'b']);
  assert.deepEqual(listDirs(join(dir, 'missing')), []);
  assert.deepEqual(listFiles(dir), ['10', '2', '2019.json', '2024.json', 'a', 'b', 'x']);
  assert.deepEqual(listFiles(join(dir, 'missing')), []);
});

test('readJson: null for a missing and for a malformed file', () => {
  const dir = tmp('cli-json-');
  writeFileSync(join(dir, 'bad.json'), '{');
  writeFileSync(join(dir, 'ok.json'), '{"a":1}');
  assert.equal(readJson(join(dir, 'bad.json')), null);
  assert.equal(readJson(join(dir, 'none.json')), null);
  assert.deepEqual(readJson(join(dir, 'ok.json')), { a: 1 });
});

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t',
  '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

test('listChanges: an unborn HEAD is "everything is new"; any other git failure still throws', () => {
  const repo = tmp('cli-git-');
  gitIn(repo, 'init', '-q');
  mkdirSync(join(repo, 'data'));
  writeFileSync(join(repo, 'data', 'a.json'), '{"v":1}');
  // the unborn case says so on stdout — captured here, so the suite's output
  // stays clean and the note itself is asserted rather than silenced
  const logged = [];
  const log = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  let unborn;
  try { unborn = listChanges(repo, 'data'); } finally { console.log = log; }
  assert.deepEqual(unborn, [{ status: 'A', path: 'data/a.json' }]);
  assert.match(logged.join('\n'), /no HEAD to compare against/);
  // a German runner: git() pins LC_ALL=C, so the failure git reports starts
  // with "fatal:" and not "Schwerwiegend:" — the regex above reads English.
  // (Today only the head of this message is translated, so listChanges would
  // survive without the pin; the pin is asserted on git() itself.) A runner
  // whose git does not translate at all (no de_DE locale generated, as on a
  // stock ubuntu image) cannot see the pin either way — measured first, so
  // the assertion is skipped there instead of passing vacuously.
  const env = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  process.env.LC_ALL = 'de_DE.UTF-8'; process.env.LANGUAGE = 'de';
  try {
    const raw = spawnSync('git', ['-C', repo, 'diff', '--name-status', 'HEAD', '--', 'data'], { encoding: 'utf8' });
    if (/Schwerwiegend/.test(raw.stderr)) {
      assert.throws(() => git(repo, ['diff', '--name-status', 'HEAD', '--', 'data'], ['ignore', 'pipe', 'pipe']),
        e => /^fatal: bad revision 'HEAD'/m.test(String(e.stderr)), 'git() reports in English under a German locale');
    } else {
      console.error('note: git does not speak German on this runner — the LC_ALL pin is not observable here');
    }
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(readHead(repo, 'data/a.json'), null, 'no HEAD version yet');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'seed');
  writeFileSync(join(repo, 'data', 'a.json'), '{"v":2}');
  writeFileSync(join(repo, 'data', 'b.json'), '{}');
  assert.deepEqual(listChanges(repo, 'data'), [{ status: 'M', path: 'data/a.json' }, { status: 'A', path: 'data/b.json' }]);
  assert.deepEqual(readHead(repo, 'data/a.json'), { v: 1 });
  // a directory git cannot enter is not "nothing changed"
  assert.throws(() => listChanges(join(repo, 'nowhere'), 'data'), /cannot change to|not a git repository|ENOENT/i);
  // a HEAD that names a missing object: diff fails, ls-files still works —
  // a probe that swallowed every diff failure would report "nothing changed"
  const branch = gitIn(repo, 'symbolic-ref', '--short', 'HEAD').trim();
  writeFileSync(join(repo, '.git', 'refs', 'heads', branch), '0000000000000000000000000000000000000000\n');
  assert.throws(() => listChanges(repo, 'data'), /bad object HEAD/);
});

test('lib/cdp.mjs imports and binds what it re-exports', async () => {
  // 0e84e0d9: `export { sleep } from` left serve() without a sleep, and only a
  // browser run — outside node --test — could see it
  const cdp = await import('../scripts/lib/cdp.mjs');
  for (const name of ['sleep', 'serve', 'chrome', 'session', 'checker', 'killChildren']) {
    assert.equal(typeof cdp[name], 'function', name);
  }
  await cdp.sleep(1);
});

// Every script's main() past its argument parsing, without touching the
// network: the C4 refactor left an unbound `args` in two of them, and the
// suite stayed green because nothing spawned those mains. Each line below
// stops at the script's OWN first validation error — a message it prints on
// purpose — which is only reachable once the parsing above it has run.
// snapshot-wsv and fetch-rws-archive used to fetch before they validated
// anything; their unknown-flag sweep (exit 2) is what makes them spawnable here.
test('every collector and builder main() gets past its argument parsing', () => {
  const missing = join(tmp('cli-main-'), 'nowhere');
  const cases = [
    [['fetch-wsv-archive.mjs', '--migrate'], 2, /unknown flag --migrate/],
    [['fetch-wsv-archive.mjs', '--current', '--running'], 1, /separate passes/],
    [['build-river-totals.mjs', '--archive', missing], 1, /exactly one of --rebuild/],
    [['build-nrw-precip.mjs', '--tree', missing], 1, /no topology\.json under/],
    [['build-nrw-hourly-lag.mjs', '--tree', missing, '--hires', missing, '--out', join(missing, 'hourly')], 1, /no topology\.json under|no hourly rain/],
    [['probe-precip-rule.mjs', '--tree', missing], 1, /no topology\.json under/],
    [['probe-hourly-lag.mjs', '--tree', missing, '--hires', missing], 1, /no topology\.json under|no hourly rain/],
    [['fetch-nrw-archive.mjs', '--dry-run', '--out', missing, '--raw', missing], 1, /ENOENT.*stations\.json/],
    [['snapshot-wsv.mjs', '--nope'], 2, /unknown flag --nope/],
    [['fetch-rws-archive.mjs', '--nope'], 2, /unknown flag --nope/],
  ];
  for (const [argv, code, expect] of cases) {
    const r = spawnSync(process.execPath, [join(SCRIPTS, argv[0]), ...argv.slice(1)], { encoding: 'utf8', timeout: 20000 });
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, /ReferenceError|is not defined/, `${argv[0]}: an unbound identifier in main()`);
    assert.equal(r.status, code, `${argv[0]} exit: ${out.slice(0, 300)}`);
    assert.match(out, expect, argv[0]);
  }
});
