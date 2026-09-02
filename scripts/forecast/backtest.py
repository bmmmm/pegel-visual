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

REPO = Path(__file__).resolve().parents[2]


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


def run_model(model, ctxs: np.ndarray, horizon: int, batch: int, log):
    """Model output for every context, in fixed batches; returns (point, deciles)."""
    points, quants = [], []
    for i in range(0, len(ctxs), batch):
        p, q = tfm.forecast_batch(model, ctxs[i:i + batch], horizon)
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
        tfm_point, tfm_q = run_model(model, ctx, H, tfm.FORECAST_CONFIG["per_core_batch_size"], log)
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
        tfm_point, tfm_q = run_model(model, ctx, H, tfm.FORECAST_CONFIG["per_core_batch_size"], log)
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
    ap.add_argument("--horizon", choices=["seasonal", "short"], default="seasonal")
    ap.add_argument("--target", choices=["mid", "max", "min"], default="mid")
    ap.add_argument("--out", default=None)
    ap.add_argument("--tmp", default=str(REPO / "tmp-forecast"))
    ap.add_argument("--stations", default=None, help="comma-separated UUIDs (default: the measured set)")
    ap.add_argument("--no-model", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args(argv)

    out = Path(args.out or (Path(args.tmp) / "results" / f"{args.horizon}-{args.target}"))
    out.mkdir(parents=True, exist_ok=True)
    uuids = args.stations.split(",") if args.stations else list(st.STATIONS)
    proto = SEASONAL if args.horizon == "seasonal" else SHORT
    config = dict(tfm.FORECAST_CONFIG)
    if args.horizon == "short":
        config["max_horizon"] = proto["horizon"]

    def log(msg):
        print(msg, flush=True)

    started = time.time()
    model = None
    repeat_ok = None
    if not args.no_model:
        log(f"loading {tfm.CHECKPOINT} (cache {Path(args.tmp) / 'hf'})")
        model = tfm.load_model(Path(args.tmp), config)

    per_station = {}
    hash_parts = []
    for uuid in uuids:
        log(f"{st.name_of(uuid)} ({uuid})")
        if args.horizon == "seasonal":
            arrays, info = backtest_seasonal_station(uuid, Path(args.archive), args.target, None if args.no_model else model,
                                                     proto, args.limit, log)
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
        if first is not None:
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
        "checkpoint": tfm.CHECKPOINT, "model": tfm.MODEL_ID, "model_license": tfm.MODEL_LICENSE,
        "torch_threads": tfm.TORCH_THREADS, "versions": tfm.versions(), "git": git_head(),
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "elapsed_s": round(time.time() - started, 1),
        "model_ran": model is not None, "limit": args.limit, "repeat_identical": repeat_ok,
        "tfm_sha256": sha256_arrays(hash_parts) if hash_parts else None,
        "stations": per_station,
    }
    (out / "header.json").write_text(json.dumps(header, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"wrote {out} in {header['elapsed_s']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
