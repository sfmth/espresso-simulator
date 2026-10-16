# SPDX-License-Identifier: GPL-2.0-or-later
"""Vaca Guerra et al. (2024): axial dispersion of the wetted bed, from tracer Bodenstein numbers (V2).

One case per tracer experiment of the wetted bed: distributions A–D after 30 g and distribution B
after 60 g (the initially dry bed, Bo = 16.8, is excluded because the model's single dispersion
coefficient describes the wetted bed). Each case is the builder's spec for the experiment's dose,
then:

- basket: a 59 mm cylinder (the authors' bed diameter), with the intergranular porosity set so that
  the bed is 13.4 mm long, as in their model;
- particle sizes: a fines + boulders log-normal mixture matching the reported overall Sauter
  diameter and the Sauter diameter of the particles above 100 µm (approximate: it under-predicts the
  reported D[4,3]; the PSD does not enter the observable);
- machine: flow control at the experiment's flow rate, ideal pump, 88 °C (the brewing temperature;
  the tracer runs were at 22 °C);
- stop: the brewed mass of the experiment (30 or 60 g), tier 0 (only the bed geometry is read).

Observable: the model's Bodenstein number Bo = v·L/D_ax, with L the model's bed height, v = Q/(A·ε)
the interstitial velocity from the experiment's flow and the model's porosity, and D_ax the spec's
axial dispersion coefficient. The authors' steady-state interstitial velocities (Table 1) are kept for
comparison.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Mapping
from types import ModuleType
from typing import Any

from ..paths import RepoPaths
from .common import (
    Basket,
    Case,
    bimodal_psd,
    flow_control,
    ideal_pump,
    make_case,
    minimal_recipe,
    phase,
    read_table,
    set_numerics,
    set_porosity_for_height,
    set_program,
    set_temperature,
)

KEY = "vacaguerra2024"
DATASETS = ("vacaguerra2024-rtd",)

BASKET = Basket("Vaca Guerra 59 mm bed", 59.0, 25.0, 55.0)
BED_LENGTH_M = 0.0134
TEMPERATURE_C = 88.0
#: (distribution, brewed mass g) of the tracer experiments used for the dispersion calibration.
EXPERIMENTS = (("A", 30.0), ("B", 30.0), ("C", 30.0), ("D", 30.0), ("B", 60.0))


def load(paths: RepoPaths) -> dict[str, list[dict[str, Any]]]:
    return {"rtd": read_table(paths, "vacaguerra2024-rtd")}


def facts(rows: list[dict[str, Any]]) -> dict[tuple[str, float | None, str], tuple[float, float | None]]:
    """(distribution, brewed mass, quantity) → (value, sd)."""
    return {(r["distribution"], r["brewed_mass_g"], r["quantity"]): (r["value"], r["sd"]) for r in rows}


def build_cases(
    data: Mapping[str, list[dict[str, Any]]],
    *,
    tier: int = 0,
    n_classes: int = 8,
    overrides: Mapping[str, float] | None = None,
    module: ModuleType | None = None,
) -> list[Case]:
    f = facts(list(data["rtd"]))
    cases = []
    for dist, brewed in EXPERIMENTS:
        dose = f[(dist, None, "dose")][0]
        flow_ml_s = f[(dist, brewed, "flow_rate")][0]
        psd = bimodal_psd(sauter_um=f[(dist, None, "sauter_diameter")][0],
                          sauter_above_100um=f[(dist, None, "sauter_diameter_coarse")][0])
        classes = psd.classes(n_classes)
        recipe = minimal_recipe(dose, psd.recipe_psd(n_classes), BASKET,
                                profile=[{"control": "flow", "target": flow_ml_s}], beverage_g=brewed, tier=tier,
                                temperature_c=TEMPERATURE_C)

        def finalize(spec: dict[str, Any], values: Mapping[str, float], *, classes=classes, dose=dose,
                     flow_ml_s=flow_ml_s, brewed=brewed) -> None:
            BASKET.apply(spec)
            spec["bed"]["dose_kg"] = dose / 1e3
            spec["bed"]["size_classes"] = [dict(c) for c in classes]
            set_porosity_for_height(spec, BASKET, BED_LENGTH_M)
            set_temperature(spec, TEMPERATURE_C)
            set_program(spec, [phase(flow_control(flow_ml_s * 1e-6), ramp_s=1.0)],
                        pump=ideal_pump(max_flow_m3_s=8e-6, max_pressure_pa=1.5e6),
                        stop_beverage_kg=brewed / 1e3, max_duration_s=120.0)
            set_numerics(spec, tier=tier)

        bo, bo_sd = f[(dist, brewed, "bodenstein")]
        v_data = f.get((dist, brewed, "interstitial_velocity"), (None, None))[0]
        case = make_case(KEY, f"{KEY}/{dist}_{int(brewed)}g", recipe, finalize, group="all",
                         info={"distribution": dist, "brewed_g": brewed, "flow_ml_s": flow_ml_s, "bodenstein": bo,
                               "bodenstein_sd": bo_sd, "interstitial_velocity_data_m_s": v_data},
                         overrides=overrides, module=module)
        case.info["porosity"] = case.spec["bed"]["intergranular_porosity"]
        cases.append(case)
    return cases


def observe(case: Case, result: Mapping[str, Any], spec: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Bo = v·L/D_ax for the case (``spec`` is the simulated spec; the case's own by default)."""
    spec = spec or case.spec
    length = result["summary"]["bed_height_m"]
    porosity = spec["bed"]["intergranular_porosity"]
    area = math.pi * spec["basket"]["profile_m"][0][1] ** 2
    velocity = case.info["flow_ml_s"] * 1e-6 / (area * porosity)
    d_ax = spec["hydraulics"]["axial_dispersion_m2_s"]
    return {
        "distribution": case.info["distribution"],
        "brewed_g": case.info["brewed_g"],
        "bed_length_m": length,
        "interstitial_velocity_m_s": velocity,
        "axial_dispersion_m2_s": d_ax,
        "bodenstein": velocity * length / d_ax,
    }


def by_experiment(rows: list[dict[str, Any]]) -> dict[tuple[str, float], dict[str, float]]:
    out: dict[tuple[str, float], dict[str, float]] = defaultdict(dict)
    for r in rows:
        if r["brewed_mass_g"] is not None:
            out[(r["distribution"], r["brewed_mass_g"])][r["quantity"]] = r["value"]
    return out
