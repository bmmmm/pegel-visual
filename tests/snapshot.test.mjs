import test from 'node:test';
import assert from 'node:assert/strict';
import { mezParts, daysInMonth, emptyShard, applySnapshot, parseBulkForSnapshot, shardIsPrunable, shardName, medianDailySpan, TIDAL_SPAN_CM, plausibilityEnvelope, implausibleCapture, lastCapturedValue, ENVELOPE_FLOOR_CM } from '../scripts/snapshot-wsv.mjs';

test('daysInMonth: month lengths incl. leap years', () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28); // century non-leap
  assert.equal(daysInMonth(2026, 12), 31);
});

test('mezParts: the day flips at MEZ midnight, not UTC midnight', () => {
  // 23:30 UTC on Mar 31 is already 00:30 MEZ on Apr 1
  assert.deepEqual(mezParts(new Date('2026-03-31T23:30:00Z')), { y: 2026, m: 4, dayIdx: 0 });
  assert.deepEqual(mezParts(new Date('2026-03-31T22:30:00Z')), { y: 2026, m: 3, dayIdx: 30 });
  // ...and the year flips the same way
  assert.deepEqual(mezParts(new Date('2026-12-31T23:30:00Z')), { y: 2027, m: 1, dayIdx: 0 });
});

test('shardName: zero-padded month', () => {
  assert.equal(shardName(2026, 8), '2026-08.json');
  assert.equal(shardName(2026, 12), '2026-12.json');
});

test('emptyShard: day-sized null arrays', () => {
  const s = emptyShard(2026, 2);
  assert.equal(s.days.length, 28);
  assert.ok(s.days.every(d => d === null));
  assert.deepEqual(s.stations, {});
});

test('applySnapshot: writes one day slot, re-running the same day overwrites it', () => {
  const capture = { dayIdx: 4, captureIso: '2026-08-05T15:17:00Z', stations: [{ uuid: 'a', n: 'BONN', w: 'RHEIN', v: 172 }] };
  const one = applySnapshot(emptyShard(2026, 8), capture);
  assert.equal(one.days[4], '2026-08-05T15:17:00Z');
  assert.equal(one.stations.a.v.length, 31);
  assert.equal(one.stations.a.v[4], 172);
  assert.equal(one.stations.a.v[3], null);

  // idempotency: a same-day re-run replaces, never appends
  const again = applySnapshot(one, { ...capture, captureIso: '2026-08-05T18:00:00Z', stations: [{ uuid: 'a', n: 'BONN', w: 'RHEIN', v: 175 }] });
  assert.equal(again.days[4], '2026-08-05T18:00:00Z');
  assert.equal(again.stations.a.v[4], 175);
  assert.equal(again.stations.a.v.length, 31);
});

test('applySnapshot: a station absent from a later run keeps its earlier days', () => {
  const day4 = applySnapshot(emptyShard(2026, 8), {
    dayIdx: 4, captureIso: '2026-08-05T15:17:00Z',
    stations: [{ uuid: 'a', n: 'BONN', w: 'RHEIN', v: 172 }, { uuid: 'b', n: 'KÖLN', w: 'RHEIN', v: 140 }],
  });
  const day5 = applySnapshot(day4, {
    dayIdx: 5, captureIso: '2026-08-06T15:17:00Z',
    stations: [{ uuid: 'a', n: 'BONN', w: 'RHEIN', v: 180 }], // b missing today
  });
  assert.equal(day5.stations.b.v[4], 140, "yesterday's value survives");
  assert.equal(day5.stations.b.v[5], null, 'the missing day stays null, not copied forward');
  assert.equal(day5.days[5], '2026-08-06T15:17:00Z');
  // and the input shard was not mutated
  assert.equal(day4.stations.a.v[5], null);
  assert.equal(day4.days[5], null);
});

test('parseBulkForSnapshot: W stations only, missing values become null entries', () => {
  const raw = [
    { uuid: 'a', shortname: 'BONN', water: { shortname: 'RHEIN' }, timeseries: [
      { shortname: 'Q' },
      { shortname: 'W', currentMeasurement: { timestamp: 'x', value: 76.0, stateMnwMhw: 'low' } },
    ] },
    { uuid: 'b', shortname: 'STALE', water: { shortname: 'X' }, timeseries: [{ shortname: 'W' }] },
    { uuid: 'c', shortname: 'NO-W', water: { shortname: 'X' }, timeseries: [{ shortname: 'Q' }] },
  ];
  const out = parseBulkForSnapshot(raw);
  assert.deepEqual(out, [
    { uuid: 'a', n: 'BONN', w: 'RHEIN', v: 76 },
    { uuid: 'b', n: 'STALE', w: 'X', v: null }, // kept: its name/water survive, the day stays null
  ]);
});

test('applySnapshot: the tidal flag reflects the current run, never sticks', () => {
  const flagged = applySnapshot(emptyShard(2026, 8), {
    dayIdx: 4, captureIso: '2026-08-05T15:17:00Z',
    stations: [{ uuid: 'a', n: 'ROTTERDAM', w: 'NEUE_MAAS', v: 10, t: 1 }],
  });
  assert.equal(flagged.stations.a.t, 1);
  // next run cannot judge (e.g. no archive checkout) → the flag drops off
  const unflagged = applySnapshot(flagged, {
    dayIdx: 5, captureIso: '2026-08-06T15:17:00Z',
    stations: [{ uuid: 'a', n: 'ROTTERDAM', w: 'NEUE_MAAS', v: 12 }],
  });
  assert.equal(unflagged.stations.a.t, undefined);
  assert.equal(unflagged.stations.a.v[4], 10, 'values still accumulate across the flag change');
});

