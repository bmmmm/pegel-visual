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

## The rain field around a gauge (`scripts/build-nrw-precip.mjs`, `nrw/precip/`, gate rule N8)

**It is not areal precipitation over a catchment, and it never was.** No
watershed is consulted anywhere in this pipeline — the source publishes none.
The product is the rain FIELD around the gauge, and every string on the plate
says so since 2026-09-08. Anyone who reintroduces the word "areal" for the
per-gauge product is making a claim the data cannot back. (The `?rain` overview
is a different product and IS a basin areal mean — that wording stays.)

A SEPARATE script from the collector, on purpose: the product is a pure function
of the committed `nrw/` tree, so `--check` can prove the committed bytes are the
ones the rule makes. CI runs it between "Collect" and the gate.

**The hydrological assignment, pre-registered and measured 2026-09-06.** A rain
gauge is OWNED by the nearest RECEIVING gauge of its own basin within 100 km;
failing that, the nearest gauge of any basin within 10 km; failing that it is
unassigned, with the reason and the distance. Receiving = one of the 298
topology nodes that is not a WSV relay (`siteNo 102`, 21 of them) and has
coordinates inside `[50.0, 52.8] x [5.5, 9.8]` — 276 of them. The relays and the
one Gauss-Krüger gauge (2728510000200 Ruenderoth) stay IN the routing graph and
forward rain downstream; dropping Ruenderoth would cost Menden_1 four upstream
nodes. Result: **302 basin + 12 orphan + 5 unassigned**. Not 304/10: the two
Issel-registered gauges in the Eifel (55040051, 55048925) sit 150 km from the
nearest Issel gauge, so MAX_ASSIGN_KM sends them down the orphan path — that
clause is what the 100 km is FOR. Ownership is still a PARTITION, and N8c3
still asserts it.

**Membership, rule version 2 (2026-09-08), is many-to-many on top of that.**
A gauge's set is the union over its upstream closure (`via: basin|orphan`) PLUS
every rain gauge within **15 km of the gauge itself** (`via: local`), and where
that yields fewer than three, the **3 nearest** instead (`via: knn`, capped at
45 km). Every member carries its own `via` and `km`, because a fallback must
never look like a measurement. Result: **93 → 275 of 276** receiving gauges
carry a series; memberships 949 basin / 45 orphan / 1406 local / 42 knn; the
floor fires on 28 gauges and reaches at most 29.05 km.

**What was measured before a line of it was written** (all on the real mirror,
`scripts/probe-precip-rule.mjs`, whose `identity` variant reproduces the old
rule at delta exactly 0 on all 92 comparable gauges — that self-test is the
first thing to run and the only one that can invalidate every other number.
It compares against `referenceRun`, the one function in the bench that does NOT
go through `precipMembers`; the first cut compared the identity variant against
ITSELF and would have printed "delta 0" whatever the machinery did):

| variant | median Δ peak-r | better/worse | z | gauges with a product | set med/p90 | members outside the equivalent radius | identical neighbour sets (all pairs) |
|---|---|---|---|---|---|---|---|
| identity (v1) | — | — | — | 93 | 5 / 20 | 69.6 % | 11 of 63, J 0.667 |
| knn3 alone | 0.0000 | 0/0 | — | 270 | 3 / 9 | 71.0 % | 24 of 177, J 0.500 |
| km10 | 0.0000 | 43/22 | 2.60 | 200 | 5 / 15 | 66.1 % | 8 of 136, J 0.500 |
| **km15 + knn3** | **+0.0043** | **61/26** | **3.75** | **275** | **8 / 15** | **74.5 %** | **8 of 181, J 0.500** |
| km25 | +0.0075 | 59/33 | 2.71 | 272 | 18 / 28 | 84.7 % | 4 of 178, J 0.635 |

