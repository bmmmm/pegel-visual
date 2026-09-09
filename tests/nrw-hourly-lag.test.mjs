// tests/nrw-hourly-lag.test.mjs — the hourly response rule of
// scripts/build-nrw-hourly-lag.mjs, each clause on a fixture built to sit
// exactly on its edge. Everything runs on synthetic trees under a temp dir —
// no network, no mirror, no clock.
//
// Two of these tests exist because the trap they name actually fired during the
// build and cost an afternoon each:
//   - a rotation by the WINDOW LENGTH is the identity, so a permutation filter
//     without a guard band reports the real statistic as its own null;
//   - the rotation set must be DETERMINISTIC, or --check compares two runs of a
//     coin toss and looks green for weeks before it does not.
// Both are shown here as the defect first (the identity really is the identity)
// and then as the rule that excludes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const {
  buildHourlyLag, publish, estimateAll, loadBench, gaugeInputs, lagStats, arealHourly,
  hourlyAxis, rotateLevel, rotationShifts, benjaminiHochberg, classOf, reasonFor,
  inputsDigest, hiresFiles, dailyGauges,
  CLASSES, MIN_PEAK_R, ROTATIONS, FDR_Q, ROTATION_GUARD_H, MAX_LAG_H,
  LAG_RULE_VERSION, MIN_RAIN_HOUR_FRAC, WINDOW_H,
} = await import('../scripts/build-nrw-hourly-lag.mjs');
const { RULE_VERSION } = await import('../scripts/build-nrw-precip.mjs');
// The gate reads what this builder writes. Importing it here is the point: the
// two were written apart, and until this seam existed a change to the file's
// own timestamp format left all 611 tests green while the shipped file became
// unreadable to N9 — caught in CI, which is the step standing in front of a
// push whose data perishes.
const {
  checkHourlyShape, MIN_HOURLY_PUBLISHED, MIN_HOURLY_WINDOW_HOURS, MAX_HOURLY_WINDOW_HOURS,
} = await import('../scripts/check-nrw-consistency.mjs');

// ---------- fixture ----------

const HOUR = 36e5;
const H0 = Date.parse('2026-07-01T00:00:00+01:00') / HOUR;  // whole hours by construction
const N = 720;                                              // 30 days
const START = '2026-07-01T00:00:00+01:00';

// A degree of latitude on the rule's own sphere.
const latOffset = km => (km / 6371.0088) * 180 / Math.PI;
const BASE = { lat: 50.2, lon: 7.0 };
const northOf = (p, km) => ({ lat: p.lat + latOffset(km), lon: p.lon });

// Deterministic pseudo-rain: about a quarter of the hours are wet, 0.1..4.9 mm.
function rainSeries(n, seed) {
  const v = []; let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    v.push(s % 4 === 0 ? ((s % 49) + 1) / 10 : 0);
  }
  return v;
}
// A level whose hourly CHANGE is the rain of `lag` hours ago: the estimator must
// then find its peak at exactly `lag` with r = 1.
function levelForLag(rain, lag) {
  const out = []; let acc = 100;
  for (let i = 0; i < rain.length; i++) { acc += (i - lag >= 0 ? rain[i - lag] : 0); out.push(acc); }
  return out;
}
function noisyLevel(n, seed) {
  const out = []; let acc = 100, s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; acc += ((s % 21) - 10) / 10; out.push(acc); }
  return out;
}

const writeJson = (p, o) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(o)); };
const shard = (id, v) => ({ id, month: '2026-07', step: 3600, start: START, v });

