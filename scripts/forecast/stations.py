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