**Why 15 km and not the better-scoring 25.** The decisive column is the second
from the right: at 25 km, **84.7 %** of members sit outside a circle of the
gauge's own catchment area, against 74.5 % at 15 km and 69.6 % under the old
rule. A number that far outside the thing it is named after has to be renamed
before it is widened, and 25 km widens it by another ten points for +0.003 of r.

**The nesting evidence is mixed, and the mixed version is the true one.** The
last column above is UNPAIRED — identity has 63 pairs and km15+knn3 has 181,
and 118 of those are gauges that had no plate at all before, so a falling median
there proves nothing about the old pairs. Measured PAIRED, over the same 63:

| variant | median J on the same 63 pairs | pairs better/worse | identical sets |
|---|---|---|---|
| km15 + knn3 | 0.667 → **0.591** | 29 / 30 | 11 → **3** |
| km25 | 0.667 → 0.667 | 26 / 36 | 11 → **1** |

So: pair by pair, widening the sets is a coin flip (29 better, 30 worse), and
what robustly improves is the count of neighbours whose sets are *literally the
same list* — 11 → 3. km25 drives that lower still (11 → 1) while its median J
does not move at all, because its sets are large enough to differ in composition
while overlapping almost completely. **The honest summary is that nesting does
not decide between 15 and 25 km; the equivalent-radius number does.** Anyone
arriving later with "more is better" is reading the Δr column and ignoring it.

**Two numbers not to misquote.** The +0.0043 holds only for the **92 gauges that
already had a number**; for the 182 that gained one there is no comparison and
can be none — the alternative there is not a worse number but no number. And
the knn floor **cannot** move an existing number: it only ever runs on sets that
had none, which is why km15 and km15+knn3 share a Δr to four decimals.

**"Every rain station lands in at least one set" is FALSE and cannot be made
true.** Measured: 5 stations stay out under the new rule, exactly as under the
old one — 42188260, 43170736 and 44206586 sit at 0/0, 42182880 carries
Gauss-Krüger coordinates, and 44075066 (Bottrop-Eigen, Emscher) is 15.5 km from
the nearest gauge of any basin, just past the ring. The idea was proposed as a
mechanism and survives as an **invariant**: N8 watches `stationsInNoSet` and the
list may not grow. A wish asserted as a rule would have been born red.

**275 gauges get a series, not 276.** 3215510000100 Linnenkamp has three rain
gauges in reach of which one (43120089) reports nothing at all, so three in
reach can never make three REPORTING and the builder withdraws the product
rather than advertise 1096 null days. (Under rule version 1 the same clause
cost 2828300000200 its product, via 51020051.)

**A rule change may not ride in on its own drift allowance.** `index.json.rule`
carries a `ruleVersion`; when it differs from HEAD's, N8 stops comparing against
HEAD — every counter is supposed to move on that run — and demands the version's
**pre-registered** numbers from `RULE_BASELINES` instead. A bump with no entry
is red; a bump whose numbers disagree with the entry is red. `MIN_PRECIP_SERIES`
was re-based 80 → 260 in the same commit, because 80 against 275 could not go
red on anything short of the mirror vanishing.

**If that gate goes red on the first collector run after a rule change, read it
before editing it.** The baseline applies on exactly one run — the first with
the new version — with a slack of 2, and the source moves between the commit and
that run. A legitimate drift of three stations reads exactly like a wrong rule.
The fix is to re-measure and re-register, never to widen the slack: the whole
clause exists because a rule change must not be able to move counters quietly.
Note also that the baseline is only consulted when there IS a HEAD to differ
from — a fresh branch or a fork has no rule change to check, and the floors in
`checkPrecipShape` are what stand there instead.

