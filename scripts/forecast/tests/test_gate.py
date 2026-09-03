"""The clause logic end to end on synthetic results: a clear winner must SHIP, a
model that only matches the blend must not, and a broken header is VOID."""
import json

import numpy as np

import gate
import stations as st
import tfm

BLOCKS = {"h1-14": [1, 14], "h15-30": [15, 30], "h31-90": [31, 90]}
H = 90
DECILE_Z = np.array([-1.2816, -0.8416, -0.5244, -0.2533, 0.0, 0.2533, 0.5244, 0.8416, 1.2816])


def dates():
    return np.concatenate([np.arange(np.datetime64(f"{y}-01-01"), np.datetime64(f"{y + 1}-01-01")) for y in range(2000, 2026)])


def synth_station(rng, model_sigma, blend_sigma=10.0, step=35):
    d = dates()
    origins = np.arange(1023, len(d) - 1 - H, step)
    o_dates = d[origins]
    is_train = o_dates + np.timedelta64(H, "D") < np.datetime64("2016-01-01")
    is_test = o_dates >= np.datetime64("2016-01-01")
    n = len(origins)
    y = 300 + 80 * np.sin(2 * np.pi * np.arange(n)[:, None] / 10) + rng.normal(0, 30, (n, 1)) + np.zeros((n, H))
    blend = y + rng.normal(0, blend_sigma, (n, H))
    tfm_point = y + rng.normal(0, model_sigma, (n, H))
    tfm_q = tfm_point[:, :, None] + model_sigma * DECILE_Z[None, None, :]
    blend_q = blend[:, :, None] + blend_sigma * DECILE_Z[None, None, :]
    return {
        "origins": origins, "o_dates": o_dates, "is_train": is_train, "is_test": is_test, "last": y[:, 0],
        "y": y, "tmask": np.ones((n, H), bool), "persist": y + rng.normal(0, 15, (n, H)), "clim": y + rng.normal(0, 20, (n, H)),
        "snaive": y + rng.normal(0, 25, (n, H)), "blend": blend, "blend_q": blend_q, "tfm_point": tfm_point, "tfm_q": tfm_q,
        "upstream": np.full((n, H), np.nan), "tau": np.array(40), "d_h": np.full(H, 12.0),
    }


def header_for(data, **overrides):
    h = {
        "horizon_kind": "seasonal", "target": "mid", "protocol": {"context": 1024, "horizon": H, "step": 35, "test_from": "2016-01-01", "blocks": BLOCKS},
        "forecast_config": tfm.FORECAST_CONFIG, "config_fingerprint": tfm.config_fingerprint(), "checkpoint": tfm.CHECKPOINT,
        "model": tfm.MODEL_ID, "model_license": tfm.MODEL_LICENSE, "torch_threads": 8, "versions": {"timesfm": "2.0.2", "torch": "x"},
        "git": "test", "generated": "now", "elapsed_s": 1.0, "model_ran": True, "limit": None, "repeat_identical": True, "tfm_sha256": "abc",
        "stations": {u: {"name": st.name_of(u), "pairs_expected": int(d["y"].size), "pairs_scored": int(d["tmask"].sum())} for u, d in data.items()},
    }
    h.update(overrides)
    return h


def thresholds():
    th = dict(gate.THRESHOLDS)
    th["bootstrap_B"] = 200
    return th


def test_a_clear_winner_ships():
    rng = np.random.default_rng(0)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    rep = gate.seasonal_report(header_for(data), data, thresholds())
    assert rep["void"] == []
    failed = [k for k, c in rep["clauses"].items() if not c["pass"]]
    assert rep["verdict"] == "SHIP", failed
    assert rep["clauses"]["A5"]["detail"]["h1-14"]["tfm"] > 0.72
    text = gate.render_seasonal(rep)
    assert "SHIP" in text and "Mittelrhein" in text
    json.dumps(gate._clean(rep))  # no NaN literals, no numpy types


