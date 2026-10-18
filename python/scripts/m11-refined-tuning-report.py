# SPDX-License-Identifier: GPL-2.0-or-later
"""Render the staged training restart and independent frozen-candidate checks."""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
from pathlib import Path
import zlib

import numpy as np
import yaml


GRID_FIELDS = ("numerics.depth_cells", "numerics.max_dt_s")
REFERENCE_PERMEABILITY = "hydraulics.permeability.reference"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text_hash(text):
    # Same fingerprint as identity.file_sha256; retain the original bytes via UTF-8 text.
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def parse_source(text, *, yaml_document=False):
    if not yaml_document:
        return json.loads(text)
    # YAML statistics use integer experiment keys. JSON object keys are strings;
    # normalize that representation before comparing a saved bundle offline.
    return json.loads(json.dumps(yaml.safe_load(text), allow_nan=False))


def read_source(path, *, yaml_document=False):
    text = path.read_bytes().decode("utf-8")
    source = {"path": str(path), "sha256": text_hash(text)}
    # The parsed observations are already present in the bundle. Compress large
    # original JSON files while retaining their exact bytes for offline joins.
    if not yaml_document and len(text) > 65536:
        source.update(encoding="zlib+base64", data=base64.b64encode(
            zlib.compress(text.encode("utf-8"), level=9)).decode("ascii"))
    else:
        source["text"] = text
    return parse_source(text, yaml_document=yaml_document), source


def source_text(source, label):
    require(isinstance(source, dict), f"{label}: missing embedded source")
    if isinstance(source.get("text"), str):
        require("encoding" not in source and "data" not in source,
                f"{label}: ambiguous embedded source encoding")
        return source["text"]
    require(source.get("encoding") == "zlib+base64" and isinstance(source.get("data"), str),
            f"{label}: missing embedded source text; rebuild the bundle from source artifacts")
    try:
        return zlib.decompress(base64.b64decode(source["data"], validate=True)).decode("utf-8")
    except (ValueError, zlib.error, UnicodeError) as error:
        raise ValueError(f"{label}: invalid compressed source") from error


def check_source(value, source, label, *, yaml_document=False):
    text = source_text(source, label)
    require(source.get("sha256") == text_hash(text), f"{label}: source hash mismatch")
    parsed = parse_source(text, yaml_document=yaml_document)
    require(parsed == value, f"{label}: bundled content differs from its embedded source")


def coefficients(stage):
    key = "values" if stage["stage"] == "fit" else "starting_values"
    values = stage.get(key)
    ids = {p["id"] for p in stage["config"]["parameters"]}
    require(isinstance(values, dict) and set(values) == ids,
            f"Stage lacks its exact {key} for the configured parameters")
    require(all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in values.values()), "Stage coefficients must be finite numbers")
    return values


def calibrated_values(document):
    fit = document["fit"]
    return {**document["parameters"], **fit.get("nuisance", {}), **fit.get("case_parameters", {})}


def without_grid(config):
    config = copy.deepcopy(config)
    for name in ("V1", "V4"):
        fields = config["blocks"][name].get("spec_fields", {})
        for field in GRID_FIELDS:
            fields.pop(field, None)
        if not fields:
            config["blocks"][name].pop("spec_fields", None)
    return config


def without_config_hash(inputs):
    return {key: value for key, value in inputs.items() if key != "config_sha256"}


def check_grid(stage, name):
    require(isinstance(stage.get("depth_cells"), int) and stage["depth_cells"] > 0,
            f"{name}: invalid depth grid")
    require(isinstance(stage.get("max_dt_s"), (int, float)) and
            math.isfinite(stage["max_dt_s"]) and stage["max_dt_s"] > 0,
            f"{name}: invalid timestep")
    for block in ("V1", "V4"):
        fields = stage["config"]["blocks"][block].get("spec_fields", {})
        require(fields.get(GRID_FIELDS[0]) == stage["depth_cells"] and
                fields.get(GRID_FIELDS[1]) == stage["max_dt_s"],
                f"{name}: grid metadata differs from the {block} configuration")
        for spec in result(stage)["specs"][block]:
            require(spec["numerics"]["depth_cells"] == stage["depth_cells"] and
                    spec["numerics"]["max_dt_s"] == stage["max_dt_s"],
                    f"{name}: scored {block} spec differs from the declared grid")


