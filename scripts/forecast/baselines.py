"""The bars a forecast has to clear.

Persistence supplies the MASE denominators but is NOT the bar: the plan's
pre-measurement (KÖLN, TEST origins from 2016, n=509) had the blend beating
persistence by 25 % at h31-90, so a win against persistence would be a win
against nothing. The blend is the bar; climatology and seasonal-naive-365 are
reported as floor and context.
"""
from __future__ import annotations

import numpy as np

# 366-slot calendar: cumulative days before each month in a LEAP year, so that a
# calendar day maps to the same slot in every year and Feb 29 owns slot 59.
_LEAP_CUM = np.array([0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335])


def calendar_slot(dates: np.ndarray) -> np.ndarray:
    months = dates.astype("datetime64[M]")
    month_idx = (months.astype(int) % 12)
    day = (dates - months.astype("datetime64[D]")).astype(int)
    return _LEAP_CUM[month_idx] + day


def year_of(dates: np.ndarray) -> np.ndarray:
    return dates.astype("datetime64[Y]").astype(int) + 1970


# ---------- climatology ----------

def climatology_table(dates: np.ndarray, x: np.ndarray, window: int = 7):
    """Expanding day-of-year climatology.

    table[Y - y0, slot] = mean of x over all years STRICTLY before Y, over the
    calendar slots within ±window days (circular). Smoothing over a 15-day
    window is declared up front: it makes climatology a stronger opponent,
    not a weaker one. NaN where no prior year has data. Returns (table, y0).
    """
    years = year_of(dates)
    slots = calendar_slot(dates)
    y0, y1 = int(years.min()), int(years.max())
    per_year = np.full((y1 - y0 + 1, 366), np.nan)
    per_year[years - y0, slots] = x
    vals = np.nan_to_num(per_year)
    cnt = (~np.isnan(per_year)).astype(float)
    sv = sum(np.roll(vals, k, axis=1) for k in range(-window, window + 1))
    sc = sum(np.roll(cnt, k, axis=1) for k in range(-window, window + 1))
    cv = np.cumsum(sv, axis=0)
    cc = np.cumsum(sc, axis=0)
    table = np.full_like(per_year, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        table[1:] = np.where(cc[:-1] > 0, cv[:-1] / cc[:-1], np.nan)
    return table, y0


def climatology_forecast(table: np.ndarray, y0: int, dates: np.ndarray,
                         origins: np.ndarray, horizon: int) -> np.ndarray:
    """(n, H) climatology for the targets of each origin, from years before year(origin)."""
    out = np.full((len(origins), horizon), np.nan)
    for i, o in enumerate(origins):
        y = int(year_of(dates[o:o + 1])[0])
        t_dates = dates[o + 1:o + 1 + horizon]
        out[i] = table[y - y0, calendar_slot(t_dates)]
    return out


# ---------- point baselines ----------

def persistence(ctx: np.ndarray, horizon: int) -> np.ndarray:
    return np.repeat(ctx[:, -1:], horizon, axis=1)


def seasonal_naive_365(x: np.ndarray, origins: np.ndarray, horizon: int) -> np.ndarray:
    out = np.full((len(origins), horizon), np.nan)
    for i, o in enumerate(origins):
        idx = np.arange(o + 1, o + 1 + horizon) - 365
        ok = idx >= 0
        out[i, ok] = x[idx[ok]]
    return out


def blend(last: np.ndarray, clim: np.ndarray, tau: float) -> np.ndarray:
    """Blend(h) = e^(-h/tau) * last + (1 - e^(-h/tau)) * climatology(day)."""
    horizon = clim.shape[1]
    h = np.arange(1, horizon + 1)
    w = np.exp(-h / tau)[None, :]
    return w * last[:, None] + (1 - w) * clim


def fit_tau(last: np.ndarray, clim: np.ndarray, y: np.ndarray, mask: np.ndarray,
            grid=range(1, 401)) -> int:
    """tau minimising pooled MAE over all horizons on the given (TRAIN) windows."""
    best, best_mae = None, np.inf
    for tau in grid:
        err = np.abs(blend(last, clim, tau) - y)[mask]
        mae = float(np.nanmean(err)) if err.size else np.inf
        if mae < best_mae:
            best, best_mae = tau, mae
    return int(best)


def upstream_ols(x_target_o: np.ndarray, x_up_o: np.ndarray, clim: np.ndarray,
                 y: np.ndarray, mask: np.ndarray, train: np.ndarray) -> np.ndarray:
    """Reference column, not part of the gate: per-horizon OLS on
    [1, target(o), upstream(o), climatology(o+h)], fitted on TRAIN rows."""
    n, horizon = y.shape
    out = np.full((n, horizon), np.nan)
    for h in range(horizon):
        X = np.column_stack([np.ones(n), x_target_o, x_up_o, clim[:, h]])
        rows = train & mask[:, h] & ~np.isnan(X).any(axis=1) & ~np.isnan(y[:, h])
        if rows.sum() < 10:
            continue
        beta, *_ = np.linalg.lstsq(X[rows], y[rows, h], rcond=None)
        out[:, h] = X @ beta
    return out


# ---------- probabilistic baseline: blend + its own TRAIN residual deciles ----------

DECILES = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])


