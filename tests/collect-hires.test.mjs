import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATIONS, STEP_MS, collectStation, gapCount, merge, normalize } from '../scripts/forecast/collect-hires.mjs';

const KOELN = 'a6ee8177-107b-47dd-bcfd-30960ccc6e9c';

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

test('gapCount counts holes wider than one 15-minute step', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const pts = [0, 1, 2, 4, 5, 9].map(k => [new Date(t0 + k * STEP_MS).toISOString(), k]);
  assert.equal(gapCount(pts), 2);
  assert.equal(gapCount([]), 0);
});

test('collectStation: writes the doc, merges across runs, records each run (no network)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'hires-'));
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const batch = (from, n) => Array.from({ length: n }, (_, i) => ({ timestamp: new Date(t0 + (from + i) * STEP_MS).toISOString(), value: 300 + i }));
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return { ok: true, json: async () => batch(calls.length === 1 ? 0 : 5, 10) }; };
  const r1 = await collectStation(KOELN, { out, fetchImpl, now: new Date('2026-09-01T12:00:00Z') });
  assert.equal(r1.fetched, 10);
  assert.equal(r1.added, 10);
  const r2 = await collectStation(KOELN, { out, fetchImpl, now: new Date('2026-09-08T12:00:00Z') });
  assert.equal(r2.added, 5, 'overlap is merged, not duplicated');
  assert.equal(r2.total, 15);
  const doc = JSON.parse(readFileSync(join(out, `${KOELN}.json`), 'utf8'));
  assert.equal(doc.name, 'KÖLN');
  assert.equal(doc.points.length, 15);
  assert.equal(doc.runs.length, 2);
  assert.match(calls[0], /\/stations\/a6ee8177-107b-47dd-bcfd-30960ccc6e9c\/W\/measurements\.json\?start=P35D$/);
});

test('collectStation: an HTTP error throws and leaves no file', async () => {
  const out = mkdtempSync(join(tmpdir(), 'hires-'));
  await assert.rejects(collectStation(KOELN, { out, fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('the collected set is addressed by UUID and names the Rhine KOBLENZ, not the Mosel one', () => {
  assert.equal(STATIONS['4c7d796a-39f2-4f26-97a9-3aad01713e29'], 'KOBLENZ');
  assert.equal(Object.keys(STATIONS).length, 8);
  for (const uuid of Object.keys(STATIONS)) assert.match(uuid, /^[0-9a-f-]{36}$/);
});
