# Forecast gate — seasonal / target mid

Verdict: **NO-SHIP**

model timesfm-2.5-200m (Apache-2.0) · checkpoint google/timesfm-2.5-200m-pytorch · config 362b77bd29350df5 · timesfm 2.0.2 · torch 2.14.0 · git 2247d9c · 2026-09-02T19:36:35Z · 239.6 s · repeat identical: yes · tfm sha256 c0f3c683d4c83587 · reproduced bit for bit by a second full run at 2026-09-02T19:42:18Z

## Clauses

| clause | pass | detail |
|---|---|---|
| A1 | FAIL | {"h1-14": 0.07192664732345844, "h15-30": 0.013880991396325593, "h31-90": -0.035533955536033224} |
| A2 | FAIL | {"h1-14": {"positive": 3, "min": 0.0}, "h15-30": {"positive": 1, "min": -0.036660263562339424}, "h31-90": {"positive": 1, "min": -0.10751890126640284}} |
| A3 | FAIL | {"h1-14": 0.05046447701421353, "h15-30": -0.033721106815549434, "h31-90": -0.11330558542020049} |
| A4 | FAIL | {"h1-14": {"significant": 4, "stouffer_z": 6.735844866475215}, "h15-30": {"significant": 2, "stouffer_z": 1.4591275079868762}, "h31-90": {"significant": 0, "stouffer_z": -0.434005019588013}} |
| A5 | PASS | {"h1-14": {"tfm": 0.8095986528206568, "blend": 0.823210777434746, "ok": true}, "h15-30": {"tfm": 0.7843074656188606, "blend": 0.8225687622789783, "ok": true}, "h31-90": {"tfm": 0.788166339227243, "blend": 0.8279895219384414, "ok": true}} |
| A6 | FAIL | {"h1-14": 0.07623050847177282, "h15-30": -0.00811186983954748, "h31-90": -0.10140374894174764} |
| A7 | PASS | {"ss_old_2003_2015": 0.07644147704683646, "ss_new_2024_2025": 0.103865734174588} |

## Pooled (KÖLN, DRESDEN, PASSAU ILZSTADT, FREMERSDORF, CUXHAVEN STEUBENHÖFT, 509 TEST origins)

| block | SS vs blend | 95 % CI | PICP80 tfm / blend | CRPS tfm / blend | SS CRPS | pairs |
|---|---|---|---|---|---|---|
| h1-14 | 0.072 | [0.050, 0.095] | 0.810 / 0.823 | 22.8 / 24.7 | 0.076 | 35630 |
| h15-30 | 0.014 | [-0.034, 0.063] | 0.784 / 0.823 | 33.4 / 33.1 | -0.008 | 40720 |
| h31-90 | -0.036 | [-0.113, 0.045] | 0.788 / 0.828 | 38.8 / 35.2 | -0.101 | 152700 |

## Regimes (median of members; ties count as 0)

| regime | members | h1-14 SS / z / p | h15-30 SS / z / p | h31-90 SS / z / p |
|---|---|---|---|---|
| Mittelrhein | KÖLN, BONN, KOBLENZ | 0.077 / 4.36 / 0.000 | -0.037 / -1.08 / 0.860 | -0.108 / -2.13 / 0.983 |
| Elbe-kontinental | DRESDEN | 0.089 / 3.81 / 0.000 | 0.089 / 2.16 / 0.016 | 0.055 / 0.83 / 0.203 |
| Donau-alpin | PASSAU ILZSTADT | 0.000 / 2.37 / 0.009 | 0.000 / 0.13 / 0.450 | 0.000 / -0.45 / 0.675 |
| Saar-flashy | FREMERSDORF | 0.160 / 3.75 / 0.000 | 0.000 / 2.29 / 0.011 | 0.000 / 1.10 / 0.135 |
| Nordsee-tidal | CUXHAVEN STEUBENHÖFT | 0.000 / 0.77 / 0.221 | 0.000 / -0.23 / 0.589 | 0.000 / -0.32 / 0.627 |

## Stations (TEST origins, MAE in the gauge's cm)

### KÖLN — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 60.7 | 99.6 | 141.8 | 58.5 | 57.0 | **54.0** | -4.5 | 0.077 | no | 0.82 | 0.060 | 0.82 | 4.47 (0.000, 601) |
| h15-30 | 97.3 | 99.2 | 142.1 | 86.2 | 86.5 | **89.4** | 3.2 | -0.037 | no | 0.94 | -0.065 | 0.77 | -1.08 (0.860, 224) |
| h31-90 | 130.0 | 98.7 | 141.5 | 97.2 | 97.3 | **108.2** | 11.0 | -0.113 | no | 0.91 | -0.175 | 0.77 | -2.21 (0.986, 83) |

PIT histogram h31-90: [3473, 2836, 2522, 2836, 3021, 3083, 3181, 3135, 2878, 3575]

### BONN — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 56.4 | 91.7 | 130.3 | 54.4 | — | **50.3** | -4.2 | 0.077 | no | 0.82 | 0.061 | 0.82 | 4.36 (0.000, 577) |
| h15-30 | 89.8 | 91.4 | 130.6 | 79.6 | — | **82.5** | 2.9 | -0.036 | no | 0.93 | -0.065 | 0.78 | -1.07 (0.859, 222) |
| h31-90 | 119.7 | 91.0 | 130.0 | 89.6 | — | **99.3** | 9.6 | -0.108 | no | 0.90 | -0.170 | 0.77 | -2.13 (0.983, 83) |

PIT histogram h31-90: [3475, 2846, 2510, 2839, 3024, 3096, 3158, 3184, 2873, 3535]

