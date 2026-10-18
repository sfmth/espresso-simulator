# SPDX-License-Identifier: GPL-2.0-or-later
"""Reproducible M3 software and mechanistic checks, without sensory validation claims.

The scenario supports and taste coefficients are estimated. These checks establish
determinism, knowledge-state behaviour and mapping directions, not empirical
interval coverage, panel-score accuracy or completion of the M1/M2 science gates.
"""

from __future__ import annotations

import copy
import datetime
import hashlib
import json
import math
import time
from pathlib import Path
from types import ModuleType
from typing import Any, Mapping

from .calibrate import load_calibration_document
from .cases.common import core
from .identity import file_sha256, solver_identity
from .paths import RepoPaths
from .registry import load_registry

REPORT_NAME = "m3-validation"
DEFAULT_SEED = 20261018
DEFAULT_SAMPLES = 16
TASTE_AXES = ("acidity", "bitterness", "astringency", "body")
LIMITATIONS = [
    "Checks are software verification and mechanistic direction checks, not independent sensory validation.",
    "The scenario distributions and widths are estimated modelling judgements; empirical coverage is unmeasured.",
    "Scenario quantiles omit structural model error, kinetic uncertainty and taste-mapping error.",
    "Taste indices are relative explanatory indices, not panel scores, liking or coffee quality.",
    "Dilution checks hold the extracted cup inventory fixed and add water; they do not predict a longer extraction.",
    "Tier 0 versus Tier 1 discrepancy is reported separately and is not absorbed by enlarging scenario bands.",
    "M1 fit values are preserved, but their prior scientific limitations and the blocked M2 V7 gate remain.",
    "Timing is a local wall-clock observation including Python boundary overhead, not a browser performance guarantee.",
]


def recipe(paths: RepoPaths) -> dict[str, Any]:
    """A fixed, ordinary 18 g scenario; no observations enter these input choices."""
    fitted = load_calibration_document(paths.root / "data/calibration/current.yaml")
    return {
        "schema": "puckworks.recipe/1",
        "bean": {"preset": "medium-washed-arabica", "days_off_roast": 10.0},
        "grinder": {"preset": "mahlkoenig-ek43", "setting": 1.7},
        "basket": {"preset": "58-precision-18g"},
        "prep": {"dose_g": 18.0},
        "machine": {"preset": "flat-9-bar", "temperature_c": 93.0},
        "stop": {"beverage_g": 36.0, "time_s": 35.0},
        "water": {"alkalinity_mg_l_caco3": 40.0, "hardness_mg_l_caco3": 70.0,
                  "calcium_mg_l": 17.0, "magnesium_mg_l": 6.6, "tds_mg_l": 100.0, "ph": 7.0},
        "chemistry": {"enabled": True},
        "numerics": {"tier": 1},
        "overrides": fitted.get("parameters", {}),
    }


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _check(name: str, passed: bool, detail: Any) -> dict[str, Any]:
    return {"check": name, "status": "pass" if passed else "fail", "detail": detail,
            "evidence_type": "software/mechanistic verification"}


