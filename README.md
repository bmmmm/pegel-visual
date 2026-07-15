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
  the level rises fast a lone rain cloud drifts in upstream as a harbinger;
  after sunset (computed for the station's real coordinates) a moon rises
  and stars twinkle over the water. The scene also mirrors real weather at
  the station (rain, snow, clouds, wind) via [open-meteo](https://open-meteo.com),
  refreshed every 15 min
- automatic dark mode (`light-dark()`, follows your system), tab title and
  favicon carry the live level — the buddy's waterline tracks MNW…MHW
- history sparkline — starts with the API's 15 days and grows: every visit
  merges the data into a local archive (localStorage, per station), so over
  time your sparkline covers more than the API can serve. Points older than
  16 days are thinned to hourly. `export` downloads the archive as JSON,
  `import` restores a previously exported file (e.g. after switching
  devices) and merges it with what is already there, `clear` (click twice)
  deletes it. Nothing ever leaves your browser.
  Fetching is API-friendly: the 15-day history is requested once as a seed,
  afterwards only the delta since the newest archived point is pulled.
- water surface elevation profile (m NHN) between the neighboring
  stations on the same river, ordered by river km
- water temperature and discharge in the header when the station reports
  them, all-time record markers (HHW/NNW) on the chart when available, and
  a frozen river scene — static pack ice, drifting floes, a ship stuck fast —
  once water temperature drops to 0.5 °C or below

## Any station

Default is Bonn (Rhine). Type a station name into the prompt at the bottom
(with autocomplete over all PEGELONLINE stations), or use the query param:

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
- `--history RANGE` — set the sparkline window (`24h`, `3d`, `7d`, `15d`, `30d`, `all`);
  the choice also lands in the URL, so shared links reproduce it
- `--export` — download the whole local archive as JSON
- `--clear` — delete the local archive (no confirmation — you typed it)
- `--info` — open the feature guide dialog (also linked as `info` in the footer):
  every feature on the page, explained in one box
- `--help` — show a man page with all of the above right on the screen

River names autocomplete alongside stations: typing or picking a known river
(e.g. `RHEIN`) opens the whole-river profile directly.

Flags combine, e.g. `--station KÖLN --history 7d` switches station and
range in one command. Press Escape to dismiss the help screen.

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

## Aircraft overhead (optional, bring your own receiver)

If you run an ADS-B receiver (tar1090 / readsb / adsb.im image), put its URL
into the `--adsb` field of the prompt (e.g. `http://10.0.0.5:8080`). Live
aircraft are projected onto the river axis between the neighbor stations and
drawn in the sky at their barometric altitude, with callsign and flight level.
The URL is stored in your browser's localStorage only — it never leaves your
machine. Note: the public HTTPS page cannot fetch a plain-http LAN receiver
(mixed content); serve the page locally or put the receiver behind HTTPS.

## Run locally

```
python3 -m http.server 8123
open http://127.0.0.1:8123/
```

Data: © Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV),
[PEGELONLINE](https://www.pegelonline.wsv.de), refreshed every 5 minutes.

## Support

If you enjoy this, you can [buy me a coffee on Ko-fi](https://ko-fi.com/bmabma). ☕