### KOBLENZ — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 51.1 | 80.9 | 116.4 | 49.1 | — | **45.8** | -3.3 | 0.068 | no | 0.83 | 0.058 | 0.82 | 4.12 (0.000, 625) |
| h15-30 | 80.5 | 80.6 | 116.7 | 70.9 | — | **73.5** | 2.6 | -0.037 | no | 0.93 | -0.060 | 0.78 | -1.13 (0.871, 232) |
| h31-90 | 106.7 | 80.2 | 116.1 | 79.3 | — | **87.5** | 8.2 | -0.103 | no | 0.89 | -0.159 | 0.78 | -2.11 (0.983, 86) |

PIT histogram h31-90: [3410, 2832, 2500, 2912, 3049, 3213, 3147, 3213, 2815, 3449]

### DRESDEN — 509 TEST origins, τ = 48

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 28.7 | 61.4 | 64.1 | 28.5 | — | **26.0** | -2.5 | 0.089 | no | 0.63 | 0.073 | 0.82 | 3.81 (0.000, 423) |
| h15-30 | 49.7 | 61.2 | 63.9 | 47.3 | — | **43.1** | -4.2 | 0.089 | no | 0.64 | 0.022 | 0.77 | 2.16 (0.016, 181) |
| h31-90 | 69.2 | 61.0 | 63.5 | 56.6 | — | **53.5** | -3.1 | 0.055 | no | 0.62 | -0.092 | 0.76 | 0.83 (0.203, 78) |

PIT histogram h31-90: [3198, 3021, 2862, 2905, 2791, 2432, 2675, 2812, 3594, 4250]

### PASSAU ILZSTADT — 509 TEST origins, τ = 44

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 31.8 | 44.5 | 61.9 | 29.7 | — | **28.2** | -1.5 | 0.050 | yes | 0.80 | 0.064 | 0.82 | 2.37 (0.009, 557) |
| h15-30 | 46.1 | 44.7 | 62.2 | 39.7 | — | **39.6** | -0.2 | 0.004 | yes | 0.79 | -0.013 | 0.78 | 0.13 (0.450, 219) |
| h31-90 | 58.8 | 44.2 | 61.7 | 43.6 | — | **44.7** | 1.2 | -0.027 | yes | 0.76 | -0.090 | 0.79 | -0.45 (0.675, 74) |

PIT histogram h31-90: [2081, 2892, 2543, 2544, 2780, 2863, 3029, 3372, 3998, 4438]

### FREMERSDORF — 509 TEST origins, τ = 26

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 16.4 | 15.6 | 22.2 | 14.8 | — | **12.4** | -2.4 | 0.160 | no | 0.70 | 0.213 | 0.79 | 3.75 (0.000, 519) |
| h15-30 | 20.4 | 15.5 | 22.0 | 16.3 | — | **14.5** | -1.8 | 0.108 | yes | 0.70 | 0.146 | 0.78 | 2.29 (0.011, 335) |
| h31-90 | 22.6 | 15.2 | 21.8 | 15.4 | — | **14.6** | -0.8 | 0.052 | yes | 0.63 | 0.071 | 0.80 | 1.10 (0.135, 88) |

PIT histogram h31-90: [1763, 2635, 2721, 2859, 3178, 3562, 3465, 3093, 2789, 4475]

### CUXHAVEN STEUBENHÖFT — 509 TEST origins, τ = 3

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 29.0 | 21.5 | 31.8 | 21.2 | — | **21.1** | -0.1 | 0.005 | yes | 0.73 | 0.032 | 0.81 | 0.77 (0.221, 408) |
| h15-30 | 31.2 | 21.6 | 31.8 | 21.6 | — | **21.6** | 0.0 | -0.002 | yes | 0.67 | 0.024 | 0.82 | -0.23 (0.589, 271) |
| h31-90 | 32.5 | 21.4 | 31.7 | 21.4 | — | **21.5** | 0.1 | -0.003 | yes | 0.64 | 0.023 | 0.83 | -0.32 (0.627, 74) |

PIT histogram h31-90: [2546, 2919, 3127, 3222, 3231, 3139, 3609, 2965, 3234, 2548]

## Befund 2 — climatology vs blend (SS of plain climatology against the blend)

| block | KÖLN | BONN | KOBLENZ | DRESDEN | PASSAU ILZSTADT | FREMERSDORF | CUXHAVEN STEUBENHÖFT |
|---|---|---|---|---|---|---|---|
| h1-14 | -0.701 | -0.685 | -0.646 | -1.153 | -0.501 | -0.054 | -0.017 |
| h15-30 | -0.150 | -0.148 | -0.137 | -0.295 | -0.125 | 0.049 | -0.000 |
| h31-90 | -0.016 | -0.015 | -0.011 | -0.079 | -0.014 | 0.015 | -0.000 |

## Caveats

- timesfm-2.5-200m has no published corpus manifest; PEGELONLINE is open and CAMELS-DE (2024) covers German basins. Assume the archive MAY be in the training data. A7 is a probe, not a proof — and it gets weaker the later the checkpoint, because A7's own recent side (2024-2025) can sit inside the training window too.
- The blend's τ and residual deciles are fitted on TRAIN; A7's 2003-2015 side therefore favours the blend slightly.
- Persistence is reported for the MASE denominators only. The bar is the blend.
- 2 candidates have now been measured on the SAME TEST origins (timesfm-2.5-200m, timesfm-3.0). The clause thresholds were pre-registered for a single candidate; read the significances as 2 looks at one test set, not one.