def same_numeric_values(actual, expected):
    # Full validation reconstructs log coordinates. Permit only its roundtrip
    # roundoff, not presentation rounding or a different fitted point.
    return (actual.keys() == expected.keys() and all(
        isinstance(actual[key], (int, float)) and math.isfinite(actual[key]) and
        math.isclose(actual[key], value, rel_tol=1e-12, abs_tol=0.0)
        for key, value in expected.items()))


def validate_document(document):
    """Check artifact joins offline, including on standalone --from-json regeneration."""
    sources = document.get("sources", {})
    stages = document["stages"]
    require(stages, "No training stages supplied")
    for name, stage in stages.items():
        check_source(stage, sources.get("stages", {}).get(name), f"Stage {name}")
        require(stage.get("complete") is True and stage.get("held_out_used") is False,
                f"Stage {name} is incomplete or used held-out observations")
    baseline = stages[document["baseline_stage"]]
    candidate = stages[document["candidate_stage"]]
    require(baseline["stage"] == "score" and candidate["stage"] == "fit",
            "Matched comparison requires a frozen score baseline and a completed fit")
    require(baseline["identity"]["solver"] == candidate["identity"]["solver"],
            "Matched baseline and candidate use different solver builds")
    require(baseline["config"] == candidate["config"] and
            baseline["identity"]["inputs"] == candidate["identity"]["inputs"],
            "Matched baseline and candidate use different configurations or inputs")
    require(baseline["identity"].get("source_calibration_sha256") is not None and
            baseline["identity"].get("source_calibration_sha256") ==
            candidate["identity"].get("source_calibration_sha256") ==
            baseline["identity"].get("starting_values_sha256"),
            "Baseline is not a frozen score of the candidate's source calibration")
    for name in (document["baseline_stage"], document["candidate_stage"]):
        check_grid(stages[name], name)
        require(not result(stages[name])["failures"], f"{name}: unavailable scored observations")
    candidate_values = coefficients(candidate)
    baseline_values = coefficients(baseline)
    for name in document.get("resolution_stages", []):
        stage = stages[name]
        require(stage["stage"] == "score", f"Resolution stage {name} must score frozen coefficients")
        require(coefficients(stage) == candidate_values,
                f"Resolution stage {name} uses different exact coefficients")
        require(stage["identity"]["solver"] == candidate["identity"]["solver"],
                f"Resolution stage {name} uses a different solver build")
        require(without_grid(stage["config"]) == without_grid(candidate["config"]) and
                without_config_hash(stage["identity"]["inputs"]) ==
                without_config_hash(candidate["identity"]["inputs"]),
                f"Resolution stage {name} changes inputs beyond V1/V4 depth and timestep")
        check_grid(stage, name)
        require(not result(stage)["failures"], f"Resolution stage {name} has unavailable observations")

    exported = document["candidate_document"]
    check_source(exported, sources.get("candidate_document"), "Candidate YAML", yaml_document=True)
    exported_values = calibrated_values(exported)
    require(set(exported_values) == set(candidate_values) | {REFERENCE_PERMEABILITY},
            "Candidate YAML does not contain exactly the fitted and pooled coefficients")
    require({key: exported_values.get(key) for key in candidate_values} == candidate_values,
            "Candidate YAML differs from the exact fitted coefficients")
    require(exported["fit"]["solver"] == candidate["identity"]["solver"] and
            exported["fit"]["effective_config"] == candidate["config"],
            "Candidate YAML has a different solver or effective configuration")
    candidate_hash = sources["stages"][document["candidate_stage"]]["sha256"]
    yaml_hash = sources["candidate_document"]["sha256"]
    if document.get("freeze") is not None:
        freeze = document["freeze"]
        check_source(freeze, sources.get("freeze"), "Freeze record")
        original = document["original_candidate_document"]
        check_source(original, sources.get("original_candidate_document"),
                     "Original candidate YAML", yaml_document=True)
        require(freeze.get("complete") is True and freeze.get("held_out_used") is False,
                "Freeze record is incomplete or used held-out observations")
        require(freeze["candidate_report_sha256"] == candidate_hash and
                freeze["original_candidate_sha256"] == sources["original_candidate_document"]["sha256"] and
                freeze["frozen_candidate_sha256"] == yaml_hash,
                "Freeze record does not join the selected fit and candidate YAML files")
        require(freeze["values"] == exported_values and
                freeze["identity"]["solver"] == candidate["identity"]["solver"] and
                freeze["identity"]["inputs"] == candidate["identity"]["inputs"],
                "Freeze record has different coefficients, solver or inputs")
        require({key: calibrated_values(original).get(key) for key in candidate_values} == candidate_values,
                "Original candidate YAML differs from the selected fit")
        before, after = copy.deepcopy(original), copy.deepcopy(exported)
        for value in (before, after):
            value["parameters"].pop(REFERENCE_PERMEABILITY, None)
            value["fit"].pop("reference_permeability", None)
            value["fit"].pop("freeze", None)
        require(before == after, "Frozen YAML changes more than pooled permeability and freeze metadata")

    if document.get("derivatives") is not None:
        audit = document["derivatives"]
        check_source(audit, sources.get("derivatives"), "Derivative audit")
        require(audit.get("complete") is True and audit.get("held_out_used") is False,
                "Derivative audit is incomplete or used held-out observations")
        require(audit["candidate_sha256"] == candidate_hash and
                audit["identity"] == candidate["identity"]["solver"] and
                audit.get("inputs") == candidate["identity"]["inputs"],
                "Derivative audit belongs to a different candidate report, solver or inputs")
        require([row["parameter"] for row in audit.get("columns", [])] ==
                [p["id"] for p in candidate["config"]["parameters"]],
                "Derivative audit has different parameter columns")

    if document.get("fine_holdouts") is not None:
        holdouts = document["fine_holdouts"]
        check_source(holdouts, sources.get("fine_holdouts"), "Fine-grid holdouts")
        identity = holdouts["identity"]
        require(holdouts.get("complete") is True and holdouts.get("used_to_select_parameters") is False,
                "Fine-grid holdouts are incomplete or selected parameters")
        require(identity["candidate_sha256"] == yaml_hash and
                identity["baseline_sha256"] == baseline["identity"]["source_calibration_sha256"] and
                identity["solver"] == candidate["identity"]["solver"],
                "Fine-grid holdouts belong to different coefficients or solver")
        require(holdouts["config"] == candidate["config"],
                "Fine-grid holdouts use a different source configuration")
        train_inputs, held_inputs = candidate["identity"]["inputs"], identity["inputs"]
        require({k: v for k, v in held_inputs.items() if k != "datasets_sha256"} ==
                {k: v for k, v in train_inputs.items() if k != "datasets_sha256"},
                "Fine-grid holdouts use different registry, configuration or interface inputs")
        for name in train_inputs["datasets_sha256"].keys() & held_inputs["datasets_sha256"].keys():
            require(train_inputs["datasets_sha256"][name] == held_inputs["datasets_sha256"][name],
                    f"Fine-grid holdouts use different shared dataset {name}")
        expected = {(label, depth, dt) for label in ("frozen_v5", "candidate")
                    for depth, dt in ((30, .05), (150, .025), (300, .025))}
        observed = [(row["label"], row["depth_cells"], row["max_dt_s"]) for row in holdouts["rows"]]
        require(len(observed) == len(expected) and set(observed) == expected,
                "Fine-grid holdouts lack the six unique baseline/candidate grid checks")
        for row in holdouts["rows"]:
            require(row["values"] == exported_values if row["label"] == "candidate" else
                    same_numeric_values({key: row["values"].get(key) for key in baseline_values}, baseline_values),
                    "Fine-grid holdout row uses different frozen coefficients")
            for record in row["records"]:
                numerics = record["spec"]["numerics"]
                require(numerics["depth_cells"] == row["depth_cells"] and
                        numerics["max_dt_s"] == row["max_dt_s"],
                        "Fine-grid holdout row differs from its recorded spec grid")

    for name, validation in document.get("validation", {}).items():
        check_source(validation, sources.get("validation", {}).get(name), f"Validation {name}")
        require(validation.get("solver") == candidate["identity"]["solver"] and
                validation.get("calibration_solver") == candidate["identity"]["solver"],
                f"Validation {name} belongs to a different solver")
        recorded = {**validation.get("nuisance", {}),
                    **{key: row["value"] for key, row in validation.get("parameters", {}).items()
                       if row.get("calibrated")}}
        require(same_numeric_values(recorded, exported_values),
                f"Validation {name} uses different candidate coefficients")
        require(validation.get("fixed") == exported["fit"].get("fixed"),
                f"Validation {name} uses different fixed assumptions")
        require(isinstance(validation.get("calibration_config"), dict) and
                "tier" in validation and "n_classes" in validation,
                f"Validation {name} lacks its own evaluation configuration")


