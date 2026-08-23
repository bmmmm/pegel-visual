import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadApp } from './extract.mjs';

// builds a real (minimal) ZIP: local headers + central directory + EOCD —
// the same layout the WSV archive service emits, so the in-page reader is
// exercised against the honest byte format
function buildZip(files) {
  const parts = [], cd = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameB = Buffer.from(name);
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameB.length, 28);
    c.writeUInt32LE(offset, 42);
    cd.push(Buffer.concat([c, nameB]));
    parts.push(local, nameB, data);
    offset += 30 + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]));
}

// noon UTC: keeps isNight()'s no-coords fallback (local hours) out of the night
// window in both UTC CI runners and European local timezones
const NOON = Date.UTC(2026, 0, 15, 12);

// ---------- parseCommand ----------

test('parseCommand: flags, values, booleans', () => {
  const app = loadApp();
  const parse = raw => app.run(`parseCommand(${JSON.stringify(raw)})`);

  assert.equal(parse('--station BONN').station, 'BONN');
  assert.equal(parse('--STATION köln').station, 'köln', 'flag matching is case-insensitive, value case is kept');
  assert.equal(parse('--river ELDE MÜRITZ WASSERSTRASSE').river, 'ELDE MÜRITZ WASSERSTRASSE', 'multi-word values run to the next flag');
  assert.equal(parse('--history 7D').history, '7d', 'history value is lowercased');

  const combined = parse('--station KÖLN --history 7d --adsb 10.0.0.5:8080');
  assert.equal(combined.station, 'KÖLN');
  assert.equal(combined.history, '7d');
  assert.equal(combined.adsb, '10.0.0.5:8080');

  assert.equal(parse('--adsb').adsb, '', 'flag given without value means "given empty" (clears)');
  assert.equal(parse('--station X').adsb, undefined, 'absent flag stays undefined');
  assert.equal(parse('--ais 10.0.0.5:8080/aiscatcher').ais, '10.0.0.5:8080/aiscatcher');
  assert.equal(parse('--ais').ais, '', '--ais without value clears, like --adsb');
  assert.equal(parse('--station X').ais, undefined);

  const bools = parse('--export --clear --info --help');
  assert.equal(bools.export, true);
  assert.equal(bools.clear, true);
  assert.equal(bools.info, true);
  assert.equal(bools.help, true);

  assert.equal(parse('--bogus').unknownFlag, '--bogus');
  assert.equal(parse('BONN').station, undefined, 'bare names are not parsed as --station (applyPrompt handles them)');
});

test('helpText: the man page lists every flag parseCommand recognises, and every history range', () => {
  const app = loadApp();
  const man = app.run('helpText(null)');
  // derived, not hand-written: parseCommand('') returns one key per flag it parses
  // (unknownFlag is the catch-all, not a flag itself) — a flag added there without
  // a matching helpText line now fails this test instead of silently going undocumented
  const flags = app.run(`Object.keys(parseCommand('')).filter(k => k !== 'unknownFlag')`);
  assert.ok(flags.length >= 10, 'sanity: parseCommand recognises a realistic number of flags');
  for (const flag of flags) assert.ok(man.includes('--' + flag), `man page mentions --${flag}`);
  // same for the sparkline/archive range presets — 24h..30d live API, 1y..20y hosted archive
  const ranges = app.run('HISTORY_PRESETS.map(p => p.k)');
  assert.ok(ranges.length >= 8, 'sanity: HISTORY_PRESETS still covers both the API and archive ranges');
  for (const k of ranges) assert.ok(man.includes(k), `man page's --history line mentions ${k}`);
  assert.ok(app.run('helpText("--nope")').startsWith('unknown flag: --nope'));
});

test('adsbEndpoint / aisEndpoint: URL normalization', () => {
  const app = loadApp();
  assert.equal(app.run(`adsbEndpoint('10.0.0.5:8080')`), 'http://10.0.0.5:8080/data/aircraft.json');
  assert.equal(app.run(`adsbEndpoint('https://r.example/data/aircraft.json')`), 'https://r.example/data/aircraft.json');
  assert.equal(app.run(`adsbEndpoint('')`), '');
  assert.equal(app.run(`aisEndpoint('10.0.0.5:8080/aiscatcher')`), 'http://10.0.0.5:8080/aiscatcher/ships.json');
  assert.equal(app.run(`aisEndpoint('http://10.0.0.5:8080/aiscatcher/')`), 'http://10.0.0.5:8080/aiscatcher/ships.json');
  assert.equal(app.run(`aisEndpoint('https://r.example/ships.json')`), 'https://r.example/ships.json');
  assert.equal(app.run(`aisEndpoint('')`), '');
});

// ---------- archive: merge, thin, dedupe, import ----------

test('mergeIntoArchive: dedupes, sorts, thins old points to hourly', () => {
  const app = loadApp({ now: NOON });
  const iso = ts => new Date(ts).toISOString();

  // recent points at 15-min cadence stay untouched, duplicates collapse
  const recent = [NOON - 45 * 60000, NOON - 30 * 60000, NOON - 15 * 60000];
  const measurements = [...recent, recent[0]].map(t => ({ timestamp: iso(t), value: 100 }));
  app.run(`mergeIntoArchive('T1', ${JSON.stringify(measurements)})`);
  const merged = app.run(`loadArchive('T1')`);
  assert.equal(merged.length, 3, 'duplicate timestamp collapsed');
  assert.deepEqual(merged.map(p => p[0]), recent, 'sorted ascending');

  // 20-day-old points at 15-min cadence over 3 h thin to one per hour bucket
  const oldBase = NOON - 20 * 864e5;
  const old = Array.from({ length: 13 }, (_, i) => ({ timestamp: iso(oldBase + i * 15 * 60000), value: 50 }));
  app.run(`mergeIntoArchive('T2', ${JSON.stringify(old)})`);
  const thinned = app.run(`loadArchive('T2')`);
  assert.ok(thinned.length === 4, `13 quarter-hour points span 4 hour buckets, got ${thinned.length}`);
});

test('mergeIntoArchive: quota errors never throw (best-effort)', () => {
  const app = loadApp({ now: NOON });
  app.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.doesNotThrow(() =>
    app.run(`mergeIntoArchive('T', [{ timestamp: new Date(${NOON}).toISOString(), value: 1 }])`));
});

test('mergeIntoArchive: quota evicts the least-recently viewed station, not old points', () => {
  const app = loadApp({ now: NOON });
  const mk = (v, h) => `[{ "timestamp": "${new Date(NOON - h * 36e5).toISOString()}", "value": ${v} }]`;
  app.run(`mergeIntoArchive('OLDTOWN', ${mk(1, 1)})`);
  app.run(`mergeIntoArchive('CURRENT', ${mk(2, 2)})`);
  app.run(`localStorage.setItem('pegel.recent', '["CURRENT","OLDTOWN"]')`);
  // simulate a full store: writes fail while OLDTOWN's archive still exists
  const ls = app.localStorage;
  const orig = Object.getOwnPropertyDescriptor(ls, 'setItem').value;
  Object.defineProperty(ls, 'setItem', { value: (k, v) => {
    if (Object.prototype.hasOwnProperty.call(ls, 'pegel.archive.OLDTOWN')) throw new Error('QuotaExceededError');
    return orig(k, v);
  }, writable: true, configurable: true });
  app.run(`mergeIntoArchive('CURRENT', ${mk(3, 3)})`);
  assert.equal(app.run(`loadArchive('OLDTOWN')`).length, 0, 'stale station was evicted');
  assert.equal(app.run(`loadArchive('CURRENT')`).length, 2, 'current station kept its full history');
});

test('importArchiveFile: accepts export shapes, rejects junk, dedupes on re-import', () => {
  const app = loadApp({ now: NOON });
  const data = { bonn: [[NOON - 36e5, 100], [NOON - 18e5, 101]], KÖLN: [[NOON - 36e5, 200]] };
  assert.equal(app.run(`importArchiveFile(${JSON.stringify(data)})`), true);
  assert.equal(app.run(`loadArchive('BONN')`).length, 2, 'station names are uppercased on import');
  assert.equal(app.run(`loadArchive('KÖLN')`).length, 1);

  assert.equal(app.run(`importArchiveFile(${JSON.stringify(data)})`), true);
  assert.equal(app.run(`loadArchive('BONN')`).length, 2, 're-import adds nothing');

  assert.equal(app.run('importArchiveFile([1, 2])'), false, 'arrays rejected');
  assert.equal(app.run('importArchiveFile("nope")'), false, 'strings rejected');
  assert.equal(app.run('importArchiveFile(null)'), false);
  assert.equal(app.run('importArchiveFile({ X: "not a list" })'), false);
  assert.equal(app.run('importArchiveFile({ X: [["NaN", null], [1]] })'), false, 'all-invalid pairs count as no match');
});

test('mergeIntoArchive: multi-year points thin to 6-hourly', () => {
  const app = loadApp({ now: NOON });
  const base = NOON - 2 * 365 * 864e5; // two years back
  const old = Array.from({ length: 25 }, (_, i) => ({ timestamp: new Date(base + i * 36e5).toISOString(), value: 70 }));
  app.run(`mergeIntoArchive('T3', ${JSON.stringify(old)})`);
  const kept = app.run(`loadArchive('T3')`);
  assert.ok(kept.length >= 4 && kept.length <= 5, `25 hourly points over 24h thin to ~4-5 six-hour buckets, got ${kept.length}`);
});

test('importWsvArchive: unpacks the WSV historical ZIP into the right station', async () => {
  const app = loadApp({ now: NOON });
  app.run(`fillDatalist([{ n: 'KÖLN', w: 'RHEIN', km: 688 }, { n: 'BONN', w: 'RHEIN', km: 654.8 }])`);
  app.run(`station = 'BONN'`);
  const measurements = Array.from({ length: 8 }, (_, i) =>
    ({ timestamp: new Date(NOON - (8 - i) * 36e5).toISOString(), value: 300 + i }));
  // same entry layout as the real archive: json + terms + info text
  const zip = buildZip([
    ['pegelonline-koeln-W-20240101-20241231.json', JSON.stringify(measurements)],
    ['nutzungsbedingungen.txt', 'DL-DE Zero'],
    ['zeitreiheninformation.txt', 'info'],
  ]);
  const importWsvArchive = app.run('importWsvArchive');
  const target = await importWsvArchive(zip);
  assert.equal(target, 'KÖLN', 'station resolved from the file name, umlaut-folded');
  assert.equal(app.run(`loadArchive('KÖLN')`).length, 8);

  // a file name that matches no station falls back to the on-screen station
  const zip2 = buildZip([['pegelonline-atlantis-W-20240101-20241231.json', JSON.stringify(measurements)]]);
  assert.equal(await app.run('importWsvArchive')(zip2), 'BONN');

  // garbage bytes are rejected, not crashed on
  await assert.rejects(() => importWsvArchive(new Uint8Array([0x50, 0x4b, 1, 2, 3])), /zip/);
});

test('countGaps: only jumps beyond 90 min count (recent points)', () => {
  const app = loadApp({ now: NOON });
  const base = NOON - 500 * 60000; // recent: the 90-min threshold applies
  const pts = [[base, 1], [base + 30 * 60000, 1], [base + 120 * 60000, 1], [base + 121 * 60000, 1], [base + 400 * 60000, 1]];
  const g = app.run(`countGaps(${JSON.stringify(pts)})`);
  assert.equal(g.gaps, 1, '90 min exactly is tolerated (thinned cadence), 279 min is a gap');
  assert.ok(Math.abs(g.maxGapH - 4.65) < 0.01);
});

// ---------- astronomy ----------

test('moonPhase: anchored to the known new moon, always in [0, 1)', () => {
  const newMoon = loadApp({ now: Date.UTC(2000, 0, 6, 18) }).run('moonPhase()');
  assert.ok(newMoon < 0.02 || newMoon > 0.98, `2000-01-06 was a new moon, got ${newMoon}`);
  const fullMoon = loadApp({ now: Date.UTC(2000, 0, 21, 5) }).run('moonPhase()');
  assert.ok(Math.abs(fullMoon - 0.5) < 0.03, `2000-01-21 was a full moon, got ${fullMoon}`);
  for (const now of [Date.UTC(2013, 6, 1), Date.UTC(2026, 1, 2, 3), Date.UTC(1999, 11, 31)]) {
    const f = loadApp({ now }).run('moonPhase()');
    assert.ok(f >= 0 && f < 1);
  }
});

test('isNight: real coordinates, polar guards, no-coords fallback', () => {
  const at = (now, info) => {
    const app = loadApp({ now });
    app.run(`state.info = ${JSON.stringify(info)}`);
    return app.run('isNight()');
  };
  const bonn = { latitude: 50.7, longitude: 7.1 };
  assert.equal(at(Date.UTC(2026, 0, 15, 12), bonn), false, 'Bonn, January noon UTC: day');
  assert.equal(at(Date.UTC(2026, 0, 15, 20), bonn), true, 'Bonn, January 20:00 UTC: night');
  assert.equal(at(Date.UTC(2026, 5, 15, 18), bonn), false, 'Bonn, June 18:00 UTC (20:00 local): still light');
  assert.equal(at(Date.UTC(2026, 5, 15, 21), bonn), true, 'Bonn, June 21:00 UTC: past the ~19:45 UTC sunset');

  const svalbard = { latitude: 78, longitude: 15 };
  assert.equal(at(Date.UTC(2026, 0, 15, 12), svalbard), true, 'polar night: dark even at noon');
  assert.equal(at(Date.UTC(2026, 5, 15, 0), svalbard), false, 'midnight sun: light even at midnight');

  assert.equal(at(Date.UTC(2026, 0, 15, 23), null), true, 'no coords, 23:00 UTC: fixed-window night');
  assert.equal(at(Date.UTC(2026, 0, 15, 10), null), false, 'no coords, 10:00 UTC: fixed-window day');
});

// ---------- name folding & resolution ----------

test('resolveStation / resolveWater: umlaut spellings fold both ways', () => {
  const app = loadApp();
  app.run(`fillDatalist([{ n: 'KÖLN', w: 'RHEIN', km: 688 }, { n: 'BONN', w: 'RHEIN', km: 654.8 }])`);
  app.run(`fillWaters(['RHEIN', 'MÜRITZSEE'])`);

  assert.equal(app.run(`foldAe('Straße')`), 'STRASSE');
  assert.equal(app.run(`foldStrip('KÖLN')`), 'KOLN');

  assert.equal(app.run(`resolveStation('koeln')`), 'KÖLN');
  assert.equal(app.run(`resolveStation('KOLN')`), 'KÖLN');
  assert.equal(app.run(`resolveStation('BONN')`), 'BONN');
  assert.equal(app.run(`resolveStation('XYZTOWN')`), 'XYZTOWN', 'unknown names pass through unchanged');

  assert.equal(app.run(`resolveWater('MUERITZSEE')`), 'MÜRITZSEE');
  assert.equal(app.run(`resolveWater('muritzsee')`), 'MÜRITZSEE');
  assert.equal(app.run(`resolveWater('ATLANTIS')`), null);
});

test('findMatches / applyPrompt: place names resolve via substring search', () => {
  const app = loadApp();
  app.run(`fillDatalist([
    { n: 'MAGDEBURG-BUCKAU', w: 'ELBE', km: 318 },
    { n: 'MAGDEBURG-STROMBRÜCKE', w: 'ELBE', km: 326.6 },
    { n: 'Trier OP', w: 'MOSEL', km: 195 },
    { n: 'Trier UP', w: 'MOSEL', km: 195 },
    { n: 'MINDEN', w: 'WESER', km: 204.5 },
    { n: 'BONN', w: 'RHEIN', km: 654.8 },
  ])`);
  app.run(`fillWaters(['MOSEL', 'ELBE'])`);

  const m = app.run(`findMatches('MAGDEBURG')`);
  assert.deepEqual(m.map(x => x.name), ['MAGDEBURG-BUCKAU', 'MAGDEBURG-STROMBRÜCKE']);
  assert.equal(app.run(`findMatches('trier')`).length, 2, 'case-insensitive');
  assert.equal(app.run(`findMatches('OSEL')`).find(x => x.river).name, 'MOSEL', 'rivers are found too');
  assert.deepEqual(app.run(`findMatches('XYZNOWHERE')`), []);

  // unique substring match switches directly
  app.run(`stationInput.value = 'MINDE'`);
  app.run(`applyPrompt()`);
  assert.equal(app.run('station'), 'MINDEN');
  assert.equal(app.run('state.suggest'), null);

  // ambiguous input opens the did-you-mean screen instead of a 404 sea monster
  app.run(`stationInput.value = 'MAGDEBURG'`);
  app.run(`applyPrompt()`);
  const suggest = app.run('state.suggest');
  assert.equal(suggest.q, 'MAGDEBURG');
  assert.equal(suggest.matches.length, 2);
  assert.equal(app.run('station'), 'MINDEN', 'no switch happened');

  // the suggest screen renders clickable rows (river rows use the river: prefix)
  const html = app.run(`(() => {
    state.suggest = { q: 'mosel', matches: [{ name: 'Trier OP', river: false }, { name: 'MOSEL', river: true }] };
    return renderSuggest(suggestViewModel(state.suggest));
  })()`);
  assert.ok(html.includes('data-nav="Trier OP"'));
  assert.ok(html.includes('data-nav="river:MOSEL"'));
  assert.ok(html.includes('Did you mean'), 'and says what it is asking');
});

test('search folds umlauts both ways: KOELN and KOLN both find KÖLN', () => {
  const app = loadApp();
  app.run(`fillDatalist([
    { n: 'KÖLN', w: 'RHEIN', km: 688 },
    { n: 'MÜNSTER', w: 'DORTMUND-EMS-KANAL', km: 70 },
    { n: 'BONN', w: 'RHEIN', km: 654.8 },
  ])`);
  app.run(`fillWaters(['RHEIN', 'MÜRITZSEE'])`);

  const names = expr => app.run(`${expr}.map(m => m.name)`);
  assert.deepEqual(names(`findMatches('KOELN')`), ['KÖLN'], 'the OE spelling the README promises');
  assert.deepEqual(names(`findMatches('KOLN')`), ['KÖLN'], 'the stripped spelling still works');
  assert.deepEqual(names(`findMatches('KÖLN')`), ['KÖLN'], 'and so does the real one');
  assert.deepEqual(names(`findMatches('MUENSTER')`), ['MÜNSTER']);
  assert.deepEqual(names(`findMatches('MUERITZ')`), ['MÜRITZSEE'], 'rivers fold too');
  assert.deepEqual(names(`matchNames('OELN', knownStations, () => '')`), ['KÖLN'], 'substring, not only prefix');
  // the finder dialog and the typeahead dropdown read the same matcher
  assert.deepEqual(names(`finderMatches('KOELN')`), ['KÖLN']);
});

// ---------- river mode data ----------

test('troubleKind: normalizes stateMnwMhw', () => {
  const app = loadApp();
  assert.equal(app.run(`troubleKind('low')`), 'low');
  assert.equal(app.run(`troubleKind('LOWEST')`), 'low');
  assert.equal(app.run(`troubleKind('HIGH')`), 'high');
  assert.equal(app.run(`troubleKind('highest')`), 'high');
  assert.equal(app.run(`troubleKind('normal')`), 'normal');
  assert.equal(app.run(`troubleKind('unknown')`), 'normal');
  assert.equal(app.run(`troubleKind(null)`), 'normal');
});

test('prepareRiverStations: filters, derives elevation, sorts by km', () => {
  const app = loadApp();
  const raw = [
    { shortname: 'A', km: 20, timeseries: [{ shortname: 'W', gaugeZero: { value: 30 }, currentMeasurement: { value: 250, stateMnwMhw: 'normal' } }] },
    { shortname: 'B', km: 5, timeseries: [{ shortname: 'W', gaugeZero: { value: 35 }, currentMeasurement: { value: 120, stateMnwMhw: 'low' } }] },
    { shortname: 'NO_KM', timeseries: [{ shortname: 'W', gaugeZero: { value: 1 }, currentMeasurement: { value: 1, stateMnwMhw: 'high' } }] },
    { shortname: 'NO_W', km: 9, timeseries: [{ shortname: 'Q' }] },
    { shortname: 'NO_ELEV_NORMAL', km: 11, timeseries: [{ shortname: 'W', currentMeasurement: { value: 90, stateMnwMhw: 'normal' } }] },
    { shortname: 'NO_ELEV_HIGH', km: 12, timeseries: [{ shortname: 'W', currentMeasurement: { value: 900, stateMnwMhw: 'highest' } }] },
  ];
  const out = app.run(`prepareRiverStations(${JSON.stringify(raw)})`);
  assert.deepEqual(out.map(s => s.name), ['B', 'NO_ELEV_HIGH', 'A'], 'km-sorted; unplottable & unflagged stations dropped');
  assert.equal(out[0].elev, 35 + 120 / 100, 'elev = gauge zero + W/100');
  assert.equal(out[1].elev, null, 'flagged station without gauge zero stays, trouble-list only');
  assert.equal(out[1].kind, 'high');
  assert.equal(out[2].kind, 'normal');
});

test('kmTicks: round steps, in range, 2-7 ticks', () => {
  const app = loadApp();
  for (const [lo, hi] of [[0, 100], [812.4, 865.1], [3, 9], [0, 1300]]) {
    const ticks = app.run(`kmTicks(${lo}, ${hi})`);
    assert.ok(ticks.length >= 2 && ticks.length <= 7, `${lo}-${hi}: got ${ticks.length} ticks`);
    for (const t of ticks) assert.ok(t >= lo - 1e-9 && t <= hi + 1e-9, `tick ${t} inside [${lo}, ${hi}]`);
    const step = ticks[1] - ticks[0];
    const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
    assert.ok([1, 2, 5].some(m => Math.abs(mantissa - m) < 1e-9), `step ${step} is a 1/2/5 step`);
    for (let i = 2; i < ticks.length; i++) assert.ok(Math.abs(ticks[i] - ticks[i - 1] - step) < 1e-9, 'uniform steps');
  }
});

// ---------- drawProfile layout invariants ----------

// Floating labels used to overwrite each other: a name plus its elevation runs to
// 37 columns, and the plot is only 4 rows tall, so three of them shared rows — on
// 3 of 4 real profiles at 44 columns, and 1 in 6 at 84. The worst case below packs
// the longest real station names onto near-identical elevations and adjacent km,
// which is what forced the collision. Every label must survive intact at any width.
test('profileViewModel: every neighbour keeps its full name and its own row', () => {
  const neighbors = [
    { name: 'DUISBURG-MEIDERICH SCHLEUSE UW', km: 6.1, lat: 51.4, lon: 6.7, elev: 85.98 },
    { name: 'FRIEDRICHSTADT STRASSENBRÜCKE', km: 6.4, lat: 51.4, lon: 6.7, elev: 85.99 },
    { name: 'Niederbiel Schleuse Kanal OP', km: 6.9, lat: 51.4, lon: 6.7, elev: 86.01 },
  ];
  const app = loadApp({ now: NOON });
  const { vm, html } = app.run(`(() => {
    station = 'FRIEDRICHSTADT STRASSENBRÜCKE';
    state.info = { water: { shortname: 'RHEIN' } };
    state.neighbors = ${JSON.stringify(neighbors)};
    const vm = profileViewModel();
    return { vm, html: renderProfile(vm) };
  })()`);
  assert.equal(vm.pts.length, 3);
  // the 84-column grid had to ellipsize these; a real list does not
  for (const p of neighbors) {
    assert.ok(html.includes(p.name.replace(/&/g, '&amp;')), `"${p.name}" survives whole`);
    assert.ok(html.includes(p.elev.toFixed(2)), 'with its elevation');
  }
  // the label has to match the axis it labels: flowFrac puts upstream at x=0
  assert.match(html, /\u2190 upstream[\s\S]*downstream \u2192/, 'upstream is named on the left, downstream on the right');
  const self = vm.pts.find(p => p.self);
  assert.ok(self, 'the current gauge marks itself');
  assert.ok(html.includes('data-nav="river:RHEIN"'), 'and leads on to its whole river');
  assert.ok(html.includes('data-nav="Niederbiel Schleuse Kanal OP"'), 'neighbours are one click away');
  // ordered upstream→downstream by the fitted flow direction, not by raw km
  assert.deepEqual(vm.pts.map(p => p.x), [...vm.pts.map(p => p.x)].sort((a, b) => a - b));
});

