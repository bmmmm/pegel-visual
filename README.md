# hires — 15-minute gauge readings for the short-horizon forecast gate

Data branch, written weekly by `scripts/forecast/collect-hires.sh` on one
machine, mirrored here so the collection survives that machine. GitHub-only,
like `archive`; only ever fast-forwarded.

Layout: `hires/<uuid>/<YYYY-MM>.json` — one UTC month of `[isoUtc, value]`
pairs in the gauge's own unit (cm for the collected set), plus
`hires/<uuid>/runs.json` with the run log. Source: PEGELONLINE REST
`?start=P35D` (clamped to ~31 days by the server), merged idempotently by
timestamp; sentinels outside the plausibility bounds are dropped on arrival.
Nothing is thinned or deleted. CUXHAVEN publishes at 1-minute resolution.
