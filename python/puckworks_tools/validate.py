# SPDX-License-Identifier: GPL-2.0-or-later
"""Validation report v1 (docs/PLAN.md §10, §12 M1): calibration fit quality and held-out checks.

``puckworks-tools validate`` simulates the case builders' conditions (``cases``) with the
calibrated parameters of ``data/calibration/current.yaml`` (registry defaults where it has none)
and writes ``docs/validation/m1-validation.md`` with figures in ``docs/validation/m1/`` and the raw
numbers in ``docs/validation/m1-validation.json``.

1. Calibration fit quality (V1 Schmieder, V2 Vaca Guerra dispersion, V4 Waszkiewicz Q(P), V6
   Corrochano relative closure): residuals of the calibration blocks and the PLAN §10 targets that
   apply to them (V1 λ and cup masses within ±10%; V2 Bo within 8–17; V6 density ratios within ×1.5).
2. Held-out checks with pass/fail against PLAN §10:
   - V3 Cameron 2020: EY peaks at 22–24% at grind settings 1.5–1.9; shot time falls monotonically as
     the grind coarsens;
   - V4 transient (Waszkiewicz 2026, 9 bar): first-drop delay and time to 90% of its 100 s flow each
     within ×1.5 of the data, without an overshoot at 15 s after the first drops; first 5 s fraction
     at 25 ± 3% TDS;
   - V5 Smrke 2024: added fines lengthen shots at every burr gap; EY tracks shot time (Spearman
     ρ ≥ 0.8); shots of 10–15 s reach 17–18% EY.

3. Reported without a pass/fail target: the held-out shot times against the data (the independent test of
   the reference permeability at measured PSDs), tier 0 against tier 1 on the held-out cases, generic app
   shots (18 g → 36 g at 9 bar per grinder preset), and the held-out predictions under the calibration's
   structural sensitivity variants (the dissolution share θ).
4. The validation part of the M1 exit criteria (PLAN §12): V1 within targets, V3 peak and V4 flow rise
   reproduced; pass, partial or fail from their checks.

Held-out cases receive only the shared calibrated parameters (recipe overrides, the pooled reference
permeability and case parameters); setup-specific (nuisance) parameters stay with their own dataset.
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np

from . import __version__
from .calibrate import (
    LOO_TOLERANCE,
    REFERENCE_PERMEABILITY_ID,
    Problem,
    Runner,
    base_permeability_id,
    build_problem,
    calibrated_values,
    load_calibration_document,
    load_config,
    observe,
)
from .cases import MODULES
from .cases.common import Case, core
from .paths import RepoPaths

REPORT_NAME = "m1-validation"
FIGURE_DIR = "m1"

V1_FIT_TOLERANCE = 0.10
V2_BODENSTEIN = (8.0, 17.0)
V3_PEAK_SETTINGS = (1.5, 1.9)
V3_PEAK_EY = (22.0, 24.0)
V4_FIRST_TDS = (22.0, 28.0)
#: V4 flow rise: the time from the first drops to 90% of the 100 s flow, and the delay from full pressure
#: to the first drops, must each lie within this factor of the data's; and the model's flow must not
#: overshoot (its flow 15 s after the first drops may not exceed its 100 s flow).
V4_TIME_FACTOR = 1.5
V5_SPEARMAN = 0.8
V5_FAST_TIMES = (10.0, 15.0)
V5_FAST_EY = (17.0, 18.0)
#: Added fines must lengthen the model's shots by at least this share of the measured relative increase
#: (0 → 4 g at each burr gap), as well as at every step.
V5_FINES_SHARE = 0.5
V6_FACTOR = 1.5
#: Generic app recipes for the shot-time check of the calibrated reference permeability: 18 g → 36 g
#: at a flat 9 bar, medium washed arabica in the 58 mm precision basket, each grinder preset at a
#: typical espresso setting (the recipes `hydraulics.permeability.reference`'s default was derived from).
GENERIC_GRINDERS = (("mahlkoenig-ek43", 1.7), ("mahlkoenig-e65s", 1.7), ("generic-flat-traditional-64", 190.0),
                    ("generic-conical-50", 190.0), ("generic-flat-unimodal-64", 170.0), ("bentwood-v63", 190.0))
GENERIC_SHOT_S = (25.0, 35.0)


def _finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(x)


def _check(name: str, passed: bool | None, detail: str, target: str, *, info: bool = False) -> dict[str, Any]:
    """A check row; ``info`` rows report fit quality without a pass/fail target."""
    status = "info" if info else ("pass" if passed else ("fail" if passed is not None else "not run"))
    return {"check": name, "status": status, "target": target, "detail": detail}


def spearman(a: Sequence[float], b: Sequence[float]) -> float:
    """Spearman rank correlation (average ranks for ties)."""
    from scipy.stats import spearmanr

    if len(a) < 3:
        return math.nan
    rho = spearmanr(a, b).statistic
    return float(rho) if math.isfinite(rho) else math.nan


# -- calibration fit quality ----------------------------------------------------------------


def _calibration_x(problem: Problem, calibrated: Mapping[str, float]) -> np.ndarray:
    x = problem.x0()
    for j, p in enumerate(problem.params):
        if p.id in calibrated:
            value = min(max(calibrated[p.id], p.lower), p.upper)
            x[j] = p.to_x(value)
    return x


def fit_quality(problem: Problem, x: np.ndarray) -> tuple[dict[str, Any], dict[str, Any]]:
    """Per-block summaries and target checks of the calibration blocks at ``x``."""
    from .cases import schmieder2023

    evaluations = problem.evaluations(x)
    summary: dict[str, Any] = {}
    observations: dict[str, Any] = {}
    checks = []
    for block, ev in zip(problem.blocks, evaluations):
        rr = ev.residuals
        summary[block.name] = {"dataset": block.module.KEY, "cases": len(block.cases), "residuals": int(rr.size),
                               "rms": float(np.sqrt(np.mean(rr**2))) if rr.size else 0.0,
                               "cost": 0.5 * float(rr @ rr), "failures": ev.failures}
        pressure_rows = [i for i, label in enumerate(block.labels) if label.endswith("peak_pressure")]
        if pressure_rows:
            summary[block.name]["pressure_rms"] = float(np.sqrt(np.mean(rr[pressure_rows] ** 2)))
        observations[block.name] = ev.observations
        key = block.module.KEY
        if key == "schmieder2023":
            targets = schmieder2023.targets(block.data)
            rows = []
            for case, obs in zip(block.cases, ev.observations):
                exp = case.info["experiment"]
                for analyte, _, _, _ in schmieder2023.ANALYTES:
                    lam_data = targets[exp]["lambda"][analyte][0]
                    lam_model = obs["lambda"][analyte] if obs else math.nan
                    cups = {m: ((obs["cup_eq3"][analyte][m] if obs else math.nan), targets[exp]["cup"][analyte][m][0])
                            for m in (20, 40, 60)}
                    rows.append({"experiment": exp, "analyte": analyte, "lambda_model": lam_model,
                                 "lambda_data": lam_data, "cups": cups})
            lam_err = [abs(r["lambda_model"] / r["lambda_data"] - 1.0) for r in rows]
            cup_err = [abs(m / d - 1.0) for r in rows for m, d in r["cups"].values()]
            within_lam = sum(1 for e in lam_err if _finite(e) and e <= V1_FIT_TOLERANCE)
            within_cup = sum(1 for e in cup_err if _finite(e) and e <= V1_FIT_TOLERANCE)
            summary[block.name]["v1"] = {"rows": rows, "lambda_within": within_lam, "lambda_total": len(lam_err),
                                         "cup_within": within_cup, "cup_total": len(cup_err),
                                         "lambda_max_error": max((e for e in lam_err if _finite(e)), default=math.nan),
                                         "cup_max_error": max((e for e in cup_err if _finite(e)), default=math.nan)}
            names = {"trigonelline": "trigonelline", "caffeine": "caffeine", "cqa5": "5-CQA", "tds": "TDS"}

            def by_analyte(kind: str) -> str:
                parts = []
                for analyte, label in names.items():
                    if kind == "lambda":
                        errs = [abs(r["lambda_model"] / r["lambda_data"] - 1.0) for r in rows if r["analyte"] == analyte]
                    else:
                        errs = [abs(m / d - 1.0) for r in rows if r["analyte"] == analyte for m, d in r["cups"].values()]
                    parts.append(f"{label} {sum(1 for e in errs if _finite(e) and e <= V1_FIT_TOLERANCE)}/{len(errs)}")
                return ", ".join(parts)

            summary[block.name]["v1"]["lambda_by_analyte"] = by_analyte("lambda")
            summary[block.name]["v1"]["cup_by_analyte"] = by_analyte("cup")
            worst = max(((abs(r["lambda_model"] / r["lambda_data"] - 1.0), r) for r in rows
                         if _finite(r["lambda_model"])), default=(math.nan, None), key=lambda x: x[0])
            if worst[1] is not None:
                summary[block.name]["v1"]["lambda_worst"] = {"experiment": worst[1]["experiment"],
                                                             "analyte": worst[1]["analyte"],
                                                             "error": worst[1]["lambda_model"] / worst[1]["lambda_data"] - 1.0}
            from .calibrate import pump_summary

            summary[block.name]["pump_limited"] = pump_summary(block, ev.observations)
            check = _check("V1 λ within ±10% (fit)", within_lam == len(lam_err),
                           f"{within_lam}/{len(lam_err)} experiment–analyte pairs within ±10% ({by_analyte('lambda')})",
                           "λ within ±10% for all 15 experiments × 4 analytes")
            checks.append({**check, "within": within_lam, "total": len(lam_err)})
            check = _check("V1 cup masses within ±10% (fit)", within_cup == len(cup_err),
                           f"{within_cup}/{len(cup_err)} cup masses (20, 40, 60 g) within ±10% ({by_analyte('cup')})",
                           "cup masses within ±10%")
            checks.append({**check, "within": within_cup, "total": len(cup_err)})
        elif key == "vacaguerra2024":
            values = [o["bodenstein"] if o else math.nan for o in ev.observations]
            ok = all(_finite(v) and V2_BODENSTEIN[0] <= v <= V2_BODENSTEIN[1] for v in values)
            summary[block.name]["bodenstein"] = [{"case": c.name, "model": v, "data": c.info["bodenstein"]}
                                                 for c, v in zip(block.cases, values)]
            above = sum(1 for c, v in zip(block.cases, values) if _finite(v) and v > c.info["bodenstein"])
            summary[block.name]["bodenstein_above_data"] = above
            checks.append(_check("V2 Bodenstein number 8–17", ok,
                                 "model Bo = " + ", ".join(f"{v:.1f}" for v in values)
                                 + f" (data " + ", ".join(f"{c.info['bodenstein']:.1f}" for c in block.cases)
                                 + f"; the model is above the data in {above} of {len(values)}; the held-out compound "
                                 "curves were not run)", "Bo within 8–17"))
        elif key == "waszkiewicz2026":
            rows = [{"pressure_bar": c.info["target_bar"], "model": o["long_time_flow_g_s"] if o else math.nan,
                     "data": c.info["longtime"]["flow_g_s"], "sem": c.info["longtime"]["flow_sem_g_s"]}
                    for c, o in zip(block.cases, ev.observations)]
            errs = [r["model"] - r["data"] for r in rows]
            rms = float(np.sqrt(np.nanmean(np.square(errs)))) if rows else math.nan
            summary[block.name]["qp"] = rows
            checks.append(_check("V4 long-time flow vs pressure (fit)", None,
                                 f"RMS error {rms:.3f} g/s over {len(rows)} pressures", "calibration (no pass/fail target)",
                                 info=True))
        elif key == "corrochano2017":
            by = {(c.info["grind"], c.info["density"]): (c, o) for c, o in zip(block.cases, ev.observations)}
            ratios = []
            for (grind, density), (case, obs) in sorted(by.items()):
                if density == 360.0:
                    continue
                ref_case, ref_obs = by[(grind, 360.0)]
                data = case.info["data"]["permeability_m2"] / ref_case.info["data"]["permeability_m2"]
                model = (obs["permeability_m2"] / ref_obs["permeability_m2"]
                         if obs and ref_obs and ref_obs["permeability_m2"] > 0 else math.nan)
                ratios.append({"grind": grind, "density": density, "model": model, "data": data,
                               "factor": model / data if _finite(model) else math.nan})
            ok = all(_finite(r["factor"]) and 1 / V6_FACTOR <= r["factor"] <= V6_FACTOR for r in ratios)
            summary[block.name]["ratios"] = ratios
            checks.append(_check("V6 relative change of κ with density within ×1.5", ok,
                                 "model/data ratio factors " + ", ".join(f"{r['factor']:.2f}" for r in ratios),
                                 "κ(ρ)/κ(360 kg/m³), model within ×1.5 of data for 4 grinds × 2 densities"))
    return {"blocks": summary, "checks": checks}, observations


def loo_check(loo: Mapping[str, Any] | None, *, stale_reasons: Sequence[str] = ()) -> dict[str, Any]:
    """The V1 leave-one-condition-out check, from the calibration file's ``fit.loo`` (``calibrate --loo``)."""
    target = f"λ and cup masses of each left-out experiment within ±{100 * LOO_TOLERANCE:.0f}%"
    if loo and stale_reasons:
        return _check("V1 leave-one-condition-out (±15%)", None,
                      "not run for this model/configuration; the calibration file's cached refits are historical ("
                      + "; ".join(stale_reasons) + ")", target)
    if not loo:
        return _check("V1 leave-one-condition-out (±15%)", None,
                      "not run (`puckworks-tools calibrate --loo` records it in the calibration file)", target)
    ok = loo["lambda_within"] == loo["lambda_total"] and loo["cup_within"] == loo["cup_total"]
    check = _check("V1 leave-one-condition-out (±15%)", ok,
                   f"λ {loo['lambda_within']}/{loo['lambda_total']}, cup masses {loo['cup_within']}/{loo['cup_total']} "
                   "within ±15% when predicted without their own experiment", target)
    return {**check, "within": loo["lambda_within"] + loo["cup_within"], "total": loo["lambda_total"] + loo["cup_total"]}