// The Rhine counts its km downstream, the Neckar counts them upstream. Whichever
// way the numbers run, flowFrac puts the upstream gauge on the left — and the axis
// label under the drawing has to name that same direction.
test('profileViewModel: upstream stays on the left whichever way the km count runs', () => {
  const cases = [
    ['km rises downstream (Rhine)', 'BONN', [
      { name: 'OBERWINTER', km: 638.19, lat: 50.6, lon: 7.2, elev: 47.45 },
      { name: 'BONN', km: 654.8, lat: 50.7, lon: 7.1, elev: 43.66 },
      { name: 'K\u00d6LN', km: 688, lat: 50.9, lon: 6.9, elev: 35.88 },
    ]],
    ['km rises upstream (Neckar)', 'HEIDELBERG', [
      { name: 'MANNHEIM NECKAR', km: 3.1, lat: 49.5, lon: 8.5, elev: 86.34 },
      { name: 'HEIDELBERG', km: 25.0, lat: 49.4, lon: 8.7, elev: 105.0 },
      { name: 'PLOCHINGEN', km: 202.6, lat: 48.7, lon: 9.4, elev: 247.39 },
    ]],
  ];
  for (const [label, self, neighbors] of cases) {
    const app = loadApp({ now: NOON });
    const { vm, html } = app.run(`(() => {
      station = ${JSON.stringify(self)};
      state.flowLowKm = null;
      state.info = { water: { shortname: 'RHEIN' } };
      state.neighbors = ${JSON.stringify(neighbors)};
      const vm = profileViewModel();
      return { vm, html: renderProfile(vm) };
    })()`);
    const leftmost = vm.pts.reduce((a, b) => (a.x <= b.x ? a : b));
    const highest = vm.pts.reduce((a, b) => (a.elev >= b.elev ? a : b));
    assert.equal(leftmost.name, highest.name, `${label}: the upstream gauge is drawn leftmost`);
    assert.match(html, /\u2190 upstream[\s\S]*downstream \u2192/, `${label}: and the axis names it upstream`);
  }
});

// ---------- drawRiver layout invariants (worst case: 30 stations, 24 troubled) ----------

test('riverViewModel: a crowded river keeps every gauge, and names its troubled ones', () => {
  const app = loadApp({ now: NOON });
  const sts = Array.from({ length: 30 }, (_, i) => ({
    name: 'ST' + String(i).padStart(2, '0'),
    km: 100 + i * 0.8 + (i % 5 === 0 ? i : 0), // clusters with occasional jumps
    value: 150 + i,
    elev: 60 - i * 0.5 - (i % 3),
    kind: i % 5 === 4 ? 'normal' : (i % 2 ? 'low' : 'high'),
  }));
  app.run(`state.river = 'TESTFLUSS'`);
  const { vm, html } = app.run(`(() => {
    const vm = riverViewModel(${JSON.stringify(sts)});
    return { vm, html: renderRiver(vm) };
  })()`);
  assert.equal(vm.counts.low, 12);
  assert.equal(vm.counts.high, 12);
  assert.equal(vm.pts.length, 30, 'every gauge is plotted — the grid could only label a few');
  // the trouble list carries ALL 24, not 8 plus an overflow line
  assert.equal(vm.troubled.length, 24);
  assert.ok(!html.includes('… and 16 more'), 'nothing is truncated any more');
  assert.ok(html.includes('TROUBLE'), 'trouble list header present');
  for (const s of vm.troubled) assert.ok(html.includes(s.name), `${s.name} is listed`);
  // dots stay inside the plot box at any width — fractions, not columns
  for (const p of vm.pts) {
    assert.ok(p.x >= 0 && p.x <= 1, `${p.name} x in range`);
    assert.ok(p.y >= 0 && p.y <= 1, `${p.name} y in range`);
  }
  assert.ok(vm.gradient > 0, 'the mean fall is derived and reported');
  assert.ok(html.includes('mean fall'), 'and named on the plate');
});


// ---------- grid & escaping ----------

// ---------- responsive COLS breakpoint (Chrome desktop cannot shrink below ~500px,
// so the 84 ↔ 44 switch is pinned here instead of via window resizing) ----------

test('layout: density follows the measured plate width, with no hard tier fork', () => {
  // fitFont's two-tier 84/44-column fork is gone: the plate is CSS-sized and
  // only genuine CONTENT decisions still read a width
  const phone = loadApp({ width: 390 });
  assert.equal(phone.run('plateDensity()'), 'narrow');
  assert.equal(phone.run('typeof COLS'), 'undefined', 'no column count survives');
  assert.equal(phone.run('typeof fitFont'), 'undefined', 'and no font-fitting hack');

  const desktop = loadApp({ width: 1200 });
  assert.equal(desktop.run('plateDensity()'), 'wide');

  // crossing the breakpoint at runtime (rotate / window resize) is continuous
  desktop.document.documentElement.clientWidth = 390;
  assert.equal(desktop.run('plateDensity()'), 'narrow', 'shrinking re-reads the width');
  assert.equal(desktop.run('bucketCols()'), 130, 'and the data density follows it');
  desktop.document.documentElement.clientWidth = 1200;
  assert.equal(desktop.run('plateDensity()'), 'wide');
});


// ---------- repo-hosted WSV archive (scripts/fetch-wsv-archive.mjs + client) ----------

test('archive script: condense folds measurements into daily MEZ min/max', async () => {
  const { condense, daysInYear, unzipJsonEntry } = await import('../scripts/fetch-wsv-archive.mjs');
  const measurements = [
    { timestamp: '2024-03-05T00:15:00+01:00', value: 500 },
    { timestamp: '2024-03-05T13:00:00+01:00', value: 540 },
    { timestamp: '2024-03-05T23:45:00+01:00', value: 520 },
    { timestamp: '2024-12-31T23:30:00+01:00', value: 300 },
    { timestamp: '2025-01-01T00:15:00+01:00', value: 301 }, // next MEZ day → next year
    { timestamp: '2024-03-06T00:00:00+01:00', value: null }, // dropped
  ];
  const years = condense(measurements);
  assert.deepEqual([...years.keys()].sort(), [2024, 2025]);
  const y24 = years.get(2024);
  assert.equal(y24.min.length, daysInYear(2024));
  assert.equal(y24.min.length, 366, '2024 is a leap year');
  const mar5 = 31 + 29 + 4; // day index of March 5 in a leap year
  assert.equal(y24.min[mar5], 500);
  assert.equal(y24.max[mar5], 540);
  assert.equal(y24.min[365], 300, 'Dec 31 lands in the last slot');
  assert.equal(years.get(2025).min[0], 301);

  // the script's zip reader handles the same layout as the in-page one
  const zip = buildZip([['pegelonline-bonn-W-x.json', JSON.stringify(measurements.slice(0, 1))]]);
  assert.equal(JSON.parse(unzipJsonEntry(zip).toString())[0].value, 500);
});

test('archive script: buildManifest marks year ranges and none-stations', async () => {
  const { buildManifest } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'pegel-manifest-'));
  mkdirSync(join(out, 'uuid-a'));
  // from/to now derive from the closed.json bundle + current.json, not filenames;
  // 2020 has one missing day (both null) so it shows up as a gap count
  writeFileSync(join(out, 'uuid-a', 'closed.json'), JSON.stringify([
    { y: 2020, min: [10, null], max: [20, null] },
    { y: 2024, min: [15], max: [25] },
  ]));
  writeFileSync(join(out, 'uuid-a', 'current.json'), JSON.stringify({ y: 2099, min: [1], max: [2] }));
  const stations = [
    { uuid: 'uuid-a', shortname: 'BONN', water: { shortname: 'RHEIN' } },
    { uuid: 'uuid-b', shortname: 'Marburg', water: { shortname: 'LAHN' } },
  ];
  const m = buildManifest(stations, out);
  assert.equal(m.stations['uuid-a'].from, 2020, 'earliest bundle year');
  assert.equal(m.stations['uuid-a'].to, new Date().getUTCFullYear(), 'current.json counts as the running year');
  assert.equal(m.stations['uuid-a'].gaps, 1, 'the one all-null day is reported as a gap');
  assert.equal(m.stations['uuid-a'].none, undefined);
  assert.deepEqual(m.stations['uuid-b'], { n: 'Marburg', w: 'LAHN', none: true });
  assert.ok(JSON.parse(readFileSync(join(out, 'manifest.json'))).stations['uuid-b'].none, 'written to disk');
  assert.equal(m.stations['uuid-a'].source, undefined, 'no meta.json source → no source field (WSV default)');
});

test('archive script: buildManifest carries a station meta.json source into the manifest', async () => {
  const { buildManifest } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'pegel-src-'));
  mkdirSync(join(out, 'uuid-r'));
  writeFileSync(join(out, 'uuid-r', 'closed.json'), JSON.stringify([{ y: 1990, min: [5], max: [9] }]));
  writeFileSync(join(out, 'uuid-r', 'meta.json'), JSON.stringify({ name: 'LOBITH', source: 'Rijkswaterstaat' }));
  // the WSV rebuild runs over the full station list, so it must preserve a
  // source a sibling adapter wrote (order-independent with the RWS refresh)
  const m = buildManifest([{ uuid: 'uuid-r', shortname: 'LOBITH', water: { shortname: 'RHEIN' } }], out);
  assert.equal(m.stations['uuid-r'].source, 'Rijkswaterstaat');
  assert.equal(m.stations['uuid-r'].from, 1990);
});

test('loadRepoArchive: a manifest none-entry skips archive fetches and flags the station', async () => {
  const app = loadApp({ now: NOON });
  app.run(`state.info = { uuid: 'gap-uuid' }`);
  app.run(`getJson = async url => {
    if (url === 'archive/manifest.json') return { stations: { 'gap-uuid': { n: 'Marburg', w: 'LAHN', none: true } } };
    globalThis.__unexpected = url;
    throw new Error('unexpected fetch ' + url);
  }`);
  await app.run('loadRepoArchive()');
  assert.equal(app.run('state.repoArchive'), 'none');
  assert.equal(globalThis.__unexpected, undefined, 'no year files were requested');
  delete globalThis.__unexpected;
});

test('loadRepoArchive: lazily merges current.json into the local archive', async () => {
  const app = loadApp({ now: NOON });
  const year = new Date(NOON).getUTCFullYear();
  const days = 365 + (((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 1 : 0);
  const min = Array(days).fill(null), max = Array(days).fill(null);
  min[9] = 110; max[9] = 190; // one archived day in the current year
  app.run(`state.info = { uuid: 'test-uuid' }`);
  app.run(`getJson = async url => {
    if (url === 'archive/test-uuid/current.json') return { y: ${year}, min: ${JSON.stringify(min)}, max: ${JSON.stringify(max)} };
    throw new Error('404 ' + url); // every other year file is missing — must not break the merge
  }`);
  await app.run('loadRepoArchive()');
  const arch = app.run(`loadArchive('BONN')`);
  assert.equal(arch.length, 2, 'one archived day → daily min + max as two points');
  assert.deepEqual(arch.map(p => p[1]), [110, 190]);
  const mezBase = Date.UTC(year, 0, 1) - 36e5 + 9 * 864e5;
  assert.deepEqual(arch.map(p => p[0]), [mezBase + 6 * 36e5, mezBase + 18 * 36e5]);

  // a second call is a no-op (per-session fetch guard), even with new data
  await app.run('loadRepoArchive()');
  assert.equal(app.run(`loadArchive('BONN')`).length, 2);
});

test('loadRepoArchive: merges the closed bundle + current.json in exactly 3 requests', async () => {
  const app = loadApp({ now: NOON });
  const year = new Date(NOON).getUTCFullYear();
  // closed.json: two past years, one archived day each; current.json: one day
  const oneDay = (idx, lo, hi, len) => {
    const min = Array(len).fill(null), max = Array(len).fill(null);
    min[idx] = lo; max[idx] = hi; return { min, max };
  };
  const closed = [
    { y: 2001, ...oneDay(0, 300, 340, 365) },
    { y: 2002, ...oneDay(0, 200, 260, 365) },
  ];
  const curY = year, cur = { y: curY, ...oneDay(0, 110, 190, 366) };
  app.run(`globalThis.__reqs = []`);
  app.run(`state.info = { uuid: 'bundle-uuid' }`);
  app.run(`getJson = async url => {
    globalThis.__reqs.push(url);
    if (url === 'archive/manifest.json') return { stations: { 'bundle-uuid': { n: 'BONN', w: 'RHEIN', from: 2001, to: ${curY} } } };
    if (url === 'archive/bundle-uuid/closed.json') return ${JSON.stringify(closed)};
    if (url === 'archive/bundle-uuid/current.json') return ${JSON.stringify(cur)};
    throw new Error('unexpected fetch ' + url);
  }`);
  await app.run('loadRepoArchive()');
  assert.equal(app.run('state.repoArchive'), 'available');
  const reqs = app.run('globalThis.__reqs');
  assert.deepEqual(reqs, ['archive/manifest.json', 'archive/bundle-uuid/closed.json', 'archive/bundle-uuid/current.json'],
    'exactly 3 archive requests: manifest, closed, current');
  const arch = app.run(`loadArchive('BONN')`);
  assert.equal(arch.length, 6, 'three archived days across bundle + current → two points each');
  assert.deepEqual(arch.map(p => p[1]), [300, 340, 200, 260, 110, 190]);
  delete globalThis.__reqs;
});

test('archiveSource: defaults to WSV, else the manifest source', () => {
  const app = loadApp({ now: NOON });
  assert.equal(app.run('archiveSource()'), 'WSV', 'no source → WSV');
  app.run(`state.archiveSource = 'Rijkswaterstaat'`);
  assert.equal(app.run('archiveSource()'), 'Rijkswaterstaat');
});

test('loadRepoArchive: an available entry carries its source through to state', async () => {
  const app = loadApp({ now: NOON });
  const year = new Date(NOON).getUTCFullYear();
  app.run(`state.info = { uuid: 'rws-uuid' }`);
  app.run(`getJson = async url => {
    if (url === 'archive/manifest.json') return { stations: { 'rws-uuid': { n: 'LOBITH', w: 'RHEIN', from: 1989, to: ${year}, source: 'Rijkswaterstaat' } } };
    if (url === 'archive/rws-uuid/closed.json') return [];
    if (url === 'archive/rws-uuid/current.json') return { y: ${year}, min: [100], max: [110] };
    throw new Error('unexpected fetch ' + url);
  }`);
  await app.run('loadRepoArchive()');
  assert.equal(app.run('state.repoArchive'), 'available');
  assert.equal(app.run('state.archiveSource'), 'Rijkswaterstaat', 'source flows from the manifest entry');
});

test('yearsViewModel: attributes the hosted archive to its manifest source', () => {
  for (const [source, label] of [[null, 'WSV'], ['Rijkswaterstaat', 'Rijkswaterstaat']]) {
    const app = loadApp({ now: NOON });
    const { vm, html } = app.run(`(() => {
      station = 'LOBITH';
      state.info = { uuid: 'u', water: { shortname: 'RHEIN' } };
      state.repoArchive = 'available';
      state.archiveSource = ${JSON.stringify(source)};
      state.archive = []; // too little history -> the "fetching the ..." line
      const vm = yearsViewModel();
      return { vm, html: renderYears(vm) };
    })()`);
    assert.equal(vm.thin, true);
    assert.ok(vm.reason.includes(`fetching the ${label} archive`), `${label} attribution shown`);
    assert.ok(html.includes(label), 'and it reaches the plate');
  }
});


// ---------- Rijkswaterstaat adapter (scripts/fetch-rws-archive.mjs) ----------

test('rws adapter: station registry is well-formed (10 unique gauges, kept raw)', async () => {
  const { STATIONS } = await import('../scripts/fetch-rws-archive.mjs');
  assert.equal(STATIONS.length, 10);
  assert.equal(new Set(STATIONS.map(s => s.uuid)).size, 10, 'unique uuids');
  assert.equal(new Set(STATIONS.map(s => s.code)).size, 10, 'unique RWS codes');
  for (const s of STATIONS) assert.equal(s.offsetCm, 0, `${s.name} kept raw (no datum shift)`);
  // TIEL is the one gauge whose RWS code changed mid-life; both codes are fetched
  const tiel = STATIONS.find(s => s.name === 'TIEL');
  assert.deepEqual(tiel.histCodes, ['tiel.sluis.waal'], 'TIEL keeps its retired historical code');
});

test('rws adapter: fetchYear parses observations, drops gap sentinels and nulls', async () => {
  const { fetchYear } = await import('../scripts/fetch-rws-archive.mjs');
  const fake = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.Locatie.Code, 'lobith.bovenrijn.tolkamer');
    assert.equal(body.AquoPlusWaarnemingMetadata.AquoMetadata.Grootheid.Code, 'WATHTE');
    return { status: 200, json: async () => ({ Succesvol: true, WaarnemingenLijst: [{ MetingenLijst: [
      { Tijdstip: '2024-06-01T12:00:00+02:00', Meetwaarde: { Waarde_Numeriek: 705 } },
      { Tijdstip: '2024-06-01T12:10:00+02:00', Meetwaarde: { Waarde_Numeriek: 999999999 } }, // sentinel
      { Tijdstip: '2024-06-01T12:20:00+02:00', Meetwaarde: { Waarde_Numeriek: null } },       // gap
    ] }] }) };
  };
  const pts = await fetchYear('lobith.bovenrijn.tolkamer', 2024, fake);
  assert.deepEqual(pts, [{ timestamp: '2024-06-01T12:00:00+02:00', value: 705 }], 'only the real value survives');
  assert.deepEqual(await fetchYear('x', 2024, async () => ({ status: 204 })), [], '204 = no data');
  await assert.rejects(() => fetchYear('x', 2024,
    async () => ({ status: 200, json: async () => ({ Succesvol: false, Foutmelding: 'boom' }) })), /boom/);
});

test("rws adapter: fetchStation unions a gauge's multiple codes per day", async () => {
  const { fetchStation } = await import('../scripts/fetch-rws-archive.mjs');
  const byCode = {
    live: [{ Tijdstip: '2024-01-02T12:00:00+01:00', Meetwaarde: { Waarde_Numeriek: 300 } }],
    hist: [
      { Tijdstip: '2024-01-02T12:00:00+01:00', Meetwaarde: { Waarde_Numeriek: 500 } }, // same day → union
      { Tijdstip: '2024-01-03T12:00:00+01:00', Meetwaarde: { Waarde_Numeriek: 200 } }, // day the live code lacks
    ],
  };
  const fake = async (url, opts) => {
    const code = JSON.parse(opts.body).Locatie.Code;
    return { status: 200, json: async () => ({ Succesvol: true, WaarnemingenLijst: [{ MetingenLijst: byCode[code] || [] }] }) };
  };
  const { years } = await fetchStation({ code: 'live', histCodes: ['hist'], offsetCm: 0 }, 2024, 2024, fake);
  const y = years.get(2024);
  assert.equal(y.max[1], 500, 'Jan 2 unions both codes → higher value wins');
  assert.equal(y.min[1], 300, 'Jan 2 lower value across both codes');
  assert.equal(y.min[2], 200, 'Jan 3 comes from the historical code alone');
});

test('rws adapter: updateManifest upserts source, leaves WSV entries intact', async () => {
  const { updateManifest } = await import('../scripts/fetch-rws-archive.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'pegel-rws-'));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ generated: 'x', stations: {
    'wsv-1': { n: 'BONN', w: 'RHEIN', from: 2000, to: 2025 } } }));
  mkdirSync(join(out, 'rws-1'));
  writeFileSync(join(out, 'rws-1', 'closed.json'), JSON.stringify([{ y: 1989, min: [10], max: [20] }]));
  writeFileSync(join(out, 'rws-1', 'meta.json'), JSON.stringify({ name: 'LOBITH', source: 'Rijkswaterstaat' }));
  const m = updateManifest(out, [{ uuid: 'rws-1', name: 'LOBITH', water: 'RHEIN' }]);
  assert.deepEqual(m.stations['wsv-1'], { n: 'BONN', w: 'RHEIN', from: 2000, to: 2025 }, 'WSV entry untouched');
  assert.equal(m.stations['rws-1'].source, 'Rijkswaterstaat');
  assert.equal(m.stations['rws-1'].from, 1989);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'))).stations['rws-1'].source, 'Rijkswaterstaat');
});

// ---------- the January year-freeze (script clock pinned via PEGEL_NOW) ----------

// PEGEL_NOW is read at module load, so each scenario runs in its own process
function runWithClock(nowIso, code) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PEGEL_NOW: nowIso },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  }));
}

test('archive script: January --current run freezes the completed year', () => {
  const out = runWithClock('2027-01-03T04:23:00Z', `
    import { currentRunPlan, condense, writeStation } from './scripts/fetch-wsv-archive.mjs';
    import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const plan = currentRunPlan();
    const measurements = [
      { timestamp: '2026-12-30T10:00:00+01:00', value: 250 },
      { timestamp: '2026-12-31T23:45:00+01:00', value: 260 },
      { timestamp: '2027-01-01T00:15:00+01:00', value: 261 },
      { timestamp: '2027-01-02T12:00:00+01:00', value: 270 },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'pegel-jan-'));
    writeStation(dir, 'BONN', condense(measurements), plan.startYear, plan.fetchedThrough);
    const files = readdirSync(dir).sort();
    const closed = JSON.parse(readFileSync(join(dir, 'closed.json')));
    const frozen = closed.find(yr => yr.y === 2026);
    const current = JSON.parse(readFileSync(join(dir, 'current.json')));
    console.log(JSON.stringify({ plan, files, bundleYears: closed.map(yr => yr.y),
      frozenLastMax: frozen.max[364], currentY: current.y, currentFirstMin: current.min[0],
      meta: JSON.parse(readFileSync(join(dir, 'meta.json'))) }));
  `);
  assert.equal(out.plan.startYear, 2026, 'January re-pulls the completed year');
  assert.equal(out.plan.fetchedThrough, 2026);
  assert.equal(out.plan.endDate, '2027-01-03');
  assert.deepEqual(out.files, ['closed.json', 'current.json', 'meta.json']);
  assert.deepEqual(out.bundleYears, [2026], 'completed year lands in the immutable bundle');
  assert.equal(out.frozenLastMax, 260, 'Dec 31 (MEZ) is the last slot of the frozen year');
  assert.equal(out.currentY, 2027, 'current.json restarts with the new year');
  assert.equal(out.currentFirstMin, 261);
  assert.equal(out.meta.fetchedThrough, 2026);
});

