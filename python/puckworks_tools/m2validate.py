# SPDX-License-Identifier: GPL-2.0-or-later
"""Fixed, unfitted M2 diagnostics against held-out Gloess espresso chemistry.

These eight conditional scenarios do not establish a V7 pass: the source has no
complete PSD, basket geometry, bean chemical inventory or water alkalinity. The
published millilitres are explicitly mapped to a 1 g/mL beverage-mass proxy.
"""

from __future__ import annotations

import datetime
import json
import math
from pathlib import Path
from types import ModuleType
from typing import Any, Mapping

from .calibrate import load_calibration_document
from .cases.common import (Basket, core, ideal_pump, lognormal_mixture, minimal_recipe,
                           phase, pressure_control, read_table, set_program)
from .paths import RepoPaths
from .identity import solver_identity
from .registry import load_registry

DATASET = "gloess2013-espresso-chemistry"
REPORT_NAME = "m2-validation"
METHODS = ("DE", "SE", "DL", "SL")
SPECIES = ("caffeine", "cqa3", "cqa5")
SPECIES_TARGET = 0.25
CLOSURE_TARGET = 0.05
# Fixed before any M2 evaluation. Neither value is inferred from the outcomes.
PSD_HYPOTHESES = (("fines_10_percent", 0.10), ("fines_30_percent", 0.30))
BASKET = Basket("assumed 58 mm double basket", 58.0, 26.5, 54.0)
MASS_PROXY_G_PER_ML = 1.0
LIMITATIONS = [
    "Output volume is published; beverage mass is not. Every stop uses an explicit 1 g/mL proxy.",
    "Basket diameter 58 mm, height 26.5 mm and perforated diameter 54 mm are assumptions.",
    "Two fixed PSD hypotheses use 10% or 30% fines by volume; neither was fitted to these data.",
    "Each scenario has a 150 s numerical ceiling; failure to reach the mass proxy is reported.",
    "Boulder medians 400/600 um are proxies near the source's espresso/lungo PSD peaks, not measured medians.",
    "Schaerer PSDs are unreported; Dalla Corte nominal PSDs are applied to them as explicit proxies.",
    "A generic medium washed Arabica is used. Pt80/Pt86 have no established mapping to the model roast index.",
    "Source hardness is 4-6 dH; alkalinity, ionic composition and source pH are unreported. Registry water is a scenario.",
    "SE/SL 90 C is boiler temperature; actual extraction temperature is unreported.",
    "Published pH and TA were measured at 20 C; the current chemistry calculation references 25 C.",
    "Coffee intrinsic pH/background buffer are estimated; pH/TA agreement cannot be an independent predictive pass.",
    "Total solids are gravimetric residue, and esterified fatty acids are not identical to filtered TDS or total lipid.",
]


def load_observations(paths: RepoPaths) -> dict[str, dict[str, float]]:
    """Flatten only explicitly named bases; no silent cup/double-shot conversion."""
    output = {method: {} for method in METHODS}
    for row in read_table(paths, DATASET):
        key = f"{row['basis']}:{row['quantity']}"
        if key in output[row["method"]]:
            raise ValueError(f"duplicate Gloess observation {row['method']}: {key}")
        output[row["method"]][key] = row["value"]
    return output


def recipes(paths: RepoPaths) -> list[dict[str, Any]]:
    """Eight fixed scenarios. Source outcomes never enter chemistry priors."""
    observations = load_observations(paths)
    calibration = load_calibration_document(paths.root / "data/calibration/current.yaml")
    # Shared fitted M1 parameters only; no dataset-specific nuisance parameters.
    overrides = calibration.get("parameters", {})
    cases = []
    for method in METHODS:
        obs = observations[method]
        is_espresso = method.endswith("E")
        nominal_median = 400.0 if is_espresso else 600.0
        for hypothesis, fines in PSD_HYPOTHESES:
            psd = lognormal_mixture([(fines, 40.0, 0.6), (1.0 - fines, nominal_median, 0.35)])
            dose = obs["per_extraction:dry_dose"]
            cups = obs["per_extraction:cups_per_extraction"]
            volume = obs["per_cup:cup_volume"] * cups
            pressure = obs["per_extraction:pressure"]
            recipe = minimal_recipe(dose, psd.recipe_psd(16), BASKET,
                                    profile=[{"control": "pressure", "target": pressure}],
                                    beverage_g=volume * MASS_PROXY_G_PER_ML,
                                    temperature_c=obs["per_extraction:temperature"], overrides=overrides)
            recipe["bean"] = {"preset": "medium-washed-arabica", "days_off_roast": 10.0}
            recipe["chemistry"] = {"enabled": True, "sample_temperature_c": 20.0}
            cases.append({"id": f"{method}/{hypothesis}", "method": method,
                          "hypothesis": hypothesis, "fines_volume_fraction": fines,
                          "dose_g": dose, "published_volume_ml": volume,
                          "mass_proxy_g": volume * MASS_PROXY_G_PER_ML,
                          "pressure_bar": pressure, "observations": obs, "recipe": recipe})
    return cases


