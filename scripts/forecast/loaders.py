"""Archive -> daily series, and the window/split logic every backtest shares.

The daily archive (one `closed.json` per station, see scripts/fetch-wsv-archive.mjs)
stores per-day MIN and MAX in cm, indexed by MEZ day-of-year. Only closed years
are used here: the running year (`current.json`) is holey in a systematic way
(only the months a --current run covered) and gets rewritten by the January ZIP
freeze, so a gate built on it would not reproduce.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Three copies of these bounds exist on purpose — scripts/fetch-wsv-archive.mjs:182
# (the fetcher), scripts/build-river-totals.mjs:81 (the totals) and this one —
# because neither side has a runtime to import the other from. Change all three.
PLAUSIBLE_MIN_CM = -2000
PLAUSIBLE_MAX_CM = 20000

FIRST_YEAR = 2000
LAST_YEAR = 2025

# Gap policy (plan §1a): runs of 1..SHORT_GAP missing days are interpolated and
# count as targets; runs up to MAX_FILL are interpolated but never scored as a
# target; anything longer stays NaN and discards every window that touches it.
SHORT_GAP = 3
MAX_FILL = 7


def plausible(v) -> bool:
    return v is not None and PLAUSIBLE_MIN_CM <= v <= PLAUSIBLE_MAX_CM


def mid_of(lo, hi):
    """Exact port of midOf() in scripts/build-river-totals.mjs:85.

    None when EITHER side is missing or implausible. Deliberately not
    "improved": a day with only a max is a flood crest without its trough.
    """
    return (lo + hi) / 2 if plausible(lo) and plausible(hi) else None


def days_in_year(y: int) -> int:
    return 366 if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else 365


@dataclass
class Series:
    uuid: str
    name: str
    dates: np.ndarray  # datetime64[D], one entry per archive day
    mid: np.ndarray    # float64, NaN = gap
    dmin: np.ndarray
    dmax: np.ndarray

    def __len__(self) -> int:
        return len(self.mid)

    def target(self, which: str) -> np.ndarray:
        if which == "mid":
            return self.mid
        if which == "max":
            return self.dmax
        if which == "min":
            return self.dmin
        raise ValueError(f"unknown target {which!r}")


def load_station(archive: Path, uuid: str, first: int = FIRST_YEAR, last: int = LAST_YEAR) -> Series:
    """Daily mid/min/max for closed years first..last as one contiguous array."""
    station = Path(archive) / uuid
    closed = json.loads((station / "closed.json").read_text(encoding="utf-8"))
    meta = json.loads((station / "meta.json").read_text(encoding="utf-8"))
    by_year = {int(e["y"]): e for e in closed}
    mids, mins, maxs, dates = [], [], [], []
    for y in range(first, last + 1):
        n = days_in_year(y)
        e = by_year.get(y) or {}
        lo = e.get("min") or []
        hi = e.get("max") or []
        for d in range(n):
            a = lo[d] if d < len(lo) else None
            b = hi[d] if d < len(hi) else None
            m = mid_of(a, b)
            mids.append(np.nan if m is None else float(m))
            mins.append(float(a) if plausible(a) else np.nan)
            maxs.append(float(b) if plausible(b) else np.nan)
        dates.append(np.arange(np.datetime64(f"{y}-01-01"), np.datetime64(f"{y + 1}-01-01")))
    dates_arr = np.concatenate(dates)
    assert len(dates_arr) == len(mids)
    return Series(uuid, meta.get("name", uuid), dates_arr,
                  np.array(mids), np.array(mins), np.array(maxs))


def gap_runs(x: np.ndarray):
    """(start, length) of every NaN run in x."""
    isnan = np.isnan(x)
    runs = []
    i = 0
    n = len(x)
    while i < n:
        if isnan[i]:
            j = i
            while j < n and isnan[j]:
                j += 1
            runs.append((i, j - i))
            i = j
        else:
            i += 1
    return runs


def fill_gaps(x: np.ndarray, max_fill: int = MAX_FILL):
    """Interpolate NaN runs up to max_fill days that have observations on both sides.

    Returns (filled, run_len) where run_len[i] is 0 for an observed day, the
    length of its run for an interpolated day, and -1 for a day left NaN (a run
    longer than max_fill, or one touching the series edge).
    """
    filled = x.astype(float).copy()
    run_len = np.zeros(len(x), dtype=int)
    for start, length in gap_runs(x):
        end = start + length  # exclusive
        if length <= max_fill and start > 0 and end < len(x):
            a, b = filled[start - 1], filled[end]
            for k in range(length):
                filled[start + k] = a + (b - a) * (k + 1) / (length + 1)
            run_len[start:end] = length
        else:
            run_len[start:end] = -1
    return filled, run_len


def origin_grid(n: int, context: int, horizon: int, step: int = 7) -> np.ndarray:
    """Every origin index o with a full context x[o-L+1..o] and full targets x[o+1..o+H]."""
    first = context - 1
    last = n - 1 - horizon
    return np.arange(first, last + 1, step)


def split_origins(origins: np.ndarray, dates: np.ndarray, horizon: int,
                  test_from: np.datetime64 = np.datetime64("2016-01-01")):
    """TRAIN = origins whose last target lies before test_from; TEST = origins at/after it.

    The two are separated by at least `horizon` days by construction; the
    assertion is the plan's void condition, kept as code rather than trust.
    """
    o_dates = dates[origins]
    train = origins[o_dates + np.timedelta64(horizon, "D") < test_from]
    test = origins[o_dates >= test_from]
    if len(train) and len(test):
        assert train.max() + horizon < test.min(), "TRAIN and TEST overlap"
    return train, test


def windows(x_filled: np.ndarray, run_len: np.ndarray, origins: np.ndarray,
            context: int, horizon: int):
    """Contexts, targets and target masks for every origin that has no long gap.

    Returns (kept_origins, ctx (n,L), y (n,H), tmask (n,H)). A window is dropped
    when its context or its targets touch an unfilled gap (run_len == -1);
    a target is masked out when it sits in a run longer than SHORT_GAP.
    """
    keep, ctxs, ys, masks = [], [], [], []
    for o in origins:
        c_idx = np.arange(o - context + 1, o + 1)
        t_idx = np.arange(o + 1, o + horizon + 1)
        assert c_idx.max() == o, "context reaches past the origin"
        if (run_len[c_idx] < 0).any() or (run_len[t_idx] < 0).any():
            continue
        keep.append(o)
        ctxs.append(x_filled[c_idx])
        ys.append(x_filled[t_idx])
        masks.append(run_len[t_idx] <= SHORT_GAP)
    if not keep:
        return np.array([], dtype=int), np.zeros((0, context)), np.zeros((0, horizon)), np.zeros((0, horizon), bool)
    return np.array(keep), np.array(ctxs), np.array(ys), np.array(masks)


# ---------- 15-minute series from the weekly collector ----------

STEP_15MIN = np.timedelta64(15, "m")


def load_hires(hires_dir: Path, uuid: str):
    """The collector's month shards `<uuid>/<YYYY-MM>.json` on a regular
    15-minute grid (NaN = missing).

    Returns (times datetime64[m], values) or (None, None) when nothing was
    collected yet. Timestamps are the collector's normalised UTC instants; a
    gauge that publishes every minute (CUXHAVEN) is thinned to the grid here.
    """
    station = Path(hires_dir) / uuid
    pts = []
    for shard in sorted(station.glob("????-??.json")) if station.is_dir() else []:
        doc = json.loads(shard.read_text(encoding="utf-8"))
        pts.extend(doc.get("points") or [])
    if not pts:
        return None, None
    ts = np.array([np.datetime64(p[0].replace("Z", "")) for p in pts]).astype("datetime64[m]")
    vals = np.array([float(p[1]) for p in pts])
    order = np.argsort(ts)
    ts, vals = ts[order], vals[order]
    on_grid = ts.astype(int) % 15 == 0  # minutes since epoch; off-grid stamps are ignored
    ts, vals = ts[on_grid], vals[on_grid]
    if not len(ts):
        return None, None
    grid = np.arange(ts[0], ts[-1] + STEP_15MIN, STEP_15MIN)
    out = np.full(len(grid), np.nan)
    out[((ts - ts[0]) / STEP_15MIN).astype(int)] = vals
    return grid, out
