# SPDX-License-Identifier: GPL-2.0-or-later
"""Conditional-replay boundaries, missing observations, and source isolation."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from puckworks_tools import community as c


def sample_case():
    return {
        "id": "synthetic-01", "grinder_group": "synthetic", "dose_g": 18.0,
        "t_s": [0, 1, 2, 3, 10, 11, 12, 20],
        "target_flow_ml_s": [-1, 4, .1, .0625, .0625, .125, 2.2, 2.2],
        "estimated_inlet_flow_ml_s": [0, 3, .1, .02, .02, .1, 2.2, 2.2],
        "measured_pressure_bar": [0, 2, 4, 3, 1, 2, 5, 4],
        "scale_mass_g": [0, -.01, 0, .1, 1.5, 1.7, 2, 18],
        "observed": {"thresholds": [{"mass_g": .5, "time_s": 5}, {"mass_g": 1, "time_s": 8}],
                     "final_logged_mass_g": 18, "annotated_minus_logged_mass_g": 2},
    }


def inventory_result(*, complete=True):
    """Synthetic conserved inventory with pressure storage and ongoing pore filling."""
    series = {
        "t_s": [0, 3, 10, 20], "beverage_mass_kg": [0, 0, .0042, .0094],
        "pressure_pa": [0, 12e5, 4e5, 0], "flow_in_m3_s": [0, 0, 0, 0],
        "cumulative_inlet_volume_m3": [0, 10e-6, 11e-6, 15e-6],
        "cumulative_outlet_volume_m3": [0, 0, 4e-6, 9e-6],
        "cumulative_vented_volume_m3": [0, 0, 0, 0],
        "retained_volume_m3": [0, 10e-6, 7e-6, 6e-6],
        "storage_volume_m3": [0, 6e-6, 2e-6, 0],
    }
    if not complete:
        series = {key: values[:-1] for key, values in series.items()}
    return {"core_version": "synthetic", "series": series,
            "summary": {"stop_reason": "time" if complete else "choked", "first_drops_s": 4},
            "diagnostics": {"hydraulic_volume_balance_error": 0, "mass_balance_error": 0,
                            "warnings": [] if complete else ["choked"]}}


def test_compression_keeps_input_knots_and_respects_native_phase_limit():
    t = np.linspace(0, 80, 401)
    y = np.sin(t) + 3 + .2 * np.sin(9 * t)
    coarse = c.compress_program(t, y, max_phases=16)
    fine = c.compress_program(t, y, required_indices=(17, 233))
    assert fine["phase_count"] == 64
    assert {0, 17, 233, 400} <= set(fine["indices"])
    assert fine["max_abs_interpolation_error"] < coarse["max_abs_interpolation_error"]
    reconstructed = np.interp(t, fine["t_s"], fine["targets"])
    assert np.max(abs(reconstructed - y)) == pytest.approx(fine["max_abs_interpolation_error"])
    assert fine == c.compress_program(t, y, required_indices=(17, 233))


@pytest.mark.parametrize("t,y", [([0, 1, 1], [0, 1, 2]), ([1, 2], [0, 1]),
                                  ([0, 1], [0, np.nan]), ([0, 1], [0, 1, 2])])
def test_invalid_replay_clocks_or_values_are_rejected(t, y):
    with pytest.raises(ValueError):
        c.compress_program(t, y)


def test_linear_input_needs_one_phase_and_initial_flat_flow_does_not_ramp_from_zero():
    linear = c.compress_program([0, 1, 2, 3], [0, 2, 4, 6])
    pressure = c.phases_from_program(linear, "pressure")
    assert len(pressure) == 1
    assert pressure[0]["ramp_s"] == 3
    assert pressure[0]["control"]["target_pa"] == 600000
    flow = c.compress_program([0, 4, 5, 20], [4, 4, .0625, .0625])
    phases = c.phases_from_program(flow, "flow")
    assert phases[0]["ramp_s"] == 0
    assert phases[0]["control"]["target_m3_s"] == 4e-6
    assert sum(p["exit"]["time_s"] for p in phases) == 20


def test_bloom_window_excludes_ramps_and_does_not_equate_target_and_estimated_flow():
    case = sample_case()
    window = c.bloom_window(case)
    assert (window["start_s"], window["end_s"]) == (3, 10)
    assert window["scale_gain_g"] == pytest.approx(1.4)
    assert window["target_inlet_volume_ml"] == pytest.approx(.0625 * 7)
    assert window["estimated_inlet_volume_ml"] == pytest.approx(.02 * 7)
    assert (window["pressure_start_bar"], window["pressure_end_bar"], window["pressure_drop_bar"]) == (3, 1, 2)
    changed = copy.deepcopy(case)
    changed["scale_mass_g"] = [999] * len(case["t_s"])
    selected = c.bloom_window(changed)
    assert (selected["start_s"], selected["end_s"]) == (3, 10)


def test_missing_crossing_and_outside_record_values_are_not_extrapolated():
    assert c.threshold_time([0, 1, 2], [-.01, .3, .4], .5) is None
    assert c.threshold_time([0, 1, 2], [.8, 1, 2], .5) is None
    assert c.threshold_time([0, 1, 2], [0, .4, .6], .5) == pytest.approx(1.5)
    assert c.threshold_time([0, 1, 2, 3], [0, .6, .2, .8], .5) == pytest.approx(5 / 6)
    assert c._at([0, 1], [0, .4], 1.5) is None
    assert c._integral([0, 1], [1, 1], 0, 2) is None
    assert c._range([None, 2])["missing"] == 1


def test_reject_unverified_source_before_simulation(repo):
    pytest.importorskip("puckcore")
    with pytest.raises(ValueError, match="pinned"):
        c.run_comparison({"cases": [sample_case()], "sources": {"identity_verified": False}}, repo)


def calibration_fixture(tmp_path, label):
    folder = tmp_path / "data/calibration"
    folder.mkdir(parents=True, exist_ok=True)
    value = 1.25 if label == "v2" else 2.5
    document = {"label": label, "parameters": {"test.coefficient": value}, "fit": {"source": "synthetic"}}
    for name in (f"{label}.yaml", "current.yaml"):
        (folder / name).write_text(json.dumps(document))
    registry = {"calibration": {"label": label, "parameters": ["test.coefficient"]},
                "parameters": [{"id": "test.coefficient", "default": value, "default_from": "calibration"},
                               {"id": "test.unfitted", "default": .5, "default_from": "registry"}]}
    return SimpleNamespace(root=tmp_path), document, registry


@pytest.mark.parametrize("label", ["v2", "v3"])
def test_calibration_identity_uses_selected_version_and_exact_document_hashes(tmp_path, label):
    other = "v3" if label == "v2" else "v2"
    calibration_fixture(tmp_path, other)
    paths, document, registry = calibration_fixture(tmp_path, label)
    # Equivalent YAML documents need not have identical bytes; retain both file identities.
    current_path = tmp_path / "data/calibration/current.yaml"
    current_path.write_text(json.dumps(document, indent=2) + "\n")
    identity = c._assert_fixed_calibration(paths, registry)
    assert identity["label"] == label
    assert identity["path"] == f"data/calibration/{label}.yaml"
    assert identity["sha256"] == hashlib.sha256((tmp_path / identity["path"]).read_bytes()).hexdigest()
    assert identity["current_sha256"] == hashlib.sha256(current_path.read_bytes()).hexdigest()
    assert identity["current_sha256"] != identity["sha256"]
    assert identity["parameters"] == document["parameters"]
    assert identity["embedded_values_verified"] is True


@pytest.mark.parametrize("label", ["v2", "v3"])
@pytest.mark.parametrize("mismatch", ["embedded_value", "embedded_label", "metadata_missing",
                                      "metadata_extra", "metadata_duplicate", "embedded_missing",
                                      "embedded_extra", "embedded_duplicate", "current_document",
                                      "versioned_label", "missing_versioned_file"])
def test_calibration_identity_rejects_stale_or_different_defaults(tmp_path, label, mismatch):
    paths, document, registry = calibration_fixture(tmp_path, label)
    folder = tmp_path / "data/calibration"
    if mismatch == "embedded_value":
        registry["parameters"][0]["default"] += .00001
    elif mismatch == "embedded_label":
        registry["calibration"]["label"] = "v3" if label == "v2" else "v2"
    elif mismatch == "metadata_missing":
        registry["calibration"]["parameters"] = []
    elif mismatch == "metadata_extra":
        registry["calibration"]["parameters"].append("test.extra")
    elif mismatch == "metadata_duplicate":
        registry["calibration"]["parameters"].append("test.coefficient")
    elif mismatch == "embedded_missing":
        registry["parameters"][0]["default_from"] = "registry"
    elif mismatch == "embedded_extra":
        registry["parameters"][1]["default_from"] = "calibration"
    elif mismatch == "embedded_duplicate":
        registry["parameters"].append(copy.deepcopy(registry["parameters"][0]))
    elif mismatch == "current_document":
        document["fit"]["source"] = "different calibration record, same coefficients"
        (folder / "current.yaml").write_text(json.dumps(document))
    elif mismatch == "versioned_label":
        document["label"] = "other"
        (folder / f"{label}.yaml").write_text(json.dumps(document))
    else:
        (folder / f"{label}.yaml").unlink()
    with pytest.raises(ValueError, match=label):
        c._assert_fixed_calibration(paths, registry)


@pytest.mark.parametrize("label", [None, "", "current", "../v3", "/tmp/v3"])
def test_calibration_identity_requires_a_versioned_label(tmp_path, label):
    paths, document, registry = calibration_fixture(tmp_path, "v3")
    document["label"] = label
    (tmp_path / "data/calibration/current.yaml").write_text(json.dumps(document))
    with pytest.raises(ValueError, match="named versioned calibration"):
        c._assert_fixed_calibration(paths, registry)


@pytest.mark.parametrize("value", [True, "2.5", float("nan"), float("inf")])
def test_calibration_identity_rejects_non_numeric_or_nonfinite_coefficients(tmp_path, value):
    paths, document, registry = calibration_fixture(tmp_path, "v3")
    document["parameters"]["test.coefficient"] = value
    registry["parameters"][0]["default"] = value
    for name in ("v3.yaml", "current.yaml"):
        (tmp_path / "data/calibration" / name).write_text(json.dumps(document))
    with pytest.raises(ValueError, match="v3"):
        c._assert_fixed_calibration(paths, registry)


@pytest.mark.parametrize("label", ["v2", "v3"])
def test_comparison_metadata_and_historical_render_keep_recorded_calibration(tmp_path, monkeypatch, label):
    puckcore = pytest.importorskip("puckcore")
    paths, document, registry = calibration_fixture(tmp_path, label)
    monkeypatch.setattr(puckcore, "registry", lambda: registry)
    monkeypatch.setattr(puckcore, "simulate_shot", lambda spec: inventory_result())
    monkeypatch.setattr(c, "solver_identity", lambda paths: {"puckcore_version": "synthetic"})
    monkeypatch.setattr(c, "build_conditional_spec", lambda *args, **kwargs: {
        "hydraulics": {"permeability_m2": 1e-13, "pore_air": {"tau_s": 1}},
        "thermal": {"initial_bed_temp_c": 20}})
    sources = {"identity_verified": True, "article_url": "https://example.test/experiment",
               "archive": {"url": "https://example.test/archive", "sha256": "synthetic"},
               "measurement_log": {"url": "https://example.test/log", "sha256": "synthetic"}}
    report = c.run_comparison({"cases": [sample_case()], "sources": sources}, paths, tier=0)
    identity = report["calibration"]
    assert identity["label"] == label
    assert identity["path"] == f"data/calibration/{label}.yaml"
    assert identity["parameters"] == document["parameters"]
    assert identity["sha256"] == hashlib.sha256((tmp_path / identity["path"]).read_bytes()).hexdigest()
    assert identity["use"] == f"Builder's embedded {label} coefficients, unchanged; no community data fitted."
    assert report["analysis_sha256"] == hashlib.sha256(Path(c.__file__).read_bytes()).hexdigest()
    saved = json.loads(json.dumps(report))
    # Re-rendering recorded v2 results after v3 selection must never relabel them as v3.
    other = "v3" if label == "v2" else "v2"
    calibration_fixture(tmp_path, other)
    markdown = c.render_markdown(saved)
    assert f"Unchanged {label} calibration (`data/calibration/{label}.yaml`)" in markdown
    assert identity["sha256"] in markdown
    assert f"Unchanged {other} calibration" not in markdown


def test_zero_probe_tracking_uses_supplied_program_and_retains_incomplete_status():
    case = sample_case()
    window = c.bloom_window(case)
    result = {
        "summary": {"stop_reason": "choked", "first_drops_s": None},
        "series": {"t_s": [0, 3, 10], "beverage_mass_kg": [0, 0, 0],
                   "pressure_pa": [0, 0, 0], "flow_in_m3_s": [0, 0, 0],
                   "cumulative_inlet_volume_m3": [0, 0, 0],
                   "cumulative_outlet_volume_m3": [0, 0, 0],
                   "cumulative_vented_volume_m3": [0, 0, 0],
                   "retained_volume_m3": [0, 0, 0], "storage_volume_m3": [0, 0, 0]},
        "diagnostics": {"hydraulic_volume_balance_error": 0, "mass_balance_error": 0, "warnings": ["choked"]},
    }
    program = {"t_s": [0, 20], "targets": [0, 0]}
    obs = c._result_observables(case, result, window, "flow", program)
    assert obs["flow_target_rmse_ml_s"] is None
    assert obs["pressure_rmse_bar"] is None
    assert obs["pressure_max_abs_error_bar"] is None
    assert obs["simulated_window_flow_target_rmse_ml_s"] == 0
    assert obs["mass_at_record_end_g"] is None
    assert obs["complete_record_window"] is False
    assert all(t["time_s"] is None and t["status"] == "not_reached" for t in obs["thresholds"])


def test_flow_tracking_excludes_final_stop_for_both_stop_sample_conventions():
    case = sample_case()
    result = inventory_result()
    result["summary"]["shot_time_s"] = 20
    program = {"t_s": [0, 20], "targets": [2.1875, 2.1875]}
    for last_flow in (2.1875e-6, 0.0):
        result["series"]["flow_in_m3_s"] = [2.1875e-6] * 3 + [last_flow]
        obs = c._result_observables(case, result, c.bloom_window(case), "flow", program)
        assert obs["complete_record_window"] is True
        assert obs["flow_target_rmse_ml_s"] == 0
        assert obs["simulated_window_flow_target_rmse_ml_s"] == 0


def test_bloom_inventory_uses_cumulative_volumes_and_distinguishes_pore_filling():
    case = sample_case()
    result = inventory_result()
    program = {"t_s": [0, 20], "targets": [0, 0]}
    obs = c._result_observables(case, result, c.bloom_window(case), "flow", program)
    # Instantaneous flow samples are deliberately zero; integrating them would lose the inlet.
    assert obs["bloom_input_volume_ml"] == pytest.approx(1)
    assert obs["bloom_output_volume_ml"] == pytest.approx(4)
    assert obs["bloom_mass_gain_g"] == pytest.approx(4.2)
    assert obs["bloom_pressure_start_bar"] == 12
    assert obs["bloom_pressure_end_bar"] == 4
    assert obs["bloom_pressure_drop_bar"] == 8
    assert obs["bloom_storage_depletion_ml"] == pytest.approx(4)
    assert obs["bloom_retained_volume_depletion_ml"] == pytest.approx(3)
    assert obs["bloom_hydraulic_volume_residual_ml"] == pytest.approx(0, abs=1e-12)
    # Interpolated endpoints preserve the linear volume identity.
    window = {"start_s": 4.5, "end_s": 8.75}
    partial = c._result_observables(case, result, window, "flow", program)
    assert partial["bloom_input_volume_ml"] == pytest.approx(4.25 / 7)
    assert partial["bloom_hydraulic_volume_residual_ml"] == pytest.approx(0, abs=1e-12)


def test_uncompleted_bloom_keeps_unobserved_endpoints_and_differences_missing():
    case = sample_case()
    result = inventory_result(complete=False)
    result["series"] = {key: values[:-1] for key, values in result["series"].items()}
    obs = c._result_observables(case, result, c.bloom_window(case), "flow",
                                {"t_s": [0, 20], "targets": [0, 0]})
    assert obs["complete_record_window"] is False
    assert obs["bloom_pressure_start_bar"] == 12
    for key in ("bloom_pressure_end_bar", "bloom_pressure_drop_bar", "bloom_input_volume_ml",
                "bloom_output_volume_ml", "bloom_storage_depletion_ml", "bloom_hydraulic_volume_residual_ml"):
        assert obs[key] is None


def test_missing_inventory_series_requires_rebuilding_the_extension():
    result = inventory_result()
    del result["series"]["storage_volume_m3"]
    case = sample_case()
    with pytest.raises(ValueError, match="rebuild the extension"):
        c._result_observables(case, result, c.bloom_window(case), "flow",
                              {"t_s": [0, 20], "targets": [0, 0]})


def test_fixed_compliance_grid_keeps_scenarios_distinct_and_reports_incomplete_runs(repo, monkeypatch):
    puckcore = pytest.importorskip("puckcore")
    specs = []

    def simulate(spec):
        specs.append(copy.deepcopy(spec))
        # An incomplete scenario and an incomplete approximation are returned states,
        # not exceptions; both must survive aggregation and rendering.
        return inventory_result(complete=len(specs) not in (1, 16))

    monkeypatch.setattr(puckcore, "simulate_shot", simulate)
    monkeypatch.setattr(c, "solver_identity", lambda paths: {"puckcore_version": "synthetic"})
    sources = {"identity_verified": True, "article_url": "https://example.test/experiment",
               "archive": {"url": "https://example.test/archive", "sha256": "synthetic"},
               "measurement_log": {"url": "https://example.test/log", "sha256": "synthetic"}}
    report = c.run_comparison({"cases": [sample_case()], "sources": sources}, repo, tier=0)
    runs = report["cases"][0]["simulations"]
    pressure = [r for r in runs if r["mode"] == "pressure_conditioned"]
    assert {(r["psd_scale"], r["headspace_ml"]) for r in pressure} == {
        (scale, headspace) for scale in (.5, 1, 2) for headspace in (0, 10, 30)}
    assert all(r["compliance_ml_per_bar"] == 0 for r in pressure)
    assert len(pressure) == 9
    for mode in ("recorded_flow_target", "zero_plateau_probe"):
        commands = [r for r in runs if r["mode"] == mode]
        assert {r["compliance_ml_per_bar"] for r in commands} == {0, .5, 2}
        assert {(r["psd_scale"], r["headspace_ml"]) for r in commands} == {(1, 10)}
    assert [spec["machine"]["hydraulic_compliance_m3_pa"] for spec in specs[9:15]] == pytest.approx(
        [0, 5e-12, 2e-11, 0, 5e-12, 2e-11])
    refined = [r for r in report["approximation_checks"]["runs"] if r["mode"] == "zero_plateau_probe"]
    assert {r["max_dt_s"] for r in refined} == {.05, .025}
    assert all(r["compliance_ml_per_bar"] == .5 for r in refined)
    assert report["numerical_checks"]["simulations"] == 20
    assert report["numerical_checks"]["incomplete_scenario_simulations"] == 1
    assert report["numerical_checks"]["incomplete_approximation_simulations"] == 1
    assert len(report["aggregate"]["synthetic"]["scenarios"]) == 15
    assert report["aggregate"]["synthetic"]["scenarios"][0]["mass_at_record_end_g"]["missing"] == 1
    assert report["aggregate"]["synthetic"]["scenarios"][0]["pressure_rmse_bar"]["missing"] == 1
    assert report["numerical_checks"]["max_abs_bloom_hydraulic_volume_residual_ml"] < 1e-12
    markdown = c.render_markdown(report)
    assert "1 incomplete scenario runs and 1 incomplete approximation runs" in markdown
    assert "Returned incomplete runs remain visible" in markdown
    assert "Pressure-storage depletion" in markdown
    assert report["refitted"] is False and report["scientific_acceptance_scored"] is False


def test_real_core_zero_command_has_no_mid_program_drainage():
    puckcore = pytest.importorskip("puckcore")
    case = sample_case()
    case["t_s"] = [0, 8, 9, 18, 19, 30]
    program = {"t_s": case["t_s"], "targets": [4, 4, 0, 0, 4, 4]}
    spec = c.build_conditional_spec(case, program, control="flow", psd_scale=1,
                                    headspace_ml=0, tier=0)
    result = puckcore.simulate_shot(spec)
    times = np.asarray(result["series"]["t_s"])
    mass = np.asarray(result["series"]["beverage_mass_kg"])
    inside = (times >= 10) & (times <= 17)
    assert len(mass[inside]) > 2
    assert np.max(mass[inside]) - np.min(mass[inside]) < 1e-12
    assert max(result["series"]["flow_in_m3_s"][i] for i in np.flatnonzero(inside)) == 0
    assert abs(result["diagnostics"]["hydraulic_volume_balance_error"]) < 1e-9


def test_real_core_opt_in_compliance_releases_stored_water_during_zero_command():
    puckcore = pytest.importorskip("puckcore")
    case = sample_case()
    case["t_s"] = [0, 20, 21, 31, 32, 45]
    program = {"t_s": case["t_s"], "targets": [4, 4, 0, 0, 4, 4]}
    spec = c.build_conditional_spec(case, program, control="flow", psd_scale=1,
                                    headspace_ml=0, tier=0, compliance_ml_per_bar=.5)
    result = puckcore.simulate_shot(spec)
    series = result["series"]
    times = np.asarray(series["t_s"])
    inside = np.flatnonzero((times >= 22) & (times <= 30))
    first, last = inside[0], inside[-1]
    pressure = np.asarray(series["pressure_pa"])[inside]
    assert pressure[0] > pressure[-1] >= 0
    assert np.max(np.diff(pressure)) <= 1e-8
    assert max(series["flow_in_m3_s"][i] for i in inside) == 0
    inlet = series["cumulative_inlet_volume_m3"]
    outlet = series["cumulative_outlet_volume_m3"]
    storage = series["storage_volume_m3"]
    assert inlet[last] - inlet[first] == 0
    assert outlet[last] - outlet[first] > 0
    assert outlet[last] - outlet[first] == pytest.approx(storage[first] - storage[last], abs=1e-12)
    assert abs(result["diagnostics"]["hydraulic_volume_balance_error"]) < 1e-9


def test_atomic_report_write_replaces_symlink_without_overwriting_target(tmp_path, monkeypatch):
    from puckworks_tools.sources.gagne2021 import ensure_local_output
    monkeypatch.setattr(c, "render_markdown", lambda report: "# local report\n")
    outside = tmp_path / "outside.json"
    outside.write_text("untouched")
    destination = tmp_path / "report"
    destination.mkdir()
    (destination / "community-comparison.json").symlink_to(outside)
    paths = c.write_report({"diagnostic": True}, destination)
    assert outside.read_text() == "untouched"
    assert not paths["json"].is_symlink()
    assert json.loads(paths["json"].read_text()) == {"diagnostic": True}
    assert ensure_local_output(destination) == destination.resolve()
