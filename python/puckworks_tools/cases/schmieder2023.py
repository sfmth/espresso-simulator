# SPDX-License-Identifier: GPL-2.0-or-later
"""Schmieder et al. (2023): flow-controlled DE1 shots, fraction kinetics of four analytes (V1).

One case per experiment (15). Each case is the builder's spec for a 20 g recipe, then:

- basket: IMS 58 mm, 26.5 mm deep (straight walls); dose 20 g;
- preparation: Grande TRE distribution and a 25 kgf tamp (§2.4). The builder has no Grande TRE
  category; its default tap mapping is an assumption. V1 calibration can replace the actual
  inner permeability spread and edge multiplier with dataset-specific spec nuisances;
- particle sizes: by default, a fines + boulders log-normal mixture whose D[4,3] equals the
  wet-measured value of the grinding level (273, 277, 295 µm) with a fixed fines weight of 25%.
  The explicit ``wet_cdf`` alternative uses the resolved wet CDF from Fig. A1b, with its
  unresolved small-particle fraction constrained by the reported D[3,2];
- machine: flow control with an ideal pump — preinfusion at 7 mL/s until the pressure reaches
  2.5 bar, then a linear ramp over 4 s to the experiment's measured mean flow (Table 2), at its
  measured brew temperature. The article's Fig. A2 shows the DE1's flow falling from 7 to 2 mL/s
  over about 4 s after the switch;
- stop: when the beverage passes the end of the last fraction (about 60 g), so every analysed
  fraction is covered.

Observables (``observe``): the mean concentration of each analyte in each analysed fraction of
every replicate, computed from the cumulative cup masses between that fraction's start and end
masses; λ and c0 fitted to those values exactly as the authors fitted the data (unweighted, at the
fractions' accumulated mid-masses); cup masses at 20, 40 and 60 g, both directly from the
cumulative series and by the authors' Eq. 3 (first fraction plus integral of the fit); and the
peak inlet pressure, over the whole shot and over the pour phase (after the transition ramp), to
compare with Table 2's mean of per-shot maxima.
"""

from __future__ import annotations

import copy
import math
from collections import defaultdict
from collections.abc import Mapping
from types import ModuleType
from typing import Any

import numpy as np

from ..paths import RepoPaths
from .common import (
    IMS_58_H26_5,
    Case,
    Psd,
    bimodal_psd,
    cup_mass_at,
    fit_exponential,
    flow_control,
    fraction_concentrations,
    ideal_pump,
    make_case,
    minimal_recipe,
    phase,
    read_table,
    set_numerics,
    set_program,
    set_temperature,
)

KEY = "schmieder2023"
DATASETS = ("schmieder2023-design", "schmieder2023-fractions", "schmieder2023-kinetics", "schmieder2023-replicates")
#: Separate from the four datasets used by the existing calibration: this input is opt-in.
PSD_DATASET = "schmieder2023-psd"

#: Analytes as (dataset name, ShotResult species id, concentration column, factor kg/kg → column unit).
ANALYTES = (
    ("trigonelline", "trigonelline", "trigonelline_mg_g", 1e3),
    ("caffeine", "caffeine", "caffeine_mg_g", 1e3),
    ("cqa5", "cqa5", "cqa5_mg_g", 1e3),
    ("tds", "tds", "tds_g_g", 1.0),
)
#: Wet-measured De Brouckere diameters D[4,3] by grinding level (article §2.2; registry psd.grinder.e65s.*).
D43_WET_UM = {1.4: 273.0, 1.7: 277.0, 2.0: 295.0}
#: Volume weight of the fines mode in the constructed PSD (assumption; registry psd.fines_fraction.dry is 15–36%).
FINES_WEIGHT = 0.25
DOSE_G = 20.0
PREINFUSION_FLOW_ML_S = 7.0
PREINFUSION_EXIT_BAR = 2.5
#: The ideal pump's pressure limit in these cases (bar); a model pressure at it means the pump could not
#: deliver the programmed flow.
PUMP_MAX_BAR = 12.0
#: Ramp from the preinfusion flow to the experiment's flow (s): in the article's Fig. A2 (set flow
#: 2 mL/s) the DE1's flow falls from 7 to 2 mL/s over about 4 s after the switch.
TRANSITION_RAMP_S = 4.0
CUP_MASSES_G = (20.0, 40.0, 60.0)
#: The app's representation of the article's grinder (its dial is the article's grinding level).
GRINDER_PRESET = "mahlkoenig-e65s"
#: Reported in §2.4; no supported input-model category represents this distributor.
DISTRIBUTION_TOOL = "Grande TRE (Sahdia Enterprises)"
TAMP_KGF = 25.0
PREPARATION_NUISANCES = (
    "calibration.schmieder2023.sigma_ln_permeability",
    "calibration.schmieder2023.edge_multiplier",
)


