# SPDX-License-Identifier: GPL-2.0-or-later
"""Waszkiewicz et al. (2026): long shots at 11 constant basket pressures (V4).

One case per pressure group (11). Each case is the builder's spec for an 18.5 g recipe, then:

- basket: IMS 58 mm, 26.5 mm deep; dose 18.5 g; intergranular porosity set so that the dry bed is
  14 mm high, as measured;
- particle sizes: the measured laser-diffraction distribution (mean of the three samples), binned
  into size classes;
- machine: pressure control at the group's long-time basket pressure (pump pressure minus the
  brewing group's measured loss), reached through a 1 s ramp, with an ideal pump; the article does
  not give the brew temperature, so 93 °C is assumed (its discussion cites a 90–96 °C window);
- stop: 130 s, enough to cover the data's 100 s window after the pressure rise.

Time alignment: the data's t = 0 is the end of the pressure rise, so model times are shifted by
the moment the model's inlet pressure first reaches 95% of its target.

Observables (``observe``): the cup mass flow (g/s) as the time derivative of the beverage mass,
smoothed like the authors' (Savitzky–Golay, order 1, 3 s); its value at t = 100 s (long-time flow,
V4 calibration); the transient on the data's time grid; and, for the TDS check, the TDS of
consecutive 5 s fractions counted from the first drops (the authors place the TDS clock 8 s after
the flow clock's zero, about the first drops at 9 bar).
"""

from __future__ import annotations

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
    ideal_pump,
    make_case,
    mass_flow_g_s,
    minimal_recipe,
    phase,
    pressure_control,
    read_table,
    series,
    set_numerics,
    set_porosity_for_height,
    set_program,
    set_temperature,
)

KEY = "waszkiewicz2026"
DATASETS = ("waszkiewicz2026-flow-transient", "waszkiewicz2026-flow-pressure", "waszkiewicz2026-tds",
            "waszkiewicz2026-psd")

DOSE_G = 18.5
BED_HEIGHT_M = 0.014
TEMPERATURE_C = 93.0  # assumption: not reported
RAMP_S = 1.0
STOP_S = 130.0
LONG_TIME_S = 100.0
ALIGN_FRACTION = 0.95
TDS_WINDOW_S = 5.0
TRANSIENT_GROUP = "9"  # the "typical" 9-bar pressure group used for the transient checks
#: Cup mass that marks the first drops, for the model and the data alike (g).
FIRST_DROPS_G = 0.1
#: Cup mass for the time-to-mass comparison (g): the 9-bar shots' 2:1 target.
TIME_TO_MASS_G = 36.0


def load(paths: RepoPaths) -> dict[str, list[dict[str, Any]]]:
    return {
        "transient": read_table(paths, "waszkiewicz2026-flow-transient"),
        "longtime": read_table(paths, "waszkiewicz2026-flow-pressure"),
        "tds": read_table(paths, "waszkiewicz2026-tds"),
        "psd": read_table(paths, "waszkiewicz2026-psd"),
    }


def group_key(pressure_group_bar: float) -> str:
    return f"{pressure_group_bar:g}".replace(".", "_")


def measured_psd(rows: list[dict[str, Any]]) -> Psd:
    diameters = [math.sqrt(r["bin_lower_um"] * r["bin_upper_um"]) for r in rows]
    weights = [(r["volume_percent_1"] + r["volume_percent_2"] + r["volume_percent_3"]) / 3.0 for r in rows]
    return Psd(np.array(diameters), np.array(weights))


def build_cases(
    data: Mapping[str, list[dict[str, Any]]],
    *,
    tier: int = 1,
    n_classes: int = 16,
    overrides: Mapping[str, float] | None = None,
    module: ModuleType | None = None,
    groups: list[str] | None = None,
) -> list[Case]:
    psd = measured_psd(list(data["psd"]))
    classes = psd.classes(n_classes)
    transient: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in data["transient"]:
        transient[group_key(row["pressure_group_bar"])].append(row)
    cases = []
    for row in data["longtime"]:
        key = group_key(row["pressure_group_bar"])
        if groups is not None and key not in groups:
            continue
        target_bar = row["basket_pressure_bar"]
        recipe = minimal_recipe(DOSE_G, psd.recipe_psd(n_classes), IMS_58_H26_5,
                                profile=[{"control": "pressure", "target": target_bar}], time_s=STOP_S, tier=tier,
                                temperature_c=TEMPERATURE_C)

        def finalize(spec: dict[str, Any], values: Mapping[str, float], *, target_bar=target_bar) -> None:
            IMS_58_H26_5.apply(spec)
            spec["bed"]["dose_kg"] = DOSE_G / 1e3
            spec["bed"]["size_classes"] = [dict(c) for c in classes]
            set_porosity_for_height(spec, IMS_58_H26_5, BED_HEIGHT_M)
            set_temperature(spec, TEMPERATURE_C)
            set_program(spec, [phase(pressure_control(target_bar * 1e5), ramp_s=RAMP_S)],
                        pump=ideal_pump(max_flow_m3_s=8e-6, max_pressure_pa=1.5e6),
                        stop_time_s=STOP_S, max_duration_s=STOP_S + 15.0)
            set_numerics(spec, tier=tier)

        case = make_case(KEY, f"{KEY}/p{key}", recipe, finalize, group="all",
                         info={"group": key, "target_bar": target_bar, "longtime": row,
                               "transient": sorted(transient[key], key=lambda r: r["time_s"])},
                         overrides=overrides, module=module)
        case.info["porosity"] = case.spec["bed"]["intergranular_porosity"]
        cases.append(case)
    return cases


