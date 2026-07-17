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

test('helpText: the man page lists every flag', () => {
  const app = loadApp();
  const man = app.run('helpText(null)');
  for (const flag of ['--station', '--river', '--adsb', '--ais', '--history', '--export', '--clear', '--info', '--help']) {
    assert.ok(man.includes(flag), `man page mentions ${flag}`);
  }
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

test('countGaps: only jumps beyond 90 min count', () => {
  const app = loadApp();
  const pts = [[0, 1], [30 * 60000, 1], [120 * 60000, 1], [121 * 60000, 1], [400 * 60000, 1]];
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
    const g = makeGrid(8);
    drawSuggest(g, state.suggest);
    return gridToHtml(g);
  })()`);
  assert.ok(html.includes('data-st="Trier OP"'));
  assert.ok(html.includes('data-st="river:MOSEL"'));
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
test('drawProfile: labels never overwrite each other, at any width', () => {
  const neighbors = [
    { name: 'DUISBURG-MEIDERICH SCHLEUSE UW', km: 6.1, lat: 51.4, lon: 6.7, elev: 85.98 },
    { name: 'FRIEDRICHSTADT STRASSENBRÜCKE', km: 6.4, lat: 51.4, lon: 6.7, elev: 85.99 },
    { name: 'Niederbiel Schleuse Kanal OP', km: 6.9, lat: 51.4, lon: 6.7, elev: 86.01 },
  ];
  for (const width of [390, 1200]) {
    const app = loadApp({ width, now: NOON });
    const { cols, rows } = app.run(`(() => {
      station = 'FRIEDRICHSTADT STRASSENBRÜCKE';
      state.info = { water: { shortname: 'RHEIN' } };
      state.neighbors = ${JSON.stringify(neighbors)};
      const g = makeGrid(PROFILE_ROWS + PROFILE_FOOT);
      drawProfile(g, 0);
      return { cols: COLS, rows: g.ch.map(r => r.join('')) };
    })()`);
    const flat = rows.join('\n');
    for (const p of neighbors) {
      const elev = p.elev.toFixed(2), km = `km ${p.km}`;
      // the name is shortened only as far as the width forces — never further
      const budget = cols - elev.length - km.length - 4;
      const name = p.name.length > budget ? p.name.slice(0, budget - 1) + '…' : p.name;
      assert.ok(flat.includes(`${name} ${elev} · ${km}`),
        `${cols} cols: "${name} ${elev} · ${km}" survives intact`);
    }
    assert.ok(flat.includes('≋ downstream →'), `${cols} cols: flow marker survives`);
    for (const r of rows) assert.ok(r.length <= cols, `${cols} cols: no row overflows`);
  }
});

// ---------- drawRiver layout invariants (worst case: 30 stations, 24 troubled) ----------

test('drawRiver: no label overlaps even on a crowded, clustered river', () => {
  const app = loadApp({ now: NOON }); // noon: keeps the night sky layer out of the layout
  const sts = Array.from({ length: 30 }, (_, i) => ({
    name: 'ST' + String(i).padStart(2, '0'),
    km: 100 + i * 0.8 + (i % 5 === 0 ? i : 0), // clusters with occasional jumps
    value: 150 + i,
    elev: 60 - i * 0.5 - (i % 3),
    kind: i % 5 === 4 ? 'normal' : (i % 2 ? 'low' : 'high'),
  }));
  app.run(`state.river = 'TESTFLUSS'`);
  const { res, grid } = app.run(`(() => {
    const sts = ${JSON.stringify(sts)};
    const g = makeGrid(riverGridRows(sts));
    const res = drawRiver(g, sts, 0);
    return { res, grid: g.ch.map(r => r.join('')) };
  })()`);

  assert.equal(res.nLow, 12);
  assert.equal(res.nHigh, 12);
  assert.ok(res.labels.length >= 2, 'at least some labels were placed');

  // every drawn label stays inside the 84-column grid…
  for (const l of res.labels) {
    assert.ok(l.col >= 0 && l.col + l.text.length <= 84, `label ${l.text} inside the grid`);
  }
  // …and no two labels on the same row overlap or sit fused together
  const byRow = new Map();
  for (const l of res.labels) {
    byRow.set(l.row, [...(byRow.get(l.row) || []), l]);
  }
  for (const [row, labels] of byRow) {
    labels.sort((a, b) => a.col - b.col);
    for (let i = 1; i < labels.length; i++) {
      const prev = labels[i - 1];
      assert.ok(labels[i].col > prev.col + prev.text.length,
        `row ${row}: "${prev.text}" and "${labels[i].text}" keep a blank cell between them`);
    }
  }

  const flat = grid.join('\n');
  assert.ok(flat.includes('TROUBLE'), 'trouble list header present');
  assert.ok(flat.includes('… and 16 more'), '24 troubled stations cap at 8 + overflow line');
});

// ---------- grid & escaping ----------

test('putKmSign / putBig: negative river km render instead of crashing', () => {
  const app = loadApp();
  const grid = app.run(`(() => {
    const g = makeGrid(12);
    putKmSign(g, 0, 0, -38.7); // MARBURG (Lahn) — km signs must survive a minus
    putBig(g, 9, 0, '-39', 'b');
    return g.ch.map(r => r.join(''));
  })()`);
  assert.ok(grid[3].includes('███'), 'minus glyph drawn inside the sign');
  assert.ok(grid[0].includes('┌───┬───┬───┐'), 'three-cell sign frame for "-39"');
  assert.ok(grid[11].includes('███'), 'big digits render the minus row');
});

test('gridToHtml: escapes markup, emits class and link runs', () => {
  const app = loadApp();
  const html = app.run(`(() => {
    const g = makeGrid(1);
    put(g, 0, 0, '<&>', 'b');
    linkCells(g, 0, 0, 3, 'A"B');
    return gridToHtml(g);
  })()`);
  assert.ok(html.includes('&lt;&amp;&gt;'), 'grid text is HTML-escaped');
  assert.ok(html.includes('data-st="A&quot;B"'), 'link layer emitted, attribute quotes escaped');
  assert.ok(html.includes('class="b"'));
});

// ---------- responsive COLS breakpoint (Chrome desktop cannot shrink below ~500px,
// so the 84 ↔ 44 switch is pinned here instead of via window resizing) ----------

test('fitFont: picks 44 columns on phone widths, 84 on desktop, and switches back', () => {
  const phone = loadApp({ width: 390 });
  assert.equal(phone.run('COLS'), 44, '390px viewport boots into the compact grid');
  assert.equal(phone.run('isCompact()'), true);
  assert.ok(parseFloat(phone.el('screen').style.fontSize) >= 8, 'compact font stays readable (>= 8px)');

  const desktop = loadApp({ width: 1200 });
  assert.equal(desktop.run('COLS'), 84, '1200px viewport uses the full grid');
  assert.equal(desktop.run('isCompact()'), false);

  // crossing the breakpoint at runtime (rotate / window resize)
  desktop.document.documentElement.clientWidth = 390;
  desktop.run('fitFont()');
  assert.equal(desktop.run('COLS'), 44, 'shrinking re-picks the compact grid');
  desktop.document.documentElement.clientWidth = 1200;
  desktop.run('fitFont()');
  assert.equal(desktop.run('COLS'), 84, 'growing restores the full grid');
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
});

test('loadRepoArchive: a manifest none-entry skips archive fetches and flags the station', async () => {
  const app = loadApp({ now: NOON });
  app.run(`state.info = { uuid: 'gap-uuid' }`);
  app.run(`getJson = async url => {
    if (url === 'archive/manifest.json') return { stations: { 'gap-uuid': { n: 'Marburg', w: 'LAHN', none: true } } };
    globalThis.__unexpected = url;
    throw new Error('unexpected fetch ' + url);
  }`);
  await app.run('loadRepoArchive(2000)');
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
  await app.run('loadRepoArchive(400)');
  const arch = app.run(`loadArchive('BONN')`);
  assert.equal(arch.length, 2, 'one archived day → daily min + max as two points');
  assert.deepEqual(arch.map(p => p[1]), [110, 190]);
  const mezBase = Date.UTC(year, 0, 1) - 36e5 + 9 * 864e5;
  assert.deepEqual(arch.map(p => p[0]), [mezBase + 6 * 36e5, mezBase + 18 * 36e5]);

  // a second call is a no-op (per-session fetch guard), even with new data
  await app.run('loadRepoArchive(400)');
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
  await app.run('loadRepoArchive(60)'); // 60-day window spans the year boundary
  const arch = app.run(`loadArchive('BONN')`);
  assert.equal(arch.length, 2);
  const dec30 = Date.UTC(2026, 0, 1) - 36e5 + 363 * 864e5;
  assert.deepEqual(arch.map(p => p[0]), [dec30 + 6 * 36e5, dec30 + 18 * 36e5],
    'points land on Dec 30, 2026 — the file year wins, not the wall clock');
});

test('drawSparkline: renders a time axis labeled from real timestamps', () => {
  const app = loadApp({ now: NOON });
  // two years of daily points ending at NOON — multi-year span → YYYY-MM ticks
  const days = 730;
  const pts = Array.from({ length: days }, (_, i) => [NOON - (days - 1 - i) * 864e5, 100 + (i % 40)]);
  app.run(`state.archive = ${JSON.stringify(pts)}`);
  app.run(`historyKey = 'all'`);
  const grid = app.run(`(() => {
    const g = makeGrid(10);
    drawSparkline(g, 0, 0.5);
    return g.ch.map(r => r.join(''));
  })()`);
  const axis = grid[2 + 4 + 1]; // SPLASH_ROWS + SPARK_ROWS + 1
  assert.ok(/\d{4}-\d{2}/.test(axis), `axis carries YYYY-MM ticks: "${axis.trim()}"`);
  assert.ok(axis.trimStart().startsWith('2024-01'), 'first tick sits at the two-years-ago start (NOON is 2026-01-15)');
  assert.ok(axis.includes('2026-01'), 'last tick is the now end');
  assert.ok(grid[0].includes('HISTORY'), 'label row intact');
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
  await app.run('loadStationList()');
  assert.equal(app.run('station'), 'KÖLN', 'error screen self-corrected to the canonical station');
});
