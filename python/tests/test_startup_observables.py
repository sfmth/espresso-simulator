# SPDX-License-Identifier: GPL-2.0-or-later
"""Startup comparisons require a measured clock origin and complete observation windows."""

from __future__ import annotations

import math
import copy
from types import SimpleNamespace

import numpy as np
import pytest

from puckworks_tools import validate
from puckworks_tools.cases import waszkiewicz2026 as wz


def test_pressure_clock_interpolates_and_does_not_invent_a_missing_origin():
    result = {"series": {"t_s": [3.0, 4.0, 5.0], "pressure_pa": [0.0, 0.5e6, 1e6]}}
    assert wz.alignment_time(result, 1e6) == pytest.approx(4.9)
    assert math.isnan(wz.alignment_time(result, 2e6))


def test_truncated_shot_does_not_supply_long_time_flow():
    case = SimpleNamespace(info={"target_bar": 9.0, "transient": [{"time_s": 0.0}, {"time_s": 100.0}]})
    result = {"series": {"t_s": [0.0, 1.0, 2.0, 3.0], "pressure_pa": [0.0, 9e5, 9e5, 9e5],
                         "beverage_mass_kg": [0.0, 0.0, 0.001, 0.002]}, "summary": {"first_drops_s": None}}
    observed = wz.observe(case, result)
    assert observed["offset_s"] == pytest.approx(0.95)
    assert math.isnan(observed["long_time_flow_g_s"])
    assert math.isnan(observed["transient_flow_g_s"][-1])


def test_flow_rise_interpolates_and_is_independent_of_the_pump_clock():
    time = np.array([0.0, 10.0, 20.0, 30.0, 100.0])
    flow = np.array([0.0, 0.0, 1.0, 2.0, 2.0])
    observed = wz.flow_rise(time, flow, 10.0, 100.0)
    shifted = wz.flow_rise(time + 250.0, flow, 260.0, 350.0)
    assert observed == pytest.approx(shifted)
    assert observed["t90_s"] == pytest.approx(18.0)
    assert observed["q2"] == pytest.approx(0.2)
    assert observed["q15"] == pytest.approx(1.5)


def test_flow_rise_rejects_unobserved_or_zero_reference_flow():
    time = np.array([0.0, 10.0, 20.0])
    flow = np.array([0.0, 1.0, 2.0])
    observed = wz.flow_rise(time, flow, 10.0, 100.0)
    assert math.isnan(observed["q_end"]) and math.isnan(observed["q15"]) and math.isnan(observed["t90_s"])
    assert math.isnan(wz.flow_rise(time, np.zeros(3), 0.0, 20.0)["t90_s"])


def _matching_transient():
    time = np.linspace(0.0, 100.0, 101)
    flow = np.clip((time - 10.0) / 10.0, 0.0, 2.0)
    # Only the first 0.1 g and the 36 g crossings enter the mass-derived metrics here.
    mass = np.interp(time, [0.0, 10.0, 40.0, 100.0], [0.0, 0.1, 36.0, 156.0])
    rows = [{"time_s": float(t), "flow_g_s": float(q), "mass_g": float(m)} for t, q, m in zip(time, flow, mass)]
    case = SimpleNamespace(info={"group": "9", "transient": rows, "longtime": {"flow_g_s": 2.0}})
    observed = {"offset_s": 5.0, "drops_s": 15.0, "time_to_mass_s": 45.0, "flow_t_s": (time + 5.0).tolist(),
                "flow_g_s": flow.tolist(), "long_time_flow_g_s": 2.0, "tds_fractions": [{"tds_percent": 25.0}]}
    return SimpleNamespace(cases=[case]), observed


def test_startup_scoring_retains_strict_delay_rise_and_overshoot_targets():
    block, observed = _matching_transient()
    checks, metrics = validate.check_v4_transient(block, [observed])
    assert [check["status"] for check in checks] == ["pass", "pass", "pass", "info"]
    assert metrics["drops_model_s"] == pytest.approx(10.0)
    assert metrics["rise_model"]["t90_s"] == pytest.approx(18.0)

    delayed = {**observed, "drops_s": 25.0}
    checks, _ = validate.check_v4_transient(block, [delayed])
    assert checks[0]["status"] == checks[1]["status"] == "fail"

    overshoot = {**observed, "flow_g_s": list(observed["flow_g_s"])}
    overshoot["flow_g_s"][25] = 2.01
    checks, _ = validate.check_v4_transient(block, [overshoot])
    assert checks[0]["status"] == "fail" and "overshoot:" in checks[0]["detail"]


