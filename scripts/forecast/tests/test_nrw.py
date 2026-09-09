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
import tfm  # noqa: E402


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

NRW_MAX_HORIZON = 64  # ceil(14 / 64) * 64, as backtest.py computes it


def _header(**over):
    """A header that is VALID, so a test about a verdict is not silently a test
    about VOID. The fingerprint is computed, never pinned: pinning it here would
    make every one of these tests fail the day a config field moves, for a reason
    that has nothing to do with what they check."""
    key = over.get("model_key", "3p0-rain")
    cfg = {**tfm.MODELS[key]["config"], "max_horizon": NRW_MAX_HORIZON}
    h = {"model_key": key, "config_fingerprint": tfm.config_fingerprint(cfg),
         "model_ran": True, "limit": None,
         "repeat_identical": True, "arm": "rain", "precip_sha256": "abc",
         "forecast_config": {"max_horizon": NRW_MAX_HORIZON}, "stations": {}}
    h.update(over)
    if "model_key" in over and "config_fingerprint" not in over:
        h["config_fingerprint"] = tfm.config_fingerprint(
            {**tfm.MODELS[over["model_key"]]["config"], "max_horizon": NRW_MAX_HORIZON})
    return h


def _data(origins=(10, 20, 30)):
    """A minimal npz-shaped run whose witness agrees: `cov_last` is what the
    covariate ended on and `rain_lags_first` the rain of day o-1, read a
    different way. Equal here means "no leak"."""
    o = np.array(origins)
    w = o.astype(float) * 0.5
    return {u: {"origins": o, "is_train": np.zeros(len(o), bool), "is_test": np.ones(len(o), bool),
                "y": np.zeros((len(o), 14)), "cov_last": w.copy(), "rain_lags_first": w.copy()}
            for u in st.NRW_POOLED}


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


def test_the_leak_witness_catches_a_covariate_built_the_wrong_way(tmp_path, monkeypatch):
    """The one test this experiment stands or falls on.

    The previous version fabricated `cov_max_index = origins`, an input the
    builder can never emit — and it stayed GREEN when `_nrw_covariate` was made
    to genuinely leak, because the witness was derived from `origins` and
    compared against `origins`. This one breaks the BUILDER and asks the gate.
    """
    n = TOTAL
    lv = [50.0 + (i % 11) for i in range(n)]
    rain = [float(i % 23) for i in range(n)]
    tree = write_mirror(tmp_path / "nrw", "g1", level=lv, rain=rain)
    proto = dict(backtest.NRW)
    proto["context"] = 32                        # a small window: the shift is what matters
    monkeypatch.setattr(st, "NRW_STATIONS", {"g1": ("G1", "B", 1.0, 5, 50)})
    monkeypatch.setattr(st, "NRW_POOLED", ("g1",))

    honest, _ = backtest.backtest_nrw_station("g1", tree, None, proto, "rain", lambda m: None)
    data = {"g1": honest}
    header = _header(precip_sha256="a")
    other = ({**header, "arm": "plain", "model_key": "3p0"}, data)
    v = [r for r in gate.nrw_void(header, data, TH, other) if "rain day o-1" in r or "witness" in r]
    assert v == [], f"an honest run must carry a clean witness: {v}"

    # now make it leak: the covariate ends on the origin's OWN rain day
    real = backtest._nrw_covariate

    def leaking(rain_arr, origins, context):
        out = np.full((len(origins), context), np.nan)
        for i, o in enumerate(origins):
            idx = np.arange(o - context + 1, o + 1)
            if idx.min() >= 0:
                out[i] = rain_arr[idx]
        return out

    monkeypatch.setattr(backtest, "_nrw_covariate", leaking)
    leaked, _ = backtest.backtest_nrw_station("g1", tree, None, proto, "rain", lambda m: None)
    monkeypatch.setattr(backtest, "_nrw_covariate", real)
    v2 = gate.nrw_void(header, {"g1": leaked}, TH, ({**header, "arm": "plain", "model_key": "3p0"}, {"g1": leaked}))
    assert any("does not end on rain day o-1" in r for r in v2), \
        f"a leaking covariate must be VOID, not scored: {v2}"


