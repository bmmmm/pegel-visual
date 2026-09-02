import json

import numpy as np
import pytest

import loaders


def test_mid_of_matches_the_js_port():
    # the same cases as tests/river-totals.test.mjs 'midOf'
    assert loaders.mid_of(100, 101) == 100.5
    assert loaders.mid_of(100, None) is None
    assert loaders.mid_of(None, 101) is None
    assert loaders.mid_of(0, 0) == 0  # zero is a value, not a gap
    assert loaders.mid_of(614, 99999) is None  # LOBITH: one sentinel poisons the day
    assert loaders.mid_of(-9999, 620) is None
    assert loaders.mid_of(-300, 620) == 160  # real NAP ebb values stay in


def test_plausible_bounds_match_the_two_js_copies():
    assert loaders.PLAUSIBLE_MIN_CM == -2000
    assert loaders.PLAUSIBLE_MAX_CM == 20000


def write_station(tmp_path, uuid, years):
    d = tmp_path / uuid
    d.mkdir()
    (d / "closed.json").write_text(json.dumps(years))
    (d / "meta.json").write_text(json.dumps({"name": "TEST", "fetchedThrough": 2001}))


def test_load_station_builds_a_contiguous_daily_series(tmp_path):
    y2000 = {"y": 2000, "min": [100] * 366, "max": [200] * 366}
    y2001 = {"y": 2001, "min": [100] * 365, "max": [200] * 365}
    y2000["min"][10] = None          # a day without a min -> mid gap, max kept
    y2001["max"][5] = 99999          # sentinel -> mid gap AND dmax gap
    write_station(tmp_path, "u1", [y2000, y2001])
    s = loaders.load_station(tmp_path, "u1", first=2000, last=2001)
    assert len(s) == 731 and s.name == "TEST"
    assert str(s.dates[0]) == "2000-01-01" and str(s.dates[366]) == "2001-01-01" and str(s.dates[-1]) == "2001-12-31"
    assert s.mid[0] == 150 and np.isnan(s.mid[10]) and s.dmax[10] == 200
    assert np.isnan(s.mid[366 + 5]) and np.isnan(s.dmax[366 + 5]) and s.dmin[366 + 5] == 100


def test_load_station_missing_year_is_all_nan(tmp_path):
    write_station(tmp_path, "u2", [{"y": 2001, "min": [1] * 365, "max": [3] * 365}])
    s = loaders.load_station(tmp_path, "u2", first=2000, last=2001)
    assert np.isnan(s.mid[:366]).all() and (s.mid[366:] == 2).all()


def test_fill_gaps_policy():
    x = np.array([np.nan, 1, np.nan, np.nan, 4, 5, np.nan, np.nan, np.nan, np.nan, np.nan, 11, 12] + [np.nan] * 8 + [21, 22], float)
    filled, run_len = loaders.fill_gaps(x)
    assert run_len[0] == -1 and np.isnan(filled[0]), "a leading gap has no left anchor"
    assert run_len[2] == 2 and run_len[3] == 2 and filled[2] == 2 and filled[3] == 3
    assert run_len[6] == 5 and np.allclose(filled[6:11], [6, 7, 8, 9, 10])
    assert (run_len[13:21] == -1).all() and np.isnan(filled[13:21]).all(), "8 days stays a hole"
    assert run_len[1] == 0 and run_len[11] == 0


def test_windows_drop_long_gaps_and_mask_medium_ones():
    x = np.arange(60, dtype=float)
    x[20:25] = np.nan   # 5-day run: interpolated, never a target
    x[45:53] = np.nan   # 8-day run: window-killing hole
    filled, run_len = loaders.fill_gaps(x)
    L, H = 5, 6
    origins = np.array([10, 18, 30, 38, 40, 44])
    kept, ctx, y, tmask = loaders.windows(filled, run_len, origins, L, H)
    assert kept.tolist() == [10, 18, 30, 38]  # 40's and 44's targets reach into the 8-day hole
    assert ctx.shape == (4, L) and y.shape == (4, H)
    assert tmask[0].all()
    assert tmask[1].tolist() == [True, False, False, False, False, False]  # targets 19..24: 20-24 sit in the 5-day run
    assert np.allclose(ctx[0], [6, 7, 8, 9, 10]) and np.allclose(y[0], [11, 12, 13, 14, 15, 16])


