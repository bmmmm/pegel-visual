import numpy as np

import baselines as bl


def dates(y0, y1):
    return np.concatenate([np.arange(np.datetime64(f"{y}-01-01"), np.datetime64(f"{y + 1}-01-01")) for y in range(y0, y1 + 1)])


def test_calendar_slot_is_stable_across_leap_years():
    d = np.array(["2000-02-29", "2001-03-01", "2000-03-01", "2001-12-31", "2000-12-31", "2001-01-01"], dtype="datetime64[D]")
    assert bl.calendar_slot(d).tolist() == [59, 60, 60, 365, 365, 0]


def test_climatology_uses_only_years_strictly_before():
    d = dates(2000, 2003)
    years = bl.year_of(d)
    x = (years - 2000).astype(float)  # 0 in 2000, 1 in 2001, ...
    table, y0 = bl.climatology_table(d, x, window=0)
    assert y0 == 2000
    assert np.isnan(table[0]).all(), "the first year has no past"
    assert np.allclose(table[1, :59], 0.0)
    assert np.allclose(table[2, :59], 0.5)
    assert np.allclose(table[3, :59], 1.0)
    # Feb 29 (slot 59) only exists in 2000 among these years
    assert table[1, 59] == 0.0 and table[2, 59] == 0.0


def test_climatology_forecast_cuts_at_the_origin_year_even_for_next_year_targets():
    d = dates(2000, 2003)
    x = (bl.year_of(d) - 2000).astype(float)
    table, y0 = bl.climatology_table(d, x, window=0)
    o = np.where(d == np.datetime64("2002-12-20"))[0]  # targets run into 2003
    f = bl.climatology_forecast(table, y0, d, o, 30)
    assert np.allclose(f, 0.5), "years < 2002 only: mean of 0 and 1"


def test_blend_limits():
    last = np.array([100.0])
    clim = np.full((1, 90), 20.0)
    assert np.allclose(bl.blend(last, clim, 1e9)[0], 100.0)  # tau -> inf: persistence
    assert np.allclose(bl.blend(last, clim, 1e-9)[0], 20.0)  # tau -> 0: climatology
    b = bl.blend(last, clim, 43)[0]
    assert b[0] > b[1] > b[-1] > 20.0


def test_fit_tau_recovers_a_planted_tau():
    rng = np.random.default_rng(1)
    n, H = 200, 90
    last = rng.normal(300, 50, n)
    clim = rng.normal(250, 30, (n, 1)) + np.zeros((n, H))
    y = bl.blend(last, clim, 30) + rng.normal(0, 0.5, (n, H))
    assert bl.fit_tau(last, clim, y, np.ones((n, H), bool), grid=range(5, 100)) == 30


def test_seasonal_naive_365_reads_the_value_one_year_before_each_target():
    x = np.arange(1000, dtype=float)
    f = bl.seasonal_naive_365(x, np.array([500]), 5)
    assert np.allclose(f[0], [136, 137, 138, 139, 140])


def test_seasonal_naive_24h_uses_the_nearest_whole_day_back():
    x = np.arange(2000, dtype=float)
    f = bl.seasonal_naive_24h(x, np.array([1000]), 200, period=96)
    assert f[0, 0] == 1001 - 96
    assert f[0, 95] == 1096 - 96
    assert f[0, 96] == 1097 - 192
    assert f[0, 191] == 1192 - 192


def test_damped_drift_continues_and_flattens():
    ctx = np.arange(100, dtype=float)[None, :]  # slope 1
    f = bl.damped_drift(ctx, 50, slope_steps=8, phi=0.5)[0]
    assert f[0] == 99 + 0.5 and abs(f[-1] - 100.0) < 1e-6  # geometric sum -> 1


def test_residual_deciles_are_monotone_and_shape_correct():
    rng = np.random.default_rng(0)
    resid = rng.normal(0, 10, (500, 4))
    dec = bl.residual_deciles(resid, np.ones((500, 4), bool))
    assert dec.shape == (4, 9)
    assert (np.diff(dec, axis=1) > 0).all()
    q = bl.quantiles_from_residuals(np.zeros((3, 4)), dec)
    assert q.shape == (3, 4, 9)


def test_tidal_harmonic_recovers_a_pure_m2_tide():
    t = np.arange(0, 20 * 24, 0.25)  # 20 days in hours
    w = 2 * np.pi / bl.TIDAL_PERIODS_H["M2"]
    x = 500 + 150 * np.cos(w * t + 0.7)
    pred = bl.tidal_harmonic(t, x, t[-1] + np.arange(0.25, 48.25, 0.25))
    truth = 500 + 150 * np.cos(w * (t[-1] + np.arange(0.25, 48.25, 0.25)) + 0.7)
    assert np.abs(pred - truth).max() < 2.0


def test_upstream_ols_recovers_a_linear_law():
    rng = np.random.default_rng(2)
    n, H = 300, 3
    x_t = rng.normal(400, 50, n)
    x_up = rng.normal(300, 40, n)
    clim = rng.normal(350, 10, (n, H))
    y = 10 + 0.5 * x_t[:, None] + 0.4 * x_up[:, None] + 0.1 * clim
    train = np.arange(n) < 200
    pred = bl.upstream_ols(x_t, x_up, clim, y, np.ones((n, H), bool), train)
    assert np.abs(pred[~train] - y[~train]).max() < 1e-6