**`risePer10mm` was sign-biased, measured 2026-09-09 (audit A3); since
2026-09-10 it is read at ONE pre-registered lag.** The event rise the RESPONSE
block printed until then was the largest daily rise
over lags 0..3 after each ≥ 10 mm day, then the median over events. A maximum
of four zero-mean draws is positive most of the time: on 200 seeded trials of
white rain against a random-walk level that never reads the rain, the shipped
estimator printed a positive number **200 times of 200** (median +0.45).
The bench is `scripts/probe-response-null.mjs` (not in CI, imports
`responseStats`, never restates it; criterion pre-registered at ≤ 55 %
positive). The obvious repair — read the rise at the gauge's own `peakLag`
only — measures **76 %**, because `peakLag` is itself the maximum of eight
correlations; a lag fixed at 1 d for every gauge measures 43 %, and printing
only above the 95th percentile of 100 rain permutations prints 3 of 200. The
`index.html` comment calling the number "not sign-constrained" is false as
long as the estimator was that one. **Decision 2026-09-10 (the human's, with
this table): the fixed lag ships** — `EVENT_LAG_DAYS = 1` in
`build-nrw-precip.mjs`, the same day for every gauge, never chosen from the
data (the same shape as the hourly product's "a class, never an hour").
`response.json` names it as `events.lagDays`; a file without that field was
written by the old maximum and the plate keeps its old sentence for it.
`RULE_VERSION` did NOT move: it versions the MEMBERSHIP with N8's
baselines, and the sets are untouched. The bench PASSes at 43 % and keeps
`max` and `peak` as the reference the decision was measured against.

## The hourly response class (`scripts/build-nrw-hourly-lag.mjs`, `nrw/hourly/lag.json`, gate rule N9)

**Shipped 2026-09-08.** The one piece of hydrology the daily product cannot see:
how long after rain over its rain field a gauge itself moves. On a DAY axis the
travel time is invisible — 0 of 42 gauges show the far part of their set
responding later than the near part. On an hourly axis it is there.

**The product is a CLASS, never an hour, and that is the churn criterion
talking.** Replayed over 14 daily steps at a fixed window length, the number of
published values that move per day:

| what the file would carry | churn/day | ceiling ~10 |
|---|---|---|
| the raw peak lag in hours | **14.6** | ✗ |
| the same within ±3 h | **10.1** | ✗ |
| **three class labels** | **8.5** (median 5, max 29) | ✓ |

Three classes — `[0,1]`, `[2,8]`, `[9,null]` hours — because six churn at 9.1
with 67.9 % class stability (on the 2/3 floor) and two say almost nothing at
82.1 %. The hour is withheld for a second reason as well: the two halves of the
window disagree by 8 h at the p90, so an hour is false precision.

**Everything else stays out of the file for the same reason.** Measured: `r` at
two decimals churns **75.6** lines a day, at one decimal **21.6**, the raw hour
**14.6**. So `gauges` maps an id onto a class and onto nothing at all besides.
The diagnostics (`r`, `h`, `n`, `wet`, `p`) go to stdout under `--report`, into
the CI log, which is kept 90 days; the branch is kept forever. And the file is
the one product here written **unminified** — its diffability IS the acceptance
criterion, and 4 kB on one line has no diff granularity. Measured over one day
of rolling: **2 gauge lines move**, 20 lines of diff in all, the other 18 being
the run's own header.

**The winner's curse is corrected, and the first correction was wrong.** The
estimator takes a maximum over 49 lags. A permutation test with **12** rotations
cannot carry that: the smallest attainable p is 1/13 = 0.077, so over ~222 gauges
~17 false positives are expected under the global null — a *weaker* filter than
the r cut beside it. Done properly — **99 deterministic, evenly spread rotations
plus Benjamini–Hochberg at q = 0.05 over m = every gauge TESTED** (224 on the
2026-09-09 mirror) — 162 of the 168 gauges over r 0.25 survive. Two traps, both hit: a rotation by the window LENGTH is the
identity (it reported 1.8 % significant instead of 87.8 %), so the shifts need a
guard band, which is set at 168 h — a week, because weather autocorrelates on
the synoptic scale and a 50 h rotation still lines the same front up with the
same flood. And the set must be **deterministic**: a `Math.random()` there kills
the `--check` purity claim silently and looks green for weeks.

**Correction to the plan that specified this: the permutation filter does NOT
lower the churn.** Re-measured 2026-09-09 with the guard band applied, both ways
over the same 14 steps: **8.2/day with the filter, 8.2/day without** — 115
rewrites either way, differently distributed, not fewer. The plan predicted 7.1
against 8.1. The filter is justified by the multiple-comparison correction
alone, and it costs ~26 s a day.

**Who gets a class.** Of 275 gauges with a daily rain field: **162 published**
(101 / 49 / 12 across the three classes), 24 not in `nrw-hires` at all, 27 with
too few wet hours, 56 with a peak r under 0.25, 6 not clear of chance.
**62 % land in class 0** — real per the control, but a three-class product where
two thirds of readers see one class is close to a one-class product, which is
what the wording has to carry rather than the decision to ship.

**The gates, all pre-registered, all measured under rule version 2:**

| gate | criterion | result |
|---|---|---|
| stability, halves within ±3 h | ≥ 2/3 | **76.3 %** (29 of 38) — PASS |
| class agreement across the halves | — | **75.0 %** (21 of 28) |
| churn of the published value | ≤ ~10/day | **8.2/day** — PASS |
| negative control (level rotated) | — | median r **0.401 → 0.056–0.057**, lag-0 share 40.2 % → 1.3–3.6 % — PASS |

Every number in that table was re-measured on 2026-09-09 against the **shipped**
window (1512 h) and with the rotation guard band actually applied — the figures
that stood here before came off a 1597 h window and a `rotationShifts()` that
took a `guard` argument and ignored it, so its null contained near-identity
rotations. Do not compare a future run against anything older than this note.

Stability is measured on the **17 %** of gauges estimable in both halves (38 of
the 224 with a peak) — a gauge estimable in both is a well-covered gauge, so
76.3 % describes the best sixth of the fleet, and the bounded window made that
denominator smaller, not larger. That sentence belongs beside the number
wherever it is quoted, and it rides in the file's own `note` onto the plate.

**The 15 km footprint carries hourly too — re-measured here, not carried over.**
The hypothesis was that convective cells are far smaller at an hourly
resolution, so a tighter ring should transmit better; that predicts monotone
improvement as the ring shrinks, and it does not happen:

The six rows below come from ONE run on the 1597 h window and the pre-guard
rotation set, and they are left exactly as measured: a ring comparison is only
worth anything if every row saw the same conditions, so replacing the shipped
row with today's figures would make the table unreadable rather than truer. Read
them against each other, never as the shipped counts — those are the table
above. The guard band applies to every row alike, so the ordering is unaffected;
what is not re-measured is the absolute level of each cell.

| ring | attempted | with peak | published | median r | class stability |
|---|---|---|---|---|---|
| hydrology only | 85 | 76 | 48 | 0.350 | 75.0 % (12/16) |
| 5 km | 229 | 182 | 126 | 0.376 | 73.5 % (25/34) |
| 10 km | 246 | 203 | 144 | 0.378 | 73.3 % (33/45) |
| **15 km (shipped)** | 251 | 222 | **162** | **0.391** | **75.0 % (42/56)** |
| 25 km | 252 | 247 | 186 | 0.381 | 73.2 % (52/71) |
| 40 km | 252 | 252 | 178 | 0.350 | 72.8 % (59/81) |

5 and 10 km publish 36 and 18 gauges FEWER at no better stability, and 15 km has
the best median r and the best class stability of all six. **Hypothesis not
supported.** 25 km publishes 24 more and is still not on the table, for a reason
that had to stand before the test and not after it: **membership must be the
shipped `RULE`**, because the PRECIPITATION block directly above this one on the
plate draws exactly that 15 km field. Two definitions of "this gauge's rain" in
two neighbouring blocks of one plate is what `T.precipNotCatchment` and
`T.precipNested` exist to prevent.

**Three reasons it is its own script and its own file**, not a key inside
`nrw/precip/<no>/response.json`, each fatal on its own: `Out.prune()` unlinks
every file under `nrw/precip/` it did not write, so N8(e) would go red; N8(e)
proves the precip bytes are a pure function of the committed `nrw` tree, and a
second input tree makes that claim false; and `pages.yml` mounts `nrw` and never
`nrw-hires`, so the product must land inside `nrw/`. The estimator lives in the
BUILDER and `scripts/probe-hourly-lag.mjs` imports it — the direction
`probe-precip-rule.mjs` already runs in, and the other way round the probe would
be de facto deployed while its own header said "NOT in CI, NOT deployed".

**`inputs.sha256` is a digest, not a commit SHA**, and that is not a nicety: the
gate runs BEFORE both pushes, `nrw` can land while the `nrw-hires` push fails,
and at build time no hires SHA exists at all. It hashes `rel \0 byteLength \0
bytes` over `nrw-hires/{rain,gauges}/**/*.json` sorted by path — `temp/` and
`raw/` are not inputs and must not churn it.

**N9's floors are calibrated on the regime the gate ALLOWS, and the obvious
numbers were wrong in three of five cases.** Measured over 21 distinct windows
(six lengths from 40 to 66.5 days ending at the newest hour, plus a 15-step
daily replay): `published` runs **119 to 201**, and it does NOT fall as the
window shortens — the short windows sit on the recent wetter fortnight and
publish MORE (201 at 40 days against 162 at 66.5). So the floor cannot be
derived from the window length: **100**, under everything measured. The plan's
120 goes red on the 119 window. Class drift: the 14 replay steps run 1, 6, 8,
29, 16, 2, 20, 2, 1, 4, 18, 4, 2, 6 — mean 8.5, **maximum 29** — so the
single-run ceiling is **50**, not the plan's 40 (which was 1.7× a maximum of 23;
50 is 1.7× the 29 actually measured). The largest one-step FALL in published
gauges is **5**, so that cap stays at 20. And `LAG_RULE_BASELINE_SLACK` is
**30**, not the daily product's 2: `published` is a statistic over a rolling
window, not a membership count, and one day of roll moved it by as much as 26.

