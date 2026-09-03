# Forecast gate — seasonal / target mid

Verdict: **NO-SHIP**

model timesfm-3.0 (timesfm-non-commercial-license-v1.0) · checkpoint google/timesfm-3.0-pytorch · config 9fc34ab62295c07f · timesfm 3.0.1 · torch 2.14.0 · git 9f30165 · 2026-09-03T13:26:41Z · 397.1 s · repeat identical: yes · tfm sha256 18975b00f3b2e449 · reproduced bit for bit by a second full run at 2026-09-03T13:32:50Z

> Measured, not shipped. These weights are licensed timesfm-non-commercial-license-v1.0 (https://huggingface.co/google/timesfm-3.0-pytorch/blob/main/LICENSE), which forbids redistribution and any commercial or production use — so this line can be measured here but can never become the model this GPL-3.0 repo ships, however it scores.

## Clauses

| clause | pass | detail |
|---|---|---|
| A1 | FAIL | {"h1-14": 0.07562788774728679, "h15-30": 0.013258397300119018, "h31-90": -0.015413120845845674} |
| A2 | FAIL | {"h1-14": {"positive": 3, "min": 0.0}, "h15-30": {"positive": 1, "min": -0.048243468641486764}, "h31-90": {"positive": 1, "min": -0.09752361015774347}} |
| A3 | FAIL | {"h1-14": 0.05310233719534842, "h15-30": -0.030566511680840992, "h31-90": -0.0882157848077435} |
| A4 | FAIL | {"h1-14": {"significant": 4, "stouffer_z": 7.174166113236039}, "h15-30": {"significant": 2, "stouffer_z": 1.6814979201240277}, "h31-90": {"significant": 2, "stouffer_z": 0.11340947972945581}} |
| A5 | PASS | {"h1-14": {"tfm": 0.7931237721021611, "blend": 0.823210777434746, "ok": true}, "h15-30": {"tfm": 0.7851424361493123, "blend": 0.8225687622789783, "ok": true}, "h31-90": {"tfm": 0.7887557301899148, "blend": 0.8279895219384414, "ok": true}} |
| A6 | FAIL | {"h1-14": 0.08318388431847978, "h15-30": -0.0019002484898134053, "h31-90": -0.0737382030304281} |
| A7 | PASS | {"ss_old_2003_2015": 0.08248613384927284, "ss_new_2024_2025": 0.09464362759525546} |

## Pooled (KÖLN, DRESDEN, PASSAU ILZSTADT, FREMERSDORF, CUXHAVEN STEUBENHÖFT, 509 TEST origins)

| block | SS vs blend | 95 % CI | PICP80 tfm / blend | CRPS tfm / blend | SS CRPS | pairs |
|---|---|---|---|---|---|---|
| h1-14 | 0.076 | [0.053, 0.100] | 0.793 / 0.823 | 22.6 / 24.7 | 0.083 | 35630 |
| h15-30 | 0.013 | [-0.031, 0.057] | 0.785 / 0.823 | 33.2 / 33.1 | -0.002 | 40720 |
| h31-90 | -0.015 | [-0.088, 0.056] | 0.789 / 0.828 | 37.8 / 35.2 | -0.074 | 152700 |

## Regimes (median of members; ties count as 0)

| regime | members | h1-14 SS / z / p | h15-30 SS / z / p | h31-90 SS / z / p |
|---|---|---|---|---|
| Mittelrhein | KÖLN, BONN, KOBLENZ | 0.074 / 3.78 / 0.000 | -0.048 / -1.48 / 0.930 | -0.098 / -1.97 / 0.976 |
| Elbe-kontinental | DRESDEN | 0.105 / 4.80 / 0.000 | 0.108 / 2.86 / 0.002 | 0.110 / 1.87 / 0.031 |
| Donau-alpin | PASSAU ILZSTADT | 0.000 / 2.79 / 0.003 | 0.000 / 0.21 / 0.417 | 0.000 / -0.53 / 0.703 |
| Saar-flashy | FREMERSDORF | 0.166 / 3.89 / 0.000 | 0.000 / 2.30 / 0.011 | 0.000 / 1.46 / 0.072 |
| Nordsee-tidal | CUXHAVEN STEUBENHÖFT | 0.000 / 0.79 / 0.215 | 0.000 / -0.13 / 0.553 | 0.000 / -0.57 / 0.716 |

## Stations (TEST origins, MAE in the gauge's cm)

### KÖLN — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 60.7 | 99.6 | 141.8 | 58.5 | 57.0 | **54.2** | -4.3 | 0.074 | no | 0.81 | 0.061 | 0.76 | 3.78 (0.000, 588) |
| h15-30 | 97.3 | 99.2 | 142.1 | 86.2 | 86.5 | **90.5** | 4.2 | -0.049 | no | 0.95 | -0.065 | 0.76 | -1.49 (0.932, 214) |
| h31-90 | 130.0 | 98.7 | 141.5 | 97.2 | 97.3 | **106.8** | 9.6 | -0.099 | no | 0.90 | -0.146 | 0.75 | -2.01 (0.978, 76) |

PIT histogram h31-90: [4350, 3097, 2826, 2759, 2614, 2739, 2773, 3135, 3107, 3140]

### BONN — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 56.4 | 91.7 | 130.3 | 54.4 | — | **50.3** | -4.2 | 0.076 | no | 0.81 | 0.064 | 0.76 | 3.90 (0.000, 563) |
| h15-30 | 89.8 | 91.4 | 130.6 | 79.6 | — | **83.4** | 3.8 | -0.048 | no | 0.94 | -0.064 | 0.75 | -1.47 (0.929, 213) |
| h31-90 | 119.7 | 91.0 | 130.0 | 89.6 | — | **98.4** | 8.7 | -0.098 | no | 0.89 | -0.146 | 0.75 | -1.97 (0.976, 76) |

PIT histogram h31-90: [4433, 3113, 2939, 2661, 2591, 2760, 2733, 3103, 3084, 3123]

### KOBLENZ — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 51.1 | 80.9 | 116.4 | 49.1 | — | **45.8** | -3.3 | 0.067 | no | 0.83 | 0.061 | 0.76 | 3.72 (0.000, 637) |
| h15-30 | 80.5 | 80.6 | 116.7 | 70.9 | — | **74.3** | 3.4 | -0.048 | no | 0.94 | -0.059 | 0.74 | -1.48 (0.930, 223) |
| h31-90 | 106.7 | 80.2 | 116.1 | 79.3 | — | **86.5** | 7.1 | -0.090 | no | 0.88 | -0.129 | 0.76 | -1.87 (0.969, 79) |

PIT histogram h31-90: [4297, 3025, 2827, 2761, 2731, 2611, 2826, 3123, 3294, 3045]

### DRESDEN — 509 TEST origins, τ = 48

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 28.7 | 61.4 | 64.1 | 28.5 | — | **25.5** | -3.0 | 0.105 | no | 0.62 | 0.090 | 0.80 | 4.80 (0.000, 500) |
| h15-30 | 49.7 | 61.2 | 63.9 | 47.3 | — | **42.1** | -5.1 | 0.108 | no | 0.62 | 0.047 | 0.78 | 2.86 (0.002, 199) |
| h31-90 | 69.2 | 61.0 | 63.5 | 56.6 | — | **50.4** | -6.2 | 0.110 | no | 0.59 | -0.034 | 0.77 | 1.87 (0.031, 82) |

PIT histogram h31-90: [2870, 3343, 3201, 2672, 2821, 2634, 2499, 2632, 3692, 4176]

### PASSAU ILZSTADT — 509 TEST origins, τ = 44

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 31.8 | 44.5 | 61.9 | 29.7 | — | **28.0** | -1.7 | 0.056 | yes | 0.80 | 0.070 | 0.82 | 2.79 (0.003, 521) |
| h15-30 | 46.1 | 44.7 | 62.2 | 39.7 | — | **39.5** | -0.3 | 0.006 | yes | 0.79 | -0.019 | 0.80 | 0.21 (0.417, 264) |
| h31-90 | 58.8 | 44.2 | 61.7 | 43.6 | — | **44.7** | 1.1 | -0.026 | yes | 0.76 | -0.086 | 0.82 | -0.53 (0.703, 81) |

PIT histogram h31-90: [2162, 2903, 2653, 2725, 2783, 2912, 3202, 3526, 4275, 3399]

### FREMERSDORF — 509 TEST origins, τ = 26

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 16.4 | 15.6 | 22.2 | 14.8 | — | **12.3** | -2.4 | 0.166 | no | 0.70 | 0.231 | 0.78 | 3.89 (0.000, 515) |
| h15-30 | 20.4 | 15.5 | 22.0 | 16.3 | — | **14.6** | -1.7 | 0.104 | yes | 0.70 | 0.161 | 0.78 | 2.30 (0.011, 342) |
| h31-90 | 22.6 | 15.2 | 21.8 | 15.4 | — | **14.4** | -1.0 | 0.064 | yes | 0.62 | 0.098 | 0.79 | 1.46 (0.072, 87) |

PIT histogram h31-90: [2398, 2878, 2854, 2947, 3120, 3041, 3105, 2958, 3277, 3962]

### CUXHAVEN STEUBENHÖFT — 509 TEST origins, τ = 3

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 29.0 | 21.5 | 31.8 | 21.2 | — | **21.1** | -0.1 | 0.005 | yes | 0.73 | 0.033 | 0.81 | 0.79 (0.215, 359) |
| h15-30 | 31.2 | 21.6 | 31.8 | 21.6 | — | **21.6** | 0.0 | -0.001 | yes | 0.67 | 0.028 | 0.81 | -0.13 (0.553, 233) |
| h31-90 | 32.5 | 21.4 | 31.7 | 21.4 | — | **21.5** | 0.1 | -0.005 | yes | 0.64 | 0.024 | 0.81 | -0.57 (0.716, 69) |

PIT histogram h31-90: [2717, 2791, 2889, 3187, 2993, 3043, 3346, 3194, 3297, 3083]

## Befund 2 — climatology vs blend (SS of plain climatology against the blend)

| block | KÖLN | BONN | KOBLENZ | DRESDEN | PASSAU ILZSTADT | FREMERSDORF | CUXHAVEN STEUBENHÖFT |
|---|---|---|---|---|---|---|---|
| h1-14 | -0.701 | -0.685 | -0.646 | -1.153 | -0.501 | -0.054 | -0.017 |
| h15-30 | -0.150 | -0.148 | -0.137 | -0.295 | -0.125 | 0.049 | -0.000 |
| h31-90 | -0.016 | -0.015 | -0.011 | -0.079 | -0.014 | 0.015 | -0.000 |

## Caveats

- TimesFM 2.5 has no published corpus manifest; PEGELONLINE is open and CAMELS-DE (2024) covers German basins. Assume 2000-2024 MAY be in the training data. A7 is a probe, not a proof.
- The blend's τ and residual deciles are fitted on TRAIN; A7's 2003-2015 side therefore favours the blend slightly.
- Persistence is reported for the MASE denominators only. The bar is the blend.
- 2 candidates have now been measured on the SAME TEST origins (timesfm-2.5-200m, timesfm-3.0). The clause thresholds were pre-registered for a single candidate; read the significances as 2 looks at one test set, not one.