def _finite(value: Any) -> bool:
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def catalogue_audit(paths: RepoPaths) -> dict[str, Any]:
    """Resolve parameter provenance; catalogue coverage is not empirical validity."""
    species = json.loads((paths.root / "data/chemistry/species.json").read_text())["species"]
    registry = load_registry(paths)
    rows = []
    for item in species:
        refs = item.get("registry_refs", [])
        provenance = [{"id": key, "tag": registry.get(key, {}).get("tag"),
                       "evidence_grade": registry.get(key, {}).get("evidence_grade")}
                      for key in refs]
        rows.append({**item, "parameter_provenance": provenance,
                     "provenance_complete": bool(refs) and all(
                         p["tag"] in ("measured", "estimated", "fitted", "derived")
                         and p["evidence_grade"] in ("A", "B", "C", "D") for p in provenance)})
    identifiers = [row["id"] for row in rows]
    appendix_rows = [r for r in rows if r["id"] not in ("acids", "unassigned_solubles")]
    return {"rows": rows, "total": len(rows), "appendix_species": len(appendix_rows),
            "complete_with_tags": len(appendix_rows) == 55 and len(identifiers) == len(set(identifiers))
                                  and all(r["provenance_complete"] for r in rows),
            "status": "metadata coverage only; estimated species are not independent measurements"}


def compare(case: Mapping[str, Any], result: Mapping[str, Any]) -> dict[str, Any]:
    """Conditional errors plus explicit missing-data status, never a V7 pass."""
    obs = case["observations"]
    summary = result["summary"]
    chemistry = result.get("chemistry")
    masses = {s["id"]: s["mass_kg"] * 1e6 for s in summary.get("species", [])}
    comparisons = []
    for analyte in SPECIES:
        measured = obs[f"per_cup:{analyte}"] * obs["per_extraction:cups_per_extraction"]
        predicted = masses.get(analyte)
        error = predicted / measured - 1.0 if _finite(predicted) else None
        comparisons.append({"species": analyte, "measured_double_mg": measured,
                            "predicted_double_mg": predicted, "relative_error": error,
                            "eligible_for_scoring": analyte != "cqa3",
                            "model_evidence": "estimated kinetic/composition priors; unscored" if analyte == "cqa3"
                                              else "M1 measured kinetic anchor; generic bean inventory assumed",
                            "within_25_percent_under_assumptions":
                                abs(error) <= SPECIES_TARGET if error is not None else False})
    acidity = (chemistry or {}).get("acidity", {})
    acidity_rows = [{"quantity": "ph", "measured": obs["per_10_ml:ph"],
                     "predicted": acidity.get("ph"), "units": "1", "status": "not independently scored"}]
    for source, model in (("naoh_to_ph6_6", "titratable_acidity_mmol_l_to_ph_6_6"),
                          ("naoh_to_ph8", "titratable_acidity_mmol_l_to_ph_8")):
        # 0.1 mol/L * mL titrant / 10 mL coffee -> value * 10 mmol/L.
        acidity_rows.append({"quantity": source, "measured": 10.0 * obs[f"per_10_ml:{source}"],
                             "predicted": acidity.get(model), "units": "mmol/L",
                             "status": "not independently scored"})
    closure = (chemistry or {}).get("mass_closure", {})
    transport_error = closure.get("relative_transport_closure_error")
    # Never score the forced identity named_mass + residual = lumped_mass.
    closure_pass = _finite(transport_error) and abs(transport_error) <= CLOSURE_TARGET
    return {"id": case["id"], "method": case["method"], "hypothesis": case["hypothesis"],
            "status": "conditional diagnostic" if chemistry else "missing M2 chemistry",
            "published_volume_ml": case["published_volume_ml"], "mass_proxy_g": case["mass_proxy_g"],
            "recipe": case["recipe"], "compound_comparisons": comparisons,
            "acidity_comparisons": acidity_rows, "mass_closure": closure,
            "raw_transport_closure_within_5_percent": closure_pass,
            "measured_time_s": obs["per_extraction:extraction_time"],
            "predicted_time_s": summary.get("shot_time_s"),
            "beverage_g": summary.get("beverage_mass_kg", 0) * 1000,
            "stop_reason": summary.get("stop_reason"),
            "reached_mass_proxy": summary.get("stop_reason") == "beverage_mass",
            "chemistry": chemistry, "v7_status": "blocked: incompletely specified experimental inputs"}


