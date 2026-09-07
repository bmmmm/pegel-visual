# Display layer: the survey plate

Pulled out of `CLAUDE.md` on 2026-09-07, the way `browser-verify.md` was: this
is needed when you are actually building or changing a drawing, not on every
turn of every session. The bullets below are the CLAUDE.md wording, moved
verbatim — do not paraphrase them. What stayed behind in `CLAUDE.md` is the
handful of rules you break without knowing you are in this domain at all.

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
- **`app.fire('keydown', {key})` / `app.fire('popstate')`** reach the real
  handlers: the harness collects window/document listeners, and `app.source`
  hands you the script text for structural checks (the dead-`cmd:`-target
  guard reads the dispatcher's own branches out of it).
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
- **A gauge does not necessarily report centimetres** — 69 of 737 W series are
  metres above a datum, and the unit comes with the reading. Print a level with
  `fmtLevel`/`levelWithUnit` in the gauge's OWN unit, convert with `toCm()`
  only at a threshold, and take elevation from `elevOf()`; the measurement and
  the noise-floor reasoning stand at those functions in `index.html`.
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
- All motion is CSS on `transform`/`opacity`, off under reduced motion.