def test_windows_short_gap_targets_still_count():
    x = np.arange(40, dtype=float)
    x[15:18] = np.nan  # 3-day run
    filled, run_len = loaders.fill_gaps(x)
    kept, ctx, y, tmask = loaders.windows(filled, run_len, np.array([12]), 4, 8)
    assert kept.tolist() == [12] and tmask.all()


def real_dates():
    parts = [np.arange(np.datetime64(f"{y}-01-01"), np.datetime64(f"{y + 1}-01-01")) for y in range(2000, 2026)]
    return np.concatenate(parts)


def test_origin_grid_and_split_reproduce_the_plan_counts():
    dates = real_dates()
    assert len(dates) == 9497
    grid = loaders.origin_grid(len(dates), 1024, 90, 7)
    train, test = loaders.split_origins(grid, dates, 90)
    assert len(train) == 676 and len(test) == 509
    assert train.max() + 90 < test.min()
    assert str(dates[test.min()]) >= "2016-01-01"
    assert str(dates[train.max()] + np.timedelta64(90, "D")) < "2016-01-01"
    assert grid[0] == 1023 and grid[-1] + 90 <= len(dates) - 1


def test_split_origins_keeps_the_embargo_for_any_cut_date():
    dates = real_dates()
    grid = loaders.origin_grid(len(dates), 1024, 90, 7)
    for cut in ("2010-06-15", "2016-01-01", "2020-02-29"):
        train, test = loaders.split_origins(grid, dates, 90, test_from=np.datetime64(cut))
        assert test.min() - train.max() >= 90
        assert not np.isin(train, test).any()


def test_windows_context_ends_exactly_at_the_origin():
    x = np.arange(300, dtype=float)
    filled, run_len = loaders.fill_gaps(x)
    origins = loaders.origin_grid(len(x), 50, 10, 7)
    kept, ctx, y, _ = loaders.windows(filled, run_len, origins, 50, 10)
    assert np.array_equal(ctx[:, -1], x[kept]), "the last context value is x[o]"
    assert np.array_equal(y[:, 0], x[kept + 1]), "the first target is x[o+1]"


def test_load_hires_reads_month_shards_onto_a_15_minute_grid(tmp_path):
    (tmp_path / "u").mkdir()
    aug = {"month": "2026-08", "points": [["2026-08-31T23:45:00.000Z", 0]]}
    sep = {"month": "2026-09", "points": [["2026-09-01T00:00:00.000Z", 1], ["2026-09-01T00:15:00.000Z", 2],
                                          ["2026-09-01T00:45:00.000Z", 4], ["2026-09-01T00:52:00.000Z", 9]]}
    (tmp_path / "u" / "2026-09.json").write_text(json.dumps(sep))
    (tmp_path / "u" / "2026-08.json").write_text(json.dumps(aug))
    (tmp_path / "u" / "runs.json").write_text(json.dumps({"runs": []}))
    grid, vals = loaders.load_hires(tmp_path, "u")
    assert len(grid) == 5 and str(grid[0]) == "2026-08-31T23:45", "shards concatenate in month order"
    assert vals[0] == 0 and vals[1] == 1 and vals[2] == 2 and np.isnan(vals[3]) and vals[4] == 4, "off-grid stamps are ignored"
    assert loaders.load_hires(tmp_path, "missing") == (None, None)
    (tmp_path / "e").mkdir()
    assert loaders.load_hires(tmp_path, "e") == (None, None)
