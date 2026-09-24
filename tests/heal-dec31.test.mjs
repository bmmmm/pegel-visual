// scripts/heal-dec31.mjs — the one-off repair of the Dec 31 flattening that
// every ZIP request ending at `Y-12-31` froze into closed.json (issue #17).
// The fixture is BONN's real 2025 tail as the archive branch held it on
// 2026-09-24 (Dec 30 172/178, Dec 31 172/172); a live probe that day healed
// it to 168/172.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flattenedYears, healStation } from '../scripts/heal-dec31.mjs';
import { daysInYear } from '../scripts/fetch-wsv-archive.mjs';

const scratch = [];
const tmp = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); scratch.push(d); return d; };
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// a closed year with a real span on every day, then the tail overridden
const year = (y, tail = {}) => {
  const n = daysInYear(y);
  const yr = { y, min: Array.from({ length: n }, (_, d) => 200 + (d % 7)), max: Array.from({ length: n }, (_, d) => 220 + (d % 7)) };
  for (const [back, [lo, hi]] of Object.entries(tail)) { yr.min[n - 1 - back] = lo; yr.max[n - 1 - back] = hi; }
  return yr;
};
const flat2025 = () => year(2025, { 0: [172, 172], 1: [172, 178] }); // BONN, as committed
const good2024 = () => year(2024, { 0: [311, 331], 1: [331, 353] });
// a coarse gauge: one reading a day, every day flat — nothing to heal
const coarse2023 = () => { const yr = year(2023); yr.max = yr.min.slice(); return yr; };

function station(years) {
  const dir = join(tmp('pegel-heal-'), 'uuid-bonn');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'closed.json'), JSON.stringify(years));
  return dir;
}

// what the ZIP endpoint hands back for Dec 30 .. Jan 1: raw points in the
// archive's UTC+1 stamps, a different Dec 30 (must stay untouched) and the
// Jan 1 midnight sliver (must never become a year)
const bonnWindow = (dec31 = [172, 170, 168, 171]) => [
  { timestamp: '2025-12-30T12:00:00+01:00', value: 150 },
  ...dec31.map((value, i) => ({ timestamp: `2025-12-31T${String(i * 6).padStart(2, '0')}:00:00+01:00`, value })),
  { timestamp: '2026-01-01T00:00:00+01:00', value: 999 },
];

function recorder(answer) {
  const calls = [];
  const fetchRange = async (uuid, start, end) => { calls.push({ uuid, start, end }); return answer(uuid, start, end); };
  return { calls, fetchRange };
}

test('flattenedYears picks the flat Dec 31 and leaves good and coarse years alone', () => {
  assert.deepEqual(flattenedYears([coarse2023(), good2024(), flat2025()]), [2025]);
  assert.deepEqual(flattenedYears(null), [], 'a station without closed.json has nothing to heal');
});

test('a flattened Dec 31 is healed from a Dec 30..Jan 1 window, and nothing else changes', async () => {
  const dir = station([coarse2023(), good2024(), flat2025()]);
  const before = JSON.parse(readFileSync(join(dir, 'closed.json'), 'utf8'));
  const { calls, fetchRange } = recorder(() => bonnWindow());

  const r = await healStation(dir, 'uuid-bonn', { fetchRange, throttleMs: 0 });

  assert.deepEqual(calls, [{ uuid: 'uuid-bonn', start: '2025-12-30', end: '2026-01-01' }],
    'one small request per flattened year — never the good or the coarse one, never a 12-31 end');
  assert.deepEqual(r, { targets: 1, fetched: 1, healed: 1, failed: 0, stopped: false });
  const out = JSON.parse(readFileSync(join(dir, 'closed.json'), 'utf8'));
  assert.deepEqual(out.map(yr => yr.y), [2023, 2024, 2025], 'the Jan 1 sliver never becomes a 2026 year');
  const healed = out[2], n = healed.min.length;
  assert.deepEqual([healed.min[n - 1], healed.max[n - 1]], [168, 172], 'BONN 2025-12-31 reads 168/172');
  assert.deepEqual([healed.min[n - 2], healed.max[n - 2]], [172, 178], 'Dec 30 in the answer is ignored');
  for (let d = 0; d < n - 1; d++) {
    assert.equal(healed.min[d], before[2].min[d], `day ${d} min untouched`);
    assert.equal(healed.max[d], before[2].max[d], `day ${d} max untouched`);
  }
  assert.equal(JSON.stringify(out[0]), JSON.stringify(before[0]), 'the coarse year is byte-identical');
  assert.equal(JSON.stringify(out[1]), JSON.stringify(before[1]), 'the good year is byte-identical');
});

test('the midnight reading the flat day already holds survives the merge', async () => {
  // an answer whose Dec 31 lacks the 172 still cannot take it away (extreme union)
  const dir = station([flat2025()]);
  const { fetchRange } = recorder(() => bonnWindow([170, 168, 171]));
  await healStation(dir, 'uuid-bonn', { fetchRange, throttleMs: 0 });
  const [yr] = JSON.parse(readFileSync(join(dir, 'closed.json'), 'utf8'));
  assert.deepEqual([yr.min.at(-1), yr.max.at(-1)], [168, 172]);
});

