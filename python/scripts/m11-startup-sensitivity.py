# SPDX-License-Identifier: GPL-2.0-or-later
"""Supplemental fixed-parameter startup ablations for the selected fit and current solver.

Run after calibration with .venv/bin/python python/scripts/m11-startup-sensitivity.py.
Writes a calibration-labelled JSON report; the archived unlabelled 0.3.0 report is preserved.
No parameters are fitted and these variants do not select priors.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import puckcore
from puckworks_tools.calibrate import build_problem, calibrated_values, datasets_for_block, load_calibration_document, load_config
from puckworks_tools.cases import waszkiewicz2026 as wz
from puckworks_tools.identity import file_sha256, input_hashes, solver_identity
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.validate import _calibration_x, _jsonable, generic_recipe, v4_transient_metrics


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, default=Path("data/calibration/current.yaml"))
    parser.add_argument("--config", type=Path, default=Path("data/calibration/config.yaml"))
    parser.add_argument("--output-dir", type=Path, default=Path("docs/validation"))
    args = parser.parse_args(argv)
    paths = RepoPaths(find_repo_root())
    config = load_config(args.config)
    calibration = load_calibration_document(args.calibration)
    if not calibration.get("label"):
        parser.error("a labelled calibration document is required")
    label = calibration["label"]
    if not isinstance(label, str) or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in label):
        parser.error("the calibration label must contain only letters, digits, hyphens or underscores")
    solver = solver_identity(paths)
    # Use every fitted extraction parameter for the V4 spec, exactly as validation does.
    problem = build_problem(paths, config, tier=1)
    try:
        datasets = sorted({name for block in problem.blocks for name in datasets_for_block(block)})
        inputs = input_hashes(paths, str(args.config), datasets)
        values = problem.values(_calibration_x(problem, calibrated_values(calibration)))
        block = next(block for block in problem.blocks if block.name == "V4")
        case = next(c for c in block.cases if c.info["group"] == wz.TRANSIENT_GROUP)
        base_v4 = block.spec_for(case, values, problem.params)
        recipe = generic_recipe("mahlkoenig-ek43", 1.7, calibration["parameters"], 1)
        base_generic = puckcore.build_shot_spec(recipe)["spec"]
        base_generic["numerics"]["snapshot_count"] = 1
        variants = [
            (f"{label} baseline", {}),
            ("Pore-air closure disabled", {"air_amplitude": 0.0}),
            ("Half intraparticle water inventory", {"water_fraction": 0.5}),
            ("Half inventory and pore-air disabled", {"water_fraction": 0.5, "air_amplitude": 0.0}),
        ]
        rows = []
        for name, change in variants:
            row = {"variant": name, "changes": change}
            for key, base in (("v4_9bar", base_v4), ("generic_18_to_36g", base_generic)):
                spec = copy.deepcopy(base)
                if "air_amplitude" in change:
                    spec["hydraulics"]["pore_air"]["amplitude"] = change["air_amplitude"]
                if "water_fraction" in change:
                    spec["hydraulics"]["intraparticle_water_fraction"] = change["water_fraction"]
                result = puckcore.simulate_shot(spec)
                row[key] = {"spec": spec, "summary": result["summary"], "diagnostics": result["diagnostics"],
                            "startup": {key: spec["hydraulics"][key] for key in (
                                "intraparticle_water_fraction", "pore_air", "pore_air_permeability_exponent")},
                            "kernel_loading_cap": spec["solubles"]["kernel_loading_cap"]}
                if key == "v4_9bar":
                    observed = wz.observe(case, result)
                    row[key]["transient"] = v4_transient_metrics(case, observed)
                    row[key]["first_tds_percent"] = observed["tds_fractions"][0]["tds_percent"]
                else:
                    row[key]["time_to_36g_s"] = wz.time_to_mass(result, 36.0)
            rows.append(row)
        if solver != solver_identity(paths) or inputs != input_hashes(paths, str(args.config), datasets):
            raise RuntimeError("solver or calibration inputs changed during startup ablations")
        output = {"schema": "puckworks.startup-sensitivity/1", "calibration": paths.relative(args.calibration),
                  "calibration_label": label, "calibration_sha256": file_sha256(args.calibration),
                  "script_sha256": file_sha256(Path(__file__)), "inputs": inputs,
                  "solver": solver, "tier": 1, "refitted": False,
                  "purpose": "Response to fixed-parameter closure changes; does not select priors or demonstrate experimental identification.",
                  "baseline_note": f"Every variant retains the {label} fitted coefficients and the recorded current solver. "
                  "The half-inventory/disabled-air variant does not restore an archived model. Full specs record "
                  "the kernel-loading-cap choice; these runs preserve the historical 0.3.0 startup report.",
                  "v1_particle_input": config["blocks"]["V1"].get("case_options", {}),
                  "v4_spec": base_v4, "generic_recipe": recipe, "rows": rows}
        args.output_dir.mkdir(parents=True, exist_ok=True)
        destination = args.output_dir / f"m11-startup-sensitivity-{label}.json"
        destination.write_text(json.dumps(_jsonable(output), indent=2, allow_nan=False) + "\n")
        print(destination)
        for row in rows:
            metrics = row["v4_9bar"]["transient"]
            print(row["variant"], {"drops_s": metrics["drops_model_s"], "rise_s": metrics["rise_model"]["t90_s"],
                                   "time_to_36g_s": metrics["time_to_mass_model_s"],
                                   "generic_time_s": row["generic_18_to_36g"]["summary"]["shot_time_s"]})
        return 0
    finally:
        problem.runner.close()


if __name__ == "__main__":
    raise SystemExit(main())