def result(stage):
    if stage["stage"] == "profile":
        return next(row for row in stage["profile"] if row["shift_dex"] == stage["selected_shift_dex"])
    return stage.get("final", stage["baseline"])


def stage_label(document, name):
    matched = {document["baseline_stage"], document["candidate_stage"],
               *document.get("resolution_stages", [])}
    return name if name in matched else f"{name} (seed diagnostic)"


def changes(reference, other):
    """Compare exactly matched V1 predictions; relative errors use the reference."""
    a = reference["observations"]["V1"]
    b = other["observations"]["V1"]
    assert a.keys() == b.keys()
    groups = {"rate_percent": [], "cup_percent": [], "pressure_bar": [], "switch_s": []}
    for case in a:
        assert a[case] is not None and b[case] is not None
        for analyte, value in a[case]["lambda"].items():
            groups["rate_percent"].append(100 * abs(b[case]["lambda"][analyte] / value - 1))
        for analyte, cups in a[case]["cup_eq3"].items():
            for mass, value in cups.items():
                groups["cup_percent"].append(100 * abs(b[case]["cup_eq3"][analyte][mass] / value - 1))
        groups["pressure_bar"].append(abs(b[case]["pour_peak_pressure_bar"] - a[case]["pour_peak_pressure_bar"]))
        groups["switch_s"].append(abs(b[case]["switch_s"] - a[case]["switch_s"]))
    return {key: max(values) for key, values in groups.items()}