test('archive script: mid-year --current run touches only the running year', () => {
  const out = runWithClock('2026-07-16T12:00:00Z', `
    import { currentRunPlan } from './scripts/fetch-wsv-archive.mjs';
    console.log(JSON.stringify(currentRunPlan()));
  `);
  assert.equal(out.startYear, 2026);
  assert.equal(out.fetchedThrough, 2025);
  assert.equal(out.endDate, '2026-07-16');
});

test('archive script: a backfill folds every completed year into one closed.json bundle', async () => {
  const { writeStation, condense } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, readdirSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pegel-bundle-'));
  // three past years, out of chronological order in the source measurements
  const years = condense([
    { timestamp: '2011-06-01T12:00:00+01:00', value: 111 },
    { timestamp: '2010-06-01T12:00:00+01:00', value: 100 },
    { timestamp: '2012-06-01T12:00:00+01:00', value: 122 },
  ]);
  writeStation(dir, 'BONN', years, 2010, 2012);
  assert.deepEqual(readdirSync(dir).sort(), ['closed.json', 'meta.json'], 'no per-year files, no current.json');
  const bundle = JSON.parse(readFileSync(join(dir, 'closed.json')));
  assert.deepEqual(bundle.map(yr => yr.y), [2010, 2011, 2012], 'bundle sorted ascending');
  assert.ok(!existsSync(join(dir, 'current.json')));
});

test('archive script: monthly --current upserts into current.json, closed.json untouched', async () => {
  const { writeStation, condense } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const Y = new Date().getUTCFullYear(); // writeStation's running year (real clock)
  const dir = mkdtempSync(join(tmpdir(), 'pegel-cur-'));
  // an immutable closed bundle already on disk, plus a partial running year
  const closedBefore = JSON.stringify([{ y: 2000, min: [50], max: [60] }]);
  writeFileSync(join(dir, 'closed.json'), closedBefore);
  const seed = { min: Array(366).fill(null), max: Array(366).fill(null) };
  seed.min[0] = 80; seed.max[0] = 90; // Jan 1 already archived from an earlier run
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ y: Y, ...seed }));
  // a fresh 30-day fetch condensed to one new day (day index 40 this year)
  const fresh = new Map([[Y, { min: Array(366).fill(null), max: Array(366).fill(null) }]]);
  fresh.get(Y).min[40] = 70; fresh.get(Y).max[40] = 130;
  writeStation(dir, 'BONN', fresh, Y, Y - 1);
  const cur = JSON.parse(readFileSync(join(dir, 'current.json')));
  assert.equal(cur.y, Y);
  assert.equal(cur.min[0], 80, 'earlier day preserved'); assert.equal(cur.max[0], 90);
  assert.equal(cur.min[40], 70, 'new day merged in'); assert.equal(cur.max[40], 130);
  assert.equal(readFileSync(join(dir, 'closed.json'), 'utf8'), closedBefore, 'closed.json byte-identical (not rewritten)');
});

test('archive script: the January freeze graduates a pre-accumulated current.json into the bundle', () => {
  const out = runWithClock('2027-01-03T04:23:00Z', `
    import { writeStation, condense } from './scripts/fetch-wsv-archive.mjs';
    import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const dir = mkdtempSync(join(tmpdir(), 'pegel-freeze-'));
    // current.json holds 2026, accumulated month by month all year (summer day set)
    const acc = { y: 2026, min: Array(365).fill(null), max: Array(365).fill(null) };
    acc.min[180] = 42; acc.max[180] = 88; // a July value only this file has
    writeFileSync(join(dir, 'current.json'), JSON.stringify(acc));
    // the Jan-3 REST fetch spans late Dec 2026 into early Jan 2027
    const fresh = condense([
      { timestamp: '2026-12-31T23:45:00+01:00', value: 260 },
      { timestamp: '2027-01-01T00:15:00+01:00', value: 261 },
    ]);
    writeStation(dir, 'BONN', fresh, 2026, 2026);
    const closed = JSON.parse(readFileSync(join(dir, 'closed.json')));
    const frozen = closed.find(yr => yr.y === 2026);
    const current = JSON.parse(readFileSync(join(dir, 'current.json')));
    console.log(JSON.stringify({ files: readdirSync(dir).sort(), bundleYears: closed.map(yr => yr.y),
      frozenJuly: frozen.max[180], frozenDec31: frozen.max[364], currentY: current.y, currentJan1: current.min[0] }));
  `);
  assert.deepEqual(out.files, ['closed.json', 'current.json', 'meta.json']);
  assert.deepEqual(out.bundleYears, [2026], 'the completed year graduated into the bundle');
  assert.equal(out.frozenJuly, 88, 'the accumulated July value survived the graduation');
  assert.equal(out.frozenDec31, 260, 'the fresh December day merged into the frozen year');
  assert.equal(out.currentY, 2027, 'current.json restarts at the new running year');
  assert.equal(out.currentJan1, 261);
});

test('archive script: migrateStation folds per-year files into a sorted closed.json bundle', async () => {
  const { migrateStation } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pegel-migrate-'));
  const y2001 = { y: 2001, min: [1], max: [2] };
  const y2000 = { y: 2000, min: [3], max: [4] };
  const y2002 = { y: 2002, min: [5], max: [6] };
  writeFileSync(join(dir, '2001.json'), JSON.stringify(y2001));
  writeFileSync(join(dir, '2000.json'), JSON.stringify(y2000));
  writeFileSync(join(dir, '2002.json'), JSON.stringify(y2002));
  writeFileSync(join(dir, 'meta.json'), '{"name":"BONN","fetchedThrough":2002}');
  const n = migrateStation(dir);
  assert.equal(n, 3);
  assert.deepEqual(readdirSync(dir).sort(), ['closed.json', 'meta.json'], 'year files removed, meta untouched');
  const bundle = JSON.parse(readFileSync(join(dir, 'closed.json')));
  assert.deepEqual(bundle, [y2000, y2001, y2002], 'bundle is the sorted union of the year files');
});

test('client in January: a not-yet-frozen current.json still maps to its own year', async () => {
  // Jan 5, 2027: the CI freeze has not run yet, current.json still carries 2026
  const app = loadApp({ now: Date.UTC(2027, 0, 5, 12) });
  const min = Array(365).fill(null), max = Array(365).fill(null);
  min[363] = 250; max[363] = 260; // Dec 30, 2026
  app.run(`state.info = { uuid: 'jan-uuid' }`);
  app.run(`getJson = async url => {
    if (url === 'archive/jan-uuid/current.json') return { y: 2026, min: ${JSON.stringify(min)}, max: ${JSON.stringify(max)} };
    throw new Error('404 ' + url);
  }`);
  await app.run('loadRepoArchive()');
  const arch = app.run(`loadArchive('BONN')`);
  assert.equal(arch.length, 2);
  const dec30 = Date.UTC(2026, 0, 1) - 36e5 + 363 * 864e5;
  assert.deepEqual(arch.map(p => p[0]), [dec30 + 6 * 36e5, dec30 + 18 * 36e5],
    'points land on Dec 30, 2026 — the file year wins, not the wall clock');
});

test('historyViewModel: the time axis is labelled from real timestamps', () => {
  const app = loadApp({ now: NOON });
  // two years of daily points ending at NOON — multi-year span → YYYY-MM ticks
  const days = 730;
  const pts = Array.from({ length: days }, (_, i) => [NOON - (days - 1 - i) * 864e5, 100 + (i % 40)]);
  app.run(`state.archive = ${JSON.stringify(pts)}`);
  app.run(`historyKey = 'all'`);
  const h = app.run('historyViewModel()');
  assert.equal(h.empty, false);
  assert.ok(h.ticks.every(t => /^\d{4}-\d{2}$/.test(t.text)), `YYYY-MM ticks: ${h.ticks.map(t => t.text)}`);
  assert.equal(h.ticks[0].text, '2024-01', 'the first tick sits at the two-years-ago start (NOON is 2026-01-15)');
  assert.equal(h.ticks.at(-1).text, '2026-01', 'the last tick is the now end');
  assert.ok(h.ticks.every(t => t.frac >= 0 && t.frac <= 1), 'ticks are positioned as fractions, not columns');
  // ticks read their own column's timestamp: gaps compress, so a linear time
  // axis would misplace them
  assert.ok(h.ticks[0].frac < h.ticks.at(-1).frac, 'and run left to right');
});

test('history presets: 1Y/5Y exist, API backfill stays within its 30-day reach', () => {
  const app = loadApp();
  const presets = app.run('HISTORY_PRESETS');
  assert.deepEqual(presets.map(p => p.k), ['24h', '3d', '7d', '15d', '30d', '1y', '5y', '10y', '20y', 'all']);
  assert.equal(presets.find(p => p.k === '1y').d, 365);
  assert.equal(presets.find(p => p.k === '10y').d, 3650);
  assert.equal(presets.find(p => p.k === '20y').d, 7300);
  assert.equal(app.run('API_MAX_DAYS'), 30);
});

test('boot: ?river= wins over ?station=, plain boot is station mode', () => {
  const river = loadApp({ search: '?river=RHEIN&station=BONN' });
  assert.equal(river.run('mode'), 'river');
  assert.equal(river.run('state.river'), 'RHEIN');
  const station = loadApp({ search: '?station=MARBURG' });
  assert.equal(station.run('mode'), 'station');
  assert.equal(station.run('station'), 'MARBURG');
});

test('first-visit ASCII ?station= link self-corrects once the station list arrives', async () => {
  const app = loadApp({ search: '?station=KOELN' });
  assert.equal(app.run('station'), 'KOELN');
  app.run('state.error = \'station "KOELN" failed: 404 /stations/KOELN.json\'');
  app.run(`fetch = url => url.includes('stations.json')
    ? Promise.resolve({ ok: true, json: () => Promise.resolve([{ shortname: 'KÖLN', water: { shortname: 'RHEIN' }, km: 688 }]) })
    : Promise.reject(new Error('offline (test stub)'))`);
  app.run(`history.pushState = () => { globalThis.__pushed = true; };
    history.replaceState = () => { globalThis.__replaced = true; }`);
  await app.run('loadStationList()');
  assert.equal(app.run('station'), 'KÖLN', 'error screen self-corrected to the canonical station');
  assert.equal(globalThis.__replaced, true, 'canonical URL replaces the broken one');
  assert.equal(globalThis.__pushed, undefined, 'Back must not land on the 404 URL again');
  delete globalThis.__replaced; delete globalThis.__pushed;
});

// a returning visitor's cached station names, so boot resolves without the network
const WARM_STATIONS = {
  'pegel.stations': JSON.stringify({
    v: 2,
    t: Date.now(),
    list: [
      { n: 'MAGDEBURG-BUCKAU', w: 'ELBE', km: 318 },
      { n: 'MAGDEBURG-STROMBRÜCKE', w: 'ELBE', km: 326.6 },
      { n: 'KÖLN', w: 'RHEIN', km: 688 },
      { n: 'BONN', w: 'RHEIN', km: 654.8 },
    ],
  }),
};

test('deep link: an ambiguous ?station= opens the did-you-mean list, not a 404', () => {
  const app = loadApp({ search: '?station=MAGDEBURG', storage: WARM_STATIONS });
  const sg = app.run('state.suggest');
  assert.ok(sg, 'the shared link takes the same resolution path the prompt takes');
  assert.equal(sg.q, 'MAGDEBURG');
  assert.deepEqual(sg.matches.map(m => m.name), ['MAGDEBURG-BUCKAU', 'MAGDEBURG-STROMBRÜCKE']);
  assert.equal(app.run('station'), 'MAGDEBURG', 'no gauge is picked on the reader’s behalf');
});

test('deep link: only an ambiguous name gets the list — unknown, unique and folded stay as they were', () => {
  const nope = loadApp({ search: '?station=XXXXNOPE', storage: WARM_STATIONS });
  assert.equal(nope.run('state.suggest'), null, 'nothing resembles it — the error plate is the honest answer');
  assert.equal(nope.run('station'), 'XXXXNOPE');

  const one = loadApp({ search: '?station=BUCKAU', storage: WARM_STATIONS });
  assert.equal(one.run('state.suggest'), null);
  assert.equal(one.run('station'), 'MAGDEBURG-BUCKAU', 'a single substring match is adopted outright');

  const ascii = loadApp({ search: '?station=KOELN', storage: WARM_STATIONS });
  assert.equal(ascii.run('state.suggest'), null);
  assert.equal(ascii.run('station'), 'KÖLN', 'the exact fold still wins before any search');

  const river = loadApp({ search: '?river=RHEIN&station=MAGDEBURG', storage: WARM_STATIONS });
  assert.equal(river.run('state.suggest'), null, 'river mode owns the plate — no suggest screen over it');
});

test('recent chips: only a gauge that actually answered is remembered', async () => {
  const dead = loadApp({ search: '?station=MAGDEBURG', storage: WARM_STATIONS });
  assert.equal(dead.localStorage['pegel.recent'], undefined, 'a deep link that never loaded leaves no chip');
  dead.run(`switchStation('XXXXNOPE', '')`);
  assert.equal(dead.localStorage['pegel.recent'], undefined, 'nor does switching to a name that fails');

  const app = loadApp({ search: '?station=BONN', storage: WARM_STATIONS });
  app.run(`fetch = url => {
    const body =
      url.includes('/stations/BONN.json') ? { shortname: 'BONN', water: { shortname: 'RHEIN' }, km: 654.8, timeseries: [{ shortname: 'W' }] } :
      url.includes('/stations/BONN/W.json') ? { currentMeasurement: { timestamp: new Date().toISOString(), value: 250 } } :
      url.includes('measurements.json') ? [] : null;
    return body === null
      ? Promise.reject(new Error('offline (test stub)'))
      : Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }`);
  await app.run('loadData()');
  assert.ok(app.localStorage['pegel.recent'], 'a reading arrived — now it earns its chip');
  assert.deepEqual(JSON.parse(app.localStorage['pegel.recent']), ['BONN']);
});

test('archive script: migrateStation names the malformed year file instead of a bare SyntaxError', async () => {
  const { migrateStation } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pegel-badmigrate-'));
  writeFileSync(join(dir, '2000.json'), JSON.stringify({ y: 2000, min: [1], max: [2] }));
  writeFileSync(join(dir, '2001.json'), '{nope');
  assert.throws(() => migrateStation(dir), /2001\.json.*re-run --migrate/s, 'error carries the file path and the next step');
  assert.deepEqual(readdirSync(dir).sort(), ['2000.json', '2001.json'], 'nothing written or deleted on failure');
});

// ---------- report issue ----------

test('buildReportBody: covers everything the renderer branches on, redacts receiver URLs', () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const app = loadApp({ now, search: '?station=BONN&adsb=10.0.0.5:8080&ais=10.0.0.9:8080/aiscatcher' });
  app.run(`state.info = { water: { shortname: 'RHEIN' }, km: 654.8 }`);
  app.run(`state.gauge = { currentMeasurement: { value: 250, timestamp: ${now}, stateMnwMhw: 'normal' } }`);
  app.run('state.wt = 12.3');
  app.run('state.q = 500');
  app.run('state.neighbors = [1, 2, 3]');
  app.run('state.flowLowKm = true');
  app.run(`state.archive = [[${now} - 2 * 3600000, 230], [${now}, 250]]`);
  app.run('state.repoArchive = "available"');
  app.run(`historyKey = '7d'`);

  const body = app.run(`buildReportBody(${JSON.stringify('the river should be blue, not on fire')})`);

  assert.match(body, /station: BONN/);
  assert.match(body, /mode: station/);
  assert.match(body, /water: RHEIN/);
  assert.match(body, /river km: 654\.8/);
  assert.match(body, /history range: 7d/);
  assert.match(body, /points in local archive: 2/);
  assert.match(body, /hosted archive loaded: true \(source: WSV\)/);
  assert.match(body, /plate: \d+px (narrow|wide)/);
  assert.match(body, /flowLowKm: true/);
  assert.match(body, /neighbors: 3/);
  assert.match(body, /W: 250 cm/);
  assert.match(body, /WT: 12\.3 °C/);
  assert.match(body, /Q: 500 m³\/s/);
  assert.match(body, /trend: 10\.0 cm\/h/);
  assert.match(body, /state: normal/);
  assert.match(body, /adsb configured: true/);
  assert.match(body, /ais configured: true/);
  assert.match(body, /app commit: dev/, 'unreplaced __COMMIT__ placeholder falls back to dev');
  assert.match(body, /the river should be blue, not on fire/);
  assert.ok(!body.includes('10.0.0.5'), 'adsb receiver URL never appears, only whether it is configured');
  assert.ok(!body.includes('10.0.0.9'), 'ais receiver URL never appears, only whether it is configured');
});

test('buildReportBody: state.error and unconfigured receivers report honestly', () => {
  const app = loadApp({ search: '?station=BONN' });
  app.run('state.error = \'station "BONN" failed: 500 /stations/BONN/W/measurements.json\'');

  const body = app.run(`buildReportBody('')`);

  assert.match(body, /error: station "BONN" failed: 500/);
  assert.match(body, /adsb configured: false/);
  assert.match(body, /ais configured: false/);
  assert.match(body, /W: n\/a/);
  assert.match(body, /trend: n\/a/);
  assert.match(body, /_\(no note provided\)_/);
});

test('buildReportUrl: trims an oversized note to stay under the GitHub URL limit', () => {
  const app = loadApp({ search: '?station=BONN' });
  app.run(`state.info = { water: { shortname: 'RHEIN' }, km: 654.8 }`);
  const hugeNote = 'x'.repeat(20000);

  const url = app.run(`buildReportUrl(${JSON.stringify(hugeNote)})`);

  assert.ok(url.length <= 8000, `expected url <= 8000 chars, got ${url.length}`);
  assert.ok(url.startsWith('https://github.com/bmmmm/pegel-visual/issues/new?'));
  const body = decodeURIComponent(new URL(url).searchParams.get('body'));
  assert.match(body, /station: BONN/, 'required context section survives trimming');
  assert.match(body, /water: RHEIN/, 'required context section survives trimming');
  assert.match(body, /\[trimmed\]/, 'a dropped section leaves a visible marker, not a silent cut');
  assert.ok(!body.includes(hugeNote), 'the oversized value is dropped whole, never truncated mid-value');
});

test('buildReportUrl: small reports pass through untrimmed', () => {
  const app = loadApp({ search: '?station=BONN' });
  const url = app.run(`buildReportUrl('short note')`);
  assert.ok(url.length <= 8000);
  const body = decodeURIComponent(new URL(url).searchParams.get('body'));
  assert.match(body, /short note/);
  assert.ok(!body.includes('[trimmed]'), 'nothing needed trimming at this size');
});

test('pages stamp: only the APP_COMMIT const line carries the __COMMIT__ literal', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const lines = html.split('\n').filter(l => l.includes('__COMMIT__'));
  assert.equal(lines.length, 1, 'the pages sed stamps every matching line — a second literal turns the dev guard always-true');
  assert.match(lines[0], /const APP_COMMIT = '__COMMIT__'/);
});

test('archive script: January freeze prefers ZIP days, REST fills only ZIP gaps', async () => {
  const { freezeFromZip } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pegel-freeze-'));
  const n = 365; // 2026
  const cur = { y: 2026, min: Array(n).fill(null), max: Array(n).fill(null) };
  cur.min[10] = 80; cur.max[10] = 300; // monthly snapshot caught a since-corrected spike
  cur.min[20] = 120; cur.max[20] = 130; // day the ZIP archive is missing
  writeFileSync(join(dir, 'current.json'), JSON.stringify(cur));
  const zy = { min: Array(n).fill(null), max: Array(n).fill(null) };
  zy.min[10] = 81; zy.max[10] = 95; // the archive's corrected day
  const frozen = await freezeFromZip(dir, 'uuid-x', 2026, async () => ({ years: new Map([[2026, zy]]) }));
  assert.equal(frozen, true);
  const out = JSON.parse(readFileSync(join(dir, 'current.json')));
  assert.equal(out.max[10], 95, 'ZIP day wins — the REST outlier does not survive into the bundle');
  assert.equal(out.min[10], 81);
  assert.equal(out.min[20], 120, 'REST fills only ZIP-null days');
  assert.equal(out.max[20], 130);
});

test('archive script: ZIP freeze skips without fetching and fails loudly without clobbering', async () => {
  const { freezeFromZip } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // no current.json -> nothing to freeze, the ZIP endpoint must not even be hit
  const empty = mkdtempSync(join(tmpdir(), 'pegel-freeze-skip-'));
  assert.equal(await freezeFromZip(empty, 'u', 2026, async () => { throw new Error('must not fetch'); }), false);
  // ZIP path down -> throws (caller falls back), REST accumulation left untouched
  const dir = mkdtempSync(join(tmpdir(), 'pegel-freeze-fail-'));
  const cur = { y: 2026, min: [100], max: [110] };
  writeFileSync(join(dir, 'current.json'), JSON.stringify(cur));
  await assert.rejects(
    () => freezeFromZip(dir, 'u', 2026, async () => { throw new Error('prepare failed (503)'); }),
    /prepare failed/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'current.json'))), cur, 'accumulation preserved for the fallback graduation');
  // ZIP reachable but empty for the year -> false, accumulation graduates as-is
  assert.equal(await freezeFromZip(dir, 'u', 2026, async () => ({ years: new Map() })), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'current.json'))), cur);
});

test("archive script: a --current run leaves meta.fetchedFrom untouched (regression: collided with the gap sweep's resumability check)", async () => {
  const { writeStation, condense } = await import('../scripts/fetch-wsv-archive.mjs');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const Y = new Date().getUTCFullYear();
  const fresh = condense([{ timestamp: `${Y}-03-01T12:00:00+01:00`, value: 100 }]);
  // a station whose backfill finished long ago but predates the fetchedFrom field
  // (exactly the state every seeded/migrated station is in on disk today)
  const dir = mkdtempSync(join(tmpdir(), 'pegel-cur-meta-'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: 'BONN', fetchedThrough: Y - 1 }));
  writeStation(dir, 'BONN', fresh, null, 0); // the CURRENT_ONLY call shape: no backfill claim, no fetchedThrough claim
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json')));
  assert.equal(meta.fetchedFrom, undefined, 'a --current run has no backfill-start claim to make');
  assert.equal(meta.fetchedThrough, Y - 1, 'unaffected');
  // a station whose backfill DID record fetchedFrom must keep it across --current runs too
  const dir2 = mkdtempSync(join(tmpdir(), 'pegel-cur-meta-2-'));
  writeFileSync(join(dir2, 'meta.json'), JSON.stringify({ name: 'BONN', fetchedFrom: 2000, fetchedThrough: Y - 1 }));
  writeStation(dir2, 'BONN', fresh, null, 0);
  const meta2 = JSON.parse(readFileSync(join(dir2, 'meta.json')));
  assert.equal(meta2.fetchedFrom, 2000, 'an existing backfill-start year survives a --current run');
});

// ---------- years view (multi-year statistics) ----------

// mid-July noon: the current year has ~half a year of data in the fixtures below
const JULY = Date.UTC(2026, 6, 15, 12);

// three years of daily points, two per day like the hosted archive: a seasonal
// sine (high winter, low summer) plus per-year offsets injected by `tweak`
const seedArchive = (app, tweak = '0') => app.run(`(() => {
  const pts = [];
  for (let y = 2024; y <= 2026; y++) {
    const end = y === 2026 ? Date.UTC(2026, 6, 15) : Date.UTC(y + 1, 0, 1);
    for (let ts = Date.UTC(y, 0, 1); ts < end; ts += 864e5) {
      const doy = Math.floor((ts - Date.UTC(y, 0, 1)) / 864e5);
      const m = new Date(ts).getUTCMonth();
      const v = 200 + Math.round(100 * Math.cos(2 * Math.PI * doy / 365)) + (${tweak});
      pts.push([ts + 6 * 36e5, v - 5], [ts + 18 * 36e5, v + 5]);
    }
  }
  state.archive = pts;
  histCache = null;
  return pts.length;
})()`);

