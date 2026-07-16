import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
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

test('history presets: 1Y/5Y exist, API backfill stays within its 30-day reach', () => {
  const app = loadApp();
  const presets = app.run('HISTORY_PRESETS');
  assert.deepEqual(presets.map(p => p.k), ['24h', '3d', '7d', '15d', '30d', '1y', '5y', 'all']);
  assert.equal(presets.find(p => p.k === '1y').d, 365);
  assert.equal(presets.find(p => p.k === '5y').d, 1825);
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
