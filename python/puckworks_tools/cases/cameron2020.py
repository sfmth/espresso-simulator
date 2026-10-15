# SPDX-License-Identifier: GPL-2.0-or-later
"""Cameron et al. (2020): extraction yield and shot time versus EK43 grind setting at 6 bar (V3, held out).

One case per grind setting (1.1 to 2.3). Each case is the builder's spec for a 20 g recipe that
carries the grind's PSD (so the builder's permeability closure sees it), then:

- basket: VST 20 g ridgeless (58.5 mm, straight walls assumed); dose 20 g;
- particle sizes (``psd="curves"``, default): the Fig. 2B volume distributions, interpolated
  linearly in grind setting between the measured settings 1.0, 1.5, 2.0 and 2.5, as the authors
  interpolated their own table; ``psd="two_class"`` uses the supplement's two-class description
  instead (fines radius 12 µm; boulder size taken as a radius, as printed);
- machine: pressure control at 6 bar through a 1 s ramp, ideal pump (San Remo Opera), 92 °C;
- stop: 40 g of beverage.

Being held out, the cases keep the builder's closures (permeability, heterogeneity) with the
calibrated parameters passed as recipe overrides; nothing is fitted to this dataset.

Observables: extraction yield and shot time at the 40 g stop, and the time of the first drops.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from types import ModuleType
from typing import Any

import numpy as np

from ..paths import RepoPaths
from .common import (
    VST_20G,
    Case,
    Psd,
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

KEY = "cameron2020"
DATASETS = ("cameron2020-ey-grind", "cameron2020-psd", "cameron2020-two-class")

DOSE_G = 20.0
BEVERAGE_G = 40.0
PRESSURE_BAR = 6.0
TEMPERATURE_C = 92.0
RAMP_S = 1.0


def load(paths: RepoPaths) -> dict[str, list[dict[str, Any]]]:
    return {
        "ey": read_table(paths, "cameron2020-ey-grind"),
        "psd": read_table(paths, "cameron2020-psd"),
        "two_class": read_table(paths, "cameron2020-two-class"),
    }


def curve_psd(rows: list[dict[str, Any]], grind_setting: float) -> Psd:
    """The Fig. 2B distribution at ``grind_setting``, interpolated linearly between measured settings."""
    curves: dict[float, list[tuple[float, float]]] = defaultdict(list)
    for r in rows:
        curves[r["grind_setting"]].append((r["diameter_um"], r["volume_percent"]))
    settings = sorted(curves)
    gs = min(max(grind_setting, settings[0]), settings[-1])
    hi = next(s for s in settings if s >= gs)
    lo = max(s for s in settings if s <= gs)
    d = np.array([x for x, _ in sorted(curves[lo])])
    v_lo = np.array([y for _, y in sorted(curves[lo])])
    v_hi = np.array([y for _, y in sorted(curves[hi])])
    f = 0.0 if hi == lo else (gs - lo) / (hi - lo)
    return Psd(d, (1.0 - f) * v_lo + f * v_hi)


def two_class(rows: list[dict[str, Any]], grind_setting: float) -> list[dict[str, float]]:
    """The supplement's two classes at ``grind_setting``, interpolated linearly (radii as printed)."""
    table = sorted(rows, key=lambda r: r["grind_setting"])
    gs = [r["grind_setting"] for r in table]
    fines = np.interp(grind_setting, gs, [r["fines_volume_fraction"] for r in table])
    boulders = np.interp(grind_setting, gs, [r["boulder_volume_fraction"] for r in table])
    radius = np.interp(grind_setting, gs, [r["boulder_size_um"] for r in table])
    total = fines + boulders
    return [
        {"radius_m": table[0]["fines_radius_um"] * 1e-6, "volume_fraction": float(fines / total)},
        {"radius_m": float(radius) * 1e-6, "volume_fraction": float(boulders / total)},
    ]


def build_cases(
    data: Mapping[str, list[dict[str, Any]]],
    *,
    tier: int = 1,
    n_classes: int = 16,
    overrides: Mapping[str, float] | None = None,
    module: ModuleType | None = None,
    psd: str = "curves",
) -> list[Case]:
    cases = []
    for row in data["ey"]:
        gs = row["grind_setting"]
        if psd == "curves":
            dist = curve_psd(list(data["psd"]), gs)
            classes = dist.classes(n_classes)
            recipe_psd = dist.recipe_psd(n_classes)
        elif psd == "two_class":
            classes = two_class(list(data["two_class"]), gs)
            recipe_psd = ([c["radius_m"] * 2e6 for c in classes], [c["volume_fraction"] for c in classes])
        else:
            raise ValueError(f"unknown psd option {psd!r}")
        recipe = minimal_recipe(DOSE_G, recipe_psd, VST_20G, profile=[{"control": "pressure", "target": PRESSURE_BAR}],
                                beverage_g=BEVERAGE_G, tier=tier, temperature_c=TEMPERATURE_C)

        def finalize(spec: dict[str, Any], values: Mapping[str, float], *, classes=classes) -> None:
            VST_20G.apply(spec)
            spec["bed"]["dose_kg"] = DOSE_G / 1e3
            spec["bed"]["size_classes"] = [dict(c) for c in classes]
            set_temperature(spec, TEMPERATURE_C)
            set_program(spec, [phase(pressure_control(PRESSURE_BAR * 1e5), ramp_s=RAMP_S)],
                        pump=ideal_pump(max_flow_m3_s=8e-6, max_pressure_pa=1.2e6),
                        stop_beverage_kg=BEVERAGE_G / 1e3, max_duration_s=120.0)
            set_numerics(spec, tier=tier)

        cases.append(make_case(KEY, f"{KEY}/gs{gs:.1f}".replace(".", "_"), recipe, finalize, group="all",
                               info={"grind_setting": gs, "data": row, "psd": psd}, overrides=overrides,
                               module=module))
    return cases


def observe(case: Case, result: Mapping[str, Any]) -> dict[str, Any]:
    summary = result["summary"]
    return {
        "grind_setting": case.info["grind_setting"],
        "ey_percent": 100.0 * summary["ey"],
        "shot_time_s": summary["shot_time_s"],
        "first_drops_s": summary.get("first_drops_s"),
        "beverage_g": summary["beverage_mass_kg"] * 1e3,
        "stop_reason": summary["stop_reason"],
    }
