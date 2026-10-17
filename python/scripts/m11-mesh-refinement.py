# SPDX-License-Identifier: GPL-2.0-or-later
"""Fixed-v5 spatial refinement, with serial timing and resumable complete shot records.

  .venv/bin/python python/scripts/m11-mesh-refinement.py \
    --calibration data/calibration/v5.yaml --output-dir .local/mesh-refinement

Depth is refined by 5x and 10x. Separate column and particle-shell sweeps use
5x and the solver's 8x limit; a joint refinement checks interactions. Particle
size distributions, all constitutive parameters, and output sampling stay fixed.
No fitting is performed. Results describe the recorded build and inputs only.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import math
import statistics
import time
from pathlib import Path

import puckcore

from puckworks_tools.calibrate import (
    build_problem, calibrated_values, datasets_for_block, load_calibration_document,
    load_config, observe, required_observations_available,
)
from puckworks_tools.cases import cameron2020 as cam, schmieder2023 as sch
from puckworks_tools.cases.common import Case
from puckworks_tools.identity import input_hashes, solver_identity
from puckworks_tools.particle_inputs import record_case, strict_data, summarize_scenario
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.validate import (
    _calibration_x, calibration_reuse_issues, generic_recipe, shared_overrides,
    v4_transient_metrics,
)


# Columns/shells are capped at 64 by the existing solver. Do not raise its bounds
# to call those axes 10x. Only the bed-depth sweep has an exact 10x resolution.
VARIANTS = {
    "baseline": (30, 8, 8, .05),
    "depth_5x": (150, 8, 8, .05),
    "depth_10x": (300, 8, 8, .05),
    "baseline_half_dt": (30, 8, 8, .025),
    "depth_10x_half_dt": (300, 8, 8, .025),
    "columns_5x": (30, 40, 8, .05),
    "columns_8x": (30, 64, 8, .05),
    "shells_5x": (30, 8, 40, .05),
    "shells_8x": (30, 8, 64, .05),
    "joint": (150, 16, 16, .05),
}
SUMMARY_FIELDS = ("shot_time_s", "first_drops_s", "beverage_mass_kg", "ey", "tds", "drip_mass_kg")


def digest(value):
    return hashlib.sha256(json.dumps(strict_data(value), sort_keys=True, allow_nan=False).encode()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(strict_data(value), indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def run_cached(folder, identity, spec):
    """Cache only an exact spec on the exact build; timings always describe an actual run."""
    key = digest({"identity": identity, "spec": spec})
    path = folder / f"{key}.json.gz"
    if path.exists():
        with gzip.open(path, "rt") as handle:
            return json.load(handle)
    started = time.perf_counter()
    try:
        result = puckcore.simulate_shot(json.dumps(spec, allow_nan=False))
    except ValueError as exc:
        result = {"error": str(exc)}
    record = {"spec_sha256": digest(spec), "wall_s": time.perf_counter() - started, "result": result}
    folder.mkdir(parents=True, exist_ok=True)
    with gzip.open(path.with_suffix(".tmp"), "wt") as handle:
        json.dump(strict_data(record), handle, allow_nan=False)
    path.with_suffix(".tmp").replace(path)
    return record


def build_inputs(paths, document):
    config_path = document["fit"].get("config", "data/calibration/config.yaml")
    config = load_config(paths.root / config_path)
    problem = build_problem(paths, config, jobs=1)
    fitted = calibrated_values(document)
    values = problem.values(_calibration_x(problem, fitted, fixed=document["fit"].get("fixed")))
    blocks = {b.name: b for b in problem.blocks}
    cases = []
    for name in ("V1", "V4"):
        block = blocks[name]
        for case in block.cases:
            if name == "V4" and case.info["group"] != "9":
                continue
            cases.append((name, case, block.spec_for(case, values, problem.params), block.module))
    overrides = shared_overrides(problem, fitted)
    for case in cam.build_cases(cam.load(paths), tier=1, n_classes=16, overrides=overrides):
        cases.append(("V3", case, case.spec, cam))
    recipe = generic_recipe("mahlkoenig-ek43", 1.7, overrides, 1)
    spec = puckcore.build_shot_spec(recipe)["spec"]
    case = Case("generic", "generic/ek43", recipe, lambda spec, values: None,
                info={"dose_g": 18.0, "stop_g": 36.0, "grinder": "mahlkoenig-ek43", "setting": 1.7})
    cases.append(("generic", case, spec, None))
    for _, _, spec, _ in cases:
        # One final spatial snapshot for every run; output curves are unchanged.
        spec["numerics"]["snapshot_count"] = 1
        assert spec["numerics"]["depth_cells"] == 30
        assert spec["bed"]["heterogeneity"]["columns"] == 8
        assert spec["numerics"]["kernel_shells"] == 8
    datasets = sorted({name for b in problem.blocks for name in datasets_for_block(b)})
    return problem, blocks, values, cases, config_path, datasets


def make_row(group, case, spec, module, cached, block):
    result = cached["result"]
    if group == "V1":
        row = record_case(case, spec, result)
        if row["completed"] and not required_observations_available(block, case, row["observations"]):
            row.update(completed=False, failure="required V1 observations are missing")
        # Reconstruct each complete spec from report.inputs and the recorded patch.
        row.pop("spec")
        row.pop("info")
    else:
        summary = result.get("summary", {})
        expected = "time" if group == "V4" else "beverage_mass"
        row = {"case": case.name, "summary": summary, "diagnostics": result.get("diagnostics", {}),
               "completed": "error" not in result and summary.get("stop_reason") == expected,
               "failure": result.get("error"), "observations": None}
        if row["completed"] and module is not None:
            row["observations"] = observe(module, case, result, spec)
        if group == "V4" and row["observations"]:
            row["transient_metrics"] = v4_transient_metrics(case, row["observations"])
    row.update(group=group, wall_s=cached["wall_s"], spec_sha256=cached["spec_sha256"],
               numerics=spec["numerics"], columns=spec["bed"]["heterogeneity"]["columns"],
               size_classes=len(spec["bed"]["size_classes"]))
    if not row["completed"] and not row["failure"]:
        row["failure"] = "shot did not reach its requested stop"
    if row["completed"]:
        if not all(math.isfinite(row["summary"][field]) for field in SUMMARY_FIELDS):
            row.update(completed=False, failure="nonfinite summary")
        spatial = result["spatial"]
        if len(spatial["depth_m"]) != spec["numerics"]["depth_cells"] or len(spatial["columns"]) != row["columns"]:
            raise RuntimeError("reported mesh differs from requested mesh")
        row["actual_bed_cells"] = len(spatial["depth_m"]) * len(spatial["columns"])
        if group in ("generic", "V4") or (group == "V1" and case.info["experiment"] in (7, 13)):
            row["series"] = result["series"]
            row["spatial"] = spatial
    return row


def compare(rows, baseline):
    lookup = {r["case"]: r for r in baseline}
    differences = []
    for row in rows:
        old = lookup[row["case"]]
        metrics = [(field, old["summary"].get(field), row["summary"].get(field)) for field in SUMMARY_FIELDS]
        if row["group"] == "V1":
            a, b = old.get("observations") or {}, row.get("observations") or {}
            for kind in ("lambda", "c0", "cup_eq3", "cup_direct"):
                for analyte, *_ in sch.ANALYTES:
                    for mass in (sch.CUP_MASSES_G if kind.startswith("cup") else (None,)):
                        def at(obs):
                            value = obs.get(kind, {}).get(analyte)
                            return value.get(mass, value.get(str(mass))) if isinstance(value, dict) else value
                        metrics.append((f"{kind}/{analyte}" + (f"/{mass:g}g" if mass else ""), at(a), at(b)))
            metrics.extend((key, a.get(key), b.get(key)) for key in ("pour_peak_pressure_bar", "switch_s"))
        for metric, a, b in metrics:
            valid = (old["completed"] and row["completed"] and isinstance(a, (int, float))
                     and isinstance(b, (int, float)) and math.isfinite(a) and math.isfinite(b))
            differences.append({"case": row["case"], "group": row["group"], "metric": metric,
                                "baseline": a, "refined": b, "difference": b - a if valid else None,
                                "relative_difference": b / a - 1 if valid and a != 0 else None})
    return differences


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, default=Path("data/calibration/v5.yaml"))
    parser.add_argument("--output-dir", type=Path, default=Path(".local/mesh-refinement"))
    parser.add_argument("--variants", nargs="+", choices=tuple(VARIANTS), default=list(VARIANTS))
    args = parser.parse_args(argv)
    paths = RepoPaths(find_repo_root())
    document = load_calibration_document(args.calibration)
    problem, blocks, values, cases, config_path, datasets = build_inputs(paths, document)
    output = args.output_dir / "mesh-refinement.json"

    def identity():
        return {"solver": solver_identity(paths), "inputs": input_hashes(paths, config_path, datasets),
                "held_out_inputs": input_hashes(paths, config_path, cam.DATASETS),
                "calibration_sha256": hashlib.sha256(args.calibration.read_bytes()).hexdigest(),
                "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}

    frozen = identity()
    report = {"schema": "puckworks.mesh-refinement/1", "identity": frozen, "calibration": document["label"],
              "calibration_reuse_issues": calibration_reuse_issues(document, frozen["solver"], frozen["inputs"]),
              "fitted_in_this_run": False, "serial_simulations": True, "parameter_values": values,
              "variant_definitions": {k: dict(zip(("depth_cells", "columns", "kernel_shells", "max_dt_s"), v))
                                      for k, v in VARIANTS.items()},
              "protocol": {"output_sampling_changed": False, "particle_size_distribution_changed": False,
                           "snapshot_count": 1, "timing": "one serial Python-to-Rust call per case and variant; includes JSON",
                           "hard_stop": "uniform across variants per case: ceil(1.35 * original shot time + 10 s), "
                                        "at least 60 s; time-stopped shots use stop time + 1 s. "
                                        "Original and shortened baseline results must be identical."},
              "inputs": {}, "variants": {}, "complete": False}
    cache = args.output_dir / "runs"
    original_results = {}
    try:
        for group, case, spec, _ in cases:
            original = run_cached(cache, frozen, spec)
            result = original["result"]
            if "error" in result or result["summary"]["stop_reason"] not in ("beverage_mass", "time"):
                raise RuntimeError(f"original baseline failed: {case.name}: {result.get('error')}")
            original_results[case.name] = result
            original_spec = copy.deepcopy(spec)
            if result["summary"]["stop_reason"] == "beverage_mass":
                spec["numerics"]["max_duration_s"] = min(
                    spec["numerics"]["max_duration_s"], max(60, math.ceil(1.35 * result["summary"]["shot_time_s"] + 10)))
            else:
                spec["numerics"]["max_duration_s"] = result["summary"]["shot_time_s"] + 1
            report["inputs"][case.name] = {"group": group, "spec": copy.deepcopy(spec), "info": case.info,
                                          "recipe": case.recipe, "original_numerics": original_spec["numerics"],
                                          "original_summary": result["summary"]}
            print(f"preflight {case.name}: {result['summary']['shot_time_s']:.3f} s; hard stop "
                  f"{spec['numerics']['max_duration_s']:g} s", flush=True)
        selected = ["baseline", *[v for v in args.variants if v != "baseline"]]
        for name in selected:
            rows = []
            depth, columns, shells, dt = VARIANTS[name]
            for group, case, base, module in cases:
                spec = copy.deepcopy(base)
                spec["numerics"].update(depth_cells=depth, kernel_shells=shells, max_dt_s=dt)
                spec["bed"]["heterogeneity"]["columns"] = columns
                cached = run_cached(cache, frozen, spec)
                if name == "baseline" and cached["result"] != original_results[case.name]:
                    # Warnings can reflect only the computational bound. Every numerical output
                    # and diagnostic must agree; remove those warning strings before comparing.
                    def numerical(result):
                        result = copy.deepcopy(result)
                        result.get("diagnostics", {}).pop("warnings", None)
                        return result
                    if numerical(cached["result"]) != numerical(original_results[case.name]):
                        raise RuntimeError(f"hard-stop change affected baseline: {case.name}")
                row = make_row(group, case, spec, module, cached, blocks["V1"])
                rows.append(row)
                print(f"{name} {case.name}: {'ok' if row['completed'] else row['failure']}; "
                      f"{row['wall_s']:.3f} s wall", flush=True)
            v1 = [r for r in rows if r["group"] == "V1"]
            score = summarize_scenario(v1, sch.targets(blocks["V1"].data))
            observations = [r["observations"] if r["completed"] else None for r in v1]
            residuals, labels = blocks["V1"].residual_fn(blocks["V1"], observations, values)
            score["cost"] = .5 * blocks["V1"].weight * float(residuals @ residuals)
            report["variants"][name] = {"rows": rows, "v1": score, "wall_total_s": sum(r["wall_s"] for r in rows),
                                        "completed": sum(r["completed"] for r in rows), "required": len(cases)}
            reference = report["variants"]["baseline"]["rows"]
            report["variants"][name]["comparison"] = compare(rows, reference)
            report["variants"][name]["median_runtime_ratio"] = statistics.median(
                r["wall_s"] / b["wall_s"] for r, b in zip(rows, reference) if r["completed"] and b["completed"])
            if identity() != frozen:
                raise RuntimeError("build, source, calibration, or inputs changed during the study")
            write_json(output, report)
            print(f"{name}: {score['score']['lambda_within']}/60 rates, {score['score']['cup_within']}/180 cups; "
                  f"cost {score['cost']:.6f}", flush=True)
        report["complete"] = all(v["completed"] == v["required"] for v in report["variants"].values())
        report["identity_unchanged"] = identity() == frozen
        write_json(output, report)
        print(output, flush=True)
        return 0 if report["complete"] else 1
    finally:
        problem.runner.close()


if __name__ == "__main__":
    raise SystemExit(main())
