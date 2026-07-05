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
?station=BONN
?station=MARBURG
```

Neighbors for the elevation profile are discovered automatically from the
station's river and kilometrage. Stations without characteristic values or
gauge zero degrade gracefully.

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

