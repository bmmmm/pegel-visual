# Forecast gate — seasonal / target max

Verdict: **NO-SHIP**

model timesfm-2.5-200m (Apache-2.0) · checkpoint google/timesfm-2.5-200m-pytorch · config 362b77bd29350df5 · timesfm 2.0.2 · torch 2.14.0 · git 2247d9c · 2026-09-02T19:46:59Z · 263.9 s · repeat identical: yes · tfm sha256 818cc1cb1bee1601 · second full run: not compared

## Clauses

| clause | pass | detail |
|---|---|---|
| A1 | FAIL | {"h1-14": 0.07154454712963454, "h15-30": 0.022002268059296393, "h31-90": -0.027786095225216467} |
| A2 | FAIL | {"h1-14": {"positive": 4, "min": 0.0}, "h15-30": {"positive": 2, "min": -0.03241271751496888}, "h31-90": {"positive": 2, "min": -0.10296785766808192}} |
| A3 | FAIL | {"h1-14": 0.051588587388657875, "h15-30": -0.024333924988255484, "h31-90": -0.10077228532849604} |
| A4 | FAIL | {"h1-14": {"significant": 5, "stouffer_z": 8.17682699148439}, "h15-30": {"significant": 3, "stouffer_z": 3.4460373714294703}, "h31-90": {"significant": 2, "stouffer_z": 1.5314121883759972}} |
| A5 | PASS | {"h1-14": {"tfm": 0.803957339320797, "blend": 0.8165310131911311, "ok": true}, "h15-30": {"tfm": 0.7851178781925344, "blend": 0.8179027504911591, "ok": true}, "h31-90": {"tfm": 0.7871709233791748, "blend": 0.8266273739358219, "ok": true}} |
| A6 | FAIL | {"h1-14": 0.07514528708823343, "h15-30": -0.001968756466342203, "h31-90": -0.09409679690189732} |
| A7 | PASS | {"ss_old_2003_2015": 0.08215942710015978, "ss_new_2024_2025": 0.09690915065207073} |

## Pooled (KÖLN, DRESDEN, PASSAU ILZSTADT, FREMERSDORF, CUXHAVEN STEUBENHÖFT, 509 TEST origins)

| block | SS vs blend | 95 % CI | PICP80 tfm / blend | CRPS tfm / blend | SS CRPS | pairs |
|---|---|---|---|---|---|---|
| h1-14 | 0.072 | [0.052, 0.093] | 0.804 / 0.817 | 25.6 / 27.7 | 0.075 | 35630 |
| h15-30 | 0.022 | [-0.024, 0.068] | 0.785 / 0.818 | 36.2 / 36.1 | -0.002 | 40720 |
| h31-90 | -0.028 | [-0.101, 0.046] | 0.787 / 0.827 | 41.5 / 37.9 | -0.094 | 152700 |

## Regimes (median of members; ties count as 0)

| regime | members | h1-14 SS / z / p | h15-30 SS / z / p | h31-90 SS / z / p |
|---|---|---|---|---|
| Mittelrhein | KÖLN, BONN, KOBLENZ | 0.059 / 3.80 / 0.000 | -0.032 / -1.03 / 0.848 | -0.103 / -2.19 / 0.986 |
| Elbe-kontinental | DRESDEN | 0.073 / 2.87 / 0.002 | 0.081 / 1.87 / 0.031 | 0.043 / 0.65 / 0.257 |
| Donau-alpin | PASSAU ILZSTADT | 0.062 / 2.87 / 0.002 | 0.000 / 0.27 / 0.392 | 0.000 / -0.48 / 0.684 |
| Saar-flashy | FREMERSDORF | 0.175 / 4.19 / 0.000 | 0.141 / 2.88 / 0.002 | 0.107 / 2.24 / 0.013 |
| Nordsee-tidal | CUXHAVEN STEUBENHÖFT | 0.000 / 4.55 / 0.000 | 0.000 / 3.71 / 0.000 | 0.000 / 3.20 / 0.001 |

## Stations (TEST origins, MAE in the gauge's cm)

### KÖLN — 509 TEST origins, τ = 40

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 63.8 | 102.8 | 145.9 | 61.4 | 59.5 | **57.8** | -3.6 | 0.059 | no | 0.84 | 0.046 | 0.82 | 3.75 (0.000, 626) |
| h15-30 | 101.5 | 102.4 | 146.3 | 89.7 | 89.9 | **92.9** | 3.2 | -0.036 | no | 0.93 | -0.064 | 0.79 | -1.11 (0.866, 241) |
| h31-90 | 135.0 | 101.9 | 145.7 | 100.5 | 100.6 | **111.5** | 11.0 | -0.109 | no | 0.90 | -0.167 | 0.78 | -2.28 (0.989, 84) |

PIT histogram h31-90: [3279, 3006, 2740, 2987, 3016, 3136, 3057, 3155, 2738, 3426]

