# SPDX-License-Identifier: GPL-2.0-or-later
"""Fixed V1 particle inputs, complete score denominators, and reproducible audit output."""

from __future__ import annotations

import copy
import json
import math

import pytest

from puckworks_tools import particle_inputs as audit
from puckworks_tools import validate
from puckworks_tools.calibrate import Runner, build_problem, calibrated_values, load_calibration_document, load_config
from puckworks_tools.cases import schmieder2023 as sch

puckcore = pytest.importorskip("puckcore")


@pytest.fixture(scope="module")
def baseline(repo):
    runner = Runner(jobs=3, cache_size=32)
    try:
        scenarios, calibration, data = audit.build_scenarios(repo, runner)
        original = scenarios[0]
        results = runner.run(original["specs"])
        rows = [audit.record_case(case, spec, result)
                for case, spec, result in zip(original["cases"], original["specs"], results)]
        targets = sch.targets(data)
        score = audit.score_v1(rows, targets)
        config = load_config(repo.root / "data/calibration/config.yaml")
        problem = build_problem(repo, config, blocks=["V1"], runner=runner)
        document = load_calibration_document(repo.root / "data/calibration/current.yaml")
        quality, _ = validate.fit_quality(problem, validate._calibration_x(problem, calibrated_values(document)))
        # The reference evaluator used exactly the same 15 native specs, served from the cache.
        assert runner.simulations == 15
        yield {"scenarios": scenarios, "calibration": calibration, "data": data, "targets": targets,
               "results": results, "rows": rows, "score": score,
               "reference": quality["blocks"]["V1"]["v1"], "robustness": runner.robustness()}
    finally:
        runner.close()


def test_scenarios_preserve_fit_values_and_only_change_declared_inputs(baseline):
    scenarios = baseline["scenarios"]
    assert sum(len(s["specs"]) for s in scenarios) == 91
    assert [len(s["cases"]) for s in scenarios] == [15, 15, 15, 15, 15, 15, 1]
    values = baseline["calibration"]["all_preserved_values"]
    for key, value in baseline["calibration"]["applied_v1_values"].items():
        if key in values:
            assert value == pytest.approx(values[key], rel=1e-14)
    original = {c.info["experiment"]: spec for c, spec in zip(scenarios[0]["cases"], scenarios[0]["specs"])}
    for scenario in scenarios:
        for case, spec in zip(scenario["cases"], scenario["specs"]):
            assert spec["hydraulics"]["permeability_m2"] == original[case.info["experiment"]]["hydraulics"]["permeability_m2"]
            assert spec["solubles"]["extractable_fraction"] == pytest.approx(
                values["calibration.schmieder2023.extractable_fraction"] / 100)
            assert 0 < len(spec["bed"]["size_classes"]) <= scenario["definition"]["n_classes"]
    nominal = scenarios[1]
    frozen = scenarios[4]
    for coarse, fine in zip(nominal["specs"], scenarios[5]["specs"]):
        # Pure numerical refinement changes only particle classes: both air tau and the
        # class-interpolated-fines-dependent preparation heterogeneity remain exactly fixed.
        restored = copy.deepcopy(fine)
        restored["bed"]["size_classes"] = coarse["bed"]["size_classes"]
        assert restored == coarse
    for case, wet_spec, frozen_spec in zip(nominal["cases"], nominal["specs"], frozen["specs"]):
        old_tau = original[case.info["experiment"]]["hydraulics"]["pore_air"]["tau_s"]
        assert wet_spec["hydraulics"]["pore_air"]["tau_s"] < old_tau
        assert frozen_spec["hydraulics"]["pore_air"]["tau_s"] == old_tau
        restored = copy.deepcopy(frozen_spec)
        restored["hydraulics"]["pore_air"]["tau_s"] = wet_spec["hydraulics"]["pore_air"]["tau_s"]
        assert restored == wet_spec
    centre = next(spec for case, spec in zip(nominal["cases"], nominal["specs"]) if case.info["experiment"] == 7)
    refined = copy.deepcopy(scenarios[-1]["specs"][0])
    assert refined["numerics"]["max_dt_s"] == centre["numerics"]["max_dt_s"] / 2
    refined["numerics"]["max_dt_s"] *= 2
    assert refined == centre


