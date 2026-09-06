# LANUK NRW — the second gauge source (Erft, Sieg, and the rest of NRW)

Read this before touching `scripts/fetch-nrw-archive.mjs`,
`scripts/check-nrw-consistency.mjs`, `.github/workflows/nrw-update.yml`, the
`nrw`/`nrw-hires` branches, or the LANUK seam in `index.html`
(`isLanukId`/`seriesBase`/`loadLanukStation`). Everything below was measured
on 2026-09-04 against the live portal; the numbers are facts about that day,
not promises.

## Why this source exists (and why not WeatherNext)

The Erft and the Sieg are not federal waterways: 0 of the 738 stations in
`archive/manifest.json` belong to them, PEGELONLINE does not carry them. The
LANUK NRW portal is the only source for them — it is not an alternative to a
weather feed, it is the only gauge feed we lack.

Google **WeatherNext** was evaluated the same day and rejected on four
independent grounds, each sufficient on its own. Do not reopen this without
new facts:

1. The forecast gate fails at h15–90 (`gate/seasonal-mid/report.md`); no
   weather model has skill past ~15 days, WeatherNext 3 ends there. The broken
   block is unreachable by construction.
2. The seasonal protocol trains on 2000–2015; WeatherNext exists since 2024.
   There is no TRAIN window (that would need ERA5).
3. TimesFM is univariate. A covariate is a different model class, not a flag;
   the existing upstream input (`upstream_ols`) buys KÖLN 1.5 cm at h1–14 and
   nothing beyond.
4. License trap like TimesFM 3.0: data ≥ 1 h old is CC BY 4.0, but the
   *future* runs under real-time terms with a mandatory "not intended,
   validated, or approved for real world use" disclaimer, a 500 USD liability
   cap, Californian law and revocable access. CI cannot reproduce a
   discretionary approval.

For precipitation *forecasts* the right source would be DWD Open Data
(ICON-D2, MOSMIX, RADOLAN, CC BY 4.0, no form); `loadWeather()` already pulls
current precipitation from open-meteo with CORS, `preconnect` and attribution.

## The source, measured

`https://hochwasserportal.nrw/data` — KISTERS WISKI-WEB of the LANUK NRW.
License **dl-de/zero-2.0**, stated in the portal only for the *download page*
(the bulk ZIPs). No license statement exists for the per-station JSONs, so
**the bulk ZIPs are the primary source** and the single-station fetch stays
the exception. Zero requires no attribution; we attribute anyway.

| Finding | Consequence |
|---|---|
| **No CORS header on any endpoint** | The browser can never query it. Everything is pre-baked. No live feed for these gauges — no poll, no "refreshes every 5 min", the foot says `kein Live-Feed`. |
| **`/data/` is a daily export**, not a live system (values ~9.5 h old, ZIP inner stamps 14:10–15:45 UTC) | Pulling more than daily buys nothing. "Current" means ~24 h here; `manifest.sourceExportAt` carries it so the display cannot sell it as live. |
| **56 of 310 gauges are missing from the bulk**, and they split **48 + 8** | 48 deliver `S/year.json` via single fetch; **8 advertise only `WT`** in `_links` (temperature/quality stations with `object_type: Oberflächengewässer`). "No `S`" is a **finding, not a failure**, or every scheduled run dies red like the 111 WSV lock gauges did. Rule: **read `index.json`, never guess `site_no`.** |
| **No registry is a superset of another** | 11 rain gauges exist only in `nieder_stationen.txt`, 6 only in `stations.json`. The truth is the **union**, keyed on `station_no`. |
| **`LANUV_Info_1/2/3` in `stations.json` ARE the alert stages** (Menden_1: 250/410/440, identical to `alarmlevel.json`) | The 310 per-station `alarmlevel.json` calls are redundant and are not made. |
| **`catchment_name` can be `"---"`** — three stations: Betzdorf and Heimborn (upper Sieg, RLP) and WSV_Andernach (`27100400`) | Selection must be a **union** of basin name and GKZ prefix, or Betzdorf, the uppermost Sieg gauge, is lost. |
| **The source delivers daily mean and daily max, no minimum** — but the 15-minute series yields it: own aggregation reproduces `mean` to **0.003 cm** and `max` **exactly** | `min` is **computed**, not invented, from pipeline day 1 for every day; seeded history carries `min: null`. The same computation proves the MEZ day boundary. |
| **A fourth bulk product**: `temperaturdaten.zip` (1.46 MB, 108 water-temperature stations) | Rolls the same way, same license, mirrored too. Its `temp_stationen.txt` has **64 columns** vs 16/13 — the best metadata row of the source. |