test('medianDailySpan: robust median over the non-null days', () => {
  const bundle = (spans) => ({
    y: 2026,
    min: spans.map(s => s == null ? null : 100),
    max: spans.map(s => s == null ? null : 100 + s),
  });
  // a river: mostly quiet, one flood day — the median ignores the outlier
  assert.equal(medianDailySpan(bundle([4, 5, null, 6, 4, 5, 6, 4, 5, 6, 4, 5, 6, 4, 180])), 5);
  // a tidal gauge sits far above the threshold
  assert.ok(medianDailySpan(bundle(Array(20).fill(200))) >= TIDAL_SPAN_CM);
  // too thin to judge (fresh January bundle): null, not a guess
  assert.equal(medianDailySpan(bundle([4, 5, 6])), null);
  assert.equal(medianDailySpan(null), null);
});

test('shardIsPrunable: strictly older than max-months, in MEZ', () => {
  const ref = new Date('2026-08-20T12:00:00Z');
  assert.equal(shardIsPrunable(2026, 8, ref, 1), false, 'the running month stays');
  assert.equal(shardIsPrunable(2026, 7, ref, 1), false, 'exactly max-months old stays');
  assert.equal(shardIsPrunable(2026, 6, ref, 1), true);
  assert.equal(shardIsPrunable(2025, 8, ref, 12), false);
  assert.equal(shardIsPrunable(2025, 7, ref, 12), true);
});

// ---------- the plausibility gate (LOBITH 2026-08-18/19: isolated 2000+cm points) ----------

// year bundle fixture: `days` entries of [min, max], null = gap
const bundle = (y, days) => ({
  y,
  min: days.map(d => d && d[0]),
  max: days.map(d => d && d[1]),
});

test('plausibilityEnvelope: observed range widened by span/range/floor, whichever is widest', () => {
  const quiet = bundle(2026, Array(20).fill([500, 505])); // range 5, span 5
  const env = plausibilityEnvelope([quiet]);
  assert.deepEqual(env, { lo: 500 - ENVELOPE_FLOOR_CM, hi: 505 + ENVELOPE_FLOOR_CM },
    'a quiet gauge gets the floor margin');
  const tidal = bundle(2026, Array(20).fill([100, 350])); // span 250 -> margin 1000
  assert.deepEqual(plausibilityEnvelope([tidal]), { lo: 100 - 1000, hi: 350 + 1000 });
  const flood = bundle(2026, [...Array(19).fill([200, 210]), [1180, 1200]]); // range 1000 -> margin 250
  assert.deepEqual(plausibilityEnvelope([flood]), { lo: 200 - 250, hi: 1200 + 250 });
});

test('plausibilityEnvelope: too thin to judge, or no record at all, is null', () => {
  assert.equal(plausibilityEnvelope([bundle(2026, Array(13).fill([500, 505]))]), null);
  assert.equal(plausibilityEnvelope([null, null]), null);
  const split = [bundle(2025, Array(7).fill([500, 505])), bundle(2026, Array(7).fill([510, 515]))];
  assert.ok(plausibilityEnvelope(split), 'days accumulate across bundles');
});

test('implausibleCapture: the isolated LOBITH spike falls, the vouched-for record flood passes', () => {
  const envelope = { lo: -364, hi: 1697 }; // LOBITH's measured 2026 envelope
  assert.equal(implausibleCapture({ v: 614, envelope, prev: 610, span: 15 }), false, 'a normal day');
  assert.equal(implausibleCapture({ v: 2013, envelope, prev: 614, span: 15 }), true,
    'the sensor artifact stands alone — yesterday was 614');
  assert.equal(implausibleCapture({ v: 1750, envelope, prev: 1680, span: 15 }), false,
    'a record flood arrives over days — yesterday already vouches');
  assert.equal(implausibleCapture({ v: 2013, envelope, prev: null, span: 15 }), true,
    'outside the envelope with no capture history, nobody vouches');
});

test('implausibleCapture: without an envelope only the sentinel bounds judge', () => {
  assert.equal(implausibleCapture({ v: 99999, envelope: null, prev: null, span: null }), true);
  assert.equal(implausibleCapture({ v: -0.87, envelope: null, prev: null, span: null }), false,
    'an m+NN gauge value passes the absolute bounds');
});

test('lastCapturedValue: scans the current shard backwards, then the previous month', () => {
  const cur = applySnapshot(emptyShard(2026, 9), {
    dayIdx: 0, captureIso: 'x', stations: [{ uuid: 'a', n: 'A', w: 'W', v: null }],
  });
  const prev = applySnapshot(emptyShard(2026, 8), {
    dayIdx: 30, captureIso: 'y', stations: [{ uuid: 'a', n: 'A', w: 'W', v: 614 }],
  });
  assert.equal(lastCapturedValue([cur, prev], 'a'), 614, 'day-1 runs reach into the previous month');
  const cur2 = applySnapshot(cur, { dayIdx: 1, captureIso: 'z', stations: [{ uuid: 'a', n: 'A', w: 'W', v: 620 }] });
  assert.equal(lastCapturedValue([cur2, prev], 'a'), 620);
  assert.equal(lastCapturedValue([null, prev], 'b'), null, 'unknown station');
});