def calibration_reuse_issues(document: Mapping[str, Any], solver: Mapping[str, Any],
                             inputs: Mapping[str, Any]) -> list[str]:
    """Reasons cached refits cannot score this run, allowing the normal post-fit registry export.

    Parameters can be evaluated with a changed model, but recorded leave-one-out scores and
    uncertainties still belong to the solver and inputs that actually produced those refits.
    """
    fit = document.get("fit") or {}
    if not fit:
        return []
    previous = fit.get("solver") or {}
    issues = []
    if previous.get("puckcore_version") != solver.get("puckcore_version"):
        issues.append("core version changed")
    trees = ("crates/puckcore/src", "crates/puckmodel/src", "crates/puckcore-py")
    old_sources, sources = previous.get("sources_sha256") or {}, solver.get("sources_sha256") or {}
    if any(not old_sources.get(tree) or old_sources.get(tree) != sources.get(tree) for tree in trees):
        issues.append("solver/model sources changed or lack an identity")
    if (previous.get("files_sha256") or {}) != (solver.get("files_sha256") or {}):
        issues.append("solver build inputs changed")
    recorded = fit.get("inputs") or {}
    if not recorded.get("config_sha256") or recorded.get("config_sha256") != inputs.get("config_sha256"):
        issues.append("calibration configuration changed or lacks an identity")
    if (recorded.get("datasets_sha256") or {}) != (inputs.get("datasets_sha256") or {}):
        issues.append("calibration datasets changed")
    if not recorded.get("registry_inputs_sha256") or recorded.get("registry_inputs_sha256") != inputs.get("registry_inputs_sha256"):
        issues.append("numeric registry defaults changed or lack an identity")
    if not recorded.get("presets_sha256") or recorded.get("presets_sha256") != inputs.get("presets_sha256"):
        issues.append("preset inputs changed or lack an identity")
    if (not recorded.get("calibration_sources_sha256")
            or recorded.get("calibration_sources_sha256") != inputs.get("calibration_sources_sha256")):
        issues.append("Python calibration/case sources changed or lack an identity")
    return issues


# -- held-out checks ----------------------------------------------------------------------------


def shared_overrides(problem: Problem, calibrated: Mapping[str, float], module: ModuleType | None = None) -> dict[str, float]:
    """Calibrated app-facing values for held-out builders: the override parameters known to the
    embedded registry, and the reference permeability under the id the builder reads for κ₀ (the
    builder scales either id identically by the recipe's Sauter diameter)."""
    known = {p["id"] for p in core(module).registry().get("parameters", [])}
    out = {p.id: calibrated[p.id] for p in problem.params
           if p.mode == "override" and p.id in calibrated and (not known or p.id in known)}
    if REFERENCE_PERMEABILITY_ID in calibrated and problem.blocks and problem.blocks[0].cases:
        out[base_permeability_id(problem.blocks[0].cases[0].recipe, module)] = calibrated[REFERENCE_PERMEABILITY_ID]
    return out


def _simulate(cases: list[Case], runner: Runner, module_obj: ModuleType) -> list[dict[str, Any] | None]:
    results = runner.run([c.spec for c in cases])
    out = []
    for case, spec, result in zip(cases, [c.spec for c in cases], results):
        if "error" in result:
            out.append(None)
            continue
        try:
            out.append(observe(module_obj, case, result, spec))
        except (ValueError, KeyError, ZeroDivisionError):
            out.append(None)
    return out