def test_v1_score_exactly_matches_existing_native_evaluator(baseline):
    score, reference = baseline["score"], baseline["reference"]
    assert all(row["completed"] and row["failure"] is None for row in baseline["rows"])
    for key in ("lambda_within", "lambda_total", "cup_within", "cup_total", "lambda_max_error", "cup_max_error"):
        assert score[key] == reference[key]
    assert (score["lambda_within"], score["lambda_total"], score["cup_within"], score["cup_total"]) == (48, 60, 163, 180)
    assert (score["lambda_missing"], score["cup_missing"]) == (0, 0)
    for actual, expected in zip(score["comparisons"], reference["rows"]):
        assert actual["lambda"]["relative_error"] == abs(expected["lambda_model"] / expected["lambda_data"] - 1.0)
        for mass, (model, data) in expected["cups"].items():
            assert actual["cups"][str(mass)]["relative_error"] == abs(model / data - 1.0)
    # sch.targets returns tuple(mean, uncertainty); JSON round trips those leaves to lists.
    assert audit.score_v1(json.loads(json.dumps(baseline["rows"])),
                          json.loads(json.dumps(baseline["targets"]))) == score


def test_audit_rejects_changed_or_out_of_bounds_calibration(repo, monkeypatch):
    document = load_calibration_document(repo.root / "data/calibration/current.yaml")
    changed = copy.deepcopy(document)
    changed["label"] = "new-fit"
    monkeypatch.setattr(audit, "load_calibration_document", lambda path: changed if path.name == "current.yaml" else document)
    with pytest.raises(ValueError, match="equal preserved v2"):
        audit.build_scenarios(repo, Runner())
    changed = copy.deepcopy(document)
    changed["fit"]["nuisance"]["calibration.schmieder2023.permeability.gl1_4"] = 1e3
    monkeypatch.setattr(audit, "load_calibration_document", lambda path: changed)
    with pytest.raises(ValueError, match="refusing to clip"):
        audit.build_scenarios(repo, Runner())


def _perfect_rows(targets):
    rows = []
    for experiment in audit.EXPERIMENTS:
        target = targets[experiment]
        rows.append({"experiment": experiment, "completed": True, "observations": {
            "lambda": {a: target["lambda"][a][0] for a, _, _, _ in sch.ANALYTES},
            "cup_eq3": {a: {m: pair[0] for m, pair in target["cup"][a].items()} for a, _, _, _ in sch.ANALYTES},
        }})
    return rows


def test_missing_nonfinite_and_incomplete_predictions_keep_denominators(baseline):
    targets = baseline["targets"]
    rows = _perfect_rows(targets)
    perfect = audit.score_v1(rows, targets)
    assert (perfect["lambda_within"], perfect["cup_within"]) == (60, 180)
    rows[0]["completed"] = False  # finite predictions of an incomplete shot cannot score
    rows[1]["observations"]["lambda"]["caffeine"] = math.nan
    del rows[1]["observations"]["cup_eq3"]["caffeine"][20]
    rows[1]["observations"]["cup_eq3"]["tds"][60] = math.inf
    rows[2]["observations"] = None
    rows.pop()  # an omitted shot also stays in all denominators
    score = audit.score_v1(rows, targets)
    assert (score["lambda_total"], score["cup_total"]) == (60, 180)
    assert (score["lambda_missing"], score["cup_missing"]) == (13, 38)
    assert (score["lambda_within"], score["cup_within"]) == (47, 142)
    assert len(score["comparisons"]) == 60
    with pytest.raises(ValueError, match="unique experiment"):
        audit.score_v1([rows[0], rows[0]], targets)


