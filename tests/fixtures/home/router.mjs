// The start page's network, frozen. Both layers of the home check import this
// one module — tests/home.test.mjs to stub `fetch` inside the app scope, and
// scripts/home-check.mjs to answer Fetch.requestPaused in a real Chrome — so
// there is one routing table and one clock, not two that drift apart.
//
// The refresh runbook (which curl calls produce these files) is in the header
// of scripts/home-check.mjs.
import { readFileSync } from 'node:fs';

const load = name => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

export const scenario = load('scenario.json');
export const CLOCK = Date.parse(scenario.clock);

export const fixtures = {
  info: load('station-info.json'),
  w: load('w.json'),
  q: load('q.json'),
  measurements: load('measurements-p30d.json'),
  neighbours: load('neighbors-rhein.json'),
  neighbourGauges: load('neighbor-gauges.json'),
  weather: load('weather.json'),
};

// Every request a cold start page makes, and nothing else. Returning null is
// how an unexpected URL becomes a failure instead of a silent trip to the real
// network — the caller decides how to say so, but neither caller may guess.
export function routeFor(url) {
  const u = String(url);
  if (u.includes('api.open-meteo.com')) return { name: 'weather', body: fixtures.weather };
  if (u.includes('/stations/BONN.json')) return { name: 'info', body: fixtures.info };
  if (u.includes('/stations/BONN/Q.json')) return { name: 'q', body: fixtures.q };

  // The refresh poll is armed before the loader runs (index.html, the boot's
  // else branch), and a frozen Date does not freeze setInterval. When it fires,
  // the archive is already seeded, so `start` is an ISO instant rather than
  // P30D — a different URL for the same endpoint. It gets an empty delta: the
  // reading has not moved, which is the truth at a stopped clock.
  if (u.includes('/stations/BONN/W/measurements.json')) {
    const isSeed = u.includes('P30D');
    return { name: isSeed ? 'measurements' : 'measurements-delta', body: isSeed ? fixtures.measurements : [] };
  }
  if (u.includes('/stations/BONN/W.json')) return { name: 'w', body: fixtures.w };
  if (u.includes('/stations.json?waters=')) return { name: 'neighbours', body: fixtures.neighbours };

  // the profile enriches BONN's two neighbours by name
  const nb = u.match(/\/stations\/([^/]+)\/W\.json/);
  if (nb) {
    const name = decodeURIComponent(nb[1]);
    if (Object.prototype.hasOwnProperty.call(fixtures.neighbourGauges, name)) {
      return { name: `neighbour:${name}`, body: fixtures.neighbourGauges[name] };
    }
  }
  return null;
}

// What a complete cold boot must ask for. The home check asserts this set from
// both ends: nothing here went unrequested, and nothing was requested that is
// not here. An `archive` entry is deliberately absent — on the start page the
// 30-day preset is exactly the live API's reach, so loadRepoArchive never runs,
// and that silence is a contract worth failing over.
export const EXPECTED = ['info', 'w', 'measurements', 'q', 'neighbours', 'weather',
  ...Object.keys(fixtures.neighbourGauges).map(n => `neighbour:${n}`)];
