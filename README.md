# pegel-visual

Live water level survey plates for German rivers — a single static page,
ink-and-pastel linework, powered by the open [PEGELONLINE](https://www.pegelonline.wsv.de)
REST API (WSV). No build step, no backend, no dependencies.

Every view is a *plate*: a title block saying what you are looking at, the
drawing itself, a legend for every mark it uses, and a foot naming the source
and the age of the reading. If a section cannot name itself in its own legend,
it does not ship — a test pulls the mark classes out of every drawing and out
of its key and fails on the first one the key does not name.

**Live:** https://bmmmm.github.io/pegel-visual/ ·
**Forecast gate:** https://bmmmm.github.io/pegel-visual/gate/

```
_      _      _      _      _      _      _      _
)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_)`'-.,_
```

## What it shows

- **the reading** — the live level as hero digits in the gauge's *own* unit:
  centimetres above gauge zero for most, metres above a datum for the 69
  gauges that report that way (reservoirs, barrages, canals). Next to it the
  trend per hour, averaged over 6 hours — gauges report whole centimetres and
  a big river moves centimetres per *day*, so an hourly slope rounds to a flat
  `0` almost every time — and the state relative to MNW / MHW. Under an hour
  of history, or after a silence longer than 12 hours, the trend reads `—`,
  not a made-up zero. Water temperature and flow join the facts when the
  station reports them.
- **the living river** — an animated cross-section: waves at the live level,
  drifting current, a seeded riverbed, a little ship, dashed marks for
  MNW / MW / MHW and the all-time records HHW / NNW. The scene reacts to the
  world: below MNW the sun blazes over a cracked, dried-out bank; above MHW
  storm clouds drift in and rain falls on the swollen river; at 0.5 °C or
  below the river freezes over — static pack ice, drifting floes, a ship
  stuck fast. Real weather at the station (rain, snow, cloud cover, wind)
  comes from [open-meteo](https://open-meteo.com), refreshed every 15
  minutes; after sunset, computed for the station's real coordinates, the
  moon rises in its current phase and stars twinkle over the water — unless
  it is overcast.
- **automatic dark mode** (`light-dark()`, follows your system); the tab
  title and favicon carry the live level — the buddy's waterline tracks
  MNW…MHW.
- **the history block** — a time chart that starts with the API's 30 days
  and grows: every visit merges the readings into a local archive
  (localStorage, per station), so over time it covers more than the API can
  serve. Points older than 16 days are thinned to hourly, older than a year
  to 6-hourly; the least-recently viewed stations are evicted first when the
  quota fills. The range chips sit on the block itself — `24H 3D 7D 15D 30D
  1Y 5Y 10Y 20Y ALL`, plus `▦ YEARS` — and land in the URL, so a shared link
  reproduces the window. Fetching is API-friendly: the 30 days are requested
  once as a seed, afterwards only the delta since the newest archived point.
  The chart's x axis is time, not sample index, so a resolution change
  inside a window is drawn through while a real silence breaks the line; the
  note under the chart says where the record actually ends (`no reading
  after …`). `export` downloads the archive as JSON, `import` restores a
  previously exported file (or swallows a WSV archive ZIP directly, unpacked
  in the browser via `DecompressionStream`), `clear` deletes it after a second
  click; a per-station breakdown lets you drop one gauge at a time. Nothing
  ever leaves your browser.
- **years, not days** — picking `1Y` and beyond fetches the hosted daily
  archive same-origin: the manifest, the station's bundle of completed years
  and its running year, merged into your local archive on the fly. Where
  it comes from, how it is refreshed and where it ends is in *Where the data
  comes from* below; the plate flags it *unvalidated raw data* and names the
  source, and a gauge WSV never archived says so instead of offering an
  import that cannot deliver.
- **years view** (`▦ YEARS` or `?view=years`) — the station as a multi-year
  statistics terminal, built from the same daily archive: a heatmap of every
  year by month (`absolute` shades the level itself, `anomaly` the deviation
  from that month's long-term mean — dry months in the drought accent, wet
  months in the flood accent), the long-term monthly min–max band with
  median against the current year, and a day-of-year overlay of all years
  with one year bold. Click a year in the heatmap to put it on top or page
  through them with the `◂ ▸` chips; clicking a month cell prints its
  numbers (mean, min–max, deviation from the long-term month mean in σ) in a
  readout line. `← live` goes back.
- **the elevation profile** — water surface elevation (m NHN) between the
  neighbouring gauges on the same river. It always runs downstream to the
  right: German river kilometres count downstream on the Rhine but upstream
  on the Neckar, so the direction comes from the elevation, not from the km.
  Neighbours are one click away, and the station's own label opens the
  whole-river profile.
- **the chrome** — an app bar with the wordmark, the station item (the
  active gauge on its own plate, `← BONN` — the way back — on every other
  view), `map`, `rising`, `totals`, `forecast gate`, `⌕ find` and `ⓘ`; a
  breadcrumb trail (`All waters ▸ RHEIN ▸ BONN`); a finder dialog
  with search, browse-by-water, recents and arrow-key navigation; a footer
  with `info`, `report issue` (builds a bug report from the live state and
  hands it to GitHub or the clipboard), `share`, `source` and Ko-fi. Every empty, loading or error state is drawn by the
  water-drop buddy, who says what is wrong.

## Any station

Default is Bonn (Rhine). Press `/` for the finder, type a name into the
prompt in the tools fold, or use the query param. Partial names work: a
fragment that matches exactly one station (umlaut spellings folded) switches
directly, an ambiguous one — `MAGDEBURG`, `HAMBURG`, `TRIER` — opens a
clickable *did you mean* list instead of an error:

```
?station=BONN
?station=MARBURG
```

Neighbours for the elevation profile are discovered automatically from the
station's river and kilometrage. Stations without characteristic values or
gauge zero degrade gracefully.

The prompt is a tiny REPL: a bare name switches station (a bare *river*
name opens the whole-river profile), or a flag command does more in one go.
Flags are matched case-insensitively and combine, e.g. `--station KÖLN
--history 7d`:

- `--station NAME` — switch to station NAME (same as typing a bare name)
- `--river NAME` — whole-river profile of NAME (any case, multi-word)
- `--rivers` — the rivers map (same as `map` in the app bar or `?rivers`)
- `--rising` — the rising board (same as `rising` or `?rising`)
- `--total` — the total overview (same as `totals` or `?total`)
- `--rain` — rainfall per NRW basin (same as `rain` or `?rain`)
- `--history RANGE` — the history window: `24h`, `3d`, `7d`, `15d`, `30d`,
  `1y`, `5y`, `10y`, `20y`, `all`
- `--view MODE` — the sub-view: `years` (station statistics), `wave` (river
  heatmap), `list` (the waters A–Z, with `--rivers`) or `live`
- `--export` — download the whole local archive as JSON
- `--clear` — delete the local archive (no confirmation — you typed it)
- `--info` — the feature guide: every feature on the page, explained in one box
- `--help` — a man page with all of the above right on the screen

The keyboard layer covers the same ground without typing, and the `?` sheet
lists it: `/` opens the finder, `?` the feature guide, `h` the man page;
`1`…`9` and `0` pick a history range, `[` and `]` walk to the next gauge
downstream / upstream, `g` `m` `r` `t` jump to gauge, map, rising board and
totals, `a` toggles absolute / anomaly in the years view, `w` profile / wave
in river mode, `d` sum / change in the totals, `.` copies this view's link,
`Esc` closes the manual or a dialog, zooms out of the totals or leaves a
sub-view. Nothing but `Esc` fires while a field or a dialog has focus.

`share` in the footer hands the current view's link to your system share
sheet (or copies it). The page ships a web manifest and a shell-only service
worker (network first, never the data), so it installs as an app from the
browser menu.

## The rivers map

`map` (or `?rivers`, `--rivers`) puts every water PEGELONLINE serves on one
screen — a schematic outline of Germany with each river anchored at the
centroid of its own gauges and labelled with how many it has. Click a name
to open that river's profile.

```
?rivers
?rivers&view=list
```

The outline is an SVG polygon under an equirectangular projection with the
longitude scaled by cos(51.15 N), so Germany keeps its shape at any width.
Label placement is greedy from the busiest water down, with real
bounding-box collision and a cap that follows the width (12 labels on a
phone, 26 on a desk): names that find no free spot are listed in the
`A–Z index` tab instead of being squeezed over a neighbour — the browsable
list the map cannot be, every water with its gauge count.

Two things are deliberately kept apart: a river's **gauge count** includes
every gauge, its **position** comes only from gauges that have coordinates.
PEGELONLINE carries a few dozen gauges without any (57 of 786 when counted
on 2026-09-02) — the Austrian Donau, the Czech Elbe, the Dutch Rhine — and letting
that gap into the count would advertise `DONAU 18` for a river whose profile
then opens with 27. Waters with no located gauge at all are listed under the
map with their real count, and the key says how many are missing and why.

## The rising board

`rising` (or `?rising`, `--rising`, the `who's rising` link in the finder)
ranks every gauge by how fast it moved since yesterday, in cm per day: the
top 20 risers, the 8 steepest fallers below, every row a click away from its
station, with a sparkline of its recent days and a bar proportional to the
rate.

```
?rising
?rising&d7
```

The live API only tells the present — it has no bulk history — so the
"yesterday" comes from a daily snapshot of all stations that a scheduled
workflow captures onto the `archive` data branch
(`archive/snapshots/YYYY-MM.json`, one value per station per day, written by
`scripts/snapshot-wsv.mjs`). The rate is normalized over the real time since
that capture, so a missed snapshot day cannot double an apparent rise, and a
baseline younger than 12 hours is not used at all. Until the first snapshot
is a day old, the board says so and shows what the live values alone can:
how many gauges sit high, low, normal. The `1D` / `7D` chips move the
baseline a week back: same cm/day unit, the total centimetres of the span in
brackets, and the span it actually measured — a missed snapshot day makes it
`Δ6.8 d` rather than exactly seven.

Where a station has mean low/high water marks, its row adds context: already
`HIGH` / `LOW`, or a rough straight-line ETA like `→MHW ~18d`. Tidal gauges
are counted but never ranked — a day apart, the tide phase has wandered
~50 minutes, so their day diff would measure the tide, not the river. They
are recognized by their `MThw` mark or, where the API carries no marks at all
(Rotterdam, Helgoland, the barrage gauges), by a flag the snapshot job derives
from the tide in their own archived daily record (median daily span ≥ 40 cm —
rivers measure 3–6 cm, tidal gauges 195–280).

## The total overview

`totals` (or `?total`, `--total`) stacks every river's summed gauge readings
into one bar chart and zooms interactively: all years → one year's months →
one month's days → a single day, where every river is ranked by its share of
that day's sum, each row a click away from its river profile. The five
all-time biggest rivers keep a fixed band, colour, glyph and hatch at every
level; the rest folds into `OTHER`. Every zoom level is a shareable link:

```
?total
?total&y=2024
?total&y=2024&d=2024-05-12
?total&diff
```

The metric is deliberately transparent: the sum of every reporting gauge's
daily mid value `(min+max)/2` in cm — a reading of the network, not a
volume, since every gauge zero is an arbitrary datum. The handful of gauges
that report absolute elevation in metres (`m+NN` — reservoirs, barrages) are
excluded before summing; their unit only exists in the live API, so a unit
sidecar is persisted alongside the aggregate.

Because the absolute sum grows with every gauge that joins the archive (and
carries the arbitrary datums as a huge constant baseline), trends belong to
the `Δ change` chip (`?total&diff`): the net day-over-day change, counting
only gauge pairs that reported on both days. A gauge's first reporting day
never contributes, so coverage ramps cancel out and the diverging bars show
how much water actually arrived or left — per day, netted per month, and
netted per year at the zoomed-out levels. `Σ sum` switches back.

The data is pre-aggregated on the `archive` branch by
`scripts/build-river-totals.mjs` (`archive/totals/overview.json` — every
river at monthly grain, one fetch for the zoomed-out levels;
`archive/totals/<year>.json` — every river at daily grain, fetched lazily
per visited year). The weekly archive workflow rebuilds it from the full
per-station archive; the daily snapshot workflow appends today, marking
snapshot-sourced days as provisional until the next rebuild.

## Rainfall per basin

`rain` (or `?rain`, `--rain`) draws the areal daily rainfall of all sixteen
NRW basins, day by day, from the LANUK mirror. The 30D/60D/90D chips widen
the window and are shareable links:

```
?rain
?rain&w=90
```

Two things separate this grid from the wave view it borrows its chassis from.
The ramp is **fixed in millimetres** — the collector's own 50/80/95 %
quantiles over its 90-day window, printed in the key — so a wet week looks wet
next to a dry one, where WAVE scales every row to its own gauge. And the Σ7d
column is the collector's number, not the page's: days without a reading are
not counted, and the tooltip says how many there were.

The right edge is the mirror's newest rain day **with a reading**, which is not
today and not even the newest day the source window names: the export runs
mid-afternoon and a rain day starts at 07:00, so the current day is always half
a day short. There is no live feed for this source at all, and the foot says so.

A basin whose name is not a link has no gauged river of its own (the Emscher).

Each LANUK station page carries the same data for its own catchment — a
**PRECIPITATION** block with the areal rain over every rain gauge that drains
into that gauge, drawn against the gauge's own level in the same columns, and a
**RESPONSE** block with the measured correlation between the two at lags 0 to 7
days plus the rise per 10 mm. A gauge with fewer than three rain gauges upstream
says so instead of drawing a thin mean.

The aggregate is baked on the `nrw` branch by `scripts/build-nrw-precip.mjs`
(`nrw/precip/`), which is a pure function of the mirror: any checkout can
recompute it byte-for-byte, and `--check` proves the committed bytes are the
ones the rule produces.

## Whole-river mode

Instead of one station, view an entire river as a single longitudinal
profile: every gauge on the river laid out along the flow (upstream to the
left, downstream to the right — the foot says so), plotted at its live
water-surface elevation (m NHN), with a
`TROUBLE` list of every station currently running low or high. One request to
PEGELONLINE fetches the whole river; it refreshes on the same 5-minute cycle.
Markers carry shape as well as colour (`◉` normal · `▼` low · `▲` high) so
meaning never rides on hue alone. Every marker and `TROUBLE` row is a real
link — one click jumps into that gauge's plate. On a phone the `TROUBLE`
list comes first: it is the answer to "is anything wrong on this river?"

Layout is continuous: container queries and SVG viewBoxes size every plate to
the space it actually has, so there is no hard phone/desktop fork and no font
shrunk into illegibility.

Entry points — the query param, the prompt's `--river` flag or a bare river
name (any case, multi-word river names allowed):

```
?river=RHEIN
> pegel --river RHEIN
> pegel --river ELDE MÜRITZ WASSERSTRASSE
> pegel ERFT
```

`--river` and `--station` are mutually exclusive views; typing a station name
(or `--station NAME`) from river mode switches straight back. Back/forward in
the browser restores whichever view, sub-view, range and year the URL held.

### Wave view

The `profile / wave` chips on the river plate or `?river=RHEIN&view=wave`
redraw the whole river as a station × day heatmap: rows run downstream
(top = upstream), columns are the last ~2.5 months, and darker cells mean
higher water — each row scaled to its own station's range. A flood wave shows
up as a diagonal ridge rolling down the screen as it travels toward the
mouth. The bulk of the data comes from the hosted daily archive; the newest
~31 days are filled live from the PEGELONLINE API, at most 6 requests in
flight, and a river with more than 24 gauges is sampled evenly along its
length (the foot says `N of M gauges sampled`). Every row is a click target
into that station.

## Where the data comes from

Three gauge sources, one weather feed, and no forecast — each named on the
plate that uses it.

- **PEGELONLINE (WSV)** — the live feed: every federal-waterway gauge with
  its current reading, the last 30 days, and the characteristic values (MNW,
  MW, MHW, HHW/NNW, `MThw` for tidal gauges). Refreshed on a 5-minute cycle,
  attribution on every foot. © Wasserstraßen- und Schifffahrtsverwaltung des
  Bundes.
- **The WSV archive (2000→)** — WSV publishes each station's raw record back
  to 2000-01-01 under [DL-DE→Zero-2.0](https://www.govdata.de/dl-de/zero-2-0).
  This repo keeps a condensed copy — daily min/max — on the `archive` branch,
  two files per gauge: `closed.json`, an immutable bundle of every completed
  year, and `current.json`, the running year. The running year has two
  feeders, because one was not enough: a **weekly** REST pull
  (`fetch-wsv-archive.mjs --current`; the server caps the window at ~31 days)
  and, on the first Monday of the month, a re-read of the whole running year
  from the ZIP download (`--running`) plus a gap sweep — the ZIP path is the
  only one that can look back past the REST retention, and it is what healed
  the half year a cancelled monthly run once tore out. Each January the
  completed year is re-backfilled from the ZIP and graduates into
  `closed.json`. About 111 of the 739 gauges have no WSV archive at all (lock and
  weir gauges, foreign partner gauges, a few harbour gauges): that is a
  recorded fact in `manifest.json` (`noArchive`), not a failure — such a
  gauge still grows a running year from the weekly pull, and the plate says
  which of the two it is looking at. Multi-year views are flagged
  *unvalidated raw data*, since WSV serves these values unchecked. The
  browser cannot fetch the ZIP itself (the download page sends its CORS
  header twice), so the `full archive (2000→)` link opens WSV's page and
  `import` swallows the ZIP.
- **Rijkswaterstaat** — ten Dutch gauges PEGELONLINE relays live but WSV
  keeps no archive for (LOBITH, PANNERDENSE KOP, TIEL, VUREN, ZALTBOMMEL,
  NIJMEGEN HAVEN, IJSSELKOP, DORDRECHT, KRIMPEN, ROTTERDAM) are backfilled
  from [Rijkswaterstaat](https://www.rijkswaterstaat.nl) open data (CC0)
  instead, back to ~1989, by `scripts/fetch-rws-archive.mjs`. Verified
  seamless with the live feed (same NAP datum); the manifest's `source`
  marker routes the attribution. See the
  [`archive` branch README](../../tree/archive) for the per-source detail.
- **LANUK NRW** — the Erft, the Sieg and the rest of North Rhine-Westphalia's
  state gauges are not on PEGELONLINE at all. They come from the
  [LANUK NRW](https://hochwasserportal.nrw) open-data export (dl-de/zero-2.0):
  ~300 gauges with daily mean and maximum (the minimum is computed from the
  15-minute series, so seeded history draws its lower edge at the daily mean
  and the legend says so), ~310 rain gauges and ~110 water-temperature
  stations, plus the official alert stages. The source is a daily export with
  a rolling window (730 days daily, 63 days at 15-minute resolution) and sends
  no CORS header, so `scripts/fetch-nrw-archive.mjs` mirrors it once a day
  into two GitHub-only branches: `nrw` (the daily level, mounted under
  `/nrw/`) and `nrw-hires` (the fine resolution, kept but never deployed).
  These stations have no live feed — their plate says *no live feed* and names
  the export time instead of refreshing. `?station=MENDEN_1`, `?river=SIEG`,
  `?river=ERFT`.
- **Weather** — the scene mirrors the current conditions at the gauge
  (rain, snow, cloud cover, wind) from [open-meteo](https://open-meteo.com),
  refreshed every 15 minutes. It dresses the drawing; it is not a forecast,
  and no weather model feeds one — see the gate below.

### The data branches

Four orphan branches carry data and nothing else. They live on GitHub only,
never on the Forgejo origin, and are only ever fast-forwarded. None of them
holds a `.github/` directory, so a push there can never start a workflow —
every job that writes a deployed branch dispatches the deploy explicitly.

| Branch | Holds | Written by | Deployed |
|---|---|---|---|
| `archive` | daily min/max per WSV and RWS gauge since 2000 (`archive/<uuid>/closed.json` + `current.json`), the daily snapshots for the rising board (`archive/snapshots/YYYY-MM.json`), the river totals (`archive/totals/`) | `archive-update` weekly, `snapshot-update` twice daily | mounted as `/archive/` |
| `hires` | 15-minute readings of eight gauges for the short-horizon forecast gate | `scripts/forecast/collect-hires.sh`, weekly from one machine (launchd) | no |
| `nrw` | LANUK NRW daily level, alert stages, topology | `nrw-update` daily | mounted as `/nrw/` |
| `nrw-hires` | LANUK 15-minute gauges, hourly rain and water temperature, the raw seed of 2026-09-04 | `nrw-update` daily | no |

Every push to `archive` passes `scripts/check-archive-consistency.mjs`
first — seven rules that can each go red: recency (R1), totals alive (R2),
coverage (R3), nothing lost against the previous commit (R4), shapes (R5),
the running year present fleet-wide (R6) and the no-archive markers intact
(R7). The daily snapshot job skips R6 and R7, because it cannot fix what they
find and a blocked snapshot loses its day slot for good. The `nrw` branch
has its own gate (`check-nrw-consistency.mjs`, N1–N8); `nrw-hires` is
mirrored as fetched. `data-freshness` watches the two deployed branches once
a day — `archive` for commit age, deployed drift and manifest age, `nrw` for
commit age — and opens or updates an issue labelled `data-freshness` instead
of failing silently. `hires` has no watchdog but its collector's own
heartbeat.

## The forecast gate

https://bmmmm.github.io/pegel-visual/gate/

Before a forecast view could be drawn, one question had to be answered:
does a model beat what needs no model? `scripts/forecast/` (Python 3.12 via
uv) runs a rolling-origin backtest of Google's
[TimesFM](https://github.com/google-research/timesfm) — a zero-shot
time-series model, no training on this data — against a
persistence/climatology blend on the closed years of the daily archive:
seven gauges in five river regimes, from the tidal Elbe at Cuxhaven to the
alpine Danube at Passau, test origins from 2016 on, lead days 1–90. `gate.py`
decides with clauses pre-registered before the first run (A1–A7: skill per
block, a bootstrap on the regimes, calibration, a contamination probe):
`SHIP`, `NO-SHIP`, `VOID` or `PROVISIONAL`. The reports are committed under
`gate/` and rendered as a plate of their own: the error-by-lead-day curve on
a log axis with the picked block hatched, a lead cursor you can drag or drive
with the arrow keys, target and gauge chips that land in the URL
(`?target=`, `?lead=`), and everything beyond the one picture folded behind
an index.

**The verdict on file is NO-SHIP, twice.** TimesFM 2.5 (Apache-2.0, the only
line this GPL repo may ever ship) reaches a pooled skill of +0.07 at lead days
1–14 under a bar of 0.10, nothing at 15–30, and loses to plain climatology at
31–90. TimesFM 3.0 was measured as a challenger on the same test origins: a
little better at the first and the last block, level at the middle one, and
nowhere near the bar — and its weights are non-commercial, so it is named on
the sheet with a ⚖ and can never become the shipped model, however it
scores; `scripts/forecast/tests/test_license.py` holds that.
The short horizon (48 h on the 15-minute grid) stays `PROVISIONAL` until
every gauge has 60 independent origins, which is what the weekly `hires`
collection is accumulating toward. A weather model as forecast input was
evaluated and rejected the same way: the gate fails exactly where a weather
forecast could help, and TimesFM is univariate. So the station plate draws no
forecast, and the gate page says why.

`cd scripts/forecast && uv run python backtest.py --help` is the whole
bootstrap — a plain `uv run` syncs torch and the shipped `timesfm` pin into
`scripts/forecast/.venv/`, with the download cache under `tmp-forecast/`;
the challenger line lives in a conflicting group
(`--no-group model --group model-nc`). Re-running the gate consumes the test
set: read `gate/*/report.md` before touching a threshold.

## Run locally

```
python3 -m http.server 8123
open http://127.0.0.1:8123/
```

The data branches are not on `main`, so a local page has the live API and
nothing else: multi-year ranges, the rising board and `?total` show their
no-data states. To rehearse them with real data, mirror what the deployed
site serves into the git-ignored mounts — `archive/manifest.json` plus one
gauge's `closed.json` and `current.json` into `archive/<uuid>/` — and
`?station=BONN&history=5y` drives the range straight from the URL. One
backdated snapshot slot gives the rising board a baseline:

```
PEGEL_NOW=$(date -u -v-1d +%Y-%m-%dT03:00:00Z) node scripts/snapshot-wsv.mjs --out archive/snapshots
```

(BSD `date`; on Linux use `date -u -d yesterday +%Y-%m-%dT03:00:00Z`.)

A headless `--screenshot` is not a check: `scheduleRender()` rides on
`requestAnimationFrame`, which a headless page never serves, so every view
screenshots as `loading…`. Drive a real browser over CDP or WebDriver BiDi
instead — the recipe, both engines and the phone emulation are in
`.claude/domains/browser-verify.md`; `scripts/gate-check.mjs` is the committed
form of it for the gate page.

## Tests and CI

`node --test` runs a dependency-free `node:test` suite in a few seconds.
`tests/extract.mjs` is the harness rather than a test: it pulls the script
out of `index.html` and evaluates it against a minimal hand-rolled browser
stub — no jsdom, no network, an injectable clock — so `app.run('<expr>')`
reaches any top-level function in the page and `app.fire('keydown', …)`
reaches the real handlers.

- `logic.test.mjs` — the page itself: parsing, view models, every renderer,
  the legend gate (every mark class in a drawing must appear in that
  drawing's own key) and a hostile-station-name pass over the renderers
- `snapshot.test.mjs`, `archive-consistency.test.mjs` — the daily snapshots
  and the seven rules that guard the archive they accumulate into
- `wsv-archive.test.mjs`, `rws-archive.test.mjs` — the two WSV/RWS backfill
  pipelines, pinned to the defects a data audit found
- `nrw-archive.test.mjs`, `nrw-consistency.test.mjs`, `nrw-precip.test.mjs` —
  the LANUK collector, its N1–N8 gate, and the areal-rain rule clause by clause
- `river-totals.test.mjs` — the summed-stage build
- `collect-hires.test.mjs` — the 15-minute collector and its wrapper
- `gate-page.test.mjs` — the gate page's model and renderer against the
  committed reports, under the same legend gate as the app
- `home.test.mjs` — the start page's cold boot over the frozen fixtures in
  `tests/fixtures/home/`, the same routing table `scripts/home-check.mjs`
  serves to a real browser

`scripts/forecast/tests/` is a pytest suite for the gate: windows, baselines,
the statistics, the clause logic on synthetic results, and the licence guard
(`uv run --no-sync pytest -q` after `uv sync --locked --no-group model`).

| Workflow | When | What |
|---|---|---|
| `tests` | every push and PR to `main` | `node --test`; the pytest suite without model weights; `scripts/gate-check.mjs` and `scripts/home-check.mjs` driving the gate page and the start page in the runner's Chrome — desktop and phone, plus a dark scheme and a deliberately failing station call for the start page |
| `pages` | after a green `tests` run on `main` (`workflow_run`), or dispatched by a data job | copies the site without `scripts/`, `tests/`, `.github/`, `.claude/` and `CLAUDE.md`, stamps the commit into `index.html` and the deploy date into `sitemap.xml`, mounts `archive/` and `nrw/` from their branches, deploys to GitHub Pages |
| `archive-update` | Mondays 04:23 UTC | WSV REST refresh; on the first Monday the ZIP heal of the running year and the gap sweep; RWS refresh; totals rebuild; consistency gate; push; deploy |
| `snapshot-update` | daily 05:17 and 15:17 UTC | bulk capture of every gauge, totals append, gate without R6/R7, push, deploy — two slots because scheduler drift once pushed a run past midnight |
| `nrw-update` | daily 17:41 UTC | LANUK mirror into `nrw` and `nrw-hires`, areal rain baked from the fresh mirror, N1–N8 gate, push, deploy |
| `data-freshness` | daily 19:47 UTC | the watchdog over `archive` and `nrw`; reports into an issue |

A push to `main` deploys only after a green `tests` run; a data job's
dispatch deploys whatever `main` holds at that moment, unasked. The
engineering notes that are
not needed on every turn — the browser recipe, the gate's registry and pins,
the LANUK measurements — live in `.claude/domains/`; `CLAUDE.md` carries the
rules that are.

Data: © Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV),
[PEGELONLINE](https://www.pegelonline.wsv.de), refreshed every 5 minutes;
Rijkswaterstaat open data (CC0) for the ten Dutch gauges; NRW state gauges:
Landesamt für Natur, Umwelt und Klima NRW (LANUK),
[hochwasserportal.nrw](https://hochwasserportal.nrw), dl-de/zero-2.0,
mirrored daily; weather: [open-meteo](https://open-meteo.com).

## License

[GPL-3.0](LICENSE). The shipped forecast line is Apache-2.0; the
non-commercial challenger is measured, never shipped.

## Support

If you enjoy this, you can [buy me a coffee on Ko-fi](https://ko-fi.com/bmabma). ☕