**Pre-registered now, in the file itself:** re-run `--split` across the season
in **2027-02**; below 2/3 class agreement the product is withdrawn. The window
is 63 days of high summer, and in February the estimator sees frontal rain, snow
(no response at any lag) and melt (a response with no rain).

### Two ideas measured and killed, and one kill withdrawn

Each had a pre-registered kill criterion, and each is recorded here so it is not
re-proposed as a fresh insight. **Do not reopen without new facts.**

- **Area weighting (Thiessen by real sub-catchment area) — killed 2026-09-07.**
  Measured against `catchmentKm2`: median Δ peak-r **0.0000**, mean −0.0026,
  20 better / 28 worse, and weighted-vs-unweighted correlate at 0.994. So
  "Thiessen with EQUAL areas" is a **measured choice**, not a shrug.
- **Travel time per rain station — killed twice.** Daily: **0 of 42** gauges
  show the far part of their set responding later than the near part. Hourly:
  6 later / 15 equal / 10 earlier *within* one set. Kirpich/Giandotti are dead
  on their own — `gaugeDatum` exists on **24 of 310** gauges and there is no
  DEM; and `distToConflKm` is not a network coordinate (**43 of 51** sets hold
  an "upstream" station with a SMALLER value, Greven by −109 km).
- **Hourly response lag per gauge — killed on a bad measurement, the kill
  withdrawn, then BUILT AND SHIPPED (2026-09-08).** The product has its own
  section above; what belongs here is why the kill was wrong, because the same
  mistake is available to anyone re-running the bench.
  The stability gate read **64.3 %** against a floor of 2/3 and the stage was
  declared dead. That number came from a run of `scripts/probe-hourly-lag.mjs`
  made *before* `RULE` was flipped to version 2 — the probe takes its membership
  from that constant, and its output did not name it. So it measured the OLD
  thin sets: 85 gauges attempted, and the gate came down to **28** gauges of
  which 18 agreed. Re-run against the shipped rule, on the same data, as a
  control: the old rule still gives exactly 28 / 18 / 64.3 %, and the shipped
  rule gives **81 gauges, 58 agreeing, 71.6 % — PASS.** The difference was the
  rule, not the day. **The probe now prints the rule it used**, on every run,
  above every number — that line is the whole fix.
  *Every figure in this bullet is the 2026-09-08 run on the 1597 h window and is
  kept as the record of that day; the shipped numbers are the gate table above,
  and they are not the same.*
  The churn gate failed too, at **10.4/day**, and it was right to: it was
  measuring the raw hour. The ceiling was NOT re-registered after seeing the
  number it failed — the product was changed to come under it, by publishing a
  three-class label instead of an hour (8.5/day). The observation that the
  ceiling is an absolute file count calibrated against a 76-gauge product and
  applied to 206 stands as an observation about the criterion's units; as a rate
  it had not moved (4.9 % then, 5.0 % then-now), and it was not used as an
  argument.
  Two facts any later reader needs: **40 % of gauges peak at lag 0** — real per
  the control, but a number carrying little information — and **24 % have peak
  r < 0.25**, which is why the r cut exists. Only 1 of 222 peaks at the 48 h
  search edge, so truncation is not a problem.

