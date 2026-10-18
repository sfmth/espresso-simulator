# SPDX-License-Identifier: GPL-2.0-or-later
"""Freeze exact fitted and pooled coefficients without changing a completed fit export."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import yaml

from puckworks_tools.calibrate import (
    REFERENCE_PERMEABILITY_ID, apply_start_values, build_problem, calibrated_values,
    load_calibration_document, reference_permeability,
)
from puckworks_tools.identity import file_sha256, input_hashes, solver_identity
from puckworks_tools.particle_inputs import strict_data
from puckworks_tools.paths import RepoPaths, find_repo_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    assert report["complete"] and report["stage"] == "fit" and not report["held_out_used"]
    source = args.report.parent / "candidate.yaml"
    config_path = args.report.parent / "config.yaml"
    output = args.report.parent / "frozen-candidate.yaml"
    original = load_calibration_document(source)
    assert original["fit"]["effective_config"] == report["config"]
    values = calibrated_values(original)
    assert all(values[key] == value for key, value in report["values"].items())
    paths = RepoPaths(find_repo_root())
    datasets = sorted(report["identity"]["inputs"]["datasets_sha256"])

    def identity():
        return {"solver": solver_identity(paths),
                "inputs": input_hashes(paths, str(config_path), datasets),
                "fit_report_sha256": file_sha256(args.report),
                "source_candidate_sha256": file_sha256(source),
                "script_sha256": file_sha256(Path(__file__))}

    before = identity()
    assert before["solver"] == report["identity"]["solver"]
    assert before["inputs"] == report["identity"]["inputs"]
    problem = build_problem(paths, report["config"], jobs=1)
    try:
        apply_start_values(problem, report["values"])
        # Pool the exact nuisance coefficients through the same builder recipe.
        # This only calls builders; it does not fit or simulate any holdout.
        reference = reference_permeability(problem, problem.x0(),
            {"parameters": original["fit"]["uncertainties"]})
        assert reference is not None
        frozen = copy.deepcopy(original)
        frozen["parameters"][REFERENCE_PERMEABILITY_ID] = reference["value_m2"]
        frozen["fit"]["reference_permeability"] = strict_data(reference)
        frozen["fit"]["freeze"] = {
            "fit_report_sha256": before["fit_report_sha256"],
            "source_candidate_sha256": before["source_candidate_sha256"],
            "held_out_used": False,
            "note": "Exact fitted values and exact pooled reference permeability; "
                    "presentation statistics retain their original rounding.",
        }
        assert identity() == before, "Inputs changed while freezing coefficients"
        output.write_text("# SPDX-License-Identifier: GPL-2.0-or-later\n"
                          "# Frozen research candidate; see m11-refined-tuning.md.\n" +
                          yaml.safe_dump(frozen, sort_keys=False, allow_unicode=True))
        record = {"schema": "puckworks.frozen-candidate/1", "complete": True,
                  "identity": before, "held_out_used": False,
                  "candidate_report_sha256": before["fit_report_sha256"],
                  "original_candidate_sha256": before["source_candidate_sha256"],
                  "frozen_candidate_sha256": file_sha256(output),
                  "values": calibrated_values(frozen),
                  "previous_reference_m2": values[REFERENCE_PERMEABILITY_ID],
                  "exact_reference_m2": reference["value_m2"],
                  "simulations": problem.runner.simulations}
        (args.report.parent / "freeze.json").write_text(
            json.dumps(strict_data(record), indent=2, allow_nan=False) + "\n")
        print(f"Frozen {len(report['values'])} fitted coefficients and exact pooled reference: {output}")
    finally:
        problem.runner.close()


if __name__ == "__main__":
    main()