def test_a_run_without_a_witness_at_all_is_void():
    d = _data()
    for u in d:
        d[u].pop("cov_last", None)
        d[u].pop("rain_lags_first", None)
    v = gate.nrw_void(_header(), d, TH, (_header(arm="plain", model_key="3p0"), _data()))
    assert any("no covariate witness" in r for r in v), "silence is not a passing witness"


def test_a_fingerprint_that_is_not_the_registered_one_is_void():
    """The header is honest by construction in these tests, so this is the one
    that proves the check still bites."""
    v = gate.nrw_void(_header(config_fingerprint="deadbeef"), _data(), TH, (_header(arm="plain", model_key="3p0"), _data()))
    assert any("fingerprint differs" in r for r in v)


def test_a_truncated_or_unrepeatable_run_is_void():
    assert any("truncated" in r for r in gate.nrw_void(_header(limit=5), _data(), TH, (_header(arm="plain", model_key="3p0"), _data())))
    assert any("bit for bit" in r for r in gate.nrw_void(_header(repeat_identical=None), _data(), TH, (_header(arm="plain", model_key="3p0"), _data())))
    assert any("baselines only" in r for r in gate.nrw_void(_header(model_ran=False), _data(), TH, (_header(arm="plain", model_key="3p0"), _data())))


def test_a_missing_station_is_void():
    d = _data()
    d.pop(next(iter(d)))
    v = gate.nrw_void(_header(), d, TH, (_header(arm="plain", model_key="3p0"), _data()))
    assert any("missing from the results" in r for r in v)


# ---------- the house verdict ----------

def _run(stations_info, model_key="3p0-rain", ss=0.2):
    """nrw_report over a synthetic run: the real function, the real thresholds.

    The previous version re-implemented the reason list inline and asserted its
    own list comprehension was non-empty — it stayed green with `nrw_report`
    deleted and `THRESHOLDS` emptied.
    """
    header = _header(model_key=model_key,
                     protocol={"blocks": {"h1-3": [1, 3], "h4-7": [4, 7], "h8-14": [8, 14]}},
                     stations=stations_info)
    n = 20
    o = np.arange(100, 100 + n)
    H = 14
    y = np.zeros((n, H))
    w = o.astype(float) * 0.5
    def arm(err):
        return {"origins": o, "is_train": np.zeros(n, bool), "is_test": np.ones(n, bool),
                "y": y, "tmask": np.ones((n, H), bool), "last": np.zeros(n),
                "persist": np.full((n, H), 3.0), "snaive": np.full((n, H), 9.0),
                "blend": np.full((n, H), 4.0), "blend_q": np.zeros((n, H, 9)),
                "rain_ols": np.full((n, H), 5.0), "rain_lags": np.zeros((n, 4)),
                "tfm_point": np.full((n, H), err), "tfm_q": np.zeros((n, H, 9)),
                "tau": np.array(30), "d_h": np.ones(H),
                "cov_last": w.copy(), "rain_lags_first": w.copy()}
    data = {u: arm(4.0 * (1 - ss)) for u in st.NRW_POOLED}
    other = (_header(arm='plain', model_key='3p0', stations=stations_info,
                     protocol={'blocks': {'h1-3': [1, 3], 'h4-7': [4, 7], 'h8-14': [8, 14]}}),
             {u: arm(4.0) for u in st.NRW_POOLED})
    return gate.nrw_report(header, data, dict(gate.THRESHOLDS), other, None)


FULL = {u: {"name": st.nrw_name_of(u), "kept": 48, "rain_events": 30} for u in st.NRW_POOLED}


