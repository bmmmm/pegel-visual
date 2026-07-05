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
- 15-day history sparkline
- water surface elevation profile (m NHN) between the neighboring
  stations on the same river, ordered by river km

## Any station

Default is Bonn (Rhine). Type a station name into the prompt at the bottom
(with autocomplete over all PEGELONLINE stations), or use the query param:

```
?station=KÖLN
?station=MARBURG
```

Neighbors for the elevation profile are discovered automatically from the
station's river and kilometrage. Stations without characteristic values or
gauge zero degrade gracefully.

## Run locally

```
python3 -m http.server 8123
open http://127.0.0.1:8123/
```

Data: © Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV),
[PEGELONLINE](https://www.pegelonline.wsv.de), refreshed every 5 minutes.