def _digest(value: Any) -> str:
    """Hash serialisable scientific outputs, with no platform-specific timing."""
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def compare_dilution(undiluted: Mapping[str, Any], diluted: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Direction only: fixed coffee inventory plus water should lower each index."""
    checks = []
    for axis in TASTE_AXES:
        key = f"{axis}_index"
        before, after = undiluted.get(key), diluted.get(key)
        passed = _finite(before) and _finite(after) and 0 <= after < before <= 100
        checks.append(_check(f"pure dilution lowers {axis}", passed,
                             {"undiluted_index": before, "diluted_index": after}))
    return checks


def unavailable_taste_check(name: str, estimate: Mapping[str, Any], expected_status: str) -> dict[str, Any]:
    """Unavailable chemistry or an empty cup must never acquire invented scores."""
    values = {f"{axis}_index": estimate.get(f"{axis}_index") for axis in TASTE_AXES}
    passed = estimate.get("status") == expected_status and all(value is None for value in values.values())
    return _check(name, passed, {"expected_status": expected_status, "status": estimate.get("status"), **values})


def calibration_audit(paths: RepoPaths, before_sha256: str | None) -> dict[str, Any]:
    """Check read-only calibration preservation and values against the existing M1 report."""
    calibration_path = paths.root / "data/calibration/current.yaml"
    document = load_calibration_document(calibration_path)
    baseline_path = paths.validation_dir / "m1-validation.json"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    parameters = document.get("parameters", {})
    baseline_parameters = baseline.get("parameters", {})
    mismatches = {key: {"current": value, "m1_report": baseline_parameters.get(key, {}).get("value")}
                  for key, value in parameters.items()
                  if not (_finite(baseline_parameters.get(key, {}).get("value")) and math.isclose(
                      value, baseline_parameters[key]["value"], rel_tol=1e-12, abs_tol=0.0))}
    after = file_sha256(calibration_path)
    return {
        "calibration_file": paths.relative(calibration_path),
        "sha256_before": before_sha256, "sha256_after": after,
        "file_unchanged": before_sha256 is not None and before_sha256 == after,
        "shared_parameter_count": len(parameters),
        "baseline_report": paths.relative(baseline_path),
        "baseline_report_sha256": file_sha256(baseline_path),
        "parameters_match_m1_report": bool(parameters) and not mismatches,
        "comparison_relative_tolerance": 1e-12,
        "parameter_mismatches": mismatches,
        "fitted": False,
        "scope": "Preservation of existing fit values, not a new assessment of empirical fit quality.",
    }


def registry_audit(paths: RepoPaths) -> dict[str, Any]:
    records = load_registry(paths)
    entries = [{"id": key, "tag": row.get("tag"), "evidence_grade": row.get("evidence_grade"),
                "value": row.get("value"), "units": row.get("units")}
               for key, row in sorted(records.items()) if key.startswith(("uncertainty.", "taste."))]
    families = {prefix: any(entry["id"].startswith(prefix) for entry in entries)
                for prefix in ("uncertainty.", "taste.")}
    return {"entries": entries, "families_present": families, "complete": all(families.values()) and all(
        entry["tag"] == "estimated" and entry["evidence_grade"] == "D" for entry in entries),
        "interpretation": "Estimated scenario supports and heuristic taste coefficients; provenance is not calibration."}


def audit_taste(estimate: Mapping[str, Any], registry: Mapping[str, Any]) -> list[str]:
    """Require bounded indices, limited trust labels and inspectable, resolved drivers."""
    problems = []
    if estimate.get("status") != "estimated" or estimate.get("trust") != "low":
        problems.append("taste must identify the estimates as low trust")
    attributes = {row["id"]: row for row in estimate.get("attributes", [])}
    if set(attributes) != set(TASTE_AXES):
        problems.append("the four requested taste dimensions are not present")
    sources = {row["id"] for row in estimate.get("sources", [])}
    for axis in TASTE_AXES:
        value = estimate.get(f"{axis}_index")
        if not _finite(value) or not 0 <= value <= 100:
            problems.append(f"{axis}: index is not finite and bounded")
        attribute = attributes.get(axis, {})
        if attribute.get("index") != value:
            problems.append(f"{axis}: attribute and top-level indices differ")
        if attribute.get("trust") != ("very_low" if axis == "astringency" else "low"):
            problems.append(f"{axis}: missing appropriately limited trust label")
        if not attribute.get("assumptions") or not attribute.get("drivers"):
            problems.append(f"{axis}: missing explanation or drivers")
        for driver in attribute.get("drivers", []):
            if not _finite(driver.get("value")) or not _finite(driver.get("contribution")):
                problems.append(f"{axis}: nonfinite driver")
            if not driver.get("registry_refs") or any(ref not in registry for ref in driver["registry_refs"]):
                problems.append(f"{axis}: unresolved driver registry reference")
            if not driver.get("source_refs") or any(ref not in sources for ref in driver["source_refs"]):
                problems.append(f"{axis}: unresolved driver evidence reference")
    return problems


def audit_bands(ensemble: Mapping[str, Any]) -> list[str]:
    """Reject missing members, nonfinite or unordered quantiles, and misleading labels."""
    problems = []
    requested, completed = ensemble.get("samples_requested"), ensemble.get("samples_completed")
    if requested != completed or ensemble.get("sample_failures"):
        problems.append(f"only {completed}/{requested} members succeeded")
    if ensemble.get("band_kind") != "scenario_percentiles_not_confidence_interval":
        problems.append("band_kind does not explicitly disclaim confidence intervals")
    if ensemble.get("ensemble_tier") != 0:
        problems.append("ensemble members are not identified as Tier 0")
    bands = ensemble.get("bands", {})
    if not bands:
        problems.append("no scalar bands")
    series = ensemble.get("series", {})
    if series.get("time_basis") != "fraction_of_recorded_duration_including_drip":
        problems.append("trajectory coordinate is not explicitly fractional recorded duration")
    progress = series.get("progress", [])
    if (len(progress) < 2 or not all(_finite(value) for value in progress)
            or progress[0] != 0 or progress[-1] != 1
            or any(a >= b for a, b in zip(progress, progress[1:]))):
        problems.append("trajectory progress must increase strictly from 0 to 1")
    scalar_and_series = list(bands.items())
    for key, values in series.get("bands", {}).items():
        if len(values) != len(progress):
            problems.append(f"trajectory {key}: band count does not match progress")
        scalar_and_series.extend((f"trajectory/{key}/{index}", band) for index, band in enumerate(values))
    for key, band in scalar_and_series:
        values = [band.get(k) for k in ("min", "p05", "p50", "p95", "max")]
        if not all(_finite(value) for value in values) or values != sorted(values):
            problems.append(f"{key}: nonfinite or unordered quantiles")
        if (not isinstance(completed, int) or not isinstance(band.get("n"), int)
                or isinstance(band["n"], bool) or not 0 < band["n"] <= completed):
            problems.append(f"{key}: invalid sample count")
    return problems


def _width(ensemble: Mapping[str, Any], key: str) -> float | None:
    band = ensemble.get("bands", {}).get(key)
    return band["p95"] - band["p05"] if band else None


def _options(state: str, seed: int, samples: int) -> dict[str, Any]:
    return {"samples": samples, "seed": seed,
            "groups": {key: state for key in ("grinder_psd", "roast_age", "composition", "water")}}


def run(paths: RepoPaths, output_dir: Path, *, seed: int = DEFAULT_SEED, samples: int = DEFAULT_SAMPLES,
        module: ModuleType | None = None) -> dict[str, Any]:
    """Exercise the actual public Python API and save the reviewable checks."""
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2**32 - 1:
        raise ValueError("seed must be an integer from 0 to 4294967295")
    if not isinstance(samples, int) or isinstance(samples, bool) or not 8 <= samples <= 64:
        raise ValueError("samples must be an integer from 8 to 64")
    engine = core(module)
    for name in ("simulate_uncertainty", "estimate_taste"):
        if not callable(getattr(engine, name, None)):
            raise ValueError(f"puckcore.{name} is unavailable; rebuild the M3 Python extension")
    calibration_before = file_sha256(paths.root / "data/calibration/current.yaml")
    base = recipe(paths)
    timing: dict[str, float] = {}

    def timed(name: str, function: Any, *args: Any) -> Any:
        start = time.perf_counter()
        value = function(*args)
        timing[name] = time.perf_counter() - start
        return value

    central = timed("central_tier1", engine.simulate_recipe, base)["result"]
    preview_recipe = copy.deepcopy(base)
    preview_recipe["numerics"]["tier"] = 0
    preview = timed("central_tier0", engine.simulate_recipe, preview_recipe)["result"]
    ensembles = {}
    for state in ("unknown", "fixed", "measured"):
        ensembles[state] = timed(f"ensemble_{state}", engine.simulate_uncertainty,
                                 base, _options(state, seed, samples))
    replay = timed("ensemble_unknown_replay", engine.simulate_uncertainty,
                   base, _options("unknown", seed, samples))
    unknown, fixed, measured = (ensembles[key] for key in ("unknown", "fixed", "measured"))
    replay_hash, original_hash = _digest(replay), _digest(unknown)
    checks = [_check("seeded scientific output replays exactly", replay_hash == original_hash,
                     {"first_sha256": original_hash, "replay_sha256": replay_hash})]
    for state, ensemble in ensembles.items():
        problems = audit_bands(ensemble)
        checks.append(_check(f"{state} ensemble accounting and quantile contract", not problems, problems))
    fixed_spread = {key: band["max"] - band["min"] for key, band in fixed["bands"].items()}
    fixed_spread.update({f"trajectory/{key}/{index}": band["max"] - band["min"]
                         for key, values in fixed["series"]["bands"].items()
                         for index, band in enumerate(values)})
    nonzero_fixed = {key: width for key, width in fixed_spread.items() if width != 0}
    checks.append(_check("all fixed scalar and trajectory bands collapse", not nonzero_fixed,
                         {"bands_checked": len(fixed_spread), "nonzero_widths": nonzero_fixed}))
    fixed_differences = [index for index, result in enumerate(fixed["sample_results"])
                         if result != fixed["baseline_preview"]]
    checks.append(_check("fixed members reproduce their unperturbed Tier 0 preview", not fixed_differences,
                         {"members_checked": len(fixed["sample_results"]),
                          "members_differing_from_preview": fixed_differences}))
    unknown_keys = ["/summary/shot_time_s", "/summary/ey", "/summary/tds",
                    "/taste/acidity_index", "/taste/bitterness_index", "/taste/body_index"]
    unknown_widths = {key: _width(unknown, key) for key in unknown_keys}
    checks.append(_check("unknown inputs produce nonzero outcome ranges",
                         all(_finite(value) and value > 0 for value in unknown_widths.values()), unknown_widths))
    checks.append(_check("unknown ranges exceed fixed ranges for this scenario",
                         all(_finite(_width(fixed, key)) and value > _width(fixed, key)
                             for key, value in unknown_widths.items() if _finite(value))
                         and all(_finite(value) for value in unknown_widths.values()),
                         {key: {"fixed": _width(fixed, key), "unknown": width}
                          for key, width in unknown_widths.items()}))
    checks.append(_check("fixed preview matches independently simulated Tier 0 central summary",
                         fixed["baseline_preview"]["summary"] == preview["summary"],
                         {"independent_tier0_sha256": _digest(preview["summary"]),
                          "ensemble_preview_sha256": _digest(fixed["baseline_preview"]["summary"])}))

    undiluted = engine.estimate_taste(base, central, {})
    diluted = engine.estimate_taste(base, central, {"dilution_water_g": 36.0})
    taste_problems = audit_taste(undiluted, load_registry(paths))
    checks.append(_check("taste indices expose bounded values, limited trust and resolved drivers",
                         not taste_problems, taste_problems))
    checks.extend(compare_dilution(undiluted, diluted))
    disabled_recipe = copy.deepcopy(base)
    disabled_recipe["chemistry"]["enabled"] = False
    disabled = timed("chemistry_disabled", engine.simulate_recipe, disabled_recipe)["result"]
    disabled_taste = engine.estimate_taste(disabled_recipe, disabled, {})
    checks.append(unavailable_taste_check("disabled chemistry yields unavailable taste", disabled_taste,
                                          "chemistry_disabled"))
    empty_recipe = copy.deepcopy(base)
    empty_recipe["stop"] = {"time_s": 0.01}
    empty_recipe["machine"]["vent_headspace"] = True
    empty = timed("no_beverage", engine.simulate_recipe, empty_recipe)["result"]
    empty_taste = engine.estimate_taste(empty_recipe, empty, {})
    checks.append(unavailable_taste_check("no beverage yields unavailable taste", empty_taste, "no_cup"))
    alkalinity_cases = {}
    for label, alkalinity in (("low", 0.0), ("high", 100.0)):
        changed = copy.deepcopy(base)
        changed["water"]["alkalinity_mg_l_caco3"] = alkalinity
        result = timed(f"alkalinity_{label}", engine.simulate_recipe, changed)["result"]
        alkalinity_cases[label] = {"alkalinity_mg_l_caco3": alkalinity,
                                  "taste": engine.estimate_taste(changed, result, {}),
                                  "acidity": result.get("chemistry", {}).get("acidity", {})}
    low, high = (alkalinity_cases[label]["taste"].get("acidity_index") for label in ("low", "high"))
    checks.append(_check("higher source alkalinity lowers acidity index under fixed other inputs",
                         _finite(low) and _finite(high) and high < low,
                         {"low_alkalinity_index": low, "high_alkalinity_index": high}))

    calibration = calibration_audit(paths, calibration_before)
    checks.append(_check("M1 calibration file and fitted values preserved",
                         calibration["file_unchanged"] and calibration["parameters_match_m1_report"], calibration))
    registry = registry_audit(paths)
    checks.append(_check("scenario and taste parameters retain estimated grade D provenance",
                         registry["complete"], {"records": len(registry["entries"])}))
    quantity_keys = ["/summary/shot_time_s", "/summary/beverage_mass_kg", "/summary/tds", "/summary/ey",
                     "/chemistry/acidity/ph", "/chemistry/acidity/titratable_acidity_mmol_l_to_ph_6_6",
                     *(f"/taste/{axis}_index" for axis in TASTE_AXES)]
    widths = [{"quantity": key, **{state: _width(ensemble, key) for state, ensemble in ensembles.items()}}
              for key in quantity_keys]
    tier_comparison = []
    for key in ("shot_time_s", "beverage_mass_kg", "tds", "ey"):
        a, b = preview["summary"][key], central["summary"][key]
        tier_comparison.append({"quantity": key, "tier0": a, "tier1": b,
                                "difference": a - b, "relative_difference": (a - b) / b if b else None})
    report = {
        "schema": "puckworks.m3-validation/1", "created": datetime.date.today().isoformat(),
        "core_version": getattr(engine, "__version__", "unknown"),
        "solver_identity": solver_identity(paths, module=module), "seed": seed, "samples": samples,
        "recipe": base, "checks": checks, "timing_s": timing,
        "scenario_widths": widths, "tier_comparison": tier_comparison, "ensembles": ensembles,
        "replay": {"scientific_sha256": original_hash, "replay_sha256": replay_hash},
        "taste": {"undiluted": undiluted, "diluted_36g": diluted, "chemistry_disabled": disabled_taste,
                  "no_beverage": empty_taste, "alkalinity": alkalinity_cases},
        "calibration": calibration, "registry": registry, "limitations": LIMITATIONS,
        "empirical_interval_coverage": "unmeasured; no coverage claim",
        "independent_espresso_sensory_validation": "not established",
        "fitted_to_sensory_data": False,
        "summary": {"checks": len(checks), "failed_checks": sum(row["status"] != "pass" for row in checks),
                    "scientific_validation_gates_changed": False},
    }
    write_report(report, output_dir)
    return report


def write_report(report: Mapping[str, Any], output_dir: Path) -> tuple[Path, Path]:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"{REPORT_NAME}.json"
    markdown_path = output_dir / f"{REPORT_NAME}.md"
    json_path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return markdown_path, json_path


def render_markdown(report: Mapping[str, Any]) -> str:
    checks = report["checks"]
    lines = ["<!-- SPDX-License-Identifier: GPL-2.0-or-later -->", "# M3 uncertainty and taste checks", "",
             "These are **software and mechanistic verification checks**. Empirical interval coverage "
             "and independent espresso sensory accuracy remain **unvalidated**. No sensory panel was fitted.", "",
             f"Reproduce: `puckworks-tools m3-validate --seed {report['seed']} --samples {report['samples']}`.", "",
             "The seed reproduces scientific outputs on the same engine; timestamps, build identity "
             "and wall-clock timings are expected to differ between runs.", "",
             "## Verification checks", "", "| Check | Result |", "|---|---|"]
    lines += [f"| {row['check']} | {row['status']} |" for row in checks]
    lines += ["", "## Scenario ranges", "",
              "The table uses the ensemble's 5th–95th percentile scenario ranges. These are not "
              "90% predictive intervals or confidence intervals. A fixed input range can collapse "
              "even though model error remains.", "",
              "| Quantity | Fixed width | Measured width | Unknown width |", "|---|---:|---:|---:|"]
    for row in report.get("scenario_widths", []):
        def show(value: Any) -> str:
            return f"{value:.6g}" if _finite(value) else "unavailable"
        lines.append(f"| {row['quantity']} | {show(row['fixed'])} | {show(row['measured'])} | {show(row['unknown'])} |")
    lines += ["", "## Central solver discrepancy and timing", "",
              "Tier 0 preview discrepancies are shown separately from the input ranges; neither "
              "tier is treated as experimental truth.", "",
              "| Quantity | Tier 0 | Tier 1 | Tier 0 − Tier 1 |", "|---|---:|---:|---:|"]
    for row in report.get("tier_comparison", []):
        lines.append(f"| {row['quantity']} | {row['tier0']:.6g} | {row['tier1']:.6g} | {row['difference']:+.6g} |")
    lines += ["", "| Run | Elapsed seconds |", "|---|---:|"]
    lines += [f"| {name} | {elapsed:.6g} |" for name, elapsed in report.get("timing_s", {}).items()]
    audit = report["calibration"]
    lines += ["", "## Preserved M1 fit", "",
              f"The {audit['shared_parameter_count']} shared fitted values match the existing M1 report: "
              f"**{'yes' if audit['parameters_match_m1_report'] else 'no'}**. "
              f"Calibration file unchanged during these checks: **{'yes' if audit['file_unchanged'] else 'no'}**. "
              "No refitting was performed. This check does not close the remaining M1/M2 scientific gates.", "",
              "## Assumptions and limits", ""]
    lines += [f"- {limit}" for limit in report["limitations"]]
    lines += ["", f"Full recipes, deterministic hashes, scenario reports, taste drivers and check details: "
              f"[{REPORT_NAME}.json]({REPORT_NAME}.json).", ""]
    return "\n".join(lines)
