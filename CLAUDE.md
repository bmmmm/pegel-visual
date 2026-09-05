# pegel-visual — Projekt-Notizen

- **Tests:** `node --test` — `tests/extract.mjs` evaluiert das Inline-Script aus `index.html` gegen Browser-Stubs (kein jsdom, kein Netz): `loadApp({search, now, width})`, dann `app.run('<expr>')` im App-Scope.
- **Node-Scripts mit Netzwerk laufen am Sandbox-Proxy vorbei:** undici/`fetch` kennt `HTTP_PROXY` nicht → `ENOTFOUND www.pegelonline.wsv.de`, obwohl `curl` denselben Host erreicht. Das ist die Sandbox, nicht DNS und nicht die App — ein Bypass pro Call statt Debugging (betrifft `scripts/fetch-wsv-archive.mjs` und Ad-hoc-Node gegen die WSV-APIs).
- **`archive`-Branch = GitHub-only Orphan-Datenbranch.** Pushes dorthin triggern nie einen Workflow (kein `.github/` im gepushten Commit) — Deploys brauchen den expliziten `gh workflow run pages.yml --ref main`; das Reseed-Runbook steht im Header von `scripts/fetch-wsv-archive.mjs`.
- **WSV-Archiv-Pipeline: die gemessenen Fakten stehen am Code, nicht hier.** Die Kurzfassung: `current.json` hat zwei Quellen, und nur der monatliche ZIP-Lauf (`--running`) kann zurückblicken — der wöchentliche REST-Lauf reicht ~31 Tage (Modi-Header von `scripts/fetch-wsv-archive.mjs`). ~111 Pegel ohne WSV-Archiv sind kein Fehlschlag: das 303 des `prepare`-Endpunkts ist die Tatsache, `markNoArchive` hält es in `meta.json` fest, nur der ZIP-Pfad löscht es, und `closed.json` unterscheidet „nie gehabt" von Ausfall (Kommentare an `prepare`, `hasClosedYears`, `markNoArchive`, `buildManifest` ebendort). **R6** und **R7** in `scripts/check-archive-consistency.mjs` bewachen Laufjahr und Marker; ihre Kommentare tragen die Kalibrierung, die fünf Pegel, die R6 nach Konstruktion nicht sieht, und die zwei stillgelegten. Warum `rivers.RHEIN.n` 2026 bei 33 startet und am 10.07. auf 36 springt, steht an `finalizeYear` in `scripts/build-river-totals.mjs`.

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
- **Two marks of one family, inverted, are not two marks.** Drawing a second
  candidate's bar as the first's hatch with its two colours swapped looked
  separable in the CSS and read as one bar drawn twice in the browser — the
  fills are the same hue at two weights. What separates at a glance is a change
  of KIND: hatched against solid, keeping the sign on the hue and on the side of
  zero the bar grows from. Same trap in words: `pale` / `dark` swap over between
  the colour schemes, `hatched` / `solid` do not. And a value column only the
  tests have seen will have its glyphs on the wrong lines.
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
- **Verify in a real browser**, not only via tests — `--headless=new
  --screenshot` alone does NOT do it (`scheduleRender()` rides on rAF, which a
  headless page never serves), and one engine is not a check. The recipes —
  Chrome over CDP with console and network capture, Firefox over WebDriver
  BiDi, phone emulation, the tab-visibility traps, and how to put real archive
  data under a local server — live in **`.claude/domains/browser-verify.md`**
  (moved there 2026-09-03). Read it before the first tool call of such a task.
  And measure a time series at **both** edges: the newest point against the
  clock, not only the oldest against the window.

## Forecast gate (`scripts/forecast/`, `gate/`)

Its own subsystem, its own file: **`.claude/domains/forecast-gate.md`** (moved
there 2026-09-03). Read it before touching the gate, the model pin or the hires
collector. The two things worth knowing without opening it: the 2026-09-02 run
of TimesFM 2.5 against the persistence/climatology blend is a **NO-SHIP**, and
that verdict lives in `gate/seasonal-mid/report.md`, not in anyone's memory —
re-running the gate consumes the test set — TimesFM 3.0 was measured on
2026-09-03 and is NO-SHIP too. And two model lines are registered, of which
only the Apache-2.0 one may ever **ship**; `tests/test_license.py` enforces it.