def test_missing_pressure_origin_and_incomplete_flow_windows_cannot_pass():
    block, observed = _matching_transient()
    checks, metrics = validate.check_v4_transient(block, [{**observed, "offset_s": math.nan}])
    assert metrics == {}
    assert checks[0]["status"] == checks[1]["status"] == "fail"
    assert "never reaches" in checks[0]["detail"]
    # TDS uses its own first-drop clock, so it is still observable without a pressure clock.
    assert checks[2]["status"] == "pass"

    truncated = {**observed, "flow_t_s": observed["flow_t_s"][:50], "flow_g_s": observed["flow_g_s"][:50]}
    checks, _ = validate.check_v4_transient(block, [truncated])
    assert checks[0]["status"] == "fail" and "incomplete flow window" in checks[0]["detail"]


def test_known_biases_follow_current_observations():
    block, observed = _matching_transient()
    checks, metrics = validate.check_v4_transient(block, [observed])
    report = {"held_out": {"v4_transient": metrics}, "held_out_checks": checks,
              "calibration": {"blocks": {"V1": {"pump_limited": {"transition_s": {"1": 0.0}, "pour_capped": []}}}}}
    text = "\n".join(validate.known_biases(report))
    assert "Startup mismatch" not in text and "Pump saturation" not in text
    checks[0]["status"] = "fail"
    text = "\n".join(validate.known_biases(report))
    assert "Startup mismatch" in text
    assert "missing transient" not in text and "matches its long-time flow" not in text


def test_cached_refits_survive_export_but_not_a_changed_model_or_configuration():
    solver = {"puckcore_version": "0.3.0", "sources_sha256": {
        "crates/puckcore/src": "core", "crates/puckmodel/src": "model", "crates/puckcore-py": "bindings",
        "crates/puckmodel/generated": "before-fit-export"}, "files_sha256": {"Cargo.lock": "dependencies"}}
    inputs = {"config_sha256": "config", "datasets_sha256": {"example": "data"},
              "registry_inputs_sha256": "numeric-defaults", "presets_sha256": "preset-inputs",
              "calibration_sources_sha256": "calibration-and-cases"}
    loo = {"lambda_within": 60, "lambda_total": 60, "cup_within": 180, "cup_total": 180}
    document = {"fit": {"solver": copy.deepcopy(solver), "inputs": copy.deepcopy(inputs), "loo": loo}}
    solver["sources_sha256"]["crates/puckmodel/generated"] = "calibration-embedded"
    assert validate.calibration_reuse_issues(document, solver, inputs) == []
    assert validate.loo_check(loo)["status"] == "pass"

    solver["sources_sha256"]["crates/puckcore/src"] = "new-startup-model"
    reasons = validate.calibration_reuse_issues(document, solver, inputs)
    assert any("sources changed" in reason for reason in reasons)
    cached = validate.loo_check(loo, stale_reasons=reasons)
    assert cached["status"] == "not run" and "historical" in cached["detail"]

    changed_inputs = {**inputs, "config_sha256": "new-fixed-startup-priors"}
    reasons = validate.calibration_reuse_issues(document, document["fit"]["solver"], changed_inputs)
    assert reasons == ["calibration configuration changed or lacks an identity"]

    changed_inputs = {**inputs, "registry_inputs_sha256": "new-pore-air-default"}
    reasons = validate.calibration_reuse_issues(document, document["fit"]["solver"], changed_inputs)
    assert reasons == ["numeric registry defaults changed or lack an identity"]

    changed_inputs = {**inputs, "presets_sha256": "changed-pump-flow"}
    reasons = validate.calibration_reuse_issues(document, document["fit"]["solver"], changed_inputs)
    assert reasons == ["preset inputs changed or lack an identity"]