def time_bias(rows: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """Signed shot-time error of held-out rows: mean model − data (s) and the geometric mean of model/data."""
    pairs = [(r["time_model"], r["time_data"]) for r in rows
             if _finite(r["time_model"]) and _finite(r["time_data"]) and r["time_data"] > 0 and r["time_model"] > 0]
    if not pairs:
        return {"bias_time": math.nan, "time_ratio": math.nan}
    return {"bias_time": float(np.mean([m - d for m, d in pairs])),
            "time_ratio": float(np.exp(np.mean([math.log(m / d) for m, d in pairs])))}


def psd_tail(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Quantiles and coarse end of a binned volume PSD (the Waszkiewicz dataset's first sample)."""
    lo = np.array([float(r["bin_lower_um"]) for r in rows])
    hi = np.array([float(r["bin_upper_um"]) for r in rows])
    v = np.array([float(r["volume_percent_1"]) for r in rows])
    cum = np.cumsum(v) / v.sum()

    def quantile(q: float) -> float:
        i = int(np.searchsorted(cum, q))
        c0 = cum[i - 1] if i > 0 else 0.0
        f = (q - c0) / (cum[i] - c0) if cum[i] > c0 else 0.0
        return float(np.exp(np.log(lo[i]) + f * (np.log(hi[i]) - np.log(lo[i]))))

    last = int(np.nonzero(v > 0)[0][-1])
    return {"x50_um": quantile(0.5), "x90_um": quantile(0.9), "last_bin_um": [float(lo[last]), float(hi[last])],
            "last_bin_percent": float(v[last]), "bins_to_um": float(hi[-1]),
            "share_below_100um": float(v[hi <= 100.0 + 1e-6].sum() / v.sum())}


def check_held_out_times(v3: Mapping[str, Any], v5: Mapping[str, Any],
                         v4t: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Held-out shot times alongside the V4 case whose long-time flow is calibrated separately.

    Both startup and permeability affect total time; this reports the evidence without attributing
    every discrepancy to the same cause or asserting that the long-time calibration is a good fit.
    """
    parts = []
    for name, extra in (("V3 Cameron", v3), ("V5 Smrke", v5)):
        if extra.get("rows"):
            parts.append(f"{name}: model/data ×{_fmt(extra.get('time_ratio'), 2)} (mean error "
                         f"{_fmt(extra.get('bias_time'), 2)} s, RMS {_fmt(extra.get('rms_time'), 2)} s)")
    if v4t and _finite(v4t.get("time_to_mass_ratio")):
        parts.append(f"V4 9 bar (long-time flow is a calibration observable): time to 36 g "
                     f"×{_fmt(v4t['time_to_mass_ratio'], 2)}")
    return _check("Held-out shot times against the data", None, "; ".join(parts) or "no held-out shots",
                  "reported: shot times depend on startup and permeability; κ_ref is not tuned to these times",
                  info=True)


def _apply_spec_fields(cases: list[Case], spec_fields: Mapping[str, Any] | None) -> list[Case]:
    from .cases.common import set_path

    for case in cases:
        for path, value in (spec_fields or {}).items():
            set_path(case.spec, path, value)
    return cases


def check_v3(paths: RepoPaths, runner: Runner, overrides: Mapping[str, float], *, tier: int, n_classes: int,
             module: ModuleType | None = None,
             spec_fields: Mapping[str, Any] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    mod = MODULES["cameron2020"]
    data = mod.load(paths)
    cases = _apply_spec_fields(mod.build_cases(data, tier=tier, n_classes=n_classes, overrides=overrides,
                                               module=module), spec_fields)
    obs = _simulate(cases, runner, mod)
    rows = [{"grind_setting": c.info["grind_setting"], "ey_model": o["ey_percent"] if o else math.nan,
             "ey_data": c.info["data"]["ey_percent"], "ey_bar": c.info["data"].get("ey_bar_percent"),
             "time_model": o["shot_time_s"] if o else math.nan, "time_data": c.info["data"]["shot_time_s"],
             "time_bar": c.info["data"].get("shot_time_bar_s"), "stop": o["stop_reason"] if o else "failed"}
            for c, o in zip(cases, obs)]
    ey = [r["ey_model"] for r in rows]
    times = [r["time_model"] for r in rows]
    checks = []
    if all(_finite(v) for v in ey):
        k = int(np.argmax(ey))
        gs, peak = rows[k]["grind_setting"], ey[k]
        interior = 0 < k < len(rows) - 1
        checks.append(_check("V3 EY peak at grind setting 1.5–1.9", interior and V3_PEAK_SETTINGS[0] <= gs <= V3_PEAK_SETTINGS[1],
                             f"model EY peaks at GS {gs:.1f}" + ("" if interior else " (at the edge of the range: no peak)"),
                             "EY maximum at GS 1.5–1.9 (data: 1.7)"))
        checks.append(_check("V3 peak EY 22–24%", V3_PEAK_EY[0] <= peak <= V3_PEAK_EY[1], f"model peak EY {peak:.2f}%",
                             "peak EY within 22–24% (data: 23.07%)"))
    else:
        checks.append(_check("V3 EY peak at grind setting 1.5–1.9", False, "some shots failed", "EY maximum at GS 1.5–1.9"))
        checks.append(_check("V3 peak EY 22–24%", False, "some shots failed", "peak EY within 22–24%"))
    mono = all(_finite(a) and _finite(b) and b < a for a, b in zip(times[:-1], times[1:]))
    checks.append(_check("V3 shot time falls as the grind coarsens", mono,
                         "model times " + ", ".join(f"{t:.1f}" for t in times) + " s",
                         "shot time strictly decreasing from GS 1.1 to 2.3"))
    err_ey = [r["ey_model"] - r["ey_data"] for r in rows]
    err_t = [r["time_model"] - r["time_data"] for r in rows]
    extra = {"rows": rows, "rms_ey": float(np.sqrt(np.nanmean(np.square(err_ey)))),
             "rms_time": float(np.sqrt(np.nanmean(np.square(err_t)))), **time_bias(rows)}
    return checks, extra


def v4_transient_metrics(case: Any, obs: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Flow-rise, first-drop and time-to-mass metrics of the 9-bar shot on the data's clock (seconds after
    the end of the pressure rise; the model's clock is shifted by the moment its inlet pressure reaches
    95% of the target), for the model and the data."""
    from .cases import waszkiewicz2026 as mod

    if case is None or not obs or not _finite(obs.get("drops_s")) or not _finite(obs.get("offset_s")):
        return None
    offset = obs["offset_s"]
    t = np.array(obs["flow_t_s"])
    q = np.array(obs["flow_g_s"])
    rows = case.info["transient"]
    td = np.array([r["time_s"] for r in rows])
    qd = np.array([r["flow_g_s"] for r in rows])
    drops_model = obs["drops_s"] - offset
    drops_data = mod.data_time_to_mass(rows, mod.FIRST_DROPS_G)
    rise = mod.flow_rise(t, q, obs["drops_s"], offset + mod.LONG_TIME_S)
    rise_data = mod.flow_rise(td, qd, drops_data, mod.LONG_TIME_S)
    return {"drops_model_s": drops_model, "drops_data_s": drops_data, "rise_model": rise, "rise_data": rise_data,
            "time_to_mass_model_s": obs["time_to_mass_s"] - offset,
            "time_to_mass_data_s": mod.data_time_to_mass(rows, mod.TIME_TO_MASS_G),
            "long_time_model_g_s": obs.get("long_time_flow_g_s"),
            "long_time_data_g_s": case.info["longtime"]["flow_g_s"]}


def _within_factor(model: float, data: float, factor: float) -> bool:
    return _finite(model) and _finite(data) and model > 0 and data > 0 and 1.0 / factor <= model / data <= factor


def check_v4_transient(v4_block: Any, observations: list[dict[str, Any] | None]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    from .cases import waszkiewicz2026 as mod

    checks: list[dict[str, Any]] = []
    case, obs = next(((c, o) for c, o in zip(v4_block.cases, observations) if c.info["group"] == mod.TRANSIENT_GROUP),
                     (None, None))
    m = v4_transient_metrics(case, obs)
    rise_target = (f"90% of the 100 s flow within ×{V4_TIME_FACTOR:g} of the data's time after the first drops, and "
                   "no overshoot at the 15 s check (flow 15 s after the first drops ≤ flow at 100 s)")
    delay_target = f"delay from full pressure to the first drops ({mod.FIRST_DROPS_G:g} g) within ×{V4_TIME_FACTOR:g} of the data's"
    if m is None:
        reason = ("the 9-bar shot never reaches 95% of its target pressure"
                  if obs and not _finite(obs.get("offset_s")) else "no first drops in the 9-bar shot")
        checks.append(_check("V4 flow rises after the first drops", False, reason, rise_target))
        checks.append(_check("V4 first drops after full pressure", False, reason, delay_target))
        first = ((obs or {}).get("tds_fractions") or [{"tds_percent": math.nan}])[0]["tds_percent"]
        checks.append(_check("V4 first-fraction TDS 25 ± 3%", _finite(first) and V4_FIRST_TDS[0] <= first <= V4_FIRST_TDS[1],
                             f"model first 5 s fraction {first:.1f}% TDS" if _finite(first) else reason,
                             "first 5 s fraction 22–28% TDS"))
        return checks, {}
    rise, rise_data = m["rise_model"], m["rise_data"]
    flow_covered = all(_finite(rise[k]) for k in ("q2", "q15", "q_end", "t90_s"))
    overshoot = rise["q15"] > rise["q_end"]
    ok = flow_covered and _within_factor(rise["t90_s"], rise_data["t90_s"], V4_TIME_FACTOR) and not overshoot

    def overall(r: Mapping[str, float]) -> float:
        return r["q_end"] / r["q2"] if r["q2"] > 0 else math.inf

    checks.append(_check("V4 flow rises after the first drops", ok,
                         f"model: 90% of the 100 s flow {rise['t90_s']:.1f} s after the first drops (data "
                         f"{rise_data['t90_s']:.1f} s); flow ×{rise['ratio_15_2']:.2f} from 2 s to 15 s and "
                         f"×{overall(rise):.2f} to 100 s (data ×{rise_data['ratio_15_2']:.2f}, ×{overall(rise_data):.2f}); "
                         + (f"overshoot: {rise['q15']:.2f} g/s at 15 s against {rise['q_end']:.2f} g/s at 100 s"
                            if overshoot else ("no overshoot at the 15 s check" if flow_covered
                                               else "incomplete flow window")), rise_target))
    checks.append(_check("V4 first drops after full pressure",
                         _within_factor(m["drops_model_s"], m["drops_data_s"], V4_TIME_FACTOR),
                         f"model {m['drops_model_s']:.1f} s, data {m['drops_data_s']:.1f} s after the pressure reaches "
                         "its target (both on the data's clock)", delay_target))
    fractions = obs.get("tds_fractions") or []
    first = fractions[0]["tds_percent"] if fractions else math.nan
    checks.append(_check("V4 first-fraction TDS 25 ± 3%", _finite(first) and V4_FIRST_TDS[0] <= first <= V4_FIRST_TDS[1],
                         f"model first 5 s fraction {first:.1f}% TDS (data: 24.4% in the one replicate that "
                         "collected liquid, 23.5% in the next window)", "22–28% TDS"))
    ratio = m["time_to_mass_model_s"] / m["time_to_mass_data_s"] if _finite(m["time_to_mass_data_s"]) else math.nan
    checks.append(_check(f"V4 time to {mod.TIME_TO_MASS_G:g} g (9 bar)", None,
                         f"model {m['time_to_mass_model_s']:.1f} s, data {m['time_to_mass_data_s']:.1f} s after the "
                         f"pressure rise: ×{ratio:.2f}; long-time flow {m['long_time_model_g_s']:.2f} "
                         f"against {m['long_time_data_g_s']:.2f} g/s",
                         "reported: time to the target mass in the case calibrated on long-time flow", info=True))
    t = np.array(obs["flow_t_s"])
    q = np.array(obs["flow_g_s"])
    rows = case.info["transient"]
    extra = {**m, "time_to_mass_ratio": ratio, "tds_model": fractions,
             "flow_model": {"t_s": (t - obs["offset_s"]).tolist(), "q_g_s": q.tolist()},
             "flow_data": {"t_s": [r["time_s"] for r in rows], "q_g_s": [r["flow_g_s"] for r in rows],
                           "sem_g_s": [r.get("flow_sem_g_s") or 0.0 for r in rows]},
             "offset_s": obs["offset_s"]}
    return checks, extra


def check_v5(paths: RepoPaths, runner: Runner, overrides: Mapping[str, float], *, tier: int, n_classes: int,
             module: ModuleType | None = None,
             spec_fields: Mapping[str, Any] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    mod = MODULES["smrke2024"]
    data = mod.load(paths)
    cases = _apply_spec_fields(mod.build_cases(data, tier=tier, n_classes=n_classes, overrides=overrides,
                                               module=module), spec_fields)
    obs = _simulate(cases, runner, mod)
    rows = []
    for c, o in zip(cases, obs):
        shots = c.info["shots"]
        rows.append({"setting_um": c.info["setting_um"], "fines_g": c.info["fines_g"],
                     "time_model": o["shot_time_s"] if o else math.nan, "ey_model": o["ey_percent"] if o else math.nan,
                     "time_data": float(np.mean([s["extraction_time_s"] for s in shots])) if shots else math.nan,
                     "ey_data": float(np.mean([s["ey_percent"] for s in shots])) if shots else math.nan,
                     "shots": len(shots)})
    by = {(r["setting_um"], r["fines_g"]): r for r in rows}
    lengthen = True
    parts = []
    for setting in (190, 210, 250):
        seq = [by[(setting, g)]["time_model"] for g in (0, 1, 2, 4)]
        data = [by[(setting, g)]["time_data"] for g in (0, 1, 2, 4)]
        monotone = all(_finite(a) and _finite(b) and b > a for a, b in zip(seq[:-1], seq[1:]))
        model_rise = seq[-1] / seq[0] - 1.0 if _finite(seq[0]) and _finite(seq[-1]) and seq[0] > 0 else math.nan
        data_rise = data[-1] / data[0] - 1.0
        enough = _finite(model_rise) and model_rise >= V5_FINES_SHARE * data_rise
        lengthen = lengthen and monotone and enough
        parts.append(f"{setting} µm: model {', '.join(f'{t:.1f}' for t in seq)} s (+{100 * model_rise:.0f}% with 4 g; "
                     f"data +{100 * data_rise:.0f}%)")
    checks = [_check("V5 added fines lengthen shots", lengthen, "; ".join(parts),
                     f"time rises at every step of 0, 1, 2, 4 g, and by at least {V5_FINES_SHARE:.0%} of the measured "
                     "relative increase from 0 to 4 g, at 190, 210 and 250 µm")]
    times = [r["time_model"] for r in rows]
    eys = [r["ey_model"] for r in rows]
    good = [(t, e) for t, e in zip(times, eys) if _finite(t) and _finite(e)]
    rho = spearman([t for t, _ in good], [e for _, e in good]) if len(good) >= 3 else math.nan
    rho_data = spearman([r["time_data"] for r in rows], [r["ey_data"] for r in rows])
    checks.append(_check("V5 EY tracks shot time", _finite(rho) and rho >= V5_SPEARMAN,
                         f"Spearman ρ(time, EY) = {rho:.2f} over {len(good)} model conditions (data: {rho_data:.2f})",
                         "Spearman ρ ≥ 0.8"))
    # the conditions whose *measured* shots took 10–15 s, compared at the same conditions
    fast = [r for r in rows if V5_FAST_TIMES[0] <= r["time_data"] <= V5_FAST_TIMES[1] and _finite(r["ey_model"])]
    if fast:
        value = float(np.mean([r["ey_model"] for r in fast]))
        how = ("conditions measured at 10–15 s: " + ", ".join(
            f"{r['setting_um']} µm + {r['fines_g']} g (measured {r['time_data']:.1f} s, {r['ey_data']:.2f}% EY; model "
            f"{r['time_model']:.1f} s, {r['ey_model']:.2f}%)" for r in fast) + f"; model mean {value:.2f}%")
        status = V5_FAST_EY[0] <= value <= V5_FAST_EY[1]
    else:
        value, how, status = math.nan, "no condition was measured at 10–15 s", None
    checks.append(_check("V5 10–15 s shots reach 17–18% EY", status, how,
                         "model EY 17–18% at the conditions whose measured shots took 10–15 s (data: 17.4–17.6% at "
                         "12 s); EY levels rest on the bean's 28% extractable solids (input models)"))
    extra = {"rows": rows, "spearman_model": rho, "spearman_data": rho_data,
             "rms_time": float(np.sqrt(np.nanmean(np.square([r["time_model"] - r["time_data"] for r in rows])))),
             "rms_ey": float(np.sqrt(np.nanmean(np.square([r["ey_model"] - r["ey_data"] for r in rows])))),
             **time_bias(rows)}
    return checks, extra


def generic_recipe(grinder: str, setting: float, overrides: Mapping[str, float], tier: int) -> dict[str, Any]:
    return {"schema": "puckworks.recipe/1", "bean": {"preset": "medium-washed-arabica"},
            "grinder": {"preset": grinder, "setting": setting}, "basket": {"preset": "58-precision-18g"},
            "prep": {"dose_g": 18.0}, "machine": {"preset": "flat-9-bar"}, "stop": {"beverage_g": 36.0},
            "numerics": {"tier": tier}, "overrides": dict(overrides)}


def check_generic_shots(runner: Runner, overrides: Mapping[str, float], *, tier: int,
                        module: ModuleType | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Shot times of generic app recipes (18 g → 36 g, 9 bar) with the calibrated parameters: a sanity
    check of the reference permeability the app uses (not a PLAN §10 target)."""
    specs, rows = [], []
    for grinder, setting in GENERIC_GRINDERS:
        try:
            built = core(module).build_shot_spec(generic_recipe(grinder, setting, overrides, tier))
        except ValueError as exc:
            rows.append({"grinder": grinder, "setting": setting, "error": str(exc)})
            continue
        spec = built["spec"]
        spec["numerics"]["snapshot_count"] = 1
        specs.append(spec)
        rows.append({"grinder": grinder, "setting": setting,
                     "kappa0_m2": spec["hydraulics"]["permeability_m2"]})
    results = iter(runner.run(specs))
    for row in rows:
        if "error" in row:
            continue
        result = next(results)
        summary = result.get("summary", {})
        row.update({"time_s": summary.get("shot_time_s", math.nan) if "error" not in result else math.nan,
                    "ey_percent": 100.0 * summary.get("ey", math.nan) if "error" not in result else math.nan,
                    "stop": summary.get("stop_reason", "failed") if "error" not in result else "failed"})
    times = [r.get("time_s", math.nan) for r in rows]
    finite = [t for t in times if _finite(t)]
    detail = (f"tier {tier}: " + ", ".join(f"{r['grinder']} {_fmt(r.get('time_s', math.nan))} s" for r in rows)
              if finite else "no generic shot finished")
    within = bool(finite) and len(finite) == len(rows) and all(GENERIC_SHOT_S[0] <= t <= GENERIC_SHOT_S[1] for t in finite)
    check = _check("Generic 18 g → 36 g, 9 bar shots near 30 s", within, detail,
                   f"{GENERIC_SHOT_S[0]:.0f}–{GENERIC_SHOT_S[1]:.0f} s for every preset at its default setting (typical "
                   "espresso; an app sanity check, not a PLAN target)")
    return check, {"rows": rows, "within": within}


def tier_agreement(paths: RepoPaths, runner: Runner, overrides: Mapping[str, float], v4_block: Any,
                   v4_observations: Sequence[dict[str, Any] | None], values: Mapping[str, float],
                   params: Sequence[Any], *, tier: int, n_classes: int,
                   module: ModuleType | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """The held-out cases (V3, V4 transient, V5) simulated at the other tier: shot time, EY and, for the
    9-bar transient, first-fraction TDS and flow 15 s after the first drops."""
    from .cases import waszkiewicz2026 as wz

    other = 0 if tier == 1 else 1
    rows: list[dict[str, Any]] = []
    for key in ("cameron2020", "smrke2024"):
        mod = MODULES[key]
        data = mod.load(paths)
        both = [mod.build_cases(data, tier=t, n_classes=n_classes, overrides=overrides, module=module)
                for t in (tier, other)]
        obs = [_simulate(cases, runner, mod) for cases in both]
        for case, a, b in zip(both[0], *obs):
            rows.append({"case": case.name,
                         "time_s": [a["shot_time_s"] if a else math.nan, b["shot_time_s"] if b else math.nan],
                         "ey_percent": [a["ey_percent"] if a else math.nan, b["ey_percent"] if b else math.nan]})
    transient = next((i for i, c in enumerate(v4_block.cases) if c.info["group"] == wz.TRANSIENT_GROUP), None)
    if transient is not None:
        case_other = [c for c in wz.build_cases(v4_block.data, tier=other, n_classes=n_classes, module=module)
                      if c.name == v4_block.cases[transient].name][0]
        spec = v4_block.spec_for(case_other, values, params)
        result = runner.run([spec])[0]
        b = None if "error" in result else observe(wz, case_other, result, spec)
        a = v4_observations[transient]

        def metrics(case: Any, o: dict[str, Any] | None) -> tuple[float, float, float]:
            m = v4_transient_metrics(case, o)
            if m is None:
                return math.nan, math.nan, math.nan
            tds = (o.get("tds_fractions") or [{"tds_percent": math.nan}])[0]["tds_percent"]
            return m["drops_model_s"], m["rise_model"]["q15"], tds

        ma, mb = metrics(v4_block.cases[transient], a), metrics(case_other, b)
        rows.append({"case": v4_block.cases[transient].name, "first_drops_s": [ma[0], mb[0]],
                     "flow_15s_g_s": [ma[1], mb[1]], "first_tds_percent": [ma[2], mb[2]]})

    def rel(pair: list[float]) -> float:
        return abs(pair[1] / pair[0] - 1.0) if _finite(pair[0]) and _finite(pair[1]) and pair[0] else math.nan

    time_diffs = [rel(r["time_s"]) for r in rows if "time_s" in r]
    ey_diffs = [abs(r["ey_percent"][1] - r["ey_percent"][0]) for r in rows if "ey_percent" in r
                if _finite(r["ey_percent"][0]) and _finite(r["ey_percent"][1])]
    worst_t = max((d for d in time_diffs if _finite(d)), default=math.nan)
    worst_ey = max(ey_diffs, default=math.nan)
    summary = {"tiers": [tier, other], "rows": rows, "max_time_rel": worst_t, "max_ey_points": worst_ey,
               "rms_time_rel": float(np.sqrt(np.nanmean(np.square(time_diffs)))) if time_diffs else math.nan,
               "rms_ey_points": float(np.sqrt(np.mean(np.square(ey_diffs)))) if ey_diffs else math.nan}
    v4row = next((r for r in rows if "first_tds_percent" in r), None)
    detail = (f"tier {other} vs tier {tier} on {len(time_diffs)} V3/V5 shots: time within "
              f"{_fmt(100 * worst_t, 2)}% (RMS {_fmt(100 * summary['rms_time_rel'], 2)}%), EY within {_fmt(worst_ey, 2)} points")
    if v4row:
        detail += (f"; V4 9 bar: first-fraction TDS {_fmt(v4row['first_tds_percent'][1])}% vs "
                   f"{_fmt(v4row['first_tds_percent'][0])}%, flow 15 s after the first drops "
                   f"{_fmt(v4row['flow_15s_g_s'][1])} vs {_fmt(v4row['flow_15s_g_s'][0])} g/s")
    return _check("Tier 0 vs tier 1 on the held-out cases", None, detail,
                  "reported, no PLAN target (tier 0 is the reduced model)", info=True), summary


#: Held-out checks whose outcome a prior or model choice was shaped by (calibration.md, "Prior provenance").
NOT_INDEPENDENT = {
    "V3 EY peak at grind setting 1.5–1.9": "model.prep.sigma_fines_sensitivity is a judgement motivated by Cameron "
                                           "2020's fine-grind behaviour, the V3 phenomenon",
    "V3 peak EY 22–24%": "model.prep.sigma_fines_sensitivity is a judgement motivated by Cameron 2020's fine-grind "
                         "behaviour, the V3 phenomenon",
}


def mark_independence(checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for c in checks:
        if c["check"] in NOT_INDEPENDENT:
            c["independent"] = False
            c["dependence"] = NOT_INDEPENDENT[c["check"]]
    return checks


#: PLAN §12 M1 exit criteria assessed by this report, with the checks each one needs.
EXIT_CRITERIA = (
    ("V1 within targets", ("V1 λ within ±10% (fit)", "V1 cup masses within ±10% (fit)",
                           "V1 leave-one-condition-out (±15%)")),
    ("V3 peak reproduced", ("V3 EY peak at grind setting 1.5–1.9", "V3 peak EY 22–24%")),
    ("V4 flow rise reproduced", ("V4 flow rises after the first drops", "V4 first drops after full pressure")),
)


def exit_criteria(checks: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The validation part of the M1 exit criteria (PLAN §12): pass if all its checks pass, partial if some
    fail while another passes, fail if none passes (not run while a check is missing and none failed). Near
    misses are described in the checks' details, not counted as passes."""
    by_name = {c["check"]: c for c in checks}
    out = []
    for name, needed in EXIT_CRITERIA:
        rows = [by_name.get(n) for n in needed]
        statuses = [r["status"] if r else "not run" for r in rows]
        if all(s == "pass" for s in statuses):
            status = "pass"
        elif "fail" not in statuses:
            status = "not run"
        elif "pass" in statuses:
            status = "partial"
        else:
            status = "fail"
        out.append({"criterion": name, "status": status, "checks": list(needed), "statuses": statuses})
    out.append({"criterion": "Verification suite green; tier 1 ≤ 1 s and tier 0 ≤ 10 ms per shot", "status": "not assessed",
                "checks": [], "statuses": [],
                "note": "covered by the solver's verification tests and benchmarks, not by this report"})
    return out


# -- figures ---------------------------------------------------------------------------------------


def make_figures(report: Mapping[str, Any], out_dir: Path) -> list[Path]:
    """Report figures (PNG); an empty list if matplotlib is not installed."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    # Colours: categorical slots 1-3 of the dataviz reference palette (validated all-pairs on the light
    # surface); model = slot 1 (lines, filled squares), data = slot 2 (open circles, error bars), so
    # identity never rests on colour alone. Target bands use the neutral midpoint grey.
    surface, ink, ink2, band = "#fcfcfb", "#0b0b0b", "#52514e", "#f0efec"
    slots = ("#2a78d6", "#eb6834", "#1baf7a")
    plt.rcParams.update({
        "figure.dpi": 110, "font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
        "figure.facecolor": surface, "axes.facecolor": surface, "savefig.facecolor": surface,
        "text.color": ink, "axes.labelcolor": ink, "axes.edgecolor": ink2, "xtick.color": ink2,
        "ytick.color": ink2, "axes.grid": True, "grid.color": "#e4e3df", "grid.linewidth": 0.6,
        "lines.linewidth": 1.5, "lines.markersize": 5.5, "legend.frameon": False,
    })
    model_c, data_c = slots[0], slots[1]
    written: list[Path] = []

    def save(fig: Any, name: str) -> None:
        path = out_dir / name
        fig.tight_layout()
        fig.savefig(path)
        plt.close(fig)
        written.append(path)

    blocks = report["calibration"]["blocks"]
    v1 = next((b.get("v1") for b in blocks.values() if "v1" in b), None)
    if v1:
        fig, axes = plt.subplots(1, 2, figsize=(8.0, 3.6))
        # one series (the model) per panel; analytes are told apart by marker shape, not colour
        offsets = {"trigonelline": -1.5, "caffeine": -0.5, "cqa5": 0.5, "tds": 1.5}
        for analyte, marker in (("trigonelline", "o"), ("caffeine", "s"), ("cqa5", "^"), ("tds", "D")):
            rows = [r for r in v1["rows"] if r["analyte"] == analyte]
            axes[0].plot([r["lambda_data"] for r in rows], [r["lambda_model"] for r in rows], marker, color=model_c,
                         mfc="none", label=analyte)
            points = [(int(mass) + offsets[analyte], m / d) for r in rows for mass, (m, d) in r["cups"].items()
                      if d and _finite(m)]
            axes[1].plot([x for x, _ in points], [y for _, y in points], marker, color=model_c, mfc="none", label=analyte)
        lims = axes[0].get_xlim()
        axes[0].fill_between(lims, [v * 0.9 for v in lims], [v * 1.1 for v in lims], color=band, lw=0, zorder=0,
                             label="±10% target")
        axes[0].plot(lims, lims, "-", color=ink2, lw=0.8)
        axes[0].set_xlabel("λ, data (g)")
        axes[0].set_ylabel("λ, model (g)")
        axes[0].set_title("V1 Schmieder: characteristic mass λ")
        axes[0].legend(frameon=False, fontsize=7)
        axes[1].axhspan(0.9, 1.1, color=band, lw=0, zorder=0, label="±10% target")
        axes[1].axhline(1.0, color=ink2, lw=0.8)
        axes[1].set_xticks([20, 40, 60])
        axes[1].set_xlabel("cup mass (g); analytes side by side")
        axes[1].set_ylabel("model / data (cup content)")
        axes[1].set_title("V1 Schmieder: cup masses at 20, 40, 60 g")
        save(fig, "v1-schmieder.png")
    qp = next((b.get("qp") for b in blocks.values() if "qp" in b), None)
    transient = report["held_out"].get("v4_transient", {})
    if qp:
        fig, axes = plt.subplots(1, 3, figsize=(10.5, 3.3))
        axes[0].errorbar([r["pressure_bar"] for r in qp], [r["data"] for r in qp], yerr=[r["sem"] for r in qp],
                         fmt="o", color=data_c, mfc="none", label="data (100 s)")
        axes[0].plot([r["pressure_bar"] for r in qp], [r["model"] for r in qp], "s-", color=model_c, label="model")
        axes[0].set_xlabel("basket pressure (bar)")
        axes[0].set_ylabel("long-time flow (g/s)")
        axes[0].set_title("V4 Waszkiewicz: Q(P), calibration")
        axes[0].legend(frameon=False, fontsize=7)
        if transient.get("flow_data"):
            fd = transient["flow_data"]
            if fd.get("sem_g_s"):
                lo = [q - e for q, e in zip(fd["q_g_s"], fd["sem_g_s"])]
                hi = [q + e for q, e in zip(fd["q_g_s"], fd["sem_g_s"])]
                axes[1].fill_between(fd["t_s"], lo, hi, color=data_c, alpha=0.25, lw=0, label="data ± SEM")
            axes[1].plot(fd["t_s"], fd["q_g_s"], color=data_c, label="data, 9 bar")
            axes[1].plot(transient["flow_model"]["t_s"], transient["flow_model"]["q_g_s"], color=model_c, label="model")
            axes[1].set_xlim(0, 100)
            axes[1].legend(frameon=False, fontsize=7)
        axes[1].set_xlabel("time after the pressure rise (s)")
        axes[1].set_ylabel("flow (g/s)")
        axes[1].set_title("V4 transient (held out)")
        tds_data = report.get("data", {}).get("waszkiewicz_tds", [])
        if tds_data:
            axes[2].errorbar([r["time_mid_s"] for r in tds_data], [r["tds_percent"] for r in tds_data],
                             yerr=[r["tds_sem_percent"] or 0 for r in tds_data], fmt="o", color=data_c, mfc="none",
                             label="data")
        if transient.get("tds_model"):
            axes[2].plot([r["time_mid_s"] for r in transient["tds_model"]],
                         [r["tds_percent"] for r in transient["tds_model"]], "s-", color=model_c, label="model")
        axes[2].axhspan(*V4_FIRST_TDS, xmax=0.12, color=band, lw=0, zorder=0)
        axes[2].set_xlabel("time after the first drops (s)")
        axes[2].set_ylabel("TDS of 5 s fraction (%)")
        axes[2].set_title("V4 TDS fractions (held out)")
        axes[2].legend(frameon=False, fontsize=7)
        save(fig, "v4-waszkiewicz.png")
    v3 = report["held_out"].get("v3", {})
    if v3.get("rows"):
        rows = v3["rows"]
        fig, axes = plt.subplots(1, 2, figsize=(8.0, 3.3))
        gs = [r["grind_setting"] for r in rows]
        axes[0].errorbar(gs, [r["ey_data"] for r in rows], yerr=[r.get("ey_bar") or 0.0 for r in rows], fmt="o",
                         color=data_c, mfc="none", label="data")
        axes[0].plot(gs, [r["ey_model"] for r in rows], "s-", color=model_c, label="model")
        axes[0].axhspan(*V3_PEAK_EY, color=band, lw=0, zorder=0)
        axes[0].axvspan(*V3_PEAK_SETTINGS, color=band, lw=0, zorder=0)
        axes[0].set_xlabel("EK43 grind setting")
        axes[0].set_ylabel("EY (%)")
        axes[0].set_title("V3 Cameron: EY (held out)")
        axes[0].legend(frameon=False, fontsize=7)
        axes[1].errorbar(gs, [r["time_data"] for r in rows], yerr=[r.get("time_bar") or 0.0 for r in rows], fmt="o",
                         color=data_c, mfc="none", label="data")
        axes[1].plot(gs, [r["time_model"] for r in rows], "s-", color=model_c, label="model")
        axes[1].legend(frameon=False, fontsize=7)
        axes[1].set_xlabel("EK43 grind setting")
        axes[1].set_ylabel("shot time to 40 g (s)")
        axes[1].set_title("V3 Cameron: shot time (held out)")
        save(fig, "v3-cameron.png")
    v5 = report["held_out"].get("v5", {})
    if v5.get("rows"):
        rows = v5["rows"]
        fig, axes = plt.subplots(1, 2, figsize=(8.0, 3.3))
        for setting, color in zip((190, 210, 250), slots):
            sel = sorted((r for r in rows if r["setting_um"] == setting), key=lambda r: r["fines_g"])
            axes[0].plot([r["fines_g"] for r in sel], [r["time_data"] for r in sel], "o", color=color, mfc="none")
            axes[0].plot([r["fines_g"] for r in sel], [r["time_model"] for r in sel], "s-", color=color,
                         label=f"{setting} µm")
            if sel and _finite(sel[-1]["time_model"]):
                axes[0].annotate(f"{setting} µm", (sel[-1]["fines_g"], sel[-1]["time_model"]), xytext=(4, 0),
                                 textcoords="offset points", fontsize=7, color=ink2, va="center")
        axes[0].set_xlabel("added fines (g)")
        axes[0].set_ylabel("shot time to 40 g (s)")
        axes[0].set_title("V5 Smrke: model (lines), data (circles)")
        axes[0].legend(frameon=False, fontsize=7)
        axes[1].plot([r["time_data"] for r in rows], [r["ey_data"] for r in rows], "o", color=data_c, mfc="none", label="data")
        axes[1].plot([r["time_model"] for r in rows], [r["ey_model"] for r in rows], "s", color=model_c, label="model")
        axes[1].fill_between(V5_FAST_TIMES, [V5_FAST_EY[0]] * 2, [V5_FAST_EY[1]] * 2, color=band, lw=0, zorder=0,
                             label="10–15 s, 17–18% target")
        axes[1].set_xlabel("shot time (s)")
        axes[1].set_ylabel("EY (%)")
        axes[1].set_title("V5 Smrke: EY vs time (held out)")
        axes[1].legend(frameon=False, fontsize=7)
        save(fig, "v5-smrke.png")
    ratios = next((b.get("ratios") for b in blocks.values() if "ratios" in b), None)
    bo = next((b.get("bodenstein") for b in blocks.values() if "bodenstein" in b), None)
    if ratios or bo:
        fig, axes = plt.subplots(1, 2, figsize=(8.0, 3.2))
        if ratios:
            labels = [f"{r['grind']} {int(r['density'])}" for r in ratios]
            pos = np.arange(len(ratios))
            axes[0].bar(pos - 0.21, [r["data"] for r in ratios], 0.4, color=data_c, label="data")
            axes[0].bar(pos + 0.21, [r["model"] if _finite(r["model"]) else 0 for r in ratios], 0.4, color=model_c,
                        label="model")
            axes[0].set_xticks(pos, labels, rotation=45, fontsize=7)
            axes[0].set_ylabel("κ(ρ)/κ(360 kg/m³)")
            axes[0].set_title("V6 Corrochano: density effect")
            axes[0].legend(frameon=False, fontsize=7)
        if bo:
            pos = np.arange(len(bo))
            axes[1].plot(pos, [r["data"] for r in bo], "o", color=data_c, mfc="none", label="data")
            axes[1].plot(pos, [r["model"] for r in bo], "s", color=model_c, label="model")
            axes[1].axhspan(*V2_BODENSTEIN, color=band, lw=0, zorder=0)
            axes[1].set_xticks(pos, [r["case"].split("/")[-1] for r in bo], fontsize=7)
            axes[1].set_ylabel("Bodenstein number")
            axes[1].set_title("V2 Vaca Guerra: dispersion")
            axes[1].legend(frameon=False, fontsize=7)
        save(fig, "v2-v6-closures.png")
    return written


# -- report -----------------------------------------------------------------------------------------


def run_validation(
    paths: RepoPaths,
    *,
    calibration_path: Path | None = None,
    config_path: Path | None = None,
    tier: int | None = None,
    n_classes: int | None = None,
    jobs: int = 1,
    simulate: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    module: ModuleType | None = None,
) -> dict[str, Any]:
    """Runs every check and returns the report document."""
    config_path = config_path or paths.root / "data" / "calibration" / "config.yaml"
    config = load_config(config_path)
    if n_classes is not None:
        config = {**config, "n_classes": n_classes}
    calibration_path = calibration_path or paths.root / "data" / "calibration" / "current.yaml"
    calibration_doc = load_calibration_document(calibration_path)
    calibrated = calibrated_values(calibration_doc)
    from .identity import input_hashes, solver_identity

    solver = solver_identity(paths, module)
    fit_doc = calibration_doc.get("fit") or {}
    reuse_issues = calibration_reuse_issues(
        calibration_doc, solver, input_hashes(paths, str(config_path), fit_doc.get("datasets") or []))
    problem = build_problem(paths, config, tier=tier, jobs=jobs, simulate=simulate, module=module)
    # Record the M1.1 water-inventory ledger over this validation run. Historical calibration
    # robustness remains as recorded; this does not imply the older fit collected the diagnostic.
    problem.runner.WORST_MAX = (*problem.runner.WORST_MAX, "hydraulic_volume_balance_error")
    try:
        x = _calibration_x(problem, calibrated)
        calibration, observations = fit_quality(problem, x)
        calibration["checks"].insert(2, loo_check(fit_doc.get("loo"), stale_reasons=reuse_issues))
        values = problem.values(x)
        # the fitted values at x, plus app-facing values that are not fit parameters (the pooled reference
        # permeability), so that held-out builders see exactly what the app's builder will use
        overrides = shared_overrides(problem, {**calibrated, **values}, module)
        tier_used = int(config.get("tier", 1) if tier is None else tier)
        n_used = int(config.get("n_classes", 16))
        held: dict[str, Any] = {}
        checks: list[dict[str, Any]] = []
        c3, held["v3"] = check_v3(paths, problem.runner, overrides, tier=tier_used, n_classes=n_used, module=module)
        v4 = next(b for b in problem.blocks if b.module.KEY == "waszkiewicz2026")
        c4, held["v4_transient"] = check_v4_transient(v4, observations[v4.name])
        c5, held["v5"] = check_v5(paths, problem.runner, overrides, tier=tier_used, n_classes=n_used, module=module)
        checks = c3 + c4 + c5
        c_tier, held["tiers"] = tier_agreement(paths, problem.runner, overrides, v4, observations[v4.name], values,
                                               problem.params, tier=tier_used, n_classes=n_used, module=module)
        c_generic, held["generic"] = check_generic_shots(problem.runner, overrides, tier=tier_used, module=module)
        checks += [check_held_out_times(held["v3"], held["v5"], held.get("v4_transient")), c_tier, c_generic]
        mark_independence(checks)
        structural = {}
        sens_doc = (calibration_doc.get("fit") or {}).get("sensitivity") or {}
        base_id = base_permeability_id(problem.blocks[0].cases[0].recipe, module) if problem.blocks else None
        for name, variant in (sens_doc.get("variants") or {}).items():
            if not variant.get("structural"):
                continue
            known = {p.id for p in problem.params if p.mode == "override"}
            v_overrides = {**overrides, **{k: v for k, v in (variant.get("shared") or {}).items() if k in known}}
            if base_id and variant.get("pooled_kappa_ref_m2"):
                v_overrides[base_id] = variant["pooled_kappa_ref_m2"]
            fields = (variant.get("options") or {}).get("spec_fields")
            _, v3 = check_v3(paths, problem.runner, v_overrides, tier=tier_used, n_classes=n_used, module=module,
                             spec_fields=fields)
            _, v5 = check_v5(paths, problem.runner, v_overrides, tier=tier_used, n_classes=n_used, module=module,
                             spec_fields=fields)
            # the 9-bar transient (V4, held out) at the variant's refitted values
            from .cases import waszkiewicz2026 as wz

            v4_metrics = None
            transient = next((c for c in v4.cases if c.info["group"] == wz.TRANSIENT_GROUP), None)
            if transient is not None:
                v_values = {**values, **{k: v for k, v in {**(variant.get("shared") or {}),
                                                           **(variant.get("nuisance") or {})}.items() if k in values}}
                spec = v4.spec_for(transient, v_values, problem.params)
                for path, value in (fields or {}).items():
                    from .cases.common import set_path

                    set_path(spec, path, value)
                result = problem.runner.run([spec])[0]
                obs4 = None if "error" in result else observe(wz, transient, result, spec)
                v4_metrics = v4_transient_metrics(transient, obs4)
                if v4_metrics is not None:
                    fr = (obs4.get("tds_fractions") or [{"tds_percent": math.nan}])[0]["tds_percent"]
                    v4_metrics["first_tds_percent"] = fr
            structural[name] = {"spec_fields": fields, "v3": v3, "v5": v5, "v4": v4_metrics,
                                "kappa_ref_by_dataset": variant.get("kappa_ref_by_dataset"),
                                "pooled_kappa_ref_m2": variant.get("pooled_kappa_ref_m2"),
                                "nuisance": variant.get("nuisance"), "v1_cost": variant.get("v1_cost"),
                                "cost": variant.get("cost"), "blocks": variant.get("blocks"),
                                "optimizer": variant.get("optimizer"), "pump": variant.get("pump"),
                                "pressure_rms": variant.get("pressure_rms")}
        held["structural"] = structural
        first = problem.blocks[0].cases[0].spec if problem.blocks and problem.blocks[0].cases else {}
        held["theta"] = (first.get("hydraulics") or {}).get("dissolution_porosity_share", "absent")
        from .cases import waszkiewicz2026

        fit_doc = calibration_doc.get("fit") or {}
        uncertainties = fit_doc.get("uncertainties") or {}
        parameters = {p.id: {"value": values[p.id], "units": p.units, "mode": p.mode,
                             "calibrated": p.id in calibrated,
                             "sd": (uncertainties.get(p.id) or {}).get("sd"),
                             "prior_sd_ratio": (uncertainties.get(p.id) or {}).get("prior_sd_ratio"),
                             "at_bound": (uncertainties.get(p.id) or {}).get("at_bound")} for p in problem.params}
        reference = fit_doc.get("reference_permeability")
        if REFERENCE_PERMEABILITY_ID in calibrated:
            parameters[REFERENCE_PERMEABILITY_ID] = {
                "value": calibrated[REFERENCE_PERMEABILITY_ID], "units": "m^2", "mode": "pooled",
                "calibrated": True, "sd": None,
                "prior_sd_ratio": None, "at_bound": None}

        report = {
            "schema": "puckworks.validation-report/1",
            "created": datetime.date.today().isoformat(),
            "tools_version": __version__,
            "core_version": core(module).__version__,
            "solver": solver,
            "calibration_solver": (calibration_doc.get("fit") or {}).get("solver"),
            "calibration_statistics_issues": reuse_issues,
            "placeholder": problem.runner.placeholder,
            "solver_warnings": sorted(problem.runner.warnings),
            "calibration_file": paths.relative(calibration_path) if calibrated else None,
            "parameters": parameters,
            "reference_permeability": reference,
            "calibration_blocks": fit_doc.get("blocks") or {},
            "reduced_chi2": fit_doc.get("reduced_chi2"),
            "sensitivity": fit_doc.get("sensitivity"),
            "nuisance": fit_doc.get("nuisance") or {},
            "fixed": fit_doc.get("fixed") or {},
            "weakly_identified": fit_doc.get("weakly_identified") or [],
            "tier": tier_used,
            "n_classes": n_used,
            "calibration": calibration,
            "held_out": held,
            "held_out_checks": checks,
            "exit_criteria": exit_criteria([*calibration["checks"], *checks]),
            "robustness": problem.runner.robustness(),
            "simulations": problem.runner.simulations,
            "data": {"waszkiewicz_tds": waszkiewicz2026.load(paths)["tds"]},
            "waszkiewicz_psd": psd_tail(waszkiewicz2026.load(paths)["psd"]),
        }
        return report
    finally:
        problem.runner.close()


def _pct(x: Any) -> float:
    """100·x, NaN for a missing value (a report re-read from JSON stores NaN as null)."""
    return 100.0 * x if isinstance(x, (int, float)) else math.nan


def _cup(row: Mapping[str, Any], mass: int) -> tuple[Any, Any]:
    """A V1 row's (model, data) cup mass at ``mass`` grams; JSON turns the integer keys into strings."""
    cups = row["cups"]
    return tuple(cups[mass] if mass in cups else cups[str(mass)])


def _fmt(x: Any, digits: int = 3) -> str:
    if x is None:
        return "—"
    if isinstance(x, float):
        return f"{x:.{digits}g}" if math.isfinite(x) else "—"
    return str(x)


def known_biases(report: Mapping[str, Any]) -> list[str]:
    """The 'Known biases' box at the top of the report, from the run's own numbers."""
    items = []
    held = report.get("held_out") or {}
    v4t = held.get("v4_transient") or {}
    startup_checks = {c["check"]: c["status"] for c in report.get("held_out_checks", [])}
    startup_failed = any(startup_checks.get(name) == "fail" for name in (
        "V4 flow rises after the first drops", "V4 first drops after full pressure"))
    if v4t.get("rise_model") and startup_failed:
        items.append(
            f"**Startup mismatch.** The V4 9-bar case has long-time flow "
            f"{_fmt(v4t.get('long_time_model_g_s'))} against {_fmt(v4t.get('long_time_data_g_s'))} g/s and reaches 36 g "
            f"at ×{_fmt(v4t.get('time_to_mass_ratio'), 2)} of the measured time. The model's flow reaches 90% of its "
            f"100 s value {_fmt(v4t['rise_model']['t90_s'])} s after the first drops instead of "
            f"{_fmt(v4t['rise_data']['t90_s'])} s, and "
            f"its first drops come {_fmt(v4t.get('drops_model_s'))} s after full pressure instead of "
            f"{_fmt(v4t.get('drops_data_s'))} s. The held-out V3 and V5 time ratios are "
            f"×{_fmt((held.get('v3') or {}).get('time_ratio'), 2)} and ×{_fmt((held.get('v5') or {}).get('time_ratio'), 2)}. "
            "Total shot times combine startup and permeability errors; they do not isolate κ_ref.")
    v1 = next((b for b in (report.get("calibration") or {}).get("blocks", {}).values() if b.get("pump_limited")), None)
    if v1:
        pump = v1["pump_limited"]
        trans = [v for v in pump.get("transition_s", {}).values() if v > 0]
        capped = pump.get("pour_capped") or []
        if trans or capped:
            items.append(
                f"**Pump saturation in V1.** {len(trans)} of {len(pump.get('transition_s', {}))} Schmieder shots reach "
                "the pump's 12 bar limit during the preinfusion-to-pour switch"
                + (f" (for {_fmt(min(trans), 2)}–{_fmt(max(trans), 2)} s)" if trans else "")
                + (f"; the pours of experiment(s) {', '.join(str(e) for e in capped)} reach the limit "
                   f"(longest {_fmt(max(pump.get('pour_s', {}).values() or [0.0]), 3)} s)" if capped else "")
                + ". The measured per-shot maxima are 2.5–9.3 bar (Table S3). The simplified DE1 control and "
                "startup hydraulics do not reproduce those maxima.")
    ref = report.get("reference_permeability") or {}
    sens = ((report.get("sensitivity") or {}).get("variants") or {})
    spreads = []
    if ref.get("max_over_min"):
        spreads.append(f"×{_fmt(ref['max_over_min'], 2)} across the four estimates (the two datasets ×"
                       f"{_fmt(max((ref.get('datasets') or {1: 1}).values()) / min((ref.get('datasets') or {1: 1}).values()), 2)})")
    whole = sens.get("whole-shot peak pressure")
    base_s = (ref.get("datasets") or {}).get("schmieder2023")
    if whole and base_s and whole.get("schmieder_kappa_ref_m2"):
        spreads.append(f"×{_fmt(whole['schmieder_kappa_ref_m2'] / base_s, 2)} between the whole-shot and pour-phase "
                       "pressure comparisons")
    theta = next((v for n, v in sens.items() if v.get("structural")), None)
    if theta and ref.get("value_m2") and theta.get("pooled_kappa_ref_m2"):
        spreads.append(f"×{_fmt(ref['value_m2'] / theta['pooled_kappa_ref_m2'], 2)} between θ = 0 and θ = 0.27")
    if spreads:
        items.append("**κ_ref rests on structural choices.** " + "; ".join(spreads)
                     + ". Fit uncertainties describe the chosen model and do not include this structural spread.")
    blocks = report.get("calibration_blocks") or {}
    if blocks:
        per = ", ".join(f"{name} {_fmt(b.get('chi2_per_residual', (b['chi2'] / b['residuals']) if b.get('residuals') else math.nan), 3)}"
                        for name, b in blocks.items())
        items.append(f"**Uncertainties are lower bounds.** Reduced chi-square {_fmt(report.get('reduced_chi2'), 3)} "
                     f"(χ²/n by block: {per}); V1 holds {blocks.get('V1', {}).get('residuals', '—')} of "
                     f"{sum(b.get('residuals', 0) for b in blocks.values())} residuals, and its cup masses share "
                     "information with c₀, λ and the first fraction (Eq. 3).")
    items.append("**EY levels.** V3 and V5 EY rest on the bean's 28% extractable solids (input models), which no "
                 "M1 dataset calibrates for those coffees.")
    v2 = next((b for b in (report.get("calibration") or {}).get("blocks", {}).values() if "bodenstein" in b), None)
    if v2:
        items.append(f"**V2.** The model's Bodenstein number is above the data in {v2.get('bodenstein_above_data')} of "
                     f"{len(v2['bodenstein'])} cases; the held-out compound curves were not run (licence).")
    return ["## Known biases", ""] + [f"- {item}" for item in items] + [""]


def render_markdown(report: Mapping[str, Any], figures: Sequence[str]) -> str:
    """The Markdown report."""
    lines = ["<!-- SPDX-License-Identifier: GPL-2.0-or-later -->",
             "# M1 validation report",
             "",
             f"*Generated by `puckworks-tools validate` on {report['created']} · puckcore {report['core_version']} · "
             f"puckworks-tools {report['tools_version']} · tier {report['tier']}, {report['n_classes']} size classes.*",
             ""]
    solver = report.get("solver") or {}
    if solver:
        sources = solver.get("sources_sha256") or {}
        lines += [f"*Solver build: extension {solver.get('extension_sha256', '—')} (built {solver.get('extension_built', '—')}); "
                  "sources " + ", ".join(f"`{k}` {v}" for k, v in sources.items()) + "."
                  + (" The calibration ran on sources " + ", ".join(f"`{k}` {v}" for k, v in
                     ((report.get("calibration_solver") or {}).get("sources_sha256") or {}).items()) + "."
                     if report.get("calibration_solver") else "") + "*", ""]
    if report["placeholder"]:
        lines += ["> **The solver reported itself as a placeholder.** These numbers test the report machinery only;",
                  "> they say nothing about the model. Regenerate this report once the M1 solver has landed.", ""]
    calib = report["calibration_file"]
    if report.get("calibration_statistics_issues"):
        lines += ["Cached calibration statistics are historical for this run: "
                  + "; ".join(report["calibration_statistics_issues"]) + ". "
                  "The parameters are evaluated below, but the calibration file's uncertainties and sensitivity "
                  "refits belong to its recorded solver/configuration. Its leave-one-out scores are not reused.", ""]
    lines += known_biases(report)
    lines += ["Datasets, case builders and the calibration harness: [case-builders.md](case-builders.md),",
              "[calibration.md](calibration.md). Targets: [PLAN §10](../PLAN.md#10-verification-and-validation).",
              "",
              ("Parameters: calibrated values from `" + calib + "` where present, registry defaults otherwise."
               if calib else "Parameters: **no calibration file**; all parameters at their registry defaults."),
              "", "## Summary", "", "| Check | Status | Result | Target |", "|---|---|---|---|"]
    status_icon = {"pass": "pass", "fail": "**fail**", "not run": "not run", "info": "info", "partial": "**partial**",
                   "not assessed": "not assessed"}
    for c in [*report["calibration"]["checks"], *report["held_out_checks"]]:
        mark = " (not independent)" if c.get("independent") is False else ""
        lines.append(f"| {c['check']} | {status_icon[c['status']]}{mark} | {c['detail']} | {c['target']} |")
    lines += ["", "Calibration checks measure fit quality (V1, V2, V4 Q(P), V6); accuracy is reported only from the",
              "held-out checks (V3, V4 transient, V5), per PLAN §10."]
    if report.get("exit_criteria"):
        lines += ["", "### M1 exit criteria (PLAN §12), validation part", "", "| Criterion | Status | Checks |",
                  "|---|---|---|"]
        for e in report["exit_criteria"]:
            what = ", ".join(f"{c} ({st})" for c, st in zip(e["checks"], e["statuses"])) or e.get("note", "")
            lines.append(f"| {e['criterion']} | {status_icon.get(e['status'], e['status'])} | {what} |")
    lines += ["", "## 1. Calibration fit quality", "",
              "RMS of the normalised residuals as this report recomputes them, next to the calibration file's; they "
              "agree when the run reproduces itself. χ²/n is from the calibration file.", "",
              "| Block | Dataset | Cases | Residuals | RMS (this report) | RMS (calibration file) | χ²/n | Failed shots |",
              "|---|---|---|---|---|---|---|---|"]
    file_blocks = report.get("calibration_blocks") or {}
    for name, b in report["calibration"]["blocks"].items():
        fb = file_blocks.get(name) or {}
        per = fb.get("chi2_per_residual", (fb["chi2"] / fb["residuals"]) if fb.get("residuals") else None)
        lines.append(f"| {name} | {b['dataset']} | {b['cases']} | {b['residuals']} | {_fmt(b['rms'])} | "
                     f"{_fmt(fb.get('rms'))} | {_fmt(per)} | {len(b['failures'])} |")
    lines += ["", "### Parameters", "",
              "SD from the fit's Jacobian (scaled by the reduced chi-square); SD/prior is the posterior SD over the "
              "registry prior's SD in the fit's coordinates (log10 for log-scaled parameters): at 0.5 or more the "
              "data add little to the prior.", "",
              "| Registry id | Value | Units | Mode | SD | SD/prior | Source |", "|---|---|---|---|---|---|---|"]
    for pid, p in report["parameters"].items():
        flags = " (at bound)" if p.get("at_bound") else ""
        lines.append(f"| `{pid}` | {_fmt(p['value'], 4)} | {p['units']} | {p['mode']} | {_fmt(p.get('sd'), 2)} | "
                     f"{_fmt(p.get('prior_sd_ratio'), 2)}{flags} | "
                     f"{'calibration' if p['calibrated'] else 'registry default'} |")
    ref = report.get("reference_permeability")
    if ref:
        datasets = ref.get("datasets") or {}
        by_dataset = "; ".join(f"{d} {_fmt(v, 3)} m²" for d, v in datasets.items())
        spread = (max(datasets.values()) / min(datasets.values())) if len(datasets) > 1 else 1.0
        lines += ["", f"**Reference permeability** `{ref['id']}`: pooled {_fmt(ref['value_m2'], 3)} m² "
                  f"({ref['pooling']}). By dataset: {by_dataset}"
                  + ((f"; the datasets differ by ×{spread:.2f}"
                      + (", more than their fit uncertainties: the pooled value carries that disagreement" if spread > 1.5 else ""))
                     if len(datasets) > 1 else "")
                  + f". Spread of all estimates: log-SD {_fmt(ref['log_sd'], 2)}, max/min {_fmt(ref['max_over_min'], 3)}."
                  + (f" Re-pooled on {ref['repooled']['date']} with puckcore {ref['repooled']['core_version']} (was "
                     f"{_fmt(ref['repooled']['previous_m2'], 3)} m²)." if ref.get("repooled") else ""), "",
                  "Each estimate is the fitted bare κ₀ divided by the builder's scaling of the app's representation of "
                  "that grind (the scaling basis). D32 values from different bases are not strictly comparable: "
                  "Waszkiewicz's PSD is laser diffraction (Mastersizer 2000; the article does not say wet or dry "
                  "dispersion), while the grinder presets' D32 comes from the input models, anchored on other "
                  "measurements.", "",
                  "| Nuisance κ₀ | Dataset | Scaling basis | κ₀ (m²) | Builder scaling | D32/D32_ref | κ_ref (m²) |",
                  "|---|---|---|---|---|---|---|"]
        lines += [f"| `{e['parameter']}` | {e['dataset']} | {e.get('scaling_basis', '')} | {_fmt(e['kappa0_m2'], 3)} | "
                  f"{_fmt(e['builder_scaling'], 3)} | {_fmt(e['sauter_ratio'], 3)} | {_fmt(e['kappa_ref_m2'], 3)} |"
                  for e in ref["estimates"]]
        tail = report.get("waszkiewicz_psd") or {}
        v3, v5 = report["held_out"].get("v3", {}), report["held_out"].get("v5", {})
        v4t = report["held_out"].get("v4_transient") or {}
        lines += ["", "**Tension with typical espresso grinds.** Published espresso grinds have a dry D32 of about "
                  "80–145 µm (Cameron, Corrochano ΨB–E, Smrke), while Waszkiewicz's grind measures about 49 µm (it was "
                  "chosen for the SCA guideline of 37 g in 32 s at 9 bar; the article's own 9 bar shots reached 37 g "
                  "at about 48 s). κ₀ scales with D32², so differences in the measured PSD affect the "
                  "reference permeability inferred from each dataset. The held-out shot times come out at "
                  f"×{_fmt(v3.get('time_ratio'), 2)} (V3 Cameron, mean error {_fmt(v3.get('bias_time'), 2)} s) and "
                  f"×{_fmt(v5.get('time_ratio'), 2)} (V5 Smrke, {_fmt(v5.get('bias_time'), 2)} s). The V4 case, "
                  f"calibrated on long-time flow, reaches 36 g at ×{_fmt(v4t.get('time_to_mass_ratio'), 2)} of its "
                  "measured time. These times combine startup and permeability effects. κ_ref is not tuned to them.",
                  "",
                  f"- *Waszkiewicz's PSD is atypical.* X50 {_fmt(tail.get('x50_um'), 3)} µm, X90 "
                  f"{_fmt(tail.get('x90_um'), 3)} µm, {_fmt(_pct(tail.get('share_below_100um')), 3)}% of the "
                  f"volume below 100 µm; {_fmt(tail.get('last_bin_percent'), 2)}% of the volume sits in the "
                  f"{_fmt((tail.get('last_bin_um') or [math.nan])[0], 3)}–{_fmt((tail.get('last_bin_um') or [math.nan, math.nan])[1], 3)} µm "
                  f"bin and nothing above, although the bins run to {_fmt(tail.get('bins_to_um'), 3)} µm and the "
                  "Mastersizer 2000 reads to 2000 µm. A coarse tail that ends this abruptly suggests that coarse "
                  "particles were under-represented (settling in a wet dispersion unit, or sample selection; the "
                  "article does not say), which lowers this D32 and raises this dataset's κ_ref. The authors describe "
                  "their grounds as \"of typical size below 200 µm\".",
                  "- *Schmieder's D32 rests on the E65S dial mapping.* The dial's scale is disputed (the brochure's "
                  "≈5 µm per indicator read as burr movement or as a particle-size bandwidth), so the preset maps the "
                  "dial to a burr gap fitted to the article's wet-laser D[4,3] at GL 1.4 and 2.0, and its D32 comes "
                  "from the input models' fines relation (fitted to dry-laser and Camsizer PSDs), not from the "
                  "article's wet D32 of 27–29 µm, which includes 1–10 µm debris. A 10% smaller D32 at the same "
                  "settings would raise the Schmieder estimate by about 23%."]
    if report.get("fixed"):
        lines += ["", "**Held at their registry values** (reviewed, not fitted):", "", "| Parameter | Value | Reason |",
                  "|---|---|---|"]
        for pid, f in report["fixed"].items():
            unit = "" if f.get("units") in (None, "1") else f.get("units")
            value = f"{_fmt(f.get('value'), 4)} {unit}".strip() if f.get("value") is not None else "solver default"
            lines.append(f"| `{pid}` | {value} | {f['reason']} |")
    v1 = next((b.get("v1") for b in report["calibration"]["blocks"].values() if "v1" in b), None)
    v1_pump = next((b.get("pump_limited") for b in report["calibration"]["blocks"].values() if b.get("pump_limited")), None)
    pump_text = ""
    if v1_pump:
        trans = {int(k): v for k, v in v1_pump.get("transition_s", {}).items()}
        pour = {int(k): v for k, v in v1_pump.get("pour_s", {}).items()}
        pump_text = (" Seconds at the pump's 12 bar limit, switch / pour, by experiment: "
                     + ", ".join(f"{e}: {_fmt(trans[e], 2)} / {_fmt(pour.get(e, 0.0), 3)}" for e in sorted(trans))
                     + ". Peak-pressure residuals of pump-capped pours are kept and flagged (they understate the "
                     "misfit: the model cannot pass the set flow below 12 bar); the sensitivity table shows the fit "
                     "without them.")
    if v1:
        lines += ["", "### V1 Schmieder 2023", "",
                  f"λ within ±10%: {v1['lambda_within']}/{v1['lambda_total']} (largest error "
                  f"{_fmt(_pct(v1['lambda_max_error']), 3)}%); cup masses within ±10%: {v1['cup_within']}/{v1['cup_total']} "
                  f"(largest error {_fmt(_pct(v1['cup_max_error']), 3)}%). The leave-one-condition-out check (target "
                  "±15%) is in the summary table; it is mildly optimistic, because parameters shared with other "
                  "blocks stay at their full-fit values in each refit."
                  + (f" Worst λ: experiment {v1['lambda_worst']['experiment']}, {v1['lambda_worst']['analyte']}, "
                     f"{_fmt(_pct(v1['lambda_worst']['error']), 3)}%." if v1.get("lambda_worst") else "")
                  + pump_text, "",
                  "| Exp. | Analyte | λ model (g) | λ data (g) | cup 40 g model | cup 40 g data |", "|---|---|---|---|---|---|"]
        for r in v1["rows"]:
            m40, d40 = _cup(r, 40)
            lines.append(f"| {r['experiment']} | {r['analyte']} | {_fmt(r['lambda_model'])} | {_fmt(r['lambda_data'])} | "
                         f"{_fmt(m40)} | {_fmt(d40)} |")
    sens = report.get("sensitivity")
    if sens and sens.get("variants") and v1:
        kappa_ids = [k for k in sorted(report.get("nuisance", {})) if k.startswith("calibration.schmieder2023.permeability")]
        ref = report.get("reference_permeability") or {}
        v1_block = next((b for b in report["calibration"]["blocks"].values() if "v1" in b), {})
        pressure_rms = v1_block.get("pressure_rms")
        lines += ["", "### V1 sensitivity", "",
                  "V1 refitted under changed case assumptions; parameters shared with other blocks held at their "
                  "fitted values; the pooled value keeps the other datasets' estimates. The first row is the "
                  "calibration itself.", "",
                  "| Variant | V1 cost | κ₀ by grinding level (m²) | Schmieder κ_ref (m²) | Pooled κ_ref (m²) | "
                  "Peak-pressure RMS | λ within ±10% | Cups within ±10% |", "|---|---|---|---|---|---|---|---|"]
        base_k = ", ".join(_fmt(report["nuisance"].get(k), 3) for k in kappa_ids)
        lines.append(f"| as calibrated | {_fmt(v1_block.get('cost'), 4)} | {base_k} | "
                     f"{_fmt((ref.get('datasets') or {}).get('schmieder2023'), 3)} | {_fmt(ref.get('value_m2'), 3)} | "
                     f"{_fmt(pressure_rms, 3)} | {v1['lambda_within']}/{v1['lambda_total']} | "
                     f"{v1['cup_within']}/{v1['cup_total']} |")
        for name, v in sens["variants"].items():
            if v.get("structural") or "V1" not in v.get("blocks", ["V1"]):
                continue
            ks = ", ".join(_fmt(v["nuisance"].get(k), 3) for k in kappa_ids)
            lines.append(f"| {name} | {_fmt(v.get('v1_cost', v.get('cost')), 4)} | {ks} | "
                         f"{_fmt(v.get('schmieder_kappa_ref_m2'), 3)} | {_fmt(v.get('pooled_kappa_ref_m2'), 3)} | "
                         f"{_fmt(v.get('pressure_rms'), 3)} | {v.get('lambda_within', '—')}/60 | {v.get('cup_within', '—')}/180 |")
    structural = report["held_out"].get("structural") or {}
    if structural:
        v3h, v5h = report["held_out"].get("v3", {}), report["held_out"].get("v5", {})
        ref = report.get("reference_permeability") or {}

        def held_out_summary(v3: Mapping[str, Any], v5: Mapping[str, Any]) -> str:
            rows3 = v3.get("rows") or []
            peak = max(rows3, key=lambda r: r["ey_model"] if _finite(r["ey_model"]) else -1.0) if rows3 else None
            eys5 = [r["ey_model"] for r in v5.get("rows") or [] if _finite(r["ey_model"])]
            return (f"×{_fmt(v3.get('time_ratio'), 2)} | "
                    + (f"{_fmt(peak['ey_model'], 3)}% at GS {peak['grind_setting']}" if peak else "—")
                    + f" | ×{_fmt(v5.get('time_ratio'), 2)} | {_fmt(float(np.mean(eys5)) if eys5 else math.nan, 3)}% | "
                    + f"{_fmt(v5.get('spearman_model'), 2)}")

        all_kappa = sorted(k for k in report.get("nuisance", {}) if ".permeability" in k)
        blocks = report["calibration"]["blocks"]
        base_total = sum(b.get("cost", 0.0) for b in blocks.values())
        base_v1 = next((b.get("cost") for b in blocks.values() if "v1" in b), None)
        comparison = []
        for name, v in structural.items():
            refit = "+".join(v.get("blocks") or [])
            opt = v.get("optimizer") or {}
            pump = v.get("pump") or {}
            capped = pump.get("pour_capped") or []
            flags = []
            if opt and not opt.get("success", True):
                flags.append(f"the refit did not converge ({opt.get('message')})")
            if capped:
                flags.append(f"{len(capped)} of 15 V1 pours sit at the pump's 12 bar limit")
            comparison.append(
                f"The row refits {refit} at the old value: total cost {_fmt(v.get('cost'), 4)} against "
                f"{_fmt(base_total, 4)} at θ = 0, peak-pressure RMS {_fmt(v.get('pressure_rms'), 3)}"
                + (f"; {'; '.join(flags)}" if flags else "") + ". "
                + ("A degenerate refit like this is not evidence for or against θ."
                   if flags else "The cost difference is within one model and is not evidence for θ."))
        lines += ["", "### Structural sensitivity: dissolution share θ", "",
                  "A sensitivity analysis of a structural assumption, not a choice: the calibration fixes θ at its "
                  "mechanistic default, 0 (the insoluble cell walls hold the particle envelope, so dissolution opens "
                  "intraparticle pores). θ is collinear with the bed permeability: the grinding-level permeabilities "
                  "and contents move to absorb it, so κ₀ and κ_ref change with it. " + " ".join(comparison)
                  + " Independent evidence for θ would have to come from flow-rise data, which M1 holds out (V4 "
                  "transient), or from new experiments. The rows repeat the held-out predictions at both values.", "",
                  "| θ | κ₀: Schmieder GL 1.4, 1.7, 2.0; Waszkiewicz (m²) | κ_ref by dataset (m²) | pooled κ_ref (m²) | "
                  "V3 time model/data | V3 peak EY | V5 time model/data | V5 mean EY | V5 ρ(time, EY) |",
                  "|---|---|---|---|---|---|---|---|---|"]
        theta_main = report["held_out"].get("theta")
        label = ("solver default" if theta_main is None else _fmt(theta_main, 3)) + " (calibration)"
        lines.append(f"| {label} | {', '.join(_fmt(report['nuisance'].get(k), 3) for k in all_kappa)} | "
                     + ", ".join(f"{d} {_fmt(v, 3)}" for d, v in (ref.get("datasets") or {}).items())
                     + f" | {_fmt(ref.get('value_m2'), 3)} | {held_out_summary(v3h, v5h)} |")
        v4_lines = []
        base_v4 = report["held_out"].get("v4_transient") or {}
        if base_v4.get("rise_model"):
            v4_lines.append(f"V4 9 bar at θ = 0: 90% of the 100 s flow {_fmt(base_v4['rise_model']['t90_s'])} s after the "
                            f"first drops (data {_fmt(base_v4['rise_data']['t90_s'])} s), first drops "
                            f"{_fmt(base_v4.get('drops_model_s'))} s after full pressure (data {_fmt(base_v4.get('drops_data_s'))} s).")
        for name, v in structural.items():
            theta = (v.get("spec_fields") or {}).get("hydraulics.dissolution_porosity_share")
            m4 = v.get("v4")
            if m4:
                v4_lines.append(f"V4 9 bar at θ = {_fmt(theta, 3)}: 90% of the 100 s flow {_fmt(m4['rise_model']['t90_s'])} s "
                                f"after the first drops, first drops {_fmt(m4.get('drops_model_s'))} s after full pressure, "
                                f"first 5 s fraction {_fmt(m4.get('first_tds_percent'))}% TDS.")
            tags = []
            if (v.get("optimizer") or {}).get("success") is False:
                tags.append("unconverged")
            if (v.get("pump") or {}).get("pour_capped"):
                tags.append("pump-capped")
            label = name.split('(')[-1].rstrip(')') if '(' in name else name
            lines.append(f"| {_fmt(theta, 3)} ({label}{'; ' + ', '.join(tags) if tags else ''}) | "
                         f"{', '.join(_fmt((v.get('nuisance') or {}).get(k), 3) for k in all_kappa)} | "
                         + ", ".join(f"{d} {_fmt(k, 3)}" for d, k in (v.get("kappa_ref_by_dataset") or {}).items())
                         + f" | {_fmt(v.get('pooled_kappa_ref_m2'), 3)} | {held_out_summary(v['v3'], v['v5'])} |")
        if v4_lines:
            lines += [""] + [" ".join(v4_lines)]
    for name, b in report["calibration"]["blocks"].items():
        if "qp" in b:
            lines += ["", "### V4 Waszkiewicz 2026: long-time flow", "", "| Basket pressure (bar) | Model (g/s) | Data (g/s) | SEM |",
                      "|---|---|---|---|"]
            lines += [f"| {_fmt(r['pressure_bar'])} | {_fmt(r['model'])} | {_fmt(r['data'])} | {_fmt(r['sem'])} |" for r in b["qp"]]
        if "bodenstein" in b:
            lines += ["", "### V2 Vaca Guerra 2024: Bodenstein numbers", "", "| Case | Model | Data |", "|---|---|---|"]
            lines += [f"| {r['case'].split('/')[-1]} | {_fmt(r['model'])} | {_fmt(r['data'])} |" for r in b["bodenstein"]]
        if "ratios" in b:
            lines += ["", "### V6 Corrochano 2017: permeability versus bed density", "",
                      "| Grind | Density (kg/m³) | κ/κ(360), model | κ/κ(360), data | Model/data |", "|---|---|---|---|---|"]
            lines += [f"| {r['grind']} | {int(r['density'])} | {_fmt(r['model'])} | {_fmt(r['data'])} | {_fmt(r['factor'])} |"
                      for r in b["ratios"]]
    held = report["held_out"]
    lines += ["", "## 2. Held-out checks", ""]
    if held.get("v3", {}).get("rows"):
        lines += ["### V3 Cameron 2020", "", f"RMS error: EY {_fmt(held['v3']['rms_ey'])} points, shot time "
                  f"{_fmt(held['v3']['rms_time'])} s.", "",
                  "| Grind setting | EY model (%) | EY data (%) | Time model (s) | Time data (s) |", "|---|---|---|---|---|"]
        lines += [f"| {r['grind_setting']} | {_fmt(r['ey_model'])} | {_fmt(r['ey_data'])} | {_fmt(r['time_model'])} | "
                  f"{_fmt(r['time_data'])} |" for r in held["v3"]["rows"]]
    v4t = held.get("v4_transient") or {}
    if v4t.get("tds_model"):
        tds_data = {round(float(r["time_mid_s"]), 3): r for r in (report.get("data") or {}).get("waszkiewicz_tds", [])}
        lines += ["", "### V4 Waszkiewicz 2026: transient at 9 bar", "",
                  "Times on the data's clock, from the end of the pressure rise (the model's clock is shifted by the "
                  "moment its inlet pressure reaches 95% of the target). First drops (cup mass 0.1 g): model "
                  f"{_fmt(v4t.get('drops_model_s'))} s, data {_fmt(v4t.get('drops_data_s'))} s. Time to 36 g: model "
                  f"{_fmt(v4t.get('time_to_mass_model_s'))} s, data {_fmt(v4t.get('time_to_mass_data_s'))} s. Long-time "
                  f"flow: model {_fmt(v4t.get('long_time_model_g_s'))}, data {_fmt(v4t.get('long_time_data_g_s'))} g/s.", "",
                  "| Fraction (s after first drops) | TDS model (%) | TDS data (%) |", "|---|---|---|"]
        lines += [f"| {_fmt(r['time_mid_s'])} | {_fmt(r['tds_percent'])} | "
                  f"{_fmt((tds_data.get(round(float(r['time_mid_s']), 3)) or {}).get('tds_percent'))} |"
                  for r in v4t["tds_model"]]
    if held.get("v5", {}).get("rows"):
        lines += ["", "### V5 Smrke 2024", "", f"RMS error: time {_fmt(held['v5']['rms_time'])} s, EY "
                  f"{_fmt(held['v5']['rms_ey'])} points.", "",
                  "| Burr gap (µm) | Fines (g) | Time model (s) | Time data (s) | EY model (%) | EY data (%) |",
                  "|---|---|---|---|---|---|"]
        lines += [f"| {r['setting_um']} | {r['fines_g']} | {_fmt(r['time_model'])} | {_fmt(r['time_data'])} | "
                  f"{_fmt(r['ey_model'])} | {_fmt(r['ey_data'])} |" for r in held["v5"]["rows"]]
    tiers = held.get("tiers")
    if tiers and tiers.get("rows"):
        a, b = tiers["tiers"]
        lines += ["", f"### Tier {b} versus tier {a}", "",
                  f"The held-out cases at tier {b} with the same parameters. V3/V5 shot time: largest difference "
                  f"{_fmt(_pct(tiers['max_time_rel']), 2)}% (RMS {_fmt(_pct(tiers['rms_time_rel']), 2)}%); EY: largest "
                  f"{_fmt(tiers['max_ey_points'], 2)} points (RMS {_fmt(tiers['rms_ey_points'], 2)}).", "",
                  f"| Case | Time, tier {a} (s) | Time, tier {b} (s) | EY, tier {a} (%) | EY, tier {b} (%) |",
                  "|---|---|---|---|---|"]
        for r in tiers["rows"]:
            if "time_s" in r:
                lines.append(f"| {r['case']} | {_fmt(r['time_s'][0])} | {_fmt(r['time_s'][1])} | "
                             f"{_fmt(r['ey_percent'][0])} | {_fmt(r['ey_percent'][1])} |")
        for r in tiers["rows"]:
            if "first_tds_percent" in r:
                lines += ["", f"{r['case']} (9 bar): first drops {_fmt(r['first_drops_s'][0])} s (tier {a}) and "
                          f"{_fmt(r['first_drops_s'][1])} s (tier {b}) after the pressure reaches its target; flow 15 s "
                          f"later {_fmt(r['flow_15s_g_s'][0])} and "
                          f"{_fmt(r['flow_15s_g_s'][1])} g/s; first 5 s fraction {_fmt(r['first_tds_percent'][0])}% and "
                          f"{_fmt(r['first_tds_percent'][1])}% TDS."]
    generic = held.get("generic")
    if generic and generic.get("rows"):
        lines += ["", "### Generic app shots", "",
                  "18 g dose with a 36 g pump-stop target at a flat 9 bar (medium washed arabica, 58 mm precision "
                  "basket) with the calibrated parameters, one per grinder preset: a sanity check of the reference "
                  "permeability the app uses. Time ends when the pump stops at 36 g. EY includes subsequent drip "
                  "into the cup, so it describes a larger final beverage rather than a 36 g cup.", "",
                  "| Grinder preset | Setting | κ₀ (m²) | Pump-stop time (s) | EY after drip (%) | Stop |",
                  "|---|---|---|---|---|---|"]
        lines += [f"| {r['grinder']} | {r['setting']} | {_fmt(r.get('kappa0_m2', math.nan), 3)} | "
                  f"{_fmt(r.get('time_s', math.nan))} | {_fmt(r.get('ey_percent', math.nan))} | {r.get('stop', r.get('error', ''))} |"
                  for r in generic["rows"]]
    if figures:
        lines += ["", "## Figures", ""]
        lines += [f"![{Path(f).stem}]({FIGURE_DIR}/{Path(f).name})" for f in sorted(figures, key=lambda f: Path(f).name)]
    if report["solver_warnings"]:
        lines += ["", "## Solver warnings", ""] + [f"- {w}" for w in report["solver_warnings"]]
    robust = report.get("robustness") or {}
    if robust.get("worst"):
        worst = robust["worst"]
        lines += ["", "## Solver robustness", "",
                  f"Over the {robust.get('simulations')} shots simulated for this report ({robust.get('failed', 0)} failed): "
                  + ", ".join(f"{k} worst {_fmt(v, 3)}" for k, v in worst.items()) + "."]
    lines += ["", f"*{report['simulations']} simulations. Raw numbers: [{REPORT_NAME}.json]({REPORT_NAME}.json).*", ""]
    return "\n".join(lines)


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items() if not str(k).startswith("_")}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def write_report(report: Mapping[str, Any], out_dir: Path) -> list[Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    figures = make_figures(report, out_dir / FIGURE_DIR)
    md = out_dir / f"{REPORT_NAME}.md"
    md.write_text(render_markdown(report, [str(f) for f in figures]), encoding="utf-8")
    js = out_dir / f"{REPORT_NAME}.json"
    js.write_text(json.dumps(_jsonable(report), indent=1, allow_nan=False) + "\n", encoding="utf-8")
    return [md, js, *figures]


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--output-dir", type=Path, help="output directory (default: docs/validation)")
    parser.add_argument("--calibration", type=Path, help="calibration file (default: data/calibration/current.yaml)")
    parser.add_argument("--config", type=Path, help="calibration config (default: data/calibration/config.yaml)")
    parser.add_argument("--tier", type=int, help="override the numerics tier of every case")
    parser.add_argument("--quick", action="store_true", help="tier 0 and 8 size classes (smoke test)")
    parser.add_argument("--jobs", type=int, default=1, help="parallel simulation processes (default: 1)")
    parser.add_argument("--from-json", type=Path,
                        help="re-render the report (Markdown and figures) from a report JSON without simulating")
    parser.add_argument("--check", action="store_true",
                        help="check that the committed report re-renders from its JSON and that it was made from the "
                             "committed calibration (data/calibration/current.yaml); simulate nothing")


def check_committed(paths: RepoPaths, out_dir: Path | None = None) -> list[str]:
    """Problems with the committed report: its Markdown differs from a re-render of its JSON, or its
    calibrated values or calibration's solver identity differ from current.yaml's."""
    out_dir = out_dir or paths.validation_dir
    md, js = out_dir / f"{REPORT_NAME}.md", out_dir / f"{REPORT_NAME}.json"
    if not js.is_file() or not md.is_file():
        return [f"{paths.relative(md)} or {paths.relative(js)} is missing"]
    report = json.loads(js.read_text(encoding="utf-8"))
    problems = []
    figures = sorted(str(f) for f in (out_dir / FIGURE_DIR).glob("*.png")) if (out_dir / FIGURE_DIR).is_dir() else []
    if render_markdown(report, figures) != md.read_text(encoding="utf-8"):
        problems.append(f"{paths.relative(md)} does not match a re-render of {paths.relative(js)}")
    calibration = load_calibration_document(paths.root / "data" / "calibration" / "current.yaml")
    current = (calibration.get("fit") or {}).get("solver")
    if report.get("calibration_solver") != current:
        problems.append("the report's calibration solver identity differs from data/calibration/current.yaml's "
                        "(re-run validate after calibrating)")
    # A calibration can be refitted or edited on the same solver build. The already-recorded
    # parameter rows include shared, case and nuisance values; no extra report fingerprint is needed.
    recorded_values = {**(report.get("nuisance") or {}),
                       **{pid: row["value"] for pid, row in (report.get("parameters") or {}).items()
                          if row.get("calibrated")}}
    current_values = calibrated_values(calibration)
    if recorded_values.keys() != current_values.keys() or any(
        not math.isclose(value, recorded_values[pid], rel_tol=1e-12, abs_tol=0.0)
        for pid, value in current_values.items() if pid in recorded_values
    ):
        problems.append("the report's calibrated values differ from data/calibration/current.yaml's "
                        "(re-run validate after calibrating)")
    return problems


def run(args: argparse.Namespace, paths: RepoPaths) -> int:
    if args.check:
        problems = check_committed(paths, args.output_dir)
        for problem in problems:
            print(f"validate: {problem}")
        if not problems:
            print("validate: the committed report re-renders from its JSON and matches the committed calibration")
        return 1 if problems else 0
    if args.from_json:
        report = json.loads(Path(args.from_json).read_text(encoding="utf-8"))
        written = write_report(report, args.output_dir or Path(args.from_json).parent)
        for path in written[:2]:
            print(f"validate: wrote {paths.relative(path)} (from {paths.relative(Path(args.from_json))})")
        return 0
    tier = 0 if args.quick else args.tier
    report = run_validation(paths, calibration_path=args.calibration, config_path=args.config, tier=tier,
                            n_classes=8 if args.quick else None, jobs=args.jobs)
    written = write_report(report, args.output_dir or paths.validation_dir)
    for path in written[:2]:
        print(f"validate: wrote {paths.relative(path)}")
    if len(written) > 2:
        print(f"validate: wrote {len(written) - 2} figure(s) to {paths.relative(written[2].parent)}")
    else:
        print("validate: matplotlib is not installed; no figures")
    checks = [*report["calibration"]["checks"], *report["held_out_checks"]]
    for c in checks:
        print(f"  {c['status']:<8} {c['check']}: {c['detail']}")
    if report["placeholder"]:
        print("validate: note: the solver reports itself as a placeholder")
    return 0
