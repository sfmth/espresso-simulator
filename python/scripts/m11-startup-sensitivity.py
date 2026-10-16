# SPDX-License-Identifier: GPL-2.0-or-later
"""Supplemental fixed-parameter startup ablations; run after the v2 calibration is embedded.

From the repository root: ``.venv/bin/python python/scripts/m11-startup-sensitivity.py``.
Writes docs/validation/m11-startup-sensitivity.json; no parameters are fitted.
"""
from __future__ import annotations

import copy
import json

import puckcore
from puckworks_tools.calibrate import build_problem, calibrated_values, load_calibration_document, load_config
from puckworks_tools.cases import waszkiewicz2026 as wz
from puckworks_tools.identity import file_sha256, solver_identity
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.validate import _calibration_x, _jsonable, generic_recipe, v4_transient_metrics

paths = RepoPaths(find_repo_root())
config = load_config(paths.root / "data/calibration/config.yaml")
calibration = load_calibration_document(paths.root / "data/calibration/v2.yaml")
assert calibration.get("label") == "v2", "v2 fit must finish first"
# Build the complete parameter set so the V4 spec explicitly receives the fitted extraction
# parameters too, exactly as validation does. Only the selected V4 shot is simulated below.
problem = build_problem(paths, config, tier=1)
try:
    values = problem.values(_calibration_x(problem, calibrated_values(calibration)))
    block = next(block for block in problem.blocks if block.name == "V4")
    case = next(c for c in block.cases if c.info["group"] == wz.TRANSIENT_GROUP)
    base_v4 = block.spec_for(case, values, problem.params)
    recipe = generic_recipe("mahlkoenig-ek43", 1.7, calibration["parameters"], 1)
    base_generic = puckcore.build_shot_spec(recipe)["spec"]
    base_generic["numerics"]["snapshot_count"] = 1
    variants = [
        ("M1.1 default", {}),
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
            row[key] = {"summary": result["summary"], "diagnostics": result["diagnostics"],
                        "startup": {key: spec["hydraulics"][key] for key in (
                            "intraparticle_water_fraction", "pore_air", "pore_air_permeability_exponent")}}
            if key == "v4_9bar":
                observed = wz.observe(case, result)
                row[key]["transient"] = v4_transient_metrics(case, observed)
                row[key]["first_tds_percent"] = observed["tds_fractions"][0]["tds_percent"]
            else:
                row[key]["time_to_36g_s"] = wz.time_to_mass(result, 36.0)
        rows.append(row)
    output = {"schema": "puckworks.startup-sensitivity/1", "calibration": "data/calibration/v2.yaml",
              "calibration_sha256": file_sha256(paths.root / "data/calibration/v2.yaml"),
              "script_sha256": file_sha256(paths.root / "python/scripts/m11-startup-sensitivity.py"),
              "solver": solver_identity(paths), "tier": 1, "refitted": False,
              "purpose": "Response to fixed-parameter closure changes; does not select priors or demonstrate experimental identification.",
              "baseline_note": "All variants retain the v2 fit and M1.1 core. The half-inventory/disabled-air variant is not the archived v1 model.",
              "v4_spec": base_v4, "generic_recipe": recipe, "rows": rows}
    destination = paths.validation_dir / "m11-startup-sensitivity.json"
    destination.write_text(json.dumps(_jsonable(output), indent=2, allow_nan=False) + "\n")
    print(destination)
    for row in rows:
        metrics = row["v4_9bar"]["transient"]
        print(row["variant"], {"drops_s": metrics["drops_model_s"], "rise_s": metrics["rise_model"]["t90_s"],
                               "time_to_36g_s": metrics["time_to_mass_model_s"],
                               "generic_time_s": row["generic_18_to_36g"]["summary"]["shot_time_s"]})
finally:
    problem.runner.close()