**Stock:** 617 stations — 310 `Oberflächengewässer`, 308 `Klimastation` in
`object_type`. **Not a partition:** exactly one station carries both, so
310 + 308 = 618. Any check asserting "sum == registry" is born red.
`site_no` ∈ {100 LANUK (577), 102 Bund (21), 104 Gebietskörperschaften (17),
105 Land (2)}. **Trap:** a `station_no` can look like a `site_no` — Bad-Honnef
has `station_no === "104"`. A composite key needs a separator.

**Windows (measured on the 2026-09-04 seed):** daily products 2024-09-04 →
2026-09-02 (729 days, 254 bulk gauges); 15-minute gauges, hourly rain and
hourly temperature 2026-07-03 15:15 → 2026-09-03 15:00 (+01:00, **63 days**).
Rain days start at `T07:00:00+01:00`, gauge days at `T00:00:00+01:00` — two
day boundaries in one source, hence separate trees and `dayBoundary` in both
`meta.json`.

**Parser traps, all measured** (canonical list in the collector's header):
CRLF; 3-column header over 4-field rows (the 4th is `Aggregation Accuracy %`,
undeclared); 2-field block terminators; empty value OR `acc === 0` is a
non-measurement, not 0 cm; negative stages are real (−97.55 … 679.50 cm);
`.` decimals in data, `,` in metadata (`"2825,00 km²"`); ZIPs carry neither
`etag` nor `last-modified` but `max-age=2592000` — cache-busting is mandatory.

## Topology — the assignment rule (stage 1 implements it, stage 3 must not overturn it)

- `catchment_no` is **not** in `stations.json`; it is column 5 of
  `pegel_stationen.txt` and `nieder_stationen.txt` — present only for the 254
  bulk gauges and 313 bulk rain gauges. Tier-2 gauges have none.
- The GKZ prefix rule is a good heuristic, **not authoritative**: 7 of 254 bulk
  gauges have a `station_no` that does not start with their `catchment_no`
  (Veert `2850000000200`→`286`, Baltes, Süsterseel, Pannenmühle, and
  `Soestbach` with the placeholder id `1234512345`→`278`). It is a **repair**
  for stations without `catchment_no`, never a replacement for the field.
- **14 basins, not 17.** Distinct `catchment_no`: `2, 3, 4, 44, 258, 272, 274,
  276, 278, 282, 286, 428, 928, 2736`. The 17 (18 with `"---"`) are distinct
  `catchment_name`s; several names share one number (Siegeinzugsgebiet
  Östlich and Westlich are both `272`).

Rule: `catchment_no` from the bulk table where present; else map
`catchment_name` to the number other stations of that name carry; else — for
the three `"---"` stations — the longest matching GKZ prefix among the 14
known numbers. Every assignment carries `basinSrc ∈ {bulk, name, gkz}` in
`registry.json`, so a guess never looks like a reading. Flow order per gauge
from `CATCHMENT_SIZE` (km²) and `DIST_TO_CONFL` (km to the mouth): Weidenau
134 km² → Niederschelden 431 → Eitorf 1468 → Siegburg 1885 → Menden 2825.
**Careful:** `temp_stationen.txt` also carries `station_dist_to_conf`
(`780.2`) — that is **not** `DIST_TO_CONFL` (`207,66 km`).

Display filter for the two rivers: `catchment_name ∈ {Erft-,
Siegeinzugsgebiet Östlich/Westlich}` **OR** `station_no` starts with
`272`/`274` — 41 gauges (14 Erft, 27 Sieg); the OR is what keeps Betzdorf.

## Areal rain (`scripts/build-nrw-precip.mjs`, `nrw/precip/`, gate rule N8)

A SEPARATE script from the collector, on purpose: the product is a pure function
of the committed `nrw/` tree, so `--check` can prove the committed bytes are the
ones the rule makes. CI runs it between "Collect" and the gate.

**The assignment rule, pre-registered and measured 2026-09-06.** A rain gauge
joins the nearest RECEIVING gauge of its own basin within 100 km; failing that,
the nearest gauge of any basin within 10 km; failing that it is unassigned, with
the reason and the distance. Receiving = one of the 298 topology nodes that is
not a WSV relay (`siteNo 102`, 21 of them) and has coordinates inside
`[50.0, 52.8] x [5.5, 9.8]` — 276 of them. The relays and the one Gauss-Krüger
gauge (2728510000200 Ruenderoth) stay IN the routing graph and forward rain
downstream; dropping Ruenderoth would cost Menden_1 four upstream nodes.
Result: **302 basin + 12 orphan + 5 unassigned**. Not 304/10: the two
Issel-registered gauges in the Eifel (55040051, 55048925) sit 150 km from the
nearest Issel gauge, so MAX_ASSIGN_KM sends them down the orphan path — that
clause is what the 100 km is FOR.

**93 gauges get a series, not 94.** Three assigned rain gauges are not three
reporting ones: 51020051 has a meta.json and no year shard at all, so
2828300000200 could never clear a threshold of three and the builder withdraws
the product rather than advertise 1096 null days.

**Two clocks, and they do not line up.** A rain day is [d 07:00, d+1 07:00) MEZ,
a gauge day [d 00:00, d+1 00:00). Rain day d therefore CLOSES seven hours into
gauge day d+1 — which is why the response statistic peaks at lag 1 and why a
forecast covariate may only ever see rain day t-1 at context position t.

**`n[]` is the number of stations BEHIND the printed value.** A day under the
reporting threshold (max(3, half the set)) is a non-day: mm/med/mx null AND n 0.
That buys the invariant N8 asserts and the plate draws — a column no gauge stood
behind is a mark of its own kind, not a short bar.

**The right edge is `coverage.precip.lastRainDay`**, not `window.rain.to`: the
export runs mid-afternoon and a rain day starts at 07:00, so the source's newest
day is always half a day short and reads back as no data. Both the ?rain grid
and every station plate hang on that one value — one picture, one estimator.

**Nesting is real.** rainSet(g) is the union over the whole upstream closure, so
two gauges on one river share most of their rain. Every legend that prints a set
size says so, and the forecast experiment picks one gauge per basin to get
disjoint sets.

`--out` refuses any directory not named `precip`: `prune()` unlinks what it did
not write, and pointed at the mirror it removed gauges/, rain/ and topology.json
— days the rolling window never gives back.

## Architecture in one breath

Daily GitHub Actions (`nrw-update.yml`, 17:41 UTC, own concurrency group) →
`scripts/fetch-nrw-archive.mjs` → two GitHub-only orphan branches: **`nrw`**
(daily level, ~3.4 MB/year, mounted by `pages.yml` under `/nrw/`) and
**`nrw-hires`** (15-minute / hourly, ~75 MB/year, **never mounted**; also
holds the raw seed under `nrw-hires/raw/2026-09-04/`). Gate
`scripts/check-nrw-consistency.mjs` (N1–N7) runs before the push;
`data-freshness.yml` watches the `nrw` commit age (30 h). Never mixed into
`archive/`: rolling 2-year window instead of closed years since 2000, a
different rain day boundary, and a derived minimum would put R6 at risk for
the whole WSV fleet.

Merge policy is the **inverse** of the WSV extreme-union: inside the source
window the fresh value wins (the source declares unchecked raw data and
revises downward too), outside it the stored value is frozen; a fresh `null`
never overwrites a stored non-null (a truncated ZIP is a no-op, not a loss).

In the app the seam is at loader level: `state.info`/`state.gauge` stay the
shared language, everything above (view models, renderers, routing, finder,
map) stays source-blind. LANUK extras live in `state.lanuk`. The seeded
history has `min: null`, so the history band's lower edge is `dayLow()` =
min ?? mean, and the legend says so for the seed period.