def test_score_uses_eq3_cups_and_existing_relative_error_rule(baseline):
    targets = baseline["targets"]
    rows = _perfect_rows(targets)
    obs = rows[0]["observations"]
    obs["cup_direct"] = copy.deepcopy(obs["cup_eq3"])
    lam_data = targets[1]["lambda"]["caffeine"][0]
    obs["lambda"]["caffeine"] = 1.11 * lam_data
    cup_data = targets[1]["cup"]["tds"][40][0]
    obs["cup_eq3"]["tds"][40] = 0.89 * cup_data
    score = audit.score_v1(rows, targets)
    assert (score["lambda_within"], score["cup_within"]) == (59, 179)
    comparison = next(row for row in score["comparisons"] if row["experiment"] == 1 and row["analyte"] == "tds")
    assert comparison["cups"]["40"]["relative_error"] == abs(0.89 * cup_data / cup_data - 1)


def test_completion_requires_stop_and_full_fraction_coverage(baseline):
    original = baseline["scenarios"][0]
    case, spec, result = original["cases"][0], original["specs"][0], baseline["results"][0]
    failed = audit.record_case(case, spec, {"error": "deliberate test failure"})
    assert not failed["completed"] and failed["failure"] == "simulation: deliberate test failure"
    partial = copy.deepcopy(result)
    partial["summary"]["stop_reason"] = "max_duration"
    row = audit.record_case(case, spec, partial)
    assert not row["completed"] and row["observations"] is not None
    assert "max_duration" in row["failure"]
    required = copy.deepcopy(spec)
    required["machine"]["stop"]["beverage_mass_kg"] = result["series"]["beverage_mass_kg"][-1] + 0.001
    row = audit.record_case(case, required, result)
    assert not row["completed"] and "required=" in row["failure"]


def test_report_strict_json_round_trip_and_rerender(repo, baseline, tmp_path):
    """Use actual native observations; serialization cannot hide NaN or depend on integer JSON keys."""
    rows = copy.deepcopy(baseline["rows"])
    rows[0]["observations"]["lambda"]["caffeine"] = math.nan
    summary = audit.summarize_scenario(rows, baseline["targets"])
    centre = next(row for row in rows if row["experiment"] == 7)
    report = {"schema": "puckworks.particle-input-audit/1", "created": "2026-10-16", "tools_version": "test",
              "solver": {"puckcore_version": puckcore.__version__}, "inputs": audit.audit_hashes(repo),
              "jobs": 3, "requested_shots": 15, "robustness": baseline["robustness"],
              "source": {"citation": "Schmieder 2023", "url": "https://doi.org/10.3390/foods12152871", "licence": "CC-BY-4.0"},
              "source_basis": list(audit.SOURCE_BASIS), "psds": [],
              "scenarios": [{"id": "original16", "label": "Original, 16 classes", "rows": rows, "summary": summary}],
              "baseline_reference": {"reproduced": False}, "refinement": audit.refinement_comparison(centre, centre)}
    markdown, data = audit.write_report(report, tmp_path / "first", figures=False)
    text = data.read_text(encoding="utf-8")
    assert "NaN" not in text and "Infinity" not in text
    loaded = json.loads(text, parse_constant=lambda value: pytest.fail(f"invalid JSON constant {value}"))
    assert loaded["scenarios"][0]["rows"][0]["observations"]["lambda"]["caffeine"] is None
    assert audit.render_markdown(loaded) == markdown.read_text(encoding="utf-8")
    assert "missing or nonfinite" in markdown.read_text(encoding="utf-8")
    assert audit.main(["--from-json", str(data), "--output-dir", str(tmp_path / "again"), "--no-figures"]) == 0
    assert (tmp_path / "again" / f"{audit.REPORT_NAME}.md").read_text(encoding="utf-8") == markdown.read_text(encoding="utf-8")
    assert loaded["inputs"]["files_sha256"]["python/puckworks_tools/particle_inputs.py"]
    assert loaded["inputs"]["datasets_sha256"][sch.PSD_DATASET]
