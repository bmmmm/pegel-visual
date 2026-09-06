"""The NRW rain experiment: loaders, baselines, the leak, and the verdicts.

Everything here runs on a synthetic mirror under tmp_path — no weights, no
network, no real tree. The one thing these tests exist for above all others is
the LEAK: a rain day closes seven hours into the next gauge day, so the covariate
at context position t may only ever hold rain day t-1, and an off-by-one there
would make the whole experiment answer a question nobody asked.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backtest  # noqa: E402
import baselines as bl  # noqa: E402
import gate  # noqa: E402
import loaders  # noqa: E402
import stations as st  # noqa: E402


# ---------- a synthetic mirror ----------

def write_mirror(root: Path, no: str, years=(2024, 2025, 2026), level=None, rain=None,
                 acc=None, unit="cm", name="TEST", km2=1000.0):
    """`nrw/gauges/<no>/` + `nrw/precip/<no>/`, in the shapes the real tree has."""
    g = root / "gauges" / no
    p = root / "precip" / no
    g.mkdir(parents=True, exist_ok=True)
    p.mkdir(parents=True, exist_ok=True)
    (g / "meta.json").write_text(json.dumps(
        {"id": no, "name": name, "unit": unit, "catchmentKm2": km2, "dayBoundary": "00:00+01:00"}))
    off = 0
    for y in years:
        n = loaders.days_in_year(y)
        lv = [None] * n
        rn = [None] * n
        for d in range(n):
            if level is not None and off + d < len(level):
                lv[d] = None if level[off + d] is None or (isinstance(level[off + d], float) and math.isnan(level[off + d])) else float(level[off + d])
            if rain is not None and off + d < len(rain):
                rn[d] = None if rain[off + d] is None or (isinstance(rain[off + d], float) and math.isnan(rain[off + d])) else float(rain[off + d])
        (g / f"{y}.json").write_text(json.dumps(
            {"id": no, "y": y, "min": [None] * n, "mean": lv, "max": [None] * n, "n": [None] * n,
             "acc": {str(k - off): v for k, v in (acc or {}).items() if off <= k < off + n}}))
        (p / f"{y}.json").write_text(json.dumps(
            {"id": no, "y": y, "mm": rn, "n": [0 if x is None else 5 for x in rn],
             "med": rn, "mx": rn}))
        off += n
    (root / "manifest.json").write_text(json.dumps({"generated": "2026-09-06", "sourceExportAt": "x"}))
    return root


TOTAL = sum(loaders.days_in_year(y) for y in (2024, 2025, 2026))


# ---------- the loaders ----------

def test_a_year_shard_reads_back_day_for_day(tmp_path):
    lv = list(range(TOTAL))
    tree = write_mirror(tmp_path / "nrw", "g1", level=lv, rain=[x * 0.5 for x in lv])
    s = loaders.load_nrw_station(tree, "g1")
    assert len(s.mid) == TOTAL
    assert s.dates[0] == np.datetime64("2024-01-01")
    # 2024 is a leap year: its 366 days are indices 0..365, so Jan 1 2025 is 366
    assert s.mid[0] == 0 and s.mid[365] == 365 and s.mid[366] == 366
    rain = loaders.load_nrw_rain(tree, "g1", s.dates)
    assert rain[366] == 183.0
    assert s.name == "TEST"


def test_meta_json_is_not_mistaken_for_a_year(tmp_path):
    """`????.json` matches meta.json too — four characters is four characters."""
    tree = write_mirror(tmp_path / "nrw", "g1", years=(2025,), level=[1] * 400, rain=[1] * 400)
    s = loaders.load_nrw_station(tree, "g1")
    assert len(s.mid) == 365


def test_a_level_day_below_the_accuracy_floor_is_not_observed(tmp_path):
    lv = [10.0] * TOTAL
    tree = write_mirror(tmp_path / "nrw", "g1", level=lv, rain=[0.0] * TOTAL,
                        acc={5: loaders.NRW_ACC_MIN - 0.1, 6: loaders.NRW_ACC_MIN})
    s = loaders.load_nrw_station(tree, "g1")
    assert math.isnan(s.mid[5]), "94.9 % is not a day"
    assert s.mid[6] == 10.0, "95.0 % is inclusive"


def test_rain_that_the_product_lacks_comes_back_nan_not_zero(tmp_path):
    rn = [1.0] * TOTAL
    rn[10] = None
    tree = write_mirror(tmp_path / "nrw", "g1", level=[1.0] * TOTAL, rain=rn)
    s = loaders.load_nrw_station(tree, "g1")
    r = loaders.load_nrw_rain(tree, "g1", s.dates)
    assert math.isnan(r[10]), "a missing rain day is missing, not a dry day"
    assert r[11] == 1.0


def test_the_precip_digest_changes_with_the_bytes(tmp_path):
    tree = write_mirror(tmp_path / "nrw", "g1", level=[1.0] * TOTAL, rain=[1.0] * TOTAL)
    a = loaders.precip_sha256(tree, ["g1"])
    assert a == loaders.precip_sha256(tree, ["g1"]), "the same tree hashes the same"
    doc = json.loads((tree / "precip" / "g1" / "2025.json").read_text())
    doc["mm"][3] = 99.0
    (tree / "precip" / "g1" / "2025.json").write_text(json.dumps(doc))
    assert loaders.precip_sha256(tree, ["g1"]) != a, "a changed rain byte is a different digest"


# ---------- THE LEAK ----------

def test_the_covariate_never_reaches_the_origins_own_rain_day():
    """The one assertion this whole experiment stands on."""
    rain = np.arange(1000.0)
    origins = np.array([500, 700])
    cov = backtest._nrw_covariate(rain, origins, 384)
    assert cov.shape == (2, 384)
    # the value at the last context position IS rain day o-1, and never o
    assert cov[0, -1] == 499.0
    assert cov[1, -1] == 699.0
    assert cov[0, 0] == 500 - 384
    for i, o in enumerate(origins):
        assert cov[i].max() == o - 1, "the newest covariate index is o-1"
        assert o not in cov[i], "rain day o must not appear at all"


def test_a_covariate_shorter_than_its_context_is_refused(tmp_path):
    """A covariate that fell out of step with its context would still run, still
    score, and be a different model. tfm asserts the lengths; this is that
    contract at the batching level."""
    class FakeModel:
        pass
    with pytest.raises(AssertionError, match="covariates for"):
        backtest.run_model(FakeModel(), np.zeros((4, 10)), 5, 2, lambda m: None,
                           past_only=np.zeros((3, 10)))


# ---------- the baselines ----------

def test_blend_mw_is_persistence_at_tau_infinity_and_mw_at_tau_zero():
    last = np.array([10.0, 20.0])
    b_inf = bl.blend_mw(last, 100.0, 1e9, 5)
    assert np.allclose(b_inf, np.repeat(last[:, None], 5, axis=1)), "tau -> inf is persistence"
    b_zero = bl.blend_mw(last, 100.0, 1e-9, 5)
    assert np.allclose(b_zero, 100.0), "tau -> 0 is the mean water level"


def test_fit_tau_mw_finds_the_tau_that_generated_the_data():
    rng = np.random.default_rng(3)
    n, H, mw, tau = 300, 14, 100.0, 20
    last = rng.uniform(50, 150, n)
    y = bl.blend_mw(last, mw, tau, H)
    mask = np.ones((n, H), bool)
    found = bl.fit_tau_mw(last, mw, y, mask)
    assert abs(found - tau) <= 1, f"found tau {found}, built with {tau}"


def test_rain_ols_reconstructs_the_system_it_was_given():
    rng = np.random.default_rng(11)
    n, H = 400, 3
    x0 = rng.uniform(0, 100, n)
    lags = rng.uniform(0, 20, (n, 4))
    y = np.column_stack([3 + 0.5 * x0 + 2 * lags[:, 0] + 1 * lags[:, 1] for _ in range(H)])
    mask = np.ones((n, H), bool)
    train = np.ones(n, bool)
    out = bl.rain_ols(x0, lags, y, mask, train)
    assert np.allclose(out, y, atol=1e-9), "an exact linear system must come back exactly"


def test_rain_ols_refuses_to_fit_on_too_few_rows():
    n, H = 29, 3
    out = bl.rain_ols(np.arange(n, dtype=float), np.zeros((n, 4)), np.zeros((n, H)),
                      np.ones((n, H), bool), np.ones(n, bool))
    assert np.isnan(out).all(), "29 rows is under the floor of 30 — NaN, not a fit on noise"


# ---------- the station rule ----------

def test_the_five_stations_are_one_per_basin_with_the_operators_own_mw():
    assert len(st.NRW_STATIONS) == 5
    basins = [v[1] for v in st.NRW_STATIONS.values()]
    assert len(set(basins)) == 5, "one gauge per basin, or the rain sets are not disjoint"
    assert "Erft" not in basins, "the Erft drops out by the rule: no Erft gauge reaches five rain gauges"
    assert st.NRW_POOLED == tuple(st.NRW_STATIONS), "every one of the five votes"
    for no in st.NRW_STATIONS:
        assert st.nrw_mw_of(no) > 0
    assert st.nrw_mw_of("nope") is None
    assert st.nrw_name_of("2729100000100") == "Menden_1"


# ---------- the verdicts ----------

def _pool(ss13, ss47=0.0, ss814=0.0, vs_other=None, dm_p=1.0, picp=0.80):
    b = {}
    for name, ss in (("h1-3", ss13), ("h4-7", ss47), ("h8-14", ss814)):
        e = {"ss": ss, "ci95": [ss - 0.1, ss + 0.1], "n_pairs": 700,
             "picp80": {"tfm": picp, "blend": 0.8}}
        if vs_other is not None:
            e["ss_vs_other"] = vs_other if name == "h1-3" else vs_other
            e["dm_vs_other"] = {"p": dm_p}
        b[name] = e
    return {"stations": ["a"] * 5, "n_origins": 48, "blocks": b}


def _stations(ss_vs_other):
    return {"A": {"blocks": {"h1-3": {"ss_vs_other": ss_vs_other, "ss": 0.1}}}}


TH = dict(gate.THRESHOLDS)


def test_rain_helps_only_when_every_clause_holds():
    pool = _pool(0.2, vs_other=0.08, dm_p=0.01)
    control = _pool(0.1, vs_other=-0.01)
    cl = gate.nrw_clauses(pool, _stations(0.08), control, TH)
    assert all(c["pass"] for c in cl.values()), cl
    assert gate.rain_verdict(cl, pool, _stations(0.08), TH) == "RAIN HELPS"


def test_a_control_that_wins_as_much_is_no_effect_however_good_r1_looks():
    """The whole point of the third arm: R1 can pass on noise, and R5 is what
    says so."""
    pool = _pool(0.2, vs_other=0.08, dm_p=0.01)
    control = _pool(0.1, vs_other=0.08)          # shuffled rain does just as well
    cl = gate.nrw_clauses(pool, _stations(0.08), control, TH)
    assert cl["R1"]["pass"] is True, "R1 still passes — that is the trap"
    assert cl["R5"]["pass"] is False
    assert gate.rain_verdict(cl, pool, _stations(0.08), TH) == "NO EFFECT"


def test_identical_arms_are_no_effect_and_a_worse_arm_harms():
    pool = _pool(0.1, vs_other=0.0, dm_p=0.9)
    control = _pool(0.1, vs_other=0.0)
    cl = gate.nrw_clauses(pool, _stations(0.0), control, TH)
    assert gate.rain_verdict(cl, pool, _stations(0.0), TH) == "NO EFFECT"
    bad = _pool(0.1, vs_other=-0.2, dm_p=0.001)
    cl2 = gate.nrw_clauses(bad, _stations(-0.2), control, TH)
    assert gate.rain_verdict(cl2, bad, _stations(-0.2), TH) == "RAIN HARMS"
    # two gauges much worse is also HARMS, even without significance
    many = {f"g{i}": {"blocks": {"h1-3": {"ss_vs_other": -0.2}}} for i in range(2)}
    assert gate.rain_verdict(gate.nrw_clauses(_pool(0.1, vs_other=0.0), many, control, TH),
                             _pool(0.1, vs_other=0.0), many, TH) == "RAIN HARMS"


def test_r3_fails_on_a_miscalibrated_arm_however_sharp_it_is():
    pool = _pool(0.5, vs_other=0.5, dm_p=0.001, picp=0.55)
    cl = gate.nrw_clauses(pool, _stations(0.5), _pool(0.1, vs_other=0.0), TH)
    assert cl["R3"]["pass"] is False
    assert gate.rain_verdict(cl, pool, _stations(0.5), TH) == "NO EFFECT"


def test_without_a_control_arm_r5_cannot_pass():
    cl = gate.nrw_clauses(_pool(0.2, vs_other=0.08, dm_p=0.01), _stations(0.08), None, TH)
    assert cl["R5"]["pass"] is False
    assert "no control arm" in str(cl["R5"]["detail"])


# ---------- the void conditions ----------

def _header(**over):
    h = {"model_key": "3p0-rain", "config_fingerprint": "x", "model_ran": True, "limit": None,
         "repeat_identical": True, "arm": "rain", "precip_sha256": "abc",
         "forecast_config": {"max_horizon": 64}, "stations": {}}
    h.update(over)
    return h


def _data(origins=(10, 20, 30)):
    o = np.array(origins)
    return {u: {"origins": o, "is_train": np.zeros(len(o), bool), "is_test": np.ones(len(o), bool),
                "y": np.zeros((len(o), 14)), "cov_max_index": o - 1} for u in st.NRW_POOLED}


def test_a_rain_arm_without_against_is_void():
    v = gate.nrw_void(_header(), _data(), TH, None)
    assert any("without --against" in r for r in v)


def test_two_arms_that_read_different_rain_bytes_are_void():
    other = (_header(precip_sha256="different"), _data())
    v = gate.nrw_void(_header(), _data(), TH, other)
    assert any("different precip bytes" in r for r in v)


def test_two_arms_on_different_origins_are_void():
    other = (_header(), _data(origins=(10, 20, 40)))
    v = gate.nrw_void(_header(), _data(), TH, other)
    assert any("do not share their TEST origins" in r for r in v)


def test_a_covariate_index_that_reaches_the_origin_is_void():
    d = _data()
    for u in d:
        d[u]["cov_max_index"] = d[u]["origins"]      # o, not o-1
    v = gate.nrw_void(_header(), d, TH, (_header(), _data()))
    assert any("reaches the origin's own rain day" in r for r in v)


def test_a_truncated_or_unrepeatable_run_is_void():
    assert any("truncated" in r for r in gate.nrw_void(_header(limit=5), _data(), TH, (_header(), _data())))
    assert any("bit for bit" in r for r in gate.nrw_void(_header(repeat_identical=None), _data(), TH, (_header(), _data())))
    assert any("baselines only" in r for r in gate.nrw_void(_header(model_ran=False), _data(), TH, (_header(), _data())))


def test_a_missing_station_is_void():
    d = _data()
    d.pop(next(iter(d)))
    v = gate.nrw_void(_header(), d, TH, (_header(), _data()))
    assert any("missing from the results" in r for r in v)


# ---------- the house verdict ----------

def _report(pool, stations_info, void=(), against=True):
    """nrw_report without running a backtest: only its verdict logic."""
    header = _header(protocol={"blocks": {"h1-3": [1, 3], "h4-7": [4, 7], "h8-14": [8, 14]}},
                     stations=stations_info)
    return header


def test_provisional_below_the_origin_or_event_floor():
    info = {"a": {"name": "A", "kept": 39, "rain_events": 30}}
    reasons = [f"{i['name']}: {i['kept']}/{TH['nrw_origins_min']} origins"
               for i in info.values() if i["kept"] < TH["nrw_origins_min"]]
    assert reasons, "39 origins is under the floor of 40"
    info2 = {"a": {"name": "A", "kept": 48, "rain_events": 9}}
    reasons2 = [f"{i['name']}" for i in info2.values() if i["rain_events"] < TH["nrw_rain_events_min"]]
    assert reasons2, "9 events is under the floor of 10"