def test_matching_the_blend_does_not_ship_and_ties_are_neither_win_nor_loss():
    rng = np.random.default_rng(1)
    data = {u: synth_station(rng, model_sigma=10.0) for u in st.STATIONS}
    rep = gate.seasonal_report(header_for(data), data, thresholds())
    assert rep["verdict"] == "NO-SHIP"
    assert not rep["clauses"]["A1"]["pass"]
    koeln = rep["stations"]["KÖLN"]["blocks"]["h1-14"]
    assert koeln["tie"] is True and koeln["ss_adj"] == 0.0


def test_a_ten_percent_win_on_a_flat_gauge_is_a_tie():
    rng = np.random.default_rng(2)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    flat = "fe72ee98-88e9-4d19-aba1-f97f61b7d4de"  # FREMERSDORF: 34 cm range in reality
    data[flat] = synth_station(rng, model_sigma=0.9, blend_sigma=1.0)
    rep = gate.seasonal_report(header_for(data), data, thresholds())
    b = rep["stations"]["FREMERSDORF"]["blocks"]["h31-90"]
    assert 0 < b["ss"] < 0.2 and b["tie"] is True and b["ss_adj"] == 0.0
    assert rep["regimes"]["Saar-flashy"]["blocks"]["h31-90"]["ss"] == 0.0


def test_rhine_trio_votes_once_by_median():
    rng = np.random.default_rng(3)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    rep = gate.seasonal_report(header_for(data), data, thresholds())
    members = rep["regimes"]["Mittelrhein"]["members"]
    assert sorted(members) == ["BONN", "KOBLENZ", "KÖLN"]
    ss = sorted(rep["stations"][m]["blocks"]["h1-14"]["ss_adj"] for m in members)
    assert rep["regimes"]["Mittelrhein"]["blocks"]["h1-14"]["ss"] == ss[1]
    assert len(rep["regimes"]) == 5


def test_void_conditions_block_any_verdict():
    rng = np.random.default_rng(4)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    bad_cfg = header_for(data, config_fingerprint="0000000000000000")
    assert gate.seasonal_report(bad_cfg, data, thresholds())["verdict"] == "VOID"
    truncated = header_for(data, limit=10)
    assert "truncated" in " ".join(gate.seasonal_report(truncated, data, thresholds())["void"])
    not_repro = header_for(data, repeat_identical=False)
    assert gate.seasonal_report(not_repro, data, thresholds())["verdict"] == "VOID"
    h = header_for(data)
    first = next(iter(h["stations"]))
    h["stations"][first]["pairs_scored"] = int(h["stations"][first]["pairs_expected"] * 0.9)
    assert any("pairs scored" in r for r in gate.seasonal_report(h, data, thresholds())["void"])
    missing = {u: d for u, d in data.items() if u != st.POOLED[1]}
    assert any("DRESDEN" in r for r in gate.seasonal_report(header_for(missing), missing, thresholds())["void"])


def test_contamination_probe_reads_train_period_origins():
    rng = np.random.default_rng(5)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    c = gate.contamination(data, [1, 30])
    assert 0.3 < c["ss_old_2003_2015"] < 0.7 and 0.3 < c["ss_new_2024_2025"] < 0.7


def test_short_report_is_provisional_before_sixty_origins():
    header = {"horizon_kind": "short", "protocol": {"context": 1024, "horizon": 192, "step": 192, "blocks": {"h1-6h": [1, 24]}},
              "forecast_config": {**tfm.FORECAST_CONFIG, "max_horizon": 192}, "config_fingerprint": "x", "model_ran": True, "limit": None,
              "repeat_identical": True, "tfm_sha256": "y", "model": tfm.MODEL_ID, "model_license": tfm.MODEL_LICENSE, "checkpoint": tfm.CHECKPOINT,
              "versions": {}, "git": None, "generated": "now", "elapsed_s": 0, "torch_threads": 8,
              "stations": {"a6ee8177-107b-47dd-bcfd-30960ccc6e9c": {"name": "KÖLN", "kept": 9, "rise_events": 1, "collected_steps": 2976}}}
    rep = gate.short_report(header, {}, thresholds())
    assert rep["verdict"] == "PROVISIONAL"
    assert any("9/60 origins" in r for r in rep["provisional_reasons"])
    assert "PROVISIONAL" in gate.render_short(rep)


