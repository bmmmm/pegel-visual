# Forecast gate — NRW, does observed areal rain help?

Verdict: **NO-SHIP**

Rain: **NO EFFECT**

> Measured, not shipped. These weights are licensed timesfm-non-commercial-license-v1.0 (https://huggingface.co/google/timesfm-3.0-pytorch/blob/main/LICENSE), which forbids redistribution and any commercial or production use — so this line can be measured here but can never become the model this GPL-3.0 repo ships, however it scores.

Arm `rain`, compared against `3p0` on the same origins.

Target: the source's own daily mean, not (min+max)/2. Covariate: areal_rain_past_only_shift1. Mirror: 2026-09-06 / export 2026-09-06T19:03:54.000Z.

## Does the rain help? (R1-R5, pre-registered)

| clause | question | pass | detail |
|---|---|---|---|
| R1 | skill over the plain arm at h1-3, significant | no | ss_h1_3 -0.010; dm_p 0.839; min 0.050; p_max 0.050 |
| R2 | no worse at h4-7 | no | ss_h4_7 -0.013; min 0.000 |
| R3 | still calibrated (PICP80 in range) | yes | picp80 h1-3 0.774 h4-7 0.741 h8-14 0.748; range [0.700, 0.900]; slack_vs_plain 0.030 |
| R4 | no single gauge much worse | no | floor -0.050; ss_vs_plain Schermbeck_1/h1-3 -0.004 Schermbeck_1/h4-7 0.002 Schermbeck_1/h8-14 0.009 Menden_1/h1-3 -0.013 Menden_1/h4-7 0.008 Menden_1/h8-14 -0.011 |
| R5 | the control loses AND the true arm beats it by the registered gap | no | control_ss_h1_3 -0.005; true_minus_control -0.005; control_max 0.020; gap_min 0.030 |

## Pooled over 5 basins, 48 origins

| block | SS vs MW-blend | 95% CI | SS vs other arm | DM p | PICP80 | pairs |
|---|---|---|---|---|---|---|
| h1-3 | 0.117 | [0.017, 0.240] | -0.010 | 0.839 | 0.774 | 720 |
| h4-7 | 0.073 | [-0.093, 0.235] | -0.013 | 0.819 | 0.741 | 960 |
| h8-14 | 0.138 | [-0.015, 0.280] | -0.003 | 0.567 | 0.748 | 1680 |

## Per gauge

| gauge | block | persist | snaive | MW-blend | rain-OLS | TimesFM | SS vs blend | SS vs other arm |
|---|---|---|---|---|---|---|---|---|
| Schermbeck_1 | h1-3 | 8.9 | 44.2 | 9.2 | 8.6 | 7.3 | 0.207 | -0.004 |
| Schermbeck_1 | h4-7 | 13.0 | 46.7 | 13.6 | 17.2 | 13.1 | 0.039 | 0.002 |
| Schermbeck_1 | h8-14 | 17.5 | 44.7 | 17.7 | 21.1 | 14.4 | 0.189 | 0.009 |
| Menden_1 | h1-3 | 11.5 | 36.5 | 11.7 | 12.9 | 9.6 | 0.178 | -0.013 |
| Menden_1 | h4-7 | 17.8 | 35.7 | 17.8 | 20.5 | 16.3 | 0.088 | 0.008 |
| Menden_1 | h8-14 | 23.4 | 35.5 | 23.0 | 24.4 | 20.0 | 0.130 | -0.011 |
| Stah | h1-3 | 6.3 | 32.1 | 6.3 | 6.6 | 6.4 | -0.015 | -0.005 |
| Stah | h4-7 | 9.7 | 33.5 | 9.7 | 10.4 | 10.1 | -0.035 | -0.056 |
| Stah | h8-14 | 12.5 | 32.6 | 12.2 | 12.6 | 11.7 | 0.042 | -0.012 |
| Loehne | h1-3 | 8.9 | 25.7 | 9.0 | 10.3 | 8.7 | 0.031 | -0.019 |
| Loehne | h4-7 | 10.4 | 24.8 | 11.0 | 12.8 | 9.9 | 0.106 | -0.031 |
| Loehne | h8-14 | 13.0 | 24.8 | 13.9 | 13.7 | 11.7 | 0.160 | -0.014 |
| Villigst | h1-3 | 6.5 | 30.7 | 6.5 | 6.9 | 5.7 | 0.127 | -0.001 |
| Villigst | h4-7 | 10.7 | 30.7 | 10.7 | 12.9 | 9.0 | 0.156 | -0.005 |
| Villigst | h8-14 | 12.5 | 30.4 | 12.4 | 14.6 | 10.5 | 0.147 | 0.014 |

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

- 3 candidates have now been measured on the SAME TEST origins (TimesFM 3.0, TimesFM 3.0 + rain, TimesFM 3.0 + shuffled rain). The clause thresholds were pre-registered for a single candidate; read the significances as 3 looks at one test set, not one.

