"""The measured set, the delivered set, and the regimes they vote in.

Always address a gauge by UUID: `KOBLENZ` on the Rhine is the one meant here,
while `Koblenz OP` / `Koblenz UP` sit on the Mosel and `Koblenz UP` is not even
a cm gauge. The three delivered Rhine gauges lie on 97 river-km of one chain
and carry practically the same signal, so in every cross-station clause they
form ONE regime (Mittelrhein) and cast one vote: the median of their skills.
"""
from __future__ import annotations

# uuid -> (name, regime)
STATIONS = {
    "a6ee8177-107b-47dd-bcfd-30960ccc6e9c": ("KÖLN", "Mittelrhein"),
    "593647aa-9fea-43ec-a7d6-6476a76ae868": ("BONN", "Mittelrhein"),
    "4c7d796a-39f2-4f26-97a9-3aad01713e29": ("KOBLENZ", "Mittelrhein"),
    "70272185-b2b3-4178-96b8-43bea330dcae": ("DRESDEN", "Elbe-kontinental"),
    "33ceb441-23bc-4ca6-9fcd-ac35d41ef117": ("PASSAU ILZSTADT", "Donau-alpin"),
    "fe72ee98-88e9-4d19-aba1-f97f61b7d4de": ("FREMERSDORF", "Saar-flashy"),
    "aad49293-242a-43ad-a8b1-e91d7792c4b2": ("CUXHAVEN STEUBENHÖFT", "Nordsee-tidal"),
}

REGIMES = ("Mittelrhein", "Elbe-kontinental", "Donau-alpin", "Saar-flashy", "Nordsee-tidal")

# the five series that are POOLED (one representative per regime); the other
# two Rhine gauges are reported per station and vote inside their regime only
POOLED = (
    "a6ee8177-107b-47dd-bcfd-30960ccc6e9c",
    "70272185-b2b3-4178-96b8-43bea330dcae",
    "33ceb441-23bc-4ca6-9fcd-ac35d41ef117",
    "fe72ee98-88e9-4d19-aba1-f97f61b7d4de",
    "aad49293-242a-43ad-a8b1-e91d7792c4b2",
)

DELIVERED = (
    "593647aa-9fea-43ec-a7d6-6476a76ae868",
    "4c7d796a-39f2-4f26-97a9-3aad01713e29",
    "a6ee8177-107b-47dd-bcfd-30960ccc6e9c",
)

# reference column only (plan §1c): the upstream gauge an OLS may read at the origin
UPSTREAM = {
    "a6ee8177-107b-47dd-bcfd-30960ccc6e9c": "b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea",  # KÖLN <- MAXAU
}

# the collector fetches the measured set, the delivered set and the upstream reference
COLLECTED = tuple(STATIONS) + tuple(UPSTREAM.values())


def regime_of(uuid: str) -> str:
    return STATIONS[uuid][1]


def name_of(uuid: str) -> str:
    return STATIONS.get(uuid, (uuid, None))[0]


# ---------- the NRW rain experiment (protocol `nrw`) ----------
# NOT a choice: the rule below was pre-registered before the first model run and
# the five gauges are what it selects, measured against the 2026-09-06 mirror.
#
#   S1  a candidate is a RECEIVING node (see scripts/build-nrw-precip.mjs) with
#       >= 725 stored days and an areal-rain set of >= 5 gauges
#   S2  per basin, the candidate with the largest catchment area
#   S3  the five basins whose set is largest
#
# 47 candidates in 7 basins on that mirror. ONE GAUGE PER BASIN is the point:
# the rain sets nest along a river, so two gauges of one river would share most
# of their rain and the five stations would not be five samples. Measured
# disjoint on 2026-09-06.
#
# The ERFT DROPS OUT by the rule, not by preference: it carries 14 gauges and
# three rain gauges, all in its north, and no Erft gauge reaches five. The report
# says so rather than leaving the river unmentioned.
#
# id -> (name, basin, catchment km2, rain gauges, MW cm as the operator states it)
NRW_STATIONS = {
    "2789770000100": ("Schermbeck_1", "Lippe", 4783.0, 32, 179),
    "2729100000100": ("Menden_1", "Sieg", 2825.0, 29, 66),
    "2829100000100": ("Stah", "Rur", 2135.15, 24, 65),
    "4670000000100": ("Loehne", "Weser", 1335.11, 22, 98),
    "2765590000100": ("Villigst", "Ruhr", 2012.76, 18, 136),
}

# every one of them is pooled: five basins, five votes, no representative
NRW_POOLED = tuple(NRW_STATIONS)


def nrw_name_of(no: str) -> str:
    return NRW_STATIONS.get(str(no), (str(no),))[0]


def nrw_basin_of(no: str) -> str:
    e = NRW_STATIONS.get(str(no))
    return e[1] if e else "?"


def nrw_mw_of(no: str):
    """The operator's own mean water level, in cm.

    An EXTERNAL number, not a constant fitted here: it is what makes `blend_mw` a
    baseline rather than a second model. 729 days of history cannot carry a
    climatology, so this stands in for one — and the report says that in as many
    words, because a latte the challenger is measured against has to be one a
    reader can check.
    """
    e = NRW_STATIONS.get(str(no))
    return None if e is None else float(e[4])
