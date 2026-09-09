// scripts/fetch-nrw-archive.mjs — the registry and the topology, on the real
// Sieg basin. Until 2026-09-09 (audit item C6) buildTopology had no test at
// all: the N8 gate's fixture wrote its graph by hand, 300 gauges with
// `down: null`, so no gate had ever seen a chain the collector built.
//
// The fixture is cut from the data branch, not invented: every station that
// assignBasin puts into basin 272 (Sieg) on the collector's own registry.json
// of 2026-09-09 — 27 gauges, 32 rain, 9 temperature stations, with the two
// Rhineland-Palatinate gauges that only the GKZ prefix places and the five
// Agger-Verband gauges that only the catchment NAME places. Empty-string
// fields are dropped (measured: the topology is byte-identical with and
// without them). The expected values below were read off the branch's
// topology.json; the builder reproduces that file exactly on this subset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseTable, parseSeries, parseKm, parseNum, buildRegistry, basinIndex, assignBasin,
  stretchOf, riverCodeOf, uniqueBy, spanOfRows, buildTopology, isGaugeLike,
} from '../scripts/fetch-nrw-archive.mjs';

const FIXTURE = new URL('./fixtures/nrw/registry-sieg.json', import.meta.url);
const loadSieg = () => new Map(Object.entries(JSON.parse(readFileSync(FIXTURE, 'utf8')).stations));

function siegTopology(hasLevel = () => true) {
  const registry = loadSieg();
  const bidx = basinIndex(registry);
  return { registry, topo: buildTopology(registry, e => assignBasin(e, bidx), hasLevel) };
}

// ---------- buildTopology on the Sieg ----------

test('topology: the Sieg basin has one mouth, and it is Menden', () => {
  const { topo } = siegTopology();
  assert.deepEqual(Object.keys(topo.basins), ['272']);
  const b = topo.basins['272'];
  assert.equal(b.mouth, '2729100000100');
  assert.equal(topo.gauges[b.mouth].name, 'Menden_1');
  assert.equal(topo.gauges[b.mouth].downSrc, 'mouth');
  assert.equal(topo.gauges[b.mouth].down, null);
  assert.equal(b.river, 'Sieg');
  assert.equal(b.gauges.length, 27);
  assert.equal(b.rain.length, 32);
  assert.equal(b.temp.length, 9);
  assert.equal(Object.values(topo.gauges).filter(g => g.downSrc === 'mouth').length, 1, 'exactly one basin mouth');
});

test('topology: every chain runs downstream — distance to the confluence falls along `down`', () => {
  const { topo } = siegTopology();
  let links = 0;
  for (const g of Object.values(topo.gauges)) {
    if (!g.down || g.downSrc !== 'river') continue;
    const next = topo.gauges[g.down];
    assert.ok(next, `${g.id} points at ${g.down}, which is not a node`);
    assert.equal(next.water, g.water, `${g.id}: a river link stays on its river`);
    assert.ok(g.distKm > next.distKm, `${g.name} (${g.distKm} km) -> ${next.name} (${next.distKm} km) flows uphill`);
    links++;
  }
  assert.ok(links >= 10, `only ${links} river links in a basin of 27 gauges`);
});

test('topology: a tributary mouth is hooked onto the Sieg by its GKZ, downstream of its confluence', () => {
  const { topo } = siegTopology();
  const gkz = Object.values(topo.gauges).filter(g => g.downSrc === 'gkz');
  assert.ok(gkz.length >= 5, `only ${gkz.length} tributary mouths`);
  for (const g of gkz) {
    const parent = topo.gauges[g.down];
    assert.ok(parent, `${g.id} points at ${g.down}, which is not a node`);
    assert.notEqual(parent.water, g.water, `${g.name}: a tributary mouth leaves its river`);
    assert.ok(parent.stretch > g.riverCode, `${g.name} joins ${parent.name} upstream of its own confluence`);
  }
  // three read off the branch's topology.json
  assert.equal(topo.gauges['2727290000100'].down, '2727500000100', 'Hanfbach -> Sieg at Eitorf');
  assert.equal(topo.gauges['2724900000100'].down, '2725910000100', 'Nister -> Sieg');
  assert.equal(topo.gauges['2727890000100'].down, '2729100000100', 'Pleisbach -> Sieg at Menden');
});

test('topology: no `down` points at itself or into a cycle', () => {
  const { topo } = siegTopology();
  for (const start of Object.keys(topo.gauges)) {
    const seen = new Set();
    for (let id = start; id; id = topo.gauges[id].down) {
      assert.ok(!seen.has(id), `cycle through ${id} starting at ${start}`);
      seen.add(id);
      assert.ok(topo.gauges[id], `${id} is not a node`);
    }
  }
});