def figure(document, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    stages = document["stages"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4), constrained_layout=True)
    colors = ["#087f9b", "#bd4e13", "#59647d"]
    fits = [(name, stage) for name, stage in stages.items() if stage["stage"] == "fit"]
    for (name, stage), color in zip(fits, colors):
        history = stage["history"]
        axes[0].plot([row["call"] for row in history], [row["cost"] for row in history],
                     ".-", label=stage_label(document, name), color=color)
    axes[0].set(xlabel="Residual evaluation (includes rejected trials)",
                ylabel="Training least-squares cost", title="Training-only optimization")
    axes[0].legend()
    baseline = stages[document["baseline_stage"]]["baseline"]
    candidate = result(stages[document["candidate_stage"]])
    for label, scored, color, marker in [("Frozen v5", baseline, "#59647d", "o"),
                                          ("Refined candidate", candidate, "#087f9b", "+")]:
        rows = scored["score"]["comparisons"]
        axes[1].scatter([r["lambda"]["data"] for r in rows],
                        [r["lambda"]["model"] for r in rows],
                        s=23, alpha=.8, label=label, color=color, marker=marker)
    low, high = axes[1].get_xlim()
    x = np.array([low, high])
    axes[1].plot(x, x, color="black", linewidth=.7)
    axes[1].fill_between(x, .9*x, 1.1*x, color="#aaa", alpha=.16, label="±10%")
    axes[1].set(xlabel="Measured extraction rate λ (g)", ylabel="Predicted λ (g)",
                title="Matched refined-grid training observations")
    axes[1].legend()
    for ax in axes:
        ax.grid(alpha=.15)
    fig.savefig(path, dpi=180)
    plt.close(fig)