def render_markdown(report: Mapping[str, Any]) -> str:
    cases = report["cases"]
    lines = ["<!-- SPDX-License-Identifier: GPL-2.0-or-later -->", "# M2 chemistry diagnostics", "",
             "V7 is **not validated**. The eight fixed scenarios below use explicit input assumptions; "
             "matching a measured compound under one assumption does not resolve those unknowns.", "",
             "No Gloess values were fitted. The original M1 calibration and held-out split are retained.", "",
             "## Conditional compound comparisons", "",
             "The measurement is per double extraction (published per-cup mg multiplied by two). "
             "The target column uses the planned ±25% compound band as a diagnostic for the measured "
             "M1 kinetic anchors. Estimated 3-CQA is reported without a pass/fail score.", "",
             "| Scenario | Species | Measured mg | Predicted mg | Error | Within ±25% |",
             "|---|---|---:|---:|---:|---|"]
    for case in cases:
        if case.get("error"):
            lines.append(f"| {case['id']} | simulation error | — | — | — | no |")
            continue
        for row in case["compound_comparisons"]:
            prediction = row["predicted_double_mg"]
            error = row["relative_error"]
            target_text = "estimated; unscored" if not row["eligible_for_scoring"] else (
                "yes" if row["within_25_percent_under_assumptions"] else "no")
            lines.append(f"| {case['id']} | {row['species']} | {row['measured_double_mg']:.4g} | "
                         f"{prediction:.4g} | {error:+.1%} | {target_text} |"
                         if prediction is not None and error is not None else
                         f"| {case['id']} | {row['species']} | {row['measured_double_mg']:.4g} | unavailable | — | no |")
    lines += ["", "## Acidity and transport closure", "",
              "pH/TA predictions are reported in the JSON alongside the measured endpoints, but are "
              "not independently scored: source alkalinity and intrinsic coffee buffering are missing. "
              "The source assay is at 20°C; the current speciation reference is 25°C.", "",
              "| Scenario | Stop | Predicted / measured time, s | Raw transport closure error | Within ±5% |",
              "|---|---|---:|---:|---|"]
    for case in cases:
        if case.get("error"):
            continue
        error = case["mass_closure"].get("relative_transport_closure_error")
        text = f"{error:.2%}" if _finite(error) else "unavailable"
        lines.append(f"| {case['id']} | {case['stop_reason']} | "
                     f"{case['predicted_time_s']:.3g} / {case['measured_time_s']:.3g} | {text} | "
                     f"{'yes' if case['raw_transport_closure_within_5_percent'] else 'no'} |")
    lines += ["", "Residual accounting is reported separately. Adding an unassigned-solubles residual "
              "to the named compounds is not evidence that the transport closure meets ±5%.", "",
              "## Compound table and provenance", "",
              f"The catalogue contains {report['catalogue']['appendix_species']} Appendix A species "
              "plus the legacy acid aggregate and explicit unassigned-solubles inventory. "
              "The latter two are not additional identified compounds. Registry tags describe each "
              "parameter, rather than assigning an entire compound a misleading 'measured' label.", "",
              "| Compound | Phase | Kinetic class | Parameter tags | Composition evidence |",
              "|---|---|---|---|---|"]
    for row in report["catalogue"]["rows"]:
        tags = sorted({p["tag"] or "missing" for p in row["parameter_provenance"]})
        lines.append(f"| {row['name']} | {row['phase']} | {row['kinetic_class']} | "
                     f"{', '.join(tags)} | {row['composition_evidence']} |")
    lines += ["",
              "## Assumptions and limits", ""] + [f"- {x}" for x in report["limitations"]]
    lines += ["", "## Exit status", "",
              f"- M2 runtime present in {report['summary']['chemistry_available']}/{len(cases)} scenarios.",
              f"- Conditional compound comparisons within ±25%: {report['summary']['compound_within']}/"
              f"{report['summary']['compound_total']}.",
              f"- Compound metadata coverage with parameter tags: "
              f"{'complete' if report['catalogue']['complete_with_tags'] else 'incomplete'}.",
              f"- Raw dissolved transport closure within ±5%: {report['summary']['closure_within']}/"
              f"{len(cases)} conditional scenarios.",
              "- Full M2 exit: **not met** while independent V7 validation remains blocked.",
              f"- Independent V7 chemistry validation: **blocked**, not passed.",
              f"- Full per-scenario chemistry, warnings and input recipes: [{REPORT_NAME}.json]({REPORT_NAME}.json).", "",
              "Source: Gloess et al. (2013), DOI [10.1007/s00217-013-1917-x]"
              "(https://doi.org/10.1007/s00217-013-1917-x), main Table 1 and Supplement Tables 2–4. "
              "CC BY 2.0. See the dataset sidecar for the source hash, uncertainty and basis audit.", ""]
    errors = [f"- {c['id']}: {c['error']}" for c in cases if c.get("error")]
    if errors:
        lines += ["## Public simulation errors", ""] + errors + [""]
    return "\n".join(lines)


