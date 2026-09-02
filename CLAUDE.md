# pegel-visual — Projekt-Notizen

- **Tests:** `node --test` — `tests/extract.mjs` evaluiert das Inline-Script aus `index.html` gegen Browser-Stubs (kein jsdom, kein Netz): `loadApp({search, now, width})`, dann `app.run('<expr>')` im App-Scope.
- **Node-Scripts mit Netzwerk laufen am Sandbox-Proxy vorbei:** undici/`fetch` kennt `HTTP_PROXY` nicht → `ENOTFOUND www.pegelonline.wsv.de`, obwohl `curl` denselben Host erreicht. Das ist die Sandbox, nicht DNS und nicht die App — ein Bypass pro Call statt Debugging (betrifft `scripts/fetch-wsv-archive.mjs` und Ad-hoc-Node gegen die WSV-APIs).
- **`archive`-Branch = GitHub-only Orphan-Datenbranch.** Pushes dorthin triggern nie einen Workflow (kein `.github/` im gepushten Commit) — Deploys brauchen den expliziten `gh workflow run pages.yml --ref main`; das Reseed-Runbook steht im Header von `scripts/fetch-wsv-archive.mjs`.

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
