# SPDX-License-Identifier: GPL-2.0-or-later
"""Conditional-replay boundaries, missing observations, and source isolation."""
from __future__ import annotations

import copy
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


@pytest.mark.parametrize("mismatch", ["embedded_value", "embedded_label", "current_file"])
def test_calibration_identity_rejects_stale_or_different_defaults(tmp_path, mismatch):
    folder = tmp_path / "data/calibration"
    folder.mkdir(parents=True)
    document = {"label": "v2", "parameters": {"test.coefficient": 1.25}}
    for name in ("v2.yaml", "current.yaml"):
        (folder / name).write_text(json.dumps(document))
    registry = {"calibration": {"label": "v2", "parameters": ["test.coefficient"]},
                "parameters": [{"id": "test.coefficient", "default": 1.25, "default_from": "calibration"}]}
    assert c._assert_fixed_calibration(SimpleNamespace(root=tmp_path), registry)["embedded_values_verified"]
    if mismatch == "embedded_value":
        registry["parameters"][0]["default"] = 1.25001
    elif mismatch == "embedded_label":
        registry["calibration"]["label"] = "v1"
    else:
        (folder / "current.yaml").write_text('{"label":"v3","parameters":{"test.coefficient":1.25}}')
    with pytest.raises(ValueError, match="v2"):
        c._assert_fixed_calibration(SimpleNamespace(root=tmp_path), registry)


def test_zero_probe_tracking_uses_supplied_program_and_retains_incomplete_status():
    case = sample_case()
    window = c.bloom_window(case)
    result = {
        "summary": {"stop_reason": "choked", "first_drops_s": None},
        "series": {"t_s": [0, 3, 10], "beverage_mass_kg": [0, 0, 0],
                   "pressure_pa": [0, 0, 0], "flow_in_m3_s": [0, 0, 0]},
        "diagnostics": {"hydraulic_volume_balance_error": 0, "mass_balance_error": 0, "warnings": ["choked"]},
    }
    program = {"t_s": [0, 20], "targets": [0, 0]}
    obs = c._result_observables(case, result, window, "flow", program)
    assert obs["flow_target_rmse_ml_s"] == 0
    assert obs["mass_at_record_end_g"] is None
    assert obs["complete_record_window"] is False
    assert all(t["time_s"] is None and t["status"] == "not_reached" for t in obs["thresholds"])


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