// Four gauges 40 km apart (so no 15 km ring reaches a neighbour's stations),
// each with four rain stations 1..4 km away. `spec` gives each gauge its level.
function mkTrees(specs, { series = null, extraTemp = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nrw-hourly-'));
  const tree = join(dir, 'nrw'), hires = join(dir, 'nrw-hires');
  const gauges = {}, precip = {};
  specs.forEach((sp, gi) => {
    const at = northOf(BASE, gi * 40);
    gauges[sp.no] = { name: sp.no, basin: '1', siteNo: '100', water: 'X' };
    writeJson(join(tree, 'gauges', sp.no, 'meta.json'), { ...at, name: sp.no, unit: 'cm' });
    for (let k = 0; k < 4; k++) {
      const rno = `${sp.no}r${k}`;
      writeJson(join(tree, 'rain', rno, 'meta.json'), { ...northOf(at, 1 + k), name: rno, catchmentNo: '1' });
      if (sp.rain) writeJson(join(hires, 'rain', rno, '2026-07.json'), shard(rno, sp.rain));
    }
    if (sp.level) writeJson(join(hires, 'gauges', sp.no, '2026-07.json'), shard(sp.no, sp.level));
    precip[sp.no] = { n: 4, up: 1, series: series ? series(sp.no) : true };
  });
  writeJson(join(tree, 'topology.json'), { gauges, basins: {} });
  writeJson(join(tree, 'manifest.json'), { schema: 1, precip });
  if (extraTemp) writeJson(join(hires, 'temp', 'T1', '2026-07.json'), shard('T1', new Array(N).fill(1)));
  return { dir, tree, hires };
}

const RAIN = rainSeries(N, 7);
// One gauge per class, plus the three ways out of the product.
const SPECS = [
  { no: '100', rain: RAIN, level: levelForLag(RAIN, 0) },   // class 0 (0-1 h)
  { no: '200', rain: RAIN, level: levelForLag(RAIN, 5) },   // class 1 (2-8 h)
  { no: '300', rain: RAIN, level: levelForLag(RAIN, 20) },  // class 2 (9+ h)
  { no: '400', rain: RAIN, level: noisyLevel(N, 3) },       // no class: the rain explains nothing
  { no: '500', rain: RAIN, level: null },                   // no class: not in nrw-hires
  { no: '600', rain: new Array(N).fill(0).map((_, i) => (i < 10 ? 1 : 0)), level: levelForLag(RAIN, 3) }, // too few wet hours
];

let FIX;
test.before(() => { FIX = mkTrees(SPECS, { extraTemp: true }); });
test.after(() => { rmSync(FIX.dir, { recursive: true, force: true }); });

const build = (o = {}) => buildHourlyLag({
  tree: FIX.tree, hires: FIX.hires, out: join(FIX.tree, 'hourly'), generated: '2026-07-31', ...o,
});

// ---------- the estimator on a series whose answer is known ----------

test('the estimator finds the lag the fixture was built with, at r = 1', () => {
  const b = loadBench(FIX.tree, FIX.hires);
  assert.equal(b.to - b.from + 1, N);
  const est = estimateAll(b, { from: b.from, to: b.to });
  for (const [no, lag] of [['100', 0], ['200', 5], ['300', 20]]) {
    assert.equal(est.get(no).h, lag, `${no} should peak at ${lag} h`);
    assert.ok(est.get(no).r > 0.999, `${no} r ${est.get(no).r}`);
  }
  assert.ok(est.get('400').r < MIN_PEAK_R, `noise gauge r ${est.get('400').r}`);
});

test('a gauge with no hourly level is a reading, not a silent skip', () => {
  const b = loadBench(FIX.tree, FIX.hires);
  const rows = gaugeInputs(b, { from: b.from, to: b.to });
  const row = rows.find(r => r.no === '500');
  assert.equal(row.skip, 'notInHires');
  assert.match(row.why, /no hourly level series/);
  // and estimateAll drops it, exactly as it always did
  assert.equal(estimateAll(b, { from: b.from, to: b.to }).has('500'), false);
});

test('too few wet hours is named by code, not only by a sentence carrying its own numbers', () => {
  const b = loadBench(FIX.tree, FIX.hires);
  const x = estimateAll(b, { from: b.from, to: b.to }).get('600');
  assert.equal(x.h, null);
  assert.equal(x.code, 'wetHours');
  // the sentence carries the gauge's own count; the code does not, which is why
  // the counts block is keyed on the code
  assert.match(x.why, new RegExp(`only 10 wet hours \\(needs ${Math.ceil(MIN_RAIN_HOUR_FRAC * N)}\\)`));
});

// ---------- the two traps ----------

test('THE TRAP: a rotation by the window length is the identity', () => {
  const level = new Map([[10, 1], [11, 2], [12, 3]]);
  const rotated = rotateLevel(level, 10, 12, 3);   // span 3
  assert.deepEqual([...rotated].sort(), [...level].sort());
  // …and one that is not a multiple of the span really does move it
  assert.notDeepEqual([...rotateLevel(level, 10, 12, 1)].sort(), [...level].sort());
});

test('THE OTHER TRAP: hours outside the window are dropped, not folded into the null', () => {
  // The mirror holds more history than the window analyses — a median of 1598
  // hours against 1512, so 85 sit before `from`. Folding them in puts a
  // correctly-aligned rain/level pair inside the null, which is the one thing a
  // null may not contain. It stayed invisible for a while because the map
  // iterates ascending and a gap-free in-window series overwrites the folded
  // values; that is an unstated invariant, not a defence.
  const level = new Map([[7, 70], [8, 80], [9, 90], [10, 1], [11, 2], [12, 3]]);
  const r = rotateLevel(level, 10, 12, 1);
  assert.deepEqual([...r.keys()].sort((a, b) => a - b), [10, 11, 12], 'no hour outside [from, to] survives');
  assert.deepEqual([...r.values()].sort((a, b) => a - b), [1, 2, 3], 'and no value from outside leaks in');
  // …including when the in-window series has a GAP, which is exactly the case
  // the overwrite used to hide
  const gappy = new Map([[7, 70], [8, 80], [10, 1], [12, 3]]);
  const g = rotateLevel(gappy, 10, 12, 1);
  assert.equal(g.size, 2, 'a gap must stay a gap rather than being filled from before the window');
  assert.ok(![...g.values()].some(v => v >= 70), 'a pre-window value in the null is the bug this guards');
});

test('the rotation set never contains the identity, and honours its guard band', () => {
  const span = 1597;
  const shifts = rotationShifts(span);
  assert.equal(shifts.length, ROTATIONS);
  for (const s of shifts) {
    assert.ok(s % span !== 0, `shift ${s} is the identity`);
    assert.ok(s >= ROTATION_GUARD_H, `shift ${s} is inside the guard band`);
    assert.ok(s <= span - ROTATION_GUARD_H, `shift ${s} is inside the far guard band`);
    // a rotation smaller than the searched lag range would leave real rain
    // inside the window the estimator looks at
    assert.ok(s > MAX_LAG_H, `shift ${s} is smaller than the search range`);
  }
  assert.equal(new Set(shifts).size, shifts.length, 'the rotations must be distinct');
});

test('the rotation set is DETERMINISTIC — a Math.random() here would kill --check silently', () => {
  assert.deepEqual(rotationShifts(1597), rotationShifts(1597));
  assert.deepEqual(rotationShifts(1261), rotationShifts(1261));
  // and it depends on the span, so a rolled window really does get its own set
  assert.notDeepEqual(rotationShifts(1597), rotationShifts(1261));
});

test('a window too short to rotate safely gets no rotations at all, rather than bad ones', () => {
  assert.deepEqual(rotationShifts(2 * ROTATION_GUARD_H), []);
  assert.deepEqual(rotationShifts(10), []);
  // AND the case in between, which is the dangerous one: the guard band leaves
  // room, so the naive test `hi > lo` passes, but the shifts collide. 337 h
  // gives a band ONE hour wide and 99 shifts of which 2 are distinct — a null
  // with a hundredth of the draws it claims, invisible downstream because the
  // count would still read 99.
  const narrow = 2 * ROTATION_GUARD_H + 1;
  assert.ok(narrow - ROTATION_GUARD_H > ROTATION_GUARD_H, 'the naive room test really does pass here');
  assert.deepEqual(rotationShifts(narrow), [], 'and it is refused anyway');
  // the exact boundary: 99 distinct shifts need a band 100 h wide
  const need = 2 * ROTATION_GUARD_H + ROTATIONS + 1;
  assert.equal(rotationShifts(need).length, ROTATIONS);
  assert.equal(new Set(rotationShifts(need)).size, ROTATIONS);
  assert.deepEqual(rotationShifts(need - 1), []);
});

// ---------- the correction ----------

test('Benjamini-Hochberg rejects the prefix its own threshold allows', () => {
  // m = 10, q = 0.05: thresholds 0.005, 0.010, …, 0.050
  const ps = [0.001, 0.008, 0.039, 0.041, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
  // 0.001 <= 0.005 ok; 0.008 <= 0.010 ok; 0.039 > 0.015; 0.041 > 0.020 — but BH
  // takes the LARGEST k that clears, so only the first two survive here
  assert.deepEqual([...benjaminiHochberg(ps, 0.05)].sort((a, b) => a - b), [0, 1]);
  // THE STEP-UP PROPERTY, which is the whole difference from a plain cutoff:
  // 0.006 fails its own threshold (k=1 allows 0.005) and is rejected anyway,
  // because k=5 clears at 0.025 and BH takes the LARGEST k that does.
  const ps2 = [0.006, 0.007, 0.008, 0.009, 0.010, 0.9, 0.9, 0.9, 0.9, 0.9];
  assert.ok(ps2[0] > (1 / 10) * 0.05, 'the first p must fail its own threshold for this to test anything');
  assert.deepEqual([...benjaminiHochberg(ps2, 0.05)].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(benjaminiHochberg([], 0.05).size, 0);
});

test('m is every gauge TESTED, not the ones that survived the r cut', () => {
  // 40 p-values at the floor and 160 at 0.9: with m = 200 the threshold at
  // k = 40 is 0.010, so a p of 0.010 clears; computing m over the 40 alone would
  // make the threshold at k = 40 equal to q itself and change nothing here, but
  // it WOULD change the answer for a p of 0.02, which this pins.
  const ps = [...new Array(40).fill(0.02), ...new Array(160).fill(0.9)];
  assert.equal(benjaminiHochberg(ps, 0.05).size, 0);         // 0.02 > 40/200*0.05 = 0.010
  assert.equal(benjaminiHochberg(ps.slice(0, 40), 0.05).size, 40); // over 40 alone: 0.02 <= 0.05
});

// ---------- the classes ----------

test('classOf sits exactly on the published boundaries', () => {
  assert.deepEqual(CLASSES, [[0, 1], [2, 8], [9, null]]);
  assert.equal(classOf(0), 0);
  assert.equal(classOf(1), 0);
  assert.equal(classOf(2), 1);
  assert.equal(classOf(8), 1);
  assert.equal(classOf(9), 2);
  assert.equal(classOf(MAX_LAG_H), 2);   // the open class must reach the search edge
  assert.equal(classOf(null), null);
  assert.equal(classOf(-1), null);
});

test('a lag the classes do not cover is withheld, not squeezed into the nearest class', () => {
  assert.equal(classOf(5, [[0, 1], [9, null]]), null);
});

// ---------- the product ----------

test('the file maps id to class and to nothing else', () => {
  const r = build();
  assert.deepEqual(r.doc.gauges, { 100: 0, 200: 1, 300: 2 });
  for (const v of Object.values(r.doc.gauges)) assert.equal(typeof v, 'number');
  assert.equal(r.doc.schema, 1);
  assert.equal(r.doc.lagRuleVersion, LAG_RULE_VERSION);
  assert.equal(r.doc.ruleVersion, RULE_VERSION);   // the membership, imported
  assert.deepEqual(r.doc.rule.classes, CLASSES);
  assert.equal(r.doc.rule.minR, MIN_PEAK_R);
  assert.equal(r.doc.rule.rotations, ROTATIONS);
  assert.equal(r.doc.rule.fdrQ, FDR_Q);
  assert.equal(r.doc.window.hours, N);
  assert.match(r.doc.note, /2027-02/);   // the seasonal re-test rides in the file
});

test('the counts add up, and each drop-out is counted where it happened', () => {
  const c = build().counts;
  assert.equal(c.daily, SPECS.length);
  assert.equal(c.notInHires, 1);                       // 500
  assert.equal(c.attempted, c.daily - c.notInHires - c.noDailySet);
  assert.equal(c.noPeak, 1);                           // 600
  assert.equal(c.noPeakWhy.wetHours, 1);
  assert.equal(c.withPeak, c.attempted - c.noPeak);
  assert.equal(c.weak, 1);                             // 400
  assert.equal(c.published, c.withPeak - c.weak - c.notSignificant);
  assert.equal(c.byClass.reduce((a, b) => a + b, 0), c.published);
  assert.deepEqual(c.byClass, [1, 1, 1]);
});

test('a gauge without a DAILY rain field is never given an hourly class', () => {
  // 200 is estimable and would be class 1 — but the daily product does not ship
  // a rain field for it, and the plate that would print the class has no
  // PRECIPITATION block above it to print it under
  const fx = mkTrees(SPECS, { series: no => no !== '200' });
  try {
    const r = buildHourlyLag({ tree: fx.tree, hires: fx.hires, out: join(fx.tree, 'hourly'), generated: '2026-07-31' });
    assert.equal('200' in r.doc.gauges, false);
    assert.equal(r.counts.daily, SPECS.length - 1);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the product refuses to build at all when no gauge has a daily rain field', () => {
  const fx = mkTrees(SPECS, { series: () => false });
  try {
    assert.throws(() => buildHourlyLag({ tree: fx.tree, hires: fx.hires, out: join(fx.tree, 'hourly'), generated: '2026-07-31' }),
      /run scripts\/build-nrw-precip\.mjs first/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the reason a gauge has no class is the PRODUCT\'s own sentence', () => {
  const r = build();
  const by = Object.fromEntries(r.rows.map(x => [x.no, x]));
  assert.match(reasonFor(by['500']), /no hourly level series/);
  assert.match(reasonFor(by['600']), /wet hours/);
  assert.match(reasonFor(by['400']), /peak r 0\.\d+, needs 0\.25/);
  assert.match(reasonFor(null), /not in the hourly product/);
});

// ---------- the file on disk ----------

test('the file is written diffably — one line per gauge, not one line total', () => {
  const r = build();
  const text = readFileSync(join(FIX.tree, 'hourly', 'lag.json'), 'utf8');
  const lines = text.split('\n');
  // the acceptance criterion of this whole product is that git can show WHICH
  // gauges moved; a minified file has no diff granularity at all
  assert.ok(lines.length > Object.keys(r.doc.gauges).length, `${lines.length} lines for ${Object.keys(r.doc.gauges).length} gauges`);
  for (const no of Object.keys(r.doc.gauges)) {
    assert.ok(lines.some(l => l.trim().startsWith(`"${no}":`)), `${no} has no line of its own`);
  }
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(text), r.doc);
});

test('a second run writes nothing, and --check then says the tree matches the rule', () => {
  build();
  const again = build();
  assert.equal(again.out.changed, 0);
  const checked = build({ check: true });
  assert.deepEqual(checked.out.diffs, []);
});

test('--check goes red on a hand-edited class, and names the file', () => {
  build();
  const p = join(FIX.tree, 'hourly', 'lag.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  doc.gauges['100'] = 2;
  writeFileSync(p, JSON.stringify(doc, null, 1) + '\n');
  const checked = build({ check: true });
  assert.deepEqual(checked.out.diffs, ['differs: lag.json']);
  build();   // put it back for the tests after this one
});

test('--check goes red on a missing file rather than passing on absence', () => {
  const fx = mkTrees(SPECS);
  try {
    const checked = buildHourlyLag({ tree: fx.tree, hires: fx.hires, out: join(fx.tree, 'hourly'), generated: '2026-07-31', check: true });
    assert.deepEqual(checked.out.diffs, ['missing: lag.json']);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the writer refuses an output directory that is not named "hourly"', () => {
  // a stray --out must not drop lag.json into the mirror's root, where nothing
  // would prune it and N4 would carry it forever
  assert.throws(() => build({ out: FIX.tree }), /must be named "hourly"/);
  assert.throws(() => build({ out: join(FIX.tree, 'precip') }), /must be named "hourly"/);
});

// ---------- the input digest ----------

test('the digest covers rain and gauges, and NOT temp or raw', () => {
  const files = hiresFiles(FIX.hires);
  assert.ok(files.length > 0);
  assert.equal(files.every(f => /^(gauges|rain)\//.test(f.rel)), true, files.map(f => f.rel).join(', '));
  // the fixture carries a temp shard on purpose
  assert.equal(files.some(f => f.rel.startsWith('temp/')), false);
  assert.equal(inputsDigest(FIX.hires).files, files.length);
});

test('the digest moves when an input byte moves, and stands still when temp moves', () => {
  const before = inputsDigest(FIX.hires).sha256;
  const temp = join(FIX.hires, 'temp', 'T1', '2026-07.json');
  writeFileSync(temp, JSON.stringify(shard('T1', new Array(N).fill(2))));
  assert.equal(inputsDigest(FIX.hires).sha256, before, 'a temperature shard is not an input');

  const rain = join(FIX.hires, 'rain', '100r0', '2026-07.json');
  const keep = readFileSync(rain, 'utf8');
  const doc = JSON.parse(keep);
  doc.v = doc.v.map((x, i) => (i === 5 ? 9.9 : x));
  writeFileSync(rain, JSON.stringify(doc));
  assert.notEqual(inputsDigest(FIX.hires).sha256, before, 'a rain byte must move the digest');
  writeFileSync(rain, keep);
  assert.equal(inputsDigest(FIX.hires).sha256, before, 'and putting it back must restore it');
});

// One file whose CONTENT spells out the next file's path, against the two files
// it imitates. Under a digest that just concatenates `path + bytes` these two
// trees are the same string; the delimiters are the only thing that tells them
// apart, and each `filler` below defeats one weaker delimiting scheme.
//
// A first cut of this used two DIFFERENT path sets and passed with the
// delimiters removed — the paths alone separated the trees, so it proved
// nothing. The mutation harness is what found that, and then found the repair
// was still aimed at the wrong scheme.
function collidingTrees(filler) {
  const a = mkdtempSync(join(tmpdir(), 'dig-a-')), b = mkdtempSync(join(tmpdir(), 'dig-b-'));
  mkdirSync(join(a, 'rain'), { recursive: true });
  writeFileSync(join(a, 'rain', 'a.json'), Buffer.concat([Buffer.from('Z'), filler, Buffer.from('rain/b.json'), filler, Buffer.from('W')]));
  mkdirSync(join(b, 'rain'), { recursive: true });
  writeFileSync(join(b, 'rain', 'a.json'), 'Z');
  writeFileSync(join(b, 'rain', 'b.json'), 'W');
  return { a, b };
}

test('the digest is unambiguously delimited — a file cannot impersonate a pair of files', () => {
  // (1) no delimiter at all: "rain/a.json" + "Zrain/b.jsonW"
  //     against "rain/a.json" + "Z" + "rain/b.json" + "W" — the same string.
  const plain = collidingTrees(Buffer.alloc(0));
  try {
    assert.equal(hiresFiles(plain.a).map(f => f.rel).join(','), 'rain/a.json');
    assert.equal(hiresFiles(plain.b).map(f => f.rel).join(','), 'rain/a.json,rain/b.json');
    assert.notEqual(inputsDigest(plain.a).sha256, inputsDigest(plain.b).sha256);
  } finally { rmSync(plain.a, { recursive: true, force: true }); rmSync(plain.b, { recursive: true, force: true }); }

});

test('the digest framing is pinned, not merely demonstrated', () => {
  // Every WEAKER framing (drop the separators, drop the length, keep one of the
  // two) needs its own hand-built collision, and two of the three cannot be
  // built at all out of bytes a JSON shard may hold — so a collision test alone
  // leaves them unguarded. This computes the documented framing independently
  // instead: `rel \0 byteLength \0 bytes`, files sorted by path. Any change to
  // it is red here, whether or not a collision for it exists.
  const t = mkdtempSync(join(tmpdir(), 'dig-e-'));
  try {
    mkdirSync(join(t, 'rain', 'r1'), { recursive: true });
    mkdirSync(join(t, 'gauges', 'g1'), { recursive: true });
    writeFileSync(join(t, 'rain', 'r1', '2026-07.json'), '{"v":[1,2]}');
    writeFileSync(join(t, 'gauges', 'g1', '2026-07.json'), '{"v":[3]}');
    writeFileSync(join(t, 'gauges', 'g1', 'notes.txt'), 'ignored');   // only .json is an input
    const h = createHash('sha256');
    for (const [rel, body] of [['gauges/g1/2026-07.json', '{"v":[3]}'], ['rain/r1/2026-07.json', '{"v":[1,2]}']]) {
      h.update(`${rel}\0${Buffer.byteLength(body)}\0`);
      h.update(Buffer.from(body));
    }
    const got = inputsDigest(t);
    assert.equal(got.files, 2, 'a .txt beside the shards is not an input');
    assert.equal(got.sha256, h.digest('hex'));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('the digest reads the tree in one fixed order, whatever the filesystem hands back', () => {
  const a = mkdtempSync(join(tmpdir(), 'dig-c-')), b = mkdtempSync(join(tmpdir(), 'dig-d-'));
  try {
    for (const [root, order] of [[a, ['x', 'y']], [b, ['y', 'x']]]) {
      mkdirSync(join(root, 'rain'), { recursive: true });
      for (const n of order) writeFileSync(join(root, 'rain', `${n}.json`), `{"v":[${n === 'x' ? 1 : 2}]}`);
    }
    assert.equal(inputsDigest(a).sha256, inputsDigest(b).sha256, 'creation order must not change the digest');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

// ---------- the seams: what the builder writes is what the gate and the plate read ----------

test('SEAM: what the builder writes passes the gate that guards it', () => {
  const r = build();
  // The fixture is far under the published floor, so the floor and the window
  // rules are relaxed to the fixture's own size — everything else is the real
  // clause, including the timestamp format, the class shape, the rule ranges,
  // the provenance fields and the accounting identity.
  const v = checkHourlyShape(r.doc, {
    topologyGauges: Object.fromEntries(SPECS.map(s => [s.no, {}])),
    precip: Object.fromEntries(SPECS.map(s => [s.no, { series: true }])),
    minPublished: 1, minWindowHours: 1, maxWindowHours: 1e6,
    // no clock: freshness is about the mirror, not about a fixture
  });
  assert.deepEqual(v, [], v.join('\n'));
});

test('SEAM: the window stamps the builder writes are readable as dates', () => {
  // The exact mutation that slipped past 611 tests: an hour-resolution stamp
  // that Date.parse cannot read. Every later reader — N9(b), the plate's age
  // line — silently gets NaN out of it.
  const w = build().doc.window;
  for (const k of ['from', 'to']) {
    assert.ok(Number.isFinite(Date.parse(w[k])), `window.${k} = ${JSON.stringify(w[k])} is not a readable timestamp`);
  }
  assert.equal((Date.parse(w.to) - Date.parse(w.from)) / 36e5 + 1, w.hours, 'and `hours` is the span they describe');
});

// The plate reads these and nothing else out of the file. A rename here is
// invisible to every other test — the plate's own fixture is a hand-written
// copy — and shows up as a missing caveat on a live page.
const PLATE_READS = [
  d => d.rule.classes, d => d.gauges, d => d.window.hours, d => d.window.to, d => d.note,
  d => d.counts.weak, d => d.counts.noPeak, d => d.counts.noPeakWhy.wetHours,
  d => d.counts.notInHires, d => d.counts.notSignificant,
];
test('SEAM: every field the plate reads is present and of the shape it assumes', () => {
  const d = build().doc;
  for (const [i, read] of PLATE_READS.entries()) {
    const v = read(d);
    assert.notEqual(v, undefined, `the plate reads field #${i} and the builder does not write it`);
  }
  assert.ok(Array.isArray(d.rule.classes) && d.rule.classes.length === 3);
  assert.equal(typeof d.note, 'string');
  for (const k of ['weak', 'noPeak', 'notInHires', 'notSignificant']) assert.equal(typeof d.counts[k], 'number');
});

// ---------- the window is BOUNDED, not the mirror's extent ----------

test('the window is cut to the rule\'s own length, however much history the mirror holds', () => {
  // The mirror only grows — the collector runs with no pruning lever — while the
  // source offers a rolling window. Reading the window off the mirror's extent
  // (which the measurement bench did) grows it by 24 h a day, away from the
  // length every constant and every caveat were calibrated on.
  const long = mkTrees(SPECS.map(sp => ({
    ...sp,
    // three times the window, all of it real data
    rain: sp.rain ? [...sp.rain, ...sp.rain, ...sp.rain] : null,
    level: sp.level ? [...sp.level, ...sp.level, ...sp.level] : null,
  })));
  try {
    const b = loadBench(long.tree, long.hires);
    assert.equal(b.held, 3 * N, 'the mirror really does hold three windows');
    assert.equal(b.to - b.from + 1, WINDOW_H, 'and the bench uses exactly one');
    assert.equal(b.to, b.from + WINDOW_H - 1);
    const r = buildHourlyLag({ tree: long.tree, hires: long.hires, out: join(long.tree, 'hourly'), generated: '2026-07-31' });
    assert.equal(r.doc.window.hours, WINDOW_H);
    assert.ok(r.doc.window.hours <= MAX_HOURLY_WINDOW_HOURS, 'and it stays under the gate ceiling');
  } finally { rmSync(long.dir, { recursive: true, force: true }); }
});

test('a mirror shorter than the window is used whole, not padded', () => {
  const b = loadBench(FIX.tree, FIX.hires);
  assert.equal(b.held, N);
  assert.equal(b.to - b.from + 1, N, `${N} h of data must give a ${N} h window, not ${WINDOW_H}`);
});

test('a window too short to rotate refuses to produce a product at all', () => {
  // With no rotations every gauge would be marked significant and
  // counts.notSignificant would read 0 — a filter that stopped filtering, under
  // a file still advertising a rotation count.
  const b = loadBench(FIX.tree, FIX.hires);
  assert.throws(() => publish(b, { from: b.from, to: b.from + 2 * ROTATION_GUARD_H, only: dailyGauges(b.manifest) }),
    /no permutation filter means no product/);
});

test('the file reports the rotations that RAN, not the constant that was asked for', () => {
  const r = build();
  assert.equal(r.doc.rule.rotations, r.shifts.length);
  assert.equal(r.doc.rule.rotations, ROTATIONS);
});

// ---------- the acceptance rule inside the areal mean ----------

test('an hour under half the set reporting is a NON-hour, not a thinner mean', () => {
  // Measured against a fixture where the same two of four stations fall silent:
  // without this rule the areal mean would quietly become a two-station mean for
  // those hours, and nothing else in the product would look different.
  const a = new Map([[0, 4], [1, 4]]), bm = new Map([[0, 2], [1, 2]]);
  const c = new Map([[0, 0], [1, 0]]), d = new Map([[0, 0]]);   // d misses hour 1
  const full = arealHourly([a, bm, c, d], 0, 1);
  assert.deepEqual(full, [1.5, 2], 'hour 0 has all four; hour 1 has three of four, over the half');
  // two of four is not over the half, and MIN_SET_FOR_SERIES is 3 besides
  const thin = arealHourly([a, bm, new Map(), new Map()], 0, 1);
  assert.deepEqual(thin, [null, null]);
});

test('a sub-hourly RAIN shard is summed, and a partly reported hour is dropped', () => {
  // Every rain shard in the mirror today is hourly, so this path is unreachable
  // from the real data and would rot unseen. It is not dead code: the source has
  // 15-minute rain elsewhere in the same portal.
  const dir = mkdtempSync(join(tmpdir(), 'sub-'));
  try {
    mkdirSync(join(dir, 'rain', 'q'), { recursive: true });
    // hour 0: all four quarters -> summed; hour 1: three of four -> not an hour
    writeFileSync(join(dir, 'rain', 'q', '2026-07.json'),
      JSON.stringify({ id: 'q', month: '2026-07', step: 900, start: START, v: [1, 2, 3, 4, 5, 6, 7, null] }));
    const axis = hourlyAxis(dir, 'q', 'rain');
    assert.equal(axis.get(H0), 10, 'four quarters of rain are a SUM, not a mean');
    assert.equal(axis.has(H0 + 1), false, 'a partly reported hour is not an hour');
    // …and a level is AVERAGED over the same shape, because a level is a state
    mkdirSync(join(dir, 'gauges', 'q'), { recursive: true });
    writeFileSync(join(dir, 'gauges', 'q', '2026-07.json'),
      JSON.stringify({ id: 'q', month: '2026-07', step: 900, start: START, v: [1, 2, 3, 4] }));
    assert.equal(hourlyAxis(dir, 'q', 'gauges').get(H0), 2.5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the permutation filter, end to end ----------

test('the filter drops a peak that its own rotations reach just as often', () => {
  const b = loadBench(FIX.tree, FIX.hires);
  // A rotation-proof gauge (the fixture's r = 1 ones) and the noise gauge, run
  // through the real filter: p at the floor for the first, high for the second.
  const r = publish(b, { from: b.from, to: b.to, only: dailyGauges(b.manifest) });
  const by = Object.fromEntries(r.rows.map(x => [x.no, x]));
  assert.equal(by['100'].rotations, ROTATIONS);
  assert.ok(by['100'].p <= 1 / (ROTATIONS + 1) + 1e-12, `p ${by['100'].p}`);
  assert.equal(by['100'].significant, true);
  assert.ok(by['400'].p > by['100'].p, `noise p ${by['400'].p} vs signal ${by['100'].p}`);
});

test('the permutation p has a FLOOR of 1/(B+1) — a finite null cannot report certainty', () => {
  // The test above bounds p from ABOVE, and `p = 0` satisfies that bound: the
  // `(1 + ge) / (1 + B)` correction could be dropped to `ge / B` with every
  // other test in this file still green. Measured. Without the +1 a gauge no
  // rotation beat claims p = 0, and BH over the fleet then rejects strictly
  // more — the cut moves on a mutation nothing catches.
  const b = loadBench(FIX.tree, FIX.hires);
  const r = publish(b, { from: b.from, to: b.to, only: dailyGauges(b.manifest) });
  const floor = 1 / (r.shifts.length + 1);
  const tested = r.rows.filter(x => !x.skip && x.h != null && x.p != null);
  assert.ok(tested.length, 'no gauge was tested — this test would assert nothing');
  for (const x of tested) assert.ok(x.p >= floor - 1e-12, `gauge ${x.no}: p ${x.p} is under the floor ${floor}`);
  // …and the floor has to be REACHED, or the loop above passes on any positive
  // p and says nothing about the numerator
  const unbeaten = tested.find(x => x.ge === 0);
  assert.ok(unbeaten, 'the fixture must hold a gauge no rotation reached, or the +1 is never exercised');
  assert.equal(unbeaten.p, floor, 'ge = 0 must give exactly 1/(B+1), not 0');
});

test('the BH family is every gauge TESTED, pinned at the call site and not only in the unit', () => {
  // The rule is stated at `publish`: the correction runs over every gauge that
  // produced a peak, not over the ones that survived the r cut — otherwise the
  // family is chosen by looking at the data. On the real mirror both readings
  // happen to give the same bytes, so the unit test on benjaminiHochberg alone
  // does not pin the CALL. This does: a weak gauge must be IN the family, which
  // shows as it having been given a verdict at all.
  const b = loadBench(FIX.tree, FIX.hires);
  const r = publish(b, { from: b.from, to: b.to, only: dailyGauges(b.manifest) });
  const weak = r.rows.find(x => x.no === '400');
  assert.equal(weak.h != null, true, 'the noise gauge does reach a peak');
  assert.ok(weak.r < MIN_PEAK_R, 'and it is under the r cut');
  assert.equal(typeof weak.significant, 'boolean', 'so it was still tested — a family chosen after the r cut would skip it');
  assert.equal(typeof weak.p, 'number');
});

test('with the rotations switched off nothing is filtered — the filter is doing the work, not the r cut alone', () => {
  const b = loadBench(FIX.tree, FIX.hires);
  const off = publish(b, { from: b.from, to: b.to, only: dailyGauges(b.manifest), permute: false });
  assert.equal(off.shifts.length, 0);
  assert.equal(off.counts.notSignificant, 0);
  for (const x of off.rows) if (!x.skip && x.h != null) assert.equal(x.p, null);
});

// The CLI, not only the function behind it: nrw-update.yml runs
// `build-nrw-hourly-lag.mjs --report` and pushes only if it exits 0. After
// the C4 refactor the --report branch read a variable that no longer existed
// and every run died with a ReferenceError — 651 tests green, because none
// of them drove main(). This one does.
test('CLI: --report on the fixture trees runs to the end and prints the diagnostics table', () => {
  const out = join(FIX.dir, 'cli-out', 'hourly'); // the writer insists on that leaf
  const stdout = execFileSync(process.execPath, [
    fileURLToPath(new URL('../scripts/build-nrw-hourly-lag.mjs', import.meta.url)),
    '--tree', FIX.tree, '--hires', FIX.hires, '--out', out, '--report',
  ], { encoding: 'utf8' });
  assert.match(stdout, /^hourly lag: window /m);
  assert.match(stdout, /^no\tclass\th\tr\tn\twet\tp\tsig\tstate$/m, 'the --report table header');
  assert.match(stdout, /^100\t0\t/m, 'gauge 100 is class 0 in the table');
  assert.match(stdout, /file\(s\) written$/m);
  assert.ok(JSON.parse(readFileSync(join(out, 'lag.json'), 'utf8')).gauges, 'lag.json written by the CLI');
});