test('a second run is a no-op: no request, closed.json byte-identical', async () => {
  const dir = station([good2024(), flat2025()]);
  await healStation(dir, 'uuid-bonn', { fetchRange: recorder(() => bonnWindow()).fetchRange, throttleMs: 0 });
  const healedBytes = readFileSync(join(dir, 'closed.json'), 'utf8');

  const again = recorder(() => bonnWindow());
  const r = await healStation(dir, 'uuid-bonn', { fetchRange: again.fetchRange, throttleMs: 0 });
  assert.deepEqual(again.calls, [], 'a healed year no longer matches, so a re-run resumes instead of repeating');
  assert.equal(r.healed, 0);
  assert.equal(readFileSync(join(dir, 'closed.json'), 'utf8'), healedBytes);

  const good = station([good2024()]);
  const goodBytes = readFileSync(join(good, 'closed.json'), 'utf8');
  const none = recorder(() => bonnWindow());
  await healStation(good, 'uuid-bonn', { fetchRange: none.fetchRange, throttleMs: 0 });
  assert.deepEqual(none.calls, []);
  assert.equal(readFileSync(join(good, 'closed.json'), 'utf8'), goodBytes, 'an already-good station is never rewritten');
});

test('an answer without Dec 31, or a thrown fetch, is a failure and leaves the file alone', async () => {
  for (const answer of [() => [], () => { throw new Error('prepare failed (502, no redirect)'); }]) {
    const dir = station([flat2025()]);
    const bytes = readFileSync(join(dir, 'closed.json'), 'utf8');
    const r = await healStation(dir, 'uuid-bonn', { fetchRange: recorder(answer).fetchRange, throttleMs: 0 });
    assert.deepEqual({ fetched: r.fetched, healed: r.healed, failed: r.failed }, { fetched: 0, healed: 0, failed: 1 },
      'the year HAS a Dec 31 reading — an empty answer is the endpoint failing, and must count toward the fail rate');
    assert.equal(readFileSync(join(dir, 'closed.json'), 'utf8'), bytes);
  }
});

test('a passed deadline stops before the next request', async () => {
  const dir = station([flat2025()]);
  const { calls, fetchRange } = recorder(() => bonnWindow());
  const r = await healStation(dir, 'uuid-bonn', { fetchRange, throttleMs: 0, deadline: Date.now() - 1 });
  assert.deepEqual(calls, []);
  assert.equal(r.stopped, true);
});

test('a leap year heals slot 365, not 364', async () => {
  // 2024 has 366 days: Dec 31 is index 365, and index 364 is Dec 30
  const dir = station([year(2024, { 0: [311, 311], 1: [331, 353] })]);
  const { calls, fetchRange } = recorder(() => [
    { timestamp: '2024-12-30T12:00:00+01:00', value: 150 },
    { timestamp: '2024-12-31T00:00:00+01:00', value: 311 },
    { timestamp: '2024-12-31T18:00:00+01:00', value: 305 },
    { timestamp: '2025-01-01T00:00:00+01:00', value: 999 },
  ]);
  await healStation(dir, 'uuid-bonn', { fetchRange, throttleMs: 0 });
  assert.deepEqual(calls.map(c => [c.start, c.end]), [['2024-12-30', '2025-01-01']]);
  const [yr] = JSON.parse(readFileSync(join(dir, 'closed.json'), 'utf8'));
  assert.equal(yr.min.length, 366);
  assert.deepEqual([yr.min[365], yr.max[365]], [305, 311]);
  assert.deepEqual([yr.min[364], yr.max[364]], [331, 353], 'Dec 30 untouched');
});

test('a --station that matches nothing fails instead of reporting nothing to heal', () => {
  const out = tmp('pegel-heal-cli-');
  mkdirSync(join(out, 'uuid-bonn'));
  writeFileSync(join(out, 'uuid-bonn', 'meta.json'), JSON.stringify({ name: 'BONN' }));
  writeFileSync(join(out, 'uuid-bonn', 'closed.json'), JSON.stringify([flat2025()]));
  const script = fileURLToPath(new URL('../scripts/heal-dec31.mjs', import.meta.url));
  const run = (...a) => spawnSync(process.execPath, [script, '--out', out, '--dry-run', ...a], { encoding: 'utf8', timeout: 20000 });
  const typo = run('--station', 'BON');
  assert.equal(typo.status, 1, typo.stdout + typo.stderr);
  assert.match(typo.stderr, /--station BON: no WSV station/);
  const hit = run('--station', 'bonn');
  assert.equal(hit.status, 0, hit.stdout + hit.stderr);
  assert.match(hit.stdout, /^1 flattened Dec 31 across 1 station/);
});
