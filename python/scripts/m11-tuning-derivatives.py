# SPDX-License-Identifier: GPL-2.0-or-later
"""Training-only derivative and feasible-descent audit of a frozen tuning candidate."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from puckworks_tools.calibrate import apply_start_values, build_problem
from puckworks_tools.identity import file_sha256, input_hashes, solver_identity
from puckworks_tools.particle_inputs import strict_data
from puckworks_tools.paths import RepoPaths, find_repo_root


def write(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(strict_data(report), indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True, help="Completed fit report.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=16)
    args = parser.parse_args()
    candidate = json.loads(args.candidate.read_text())
    assert candidate["complete"] and candidate["stage"] == "fit"
    paths = RepoPaths(find_repo_root())
    problem = build_problem(paths, candidate["config"], jobs=args.jobs, fd_step=candidate["fd_step"])
    apply_start_values(problem, candidate["values"])
    identity = solver_identity(paths)
    assert identity == candidate["identity"]["solver"], "Audit requires the candidate's exact build"
    config_path = args.candidate.parent / "config.yaml"
    datasets = list(candidate["identity"]["inputs"]["datasets_sha256"])
    assert input_hashes(paths, str(config_path), datasets) == candidate["identity"]["inputs"]
    report = {"schema": "puckworks.tuning-derivatives/1", "identity": identity,
              "inputs": candidate["identity"]["inputs"],
              "candidate_sha256": file_sha256(args.candidate), "held_out_used": False,
              "script_sha256": file_sha256(Path(__file__)),
              "polish_rule": {"minimum_gradient_cosine": .95,
                              "maximum_relative_gradient_difference": .25,
                              "minimum_cost_reduction": .01,
                              "adjacent_descent_steps_required": 2,
                              "note": "Operational work threshold, not a scientific acceptance test."},
              "columns": [], "descent_trials": [], "complete": False}
    try:
        x = problem.x0()
        lo, hi = problem.bounds()
        span = hi-lo
        z = (x-lo)/span
        residuals = problem.residuals(x)
        cost = .5*float(residuals@residuals)
        assert np.isclose(cost, candidate["final"]["cost"], rtol=1e-10, atol=1e-8)
        report["baseline_cost"] = cost
        reference = np.asarray(candidate["jacobian"], dtype=float)
        assert candidate["jacobian_parameter_ids"] == [p.id for p in problem.params], \
            "Saved Jacobian parameter order differs from the audit problem"
        assert reference.shape == (len(residuals), len(problem.params))
        assert np.all(np.isfinite(reference)), "Saved Jacobian is not finite"
        jacobian = reference.copy()
        halfway = reference.copy()
        offsets = np.cumsum([0, *problem.sizes])
        base = problem.evaluations(x)
        names = [block.name for block in problem.blocks]
        # Inspect all directions, including inward derivatives at active bounds.
        # The fitted-step column is retained; new runs use h/2 and h/4.
        for j, parameter in enumerate(problem.params):
            columns = [reference[:, j]]
            fitted_h = candidate["fd_step"]
            if parameter.scale != "log":
                fitted_h *= span[j]
            if x[j]+fitted_h > hi[j]:
                fitted_h = -fitted_h
            assert lo[j] <= x[j]+fitted_h <= hi[j]
            steps = [fitted_h]
            probes, specs = [], []
            for divisor in (2, 4):
                # Retain the fitted direction: shrinking h must not switch sides.
                h = fitted_h / divisor
                steps.append(h)
                probe = x.copy()
                probe[j] += h
                probes.append((h, probe))
                values = problem.values(probe)
                for name in parameter.blocks:
                    if name not in names:
                        continue
                    block = problem.blocks[names.index(name)]
                    specs.extend(block.spec_for(case, values, problem.params) for case in block.cases)
            # Both probes are independent. Fill the existing runner cache in one
            # batch so workers can take the next shot without a per-block barrier.
            # Observation construction and failure handling remain unchanged.
            assert len(specs) < problem.runner.cache_size
            problem.runner.run(specs)
            prefetched = problem.runner.simulations
            for h, probe in probes:
                column = np.zeros_like(residuals)
                for name in parameter.blocks:
                    if name not in names:
                        continue
                    i = names.index(name)
                    evaluation = problem._block(i, probe)
                    if evaluation.failures:
                        raise RuntimeError(evaluation.failures)
                    column[offsets[i]:offsets[i+1]] = (evaluation.residuals-base[i].residuals)/h
                columns.append(column)
            assert problem.runner.simulations == prefetched, "Derivative prefetch missed a scored spec"
            jacobian[:, j] = columns[-1]
            halfway[:, j] = columns[1]
            row = {"parameter": parameter.id, "normalized_position": float(z[j]),
                   "signed_steps": steps,
                   "normalized_gradients": [float(column@residuals)*span[j] for column in columns],
                   "relative_column_changes": [float(np.linalg.norm(column-columns[-1]) /
                       max(np.linalg.norm(columns[-1]), 1e-12)) for column in columns[:-1]]}
            report["columns"].append(row)
            write(args.output, report)
            print(parameter.id, row["normalized_gradients"], flush=True)
        # Attribute finite-difference disagreement without additional core shots.
        # Normalize coordinates before combining different parameter columns.
        groups = {}
        for i, label in enumerate(problem.labels):
            parts = label.split("/")
            block = parts[0]
            keys = [block]
            if block == "V1":
                kind = "pressure" if "pressure" in parts[2] else "extraction"
                keys.extend((f"V1/{kind}", f"V1/{parts[1]}/{kind}"))
            for key in keys:
                groups.setdefault(key, []).append(i)
        report["disagreement_by_observable"] = {}
        for key, indices in groups.items():
            fine = jacobian[indices] * span
            norm = float(np.linalg.norm(fine))
            differences = [float(np.linalg.norm((matrix[indices]-jacobian[indices])*span))
                           for matrix in (reference, halfway)]
            report["disagreement_by_observable"][key] = {
                "residuals": len(indices), "quarter_step_normalized_jacobian_norm": norm,
                "fitted_and_half_step_difference_norms": differences,
                "relative_differences": [difference/max(norm, 1e-12) for difference in differences],
            }
        write(args.output, report)
        jz = jacobian*span
        gradient = jz.T@residuals
        def project(g):
            out = g.copy()
            out[(z < 1e-7) & (g > 0)] = 0
            out[(z > 1-1e-7) & (g < 0)] = 0
            return out
        projected = project(gradient)
        half_projected = project((halfway*span).T@residuals)
        a, b = float(np.linalg.norm(half_projected)), float(np.linalg.norm(projected))
        cosine = float(half_projected@projected)/(a*b) if a*b > 0 else float(a == b)
        relative = float(np.linalg.norm(half_projected-projected))/max(b, 1e-12)
        report["gradient_agreement"] = {"half_step_projected": half_projected.tolist(),
            "quarter_step_projected": projected.tolist(), "cosine": cosine,
            "relative_difference": relative}
        report["projected_gradient_max"] = float(np.max(abs(projected)))
        direction = -projected / np.maximum(np.sum(jz*jz, axis=0), 1e-12)
        scale = np.max(abs(direction))
        if scale > 0:
            direction /= scale
            for step in (.003, .001, .0003, .0001):
                trial = lo + span*np.clip(z+step*direction, 0, 1)
                evaluations = problem.evaluations(trial)
                failures = [f for evaluation in evaluations for f in evaluation.failures]
                r = np.concatenate([evaluation.residuals for evaluation in evaluations])
                trial_cost = .5*float(r@r)
                report["descent_trials"].append({"normalized_max_step": step,
                    "cost": trial_cost, "cost_change": trial_cost-cost,
                    "failures": failures, "values": problem.values(trial)})
                write(args.output, report)
                print(f"Descent {step:g}: cost {trial_cost:.9f}", flush=True)
        rule = report["polish_rule"]
        improvements = [not row["failures"] and row["cost_change"] <= -rule["minimum_cost_reduction"]
                        for row in report["descent_trials"]]
        adjacent = any(a and b for a, b in zip(improvements, improvements[1:]))
        report["polish_recommended"] = bool(adjacent and cosine >= rule["minimum_gradient_cosine"]
            and relative <= rule["maximum_relative_gradient_difference"])
        report["robustness"] = problem.runner.robustness()
        if identity != solver_identity(paths):
            raise RuntimeError("solver changed during derivative audit")
        if input_hashes(paths, str(config_path), datasets) != candidate["identity"]["inputs"]:
            raise RuntimeError("calibration inputs changed during derivative audit")
        report["complete"] = True
        write(args.output, report)
    finally:
        problem.runner.close()


if __name__ == "__main__":
    main()