test('topology: a gauge without a level series is listed under noLevel and is never a node', () => {
  const dropped = '2727500000100'; // Eitorf, mid-chain on the Sieg
  const { topo } = siegTopology(e => e.station_no !== dropped);
  const b = topo.basins['272'];
  assert.deepEqual(b.noLevel, [dropped]);
  assert.equal(topo.gauges[dropped], undefined);
  assert.ok(!b.gauges.includes(dropped));
  for (const g of Object.values(topo.gauges)) assert.notEqual(g.down, dropped, `${g.id} still points at the dropped gauge`);
  // the chain closes over the gap: Sieg gauges upstream of Eitorf now reach Menden
  assert.equal(topo.gauges['2725910000100'].down, '2729100000100');
  assert.equal(b.gauges.length, 26);
});

test('topology: the basin-only station of a name is placed, the gauge of another basin is not', () => {
  const { topo, registry } = siegTopology();
  for (const g of Object.values(topo.gauges)) assert.equal(g.basin, '272');
  const srcs = {};
  for (const g of Object.values(topo.gauges)) srcs[g.basinSrc] = (srcs[g.basinSrc] || 0) + 1;
  assert.deepEqual(srcs, { bulk: 20, gkz: 2, name: 5 });
  assert.equal([...registry.values()].filter(isGaugeLike).length, 27);
});

// ---------- the registry and its parsers ----------

test('parseTable: header, CRLF, an empty line and a short row', () => {
  const t = parseTable('station_no;station_name;catchment_no\r\n1;A;272\r\n\r\n2;B\r\n');
  assert.deepEqual(t.header, ['station_no', 'station_name', 'catchment_no']);
  assert.deepEqual(t.rows, [
    { station_no: '1', station_name: 'A', catchment_no: '272' },
    { station_no: '2', station_name: 'B', catchment_no: '' },
  ]);
});

test('parseSeries: rows keyed by station, a gap, a block terminator, accuracy 0 is not a value', () => {
  // values carry a decimal POINT in the value tables (the km fields of the
  // station table are the ones with a comma); a comma here is not a number
  const text = 'station_no;time;value;accuracy\r\n1;2026-09-01T00:00:00+01:00;12.5;100\r\n1;2026-09-02T00:00:00+01:00;;\r\n1;\r\n2;2026-09-01T00:00:00+01:00;7;0\r\n2;2026-09-02T00:00:00+01:00;abc;100\n2;2026-09-03T00:00:00+01:00;3\n';
  const s = parseSeries(text);
  assert.deepEqual(s.header, ['station_no', 'time', 'value', 'accuracy']);
  assert.deepEqual([...s.stations.keys()], ['1', '2']);
  assert.deepEqual(s.stations.get('1'), [['2026-09-01T00:00:00+01:00', 12.5, 100], ['2026-09-02T00:00:00+01:00', null, null]]);
  assert.deepEqual(s.stations.get('2'), [
    ['2026-09-01T00:00:00+01:00', null, 0],      // accuracy 0 %: not measured
    ['2026-09-02T00:00:00+01:00', null, 100],    // not a number
    ['2026-09-03T00:00:00+01:00', 3, null],      // three fields, no accuracy column
  ]);
});

test('parseKm / parseNum: units, decimal comma, empty, a dash', () => {
  assert.equal(parseKm('8,60 km'), 8.6);
  assert.equal(parseKm('2825,00 km²'), 2825);
  assert.equal(parseKm('4485.94'), 4485.94);
  assert.equal(parseKm(''), null);
  assert.equal(parseKm('-'), null);
  assert.equal(parseKm(null), null);
  assert.equal(parseNum('250,0'), 250);
  assert.equal(parseNum(' 3.5 '), 3.5);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum('-'), null);
  assert.equal(parseNum(undefined), null);
});

test('buildRegistry: stations.json first, tables fill the blanks, _src lists every carrier', () => {
  const reg = buildRegistry({
    stations: [{ station_no: '1', station_name: 'A', catchment_no: '' }, { station_no: '', station_name: 'no id' }],
    tables: {
      gauges: [{ station_no: '1', station_name: 'A-table', catchment_no: '272' }],
      rain: [{ station_no: '2', station_name: 'R' }],
      temp: [{ station_no: '1', LANUV_MW: '5' }],
    },
  });
  assert.deepEqual([...reg.keys()], ['1', '2']);
  const e = reg.get('1');
  assert.equal(e.station_name, 'A', 'the first source wins a filled field');
  assert.equal(e.catchment_no, '272', 'an empty field is filled by a later table');
  assert.equal(e.LANUV_MW, '5');
  assert.deepEqual(e._src, ['stations', 'pegel', 'temp']);
  assert.deepEqual(reg.get('2')._src, ['nieder']);
});

