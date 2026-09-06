# nrw — LANUK NRW gauges, rain and water temperature (daily level)

Data branch, written daily by `.github/workflows/nrw-update.yml` with
`scripts/fetch-nrw-archive.mjs`, mounted by `pages.yml` under `/nrw/`.
GitHub-only like `archive`; only ever fast-forwarded. Its sibling
`nrw-hires` holds the raw seed and the 15-minute / hourly series and is
never deployed.

Source: https://hochwasserportal.nrw/data (KISTERS WISKI-WEB, LANUK NRW),
bulk downloads under dl-de/zero-2.0. The source is a daily export with a
rolling 730-day window; `manifest.sourceExportAt` is the export's own
stamp, so nothing here is more current than ~24 h. The full schema, the
merge policy and every parser trap live in the script header.

Layout: `manifest.json`, `registry.json`, `topology.json`, `runs.json`,
then `gauges/<station_no>/{meta.json,<YYYY>.json}` (min/mean/max/n per MEZ
day; `min` and `n` derived from the fine series, null before its window),
`rain/<station_no>/…` (mm per day starting 07:00 MEZ, imax = max hourly
mm/h, coverage %) and `temp/<station_no>/…` (°C). Nothing is thinned or
deleted by the workflow; the pruning levers exist and are never passed.

`precip/` is the one DERIVED tree here, written by
`scripts/build-nrw-precip.mjs` in the same run, right after this collector
and before the gate. It holds the areal daily rainfall over each gauge's
upstream catchment (`precip/<station_no>/{meta.json,<YYYY>.json,response.json}`),
the same per basin (`precip/basins/<no>/…`), and `precip/{index.json,overview.json}`.
It is a pure function of the rest of this branch: `--check` recomputes it and
exits 1 with a list of what differs, and gate rule N8 runs exactly that before
every push. Unlike the mirrored trees it may SHRINK — a gauge that drops below
three upstream rain gauges loses its files, because a derived product must not
keep history its inputs no longer imply.

Two clocks: a rain day is [d 07:00, d+1 07:00) MEZ, a gauge day
[d 00:00, d+1 00:00). Rain day d closes seven hours into gauge day d+1, so
`coverage.precip.lastRainDay` — the newest rain day with a reading — is what
every drawing hangs its right edge on, not `window.rain.to` and not the clock.
