// scripts/heal-dec31-run.mjs — the dispatch window, the Dec 31 read-back and
// the workflow inputs of the heal runbook (issue #17). The gh/git parts are a
// live operation and not tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowBlock, dec31, dispatchArgs, parseArgs, parseSelected, passed, pickRun } from '../scripts/heal-dec31-run.mjs';

const at = iso => new Date(iso);

test('window: Tue..Sun between 05:30 and 13:30 UTC is open', () => {
  assert.equal(windowBlock(at('2026-09-29T06:00:00Z')), null); // Tue
  assert.equal(windowBlock(at('2026-09-27T05:30:00Z')), null); // Sun, opening edge
  assert.equal(windowBlock(at('2026-09-26T13:30:00Z')), null); // Sat, closing edge
});

test('window: Monday is closed all day (archive-update)', () => {
  assert.match(windowBlock(at('2026-09-28T09:00:00Z')), /Monday/);
});

test('window: before 05:30 UTC is closed (morning snapshot)', () => {
  assert.match(windowBlock(at('2026-09-29T05:29:00Z')), /05:30/);
});

test('window: after 13:30 UTC is closed (afternoon snapshot)', () => {
  assert.match(windowBlock(at('2026-09-29T13:31:00Z')), /13:30/);
});

test('dec31 reads the last slot of the named year, null when absent', () => {
  const closed = [
    { y: 2024, min: [1, 2, 311], max: [3, 4, 331] },
    { y: 2025, min: [5, 172, 168], max: [6, 178, 172] },
  ];
  assert.deepEqual(dec31(closed, 2025), [168, 172]);
  assert.deepEqual(dec31(closed, 2024), [311, 331]);
  assert.equal(dec31(closed, 2023), null);
});

test('dispatch inputs: probe is BONN only, full is two workers under the 240-min budget', () => {
  assert.deepEqual(dispatchArgs('probe', false), ['-f', 'dec31=true', '-f', 'running=false', '-f', 'station=BONN']);
  assert.deepEqual(dispatchArgs('full', true), ['-f', 'dec31=true', '-f', 'running=true', '-f', 'parallel=2', '-f', 'budget_minutes=240']);
  assert.throws(() => dispatchArgs('ful', false), /unknown mode/);
});

// Pure on purpose: this script dispatches a real workflow, so no test ever
// spawns it (a mutant once reached GitHub through a spawned usage check).
test('parseArgs: the three modes and two flags, nothing else', () => {
  assert.deepEqual(parseArgs(['probe']), { mode: 'probe', running: false, force: false });
  assert.deepEqual(parseArgs(['full', '--running', '--force']), { mode: 'full', running: true, force: true });
  assert.deepEqual(parseArgs(['check']), { mode: 'check', running: false, force: false });
  assert.equal(parseArgs(['ful']), null);
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['full', '--runing']), null);
  assert.equal(parseArgs(['check', '--force']), null);
});

test('parseSelected reads the dry-run year count, null when absent', () => {
  assert.equal(parseSelected('2143 flattened Dec 31 across 613 station(s) · out: x/ · 1 worker(s)\n'), 2143);
  assert.equal(parseSelected('59 flattened Dec 31 across 40 station(s)'), 59);
  assert.equal(parseSelected('no station directories under x'), null);
});

// a budget-stopped full run heals BONN early and exits 0 — BONN alone must not pass it
test('passed: probe needs BONN, full needs BONN and the branch down to <= 100', () => {
  assert.equal(passed('probe', true, 2100), true);
  assert.equal(passed('probe', false, 59), false);
  assert.equal(passed('full', true, 59), true);
  assert.equal(passed('full', true, 100), true);
  assert.equal(passed('full', true, 101), false);
  assert.equal(passed('full', true, null), false);
  assert.equal(passed('full', false, 59), false);
});

test('pickRun: the first workflow_dispatch run at/after the dispatch, never an older one', () => {
  const since = '2026-09-24T10:25:40Z';
  const runs = [
    { databaseId: 3, event: 'workflow_dispatch', createdAt: '2026-09-24T10:25:50Z' },
    { databaseId: 2, event: 'workflow_dispatch', createdAt: '2026-09-24T10:25:45Z' },
    { databaseId: 1, event: 'workflow_dispatch', createdAt: '2026-09-24T09:00:00Z' }, // the probe
    { databaseId: 4, event: 'push', createdAt: '2026-09-24T10:25:41Z' },
  ];
  assert.equal(pickRun(runs, since), '2');
  assert.equal(pickRun(runs.slice(2), since), null);
});