def residual_deciles(resid: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """(H, 9) empirical deciles of the residual y - blend per horizon step."""
    horizon = resid.shape[1]
    out = np.full((horizon, len(DECILES)), np.nan)
    for h in range(horizon):
        r = resid[:, h][mask[:, h] & ~np.isnan(resid[:, h])]
        if r.size >= 10:
            out[h] = np.quantile(r, DECILES)
    return out


def quantiles_from_residuals(point: np.ndarray, deciles: np.ndarray) -> np.ndarray:
    return point[:, :, None] + deciles[None, :, :]


# ---------- short-horizon baselines (15-minute grid) ----------

STEPS_PER_DAY = 96


def seasonal_naive_24h(x: np.ndarray, origins: np.ndarray, horizon: int,
                       period: int = STEPS_PER_DAY) -> np.ndarray:
    """The value one (or the nearest whole number of) day(s) before the target."""
    out = np.full((len(origins), horizon), np.nan)
    for i, o in enumerate(origins):
        h = np.arange(1, horizon + 1)
        idx = o + h - period * np.ceil(h / period).astype(int)
        ok = idx >= 0
        out[i, ok] = x[idx[ok]]
    return out


def damped_drift(ctx: np.ndarray, horizon: int, slope_steps: int = 8, phi: float = 0.9) -> np.ndarray:
    """Persistence plus a damped continuation of the last slope."""
    slope = (ctx[:, -1] - ctx[:, -1 - slope_steps]) / slope_steps
    h = np.arange(1, horizon + 1)
    damp = np.cumsum(phi ** h)[None, :]
    return ctx[:, -1:] + slope[:, None] * damp


TIDAL_PERIODS_H = {"M2": 12.4206012, "S2": 12.0, "N2": 12.65834751, "K1": 23.93447213, "O1": 25.81933871}


def tidal_harmonic(t_hours: np.ndarray, x: np.ndarray, t_pred_hours: np.ndarray,
                   ridge: float = 1e-3) -> np.ndarray:
    """Least-squares fit of mean + trend + five constituents (M2 S2 N2 K1 O1) on
    the observed span, evaluated at t_pred. Ridge keeps close constituents
    (M2/N2 need ~28 days to separate) from blowing up on a short window."""
    def design(t):
        cols = [np.ones_like(t), (t - t_hours[0]) / 24.0]
        for period in TIDAL_PERIODS_H.values():
            w = 2 * np.pi / period
            cols += [np.cos(w * t), np.sin(w * t)]
        return np.column_stack(cols)
    ok = ~np.isnan(x)
    X = design(t_hours[ok])
    A = X.T @ X + ridge * np.eye(X.shape[1])
    beta = np.linalg.solve(A, X.T @ x[ok])
    return design(t_pred_hours) @ beta
