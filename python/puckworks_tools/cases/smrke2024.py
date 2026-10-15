# SPDX-License-Identifier: GPL-2.0-or-later
"""Smrke et al. (2024): shot time and extraction yield versus burr gap and added fines (V5, held out).

One case per ground sample (15: six burr gaps without added fines, and 1, 2 or 4 g of sieved fines
at 190, 210 and 250 µm). Each case is the builder's spec for a 20 g recipe carrying the sample's
PSD, then:

- basket: VST 20 g (58.5 mm, straight walls assumed); dose 20 g in all cases (added fines replace the
  same mass of coffee);
- particle sizes: a fines + boulders log-normal mixture matching the measured share below 100 µm and
  median X50 (Camsizer, Fig. 2); the fines mode and the widths are the input models' defaults;
- machine: pressure control at 9 bar through a 1 s ramp, ideal pump (Black Eagle); the temperature is
  not reported, so 93 °C is assumed;
- stop: 40 g of beverage (the shots were stopped by hand at 40 g).

Held out: the builder's closures are kept (calibrated parameters as recipe overrides).

Observables: shot time (from pump start; the article uses the machine's displayed time) and
extraction yield at the stop.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import ModuleType
from typing import Any

from ..paths import RepoPaths
from .common import (
    VST_20G,
    Case,
    bimodal_psd,
    ideal_pump,
    make_case,
    minimal_recipe,
    phase,
    pressure_control,
    read_table,
    set_numerics,
    set_program,
    set_temperature,
)

KEY = "smrke2024"
DATASETS = ("smrke2024-psd", "smrke2024-shots")

DOSE_G = 20.0
BEVERAGE_G = 40.0
PRESSURE_BAR = 9.0
TEMPERATURE_C = 93.0  # assumption: not reported
RAMP_S = 1.0


def load(paths: RepoPaths) -> dict[str, list[dict[str, Any]]]:
    return {"psd": read_table(paths, "smrke2024-psd"), "shots": read_table(paths, "smrke2024-shots")}


def build_cases(
    data: Mapping[str, list[dict[str, Any]]],
    *,
    tier: int = 1,
    n_classes: int = 16,
    overrides: Mapping[str, float] | None = None,
    module: ModuleType | None = None,
) -> list[Case]:
    cases = []
    for row in data["psd"]:
        setting, grams = row["grinder_setting_um"], row["fines_added_g"]
        psd = bimodal_psd(share_below_100um=row["q100_percent"] / 100.0, median_um=row["x50_um"])
        classes = psd.classes(n_classes)
        recipe = minimal_recipe(DOSE_G, psd.recipe_psd(n_classes), VST_20G,
                                profile=[{"control": "pressure", "target": PRESSURE_BAR}], beverage_g=BEVERAGE_G,
                                tier=tier, temperature_c=TEMPERATURE_C)

        def finalize(spec: dict[str, Any], values: Mapping[str, float], *, classes=classes) -> None:
            VST_20G.apply(spec)
            spec["bed"]["dose_kg"] = DOSE_G / 1e3
            spec["bed"]["size_classes"] = [dict(c) for c in classes]
            set_temperature(spec, TEMPERATURE_C)
            set_program(spec, [phase(pressure_control(PRESSURE_BAR * 1e5), ramp_s=RAMP_S)],
                        pump=ideal_pump(max_flow_m3_s=8e-6, max_pressure_pa=1.2e6),
                        stop_beverage_kg=BEVERAGE_G / 1e3, max_duration_s=150.0)
            set_numerics(spec, tier=tier)

        shots = [s for s in data["shots"] if s["grinder_setting_um"] == setting and s["fines_added_g"] == grams]
        cases.append(make_case(KEY, f"{KEY}/s{setting}_f{grams}", recipe, finalize, group="all",
                               info={"setting_um": setting, "fines_g": grams, "psd": row, "shots": shots},
                               overrides=overrides, module=module))
    return cases


def observe(case: Case, result: Mapping[str, Any]) -> dict[str, Any]:
    summary = result["summary"]
    return {
        "setting_um": case.info["setting_um"],
        "fines_g": case.info["fines_g"],
        "shot_time_s": summary["shot_time_s"],
        "ey_percent": 100.0 * summary["ey"],
        "beverage_g": summary["beverage_mass_kg"] * 1e3,
        "stop_reason": summary["stop_reason"],
    }