test('basinIndex / assignBasin: number wins, then name, then the GKZ prefix — and a name maps once', () => {
  const reg = new Map([
    ['a', { station_no: 'a', catchment_no: '272', catchment_name: 'Sieg' }],
    ['b', { station_no: 'b', catchment_no: '278', catchment_name: 'Sieg' }], // the same name under a second number
    ['c', { station_no: 'c', catchment_no: '2781', catchment_name: '---' }],
  ]);
  const idx = basinIndex(reg);
  assert.deepEqual([...idx.nos].sort(), ['272', '278', '2781']);
  assert.equal(idx.nameToNo.get('Sieg'), '272', 'the first number seen owns the name');
  assert.equal(idx.nameToNo.has('---'), false);
  assert.deepEqual(assignBasin({ station_no: 'x', catchment_no: '278' }, idx), { no: '278', src: 'bulk' });
  assert.deepEqual(assignBasin({ station_no: 'x', catchment_name: 'Sieg' }, idx), { no: '272', src: 'name' });
  // a gauge with a number only: the LONGEST known basin prefix
  assert.deepEqual(assignBasin({ station_no: '2781500000100', _src: ['pegel'] }, idx), { no: '2781', src: 'gkz' });
  // a rain station is never placed by its number
  assert.deepEqual(assignBasin({ station_no: '2781500000100', _src: ['nieder'] }, idx), { no: null, src: null });
  assert.deepEqual(assignBasin({ station_no: 'abc', _src: ['pegel'] }, idx), { no: null, src: null });
});

test('assignBasin on the fixture: Betzdorf and Heimborn by GKZ, the Agger Verband gauges by name', () => {
  const registry = loadSieg();
  const idx = basinIndex(registry);
  assert.deepEqual(assignBasin(registry.get('27200500'), idx), { no: '272', src: 'gkz' });
  assert.deepEqual(assignBasin(registry.get('2724900000100'), idx), { no: '272', src: 'gkz' });
  assert.deepEqual(assignBasin(registry.get('2728759000100'), idx), { no: '272', src: 'name' });
  assert.deepEqual(assignBasin(registry.get('2729100000100'), idx), { no: '272', src: 'bulk' });
});

test('stretchOf / riverCodeOf: the LAWA stretch in a 13-digit number, site 102 short numbers, the parent code', () => {
  assert.equal(stretchOf('2729100000100', '100'), '27291');
  assert.equal(stretchOf('2721330000100', '100'), '272133');
  assert.equal(stretchOf('27200500', '105'), null, 'an 8-digit number is a stretch only at site 102');
  assert.equal(stretchOf('27200500', '102'), '272');
  assert.equal(stretchOf('x', '100'), null);
  assert.equal(riverCodeOf('27291', '272'), '272', 'odd digits after the basin: the main river');
  assert.equal(riverCodeOf('272729', '272'), '27272', 'the last even digit closes a tributary code');
  assert.equal(riverCodeOf('27249', '272'), '2724');
  assert.equal(riverCodeOf('27249', '278'), null, 'a stretch outside its basin has no code');
  assert.equal(riverCodeOf(null, '272'), null);
});

test('uniqueBy / spanOfRows: empty, one element, duplicates, null values do not span', () => {
  assert.deepEqual(uniqueBy([], r => r.k), []);
  assert.deepEqual(uniqueBy([{ k: 'a' }], r => r.k), [{ k: 'a' }]);
  assert.deepEqual(uniqueBy([{ k: 'a', i: 1 }, { k: 'a', i: 2 }, { k: '', i: 3 }, { k: 'b', i: 4 }], r => r.k), [{ k: 'a', i: 1 }, { k: 'b', i: 4 }]);
  assert.deepEqual(spanOfRows([]), { from: null, to: null });
  assert.deepEqual(spanOfRows([[['2026-01-01', 1]]]), { from: '2026-01-01', to: '2026-01-01' });
  assert.deepEqual(spanOfRows([[['2026-01-03', 1], ['2026-01-09', null]], [['2026-01-02', 0]]]), { from: '2026-01-02', to: '2026-01-03' });
});
