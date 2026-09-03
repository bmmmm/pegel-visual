"""TimesFM — the model registry, the licence guard, and one batched forecast call.

Two lines are wired here, and they are not interchangeable:

  2p5  google/timesfm-2.5-200m-pytorch, Apache-2.0 weights. The SHIPPED model —
       the one every gate/<kind>-<target>/report.json is measured with.
  3p0  google/timesfm-3.0-pytorch, weights under Google's
       timesfm-non-commercial-license-v1.0. Measured as a challenger, named
       honestly in its own report, and never shipped: that licence forbids
       redistribution and any commercial or production use, so a GPL-3.0 repo
       cannot pass it on to its readers. Running it here is non-commercial
       research, which the licence does allow.

`license_guard()` is permanent code, not a setup check, and
tests/test_license.py holds the promise from the outside.

The two lines are the SAME distribution at two versions (3.0.x ships a second
top-level package beside the 2.5 one inside the same wheel), so they cannot
share an environment — see the conflicting `model` / `model-nc` groups in
pyproject.toml. A plain `uv run` gets 2.5 and never downloads 3.0's weights.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

PERMISSIVE = frozenset({"Apache-2.0", "MIT", "BSD-3-Clause"})
# what metrics.py scores: nine deciles, the median in the middle
DECILE_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

# ---------- the two pre-registered ForecastConfigs ----------
#
# Both were fixed before their model's first run. Changing any value changes the
# fingerprint the backtest header records, and gate.py refuses a result whose
# fingerprint differs from the one registered here.
#
# infer_is_positive / make_positive = False: a gauge CAN read negative
# (PLAUSIBLE_MIN_CM = -2000).
#
# use_continuous_quantile_head=True also makes the one code difference between
# timesfm 2.0.2 and 3.0.1 in the 2.5 path moot: it overwrites quantile channels
# 1-4 and 6-9 of every horizon step from the spread head, and channels 0 (mean)
# and 5 (median) are invariant under the flip that 3.0.1 adds for
# autoregressive patches.
CONFIG_2P5 = {
    "max_context": 1024,
    "max_horizon": 128,
    "normalize_inputs": True,
    "use_continuous_quantile_head": True,
    "force_flip_invariance": True,
    "infer_is_positive": False,
    "fix_quantile_crossing": True,
    "per_core_batch_size": 32,
}

# The 3.0 flags are spelled with 3.0's own names, so the header says what
# actually ran rather than a translation of it. The mapping to the 2.5
# pre-registration, so the two runs stay comparable:
#
#   max_context 1024            same 1 024 days of context are fed
#   max_horizon 128             ceil(90 / output_patch_length 64) * 64 = 128,
#                               the same patch-rounded horizon 2.5 decodes
#   use_symmetric_averaging     = force_flip_invariance: extends
#                                 TimesFM(aX+b) = a*TimesFM(x)+b to a < 0.
#                                 It forecasts x and -x and averages, so it
#                                 costs two forward passes per window.
#   make_positive False         = infer_is_positive False
#   sort_quantiles True         = fix_quantile_crossing True
#   use_znorm False             3.0 normalises internally (CPM RevIN); a second
#                               z-norm of ours would be a different model
#   the four architecture flags stay at the checkpoint's own defaults
CONFIG_3P0 = {
    "max_context": 1024,
    "max_horizon": 128,
    "per_core_batch_size": 32,
    "use_symmetric_averaging": True,
    "make_positive": False,
    "sort_quantiles": True,
    "use_znorm": False,
    "padding_mode": "none",
    "use_stitching": True,
    "use_linear_detrending": True,
    "use_iterative_cpm_revin": True,
    "use_variate_attention": True,
    "input_transform": "identity",
}

# which keys reach the constructor and which reach the call, for 3.0
_3P0_CTOR = ("per_core_batch_size", "use_stitching", "use_linear_detrending",
             "use_iterative_cpm_revin", "use_variate_attention", "input_transform")
_3P0_CALL = ("use_symmetric_averaging", "make_positive", "sort_quantiles",
             "use_znorm", "padding_mode")

TORCH_THREADS = 8  # fixed, so two runs reduce in the same order


@dataclass
class Loaded:
    """A loaded model and everything needed to call it — what backtest.py holds."""
    key: str
    entry: dict
    config: dict
    model: object


def _torch_setup():
    import torch  # noqa: PLC0415  (deferred: the tests run without the model extra)
    torch.manual_seed(0)
    torch.set_num_threads(TORCH_THREADS)
    return torch


def _load_2p5(entry: dict, tmp_dir: Path, config: dict):
    _torch_setup()
    import timesfm  # noqa: PLC0415

    # 3.0.x still exports the 2.5 class, but through a try/except that drops it
    # silently on any import error — so check rather than trust.
    assert hasattr(timesfm, "TimesFM_2p5_200M_torch"), "2.5 class missing — check the timesfm package version"
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(entry["checkpoint"])
    assert model.model.device.type == "cpu", "the gate runs on CPU for bit-exact reproduction"
    model.compile(timesfm.ForecastConfig(**config))
    return model


def _forecast_2p5(loaded: Loaded, contexts, horizon: int):
    inputs = [np.asarray(c, dtype=np.float32) for c in contexts]  # a fresh list: forecast() pads in place
    point, quant = loaded.model.forecast(horizon=horizon, inputs=inputs)
    return np.asarray(point, dtype=np.float64), np.asarray(quant, dtype=np.float64)


def _load_3p0(entry: dict, tmp_dir: Path, config: dict):
    _torch_setup()
    import timesfm3  # noqa: PLC0415

    kwargs = {k: config[k] for k in _3P0_CTOR if k in config}
    model = timesfm3.TimesFM3Forecaster.from_pretrained(entry["checkpoint"], device="cpu", **kwargs)
    assert str(model.device) == "cpu", "the gate runs on CPU for bit-exact reproduction"
    assert model.config.median_quantile_index == entry["point_channel"], \
        f"median channel moved: {model.config.median_quantile_index} != {entry['point_channel']}"
    assert len(model.config.quantiles) == entry["quantile_channels"], model.config.quantiles
    # the levels, not just the count: metrics.py scores these columns AS deciles
    # (DECILES = 0.1..0.9) and calls the outer pair an 80 % interval
    assert [round(q, 6) for q in model.config.quantiles] == DECILE_LEVELS, model.config.quantiles
    return model


def _forecast_3p0(loaded: Loaded, contexts, horizon: int):
    cfg = loaded.config
    inputs = [np.asarray(c, dtype=np.float32) for c in contexts]
    assert all(c.shape[-1] <= cfg["max_context"] for c in inputs), "context longer than the registered max"
    patch = loaded.model.config.output_patch_length
    assert math.ceil(horizon / patch) * patch == cfg["max_horizon"], \
        "horizon does not round to the registered max_horizon"
    call = {k: cfg[k] for k in _3P0_CALL if k in cfg}
    outs = list(loaded.model.predict_batch(contexts=inputs, horizon=horizon, return_quantiles=True, **call))
    point = np.asarray(np.stack([o.forecast for o in outs]), dtype=np.float64)
    quant = np.asarray(np.stack([o.quantiles for o in outs]), dtype=np.float64)
    return point, quant


# ---------- the registry ----------
#
# `point_channel` / `quantile_channels` are the output layout, MEASURED on each
# line rather than assumed: 2.5 returns ten channels (0 the mean head, 1..9 the
# deciles) with the point forecast on 5; 3.0 returns nine (the deciles alone)
# with the point on 4. forecast_batch() asserts both on every call, because a
# silently wrong channel is a plausible-looking wrong MAE.
MODELS = {
    "2p5": {
        "id": "timesfm-2.5-200m",
        "label": "TimesFM 2.5",
        "params": "200M",
        "checkpoint": "google/timesfm-2.5-200m-pytorch",
        "license": "Apache-2.0",
        "license_url": "https://huggingface.co/google/timesfm-2.5-200m-pytorch",
        "shippable": True,
        "group": "model",
        "config": CONFIG_2P5,
        "point_channel": 5,
        "quantile_channels": 10,
        "decile_slice": (1, 10),
        "load": _load_2p5,
        "forecast": _forecast_2p5,
    },
    "3p0": {
        "id": "timesfm-3.0",
        "label": "TimesFM 3.0",
        "params": "330M",
        "checkpoint": "google/timesfm-3.0-pytorch",
        "license": "timesfm-non-commercial-license-v1.0",
        "license_url": "https://huggingface.co/google/timesfm-3.0-pytorch/blob/main/LICENSE",
        "shippable": False,
        "group": "model-nc",
        "config": CONFIG_3P0,
        "point_channel": 4,
        "quantile_channels": 9,
        "decile_slice": (0, 9),
        "load": _load_3p0,
        "forecast": _forecast_3p0,
    },
}
SHIPPED = "2p5"

# What the rest of the code said before there was more than one model. Every
# caller that means "the model this repo ships" keeps reading these.
CHECKPOINT = MODELS[SHIPPED]["checkpoint"]
MODEL_ID = MODELS[SHIPPED]["id"]
MODEL_LICENSE = MODELS[SHIPPED]["license"]
FORECAST_CONFIG = MODELS[SHIPPED]["config"]


def license_guard(key: str = SHIPPED) -> None:
    """Two promises, both able to fail — and the order matters: the per-key check
    runs FIRST, or `SHIPPED` pointing at non-commercial weights would always be
    caught by the second assert and the first could never fire at all."""
    entry = MODELS[key]
    if not entry["shippable"]:
        assert key != SHIPPED, f"{key} may not be shipped and must never be the shipped model"
        assert entry["license_url"], f"{key}: a model that cannot ship must link the licence that says so"
    shipped = MODELS[SHIPPED]
    assert shipped["shippable"], "the shipped model is not marked shippable"
    assert shipped["license"] in PERMISSIVE, \
        f"shipped weights are {shipped['license']}, which is not a permissive licence"


def config_fingerprint(config: dict = FORECAST_CONFIG) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()[:16]


def expected_config(header: dict) -> dict:
    """The config the report's own model was pre-registered with. Headers written
    before the registry carry no model_key — those are the shipped model.

    An unregistered key falls back to the shipped config rather than raising: a
    header from a removed entry must come out of the gate as a VOID verdict
    (gate.void_reasons names it, and the fingerprint will not match either), not
    as a traceback."""
    return MODELS.get(header.get("model_key") or SHIPPED, MODELS[SHIPPED])["config"]


def load_model(tmp_dir: Path, config: dict = None, key: str = SHIPPED) -> Loaded:
    """CPU, float32, deterministic seed. Weights are cached under tmp_dir/hf."""
    license_guard(key)
    entry = MODELS[key]
    config = entry["config"] if config is None else config
    os.environ.setdefault("HF_HOME", str(Path(tmp_dir) / "hf"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    return Loaded(key=key, entry=entry, config=config, model=entry["load"](entry, Path(tmp_dir), config))


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


def forecast_batch(loaded: Loaded, contexts: np.ndarray, horizon: int):
    """(point (B,H), deciles (B,H,9)) — the same shape from either line.

    The point forecast is the MEDIAN channel, and which index that is differs
    between the lines (2.5: 5 of 10, the mean head sits on 0; 3.0: 4 of 9, there
    is no mean head). Both are asserted here on every call: the plan's void
    condition "quantiles[..., k] != point" is what catches a silently reordered
    output, and a wrong channel would otherwise score as a plausible MAE.
    """
    entry = loaded.entry
    point, quant = entry["forecast"](loaded, contexts, horizon)
    assert quant.shape[-1] == entry["quantile_channels"], quant.shape
    assert np.array_equal(quant[..., entry["point_channel"]], point), \
        "the point forecast is not the median channel"
    lo, hi = entry["decile_slice"]
    deciles = quant[..., lo:hi]
    # The slice itself was the gap: asserting the point channel of the RAW output
    # says nothing about what leaves this function. metrics.py reads these nine
    # columns as the deciles 0.1..0.9, so column 4 must BE the point forecast —
    # a slice off by one passes every other check here and scores a plausible,
    # wrong CRPS, PICP80 and PIT.
    assert deciles.shape[-1] == len(DECILE_LEVELS), deciles.shape
    assert np.array_equal(deciles[..., DECILE_LEVELS.index(0.5)], point), \
        "the returned deciles are not centred on the point forecast — check decile_slice"
    return point, deciles
