// scripts/fetch-nrw-archive.mjs — the pure functions the first gate run on
// the real tree caught out (2026-09-04, root causes measured 2026-09-06):
//   1. a partial day's minimum is not a day minimum: the fine window's first
//      day starts 15:15, and at 9 of 252 gauges its "min" sat above the
//      source's own day mean (N5 red)
//   2. a series the portal advertises but never fills is not a tier-2
//      success: four Rur gauges deliver [ts, null, accuracy] rows only, the
//      collector counted them and the topology listed them without a shard
//      (N1 red)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { condenseHires, dayMin, stepOf, tier2Series, seriesHasValues, dayOf, readRawDir, readSha256Sums,
  classifyFailure, fetchBulk, fetchJson, missingTables, PRODUCTS } from '../scripts/fetch-nrw-archive.mjs';

test('classifyFailure: undici fetch failed carries the connect timeout in its cause', () => {
  const cause = Object.assign(new Error('Connect Timeout Error (attempted address: hochwasserportal.nrw:443, timeout: 10000ms)'),
    { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' });
  const err = new TypeError('fetch failed', { cause });
  assert.deepEqual(classifyFailure(err), { kind: 'source-unreachable', code: 'UND_ERR_CONNECT_TIMEOUT' });
  assert.deepEqual(classifyFailure(new Error('wrapped again', { cause: err })), classifyFailure(err));
});

for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
  test(`classifyFailure: ${code} is a source outage`, () => {
    const err = Object.assign(new Error('network failed'), { code });
    assert.deepEqual(classifyFailure(err), { kind: 'source-unreachable', code });
    assert.deepEqual(classifyFailure(new TypeError('fetch failed', { cause: err })), { kind: 'source-unreachable', code });
  });
}

test('classifyFailure: AbortSignal.timeout uses TimeoutError, not AbortError', () => {
  const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.deepEqual(classifyFailure(err), { kind: 'source-unreachable', code: 'TimeoutError' });
  assert.equal(classifyFailure(new DOMException('cancelled', 'AbortError')).kind, 'pipeline-failure');
});

test('classifyFailure: parsing, replay and unknown errors stay pipeline failures', () => {
  for (const err of [new SyntaxError('bad JSON'), new Error('gate N1 failed'),
    Object.assign(new Error('missing seed'), { code: 'ENOENT' }), new Error('HTTP 503 for a URL')]) {
    assert.deepEqual(classifyFailure(err), { kind: 'pipeline-failure', code: err.code || err.name });
  }
  const forged = Object.assign(new Error('odd code'), { code: 'X\nfailure_kind=source-unreachable' });
  assert.equal(classifyFailure(forged).code, 'X_failure_kind_source-unreachable');
  const cycle = new Error('circular cause');
  cycle.cause = cycle;
  assert.equal(classifyFailure(cycle).kind, 'pipeline-failure');
});

test('HTTP status from either fetch path: 5xx is a source outage, 4xx is a pipeline failure', async () => {
  for (const status of [400, 404, 499, 500, 503, 599]) {
    const fetchImpl = async () => ({ ok: false, status });
    for (const bulk of [true, false]) {
      const run = () => bulk ? fetchBulk(fetchImpl) : fetchJson('https://example.invalid/data', fetchImpl);
      // Tier 2's missing station remains an expected null, unlike a missing bulk download.
      if (status === 404 && !bulk) { assert.equal(await run(), null); continue; }
      await assert.rejects(run, err => {
        assert.equal(err.status, status);
        assert.match(err.message, new RegExp(`^HTTP ${status} for https://`));
        assert.equal(classifyFailure(err).kind, status >= 500 ? 'source-unreachable' : 'pipeline-failure');
        if (status >= 500) assert.equal(classifyFailure(err).code, `HTTP_${status}`);
        return true;
      });
    }
  }
});

test('readRawDir: a seed with SHA256SUMS is checked, a tampered file refuses to replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nrw-seed-'));
  const files = { 'stations.json': '[]', 'pegeldaten.zip': 'p', 'niederschlagsdaten.zip': 'n', 'temperaturdaten.zip': 't' };
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  // as `shasum -a 256 "$D"/*` wrote the real one: hash, two spaces, the path as the writer's cwd spelled it
  writeFileSync(join(dir, 'SHA256SUMS'), Object.entries(files)
    .map(([n, c]) => `${createHash('sha256').update(c).digest('hex')}  tmp-nrw/raw/2026-09-04/${n}`).join('\n') + '\n');
  assert.equal(readSha256Sums(join(dir, 'SHA256SUMS')).size, 4);
  assert.deepEqual(readRawDir(dir).stations, []);
  writeFileSync(join(dir, 'pegeldaten.zip'), 'tampered');
  assert.throws(() => readRawDir(dir), /raw seed pegeldaten\.zip: sha256 [0-9a-f]{64} does not match SHA256SUMS/);
  rmSync(join(dir, 'SHA256SUMS'));
  assert.equal(readSha256Sums(join(dir, 'SHA256SUMS')), null);
  assert.doesNotThrow(() => readRawDir(dir), 'no sums file, no check — a seed without one still replays');
});

