#!/usr/bin/env python3
"""Rolling-origin backtest: baselines and TimesFM on the same windows.

    uv run python backtest.py --archive ../../archive --horizon seasonal --target mid \
        --out ../../tmp-forecast/results/seasonal-mid --tmp ../../tmp-forecast

Writes one `<uuid>.npz` per station (every window's targets, mask and every
forecast) plus `header.json` with the pre-registered ForecastConfig, its
fingerprint, package versions and the sha256 of all model output, so a second
run can be compared number for number. gate.py reads that directory and prints
the verdict. `--no-model` runs the baselines alone, `--limit N` truncates the
origin grid for smoke tests (the header records both, and the gate refuses a
truncated run).

`--model` picks a line from tfm.MODELS. The default is the shipped one; a
challenger writes to its own results directory and needs its own environment,
because the two lines are the same distribution at two versions:

    uv run --no-group model --group model-nc python backtest.py --model 3p0 ...

The archive path differs between machines: locally the data branch is checked
out as `archive/` (gitignored); CI lays it down as `archive-branch/archive`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import baselines as bl  # noqa: E402
import loaders  # noqa: E402
import metrics  # noqa: E402
import stations as st  # noqa: E402
import tfm  # noqa: E402

# ---------- the seasonal protocol (plan §1b), fixed before the first model run ----------
SEASONAL = {
    "context": 1024,
    "horizon": 90,
    "step": 7,
    "test_from": "2016-01-01",
    "blocks": {"h1-14": [1, 14], "h15-30": [15, 30], "h31-90": [31, 90]},
}

# ---------- the short-horizon protocol (15-minute grid; PROVISIONAL until the data exists) ----------
SHORT = {
    "context": 1024,   # 10.7 days of 15-minute steps
    "horizon": 192,    # 48 h
    "step": 192,       # origins do not overlap: each window is an independent sample
    "blocks": {"h1-6h": [1, 24], "h6-24h": [25, 96], "h24-48h": [97, 192]},
}

# ---------- the NRW rain protocol, fixed before the first model run ----------
# Context 384 = 12 x the 3.0 input patch of 32: 365 would be padded silently, and
# a padded context is a different context. Horizon 14 because the question is
# whether observed rain helps the days a catchment actually responds over — the
# response statistic in nrw/precip/<no>/response.json peaks at lag 1 and is gone
# by lag 5, so 14 days is generous, not arbitrary.
#
# The window is what it is: the mirror rolls two years, so there is no TRAIN
# period for a model, only for the baselines' two fitted constants (tau, the OLS
# betas). That is stated in the report rather than papered over.
NRW = {
    "context": 384,
    "horizon": 14,
    "step": 7,
    "blocks": {"h1-3": [1, 3], "h4-7": [4, 7], "h8-14": [8, 14]},
    # `mid` is the FIELD NAME in Series; for a LANUK gauge it holds the source's
    # own daily mean, not (min+max)/2. The header says so in words.
    "target_field": "mid",
    "target_meaning": "the source's own daily mean, not (min+max)/2",
    "acc_min": loaders.NRW_ACC_MIN,
    "covariate": "areal_rain_past_only_shift1",
    "rain_lag_columns": 4,
}

REPO = Path(__file__).resolve().parents[2]


def git_head_of(tree: Path) -> str | None:
    """The commit of the tree the run READ, which for `nrw` is a data branch and
    not this checkout's HEAD. A worktree copy is not in git at all, so a run
    against a gitignored mirror records the manifest's own stamp instead."""
    try:
        m = json.loads((Path(tree) / "manifest.json").read_text(encoding="utf-8"))
        return f"{m.get('generated')} / export {m.get('sourceExportAt')}"
    except Exception:  # noqa: BLE001
        return None


def git_head() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True,
                              text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return None


def sha256_arrays(parts) -> str:
    h = hashlib.sha256()
    for a in parts:
        h.update(np.ascontiguousarray(a).tobytes())
    return h.hexdigest()


