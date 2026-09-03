# Forecast gate (`scripts/forecast/`, Python via uv)

Pulled out of `CLAUDE.md` on 2026-09-03 — a self-contained subsystem with its
own script tree, needed when working on it and not before. Moved verbatim.

- **The verdict is on file, not in memory.** `gate/seasonal-mid/report.md`
  is the 2026-09-02 gate run of TimesFM 2.5 against the persistence/climatology
  blend: **NO-SHIP** (pooled skill 0.07 at h1–14, nothing at h15–30, −0.04 at
  h31–90; calibration fine). Re-running the gate consumes the test set — read
  the report and the plan (`~/.claude/plans/mache-den-plan-wie-linked-puddle.md`)
  before touching a threshold, and list every tried variant in the header.
- **`gate/` is deployed** (`pages.yml` excludes only `scripts/`, `tests/`,
  `.github/`): `gate/index.html` + `gate.js` render the committed `report.json`
  files as an interactive plate at `/pegel-visual/gate/`. `gate.py` writes there
  by default; its `per_h` / `per_h_ratio_median` keys (MAE per lead day, and the
  median of the five regimes' ratios to the blend) feed the page's one picture,
  the error-by-lead-day curve. `gate.js` is pure at import —
  `tests/gate-page.test.mjs` runs `buildModel`/`renderPage` against the real
  reports and applies the same legend gate as the app: every mark class must
  appear in its section's key.
- **The gate page re-renders the whole plate on every chip, so focus is a
  deliverable.** Three patterns, verified only in a real browser: (1) every chip
  and index link carries `data-focus`, and `draw({focus})` opens the `<details
  class="panel">` it names and focuses its `<summary>` — with a `summary:focus`
  ring, not `:focus-visible`, because script-set focus fails that heuristic;
  (2) open panel ids are read before `innerHTML` and restored after; (3) one
  `stateHref()` spells query (data) and hash (panel), chips and index links go
  through one `pushState` path. After `popstate`, Chrome processes the URL
  fragment and CLEARS the focus when its target is not focusable (a section, a
  details) — so the popstate path focuses after a double `requestAnimationFrame`,
  never inside the handler. `node scripts/gate-check.mjs` (headless Chrome over
  CDP, desktop + phone with touch emulation, needs the sandbox bypass for
  loopback) is the gate for all of this — run it before every deploy of the
  page. `(pointer: coarse)` comes from `Emulation.setTouchEmulationEnabled`;
  `setEmulatedMedia` cannot override it.
- **`timesfm` is pinned to 2.0.2 and the pin is load-bearing.** The 3.0 line's
  weights are non-commercial and GPL-incompatible; `tests/test_license.py`
  greps the whole repo for the 3.0 package, class and checkpoint names, so do
  not spell them out even in comments. Dependabot is told to ignore `>=3`.
- **`uv run python <script>` is the whole bootstrap.** `[tool.uv]` points the
  cache at `tmp-forecast/uv-cache` (the default `~/.cache/uv` is not writable in
  the sandbox) and makes `model` a default group, so the first `uv run` syncs
  torch + timesfm by itself, no bypass, no separate `uv sync`. CI opts out with
  `--no-group model`. Weights cache under `tmp-forecast/hf` — pass `--tmp` and
  `--archive` with the MAIN checkout's paths from a worktree, or the download
  lands in the worktree and dies with it.
- **The model's point forecast is the median channel (index 5), not channel 0.**
  Measured on 2.0.2; `tfm.forecast_batch` asserts it. Horizon ≤ 128 steps is one
  decode step — the 2.0.2/3.0.1 flip-quantile difference never applies.
- **`collect-hires.mjs` is the only source of 15-minute data.** Weekly via the
  LaunchAgent `de.6bm.pegel-hires` (wrapper `collect-hires.sh`, heartbeat
  `cron:pegel-hires`, on the recap roster at 192 h), into
  `tmp-forecast/hires/<uuid>/<YYYY-MM>.json` on this Mac and from there into the
  GitHub-only, protected `hires` data branch (clone under
  `tmp-forecast/hires-branch/`, fast-forward only, never `origin`) — the
  short-horizon gate stays PROVISIONAL until ~16 weeks have accumulated. Month
  shards, not one file per gauge, so the weekly mirror commit stays small. The
  server clamps `P35D` to ~31 days; merges are idempotent by timestamp.
