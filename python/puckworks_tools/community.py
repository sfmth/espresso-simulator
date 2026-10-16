# SPDX-License-Identifier: GPL-2.0-or-later
"""Conditional community-shot diagnostics; no fitting or scientific pass/fail scoring.

Original observations are supplied by a local audited source loader. These simulations
condition on observations and explicit illustrative nuisance assumptions, so they are
not matched predictions or independent validation of the pressure boundary.
"""
from __future__ import annotations

import hashlib
import json
import math
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from .cases.common import Basket, base_spec, ideal_pump, minimal_recipe, phase, set_program
from .identity import solver_identity
from .paths import RepoPaths
from .yamlio import load_yaml

# Fixed before inspecting model responses; deliberately the same hypotheses for both grinders.
# These are sensitivity scenarios, not measured PSDs or a probability distribution.
PSD_SCALES = (0.5, 1.0, 2.0)
HEADSPACE_ML = (0.0, 10.0, 30.0)
CENTRAL = (1.0, 10.0)


def _assert_fixed_calibration(paths: RepoPaths, registry: dict[str, Any]) -> dict[str, Any]:
    """Refuse to label an installed builder's different defaults as the preserved v2 fit."""
    expected = load_yaml(paths.root / "data/calibration/v2.yaml")
    current = load_yaml(paths.root / "data/calibration/current.yaml")
    if expected.get("label") != "v2" or current != expected:
        raise ValueError("community comparison requires current.yaml to match preserved v2.yaml")
    values = expected.get("parameters", {})
    metadata = registry.get("calibration", {})
    records = {record["id"]: record for record in registry.get("parameters", [])}
    embedded_keys = {key for key, record in records.items() if record.get("default_from") == "calibration"}
    if (not values or metadata.get("label") != "v2" or embedded_keys != set(values)
            or set(metadata.get("parameters", [])) != set(values)):
        raise ValueError("installed puckcore calibration metadata differs from v2; rebuild the extension")
    for key, value in values.items():
        if records[key].get("default") != value:
            raise ValueError(f"installed puckcore default for {key} differs from v2; rebuild the extension")
    return {"label": "v2", "embedded_values_verified": True, "parameters": dict(values)}


def _numeric(values: Any, name: str) -> np.ndarray:
    out = np.asarray(values, dtype=float)
    if out.ndim != 1 or len(out) < 2 or not np.all(np.isfinite(out)):
        raise ValueError(f"{name} needs at least two finite scalar samples")
    return out


def compress_program(t_s: Any, targets: Any, *, max_phases: int = 64,
                     required_indices: tuple[int, ...] = ()) -> dict[str, Any]:
    """Greedily bound the *input* interpolation error using at most max_phases segments.

    No output mass or simulation response participates. Breakpoints are original samples;
    insert the sample with greatest absolute vertical interpolation error, earliest on ties.
    """
    t = _numeric(t_s, "time")
    y = _numeric(targets, "targets")
    if len(t) != len(y) or not np.all(np.diff(t) > 0) or abs(t[0]) > 1e-12:
        raise ValueError("equal-length target/time arrays must start at zero and increase strictly")
    if not 1 <= max_phases <= 64:
        raise ValueError("max_phases must be 1..64")
    nodes = {0, len(t) - 1, *required_indices}
    if any(i < 0 or i >= len(t) for i in nodes) or len(nodes) > max_phases + 1:
        raise ValueError("required indices exceed the phase budget or input bounds")
    while len(nodes) < max_phases + 1:
        order = sorted(nodes)
        error = np.abs(y - np.interp(t, t[order], y[order]))
        i = int(np.argmax(error))
        if error[i] <= 1e-12:
            break
        nodes.add(i)
    order = sorted(nodes)
    error = y - np.interp(t, t[order], y[order])
    return {"indices": order, "t_s": t[order].tolist(), "targets": y[order].tolist(),
            "phase_count": len(order) - 1,
            "max_abs_interpolation_error": float(np.max(np.abs(error)))}