test('dailyMeans: groups points into per-UTC-day means, in order', () => {
  const app = loadApp();
  const d0 = Date.UTC(2026, 0, 1);
  const out = app.run(`dailyMeans([[${d0} + 6 * 36e5, 100], [${d0} + 18 * 36e5, 200], [${d0} + 864e5, 300]])`);
  assert.equal(out.length, 2);
  assert.equal(out[0].v, 150, 'two same-day points average');
  assert.equal(out[1].v, 300);
  assert.equal(out[1].d, out[0].d + 1);
});

test('buildHistStats: climatology comes from past years only, leap days index cleanly', () => {
  const app = loadApp({ now: JULY });
  seedArchive(app);
  const st = app.run(`(() => { const s = histStats(); return {
    years: s.years, curYear: s.curYear, climYears: s.climYears,
    jan: s.clim[0], dec31: s.byYear.get(2024)[365], nov: s.byYear.get(2026).slice(304, 366).filter(v => v != null).length,
  }; })()`);
  assert.deepEqual(st.years, [2024, 2025, 2026]);
  assert.equal(st.curYear, 2026);
  assert.equal(st.climYears, 2, '2026 is judged, not part of the baseline');
  assert.ok(st.jan.mean > 280, 'january climatology sits near the winter crest');
  assert.equal(st.dec31, 200 + Math.round(100 * Math.cos(2 * Math.PI * 365 / 365)), '2024 is a leap year: Dec 31 lands on day-of-year 365');
  assert.equal(st.nov, 0, 'the current year has no data after mid-July');
});

test('heatBinAbs / heatBinAnom: lightness bins, direction as its own channel', () => {
  const app = loadApp();
  // the ramp stays a LIGHTNESS ramp (one hue, dark = more), which is safe by
  // construction; the CSS turns the bin into a colour-mix step
  assert.equal(app.run(`heatBinAbs(0, 0, 100)`), 0);
  assert.equal(app.run(`heatBinAbs(99, 0, 100)`), 3);
  assert.equal(app.run(`heatBinAbs(-50, 0, 100)`), 0, 'below-range clamps');
  assert.equal(app.run(`heatBinAbs(500, 0, 100)`), 3, 'above-range clamps');
  // anomaly keeps magnitude in the bin and puts direction in its OWN field, so
  // the renderer can hatch it rather than relying on hue
  assert.deepEqual(app.run(`heatBinAnom(0.1)`), { bin: -1, dir: 0 }, 'near-normal is the neutral midpoint');
  assert.deepEqual(app.run(`heatBinAnom(3)`), { bin: 3, dir: 1 }, 'very wet: densest bin, wet direction');
  assert.deepEqual(app.run(`heatBinAnom(-3)`), { bin: 3, dir: -1 }, 'very dry: densest bin, dry direction');
  assert.equal(app.run(`heatBinAnom(1).bin`), 1);
  assert.equal(app.run(`heatBinAnom(1).dir`), 1);
});


test('renderYears: heatmap, monthly range and the year overlay all render', () => {
  const app = loadApp({ now: JULY });
  seedArchive(app);
  const { vm, html } = app.run(`(() => {
    const vm = yearsViewModel();
    return { vm, html: renderYears(vm) };
  })()`);
  assert.equal(vm.thin, false);
  for (const y of [2024, 2025, 2026]) {
    assert.ok(vm.rows.some(r => r.y === y), `year row ${y}`);
    assert.ok(html.includes(`>${y}<`), `${y} is printed`);
  }
  // a real table: rows and columns are announced, cells carry their own label
  assert.ok(html.includes('<table class="heat">'), 'the heatmap is a real table');
  assert.ok(html.includes('<th scope="row">') && html.includes('<th scope="col">'), 'with real headers');
  assert.ok(html.includes('aria-label="July 2026'), 'and every cell says what it is');
  assert.ok(html.includes('data-nav="cmd:hy:2024"'), 'year rows stay pickable');
  assert.ok(html.includes('data-nav="cmd:hm:2026:6"'), 'month cells too');
  assert.ok(html.includes('data-nav="cmd:live"'), 'back target');
  // all three sections
  assert.ok(html.includes('MONTHLY HEAT'), 'section 1');
  assert.ok(html.includes('LONG-TERM MONTHLY RANGE'), 'section 2');
  assert.ok(html.includes('EVERY YEAR BY DAY OF YEAR'), 'section 3');
  assert.ok(html.includes('class="ov-sel"'), 'the picked year is drawn bold in the overlay');
});


test('renderYears: the "pick a month cell" hint is printed once, not twice', () => {
  const app = loadApp({ now: JULY });
  seedArchive(app);
  const html = app.run('renderYears(yearsViewModel())');
  const hint = app.run('T.yearsHint');
  const hits = html.split(hint).length - 1;
  // it belongs to the readout panel's empty state; the key names marks only
  assert.equal(hits, 1, `"${hint}" appears ${hits} times`);
  assert.ok(html.includes(`class="p-dim p-readout">${hint}`), 'and the survivor is the readout');
});


test('renderYears: anomaly mode marks direction with a hatch, not just a hue', () => {
  const app = loadApp({ now: JULY });
  // 2026: January +150 (wet), May/June -150 (dry) against the 2024/25 baseline
  seedArchive(app, `y === 2026 && m === 0 ? 150 : y === 2026 && (m === 4 || m === 5) ? -150 : 0`);
  const { vm, html } = app.run(`(() => {
    histMode = 'anom';
    const vm = yearsViewModel();
    const html = renderYears(vm);
    histMode = 'abs';
    return { vm, html };
  })()`);
  const row = vm.rows.find(r => r.y === 2026);
  assert.equal(row.cells[0].dir, 1, 'january reads wet');
  assert.equal(row.cells[5].dir, -1, 'june reads dry');
  // direction is a CLASS the CSS hatches, so it survives greyscale and CVD
  assert.ok(html.includes(' wet"'), 'wet cells carry the wet class');
  assert.ok(html.includes(' dry"'), 'dry cells carry the dry class');
  assert.ok(html.includes('−2 σ') && html.includes('+2 σ'), 'the diverging legend labels its zero');
  assert.ok(html.includes('standard deviation'), 'and glosses sigma instead of assuming it');
});


test('yearsViewModel: too little data says so instead of drawing noise', () => {
  const app = loadApp({ now: JULY });
  app.run(`state.archive = [[${JULY} - 864e5, 100], [${JULY}, 110]]; histCache = null; state.repoArchive = 'none'`);
  const { vm, html } = app.run(`(() => {
    const vm = yearsViewModel();
    return { vm, html: renderYears(vm) };
  })()`);
  assert.equal(vm.thin, true);
  assert.ok(vm.reason.includes('no multi-year archive'), 'the none-manifest case is named');
  assert.ok(html.includes('no multi-year archive'));
  assert.ok(html.includes('grows with every visit'), 'and points at what does help');
});


// ---------- wave view (river station × day heatmap) ----------

test('foldYearsIntoWindow: maps archive days into the window across a year boundary', () => {
  const app = loadApp();
  const day0 = app.run(`epochDay(Date.UTC(2025, 11, 30))`); // window starts Dec 30
  const vals = app.run(`(() => {
    const vals = Array(6).fill(null);
    foldYearsIntoWindow([
      { y: 2025, min: Array(363).fill(null).concat([100, 120]), max: Array(363).fill(null).concat([110, 130]) },
      { y: 2026, min: [200, null, 220], max: [210, null, 230] },
    ], vals, ${day0});
    return vals;
  })()`);
  assert.deepEqual(vals, [105, 125, 205, null, 225, null], 'daily mid = (min+max)/2, gaps stay null');
});

test('waveViewModel: rows are scaled per gauge, labelled and disclosed', () => {
  const app = loadApp({ now: JULY });
  const { vm, html } = app.run(`(() => {
    const nDays = WAVE_FETCH_DAYS;
    const day0 = epochDay(Date.now()) - (nDays - 1);
    const mk = (name, kind, base) => ({ name, km: 0, kind,
      vals: Array.from({ length: nDays }, (_, i) => base + (i % 20)) });
    const w = { river: 'TESTFLUSS', day0, nDays, shown: 3, total: 5, rows: [
      mk('OBEN', 'normal', 100), mk('MITTE', 'high', 500),
      { name: 'FLAT', km: 0, kind: 'low', vals: Array(nDays).fill(42) },
    ]};
    const vm = waveViewModel(w);
    return { vm, html: renderWave(vm) };
  })()`);
  assert.deepEqual(vm.rows.map(r => r.name), ['OBEN', 'MITTE', 'FLAT']);
  assert.ok(html.includes('OBEN') && html.includes('MITTE'), 'station names');
  assert.ok(html.includes('3 of 5 gauges sampled'), 'the sampling is disclosed');
  // the caveat that used to be a clipped fragment is now a full sentence
  assert.ok(html.includes('scaled to its OWN gauge'), 'per-gauge scaling explained');
  assert.ok(html.includes('compare shape, not absolute level'), 'and why it matters');
  assert.ok(html.includes('data-nav="OBEN"'), 'rows are click targets');
  assert.ok(html.includes('data-nav="cmd:live"'), 'back target');
  // a dead-flat gauge takes a mid bin rather than reading as noise or as a peak
  const flat = vm.rows.find(r => r.name === 'FLAT');
  assert.ok(flat.cells.every(c => c.bin === 1), 'a flat gauge sits mid-ramp');
  const oben = vm.rows.find(r => r.name === 'OBEN');
  assert.ok(oben.cells.some(c => c.bin === 0) && oben.cells.some(c => c.bin === 3),
    'a varying gauge uses its own full range');
  assert.ok(html.includes('<table class="heat wave">'), 'a real table');
  assert.ok(html.includes('no reading') || vm.rows.every(r => r.cells.every(c => c.v != null)),
    'gaps are named rather than blank');
});


test('renderWave: the key names the row glyph it prefixes every station with', () => {
  const app = loadApp({ now: JULY });
  const { html, glyphs, labels } = app.run(`(() => {
    const nDays = WAVE_FETCH_DAYS;
    const day0 = epochDay(Date.now()) - (nDays - 1);
    const mk = (name, kind) => ({ name, km: 0, kind,
      vals: Array.from({ length: nDays }, (_, i) => 100 + (i % 20)) });
    const w = { river: 'TESTFLUSS', day0, nDays, shown: 3, total: 3, rows: [
      mk('OBEN', 'normal'), mk('MITTE', 'high'), mk('UNTEN', 'low') ]};
    return { html: renderWave(waveViewModel(w)),
      glyphs: RIVER_GLYPH, labels: [T.kindLow, T.kindNormal, T.kindHigh] };
  })()`);
  const key = html.slice(html.indexOf('<dl class="p-key">'));
  // a legend for every mark it uses: all three states, each named
  for (const kind of ['low', 'normal', 'high']) {
    assert.ok(key.includes(`class="k-${kind}"`), `the key carries the ${kind} glyph`);
  }
  for (const g of [glyphs.low, glyphs.normal, glyphs.high]) {
    assert.ok(key.includes(`>${g}</span>`), `the key draws ${g}`);
  }
  for (const label of labels) assert.ok(key.includes(label), `the key names "${label}"`);
});


// ---------- sub-view switching ----------

test('setView: mode guards, URL round-trip, wrong-mode boot normalizes', () => {
  const app = loadApp({ search: '?station=BONN&view=years' });
  assert.equal(app.run('viewMode'), 'years', 'boots into the years view from the URL');
  app.run(`setView('wave')`);
  assert.equal(app.run('viewMode'), 'years', 'wave is river-only and bounces off station mode');
  app.run(`setView('live')`);
  assert.equal(app.run('viewMode'), 'live');

  const river = loadApp({ search: '?river=RHEIN&view=years' });
  assert.equal(river.run('viewMode'), 'live', 'years is station-only: normalized away at boot');
  river.run(`setView('wave')`);
  assert.equal(river.run('viewMode'), 'wave');

  const junk = loadApp({ search: '?station=BONN&view=nonsense' });
  assert.equal(junk.run('viewMode'), 'live');
});

test('parseCommand / helpText: --view is a first-class flag', () => {
  const app = loadApp();
  assert.equal(app.run(`parseCommand('--view YEARS').view`), 'years', 'value is lowercased');
  assert.equal(app.run(`parseCommand('--station X').view`), undefined);
  assert.ok(app.run('helpText(null)').includes('--view'), 'man page mentions --view');
});

test('cropWaveWindow: cuts leading days until half the rows have data', () => {
  const app = loadApp();
  const rows = JSON.stringify([
    { vals: [null, null, 1, 1, 1] },
    { vals: [null, 2, 2, 2, 2] },
    { vals: [null, null, null, 3, 3] },
  ]);
  assert.equal(app.run(`cropWaveWindow(${rows}, 5)`), 2, 'day 2 is the first with >= 2 of 3 rows covered');
  assert.equal(app.run(`cropWaveWindow([{ vals: [1, 1] }], 2)`), 0, 'full coverage cuts nothing');
  assert.equal(app.run(`cropWaveWindow([], 5)`), 0, 'no rows, no cut');
  assert.equal(app.run(`cropWaveWindow([{ vals: [null, null] }], 2)`), 0, 'never-covered window stays uncut');
});

test('waveViewModel: a short window keeps every day it has', () => {
  const app = loadApp({ now: JULY });
  const vm = app.run(`(() => {
    const nDays = 20;
    const day0 = epochDay(Date.now()) - (nDays - 1);
    const w = { river: 'X', day0, nDays, shown: 1, total: 1, rows: [
      { name: 'OBEN', km: 0, kind: 'normal', vals: Array.from({ length: nDays }, (_, i) => i) },
    ]};
    return waveViewModel(w);
  })()`);
  // the character grid had to right-align a short window against the last
  // column; a table just carries all 20 days
  assert.equal(vm.days, 20);
  assert.equal(vm.rows[0].cells.length, 20);
  assert.equal(vm.rows[0].cells.at(-1).bin, 3, 'the newest day is the highest of its own range');
  assert.equal(vm.rows[0].cells[0].bin, 0);
});


test('plate controls: the range chips ride the history block, as real links', () => {
  const live = loadApp({ search: '?station=BONN' });
  const ctl = live.run('historyCtl()');
  for (const k of ['24h', '3d', '7d', '15d', '30d', '1y', '5y', '10y', '20y', 'all']) {
    assert.ok(ctl.includes(`data-nav="cmd:h:${k}"`), `${k} is offered`);
  }
  assert.ok(ctl.includes('▦ YEARS') && ctl.includes('data-nav="cmd:years"'), 'and the way into the years view');
  assert.ok(ctl.includes('class="on" href="?station=BONN" data-nav="cmd:h:30d"'),
    'the default window is lit and its link drops the redundant param');
  assert.ok(ctl.includes('href="?station=BONN&amp;history=24h" data-nav="cmd:h:24h"'),
    'every other window is a shareable URL');

  // and the block that draws the chart carries them — not a bar past the prompt
  const empty = live.run(`renderHistory({ empty: true, label: '30D' })`);
  assert.ok(empty.includes('data-nav="cmd:h:24h"'), 'even an empty window keeps its range chips');
  assert.equal(live.run(`typeof renderHistoryBar`), 'undefined', 'the standalone chip bar is gone');
});

test('setScreenHtml: the screen only swaps when the content changed', () => {
  const app = loadApp();
  const stable = app.run(`(() => {
    state.help = 'MAN PAGE';
    render();
    const first = screen.innerHTML;
    screen.innerHTML = 'SENTINEL'; // a repaint would overwrite this
    render();
    return { first, second: screen.innerHTML };
  })()`);
  assert.match(stable.first, /MAN PAGE/);
  assert.equal(stable.second, 'SENTINEL', 'unchanged content leaves the DOM alone');
  const changed = app.run(`(() => {
    state.help = 'NEW PAGE';
    render();
    return screen.innerHTML;
  })()`);
  assert.match(changed, /NEW PAGE/, 'changed content still repaints');
});


test('year paging + month readout: chips step and clamp, cells report numbers', () => {
  const app = loadApp({ width: 1200, now: JULY });
  seedArchive(app);
  // the year pager steps back through archived years and clamps at the oldest
  assert.equal(app.run(`(stepHistYear(-1), histSelYear(histStats()))`), 2025);
  assert.equal(app.run(`(stepHistYear(-1), stepHistYear(-1), stepHistYear(-1), histSelYear(histStats()))`), 2024, 'clamped at the oldest year');
  assert.equal(app.run(`(stepHistYear(1), histSelYear(histStats()))`), 2025);
  // the pager sits in the heat block's own control row, beside ABSOLUTE/ANOMALY
  const pager = app.run(`(viewMode = 'years', renderYears(yearsViewModel()))`);
  assert.ok(pager.includes('>◂<') && pager.includes('>▸<') && pager.includes('>2025<'), 'year pager chips present');
  assert.ok(pager.includes('data-nav="cmd:hy:2024"'), 'and each step names the year it lands on');
  assert.ok(pager.indexOf('cmd:abs') < pager.indexOf('cmd:hy:'), 'one row: shading mode, then the year');
  // picking a heatmap cell focuses the month AND puts its year on top
  app.run(`runGridCmd('hm:2024:3')`);
  assert.deepEqual(app.run('histFocus'), { y: 2024, m: 3 });
  assert.equal(app.run('histSelYear(histStats())'), 2024);
  const { vm, html } = app.run(`(() => {
    const vm = yearsViewModel();
    return { vm, html: renderYears(vm) };
  })()`);
  assert.equal(vm.readout.empty, false);
  assert.equal(vm.readout.y, 2024);
  assert.equal(vm.readout.m, 3);
  // the readout is a sentence now, not a glyph-prefixed one-liner
  assert.match(vm.readout.say, /^April 2024 averaged \d+ cm, ranging \d+–\d+ cm\./, vm.readout.say);
  assert.match(vm.readout.say, /σ (above|below) the long-term April mean of \d+ cm/, 'and names what it is measured against');
  assert.ok(html.includes(vm.readout.say.slice(0, 20)), 'and it reaches the plate');
  assert.ok(html.includes('data-nav="cmd:hm:2025:0"'), 'month cells are pick targets');
  // paging the year drags the readout month along
  app.run(`stepHistYear(1)`);
  assert.deepEqual(app.run('histFocus'), { y: 2025, m: 3 });
});


// ---------- regression tests for the QA-sweep findings ----------

test('switchRiver folds ASCII umlaut spellings like the station path', () => {
  const app = loadApp();
  app.run(`fillWaters(['MÜRITZSEE'])`);
  app.run(`switchRiver('mueritzsee')`);
  assert.equal(app.run('state.river'), 'MÜRITZSEE');
  assert.equal(app.run('mode'), 'river');
});

test('mergeIntoArchive rejects non-numeric values instead of poisoning min/max', () => {
  const app = loadApp({ now: NOON });
  const iso = ts => new Date(ts).toISOString();
  app.run(`mergeIntoArchive('BONN', [
    { timestamp: '${iso(NOON - 30 * 60000)}', value: 100 },
    { timestamp: '${iso(NOON - 15 * 60000)}', value: 'n/a' },
    { timestamp: '${iso(NOON - 10 * 60000)}', value: NaN },
    { timestamp: '${iso(NOON - 5 * 60000)}', value: 110 },
  ])`);
  assert.deepEqual(app.run(`loadArchive('BONN').map(p => p[1])`), [100, 110]);
});

test('countGaps tolerates the 6-hourly thinned cadence of multi-year points', () => {
  const app = loadApp({ now: NOON });
  const old = NOON - 400 * 864e5; // beyond the 1-year thinning cutoff
  const sixHourly = Array.from({ length: 5 }, (_, i) => [old + i * 6 * 36e5, 100]);
  assert.equal(app.run(`countGaps(${JSON.stringify(sixHourly)})`).gaps, 0, '6h cadence is not a gap for old points');
  const twelveHourly = [[old, 100], [old + 12 * 36e5, 100]];
  assert.equal(app.run(`countGaps(${JSON.stringify(twelveHourly)})`).gaps, 1, '12h IS a gap even for old points');
  const recent = [[NOON - 4 * 36e5, 100], [NOON - 36e5, 100]];
  assert.equal(app.run(`countGaps(${JSON.stringify(recent)})`).gaps, 1, '3h stays a gap for recent points');
});

test('renderHistory: a flat series draws at half height, not as an empty chart', () => {
  const app = loadApp({ now: NOON });
  const { h, html } = app.run(`(() => {
    state.archive = Array.from({ length: 50 }, (_, i) => [${NOON} - (50 - i) * 36e5, 77]);
    historyKey = 'all';
    const h = historyViewModel();
    return { h, html: renderHistory(h) };
  })()`);
  assert.equal(h.series.min, 77);
  assert.equal(h.series.max, 77);
  assert.ok(html.includes('77 cm'), 'the scale still names the level');
  // a flat window normalises to mid-box rather than collapsing every point to
  // zero fill, which used to read as "no data"
  assert.ok(html.includes('class="h-fill"'), 'the water body is still drawn');
  assert.ok(/48\.0|48 /.test(html), 'the surface sits at half of the 96-unit box');
});

test('bucketSeries: buckets tile the window, extremes come from every point', () => {
  const app = loadApp();
  // 12 points into 4 columns: three per bucket, nothing dropped
  const b = app.run('bucketSeries([5, 1, 9, 4, 4, 4, 7, 2, 8, 0, 6, 3], 4)');
  assert.deepEqual(b.lo, [1, 4, 2, 0]);
  assert.deepEqual(b.hi, [9, 4, 8, 6]);
  assert.equal(b.min, 0, 'window min is the smallest point, not the smallest sampled one');
  assert.equal(b.max, 9);

  // fewer points than columns: every bucket holds at most one point, so lo === hi
  // and both equal series[floor(x * step)] — exactly what the old renderer drew
  const series = [10, 40, 20, 30];
  const s = app.run(`bucketSeries(${JSON.stringify(series)}, 9)`);
  const old = Array.from({ length: 9 }, (_, x) => series[Math.min(3, Math.floor(x * (4 / 9)))]);
  assert.deepEqual(s.lo, old, 'degrades to the old one-point-per-column sampling');
  assert.deepEqual(s.hi, old);
  assert.deepEqual(s.lo, s.hi, 'no band at all when a bucket holds one point');
  assert.equal(s.min, 10);
  assert.equal(s.max, 40);

  // exactly as many points as columns: still one per bucket
  const e = app.run('bucketSeries([3, 1, 2], 3)');
  assert.deepEqual(e.lo, [3, 1, 2]);
  assert.deepEqual(e.hi, [3, 1, 2]);
});

// the hosted archive merges as two synthetic points per day (min 06:00, max
// 18:00), so one sample per column used to be a coin flip between the two — and
// the caption described that subsample rather than the window
test('historyViewModel: the scale reports the window extremes, not a subsample', () => {
  const app = loadApp({ now: NOON });
  const { h, html } = app.run(`(() => {
    const pts = [];
    for (let d = 0; d < 900; d++) {
      const ts = ${NOON} - (900 - d) * 864e5;
      pts.push([ts + 6 * 36e5, 200 - (d % 7)], [ts + 18 * 36e5, 260 + (d % 7)]);
    }
    // the record low and the record high sit on one single day in the middle
    pts[900][1] = 12;
    pts[901][1] = 987;
    state.archive = pts;
    historyKey = 'all';
    const h = historyViewModel();
    return { h, html: renderHistory(h) };
  })()`);
  assert.equal(h.series.min, 12, 'the real window low, not the low of whatever a column sampled');
  assert.equal(h.series.max, 987);
  assert.ok(html.includes('987 cm') && html.includes('12 cm'), 'and the scale prints them');
  assert.equal(h.banded, true, 'columns that merged more than one point carry a band');
  assert.ok(html.includes('class="h-band"'), 'which is drawn as its own polygon');
  assert.ok(html.includes('min–max inside one pixel column'), 'and named in the legend');
});

