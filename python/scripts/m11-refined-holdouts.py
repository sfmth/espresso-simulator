# SPDX-License-Identifier: GPL-2.0-or-later
"""Frozen baseline/candidate holdouts at the default, 5x and 10x depth grids."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from puckworks_tools.calibrate import (
    DatasetBlock, apply_start_values, build_problem, calibrated_values,
    load_calibration_document, load_config,
)
from puckworks_tools.cases import cameron2020 as cam, smrke2024 as smr, waszkiewicz2026 as wz
from puckworks_tools.identity import file_sha256, input_hashes, solver_identity
from puckworks_tools.particle_inputs import strict_data
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.validate import check_v3, check_v4_transient, check_v5, shared_overrides


def write(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(strict_data(report), indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=Path("data/calibration/v5.yaml"))
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=16)
    args = parser.parse_args()
    paths = RepoPaths(find_repo_root())
    config = load_config(args.config)
    datasets = sorted(set(cam.DATASETS + smr.DATASETS + wz.DATASETS))

    def identity():
        return {"solver": solver_identity(paths),
                "inputs": input_hashes(paths, str(args.config), datasets),
                "baseline_sha256": file_sha256(args.baseline),
                "candidate_sha256": file_sha256(args.candidate),
                "script_sha256": file_sha256(Path(__file__)),
                "validation_source_sha256": file_sha256(paths.root / "python/puckworks_tools/validate.py")}

    report = {"schema": "puckworks.refined-holdouts/1", "identity": identity(),
              "used_to_select_parameters": False, "config": config, "rows": [], "complete": False,
              "protocol": "Freeze both coefficient sets before evaluating any holdout. "
              "Original cases, clocks and scoring thresholds; only depth, timestep and unused "
              "hard-stop budget change. Require completed requested stops on every grid."}
    for label, path in (("frozen_v5", args.baseline), ("candidate", args.candidate)):
        document = load_calibration_document(path)
        values = calibrated_values(document)
        for depth, dt in ((30, .05), (150, .025), (300, .025)):
            fields = {"numerics.depth_cells": depth, "numerics.max_dt_s": dt,
                      "numerics.max_duration_s": 131, "numerics.snapshot_count": 1}
            cfg = copy.deepcopy(config)
            cfg["blocks"]["V4"].setdefault("spec_fields", {}).update(fields)
            problem = build_problem(paths, cfg, jobs=args.jobs)
            apply_start_values(problem, values)
            records = []
            run = problem.runner.run

            def recorded(specs):
                results = run(specs)
                for spec, result in zip(specs, results):
                    if "error" in result or result.get("summary", {}).get("stop_reason") not in ("time", "beverage_mass"):
                        raise RuntimeError(f"Incomplete held-out shot: {result.get('error', result.get('summary'))}")
                    if len(result["spatial"]["depth_m"]) != depth:
                        raise RuntimeError("Actual held-out mesh does not match the requested depth")
                    records.append({"spec": spec, "summary": result["summary"],
                                    "diagnostics": result["diagnostics"]})
                return results

            problem.runner.run = recorded
            try:
                overrides = shared_overrides(problem, values)
                c3, v3 = check_v3(paths, problem.runner, overrides, tier=1,
                                  n_classes=config.get("n_classes", 16), spec_fields=fields)
                c5, v5 = check_v5(paths, problem.runner, overrides, tier=1,
                                  n_classes=config.get("n_classes", 16), spec_fields=fields)
                full = next(b for b in problem.blocks if b.name == "V4")
                cases = [case for case in full.cases if case.info["group"] == wz.TRANSIENT_GROUP]
                block = DatasetBlock(full.name, full.module, full.data, cases, full.options, full.units)
                evaluation = block.evaluate(problem.values(problem.x0()), problem.runner, problem.params)
                if evaluation.failures:
                    raise RuntimeError(evaluation.failures)
                c4, v4 = check_v4_transient(block, evaluation.observations)
                report["rows"].append({"label": label, "depth_cells": depth, "max_dt_s": dt,
                    "values": values, "held_out_checks": c3+c4+c5,
                    "held_out": {"v3": v3, "v4_transient": v4, "v5": v5},
                    "records": records, "robustness": problem.runner.robustness()})
                write(args.output, report)
                print(f"{label} {depth} layers: {len(records)} completed shots", flush=True)
            finally:
                problem.runner.close()
    if report["identity"] != identity():
        raise RuntimeError("solver, inputs or evaluation sources changed during held-out checks")
    report["complete"] = True
    write(args.output, report)


if __name__ == "__main__":
    main()