def phases_from_program(program: dict[str, Any], control: str) -> list[dict[str, Any]]:
    """Use timed linear ramps, preserving a nonzero initial flat flow command."""
    if control not in ("pressure", "flow"):
        raise ValueError("control must be pressure or flow")
    times, targets = program["t_s"], program["targets"]
    out = []
    for i in range(len(times) - 1):
        dt = times[i + 1] - times[i]
        key, factor = ("target_pa", 1e5) if control == "pressure" else ("target_m3_s", 1e-6)
        target = targets[i + 1]
        if target < 0:
            raise ValueError("negative machine targets cannot be replayed")
        # A flat initial flow segment starts immediately at its logged target. For a ramp,
        # the native engine starts from achieved previous pressure/flow; mismatch is reported.
        ramp = 0.0 if abs(target - targets[i]) <= 1e-12 else dt
        out.append(phase({"type": control, key: target * factor}, ramp_s=ramp,
                         limit=8e-6 if control == "pressure" else 1.2e6, time_s=dt))
    return out


def threshold_time(t_s: Any, values: Any, threshold: float) -> float | None:
    """First upward crossing; a record already above threshold is left-censored."""
    t, y = np.asarray(t_s, dtype=float), np.asarray(values, dtype=float)
    if len(t) == 0 or len(t) != len(y):
        return None
    if y[0] >= threshold:
        return None
    crossing = np.flatnonzero((y[:-1] < threshold) & (y[1:] >= threshold))
    if len(crossing) == 0:
        return None
    i = int(crossing[0])
    return float(t[i] + (threshold - y[i]) * (t[i + 1] - t[i]) / (y[i + 1] - y[i]))


def _at(t: Any, y: Any, when: float) -> float | None:
    if when < t[0] - 1e-9 or when > t[-1] + 1e-9:
        return None
    return float(np.interp(when, t, y))


def _integral(t: Any, y: Any, start: float, end: float) -> float | None:
    t, y = np.asarray(t), np.asarray(y)
    if start < t[0] - 1e-9 or end > t[-1] + 1e-9:
        return None
    inside = (t > start) & (t < end)
    tt = np.concatenate(([start], t[inside], [end]))
    yy = np.interp(tt, t, y)
    return float(np.sum(np.diff(tt) * (yy[:-1] + yy[1:]) / 2))


def bloom_window(case: dict[str, Any]) -> dict[str, Any]:
    """Find the longest minimum logged-flow-goal plateau; do not call it pump-off.

    Its boundaries are sampled plateau endpoints, excluding both transitions. The initial
    negative sentinel is not a physical flow command. No observed cup mass selects the window.
    """
    t = _numeric(case["t_s"], "time")
    goal = _numeric(case["target_flow_ml_s"], "flow goals")
    if len(goal) != len(t):
        raise ValueError("flow-goal and time lengths differ")
    valid = np.flatnonzero(goal >= 0)
    if not len(valid):
        raise ValueError("no nonnegative flow goals")
    floor = float(np.min(goal[valid]))
    mask = np.isclose(goal, floor, rtol=0, atol=1e-12)
    runs = []
    start = None
    for i, value in enumerate(mask):
        if value and start is None:
            start = i
        if start is not None and (not value or i == len(mask) - 1):
            end = i if value else i - 1
            runs.append((start, end))
            start = None
    first, last = max(runs, key=lambda r: t[r[1]] - t[r[0]])
    if t[last] - t[first] < 5:
        raise ValueError("no sustained low-flow-goal plateau found")
    mass = np.asarray(case["scale_mass_g"])
    return {"first_index": first, "last_index": last,
            "start_s": float(t[first]), "end_s": float(t[last]),
            "duration_s": float(t[last] - t[first]), "logged_target_ml_s": floor,
            "scale_gain_g": float(mass[last] - mass[first]),
            "target_inlet_volume_ml": _integral(t, goal, t[first], t[last]),
            "estimated_inlet_volume_ml": _integral(t, case["estimated_inlet_flow_ml_s"], t[first], t[last]),
            "pressure_start_bar": float(case["measured_pressure_bar"][first]),
            "pressure_end_bar": float(case["measured_pressure_bar"][last])}


