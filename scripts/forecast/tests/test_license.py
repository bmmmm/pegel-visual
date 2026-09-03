"""What may be shipped, and what may only be measured.

The 3.0 line of TimesFM ships weights under a non-commercial licence that also
forbids redistribution. A GPL-3.0 repo cannot pass those terms on to its
readers, so 3.0 may be measured and named — its numbers are facts, and running
it here is non-commercial research the licence allows — but it may never become
the model this repo ships.

An earlier version of this file grepped every tracked file for the 3.0 package,
class and checkpoint names. That banned the honest thing (a report naming the
checkpoint it measured) while catching none of the real hazard. These tests
guard the hazard instead: the shipped model's licence, the shipped reports, and
the fact that a plain `uv run` can never even install the non-commercial line.
"""
import json
import re
import tomllib
from pathlib import Path

import tfm

REPO = Path(__file__).resolve().parents[3]
PYPROJECT = REPO / "scripts" / "forecast" / "pyproject.toml"


def pyproject() -> dict:
    return tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))


def model_of(header: dict) -> str:
    """The registry key a report was produced with. Headers written before the
    registry carry no model_key, so fall back to matching the checkpoint."""
    key = header.get("model_key")
    if key:
        assert key in tfm.MODELS, f"unknown model_key {key!r}"
        return key
    for k, entry in tfm.MODELS.items():
        if entry["checkpoint"] == header.get("checkpoint"):
            return k
    raise AssertionError(f"report names an unregistered checkpoint: {header.get('checkpoint')!r}")


# ---------- the registry ----------

def test_shipped_model_is_permissively_licensed():
    tfm.license_guard()
    shipped = tfm.MODELS[tfm.SHIPPED]
    assert shipped["checkpoint"] == "google/timesfm-2.5-200m-pytorch"
    assert shipped["license"] == "Apache-2.0"
    assert shipped["shippable"] is True
    assert [k for k, e in tfm.MODELS.items() if e["shippable"]] == [tfm.SHIPPED], \
        "exactly one model may be shippable, and it must be the shipped one"


def test_non_commercial_models_are_marked_and_never_shipped():
    others = {k: e for k, e in tfm.MODELS.items() if e["license"] not in tfm.PERMISSIVE}
    assert others, "this test is vacuous unless a non-permissive model is registered"
    for key, entry in others.items():
        assert entry["shippable"] is False, f"{key}: non-permissive weights marked shippable"
        assert entry["license_url"], f"{key}: no link to the licence that forbids shipping"
        tfm.license_guard(key)  # loading it is allowed; being SHIPPED is not


def test_output_layout_is_registered_per_line_not_copied():
    # 2.5 returns ten channels with the point on 5, 3.0 nine with the point on 4.
    # A copy-paste that gave both the same layout would score a wrong MAE that
    # still looks plausible, so the difference itself is asserted.
    layouts = {k: (e["point_channel"], e["quantile_channels"], tuple(e["decile_slice"]))
               for k, e in tfm.MODELS.items()}
    assert layouts["2p5"] == (5, 10, (1, 10))
    assert layouts["3p0"] == (4, 9, (0, 9))
    for key, (_, _, (lo, hi)) in layouts.items():
        assert hi - lo == 9, f"{key}: the gate scores nine deciles"


# ---------- the environment ----------

def test_pin_is_exact_and_the_shipped_line_stays_pre_3():
    text = PYPROJECT.read_text(encoding="utf-8")
    assert '"timesfm[torch]==2.0.2"' in text
    assert "timesfm>=" not in text and "timesfm~=" not in text
    groups = pyproject()["dependency-groups"]
    assert any(d.startswith("timesfm[torch]==2.0.2") for d in groups[tfm.MODELS[tfm.SHIPPED]["group"]])


def test_the_non_commercial_line_is_opt_in_only():
    """A plain `uv run` must not be able to install it, let alone download it."""
    pp = pyproject()
    groups, uv = pp["dependency-groups"], pp["tool"]["uv"]
    shipped_group = tfm.MODELS[tfm.SHIPPED]["group"]
    # a list, not the word "all": `x not in "all"` is a SUBSTRING test and would
    # pass for every group name while every group is in fact default
    defaults = uv["default-groups"]
    assert isinstance(defaults, list), f"default-groups must be a list, got {defaults!r}"
    for key, entry in tfm.MODELS.items():
        if entry["shippable"]:
            continue
        group = entry["group"]
        assert group in groups, f"{key}: group {group!r} is not declared"
        assert group not in defaults, f"{key}: {group!r} must not be a default group"
        pins = [d for d in groups[group] if d.startswith("timesfm")]
        assert len(pins) == 1 and "==" in pins[0], f"{group}: timesfm must be pinned exactly, got {pins}"
        # the same distribution at two versions: uv must know they exclude each other
        assert any({shipped_group, group} <= {m.get("group") for m in pair} for pair in uv["conflicts"]), \
            f"{group} and {shipped_group} are not declared as conflicting"


