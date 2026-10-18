# SPDX-License-Identifier: GPL-2.0-or-later
"""M3 report rejects broken accounting and exercises public seeded/taste APIs."""

from __future__ import annotations

import copy
import json

import pytest

from puckworks_tools import cli, m3validate
from puckworks_tools.identity import file_sha256


def _ensemble():
    return {"samples_requested": 8, "samples_completed": 8, "sample_failures": [],
            "ensemble_tier": 0, "band_kind": "scenario_percentiles_not_confidence_interval",
            "series": {"time_basis": "fraction_of_recorded_duration_including_drip",
                       "progress": [0.0, 1.0],
                       "bands": {"tds": [{"min": 0.0, "p05": 0.0, "p50": 0.0,
                                          "p95": 0.0, "max": 0.0, "n": 8}] * 2}},
            "bands": {"/summary/ey": {"min": 0.1, "p05": 0.11, "p50": 0.2,
                                        "p95": 0.29, "max": 0.3, "n": 8}}}


def test_band_audit_rejects_failed_members_even_with_plausible_quantiles():
    ensemble = _ensemble()
    assert m3validate.audit_bands(ensemble) == []
    ensemble["samples_completed"] = 7
    ensemble["sample_failures"] = [{"sample_index": 2, "message": "invalid support"}]
    ensemble["bands"]["/summary/ey"]["n"] = 7
    for band in ensemble["series"]["bands"]["tds"]:
        band["n"] = 7
    assert m3validate.audit_bands(ensemble) == ["only 7/8 members succeeded"]


@pytest.mark.parametrize("mutation, expected", [
    (lambda doc: doc.update(band_kind="90% confidence interval"), "disclaim confidence intervals"),
    (lambda doc: doc["bands"]["/summary/ey"].update(p05=0.25), "unordered quantiles"),
    (lambda doc: doc["bands"]["/summary/ey"].update(p95=float("nan")), "nonfinite"),
    (lambda doc: doc["bands"]["/summary/ey"].update(n=9), "sample count"),
    (lambda doc: doc["bands"]["/summary/ey"].update(n=0), "sample count"),
    (lambda doc: doc["series"].update(time_basis="time_seconds"), "fractional recorded duration"),
    (lambda doc: doc["series"]["bands"]["tds"][0].update(p50=float("inf")), "nonfinite"),
    (lambda doc: doc["series"]["bands"].update(tds=[]), "band count does not match progress"),
    (lambda doc: doc["series"].update(progress=[0.0, 0.0]), "increase strictly"),
])
def test_band_audit_detects_quantile_and_interpretation_errors(mutation, expected):
    ensemble = _ensemble()
    mutation(ensemble)
    assert any(expected in problem for problem in m3validate.audit_bands(ensemble))


def test_direction_checks_reject_unchanged_reversed_or_unavailable_taste():
    before = {f"{axis}_index": 50.0 for axis in m3validate.TASTE_AXES}
    after = {f"{axis}_index": 25.0 for axis in m3validate.TASTE_AXES}
    assert all(row["status"] == "pass" for row in m3validate.compare_dilution(before, after))
    for invalid in (None, float("nan"), 50.0, 60.0, -1.0):
        changed = {**after, "acidity_index": invalid}
        checks = m3validate.compare_dilution(before, changed)
        assert checks[0]["status"] == "fail"
        assert all(row["status"] == "pass" for row in checks[1:])


def test_unavailable_status_also_requires_null_indices():
    values = {"status": "no_cup", **{f"{axis}_index": None for axis in m3validate.TASTE_AXES}}
    assert m3validate.unavailable_taste_check("empty", values, "no_cup")["status"] == "pass"
    values["body_index"] = 0.0
    assert m3validate.unavailable_taste_check("empty", values, "no_cup")["status"] == "fail"


def test_fit_preservation_audit_detects_changed_parameter_without_refitting(repo, monkeypatch):
    path = repo.root / "data/calibration/current.yaml"
    before = file_sha256(path)
    audit = m3validate.calibration_audit(repo, before)
    assert audit["file_unchanged"]
    assert audit["parameters_match_m1_report"]
    calibration = copy.deepcopy(m3validate.load_calibration_document(path))
    key = next(iter(calibration["parameters"]))
    calibration["parameters"][key] *= 1.01
    monkeypatch.setattr(m3validate, "load_calibration_document", lambda _: calibration)
    audit = m3validate.calibration_audit(repo, before)
    assert audit["file_unchanged"] and not audit["parameters_match_m1_report"]
    assert key in audit["parameter_mismatches"]