def load(paths: RepoPaths) -> dict[str, list[dict[str, Any]]]:
    return {
        "design": read_table(paths, "schmieder2023-design"),
        "fractions": read_table(paths, "schmieder2023-fractions"),
        "kinetics": read_table(paths, "schmieder2023-kinetics"),
        "replicates": read_table(paths, "schmieder2023-replicates"),
        "psd": read_table(paths, PSD_DATASET),
    }


def grind_group(grind_level: float) -> str:
    return f"gl{grind_level:.1f}".replace(".", "_")


def _wet_psd_with_info(
    data: Mapping[str, list[dict[str, Any]]], grind: float, sauter_offset_sd: float,
) -> tuple[Psd, dict[str, Any]]:
    """Validate the source curves and discretise one, retaining the reconstruction metadata."""
    moment_columns = ("reported_d32_um", "reported_d32_sd_um", "reported_d43_um", "reported_d43_sd_um")
    columns = ("diameter_um", "cumulative_volume_fraction", *moment_columns)
    grouped: dict[float, list[tuple[float, ...]]] = defaultdict(list)
    try:
        for row in data["psd"]:
            level = float(row["grind_level"])
            values = tuple(float(row[column]) for column in columns)
            if not math.isfinite(level) or not all(math.isfinite(value) for value in values):
                raise ValueError("wet PSD values must be finite")
            grouped[level].append(values)
    except (KeyError, TypeError) as exc:
        raise ValueError("wet PSD rows need a grind level, CDF points and reported moments") from exc
    if set(grouped) != set(D43_WET_UM):
        raise ValueError("wet PSD requires exactly the grinding levels 1.4, 1.7 and 2.0")
    if grind not in grouped:
        raise ValueError("wet PSD grind must be 1.4, 1.7 or 2.0")
    if not math.isfinite(sauter_offset_sd):
        raise ValueError("sauter_offset_sd must be finite")
    curves = {}
    for level, rows in grouped.items():
        points = np.asarray(rows)
        diameter, cdf = points[:, 0], points[:, 1]
        if len(points) < 2 or np.any(diameter <= 0) or np.any(np.diff(diameter) <= 0):
            raise ValueError(f"wet PSD GL {level} needs positive, strictly increasing diameters")
        if np.any(cdf < 0) or np.any(cdf > 1) or np.any(np.diff(cdf) < 0) or cdf[-1] != 1.0:
            raise ValueError(f"wet PSD GL {level} needs a nondecreasing CDF in [0, 1], ending at 1")
        moments = points[0, 2:]
        if np.any(points[:, 2:] != moments):
            raise ValueError(f"wet PSD GL {level} has inconsistent reported moments")
        if np.any(moments[[0, 2]] <= 0) or np.any(moments[[1, 3]] < 0):
            raise ValueError(f"wet PSD GL {level} needs positive reported means and nonnegative SDs")
        curves[level] = (diameter, cdf, dict(zip(moment_columns, map(float, moments))))

    diameter, cdf, moments = curves[grind]
    target_d32 = moments["reported_d32_um"] + sauter_offset_sd * moments["reported_d32_sd_um"]
    if not math.isfinite(target_d32) or target_d32 <= 0:
        raise ValueError("wet PSD target D[3,2] must be positive and finite")
    widths, masses = np.diff(diameter), np.diff(cdf)
    # Exact inverse-diameter moment of a density constant in diameter on each source interval.
    tail_inverse = float(np.sum(masses * np.log1p(widths / diameter[:-1]) / widths))
    head_mass = float(cdf[0])
    head_diameter = None
    if head_mass > 0:
        head_inverse = 1.0 / target_d32 - tail_inverse
        if head_inverse <= 0:
            raise ValueError("wet PSD target D[3,2] leaves no positive unresolved-head inverse moment")
        head_diameter = head_mass / head_inverse
        if not 0 < head_diameter < diameter[0]:
            raise ValueError("wet PSD unresolved-head diameter must be below the first resolved diameter")
    elif not math.isclose(1.0 / target_d32, tail_inverse, rel_tol=1e-12):
        raise ValueError("wet PSD without an unresolved head cannot match the target D[3,2]")

    diameters, weights = [], []
    if head_diameter is not None:
        diameters.append(np.array([head_diameter]))
        weights.append(np.array([head_mass]))
    for lower, upper, mass in zip(diameter[:-1], diameter[1:], masses):
        if mass == 0:
            continue
        # Geometric subinterval edges keep the midpoint inverse-moment error below 1e-7.
        # Density stays uniform in diameter, not in log diameter: each weight is density × width.
        count = max(1, math.ceil((math.log(upper) - math.log(lower)) / 1e-3))
        edges = np.geomspace(lower, upper, count + 1)
        diameters.append(edges[:-1] + 0.5 * np.diff(edges))
        weights.append(mass * (np.diff(edges) / (upper - lower)))
    psd = Psd(np.concatenate(diameters), np.concatenate(weights))
    # The continuous tail and separate head atom define this share without interpolating across
    # empty size intervals or treating the head atom as a measured continuous distribution.
    fines = float(np.interp(100.0, diameter, cdf - head_mass, left=0.0, right=1.0 - head_mass))
    if head_diameter is not None and head_diameter < 100.0:
        fines += head_mass
    return psd, {
        **moments,
        "sauter_offset_sd": float(sauter_offset_sd),
        "target_d32_um": target_d32,
        "resolved_start_um": float(diameter[0]),
        "unresolved_head_fraction": head_mass,
        "unresolved_head_diameter_um": head_diameter,
        "fines_fraction_below_100um": fines,
    }


