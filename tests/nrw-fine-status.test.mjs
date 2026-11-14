import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tracker } from './fixtures/freshness-tracker.mjs';
import { main, lastFineStatus } from '../scripts/report-nrw-fine-status.mjs';

const pegel = 'pegel_messwerte.txt';
const rain = 'nieder_messwerte.txt';
const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com' };
const bot = body => ({ body, user: { login: 'github-actions[bot]' } });
const legacy = bot('nrw-update run degraded: https://github.com/owner/repo/actions/runs/1\n\n'
  + 'The LANUK export lacked pegel_messwerte.txt — the daily level, rain and temperature were mirrored, that fine series was skipped. Not a pipeline bug; the fine window starts losing days once the source has been without it for 63 days.');

test('warn once, stay quiet during the outage, recover once, then stay quiet; recurrence warns again', () => {
  const t = tracker();
  assert.equal(t.run(pegel), 'reported');
  assert.equal(t.run(pegel), 'unchanged');
  assert.equal(t.run(''), 'reported');
  assert.equal(t.run(''), 'unchanged');
  assert.equal(t.run(pegel), 'reported');
  assert.equal(t.writes.length, 3);
  assert.match(t.writes[0], /^nrw-update run degraded:/);
  assert.match(t.writes[1], /^nrw-update fine series recovered: https:\/\/github.com\/owner\/repo\/actions\/runs\/42/);
});

test('legacy warning is recovered once, even with unrelated reports and human comments afterwards', () => {
  const t = tracker({ pages: [[legacy], [bot('archive-update run failed: url'),
    { body: 'nrw-update fine series recovered: human speculation', user: { login: 'someone' } }]] });
  assert.equal(t.run(''), 'reported');
  assert.equal(t.run(''), 'unchanged');
  assert.equal(t.writes.length, 1);
});

test('changed missing-table sets are reported; order, duplicates and spaces do not cause noise', () => {
  const t = tracker();
  assert.equal(t.run(`${pegel},${rain}`), 'reported');
  assert.equal(t.run(` ${rain},${pegel},${rain} `), 'unchanged');
  assert.equal(t.run(pegel), 'reported');
  assert.equal(t.run(pegel), 'unchanged');
  assert.equal(t.run(''), 'reported');
  assert.equal(t.writes.length, 3);
});

test('healthy first runs never create an issue or label; degraded issue body is durable state too', () => {
  const t = tracker({ issue: null });
  assert.equal(t.run(''), 'unchanged');
  assert.equal(t.calls.length, 1, 'only the issue lookup, no mutation');
  assert.equal(t.run(pegel), 'created');
  assert.equal(t.run(pegel), 'unchanged', 'new issue body uses GraphQL bot identity');
  assert.equal(t.run(''), 'reported');
  assert.equal(t.run(''), 'unchanged');
  assert.equal(t.writes.length, 2);
});

test('healthy runs do not acknowledge other failures or human degradation reports', () => {
  assert.deepEqual(lastFineStatus([{ ...legacy, user: { login: 'someone' } }]), []);
  const t = tracker({ pages: [[bot('nrw-update run failed: url'), bot('Still stale: archive refresh')]] });
  assert.equal(t.run(''), 'unchanged');
  assert.equal(t.writes.length, 0);
});

test('API failures propagate; an unsuccessful report is retried without losing the incident', () => {
  const read = tracker();
  read.failRead();
  assert.throws(() => read.run(''), /GitHub unavailable/);
  const write = tracker({ pages: [[legacy]] });
  write.failWrite(true);
  assert.throws(() => write.run(''), /Comment write failed/);
  write.failWrite(false);
  assert.equal(write.run(''), 'reported');
  assert.equal(write.run(''), 'unchanged');
  assert.equal(write.writes.length, 1);
});

test('invalid invocation and missing status fail before any GitHub request', () => {
  const gh = () => assert.fail('must not access GitHub');
  assert.throws(() => main(['--nope'], { env, gh }), /usage:/);
  assert.throws(() => main([], { env: {}, gh }), /GITHUB_REPOSITORY/);
  assert.throws(() => main([], { env, gh }), /DEGRADED must be set/);
  assert.throws(() => main([], { env: { ...env, DEGRADED: 'wrong.txt' }, gh }), /unknown LANUK/);
});

test('workflow reports recovery only after the gate and both pushes succeed', () => {
  const workflow = readFileSync(new URL('../.github/workflows/nrw-update.yml', import.meta.url), 'utf8');
  const report = workflow.indexOf('      - name: Report a fine-series status change');
  for (const step of ['Consistency gate (N1-N9)', 'Commit and push nrw\n', 'Commit and push nrw-hires\n']) {
    const pos = workflow.indexOf(step);
    assert.ok(pos >= 0 && pos < report, step);
  }
  const block = workflow.slice(report, workflow.indexOf('      - name: Report a failed run', report));
  assert.match(block, /\n        if: success\(\)\n/);
  assert.match(block, /DEGRADED: \$\{\{ steps\.collect\.outputs\.degraded \}\}/);
  assert.match(block, /run: node scripts\/report-nrw-fine-status\.mjs/);
});
