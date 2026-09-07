# Browser verification

Pulled out of `CLAUDE.md` on 2026-09-03: this is needed when you are actually
verifying something in a browser, not on every turn of every session. The text
below is the CLAUDE.md wording, moved verbatim — do not paraphrase it, the
memory `browser-verify-cdp-recipe` points here as the source.

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
  catches what a screenshot only hints at. `Runtime.enable` + `Log.enable` +
  `Network.enable` BEFORE `Page.navigate` collect the console
  (`Runtime.consoleAPICalled`, `Log.entryAdded`, `Runtime.exceptionThrown`) and
  every response code in the same run — that is how a request the app swallows
  in a `.catch` becomes visible at all.
- **The apparatus is `scripts/lib/cdp.mjs`, not a fourth copy.** `serve`, `chrome`,
  the CDP client, `check`, and `rect`/`settle`/`click` live there; `gate-check`,
  `home-check`, `verify-precip` and `gate-rain-check` import them. `session()`
  also gives you `on(method, fn)` — CDP events carry no `id`, so without it
  `Fetch.requestPaused` lands on the floor and the page hangs waiting for an
  interception nobody answered.
- **Freezing a page's data: intercept, do not stub.** `scripts/home-check.mjs`
  answers every PEGELONLINE and open-meteo request over `Fetch.enable` +
  `fulfillRequest` from `tests/fixtures/home/`, which the Node test imports too —
  one routing table, one clock. Real `Response` objects, so `getJson`'s `res.ok`
  branch is exercised; `Access-Control-Allow-Origin` must be in the fulfilled
  headers, which is how the cross-origin contract gets tested rather than
  bypassed. An unmatched URL FAILS the run — never `continueRequest` to the real
  network, or CI eventually goes green off live data, which is the state that
  looks healthiest and proves least. Freeze the clock with
  `Page.addScriptToEvaluateOnNewDocument` (the `DateStub` of `tests/extract.mjs`,
  verbatim), never `Emulation.setVirtualTimePolicy` — that also drives rAF, and
  rAF firing normally is the one thing a browser check is for. And
  `Network.setBypassServiceWorker` before the first navigate, or load 1 is
  uncontrolled and load 2 is service-worker controlled: two paths in one run.
- **A ledger of cross-origin requests is half a ledger.** `archive/` is
  SAME-origin. A check written against the API interception passed while the page
  fetched the whole archive, and only a 404 out of a bare worktree made the run
  fail at all — on a checkout with `archive/` lying around it would have been
  silent. Record the local requests too. (And filter on `/archive/`, not on
  `manifest`: the PWA's `manifest.webmanifest` is not a data tree.)
- **A range chip replaces, it does not push.** `setHistory` calls
  `history.replaceState`, so Back leaves the gauge rather than stepping through
  every range tried. Do not write a check that expects Back to undo a range —
  what the chip's `href` is FOR is sharing, and the way to prove that is to load
  the URL it produced COLD and see the same view come back.
- **One engine is not a check.** The 400 on `measurements.json` and the „history
  stops in January" report both came out of Firefox. Gecko over **WebDriver
  BiDi**: `firefox --headless --no-remote --profile <tmp> --remote-debugging-port
  <p> about:blank`, then a WebSocket on `ws://127.0.0.1:<p>/session` — Firefox
  serves **no** `/json/version` and CDP is off. `session.new {capabilities:{}}` →
  `browsingContext.getTree` (take `contexts[0].context`) →
  `browsingContext.navigate {wait:'complete'}` → `script.evaluate {target:
  {context}, awaitPromise:true}`. The expression must return a **string**
  (`JSON.stringify(...)`), or the result comes back as a serialized object tree.
  Console via `session.subscribe {events:['log.entryAdded']}`. Errors arrive as
  `{type:'error'}`, not as a rejected promise.
- **A view transition is invisible to headless screenshots** — both engines
  capture the DOM under the snapshot layer, so a squashed 350 ms frame never
  shows up in a PNG. Measure it instead: `document.getAnimations()` filtered
  on `effect.pseudoElement` says which `::view-transition-*` groups run and
  where in their timeline they are, and `getComputedStyle(document.documentElement,
  '::view-transition-new(<name>)').height` against the real element's
  `offsetHeight` says whether a snapshot is being stretched. That is how the
  `#screen` group was caught sized to the 224 px connecting screen while the
  chart underneath was already 831 px (2026-09-06, Firefox 154 and Chrome).
- **A time series has two edges, and a check that measures one proves nothing.**
  The gate that signed off the running-year heal only asked whether the line
  breaks — a series ending cleanly on 31.12.2025 would have passed it. Always
  measure the newest point against the CLOCK as well as the oldest against the
  window. The same asymmetry sat in the plate itself: `coveredDays` warned about
  a short start while a missing right end went unnamed.
- **Local checks need real data, and `/archive/` is gitignored for exactly
  that.** `curl` the deployed `archive/manifest.json` plus the one gauge's
  `closed.json` + `current.json` into `archive/<uuid>/` next to the worktree's
  `index.html`, then serve it — that is how new code meets real data before it
  is deployed. `?station=BONN&history=5y` drives the range straight from the URL.
  In a worktree, `ln -s <main checkout>/archive archive` is the quick way to the
  same data — but `git status` then shows it as `??`, because the ignore rule
  `/archive/` matches a directory, not a symlink. Remove the link before the
  commit (2026-09-06).
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
- **`body.innerHTML.includes()` is not a page check** — it matches the script's
  own string table and the global footer, so an assertion written that way is
  true before the page renders anything. Read `#screen`'s `innerText` instead
  (2026-09-06: 44 false FAILs out of one wrong anchor). This and the bullet
  below are the same rule, once for the text layer and once for the drawing.
- **In the browser, the key's swatches ARE the drawing — anchor at `.scene-plot`,
  not at `svg.scene`.** A swatch reuses the drawing's classes *and* its element
  (`keySw` emits `<svg class="sw scene">`), so `#screen svg.scene g.boat` counts
  the boat twice and `#screen svg.scene *` sweeps the key's own marks into the
  set of "classes drawn". A check built that way passes by construction: it
  compares the legend against itself. Measured 2026-09-07 — one boat read as
  two, and the "every mark is named" check was circular until both selectors
  were anchored at `.scene-plot` (the drawing) against `.p-key .sw` (the key).
  This is the CLAUDE.md anchor rule in its browser form; the rule was read that
  session and still missed, because in the DOM the two live one node apart.
- **A layout measured on this Mac is not a measurement of the CI runner.** The
  same subtitle wrapped to three lines more on the runner's fonts, and
  `gate-check`'s "the drawing is whole on the first screen" went from 819 px of
  844 locally to 884 on the runner — green here, red on main (2026-09-04). Chrome
  is the same build; the fonts are not. So when prose grows against a measured
  edge, leave room for a third of the block again, and cap the string's length in
  a unit test — that check runs the same everywhere, which is the whole point of
  putting the budget there rather than in the browser.
