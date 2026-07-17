# pegel-visual archive data

This branch carries only data: the WSV/PEGELONLINE historical water-level
archive (raw values since 2000-01-01), condensed to daily min/max per
station and year by `scripts/fetch-wsv-archive.mjs` on `main`.

Layout: `archive/<station-uuid>/closed.json` (one immutable bundle of all
completed years, `[{y, min[], max[]}, …]`, extended only by the January
freeze), `current.json` (running year, refreshed monthly by the
`archive-update` workflow) and `meta.json` (station name + resume marker).
`archive/manifest.json` maps every station to its year range (`from`/`to`,
plus a `gaps` day count as inspection metadata) or marks it `none`.

Data: © Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV),
provided as unvalidated raw data under
[DL-DE→Zero-2.0](https://www.govdata.de/dl-de/zero-2-0). Outliers and
gaps are possible.

The `pages` workflow merges this branch's `archive/` directory into the
deployed site.

## Stations without a WSV archive (120 of 738)

These stations are marked `none` in `archive/manifest.json` — WSV keeps no
pre-30-day history for them (lock/weir operating gauges, foreign partner
gauges, some harbor and barrage gauges; re-verified individually). The page
falls back to the live API for them.

| Water | Stations |
|---|---|
| NECKAR (30) | Aldingen Schleuse UP, Besigheim Schleuse UP, Besigheim Wehr UP, Cannstatt Schleuse UP, Deizisau Schleuse UP, Esslingen Schleuse UP, Esslingen Wehr OP, Feudenheim Schleuse UP, Guttenbach Schleuse UP, Hassmersheim AMS, Heilbronn Schleuse UP, Hirschhorn Schleuse UP, Hofen Schleuse UP, Horkheim Schleuse UP, Horkheim Wehr UP, Kochendorf Schleuse UP, Ladenburg Wehr UP, Lauffen Schleuse UP, Marbach Schleuse UP, Neckargemünd Schleuse UP, Neckarsteinach Schleuse UP, Neckarsulm Wehr UP, Neckarzimmern Schleuse UP, Oberesslingen Schleuse UP, Oberesslingen Wehr UP, Pleidelsheim Schleuse UP, Rockenau Schleuse UP, Schwabenheim Schleuse UP, Untertürkheim Schleuse UP, Wieblingen Wehr UP neu |
| LAHN (14) | Diez Schleuse OP, Diez Schleuse UP, Fürfurt Schleuse UP, Hollerich Schleuse OP, Hollerich Schleuse UP, Kalkofen Schleuse OP, Lahnstein Schleuse OP, Marburg, Nassau Schleuse OP, Nassau Schleuse UP, Niederbiel Schleuse Kanal OP, Runkel Schleuse UP, Scheidt Schleuse OP, Scheidt Schleuse UP |
| DONAU (11) | ACHLEITEN, DÜRNSTEIN, GREIN, INGOLSTADT LUITPOLDSTRASSE, KELHEIM DONAU, KIENSTOCK, KORNEUBURG, MAUTHAUSEN, THEBNERSTRASSL, WILDUNGSMAUER, WILHERING |
| MOSEL (11) | Enkirch OP, Grevenmacher OP, Grevenmacher UP, Lehmen OP, Mehring AMS, Müden OP, Sankt Aldegund OP, Stadtbredimus OP, Stadtbredimus UP, Trier OP, Zeltingen OP |
| SAAR (11) | Güdingen OP, Kanzem OP, Kanzem UP, Lisdorf OP, Mettlach OP, Rehlingen OP, Saarbrücken OP, Saarbrücken UP, Schoden OP, Schoden SKA, Serrig OP |
| ELBE (6) | BLANKENESE UF, BUNTHAUS, HAMBURG ST. PAULI, HAMBURG-HARBURG, SCHÖPFSTELLE, SEEMANNSHÖFT |
| RHEIN (5) | Basel-Rheinhalle, KONSTANZ-RHEIN, LOBITH, Neuwied Stadt, PANNERDENSE KOP |
| MHW (4) | Diemitz OP, Diemitz UP, Strasen OP, Strasen UP |
| WAAL (4) | NIJMEGEN HAVEN, TIEL, VUREN, ZALTBOMMEL |
| WDK (3) | FLAESHEIM SCHLEUSE OW, FLAESHEIM SCHLEUSE UW, HÜNXE SCHLEUSE OW |
| EMS (3) | Rühle, VERSEN WEHR OP, Wachendorf |
| RUHR (2) | Hattingen, RUHRWEHR OW |
| OSTE (2) | OSTE-SPERRWERK AP, OSTE-SPERRWERK BP |
| EHK (2) | Roßdorf, Schlagenthiner Stremme |
| ELK (1) | DONNERSCHLEUSE OP |
| ALTE_MAAS (1) | DORDRECHT |
| ESTE (1) | ESTE INNERES SPERRWERK AP |
| ILMENAU (1) | FAHRENHOLZ OP |
| KÜSTENKANAL (1) | Hilkenbrook |
| IJSSEL (1) | IJSSELKOP |
| BODENSEE (1) | KONSTANZ |
| LEK (1) | KRIMPEN |
| OSTSEE (1) | Prerow |
| NEUE_MAAS (1) | ROTTERDAM |
| DEK (1) | VERSEN TRENNSPITZE |
| MLK (1) | WARBER GRABEN |
