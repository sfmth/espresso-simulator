# SPDX-License-Identifier: GPL-2.0-or-later
"""Roman Corrochano (2017): permeability of extracted beds versus bed density and grind (V6).

One case per grind (ΨB–ΨE) and initial bed density (360, 400, 480 kg/m³): 12 cases. Each case is
the builder's spec for the dose, with the grind's PSD, then:

- cell: the permeameter's brewing chamber, a cylinder of 1.1×10⁻³ m² cross-section (37.4 mm); the bed
  fills 20 cm³ (18.2 mm), so the dose (7.2, 8.0 or 9.5 g) fixes the bulk density;
- bed: skeletal density 1337 kg/m³ and particle porosity 0.57 (Blend 1, Tables 4.5–4.6); the
  intergranular porosity follows from the bulk density;
- particle sizes: a fines + boulders log-normal mixture matching the dry-measured share of fines and
  X50 (Table 4.1);
- permeability: the builder's κ₀, which applies the app's density closure itself:
  κ₀ = κ_ref·(D32/D32_ref)²·[KC(ε)/KC(ε_ref)]^α with KC(ε) = ε³/(1 − ε)², the case's porosity ε
  passed as a recipe override of ``bed.porosity.intergranular``, ε_ref the registry default and α
  the closure exponent ``hydraulics.kozeny_carman.density_exponent`` (an override parameter the
  builder reads; α = 1 is plain relative Kozeny–Carman). V6 calibrates α;
- machine: pressure control at 3 bar (the data come from Darcy fits over 0.5–4.5 bar), ideal pump,
  80 °C, run for 600 s, the hydration time after which the beds were extracted; tier 0 by default.

Observable: the effective permeability κ = Q·μ·L/(A·ΔP) at the end of the run, from the outflow, the
inlet pressure and the model's bed height, with the viscosity of water at 80 °C. V6 compares its
change with density within each grind against the data's.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from types import ModuleType
from typing import Any

from ..paths import RepoPaths
from .common import (
    Basket,
    Case,
    bimodal_psd,
    ideal_pump,
    make_case,
    minimal_recipe,
    phase,
    pressure_control,
    read_table,
    series,
    set_numerics,
    set_porosity_for_density,
    set_program,
    set_temperature,
)

KEY = "corrochano2017"
DATASETS = ("corrochano2017-permeability", "corrochano2017-psd", "corrochano2017-properties")

CELL_AREA_M2 = 1.1e-3
CELL_VOLUME_M3 = 20e-6
#: The cell, drawn 25 mm tall so the 18.2 mm bed (20 cm³) fits with a little headspace; the bed's bulk
#: density is still dose / 20 cm³.
CELL = Basket("Corrochano permeameter cell", 2000.0 * math.sqrt(CELL_AREA_M2 / math.pi), 25.0,
              2000.0 * math.sqrt(CELL_AREA_M2 / math.pi) - 2.0)
SKELETAL_DENSITY = 1337.0
PARTICLE_POROSITY = 0.57
TEMPERATURE_C = 80.0
PRESSURE_BAR = 3.0
DURATION_S = 600.0
#: Viscosity of water at 80 °C, Pa·s (registry hydraulics.viscosity.water_80c, 0.355 mPa·s).
WATER_VISCOSITY_80C = 0.355e-3
#: Registry id of the closure exponent α (data/params/hydraulics.yaml); the builder applies it.
DENSITY_EXPONENT_ID = "hydraulics.kozeny_carman.density_exponent"
#: Registry id of the bed's intergranular porosity; a recipe override sets the case's porosity.
POROSITY_ID = "bed.porosity.intergranular"


def bed_porosity(bulk_density_kg_m3: float) -> float:
    """Intergranular porosity of the cell's bed at a bulk density (Blend 1 skeletal density and
    particle porosity), as ``common.set_porosity_for_density`` computes it."""
    return 1.0 - bulk_density_kg_m3 / ((1.0 - PARTICLE_POROSITY) * SKELETAL_DENSITY)


def load(paths: RepoPaths) -> dict[str, list[dict[str, Any]]]:
    return {
        "permeability": read_table(paths, "corrochano2017-permeability"),
        "psd": read_table(paths, "corrochano2017-psd"),
        "properties": read_table(paths, "corrochano2017-properties"),
    }


def build_cases(
    data: Mapping[str, list[dict[str, Any]]],
    *,
    tier: int = 0,
    n_classes: int = 8,
    overrides: Mapping[str, float] | None = None,
    module: ModuleType | None = None,
) -> list[Case]:
    dry = {r["grind"]: r for r in data["psd"] if r["method"] == "dry"}
    cases = []
    for row in data["permeability"]:
        grind, dose = row["grind"], row["dose_g"]
        psd = bimodal_psd(share_below_100um=dry[grind]["fines_percent"] / 100.0, median_um=dry[grind]["x50_um"])
        classes = psd.classes(n_classes)
        porosity = bed_porosity(dose / 1e3 / CELL_VOLUME_M3)
        recipe = minimal_recipe(dose, psd.recipe_psd(n_classes), CELL,
                                profile=[{"control": "pressure", "target": PRESSURE_BAR}], time_s=DURATION_S,
                                tier=tier, temperature_c=TEMPERATURE_C, overrides={POROSITY_ID: porosity})
        info: dict[str, Any] = {"grind": grind, "density": row["bed_density_kg_m3"], "data": row, "porosity": porosity}

        def finalize(spec: dict[str, Any], values: Mapping[str, float], *, classes=classes, dose=dose,
                     info=info) -> None:
            CELL.apply(spec)
            spec["basket"]["extra_headspace_m3"] = 1e-6
            spec["bed"]["dose_kg"] = dose / 1e3
            spec["bed"]["skeletal_density_kg_m3"] = SKELETAL_DENSITY
            spec["bed"]["intraparticle_porosity"] = PARTICLE_POROSITY
            spec["bed"]["size_classes"] = [dict(c) for c in classes]
            # the same porosity as the recipe override, from which the builder's κ₀ already carries
            # the density closure
            set_porosity_for_density(spec, dose / 1e3 / CELL_VOLUME_M3)
            info.update(kappa_builder=spec["hydraulics"]["permeability_m2"])
            set_temperature(spec, TEMPERATURE_C)
            spec["thermal"]["initial_bed_temp_c"] = TEMPERATURE_C
            set_program(spec, [phase(pressure_control(PRESSURE_BAR * 1e5), ramp_s=1.0)],
                        pump=ideal_pump(max_flow_m3_s=8e-6, max_pressure_pa=1.0e6),
                        stop_time_s=DURATION_S, max_duration_s=DURATION_S + 30.0)
            set_numerics(spec, tier=tier, output_interval_s=1.0, snapshot_count=2)

        cases.append(make_case(KEY, f"{KEY}/{grind}_{int(row['bed_density_kg_m3'])}", recipe, finalize, group=grind,
                               info=info, overrides=overrides, module=module))
    return cases


def observe(case: Case, result: Mapping[str, Any]) -> dict[str, Any]:
    flow = series(result, "flow_out_m3_s")
    pressure = series(result, "pressure_pa")
    t = series(result, "t_s")
    # the last output point before the stop (the series continues through the drip)
    end = int(max(0, min(len(t) - 1, (t <= DURATION_S).sum() - 1)))
    length = result["summary"]["bed_height_m"]
    q, dp = float(flow[end]), float(pressure[end])
    kappa = q * WATER_VISCOSITY_80C * length / (CELL_AREA_M2 * dp) if dp > 0 else math.nan
    return {"grind": case.info["grind"], "density": case.info["density"], "permeability_m2": kappa,
            "flow_m3_s": q, "pressure_pa": dp, "bed_length_m": length}
