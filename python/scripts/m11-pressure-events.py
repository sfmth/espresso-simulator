# SPDX-License-Identifier: GPL-2.0-or-later
"""Probe pressure-event resolution at fixed v4 values, without fitting or exporting.

Use the same recorded input on each solver build. Keep the original training
observable and also resample to the old regular output grid to isolate the
effect of omitting phase and ramp boundaries from the reported series.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from types import SimpleNamespace

from puckworks_tools.calibrate import Runner
from puckworks_tools.cases.schmieder2023 import observe
from puckworks_tools.identity import file_sha256, solver_identity
from puckworks_tools.paths import RepoPaths, find_repo_root


def observations(result, case_info, interval):
    case = SimpleNamespace(info=case_info)
    actual = observe(case, result)
    sampled = copy.deepcopy(result)
    series = sampled["series"]
    indices = [i for i, t in enumerate(series["t_s"])
               if abs(t / interval - round(t / interval)) < 1e-7 or i == len(series["t_s"]) - 1]
    for key, values in series.items():
        if key == "species_cup_kg":
            for species in values:
                species["values"] = [species["values"][i] for i in indices]
        else:
            series[key] = [values[i] for i in indices]
    coarse = observe(case, sampled)
    keys = ("switch_s", "pour_peak_pressure_bar", "pump_limit_s", "pour_capped", "lambda")
    return {"reported": {key: actual[key] for key in keys},
            "regular_grid_only": {key: coarse[key] for key in keys},
            "summary": result["summary"], "diagnostics": result["diagnostics"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path,
                        default=Path("docs/validation/m11-startup-identification.json"))
    parser.add_argument("--output-dir", type=Path, default=Path(".local/pressure-events"))
    parser.add_argument("--jobs", type=int, default=6)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    paths = RepoPaths(find_repo_root())
    source = json.loads(args.input.read_text())["amplitude_grid"]
    solver = solver_identity(paths)
    input_hash = file_sha256(args.input)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    settings = [(a, dt) for a in (0.5, 0.509, 0.511)
                for dt in (0.05, 0.025, 0.0125, 0.00625)]
    specs = []
    for amplitude, dt in settings:
        spec = copy.deepcopy(source["baseline_spec"])
        spec["hydraulics"]["pore_air"]["amplitude"] = amplitude
        spec["numerics"]["max_dt_s"] = dt
        specs.append(spec)
    runner = Runner(jobs=args.jobs)
    try:
        rows = []
        for (amplitude, dt), spec, result in zip(settings, specs, runner.run(specs)):
            if "error" in result:
                raise RuntimeError(result["error"])
            output = args.output_dir / f"A{amplitude}-dt{dt}.json"
            output.write_text(json.dumps(result, allow_nan=False) + "\n")
            row = {"amplitude": amplitude, "max_dt_s": dt,
                   **observations(result, source["case_info"], spec["numerics"]["output_interval_s"]),
                   "result_file": output.name, "result_sha256": file_sha256(output)}
            rows.append(row)
            print(f"A={amplitude:g}, dt={dt:g}: "
                  f"P_pour={row['reported']['pour_peak_pressure_bar']:.6g} bar", flush=True)
        if solver != solver_identity(paths) or input_hash != file_sha256(args.input):
            raise RuntimeError("solver or fixed input changed during the probe")
        report = {"schema": "puckworks.pressure-events/1", "solver": solver,
                  "input": str(args.input), "input_sha256": input_hash,
                  "script_sha256": file_sha256(Path(__file__)),
                  "case": source["case"], "baseline_spec": source["baseline_spec"],
                  "case_info": source["case_info"], "refitted": False, "held_out_used": False,
                  "rows": rows, "robustness": runner.robustness()}
        (args.output_dir / "m11-pressure-events.json").write_text(
            json.dumps(report, indent=2, allow_nan=False) + "\n")
    finally:
        runner.close()


if __name__ == "__main__":
    main()
