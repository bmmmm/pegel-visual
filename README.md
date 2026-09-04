# pegel-visual archive data

This branch carries only data: the historical water-level archive for the
PEGELONLINE station set — most stations from WSV (raw values since
2000-01-01), ten Dutch gauges from Rijkswaterstaat (raw values back to
~1989) — condensed to daily min/max per station and year by
`scripts/fetch-wsv-archive.mjs` and `scripts/fetch-rws-archive.mjs` on
`main`.

Layout: `archive/<station-uuid>/closed.json` (one immutable bundle of all
completed years, `[{y, min[], max[]}, …]`, extended only by the January
freeze), `current.json` (running year, refreshed monthly by the
`archive-update` workflow) and `meta.json` (station name, resume marker, and
`noArchive` where the WSV download endpoint has said it keeps no series for
this gauge). `archive/manifest.json` maps every station to its year range
(`from`/`to`, plus a `gaps` day count as inspection metadata), marks it `none`
when there is no data file at all, and carries `noArchive` through from
`meta.json`.

Those last two are different claims and both are needed: `none` is about this
branch (nothing here), `noArchive` is about WSV (nothing there, ever). A gauge
can be `noArchive` and still hold a running year — the REST refresh reaches
~31 days back and accumulates, so the record grows forward from the day we
first caught it and can never reach further back.

