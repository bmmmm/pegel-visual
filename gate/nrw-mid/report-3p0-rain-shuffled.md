# Forecast gate — NRW, does observed areal rain help?

Verdict: **SHIP**

> Measured, not shipped. These weights are licensed timesfm-non-commercial-license-v1.0 (https://huggingface.co/google/timesfm-3.0-pytorch/blob/main/LICENSE), which forbids redistribution and any commercial or production use — so this line can be measured here but can never become the model this GPL-3.0 repo ships, however it scores.

> **This is the negative control.** Its covariate is real rain from a DIFFERENT origin, so it is supposed to lose. Its numbers are here to be compared with the true rain arm's, not read on their own — see clause R5 in `report-3p0-rain.md`.

Arm `shuffled`, compared against `3p0` on the same origins.

Target: the source's own daily mean, not (min+max)/2. Covariate: areal_rain_past_only_shift1_shuffled_seed7. Mirror: 2026-09-06 / export 2026-09-06T19:03:54.000Z.

## Pooled over 5 basins, 48 origins

| block | SS vs MW-blend | 95% CI | SS vs other arm | DM p | PICP80 | pairs |
|---|---|---|---|---|---|---|
| h1-3 | 0.119 | [0.016, 0.242] | -0.007 | 0.768 | 0.779 | 720 |
| h4-7 | 0.079 | [-0.086, 0.243] | -0.006 | 0.690 | 0.732 | 960 |
| h8-14 | 0.143 | [-0.012, 0.287] | 0.002 | 0.447 | 0.740 | 1680 |

## Per gauge

| gauge | block | persist | snaive | MW-blend | rain-OLS | TimesFM | SS vs blend | SS vs other arm |
|---|---|---|---|---|---|---|---|---|
| Schermbeck_1 | h1-3 | 8.9 | 44.2 | 9.2 | 8.6 | 7.2 | 0.212 | 0.003 |
| Schermbeck_1 | h4-7 | 13.0 | 46.7 | 13.6 | 17.2 | 13.1 | 0.036 | -0.001 |
| Schermbeck_1 | h8-14 | 17.5 | 44.7 | 17.7 | 21.1 | 14.5 | 0.181 | 0.000 |
| Menden_1 | h1-3 | 11.5 | 36.5 | 11.7 | 12.9 | 9.5 | 0.182 | -0.008 |
| Menden_1 | h4-7 | 17.8 | 35.7 | 17.8 | 20.5 | 16.1 | 0.098 | 0.019 |
| Menden_1 | h8-14 | 23.4 | 35.5 | 23.0 | 24.4 | 19.8 | 0.139 | -0.001 |
| Stah | h1-3 | 6.3 | 32.1 | 6.3 | 6.6 | 6.5 | -0.030 | -0.020 |
| Stah | h4-7 | 9.7 | 33.5 | 9.7 | 10.4 | 10.1 | -0.038 | -0.058 |
| Stah | h8-14 | 12.5 | 32.6 | 12.2 | 12.6 | 11.4 | 0.063 | 0.010 |
| Loehne | h1-3 | 8.9 | 25.7 | 9.0 | 10.3 | 8.6 | 0.042 | -0.008 |
| Loehne | h4-7 | 10.4 | 24.8 | 11.0 | 12.8 | 9.7 | 0.118 | -0.017 |
| Loehne | h8-14 | 13.0 | 24.8 | 13.9 | 13.7 | 11.6 | 0.168 | -0.004 |
| Villigst | h1-3 | 6.5 | 30.7 | 6.5 | 6.9 | 5.7 | 0.127 | -0.001 |
| Villigst | h4-7 | 10.7 | 30.7 | 10.7 | 12.9 | 8.9 | 0.165 | 0.006 |
| Villigst | h8-14 | 12.5 | 30.4 | 12.4 | 14.6 | 10.6 | 0.144 | 0.010 |

MAE in the gauge's own unit (every LANUK gauge in this set reports cm).

## The rain behind each gauge

| gauge | basin | km² | rain gauges | MW | origins | rain events | tau |
|---|---|---|---|---|---|---|---|
| Schermbeck_1 | Lippe | 4783 | 32 | 179 | 48 | 22 | 59 |
| Menden_1 | Sieg | 2825 | 29 | 66 | 48 | 27 | 79 |
| Stah | Rur | 2135 | 24 | 65 | 48 | 20 | 123 |
| Loehne | Weser | 1335 | 22 | 98 | 48 | 21 | 22 |
| Villigst | Ruhr | 2013 | 18 | 136 | 48 | 26 | 87 |

## Caveats

- Three arms ran on the SAME origins, and the thresholds above were pre-registered for one comparison. The third arm (shuffled rain) is a control that is SUPPOSED to lose: if it wins as much as the true arm, what the true arm found is not rain.
- 729 days of mirror cannot carry a climatology, so the latte is a blend towards the operator's own MW — an external number, not a constant fitted here.
- The areal mean is Thiessen with equal areas: the source ships no sub-catchment polygons, and a rain gauge joins the nearest receiving gauge of its own basin.
- **Observed rain, not forecast rain.** This measures the ceiling a perfect precipitation forecast would buy, not what an operational system could do — and the mirror itself lags about a day behind.

- 3 candidates have now been measured on the SAME TEST origins (timesfm-3.0, timesfm-3.0, timesfm-3.0). The clause thresholds were pre-registered for a single candidate; read the significances as 3 looks at one test set, not one.

