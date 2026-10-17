# SPDX-License-Identifier: GPL-2.0-or-later
"""Fixed-parameter V1 particle-input audit; no fitting, input selection or gate changes.

Run ``python -m puckworks_tools.particle_inputs --jobs 3 --output-dir PATH``. The six
predeclared variants contain all 15 Schmieder conditions; one further centre shot halves dt.
The JSON retains every spec and observation, and can regenerate the report with ``--from-json``.
"""

from __future__ import annotations

import argparse
import copy
import datetime
import json
import math
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from . import __version__
from .calibrate import Runner, build_problem, calibrated_values, load_calibration_document
from .cases import schmieder2023 as sch
from .cases.common import Case, bimodal_psd
from .identity import file_sha256, input_hashes, solver_identity, tree_sha256
from .paths import RepoPaths, find_repo_root
from .validate import V1_FIT_TOLERANCE, _calibration_x
from .yamlio import load_yaml

REPORT_NAME = "m11-particle-inputs"
HISTORICAL_REPORT = "docs/validation/m11-particle-inputs.json"
EXPERIMENTS = tuple(range(1, 16))
SCENARIOS = (
    {"id": "original16", "label": "Original, 16 classes", "psd_source": "reconstructed", "n_classes": 16},
    {"id": "wet16", "label": "Wet, 16 classes", "psd_source": "wet_cdf", "n_classes": 16},
    {"id": "wet16_d32_minus_sd", "label": "Wet D32 −1 SD", "psd_source": "wet_cdf", "n_classes": 16,
     "sauter_offset_sd": -1.0},
    {"id": "wet16_d32_plus_sd", "label": "Wet D32 +1 SD", "psd_source": "wet_cdf", "n_classes": 16,
     "sauter_offset_sd": 1.0},
    {"id": "wet16_original_air_tau", "label": "Wet, original air τ", "psd_source": "wet_cdf", "n_classes": 16,
     "original_air_tau": True},
    {"id": "wet32", "label": "Wet, 32 classes", "psd_source": "wet_cdf", "n_classes": 32,
     "retain_wet16_non_class_fields": True,
     "spec_construction": "Build a wet 32-class case for its PSD/classes and metadata, then replace only "
     "bed.size_classes in the corresponding wet16 final spec; all other fields are copied from wet16, "
     "including pore-air tau and preparation heterogeneity. The simulated spec therefore differs "
     "from rebuilding the 32-class recipe alone."},
)
SOURCE_BASIS = (
    "The wet input uses the resolved cumulative volume distribution Q3 from Schmieder et al. (2023), "
    "Fig. A1(b), and the wet D32/D43 means and SDs in section 2.4. It is a digitisation of the published "
    "figure, not the authors' raw instrument data. Each resolved interval has uniform volume density "
    "in diameter; midpoint quadrature preserves its volume and D43 and approximates D32 within 1e-7.",
    "The unresolved fraction below the first resolved coordinate is placed at one effective diameter "
    "to impose the reported D32. This head diameter is derived, not a measured fine-particle shape. "
    "D32 agreement is a constraint, while D43 is an unfitted cross-check. Applying a mean D32 to a "
    "mean CDF does not recover the replicate distributions.",
    "The sub-3.04 µm head and three density/CDF crossings are omitted from the digitisation. "
    "Interpolation over those crossings, within-bin shape, an assumed terminal support at 1000 µm, "
    "occlusion and the monotonic projection remain uncertain. Raw readings and the projection are "
    "retained in the dataset. These runs do not sample all those uncertainties.",
    "The ±1 SD variants move the reported D32 target and only the derived head diameter; the resolved "
    "CDF and head fraction stay fixed. They are fixed input sensitivities, not a confidence band or "
    "independent replicate predictions.",
    "All shared and nuisance values remain at the preserved v2 calibration, including each grinding "
    "level's bare permeability κ₀. There is no refit or rescaling of κ₀ for the new particle input. "
    "Registry values for unfitted parameters and the existing V1 conditions also remain fixed.",
    "The builder's pore-air relaxation time follows wet D32 through its moisture-diffusion closure; "
    "this use of a wet equivalent-sphere diameter is not independently validated as a gas-relaxation "
    "radius or intact-cell diffusion distance. One variant copies the original case's air τ per "
    "experiment to expose this coupling. The builder also changes preparation heterogeneity σ through "
    "the volume share below 100 µm. Holding only air τ fixed therefore still mixes particle transport "
    "with the changed permeability spread. Wet and dry particle geometry need not coincide.",
    "The 32-class numerical check replaces only bed.size_classes in the nominal wet16 final spec. "
    "All non-class fields, including air τ and preparation heterogeneity, remain exactly fixed. "
    "Its case metadata comes from the normally built 32-class recipe, but that recipe alone would "
    "also change the builder's class-interpolated fines share and derived heterogeneity.",
    "Scores use the existing V1 absolute relative-error rule ≤10%, with the authors' Eq. 3 cup masses. "
    "Every scenario retains denominators of 60 λ values and 180 cup masses; failed, incomplete, "
    "missing and nonfinite predictions cannot count as successes. First drops and shot times use "
    "the solver's summary convention, and their ranges include completed shots only.",
    "This is a conditional input audit on the V1 calibration data, not independent validation. "
    "It selects no best variant, promotes no input automatically, and changes no calibration defaults "
    "or scientific acceptance gates.",
)


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool) and math.isfinite(value)


