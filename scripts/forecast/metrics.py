"""Scores, and the two pieces of statistics that keep overlapping windows honest.

509 origins at 7-day spacing with a 90-day horizon are about 40 independent
samples, not 509: a naive t-test reports p < 1e-6 on pure noise. So every
"significant" here comes from a Diebold-Mariano test with a Newey-West
variance (Bartlett kernel, lag 13) or from a moving-block bootstrap over
origins (block length 26), and both report the effective n next to the dense n.
"""
from __future__ import annotations

import math

import numpy as np

DECILES = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])


def mae(pred: np.ndarray, y: np.ndarray, mask: np.ndarray) -> float:
    err = np.abs(pred - y)
    sel = mask & ~np.isnan(err)
    return float(err[sel].mean()) if sel.any() else float("nan")


def abs_err_sum_count(pred: np.ndarray, y: np.ndarray, mask: np.ndarray):
    """(sum of |err|, count) so callers can pool across stations without re-weighting."""
    err = np.abs(pred - y)
    sel = mask & ~np.isnan(err)
    return float(err[sel].sum()), int(sel.sum())


def skill(mae_model: float, mae_base: float) -> float:
    return 1.0 - mae_model / mae_base if mae_base > 0 else float("nan")


def mase_denominators(x: np.ndarray, horizon: int) -> np.ndarray:
    """d_h = mean |x[t] - x[t-h]| over the given (TRAIN-period) series, h = 1..H."""
    out = np.full(horizon, np.nan)
    for h in range(1, horizon + 1):
        d = np.abs(x[h:] - x[:-h])
        d = d[~np.isnan(d)]
        out[h - 1] = d.mean() if d.size else np.nan
    return out


def pinball(y: np.ndarray, q: np.ndarray, tau: float) -> np.ndarray:
    diff = y - q
    return np.maximum(tau * diff, (tau - 1) * diff)


def crps_deciles(y: np.ndarray, quant: np.ndarray) -> np.ndarray:
    """CRPS approximated from nine deciles: (2/9) * sum_k pinball_{tau_k}. (n, H)."""
    acc = np.zeros(y.shape)
    for k, tau in enumerate(DECILES):
        acc += pinball(y, quant[:, :, k], tau)
    return 2.0 * acc / len(DECILES)


def picp(y: np.ndarray, quant: np.ndarray, lo: int, hi: int, mask: np.ndarray) -> float:
    inside = (quant[:, :, lo] <= y) & (y <= quant[:, :, hi])
    sel = mask & ~np.isnan(y)
    return float(inside[sel].mean()) if sel.any() else float("nan")


def pit_histogram(y: np.ndarray, quant: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Ten bins: how many deciles lie at or below y (0..9). Flat = calibrated."""
    sel = mask & ~np.isnan(y)
    below = (quant[sel] <= y[sel][:, None]).sum(axis=1)
    return np.bincount(below, minlength=10)


# ---------- Diebold-Mariano with Newey-West ----------

def newey_west_variance(d: np.ndarray, lag: int) -> tuple[float, float]:
    """(long-run variance, gamma0) of the loss differential with a Bartlett kernel."""
    d = d - d.mean()
    n = len(d)
    gamma0 = float((d * d).sum() / n)
    lrv = gamma0
    for k in range(1, min(lag, n - 1) + 1):
        gk = float((d[k:] * d[:-k]).sum() / n)
        lrv += 2.0 * (1.0 - k / (lag + 1.0)) * gk
    return max(lrv, 1e-12), gamma0


def dm_test(loss_model: np.ndarray, loss_base: np.ndarray, lag: int = 13) -> dict:
    """One-sided DM test that the model's loss is LOWER (d = model - base < 0).

    Returns z (positive = model better), the one-sided p, dense n and the
    effective n implied by the variance inflation.
    """
    d = np.asarray(loss_model, float) - np.asarray(loss_base, float)
    d = d[~np.isnan(d)]
    n = len(d)
    if n < 3:
        return {"z": float("nan"), "p": float("nan"), "n": n, "n_eff": float("nan"), "mean": float("nan")}
    lrv, gamma0 = newey_west_variance(d, lag)
    se = math.sqrt(lrv / n)
    z = -d.mean() / se if se > 0 else 0.0
    p = 0.5 * math.erfc(z / math.sqrt(2.0))
    n_eff = n * gamma0 / lrv if lrv > 0 else float("nan")
    return {"z": float(z), "p": float(p), "n": n, "n_eff": float(n_eff), "mean": float(d.mean())}


def stouffer(zs) -> float:
    zs = [z for z in zs if not (z is None or math.isnan(z))]
    return float(sum(zs) / math.sqrt(len(zs))) if zs else float("nan")


# ---------- moving-block bootstrap over origins ----------

def block_bootstrap_indices(n: int, block: int, rng: np.random.Generator) -> np.ndarray:
    """One resample of 0..n-1 as consecutive (circular) blocks of length `block`."""
    starts = rng.integers(0, n, size=math.ceil(n / block))
    idx = (starts[:, None] + np.arange(block)[None, :]).ravel() % n
    return idx[:n]


def bootstrap_ci(stat_fn, n: int, block: int, B: int = 2000, seed: int = 0, alpha: float = 0.05):
    """Percentile CI of stat_fn(indices) under joint block resampling of origins."""
    rng = np.random.default_rng(seed)
    vals = np.array([stat_fn(block_bootstrap_indices(n, block, rng)) for _ in range(B)])
    vals = vals[~np.isnan(vals)]
    if vals.size == 0:
        return float("nan"), float("nan")
    return float(np.quantile(vals, alpha / 2)), float(np.quantile(vals, 1 - alpha / 2))
