# Forecast gate (`scripts/forecast/`, Python via uv)

Pulled out of `CLAUDE.md` on 2026-09-03 — a self-contained subsystem with its
own script tree, needed when working on it and not before. Moved verbatim.

- **The verdict is on file, not in memory.** `gate/seasonal-mid/report.md`
  is the 2026-09-02 gate run of TimesFM 2.5 against the persistence/climatology
  blend: **NO-SHIP** (pooled skill 0.07 at h1–14, nothing at h15–30, −0.04 at
  h31–90; calibration fine). Re-running the gate consumes the test set — read
  the report and the plan (`~/.claude/plans/mache-den-plan-wie-linked-puddle.md`)
  before touching a threshold, and list every tried variant in the header.
- **TimesFM 3.0 was measured on 2026-09-03 and does not clear the bar either.**
  `report-3p0.md` beside each shipped report: NO-SHIP, the same 2 of 7 clauses,
  pooled skill +0.076 / +0.013 / −0.015 (mid) against 2.5's +0.072 / +0.014 /
  −0.036. It is consistently a little better — most at h31–90, and on CRPS
  everywhere — and nowhere near A1's 0.10. Both reports now say in their own
  caveats that TWO candidates have been measured on the SAME test origins;
  a third look needs that count raised, not quietly reused. Re-derived from the
  raw `results/*.npz` on 2026-09-04 without importing `gate.py` or `metrics.py`:
  A1, A2, A4 (all 30 regime z included), A5, A6 and A7 match to 1e-9, and the
  15 shared arrays are bit-identical between the 2.5 and 3.0 runs, so the
  comparison is on the same windows. Only A3 is reproduced rather than
  recomputed — its bootstrap rides on the RNG, and a re-run of `gate.py` returns
  the committed report byte for byte (bar the `candidates` key a temp directory
  cannot know).
- **The 15-minute grid is its own test set, and 3.0 is on it since 2026-09-04.**
  `short-mid/report-3p0.md`: PROVISIONAL like 2.5 (10 of 60 origins), ahead in
  13 of the 21 cells — +0.44 at DRESDEN h1-6h, −0.34 at KOBLENZ h24-48h. Before
  measuring the challenger there, 2.5 was re-run: `collect-hires.mjs` had added
  two steps since 2026-09-02, but the origin grid did not move and all eleven
  arrays came back bit-identical, so the published 2.5 numbers still stand. A
  challenger run on a grid that HAS moved would need the incumbent re-run and
  re-published alongside it — compare only what shares its windows.
- **A model label made of a generic word and a number can be spelled out of
  prose.** The short panel's readout said `TimesFM 2.5 cm vs …` — the word plus
  KOBLENZ's 2.5 cm MAE — and the "a sheet read for one model must not contain
  the other's name" test went red the day 3.0 landed on that value. The fix is
  in the sentence, not the assertion: the centimetres go BEFORE the name
  (`2.5 cm for TimesFM 3.0`), which no value can reproduce. Any renderer that
  prints a bare number next to `TimesFM` is one measurement away from the same
  collision.
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
- **A control belongs against the drawing it changes, and must not move it.**
  The target/horizon row renders directly above the curve and focuses `lead`:
  measured before that, it sat 1 121 px below the curve's head (2 173 on a
  phone) and a click scrolled the curve 1 166 px off the top. And `focusTo`
  scrolls only towards what the reader cannot see — a chip sits ON its own
  drawing, so pulling that drawing's heading to the top moved the page 415 px
  per click. Two traps in writing that rule: "visible" has to be the visible
  OVERLAP (the drawing spans 606–846 px of a 900 px window — wholly visible,
  yet a threshold on its top edge called it hidden), and the question is about
  the part that matters, marked `[data-core]`, because a section opens with
  prose and a chip row and on a phone the drawing starts ~380 px lower. An
  index link to a section really out of view still lays it at the top — the
  gate checks BOTH halves, or the rule silently becomes "never scroll".
- **The URL follows what is unfolded**, so a link can be sent as it stands:
  opening a panel by hand writes its anchor with `replaceState` (no history
  entry per fold, the chips keep their own back button). `toggle` does NOT
  bubble (hence a capture-phase listener) and fires in a task of its own — so a
  time flag cannot separate the reader's click from `draw()`'s restore pass:
  the element is marked (`silentToggles`), not the moment. With a flag, a chip
  clicked while two panels were open wrote `#method` into the URL instead of
  the drawing it had just changed.
- **Two gate-check habits.** Its `click()` helper `scrollIntoView`s the target
  first, so it can never measure whether the PAGE moved — dispatch the mouse
  events where the element already sits. And checks that use `replaceState` go
  LAST in the sequence: replaceState edits the current history entry, so
  folding panels mid-chain rewrites the very entries the back/forward checks
  walk.
- **Two lines are registered in `tfm.py`, and only one may ship.** `2p5` is
  Apache-2.0 and is `SHIPPED`; `3p0` carries non-commercial weights that forbid
  redistribution and production use, so it is measured and named but can never
  become the shipped model, however it scores. Both `timesfm` pins are exact
  and pre-registered (Dependabot ignores the package outright) — and they are
  the SAME distribution at two versions, so they live in the conflicting `model`
  / `model-nc` groups and can never share an environment. A challenger run needs
  `uv run --no-group model --group model-nc`. `tests/test_license.py` no longer
  greps for names (that banned the honest thing and caught none of the hazard);
  it guards the shipped model's licence, the shipped `report.json` files, and
  the fact that a plain `uv run` cannot install the non-commercial line — all
  nine break scenarios were measured red on 2026-09-03.
- **The output layout differs per line and is asserted on every call.** 2.5
  returns ten channels with the point forecast on 5 (channel 0 is the mean
  head); 3.0 returns nine deciles with the point on **4** and no mean head. A
  copied index would score a wrong MAE that still looks plausible, so
  `forecast_batch` checks the channel it was registered with.
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