Data: © Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV),
provided as unvalidated raw data under
[DL-DE→Zero-2.0](https://www.govdata.de/dl-de/zero-2-0). Outliers and
gaps are possible.

The `pages` workflow merges this branch's `archive/` directory into the
deployed site.

## Sources & attribution

Most stations come from **WSV** (© Wasserstraßen- und Schifffahrtsverwaltung
des Bundes), DL-DE->Zero-2.0, condensed by scripts/fetch-wsv-archive.mjs.

Ten Dutch gauges PEGELONLINE relays live but WSV keeps no multi-year archive
for are backed by **Rijkswaterstaat** instead (source:"Rijkswaterstaat" in the
manifest), condensed by scripts/fetch-rws-archive.mjs from the Rijkswaterstaat
DD-API, raw values back to ~1989. Rijkswaterstaat water data is CC0 (public
domain, no attribution required); attributed here for transparency. Values are
cm relative to NAP and verified seamless with the live PEGELONLINE feed (median
offset 0 cm), so no datum shift is applied.

| WSV station | Water | Rijkswaterstaat location |
|---|---|---|
| LOBITH | RHEIN | lobith.bovenrijn.tolkamer |
| PANNERDENSE KOP | RHEIN | millingenaanderijn.pannerdensekop |
| TIEL | WAAL | tiel.waal (+ historical tiel.sluis.waal) |
| VUREN | WAAL | dalem ("voorheen Vuren") |
| ZALTBOMMEL | WAAL | zaltbommel |
| NIJMEGEN HAVEN | WAAL | nijmegen.waal ("voorheen Nijmegen haven") |
| IJSSELKOP | IJSSEL | westervoort.ijsselkop |
| DORDRECHT | ALTE_MAAS | dordrecht.oudemaas.benedenmerwede |
| KRIMPEN | LEK | krimpenaandelek.lek |
| ROTTERDAM | NEUE_MAAS | rotterdam.nieuwemaas.boerengat |

## Stations without a WSV archive (111 of 739)

These stations are marked `noArchive` in `archive/manifest.json` — WSV keeps no
pre-30-day history for them (lock/weir operating gauges, foreign partner
gauges, some harbor and barrage gauges; re-verified individually). The page
falls back to the live API for them, and says so on the plate instead of
offering an archive import that cannot deliver.

Until 2026-09-04 the marker was `none`, derived from the file listing — so the
weekly REST refresh erased it simply by writing these gauges a `current.json`,
and the count here read 0. The verdict is a recorded fact now (the endpoint's
303), and `R7` in `check-archive-consistency.mjs` goes red if it stops being
one. Keep this list in step with the manifest; it is maintained by hand.

| Water | Stations |
|---|---|
| NECKAR (30) | Aldingen Schleuse UP, Besigheim Schleuse UP, Besigheim Wehr UP, Cannstatt Schleuse UP, Deizisau Schleuse UP, Esslingen Schleuse UP, Esslingen Wehr OP, Feudenheim Schleuse UP, Guttenbach Schleuse UP, Hassmersheim AMS, Heilbronn Schleuse UP, Hirschhorn Schleuse UP, Hofen Schleuse UP, Horkheim Schleuse UP, Horkheim Wehr UP, Kochendorf Schleuse UP, Ladenburg Wehr UP, Lauffen Schleuse UP, Marbach Schleuse UP, Neckargemünd Schleuse UP, Neckarsteinach Schleuse UP, Neckarsulm Wehr UP, Neckarzimmern Schleuse UP, Oberesslingen Schleuse UP, Oberesslingen Wehr UP, Pleidelsheim Schleuse UP, Rockenau Schleuse UP, Schwabenheim Schleuse UP, Untertürkheim Schleuse UP, Wieblingen Wehr UP neu |
| LAHN (14) | Diez Schleuse OP, Diez Schleuse UP, Fürfurt Schleuse UP, Hollerich Schleuse OP, Hollerich Schleuse UP, Kalkofen Schleuse OP, Lahnstein Schleuse OP, Marburg, Nassau Schleuse OP, Nassau Schleuse UP, Niederbiel Schleuse Kanal OP, Runkel Schleuse UP, Scheidt Schleuse OP, Scheidt Schleuse UP |
| DONAU (11) | ACHLEITEN, DÜRNSTEIN, GREIN, INGOLSTADT LUITPOLDSTRASSE, KELHEIM DONAU, KIENSTOCK, KORNEUBURG, MAUTHAUSEN, THEBNERSTRASSL, WILDUNGSMAUER, WILHERING |
| MOSEL (11) | Enkirch OP, Grevenmacher OP, Grevenmacher UP, Lehmen OP, Mehring AMS, Müden OP, Sankt Aldegund OP, Stadtbredimus OP, Stadtbredimus UP, Trier OP, Zeltingen OP |
| SAAR (11) | Güdingen OP, Kanzem OP, Kanzem UP, Lisdorf OP, Mettlach OP, Rehlingen OP, Saarbrücken OP, Saarbrücken UP, Schoden OP, Schoden SKA, Serrig OP |
| ELBE (6) | BLANKENESE UF, BUNTHAUS, HAMBURG ST. PAULI, HAMBURG-HARBURG, SCHÖPFSTELLE, SEEMANNSHÖFT |
| RHEIN (3) | Basel-Rheinhalle, KONSTANZ-RHEIN, Neuwied Stadt |
| MHW (4) | Diemitz OP, Diemitz UP, Strasen OP, Strasen UP |
| WDK (3) | FLAESHEIM SCHLEUSE OW, FLAESHEIM SCHLEUSE UW, HÜNXE SCHLEUSE OW |
| EMS (3) | Rühle, VERSEN WEHR OP, Wachendorf |
| RUHR (2) | Hattingen, RUHRWEHR OW |
| OSTE (2) | OSTE-SPERRWERK AP, OSTE-SPERRWERK BP |
| EHK (2) | Roßdorf, Schlagenthiner Stremme |
| ELK (1) | DONNERSCHLEUSE OP |
| ESTE (1) | ESTE INNERES SPERRWERK AP |
| ILMENAU (1) | FAHRENHOLZ OP |
| KÜSTENKANAL (1) | Hilkenbrook |
| BODENSEE (1) | KONSTANZ |
| OSTSEE (1) | Prerow |
| DEK (2) | GROPPENBRUCH, VERSEN TRENNSPITZE |
| MLK (1) | WARBER GRABEN |