def test_forecast_configs_are_the_pre_registered_ones():
    # the fingerprints gate.py compares against; change deliberately, with a header note
    assert tfm.config_fingerprint(tfm.MODELS["2p5"]["config"]) == "362b77bd29350df5"
    assert tfm.config_fingerprint(tfm.MODELS["3p0"]["config"]) == "9fc34ab62295c07f"
    assert tfm.config_fingerprint() == "362b77bd29350df5"  # the alias still means the shipped one
    assert tfm.MODELS["2p5"]["config"]["infer_is_positive"] is False
    assert tfm.MODELS["3p0"]["config"]["make_positive"] is False
    for entry in tfm.MODELS.values():
        assert entry["config"]["max_context"] == 1024, "both lines are fed the same context"


# ---------- what is published ----------

def test_the_shipped_reports_name_a_shippable_model():
    """gate/<kind>-<target>/report.json is THE report — the one the page and the
    landing text speak for. A challenger writes report-<key>.json beside it."""
    reports = sorted((REPO / "gate").glob("*/report.json"))
    assert reports, "no committed gate report found"
    for path in reports:
        header = json.loads(path.read_text(encoding="utf-8"))["header"]
        key = model_of(header)
        assert tfm.MODELS[key]["shippable"], \
            f"{path.relative_to(REPO)} is the shipped report but was measured with {key}"


def test_challenger_reports_declare_the_model_they_ran():
    for path in sorted((REPO / "gate").glob("*/report-*.json")):
        header = json.loads(path.read_text(encoding="utf-8"))["header"]
        key = path.stem.removeprefix("report-")
        assert key in tfm.MODELS, f"{path.relative_to(REPO)}: {key!r} is not a registered model"
        assert header.get("model_key") == key, f"{path.relative_to(REPO)}: header says {header.get('model_key')!r}"
        assert header.get("model_shippable") is tfm.MODELS[key]["shippable"]
        if not tfm.MODELS[key]["shippable"]:
            assert header.get("model_license_url"), f"{path.relative_to(REPO)}: no licence link in the header"


def test_the_page_publishes_only_the_shipped_reports():
    """The guard the file-level checks miss: gate/gate.js decides WHICH report the
    deployed plate speaks for. Point its fetches at a challenger and every other
    test here stays green while the site shows non-commercial numbers under prose
    that names the shipped model."""
    js = (REPO / "gate" / "gate.js").read_text(encoding="utf-8")
    fetched = re.findall(r"getJson\(\s*'([^']+)'", js)
    assert fetched, "no getJson literals found — has the loader been rewritten?"
    shipped_names = {"report.json", "models.json"}
    for url in fetched:
        name = url.rsplit("/", 1)[-1]
        assert name in shipped_names, \
            f"gate.js fetches {url!r}; the deployed plate may only speak for the shipped report"


def test_the_committed_manifest_matches_the_registry_and_disk():
    """models.json is deployed and is the machine-readable claim about which model
    this repo ships. Nothing else reads it yet, so nothing else would catch a
    hand-edit."""
    manifest = json.loads((REPO / "gate" / "models.json").read_text(encoding="utf-8"))
    assert manifest["shipped"] == tfm.SHIPPED
    listed = {m["key"] for m in manifest["models"]}
    assert listed <= set(tfm.MODELS), f"manifest names an unregistered model: {listed - set(tfm.MODELS)}"
    for m in manifest["models"]:
        entry = tfm.MODELS[m["key"]]
        for field in ("checkpoint", "license", "license_url", "shippable", "id", "params", "label"):
            assert m[field] == entry[field], f"{m['key']}.{field}: {m[field]!r} != {entry[field]!r}"
        for where in m["files"].values():
            for path in where.values():
                assert (REPO / "gate" / path).exists(), f"manifest points at a missing file: {path}"
    assert [m["key"] for m in manifest["models"] if m["shippable"]] == [tfm.SHIPPED]


def test_default_groups_is_a_list_not_a_word():
    """`group not in default-groups` degrades to a SUBSTRING test if uv's
    `default-groups = "all"` spelling is ever used — and "model-nc" is not a
    substring of "all", so the opt-in guard would pass while every group is on."""
    uv = pyproject()["tool"]["uv"]
    assert isinstance(uv["default-groups"], list), uv["default-groups"]
    assert tfm.MODELS[tfm.SHIPPED]["group"] in uv["default-groups"], "the shipped model must sync by default"

