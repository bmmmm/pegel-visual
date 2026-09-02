"""TimesFM 2.5 — loading with the licence guard, and one batched forecast call.

The 3.0 weights are non-commercial and therefore incompatible with this repo's
GPL-3.0; the guard below is permanent code, not a setup check, and
tests/test_license.py greps the whole repo for the 3.0 package, class and
checkpoint names. See pyproject.toml for why the package is pinned to 2.0.2.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np

CHECKPOINT = "google/timesfm-2.5-200m-pytorch"  # Apache-2.0
MODEL_ID = "timesfm-2.5-200m"
MODEL_LICENSE = "Apache-2.0"

# Pre-registered before the first model run (plan §1d). Changing any value
# changes the fingerprint the backtest header records, and gate.py refuses a
# result whose fingerprint differs from this one.
#
# infer_is_positive=False: a gauge CAN read negative (PLAUSIBLE_MIN_CM=-2000).
# use_continuous_quantile_head=True also makes the one code difference between
# timesfm 2.0.2 and 3.0.1 moot: it overwrites quantile channels 1-4 and 6-9 of
# every horizon step from the spread head, and channels 0 (mean) and 5 (median)
# are invariant under the flip that 3.0.1 adds for autoregressive patches.
FORECAST_CONFIG = {
    "max_context": 1024,
    "max_horizon": 128,
    "normalize_inputs": True,
    "use_continuous_quantile_head": True,
    "force_flip_invariance": True,
    "infer_is_positive": False,
    "fix_quantile_crossing": True,
    "per_core_batch_size": 32,
}
TORCH_THREADS = 8  # fixed, so two runs reduce in the same order


def license_guard() -> None:
    assert "2.5" in CHECKPOINT and "3.0" not in CHECKPOINT, "only the Apache-2.0 2.5 weights may be used"


def config_fingerprint(config: dict = FORECAST_CONFIG) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()[:16]


def load_model(tmp_dir: Path, config: dict = FORECAST_CONFIG):
    """CPU, float32, deterministic seed. Weights are cached under tmp_dir/hf."""
    license_guard()
    os.environ.setdefault("HF_HOME", str(Path(tmp_dir) / "hf"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    import torch  # noqa: E402  (deferred: the tests run without the model extra)
    import timesfm  # noqa: E402

    assert hasattr(timesfm, "TimesFM_2p5_200M_torch"), "2.5 class missing — check the timesfm package version"
    torch.manual_seed(0)
    torch.set_num_threads(TORCH_THREADS)
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(CHECKPOINT)
    assert model.model.device.type == "cpu", "the gate runs on CPU for bit-exact reproduction"
    model.compile(timesfm.ForecastConfig(**config))
    return model


def versions() -> dict:
    import platform
    out = {"python": platform.python_version()}
    try:
        from importlib.metadata import version
        for pkg in ("timesfm", "torch", "numpy"):
            try:
                out[pkg] = version(pkg)
            except Exception:  # noqa: BLE001
                out[pkg] = None
    except Exception:  # noqa: BLE001
        pass
    return out


def forecast_batch(model, contexts: np.ndarray, horizon: int):
    """(point (B,H), deciles (B,H,9)).

    The raw quantile output has ten channels: 0 is the mean head, 1..9 are the
    deciles 0.1..0.9. timesfm 2.0.2 returns the MEDIAN (channel 5) as its point
    forecast (`return full_forecast[..., 5], full_forecast` in
    timesfm_2p5_torch.py) — the right point for an MAE score, and the plan's
    void condition "quantiles[...,0] ≉ point" is therefore checked against
    channel 5, measured on 2026-09-02 (channel 0 differs from the point).
    """
    inputs = [np.asarray(c, dtype=np.float32) for c in contexts]  # a fresh list: forecast() pads in place
    point, quant = model.forecast(horizon=horizon, inputs=inputs)
    point = np.asarray(point, dtype=np.float64)
    quant = np.asarray(quant, dtype=np.float64)
    assert quant.shape[-1] == 10, quant.shape
    assert np.array_equal(quant[..., 5], point), "the point forecast is not the median channel"
    return point, quant[..., 1:]
