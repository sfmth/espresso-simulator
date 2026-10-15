# SPDX-License-Identifier: GPL-2.0-or-later
"""The validation report runs end to end on the current build and reports every PLAN §10 check."""

from __future__ import annotations

import json

import pytest

from puckworks_tools import validate
from puckworks_tools.cli import main

puckcore = pytest.importorskip("puckcore")

CHECKS = [
    "V1 λ within ±10% (fit)",
    "V1 cup masses within ±10% (fit)",
    "V1 leave-one-condition-out (±15%)",
    "V2 Bodenstein number 8–17",
    "V4 long-time flow vs pressure (fit)",
    "V6 relative change of κ with density within ×1.5",
    "V3 EY peak at grind setting 1.5–1.9",
    "V3 peak EY 22–24%",
    "V3 shot time falls as the grind coarsens",
    "V4 flow rises after the first drops",
    "V4 first drops after full pressure",
    "V4 first-fraction TDS 25 ± 3%",
    "V4 time to 36 g (9 bar)",
    "V5 added fines lengthen shots",
    "V5 EY tracks shot time",
    "V5 10–15 s shots reach 17–18% EY",
    "Held-out shot times against the data",
    "Tier 0 vs tier 1 on the held-out cases",
    "Generic 18 g → 36 g, 9 bar shots near 30 s",
]


@pytest.fixture(scope="module")
def report(repo, tmp_path_factory):
    no_calibration = tmp_path_factory.mktemp("cal") / "none.yaml"
    return validate.run_validation(repo, calibration_path=no_calibration, tier=0, n_classes=6)


def test_every_check_is_reported(report):
    names = [c["check"] for c in [*report["calibration"]["checks"], *report["held_out_checks"]]]
    assert names == CHECKS
    for c in [*report["calibration"]["checks"], *report["held_out_checks"]]:
        assert c["status"] in ("pass", "fail", "info", "not run")
        assert c["detail"] and c["target"]
    assert report["calibration_file"] is None
    assert all(not p["calibrated"] for p in report["parameters"].values())
    # the validation part of the M1 exit criteria, each from its checks
    criteria = [e["criterion"] for e in report["exit_criteria"]]
    assert criteria[:3] == ["V1 within targets", "V3 peak reproduced", "V4 flow rise reproduced"]
    # tier comparison: 7 V3 + 15 V5 shots and the 9-bar transient, at tier 1 against the report's tier 0
    tiers = report["held_out"]["tiers"]
    assert tiers["tiers"] == [0, 1] and len(tiers["rows"]) == 23
    assert len(report["held_out"]["generic"]["rows"]) == len(validate.GENERIC_GRINDERS)


def test_exit_criteria_follow_their_checks():
    names = ["V1 λ within ±10% (fit)", "V1 cup masses within ±10% (fit)", "V1 leave-one-condition-out (±15%)",
             "V3 EY peak at grind setting 1.5–1.9", "V3 peak EY 22–24%", "V4 flow rises after the first drops",
             "V4 first drops after full pressure"]
    checks = [{"check": n, "status": "pass"} for n in names]
    checks[-1]["status"] = "fail"
    status = {e["criterion"]: e["status"] for e in validate.exit_criteria(checks)}
    assert status["V1 within targets"] == "pass" and status["V3 peak reproduced"] == "pass"
    assert status["V4 flow rise reproduced"] == "partial"
    checks[-2]["status"] = "fail"
    assert {e["criterion"]: e["status"] for e in validate.exit_criteria(checks)}["V4 flow rise reproduced"] == "fail"
    checks[2]["status"] = "not run"
    assert validate.exit_criteria(checks)[0]["status"] == "not run"
    checks[0]["status"] = "fail"  # one V1 check fails, another passes: partial
    assert validate.exit_criteria(checks)[0]["status"] == "partial"
    checks[1].update(status="fail", within=160, total=180)
    checks[2]["status"] = "fail"
    # no V1 check passes: fail, however close the near misses
    assert validate.exit_criteria(checks)[0]["status"] == "fail"


