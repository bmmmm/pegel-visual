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
- history sparkline — starts with the API's 15 days and grows: every visit
  merges the data into a local archive (localStorage, per station), so over
  time your sparkline covers more than the API can serve. Points older than
  16 days are thinned to hourly. `export` downloads the archive as JSON,
  `clear` (click twice) deletes it. Nothing ever leaves your browser.
  Fetching is API-friendly: the 15-day history is requested once as a seed,
  afterwards only the delta since the newest archived point is pulled.
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