def wet_psd(
    data: Mapping[str, list[dict[str, Any]]], grind: float, *, sauter_offset_sd: float = 0.0,
) -> Psd:
    """Wet Fig. A1b CDF with a D[3,2]-constrained unresolved head, not measured head locations.

    Between resolved CDF points the volume density is constant in diameter. Dense midpoint
    quadrature preserves its volume and D[4,3], and approximates D[3,2] to better than 1e-7
    relative error. The initial CDF's unresolved volume is a single effective diameter chosen
    from the reported D[3,2] plus ``sauter_offset_sd`` times its reported SD. Infeasible moments
    are rejected; no negative weights, CDF repair or diameter clipping is applied.
    """
    return _wet_psd_with_info(data, grind, sauter_offset_sd)[0]


def fraction_windows(fractions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Analysed fractions with their beverage-mass windows (g): start = mid − mass/2, end = mid + mass/2."""
    out = []
    for row in fractions:
        if row["fraction_mass_g"] is None or row["cumulative_mass_g"] is None:
            continue
        half = 0.5 * row["fraction_mass_g"]
        out.append({**row, "start_g": row["cumulative_mass_g"] - half, "end_g": row["cumulative_mass_g"] + half})
    return out


def build_cases(
    data: Mapping[str, list[dict[str, Any]]],
    *,
    tier: int = 1,
    n_classes: int = 16,
    overrides: Mapping[str, float] | None = None,
    module: ModuleType | None = None,
    experiments: list[int] | None = None,
    transition_ramp_s: float = TRANSITION_RAMP_S,
    psd_source: str = "reconstructed",
    sauter_offset_sd: float = 0.0,
) -> list[Case]:
    if psd_source not in ("reconstructed", "wet_cdf"):
        raise ValueError("psd_source must be 'reconstructed' or 'wet_cdf'")
    if not math.isfinite(sauter_offset_sd) or (psd_source == "reconstructed" and sauter_offset_sd != 0.0):
        raise ValueError("sauter_offset_sd must be finite and is only supported by psd_source='wet_cdf'")
    wet_distributions = {}
    by_experiment: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in fraction_windows(list(data["fractions"])):
        by_experiment[row["experiment"]].append(row)
    cases = []
    for design in data["design"]:
        exp = design["experiment"]
        if experiments is not None and exp not in experiments:
            continue
        windows = by_experiment[exp]
        stop_g = max(62.0, 1.03 * max(w["end_g"] for w in windows))
        grind = design["grind_level"]
        psd_details = {}
        if psd_source == "reconstructed":
            psd = bimodal_psd(de_brouckere_um=D43_WET_UM[grind], fines_weight=FINES_WEIGHT)
        else:
            if grind not in wet_distributions:
                wet_distributions[grind] = _wet_psd_with_info(data, grind, sauter_offset_sd)
            psd, psd_details = wet_distributions[grind]
        classes = psd.classes(n_classes)
        psd_info = {"d32_um": psd.sauter_um(), "d43_um": psd.de_brouckere_um(),
                    "fines_fraction_below_100um": psd.share_below(100.0), **psd_details}
        class_psd_info = {
            "d32_um": 1.0 / sum(c["volume_fraction"] / (c["radius_m"] * 2e6) for c in classes),
            "d43_um": sum(c["volume_fraction"] * c["radius_m"] * 2e6 for c in classes),
            "fines_fraction_below_100um": sum(c["volume_fraction"] for c in classes if c["radius_m"] * 2e6 < 100),
        }
        temperature = design["temp_measured_c"]
        flow_ml_s = design["flow_measured_ml_s"]
        profile = [{"control": "flow", "target": PREINFUSION_FLOW_ML_S, "until_pressure_bar": PREINFUSION_EXIT_BAR},
                   {"control": "flow", "target": flow_ml_s}]
        recipe = minimal_recipe(DOSE_G, psd.recipe_psd(n_classes), IMS_58_H26_5, profile=profile, beverage_g=stop_g,
                                tier=tier, temperature_c=temperature)
        # Record the reported tamp load. The builder gives it no numerical effect above 10 kgf.
        # Grande TRE has no supported distribution category: leave that field absent rather
        # than asserting equivalence to tap or WDT. Calibration writes actual heterogeneity
        # through spec nuisances after the builder, without changing those global defaults.
        recipe["prep"]["tamp_kgf"] = TAMP_KGF
        if psd_source == "wet_cdf":
            # The builder must use these same classes when deriving D32-dependent inputs such as
            # pore-air tau; otherwise its default 30-class limit rebins a 32-class refinement.
            recipe["numerics"]["size_classes"] = n_classes

        def finalize(spec: dict[str, Any], values: Mapping[str, float], *, classes=classes, temperature=temperature,
                     flow_ml_s=flow_ml_s, stop_g=stop_g, ramp_s=float(transition_ramp_s)) -> None:
            IMS_58_H26_5.apply(spec)
            spec["bed"]["dose_kg"] = DOSE_G / 1e3
            spec["bed"]["size_classes"] = [dict(c) for c in classes]
            set_temperature(spec, temperature)
            set_program(
                spec,
                [
                    phase(flow_control(PREINFUSION_FLOW_ML_S * 1e-6), ramp_s=0.0,
                          pressure_pa=PREINFUSION_EXIT_BAR * 1e5),
                    phase(flow_control(flow_ml_s * 1e-6), ramp_s=ramp_s),
                ],
                pump=ideal_pump(max_flow_m3_s=8e-6, max_pressure_pa=PUMP_MAX_BAR * 1e5),
                stop_beverage_kg=stop_g / 1e3,
                # room for a shot slowed by the pressure limit, so its residuals stay informative
                max_duration_s=max(240.0, 3.0 * stop_g / max(flow_ml_s, 0.1) + 120.0),
            )
            set_numerics(spec, tier=tier)

        cases.append(make_case(
            KEY, f"{KEY}/exp{exp:02d}", recipe, finalize, group=grind_group(grind),
            info={"experiment": exp, "design": design, "windows": windows, "flow_ml_s": flow_ml_s,
                  "temperature_c": temperature, "grind_level": grind, "transition_ramp_s": float(transition_ramp_s),
                  "psd_source": psd_source, "psd": psd_info, "class_psd": class_psd_info,
                  "preparation": {"reported_distributor": DISTRIBUTION_TOOL, "reported_tamp_kgf": TAMP_KGF,
                                  "source_locator": "Schmieder et al. (2023), §2.4",
                                  "builder_distribution_fallback": "tap",
                                  "conditional_spec_nuisances": list(PREPARATION_NUISANCES)}},
            overrides=overrides, module=module,
        ))
    return cases


def scaling_recipe(case: Case) -> tuple[dict[str, Any], str]:
    """The recipe whose builder scaling maps this case's fitted bare κ₀ to the reference permeability:
    the case's recipe with the E65S grinder preset at the article's grinding level, so that the app's
    E65S at that level gets the fitted bed permeability (the case simulates its selected PSD)."""
    recipe = copy.deepcopy(case.recipe)
    recipe["grinder"] = {"preset": GRINDER_PRESET, "setting": float(case.info["grind_level"])}
    return recipe, f"grinder preset {GRINDER_PRESET} at GL {case.info['grind_level']}"


def observe(case: Case, result: Mapping[str, Any]) -> dict[str, Any]:
    """Model observables comparable with the dataset (concentrations in the dataset's units)."""
    windows = case.info["windows"]
    bounds = [(w["start_g"] / 1e3, w["end_g"] / 1e3) for w in windows]
    out: dict[str, Any] = {"fractions": [], "lambda": {}, "c0": {}, "cup_direct": {}, "cup_eq3": {}}
    for name, species, column, factor in ANALYTES:
        conc = [c * factor for c in fraction_concentrations(result, species, bounds)]
        for w, c in zip(windows, conc):
            out["fractions"].append({"replicate": w["replicate"], "fraction": w["fraction"], "analyte": name,
                                     "model": c, "data": w[column], "mid_g": w["cumulative_mass_g"]})
        fit = fit_exponential([w["cumulative_mass_g"] for w in windows], conc)
        out["lambda"][name] = fit.lam
        out["c0"][name] = fit.c0
        to_unit = 1e3 if name == "tds" else 1e6  # kg → g (TDS) or mg (species), the dataset's units
        out["cup_direct"][name] = {int(m): cup_mass_at(result, species, m / 1e3) * to_unit for m in CUP_MASSES_G}
        # the authors' Eq. 3 on each replicate's model fractions: first fraction (mass × concentration)
        # plus the integral of the fitted exponential from its end to the cup mass; then averaged
        firsts = [(w["fraction_mass_g"], c) for w, c in zip(windows, conc) if w["fraction"] == 1]
        eq3 = {}
        for m in CUP_MASSES_G:
            values = [m1 * c + fit.c0 * fit.lam * (math.exp(-m1 / fit.lam) - math.exp(-m / fit.lam))
                      for m1, c in firsts if math.isfinite(c)]
            eq3[int(m)] = sum(values) / len(values) if values and math.isfinite(fit.lam) else math.nan
        out["cup_eq3"][name] = eq3
    out["peak_pressure_bar"] = result["summary"]["max_pressure_pa"] / 1e5
    # the pour phase: from the end of the transition ramp, which starts when the inlet pressure first
    # reaches the preinfusion exit pressure
    t = result["series"]["t_s"]
    p = result["series"]["pressure_pa"]
    switch = next((ti for ti, pi in zip(t, p) if pi >= PREINFUSION_EXIT_BAR * 1e5), None)
    ramp = case.info.get("transition_ramp_s", 0.0)
    pour = [pi for ti, pi in zip(t, p) if switch is not None and ti >= switch + ramp]
    out["switch_s"] = switch
    out["pour_peak_pressure_bar"] = max(pour) / 1e5 if pour else out["peak_pressure_bar"]
    # time at the pump's pressure limit, in the transition and in the pour (output-step resolution)
    limit = 0.999 * PUMP_MAX_BAR * 1e5
    at_limit = {"transition": 0.0, "pour": 0.0}
    for k in range(1, len(t)):
        if p[k] >= limit and switch is not None and t[k] >= switch:
            at_limit["transition" if t[k] < switch + ramp else "pour"] += t[k] - t[k - 1]
    out["pump_limit_s"] = at_limit
    out["pour_capped"] = bool(pour) and max(pour) >= limit
    out["beverage_g"] = result["summary"]["beverage_mass_kg"] * 1e3
    return out


def targets(data: Mapping[str, list[dict[str, Any]]]) -> dict[int, dict[str, Any]]:
    """Per experiment: λ, c0 (with standard errors), cup masses (mean over replicates and RSD) and pressure."""
    kinetics: dict[int, dict[str, Any]] = defaultdict(lambda: {"lambda": {}, "c0": {}})
    for row in data["kinetics"]:
        k = kinetics[row["experiment"]]
        k["lambda"][row["analyte"]] = (row["lambda_g"], row["lambda_se_g"])
        k["c0"][row["analyte"]] = (row["c0"], row["c0_se"])
    reps: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data["replicates"]:
        reps[row["experiment"]].append(row)
    out = {}
    for design in data["design"]:
        exp = design["experiment"]
        cups: dict[str, dict[int, tuple[float, float]]] = {}
        for name, _, _, _ in ANALYTES:
            unit = "g" if name == "tds" else "mg"
            cups[name] = {}
            for m in (20, 40, 60):
                values = [r[f"{name}_{unit}_{m}g"] for r in reps[exp]]
                mean = sum(values) / len(values)
                sd = (sum((v - mean) ** 2 for v in values) / max(len(values) - 1, 1)) ** 0.5
                cups[name][m] = (mean, sd / mean if mean else 0.0)
        out[exp] = {
            "lambda": kinetics[exp]["lambda"],
            "c0": kinetics[exp]["c0"],
            "cup": cups,
            "pressure_bar": (design["pressure_bar"], design["pressure_rsd_percent"] / 100.0),
            "grind_level": design["grind_level"],
        }
    return out
