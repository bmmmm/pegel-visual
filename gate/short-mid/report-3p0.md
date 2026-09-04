# Forecast gate — short horizon (15-minute grid)

Verdict: **PROVISIONAL**

> Measured, not shipped. These weights are licensed timesfm-non-commercial-license-v1.0 (https://huggingface.co/google/timesfm-3.0-pytorch/blob/main/LICENSE), which forbids redistribution and any commercial or production use — so this line can be measured here but can never become the model this GPL-3.0 repo ships, however it scores.

PROVISIONAL — cannot be SHIP before:
- KÖLN: 10/60 origins
- BONN: 10/60 origins
- KOBLENZ: 10/60 origins
- DRESDEN: 10/60 origins
- PASSAU ILZSTADT: 10/60 origins
- FREMERSDORF: 10/60 origins
- CUXHAVEN STEUBENHÖFT: 10/60 origins

| station | origins | rises | block | persist | snaive24h | drift | tidal | TimesFM | best baseline | SS vs best |
|---|---|---|---|---|---|---|---|---|---|---|
| KÖLN | 10 | 3 | h1-6h | 1.2 | 4.4 | 0.9 | — | 0.9 | drift | 0.005 |
| KÖLN | 10 | 3 | h6-24h | 5.4 | 5.9 | 4.8 | — | 4.9 | drift | -0.020 |
| KÖLN | 10 | 3 | h24-48h | 11.5 | 11.7 | 11.0 | — | 11.4 | drift | -0.039 |
| BONN | 10 | 3 | h1-6h | 1.1 | 3.9 | 0.8 | — | 0.8 | drift | 0.014 |
| BONN | 10 | 3 | h6-24h | 4.6 | 6.7 | 4.0 | — | 4.5 | drift | -0.124 |
| BONN | 10 | 3 | h24-48h | 8.1 | 10.4 | 7.4 | — | 8.1 | drift | -0.103 |
| KOBLENZ | 10 | 4 | h1-6h | 2.4 | 10.0 | 2.9 | — | 2.5 | persist | -0.026 |
| KOBLENZ | 10 | 4 | h6-24h | 4.0 | 7.5 | 5.0 | — | 4.3 | persist | -0.075 |
| KOBLENZ | 10 | 4 | h24-48h | 5.2 | 10.0 | 5.0 | — | 6.9 | drift | -0.378 |
| DRESDEN | 10 | 4 | h1-6h | 3.7 | 13.2 | 2.6 | — | 1.9 | drift | 0.254 |
| DRESDEN | 10 | 4 | h6-24h | 8.8 | 11.4 | 7.1 | — | 6.6 | drift | 0.072 |
| DRESDEN | 10 | 4 | h24-48h | 11.3 | 14.9 | 10.6 | — | 12.4 | drift | -0.166 |
| PASSAU ILZSTADT | 10 | 3 | h1-6h | 4.9 | 5.1 | 6.9 | — | 2.7 | persist | 0.455 |
| PASSAU ILZSTADT | 10 | 3 | h6-24h | 8.6 | 6.1 | 11.4 | — | 5.8 | snaive | 0.034 |
| PASSAU ILZSTADT | 10 | 3 | h24-48h | 10.4 | 8.4 | 13.0 | — | 9.8 | snaive | -0.165 |
| FREMERSDORF | 10 | 10 | h1-6h | 2.4 | 3.6 | 3.3 | — | 2.4 | persist | 0.003 |
| FREMERSDORF | 10 | 10 | h6-24h | 3.8 | 3.3 | 5.4 | — | 2.3 | snaive | 0.306 |
| FREMERSDORF | 10 | 10 | h24-48h | 4.3 | 3.9 | 5.7 | — | 2.9 | snaive | 0.253 |
| CUXHAVEN STEUBENHÖFT | 10 | 5 | h1-6h | 115.4 | 39.4 | 106.0 | 27.9 | 10.9 | tidal | 0.609 |
| CUXHAVEN STEUBENHÖFT | 10 | 5 | h6-24h | 110.5 | 35.9 | 171.8 | 27.6 | 17.4 | tidal | 0.371 |
| CUXHAVEN STEUBENHÖFT | 10 | 5 | h24-48h | 112.0 | 68.4 | 163.8 | 30.3 | 26.3 | tidal | 0.132 |

collected: KÖLN: 3060 steps; BONN: 3060 steps; KOBLENZ: 3060 steps; DRESDEN: 3060 steps; PASSAU ILZSTADT: 3060 steps; FREMERSDORF: 3060 steps; CUXHAVEN STEUBENHÖFT: 3059 steps

## Caveats

- 2 candidates have now been measured on the SAME TEST origins (timesfm-2.5-200m, timesfm-3.0). The clause thresholds were pre-registered for a single candidate; read the significances as 2 looks at one test set, not one.

