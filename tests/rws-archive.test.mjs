import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchYear, fetchStation } from '../scripts/fetch-rws-archive.mjs';

// The DD-API returns tide FORECASTS for future timestamps (notably the 4 tidal
// gauges VUREN, DORDRECHT, KRIMPEN, ROTTERDAM). fetchYear must never request or
// keep a point past "now": the running year's Einddatumtijd is capped at now,
// and any returned measurement timestamped after now is dropped regardless of
// which year it claims to be in.

// fetch-rws-archive.mjs reads PEGEL_NOW at module load, so a pinned-clock
// scenario needs its own process (mirrors tests/logic.test.mjs's runWithClock).
function runWithClock(nowIso, code) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PEGEL_NOW: nowIso },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  }));
}

test('rws archive: running year Einddatumtijd is capped at now', () => {
  const out = runWithClock('2026-07-16T12:00:00Z', `
    import { fetchYear } from './scripts/fetch-rws-archive.mjs';
    let captured;
    const fake = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { status: 204 };
    };
    await fetchYear('rotterdam.nieuwemaas.boerengat', 2026, fake);
    console.log(JSON.stringify(captured.Periode));
  `);
  // now = 2026-07-16T12:00:00Z -> +1h wall clock -> 2026-07-16T13:00:00+01:00
  assert.equal(out.Begindatumtijd, '2026-01-01T00:00:00+01:00', 'start of year is untouched');
  assert.equal(out.Einddatumtijd, '2026-07-16T13:00:00+01:00', 'end of window is capped at now, not Dec 31');
});

test('rws archive: a closed year still requests the full calendar year', () => {
  const out = runWithClock('2026-07-16T12:00:00Z', `
    import { fetchYear } from './scripts/fetch-rws-archive.mjs';
    let captured;
    const fake = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { status: 204 };
    };
    await fetchYear('rotterdam.nieuwemaas.boerengat', 2024, fake);
    console.log(JSON.stringify(captured.Periode));
  `);
  assert.equal(out.Begindatumtijd, '2024-01-01T00:00:00+01:00');
  assert.equal(out.Einddatumtijd, '2024-12-31T23:59:59+01:00', 'a past year is unaffected by the clamp');
});

test('rws archive: future-timestamped measurements are dropped from the running year', () => {
  const out = runWithClock('2026-07-16T12:00:00Z', `
    import { fetchYear } from './scripts/fetch-rws-archive.mjs';
    const fake = async () => ({ status: 200, json: async () => ({ Succesvol: true, WaarnemingenLijst: [{ MetingenLijst: [
      { Tijdstip: '2026-07-16T12:00:00+01:00', Meetwaarde: { Waarde_Numeriek: 100 } }, // just before now
      { Tijdstip: '2026-07-16T13:30:00+01:00', Meetwaarde: { Waarde_Numeriek: 200 } }, // tide forecast, after now
      { Tijdstip: '2026-12-31T23:00:00+01:00', Meetwaarde: { Waarde_Numeriek: 300 } }, // way past now
    ] }] }) });
    const pts = await fetchYear('rotterdam.nieuwemaas.boerengat', 2026, fake);
    console.log(JSON.stringify(pts));
  `);
  assert.deepEqual(out, [{ timestamp: '2026-07-16T12:00:00+01:00', value: 100 }],
    'only the measurement at or before now survives');
});

test('rws archive: the future-timestamp guard also applies to a closed year (belt-and-braces)', () => {
  const out = runWithClock('2026-07-16T12:00:00Z', `
    import { fetchYear } from './scripts/fetch-rws-archive.mjs';
    const fake = async () => ({ status: 200, json: async () => ({ Succesvol: true, WaarnemingenLijst: [{ MetingenLijst: [
      { Tijdstip: '2024-06-01T12:00:00+02:00', Meetwaarde: { Waarde_Numeriek: 705 } },
    ] }] }) });
    const pts = await fetchYear('rotterdam.nieuwemaas.boerengat', 2024, fake);
    console.log(JSON.stringify(pts));
  `);
  assert.deepEqual(out, [{ timestamp: '2024-06-01T12:00:00+02:00', value: 705 }],
    'a genuinely past point in a closed year is unaffected');
});

test('rws archive: fetchYear under the real clock still caps the current running year', async () => {
  const currentYear = new Date().getUTCFullYear();
  let captured;
  const before = Date.now();
  const fake = async (url, opts) => { captured = JSON.parse(opts.body); return { status: 204 }; };
  await fetchYear('rotterdam.nieuwemaas.boerengat', currentYear, fake);
  const after = Date.now();
  assert.notEqual(captured.Periode.Einddatumtijd, `${currentYear}-12-31T23:59:59+01:00`,
    'the running year never requests through Dec 31');
  // Einddatumtijd carries an explicit +01:00 offset, so Date.parse recovers
  // the real UTC instant directly — no manual offset math needed.
  const capped = Date.parse(captured.Periode.Einddatumtijd);
  // The module caches `now` at import time, and the runWithClock subprocess
  // tests above run first in this file — so by the time this test executes,
  // `capped` sits seconds behind Date.now(). The exact cap-equals-now claim is
  // proven by the pinned-clock tests; here only assert the default path tracks
  // the real clock at all (recent, not Dec 31, not epoch) with a window wide
  // enough that scheduling can never flake it.
  assert.ok(capped >= before - 300000 && capped <= after, 'capped instant tracks the real clock (within minutes)');
});

// fetchStation isolates a transient error per (code, year) so one bad year
// cannot discard a whole backfill. The cost of that isolation: the caller sees
// no exception, so a station whose every year failed used to be counted as
// fetched. Measured with the network cut before this was fixed: "10 fetched,
// 0 failed", exit code 0, on a run that imported nothing at all.
test('fetchStation reports the failed years it swallowed', async () => {
  const st = { name: 'LOBITH', code: 'lobith.bovenrijn', uuid: 'u-lobith' };

  const dead = await fetchStation(st, 2026, 2026, async () => { throw new Error('fetch failed'); });
  assert.equal(dead.pts, 0, 'nothing came back');
  assert.equal(dead.failed, 1, 'the swallowed year is still reported to the caller');
  assert.equal(dead.years.size, 0);
  // this pair — no points, and a year that explicitly failed — is what the
  // caller now classifies as a failed station rather than a fetched one
  assert.ok(dead.pts === 0 && dead.failed > 0, 'asked for, errored, nothing back');

  // an empty-but-healthy answer is NOT a failure: nothing errored, so a silent
  // gauge must not turn a run red
  const quiet = await fetchStation(st, 2026, 2026, async () => ({ status: 204 }));
  assert.equal(quiet.pts, 0);
  assert.equal(quiet.failed, 0, 'a 204 is an answer, not an error');
  assert.ok(!(quiet.pts === 0 && quiet.failed > 0), 'a quiet gauge stays green');
});