### BONN — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 59.3 | 94.8 | 134.2 | 57.1 | — | **53.7** | -3.4 | 0.059 | no | 0.84 | 0.049 | 0.83 | 3.80 (0.000, 658) |
| h15-30 | 93.8 | 94.5 | 134.6 | 83.0 | — | **85.7** | 2.7 | -0.032 | no | 0.93 | -0.059 | 0.79 | -1.03 (0.848, 245) |
| h31-90 | 124.3 | 94.0 | 134.0 | 92.9 | — | **102.4** | 9.6 | -0.103 | no | 0.89 | -0.162 | 0.78 | -2.19 (0.986, 84) |

PIT histogram h31-90: [3303, 2982, 2737, 2994, 3062, 3172, 3030, 3174, 2715, 3371]

### KOBLENZ — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 53.7 | 83.7 | 120.1 | 51.6 | — | **48.6** | -3.0 | 0.057 | no | 0.85 | 0.053 | 0.83 | 4.03 (0.000, 749) |
| h15-30 | 84.1 | 83.4 | 120.4 | 73.9 | — | **75.9** | 2.0 | -0.028 | no | 0.92 | -0.050 | 0.80 | -0.90 (0.817, 258) |
| h31-90 | 110.7 | 83.0 | 119.8 | 82.3 | — | **90.0** | 7.7 | -0.094 | no | 0.88 | -0.151 | 0.79 | -2.02 (0.978, 87) |

PIT histogram h31-90: [3210, 2899, 2611, 3036, 3235, 3295, 3201, 3109, 2664, 3280]

### DRESDEN — 509 TEST origins, τ = 48

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 31.1 | 63.6 | 66.8 | 30.7 | — | **28.5** | -2.2 | 0.073 | no | 0.66 | 0.052 | 0.80 | 2.87 (0.002, 361) |
| h15-30 | 52.5 | 63.4 | 66.5 | 49.5 | — | **45.5** | -4.0 | 0.081 | no | 0.64 | 0.015 | 0.77 | 1.87 (0.031, 181) |
| h31-90 | 71.7 | 63.2 | 66.2 | 58.7 | — | **56.2** | -2.5 | 0.043 | no | 0.63 | -0.101 | 0.75 | 0.65 (0.257, 81) |

PIT histogram h31-90: [3248, 3059, 2965, 2841, 2676, 2454, 2532, 2803, 3702, 4260]

### PASSAU ILZSTADT — 509 TEST origins, τ = 41

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 36.6 | 48.2 | 67.1 | 34.0 | — | **31.9** | -2.1 | 0.062 | no | 0.82 | 0.077 | 0.81 | 2.87 (0.002, 580) |
| h15-30 | 51.0 | 48.4 | 67.4 | 43.7 | — | **43.3** | -0.4 | 0.010 | yes | 0.78 | -0.009 | 0.78 | 0.27 (0.392, 228) |
| h31-90 | 63.9 | 47.8 | 66.7 | 47.2 | — | **48.5** | 1.3 | -0.029 | yes | 0.75 | -0.090 | 0.79 | -0.48 (0.684, 74) |

PIT histogram h31-90: [1912, 2738, 2446, 2449, 2697, 2908, 3191, 3627, 4068, 4504]

### FREMERSDORF — 509 TEST origins, τ = 31

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 19.8 | 18.9 | 25.9 | 18.0 | — | **14.8** | -3.1 | 0.175 | no | 0.72 | 0.222 | 0.79 | 4.19 (0.000, 492) |
| h15-30 | 24.2 | 18.9 | 25.7 | 19.8 | — | **17.0** | -2.8 | 0.141 | no | 0.71 | 0.157 | 0.78 | 2.88 (0.002, 338) |
| h31-90 | 26.3 | 18.5 | 25.5 | 18.9 | — | **16.9** | -2.0 | 0.107 | no | 0.64 | 0.073 | 0.79 | 2.24 (0.013, 98) |

PIT histogram h31-90: [1877, 2353, 2768, 2986, 3370, 3423, 3525, 3222, 2583, 4433]

### CUXHAVEN STEUBENHÖFT — 509 TEST origins, τ = 2

| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| h1-14 | 37.0 | 27.4 | 41.1 | 26.6 | — | **25.5** | -1.1 | 0.041 | yes | 0.70 | 0.051 | 0.80 | 4.55 (0.000, 277) |
| h15-30 | 39.1 | 27.5 | 41.1 | 27.5 | — | **26.5** | -1.0 | 0.037 | yes | 0.67 | 0.046 | 0.80 | 3.71 (0.000, 214) |
| h31-90 | 40.6 | 27.2 | 41.0 | 27.2 | — | **26.4** | -0.8 | 0.029 | yes | 0.65 | 0.038 | 0.82 | 3.20 (0.001, 79) |

PIT histogram h31-90: [2713, 3165, 3084, 2960, 2988, 3356, 3406, 3063, 2958, 2847]

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