def test_per_h_curves_cover_every_lead_day_and_the_blend_is_the_unit():
    rng = np.random.default_rng(6)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    rep = gate.seasonal_report(header_for(data), data, thresholds())
    per = rep["stations"]["KÖLN"]["per_h"]
    assert sorted(per) == sorted(gate.METHODS) and len(per) == 6
    assert all(len(per[k]) == H for k in per)
    assert all(t < b for t, b in zip(per["tfm_point"], per["blend"])), "a clear winner stays under the blend on every lead day"
    assert all(v is None for v in gate._clean(per["upstream"])), "an empty column is null, not 0"
    pool = rep["pooled"]
    assert all(len(pool["per_h"][k]) == H for k in gate.METHODS)
    med = pool["per_h_ratio_median"]
    assert np.allclose(med["blend"], 1.0)
    assert all(r < 1 for r in med["tfm_point"]) and all(r > 1 for r in med["clim"])
    assert all(v is None for v in gate._clean(med["upstream"]))
    json.dumps(gate._clean(rep))


def test_a_column_one_pooled_station_has_is_not_pooled():
    # upstream exists at KÖLN only in reality: its own curve is reported, the pooled one is null
    rng = np.random.default_rng(7)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    koeln = st.POOLED[0]
    assert st.name_of(koeln) == "KÖLN"
    data[koeln]["upstream"] = data[koeln]["y"] + rng.normal(0, 8.0, data[koeln]["y"].shape)
    rep = gate.seasonal_report(header_for(data), data, thresholds())
    assert all(v is not None for v in gate._clean(rep["stations"]["KÖLN"]["per_h"]["upstream"]))
    assert all(v is None for v in gate._clean(rep["pooled"]["per_h"]["upstream"]))
    assert all(v is None for v in gate._clean(rep["pooled"]["per_h_ratio_median"]["upstream"]))
    assert all(v is not None for v in gate._clean(rep["pooled"]["per_h"]["tfm_point"])), "a complete column is still pooled"


# ---------- more than one candidate ----------

def test_a_challenger_header_is_gated_against_its_own_config():
    """The void check must read the config the report's OWN model was registered
    with. Before the registry it compared every run against the shipped one,
    which would VOID every 3.0 run for the wrong reason."""
    rng = np.random.default_rng(3)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    challenger = tfm.MODELS["3p0"]
    h = header_for(data, model_key="3p0", model_shippable=False,
                   model_license=challenger["license"], model_license_url=challenger["license_url"],
                   checkpoint=challenger["checkpoint"], model=challenger["id"],
                   forecast_config=challenger["config"],
                   config_fingerprint=tfm.config_fingerprint(challenger["config"]))
    assert tfm.expected_config(h) is challenger["config"]
    assert gate.void_reasons(h, data, tfm.expected_config(h), thresholds()) == []
    # and the shipped model's config would VOID it — the check is not vacuous
    assert any("fingerprint" in r for r in gate.void_reasons(h, data, tfm.FORECAST_CONFIG, thresholds()))


def test_a_header_without_a_model_key_is_still_the_shipped_model():
    """Every report committed before the registry carries no model_key."""
    rng = np.random.default_rng(4)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    h = header_for(data)
    assert "model_key" not in h
    assert tfm.expected_config(h) is tfm.MODELS[tfm.SHIPPED]["config"]