test('historyViewModel: windows with fewer points than columns carry no band', () => {
  for (const width of [390, 1200]) {
    const app = loadApp({ now: NOON, width });
    const { h, html } = app.run(`(() => {
      // 20 hourly readings — fewer than either width's bucket count
      state.archive = Array.from({ length: 20 }, (_, i) => [${NOON} - (20 - i) * 36e5, 100 + i * 3]);
      historyKey = '24h';
      const h = historyViewModel();
      return { h, html: renderHistory(h) };
    })()`);
    assert.equal(h.banded, false, `${width}px: no band when every bucket holds one point`);
    assert.ok(!html.includes('class="h-band"'), `${width}px: and none is drawn`);
    assert.ok(!html.includes('min–max inside'), `${width}px: no band legend either`);
    assert.equal(h.series.min, 100, `${width}px: extremes are the window's`);
    assert.equal(h.series.max, 157);
    assert.ok(html.includes('class="h-fill"'), `${width}px: the water body is still there`);
  }
});

// ---------- "is this unusual?" line ----------

// a station's stats stand-in: `n` archived daily means 1..n, and a climatology
// for the month under test
const fakeStats = (n, clim = null, years = 26) => ({
  allSorted: Array.from({ length: n }, (_, i) => i + 1),
  clim: Array.from({ length: 12 }, (_, m) => (m === 7 ? clim : null)),
  years: Array.from({ length: years }, (_, i) => 2000 + i),
});

test('unusualStats: percentile rank over the archived distribution, edges included', () => {
  const app = loadApp();
  const st = JSON.stringify(fakeStats(100));
  const pct = cm => app.run(`unusualStats(${st}, ${cm}, 7)`).pct;
  assert.equal(pct(0.5), 0, 'below every archived day → 0th percentile');
  assert.equal(pct(1), 1, 'equal to the single lowest day');
  assert.equal(pct(50), 50);
  assert.equal(pct(100), 100, 'equal to the highest day → 100th percentile');
  assert.equal(pct(9999), 100, 'above every archived day stays capped at 100');
  assert.equal(app.run(`unusualStats(${st}, 91, 7)`).years, 26);
  assert.equal(app.run(`unusualStats(${st}, 91, 7)`).cm, 91, 'the level is rounded, not reformatted');
});

test('unusualStats: null without an archive, without a reading, or below the noise floor', () => {
  const app = loadApp();
  assert.equal(app.run('unusualStats(null, 342, 7)'), null, 'no stats at all');
  assert.equal(app.run(`unusualStats({ allSorted: [], clim: [], years: [] }, 342, 7)`), null, 'empty archive');
  assert.equal(app.run(`unusualStats(${JSON.stringify(fakeStats(44))}, 20, 7)`), null,
    'one day short of HIST_MIN_DAYS stays silent');
  assert.ok(app.run(`unusualStats(${JSON.stringify(fakeStats(45))}, 20, 7)`), 'exactly HIST_MIN_DAYS speaks');
  assert.equal(app.run(`unusualStats(${JSON.stringify(fakeStats(100))}, NaN, 7)`), null, 'no numeric reading');
  // an archive that reaches back far enough but has no completed year for this
  // month yet: rank still works, the climatology half is simply absent
  const noClim = app.run(`unusualStats(${JSON.stringify(fakeStats(100))}, 50, 7)`);
  assert.equal(noClim.climMean, null);
  assert.equal(noClim.z, null);
  assert.equal(app.run(`unusualText(${JSON.stringify(noClim)}, false)`), '50 cm · 50th pct of 26y');
});

test('unusualStats: σ distance, incl. the sd floor that keeps tiny samples sane', () => {
  const app = loadApp();
  const st = n => JSON.stringify(fakeStats(60, { mean: 268, sd: n, min: 1, max: 2, med: 1 }));
  const u = app.run(`unusualStats(${st(50)}, 338, 7)`);
  assert.equal(u.climMean, 268);
  assert.equal(u.z.toFixed(2), '1.40', '(338 - 268) / 50');
  // buildHistStats floors sd at 1 cm; a floored sd must still produce a finite z
  const tiny = app.run(`unusualStats(${st(1)}, 271, 7)`);
  assert.equal(tiny.z, 3, 'a 1 cm sd gives a large but finite σ distance');
  assert.ok(Number.isFinite(app.run(`unusualStats(${st(1)}, 268, 7)`).z), 'zero deviation stays finite');
  assert.equal(app.run(`unusualStats(${st(50)}, 218, 7)`).z.toFixed(1), '-1.0', 'below the mean goes negative');
});

test('unusualText: terminal one-liner, compact variant fits 44 columns', () => {
  const app = loadApp();
  const u = { cm: 342, pct: 91, years: 26, month: 7, climMean: 268, z: 1.42 };
  assert.equal(app.run(`unusualText(${JSON.stringify(u)}, false)`),
    '342 cm · 91st pct of 26y · AUG mean 268 (+1.4σ)');
  const compact = app.run(`unusualText(${JSON.stringify(u)}, true)`);
  assert.equal(compact, '91st pct of 26y · AUG ⌀268 +1.4σ');
  assert.ok(compact.length <= 44, `compact line fits the 44-column grid (${compact.length})`);
  // widest plausible numbers must still fit the compact grid
  const wide = app.run(`unusualText(${JSON.stringify({ cm: 1234, pct: 100, years: 26, month: 11, climMean: -100, z: -12.34 })}, true)`);
  assert.ok(wide.length <= 44, `worst case still fits (${wide.length}): "${wide}"`);
  assert.equal(app.run('unusualText(null, false)'), '');
  // ordinals: the 11/12/13 exception and the plain cases
  const pctText = p => app.run(`unusualText(${JSON.stringify({ ...u, pct: p })}, true)`).split(' ')[0];
  assert.deepEqual([0, 1, 2, 3, 4, 11, 12, 13, 21, 42, 100].map(pctText),
    ['0th', '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '42nd', '100th']);
});

test('the insight sentence: spelled out for everyone, terse line kept for the fluent', () => {
  const mk = search => {
    const app = loadApp({ now: JULY, search });
    seedArchive(app);
    app.run(`historyKey = 'all';`);
    return app;
  };
  // no gauge reading yet -> no verdict, and no readout block
  const bare = mk('?station=BONN');
  assert.equal(bare.run('unusualNow()'), null, 'no current measurement, no verdict');

  const app = mk('?station=BONN');
  app.run(`state.gauge = { currentMeasurement: { value: 342, timestamp: ${JULY} } }`);
  const u = app.run('unusualNow()');
  assert.ok(u, 'three seeded years are enough archive to judge against');
  assert.equal(u.month, 6, 'JULY fixture -> the July climatology');
  assert.ok(u.fromYear, 'and the model carries the first archived year');

  const say = app.run(`insightSentence(unusualNow(), 342)`);
  // this is the line the feedback was about: "91st pct of 26y" told nobody anything
  assert.match(say, /342 cm/, 'names the reading');
  assert.match(say, /higher than/, 'in words, not jargon');
  // said from whichever end is the short one: "higher than 1 %" is true of a
  // record low but reads like good news
  const recordLow = app.run(`insightSentence({ pct: 1, fromYear: 1999, years: 27, month: 7, climMean: 250, z: -1.9 }, 96)`);
  assert.match(recordLow, /lower than <b>99 %<\/b>/, 'a record low is said as a record low');
  assert.match(recordLow, /clearly dry/, 'and the season comparison agrees');
  // and from whichever end is the short one — "higher than 1 %" reads like good
  // news when it is actually a record low
  const low = app.run(`insightSentence({ pct: 1, fromYear: 1999, years: 27, month: 7, climMean: 250, z: -1.9 }, 96)`);
  assert.match(low, /lower than <b>99 %<\/b>/, 'a record low is said as a record low');
  assert.match(say, /of all days recorded here since/, 'and says what it is compared against');
  assert.match(say, /since <b>\d{4}<\/b>/, 'naming the first archived year, not "26y"');
  assert.match(say, /July/, 'the month is spelled out, not JUL');
  assert.ok(!/pct|sigma|\bσ\b/.test(say), 'no unexplained abbreviations in the spoken line');

  // the terse mono line survives underneath it, unchanged, for people who read it fluently
  const terse = app.run('unusualText(unusualNow(), false)');
  assert.match(terse, /^342 cm · \d+(st|nd|rd|th) pct of 3y · JUL mean \d+ \([+-][\d.]+σ\)$/,
    `terse line unchanged: "${terse}"`);

  // a station WSV keeps no archive for still says nothing rather than guessing
  const none = loadApp({ now: JULY, search: '?station=BONN' });
  none.run(`state.archive = [[${JULY} - 36e5, 300], [${JULY}, 342]]; histCache = null;`);
  none.run(`state.gauge = { currentMeasurement: { value: 342, timestamp: ${JULY} } }; state.repoArchive = 'none';`);
  assert.equal(none.run('unusualNow()'), null, 'two local points are not a distribution');
  assert.equal(none.run('insightSentence(unusualNow(), 342)'), null, 'and no sentence is invented');
});
test('histStats cache: switching stations never serves the old station\'s stats', () => {
  const mk = v => { const pts = []; for (let d = 0; d < 365; d++) { const ts = Date.UTC(2025, 0, 1) + d * 864e5; pts.push([ts + 6 * 36e5, v], [ts + 18 * 36e5, v]); } return pts; };
  const app = loadApp({ now: JULY, search: '?station=BONN&view=years' });
  app.run(`state.archive = ${JSON.stringify(mk(300))}; histCache = null;`);
  app.run(`localStorage.setItem('pegel.archive.KOELN', JSON.stringify(${JSON.stringify(mk(500))}))`);
  app.run(`histStats()`); // warm the cache with BONN's shape
  app.run(`switchStation('KOELN')`);
  assert.equal(app.run(`histStats().byYear.get(2025)[0]`), 500, 'identical archive shape must not collide in the cache');
});

test('years view: no backwards range title without a completed year', () => {
  const app = loadApp({ now: JULY });
  const html = app.run(`(() => {
    const pts = [];
    for (let d = 0; d < 60; d++) { const ts = Date.UTC(2026, 0, 1) + d * 864e5; pts.push([ts + 6 * 36e5, 200]); }
    state.archive = pts; histCache = null;
    return renderYears(yearsViewModel());
  })()`);
  assert.ok(!html.includes('2026–2025'), 'no end-before-start range');
  assert.ok(html.includes('LONG-TERM MONTHLY RANGE'), 'section title survives');
  assert.ok(html.includes('at least one completed year'));
});


test('foldYearsIntoWindow survives malformed archive years without throw or NaN', () => {
  const app = loadApp();
  const day0 = app.run(`epochDay(Date.UTC(2026, 0, 1))`);
  const out = app.run(`(() => {
    const vals = Array(4).fill(null);
    foldYearsIntoWindow([
      { y: 2026, min: [1, 2, 3] },                    // max missing entirely
      { y: 2026, min: [10, 20, 30], max: [12] },      // max shorter than min
      null, { y: 'x', min: [], max: [] },             // garbage entries
    ], vals, ${day0});
    return vals;
  })()`);
  assert.deepEqual(out, [11, null, null, null], 'only the fully-valid day lands; no throw, no NaN');
});

test('wave cache: the 5-min river poll refreshes the state badges on cached rows', async () => {
  const app = loadApp({ now: JULY, search: '?river=RHEIN&view=wave' });
  await app.run(`(async () => {
    state.riverStations = [{ name: 'A', uuid: 'u1', km: 0, elev: 10, kind: 'normal', value: 100 }];
    waveData = { river: 'RHEIN', rows: [{ name: 'A', km: 0, kind: 'normal', vals: [] }], day0: 0, nDays: 1, shown: 1, total: 1 };
    state.riverStations[0].kind = 'high'; // the next poll sees a flood
    await loadWave();
  })()`);
  assert.equal(app.run('waveData.rows[0].kind'), 'high', 'badge follows the live state without a refetch');
});

test('year overlay: reference levels are drawn and named on their own rules', () => {
  const app = loadApp({ now: JULY });
  seedArchive(app);
  const { vm, html } = app.run(`(() => {
    state.gauge = { currentMeasurement: { value: 200 }, characteristicValues: [
      { shortname: 'MHW', value: 212 }, { shortname: 'MNW', value: 210 },
    ]};
    const vm = yearsViewModel();
    const html = renderYears(vm);
    state.gauge = null;
    return { vm, html };
  })()`);
  // the character grid had to merge two labels that landed on one row
  // ("MHW+MNW"); a continuous scale gives each its own rule and label
  assert.deepEqual(vm.overlay.marks.map(m => m.k), ['MHW', 'MNW']);
  // each level gets its own rule, and both are named in the key — the axis text
  // itself stays out of the SVG so it cannot scale with the viewBox
  assert.equal((html.match(/class="href-line"/g) || []).length >= 2, true, 'each gets its own rule');
  assert.ok(html.includes('MHW 212') && html.includes('MNW 210'), 'both named with their values');
});


// ---------- trend ----------

// quarter-hourly points over `hours`, valued by a callback taking hours-ago
const trendArchive = (hours, expr) => `(() => {
  const pts = [];
  for (let i = ${hours} * 4; i >= 0; i--) {
    const hoursAgo = i / 4;
    pts.push([${NOON} - i * 9e5, (${expr})]);
  }
  state.archive = pts;
  return trendPerHour();
})()`;

test('trendPerHour: a 6 h window sees a fall that an hourly one rounds away', () => {
  const app = loadApp({ now: NOON });
  // the real low-water shape: dead flat for the last hour, quietly falling before it.
  // Sampling only the last hour is what used to print a flat "0 cm/h" all day.
  const shape = 'hoursAgo <= 1 ? 77 : 77 + Math.round((hoursAgo - 1) * 0.6)';
  assert.equal(app.run(trendArchive(7, shape)), -0.5, 'reports the 6 h slope, not the flat hour');

  const flat = loadApp({ now: NOON });
  assert.equal(flat.run(trendArchive(7, '77')), 0, 'a genuinely flat river still reads zero');
});

test('trendPerHour: under an hour of history is unknown, not steady', () => {
  const app = loadApp({ now: NOON });
  const short = app.run(`(() => {
    state.archive = [[${NOON} - 30 * 60000, 80], [${NOON}, 77]];
    return trendPerHour();
  })()`);
  assert.equal(short, null, '30 min of data yields no slope at all');

  const app2 = loadApp({ now: NOON });
  const hour = app2.run(`(() => {
    state.archive = [[${NOON} - 60 * 60000, 80], [${NOON}, 77]];
    return trendPerHour();
  })()`);
  assert.equal(hour, -3, 'exactly an hour is enough');
});

test('the station head: prints the trend with a decimal and an em dash when unknown', () => {
  const render = archive => {
    const app = loadApp({ now: NOON });
    return app.run(`(() => {
      station = 'BONN';
      state.info = { water: { shortname: 'RHEIN' }, km: 654.8 };
      state.gauge = { currentMeasurement: { value: 77, timestamp: ${NOON}, stateMnwMhw: 'low' } };
      state.archive = ${archive};
      state.neighbors = [];
      return renderStation(stationViewModel());
    })()`);
  };
  const falling = render(`[[${NOON} - 6 * 36e5, 80], [${NOON}, 77]]`);
  assert.ok(falling.includes('▼ -0.5 cm/h'), 'decimal slope with a falling arrow');

  const steady = render(`[[${NOON} - 6 * 36e5, 77], [${NOON}, 77]]`);
  assert.ok(steady.includes('▬ 0.0 cm/h'), 'a flat river reads 0.0 without a sign');

  // -0.04 cm/h is steady; "-0.0" would read like a rendering fault
  const creep = render(`[[${NOON} - 6 * 36e5, 77.24], [${NOON}, 77]]`);
  assert.ok(creep.includes('▬ 0.0 cm/h'), 'sub-0.05 drift prints unsigned');

  assert.ok(render(`[[${NOON} - 30 * 60000, 80], [${NOON}, 77]]`).includes('<dd title'),
    'too little history shows an em dash rather than a fabricated zero');
  assert.ok(render(`[[${NOON} - 30 * 60000, 80], [${NOON}, 77]]`).includes('>—<'), 'literally an em dash');

  // the hero reading and its unit are real selectable text now, not block glyphs
  const h = render(`[[${NOON} - 6 * 36e5, 80], [${NOON}, 77]]`);
  assert.ok(h.includes('<span class="hero-n">77</span>'), 'the level is text');
  assert.ok(h.includes('above this gauge’s own zero mark'), 'and says what the number means');
  assert.ok(h.includes('class="km-sign"') && h.includes('654.8'), 'the km board survives as a real sign');
});
// ---------- characteristic values ----------

test('charRecord: reads the API\'s bare date strings as well as the object form', () => {
  const app = loadApp({ now: NOON });
  const year = shape => app.run(`(() => {
    state.gauge = { characteristicValues: [{ shortname: 'HHW', value: 1013, occurrences: ${shape} }] };
    return charRecord('HHW').year;
  })()`);
  // PEGELONLINE sends occurrences as flat strings; reading only .date/.timestamp
  // silently dropped every record year the page ever tried to show
  assert.equal(year(`['1993-12-23']`), 1993, 'bare string form');
  assert.equal(year(`[{ date: '1993-12-23' }]`), 1993, 'object form still works');
  assert.equal(year(`['1988-03-29', '1993-12-23']`), 1993, 'newest occurrence wins');
  assert.equal(year(`[]`), null, 'no occurrences, no year');

  const span = app.run(`(() => {
    state.gauge = { characteristicValues: [{ shortname: 'NNW', value: 81, timespanEnd: '2020-10-31' }] };
    return charRecord('NNW').year;
  })()`);
  assert.equal(span, 2020, 'timespan fallback survives');
});

test('sceneModel: low water keeps every mark visible and strictly in order', () => {
  const app = loadApp({ now: NOON });
  // BONN's real values on 2026-08-09: the level sits below its own record low, so
  // NNW, MNW and the water line all land within a hair of each other
  const s = app.run(`(() => {
    station = 'BONN';
    state.info = { water: { shortname: 'RHEIN' }, km: 654.8, latitude: 50.736, longitude: 7.108 };
    state.gauge = { currentMeasurement: { value: 77, timestamp: ${NOON}, stateMnwMhw: 'low' },
      characteristicValues: [
        { shortname: 'HHW', value: 1013, occurrences: ['1993-12-23'] },
        { shortname: 'NNW', value: 81, occurrences: ['2018-10-22'] },
        { shortname: 'MNW', value: 121 }, { shortname: 'MW', value: 290 }, { shortname: 'MHW', value: 680 },
      ] };
    state.archive = [];
    state.neighbors = [];
    return sceneModel();
  })()`);

  const all = [...s.marks, ...s.above, ...s.below];
  for (const key of ['MHW', 'MW', 'MNW', 'NNW']) {
    assert.ok(all.some(m => m.key === key), `${key} is accounted for`);
  }
  // fractions grow downwards, so a higher value must sit at a smaller fraction —
  // asserted on the model itself instead of inferred from character rows
  const drawn = s.marks.slice().sort((a, b) => b.cm - a.cm);
  for (let i = 1; i < drawn.length; i++) {
    assert.ok(drawn[i].frac > drawn[i - 1].frac,
      `mark order inverted: ${JSON.stringify(drawn.map(m => [m.key, m.cm, m.frac]))}`);
  }
  // the water line keeps its place in that ranking too
  for (const m of s.marks) {
    if (m.cm >= s.value) assert.ok(m.frac <= s.surface, `${m.key} (${m.cm}) must not sit below the water line`);
    else assert.ok(m.frac >= s.surface, `${m.key} (${m.cm}) must not sit above the water line`);
  }
  assert.equal(s.flags.drought, true, '77 cm is below MNW 121');
  assert.ok(s.band, 'the normal range band spans MNW to MHW');
  assert.ok(s.band.top < s.band.bottom, 'with high water at the top of the box');
});
// ---------- rivers map (?rivers) ----------

const seedRivers = (app, list) => app.run(`(() => {
  fillDatalist(${JSON.stringify(list)});
  return riversOverview();
})()`);

// a grid of waters packed into a few degrees, so the placer runs out of room and
// has to spill — the crowded case is the one that used to corrupt labels
const crowd = (count, per = 3) => Array.from({ length: count * per }, (_, i) => {
  const w = Math.floor(i / per);
  return { n: `S${i}`, w: `W${String(w).padStart(2, '0')}`, km: i,
           la: 48.4 + (w % 8) * 0.55, lo: 7.4 + Math.floor(w / 8) * 0.62 };
});

test('riversOverview: counts every gauge, anchors only on the located ones', () => {
  const app = loadApp({ search: '?rivers' });
  // PEGELONLINE lists foreign gauges (Austrian Donau, Czech Elbe) without coordinates.
  // Folding that gap into the count would advertise a river as smaller than it opens.
  const out = seedRivers(app, [
    { n: 'A', w: 'DONAU', km: 1, la: 48.5, lo: 13.0 },
    { n: 'B', w: 'DONAU', km: 2, la: null, lo: null },
    { n: 'C', w: 'DONAU', km: 3, la: null, lo: null },
    { n: 'D', w: 'MOLDAU', km: 1, la: null, lo: null },
  ]);
  const donau = out.find(r => r.name === 'DONAU');
  assert.equal(donau.n, 3, 'every gauge counted, coordinates or not');
  assert.equal(donau.la, 48.5, 'anchored on the only gauge that has a position');
  const moldau = out.find(r => r.name === 'MOLDAU');
  assert.equal(moldau.n, 1, 'counted even with nothing to anchor on');
  assert.equal(moldau.la, null, 'and left unanchored rather than placed at 0,0');
});

const seedRiversPlate = (app, list, view = 'live') => app.run(`(() => {
  fillDatalist(${JSON.stringify(list)});
  viewMode = ${JSON.stringify(view)};
  const vm = riversViewModel();
  return { vm, html: renderRivers(vm) };
})()`);

test('riversViewModel: every water is either placed or spilled, counts conserved', () => {
  const app = loadApp({ search: '?rivers' });
  const list = crowd(40);
  const { vm, html } = seedRiversPlate(app, list);
  assert.ok(vm.placed.length > 0, 'something must reach the map');
  // the real invariant the old character-collision test was a proxy for:
  // nothing is silently dropped between the map and the index
  assert.equal(vm.placed.length + vm.spilled.length, vm.waters, 'placed + spilled = every water');
  assert.equal(vm.gauges, list.length, 'the gauge count is the whole list');
  const named = new Set([...vm.placed, ...vm.spilled].map(r => r.name));
  assert.equal(named.size, vm.waters, 'no water appears twice');
  assert.equal(vm.all.length, vm.waters, 'and the A–Z index carries all of them');
  assert.ok(html.includes('data-nav="river:W00"'), 'a mapped water links to its profile');
});

test('placeRiverLabels: no label overlaps another at any label cap', () => {
  const app = loadApp({ search: '?rivers' });
  app.run(`fillDatalist(${JSON.stringify(crowd(40))})`);
  for (const cap of [6, 14, 26]) {
    const placed = app.run(`placeRiverLabels(riversOverview(), ${cap}).placed`);
    assert.ok(placed.length <= cap, `cap ${cap} is respected`);
    // real bounding-box check, which the character grid could only approximate
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = app.run(`mapLabelBox(${placed[i].lx}, ${placed[i].ly}, ${JSON.stringify(placed[i].text)}, ${placed[i].anchor === 'end'})`);
        const b = app.run(`mapLabelBox(${placed[j].lx}, ${placed[j].ly}, ${JSON.stringify(placed[j].text)}, ${placed[j].anchor === 'end'})`);
        assert.equal(app.run(`boxHit(${JSON.stringify(a)}, ${JSON.stringify(b)})`), false,
          `cap ${cap}: "${placed[i].text}" overlaps "${placed[j].text}"`);
      }
    }
  }
});