const stamp = (day, minuteOfDay) => {
  const hh = Math.floor(minuteOfDay / 60), mm = minuteOfDay % 60;
  return `2026-07-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000+01:00`;
};
// [ts, value] rows every `step` minutes from `from` to `to` (inclusive), value = 100 + minute/100
const series = (day, from, to, step, skip = () => false) => {
  const rows = [];
  for (let m = from; m <= to; m += step) if (!skip(m)) rows.push([stamp(day, m), 100 + m / 100]);
  return rows;
};
const D3 = dayOf(stamp(3, 0)).d, D4 = dayOf(stamp(4, 0)).d;

test('condenseHires: the day the window enters at 15:15 keeps n but carries no min', () => {
  const rows = [...series(3, 15 * 60 + 15, 23 * 60 + 45, 15), ...series(4, 0, 23 * 60 + 45, 15)];
  const yr = condenseHires(rows).get(2026);
  assert.equal(yr.n[D3], 35);
  assert.equal(yr.full[D3], false);
  assert.equal(yr.n[D4], 96);
  assert.equal(yr.full[D4], true);
  const min = dayMin(yr);
  assert.equal(min[D3], null);
  assert.equal(min[D4], 100);
  assert.equal(yr.min[D3], 100 + (15 * 60 + 15) / 100); // the raw extreme stays for the cross-check
  assert.equal(yr.mean[D4], 107.125); // 100 + (0 + 1425) / 2 / 100
});

test('condenseHires: a gap inside the day is the source\'s, the day stays full', () => {
  const rows = series(4, 0, 23 * 60 + 45, 15, m => m >= 10 * 60 && m < 12 * 60);
  const yr = condenseHires(rows).get(2026);
  assert.equal(yr.n[D4], 96 - 8);
  assert.equal(yr.full[D4], true);
  assert.equal(dayMin(yr)[D4], 100);
});

test('condenseHires: a hole big enough to hide the day\'s minimum takes the day\'s min away', () => {
  // the span test sees only the two outer samples, so a day can run 00:00 →
  // 23:45 around a hole of hours and still look complete. Four hours out of
  // 96 samples: 80 left, under the 87 the 90 % floor demands.
  const holed = series(4, 0, 23 * 60 + 45, 15, m => m >= 10 * 60 && m < 14 * 60);
  const yr = condenseHires(holed).get(2026);
  assert.equal(yr.n[D4], 96 - 16, 'n is written regardless — honestly partial');
  assert.equal(yr.full[D4], false, 'a day covered to 83 % is not a full day');
  assert.equal(dayMin(yr)[D4], null, 'and it ships no minimum');
  // the same day without the hole is untouched
  const whole = condenseHires(series(4, 0, 23 * 60 + 45, 15)).get(2026);
  assert.equal(whole.n[D4], 96);
  assert.equal(whole.full[D4], true);
  assert.equal(dayMin(whole)[D4], 100);
});

