# pegel-visual — Projekt-Notizen

- **Tests:** `node --test` — `tests/extract.mjs` evaluiert das Inline-Script aus `index.html` gegen Browser-Stubs (kein jsdom, kein Netz): `loadApp({search, now, width})`, dann `app.run('<expr>')` im App-Scope.
- **Node-Scripts mit Netzwerk laufen am Sandbox-Proxy vorbei:** undici/`fetch` kennt `HTTP_PROXY` nicht → `ENOTFOUND www.pegelonline.wsv.de`, obwohl `curl` denselben Host erreicht. Das ist die Sandbox, nicht DNS und nicht die App — ein Bypass pro Call statt Debugging (betrifft `scripts/fetch-wsv-archive.mjs` und Ad-hoc-Node gegen die WSV-APIs).
- **`archive`-Branch = GitHub-only Orphan-Datenbranch.** Pushes dorthin triggern nie einen Workflow (kein `.github/` im gepushten Commit) — Deploys brauchen den expliziten `gh workflow run pages.yml --ref main`; das Reseed-Runbook steht im Header von `scripts/fetch-wsv-archive.mjs`.
- **`current.json` hat zwei Quellen, und nur eine kann zurückblicken.** Der wöchentliche REST-Lauf (`--current`) reicht ~31 Tage; der monatliche ZIP-Lauf (`--running`, erster Montag) liest das **ganze** Laufjahr neu und ist die Autorität. Der ZIP-Endpunkt akzeptiert ein Enddatum in der Zukunft und liefert bis zur letzten Messung (gemessen 2026-09-03: BONN 2026-01-01 … 09-03, 23 566 Punkte, 0 fehlende Tage) — `requestEnd(CURRENT_YEAR)` ist also richtig. Mit nur dem monatlichen REST-Lauf ließen zwei abgebrochene Läufe Januar–Juli 2026 in **jedem** WSV-`current.json` leer, ein halbes Jahr lang, während R1–R5 grün blieben. **R6** (`check-archive-consistency.mjs`) bewacht seitdem Vorderkante, Hinterkante und Lücktage der Flotte; `--skip R6` im Snapshot-Job ist Absicht: der schreibt `current.json` nie und würde sonst für einen fremden Defekt seine Tagesslots verlieren.
- **Ein Pegel, den WSV nie archiviert hat, ist kein Fehlschlag.** ~111 Schleusen- und Wehrpegel sind live auf REST, haben aber keine ZIP-Zeitreihe; der `prepare`-Endpunkt antwortet mit 303 auf `/errorpages/errorException`. Sie zählen getrennt — sonst liest sich der gesunde Gap-Sweep (626 übersprungen, nur die aussichtslosen versucht) als 100 % Fehlerquote, und **jeder** geplante Lauf stirbt rot vor seinem Push (so geschehen bis 2026-09-03). Die Unterscheidung hängt an `closed.json`: wer schon Jahre hat, kann sein Archiv nicht „nie gehabt" haben — dieselbe Antwort ist dort ein echter Fehlschlag.
- **Drei Rhein-Pegel sind nicht heilbar** (Basel-Rheinhalle, KONSTANZ-RHEIN, Neuwied Stadt, `from=2026`): kein ZIP vor 2026. `totals/2026.json` → `rivers.RHEIN.n` startet deshalb bei 33 und steigt am 10.07. auf 36 — das ist korrekt, kein Loch.

## Display layer: the survey plate

- **No character grid.** Every view is a *plate* rendered as HTML + inline SVG:
  a title block, the drawing, a legend for every mark it uses, and a foot
  naming source and reading age. If a section cannot name itself in its own
  legend, it does not ship.
- **Controls live on the plate.** Anything that changes a drawing — range,
  sub-view, lookback, shading, year — is rendered by that plate's own renderer
  as one `ctlRow()` directly above the mark it steers. There is no control bar
  outside `#screen`; a chip a screen away from its chart is a chip nobody
  connects to it. Each chip carries a real `href` via `navHref` (`cmd:h:30d`,
  `cmd:rd:7`, `cmd:years`, …), so the state it sets is shareable and the Back
  button works; only genuinely URL-less toggles (`cmd:abs`) stay buttons.
- **Legends are built, not spelled out.** A key is one `plateKey([…])` call —
  `ctlRow`'s sibling — fed `{ sw, label }` marks, `{ note }` caveats and
  `{ dd }` for markup the caller already escaped; swatches come from `keySw()`
  or `keyChip()`. A swatch reuses the drawing's own classes, so a mark that
  changes changes in both places at once. `tests/logic.test.mjs` pulls the
  classes out of the drawing and out of its `<dl class="p-key">` and demands
  the second set covers the first, so a new mark without a legend entry is red.
- **A swatch is a still, and it must not be positioned by `transform`.** Sharing
  the drawing's classes also inherits its CSS: the scene's `drift` carries a
  wave 320 units — a full scene width — clear of a 12 px box, and `bob`'s
  keyframe on `transform` silently beats a `transform=` attribute on the same
  element. So give an off-origin mark **its own `viewBox`** (third argument of
  `keySw`) instead of scaling it, and switch its animation off for `.sw` at a
  specificity that actually wins. Neither failure is visible to the tests —
  only a real browser catches an empty swatch.