### Two gates run for later stages, and what they said

- **GSK3C catchment polygons — stopped at the LICENCE gate, 2026-09-08.**
  Reachable and cheap: `gsk3c_EPSG25832_Shape.zip`, **68.0 MB**, stable
  `Content-Length`, `Last-Modified` frozen at 2016-04-21, and `Accept-Ranges:
  bytes` — so its central directory can be read for a few kB instead of 68 MB
  (32 entries, four shapefiles: `ezg`, `gew_flaeche`, `gew_kanal_plm`,
  `stationierung`). But the package contains **no licence file of any kind**,
  and the only licence-shaped fields in its in-ZIP ESRI metadata are unfilled
  template placeholders ("REQUIRED: Restrictions and legal prerequisites…");
  the dataset's own portal index entry carries none either. The repo's rule is
  that the licence is read out of the package, not off a product page — that
  confusion has cost this repo twice, at HydroBASINS and TimesFM 3.0 — so the
  stage stops here. Its remaining gates (area reconstruction against the 257
  known `catchmentKm2`, then effect on the bench) were never run, and per the
  measurements above its expected effect on accuracy is near zero anyway: its
  value would be honesty, not precision.
- **"Gebietsniederschläge NRW" — opened 2026-09-08, and it is NOT the live
  product it sounds like.** The same portal publishes
  `umwelt_klima/wasser/oberflaechengewaesser/gebietsniederschlaege`, which for a
  moment looked like the real version of the number this repo approximates. Its
  own readme (a 122 kB `_meta.zip` next to the data, so this cost nothing to
  settle) says otherwise: it covers **1980–2011**, it was published in 2017, and
  it holds **annual and monthly sums plus 32-year means — no daily values and no
  feed of any kind.** It is a climatology, not a source. The 15 km ring is not a
  workaround for it.
  What it DOES settle is what "done properly" would mean here, in the operator's
  own words: **Kriging over all operators' station data, then area-weighted onto
  the GSK3C catchments**, joined by `GEBKZ`. That needs exactly the polygons the
  licence gate above blocks, plus an interpolation this repo does not have — so
  the two findings close each other. Its package carries no licence statement
  either, the same gap as GSK3C.