def _flow_goals(case: dict[str, Any]) -> np.ndarray:
    goal = np.asarray(case["target_flow_ml_s"], dtype=float).copy()
    good = np.flatnonzero(goal >= 0)
    if not len(good) or np.any(goal[good[0]:] < 0):
        raise ValueError("flow goals have missing commands after startup")
    # The record starts with a -1 sentinel. Its replacement is a declared control assumption.
    goal[:good[0]] = goal[good[0]]
    return goal


def build_conditional_spec(case: dict[str, Any], program: dict[str, Any], *, control: str,
                           psd_scale: float, headspace_ml: float, tier: int,
                           max_dt_s: float = 0.05) -> dict[str, Any]:
    basket = Basket("illustrative 58 mm straight-wall basket", 58.0, 24.0, 54.0)
    recipe = minimal_recipe(case["dose_g"], ([40 * psd_scale, 400 * psd_scale], [0.3, 0.7]),
                            basket, time_s=case["t_s"][-1], tier=tier, temperature_c=92.0)
    spec = base_spec(recipe)
    bed = spec["bed"]
    area = math.pi * (0.058 / 2) ** 2
    bed_height = bed["dose_kg"] / ((1 - bed["intraparticle_porosity"]) * bed["skeletal_density_kg_m3"]
                                  * (1 - bed["intergranular_porosity"]) * area)
    # Only empty volume changes; the coffee bed retains the same straight cross-section.
    # A tiny geometric tolerance avoids a floating-point "bed taller than basket" rejection.
    top = bed_height + headspace_ml * 1e-6 / area + 1e-12
    spec["basket"]["profile_m"] = [[0.0, 0.029], [top, 0.029]]
    spec["basket"]["extra_headspace_m3"] = 0.0
    set_program(spec, phases_from_program(program, control), pump=ideal_pump(8e-6, 1.2e6),
                stop_time_s=case["t_s"][-1], max_duration_s=case["t_s"][-1])
    spec["machine"]["stop"]["drip_tau_s"] = 0.0
    spec["numerics"].update(max_dt_s=max_dt_s, output_interval_s=0.1, snapshot_count=1)
    return spec


def _result_observables(case: dict[str, Any], result: dict[str, Any], window: dict[str, Any],
                        control: str, program: dict[str, Any]) -> dict[str, Any]:
    s = result["series"]
    t = np.asarray(s["t_s"])
    mass = np.asarray(s["beverage_mass_kg"]) * 1000
    input_t = np.asarray(case["t_s"])
    end = float(input_t[-1])
    start_mass = _at(t, mass, window["start_s"])
    end_mass = _at(t, mass, window["end_s"])
    complete = t[-1] >= end - 1e-8
    pressure_error = np.asarray(s["pressure_pa"]) / 1e5 - np.interp(t, input_t, case["measured_pressure_bar"])
    target_error = np.asarray(s["flow_in_m3_s"]) * 1e6 - np.interp(t, program["t_s"], program["targets"])
    thresholds = [{"mass_g": target, "time_s": threshold_time(t, mass, target)} for target in (0.5, 1.0)]
    for row in thresholds:
        row["status"] = ("left_censored" if mass[0] >= row["mass_g"] else
                         "reached" if row["time_s"] is not None else "not_reached")
    return {"complete_record_window": bool(complete), "record_end_s": end,
            "model_end_s": float(t[-1]), "stop_reason": result["summary"]["stop_reason"],
            "thresholds": thresholds, "model_summary_first_drops_s": result["summary"]["first_drops_s"],
            "mass_at_record_end_g": _at(t, mass, end),
            "bloom_mass_gain_g": None if start_mass is None or end_mass is None else end_mass - start_mass,
            "bloom_input_volume_ml": _integral(t, np.asarray(s["flow_in_m3_s"]) * 1e6,
                                                window["start_s"], window["end_s"]),
            "pressure_rmse_bar": float(np.sqrt(np.mean(pressure_error ** 2))),
            "pressure_max_abs_error_bar": float(np.max(np.abs(pressure_error))),
            "flow_target_rmse_ml_s": float(np.sqrt(np.mean(target_error ** 2))) if control == "flow" else None,
            "max_flow_in_ml_s": float(max(s["flow_in_m3_s"]) * 1e6),
            "hydraulic_volume_balance_error": result["diagnostics"]["hydraulic_volume_balance_error"],
            "solute_mass_balance_error": result["diagnostics"]["mass_balance_error"],
            "warnings": result["diagnostics"]["warnings"]}


