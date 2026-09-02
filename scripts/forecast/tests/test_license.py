"""The 3.0 line of TimesFM ships non-commercial weights, which a GPL-3.0 repo cannot
use. Nothing in the repo may name its package, its evaluator class or its
checkpoint — the names are assembled here so this file does not trip itself."""
import subprocess
from pathlib import Path

import tfm

REPO = Path(__file__).resolve().parents[3]
FORBIDDEN = [
    "timesfm" + "3",
    "TimesFM3" + "Evaluator",
    "google/timesfm-" + "3.0-pytorch",
    "timesfm-non-commercial",
]


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True, check=True).stdout
    return [REPO / p.decode() for p in out.split(b"\0") if p]


def test_no_forbidden_names_anywhere_in_the_repo():
    hits = []
    for path in tracked_files():
        if path.resolve() == Path(__file__).resolve() or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for token in FORBIDDEN:
            if token in text:
                hits.append(f"{path.relative_to(REPO)}: {token}")
    assert not hits, "\n".join(hits)


def test_checkpoint_guard_holds():
    tfm.license_guard()
    assert tfm.CHECKPOINT == "google/timesfm-2.5-200m-pytorch"
    assert tfm.MODEL_LICENSE == "Apache-2.0"


def test_pin_is_exact_and_pre_3():
    text = (REPO / "scripts" / "forecast" / "pyproject.toml").read_text(encoding="utf-8")
    assert '"timesfm[torch]==2.0.2"' in text
    assert "timesfm>=" not in text and "timesfm~=" not in text


def test_forecast_config_is_the_pre_registered_one():
    # the fingerprint gate.py compares against; change deliberately, with a header note
    assert tfm.config_fingerprint() == "362b77bd29350df5"
    assert tfm.FORECAST_CONFIG["infer_is_positive"] is False
    assert tfm.FORECAST_CONFIG["max_context"] == 1024