test('renderRivers: the map projects Germany, not a squashed grid', () => {
  const app = loadApp({ search: '?rivers' });
  // a degree of longitude is ~0.63 of a degree of latitude at 51 N; ignoring
  // that is what flattened the character-grid map
  const scale = app.run('MAP_LON_SCALE');
  assert.ok(scale > 0.6 && scale < 0.65, `cos(51.15) ≈ 0.627, got ${scale}`);
  const h = app.run('MAP_H'), w = app.run('MAP_W');
  assert.ok(h > w, 'Germany comes out portrait, which also suits a phone');
  const { html } = seedRiversPlate(app, crowd(12));
  assert.ok(html.includes('<polygon points='), 'the border is one real polygon');
  assert.ok(html.includes('class="mdot"'), 'gauges cluster into dots');
  assert.ok(html.includes('30+'), 'the legend names the dot sizes');
});

test('riversViewModel: the A–Z index is the browsable list the map cannot be', () => {
  const app = loadApp({ search: '?rivers&view=list' });
  assert.equal(app.run('viewMode'), 'list', 'the index is its own URL state');
  const { vm, html } = seedRiversPlate(app, crowd(40), 'list');
  assert.equal(vm.tab, 'list');
  assert.deepEqual(vm.all.map(r => r.name), [...vm.all.map(r => r.name)].sort(), 'sorted A–Z');
  assert.ok(html.includes('<ol class="a-z">'), 'a real ordered list');
  assert.ok(html.includes('data-nav="river:W00"'));
  assert.ok(!html.includes('<polygon'), 'the map steps aside for the index');
  assert.equal(app.run(`navHref('cmd:rlist')`), '?rivers&view=list', 'the tab is a shareable link');
  assert.equal(app.run(`navHref('cmd:rmap')`), '?rivers');
});

test('rivers map: ?rivers boots into the map and --rivers switches into it', () => {
  const app = loadApp({ search: '?rivers' });
  assert.equal(app.run('mode'), 'rivers', '?rivers selects the map on load');
  assert.equal(app.run('viewMode'), 'live', 'the map has no sub-views');

  // ?rivers wins over ?river=, which wins over ?station=
  assert.equal(loadApp({ search: '?rivers&river=RHEIN&station=BONN' }).run('mode'), 'rivers');
  assert.equal(loadApp({ search: '?river=RHEIN&station=BONN' }).run('mode'), 'river');
  assert.equal(loadApp({ search: '?station=BONN' }).run('mode'), 'station');

  const cmd = loadApp({}).run(`parseCommand('--rivers')`);
  assert.equal(cmd.rivers, true, '--rivers parses as its own flag');
  assert.equal(cmd.unknownFlag, null, 'and is not mistaken for a typo of --river');
  // the singular must not be swallowed by the plural
  const one = loadApp({}).run(`parseCommand('--river RHEIN')`);
  assert.equal(one.river, 'RHEIN');
  assert.equal(one.rivers, false);
});

test('currentModeQuery: the share link follows whatever mode is actually on screen', () => {
  // used to hard-code ?station=<gauge> regardless of mode, so sharing from ?total,
  // ?rising, ?rivers or ?river= silently shared the last-viewed gauge instead
  assert.equal(loadApp({ search: '?station=BONN' }).run('currentModeQuery()'), '?station=BONN');
  assert.equal(loadApp({ search: '?station=KÖLN&view=years' }).run('currentModeQuery()'),
    '?station=' + encodeURIComponent('KÖLN') + '&view=years', 'umlaut-encoded, sub-view preserved');
  assert.equal(loadApp({ search: '?river=RHEIN' }).run('currentModeQuery()'), '?river=RHEIN');
  assert.equal(loadApp({ search: '?river=MÜRITZSEE&view=wave' }).run('currentModeQuery()'),
    '?river=' + encodeURIComponent('MÜRITZSEE') + '&view=wave');
  assert.equal(loadApp({ search: '?rivers' }).run('currentModeQuery()'), '?rivers');
  assert.equal(loadApp({ search: '?rising' }).run('currentModeQuery()'), '?rising');
  assert.equal(loadApp({ search: '?total' }).run('currentModeQuery()'), '?total');
  assert.equal(loadApp({ search: '?total&y=2024&m=5' }).run('currentModeQuery()'), '?total&y=2024&m=5', 'zoom level round-trips');
  assert.equal(loadApp({ search: '?total&y=2024&d=2024-05-12' }).run('currentModeQuery()'), '?total&y=2024&d=2024-05-12');

  // and it tracks a live mode switch, not just the URL a page happened to boot from
  const app = loadApp({ search: '?station=BONN' });
  app.run('switchTotal()');
  assert.equal(app.run('currentModeQuery()'), '?total', 'follows the switch into ?total');
  app.run('switchRising()');
  assert.equal(app.run('currentModeQuery()'), '?rising', 'and into ?rising');
});

test('applyModeChrome: marks the active nav item, footer label matches the mode', () => {
  const rivers = loadApp({ search: '?rivers' });
  assert.equal(rivers.el('rivers-btn').className, 'on', 'the active item gets .on');
  assert.equal(rivers.el('rivers-btn').getAttribute('aria-current'), 'page');
  assert.equal(rivers.el('rising-btn').className, '', 'the other two stay plain');
  assert.equal(rivers.el('rising-btn').getAttribute('aria-current'), 'false');
  assert.equal(rivers.el('total-btn').className, '');
  assert.equal(rivers.el('footer-perma-label').textContent, 'rivers link:');

  const rising = loadApp({ search: '?rising' });
  assert.equal(rising.el('rising-btn').className, 'on');
  assert.equal(rising.el('footer-perma-label').textContent, 'rising link:');

  const total = loadApp({ search: '?total' });
  assert.equal(total.el('total-btn').className, 'on');
  assert.equal(total.el('footer-perma-label').textContent, 'total link:');

  // station mode: the station item is current, the three global views are not.
  // Station-mode boot never calls applyModeChrome() itself (the static markup's
  // default class is already correct there), so call it explicitly, same as the
  // "back button" test above does for the same reason.
  const station = loadApp({ search: '?station=BONN' });
  station.run('applyModeChrome()');
  for (const id of ['rivers-btn', 'rising-btn', 'total-btn']) {
    assert.equal(station.el(id).className, '', `${id} unmarked in station mode`);
    assert.equal(station.el(id).getAttribute('aria-current'), 'false');
  }
  assert.equal(station.el('home-btn').getAttribute('aria-current'), 'page');
  assert.equal(station.el('footer-perma-label').textContent, 'station link:');

  const river = loadApp({ search: '?river=RHEIN' });
  assert.equal(river.el('footer-perma-label').textContent, 'river link:');
});

test('applyTotalChrome: the tab title carries the zoom scope, so history entries differ', () => {
  const app = loadApp({ search: '?total' });
  const all = app.document.title;
  app.run('totalSetZoom(2024, null, null)');
  const year = app.document.title;
  app.run('totalSetZoom(2024, 4, null)');
  const month = app.document.title;
  app.run('totalSetZoom(2024, 4, 12)');
  const day = app.document.title;
  assert.equal(all, 'PEGEL://TOTAL · ALL');
  assert.equal(year, 'PEGEL://TOTAL · 2024');
  assert.equal(month, 'PEGEL://TOTAL · MAY 2024');
  assert.equal(day, 'PEGEL://TOTAL · MAY 2024 · 12');
  assert.equal(new Set([all, year, month, day]).size, 4, 'all four zoom levels are distinguishable');
});

test('boot: a deep link straight into a ?total month/day zoom titles the tab without crashing', () => {
  // applyTotalChrome runs at boot, before `state` (and originally MONTH_ABBR) exist —
  // a direct ?total&y=…&m=… / &d=… link used to be the only way to reach that code
  // path with totalMonth already set, so it is the one that would have caught the TDZ
  assert.equal(loadApp({ search: '?total&y=2024&m=5' }).document.title, 'PEGEL://TOTAL · MAY 2024');
  assert.equal(loadApp({ search: '?total&y=2024&d=2024-05-12' }).document.title, 'PEGEL://TOTAL · MAY 2024 · 12');
});

test('station nav item: names the way back in river and map mode', () => {
  // Neither view shows the station you came from, so without this the only way
  // back is remembering a name and typing it.
  for (const [search, where] of [['?rivers', 'the map'], ['?river=RHEIN', 'the river profile']]) {
    const app = loadApp({ search });
    const btn = app.run(`(() => {
      station = 'KÖLN';
      applyModeChrome();
      const b = document.getElementById('home-btn');
      return { hidden: b.hidden, text: b.textContent, title: b.title, nav: b.dataset.nav, href: b.href };
    })()`);
    assert.equal(btn.hidden, false, `shown on ${where}`);
    assert.equal(btn.text, '← KÖLN', `${where}: names its target, not a generic "home"`);
    assert.match(btn.title, /KÖLN/, `${where}: title names the target too`);
    assert.equal(btn.nav, 'KÖLN', `${where}: dispatches through the nav grammar`);
    assert.equal(btn.href, '?station=K%C3%96LN', `${where}: the href is honest`);
  }

  // on the gauge itself it is the current page, named plainly
  const station = loadApp({ search: '?station=BONN' });
  const self = station.run(`(() => {
    applyModeChrome();
    const b = document.getElementById('home-btn');
    return { hidden: b.hidden, text: b.textContent, current: b.getAttribute('aria-current') };
  })()`);
  assert.equal(self.hidden, false, 'always present in the nav');
  assert.equal(self.text, 'BONN');
  assert.equal(self.current, 'page');
});

test('back button: leaving the map redraws the station even if it never changed', () => {
  // switchStation used to bail out when the target matched the current station,
  // which left the map on screen and made the button look broken.
  const app = loadApp({ search: '?rivers' });
  const after = app.run(`(() => {
    const before = mode;
    switchStation(station, '', false);
    return { before, after: mode, station };
  })()`);
  assert.equal(after.before, 'rivers');
  assert.equal(after.after, 'station', 'the mode actually changes back');
  assert.equal(after.station, 'BONN', 'landing on the station the button named');
});

test('sceneModel: marks off the scale become margin arrows instead of being clipped', () => {
  const seed = (app, value) => app.run(`(() => {
    station = 'BONN';
    state.info = { water: { shortname: 'RHEIN' }, km: 654.8, latitude: 50.736, longitude: 7.108 };
    state.gauge = { currentMeasurement: { value: ${value}, timestamp: ${NOON}, stateMnwMhw: 'low' },
      characteristicValues: [
        { shortname: 'HHW', value: 1013, occurrences: ['1993-12-23'] },
        { shortname: 'NNW', value: 81, occurrences: ['2018-10-22'] },
        { shortname: 'MNW', value: 121 }, { shortname: 'MW', value: 290 }, { shortname: 'MHW', value: 680 },
      ] };
    state.archive = [];
    state.neighbors = [];
    const vm = stationViewModel();
    return { scene: vm.scene, html: renderStation(vm) };
  })()`);

  // low water: HHW 1013 sits far above the MHW-pinned scale, so it belongs in
  // the top margin rather than clipped off the chart
  const low = seed(loadApp({ now: NOON }), 77);
  assert.ok(low.scene.above.some(m => m.key === 'HHW'), 'HHW is reported above the box');
  assert.ok(low.html.includes('↑ HHW'), 'as an explicit up arrow');
  assert.ok(low.html.includes('1013'), 'carrying its value');
  assert.ok(low.html.includes('1993'), 'and the year it happened');

  // at the record level itself the scale grows to hold it, so no arrow is needed
  const high = seed(loadApp({ now: NOON }), 1013);
  assert.ok(high.scene.topCm > 1013, 'the flood scale makes room above the level');
  assert.equal(high.scene.above.some(m => m.key === 'HHW'), false, 'HHW is on the chart now');
  assert.equal(high.scene.flags.flood, true, 'and the scene knows it is a flood');

  // every label lives in an HTML gutter, so nothing can be clipped by a column count
  assert.ok(low.html.includes('class="gutter"'), 'labels sit on paper beside the drawing');
  for (const key of ['MHW', 'MW', 'MNW']) {
    assert.ok(low.html.includes(`<b>${key}</b>`), `${key} is named in full in the gutter`);
  }
});
// ---------- rising board ----------

// raw bulk-endpoint station entry, same shape the live API returns
const bulk = (uuid, n, w, value, cvs = [], state = null) => ({
  uuid, shortname: n, water: { shortname: w },
  timeseries: [{
    shortname: 'W',
    ...(value == null ? {} : { currentMeasurement: { timestamp: 'x', value, stateMnwMhw: state } }),
    characteristicValues: cvs.map(([shortname, value]) => ({ shortname, value, unit: 'cm' })),
  }],
});
const SPAN = [['MNW', 100], ['MHW', 400]];
// snapshot shard with a single usable day at `dayIdx`; a value may be a bare
// number or { v, t } to carry the job's tidal flag
const shardWith = (y, m, len, dayIdx, iso, values) => ({
  y, m,
  days: Array.from({ length: len }, (_, i) => i === dayIdx ? iso : null),
  stations: Object.fromEntries(Object.entries(values).map(([uuid, val]) => {
    const { v, t } = typeof val === 'object' ? val : { v: val };
    const arr = Array(len).fill(null);
    arr[dayIdx] = v;
    return [uuid, { n: uuid.toUpperCase(), w: 'X', v: arr, ...(t ? { t: 1 } : {}) }];
  })),
});

test('parseBulkStations: keeps live W stations with tidal flag, span and kind', () => {
  const app = loadApp({});
  const raw = [
    bulk('a', 'BONN', 'RHEIN', 76, [['MNW', 121], ['MHW', 680]], 'low'),
    bulk('b', 'HERBRUM', 'EMS', 250, [['MThw', 300], ['MTnw', 50]]),
    bulk('c', 'NO-MEASUREMENT', 'X', null),
    { uuid: 'd', shortname: 'NO-W', water: { shortname: 'X' }, timeseries: [{ shortname: 'Q' }] },
  ];
  const out = app.run(`parseBulkStations(${JSON.stringify(raw)})`);
  assert.equal(out.length, 2, 'stations without a live W value are dropped');
  assert.deepEqual(out[0], { uuid: 'a', n: 'BONN', w: 'RHEIN', v: 76, tidal: false, mnw: 121, mhw: 680, kind: 'low' });
  assert.equal(out[1].tidal, true, 'MThw marks the tidal gauge');
  assert.equal(out[1].mnw, null, 'a tidal gauge has no MNW span');
});

test('risingOverview: ranks by cm/day, excludes tidal, skips baseline-less stations', () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString(); // exactly one day old → dayIdx 13 (Jan 14)
  const shard = shardWith(2026, 1, 31, 13, iso, { a: 100, b: 100, d: 100, f: { v: 100, t: 1 } });
  const raw = [
    bulk('a', 'UP', 'X', 120, SPAN),        // +20 cm/d
    bulk('b', 'DOWN', 'X', 90, SPAN),       // -10 cm/d
    bulk('c', 'TIDE', 'X', 500, [['MThw', 600]]), // excluded by its MThw mark
    bulk('d', 'FLAT', 'X', 100.4, SPAN),    // steady
    bulk('e', 'NEW', 'X', 200, SPAN),       // no snapshot entry → skipped silently
    bulk('f', 'ROTTERDAM', 'X', 300),       // no marks at all — excluded by the shard's t flag
  ];
  const d = app.run(`risingOverview(parseBulkStations(${JSON.stringify(raw)}), ${JSON.stringify(shard)}, ${NOON})`);
  assert.equal(d.noBaseline, false);
  assert.deepEqual(d.counts, { rising: 1, falling: 1, steady: 1, tidal: 2 });
  assert.equal(d.risers.length, 1);
  assert.equal(d.risers[0].n, 'UP');
  assert.equal(d.risers[0].cmPerDay.toFixed(1), '20.0');
  assert.equal(d.fallers[0].n, 'DOWN');
  assert.equal(d.fallers[0].cmPerDay.toFixed(1), '-10.0');
  assert.equal(d.baselineTs, NOON - 864e5);
});

test('risingOverview: a missed cron day does not double the rate', () => {
  const app = loadApp({ now: NOON });
  // the only usable capture is 3 days old — +30 cm since then is +10 cm/day
  const iso = new Date(NOON - 3 * 864e5).toISOString();
  const shard = shardWith(2026, 1, 31, 11, iso, { a: 100 });
  const raw = [bulk('a', 'UP', 'X', 130, SPAN)];
  const d = app.run(`risingOverview(parseBulkStations(${JSON.stringify(raw)}), ${JSON.stringify(shard)}, ${NOON})`);
  assert.equal(d.risers[0].cmPerDay.toFixed(1), '10.0');
});

test('risingOverview: RISING_FLAT boundary and a too-young capture', () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString();
  const shard = shardWith(2026, 1, 31, 13, iso, { a: 100, b: 100 });
  const raw = [bulk('a', 'EDGE', 'X', 101, SPAN), bulk('b', 'UNDER', 'X', 100.9, SPAN)];
  const d = app.run(`risingOverview(parseBulkStations(${JSON.stringify(raw)}), ${JSON.stringify(shard)}, ${NOON})`);
  assert.deepEqual(d.counts, { rising: 1, falling: 0, steady: 1, tidal: 0 }, 'exactly 1 cm/d is rising, just under is steady');

  // a capture from 2 hours ago is "today", not a baseline
  const young = shardWith(2026, 1, 31, 14, new Date(NOON - 2 * 36e5).toISOString(), { a: 100 });
  const dy = app.run(`risingOverview(parseBulkStations(${JSON.stringify(raw)}), ${JSON.stringify(young)}, ${NOON})`);
  assert.equal(dy.noBaseline, true);
  assert.deepEqual(dy.live, { high: 0, low: 0, normal: 2, tidal: 0 }, 'live-only counts still render');
});

test('risingBadge: HIGH/LOW override the ETA, spanless stations get none', () => {
  const app = loadApp({});
  const badge = r => app.run(`risingBadge(${JSON.stringify(r)})`);
  assert.equal(badge({ mnw: 100, mhw: 400, v: 300, kind: 'normal', cmPerDay: 10 }).text, '→MHW ~10d');
  assert.equal(badge({ mnw: 100, mhw: 400, v: 150, kind: 'normal', cmPerDay: -10 }).text, '→MNW ~5d');
  assert.equal(badge({ mnw: 100, mhw: 400, v: 450, kind: 'high', cmPerDay: 10 }).text, 'HIGH');
  assert.equal(badge({ mnw: 100, mhw: 400, v: 90, kind: 'low', cmPerDay: -2 }).text, 'LOW');
  assert.equal(badge({ mnw: null, mhw: null, v: 300, kind: 'normal', cmPerDay: 50 }), null, 'no span, no badge');
  assert.equal(badge({ mnw: 100, mhw: 400, v: 399, kind: 'normal', cmPerDay: 0.001 }), null, 'an ETA beyond 99 days is noise, not a forecast');
});

// the plate renderers read state.rising (data + the shard the sparklines use),
// so every rising view-model test goes through the same seam the app does
function risingPlate(app, raw, shard, nowTs, lookback = 1) {
  return app.run(`(() => {
    mode = 'rising';
    const d = risingOverview(parseBulkStations(${JSON.stringify(raw)}), ${JSON.stringify(shard)}, ${nowTs}, ${lookback});
    state.rising = { data: d, snapshot: ${JSON.stringify(shard)}, error: null };
    const vm = risingViewModel();
    return { vm, html: renderRising(vm) };
  })()`);
}

test('risingViewModel: ranks, caps at the top 20, counts the overflow', () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString();
  const values = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, 100]));
  const shard = shardWith(2026, 1, 31, 13, iso, values);
  // 25 risers (overflow past the top 20), 4 fallers, 1 steady
  const raw = Array.from({ length: 30 }, (_, i) => {
    const v = i < 25 ? 110 + i : i < 29 ? 90 - i : 100;
    return bulk(`s${i}`, `ST${String(i).padStart(2, '0')}`, 'RIVER', v, SPAN);
  });
  const { vm } = risingPlate(app, raw, shard, NOON);
  assert.equal(vm.risers.length, 20, 'capped at the top 20');
  assert.equal(vm.counts.rising, 25);
  assert.equal(vm.moreRising, 5, 'the overflow is counted, not silently dropped');
  assert.equal(vm.risers[0].rank, 1);
  assert.equal(vm.risers[0].n, 'ST24', 'the fastest riser leads');
  assert.ok(vm.risers.every(r => r.dir === 'up'), 'risers are marked as rising');
  assert.ok(vm.fallers.every(r => r.dir === 'down'));
  // risers and fallers share one bar scale, so a steeper fall visibly outweighs
  // a gentler rise instead of both maxing out their own half of the board
  assert.equal(vm.fallers[0].pct, 100, 'the biggest absolute mover sets the scale');
  assert.equal(vm.risers[0].pct, 89, '+34 cm/d against the -38 cm/d leader');
  assert.ok([...vm.risers, ...vm.fallers].every(r => r.pct >= 0 && r.pct <= 100), 'bar widths stay in range');
});

test('renderRising: every row is a link carrying its rate, no COLS in sight', () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString();
  const shard = shardWith(2026, 1, 31, 13, iso, { a: 100, b: 100 });
  const raw = [bulk('a', 'UP', 'RHEIN', 150, SPAN), bulk('b', 'DOWN', 'MAIN', 60, SPAN)];
  const { html } = risingPlate(app, raw, shard, NOON);
  assert.ok(html.includes('href="?station=UP"'), 'the gauge is an honest link');
  assert.ok(html.includes('data-nav="UP"'), 'and dispatches through the nav grammar');
  assert.ok(html.includes('href="?river=RHEIN"'), 'the river column links to its profile');
  assert.ok(html.includes('<ol class="board">'), 'a ranked list is a real ordered list');
  assert.match(html, /\+50\.0 cm\/d/, 'the rate is spelled out with its unit');
  assert.ok(html.includes('150 cm'), 'the absolute level rides along — new next to the ASCII board');
  assert.ok(html.includes('class="p-key"'), 'the legend is in the plate, not in a modal');
  assert.ok(html.includes('tidal gauges are excluded'), 'the caveat survives the redesign');
});