def test_a_thin_run_is_provisional_and_says_which_floor_it_missed():
    thin = {u: {**v, "kept": 39} for u, v in FULL.items()}
    rep = _run(thin)
    assert rep["verdict"] == "PROVISIONAL"
    assert any("39/40 origins" in r for r in rep["provisional_reasons"]), rep["provisional_reasons"]
    dry = {u: {**v, "rain_events": 9} for u, v in FULL.items()}
    rep2 = _run(dry)
    assert rep2["verdict"] == "PROVISIONAL"
    assert any("9/10 rain events" in r for r in rep2["provisional_reasons"]), rep2["provisional_reasons"]
    # …and a full one is not provisional
    assert _run(FULL)["verdict"] != "PROVISIONAL"


def test_a_line_that_cannot_ship_never_earns_a_ship_verdict():
    """SHIP is a claim about shipping, and gate.py's exit code is its
    machine-readable form. Every arm here carries non-commercial weights."""
    rep = _run(FULL, ss=0.5)          # comfortably over U1 and U2
    assert rep["pooled"]["blocks"]["h1-3"]["ss"] > gate.THRESHOLDS["U1_ss_h1_3_min"]
    assert rep["verdict"] == "NO-SHIP", "a non-shippable line scoring well is still NO-SHIP"
    assert {"SHIP": 0, "NO-SHIP": 1, "VOID": 2, "PROVISIONAL": 3}[rep["verdict"]] != 0


def test_a_bad_run_is_no_ship_on_the_numbers_too():
    rep = _run(FULL, ss=-0.5)
    assert rep["verdict"] == "NO-SHIP"


def test_against_the_wrong_arm_is_void_before_anything_is_scored():
    """--against <the shuffled run> used to produce a full clause table whose
    R1/R2/R4 measured rain-against-shuffled under a heading that said plain."""
    header = _header(protocol={"blocks": {"h1-3": [1, 3]}}, stations=FULL)
    d = _data()
    # the registry key scores 3.85 bits and looks like a token to a rule that
    # measures entropy alone; it is the name of a forecast arm and grants nothing
    wrong = ({**header, "arm": "shuffled", "model_key": "3p0-rain-shuffled"}, d)  # gitleaks:allow
    v = gate.nrw_void(header, d, TH, wrong)
    assert any("not the plain one" in r for r in v)
    same = ({**header, "arm": "plain"}, d)   # same model_key as --results
    assert any("cannot be its own control" in r for r in gate.nrw_void(header, d, TH, same))


def test_two_arms_on_different_grids_are_void_and_do_not_crash():
    """The mirror rolls daily, so re-running one arm a day later moves its grid.
    That used to raise a numpy broadcast error out of the middle of scoring."""
    header = _header(protocol={"blocks": {"h1-3": [1, 3], "h4-7": [4, 7], "h8-14": [8, 14]}}, stations=FULL)
    a_data = _data(origins=(10, 20, 30))
    b_data = _data(origins=(10, 20, 40))
    rep = gate.nrw_report(header, a_data, dict(gate.THRESHOLDS), ({**header, "arm": "plain", "model_key": "3p0"}, b_data), None)
    assert rep["verdict"] == "VOID"
    assert any("do not share their TEST origins" in r for r in rep["void"])
    assert rep["clauses"] == {}, "a void run states no clauses"


def test_the_control_arm_is_far_from_the_window_it_replaces():
    """A plain derangement hands a window the rain of seven days earlier, which
    shares 377 of its 384 days. Measured on seed 7 before the fix: 2 of 48
    windows within one step, 6 within three."""
    rows = np.arange(48)[:, None] * np.ones((1, 4))
    out = backtest._deranged(rows, backtest.MIN_SHUFFLE_DISTANCE)
    moved = np.minimum(np.abs(out[:, 0] - np.arange(48)), 48 - np.abs(out[:, 0] - np.arange(48)))
    assert moved.min() >= backtest.MIN_SHUFFLE_DISTANCE, f"closest window moved only {moved.min()} origins"
    assert moved.min() == 24, "a half-cycle moves every window the same maximal distance"
    # deterministic, so two runs of the same arm reproduce
    assert np.array_equal(out, backtest._deranged(rows, backtest.MIN_SHUFFLE_DISTANCE))
    # a run too short for the distance is refused, not quietly shifted by one
    # origin (which at step 7 is the rain of seven days earlier)
    short = np.arange(3)[:, None] * np.ones((1, 2))
    with pytest.raises(ValueError, match="too short"):
        backtest._deranged(short, 8)
    assert backtest._deranged(np.arange(16)[:, None] * np.ones((1, 2)), 8).shape == (16, 2), 'sixteen is enough'