@pytest.mark.parametrize("seed, samples", [(-1, 8), (2**32, 8), (1, 7), (1, 65), (True, 8)])
def test_invalid_controls_fail_before_engine_import(repo, tmp_path, seed, samples):
    with pytest.raises(ValueError):
        m3validate.run(repo, tmp_path, seed=seed, samples=samples)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("failed, expected_code", [(0, 0), (1, 1)])
def test_cli_wires_controls_and_does_not_claim_scientific_validation(repo, tmp_path, monkeypatch,
                                                                   capsys, failed, expected_code):
    seen = {}

    def fake_run(paths, output_dir, **controls):
        seen.update(output_dir=output_dir, **controls)
        return {"summary": {"failed_checks": failed}}

    monkeypatch.setattr(m3validate, "run", fake_run)
    assert cli.main(["m3-validate", "--root", str(repo.root), "--output-dir", str(tmp_path),
                     "--seed", "41", "--samples", "8"]) == expected_code
    assert seen == {"output_dir": tmp_path, "seed": 41, "samples": 8}
    assert "remain unvalidated" in capsys.readouterr().out


@pytest.fixture(scope="module")
def report(repo, tmp_path_factory):
    engine = pytest.importorskip("puckcore")
    if not hasattr(engine, "simulate_uncertainty") or not hasattr(engine, "estimate_taste"):
        pytest.skip("M3 public extension entry points are not built")
    return m3validate.run(repo, tmp_path_factory.mktemp("m3-report"), samples=8)


def test_public_m3_checks_pass(report):
    failures = [row for row in report["checks"] if row["status"] != "pass"]
    assert failures == []
    assert report["summary"]["failed_checks"] == 0
    assert report["summary"]["scientific_validation_gates_changed"] is False
    assert report["fitted_to_sensory_data"] is False


def test_report_is_reviewable_and_distinguishes_software_from_empirical_evidence(report, tmp_path):
    markdown, document = m3validate.write_report(report, tmp_path)
    stored = json.loads(document.read_text(encoding="utf-8"))
    assert stored["schema"] == "puckworks.m3-validation/1"
    assert stored["seed"] == m3validate.DEFAULT_SEED and stored["samples"] == 8
    assert stored["replay"]["scientific_sha256"] == stored["replay"]["replay_sha256"]
    text = markdown.read_text(encoding="utf-8")
    assert "not 90% predictive intervals or confidence intervals" in text
    assert "independent espresso sensory accuracy remain **unvalidated**" in text
    assert "Tier 0 − Tier 1" in text
    assert "No refitting was performed" in text


def test_actual_unknown_and_measured_inputs_use_paired_seeded_draws(report):
    ensembles = report["ensembles"]
    for key in ("psd_scale", "psd_fines_factor", "composition_factor", "water_factor"):
        for unknown, measured, fixed in zip(ensembles["unknown"]["sample_inputs"],
                                            ensembles["measured"]["sample_inputs"],
                                            ensembles["fixed"]["sample_inputs"]):
            assert fixed[key] == 1.0
            assert abs(measured[key] - 1.0) <= abs(unknown[key] - 1.0) + 1e-14
    assert report["calibration"]["file_unchanged"] and report["calibration"]["parameters_match_m1_report"]


def test_taste_audit_rejects_unsupported_trust_and_unresolved_driver_evidence(report, repo):
    from puckworks_tools.registry import load_registry

    estimate = copy.deepcopy(report["taste"]["undiluted"])
    registry = load_registry(repo)
    assert m3validate.audit_taste(estimate, registry) == []
    estimate["attributes"][2]["trust"] = "high"
    estimate["attributes"][0]["drivers"][0]["source_refs"] = ["missing-study"]
    problems = m3validate.audit_taste(estimate, registry)
    assert any("trust label" in problem for problem in problems)
    assert any("evidence reference" in problem for problem in problems)