test('renderRising: the key names the sparkline and the rate bar it draws', () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString();
  const shard = shardWith(2026, 1, 31, 13, iso, { a: 100, b: 100 });
  const raw = [bulk('a', 'UP', 'RHEIN', 150, SPAN), bulk('b', 'DOWN', 'MAIN', 60, SPAN)];
  const { html } = risingPlate(app, raw, shard, NOON);
  const board = html.slice(0, html.indexOf('<dl class="p-key">'));
  const key = html.slice(html.indexOf('<dl class="p-key">'));
  // both marks are drawn in the board, so both have to be named in the key
  assert.ok(board.includes('class="b-spark"'), 'the board draws sparklines');
  assert.ok(board.includes('--pct:'), 'and a magnitude bar behind each rate');
  assert.ok(key.includes('class="b-spark lg-spark"'), 'the key shows the same spark mark');
  assert.ok(key.includes('class="lg-bar up"') && key.includes('class="lg-bar down"'),
    'and the bar in both directions');
  assert.ok(key.includes(app.run('T.risingSparkKey')), 'the spark is explained');
  assert.ok(key.includes(app.run('T.risingBarKey')), 'the bar is explained');
});

// WSV passes three waters through as raw tokens (NEUE_MAAS). Those read as their
// longname — ITTER_DIEMEL is "ITTER ZUR DIEMEL", so underscore-to-space would be
// wrong — while short codes stay codes and the shortname stays the identity.
test('waterLabel: only underscored waters swap, and only for display', () => {
  const app = loadApp({ now: NOON });
  const out = app.run(`(() => {
    fillWaters(['NEUE_MAAS', 'ITTER_DIEMEL', 'MLK'], { NEUE_MAAS: 'NEUE MAAS', ITTER_DIEMEL: 'ITTER ZUR DIEMEL' });
    return { neue: waterLabel('NEUE_MAAS'), itter: waterLabel('ITTER_DIEMEL'),
             mlk: waterLabel('MLK'), plain: waterLabel('RHEIN'), blank: waterLabel('') };
  })()`);
  assert.equal(out.neue, 'NEUE MAAS');
  assert.equal(out.itter, 'ITTER ZUR DIEMEL', 'the longname, not underscore-to-space');
  assert.equal(out.mlk, 'MLK', 'a short code stays a short code');
  assert.equal(out.plain, 'RHEIN');
  assert.equal(out.blank, '');

  const iso = new Date(NOON - 864e5).toISOString();
  const shard = shardWith(2026, 1, 31, 13, iso, { s0: 100 });
  const raw = [bulk('s0', 'ROTTERDAM', 'NEUE_MAAS', 140, SPAN)];
  const { html } = risingPlate(app, raw, shard, NOON);
  assert.ok(html.includes('>NEUE MAAS<'), 'the board row reads the display name');
  assert.ok(html.includes('data-nav="river:NEUE_MAAS"'), 'while the link still carries the identity');
});

// a quiet river is a real state, not a half-loaded view: without this the counts
// and the key sit either side of a gap that names nothing
test('renderRising: a baseline with nothing moving still says so', () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString();
  const values = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, 100]));
  const shard = shardWith(2026, 1, 31, 13, iso, values);
  const raw = Array.from({ length: 6 }, (_, i) => bulk(`s${i}`, `ST${i}`, 'RIVER', 100, SPAN));
  const { vm, html } = risingPlate(app, raw, shard, NOON);
  assert.equal(vm.risers.length, 0, 'nobody rose');
  assert.equal(vm.fallers.length, 0, 'nobody fell');
  assert.equal(vm.counts.steady, 6, 'and the baseline was there all along');
  assert.ok(!html.includes('<ol class="board">'), 'no empty board list is drawn');
  assert.match(html, /Nothing moved/, 'the quiet is named instead of left blank');
});

test('renderRising: a hostile gauge name never reaches markup unescaped', () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString();
  const shard = shardWith(2026, 1, 31, 13, iso, { a: 100 });
  const raw = [bulk('a', '"><img src=x onerror=1>', 'R<X', 150, SPAN)];
  const { html } = risingPlate(app, raw, shard, NOON);
  assert.ok(!html.includes('<img'), 'no injected element');
  assert.ok(!html.includes('R<X'), 'the river name is escaped too');
  assert.ok(html.includes('&lt;img'), 'it renders as visible text instead');
});

test('sparkPath: normalises per row, skips gaps, needs two points', () => {
  const app = loadApp();
  assert.equal(app.run('sparkPath([100])'), '', 'a single point is no shape');
  assert.equal(app.run('sparkPath([null, null])'), '', 'gaps alone are no shape');
  const p = app.run('sparkPath([100, 200], 60, 14)');
  assert.match(p, /^M/, 'starts with a move');
  assert.equal(p.split('L').length, 2, 'two points, one line segment');
  // the low value sits at the bottom of the box, the high at the top
  const ys = p.match(/[\d.]+ ([\d.]+)/g).map(s => parseFloat(s.split(' ')[1]));
  assert.ok(ys[0] > ys[1], 'a rising series draws upward (SVG y grows downward)');
  const gapped = app.run('sparkPath([100, null, 200])');
  assert.equal(gapped.split(/[ML]/).length - 1, 2, 'the null slot is skipped, not drawn as zero');
});

test('risingViewModel: without a baseline it carries the live counts and the reason', () => {
  const app = loadApp({ now: NOON });
  const raw = [bulk('a', 'A', 'X', 500, SPAN, 'high'), bulk('b', 'B', 'X', 90, SPAN, 'low'), bulk('c', 'C', 'X', 250, [['MThw', 300]])];
  const { vm, html } = risingPlate(app, raw, null, NOON);
  assert.equal(vm.noBaseline, true);
  assert.match(vm.reason, /no baseline yet/, 'names the missing piece');
  assert.deepEqual({ high: vm.live.high, low: vm.live.low, tidal: vm.live.tidal }, { high: 1, low: 1, tidal: 1 });
  assert.ok(html.includes('1 high') && html.includes('1 low') && html.includes('1 tidal'), 'live counts still render');
});

test('rising board: ?rising boots into it and --rising switches into it', () => {
  const app = loadApp({ search: '?rising' });
  assert.equal(app.run('mode'), 'rising', '?rising selects the board on load');
  assert.equal(app.run('viewMode'), 'live', 'the board has no sub-views');
  // ?rising wins over everything else
  assert.equal(loadApp({ search: '?rising&rivers&river=RHEIN&station=BONN' }).run('mode'), 'rising');

  const cmd = loadApp({}).run(`parseCommand('--rising')`);
  assert.equal(cmd.rising, true, '--rising parses as its own flag');
  assert.equal(cmd.unknownFlag, null);
  assert.equal(loadApp({}).run(`parseCommand('--river RHEIN')`).rising, false, 'the singular river flag is not mistaken for it');

  const sw = loadApp({ search: '?station=BONN' });
  sw.run(`runCommand('--rising')`);
  assert.equal(sw.run('mode'), 'rising', 'the REPL flag switches the mode');

  const back = loadApp({ search: '?rising' });
  back.run(`actOnGridTarget('BONN')`);
  assert.equal(back.run('mode'), 'station', 'a board row leads to its station');
  const entry = loadApp({ search: '?rivers' });
  entry.run(`actOnGridTarget('rising')`);
  assert.equal(entry.run('mode'), 'rising', "the map's entry link opens the board");
});

test('loadRising: bulk + snapshot happy path, and a missing snapshot is not an error', async () => {
  const app = loadApp({ now: NOON });
  const iso = new Date(NOON - 864e5).toISOString();
  const shard = shardWith(2026, 1, 31, 13, iso, { a: 100 });
  const raw = [bulk('a', 'UP', 'X', 120, SPAN)];
  app.run(`mode = 'rising'`);
  app.run(`getJson = async url => {
    if (url.includes('stations.json')) return ${JSON.stringify(raw)};
    if (url === 'archive/snapshots/2026-01.json') return ${JSON.stringify(shard)};
    throw new Error('404 ' + url);
  }`);
  await app.run('loadRising()');
  assert.equal(app.run('state.rising.error'), null);
  assert.equal(app.run('state.rising.data.risers[0].n'), 'UP');

  // snapshot 404s (fresh deploy, local checkout): degraded, not broken
  const bare = loadApp({ now: NOON });
  bare.run(`mode = 'rising'`);
  bare.run(`getJson = async url => {
    if (url.includes('stations.json')) return ${JSON.stringify(raw)};
    throw new Error('404 ' + url);
  }`);
  await bare.run('loadRising()');
  assert.equal(bare.run('state.rising.error'), null);
  assert.equal(bare.run('state.rising.data.noBaseline'), true);
});

test('loadRising: early in a month the baseline comes from the previous shard', async () => {
  const feb1 = Date.UTC(2026, 1, 1, 12);
  const app = loadApp({ now: feb1 });
  // current month: only a 2h-old capture; previous month: yesterday's
  const cur = shardWith(2026, 2, 28, 0, new Date(feb1 - 2 * 36e5).toISOString(), { a: 115 });
  const prev = shardWith(2026, 1, 31, 30, new Date(feb1 - 864e5).toISOString(), { a: 100 });
  app.run(`mode = 'rising'`);
  app.run(`getJson = async url => {
    if (url.includes('stations.json')) return ${JSON.stringify([bulk('a', 'UP', 'X', 120, SPAN)])};
    if (url === 'archive/snapshots/2026-02.json') return ${JSON.stringify(cur)};
    if (url === 'archive/snapshots/2026-01.json') return ${JSON.stringify(prev)};
    throw new Error('404 ' + url);
  }`);
  await app.run('loadRising()');
  assert.equal(app.run('state.rising.data.baselineTs'), feb1 - 864e5, 'January 31 is the baseline');
  assert.equal(app.run('state.rising.data.risers[0].cmPerDay').toFixed(1), '20.0');
});

// ---------- rising board: the 7-day lookback ----------

// the timestamp the daily snapshot cron writes for that day (the Aug 13-19
// backfill slots carry exactly this 11:30Z shape)
const capture = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 11, 30)).toISOString();
// snapshot shard with several captured days: `days` maps day index -> iso,
// `values` maps uuid -> { <day index>: cm } (plus t: 1 for the tidal flag)
const shardOf = (y, m, len, days, values) => ({
  y, m,
  days: Array.from({ length: len }, (_, i) => days[i] || null),
  stations: Object.fromEntries(Object.entries(values).map(([uuid, slots]) => {
    const v = Array(len).fill(null);
    for (const [i, cm] of Object.entries(slots)) if (i !== 't') v[+i] = cm;
    return [uuid, { n: uuid.toUpperCase(), w: 'X', v, ...(slots.t ? { t: 1 } : {}) }];
  })),
});
// Jan 7..15 2026 captured daily, NOON = Jan 15 12:00 → yesterday is index 13
const JAN_DAYS = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 6, capture(2026, 1, i + 7)]));

test('risingBaselineIndex: 1D takes the newest capture, 7D aims at the day a week back', () => {
  const app = loadApp({ now: NOON });
  const full = shardOf(2026, 1, 31, JAN_DAYS, { a: {} });
  const idx = (shard, n) => app.run(`risingBaselineIndex(${JSON.stringify(shard)}, ${NOON}, ${n})`);
  assert.equal(app.run(`newestUsableDayIndex(${JSON.stringify(full)}, ${NOON})`), 13,
    "today's own capture is half an hour old — yesterday's is the baseline");
  assert.equal(idx(full, 1), 13, 'the 1-day view is unchanged: the newest usable capture');
  assert.equal(idx(full, 7), 7,
    'Jan 8 — the capture nearest 7×24h back, not seven slots back from the newest (which would be Jan 7, eight days out)');

  // the cron missed that day: the nearest capture on either side wins
  const gap = shardOf(2026, 1, 31, { ...JAN_DAYS, 7: null }, { a: {} });
  assert.equal(idx(gap, 7), 8, 'Jan 9 (6.0 days) beats Jan 7 (8.0 days) by half a day');
  assert.equal(idx(gap, 1), 13, 'the 1-day baseline is untouched by a hole a week back');

  // a young archive has nothing a week back — the view says so instead of
  // passing a three-day-old capture off as a week
  const young = shardOf(2026, 1, 31, { 11: capture(2026, 1, 12) }, { a: {} });
  assert.equal(idx(young, 1), 11);
  assert.equal(idx(young, 7), -1, 'three days back is not "a week ago"');
});

test('mergeSnapshotShards: two months as one day axis, padded and tidal-flag preserving', () => {
  const app = loadApp({});
  const jul = shardOf(2026, 7, 31, { 30: capture(2026, 7, 31) }, { a: { 30: 100 }, b: { 30: 50, t: 1 } });
  const aug = shardOf(2026, 8, 31, { 0: capture(2026, 8, 1) }, { a: { 0: 110 }, c: { 0: 7 } });
  const m = app.run(`mergeSnapshotShards(${JSON.stringify(jul)}, ${JSON.stringify(aug)})`);
  assert.equal(m.days.length, 62, 'July then August, one continuous day axis');
  assert.deepEqual([m.days[30], m.days[31]], [capture(2026, 7, 31), capture(2026, 8, 1)]);
  assert.equal(m.stations.a.v.length, 62);
  assert.deepEqual([m.stations.a.v[30], m.stations.a.v[31]], [100, 110]);
  assert.equal(m.stations.b.v[31], null, 'a station missing from August keeps null slots there');
  assert.equal(m.stations.b.t, 1, "the snapshot job's tidal flag survives the merge");
  assert.equal(m.stations.c.v[30], null, 'a station new in August has no July values');
  assert.deepEqual([m.y, m.m], [2026, 8], 'the merged shard is named after the newer month');
  assert.equal(app.run(`mergeSnapshotShards(null, ${JSON.stringify(aug)}).days.length`), 31, 'a missing half is not a merge');
  assert.equal(app.run(`mergeSnapshotShards(${JSON.stringify(jul)}, null).days.length`), 31);
});

test('risingOverview: the 7-day view normalises over the real span and skips week-less stations', () => {
  const app = loadApp({ now: NOON });
  const shard = shardOf(2026, 1, 31, JAN_DAYS, {
    a: { 7: 100, 13: 160 }, // +70 over the week, +10 since yesterday
    b: { 13: 200 },         // no slot a week back — rankable in 1D only
  });
  const raw = [bulk('a', 'WEEK', 'X', 170, SPAN), bulk('b', 'FRESH', 'X', 220, SPAN)];
  const over = n => app.run(`risingOverview(parseBulkStations(${JSON.stringify(raw)}), ${JSON.stringify(shard)}, ${NOON}, ${n})`);

  const d1 = over(1);
  assert.deepEqual(d1.risers.map(r => r.n), ['FRESH', 'WEEK'], 'both rank against yesterday');
  assert.equal(d1.lookbackDays, 1);

  const d7 = over(7);
  assert.deepEqual(d7.risers.map(r => r.n), ['WEEK'], 'the station without a week-old slot is skipped, not zeroed');
  assert.deepEqual(d7.counts, { rising: 1, falling: 0, steady: 0, tidal: 0 }, 'and counts in no bucket at all');
  assert.equal(d7.elapsedDays.toFixed(2), '7.02', 'the span is the real one: 7 days plus the half hour of capture drift');
  assert.equal(d7.risers[0].cmPerDay.toFixed(1), '10.0', '70 cm over 7.02 days, not 70 cm/day');
  assert.equal(d7.risers[0].deltaCm, 70, 'the row also carries the whole span in centimetres');
  assert.equal(d7.baselineTs, Date.parse(capture(2026, 1, 8)));
  assert.equal(d7.lookbackDays, 7);
});

test('risingViewModel: the 7-day view carries the span it really measured', () => {
  const shard = shardOf(2026, 1, 31, { ...JAN_DAYS, 7: null }, { a: { 8: 105, 13: 160 } });
  const raw = [bulk('a', 'WEEK', 'RHEIN', 170, SPAN)];
  const app = loadApp({ now: NOON });
  const { vm, html } = risingPlate(app, raw, shard, NOON, 7);
  assert.equal(vm.elapsedDays.toFixed(1), '6.0', 'the missed Jan 8 leaves a six-day span');
  assert.ok(html.includes('Δ6.0 d back'), 'the header states the real span, not the nominal seven');
  assert.equal(vm.risers[0].deltaCm, 65, 'the row carries the centimetres of the whole span');
  assert.ok(html.includes('(+65 cm)'), 'and prints them next to the rate');
  assert.ok(html.includes('+10.8 cm/d'), '65 cm over 6.02 days');
  assert.ok(vm.risers[0].spark.length > 1, 'the row gets its 7-day shape from the same shard');
});

test('risingViewModel: without a week-old baseline the empty state names the week', () => {
  const app = loadApp({ now: NOON });
  const shard = shardOf(2026, 1, 31, { 11: capture(2026, 1, 12) }, { a: { 11: 100 } });
  const raw = [bulk('a', 'A', 'X', 500, SPAN, 'high'), bulk('b', 'B', 'X', 90, SPAN, 'low')];
  const { vm, html } = risingPlate(app, raw, shard, NOON, 7);
  assert.equal(vm.noBaseline, true);
  assert.match(vm.reason, /a week back/, 'the empty state is about the week, not the day');
  assert.ok(html.includes('1-day view'), 'and points at the view that does work');
  assert.ok(html.includes('1 high') && html.includes('1 low'), 'live counts still render');
});

test('loadRising: the 7-day baseline crosses into the previous month\'s shard', async () => {
  const aug5 = Date.UTC(2026, 7, 5, 12);
  const jul = shardOf(2026, 7, 31, Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 24, capture(2026, 7, i + 25)])),
    { a: { 28: 100, 30: 150 } });
  const aug = shardOf(2026, 8, 31, Object.fromEntries(Array.from({ length: 4 }, (_, i) => [i, capture(2026, 8, i + 1)])),
    { a: { 0: 160, 1: 162, 2: 165, 3: 168 } });
  const raw = [bulk('a', 'UP', 'X', 170, SPAN)];
  const stub = `getJson = async url => {
    globalThis.__fetched.push(url);
    if (url.includes('stations.json')) return ${JSON.stringify(raw)};
    if (url === 'archive/snapshots/2026-08.json') return ${JSON.stringify(aug)};
    if (url === 'archive/snapshots/2026-07.json') return ${JSON.stringify(jul)};
    throw new Error('404 ' + url);
  }`;

  const week = loadApp({ now: aug5, search: '?rising&d7' });
  week.run('globalThis.__fetched = []');
  week.run(stub);
  await week.run('loadRising()');
  assert.equal(week.run('state.rising.error'), null);
  assert.equal(week.run('state.rising.data.baselineTs'), Date.parse(capture(2026, 7, 29)),
    'July 29 is the baseline, seven days back across the month boundary');
  assert.equal(week.run('state.rising.data.risers[0].cmPerDay').toFixed(1), '10.0', '70 cm over 7.02 days');
  assert.equal(week.run('state.rising.data.risers[0].deltaCm'), 70);
  assert.deepEqual(week.run('globalThis.__fetched').filter(u => u.includes('snapshots')),
    ['archive/snapshots/2026-08.json', 'archive/snapshots/2026-07.json'], 'the current shard first, the previous one only because the week reaches into it');
  await week.run('loadRising()');
  assert.deepEqual(week.run('globalThis.__fetched').filter(u => u.includes('snapshots')).length, 2,
    'the auto-refresh reuses both cached shards');

  // the 1-day path on the same day never touches the previous shard
  const day = loadApp({ now: aug5, search: '?rising' });
  day.run('globalThis.__fetched = []');
  day.run(stub);
  await day.run('loadRising()');
  assert.equal(day.run('state.rising.data.baselineTs'), Date.parse(capture(2026, 8, 4)));
  assert.equal(day.run('state.rising.data.risers[0].cmPerDay').toFixed(1), '2.0');
  assert.deepEqual(day.run('globalThis.__fetched').filter(u => u.includes('snapshots')), ['archive/snapshots/2026-08.json']);
});

test('rising board: the 1D/7D toggle rides the URL and sits on the board', () => {
  // the lookback chips are rendered by the board itself, above the ranking
  const chips = app => app.run(`(() => {
    state.rising = { data: { lookbackDays: risingDays, noBaseline: true,
      live: { high: 0, low: 0, normal: 0, tidal: 0 } }, error: null };
    return renderRising(risingViewModel());
  })()`);
  const boot = loadApp({ search: '?rising&d7' });
  assert.equal(boot.run('risingDays'), 7, '?rising&d7 boots into the week view');
  assert.equal(boot.run('currentModeQuery()'), '?rising&d7', 'and shares as that link');
  assert.equal(boot.el('station-link').textContent, '?rising&d7');
  assert.equal(boot.document.title, 'PEGEL://RISING · 7D', 'the tab says which board this is');
  const bootHtml = chips(boot);
  assert.ok(bootHtml.includes('href="?rising" data-nav="cmd:rd:1"'), '1D is a real link');
  assert.ok(bootHtml.includes('class="on" href="?rising&amp;d7" data-nav="cmd:rd:7"'), 'the active lookback is lit');

  const plain = loadApp({ search: '?rising' });
  assert.equal(plain.run('risingDays'), 1, 'the default stays 1D');
  assert.equal(plain.run('currentModeQuery()'), '?rising');
  assert.ok(chips(plain).includes('class="on" href="?rising" data-nav="cmd:rd:1"'));
  plain.run(`state.rising = { data: { noBaseline: true }, error: null }`);
  plain.run(`runGridCmd('rd:7')`);
  assert.equal(plain.run('currentModeQuery()'), '?rising&d7', 'flipping the chip rewrites the link');
  assert.equal(plain.run('state.rising'), null, 'and drops the board built on the other baseline');
  assert.ok(chips(plain).includes('class="on" href="?rising&amp;d7" data-nav="cmd:rd:7"'));
  plain.run('risingSetDays(1)');
  assert.equal(plain.run('currentModeQuery()'), '?rising');
  plain.run('risingSetDays(3)');
  assert.equal(plain.run('risingDays'), 1, 'only the two offered lookbacks are reachable');

  // entering the board from a station carries the current lookback into the URL
  const from = loadApp({ search: '?station=BONN' });
  from.run('risingDays = 7; switchRising()');
  assert.equal(from.run('currentModeQuery()'), '?rising&d7');
});

test('loadRising: a hard bulk failure reports, switching away mid-fetch discards', async () => {
  const app = loadApp({ now: NOON });
  app.run(`mode = 'rising'`);
  app.run(`getJson = async () => { throw new Error('WSV down'); }`);
  await app.run('loadRising()');
  assert.match(app.run('state.rising.error'), /WSV down/);

  const away = loadApp({ now: NOON });
  away.run(`mode = 'rising'`);
  away.run(`getJson = async url => url.includes('stations.json') ? [] : (() => { throw new Error('404'); })()`);
  await away.run(`(() => { const p = loadRising(); mode = 'station'; return p; })()`);
  assert.equal(away.run('state.rising'), null, 'a stale response never lands in another mode');
});

// ---------- total overview (?total) ----------

// 7 rivers with fixed per-day sums (2nd field) and net deltas (3rd field):
// R1..R5 become the bands, R6+R7 fold into OTHER. Two overview years (2024
// leap, 2025 current). Per-month deltas across all rivers net to +11.
const TOTAL_RIVERS = [['R1', 700, 12], ['R2', 600, -6], ['R3', 500, 4], ['R4', 400, 0],
  ['R5', 300, 2], ['R6', 200, -2], ['R7', 100, 1]];

const totalOverviewFix = (() => {
  const rivers = {}, diff = {};
  for (const [name, v, dv] of TOTAL_RIVERS) { rivers[name] = Array(24).fill(v); diff[name] = Array(24).fill(dv); }
  rivers.R1[13] = null; diff.R1[13] = null; // Feb 2025: R1 has no data
  return { generated: 'g-ov', fromYear: 2024, months: 24, currentYear: 2025, excludedStations: 68, rivers, diff };
})();