- **A rain arm in the forecast gate — the correlation pre-test SURVIVES, just.**
  Rule v2's covariate against rule v1's, over the 93 gauges comparable under
  both: median r **0.9787** against a kill threshold of 0.98, min 0.7796, and
  49 of 93 below 0.98. So the two are *not* the same input — but a gate run
  consumes the test set, `loaders.precip_sha256` VOIDs comparisons across
  different precip bytes (the existing `plain` arm stops being a comparison, so
  **three** arms would have to re-run), and the covariate filter shifts the
  origin grid on every arm. That is a spend, not a step, and it waits for a
  decision.

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

**Nesting is real, and rule version 2 did not make it worse.** rainSet(g) is the
union over the whole upstream closure plus the 15 km ring, so two gauges on one
river share most of their rain — and now neighbours can share the stations
between them as well. The fear was that widening the sets would make neighbours
interchangeable. Measured on the same 63 pairs: the median Jaccard falls 0.667 →
0.591, pair by pair it is 29 better / 30 worse, and the count of neighbours
whose sets are *literally the same list* falls 11 → 3. So "not worse, and fewer
duplicate plates" — not "better". Every legend that prints a set size says so,
and the forecast experiment picks one gauge per basin to get disjoint sets.

`--out` refuses any directory not named `precip`: `prune()` unlinks what it did
not write, and pointed at the mirror it removed gauges/, rain/ and topology.json
— days the rolling window never gives back.

