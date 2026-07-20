# pegel-visual

Live ASCII water level terminal for German rivers — a single static page,
Bauhaus black-and-white, powered by the open [PEGELONLINE](https://www.pegelonline.wsv.de)
REST API (WSV). No build step, no backend, no dependencies.

**Live:** https://bmmmm.github.io/pegel-visual/

```
_      _      _      _      _      _      _      _
)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_
```

## What it shows

- current level as big block digits, trend per hour, MNW/MHW state
- animated river cross-section: waves at the live level, drifting current,
  seeded riverbed, a little ship, markers for MNW / MW / MHW
- living scenes: below MNW the sun blazes over a cracked, dried-out bank;
  above MHW storm clouds drift in and rain falls on the swollen river; when
  the level rises fast (≥ 2 cm/h) a lone rain cloud drifts in upstream as a
  harbinger of the water to come — independent scenes can overlap, e.g. a
  drought sun next to the harbinger cloud when a low river is refilling;
  after sunset (computed for the station's real coordinates) the moon rises
  in its real current phase and stars twinkle over the water. The scene also
  mirrors real weather at the station (rain, snow, clouds, wind) via
  [open-meteo](https://open-meteo.com), refreshed every 15 min
- automatic dark mode (`light-dark()`, follows your system), tab title and
  favicon carry the live level — the buddy's waterline tracks MNW…MHW
- history sparkline — starts with the API's 15 days and grows: every visit
  merges the data into a local archive (localStorage, per station), so over
  time your sparkline covers more than the API can serve. Points older than
  16 days are thinned to hourly, older than a year to 6-hourly. `export`
  downloads the archive as JSON, `import` restores a previously exported
  file (e.g. after switching devices) and merges it with what is already
  there, `clear` (click twice) deletes it. Nothing ever leaves your browser.
  Fetching is API-friendly: the 15-day history is requested once as a seed,
  afterwards only the delta since the newest archived point is pulled.
- **years, not days:** WSV publishes each station's raw archive back to
  2000-01-01 ([DL-DE→Zero-2.0](https://www.govdata.de/dl-de/zero-2-0)).
  This repo hosts a condensed copy — daily min/max — as two files per
  station on the `archive` branch: `closed.json`, an immutable bundle of
  every completed year, and `current.json`, the running year. So picking
  `1Y` / `5Y` / `ALL` fetches just three files same-origin (manifest +
  bundle + running year) and merges them into your local archive on the
  fly. A monthly CI run refreshes the running year from the PEGELONLINE
  REST API (a month at a time); each January the completed year is
  re-backfilled from the WSV archive download — the monthly snapshots
  only fill days the archive is missing — and graduates into the
  immutable bundle. The live API covers the newest 30 days on
  top, so the site is never more than a month stale. Multi-year views are
  flagged as *unvalidated raw data*, since WSV serves these values
  unchecked (outliers and gaps included; the manifest records a per-station
  gap-day count as inspection metadata — the page itself does not surface
  it). `scripts/fetch-wsv-archive.mjs` builds and refreshes the
  data — the full backfill still uses WSV's ZIP download page, which the
  browser cannot fetch cross-origin (it sends its CORS header twice, see
  issue #1). The manual route works too: the `full archive (2000→)` link
  opens the station's WSV download page, and `import` swallows the ZIP
  directly (unpacked in the browser via `DecompressionStream`, still no
  dependencies)
- **beyond WSV:** ten Dutch gauges PEGELONLINE relays live but WSV keeps no
  multi-year archive for (LOBITH, PANNERDENSE KOP, TIEL, VUREN, ZALTBOMMEL,
  NIJMEGEN HAVEN, IJSSELKOP, DORDRECHT, KRIMPEN, ROTTERDAM) are backfilled
  from [Rijkswaterstaat](https://www.rijkswaterstaat.nl) open data (CC0)
  instead, back to ~1989. Each carries a `source` marker in the archive
  manifest so the *unvalidated raw data* attribution names the right origin;
  `scripts/fetch-rws-archive.mjs` builds and refreshes them. Values were
  verified seamless with the live PEGELONLINE feed (identical NAP datum). See
  the [`archive` branch README](../../tree/archive) for the per-source
  attribution
- **years view** (`▦ YEARS` chip or `?view=years`) — the station as a
  multi-year statistics terminal, built from the same daily archive:
  a heatmap of every year by month (`ABS` shades the level itself,
  `ANOM` the deviation from that month's long-term mean — dry months in
  the drought accent, wet months in the flood accent, `·` for normal),
  the long-term monthly min–max band with median against the current
  year, and a day-of-year overlay of all years with one year bold —
  click any year in the heatmap to put it on top or page through them
  with the `◂ year ▸` chips; clicking a month cell prints its numbers
  (monthly mean, min–max, deviation from the long-term month mean in σ)
  in a readout line
- water surface elevation profile (m NHN) between the neighboring
  stations on the same river, ordered by river km — neighbors are one
  click away, and the current station's own label opens the whole-river
  profile
- water temperature and discharge in the header when the station reports
  them, all-time record markers (HHW/NNW) on the chart when available, and
  a frozen river scene — static pack ice, drifting floes, a ship stuck fast —
  once water temperature drops to 0.5 °C or below

## Any station

Default is Bonn (Rhine). Type a station name into the prompt at the bottom
(with autocomplete over all PEGELONLINE stations), or use the query param.
Partial names work: a fragment that matches exactly one station (umlaut
spellings folded) switches directly, an ambiguous one — `MAGDEBURG`,
`HAMBURG`, `TRIER` — opens a clickable *did you mean* list instead of an
error:

```
?station=BONN
?station=MARBURG
```

Neighbors for the elevation profile are discovered automatically from the
station's river and kilometrage. Stations without characteristic values or
gauge zero degrade gracefully.

The prompt is a tiny REPL: type a bare name to switch station, or a
flag command (flags are matched case-insensitively) to do more in one go:

- `--station NAME` — switch to station NAME (same as typing a bare name)
- `--adsb URL` — set your ADS-B receiver URL; `--adsb` with no value clears it
- `--ais URL` — set your AIS receiver URL; `--ais` with no value clears it
- `--history RANGE` — set the sparkline window (`24h`, `3d`, `7d`, `15d`, `30d`,
  `1y`, `5y`, `10y`, `20y`, `all`); the choice also lands in the URL, so shared
  links reproduce it
- `--view MODE` — switch the sub-view: `years` (station statistics), `wave`
  (river heatmap) or `live`; also lands in the URL, so shared links reproduce it
- `--export` — download the whole local archive as JSON
- `--clear` — delete the local archive (no confirmation — you typed it)
- `--info` — open the feature guide dialog (also linked as `info` in the footer):
  every feature on the page, explained in one box
- `--help` — show a man page with all of the above right on the screen

River names autocomplete alongside stations: typing or picking a known river
(e.g. `RHEIN`) opens the whole-river profile directly.

Flags combine, e.g. `--station KÖLN --history 7d` switches station and
range in one command. Press `/` to focus the prompt from anywhere on the
page, Escape to dismiss the help screen.

`share` in the footer hands the station link to your system share sheet
(or copies it). The page ships a web manifest, so it can be installed as
an app from the browser menu.

## Whole-river mode

Instead of one station, view an entire river as a single ASCII longitudinal
profile: every gauge on the river laid out by river kilometre (downstream to
the left), plotted at its live water-surface elevation (m NHN), with a
`TROUBLE` list of every station currently running low or high. One request to
PEGELONLINE fetches the whole river; it refreshes on the same 5-minute cycle.
Markers use a distinct glyph per state so colour never carries meaning alone:
`◉` normal, `▼` low, `▲` high. Every marker, label and `TROUBLE` row is a
click target — one click jumps into that station's terminal (the elevation
profile's neighbor stations are clickable the same way).

On narrow screens the whole app switches from the 84-column grid to a
44-column compact layout instead of shrinking the font into illegibility.

Entry points — the query param or the prompt's `--river` flag (any case,
multi-word river names allowed):

```
?river=RHEIN
> pegel --river RHEIN
> pegel --river ELDE MÜRITZ WASSERSTRASSE
```

A profile line looks like this — the water surface stepping down between two
gauges, a flagged low station labelled below its marker:

```
                      RUHRORT
      ·······◉·······  57.94
◉·····                        ·····▼·····
812.4                              WESEL
                                   19.03
```

`--river` and `--station` are mutually exclusive views; typing a station name
(or `--station NAME`) from river mode switches straight back. Back/forward in
the browser restores whichever view the URL held.

### Wave view

The `PROFILE / ▦ WAVE` chips under the prompt, `[▦ WAVE]` in the river
header or `?river=RHEIN&view=wave` redraw the whole
river as a station × day heatmap: rows run downstream (top = upstream), columns
are the last ~2.5 months, and darker cells mean higher water — each row scaled
to its own station's range. A flood wave shows up as a diagonal ridge rolling
down the screen as it travels toward the mouth. The bulk of the data comes from
the hosted daily archive (refreshed monthly); the newest ~31 days are filled
live from the PEGELONLINE API, at most 6 requests in flight and capped at 24
sampled stations per river. Every row is a click target into that station.

## Aircraft overhead (optional, bring your own receiver)

If you run an ADS-B receiver (tar1090 / readsb / adsb.im image), put its URL
into the `--adsb` field of the prompt (e.g. `http://10.0.0.5:8080`). Live
aircraft are projected onto the river axis between the neighbor stations and
drawn in the sky at their barometric altitude, with callsign and flight level.
The URL is stored in your browser's localStorage only — it never leaves your
machine. Note: the public HTTPS page cannot fetch a plain-http LAN receiver
(mixed content); serve the page locally or put the receiver behind HTTPS.

## Ships on the river (optional, bring your own receiver)

If you run an [AIS-catcher](https://github.com/jvde-github/AIS-catcher)
receiver, put its web server URL into the `--ais` field (e.g.
`http://10.0.0.5:8080/aiscatcher` on an adsb.im image — the ship list is
fetched from `<url>/ships.json` every 5 s). Real river traffic within ~2 km
of the river axis is drawn right on the waterline: a direction-aware hull
with ship name (or MMSI) and speed in knots, and a `ais: N ships` status in
the header. While real ships are in view, the decorative boat politely yields
the river. The URL stays in your browser's localStorage; the same
mixed-content caveat as for ADS-B applies.

## Run locally

```
python3 -m http.server 8123
open http://127.0.0.1:8123/
```

## Tests

The inline logic is covered by a dependency-free `node:test` suite:
`tests/extract.mjs` pulls the script out of `index.html` and evaluates it
against a minimal hand-rolled browser stub (no jsdom, no network, an
injectable clock for the astronomy). Run it with:

```
node --test
```

CI runs the same suite on every push and pull request.

Data: © Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV),
[PEGELONLINE](https://www.pegelonline.wsv.de), refreshed every 5 minutes.

## License

[GPL-3.0](LICENSE).

## Support

If you enjoy this, you can [buy me a coffee on Ko-fi](https://ko-fi.com/bmabma). ☕