def _range(values: list[Any]) -> dict[str, Any]:
    good = [float(v) for v in values if v is not None and math.isfinite(v)]
    return {"min": min(good) if good else None, "max": max(good) if good else None,
            "median": float(np.median(good)) if good else None, "count": len(good),
            "missing": len(values) - len(good)}


def _aggregate(report: dict[str, Any]) -> dict[str, Any]:
    cases = report["cases"]
    out = {}
    for group in sorted({c["grinder_group"] for c in cases}):
        selected = [c for c in cases if c["grinder_group"] == group]
        row = {"shots": len(selected),
               "observed_bloom_mass_gain_g": _range([c["bloom"]["scale_gain_g"] for c in selected]),
               "target_bloom_inlet_ml": _range([c["bloom"]["target_inlet_volume_ml"] for c in selected]),
               "estimated_bloom_inlet_ml": _range([c["bloom"]["estimated_inlet_volume_ml"] for c in selected]),
               "observed_final_logged_mass_g": _range([c["observed"]["final_logged_mass_g"] for c in selected]),
               "observed_threshold_0_5g_s": _range([c["observed"]["thresholds"][0]["time_s"] for c in selected]),
               "observed_threshold_1g_s": _range([c["observed"]["thresholds"][1]["time_s"] for c in selected]),
               "scenarios": []}
        for mode in ("pressure_conditioned", "recorded_flow_target", "zero_plateau_probe"):
            runs = [r for c in selected for r in c["simulations"] if r["mode"] == mode]
            row[mode] = {
                "runs": len(runs), "complete": sum(r["observables"]["complete_record_window"] for r in runs),
                "mass_at_record_end_g": _range([r["observables"]["mass_at_record_end_g"] for r in runs]),
                "bloom_mass_gain_g": _range([r["observables"]["bloom_mass_gain_g"] for r in runs]),
                "bloom_input_volume_ml": _range([r["observables"]["bloom_input_volume_ml"] for r in runs]),
                "threshold_0_5g_s": _range([r["observables"]["thresholds"][0]["time_s"] for r in runs]),
                "threshold_1g_s": _range([r["observables"]["thresholds"][1]["time_s"] for r in runs]),
                "pressure_rmse_bar": _range([r["observables"]["pressure_rmse_bar"] for r in runs])}
            for scale, headspace in sorted({(r["psd_scale"], r["headspace_ml"]) for r in runs}):
                matching = [r for r in runs if r["psd_scale"] == scale and r["headspace_ml"] == headspace]
                row["scenarios"].append({"mode": mode, "psd_scale": scale, "headspace_ml": headspace,
                    "runs": len(matching),
                    "complete": sum(r["observables"]["complete_record_window"] for r in matching),
                    "threshold_0_5g_s": _range([r["observables"]["thresholds"][0]["time_s"] for r in matching]),
                    "threshold_1g_s": _range([r["observables"]["thresholds"][1]["time_s"] for r in matching]),
                    "mass_at_record_end_g": _range([r["observables"]["mass_at_record_end_g"] for r in matching]),
                    "bloom_mass_gain_g": _range([r["observables"]["bloom_mass_gain_g"] for r in matching]),
                    "pressure_rmse_bar": _range([r["observables"]["pressure_rmse_bar"] for r in matching])})
        out[group] = row
    return out


