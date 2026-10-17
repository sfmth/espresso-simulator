# SPDX-License-Identifier: GPL-2.0-or-later
"""All 15 V1 conditions at fixed final coefficients, max_dt .05 -> .025 s.

Run only after the final main/prune checkpoint is supplied. No fit or held-out
simulation is performed. Both complete input specs and observations are retained.

  .venv/bin/python python/scripts/m11-v1-resolution.py \
    --calibration data/calibration/v5.yaml --jobs 4 \
    --output .local/pressure-resolution/v1-resolution.json
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import inspect
import json
import math
import time
from pathlib import Path

from puckworks_tools.calibrate import (
    build_problem, calibrated_values, datasets_for_block, load_calibration_document,
    load_config, required_observations_available,
)
from puckworks_tools.cases import schmieder2023 as sch
from puckworks_tools.identity import input_hashes, solver_identity
from puckworks_tools.particle_inputs import record_case, summarize_scenario
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.validate import _calibration_x, _jsonable, calibration_reuse_issues


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def comparison(nominal, refined):
    rows = []
    for before, after in zip(nominal, refined):
        assert before["experiment"] == after["experiment"]
        for kind in ("lambda", "c0", "cup_eq3", "cup_direct"):
            for analyte, *_ in sch.ANALYTES:
                for mass in (sch.CUP_MASSES_G if kind.startswith("cup") else (None,)):
                    def value(row):
                        result = (row.get("observations") or {}).get(kind, {}).get(analyte)
                        return result.get(mass) if mass is not None and isinstance(result, dict) else result
                    a, b = value(before), value(after)
                    valid = (before["completed"] and after["completed"]
                             and isinstance(a, (int, float)) and isinstance(b, (int, float))
                             and math.isfinite(a) and math.isfinite(b) and a > 0)
                    rows.append({"experiment": before["experiment"], "analyte": analyte,
                                 "metric": kind, "cup_mass_g": mass,
                                 "nominal": a, "half_dt": b,
                                 "difference": b - a if valid else None,
                                 "relative_difference": b / a - 1.0 if valid else None})
    scalars = ("peak_pressure_bar", "pour_peak_pressure_bar", "switch_s", "beverage_g")
    for before, after in zip(nominal, refined):
        for kind in scalars:
            a, b = ((row.get("observations") or {}).get(kind) for row in (before, after))
            valid = (before["completed"] and after["completed"]
                     and isinstance(a, (int, float)) and isinstance(b, (int, float))
                     and math.isfinite(a) and math.isfinite(b) and a > 0)
            rows.append({"experiment": before["experiment"], "analyte": None,
                         "metric": kind, "cup_mass_g": None, "nominal": a, "half_dt": b,
                         "difference": b - a if valid else None,
                         "relative_difference": b / a - 1.0 if valid else None})
    summaries = {}
    for kind in ("lambda", "c0", "cup_eq3", "cup_direct", *scalars):
        selected = [row for row in rows if row["metric"] == kind]
        valid = [row for row in selected if row["relative_difference"] is not None]
        worst = max(valid, key=lambda row: abs(row["relative_difference"]), default=None)
        summaries[kind] = {"required": len(selected), "available": len(valid),
                           "max_abs_relative_difference": abs(worst["relative_difference"]) if worst else None,
                           "worst": worst}
    return {"metrics": summaries, "rows": rows}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", "--checkpoint", dest="checkpoint", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    paths = RepoPaths(find_repo_root())
    document = load_calibration_document(args.checkpoint)
    fit = document.get("fit") or {}
    if fit.get("pipeline", {}).get("stage") not in ("main-prune", "complete"):
        raise ValueError("use a completed calibration or its stable main-prune checkpoint")
    config_path = fit.get("config", "data/calibration/config.yaml")
    config = load_config(paths.root / config_path)
    problem = build_problem(paths, config, jobs=args.jobs)
    problem.runner.WORST_MAX = (*problem.runner.WORST_MAX, "hydraulic_volume_balance_error")
    started = time.monotonic()
    try:
        block = next(block for block in problem.blocks if block.name == "V1")
        if [case.info["experiment"] for case in block.cases] != list(range(1, 16)):
            raise ValueError("resolution check requires every V1 experiment, in source order")
        datasets = sorted({name for b in problem.blocks for name in datasets_for_block(b)})

        def identity():
            return {"solver": solver_identity(paths), "inputs": input_hashes(paths, config_path, datasets),
                    "checkpoint_sha256": sha256(args.checkpoint), "script_sha256": sha256(__file__),
                    "evaluation_helpers_sha256": hashlib.sha256("\n".join(inspect.getsource(fn) for fn in (
                        _calibration_x, required_observations_available, record_case, summarize_scenario
                    )).encode()).hexdigest()}

        before = identity()
        issues = calibration_reuse_issues(document, before["solver"], before["inputs"])
        if issues:
            raise ValueError("calibration differs from the current frozen build: " + "; ".join(issues))
        fitted = calibrated_values(document)
        values = problem.values(_calibration_x(problem, fitted, fixed=fit.get("fixed")))
        base_specs = [block.spec_for(case, values, problem.params) for case in block.cases]
        if any(spec["numerics"]["tier"] != 1 or spec["numerics"]["max_dt_s"] != .05 for spec in base_specs):
            raise ValueError("expected final tier 1 V1 specs at max_dt 0.05 s")
        targets = sch.targets(block.data)
        report = {"schema": "puckworks.v1-resolution/1", "calibration_label": document["label"],
                  "checkpoint": str(args.checkpoint), "identity_before": before,
                  "fitted_in_this_run": False, "held_out_used": False, "jobs": args.jobs,
                  "protocol": {"experiments": list(range(1, 16)), "max_dt_s": [.05, .025],
                               "output_interval_changed": False, "other_spec_fields_changed": False},
                  "applied_parameter_values": values, "recorded_fixed": fit.get("fixed"),
                  "recorded_fitted": fitted, "fit_optimizer": fit.get("optimizer"),
                  "variants": {}, "complete": False}
        for name, factor in (("nominal", 1.0), ("half_dt", .5)):
            specs = copy.deepcopy(base_specs)
            for spec in specs:
                spec["numerics"]["max_dt_s"] *= factor
            results = problem.runner.run(specs)
            rows = []
            for case, spec, result in zip(block.cases, specs, results):
                row = record_case(case, spec, result)
                if row["observations"] is not None and not required_observations_available(block, case, row["observations"]):
                    row["failure"] = "required fit observations, including c0, are unavailable"
                    row["completed"] = False
                rows.append(row)
            observations = [row["observations"] if row["completed"] else None for row in rows]
            residuals, labels = block.residual_fn(block, observations, values)
            residuals = math.sqrt(block.weight) * residuals
            summary = summarize_scenario(rows, targets)
            concentrations = [row["diagnostics"].get("min_concentration_kg_m3") for row in rows]
            summary["min_concentration_kg_m3"] = min(
                (v for v in concentrations if isinstance(v, (int, float)) and math.isfinite(v)), default=None)
            summary["cost"] = .5 * float(residuals @ residuals)
            report["variants"][name] = {"rows": rows, "summary": summary,
                                        "residuals": dict(zip(labels, map(float, residuals)))}
            after = identity()
            report["identity_after"] = after
            report["unchanged_identity"] = after == before
            report["elapsed_s"] = time.monotonic() - started
            report["robustness"] = problem.runner.robustness()
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(_jsonable(report), indent=2, allow_nan=False) + "\n")
            if after != before:
                raise RuntimeError("solver, input, checkpoint or evaluation code changed during resolution check")
            print(name, {"completed": summary["completed"], "cost": summary["cost"],
                         "lambda_within": summary["score"]["lambda_within"],
                         "cup_within": summary["score"]["cup_within"]}, flush=True)
        nominal, refined = (report["variants"][name] for name in ("nominal", "half_dt"))
        report["comparison"] = comparison(nominal["rows"], refined["rows"])
        report["complete"] = all(v["summary"]["completed"] == 15 and not v["summary"]["failures"]
                                 for v in report["variants"].values())
        report["elapsed_s"] = time.monotonic() - started
        args.output.write_text(json.dumps(_jsonable(report), indent=2, allow_nan=False) + "\n")
        print(json.dumps(report["comparison"]["metrics"], indent=2, allow_nan=False), flush=True)
        print(args.output, flush=True)
        return 0 if report["complete"] else 1
    finally:
        problem.runner.close()


if __name__ == "__main__":
    raise SystemExit(main())
