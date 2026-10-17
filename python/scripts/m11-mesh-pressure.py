# SPDX-License-Identifier: GPL-2.0-or-later
"""Resolve the two grid-sensitive pour-pressure transients over their first 15 s.

  .venv/bin/python python/scripts/m11-mesh-pressure.py \
    --study .local/mesh-refinement/mesh-refinement.json

All species and physical inputs are retained. Only the stop is moved to 15 s
and the subsequent drip disabled, allowing smaller timesteps within the existing
work bound. Available full-shot prefixes must match exactly before using this
short window. These are pressure diagnostics, not completed calibration shots.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

from puckworks_tools.cases import schmieder2023 as sch
from puckworks_tools.identity import solver_identity
from puckworks_tools.paths import RepoPaths, find_repo_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", type=Path, required=True)
    args = parser.parse_args()
    study = json.loads(args.study.read_text())
    if not study["complete"]:
        raise ValueError("finish the full mesh study first")
    module_spec = importlib.util.spec_from_file_location("mesh_study", Path(__file__).with_name("m11-mesh-refinement.py"))
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    paths = RepoPaths(find_repo_root())
    identity = copy.deepcopy(study["identity"])
    if solver_identity(paths) != identity["solver"]:
        raise ValueError("use the exact solver build of the main study")
    identity["script_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    folder = args.study.parent
    report = {"schema": "puckworks.mesh-pressure-window/1", "identity": identity,
              "full_study_sha256": hashlib.sha256(args.study.read_bytes()).hexdigest(),
              "protocol": {"window_s": 15, "drip_tau_s": 0, "max_duration_s": 16,
                           "unchanged_physical_parameters_and_species": True,
                           "output_interval_s": .1, "full_shot_prefix_check_before_s": 14.8},
              "rows": [], "complete": False}
    settings = ((30, .05, "baseline"), (150, .05, "depth_5x"), (300, .05, "depth_10x"),
                (300, .025, "depth_10x_half_dt"), (300, .0125, None), (300, .00625, None),
                (300, .003125, None), (600, .00625, None))
    for experiment in (2, 13):
        name = f"schmieder2023/exp{experiment:02d}"
        base = study["inputs"][name]["spec"]
        for depth, dt, reference in settings:
            spec = copy.deepcopy(base)
            spec["numerics"].update(depth_cells=depth, max_dt_s=dt, max_duration_s=16)
            spec["machine"]["stop"].update(time_s=15, beverage_mass_kg=None, drip_tau_s=0)
            cached = module.run_cached(folder / "pressure-runs", identity, spec)
            result = cached["result"]
            if "error" in result or result["summary"]["stop_reason"] != "time":
                raise RuntimeError(f"pressure window failed: {name}/{depth}/{dt}: {result.get('error')}")
            series = result["series"]
            checked = None
            if reference:
                full_spec = copy.deepcopy(base)
                full_spec["numerics"].update(depth_cells=depth, max_dt_s=dt)
                full = module.run_cached(folder / "runs", study["identity"], full_spec)["result"]
                inds = [i for i, t in enumerate(series["t_s"]) if t < 14.8]
                count = len(inds)
                for field in ("t_s", "pressure_pa", "flow_out_m3_s", "beverage_mass_kg", "ey"):
                    if [series[field][i] for i in inds] != full["series"][field][:count]:
                        raise RuntimeError(f"truncation changes the full-shot prefix: {name}/{depth}/{dt}/{field}")
                checked = {"reference_variant": reference, "samples": count, "five_channels_exact": True}
            switch = next(t for t, p in zip(series["t_s"], series["pressure_pa"])
                          if p >= sch.PREINFUSION_EXIT_BAR * 1e5)
            ramp_end = switch + study["inputs"][name]["info"]["transition_ramp_s"]
            peak = max(p for t, p in zip(series["t_s"], series["pressure_pa"]) if t >= ramp_end) / 1e5
            if reference:
                full_row = next(r for r in study["variants"][reference]["rows"] if r["case"] == name)
                if peak != full_row["observations"]["pour_peak_pressure_bar"]:
                    raise RuntimeError("15 s window does not contain the full-shot pour peak")
            record = {"case": name, "experiment": experiment, "depth_cells": depth, "max_dt_s": dt,
                      "spec": spec, "wall_s": cached["wall_s"], "prefix_check": checked,
                      "pour_peak_pressure_bar": peak, "switch_s": switch, "ramp_end_s": ramp_end,
                      "summary": result["summary"], "diagnostics": result["diagnostics"],
                      "series": {key: series[key] for key in ("t_s", "pressure_pa", "flow_out_m3_s", "beverage_mass_kg")}}
            report["rows"].append(record)
            module.write_json(folder / "mesh-pressure-window.json", report)
            print(f"exp{experiment}, {depth} layers, dt {dt:g}: pour peak {peak:.6f} bar, "
                  f"{cached['wall_s']:.3f} s wall", flush=True)
    for experiment in (2, 13):
        selected = [r for r in report["rows"] if r["experiment"] == experiment]
        fine = next(r for r in selected if r["depth_cells"] == 300 and r["max_dt_s"] == .003125)
        # Common absolute times retain phase-timing differences. Exclude the pump stop.
        t = np.arange(8.5, 12.50001, .001)
        p = np.interp(t, fine["series"]["t_s"], fine["series"]["pressure_pa"]) / 1e5
        for r in selected:
            q = np.interp(t, r["series"]["t_s"], r["series"]["pressure_pa"]) / 1e5
            r["max_pressure_trace_difference_bar"] = float(np.max(np.abs(p - q)))
    if solver_identity(paths) != identity["solver"]:
        raise RuntimeError("solver identity changed during pressure windows")
    report["complete"] = True
    module.write_json(folder / "mesh-pressure-window.json", report)


if __name__ == "__main__":
    main()