def run_comparison(bundle: dict[str, Any], paths: RepoPaths, *, tier: int = 1) -> dict[str, Any]:
    import puckcore

    if tier not in (0, 1):
        raise ValueError("tier must be 0 or 1")
    if not bundle["cases"]:
        raise ValueError("community comparison needs at least one qualified case")
    if bundle["sources"].get("identity_verified") is not True:
        raise ValueError("community comparison requires the pinned Gagné source identities")
    calibration_identity = _assert_fixed_calibration(paths, puckcore.registry())
    report: dict[str, Any] = {
        "schema": "puckworks.community-comparison/1", "source": "gagne2021",
        "purpose": "Exploratory conditional replay and structural probes; not matched validation.",
        "refitted": False, "scientific_acceptance_scored": False,
        "solver": solver_identity(paths), "tier": tier,
        "analysis_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "case_helpers_sha256": hashlib.sha256((Path(__file__).parent / "cases/common.py").read_bytes()).hexdigest(),
        "source_tools_sha256": {name: hashlib.sha256((Path(__file__).parent / "sources" / name).read_bytes()).hexdigest()
                                for name in ("de1.py", "gagne2021.py") if (Path(__file__).parent / "sources" / name).is_file()},
        "calibration": {"path": "data/calibration/v2.yaml",
                        "sha256": hashlib.sha256((paths.root / "data/calibration/v2.yaml").read_bytes()).hexdigest(),
                        **calibration_identity,
                        "use": "Builder's embedded v2 coefficients, unchanged; no community data fitted."},
        "sources": bundle["sources"], "source_limitations": bundle.get("limitations", []),
        "assumptions": {"psd_diameters_um_at_scale_1": [40, 400], "psd_volume_fractions": [0.3, 0.7],
                        "psd_scales": list(PSD_SCALES), "headspace_ml": list(HEADSPACE_ML),
                        "central_command_probe": {"psd_scale": CENTRAL[0], "headspace_ml": CENTRAL[1]},
                        "basket_diameter_mm": 58, "perforated_diameter_mm": 54,
                        "inlet_temperature_c": 92, "ideal_max_flow_ml_s": 8,
                        "ideal_max_pressure_bar": 12, "output_interval_s": 0.1, "max_dt_s": 0.05,
                        "stop": "End of recorded elapsed series; no modeled post-record drip.",
                        "clock": "Unshifted logged elapsed clock, not established pump energization time.",
                        "selection": "Illustrative uniform grid fixed before model response inspection; not priors or fitted values."},
        "limitations": [
            "Pressure-conditioned replay consumes measured pressure and cannot validate pressure prediction.",
            "Pressure replay may require virtual inlet delivery during bloom; it is not an actual pump-control reconstruction.",
            "The ideal pump cap and sequential headspace filling can prevent exact pressure tracking; errors are reported.",
            "No measured PSD or headspace exists; every grinder receives the same illustrative scenario grid.",
            "A constant 92 C inlet and builder-default initial thermal state replace the varying temperature program; basket temperature is not imposed as inlet temperature.",
            "Other bean, paper-filter, geometry and preparation properties remain builder defaults, not measured experiment inputs.",
            "The flow probe uses logged targets (not measured inlet flow). The negative startup sentinel is replaced by the first valid command.",
            "The zero plateau is a counterfactual structural probe. The real logged bloom goal is positive, with ramps outside the selected plateau.",
            "Mid-program zero flow has no independent pressure-storage or gravity-drainage state in the current solver.",
            "Comparing cup grams with inlet millilitres is not a closed experimental water/solute balance: inlet estimates, density, dissolved solids and sensor uncertainty remain unresolved.",
            "Bloom discrepancies motivate pressure/storage and drainage investigation but do not uniquely identify gas, headspace or particle-water mechanisms; do not tune pore-air coefficients to replace missing storage physics.",
            "Scale noise, latency and clock alignment limit physical interpretation of threshold times.",
            "Window metrics interpolate 0.1 s model outputs; sharp phase boundaries can cause small apparent zero-probe gains.",
            "Recorded-end mass and spreadsheet final beverage mass are different endpoints; their difference is not classified as drip.",
            "No coefficient is selected by residual, no scientific pass/fail gate is assigned, and existing held-out datasets are untouched."],
        "cases": []}
    for case in bundle["cases"]:
        window = bloom_window(case)
        pressure = np.asarray(case["measured_pressure_bar"], dtype=float)
        if np.any(pressure < 0):
            raise ValueError("negative pressure observations require explicit qualification before replay")
        pressure_program = compress_program(case["t_s"], pressure)
        flow = _flow_goals(case)
        anchors = (window["first_index"], window["last_index"])
        flow_program = compress_program(case["t_s"], flow, required_indices=anchors)
        zero_flow = flow.copy()
        zero_flow[window["first_index"]:window["last_index"] + 1] = 0
        zero_program = compress_program(case["t_s"], zero_flow, required_indices=anchors)
        case_row = {"id": case["id"], "grinder_group": case["grinder_group"], "dose_g": case["dose_g"],
                    "observed": {k: case["observed"][k] for k in ("thresholds", "final_logged_mass_g", "annotated_minus_logged_mass_g")},
                    "bloom": window,
                    "program_compression": {mode: {k: p[k] for k in ("phase_count", "max_abs_interpolation_error")}
                                            for mode, p in (("pressure_bar", pressure_program), ("flow_ml_s", flow_program), ("zero_flow_ml_s", zero_program))},
                    "simulations": []}
        scenarios = [("pressure_conditioned", "pressure", pressure_program, scale, headspace)
                     for scale in PSD_SCALES for headspace in HEADSPACE_ML]
        scenarios += [("recorded_flow_target", "flow", flow_program, *CENTRAL),
                      ("zero_plateau_probe", "flow", zero_program, *CENTRAL)]
        for mode, control, program, scale, headspace in scenarios:
            spec = build_conditional_spec(case, program, control=control, psd_scale=scale,
                                          headspace_ml=headspace, tier=tier)
            result = puckcore.simulate_shot(spec)
            report["solver"]["puckcore_version"] = result["core_version"]
            case_row["simulations"].append({"mode": mode, "psd_scale": scale, "headspace_ml": headspace,
                "spec_sha256": hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest(),
                "permeability_m2": spec["hydraulics"]["permeability_m2"],
                "pore_air_tau_s": spec["hydraulics"]["pore_air"]["tau_s"],
                "initial_bed_temperature_c": spec["thermal"]["initial_bed_temp_c"],
                "observables": _result_observables(case, result, window, control, program)})
        report["cases"].append(case_row)
    # Approximation checks select the first stable experiment id, never a favourable response.
    representative = min(bundle["cases"], key=lambda c: c["id"])
    window = bloom_window(representative)
    checks = []
    for phase_budget, dt in ((64, 0.05), (32, 0.05), (64, 0.025)):
        program = compress_program(representative["t_s"], representative["measured_pressure_bar"],
                                   max_phases=phase_budget)
        spec = build_conditional_spec(representative, program, control="pressure", psd_scale=CENTRAL[0],
                                      headspace_ml=CENTRAL[1], tier=tier, max_dt_s=dt)
        result = puckcore.simulate_shot(spec)
        checks.append({"phase_budget": phase_budget, "phases": program["phase_count"], "max_dt_s": dt,
                       "input_max_abs_interpolation_error_bar": program["max_abs_interpolation_error"],
                       "observables": _result_observables(representative, result, window, "pressure", program)})
    report["approximation_checks"] = {"case_id": representative["id"],
                                     "selection": "Lexicographically first experiment id; central hypothesis.",
                                     "runs": checks}
    report["aggregate"] = _aggregate(report)
    all_runs = [r for c in report["cases"] for r in c["simulations"]]
    report["numerical_checks"] = {
        "simulations": len(all_runs) + len(checks), "scenario_simulations": len(all_runs),
        "approximation_simulations": len(checks),
        "invalid_simulations": 0,
        "incomplete_scenario_simulations": sum(not r["observables"]["complete_record_window"] for r in all_runs),
        "max_abs_hydraulic_volume_balance_error": max(abs(r["observables"]["hydraulic_volume_balance_error"]) for r in all_runs + checks),
        "max_abs_solute_mass_balance_error": max(abs(r["observables"]["solute_mass_balance_error"]) for r in all_runs + checks)}
    return report


