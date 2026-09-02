import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATIONS, STEP_MS, byMonth, collectStation, foldLegacy, gapCount, merge, normalize, readAllPoints, writeShards,
} from '../scripts/forecast/collect-hires.mjs';

const KOELN = 'a6ee8177-107b-47dd-bcfd-30960ccc6e9c';
const T0 = Date.parse('2026-10-01T00:00:00Z'); // negative k = September, k >= 0 = October
const stamp = k => new Date(T0 + k * STEP_MS).toISOString();
const batch = (from, n) => Array.from({ length: n }, (_, i) => ({ timestamp: stamp(from + i), value: 300 + from + i }));

test('normalize: drops sentinels and bad stamps, sorts, last reading per stamp wins', () => {
  const pts = normalize([
    { timestamp: '2026-09-01T10:15:00+02:00', value: 250 },
    { timestamp: '2026-09-01T10:00:00+02:00', value: 249 },
    { timestamp: '2026-09-01T10:00:00+02:00', value: 251 }, // revision of the same stamp
    { timestamp: '2026-09-01T10:30:00+02:00', value: 99999 }, // sentinel
    { timestamp: 'not a date', value: 200 },
    { timestamp: '2026-09-01T10:45:00+02:00', value: null },
  ]);
  assert.deepEqual(pts, [
    ['2026-09-01T08:00:00.000Z', 251],
    ['2026-09-01T08:15:00.000Z', 250],
  ]);
});

test('normalize: negative NAP values are readings, not sentinels', () => {
  assert.deepEqual(normalize([{ timestamp: '2026-09-01T00:00:00Z', value: -300 }]), [['2026-09-01T00:00:00.000Z', -300]]);
});

test('merge: idempotent union by timestamp, fresh wins, chronological', () => {
  const a = [['2026-09-01T00:00:00.000Z', 1], ['2026-09-01T00:15:00.000Z', 2]];
  const b = [['2026-09-01T00:15:00.000Z', 3], ['2026-08-31T23:45:00.000Z', 0]];
  const m = merge(a, b);
  assert.deepEqual(m, [['2026-08-31T23:45:00.000Z', 0], ['2026-09-01T00:00:00.000Z', 1], ['2026-09-01T00:15:00.000Z', 3]]);
  assert.deepEqual(merge(m, b), m, 'a second merge changes nothing');
});

test('byMonth shards by the UTC month of the stamp', () => {
  const months = byMonth([['2026-09-30T23:45:00.000Z', 1], ['2026-10-01T00:00:00.000Z', 2], ['2026-10-01T00:15:00.000Z', 3]]);
  assert.deepEqual([...months.keys()], ['2026-09', '2026-10']);
  assert.equal(months.get('2026-10').length, 2);
});

test('gapCount counts holes wider than one 15-minute step', () => {
  const pts = [0, 1, 2, 4, 5, 9].map(k => [stamp(k), k]);
  assert.equal(gapCount(pts), 2);
  assert.equal(gapCount([]), 0);
});

test('writeShards: a month boundary splits into two files, an untouched shard is not rewritten', () => {
  const out = mkdtempSync(join(tmpdir(), 'hires-'));
  const pts = normalize(batch(-4, 8)); // 4 steps in September, 4 in October
  assert.equal(writeShards(out, KOELN, 'KÖLN', pts, new Date('2026-10-01T02:00:00Z')), 8);
  const names = readdirSync(join(out, KOELN)).sort();
  assert.deepEqual(names, ['2026-09.json', '2026-10.json']);
  const sep = JSON.parse(readFileSync(join(out, KOELN, '2026-09.json'), 'utf8'));
  assert.equal(sep.points.length, 4);
  assert.equal(sep.month, '2026-09');
  const before = readFileSync(join(out, KOELN, '2026-09.json'), 'utf8');
  // a second run with the same September points and two new October ones
  assert.equal(writeShards(out, KOELN, 'KÖLN', normalize(batch(-4, 10)), new Date('2026-10-08T02:00:00Z')), 2);
  assert.equal(readFileSync(join(out, KOELN, '2026-09.json'), 'utf8'), before, 'September shard untouched byte for byte');
  assert.equal(readAllPoints(join(out, KOELN)).length, 10);
});

test('writeShards: a revised reading on a known stamp does rewrite its shard', () => {
  const out = mkdtempSync(join(tmpdir(), 'hires-'));
  writeShards(out, KOELN, 'KÖLN', [[stamp(0), 300]], new Date());
  assert.equal(writeShards(out, KOELN, 'KÖLN', [[stamp(0), 301]], new Date()), 0);
  assert.equal(readAllPoints(join(out, KOELN))[0][1], 301);
});

test('foldLegacy: the first runs single file is folded into shards once and removed', () => {
  const out = mkdtempSync(join(tmpdir(), 'hires-'));
  writeFileSync(join(out, `${KOELN}.json`), JSON.stringify({ name: 'KÖLN', updated: '2026-09-02T00:00:00Z', points: normalize(batch(-2, 4)) }));
  assert.equal(foldLegacy(out, KOELN), 4);
  assert.equal(existsSync(join(out, `${KOELN}.json`)), false);
  assert.equal(readAllPoints(join(out, KOELN)).length, 4);
  assert.equal(foldLegacy(out, KOELN), 0, 'nothing left to fold');
});

test('collectStation: writes shards, merges across runs, records each run (no network)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'hires-'));
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return { ok: true, json: async () => batch(calls.length === 1 ? 0 : 5, 10) }; };
  const r1 = await collectStation(KOELN, { out, fetchImpl, now: new Date('2026-09-29T12:00:00Z') });
  assert.equal(r1.fetched, 10);
  assert.equal(r1.added, 10);
  const r2 = await collectStation(KOELN, { out, fetchImpl, now: new Date('2026-10-06T12:00:00Z') });
  assert.equal(r2.added, 5, 'overlap is merged, not duplicated');
  assert.equal(r2.total, 15);
  const runs = JSON.parse(readFileSync(join(out, KOELN, 'runs.json'), 'utf8'));
  assert.equal(runs.name, 'KÖLN');
  assert.equal(runs.runs.length, 2);
  assert.match(calls[0], /\/stations\/a6ee8177-107b-47dd-bcfd-30960ccc6e9c\/W\/measurements\.json\?start=P35D$/);
});

test('collectStation: an HTTP error throws and leaves no file', async () => {
  const out = mkdtempSync(join(tmpdir(), 'hires-'));
  await assert.rejects(collectStation(KOELN, { out, fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  assert.equal(existsSync(join(out, KOELN)), false);
});

test('the collected set is addressed by UUID and names the Rhine KOBLENZ, not the Mosel one', () => {
  assert.equal(STATIONS['4c7d796a-39f2-4f26-97a9-3aad01713e29'], 'KOBLENZ');
  assert.equal(Object.keys(STATIONS).length, 8);
  for (const uuid of Object.keys(STATIONS)) assert.match(uuid, /^[0-9a-f-]{36}$/);
});
