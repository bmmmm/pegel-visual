# nrw-hires — LANUK NRW fine-resolution series (never deployed)

Data branch, GitHub-only like `archive` and `hires`; only ever fast-forwarded,
protected against force-push and deletion. **Never mounted by `pages.yml`** —
this branch is kept, not served. Its sibling `nrw` carries the daily level and
is what the site mounts under `/nrw/`.

Source: `https://hochwasserportal.nrw/data` (KISTERS WISKI-WEB of the LANUK
NRW), bulk downloads under the OpenData license dl-de/zero-2.0. The source is a
daily export with a rolling window — 730 days for the daily products, only
**63 days** for the 15-minute gauge series, hourly rain and hourly water
temperature. What is not mirrored while it is in the window is gone.

Layout:

- `nrw-hires/raw/<YYYY-MM-DD>/` — the one-time raw seed (stage 0 of the LANUK
  plan): `stations.json` plus the three bulk ZIPs exactly as downloaded, with
  `SHA256SUMS`. Frozen; the first day whose fine-resolution window this branch
  holds is the seed day minus 63.
- `nrw-hires/gauges/<station_no>/<YYYY-MM>.json` — `{ id, month, step: 900, start, v: [...] }`
- `nrw-hires/rain/<station_no>/<YYYY-MM>.json` — `{ id, month, step: 3600, start, v: [...] }`
- `nrw-hires/temp/<station_no>/<YYYY-MM>.json` — same shape as rain

Month shards, so the daily mirror commit stays small. Nothing is thinned or
deleted by the workflow; the pruning lever (`--max-months N --allow-prune`)
exists in `scripts/fetch-nrw-archive.mjs` and is never passed by CI.
