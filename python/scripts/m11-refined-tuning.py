# SPDX-License-Identifier: GPL-2.0-or-later
"""Staged, training-only restart after resolving the wet-age mesh bias.

Preserves v5's effective 22-parameter configuration, original observations,
weights and bounds. A permeability profile supplies a seed; a cheap fit supplies
only a warm start for the refined fit. Candidates are written outside the active
calibration directory. No held-out observation selects a parameter or restart.
"""
from __future__ import annotations

import argparse
import copy
import json
import time
from pathlib import Path

import numpy as np
import puckcore

from puckworks_tools.calibrate import (
    apply_start_values, build_problem, calibrated_values, calibration_document,
    datasets_for_block, dump_document, fit, load_calibration_document,
    optimizer_record, write_documents,
)
from puckworks_tools.identity import file_sha256, input_hashes, solver_identity
from puckworks_tools.particle_inputs import strict_data, score_v1
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.cases import schmieder2023 as sch


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(strict_data(value), indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def score(problem, x):
    evaluations = problem.evaluations(x)
    block = next(b for b in problem.blocks if b.name == "V1")
    evaluation = evaluations[problem.blocks.index(block)]
    rows = [{"experiment": c.info["experiment"], "completed": o is not None,
             "observations": o} for c, o in zip(block.cases, evaluation.observations)]
    counts = score_v1(rows, sch.targets(block.data))
    return {"cost": sum(.5*float(e.residuals@e.residuals) for e in evaluations),
            "block_costs": {b.name: .5*float(e.residuals@e.residuals)
                            for b, e in zip(problem.blocks, evaluations)},
            "failures": [f for e in evaluations for f in e.failures],
            "score": counts,
            "observations": {b.name: {c.name: o for c, o in zip(b.cases, e.observations)}
                             for b, e in zip(problem.blocks, evaluations)},
            "specs": {b.name: e.specs for b, e in zip(problem.blocks, evaluations)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("profile", "fit", "score"), required=True)
    parser.add_argument("--calibration", type=Path, default=Path("data/calibration/v5.yaml"))
    parser.add_argument("--start-from", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--depth", type=int, default=150)
    parser.add_argument("--dt", type=float, default=.025)
    parser.add_argument("--fd-step", type=float, default=.003)
    parser.add_argument("--max-nfev", type=int, default=80)
    parser.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args()
    paths = RepoPaths(find_repo_root())
    document = load_calibration_document(args.calibration)
    config = copy.deepcopy(document["fit"]["effective_config"])
    assert set(config["blocks"]) == {"V1", "V2", "V4", "V6"}
    assert len(config["parameters"]) == 22
    for name in ("V1", "V4"):
        fields = config["blocks"][name].setdefault("spec_fields", {})
        fields.update({"numerics.depth_cells": args.depth, "numerics.max_dt_s": args.dt})
        # V4 stops at 130 s. This only removes unused preflight allocation.
        if name == "V4":
            fields["numerics.max_duration_s"] = 131
        else:
            # All source shots/frozen-v5 shots complete well before this.
            # Retain the full beverage stop and drip; missing observations
            # still incur the unchanged failure residual. The explicit cap
            # keeps 300-layer checks within the core's existing work guard.
            fields["numerics.max_duration_s"] = 130
    args.output_dir.mkdir(parents=True, exist_ok=True)
    config_path = args.output_dir / "config.yaml"
    config_path.write_text(dump_document(config))
    problem = build_problem(paths, config, jobs=args.jobs, fd_step=args.fd_step)
    # Profile seed documents intentionally contain only exact physical values.
    if args.start_from and args.start_from.suffix == ".json":
        values = json.loads(args.start_from.read_text())["values"]
    else:
        starting = load_calibration_document(args.start_from) if args.start_from else document
        values = calibrated_values(starting)
    apply_start_values(problem, values)
    datasets = sorted({d for b in problem.blocks for d in datasets_for_block(b)})
    identity = {"solver": solver_identity(paths),
                "inputs": input_hashes(paths, paths.relative(config_path), datasets),
                "source_calibration_sha256": file_sha256(args.calibration),
                "starting_values_sha256": file_sha256(args.start_from or args.calibration),
                "script_sha256": file_sha256(Path(__file__))}
    report = {"schema": "puckworks.refined-tuning/1", "identity": identity,
              "config": config, "stage": args.stage, "depth_cells": args.depth,
              "max_dt_s": args.dt, "fd_step": args.fd_step, "fd_scheme": "forward_inward_at_bound",
              "held_out_used": False, "complete": False, "history": []}
    started = time.perf_counter()
    try:
        x0 = problem.x0()
        report["baseline"] = score(problem, x0)
        report["starting_values"] = problem.values(x0)
        if report["baseline"]["failures"]:
            raise RuntimeError(report["baseline"]["failures"])
        print(f"Starting cost {report['baseline']['cost']:.8f}", flush=True)
        write_json(args.output_dir / "report.json", report)
        if args.stage == "profile":
            candidates = []
            lo, hi = problem.bounds()
            indices = [j for j, p in enumerate(problem.params)
                       if p.id.startswith("calibration.schmieder2023.permeability.")]
            for shift in (0, .05, .1, .15):
                x = x0.copy()
                x[indices] = np.clip(x[indices] + shift, lo[indices], hi[indices])
                row = {"shift_dex": shift, "values": problem.values(x), **score(problem, x)}
                candidates.append(row)
                report["profile"] = candidates
                write_json(args.output_dir / "report.json", report)
                print(f"Profile +{shift:g} dex: {row['cost']:.8f}", flush=True)
            selected = min((r for r in candidates if not r["failures"]), key=lambda r: r["cost"])
            write_json(args.output_dir / "seed.json", {"values": selected["values"],
                       "training_cost": selected["cost"], "shift_dex": selected["shift_dex"]})
            report["selected_shift_dex"] = selected["shift_dex"]
        elif args.stage == "fit":
            residuals = problem.residuals

            def monitored(x):
                r = residuals(x)
                row = {"call": len(report["history"])+1, "cost": .5*float(r@r),
                       "values": problem.values(x), "elapsed_s": time.perf_counter()-started}
                report["history"].append(row)
                write_json(args.output_dir / "progress.json", row)
                write_json(args.output_dir / "history.json", report["history"])
                print(f"Evaluation {row['call']}: cost {row['cost']:.8f}, "
                      f"{problem.runner.simulations} shots", flush=True)
                return r

            problem.residuals = monitored
            result = fit(problem, x0=x0, max_nfev=args.max_nfev, verbose=2)
            report["optimizer"] = optimizer_record(result)
            report["final"] = score(problem, result.x)
            report["values"] = problem.values(result.x)
            report["jacobian"] = result.jacobian.tolist()
            report["jacobian_parameter_ids"] = [p.id for p in problem.params]
            candidate = calibration_document(problem, result, label="v6-candidate",
                config_path=paths.relative(config_path), core_version=puckcore.__version__,
                fixed=document["fit"]["fixed"])
            candidate["fit"].update(effective_config=config, pipeline={"stage": "candidate",
                                   "completed": False, "held_out_used": False})
            # Keep exact fitted coefficients for frozen-grid and holdout checks.
            # Presentation statistics can stay rounded; the scored inputs cannot.
            for section in (candidate["parameters"], candidate["fit"]["nuisance"],
                            candidate["fit"]["case_parameters"]):
                for key in section.keys() & report["values"].keys():
                    section[key] = report["values"][key]
            write_documents(candidate, args.output_dir, label="candidate", current=False)
        report["robustness"] = problem.runner.robustness()
        report["wall_s"] = time.perf_counter()-started
        if (identity["solver"] != solver_identity(paths) or
                identity["inputs"] != input_hashes(paths, paths.relative(config_path), datasets)):
            raise RuntimeError("solver or calibration inputs changed during the stage")
        report["complete"] = True
        write_json(args.output_dir / "report.json", report)
    finally:
        problem.runner.close()


if __name__ == "__main__":
    main()