def run_model(model, ctxs: np.ndarray, horizon: int, batch: int, log, past_only=None):
    """Model output for every context, in fixed batches; returns (point, deciles).

    `past_only` is an optional (n, context) covariate, batched in lockstep with
    the contexts — a covariate that fell out of step with its own context would
    still run and still score.
    """
    points, quants = [], []
    if past_only is not None:
        assert len(past_only) == len(ctxs), f"{len(past_only)} covariates for {len(ctxs)} contexts"
    for i in range(0, len(ctxs), batch):
        cov = None if past_only is None else past_only[i:i + batch]
        p, q = tfm.forecast_batch(model, ctxs[i:i + batch], horizon, cov)
        points.append(p)
        quants.append(q)
        if (i // batch) % 10 == 0:
            log(f"    {i + len(p)}/{len(ctxs)} windows")
    return np.concatenate(points), np.concatenate(quants)


def repeat_check(model, ctxs: np.ndarray, horizon: int, batch: int) -> bool:
    """Void condition: the same batch must reproduce bit for bit."""
    a_p, a_q = tfm.forecast_batch(model, ctxs[:batch], horizon)
    b_p, b_q = tfm.forecast_batch(model, ctxs[:batch], horizon)
    return np.array_equal(a_p, b_p) and np.array_equal(a_q, b_q)


# ---------- seasonal ----------

def backtest_seasonal_station(uuid: str, archive: Path, target: str, model, proto: dict,
                              limit: int | None, log) -> tuple[dict, dict]:
    L, H, step = proto["context"], proto["horizon"], proto["step"]
    series = loaders.load_station(archive, uuid)
    x_raw = series.target(target)
    x, run_len = loaders.fill_gaps(x_raw)
    grid = loaders.origin_grid(len(x), L, H, step)
    if limit:
        grid = grid[:limit]
    train_o, test_o = loaders.split_origins(grid, series.dates, H, np.datetime64(proto["test_from"]))
    kept, ctx, y, tmask = loaders.windows(x, run_len, grid, L, H)
    is_train = np.isin(kept, train_o)
    is_test = np.isin(kept, test_o)
    assert not (is_train & is_test).any()

    clim_table, y0 = bl.climatology_table(series.dates, x)
    clim = bl.climatology_forecast(clim_table, y0, series.dates, kept, H)
    last = ctx[:, -1]
    persist = bl.persistence(ctx, H)
    snaive = bl.seasonal_naive_365(x, kept, H)
    fit_rows = is_train & ~np.isnan(clim).any(axis=1)
    tau = bl.fit_tau(last[fit_rows], clim[fit_rows], y[fit_rows], tmask[fit_rows]) if fit_rows.sum() >= 30 else 30
    blend = bl.blend(last, clim, tau)
    resid_dec = bl.residual_deciles((y - blend)[is_train], tmask[is_train])
    blend_q = bl.quantiles_from_residuals(blend, resid_dec)

    # MASE denominators from the TRAIN period only
    train_end = int(train_o.max()) + H if len(train_o) else len(x)
    d_h = metrics.mase_denominators(x[:train_end], H)

    upstream = np.full_like(y, np.nan)
    up_uuid = st.UPSTREAM.get(uuid)
    if up_uuid and (archive / up_uuid / "closed.json").exists():
        up = loaders.load_station(archive, up_uuid)
        up_x, _ = loaders.fill_gaps(up.target(target))
        upstream = bl.upstream_ols(x[kept], up_x[kept], clim, y, tmask, is_train)

    tfm_point = np.full_like(y, np.nan)
    tfm_q = np.full((len(kept), H, 9), np.nan)
    if model is not None:
        t0 = time.time()
        tfm_point, tfm_q = run_model(model, ctx, H, model.config["per_core_batch_size"], log)
        log(f"    model: {len(kept)} windows in {time.time() - t0:.0f}s")

    arrays = {
        "origins": kept, "o_dates": series.dates[kept], "is_train": is_train, "is_test": is_test,
        "last": last, "y": y, "tmask": tmask, "persist": persist, "clim": clim, "snaive": snaive,
        "blend": blend, "blend_q": blend_q, "tfm_point": tfm_point, "tfm_q": tfm_q,
        "upstream": upstream, "tau": np.array(tau), "d_h": d_h,
    }
    info = {
        "name": series.name, "regime": st.regime_of(uuid) if uuid in st.STATIONS else None,
        "n_days": len(x), "nan_days": int(np.isnan(x_raw).sum()),
        "grid": int(len(grid)), "kept": int(len(kept)), "train": int(is_train.sum()), "test": int(is_test.sum()),
        "pairs_expected": int(len(grid) * H), "pairs_scored": int(tmask.sum()),
        "tau": int(tau), "range_cm": [float(np.nanmin(x_raw)), float(np.nanmax(x_raw))],
    }
    return arrays, info


# ---------- the NRW rain experiment ----------

# how far a control window's covariate must come from, in ORIGINS. At step 7 a
# distance of 8 means at least 56 days apart: two 384-day windows then share at
# most 328 of their days, and none of the recent ones a lag-1 response lives on.
MIN_SHUFFLE_DISTANCE = 8


def _deranged(rows: np.ndarray, min_dist: int) -> np.ndarray:
    """Every row gets the row half the run away — a HALF-CYCLE, not a shuffle.

    A random derangement does not do this job: at n = 48 no permutation with a
    minimum displacement of 8 turned up in 2000 draws, and the ones that did
    turn up left 2 windows one step from themselves — which at step 7 means the
    rain of seven days earlier, sharing 377 of its 384 days. A half-cycle moves
    every window by exactly floor(n/2) origins (24 at n = 48, so 168 days apart:
    the two 384-day windows overlap in none of the recent days a lag-1 response
    lives on), is deterministic, and can be checked in one line rather than
    hoped for. Regularity is not a defect in a control that only has to be FAR.
    """
    n = len(rows)
    shift = n // 2
    # `min_dist` was passed and never read (audit 2026-09-09): at n = 3 the
    # half-cycle is a one-origin shift — the rain of seven days earlier, the
    # very case the docstring calls unfit. A control that is not far is not a
    # control, so a run too short for the distance stops here rather than
    # scoring a comparison that means nothing.
    if shift < min_dist:
        raise ValueError(f"{n} windows give a half-cycle of {shift} origins, under the "
                         f"registered minimum of {min_dist}: too short a run for a control arm")
    return rows[(np.arange(n) + shift) % n]


def _nrw_covariate(rain: np.ndarray, origins: np.ndarray, context: int) -> np.ndarray:
    """(n, context) of areal rain, shifted one day back.

    At the context position of gauge day t stands rain day t-1, so the newest
    index any window sees is `o - 1`. That is not caution, it is arithmetic: a
    rain day runs 07:00 -> 07:00 MEZ and therefore CLOSES seven hours into gauge
    day t+1, which means rain day t is not knowable at the end of gauge day t.
    """
    out = np.full((len(origins), context), np.nan)
    for i, o in enumerate(origins):
        idx = np.arange(o - context, o)
        assert idx.max() == o - 1, "the covariate reaches the origin's own rain day"
        if idx.min() < 0:
            continue
        out[i] = rain[idx]
    return out


def _cov_last(cov_full: np.ndarray, is_test: np.ndarray) -> np.ndarray:
    """The last value of every window's covariate; NaN on rows that have none.

    Stored so the gate can check the shift against a column derived a different
    way (`rain_lags[:, 0]`, the rain of day o-1). A witness computed from the
    same variable it certifies is not a witness.
    """
    out = np.full(len(cov_full), np.nan)
    out[is_test] = cov_full[is_test][:, -1]
    return out


def backtest_nrw_station(no: str, tree: Path, model, proto: dict, arm: str, log) -> tuple[dict, dict]:
    L, H, step = proto["context"], proto["horizon"], proto["step"]
    series = loaders.load_nrw_station(tree, no)
    x_raw = series.target(proto["target_field"])
    rain = loaders.load_nrw_rain(tree, no, series.dates)
    x, run_len = loaders.fill_gaps(x_raw)

    grid = loaders.origin_grid(len(x), L, H, step)
    test_kept, test_ctx, test_y, test_mask = loaders.windows(x, run_len, grid, L, H)

    # THE COVARIATE FILTER RUNS ON EVERY ARM, including the plain one. A window
    # the rain arm cannot take must not be scored for the plain arm either, or
    # the two are measured on different origin sets and the pairing — every
    # skill score, every DM test — is comparing two different questions.
    cov = _nrw_covariate(rain, test_kept, L)
    usable = ~np.isnan(cov).any(axis=1)
    test_kept, test_ctx, test_y, test_mask, cov = (
        test_kept[usable], test_ctx[usable], test_y[usable], test_mask[usable], cov[usable])

    if not len(test_kept):
        return None, {"name": st.nrw_name_of(no), "kept": 0, "reason": "no window survives the covariate filter"}

    # TRAIN rows exist for the BASELINES only: two years cannot give a model a
    # training window at context 384, but tau and the OLS betas need rows, and
    # they need only x[o] and four rain lags. Embargoed by construction and
    # asserted below.
    first_test = int(test_kept.min())
    lags = proto["rain_lag_columns"]
    train_o = []
    for o in range(lags, first_test - H):
        t_idx = np.arange(o + 1, o + H + 1)
        if run_len[o] < 0 or (run_len[t_idx] < 0).any():
            continue
        if np.isnan(rain[o - lags:o]).any():
            continue
        train_o.append(o)
    train_o = np.array(train_o, dtype=int)
    if len(train_o):
        assert train_o.max() + H < first_test, "TRAIN and TEST overlap"

    origins = np.concatenate([train_o, test_kept]) if len(train_o) else test_kept
    is_train = np.concatenate([np.ones(len(train_o), bool), np.zeros(len(test_kept), bool)]) if len(train_o) else np.zeros(len(test_kept), bool)
    is_test = ~is_train
    n = len(origins)

    y = np.array([x[np.arange(o + 1, o + H + 1)] for o in origins])
    tmask = np.array([run_len[np.arange(o + 1, o + H + 1)] <= loaders.SHORT_GAP for o in origins])
    last = x[origins]
    # R0..R3 = the rain of days o-1 .. o-4, newest first — the same one-day shift
    rain_lags = np.column_stack([rain[origins - (k + 1)] for k in range(lags)])

    ctx = np.full((n, L), np.nan)
    ctx[is_test] = test_ctx
    cov_full = np.full((n, L), np.nan)
    cov_full[is_test] = cov

    mw = st.nrw_mw_of(no)
    tau = bl.fit_tau_mw(last[is_train], mw, y[is_train], tmask[is_train]) if is_train.sum() >= 30 else 30
    blend_mw = bl.blend_mw(last, mw, tau, H)
    resid_dec = bl.residual_deciles((y - blend_mw)[is_train], tmask[is_train])
    blend_mw_q = bl.quantiles_from_residuals(blend_mw, resid_dec)
    persist = bl.persistence(ctx, H)
    persist[is_train] = np.repeat(last[is_train][:, None], H, axis=1)  # no context on a TRAIN row
    snaive = bl.seasonal_naive_365(x, origins, H)
    rain_ols = bl.rain_ols(last, rain_lags, y, tmask, is_train)

    train_end = int(train_o.max()) + H if len(train_o) else first_test
    d_h = metrics.mase_denominators(x[:train_end], H)

    tfm_point = np.full_like(y, np.nan)
    tfm_q = np.full((n, H, 9), np.nan)
    if model is not None:
        past_only = None
        if proto.get("covariate") and arm != "plain":
            arm_cov = cov
            if arm == "shuffled":
                # the negative control: every window keeps a REAL rain context —
                # its autocorrelation, its wet spells — but one belonging to a
                # different origin. What survives that is not rain.
                #
                # A plain derangement is not enough: origins are one week apart,
                # so perm[i] = i±1 hands a window the rain of seven days earlier,
                # which shares 377 of its 384 days. Measured on seed 7: 2 of 48
                # windows landed within one step and 6 within three. The control
                # has to be far in ORIGIN, not merely different.
                arm_cov = _deranged(arm_cov, MIN_SHUFFLE_DISTANCE)
            past_only = arm_cov
        t0 = time.time()
        pt, q = run_model(model, test_ctx, H, model.config["per_core_batch_size"], log, past_only=past_only)
        tfm_point[is_test] = pt
        tfm_q[is_test] = q
        log(f"    model: {len(test_ctx)} windows in {time.time() - t0:.0f}s")

    arrays = {
        "origins": origins, "o_dates": series.dates[origins], "is_train": is_train, "is_test": is_test,
        "last": last, "y": y, "tmask": tmask, "persist": persist, "snaive": snaive,
        "blend": blend_mw, "blend_q": blend_mw_q, "rain_ols": rain_ols, "rain_lags": rain_lags,
        "tfm_point": tfm_point, "tfm_q": tfm_q, "tau": np.array(tau), "d_h": d_h,
        # THE LEAK WITNESS. It has to come out of the covariate that was BUILT,
        # not out of the origins it was built from: `[o - 1 for o in origins]`
        # compared against `origins - 1` restates its own input, and a genuinely
        # leaking `_nrw_covariate` passed it (measured 2026-09-07). `cov_last` is
        # the last VALUE of each window's covariate; `rain_lags[:, 0]` is the
        # rain of day o-1 read independently. Equal means the covariate ended
        # where it was supposed to end.
        "cov_last": _cov_last(cov_full, is_test),
        "rain_lags_first": rain_lags[:, 0],
    }
    meta = loaders.nrw_meta(tree, no)
    # A rain event is a TEST WINDOW that has something to forecast: at least one
    # day of >= 10 mm areal rain inside its own target range. Counting the rain
    # AT the origin instead would count the 48 origin days and answer a different
    # question — measured 2026-09-07: 2 to 4 that way, 20 to 31 this way.
    ev_thresh = 10
    events = int(sum(1 for o in test_kept if np.nanmax(rain[o + 1:o + H + 1], initial=0) >= ev_thresh))
    info = {
        "name": st.nrw_name_of(no), "basin": st.nrw_basin_of(no), "unit": meta.get("unit", "cm"),
        "mw": mw, "km2": meta.get("catchmentKm2"),
        "n_days": len(x), "nan_days": int(np.isnan(x_raw).sum()),
        "grid": int(len(grid)), "kept": int(len(test_kept)), "train": int(is_train.sum()), "test": int(is_test.sum()),
        "dropped_by_covariate": int((~usable).sum()),
        "first_origin": str(series.dates[test_kept[0]]), "last_origin": str(series.dates[test_kept[-1]]),
        "pairs_scored": int(tmask[is_test].sum()), "tau": int(tau),
        "rain_events": events,
        "range": [float(np.nanmin(x_raw)), float(np.nanmax(x_raw))],
    }
    return arrays, info


# ---------- short horizon (15-minute grid) ----------

def backtest_short_station(uuid: str, hires: Path, model, proto: dict, log) -> tuple[dict | None, dict]:
    L, H, step = proto["context"], proto["horizon"], proto["step"]
    times, x_raw = loaders.load_hires(hires, uuid)
    if times is None:
        return None, {"name": st.name_of(uuid), "collected_steps": 0, "kept": 0}
    x, run_len = loaders.fill_gaps(x_raw, max_fill=8)  # two hours of 15-minute steps
    grid = loaders.origin_grid(len(x), L, H, step)
    kept, ctx, y, tmask = loaders.windows(x, run_len, grid, L, H)
    info = {"name": st.name_of(uuid), "collected_steps": int(len(x)), "grid": int(len(grid)),
            "kept": int(len(kept)), "pairs_expected": int(len(grid) * H), "pairs_scored": int(tmask.sum()),
            "span": [str(times[0]), str(times[-1])]}
    if not len(kept):
        return None, info
    persist = bl.persistence(ctx, H)
    snaive = bl.seasonal_naive_24h(x, kept, H)
    drift = bl.damped_drift(ctx, H)
    tidal = np.full_like(y, np.nan)
    if uuid in st.STATIONS and st.regime_of(uuid) == "Nordsee-tidal":
        hours = (times - times[0]) / np.timedelta64(1, "h")
        for i, o in enumerate(kept):
            lo = max(0, o - 90 * bl.STEPS_PER_DAY)
            tidal[i] = bl.tidal_harmonic(hours[lo:o + 1], x[lo:o + 1], hours[o + 1:o + 1 + H])
    # a rise event: within the 48 h the level climbs by more than a quarter of the
    # range the 10.7-day context showed — a flood-wave onset, not tidal or lock
    # noise (at a tenth, every FREMERSDORF window qualified — measured 2026-09-02)
    rise = (y.max(axis=1) - ctx[:, -1]) > 0.25 * (ctx.max(axis=1) - ctx.min(axis=1) + 1e-9)
    tfm_point = np.full_like(y, np.nan)
    tfm_q = np.full((len(kept), H, 9), np.nan)
    if model is not None:
        tfm_point, tfm_q = run_model(model, ctx, H, model.config["per_core_batch_size"], log)
    arrays = {"origins": kept, "o_times": times[kept], "y": y, "tmask": tmask, "persist": persist,
              "snaive": snaive, "drift": drift, "tidal": tidal, "rise": rise,
              "tfm_point": tfm_point, "tfm_q": tfm_q}
    info["rise_events"] = int(rise.sum())
    return arrays, info


# ---------- main ----------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", default=str(REPO / "archive"))
    ap.add_argument("--hires", default=str(REPO / "tmp-forecast" / "hires"))
    ap.add_argument("--horizon", choices=["seasonal", "short", "nrw"], default="seasonal")
    ap.add_argument("--nrw", default=str(REPO / "nrw"), help="the LANUK mirror tree (protocol `nrw`)")
    ap.add_argument("--target", choices=["mid", "max", "min"], default="mid")
    ap.add_argument("--out", default=None)
    ap.add_argument("--tmp", default=str(REPO / "tmp-forecast"))
    ap.add_argument("--stations", default=None, help="comma-separated UUIDs (default: the measured set)")
    ap.add_argument("--model", choices=sorted(tfm.MODELS), default=tfm.SHIPPED,
                    help="which line to run (default: the shipped one)")
    ap.add_argument("--no-model", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args(argv)

    entry = tfm.MODELS[args.model]
    # a challenger never overwrites the shipped model's results tree
    suffix = "" if args.model == tfm.SHIPPED else f"-{args.model}"
    out = Path(args.out or (Path(args.tmp) / "results" / f"{args.horizon}-{args.target}{suffix}"))
    out.mkdir(parents=True, exist_ok=True)
    proto = {"seasonal": SEASONAL, "short": SHORT, "nrw": NRW}[args.horizon]
    default_ids = list(st.NRW_STATIONS) if args.horizon == "nrw" else list(st.STATIONS)
    uuids = args.stations.split(",") if args.stations else default_ids
    config = dict(entry["config"])
    if args.horizon == "short":
        config["max_horizon"] = proto["horizon"]
    elif args.horizon == "nrw":
        # 14 days round up to one output patch. The SAME substitution has to
        # happen in gate.py's expectation, or every nrw report is VOID against a
        # fingerprint nothing produced.
        import math as _math
        patch = 64
        config["max_horizon"] = _math.ceil(proto["horizon"] / patch) * patch
    # which arm of the rain experiment this run is: the registry key decides, and
    # it never reaches the model — only which array is handed in
    cov_key = entry["config"].get("covariate")
    arm = "plain" if not cov_key else ("shuffled" if "shuffled" in cov_key else "rain")
    if args.horizon == "nrw" and arm != "plain" and args.model.startswith("2p5"):
        raise SystemExit("2.5 cannot take a covariate without changing the shipped line's fingerprint")

    def log(msg):
        print(msg, flush=True)

    started = time.time()
    model = None
    repeat_ok = None
    if not args.no_model:
        log(f"loading {entry['checkpoint']} ({entry['license']}, cache {Path(args.tmp) / 'hf'})")
        model = tfm.load_model(Path(args.tmp), config, args.model)

    per_station = {}
    hash_parts = []
    for uuid in uuids:
        log(f"{(st.nrw_name_of(uuid) if args.horizon == 'nrw' else st.name_of(uuid))} ({uuid})")
        if args.horizon == "seasonal":
            arrays, info = backtest_seasonal_station(uuid, Path(args.archive), args.target, None if args.no_model else model,
                                                     proto, args.limit, log)
        elif args.horizon == "nrw":
            arrays, info = backtest_nrw_station(uuid, Path(args.nrw), None if args.no_model else model, proto, arm, log)
        else:
            arrays, info = backtest_short_station(uuid, Path(args.hires), None if args.no_model else model, proto, log)
        per_station[uuid] = info
        if arrays is None:
            log(f"    no windows ({info})")
            continue
        np.savez_compressed(out / f"{uuid}.npz", **arrays)
        hash_parts += [arrays["tfm_point"], arrays["tfm_q"]]
        log(f"    {info}")

    if model is not None:
        # the reproducibility void condition, measured on the first station's first batch
        first = next((u for u in uuids if (out / f"{u}.npz").exists()), None)
        if first is not None and args.horizon == "nrw":
            # WITH the covariate: repeating a plain call would prove the plain
            # path reproduces and say nothing about the arm that actually ran
            series = loaders.load_nrw_station(Path(args.nrw), first)
            rain = loaders.load_nrw_rain(Path(args.nrw), first, series.dates)
            x, run_len = loaders.fill_gaps(series.target(proto["target_field"]))
            g = loaders.origin_grid(len(x), proto["context"], proto["horizon"], proto["step"])
            kept, ctx, _, _ = loaders.windows(x, run_len, g, proto["context"], proto["horizon"])
            b = config["per_core_batch_size"]
            cv = _nrw_covariate(rain, kept, proto["context"])
            ok = ~np.isnan(cv).any(axis=1)
            ctx, cv = ctx[ok][:b], cv[ok][:b]
            # the arm that actually ran, shuffle included: repeating the plain
            # covariate would prove the wrong path reproduces
            if arm == "shuffled":
                cv = _deranged(cv, MIN_SHUFFLE_DISTANCE)
            po = None if arm == "plain" else cv
            a1 = tfm.forecast_batch(model, ctx, proto["horizon"], po)
            a2 = tfm.forecast_batch(model, ctx, proto["horizon"], po)
            repeat_ok = np.array_equal(a1[0], a2[0]) and np.array_equal(a1[1], a2[1])
            log(f"repeat check: {'identical' if repeat_ok else 'DIFFERS'}")
        elif first is not None:
            if args.horizon == "seasonal":
                series = loaders.load_station(Path(args.archive), first)
                x, run_len = loaders.fill_gaps(series.target(args.target))
            else:
                times, x_raw = loaders.load_hires(Path(args.hires), first)
                x, run_len = loaders.fill_gaps(x_raw, max_fill=8)
            grid = loaders.origin_grid(len(x), proto["context"], proto["horizon"], proto["step"])
            _, ctx, _, _ = loaders.windows(x, run_len, grid[:config["per_core_batch_size"]], proto["context"], proto["horizon"])
            repeat_ok = repeat_check(model, ctx, proto["horizon"], config["per_core_batch_size"])
            log(f"repeat check: {'identical' if repeat_ok else 'DIFFERS'}")

    header = {
        "horizon_kind": args.horizon, "target": args.target, "protocol": proto,
        "forecast_config": config, "config_fingerprint": tfm.config_fingerprint(config),
        "checkpoint": entry["checkpoint"], "model": entry["id"], "model_license": entry["license"],
        "model_key": args.model, "model_shippable": entry["shippable"],
        "model_license_url": entry["license_url"], "model_params": entry["params"],
        "torch_threads": tfm.TORCH_THREADS, "versions": tfm.versions(), "git": git_head(),
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "elapsed_s": round(time.time() - started, 1),
        "model_ran": model is not None, "limit": args.limit, "repeat_identical": repeat_ok,
        "tfm_sha256": sha256_arrays(hash_parts) if hash_parts else None,
        "stations": per_station,
    }
    if args.horizon == "nrw":
        # what a reader needs to know a report is comparable to another: which
        # mirror commit, which rain bytes, which arm, and what `target` means here
        header["nrw_commit"] = git_head_of(Path(args.nrw))
        header["precip_sha256"] = loaders.precip_sha256(Path(args.nrw), uuids)
        header["target_field"] = proto["target_field"]
        header["target_meaning"] = proto["target_meaning"]
        header["covariate"] = cov_key
        header["arm"] = arm
    (out / "header.json").write_text(json.dumps(header, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"wrote {out} in {header['elapsed_s']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