def alignment_time(result: Mapping[str, Any], target_pa: float) -> float:
    """Model time at which the inlet pressure first reaches ALIGN_FRACTION of its target."""
    t = series(result, "t_s")
    p = series(result, "pressure_pa")
    above = np.nonzero(p >= ALIGN_FRACTION * target_pa)[0]
    return float(t[above[0]]) if above.size else float(t[0])


def observe(case: Case, result: Mapping[str, Any]) -> dict[str, Any]:
    t, q = mass_flow_g_s(result)
    offset = alignment_time(result, case.info["target_bar"] * 1e5)
    data_t = np.array([r["time_s"] for r in case.info["transient"]])
    model_q = np.interp(data_t + offset, t, q, right=float(q[-1]) if q.size else math.nan)
    long_time = float(np.interp(LONG_TIME_S + offset, t, q))
    first_drops = result["summary"].get("first_drops_s")
    out: dict[str, Any] = {
        # model clock (from the pump start); the data clock starts at the end of the pressure rise
        "drops_s": time_to_mass(result, FIRST_DROPS_G),
        "time_to_mass_s": time_to_mass(result, TIME_TO_MASS_G),
        "offset_s": offset,
        "long_time_flow_g_s": long_time,
        "transient_t_s": data_t.tolist(),
        "transient_flow_g_s": model_q.tolist(),
        "first_drops_s": first_drops,
        "flow_t_s": t.tolist(),
        "flow_g_s": q.tolist(),
    }
    if first_drops is not None:
        out["tds_fractions"] = tds_fractions(result, first_drops)
    return out


def _first_crossing(t: np.ndarray, m: np.ndarray, level: float) -> float:
    above = np.nonzero(m >= level)[0]
    if not above.size:
        return math.nan
    i = int(above[0])
    if i == 0 or m[i] == m[i - 1]:
        return float(t[i])
    return float(t[i - 1] + (level - m[i - 1]) * (t[i] - t[i - 1]) / (m[i] - m[i - 1]))


def time_to_mass(result: Mapping[str, Any], grams: float) -> float:
    """Model time (s from the pump start) at which the cup first holds ``grams`` (linear interpolation)."""
    t = series(result, "t_s")
    m = np.maximum.accumulate(series(result, "beverage_mass_kg")) * 1e3
    return _first_crossing(t, m, grams)


def data_time_to_mass(rows: list[dict[str, Any]], grams: float) -> float:
    """Data time (s after the end of the pressure rise) at which the mean cup mass first reaches ``grams``."""
    ordered = sorted(rows, key=lambda r: r["time_s"])
    t = np.array([r["time_s"] for r in ordered])
    m = np.maximum.accumulate(np.array([r["mass_g"] for r in ordered]))
    return _first_crossing(t, m, grams)


def tds_fractions(result: Mapping[str, Any], start_s: float, n: int = 12) -> list[dict[str, float]]:
    """TDS (%) of consecutive TDS_WINDOW_S windows starting at ``start_s``."""
    t = series(result, "t_s")
    m = np.maximum.accumulate(series(result, "beverage_mass_kg"))
    d = np.maximum.accumulate(series(result, "tds_cup") * series(result, "beverage_mass_kg"))
    out = []
    for k in range(n):
        a, b = start_s + k * TDS_WINDOW_S, start_s + (k + 1) * TDS_WINDOW_S
        if b > t[-1]:
            break
        dm = np.interp(b, t, m) - np.interp(a, t, m)
        dd = np.interp(b, t, d) - np.interp(a, t, d)
        out.append({"time_mid_s": (k + 0.5) * TDS_WINDOW_S, "tds_percent": 100.0 * dd / dm if dm > 0 else math.nan})
    return out


def flow_rise(t: np.ndarray, q: np.ndarray, start_s: float, end_s: float) -> dict[str, float]:
    """Flow-rise metrics after ``start_s`` (first drops): ratio of the flow 15 s and 2 s after it,
    and the time from it to 90% of the flow at ``end_s``."""
    q_end = float(np.interp(end_s, t, q))
    q2, q15 = float(np.interp(start_s + 2.0, t, q)), float(np.interp(start_s + 15.0, t, q))
    after = np.nonzero((t >= start_s) & (q >= 0.9 * q_end))[0]
    t90 = float(t[after[0]] - start_s) if after.size else math.nan
    return {"q2": q2, "q15": q15, "ratio_15_2": q15 / q2 if q2 > 0 else math.inf, "t90_s": t90, "q_end": q_end}


def data_first_drops(rows: list[dict[str, Any]], threshold_g: float = 0.5) -> float:
    """Time (s, data clock) when the mean cup mass first exceeds ``threshold_g``."""
    for r in sorted(rows, key=lambda r: r["time_s"]):
        if r["mass_g"] >= threshold_g:
            return r["time_s"]
    return math.nan