def _at(value: Any, *keys: Any) -> Any:
    """Read numeric-keyed observations before or after a JSON round trip."""
    for key in keys:
        if isinstance(value, Mapping):
            value = value.get(key, value.get(str(key)))
        elif isinstance(value, (list, tuple)) and isinstance(key, int) and 0 <= key < len(value):
            value = value[key]
        else:
            return None
    return value


def strict_data(value: Any) -> Any:
    """Represent unavailable numerical values as JSON null, never NaN or Infinity."""
    if isinstance(value, Mapping):
        return {str(key): strict_data(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [strict_data(item) for item in value]
    if isinstance(value, (float, np.floating)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    return value


def score_v1(rows: Sequence[Mapping[str, Any]], targets: Mapping[Any, Any]) -> dict[str, Any]:
    """Apply validate.py's V1 rule to the complete, fixed 15 × 4 × 3 comparison grid."""
    by_experiment = {}
    for row in rows:
        experiment = row["experiment"]
        if experiment not in EXPERIMENTS or experiment in by_experiment:
            raise ValueError("V1 audit rows need unique experiment numbers in 1..15")
        by_experiment[experiment] = row

    def compare(model: Any, data: Any, reason: str | None) -> dict[str, Any]:
        if reason is None and not _finite(model):
            reason = "missing or nonfinite prediction"
        if not _finite(data) or data <= 0:
            reason = "missing or invalid target"
        error = abs(model / data - 1.0) if reason is None else None
        if error is not None and not math.isfinite(error):
            reason, error = "nonfinite relative error", None
        return {"model": model if reason is None else None, "data": data,
                "relative_error": error, "within": error is not None and error <= V1_FIT_TOLERANCE,
                "missing_reason": reason}

    comparisons = []
    for experiment in EXPERIMENTS:
        row = by_experiment.get(experiment)
        reason = "shot not run" if row is None else (None if row.get("completed") else "shot failed or incomplete")
        obs = row.get("observations") if row else None
        for analyte, _, _, _ in sch.ANALYTES:
            target = _at(targets, experiment)
            comparisons.append({
                "experiment": experiment, "analyte": analyte,
                "lambda": compare(_at(obs, "lambda", analyte), _at(target, "lambda", analyte, 0), reason),
                "cups": {str(int(m)): compare(_at(obs, "cup_eq3", analyte, int(m)),
                                               _at(target, "cup", analyte, int(m), 0), reason)
                         for m in sch.CUP_MASSES_G},
            })

    def counts(selected: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        lambdas = [row["lambda"] for row in selected]
        cups = [cup for row in selected for cup in row["cups"].values()]
        return {f"{kind}_{metric}": value for kind, values in (("lambda", lambdas), ("cup", cups))
                for metric, value in (
                    ("within", sum(row["within"] for row in values)), ("total", len(values)),
                    ("missing", sum(row["missing_reason"] is not None for row in values)),
                    ("max_error", max((row["relative_error"] for row in values
                                       if row["relative_error"] is not None), default=None)),
                )}

    return {**counts(comparisons), "comparisons": comparisons,
            "by_analyte": {a: counts([row for row in comparisons if row["analyte"] == a])
                           for a, _, _, _ in sch.ANALYTES}}


def historical_inputs(paths: RepoPaths) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """The archived audit config and v2 values, independent of the currently deployed calibration.

    Replaying these inputs on a newer solver is a new experiment; the archived 0.5.1 results and
    their source identities remain untouched. Unfitted registry inputs come from the running tree.
    """
    archive = json.loads((paths.root / HISTORICAL_REPORT).read_text(encoding="utf-8"))
    document = load_calibration_document(paths.root / "data/calibration/v2.yaml")
    if document.get("label") != "v2" or calibrated_values(document) != archive["calibration"]["all_preserved_values"]:
        raise ValueError("particle-input audit requires the preserved v2 values recorded in the historical report")
    return copy.deepcopy(archive["calibration"]["config"]), document, archive


def preserve_shared_values(problem: Any, document: Mapping[str, Any]) -> None:
    """Make every historical shared value explicit, including values absent from the V1 fit vector."""
    for block in problem.blocks:
        for case in block.cases:
            case.recipe["overrides"] = {**case.recipe.get("overrides", {}), **document["parameters"]}


def build_scenarios(paths: RepoPaths, runner: Runner) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Build all 91 specs using preserved v2 inputs and the installed solver, without fitting."""
    config, document, archive = historical_inputs(paths)
    calibrated = calibrated_values(document)
    scenarios, original_specs = [], {}
    fixed_values = None
    for definition in SCENARIOS:
        variant = copy.deepcopy(config)
        variant["n_classes"] = definition["n_classes"]
        options = variant["blocks"]["V1"].setdefault("case_options", {})
        options.update(psd_source=definition["psd_source"], sauter_offset_sd=definition.get("sauter_offset_sd", 0.0))
        problem = build_problem(paths, variant, blocks=["V1"], runner=runner)
        preserve_shared_values(problem, document)
        if any(p.id in calibrated and not p.lower <= calibrated[p.id] <= p.upper for p in problem.params):
            raise ValueError("preserved calibration lies outside the current bounds; refusing to clip it")
        values = problem.values(_calibration_x(problem, calibrated))
        if fixed_values is not None and values != fixed_values:
            raise ValueError("particle-input variants changed the fixed calibration values")
        fixed_values = values
        block = problem.blocks[0]
        if sorted(c.info["experiment"] for c in block.cases) != list(EXPERIMENTS):
            raise ValueError("particle-input audit requires all 15 V1 experiments")
        specs = []
        for case in block.cases:
            spec = block.spec_for(case, values, problem.params)
            experiment = case.info["experiment"]
            if definition["id"] == "original16":
                original_specs[experiment] = spec
            if definition.get("original_air_tau"):
                spec["hydraulics"]["pore_air"]["tau_s"] = original_specs[experiment]["hydraulics"]["pore_air"]["tau_s"]
            if spec["hydraulics"]["permeability_m2"] != original_specs[experiment]["hydraulics"]["permeability_m2"]:
                raise ValueError("a particle-input variant changed a fixed bare permeability")
            if definition.get("retain_wet16_non_class_fields"):
                nominal = next(s for s in scenarios if s["definition"]["id"] == "wet16")
                reference = next(s for c, s in zip(nominal["cases"], nominal["specs"])
                                 if c.info["experiment"] == experiment)
                classes = spec["bed"]["size_classes"]
                spec = copy.deepcopy(reference)
                spec["bed"]["size_classes"] = classes
            specs.append(spec)
        scenarios.append({"definition": dict(definition), "case_options": dict(options),
                          "cases": block.cases, "specs": specs})
    nominal = next(s for s in scenarios if s["definition"]["id"] == "wet16")
    centre_index = next(i for i, case in enumerate(nominal["cases"]) if case.info["experiment"] == 7)
    refined_spec = copy.deepcopy(nominal["specs"][centre_index])
    refined_spec["numerics"]["max_dt_s"] *= 0.5
    scenarios.append({"definition": {"id": "wet16_half_dt_exp7", "label": "Wet, half dt (experiment 7)",
                                      "psd_source": "wet_cdf", "n_classes": 16, "max_dt_factor": 0.5},
                      "case_options": nominal["case_options"], "cases": [nominal["cases"][centre_index]],
                      "specs": [refined_spec]})
    calibration = {"label": "v2", "all_preserved_values": calibrated, "applied_v1_values": fixed_values,
                   "config": config, "fitted_in_this_run": False, "shared_values_applied_as_overrides": True,
                   "historical_report": HISTORICAL_REPORT, "historical_solver": archive["solver"]}
    return scenarios, calibration, block.data


def record_case(case: Case, spec: Mapping[str, Any], result: Mapping[str, Any]) -> dict[str, Any]:
    """Retain failures and partial observations, but mark coverage before any scoring."""
    row = {"case": case.name, "experiment": case.info["experiment"], "info": case.info, "spec": spec,
           "summary": result.get("summary", {}), "diagnostics": result.get("diagnostics", {}),
           "completed": False, "failure": None, "observations": None}
    if "error" in result:
        row["failure"] = f"simulation: {result['error']}"
        return row
    try:
        series, summary = result["series"], result["summary"]
        end_mass = series["beverage_mass_kg"][-1]
        required = max(spec["machine"]["stop"]["beverage_mass_kg"], 0.060,
                       max(window["end_g"] for window in case.info["windows"]) / 1e3)
        row.update(last_time_s=series["t_s"][-1], last_beverage_mass_kg=end_mass, required_beverage_mass_kg=required)
        row["completed"] = (summary["stop_reason"] == "beverage_mass" and _finite(end_mass)
                            and end_mass >= required - 1e-10)
        row["observations"] = sch.observe(case, result)
        if not row["completed"]:
            row["failure"] = f"incomplete: stop={summary['stop_reason']}, final mass={end_mass!r} kg, required={required:g} kg"
        else:
            missing = [f"{kind}/{analyte}" + (f"/{int(m)}g" if kind == "cup_eq3" else "")
                       for analyte, _, _, _ in sch.ANALYTES for kind in ("lambda", "cup_eq3")
                       for m in (sch.CUP_MASSES_G if kind == "cup_eq3" else (None,))
                       if not _finite(_at(row["observations"], kind, analyte, int(m)) if m is not None
                                      else _at(row["observations"], kind, analyte))]
            if missing:
                row["failure"] = "missing or nonfinite observations: " + ", ".join(missing)
    except (ValueError, KeyError, IndexError, TypeError, ZeroDivisionError) as exc:
        row["completed"] = False
        row["failure"] = f"observation: {type(exc).__name__}: {exc}"
    return row


def _range(values: Sequence[Any]) -> dict[str, Any]:
    finite = [float(value) for value in values if _finite(value)]
    return {"min": min(finite) if finite else None, "max": max(finite) if finite else None, "count": len(finite)}


def summarize_scenario(rows: Sequence[Mapping[str, Any]], targets: Mapping[Any, Any]) -> dict[str, Any]:
    complete = [row for row in rows if row["completed"]]
    score = score_v1(rows, targets)
    failures = [{"case": row["case"], "experiment": row["experiment"], "reason": row["failure"]}
                for row in rows if row["failure"]]
    for experiment in EXPERIMENTS:
        comparisons = [r for r in score["comparisons"] if r["experiment"] == experiment]
        missing = sum(c["missing_reason"] is not None for r in comparisons for c in [r["lambda"], *r["cups"].values()])
        if missing and not any(row["experiment"] == experiment for row in failures):
            failures.append({"experiment": experiment, "reason": f"{missing}/16 V1 predictions missing or nonfinite"})
    return {"requested": len(rows), "completed": len(complete), "score": score, "failures": failures,
            "first_drops_s": _range([_at(row, "summary", "first_drops_s") for row in complete]),
            "shot_time_s": _range([_at(row, "summary", "shot_time_s") for row in complete]),
            "max_mass_balance_error": max((abs(row["diagnostics"]["mass_balance_error"]) for row in rows
                                            if _finite(_at(row, "diagnostics", "mass_balance_error"))), default=None),
            "max_carrier_balance_error": max((abs(row["diagnostics"]["hydraulic_volume_balance_error"]) for row in rows
                                               if _finite(_at(row, "diagnostics", "hydraulic_volume_balance_error"))), default=None)}


def refinement_comparison(nominal: Mapping[str, Any], refined: Mapping[str, Any]) -> dict[str, Any]:
    metrics = []
    for label, path in [("first_drops_s", ("summary", "first_drops_s")),
                        ("shot_time_s", ("summary", "shot_time_s")), ("tds", ("summary", "tds")),
                        ("ey", ("summary", "ey")), ("mass_balance_error", ("diagnostics", "mass_balance_error")),
                        ("carrier_balance_error", ("diagnostics", "hydraulic_volume_balance_error"))]:
        a, b = _at(nominal, *path), _at(refined, *path)
        metrics.append({"metric": label, "nominal": a, "half_dt": b,
                        "difference": b - a if _finite(a) and _finite(b) else None})
    differences = {"lambda": [], "cups": []}
    for analyte, _, _, _ in sch.ANALYTES:
        paths = [("lambda", ("lambda", analyte)),
                 *[("cups", ("cup_eq3", analyte, int(m))) for m in sch.CUP_MASSES_G]]
        for kind, path in paths:
            a, b = _at(nominal, "observations", *path), _at(refined, "observations", *path)
            differences[kind].append({"analyte": analyte, "mass_g": path[-1] if kind == "cups" else None,
                                      "nominal": a, "half_dt": b,
                                      "relative_change": b / a - 1.0 if _finite(a) and a != 0 and _finite(b) else None})
    return {"experiment": 7, "both_completed": nominal["completed"] and refined["completed"],
            "nominal_max_dt_s": nominal["spec"]["numerics"]["max_dt_s"],
            "refined_max_dt_s": refined["spec"]["numerics"]["max_dt_s"], "metrics": metrics,
            **differences, **{f"max_abs_{kind}_relative_change": max(
                (abs(r["relative_change"]) for r in rows if _finite(r["relative_change"])), default=None)
                for kind, rows in differences.items()}}


def audit_hashes(paths: RepoPaths) -> dict[str, Any]:
    files = ("data/calibration/v2.yaml", HISTORICAL_REPORT,
             "data/schema/units.yaml",
             "python/puckworks_tools/particle_inputs.py", "python/puckworks_tools/sources/schmieder2023_psd.py",
             "python/puckworks_tools/validate.py", "python/puckworks_tools/identity.py",
             "python/puckworks_tools/units.py", "python/puckworks_tools/registry.py", "python/puckworks_tools/yamlio.py",
             "python/puckworks_tools/paths.py")
    return {**input_hashes(paths, HISTORICAL_REPORT, [*sch.DATASETS, sch.PSD_DATASET]),
            "config_source": f"{HISTORICAL_REPORT}:calibration.config",
            "registry_tree_sha256": tree_sha256(paths.params_dir),
            "files_sha256": {name: file_sha256(paths.root / name) for name in files}}


def run_audit(paths: RepoPaths, *, jobs: int = 3, progress: Callable[[str], None] | None = None) -> dict[str, Any]:
    if jobs < 1:
        raise ValueError("jobs must be positive")
    before, solver_before = audit_hashes(paths), solver_identity(paths)
    runner = Runner(jobs=jobs, cache_size=16)
    report_scenarios = []
    try:
        scenarios, calibration, data = build_scenarios(paths, runner)
        targets = sch.targets(data)
        for scenario in scenarios:
            definition = scenario["definition"]
            if progress:
                progress(f"{definition['label']}: {len(scenario['cases'])} shots")
            results = runner.run(scenario["specs"])
            rows = [record_case(case, spec, result)
                    for case, spec, result in zip(scenario["cases"], scenario["specs"], results)]
            out = {**definition, "case_options": scenario["case_options"], "rows": rows}
            if len(rows) == len(EXPERIMENTS):
                out["summary"] = summarize_scenario(rows, targets)
            report_scenarios.append(out)
        robustness = runner.robustness()
        robustness["warnings"] = sorted(runner.warnings)
    finally:
        runner.close()
    nominal = next(s for s in report_scenarios if s["id"] == "wet16")
    original = report_scenarios[0]
    psds = []
    for grind in sch.D43_WET_UM:
        old = next(row for row in original["rows"] if row["info"]["grind_level"] == grind)
        new = next(row for row in nominal["rows"] if row["info"]["grind_level"] == grind)
        original_psd = bimodal_psd(de_brouckere_um=sch.D43_WET_UM[grind], fines_weight=sch.FINES_WEIGHT)
        psds.append({"grind_level": grind, "original": old["info"]["psd"], "wet": new["info"]["psd"],
                     "original_classes": old["info"]["class_psd"], "wet_classes": new["info"]["class_psd"],
                     "original_air_tau_s": old["spec"]["hydraulics"]["pore_air"]["tau_s"],
                     "wet_air_tau_s": new["spec"]["hydraulics"]["pore_air"]["tau_s"],
                     "original_sigma_ln_permeability": old["spec"]["bed"]["heterogeneity"]["sigma_ln_permeability"],
                     "wet_sigma_ln_permeability": new["spec"]["bed"]["heterogeneity"]["sigma_ln_permeability"],
                     "original_grid": {"diameter_um": original_psd.diameter_um.tolist(),
                                       "volume_fraction": original_psd.weight.tolist()},
                     "resolved_cdf": [row for row in data["psd"] if row["grind_level"] == grind]})
    centre = next(row for row in nominal["rows"] if row["experiment"] == 7)
    baseline_score = original["summary"]["score"]
    source = load_yaml(paths.datasets_dir / sch.PSD_DATASET / "dataset.yaml")
    after, solver = audit_hashes(paths), solver_identity(paths)
    if after != before or solver != solver_before:
        raise RuntimeError("audit inputs or solver changed during the run; rerun on the final sources")
    if sum(len(s["rows"]) for s in report_scenarios) != 91:
        raise RuntimeError("particle-input audit did not retain all 91 requested rows")
    return strict_data({"schema": "puckworks.particle-input-audit/1", "tools_version": __version__,
                        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                        "solver": solver, "inputs": after, "jobs": jobs, "requested_shots": 91,
                        "source": source,
                        "source_basis": list(SOURCE_BASIS), "calibration": calibration,
                        "targets": targets, "psds": psds, "scenarios": report_scenarios,
                        "refinement": refinement_comparison(centre, report_scenarios[-1]["rows"][0]),
                        "baseline_reference": {"lambda_within": 48, "cup_within": 163,
                                               "historical_core_version": calibration["historical_solver"]["puckcore_version"],
                                               "same_physical_model": all(
                                                   solver["sources_sha256"][name] == calibration["historical_solver"]["sources_sha256"][name]
                                                   for name in ("crates/puckcore/src", "crates/puckmodel/src")),
                                               "reproduced": baseline_score["lambda_within"] == 48
                                               and baseline_score["cup_within"] == 163},
                        "robustness": robustness})


def _fmt(value: Any, digits: int = 4) -> str:
    return f"{value:.{digits}g}" if _finite(value) else "—"


def render_markdown(report: Mapping[str, Any]) -> str:
    lines = ["<!-- SPDX-License-Identifier: GPL-2.0-or-later -->", "# Fixed-parameter particle-input audit", "",
             f"Generated {report['created']}; tools {report['tools_version']}; puckcore "
             f"{report['solver']['puckcore_version']}. {report['requested_shots']} requested shots, "
             f"{report['robustness']['simulations']} solver evaluations, {report['jobs']} workers.", "",
             "All six variants were declared before this run. Every shared and nuisance fit parameter "
             "stays fixed at v2; no variant is selected for promotion.", "",
             f"Source: [{report['source']['citation']}]({report['source']['url']}) "
             f"({report['source']['licence']}).", ""]
    lines.extend(paragraph + "\n" for paragraph in report["source_basis"])
    reference = report["baseline_reference"]
    if "same_physical_model" in reference and not reference["same_physical_model"]:
        lines += [f"This is a replay of preserved v2 fit values on a changed solver, not a reproduction "
                  f"of the archived puckcore {reference['historical_core_version']} calculation. The "
                  "archived configuration and every shared fitted value are applied explicitly; current "
                  "unfitted registry assumptions and solver physics are recorded in this run's identity. "
                  "Historical score counts are reference values only.", ""]
    lines += ["## Particle inputs", "", "Original and reconstructed wet distributions before size-class reduction. "
              "Diameters are in µm. Head diameters are derived; the head share is a volume fraction.", "",
              "| GL | Original D32 | Wet D32 | Original D43 | Wet D43 | Reported wet D43 ± SD | Head share | Head diameter |",
              "|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for row in report["psds"]:
        old, wet = row["original"], row["wet"]
        lines.append(f"| {row['grind_level']} | {_fmt(old['d32_um'])} | {_fmt(wet['d32_um'])} | "
                     f"{_fmt(old['d43_um'])} | {_fmt(wet['d43_um'])} | {_fmt(wet['reported_d43_um'])} ± "
                     f"{_fmt(wet['reported_d43_sd_um'])} | {_fmt(wet['unresolved_head_fraction'])} | "
                     f"{_fmt(wet['unresolved_head_diameter_um'])} |")
    lines += ["", "Derived startup and preparation inputs also change in the nominal comparison:", "",
              "| GL | Original air τ (s) | Wet air τ (s) | Original σ(ln κ) | Wet σ(ln κ) |",
              "|---:|---:|---:|---:|---:|"]
    for row in report["psds"]:
        lines.append(f"| {row['grind_level']} | {_fmt(row['original_air_tau_s'])} | {_fmt(row['wet_air_tau_s'])} | "
                     f"{_fmt(row['original_sigma_ln_permeability'])} | {_fmt(row['wet_sigma_ln_permeability'])} |")
    lines += ["", "The JSON also records each distribution's and each finite class set's D32, D43 and "
              "volume share below 100 µm, along with every final spec. Class labels give the requested "
              "maximum; empty size intervals need no class.", "", "## Fixed-parameter results", "",
              "Ranges are over completed shots. Balance residuals are the solver's relative diagnostics; "
              "their maxima include all returned shots. Missing values remain in the score denominators.", "",
              "| Variant | Complete | λ within 10% | Cups within 10% | Missing λ / cups | First drops (s) | Shot time (s) | Max mass residual | Max carrier residual |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for scenario in report["scenarios"]:
        if "summary" not in scenario:
            continue
        summary, score = scenario["summary"], scenario["summary"]["score"]
        first, time = summary["first_drops_s"], summary["shot_time_s"]
        lines.append(f"| {scenario['label']} | {summary['completed']}/15 | {score['lambda_within']}/60 | "
                     f"{score['cup_within']}/180 | {score['lambda_missing']} / {score['cup_missing']} | "
                     f"{_fmt(first['min'])}–{_fmt(first['max'])} | {_fmt(time['min'])}–{_fmt(time['max'])} | "
                     f"{_fmt(summary['max_mass_balance_error'], 3)} | {_fmt(summary['max_carrier_balance_error'], 3)} |")
    reproduced = report["baseline_reference"]["reproduced"]
    comparison = ("was reproduced." if reproduced else "was NOT reproduced; this discrepancy requires review.")
    if reference.get("same_physical_model") is False:
        comparison = "is historical; score equality is not required after a model change."
    lines += ["", "The original-input reference of λ 48/60 and cups 163/180 " + comparison, "",
              "## Experiment 7 timestep check", ""]
    refined = report["refinement"]
    lines += [f"Wet, 16 classes: max dt {_fmt(refined['nominal_max_dt_s'])} → "
              f"{_fmt(refined['refined_max_dt_s'])} s; both shots completed: {refined['both_completed']}.", "",
              "| Metric | Nominal dt | Half dt | Difference |", "|---|---:|---:|---:|"]
    for row in refined["metrics"]:
        lines.append(f"| {row['metric']} | {_fmt(row['nominal'], 7)} | {_fmt(row['half_dt'], 7)} | {_fmt(row['difference'], 3)} |")
    lines += ["", f"Maximum absolute relative change: λ {_fmt(refined['max_abs_lambda_relative_change'], 3)}, "
              f"Eq. 3 cups {_fmt(refined['max_abs_cups_relative_change'], 3)}. "
              "This single check does not establish convergence for all conditions or unresolved particle shapes.", "",
              "## Failures and missing observations", ""]
    failures = []
    for scenario in report["scenarios"]:
        if "summary" in scenario:
            failures.extend((scenario["label"], row) for row in scenario["summary"]["failures"])
        else:
            failures.extend((scenario["label"], {"experiment": row["experiment"], "reason": row["failure"]})
                            for row in scenario["rows"] if row["failure"])
    lines += ([f"- {label}, experiment {row['experiment']}: {row['reason']}" for label, row in failures]
              if failures else ["None. All requested shots completed and all scored predictions were finite."])
    lines += ["", "## Reproduction and identity", "", "```sh",
              "python -m puckworks_tools.particle_inputs --jobs 3 --output-dir .local/particle-inputs-v0.5.1",
              "```", "", "The adjacent JSON contains the source sidecar, final specs, observations, diagnostics, "
              "parameter values, solver identity and input hashes. All NaN/Infinity observations are stored as null. "
              f"It can regenerate this report using `--from-json {REPORT_NAME}.json --output-dir PATH`.", "",
              f"Compiled extension SHA-256 prefix: `{report['solver'].get('extension_sha256')}`. "
              f"Audit source SHA-256 prefix: `{report['inputs']['files_sha256'].get('python/puckworks_tools/particle_inputs.py')}`.", ""]
    if report.get("figure_files"):
        lines += [f"![{name.removesuffix('.png').replace('-', ' ')}]({name})\n" for name in report["figure_files"]]
    return "\n".join(lines)


def write_figures(report: Mapping[str, Any], output: Path) -> list[Path]:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return []
    figure, axes = plt.subplots(2, 3, figsize=(13, 7), sharex="col", constrained_layout=True)
    for column, row in enumerate(report["psds"]):
        d = np.asarray(row["original_grid"]["diameter_um"])
        w = np.asarray(row["original_grid"]["volume_fraction"])
        logs = np.log10(d)
        axes[0, column].plot(d, w / np.gradient(logs), label="Original")
        axes[1, column].plot(d, np.cumsum(w) - 0.5 * w, label="Original")
        curve = row["resolved_cdf"]
        cd = np.array([r["diameter_um"] for r in curve])
        cq = np.array([r["cumulative_volume_fraction"] for r in curve])
        curve_d, curve_q = [], []
        for i, mass in enumerate(np.diff(cq)):
            dd = np.geomspace(cd[i], cd[i + 1], 16)
            axes[0, column].plot(dd, mass / (cd[i + 1] - cd[i]) * dd * math.log(10),
                                color="tab:orange", label="Wet resolved density" if i == 0 else None)
            curve_d.extend(dd)
            curve_q.extend(cq[i] + mass * (dd - cd[i]) / (cd[i + 1] - cd[i]))
        head = row["wet"]["unresolved_head_diameter_um"]
        share = row["wet"]["unresolved_head_fraction"]
        axes[0, column].axvline(head, color="tab:orange", linestyle=":", label=f"Derived head atom ({100*share:.2f}%)")
        axes[1, column].plot([head, head, *curve_d], [0, share, *curve_q],
                            color="tab:orange", label="Wet + derived head")
        axes[1, column].scatter(cd[:-1], [r["raw_cumulative_volume_fraction"] for r in curve[:-1]],
                                s=10, color="black", alpha=0.5, label="Raw resolved readings")
        axes[1, column].scatter(cd[-1:], cq[-1:], s=24, color="black", marker="x", label="Assumed terminal support")
        for ax in axes[:, column]:
            ax.set_xscale("log")
            ax.grid(alpha=0.2)
        axes[0, column].set_title(f"Grinding level {row['grind_level']}")
        axes[1, column].set_xlabel("Diameter (µm)")
        axes[1, column].set_ylim(0, 1.02)
    axes[0, 0].set_ylabel("Volume fraction per log₁₀ diameter")
    axes[1, 0].set_ylabel("Cumulative volume fraction")
    axes[0, 0].legend(fontsize=7)
    axes[1, 0].legend(fontsize=7)
    figure.suptitle("Schmieder et al. 2023, Fig. A1(b)/§2.4 · CC BY 4.0 · Puckworks reconstruction", fontsize=10)
    psd_path = output / f"{REPORT_NAME}-distributions.png"
    figure.savefig(psd_path, dpi=180)
    plt.close(figure)
    scenarios = [s for s in report["scenarios"] if "summary" in s]
    figure, ax = plt.subplots(figsize=(10, 4.5), constrained_layout=True)
    x = np.arange(len(scenarios))
    ax.bar(x - 0.18, [s["summary"]["score"]["lambda_within"] / 60 for s in scenarios], 0.36, label="λ / 60")
    ax.bar(x + 0.18, [s["summary"]["score"]["cup_within"] / 180 for s in scenarios], 0.36, label="Eq. 3 cups / 180")
    ax.set_xticks(x, [s["label"] for s in scenarios], rotation=18, ha="right")
    ax.set_ylim(0, 1.05)
    ax.set_ylabel("Share within the existing ±10% target")
    ax.set_title("Fixed v2 parameters; incomplete or missing predictions remain in denominators")
    ax.legend()
    score_path = output / f"{REPORT_NAME}-scores.png"
    figure.savefig(score_path, dpi=180)
    plt.close(figure)
    return [psd_path, score_path]


def write_report(report: Mapping[str, Any], output: Path, *, figures: bool = True) -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    clean = strict_data(report)
    figure_paths = write_figures(clean, output) if figures else []
    if figures:
        clean["figure_files"] = [path.name for path in figure_paths]
    markdown, data = output / f"{REPORT_NAME}.md", output / f"{REPORT_NAME}.json"
    markdown.write_text(render_markdown(clean), encoding="utf-8")
    data.write_text(json.dumps(clean, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return [markdown, data, *figure_paths]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--output-dir", type=Path, default=Path(f".local/particle-inputs-v{__version__}"))
    parser.add_argument("--from-json", type=Path, help="regenerate a report without simulation")
    parser.add_argument("--no-figures", action="store_true")
    args = parser.parse_args(argv)
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    if args.from_json:
        report = json.loads(args.from_json.read_text(encoding="utf-8"))
        if report.get("schema") != "puckworks.particle-input-audit/1":
            parser.error("--from-json needs a particle-input audit report")
    else:
        report = run_audit(RepoPaths(find_repo_root(args.root)), jobs=args.jobs,
                           progress=lambda message: print(message, flush=True))
    for path in write_report(report, args.output_dir, figures=not args.no_figures):
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
