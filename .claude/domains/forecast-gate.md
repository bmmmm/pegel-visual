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
- **Two gate-check habits.** The `click()` helper (in `scripts/lib/cdp.mjs` since
  the browser checks were de-duplicated) `scrollIntoView`s the target
  first, so it can never measure whether the PAGE moved — dispatch the mouse
  events where the element already sits. And checks that use `replaceState` go
  LAST in the sequence: replaceState edits the current history entry, so
  folding panels mid-chain rewrites the very entries the back/forward checks
  walk.
- **The sheet has ONE primary, and it is registry state — `tfm.PRIMARY`, beside
  `SHIPPED` and a different axis from it.** Since 2026-09-05 it is `3p0`, the
  line that can never ship. `write_models_manifest` writes it into
  `gate/models.json` (`primary`, falling back to the shipped line when the
  primary has no report on disk — the manifest may only name a model it lists;
  `test_gate.py` and `test_license.py` hold both). `buildModel` reads it: the
  primary leads everything that reads in a row (verdict list, settings lid,
  panel titles, readout, the gist), the panels that carry one number speak for
  it AND say so (facts, clauses fold, band labels with its line swatch, foot run
  line, method), and `labelNC()` is the one way such a name is printed — with ⚖
  when it cannot ship. Before this, "primary" was whichever enabled model came
  first in the manifest while the gist sorted "non-shippable first": two notions
  of focus that agreed by accident, with 2.5's numbers standing unnamed under a
  subtitle about 3.0. Three things deliberately do NOT follow the primary: the
  MARK (hue, dash) and the skill panel's SLOT (upper+hatched / lower+solid) stay
  bound to the manifest index, so a line keeps its look whoever leads; the CHIP
  row keeps the manifest's order even while the primary is off, because a
  control that changes places when used cannot be found again; and a target is
  available when ANY drawn model has it, with the primary stood in for by the
  first enabled model measured on it, and the same for the short-horizon run.
  On a 390 px phone the 1–14 band is 33 px wide: with two curves the band labels
  drop the SWATCH (CSS, `data-many`) and keep the number — it is this plate's own
  estimator (the median of five gauges; the facts pool centimetres, a different
  figure) and the primary's, the model the subtitle is about; gate-check measures
  paint, not DOM presence, because a swatch inside a `display:none` parent is
  "there". Names that are read aloud (`aria-label`, `data-say`) go through
  `spoken()` — words, not the glyph. `signed()` prints a rounded zero without a
  sign ("0.00", not "-0.00"); gate-check reads the block's sign off the label's
  three-decimal title since.
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
- **Observed areal rain does not help TimesFM 3.0, and the control is what
  says so.** `gate/nrw-mid/` holds the 2026-09-07 run of protocol `nrw`
  (context 384 = 12 patches of 32, horizon 14, weekly origins, blocks
  h1-3/h4-7/h8-14) on five LANUK gauges, one per basin, picked by the rule in
  `stations.NRW_STATIONS` — the Erft drops out because no Erft gauge reaches
  five rain gauges. Three arms on the SAME 48 origins: plain 3.0, 3.0 with the
  areal rain as a past-only covariate, and 3.0 with the rain of a DIFFERENT
  origin — and "different" means a HALF-CYCLE, 24 origins away: a random
  derangement left two of 48 windows one step from themselves, which at step 7
  is the rain of seven days earlier sharing 377 of its 384 days. Pooled at h1-3
  the rain arm is **−0.010** against the plain one (DM p 0.839) and the shuffled
  control **−0.005** — the control is FIVE THOUSANDTHS BETTER than the real rain.
  `rain_verdict` is **NO EFFECT**. R5 exists for exactly this: R1 can pass on
  noise, and only a control that does as well tells you it did.
  The house verdict is separate and is about the LINE, not the covariate: 3.0
  clears the MW-blend latte here (+0.117 at h1-3) and still can never ship.
- **The leak is the experiment, and its witness must not be derived from what
  it certifies.** A rain day closes seven hours into the next gauge day, so at
  context position t the newest rain is day t-1. The first witness was
  `[o-1 for o in origins]` compared against `origins-1` — it restated its own
  input, and a genuinely leaking `_nrw_covariate` passed it (measured
  2026-09-07). It is `cov_last` (what each covariate ENDED on) against
  `rain_lags_first` (the rain of o-1, read another way) now; the leaking build
  is VOID in 44 of 48 windows. `--against` is likewise checked to BE the plain
  arm: pointed at the shuffled run it produced a full clause table measuring
  rain-against-shuffled under headings that said plain, with R5 comparing the
  control against itself. The covariate filter runs on
  EVERY arm including the plain one — a window one arm cannot take must not be
  scored for the other, or the two arms answer different questions and every
  paired statistic is void.
- **729 days cannot carry a climatology**, so the `nrw` latte is `blend_mw`: a
  blend towards the operator's own published MW. An external number, not a
  constant fitted here — which is what keeps it a baseline rather than a second
  model. And the rain is OBSERVED: the run measures the ceiling a perfect
  precipitation forecast would buy, not what an operational system could do.
- **The control arm is listed, linked and never drawn.** `tfm.MODELS` marks it
  `control: True`, `write_models_manifest` carries that into `gate/models.json`,
  and `gate.js`'s exported `drawable()` — used by the page AND its tests, because
  those two disagreeing is how a control ends up on a plate — filters it out. Its
  report is linked from the rain panel's own prose, since R5 is worth nothing if
  a reader cannot open the arm it is about. `scripts/gate-rain-check.mjs` is that
  panel's browser gate (`gate-check.mjs` does not know it): it measures the PAINT,
  because `.meter.neg` was set on three negative bars and defined nowhere, and no
  assertion on markup could see it.
- **`collect-hires.mjs` is the only source of 15-minute data.** Weekly via the
  LaunchAgent `de.6bm.pegel-hires` (wrapper `collect-hires.sh`, heartbeat
  `cron:pegel-hires`, on the recap roster at 192 h), into
  `tmp-forecast/hires/<uuid>/<YYYY-MM>.json` on this Mac and from there into the
  GitHub-only, protected `hires` data branch (clone under
  `tmp-forecast/hires-branch/`, fast-forward only, never `origin`) — the
  short-horizon gate stays PROVISIONAL until ~16 weeks have accumulated. Month
  shards, not one file per gauge, so the weekly mirror commit stays small. The
  server clamps `P35D` to ~31 days; merges are idempotent by timestamp. A run
  that fails every fetch reports the disk as unchanged, not as empty, and the
  wrapper probes the API (HEAD) for ~10 min before it posts `failed` and logs
  the wait — `RunAtLoad` fires at login, on 2026-09-05 into a network 18 h
  without DNS.
