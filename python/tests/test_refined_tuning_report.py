# SPDX-License-Identifier: GPL-2.0-or-later
"""Offline artifact joins; these tests never build a model or simulate a shot."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys

import pytest
import yaml


SCRIPT = Path(__file__).parents[1] / "scripts" / "m11-refined-tuning-report.py"
SPEC = importlib.util.spec_from_file_location("refined_tuning_report", SCRIPT)
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)


def source(value, *, as_yaml=False):
    text = yaml.safe_dump(value) if as_yaml else json.dumps(value)
    return {"path": "/unavailable/original/artifact", "text": text, "sha256": report.text_hash(text)}


def attach(document, key, value):
    document[key] = value
    document["sources"][key] = source(value)


def resign_stage(document, name):
    document["sources"]["stages"][name] = source(document["stages"][name])


def stage(kind="score", *, depth=150, dt=.025, value=1.0):
    config = {"tier": 1, "n_classes": 16,
              "parameters": [{"id": "p", "mode": "override", "scale": "linear", "blocks": ["V1"]}],
              "fixed": [], "blocks": {name: {"weight": 1, "spec_fields": {
                  "numerics.depth_cells": depth, "numerics.max_dt_s": dt,
                  "numerics.max_duration_s": 131}} for name in ("V1", "V4")}}
    scored = {"cost": 10.0, "block_costs": {"V1": 10.0}, "failures": [],
              "score": {"lambda_within": 1, "lambda_total": 1, "cup_within": 1, "cup_total": 1},
              "observations": {"V1": {"case": {"lambda": {"tds": 10.0},
                  "cup_eq3": {"tds": {"20": 1.0}}, "pour_peak_pressure_bar": 2.0, "switch_s": 1.0}}},
              "specs": {name: [{"numerics": {"depth_cells": depth, "max_dt_s": dt}}]
                        for name in ("V1", "V4")}}
    out = {"stage": kind, "complete": True, "held_out_used": False,
           "config": config, "depth_cells": depth, "max_dt_s": dt,
           "identity": {"solver": {"build": "final"},
                        "inputs": {"config_sha256": f"config-{depth}-{dt}", "registry": "same",
                                   "datasets_sha256": {"training": "same"}},
                        "source_calibration_sha256": "v5", "starting_values_sha256": "v5"},
           "starting_values": {"p": value}, "baseline": scored}
    if kind == "fit":
        out.update(values={"p": value}, final=copy.deepcopy(scored), history=[],
                   optimizer={"message": "xtol", "evaluations": 2, "jacobian_evaluations": 1,
                              "optimality": 1.0}, robustness={"simulations": 1, "failed": 0})
        out["final"]["cost"] = 8.0
    return out


@pytest.fixture
def bundle():
    stages = {"baseline150": stage(), "refined150": stage("fit", value=1.2),
              "check300": stage(depth=300, value=1.2), "warm30": stage("fit", depth=30, value=1.1)}
    stages["warm30"]["identity"]["solver"] = {"build": "historical"}
    del stages["warm30"]["starting_values"]  # Historical seed has neither this field nor a Jacobian.
    exported = {"parameters": {"p": 1.2, "hydraulics.permeability.reference": 3e-14},
                "fit": {"solver": {"build": "final"}, "effective_config": stages["refined150"]["config"],
                        "nuisance": {}, "case_parameters": {}, "fixed": {}}}
    return {"schema": "puckworks.refined-tuning-report/1", "stages": stages,
            "baseline_stage": "baseline150", "candidate_stage": "refined150",
            "resolution_stages": ["check300"], "candidate_document": exported,
            "disposition": "Research candidate.", "validation": {},
            "sources": {"stages": {name: source(value) for name, value in stages.items()},
                        "candidate_document": source(exported, as_yaml=True), "validation": {}}}


def derivative_audit(bundle, trials=None):
    return {"complete": True, "held_out_used": False, "identity": {"build": "final"},
            "inputs": bundle["stages"]["refined150"]["identity"]["inputs"],
            "candidate_sha256": bundle["sources"]["stages"]["refined150"]["sha256"],
            "columns": [{"parameter": "p", "relative_column_changes": [0.0, 0.0]}],
            "projected_gradient_max": 0.0, "descent_trials": trials or []}


def fine_holdouts(bundle):
    candidate = bundle["stages"]["refined150"]
    values = report.calibrated_values(bundle["candidate_document"])
    rows = []
    for label in ("frozen_v5", "candidate"):
        for depth, dt in ((30, .05), (150, .025), (300, .025)):
            rows.append({"label": label, "depth_cells": depth, "max_dt_s": dt,
                         "values": values if label == "candidate" else {"p": 1.0},
                         "records": [{"spec": {"numerics": {"depth_cells": depth, "max_dt_s": dt}}}]})
    return {"complete": True, "used_to_select_parameters": False, "config": candidate["config"],
            "identity": {"solver": candidate["identity"]["solver"],
                         "inputs": candidate["identity"]["inputs"], "baseline_sha256": "v5",
                         "candidate_sha256": bundle["sources"]["candidate_document"]["sha256"]},
            "rows": rows}


def full_validation(bundle):
    return {"solver": {"build": "final"}, "calibration_solver": {"build": "final"},
            "parameters": {key: {"value": value, "calibrated": True}
                           for key, value in report.calibrated_values(bundle["candidate_document"]).items()},
            "fixed": {}, "nuisance": {}, "calibration_config": {"own_configuration": True},
            "tier": 0, "n_classes": 8, "held_out_checks": []}


def attach_validation(bundle, value):
    bundle["validation"]["full"] = value
    bundle["sources"]["validation"]["full"] = source(value)


def test_matching_bundle_accepts_historical_seed_and_score_starting_values(bundle):
    report.validate_document(bundle)
    assert report.stage_label(bundle, "warm30") == "warm30 (seed diagnostic)"
    assert "values" not in bundle["stages"]["check300"]


@pytest.mark.parametrize("change,match", [
    (lambda b: b["stages"]["baseline150"]["identity"]["solver"].update(build="old"), "different solver"),
    (lambda b: b["stages"]["baseline150"]["config"].update(n_classes=32), "different configurations"),
    (lambda b: b["stages"]["baseline150"].update(max_dt_s=.05), "grid metadata"),
    (lambda b: b["stages"]["baseline150"]["identity"].update(starting_values_sha256="warm"), "not a frozen score"),
])
def test_rejects_unmatched_baseline(bundle, change, match):
    change(bundle)
    resign_stage(bundle, "baseline150")
    with pytest.raises(ValueError, match=match):
        report.validate_document(bundle)


@pytest.mark.parametrize("change,match", [
    (lambda s: s["starting_values"].update(p=1.200000001), "different exact coefficients"),
    (lambda s: s["config"]["blocks"]["V1"].update(weight=2), "beyond V1/V4"),
    (lambda s: s["config"]["blocks"]["V1"]["spec_fields"].update({"numerics.max_duration_s": 500}), "beyond V1/V4"),
    (lambda s: s["identity"]["inputs"].update(registry="changed"), "beyond V1/V4"),
    (lambda s: s["identity"]["solver"].update(build="old"), "different solver"),
    (lambda s: s["baseline"]["specs"]["V1"][0]["numerics"].update(depth_cells=30), "scored V1 spec"),
])
def test_resolution_changes_only_depth_and_timestep(bundle, change, match):
    change(bundle["stages"]["check300"])
    resign_stage(bundle, "check300")
    with pytest.raises(ValueError, match=match):
        report.validate_document(bundle)


def test_derivative_and_holdout_hashes_join_the_actual_candidate_sources(bundle):
    audit = derivative_audit(bundle)
    audit["candidate_sha256"] = "other-fit"
    attach(bundle, "derivatives", audit)
    with pytest.raises(ValueError, match="different candidate report"):
        report.validate_document(bundle)
    attach(bundle, "derivatives", derivative_audit(bundle))
    holdouts = fine_holdouts(bundle)
    holdouts["identity"]["candidate_sha256"] = "rounded-export"
    attach(bundle, "fine_holdouts", holdouts)
    with pytest.raises(ValueError, match="different coefficients or solver"):
        report.validate_document(bundle)
    attach(bundle, "fine_holdouts", fine_holdouts(bundle))
    report.validate_document(bundle)


def test_freeze_record_joins_both_yaml_artifacts_and_fit(bundle):
    original = copy.deepcopy(bundle["candidate_document"])
    bundle["original_candidate_document"] = original
    bundle["sources"]["original_candidate_document"] = source(original, as_yaml=True)
    freeze = {"complete": True, "held_out_used": False,
              "identity": bundle["stages"]["refined150"]["identity"],
              "candidate_report_sha256": bundle["sources"]["stages"]["refined150"]["sha256"],
              "original_candidate_sha256": bundle["sources"]["original_candidate_document"]["sha256"],
              "frozen_candidate_sha256": bundle["sources"]["candidate_document"]["sha256"],
              "values": report.calibrated_values(original)}
    attach(bundle, "freeze", freeze)
    report.validate_document(bundle)
    freeze["candidate_report_sha256"] = "wrong-fit"
    attach(bundle, "freeze", freeze)
    with pytest.raises(ValueError, match="does not join"):
        report.validate_document(bundle)


@pytest.mark.parametrize("change,match", [
    (lambda v: v["parameters"]["p"].update(value=1.200001), "different candidate coefficients"),
    (lambda v: v["solver"].update(build="old"), "different solver"),
    (lambda v: v.pop("calibration_config"), "own evaluation configuration"),
    (lambda v: v["fixed"].update(other={"value": 2}), "different fixed assumptions"),
])
def test_full_validation_rejects_stale_values_build_or_missing_config(bundle, change, match):
    validation = full_validation(bundle)
    change(validation)
    attach_validation(bundle, validation)
    with pytest.raises(ValueError, match=match):
        report.validate_document(bundle)


def test_full_validation_labels_its_own_config_and_allows_coordinate_roundtrip(bundle):
    validation = full_validation(bundle)
    validation["parameters"]["p"]["value"] *= 1 + 1e-14
    attach_validation(bundle, validation)
    report.validate_document(bundle)
    rendered = report.markdown(bundle)
    assert "tier 0 and 8 particle classes" in rendered
    assert "own_configuration: true" in rendered


@pytest.mark.parametrize("trials,expected", [
    ([], "no descent direction was proposed"),
    ([{"cost": -100, "cost_change": -108, "failures": ["incomplete"]}], "No valid descent trial"),
    ([{"cost": -100, "cost_change": -108, "failures": ["incomplete"]},
      {"cost": 8.1, "cost_change": .1, "failures": []}], "changes cost by +0.1"),
    ([{"cost": None, "cost_change": None, "failures": []}], "No valid descent trial"),
])
def test_derivative_render_handles_empty_failed_and_nonfinite_trials(bundle, trials, expected):
    attach(bundle, "derivatives", derivative_audit(bundle, trials))
    report.validate_document(bundle)
    rendered = report.markdown(bundle)
    assert expected in rendered
    assert "changes cost by -108" not in rendered


def test_from_json_revalidates_offline_and_preserves_candidate_yaml_bytes(bundle, tmp_path, monkeypatch):
    path = tmp_path / "bundle.json"
    path.write_text(json.dumps(bundle))
    output = tmp_path / "rendered"
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--from-json", str(path), "--output-dir", str(output)])
    monkeypatch.setattr(report, "figure", lambda document, path: path.write_bytes(b"figure"))
    report.main()
    assert (output / "m11-refined-tuning.yaml").read_bytes() == bundle["sources"]["candidate_document"]["text"].encode()
    # Re-sign the altered input: this must fail the semantic join, not just its byte hash.
    bundle["stages"]["check300"]["starting_values"]["p"] = 1.3
    resign_stage(bundle, "check300")
    path.write_text(json.dumps(bundle))
    with pytest.raises(ValueError, match="different exact coefficients"):
        report.main()


def test_embedded_source_tampering_is_rejected(bundle):
    bundle["stages"]["refined150"]["final"]["cost"] = .01
    with pytest.raises(ValueError, match="differs from its embedded source"):
        report.validate_document(bundle)


def test_large_source_preserves_exact_bytes_and_detects_tampering(tmp_path):
    path = tmp_path / "large.json"
    original = "  " + json.dumps({"samples": list(range(15000))}, indent=2) + "\n\n"
    path.write_bytes(original.encode("utf-8"))
    parsed, saved = report.read_source(path)
    assert saved["encoding"] == "zlib+base64"
    assert report.source_text(saved, "test") == original
    report.check_source(parsed, saved, "test")
    saved["sha256"] = "changed"
    with pytest.raises(ValueError, match="source hash mismatch"):
        report.check_source(parsed, saved, "test")
    saved["data"] = "invalid compressed bytes"
    with pytest.raises(ValueError, match="invalid compressed source"):
        report.check_source(parsed, saved, "test")


def test_yaml_integer_experiment_keys_survive_json_roundtrip(tmp_path):
    path = tmp_path / "candidate.yaml"
    original = "# Exact YAML bytes\nfit:\n  transition_s:\n    1: 4.125\n    2: 3.75\n"
    path.write_text(original)
    value, saved = report.read_source(path, yaml_document=True)
    roundtrip = json.loads(json.dumps({"value": value, "source": saved}))
    report.check_source(roundtrip["value"], roundtrip["source"], "Candidate YAML", yaml_document=True)
    assert report.source_text(roundtrip["source"], "Candidate YAML") == original
    roundtrip["value"]["fit"]["transition_s"]["1"] = 9.0
    with pytest.raises(ValueError, match="differs from its embedded source"):
        report.check_source(roundtrip["value"], roundtrip["source"], "Candidate YAML", yaml_document=True)


def test_cli_assembles_explicit_frozen_yaml_and_freeze_record(bundle, tmp_path, monkeypatch):
    run_dir = tmp_path / "runs"
    for name, artifact in bundle["sources"]["stages"].items():
        path = run_dir / name / "report.json"
        path.parent.mkdir(parents=True)
        path.write_text(artifact["text"])
    original_path = run_dir / "refined150" / "candidate.yaml"
    original_path.write_text(bundle["sources"]["candidate_document"]["text"])
    frozen = copy.deepcopy(bundle["candidate_document"])
    frozen["parameters"]["hydraulics.permeability.reference"] = 3.123456789e-14
    frozen_source = source(frozen, as_yaml=True)
    frozen_path = run_dir / "refined150" / "frozen-candidate.yaml"
    frozen_path.write_text(frozen_source["text"])
    freeze = {"complete": True, "held_out_used": False,
              "identity": bundle["stages"]["refined150"]["identity"],
              "candidate_report_sha256": bundle["sources"]["stages"]["refined150"]["sha256"],
              "original_candidate_sha256": bundle["sources"]["candidate_document"]["sha256"],
              "frozen_candidate_sha256": frozen_source["sha256"],
              "values": report.calibrated_values(frozen)}
    freeze_path = run_dir / "refined150" / "freeze.json"
    freeze_path.write_text(json.dumps(freeze))
    output = tmp_path / "rendered"
    argv = [str(SCRIPT), "--root-dir", str(run_dir), "--resolution-stage", "check300",
            "--candidate-document", str(frozen_path), "--freeze", str(freeze_path),
            "--output-dir", str(output)]
    for name in bundle["stages"]:
        argv.extend(["--stage", name])
    monkeypatch.setattr(sys, "argv", argv)
    monkeypatch.setattr(report, "figure", lambda document, path: path.write_bytes(b"figure"))
    report.main()
    saved = json.loads((output / "m11-refined-tuning.json").read_text())
    report.validate_document(saved)
    assert saved["sources"]["candidate_document"]["sha256"] == freeze["frozen_candidate_sha256"]
    assert (output / "m11-refined-tuning.yaml").read_bytes() == frozen_path.read_bytes()