# ---------- the control arm gets the same checks the plain arm got ----------

def test_a_control_that_is_an_arm_already_in_the_comparison_is_void():
    """`--against` earned four checks on 2026-09-07; `--control` had none, so
    `--control <the plain run>` scored the plain arm against itself: control_ss
    0.0, gap 0.273, R1-R5 all PASS, RAIN HELPS (measured 2026-09-09)."""
    header = _header(protocol={"blocks": {"h1-3": [1, 3], "h4-7": [4, 7], "h8-14": [8, 14]}}, stations=FULL)
    d = _data()
    plain = ({**header, "arm": "plain", "model_key": "3p0"}, d)
    rep = gate.nrw_report(header, d, dict(gate.THRESHOLDS), plain, plain)
    assert rep["verdict"] == "VOID"
    assert any("--control" in r and "control" in r for r in rep["void"]), rep["void"]
    assert rep["rain_verdict"] is None
    # …and the rain arm itself is no control either
    rep2 = gate.nrw_report(header, d, dict(gate.THRESHOLDS), plain, (header, d))
    assert rep2["verdict"] == "VOID", rep2["void"]


def test_a_control_that_is_not_the_registered_control_arm_is_void():
    header = _header(protocol={"blocks": {"h1-3": [1, 3]}}, stations=FULL)
    d = _data()
    plain = ({**header, "arm": "plain", "model_key": "3p0"}, d)
    # a fourth run under a non-control key — a plain 2.5 line, say
    stray = (_header(arm="plain", model_key="2p5"), d)
    v = gate.nrw_void(header, d, TH, plain, stray)
    assert any("--control" in r and "registered" in r for r in v), v
    # different rain bytes, or a different grid, void it exactly like --against
    ctl = _header(arm="shuffled", model_key="3p0-rain-shuffled")   # gitleaks:allow
    assert any("precip bytes" in r for r in gate.nrw_void(header, d, TH, plain, ({**ctl, "precip_sha256": "x"}, d)))
    assert any("TEST origins" in r for r in gate.nrw_void(header, d, TH, plain, (ctl, _data(origins=(10, 20, 40)))))
    # and the honest control passes every one of them
    assert gate.nrw_void(header, d, TH, plain, (ctl, d)) == []


def test_a_p_of_exactly_zero_is_the_strongest_evidence_not_the_weakest():
    """`(p or 1.0)` turned p = 0.0 into 1.0. It is reachable: the DM variance
    is clamped at 1e-12 and erfc underflows (measured z = 1.4e7, p = 0.0), so
    R1 failed exactly when the rain arm won most clearly."""
    control = _pool(0.1, vs_other=0.0)
    cl = gate.nrw_clauses(_pool(0.2, vs_other=0.08, dm_p=0.0), _stations(0.08), control, TH)
    assert cl["R1"]["pass"] is True, cl["R1"]
    # …and on the HARMS side, where the same expression decided the verdict
    bad = _pool(-0.2, vs_other=-0.2, dm_p=0.0)
    assert gate.rain_verdict(gate.nrw_clauses(bad, _stations(-0.2), control, TH), bad, _stations(-0.2), TH) == "RAIN HARMS"
    # a MISSING p still counts as no evidence
    cl3 = gate.nrw_clauses(_pool(0.2, vs_other=0.08, dm_p=None), _stations(0.08), control, TH)
    assert cl3["R1"]["pass"] is False