def test_report_files(report, tmp_path):
    written = validate.write_report(report, tmp_path)
    md, js = written[0], written[1]
    text = md.read_text(encoding="utf-8")
    assert text.startswith("<!-- SPDX-License-Identifier: GPL-2.0-or-later -->")
    assert "## Summary" in text and "## 2. Held-out checks" in text
    for name in CHECKS:
        assert name in text
    if report["placeholder"]:
        assert "placeholder" in text
    data = json.loads(js.read_text(encoding="utf-8"))
    assert data["schema"] == "puckworks.validation-report/1"
    assert len(data["held_out"]["v3"]["rows"]) == 7 and len(data["held_out"]["v5"]["rows"]) == 15
    for figure in written[2:]:
        assert figure.suffix == ".png" and figure.stat().st_size > 1000


def test_spearman():
    assert validate.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert validate.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)


def test_cli_quick_run(repo, tmp_path):
    out = tmp_path / "validation"
    code = main(["validate", "--quick", "--output-dir", str(out), "--calibration", str(tmp_path / "none.yaml"),
                 "--root", str(repo.root)])
    assert code == 0
    assert (out / "m1-validation.md").is_file() and (out / "m1-validation.json").is_file()


def test_report_re_renders_from_its_json(report, tmp_path):
    """The Markdown regenerates fully from the JSON, without simulating."""
    written = validate.write_report(report, tmp_path / "run")
    out = tmp_path / "again"
    code = main(["validate", "--from-json", str(written[1]), "--output-dir", str(out)])
    assert code == 0
    assert (out / "m1-validation.md").read_text(encoding="utf-8") == written[0].read_text(encoding="utf-8")
    assert report["solver"]["sources_sha256"]


def test_v4_transient_metrics_use_a_common_clock(report):
    """First drops and time to 36 g on the data's clock; the data side reproduces the dataset."""
    v4t = report["held_out"]["v4_transient"]
    assert v4t["drops_data_s"] == pytest.approx(12.9, abs=0.3)
    assert v4t["time_to_mass_data_s"] == pytest.approx(47.8, abs=0.4)
    assert v4t["drops_model_s"] > 0 and v4t["time_to_mass_model_s"] > v4t["drops_model_s"]
    rise = next(c for c in report["held_out_checks"] if c["check"] == "V4 flow rises after the first drops")
    assert ("overshoot" in rise["detail"]) and "×1.5" in rise["target"]


def test_v5_checks_compare_like_with_like(report):
    checks = {c["check"]: c for c in report["held_out_checks"]}
    fines = checks["V5 added fines lengthen shots"]
    assert "data +" in fines["detail"] and "50%" in fines["target"]
    fast = checks["V5 10–15 s shots reach 17–18% EY"]
    # selected by measured time: only 250 µm with 1 g of added fines was measured at 10–15 s
    assert "250 µm + 1 g" in fast["detail"]


def test_not_independent_checks_are_marked(report):
    marked = {c["check"] for c in report["held_out_checks"] if c.get("independent") is False}
    assert marked == set(validate.NOT_INDEPENDENT)


def test_committed_report_check_detects_drift(report, tmp_path, repo):
    from puckworks_tools.calibrate import load_calibration_document

    written = validate.write_report(report, tmp_path)
    problems = validate.check_committed(repo, tmp_path)
    assert not any("does not match" in p for p in problems)  # a fresh report re-renders exactly
    committed = load_calibration_document(repo.root / "data" / "calibration" / "current.yaml")
    if (committed.get("fit") or {}).get("solver"):
        # the fixture's report used no calibration file, so its calibration identity differs
        assert any("calibration solver" in p for p in problems)
    written[0].write_text(written[0].read_text(encoding="utf-8") + "edited\n", encoding="utf-8")
    assert any("does not match" in p for p in validate.check_committed(repo, tmp_path))