- **A test that greps the whole page proves less than it looks.** `renderTotal:
  falling days are hatched` passed for months on the class name while no hatch
  existed; rewritten as `includes('fill="url(#tb-fell)"')` it would then have
  passed on the legend's own swatch. Anchor an assertion to the element it is
  about — `/<rect[^>]*fill="url\(#tb-fell\)"[^>]*class="db fell"/` — and put
  the fix back OUT to watch it go red before believing it.
- **`app.fire('keydown', {key})` / `app.fire('popstate')`** reach the real
  handlers: the harness collects window/document listeners, and `app.source`
  hands you the script text for structural checks (the dead-`cmd:`-target
  guard reads the dispatcher's own branches out of it).
- **Conventions the test harness depends on:** every `*ViewModel()` and
  `render*()` is a **top-level `function` declaration** (a `const` arrow inside
  a block is unreachable from `app.run`), and no renderer may ever emit the
  literal closing `script` tag — `tests/logic.test.mjs` guards both.
- **Never interpolate a raw value into markup** — always `${esc(v)}`, or
  `attr()` for attributes. A hostile-station-name test covers the renderers.
- **Palette is split fill/line:** pastels (`--water`, `--bed`, `--dry`) are
  FILLS for areas ≥24px, always bounded by an ink hairline. Anything carrying
  meaning as a line, a small mark or text uses the `-line` sibling, which is
  measured ≥4.5:1 on paper. Never give a mark only a fill token.
- **Meaning never rides on hue alone** — bands carry a hatch, states carry a
  glyph, directions carry both. The heat ramp stays a lightness ramp.
- **One picture, one estimator.** A number printed over a drawing comes from
  the same pooling as the drawing: the gate's lead curve is the median of five
  gauges' ratios, so its band labels are the median of their block skills, not
  clause A1's cm-pooled figure — a review caught the curve sitting on ×1.00
  under a label that said −0.04. Where two estimators must coexist, the key
  says which is which.
- **A gauge does not necessarily report centimetres.** 69 of 737 W series are
  metres above a datum (`m+NN`, `m+PNP`); the unit rides in the same `W.json`
  the client fetches. Print a level with `fmtLevel`/`levelWithUnit` in the
  gauge's OWN unit, and convert with `toCm()` only where a threshold is
  involved — `TREND_FLAT` and `RISING_FLAT` are noise floors for a gauge that
  ticks in whole centimetres. Elevation goes through `elevOf()`: a metre gauge
  IS the elevation and often carries no `gaugeZero` at all.
- **The history chart's x axis is TIME.** `bucketSeries` tiles the window by
  timestamp, not by array index, because the archive changes cadence inside a
  window (15-minutely for 16 days, hourly to a year, 6-hourly beyond). An
  empty column is either a resolution gap (drawn through) or a real silence
  (left null, the line breaks) — `windowGapLimit` decides, from the readings'
  own 90th-percentile spacing rather than from the clock, because 24 h is an
  outage at one gauge and the cadence at another.
- **Sizing:** container queries and SVG `viewBox`es, never a column count.
  `aspect-ratio` plus `min-height` on the same box derives a WIDTH from the
  height and overflows its track — use one or the other.
- **No render loop.** The page repaints only when data changes or the reader
  acts: every loader must end in `scheduleRender()`. A loader that forgets it
  simply never appears (this bit `loadStationList` during the migration).
  All motion is CSS on `transform`/`opacity`, off under reduced motion.
- **Verify in a real browser**, not only via tests — and `--headless=new
  --screenshot` alone does NOT do it: `scheduleRender()` rides on rAF, which a
  headless page never serves, so every data-driven view screenshots as
  `loading…`. What works: a `python3 -m http.server` plus Chrome with
  `--remote-debugging-port=9222 --remote-allow-origins='*'` (both need the
  sandbox bypass — socket bind and loopback connect), then a ~40-line CDP
  client over the global `WebSocket`: `Page.navigate`, sleep, evaluate
  `renderNow()`, `Page.captureScreenshot`.
  `Emulation.setDeviceMetricsOverride {mobile:true}` gives a true phone
  viewport, `setEmulatedMedia` a real `pointer: coarse`, and a `clip` at
  `scale: 4` is how you read a 12 px swatch. Measure through
  `Runtime.evaluate` in the same run — a `getBoundingClientRect()` sweep
  catches what a screenshot only hints at.
- **Driving the live browser: the tab has to be VISIBLE.** A tab that is
  minimised, on another Space or fully covered by another window reports
  `document.visibilityState === 'hidden'`, and Chrome then stops serving
  `requestAnimationFrame` — since `scheduleRender()` rides on rAF, the page sits
  on `loading…` with the data already in `state`, and `captureVisibleTab`
  returns blank images. Both look exactly like app bugs. Check
  `document.visibilityState` before believing either. (`renderNow()` from the
  console rendering fine while `scheduleRender()` does nothing is the tell.)
  A second trap: with browser zoom on, the extension's screenshot is a crop in
  device pixels, so image coordinates are `css * devicePixelRatio` — click by
  element `ref`, not by pixels read off the picture.

## Forecast gate (`scripts/forecast/`, Python via uv)

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
