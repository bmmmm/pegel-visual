import math

import numpy as np

import metrics


def test_mae_respects_mask_and_nan():
    y = np.array([[1.0, 2.0, 3.0]])
    p = np.array([[2.0, 2.0, np.nan]])
    assert metrics.mae(p, y, np.array([[True, True, True]])) == 0.5
    assert metrics.mae(p, y, np.array([[True, False, True]])) == 1.0
    assert math.isnan(metrics.mae(p, y, np.zeros((1, 3), bool)))


def test_skill_and_mase_denominators():
    assert metrics.skill(50.0, 100.0) == 0.5
    x = np.arange(10, dtype=float)
    assert np.allclose(metrics.mase_denominators(x, 3), [1, 2, 3])


def test_crps_zero_for_a_perfect_sharp_forecast_and_grows_with_width():
    y = np.full((1, 4), 10.0)
    sharp = np.repeat(y[:, :, None], 9, axis=2)
    assert np.allclose(metrics.crps_deciles(y, sharp), 0.0)
    wide = y[:, :, None] + np.linspace(-20, 20, 9)[None, None, :]
    wider = y[:, :, None] + np.linspace(-40, 40, 9)[None, None, :]
    assert (metrics.crps_deciles(y, wider) > metrics.crps_deciles(y, wide)).all()


def test_picp_and_pit():
    y = np.array([[0.0, 5.0, 100.0]])
    q = np.repeat(np.linspace(1, 9, 9)[None, None, :], 3, axis=1)
    m = np.ones((1, 3), bool)
    assert metrics.picp(y, q, 0, 8, m) == 1 / 3
    assert metrics.pit_histogram(y, q, m).tolist() == [1, 0, 0, 0, 0, 1, 0, 0, 0, 1]


def test_dm_on_pure_noise_is_not_significant_and_reports_a_small_n_eff():
    """Overlapping 90-day windows make loss differentials autocorrelated: a naive
    t-test would call pure noise significant, the Newey-West version must not."""
    rng = np.random.default_rng(0)
    false_alarms = 0
    n_effs = []
    for _ in range(40):
        white = rng.normal(0, 1, 509 + 12)
        d = np.convolve(white, np.ones(13) / 13, mode="valid")  # MA(12): the overlap structure
        r = metrics.dm_test(d + 0.0, np.zeros(509), lag=13)
        n_effs.append(r["n_eff"])
        if r["p"] < 0.05:
            false_alarms += 1
    assert false_alarms <= 6, false_alarms  # ~5 % nominal, allow slack
    assert np.median(n_effs) < 509 / 5


def test_dm_detects_a_real_improvement():
    rng = np.random.default_rng(1)
    white = rng.normal(0, 1, 509 + 12)
    d = np.convolve(white, np.ones(13) / 13, mode="valid") - 0.5
    r = metrics.dm_test(d, np.zeros(509), lag=13)
    assert r["p"] < 1e-4 and r["z"] > 0


def test_block_bootstrap_indices_are_consecutive_blocks_of_the_right_length():
    rng = np.random.default_rng(0)
    idx = metrics.block_bootstrap_indices(100, 26, rng)
    assert len(idx) == 100 and idx.min() >= 0 and idx.max() < 100
    within = np.diff(idx[:26])
    assert (within % 100 == 1).all()


def test_bootstrap_ci_brackets_the_mean_of_iid_data():
    rng = np.random.default_rng(3)
    x = rng.normal(5, 1, 400)
    lo, hi = metrics.bootstrap_ci(lambda i: x[i].mean(), len(x), 26, B=300, seed=1)
    assert lo < 5 < hi and hi - lo < 0.5


def test_stouffer():
    assert metrics.stouffer([2.0, 2.0, 2.0, 2.0]) == 4.0
    assert math.isnan(metrics.stouffer([float("nan")]))