def _fmt_range(row: dict[str, Any], digits: int = 2) -> str:
    if row["min"] is None:
        return "not reached / unavailable"
    out = f'{row["min"]:.{digits}f}–{row["max"]:.{digits}f}'
    if row["missing"]:
        out += f' ({row["missing"]} unavailable)'
    return out


def render_markdown(report: dict[str, Any]) -> str:
    """Aggregate-only Markdown: no raw traces, profiles, names, or per-shot source tables."""
    lines = ["# Community comparison: Gagné 2021", "",
             "**Exploratory conditional simulations; no parameters fitted and no validation gates scored.**", "",
             "Ranges span the shots within a grinder group and a stated hypothesis. They are descriptive ranges, not uncertainty intervals.", "",
             "| Group | Shots | Logged 0.5 g crossing (s) | Logged bloom gain (g) | Logged target inlet (mL) | Estimated inlet (mL) | Last logged cup mass (g) |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for group, a in report["aggregate"].items():
        lines.append(f'| {group} | {a["shots"]} | {_fmt_range(a["observed_threshold_0_5g_s"])} | {_fmt_range(a["observed_bloom_mass_gain_g"])} | {_fmt_range(a["target_bloom_inlet_ml"])} | {_fmt_range(a["estimated_bloom_inlet_ml"])} | {_fmt_range(a["observed_final_logged_mass_g"])} |')
    lines += ["", "The bloom interval is the sampled positive minimum-flow-goal plateau, excluding its transitions. Estimated inlet flow is firmware-derived; it is not an independent flowmeter measurement. Mass and volume are distinct quantities.", "",
              "| Group / mode | PSD scale / headspace (mL) | Completed / runs | Model 0.5 g crossing (s) | Model bloom gain (g) | Model mass at record end (g) | Pressure RMSE (bar) |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for group, a in report["aggregate"].items():
        for x in a["scenarios"]:
            mode = x["mode"]
            lines.append(f'| {group} / {mode} | {x["psd_scale"]:g} / {x["headspace_ml"]:g} | {x["complete"]}/{x["runs"]} | {_fmt_range(x["threshold_0_5g_s"])} | {_fmt_range(x["bloom_mass_gain_g"])} | {_fmt_range(x["mass_at_record_end_g"])} | {_fmt_range(x["pressure_rmse_bar"])} |')
    lines += ["", "Pressure replay uses observed pressure as an input; its apparent pressure agreement is not a prediction. Required inlet delivery, headspace filling and the pump cap can prevent exact pressure tracking. The positive-floor and zero-command probes use control targets, not estimated inlet observations.", "", "## Fixed assumptions", "",
              "Two particle diameters 40/400 µm at volume fractions 0.3/0.7, scaled together by 0.5/1/2; headspace 0/10/30 mL. The same nine scenarios apply to both grinder groups. Command probes use scale 1 and 10 mL. None is selected as a best fit.", "",
              "Actual dose is supplied by the log. Basket diameter 58 mm, perforated diameter 54 mm, constant inlet 92 °C, ideal pump limits 8 mL/s and 12 bar; remaining bean/preparation/thermal properties retain builder defaults. Stop at the record's last timestamp, with no post-record drip. Thus these are conditional scenarios, not matched reconstructions.", "", "## Limitations", ""]
    lines += [f"- {s}" for s in report["limitations"]]
    lines += ["", "## Approximation checks", "",
              f'Case `{report["approximation_checks"]["case_id"]}`, chosen by experiment id, uses the central hypothesis. No parameter changes or response-based selection occur.', "",
              "| Phase budget | Actual phases | Maximum step (s) | Input interpolation error (bar) | 0.5 g crossing (s) | Record-end mass (g) |",
              "|---|---:|---:|---:|---:|---:|"]
    for check in report["approximation_checks"]["runs"]:
        x = check["observables"]
        crossing = x["thresholds"][0]["time_s"]
        crossing_text = "not reached" if crossing is None else f"{crossing:.4f}"
        mass = x["mass_at_record_end_g"]
        mass_text = "unavailable" if mass is None else f"{mass:.4f}"
        lines.append(f'| {check["phase_budget"]} | {check["phases"]} | {check["max_dt_s"]:g} | {check["input_max_abs_interpolation_error_bar"]:.5f} | {crossing_text} | {mass_text} |')
    checks = report["numerical_checks"]
    lines += ["", f'Numerical checks: {checks["simulations"]} simulations; {checks["invalid_simulations"]} invalid and {checks["incomplete_scenario_simulations"]} incomplete scenario runs. Invalid input or failed simulations stop report generation rather than being silently omitted. Worst absolute relative hydraulic volume residual {checks["max_abs_hydraulic_volume_balance_error"]:.3g}; solute mass residual {checks["max_abs_solute_mass_balance_error"]:.3g}. This is a hydraulic carrier-volume check, not exact solvent mass accounting; numerical conservation does not establish experimental accuracy.', "",
              "## Reproduction identity", "",
              f'Solver: `{report["solver"]["puckcore_version"]}`, extension `{report["solver"].get("extension_sha256", "unavailable")}`; tier {report["tier"]}.', "",
              f'Analysis module SHA-256: `{report["analysis_sha256"]}`.', "",
              f'Case-helper module SHA-256: `{report["case_helpers_sha256"]}`.', "",
              f'Unchanged v2 calibration SHA-256: `{report["calibration"]["sha256"]}`.', ""]
    source = report["sources"]
    lines.append(f'[Original experiment]({source["article_url"]}). Raw files remain local; source qualification does not grant redistribution rights.')
    for key in ("archive", "measurement_log"):
        item = source[key]
        lines += ["", f'[{key.replace("_", " ")}]({item["url"]}): SHA-256 `{item["sha256"]}`.']
    for name, digest in report["source_tools_sha256"].items():
        lines += ["", f'Source parser `{name}` SHA-256: `{digest}`.']
    lines.append("")
    return "\n".join(lines)


# Scratch prototype compatibility; the CLI and published summary use render_markdown.
render_summary = render_markdown


def write_report(report: dict[str, Any], output_dir: Path | str) -> dict[str, Path]:
    from .sources.gagne2021 import ensure_local_output

    destination = ensure_local_output(Path(output_dir))
    destination.mkdir(parents=True, exist_ok=True)
    json_path = destination / "community-comparison.json"
    markdown_path = destination / "community-comparison.md"
    for target, content in ((json_path, json.dumps(report, indent=2, allow_nan=False) + "\n"),
                            (markdown_path, render_markdown(report))):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=destination, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(content)
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {"json": json_path, "markdown": markdown_path}