def run(paths: RepoPaths, output_dir: Path, *, module: ModuleType | None = None) -> dict[str, Any]:
    """Run the fixed scenarios and write a reviewable Markdown/JSON report."""
    engine = core(module)
    results = []
    for case in recipes(paths):
        try:
            build = engine.build_shot_spec(case["recipe"])
            spec = build["spec"]
            set_program(spec, [phase(pressure_control(case["pressure_bar"] * 1e5), ramp_s=1.0)],
                        pump=ideal_pump(), stop_beverage_kg=case["mass_proxy_g"] / 1000,
                        max_duration_s=150.0)
            spec["machine"]["stop"]["vent_headspace"] = True  # fixed vented-machine assumption
            result = engine.simulate_shot(spec)
            row = compare(case, result)
            row["build_warnings"] = build.get("derived", {}).get("notes", [])
            row["compound_definitions"] = spec.get("chemistry", {}).get("compounds", [])
            results.append(row)
        except Exception as exc:
            results.append({"id": case["id"], "recipe": case["recipe"], "error": str(exc),
                            "v7_status": "not run"})
    compared = [r for r in results if "compound_comparisons" in r]
    compounds = [s for r in compared for s in r["compound_comparisons"] if s["eligible_for_scoring"]]
    report = {"schema": "puckworks.m2-validation/1", "created": datetime.date.today().isoformat(),
              "core_version": getattr(engine, "__version__", "unknown"), "dataset": DATASET,
              "solver_identity": solver_identity(paths, module=module),
              "fitted_to_v7": False, "v7_status": "blocked: incomplete experimental inputs",
              "catalogue": catalogue_audit(paths),
              "limitations": LIMITATIONS, "cases": results,
              "summary": {"simulations": len(results), "simulation_errors": len(results) - len(compared),
                          "chemistry_available": sum(bool(r.get("chemistry")) for r in compared),
                          "closure_within": sum(r["raw_transport_closure_within_5_percent"] for r in compared),
                          "compound_within": sum(s["within_25_percent_under_assumptions"] for s in compounds),
                          "compound_total": len(compounds)}}
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f"{REPORT_NAME}.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    (output_dir / f"{REPORT_NAME}.md").write_text(render_markdown(report))
    return report