## Architecture in one breath

Daily GitHub Actions (`nrw-update.yml`, 17:41 UTC, own concurrency group) →
`scripts/fetch-nrw-archive.mjs` → two GitHub-only orphan branches: **`nrw`**
(daily level, ~3.4 MB/year, mounted by `pages.yml` under `/nrw/`) and
**`nrw-hires`** (15-minute / hourly, ~75 MB/year, **never mounted**; also
holds the raw seed under `nrw-hires/raw/2026-09-04/`). Then two derived
products, in this order and only this order: `build-nrw-precip.mjs` (the rain
field, from `nrw` alone) and `build-nrw-hourly-lag.mjs` (the response class,
from BOTH branches, taking its membership and its universe from the first).
Gate `scripts/check-nrw-consistency.mjs` (N1–N9, `--hires` or N9 runs partial)
runs before the push;
`data-freshness.yml` watches the `nrw` commit age (30 h). Never mixed into
`archive/`: rolling 2-year window instead of closed years since 2000, a
different rain day boundary, and a derived minimum would put R6 at risk for
the whole WSV fleet.

**A local `github/nrw` ref is a date, not a fact — and nothing on disk
contradicts it.** These branches have no working tree, so a stale
remote-tracking ref reads exactly like a current one: `git show
github/nrw:nrw/manifest.json` answers confidently out of whenever you last
fetched. On 2026-09-08 that made an agent report `nrw/precip/` as "not
materialized on the branch" while the deployed site was serving all 276 entries
of it. Before treating either data branch as evidence: `git fetch github nrw
nrw-hires`, or — faster and authoritative for the question that usually
matters, *what do readers actually get* — `curl` the Pages URL
(`https://bmmmm.github.io/pegel-visual/nrw/manifest.json`, `nrw/precip/index.json`,
`nrw/gauges/<id>/meta.json`). For `nrw-hires`, which Pages never mounts,
`gh api "repos/bmmmm/pegel-visual/git/trees/nrw-hires?recursive=1"` lists the
tree without fetching it — quote the URL, zsh globs the `?`.

Merge policy is the **inverse** of the WSV extreme-union: inside the source
window the fresh value wins (the source declares unchecked raw data and
revises downward too), outside it the stored value is frozen; a fresh `null`
never overwrites a stored non-null (a truncated ZIP is a no-op, not a loss).

In the app the seam is at loader level: `state.info`/`state.gauge` stay the
shared language, everything above (view models, renderers, routing, finder,
map) stays source-blind. LANUK extras live in `state.lanuk`. The seeded
history has `min: null`, so the history band's lower edge is `dayLow()` =
min ?? mean, and the legend says so for the seed period.
