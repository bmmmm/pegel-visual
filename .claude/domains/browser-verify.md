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
