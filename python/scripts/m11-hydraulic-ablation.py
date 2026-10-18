# SPDX-License-Identifier: GPL-2.0-or-later
"""Separate viscosity and wet-age feedback in the mesh-sensitive pressure windows.

These are frozen-coefficient mechanism probes, not alternative calibrations.
Every input, solver identity and complete native result is retained. The
conductance reconstruction uses the core's existing poroelastic and outlet laws.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from scipy.optimize import brentq

from puckworks_tools.identity import solver_identity
from puckworks_tools.paths import RepoPaths, find_repo_root


def mesh_helpers():
    source = importlib.util.spec_from_file_location(
        "mesh_helpers", Path(__file__).with_name("m11-mesh-refinement.py"))
    module = importlib.util.module_from_spec(source)
    source.loader.exec_module(module)
    return module


def run_one(task):
    folder, identity, experiment, mechanism, spec = task
    cached = mesh_helpers().run_cached(folder / "runs", identity, spec)
    result = cached["result"]
    if "error" in result or result["summary"]["stop_reason"] != "time":
        raise RuntimeError(f"failed {experiment}/{mechanism}: {result.get('error')}")
    series = result["series"]
    switch = next(t for t, p in zip(series["t_s"], series["pressure_pa"]) if p >= 2.5e5)
    ramp_end = switch + spec["machine"]["phases"][1]["ramp_s"]
    keep = [i for i, t in enumerate(series["t_s"]) if ramp_end <= t < 15]
    row = {"experiment": experiment, "mechanism": mechanism, "spec": spec,
            "spec_sha256": cached["spec_sha256"], "wall_s": cached["wall_s"],
            "switch_s": switch, "ramp_end_s": ramp_end,
            "pour_peak_bar": max(series["pressure_pa"][i] for i in keep) / 1e5,
            "summary": result["summary"], "diagnostics": result["diagnostics"],
            "series": {key: series[key] for key in (
                "t_s", "pressure_pa", "flow_in_m3_s", "flow_out_m3_s", "wetted_fraction")}}
    row["hydraulic_diagnostics"] = reconstruct_capacity(spec, row["series"], switch)
    return row


def reconstruct_capacity(spec, series, switch):
    """Recover both parallel conductances from actual inlet/outlet flows.

    This is exact for the recorded noncompliant ideal-pump cases, subject to
    floating-point error. It is undefined during headspace filling (P=0).
    """
    assert spec["machine"]["hydraulic_compliance_m3_pa"] == 0
    assert spec["basket"]["outlet"]["type"] == "holes"
    temp = spec["thermal"]["water_temp_c"]
    rho = (999.83952 + temp * (16.945176 + temp * (-7.9870401e-3 + temp *
           (-46.170461e-6 + temp * (105.56302e-9 - temp * 280.54253e-12))))) / (1 + 16.879850e-3 * temp)
    basket = spec["basket"]
    area = basket["open_area_fraction"] * math.pi * basket["perforated_radius_m"] ** 2
    outlet = rho / (2 * .61 ** 2 * area ** 2) if basket["open_area_fraction"] < 1 else 0
    pc = spec["hydraulics"]["poroelastic_pc_pa"]

    def phi(pressure):
        if pressure <= 0:
            return 0
        x = min(pressure / pc, 1)
        return pc * x * (1 - 1.5*x + x*x - .25*x*x*x)

    cap = spec["machine"]["pump"]["max_pressure_pa"]
    rows = {"conductance_m3_pa_s": [], "capacity_at_cap_m3_s": [],
            "command_m3_s": [], "command_over_capacity": []}
    phase0, phase1 = spec["machine"]["phases"]
    for t, p, qin, qout in zip(series["t_s"], series["pressure_pa"],
                              series["flow_in_m3_s"], series["flow_out_m3_s"]):
        blend = min(max((t - switch) / phase1["ramp_s"], 0), 1)
        command = ((1-blend)*phase0["control"]["target_m3_s"] +
                   blend*phase1["control"]["target_m3_s"])
        rows["command_m3_s"].append(command)
        if p <= 0 or t >= 15:
            for key in ("conductance_m3_pa_s", "capacity_at_cap_m3_s", "command_over_capacity"):
                rows[key].append(None)
            continue
        wet = max(qin - qout, 0) / phi(p)
        through = qout / phi(p - outlet*qout*qout) if qout > 0 else 0
        upper = through * phi(cap)
        qcap = (brentq(lambda q: q - through*phi(cap-outlet*q*q), 0, upper,
                       xtol=1e-18) if upper > 0 else 0) + wet * phi(cap)
        rows["conductance_m3_pa_s"].append(wet + through)
        rows["capacity_at_cap_m3_s"].append(qcap)
        rows["command_over_capacity"].append(command/qcap)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path(".local/hydraulic-ablation"))
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    paths = RepoPaths(find_repo_root())
    study = json.loads(args.study.read_text())
    identity = {"solver": solver_identity(paths),
                "source_study_sha256": hashlib.sha256(args.study.read_bytes()).hexdigest(),
                "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    report = {"schema": "puckworks.hydraulic-ablation/1", "identity": identity,
              "protocol": {"coefficients": "frozen v5", "window_s": 15,
                           "output_interval_s": .1, "no_refit": True,
                           "ablations_are_not_proposed_physical_parameters": True},
              "rows": [], "complete": False}
    tasks = []
    for experiment in (2, 13):
        for mechanism in ("original", "no_viscosity_feedback", "no_pore_air", "neither"):
            for depth, dt in ((30, .00625), (150, .0125), (300, .00625)):
                spec = copy.deepcopy(study["inputs"][f"schmieder2023/exp{experiment:02d}"]["spec"])
                spec["numerics"].update(depth_cells=depth, max_dt_s=dt, max_duration_s=16,
                                        snapshot_count=1)
                spec["machine"]["stop"].update(time_s=15, beverage_mass_kg=None, drip_tau_s=0)
                if mechanism in ("no_viscosity_feedback", "neither"):
                    spec["hydraulics"]["viscosity"]["temperature_exponent"] = 0
                if mechanism in ("no_pore_air", "neither"):
                    spec["hydraulics"]["pore_air"]["amplitude"] = 0
                tasks.append((args.output_dir, identity, experiment, mechanism, spec))
    helper = mesh_helpers()
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        for row in pool.map(run_one, tasks):
            report["rows"].append(row)
            helper.write_json(args.output_dir / "ablation.json", report)
            print(f"exp{row['experiment']} {row['mechanism']} "
                  f"{row['spec']['numerics']['depth_cells']}: "
                  f"{row['pour_peak_bar']:.6f} bar", flush=True)
    if identity["solver"] != solver_identity(paths):
        raise RuntimeError("solver changed during ablations")
    report["comparisons"] = []
    times = np.arange(8.5, 12.50001, .001)
    for experiment in (2, 13):
        for mechanism in ("original", "no_viscosity_feedback", "no_pore_air", "neither"):
            selected = [r for r in report["rows"] if r["experiment"] == experiment
                        and r["mechanism"] == mechanism]
            reference = selected[-1]
            for row in selected[:-1]:
                metrics = {}
                for key, source in (("pressure_pa", "series"),
                                    ("conductance_m3_pa_s", "hydraulic_diagnostics"),
                                    ("capacity_at_cap_m3_s", "hydraulic_diagnostics")):
                    a, b = [np.interp(times, r["series"]["t_s"], np.asarray(r[source][key], dtype=float))
                            for r in (row, reference)]
                    if not np.all(np.isfinite(a)) or not np.all(np.isfinite(b)):
                        raise RuntimeError("comparison window includes undefined capacity")
                    metrics[key] = {"max_absolute_difference": float(np.max(abs(a-b))),
                                    "max_relative_difference": float(np.max(abs(a/b-1)))}
                report["comparisons"].append({"experiment": experiment, "mechanism": mechanism,
                    "depth_cells": row["spec"]["numerics"]["depth_cells"],
                    "reference_depth_cells": 300, "window_s": [8.5, 12.5], "metrics": metrics})
    report["complete"] = True
    helper.write_json(args.output_dir / "ablation.json", report)


if __name__ == "__main__":
    main()