def markdown(document):
    stages = document["stages"]
    base = stages[document["baseline_stage"]]["baseline"]
    selected = stages[document["candidate_stage"]]
    final = result(selected)
    improvement = 100 * (1 - final["cost"] / base["cost"])
    lines = ["<!-- SPDX-License-Identifier: GPL-2.0-or-later -->",
        "# M1.1: tuning after the wetting-age correction", "",
        f"On the matched {selected['depth_cells']}-layer / {selected['max_dt_s']*1000:g} ms grid, "
        f"training cost changes from **{base['cost']:.3f}** with frozen v5 coefficients to "
        f"**{final['cost']:.3f}** with the candidate (**{improvement:.2f}% lower**). "
        "This is a training comparison, not a held-out accuracy claim.", "",
        "![Optimization and matched-grid extraction rates](m11-refined-tuning.png)", "",
        "## Protocol", "",
        "The [wetting-age correction](m11-wet-age.md) addresses a numerical bias in the existing "
        "pore-air closure. The tuning round retains v5's effective 22 parameters, fixed 5-CQA "
        "partition, original bounds, residual weights and V1/V2/V4/V6 training blocks. V3, V4 "
        "startup/TDS and V5 remain held out. No holdout result chooses a restart or parameter.", "",
        "A four-point common permeability profile supplies a training-selected seed. A 30-layer "
        "fit supplies a warm start for the 150-layer fit; V1 and V4 use 25 ms maximum timesteps. "
        "V2/V6 retain their existing tier and discretization. The optimizer works in [0,1] "
        "coordinates relative to parameter bounds, preventing the step stopping rule from "
        "depending on units. Finite differences and exported Jacobians retain the original "
        "physical/log coordinates. Optimizer termination is recorded separately from stationarity.", "",
        "V1/V4 use explicit 130/131 s hard-stop budgets to remain within the existing work guard. "
        "The requested stop and every source fraction must complete; unavailable fractions or "
        "truncated shots receive failure residuals. All stages retain exact specs, observations, "
        "build/input hashes, progress and robustness statistics in the companion JSON.", "",
        "## Training and frozen-candidate checks", "",
        "| Stage | Layers / maximum step | Cost | Rates within ±10% | Cups within ±10% | Failures |",
        "|---|---|---:|---:|---:|---:|"]
    for name, stage in stages.items():
        scored = result(stage)
        counts = scored["score"]
        lines.append(f"| {stage_label(document, name)} | {stage['depth_cells']} / {stage['max_dt_s']*1000:g} ms | "
                     f"{scored['cost']:.3f} | {counts['lambda_within']}/{counts['lambda_total']} | "
                     f"{counts['cup_within']}/{counts['cup_total']} | {len(scored['failures'])} |")
    lines += ["", "| Training block | Frozen v5 cost | Candidate cost |",
              "|---|---:|---:|"]
    for name, cost in base["block_costs"].items():
        lines.append(f"| {name} | {cost:.4f} | {final['block_costs'][name]:.4f} |")
    lines += ["", "Historical v5 cost 570.523 belongs to its original core and grid and is not the "
              "baseline for this comparison. A stage's exact solver identity is retained even "
              "when an earlier build supplies only starting parameters. Seed diagnostics may use "
              "earlier builds and are not matched comparisons.", "",
              "## Resolution with frozen candidate coefficients", "",
              "The table compares each scored candidate against the selected refined fit, "
              "over all 15 V1 conditions. Maxima include 60 rates, 180 Eq. 3 cup masses, "
              "15 pour peaks and 15 pressure-switch times. Peak agreement alone cannot "
              "establish pressure-trajectory convergence near the pump cap.", "",
              "| Check | Max rate change (%) | Max cup change (%) | Max pour-peak change (bar) | Max switch change (s) |",
              "|---|---:|---:|---:|---:|"]
    for name in document.get("resolution_stages", []):
        diff = changes(final, result(stages[name]))
        lines.append(f"| {name} | {diff['rate_percent']:.4f} | {diff['cup_percent']:.4f} | "
                     f"{diff['pressure_bar']:.5f} | {diff['switch_s']:.6f} |")
    lines += ["", "## Optimizer diagnostics", "",
              "| Fit | Termination | Evaluations / Jacobians | First-order optimality | Shots / failures |",
              "|---|---|---:|---:|---:|"]
    for name, stage in stages.items():
        if stage["stage"] != "fit":
            continue
        opt, robust = stage["optimizer"], stage["robustness"]
        lines.append(f"| {name} | {opt['message']} | {opt['evaluations']} / "
                     f"{opt['jacobian_evaluations']} | {opt['optimality']:.5g} | "
                     f"{robust['simulations']} / {robust['failed']} |")
    lines += ["", "Finite-difference and mesh sensitivity, active bounds and nonzero first-order "
              "optimality limit any identifiability or optimum claim. The original training "
              "observations include correlated quantities derived from the same fractions; "
              "the unchanged least-squares cost is not independent-sample evidence.", "",
              "## Disposition and validation", "", document["disposition"], ""]
    if document.get("derivatives"):
        audit = document["derivatives"]
        largest = max(audit["columns"], key=lambda row: max(row["relative_column_changes"]))
        trials = audit["descent_trials"]
        valid = [row for row in trials if not row.get("failures") and
                 all(isinstance(row.get(key), (int, float)) and math.isfinite(row[key])
                     for key in ("cost", "cost_change"))]
        if valid:
            best = min(valid, key=lambda row: row["cost"])
            descent = f"The best valid tested descent step changes cost by {best['cost_change']:+.6g}. "
        elif not trials and audit["projected_gradient_max"] == 0:
            descent = "The projected gradient is zero; no descent direction was proposed. "
        else:
            descent = "No valid descent trial is available. "
        lines += ["### Derivative audit", "",
            "All parameter directions are re-evaluated with half and quarter finite-difference "
            f"steps; {len(valid)} of {len(trials)} diagonally scaled descent trials have valid "
            "training predictions. "
            f"The largest relative Jacobian-column change is {max(largest['relative_column_changes']):.4g} "
            f"for `{largest['parameter']}`. The quarter-step projected-gradient maximum is "
            f"{audit['projected_gradient_max']:.5g} in bound-normalized coordinates. "
            + descent +
            "These diagnostics do not establish a global optimum.", ""]
        if audit.get("gradient_agreement"):
            agreement, rule = audit["gradient_agreement"], audit["polish_rule"]
            lines += [f"Half/quarter projected-gradient cosine is {agreement['cosine']:.5g}, "
                      f"with relative difference {agreement['relative_difference']:.5g}. "
                      "The predeclared operational rule permits one additional bounded polish only "
                      f"at cosine ≥{rule['minimum_gradient_cosine']:g}, relative difference "
                      f"≤{rule['maximum_relative_gradient_difference']:g}, and cost reductions "
                      f"≥{rule['minimum_cost_reduction']:g} at two adjacent descent steps. "
                      f"Rule satisfied: **{'yes' if audit['polish_recommended'] else 'no'}**. "
                      "This work threshold does not change the model's scientific acceptance criteria.", ""]
        groups = audit.get("disagreement_by_observable", {})
        if groups:
            lines += ["Differences below use Jacobians in bound-normalized coordinates. "
                      "They locate sensitivity to the derivative step; they do not identify "
                      "which solver branch caused it.", "",
                      "| Residual group | Fitted vs quarter-step difference norm | Half vs quarter-step difference norm | Quarter-step Jacobian norm |",
                      "|---|---:|---:|---:|"]
            for key in ("V1/extraction", "V1/pressure", "V2", "V4", "V6"):
                row = groups[key]
                a, b = row["fitted_and_half_step_difference_norms"]
                lines.append(f"| {key} | {a:.5g} | {b:.5g} | "
                             f"{row['quarter_step_normalized_jacobian_norm']:.5g} |")
            lines.append("")
    if document.get("fine_holdouts"):
        lines += ["### Holdouts with frozen coefficients at three grids", "",
            "Both coefficient sets are frozen before these checks. The original source conditions, "
            "clocks and acceptance thresholds are retained. These previously inspected holdouts "
            "are not new independent data. Every requested stop must complete, and the actual "
            "output mesh is checked against the requested depth.", "",
            "| Coefficients | Layers / step | V3 peak EY (%) | V3 time RMS (s) | V4 drops (s) | V4 rise to 90% (s) | V5 time RMS (s) |",
            "|---|---|---:|---:|---:|---:|---:|"]
        for row in document["fine_holdouts"]["rows"]:
            held = row["held_out"]
            v3, v4, v5 = held["v3"], held["v4_transient"], held["v5"]
            peak = max(r["ey_model"] for r in v3["rows"])
            lines.append(f"| {row['label']} | {row['depth_cells']} / {row['max_dt_s']*1000:g} ms | "
                         f"{peak:.4f} | {v3['rms_time']:.4f} | {v4['drops_model_s']:.4f} | "
                         f"{v4['rise_model']['t90_s']:.4f} | {v5['rms_time']:.4f} |")
        lines += ["", "V3's measured peak is 23.07%, with the original acceptance interval 22–24%. "
                  "V4 measured first drops and flow rise are 12.762 and 25.475 s on the source clocks. "
                  "The JSON retains every held-out check, including first-fraction TDS and the "
                  "grind/fines trends, plus exact specs, summaries and numerical diagnostics.", ""]
    for name, validation in document.get("validation", {}).items():
        config = validation["calibration_config"]
        config_hash = text_hash(json.dumps(config, sort_keys=True, separators=(",", ":")))
        lines += [f"### {name}", "",
                  f"Full validation uses its own configuration (content hash `{config_hash}`), "
                  f"tier {validation['tier']} and {validation['n_classes']} particle classes. "
                  "Its configuration is shown below; omitted numerical fields use this solver's case defaults.", "",
                  "<details><summary>Full-validation configuration</summary>", "", "```yaml",
                  yaml.safe_dump(config, sort_keys=False, allow_unicode=True).rstrip(), "```", "", "</details>", "",
                  "| Held-out check | Result | Evidence |", "|---|---|---|"]
        for check in validation.get("held_out_checks", []):
            lines.append(f"| {check['check']} | "
                         f"{check.get('status', check.get('passed', ''))} | "
                         f"{check.get('detail', check.get('message', ''))} |")
        lines.append("")
    lines += ["## Reproduction", "",
              "See [the tooling commands](../../python/README.md#wetting-age-correction-and-refined-tuning). "
              "Each simulation stage checks that its solver and calibration inputs remain unchanged. "
              "To regenerate this document and figure without simulating:", "", "```sh",
              ".venv/bin/python python/scripts/m11-refined-tuning-report.py --from-json docs/validation/m11-refined-tuning.json",
              "```", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-json", type=Path)
    parser.add_argument("--root-dir", type=Path, default=Path(".local/refined-tuning"))
    parser.add_argument("--stage", action="append", default=[])
    parser.add_argument("--baseline-stage", default="baseline150")
    parser.add_argument("--candidate-stage", default="refined150")
    parser.add_argument("--candidate-document", type=Path,
                        help="Exact candidate YAML (default: candidate-stage/candidate.yaml)")
    parser.add_argument("--freeze", type=Path, help="Optional exact-coefficient freeze record")
    parser.add_argument("--resolution-stage", action="append", default=[])
    parser.add_argument("--validation", action="append", default=[], help="NAME=JSON_PATH")
    parser.add_argument("--derivatives", type=Path)
    parser.add_argument("--fine-holdouts", type=Path)
    parser.add_argument("--disposition", default="Candidate retained for research; active calibration unchanged. "
                        "Fresh full-block leave-one-out and sensitivity refits are required for promotion. "
                        "Historical v5 predictive scores do not transfer to this solver.")
    parser.add_argument("--output-dir", type=Path, default=Path("docs/validation"))
    args = parser.parse_args()
    if args.from_json:
        document = json.loads(args.from_json.read_text())
    else:
        stages, validation = {}, {}
        sources = {"stages": {}, "validation": {}}
        for name in args.stage:
            require(name not in stages, f"Duplicate stage {name}")
            stages[name], sources["stages"][name] = read_source(args.root_dir / name / "report.json")
        for item in args.validation:
            name, path = item.split("=", 1)
            require(name not in validation, f"Duplicate validation attachment {name}")
            validation[name], sources["validation"][name] = read_source(Path(path))
        document = {"schema": "puckworks.refined-tuning-report/1", "stages": stages,
                    "baseline_stage": args.baseline_stage, "candidate_stage": args.candidate_stage,
                    "resolution_stages": args.resolution_stage, "validation": validation,
                    "disposition": args.disposition, "sources": sources}
        original_path = args.root_dir / args.candidate_stage / "candidate.yaml"
        candidate_path = args.candidate_document or original_path
        document["candidate_document"], sources["candidate_document"] = read_source(
            candidate_path, yaml_document=True)
        if args.freeze:
            document["original_candidate_document"], sources["original_candidate_document"] = read_source(
                original_path, yaml_document=True)
        for key, path in (("derivatives", args.derivatives), ("fine_holdouts", args.fine_holdouts),
                          ("freeze", args.freeze)):
            if path:
                document[key], sources[key] = read_source(path)
    validate_document(document)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    prefix = args.output_dir / "m11-refined-tuning"
    figure(document, prefix.with_suffix(".png"))
    prefix.with_suffix(".md").write_text(markdown(document))
    prefix.with_suffix(".json").write_text(json.dumps(document, indent=2, allow_nan=False) + "\n")
    if document.get("candidate_document"):
        # Preserve the exact bytes whose fingerprint joins the holdout/freeze records.
        prefix.with_suffix(".yaml").write_bytes(source_text(
            document["sources"]["candidate_document"], "Candidate YAML").encode("utf-8"))


if __name__ == "__main__":
    main()