def test_a_run_that_may_not_ship_says_so_in_its_own_report():
    challenger = tfm.MODELS["3p0"]
    note = "\n".join(gate.shipping_note({"model_shippable": False, "model_license": challenger["license"],
                                         "model_license_url": challenger["license_url"]}))
    assert challenger["license"] in note and challenger["license_url"] in note
    assert "never become the model" in note
    assert gate.shipping_note({"model_shippable": True}) == []
    assert gate.shipping_note({}) == []  # an old header is the shipped model


def test_the_manifest_lists_only_reports_that_exist(tmp_path):
    gate_dir = tmp_path / "gate"
    (gate_dir / "seasonal-mid").mkdir(parents=True)
    (gate_dir / "seasonal-mid" / "report.json").write_text("{}", encoding="utf-8")
    (gate_dir / "seasonal-mid" / "report.md").write_text("#", encoding="utf-8")
    (gate_dir / "not-a-dir-file.json").write_text("{}", encoding="utf-8")

    one = gate.write_models_manifest(tmp_path)
    assert one["shipped"] == tfm.SHIPPED
    assert [m["key"] for m in one["models"]] == [tfm.SHIPPED], "a model with no report is not offered"
    assert one["models"][0]["files"] == {"seasonal-mid": {"json": "seasonal-mid/report.json", "md": "seasonal-mid/report.md"}}

    (gate_dir / "seasonal-mid" / "report-3p0.json").write_text("{}", encoding="utf-8")
    two = gate.write_models_manifest(tmp_path)
    keys = [m["key"] for m in two["models"]]
    assert keys == [tfm.SHIPPED, "3p0"], keys
    nc = next(m for m in two["models"] if m["key"] == "3p0")
    assert nc["shippable"] is False and nc["license_url"]
    assert json.loads((gate_dir / "models.json").read_text(encoding="utf-8")) == two


def test_candidates_are_registry_keys_in_the_directory_being_written(tmp_path):
    """The count must come from the registry and from the directory this run
    writes to — not from whatever files happen to sit there."""
    d = tmp_path / "seasonal-mid"
    d.mkdir(parents=True)
    assert gate.candidates_in(d, tfm.SHIPPED) == [tfm.SHIPPED], "the run being written always counts"
    (d / "report.json").write_text("{}", encoding="utf-8")
    (d / "report-3p0.json").write_text("{}", encoding="utf-8")
    assert gate.candidates_in(d, tfm.SHIPPED) == [tfm.SHIPPED, "3p0"]
    # a stray file is not a candidate, however much it looks like a report
    (d / "report_backup_2026-09-01.json").write_text("{}", encoding="utf-8")
    (d / "report-nonsense.json").write_text("{}", encoding="utf-8")
    assert gate.candidates_in(d, tfm.SHIPPED) == [tfm.SHIPPED, "3p0"]
    # and another directory's reports never leak in
    other = tmp_path / "seasonal-max"
    other.mkdir()
    assert gate.candidates_in(other, "3p0") == ["3p0"]


def test_the_caveat_reads_the_candidate_list_the_json_also_carries():
    assert gate.candidate_note({"candidates": [tfm.SHIPPED]}) == [], "one candidate needs no warning"
    assert gate.candidate_note({}) == []
    note = "\n".join(gate.candidate_note({"candidates": [tfm.SHIPPED, "3p0"]}))
    assert "2 candidates" in note and tfm.MODELS["3p0"]["id"] in note and "SAME TEST origins" in note


def test_an_unregistered_model_in_a_header_is_void_not_a_traceback():
    rng = np.random.default_rng(5)
    data = {u: synth_station(rng, model_sigma=5.0) for u in st.STATIONS}
    h = header_for(data, model_key="3p1")
    tfm.expected_config(h)  # must not raise
    reasons = gate.void_reasons(h, data, tfm.expected_config(h), thresholds())
    assert any("unregistered model" in r for r in reasons), reasons