test('condenseHires: the last sample closes the day only within one step, at 5 minutes too', () => {
  const closed = condenseHires(series(4, 0, 23 * 60 + 55, 5)).get(2026);
  assert.equal(stepOf(series(4, 0, 23 * 60 + 55, 5)), 300);
  assert.equal(closed.n[D4], 288);
  assert.equal(closed.full[D4], true);
  const cut = condenseHires(series(4, 0, 23 * 60 + 40, 5)).get(2026); // the export stopped at 23:40
  assert.equal(cut.full[D4], false);
  assert.equal(dayMin(cut)[D4], null);
  const late = condenseHires(series(4, 15, 23 * 60 + 45, 15)).get(2026); // first sample 00:15: within one step
  assert.equal(late.full[D4], true);
  const later = condenseHires(series(4, 30, 23 * 60 + 45, 15)).get(2026); // 00:30 is not
  assert.equal(later.full[D4], false);
});

test('condenseHires: a rain day runs 07:00 to 07:00 and is judged against that boundary', () => {
  const rows = [];
  for (let h = 7; h < 24; h++) rows.push([stamp(4, h * 60), h]);
  for (let h = 0; h < 7; h++) rows.push([stamp(5, h * 60), h]);
  const yr = condenseHires(rows, { boundaryHour: 7 }).get(2026);
  assert.equal(yr.n[D4], 24);
  assert.equal(yr.full[D4], true);
  assert.equal(yr.max[D4], 23);
  const short = condenseHires(rows.slice(0, 12), { boundaryHour: 7 }).get(2026); // 07:00–18:00 only
  assert.equal(short.full[D4], false);
});

test('dayMin without full flags is all null, never a guess', () => {
  assert.deepEqual(dayMin({ min: [1, 2, 3] }), [null, null, null]);
});

const nullDoc = () => ['Day.Mean.B.Imp.Inter.W', 'Day.Max.B.Imp.Inter.W'].map(short => ({
  ts_shortname: short, ts_unitsymbol: 'cm',
  data: [[stamp(3, 0), null, 68.75], [stamp(4, 0), null, 98.96], [stamp(5, 0), null, 100]],
}));

test('tier2Series: an advertised series with accuracies but no values folds to nothing', () => {
  const { years, unknown } = tier2Series(nullDoc(), 0, [-500, 5000]);
  assert.deepEqual(unknown, []);
  assert.equal(seriesHasValues(years), false);
});

test('tier2Series: one real value is enough to count as a series', () => {
  const doc = nullDoc();
  doc[0].data[1] = [stamp(4, 0), 98.96, 100];
  const { years } = tier2Series(doc, 0, [-500, 5000]);
  assert.equal(seriesHasValues(years), true);
  assert.equal(years.get(2026).mean[D4], 98.96);
});

test('seriesHasValues: rain sums count, an empty map does not', () => {
  assert.equal(seriesHasValues(new Map()), false);
  assert.equal(seriesHasValues(new Map([[2026, { y: 2026, mm: [null, 0.4] }]])), true);
  assert.equal(seriesHasValues(new Map([[2026, { y: 2026, mm: [null, null] }]])), false);
});

// 2026-10-27: pegeldaten.zip shipped without pegel_messwerte.txt and the whole
// run refused, stalling the day tables, rain and temperature with it
test('missingTables: only a fine series may be absent, every other table still stops the run', () => {
  assert.deepEqual(missingTables(['pegel_messwerte.txt'], PRODUCTS.gauges), { required: [], optional: ['pegel_messwerte.txt'] });
  for (const p of Object.values(PRODUCTS)) {
    const { hires, ...rest } = p.tables;
    assert.deepEqual(missingTables([hires], p).required, [], p.zip);
    for (const name of Object.values(rest)) {
      assert.deepEqual(missingTables([name, hires], p), { required: [name], optional: [hires] }, `${p.zip} ${name}`);
    }
  }
  assert.deepEqual(missingTables([], PRODUCTS.rain), { required: [], optional: [] });
});
