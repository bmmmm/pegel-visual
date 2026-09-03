# Forecast gate — seasonal / target max

Verdict: **NO-SHIP**

model timesfm-3.0 (timesfm-non-commercial-license-v1.0) · checkpoint google/timesfm-3.0-pytorch · config 9fc34ab62295c07f · timesfm 3.0.1 · torch 2.14.0 · git 9f30165 · 2026-09-03T13:38:44Z · 353.0 s · repeat identical: yes · tfm sha256 e261bcd714de0e0d · reproduced bit for bit by a second full run at 2026-09-03T13:44:58Z

> Measured, not shipped. These weights are licensed timesfm-non-commercial-license-v1.0 (https://huggingface.co/google/timesfm-3.0-pytorch/blob/main/LICENSE), which forbids redistribution and any commercial or production use — so this line can be measured here but can never become the model this GPL-3.0 repo ships, however it scores.

## Clauses

| clause | pass | detail |
|---|---|---|
| A1 | FAIL | {"h1-14": 0.07995582777274679, "h15-30": 0.023417569204391864, "h31-90": -0.001019898350845816} |
| A2 | FAIL | {"h1-14": {"positive": 4, "min": 0.0}, "h15-30": {"positive": 2, "min": -0.04988355521851062}, "h31-90": {"positive": 2, "min": -0.08725966083919001}} |
| A3 | FAIL | {"h1-14": 0.05753954683384421, "h15-30": -0.021480020477870104, "h31-90": -0.07210991202150763} |
| A4 | FAIL | {"h1-14": {"significant": 5, "stouffer_z": 9.258097657371346}, "h15-30": {"significant": 3, "stouffer_z": 4.242912208264602}, "h31-90": {"significant": 3, "stouffer_z": 2.780079061442726}} |
| A5 | PASS | {"h1-14": {"tfm": 0.7865001403311815, "blend": 0.8165310131911311, "ok": true}, "h15-30": {"tfm": 0.7861738703339882, "blend": 0.8179027504911591, "ok": true}, "h31-90": {"tfm": 0.7913425016371971, "blend": 0.8266273739358219, "ok": true}} |
| A6 | FAIL | {"h1-14": 0.08523204599026779, "h15-30": 0.007406456340493639, "h31-90": -0.06152454218398917} |
| A7 | PASS | {"ss_old_2003_2015": 0.09193292284055721, "ss_new_2024_2025": 0.10515998111170799} |

## Pooled (KÖLN, DRESDEN, PASSAU ILZSTADT, FREMERSDORF, CUXHAVEN STEUBENHÖFT, 509 TEST origins)

| block | SS vs blend | 95 % CI | PICP80 tfm / blend | CRPS tfm / blend | SS CRPS | pairs |
|---|---|---|---|---|---|---|
| h1-14 | 0.080 | [0.058, 0.103] | 0.787 / 0.817 | 25.3 / 27.7 | 0.085 | 35630 |
| h15-30 | 0.023 | [-0.021, 0.069] | 0.786 / 0.818 | 35.8 / 36.1 | 0.007 | 40720 |
| h31-90 | -0.001 | [-0.072, 0.070] | 0.791 / 0.827 | 40.3 / 37.9 | -0.062 | 152700 |

## Regimes (median of members; ties count as 0)

| regime | members | h1-14 SS / z / p | h15-30 SS / z / p | h31-90 SS / z / p |
|---|---|---|---|---|
| Mittelrhein | KÖLN, BONN, KOBLENZ | 0.056 / 3.08 / 0.001 | -0.050 / -1.49 / 0.932 | -0.087 / -1.85 / 0.968 |
| Elbe-kontinental | DRESDEN | 0.093 / 3.82 / 0.000 | 0.096 / 2.45 / 0.007 | 0.098 / 1.58 / 0.057 |
| Donau-alpin | PASSAU ILZSTADT | 0.066 / 3.16 / 0.001 | 0.000 / 0.25 / 0.402 | 0.000 / -0.43 / 0.667 |
| Saar-flashy | FREMERSDORF | 0.182 / 4.24 / 0.000 | 0.143 / 3.06 / 0.001 | 0.119 / 2.60 / 0.005 |
| Nordsee-tidal | CUXHAVEN STEUBENHÖFT | 0.000 / 6.41 / 0.000 | 0.000 / 5.22 / 0.000 | 0.000 / 4.32 / 0.000 |

## Stations (TEST origins, MAE in the gauge's cm)

### KÖLN — 509 TEST origins, τ = 40

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 63.8 | 102.8 | 145.9 | 61.4 | 59.5 | **58.0** | -3.4 | 0.056 | no | 0.84 | 0.045 | 0.75 | 3.13 (0.001, 641) |
| h15-30 | 101.5 | 102.4 | 146.3 | 89.7 | 89.9 | **94.2** | 4.5 | -0.050 | no | 0.95 | -0.062 | 0.75 | -1.49 (0.932, 212) |
| h31-90 | 135.0 | 101.9 | 145.7 | 100.5 | 100.6 | **109.1** | 8.6 | -0.086 | no | 0.88 | -0.129 | 0.75 | -1.85 (0.968, 79) |

PIT histogram h31-90: [4480, 2915, 2781, 2662, 2619, 2688, 2828, 3169, 3377, 3021]

### BONN — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 59.3 | 94.8 | 134.2 | 57.1 | — | **53.9** | -3.2 | 0.056 | no | 0.84 | 0.048 | 0.76 | 3.08 (0.001, 613) |
| h15-30 | 93.8 | 94.5 | 134.6 | 83.0 | — | **87.1** | 4.1 | -0.050 | no | 0.94 | -0.062 | 0.75 | -1.49 (0.932, 214) |
| h31-90 | 124.3 | 94.0 | 134.0 | 92.9 | — | **101.0** | 8.1 | -0.087 | no | 0.88 | -0.131 | 0.76 | -1.85 (0.968, 80) |

PIT histogram h31-90: [4461, 2992, 2762, 2726, 2653, 2627, 2827, 3200, 3347, 2945]

### KOBLENZ — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 53.7 | 83.7 | 120.1 | 51.6 | — | **48.8** | -2.7 | 0.053 | no | 0.85 | 0.048 | 0.76 | 3.06 (0.001, 674) |
| h15-30 | 84.1 | 83.4 | 120.4 | 73.9 | — | **78.0** | 4.1 | -0.056 | no | 0.95 | -0.063 | 0.75 | -1.71 (0.956, 226) |
| h31-90 | 110.7 | 83.0 | 119.8 | 82.3 | — | **90.0** | 7.7 | -0.094 | no | 0.88 | -0.131 | 0.77 | -2.00 (0.977, 81) |

PIT histogram h31-90: [4223, 2860, 2865, 2739, 2695, 2606, 2920, 3329, 3422, 2881]

### DRESDEN — 509 TEST origins, τ = 48

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 31.1 | 63.6 | 66.8 | 30.7 | — | **27.9** | -2.9 | 0.093 | no | 0.64 | 0.072 | 0.79 | 3.82 (0.000, 402) |
| h15-30 | 52.5 | 63.4 | 66.5 | 49.5 | — | **44.7** | -4.8 | 0.096 | no | 0.63 | 0.038 | 0.78 | 2.45 (0.007, 201) |
| h31-90 | 71.7 | 63.2 | 66.2 | 58.7 | — | **52.9** | -5.8 | 0.098 | no | 0.59 | -0.046 | 0.78 | 1.58 (0.057, 81) |

PIT histogram h31-90: [2454, 3181, 3008, 2705, 2708, 2779, 2694, 2710, 3917, 4384]

### PASSAU ILZSTADT — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 36.6 | 48.2 | 67.1 | 34.0 | — | **31.8** | -2.2 | 0.066 | no | 0.81 | 0.080 | 0.80 | 3.16 (0.001, 556) |
| h15-30 | 51.0 | 48.4 | 67.4 | 43.7 | — | **43.4** | -0.3 | 0.008 | yes | 0.78 | -0.018 | 0.80 | 0.25 (0.402, 262) |
| h31-90 | 63.9 | 47.8 | 66.7 | 47.2 | — | **48.2** | 1.0 | -0.021 | yes | 0.75 | -0.085 | 0.81 | -0.43 (0.667, 79) |

PIT histogram h31-90: [2212, 2934, 2565, 2748, 2785, 2963, 3149, 3527, 4189, 3468]

### FREMERSDORF — 509 TEST origins, τ = 31

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 19.8 | 18.9 | 25.9 | 18.0 | — | **14.7** | -3.3 | 0.182 | no | 0.72 | 0.239 | 0.79 | 4.24 (0.000, 495) |
| h15-30 | 24.2 | 18.9 | 25.7 | 19.8 | — | **17.0** | -2.8 | 0.143 | no | 0.71 | 0.175 | 0.78 | 3.06 (0.001, 355) |
| h31-90 | 26.3 | 18.5 | 25.5 | 18.9 | — | **16.7** | -2.3 | 0.119 | no | 0.63 | 0.100 | 0.79 | 2.60 (0.005, 99) |

PIT histogram h31-90: [2347, 2737, 2891, 3172, 3186, 3105, 3087, 3077, 2997, 3941]

### CUXHAVEN STEUBENHÖFT — 509 TEST origins, τ = 2

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 37.0 | 27.4 | 41.1 | 26.6 | — | **24.8** | -1.9 | 0.070 | yes | 0.68 | 0.078 | 0.80 | 6.41 (0.000, 295) |
| h15-30 | 39.1 | 27.5 | 41.1 | 27.5 | — | **25.6** | -1.9 | 0.070 | yes | 0.65 | 0.078 | 0.82 | 5.22 (0.000, 181) |
| h31-90 | 40.6 | 27.2 | 41.0 | 27.2 | — | **25.8** | -1.4 | 0.050 | yes | 0.63 | 0.057 | 0.82 | 4.32 (0.000, 85) |

PIT histogram h31-90: [2556, 3372, 2979, 3021, 3062, 2923, 3122, 3170, 3336, 2999]

## Befund 2 — climatology vs blend (SS of plain climatology against the blend)

| block | KÖLN | BONN | KOBLENZ | DRESDEN | PASSAU ILZSTADT | FREMERSDORF | CUXHAVEN STEUBENHÖFT |
|---|---|---|---|---|---|---|---|
| h1-14 | -0.673 | -0.661 | -0.623 | -1.069 | -0.415 | -0.054 | -0.028 |
| h15-30 | -0.141 | -0.139 | -0.129 | -0.282 | -0.108 | 0.049 | -0.000 |
| h31-90 | -0.014 | -0.013 | -0.008 | -0.077 | -0.013 | 0.021 | -0.000 |

## Caveats

- TimesFM 2.5 has no published corpus manifest; PEGELONLINE is open and CAMELS-DE (2024) covers German basins. Assume 2000-2024 MAY be in the training data. A7 is a probe, not a proof.
- The blend's τ and residual deciles are fitted on TRAIN; A7's 2003-2015 side therefore favours the blend slightly.
- Persistence is reported for the MASE denominators only. The bar is the blend.
- 2 candidates have now been measured on the SAME TEST origins (timesfm-2.5-200m, timesfm-3.0). The clause thresholds were pre-registered for a single candidate; read the significances as 2 looks at one test set, not one.

