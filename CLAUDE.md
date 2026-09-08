# pegel-visual — Projekt-Notizen

- **Tests:** `node --test` — `tests/extract.mjs` evaluiert das Inline-Script aus `index.html` gegen Browser-Stubs (kein jsdom, kein Netz): `loadApp({search, now, width})`, dann `app.run('<expr>')` im App-Scope. Timer im App-Scope sind Stubs, die nie feuern: ein Test, der auf `app.run('new Promise(r => setTimeout(r, 5))')` wartet, hängt für immer — auf der Node-Seite warten oder direkt `await app.run('loadData()')`.
- **Node-Scripts mit Netzwerk laufen am Sandbox-Proxy vorbei:** undici/`fetch` kennt `HTTP_PROXY` nicht → `ENOTFOUND www.pegelonline.wsv.de`, obwohl `curl` denselben Host erreicht. Das ist die Sandbox, nicht DNS und nicht die App — ein Bypass pro Call statt Debugging (betrifft `scripts/fetch-wsv-archive.mjs` und Ad-hoc-Node gegen die WSV-APIs).
- **`archive`-Branch = GitHub-only Orphan-Datenbranch.** Pushes dorthin triggern nie einen Workflow (kein `.github/` im gepushten Commit) — Deploys brauchen den expliziten `gh workflow run pages.yml --ref main`; das Reseed-Runbook steht im Header von `scripts/fetch-wsv-archive.mjs`.
- **WSV-Archiv-Pipeline: die gemessenen Fakten stehen am Code, nicht hier.** Vorab nur dies: `current.json` hat zwei Quellen, und nur der monatliche ZIP-Lauf (`--running`) kann zurückblicken, der wöchentliche REST-Lauf reicht ~31 Tage (Modi-Header von `scripts/fetch-wsv-archive.mjs`). Warum Pegel ohne WSV-Archiv kein Fehlschlag sind, steht an `prepare`, `hasClosedYears`, `markNoArchive` und `buildManifest` ebendort; die Kalibrierung von **R6**/**R7** an ihren Regeln in `scripts/check-archive-consistency.mjs`; der Sprung von `rivers.RHEIN.n` an `finalizeYear` in `scripts/build-river-totals.mjs`.

## Display layer: the survey plate

Its own file: **`.claude/domains/display-layer.md`** — read it before drawing
or changing a mark, a legend, a control chip, a colour, the history chart's
buckets or anything sized. It carries the plate model itself (every view is a
title block, a drawing, a key that names every mark, and a foot naming source
and age — a section that cannot name itself does not ship), the `plateKey`/
`ctlRow` mechanics, the swatch traps, the fill/line palette split, and the rule
that a gauge does not necessarily report centimetres. Five rules stay here,
because they are the ones you break without knowing you are in that domain:

- **Never interpolate a raw value into markup** — always `${esc(v)}`, or
  `attr()` for attributes. A hostile-station-name test covers the renderers.
- **Every `*ViewModel()` and `render*()` is a top-level `function`
  declaration** — a `const` arrow inside a block is unreachable from `app.run`.
- **No render loop.** The page repaints only when data changes or the reader
  acts: every loader must end in `scheduleRender()`. A loader that forgets it
  simply never appears (this bit `loadStationList` during the migration).
- **Anchor an assertion to the element it is about, never to the whole page.**
  A class-name grep passed for months while no hatch existed, and a plain
  `includes()` would pass on the legend's own swatch — the `tb-fell` regex in
  `tests/logic.test.mjs` is the form. Put the fix back OUT and watch it go red
  before believing it. In the browser the anchors are their own subject —
  `.claude/domains/browser-verify.md`.
- **Verify in a real browser**, not only via tests — and `--headless=new
  --screenshot` alone does NOT do it, nor is one engine a check. The recipes,
  the traps and the anchors live in **`.claude/domains/browser-verify.md`**:
  read it before the first tool call of such a task. And measure a time series
  at **both** edges: the newest point against the clock, not only the oldest
  against the window.

## LANUK NRW (`scripts/fetch-nrw-archive.mjs`, `build-nrw-precip.mjs`, `nrw-update.yml`, branches `nrw`/`nrw-hires`)

Its own file: **`.claude/domains/lanuk-nrw.md`** — read it before touching the
collector, the **rain-field product** (`nrw/precip/`, its N1–**N8** gate, the
`?rain` mode, the station PRECIPITATION/RESPONSE blocks), the data branches or
the LANUK seam in `index.html`. Five things to carry without opening it: the source has **no CORS and no live feed** (a daily export, ~24 h
old, mirrored into two GitHub-only orphan branches); its window **rolls**, so a
missed day is gone for good and the merge policy is the inverse of the WSV
extreme-union; **WeatherNext** was evaluated on 2026-09-04 and rejected on four
independent grounds — do not reopen it without new facts; there are **two
clocks in one source**, a rain day against a gauge day, so the right edge of
every rain drawing is the collector's own `lastRainDay`, never `window.rain.to`
and never the clock; and the per-gauge product is **not areal rain over a
catchment** — no watershed is consulted anywhere, it is the rain FIELD around
the gauge (rule version 2, `scripts/probe-precip-rule.mjs` is the bench that
chose it); area weighting and per-station travel time were **measured and
killed** against a pre-registered criterion; and the hourly response lag was
killed on 2026-09-08 by a measurement that turned out to be **wrong** — the
probe had run under the old rule — so that kill is **withdrawn** and the stage
is open. Every figure behind these lives in the file.

## Forecast gate (`scripts/forecast/`, `gate/`)

Its own subsystem, its own file: **`.claude/domains/forecast-gate.md`** (moved
there 2026-09-03). Read it before touching the gate, the model pin or the hires
collector. Three verdicts to carry without opening it: TimesFM **2.5 and 3.0
are both NO-SHIP** seasonally, and those verdicts live in the gate's own
reports, not in anyone's memory — re-running the gate consumes the test set.
Of four registered model lines only the Apache-2.0 one may ever **ship**;
`tests/test_license.py` enforces it. And observed areal rain as a
covariate is **NO EFFECT** — the shuffled control did better than the real
rain, which is the whole reason a control that is never drawn is still run.
