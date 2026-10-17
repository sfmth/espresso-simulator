# SPDX-License-Identifier: GPL-2.0-or-later
"""Training-only review of the pore-air closure, conditional on a preserved calibration.

Writes configurations for matched baseline/connectivity refits, local Jacobian diagnostics,
a conditional training-cost grid, and a timestep probe of Schmieder experiment 13.
Does not fit or export any coefficients.
See docs/validation/m11-startup-identification.md for the separate bounded-refit commands.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np

from puckworks_tools.calibrate import (
    apply_start_values, build_problem, calibrated_values, datasets_for_block, dump_document,
    load_calibration_document, observe, uncertainties,
)
from puckworks_tools.identity import file_sha256, input_hashes, solver_identity
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.validate import _jsonable


STARTUP_IDS = (
    "model.hydraulics.pore_air_amplitude",
    "model.hydraulics.pore_air_permeability_exponent",
    "model.hydraulics.moisture_diffusivity",
)
TRAINING_BLOCKS = ("V1", "V2", "V4", "V6")


def extend_config(baseline, ids):
    config = copy.deepcopy(baseline)
    config["fixed"] = [entry for entry in config["fixed"] if entry.get("id") not in ids]
    config["parameters"] = [entry for entry in config["parameters"] if entry["id"] not in ids]
    config["parameters"].extend({
        "id": rid, "mode": "override", "blocks": list(TRAINING_BLOCKS),
        "scale": "log" if rid.endswith("diffusivity") else "linear",
    } for rid in ids)
    return config


def write_json(path, value):
    path.write_text(json.dumps(_jsonable(value), indent=2, allow_nan=False) + "\n")


def local_diagnostics(problem, output_dir):
    x = problem.x0()
    residuals = problem.residuals(x)
    ids = [parameter.id for parameter in problem.params]
    prior_scales = np.array([parameter.prior_sd_x for parameter in problem.params])
    rows = []
    for step in (0.01, 0.005):
        problem.fd_step = step
        jacobian = problem.jacobian(x)
        uncertainty = uncertainties(problem, x, jacobian, residuals)
        scaled = jacobian * prior_scales
        startup = {}
        for rid in STARTUP_IDS:
            j = ids.index(rid)
            other = np.delete(jacobian, j, axis=1)
            projected = jacobian[:, j] - other @ np.linalg.lstsq(other, jacobian[:, j], rcond=1e-10)[0]
            correlation = uncertainty["correlation"]["matrix"][j]
            strongest = sorted(((ids[k], c) for k, c in enumerate(correlation) if k != j),
                               key=lambda item: abs(item[1]), reverse=True)[:5]
            startup[rid] = {
                **uncertainty["parameters"][rid], "value": problem.params[j].from_x(x[j]),
                "norm_per_prior_sd": float(np.linalg.norm(scaled[:, j])),
                "norm_after_other_parameters_per_prior_sd": float(np.linalg.norm(projected) * prior_scales[j]),
                "strongest_correlations": strongest,
            }
        rows.append({"fd_step": step, "cost": 0.5 * float(residuals @ residuals),
                     "prior_scaled_singular_values": np.linalg.svd(scaled, compute_uv=False).tolist(),
                     "startup": startup, "uncertainties": uncertainty,
                     "robustness": problem.runner.robustness()})
        np.savez_compressed(output_dir / f"jacobian-{step}.npz", jacobian=jacobian,
                            residuals=residuals, x=x, ids=ids)
        print(f"Jacobian step {step}: cost {rows[-1]['cost']:.6g}; "
              f"{problem.runner.simulations} simulations, {problem.runner.failed} failures", flush=True)
    return {"parameter_ids": ids, "values": problem.values(x),
            "residual_labels": problem.labels, "steps": rows}


def amplitude_grid(paths, baseline, document, jobs):
    problem = build_problem(paths, baseline, blocks=["V1"], jobs=jobs)
    block = problem.blocks[0]
    case = next(case for case in block.cases if case.info["experiment"] == 13)
    values = calibrated_values(document)
    base = block.spec_for(case, values, problem.params)
    amplitudes = (0.49, 0.495, 0.5, 0.502, 0.5045, 0.507, 0.509, 0.511, 0.515, 0.52)
    specs, settings = [], []
    for factor in (1.0, 0.5, 0.25):
        for amplitude in amplitudes:
            spec = copy.deepcopy(base)
            spec["hydraulics"]["pore_air"]["amplitude"] = amplitude
            spec["numerics"]["max_dt_s"] *= factor
            specs.append(spec)
            settings.append({"amplitude": amplitude, "dt_factor": factor,
                             "max_dt_s": spec["numerics"]["max_dt_s"]})
    try:
        rows = []
        for spec, result, row in zip(specs, problem.runner.run(specs), settings):
            if "error" in result:
                row["error"] = result["error"]
            else:
                observation = observe(block.module, case, result, spec)
                row.update({key: value for key, value in observation.items() if key != "fractions"})
                row["summary"] = result["summary"]
                row["diagnostics"] = result["diagnostics"]
            rows.append(row)
        return {"case": case.name, "case_info": case.info, "baseline_spec": base,
                "grid": rows, "robustness": problem.runner.robustness()}
    finally:
        problem.runner.close()


def training_grid(paths, baseline, document, jobs):
    config = extend_config(baseline, STARTUP_IDS[:2])
    problem = build_problem(paths, config, jobs=jobs)
    apply_start_values(problem, calibrated_values(document))
    ids = [parameter.id for parameter in problem.params]
    a, n = (ids.index(rid) for rid in STARTUP_IDS[:2])
    rows = []
    try:
        for amplitude in (0.0, 0.225, 0.45, 0.5, 0.675, 0.9):
            for exponent in (2.0, 3.0, 5.0):
                x = problem.x0()
                x[a], x[n] = amplitude, exponent
                residuals = problem.residuals(x)
                evaluations = problem.evaluations(x)
                row = {"amplitude": amplitude, "exponent": exponent,
                       "cost": 0.5 * float(residuals @ residuals),
                       "block_costs": {block.name: 0.5 * float(ev.residuals @ ev.residuals)
                                       for block, ev in zip(problem.blocks, evaluations)},
                       "failures": [failure for ev in evaluations for failure in ev.failures]}
                rows.append(row)
                print(f"Training grid A={amplitude:g}, n={exponent:g}: cost {row['cost']:.6g}; "
                      f"{len(row['failures'])} unavailable cases", flush=True)
        return {"refitted": False, "held_out_used": False, "grid": rows,
                "interpretation": "Conditional costs with all other fitted values held fixed; "
                "not profile likelihoods or confidence limits.",
                "robustness": problem.runner.robustness()}
    finally:
        problem.runner.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, default=Path("data/calibration/v4.yaml"))
    parser.add_argument("--output-dir", type=Path, default=Path(".local/startup-identification"))
    parser.add_argument("--jobs", type=int, default=8)
    parser.add_argument("--prepare-only", action="store_true", help="write refit configurations without simulations")
    args = parser.parse_args(argv)
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    paths = RepoPaths(find_repo_root())
    document = load_calibration_document(args.calibration)
    baseline = document["fit"]["effective_config"]
    if set(baseline["blocks"]) != set(TRAINING_BLOCKS):
        parser.error("this review requires exactly the original V1/V2/V4/V6 training blocks")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    configs = {"baseline": baseline, "connectivity": extend_config(baseline, STARTUP_IDS[:2]),
               "diagnostic": extend_config(baseline, STARTUP_IDS)}
    for name, config in configs.items():
        (args.output_dir / f"{name}-config.yaml").write_text(dump_document(config))
    if args.prepare_only:
        return 0
    config_path = args.output_dir / "diagnostic-config.yaml"
    problem = build_problem(paths, configs["diagnostic"], jobs=args.jobs)
    datasets = sorted({name for block in problem.blocks for name in datasets_for_block(block)})
    solver = solver_identity(paths)
    inputs = input_hashes(paths, str(config_path), datasets)
    calibration_hash = file_sha256(args.calibration)
    try:
        apply_start_values(problem, calibrated_values(document))
        report = {"schema": "puckworks.startup-identification/1", "calibration": paths.relative(args.calibration),
                  "calibration_label": document["label"], "calibration_sha256": calibration_hash,
                  "solver": solver, "inputs": inputs, "script_sha256": file_sha256(Path(__file__)),
                  "refitted": False, "training_blocks": list(TRAINING_BLOCKS),
                  "held_out_used": False, "config": configs["diagnostic"],
                  "interpretation": "Local linear diagnostics conditional on this model and existing bounds; "
                  "not posterior uncertainty, a measured saturation law, or evidence of global identification.",
                  **local_diagnostics(problem, args.output_dir)}
        report["amplitude_grid"] = amplitude_grid(paths, baseline, document, args.jobs)
        report["training_grid"] = training_grid(paths, baseline, document, args.jobs)
        candidates = [row for row in report["training_grid"]["grid"]
                      if not row["failures"] and (row["amplitude"], row["exponent"]) != (0.5, 3.0)]
        if candidates:
            selected = min(candidates, key=lambda row: row["cost"])
            grid_start = copy.deepcopy(configs["connectivity"])
            for entry in grid_start["parameters"]:
                if entry["id"] == STARTUP_IDS[0]:
                    entry["start"] = selected["amplitude"]
                elif entry["id"] == STARTUP_IDS[1]:
                    entry["start"] = selected["exponent"]
            (args.output_dir / "connectivity-grid-start-config.yaml").write_text(dump_document(grid_start))
            report["training_grid"]["nonbaseline_restart"] = selected
        if (solver != solver_identity(paths) or inputs != input_hashes(paths, str(config_path), datasets)
                or calibration_hash != file_sha256(args.calibration)):
            raise RuntimeError("solver or calibration inputs changed during the review")
        output = args.output_dir / "m11-startup-identification.json"
        write_json(output, report)
        print(output)
        return 0
    finally:
        problem.runner.close()


if __name__ == "__main__":
    raise SystemExit(main())
