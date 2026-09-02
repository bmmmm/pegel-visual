# Forecast gate — short horizon (15-minute grid)

Verdict: **PROVISIONAL**

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
| KÖLN | 10 | 3 | h1-6h | 1.2 | 4.4 | 0.9 | — | 1.0 | drift | -0.068 |
| KÖLN | 10 | 3 | h6-24h | 5.4 | 5.9 | 4.8 | — | 5.0 | drift | -0.041 |
| KÖLN | 10 | 3 | h24-48h | 11.5 | 11.7 | 11.0 | — | 10.8 | drift | 0.016 |
| BONN | 10 | 3 | h1-6h | 1.1 | 3.9 | 0.8 | — | 0.9 | drift | -0.091 |
| BONN | 10 | 3 | h6-24h | 4.6 | 6.7 | 4.0 | — | 4.6 | drift | -0.140 |
| BONN | 10 | 3 | h24-48h | 8.1 | 10.4 | 7.4 | — | 7.2 | drift | 0.016 |
| KOBLENZ | 10 | 4 | h1-6h | 2.4 | 10.0 | 2.9 | — | 2.4 | persist | 0.011 |
| KOBLENZ | 10 | 4 | h6-24h | 4.0 | 7.5 | 5.0 | — | 3.8 | persist | 0.045 |
| KOBLENZ | 10 | 4 | h24-48h | 5.2 | 10.0 | 5.0 | — | 5.2 | drift | -0.033 |
| DRESDEN | 10 | 4 | h1-6h | 3.7 | 13.2 | 2.6 | — | 3.1 | drift | -0.188 |
| DRESDEN | 10 | 4 | h6-24h | 8.8 | 11.4 | 7.1 | — | 8.8 | drift | -0.233 |
| DRESDEN | 10 | 4 | h24-48h | 11.3 | 14.9 | 10.6 | — | 11.9 | drift | -0.125 |
| PASSAU ILZSTADT | 10 | 3 | h1-6h | 4.9 | 5.1 | 6.9 | — | 3.1 | persist | 0.368 |
| PASSAU ILZSTADT | 10 | 3 | h6-24h | 8.6 | 6.1 | 11.4 | — | 7.1 | snaive | -0.165 |
| PASSAU ILZSTADT | 10 | 3 | h24-48h | 10.4 | 8.4 | 13.0 | — | 10.0 | snaive | -0.192 |
| FREMERSDORF | 10 | 10 | h1-6h | 2.4 | 3.6 | 3.3 | — | 2.4 | persist | 0.011 |
| FREMERSDORF | 10 | 10 | h6-24h | 3.8 | 3.3 | 5.4 | — | 2.4 | snaive | 0.262 |
| FREMERSDORF | 10 | 10 | h24-48h | 4.3 | 3.9 | 5.7 | — | 2.9 | snaive | 0.263 |
| CUXHAVEN STEUBENHÖFT | 10 | 5 | h1-6h | 115.4 | 39.4 | 106.0 | 27.9 | 12.2 | tidal | 0.562 |
| CUXHAVEN STEUBENHÖFT | 10 | 5 | h6-24h | 110.5 | 35.9 | 171.8 | 27.6 | 20.4 | tidal | 0.263 |
| CUXHAVEN STEUBENHÖFT | 10 | 5 | h24-48h | 112.0 | 68.4 | 163.8 | 30.3 | 26.7 | tidal | 0.120 |

collected: KÖLN: 3058 steps; BONN: 3058 steps; KOBLENZ: 3058 steps; DRESDEN: 3058 steps; PASSAU ILZSTADT: 3058 steps; FREMERSDORF: 3058 steps; CUXHAVEN STEUBENHÖFT: 3058 steps

