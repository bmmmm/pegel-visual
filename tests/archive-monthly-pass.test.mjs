import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstMonday, duePeriod, monthlyCurrent, MONTHLY_PROTOCOL, main } from '../scripts/archive-monthly-pass.mjs';
const at = s => new Date(s);
const completed = (period, completedAt) => ({ monthly: { period, completedAt, protocol: MONTHLY_PROTOCOL } });

test('monthly due period follows first Monday across months and year boundaries', () => {
  assert.equal(firstMonday(at('2026-11-14Z')).toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(duePeriod(at('2026-11-01T23:59:59Z')), '2026-10');
  assert.equal(duePeriod(at('2026-11-02T00:00:00Z')), '2026-11');
  assert.equal(duePeriod(at('2027-01-01T12:00:00Z')), '2026-12');
  assert.equal(duePeriod(at('2027-01-04T00:00:00Z')), '2027-01');
});

test('only a valid full pass on the new protocol satisfies the monthly checkpoint', () => {
  const now = at('2026-11-14T10:00:00Z');
  assert.equal(monthlyCurrent(completed('2026-11', '2026-11-09T12:00:00Z'), '2026-11', now), true);
  for (const s of [{}, { monthly: { period: '2026-11' } },
    completed('2026-10', '2026-10-12T00:00:00Z'), completed('2026-12', '2026-12-01T00:00:00Z'),
    completed('2026-11', '2026-11-15T00:00:00Z'), completed('2026-11', '2026-10-31T00:00:00Z'),
    { monthly: { period: '2026-11', completedAt: '2026-11-09T00:00:00Z', protocol: 'old' } }]) {
    assert.equal(monthlyCurrent(s, '2026-11', now), false, JSON.stringify(s));
  }
});

test('missing pass stays due on later Mondays; completing it shares the data tree and ends retries', () => {
  const tree = mkdtempSync(join(tmpdir(), 'archive-monthly-'));
  const output = join(tree, 'output');
  writeFileSync(join(tree, 'manifest.json'), '{"generated":"2026-11-09T12:00:00Z"}');
  const env = { GITHUB_OUTPUT: output };
  try {
    assert.equal(main(['--tree', tree], { env, now: at('2026-11-09T13:00:00Z') }), true, 'fresh weekly manifest does not satisfy the ZIP pass');
    assert.equal(main(['--tree', tree], { env, now: at('2026-11-16T13:00:00Z') }), true, 'still due the following week');
    assert.equal(readFileSync(output, 'utf8'), 'monthly=true\nperiod=2026-11\nmonthly=true\nperiod=2026-11\n');
    assert.equal(main(['--tree', tree, '--complete', '--period', '2026-11'], { env, now: at('2026-11-16T14:00:00Z') }), 'completed');
    assert.equal(main(['--tree', tree], { env, now: at('2026-11-23T13:00:00Z') }), false);
    assert.equal(main(['--tree', tree, '--force'], { env, now: at('2026-11-23T13:00:00Z') }), true);
    assert.throws(() => main(['--tree', tree, '--complete', '--period', '2026-12'], { env, now: at('2026-11-23T13:00:00Z') }), /invalid monthly period/);
    assert.throws(() => main(['--tree', tree, '--complete', '--period', '2026-10'], { env, now: at('2026-11-23T13:00:00Z') }), /current month/);
    writeFileSync(join(tree, 'pipeline-status.json'), '{bad');
    assert.throws(() => main(['--tree', tree], { env }), SyntaxError);
  } finally { rmSync(tree, { recursive: true, force: true }); }
});

test('workflow checkpoints a full pass before the gate and publishes it only with the data push', () => {
  const s = readFileSync(new URL('../.github/workflows/archive-update.yml', import.meta.url), 'utf8');
  const mark = s.indexOf('- name: Record the completed monthly pass');
  for (const name of ['Heal the running year from the WSV ZIP archive', 'Gap sweep (new stations + retry the none-stations)', 'Rebuild river totals']) assert.ok(s.indexOf(name) < mark);
  assert.ok(mark < s.indexOf('- name: Consistency gate'));
  assert.ok(s.indexOf('- name: Consistency gate') < s.indexOf('- name: Commit and push'));
  assert.match(s.slice(mark, s.indexOf('- name: Consistency gate')), /if: steps\.pass\.outputs\.monthly == 'true'/);
  assert.doesNotMatch(s, /date -u \+%d/);
});

test('manual running-year repair also sweeps gaps, restores RWS and checkpoints before its gate', () => {
  const s = readFileSync(new URL('../.github/workflows/archive-heal.yml', import.meta.url), 'utf8');
  const mark = s.indexOf('- name: Record the completed monthly pass');
  for (const name of ['Heal the running year from the WSV ZIP archive', 'Gap sweep after the running-year heal', 'Refresh Rijkswaterstaat gauges after the WSV pass', 'Rebuild river totals']) assert.ok(s.indexOf(name) < mark);
  assert.ok(mark < s.indexOf('- name: Consistency gate'));
  assert.match(s.slice(mark, s.indexOf('- name: Consistency gate')), /if: inputs\.running/);
});