const totalShardFix = (() => {
  const rivers = {};
  TOTAL_RIVERS.forEach(([name, val, dval], i) => {
    rivers[name] = { v: Array(365).fill(val), n: Array(365).fill(i + 1),
      dv: Array(365).fill(dval), dn: Array(365).fill(i + 1) };
  });
  rivers.R1.v[130] = null; rivers.R1.n[130] = null; // May 11: R1 silent
  rivers.R1.dv[130] = null; rivers.R1.dn[130] = null;
  return { y: 2025, generated: 'g-25', provisionalFrom: 300, rivers };
})();

const seedTotal = (app, zoom = 'null, null, null') => app.run(`(() => {
  state.total = { overview: ${JSON.stringify(totalOverviewFix)}, top: totalTopRivers(${JSON.stringify(totalOverviewFix)}), error: null };
  totalShardCache.set(2025, ${JSON.stringify(totalShardFix)});
  [totalYear, totalMonth, totalDay] = [${zoom}];
  const vm = totalPlateModel();
  return { vm, html: renderTotal(vm), level: vm.level };
})()`);

test('totalTopRivers: fixed all-time ranking, exactly K bands', () => {
  const app = loadApp({ search: '?total' });
  assert.deepEqual(app.run(`totalTopRivers(${JSON.stringify(totalOverviewFix)})`), ['R1', 'R2', 'R3', 'R4', 'R5']);
});

test('total bars: bands stack to the column total, OTHER folds the tail', () => {
  const app = loadApp({ search: '?total' });
  const out = app.run(`(() => {
    const ov = ${JSON.stringify(totalOverviewFix)};
    const top = totalTopRivers(ov);
    const years = totalYearBars(ov, top);
    const months = totalMonthBars(ov, top, 2025);
    const days = totalDayBars(${JSON.stringify(totalShardFix)}, top, 2025, 4);
    return { years, months, days };
  })()`);
  assert.equal(out.years.length, 2);
  assert.equal(out.years[0].total, 2800, '2024: all seven rivers, every month');
  assert.equal(out.years[0].bands.at(-1).name, 'OTHER');
  assert.equal(out.years[0].bands.at(-1).v, 300, 'OTHER = R6 + R7');
  assert.equal(out.years[0].cmd, 'cmd:ty:2024');
  // 2025: R1's null February must not drag its yearly mean down
  assert.equal(out.years[1].bands[0].v, 700, 'mean over the non-null months only');
  assert.equal(out.months.length, 12);
  assert.equal(out.months[1].bands[0].v, 0, 'R1 contributes nothing to its null month');
  assert.equal(out.months[1].total, 2100);
  assert.equal(out.months[4].cmd, 'cmd:tm:2025:4');
  assert.equal(out.days.length, 31, 'May has 31 day bars');
  assert.equal(out.days[11].cmd, 'cmd:td:2025:4:12');
  assert.equal(out.days[10].total, 2100, 'May 11: R1 silent');
  assert.equal(out.days[11].total, 2800);
});

test('totalDayBreakdown: full ranked list, shares and the provisional flag', () => {
  const app = loadApp({ search: '?total' });
  const bd = app.run(`totalDayBreakdown(${JSON.stringify(totalShardFix)}, 2025, 4, 12)`);
  assert.equal(bd.rows.length, 7);
  assert.deepEqual(bd.rows.map(r => r.name), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'], 'sorted by sum, desc');
  assert.equal(bd.total, 2800);
  assert.equal(bd.gauges, 1 + 2 + 3 + 4 + 5 + 6 + 7);
  assert.ok(Math.abs(bd.rows.reduce((a, r) => a + r.v / bd.total, 0) - 1) < 1e-9, 'shares sum to 1');
  assert.equal(bd.provisional, false);
  const prov = app.run(`totalDayBreakdown(${JSON.stringify(totalShardFix)}, 2025, 10, 7)`);
  assert.equal(prov.provisional, true, 'day 310 sits past provisionalFrom 300');
  const gap = app.run(`totalDayBreakdown(${JSON.stringify(totalShardFix)}, 2025, 4, 11)`);
  assert.equal(gap.rows.length, 6, 'a silent river leaves the list, not a zero row');
});

test('humanizeSum: metres, then kilometres', () => {
  const app = loadApp({ search: '?total' });
  assert.equal(app.run('humanizeSum(4200)'), '42m');
  assert.equal(app.run('humanizeSum(1000000)'), '10.0km');
});

test('humanizeDiff: always signed, cm-fine below a metre', () => {
  const app = loadApp({ search: '?total' });
  assert.equal(app.run('humanizeDiff(0)'), '+0cm');
  assert.equal(app.run('humanizeDiff(-42)'), '-42cm');
  assert.equal(app.run('humanizeDiff(431)'), '+4.3m');
  assert.equal(app.run('humanizeDiff(-25000)'), '-250m');
  assert.equal(app.run('humanizeDiff(-1234567)'), '-12.3km');
});

test('total diff bars: net change summed across rivers, signs preserved', () => {
  const app = loadApp({ search: '?total&diff' });
  const out = app.run(`(() => {
    const ov = ${JSON.stringify(totalOverviewFix)};
    return {
      years: totalDiffYearBars(ov),
      months: totalDiffMonthBars(ov, 2025),
      days: totalDiffDayBars(${JSON.stringify(totalShardFix)}, 2025, 4),
    };
  })()`);
  assert.equal(out.years.length, 2);
  assert.equal(out.years[0].v, 132, '2024: 12 months × net +11');
  assert.equal(out.years[0].cmd, 'cmd:ty:2024');
  assert.equal(out.years[1].v, 120, "2025: R1's null February drops its +12");
  assert.equal(out.months[1].v, -1, 'Feb 2025 without R1 nets negative');
  assert.equal(out.months[4].cmd, 'cmd:tm:2025:4');
  assert.equal(out.days.length, 31, 'May has 31 day bars');
  assert.equal(out.days[10].v, -1, 'May 11: R1 silent, the rest nets negative');
  assert.equal(out.days[11].v, 11);
  assert.equal(out.days[11].cmd, 'cmd:td:2025:4:12');
});

test('totalDiffDayBreakdown: risers first, paired-gauge counts, signs kept', () => {
  const app = loadApp({ search: '?total&diff' });
  const bd = app.run(`totalDiffDayBreakdown(${JSON.stringify(totalShardFix)}, 2025, 4, 12)`);
  assert.deepEqual(bd.rows.map(r => r.name), ['R1', 'R3', 'R5', 'R7', 'R4', 'R6', 'R2'], 'sorted by delta, desc');
  assert.equal(bd.total, 11);
  assert.equal(bd.pairs, 1 + 2 + 3 + 4 + 5 + 6 + 7);
  assert.equal(bd.provisional, false);
  const gap = app.run(`totalDiffDayBreakdown(${JSON.stringify(totalShardFix)}, 2025, 4, 11)`);
  assert.equal(gap.rows.length, 6, 'a silent river leaves the list, not a zero row');
});

test('boot: ?total&diff routes and the deep link round-trips', () => {
  const app = loadApp({ search: '?total&diff&y=2024&d=2024-05-12' });
  assert.equal(app.run('mode'), 'total');
  assert.equal(app.run('totalDiff'), true);
  assert.equal(app.run('totalQuery()'), '?total&diff&y=2024&d=2024-05-12');
  assert.equal(loadApp({ search: '?total' }).run('totalDiff'), false, 'sum stays the default');
  const rt = loadApp({ search: '?total' });
  const q = rt.run(`(() => {
    totalSyncFromUrl(new URLSearchParams('?total&diff&y=2024&m=5'));
    return totalQuery();
  })()`);
  assert.equal(q, '?total&diff&y=2024&m=5');
});

test('tsum/tdiff: the grid command flips the metric and rewrites the URL', () => {
  const app = loadApp({ search: '?total' });
  app.run(`runGridCmd('tdiff')`);
  assert.equal(app.run('totalDiff'), true);
  assert.equal(app.run('totalQuery()'), '?total&diff');
  app.run(`runGridCmd('tsum')`);
  assert.equal(app.run('totalDiff'), false);
  assert.equal(app.run('totalQuery()'), '?total');
});

const seedTotalDiff = (app, zoom = 'null, null, null', overview = totalOverviewFix, shard = totalShardFix) => app.run(`(() => {
  totalDiff = true;
  state.total = { overview: ${JSON.stringify(overview)}, top: totalTopRivers(${JSON.stringify(overview)}), error: null };
  totalShardCache.set(2025, ${JSON.stringify(shard)});
  [totalYear, totalMonth, totalDay] = [${zoom}];
  const vm = totalPlateModel();
  return { vm, html: renderTotal(vm), level: vm.level };
})()`);

test('renderTotal diff: diverging bars around a labelled zero, rivers linked', () => {
  const all = seedTotalDiff(loadApp({ search: '?total&diff' }));
  assert.equal(all.level, 'all');
  assert.ok(all.html.includes('href="?total&amp;diff&amp;y=2024"'), 'a year bar is a real link that keeps Δ');
  // 2024 nets +132, 2025 +120 — both positive, so both sit above the zero line
  assert.ok(all.vm.bars.every(b => b.frac > 0), 'the fixture rises in both years');
  assert.ok(all.html.includes('class="db rose"'), 'rising bars are marked as risen');
  assert.ok(all.html.includes('>0</text>'), 'the zero line is labelled');

  const month = seedTotalDiff(loadApp({ search: '?total&diff' }), '2025, 4, null');
  assert.equal(month.level, 'month');
  assert.ok(month.html.includes('href="?total&amp;diff&amp;y=2025&amp;d=2025-05-12"'), 'a day bar deep-links');
  assert.ok(month.html.includes('class="db fell"'), 'falling days are hatched, not only coloured');

  const day = seedTotalDiff(loadApp({ search: '?total&diff' }), '2025, 4, 12');
  assert.equal(day.level, 'day');
  assert.ok(day.html.includes('href="?river=R1"'), 'ranked rows link to their river');
  assert.ok(day.html.includes('paired'), 'the paired-gauge caveat is on screen');
  assert.ok(day.html.includes('never counts'), 'and the reason it matters');
});

test('renderTotal diff: data built before the diff series degrades to a note', () => {
  const { diff, ...ovNoDiff } = totalOverviewFix;
  const preDiff = seedTotalDiff(loadApp({ search: '?total&diff' }), 'null, null, null', ovNoDiff);
  assert.equal(preDiff.level, 'missing');
  assert.ok(preDiff.html.includes('not built yet'));
  const shardNoDv = JSON.parse(JSON.stringify(totalShardFix));
  for (const rv of Object.values(shardNoDv.rivers)) { delete rv.dv; delete rv.dn; }
  const oldShard = seedTotalDiff(loadApp({ search: '?total&diff' }), '2025, 4, null', totalOverviewFix, shardNoDv);
  assert.equal(oldShard.level, 'missing');
});

test('totalPlateModel: every level carries its zoom links and its crumb trail', () => {
  const all = seedTotal(loadApp({ search: '?total' }));
  assert.equal(all.level, 'all');
  assert.ok(all.html.includes('href="?total&amp;y=2024"'), 'year bars are links');
  assert.deepEqual(all.vm.crumbs.map(c => c.label), ['ALL']);
  assert.equal(all.vm.crumbs[0].current, true, 'the top level is where we are');

  const year = seedTotal(loadApp({ search: '?total' }), '2025, null, null');
  assert.equal(year.level, 'year');
  assert.ok(year.html.includes('href="?total&amp;y=2025&amp;m=5"'), 'month bars are links');
  assert.deepEqual(year.vm.crumbs.map(c => c.label), ['ALL', '2025']);

  const month = seedTotal(loadApp({ search: '?total' }), '2025, 4, null');
  assert.equal(month.level, 'month');
  assert.ok(month.html.includes('href="?total&amp;y=2025&amp;d=2025-05-12"'), 'day bars deep-link');
  assert.deepEqual(month.vm.crumbs.map(c => c.label), ['ALL', '2025', 'MAY']);

  const day = seedTotal(loadApp({ search: '?total' }), '2025, 4, 12');
  assert.equal(day.level, 'day');
  assert.ok(day.html.includes('href="?river=R1"'), 'ranked rows link to rivers');
  assert.ok(!day.html.includes('href="?river=OTHER"'), 'OTHER is a band, never a river link');
  assert.deepEqual(day.vm.crumbs.map(c => c.label), ['ALL', '2025', 'MAY', '12']);
});

test('renderTotal: every band carries a hatch as well as a colour', () => {
  const all = seedTotal(loadApp({ search: '?total' }));
  // five named bands + OTHER, each with its own pattern — meaning never rides
  // on hue alone, so the chart survives greyscale and colour blindness
  assert.equal(all.vm.bands.length, 6);
  assert.equal(all.vm.bands.at(-1).name, 'OTHER');
  const pats = all.vm.bands.map(b => b.pattern);
  assert.equal(new Set(pats).size, 6, 'every band has a distinct hatch');
  for (const p of pats) assert.ok(all.html.includes(`id="tb-${p}"`), `${p} pattern is defined`);
  assert.ok(all.html.includes('url(#tb-solid)'), 'and actually used as a fill');
  assert.ok(all.html.includes('greyscale'), 'the legend says why the hatching is there');
  // legend shares are computed over the whole visible range, not one column
  assert.ok(all.vm.bands.every(b => b.pct >= 0 && b.pct <= 100));
  assert.ok(Math.abs(all.vm.bands.reduce((a, b) => a + b.pct, 0) - 100) <= 2, 'shares add up');
});

test('renderTotal: the day breakdown ranks every river that reported', () => {
  const day = seedTotal(loadApp({ search: '?total' }), '2025, 4, 12');
  const rows = day.vm.breakdown.rows;
  assert.equal(rows.length, 7, 'no truncation — the plate has room the 84 columns did not');
  assert.deepEqual(rows.map(r => r.name), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].pct, 100, 'the biggest sets the bar scale');
  assert.equal(rows.reduce((a, r) => a + r.share, 0), 100, 'shares are whole percents of the day');
  assert.ok(day.html.includes('×1'), 'the gauge count per river rides along');
});

test('boot: ?total routes by deep link, day clamped to the real month length', () => {
  assert.equal(loadApp({ search: '?total' }).run('mode'), 'total');
  assert.equal(loadApp({ search: '?total' }).run('totalYear'), null);
  const y = loadApp({ search: '?total&y=2024' });
  assert.equal(y.run('totalYear'), 2024);
  assert.equal(y.run('totalMonth'), null);
  const d = loadApp({ search: '?total&y=2024&d=2024-05-12' });
  assert.deepEqual([d.run('totalYear'), d.run('totalMonth'), d.run('totalDay')], [2024, 4, 12]);
  const clamp = loadApp({ search: '?total&d=2024-02-31' });
  assert.equal(clamp.run('totalDay'), 29, 'leap February caps at 29');
  assert.equal(loadApp({ search: '?rising&total' }).run('mode'), 'rising', '?rising wins');
});

test('totalQuery/totalSyncFromUrl: the deep link round-trips', () => {
  const app = loadApp({ search: '?total' });
  const q = app.run(`(() => {
    totalYear = 2024; totalMonth = 4; totalDay = 12;
    return totalQuery();
  })()`);
  assert.equal(q, '?total&y=2024&d=2024-05-12');
  assert.deepEqual(app.run(`(() => {
    totalSyncFromUrl(new URLSearchParams('${q}'));
    return [totalYear, totalMonth, totalDay];
  })()`), [2024, 4, 12]);
  assert.equal(app.run(`(() => { totalDay = null; return totalQuery(); })()`), '?total&y=2024&m=5');
});

test('prompt: --total switches, the man page names it', () => {
  const app = loadApp();
  assert.equal(app.run(`parseCommand('--total').total`), true);
  assert.ok(app.run('helpText()').includes('--total'));
  app.run(`runCommand('--total')`);
  assert.equal(app.run('mode'), 'total');
});

test('total chrome: the plate owns the zoom trail', () => {
  const app = loadApp({ search: '?total&y=2025&d=2025-05-12' });
  // the breadcrumb and the metric switch are real links inside the plate;
  // a second set of chips outside it would be two controls for one state
  assert.equal(app.el('home-btn').hidden, false, 'the way back to the station stays');
  const crumbs = app.run('totalCrumbs()');
  assert.deepEqual(crumbs.map(c => c.label), ['ALL', '2025', 'MAY', '12']);
  assert.equal(crumbs.at(-1).current, true, 'the deepest level is where we are');
  assert.equal(app.run(`navHref('cmd:ty:2025')`), '?total&y=2025', 'each crumb is a real URL');
});

// ---------- plate helpers (display redesign, stage 0) ----------

test('harness guard: index.html holds exactly one bare script block', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // the loader regex-extracts the first <script>…</script>; a renderer that
  // ever emits the literal closing tag would silently truncate the suite's
  // view of the app, and a second bare <script> would shadow half the code
  assert.equal(html.split('<script>').length, 2, 'exactly one bare <script> tag');
  assert.equal(html.split('</script').length, 2, 'exactly one closing script tag');
});

test('navHref: the data-st grammar maps to honest hrefs', () => {
  const app = loadApp();
  assert.equal(app.run(`navHref('BONN')`), '?station=BONN');
  assert.equal(app.run(`navHref('river:ELDE MÜRITZ WASSERSTRASSE')`),
    '?river=ELDE%20M%C3%9CRITZ%20WASSERSTRASSE');
  assert.equal(app.run(`navHref('rising')`), '?rising');
  assert.equal(app.run(`navHref('cmd:abs')`), null, 'in-view toggles with no URL stay buttons');
  assert.ok(app.run(`navAttrs('cmd:abs')`).includes('data-nav="cmd:abs"'));
  assert.ok(!app.run(`navAttrs('cmd:abs')`).includes('href'), 'no href on a URL-less cmd target');
  const a = app.run(`navAttrs('B<ONN"')`);
  assert.ok(!a.includes('<'), 'hostile names never reach markup unescaped');
});

test('navTo: routes through the same switches as the grid layer', () => {
  const app = loadApp();
  app.run(`navTo('river:RHEIN')`);
  assert.equal(app.run('mode'), 'river');
  app.run(`navTo('rising')`);
  assert.equal(app.run('mode'), 'rising');
});

test('plateDensity/bucketCols: scale with the measured width, clamped', () => {
  const phone = loadApp({ width: 390 });
  assert.equal(phone.run('plateDensity()'), 'narrow');
  assert.equal(phone.run('bucketCols()'), 130);
  const desk = loadApp({ width: 1200 });
  assert.equal(desk.run('plateDensity()'), 'wide');
  assert.equal(desk.run('bucketCols()'), 320, 'clamped: 1200/3 = 400 caps at 320');
  assert.equal(desk.run('bucketCols(60)'), 40, 'floor at 40 buckets');
});

// ---------- shell (display redesign, stage 1) ----------

test('navHref: the global views are URL targets too', () => {
  const app = loadApp();
  assert.equal(app.run(`navHref('rivers')`), '?rivers');
  assert.equal(app.run(`navHref('total')`), '?total');
  app.run(`navTo('total')`);
  assert.equal(app.run('mode'), 'total');
  app.run(`navTo('rivers')`);
  assert.equal(app.run('mode'), 'rivers');
});

test('watersIndex: groups gauges under their water, biggest first, by km', () => {
  const app = loadApp();
  app.run(`fillDatalist([
    { n: 'EMMERICH', w: 'RHEIN', km: 851.9 },
    { n: 'BONN', w: 'RHEIN', km: 654.8 },
    { n: 'KÖLN', w: 'RHEIN', km: 688 },
    { n: 'HANN.MÜNDEN', w: 'WESER', km: 0.9 },
    { n: 'NIRGENDWO', w: '', km: null },
  ])`);
  const idx = app.run('watersIndex()');
  assert.equal(idx[0].w, 'RHEIN', 'most gauges first');
  assert.deepEqual(idx[0].stations.map(s => s.n), ['BONN', 'KÖLN', 'EMMERICH'], 'stations ordered by km');
  assert.equal(idx[1].w, 'WESER');
  assert.equal(idx[2].w, '', 'waterless gauges collect under the blank key (skipped by the tree)');
});

test('finderMatches: one ranked list, gauges before waters, waters marked', () => {
  const app = loadApp();
  app.run(`fillDatalist([{ n: 'WESEL', w: 'RHEIN', km: 814 }])`);
  app.run(`fillWaters(['WESER', 'WERRA'])`);
  const m = app.run(`finderMatches('WES')`);
  assert.equal(m[0].name, 'WESEL');
  assert.equal(m[0].water, undefined);
  assert.ok(m.some(x => x.name === 'WESER' && x.water === true), 'the river is offered as a river');
});

test('renderCrumbs: All waters ▸ water ▸ gauge, with honest hrefs', () => {
  const app = loadApp({ search: '?station=BONN' });
  const html = app.run(`(() => {
    state.info = { water: { shortname: 'RHEIN' } };
    lastCrumbs = null;
    renderCrumbs();
    return document.getElementById('crumbs').innerHTML;
  })()`);
  assert.ok(html.includes('data-nav="rivers"'), 'All waters is a link to the map');
  assert.ok(html.includes('href="?river=RHEIN"'), 'the water is a link to its profile');
  assert.ok(html.includes('aria-current="page">BONN'), 'the gauge is the current page');

  const rising = loadApp({ search: '?rising' });
  const rhtml = rising.run(`(() => {
    lastCrumbs = null;
    renderCrumbs();
    return document.getElementById('crumbs').innerHTML;
  })()`);
  assert.ok(rhtml.includes('rising board'), 'boards name themselves');
});

// ---------- keyboard layer (display redesign, stage 8) ----------

test('KEYMAP: the help sheet is rendered from the same list the handler uses', () => {
  const app = loadApp({ search: '?station=BONN' });
  const map = app.run('KEYMAP');
  assert.ok(map.length >= 6, 'a real map, not a token gesture');
  for (const [k, what] of map) {
    assert.equal(typeof k, 'string');
    assert.ok(what.length > 3, `${k} explains itself`);
  }
  // the sheet is filled from KEYMAP, so it cannot drift from the bindings
  const sheet = app.el('keymap').innerHTML;
  for (const [k] of map) assert.ok(sheet.includes(k.trim()), `${k.trim()} reaches the help sheet`);
});

test('stepNeighbour: [ and ] walk the river without leaving the keyboard', () => {
  const app = loadApp({ search: '?station=BONN', now: NOON });
  // the Rhine: km counts downstream, so elevation falls as km rises
  const seed = at => app.run(`(() => {
    station = ${JSON.stringify(at)};
    state.flowLowKm = false;
    state.neighbors = [
      { name: 'KÖLN', km: 688, lat: 50.9, lon: 6.9, elev: 45.3 },
      { name: 'BONN', km: 654.8, lat: 50.7, lon: 7.1, elev: 51.8 },
      { name: 'OBERWINTER', km: 637, lat: 50.6, lon: 7.2, elev: 55.1 },
    ];
  })()`);

  seed('BONN');
  app.run('stepNeighbour(1)');
  assert.equal(app.run('station'), 'OBERWINTER', '] goes one gauge upstream');

  seed('BONN');
  app.run('stepNeighbour(-1)');
  assert.equal(app.run('station'), 'KÖLN', '[ goes one gauge downstream');

  // at the end of the list it stays put rather than wrapping into a surprise
  seed('KÖLN');
  app.run('stepNeighbour(-1)');
  assert.equal(app.run('station'), 'KÖLN', 'the end of the list is a stop, not a wrap');
});
