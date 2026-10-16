# SPDX-License-Identifier: GPL-2.0-or-later
"""Kernel verification: puckcore's sphere solver against Crank's analytic solution.

For every grid × scheme combination the report gives, against the analytic
released fraction:

- a space-refinement series (the number of shells N doubled at each step, at a fine dt);
- a time-refinement series (the number of steps doubled at each step, at a fine N);
- for each run: the maximum absolute error over all output times, the error at
  tau = D t / a² = 0.1, the mass-balance error and the runtime;
- observed orders, log2 of successive error ratios.

It also compares ``puckcore.crank_sphere_release_fraction`` with the
independent NumPy implementation in :mod:`puckworks_tools.analytic`.

Outputs: docs/validation/m0-kernel-verification.md and .json (raw numbers).
"""

from __future__ import annotations

import json
import math
import platform
import time
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np

from . import __version__ as TOOLS_VERSION
from . import analytic
from .fixtures import import_puckcore

GRIDS = ("uniform_radius", "equal_volume")
SCHEMES = ("backward_euler", "bdf2", "crank_nicolson")

#: Design orders of accuracy, for orientation (smooth solutions).
EXPECTED_TIME_ORDER = {"backward_euler": 1, "bdf2": 2, "crank_nicolson": 2}
EXPECTED_SPACE_ORDER = 2

#: docs/PLAN.md §10: Crank's solution reproduced within 0.5% (read here as an
#: absolute error of 0.005 in the released fraction) and mass-balance error
#: below 0.1% per run.
TARGET_MAX_ABS_ERROR = 0.005
TARGET_MASS_BALANCE = 1e-3

REPORT_NAME = "m0-kernel-verification"
JSON_SCHEMA = "puckworks.kernel-verification/1"


@dataclass(frozen=True)
class VerifyConfig:
    """What to run. The defaults give the published report."""

    radius_m: float = 100e-6
    diffusivity_m2_s: float = 1e-10
    t_end_s: float = 20.0
    probe_tau: float = 0.1
    space_shells: tuple[int, ...] = (16, 32, 64, 128)
    space_steps: int = 100_000
    #: Steps of the space series for first-order schemes, whose time error
    #: would otherwise contaminate the finest runs.
    space_steps_first_order: int = 1_000_000
    time_steps: tuple[int, ...] = (100, 200, 400, 800)
    time_shells: int = 65_536
    repeats: int = 3
    #: Timing stops repeating once a case has used this much wall time.
    timing_budget_s: float = 1.0
    analytic_tau_min: float = 1e-8
    analytic_tau_max: float = 10.0
    analytic_points: int = 2001

    @property
    def diffusion_time_s(self) -> float:
        """a² / D."""
        return self.radius_m**2 / self.diffusivity_m2_s

    @property
    def tau_end(self) -> float:
        return self.t_end_s / self.diffusion_time_s


#: A small configuration for smoke tests.
QUICK_CONFIG = VerifyConfig(
    space_shells=(8, 16),
    space_steps=200,
    space_steps_first_order=400,
    time_steps=(10, 20),
    time_shells=64,
    repeats=1,
    analytic_points=101,
)


def observed_orders(errors: Sequence[float]) -> list[float | None]:
    """log2(|e_i| / |e_i+1|) for successive refinements; None where undefined."""
    orders: list[float | None] = []
    for coarse, fine in zip(errors, errors[1:]):
        coarse, fine = abs(coarse), abs(fine)
        orders.append(math.log2(coarse / fine) if coarse > 0 and fine > 0 else None)
    return orders


def run_case(
    core: ModuleType, config: VerifyConfig, n_shells: int, n_steps: int, grid: str, scheme: str
) -> dict[str, Any]:
    """One solver run, summarised."""
    params = {
        "radius_m": config.radius_m,
        "diffusivity_m2_s": config.diffusivity_m2_s,
        "n_shells": n_shells,
        "t_end_s": config.t_end_s,
        "n_steps": n_steps,
        "grid": grid,
        "scheme": scheme,
    }
    runtime = math.inf
    spent = 0.0
    result: Mapping[str, Any] = {}
    for _ in range(max(1, config.repeats)):
        start = time.perf_counter()
        result = core.simulate_sphere_release(**params)
        elapsed = time.perf_counter() - start
        runtime = min(runtime, elapsed)
        spent += elapsed
        if spent >= config.timing_budget_s:
            break
    t = np.asarray(result["t_s"])
    k = int(np.argmin(np.abs(t - config.probe_tau * config.diffusion_time_s)))
    error_at_probe = float(result["released_fraction"][k] - result["analytic_fraction"][k])
    return {
        "n_shells": n_shells,
        "n_steps": n_steps,
        "max_abs_error": float(result["max_abs_error"]),
        "error_at_probe": error_at_probe,
        "probe_tau": float(t[k] / config.diffusion_time_s),
        "mass_balance_error": float(result["mass_balance_error"]),
        "runtime_s": runtime,
    }


def _series_orders(runs: Sequence[Mapping[str, Any]]) -> dict[str, list[float | None]]:
    return {
        "max_abs_error": observed_orders([r["max_abs_error"] for r in runs]),
        "error_at_probe": observed_orders([r["error_at_probe"] for r in runs]),
    }


def analytic_check(core: ModuleType, config: VerifyConfig) -> dict[str, Any]:
    """Compares puckcore's analytic function with the independent implementation."""
    taus = np.logspace(
        math.log10(config.analytic_tau_min), math.log10(config.analytic_tau_max), config.analytic_points
    )
    # Points around puckcore's switch between its short- and long-time formulas.
    taus = np.unique(np.concatenate([taus, [0.01 * (1 - 1e-9), 0.01, 0.01 * (1 + 1e-9), 0.1, 0.2]]))
    independent = np.asarray(analytic.release_fraction(taus))
    reference = np.array([core.crank_sphere_release_fraction(float(t), 1.0, 1.0) for t in taus])
    diff = np.abs(reference - independent)
    rel = diff / np.maximum(np.abs(independent), np.finfo(float).tiny)
    i_abs, i_rel = int(np.argmax(diff)), int(np.argmax(rel))
    return {
        "n_tau": int(taus.size),
        "tau_min": float(taus[0]),
        "tau_max": float(taus[-1]),
        "max_abs_diff": float(diff[i_abs]),
        "tau_at_max_abs_diff": float(taus[i_abs]),
        "max_rel_diff": float(rel[i_rel]),
        "tau_at_max_rel_diff": float(taus[i_rel]),
    }


def _signature(combo: Mapping[str, Any]) -> list[tuple[float, float, float]]:
    # The time series uses the same N and steps for every combination, so
    # identical numbers there mean the solver ignored the grid or scheme.
    return [(r["max_abs_error"], r["error_at_probe"], r["mass_balance_error"]) for r in combo["time"]]


def ignored_options(combinations: Sequence[Mapping[str, Any]]) -> dict[str, bool]:
    """Whether the solver gave identical results for every grid, or for every scheme."""
    by_key = {(c["grid"], c["scheme"]): _signature(c) for c in combinations}
    grid_ignored = all(
        len({repr(by_key[(g, s)]) for g in GRIDS if (g, s) in by_key}) == 1 for s in SCHEMES
    )
    scheme_ignored = all(
        len({repr(by_key[(g, s)]) for s in SCHEMES if (g, s) in by_key}) == 1 for g in GRIDS
    )
    return {"grid": grid_ignored, "scheme": scheme_ignored}


def space_steps_for(config: VerifyConfig, scheme: str) -> int:
    """Steps of the space-refinement series for ``scheme``."""
    return config.space_steps_first_order if EXPECTED_TIME_ORDER[scheme] == 1 else config.space_steps


def run(config: VerifyConfig = VerifyConfig(), core: ModuleType | None = None) -> dict[str, Any]:
    """Runs everything and returns the report document (JSON-serialisable)."""
    core = core or import_puckcore()
    combinations = []
    for grid in GRIDS:
        for scheme in SCHEMES:
            n_steps = space_steps_for(config, scheme)
            space = [run_case(core, config, n, n_steps, grid, scheme) for n in config.space_shells]
            steps = [run_case(core, config, config.time_shells, s, grid, scheme) for s in config.time_steps]
            runs = [*space, *steps]
            combinations.append(
                {
                    "grid": grid,
                    "scheme": scheme,
                    "space_steps": n_steps,
                    "space": space,
                    "space_orders": _series_orders(space),
                    "time": steps,
                    "time_orders": _series_orders(steps),
                    "worst_mass_balance_error": max(r["mass_balance_error"] for r in runs),
                    "meets_targets": bool(
                        space[-1]["max_abs_error"] <= TARGET_MAX_ABS_ERROR
                        and all(r["mass_balance_error"] <= TARGET_MASS_BALANCE for r in runs)
                    ),
                }
            )
    ignored = ignored_options(combinations)
    return {
        "schema": JSON_SCHEMA,
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "core_version": core.__version__,
        "tools_version": TOOLS_VERSION,
        "platform": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "system": platform.system(),
            "machine": platform.machine(),
        },
        "config": {**asdict(config), "tau_end": config.tau_end, "diffusion_time_s": config.diffusion_time_s},
        "targets": {"max_abs_error": TARGET_MAX_ABS_ERROR, "mass_balance_error": TARGET_MASS_BALANCE},
        "expected_orders": {"space": EXPECTED_SPACE_ORDER, "time": EXPECTED_TIME_ORDER},
        "analytic_check": analytic_check(core, config),
        "ignored_options": ignored,
        "combinations": combinations,
    }


# -- Markdown ----------------------------------------------------------------


def _e(x: float) -> str:
    return f"{x:.3e}"


def _order(x: float | None) -> str:
    return "–" if x is None else f"{x:.2f}"


def _last(orders: Sequence[float | None]) -> float | None:
    return orders[-1] if orders else None


def _series_table(runs: Sequence[Mapping[str, Any]], orders: Mapping[str, list[float | None]], key: str) -> list[str]:
    label = "N" if key == "n_shells" else "steps"
    lines = [
        f"| {label} | max \\|e\\| | order | \\|e(τ=0.1)\\| | order | mass balance | runtime (ms) |",
        "|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for i, r in enumerate(runs):
        o_max = _order(orders["max_abs_error"][i - 1]) if i else ""
        o_probe = _order(orders["error_at_probe"][i - 1]) if i else ""
        lines.append(
            f"| {r[key]} | {_e(r['max_abs_error'])} | {o_max} | {_e(abs(r['error_at_probe']))} | {o_probe} "
            f"| {_e(r['mass_balance_error'])} | {r['runtime_s'] * 1e3:.1f} |"
        )
    return lines


def render_markdown(doc: Mapping[str, Any]) -> str:
    """The human-readable report."""
    cfg = doc["config"]
    check = doc["analytic_check"]
    plat = doc["platform"]
    out = [
        "<!-- SPDX-License-Identifier: GPL-2.0-or-later -->",
        "<!-- Generated by `puckworks-tools verify`; do not edit by hand. -->",
        "",
        "# M0 kernel verification: sphere diffusion against Crank's solution",
        "",
        f"Generated {doc['generated_utc']} by puckworks-tools {doc['tools_version']} with puckcore "
        f"{doc['core_version']} (Python {plat['python']}, NumPy {plat['numpy']}, {plat['system']} "
        f"{plat['machine']}). Raw numbers: [{REPORT_NAME}.json]({REPORT_NAME}.json).",
        "",
        "## Problem",
        "",
        "A sphere of radius a holds a uniform concentration; for t > 0 its surface is a perfect sink "
        "and the solute diffuses out with constant D. The error e is the numerical minus the analytic "
        "released fraction M_t/M_∞ (Crank 1975, eq. 6.20), with τ = D t / a².",
        "",
        f"- a = {cfg['radius_m'] * 1e6:g} µm, D = {cfg['diffusivity_m2_s']:g} m²/s, so a²/D = "
        f"{cfg['diffusion_time_s']:g} s; t_end = {cfg['t_end_s']:g} s (τ_end = {cfg['tau_end']:.3g}).",
        "- \"max |e|\" is the largest error over all output times, including the start, where the "
        "initial discontinuity at the surface limits the convergence rate; \"|e(τ=0.1)|\" is the "
        "error at τ = 0.1, away from it.",
        f"- Space refinement: N = {', '.join(map(str, cfg['space_shells']))} shells at "
        f"{cfg['space_steps']} steps ({cfg['space_steps_first_order']} for backward Euler, so that its "
        f"first-order time error stays small). Time refinement: {', '.join(map(str, cfg['time_steps']))} "
        f"steps at N = {cfg['time_shells']}.",
        "- Observed order = log2(e_coarse / e_fine) between successive rows. Design orders for smooth "
        f"solutions: {EXPECTED_SPACE_ORDER} in space; 1 in time for backward Euler, 2 for BDF2 and "
        "Crank–Nicolson. Where the finest space runs still carry time error (backward Euler: compare "
        "|e(τ=0.1)| with its time-refinement series), the observed space order underestimates the "
        "true one.",
        f"- Runtime per run: best of up to {cfg['repeats']} repeats (fewer once a case has used "
        f"{cfg['timing_budget_s']:g} s), including the conversion of results to Python lists.",
        "",
    ]
    ignored = [name for name in ("grid", "scheme") if doc["ignored_options"][name]]
    if ignored:
        names = " and ".join(f"`{name}`" for name in ignored)
        out += [
            f"> **Note.** The time-refinement runs, which use the same N and steps everywhere, gave "
            f"identical results for every value of {names}: the installed solver ignores "
            f"{'them' if len(ignored) > 1 else 'it'} (as the M0 placeholder does). Re-run this report "
            "on the final solver.",
            "",
        ]
    out += [
        "## Summary",
        "",
        "Orders are for the finest pair of each series. \"Targets\" are those of docs/PLAN.md §10: "
        f"max |e| ≤ {TARGET_MAX_ABS_ERROR:g} on the finest space run, read as Crank's solution within "
        f"0.5% of M_∞, and mass-balance error ≤ {TARGET_MASS_BALANCE:g} (0.1%) on every run.",
        "",
        "| grid | scheme | space order, max \\|e\\| | space order, e(τ=0.1) | time order, max \\|e\\| "
        "| time order, e(τ=0.1) | finest max \\|e\\| | worst mass balance | targets |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for combo in doc["combinations"]:
        out.append(
            f"| {combo['grid']} | {combo['scheme']} | {_order(_last(combo['space_orders']['max_abs_error']))} "
            f"| {_order(_last(combo['space_orders']['error_at_probe']))} "
            f"| {_order(_last(combo['time_orders']['max_abs_error']))} "
            f"| {_order(_last(combo['time_orders']['error_at_probe']))} "
            f"| {_e(combo['space'][-1]['max_abs_error'])} | {_e(combo['worst_mass_balance_error'])} "
            f"| {'met' if combo['meets_targets'] else 'not met'} |"
        )
    out += [
        "",
        "## Independent check of the analytic solution",
        "",
        "`puckcore.crank_sphere_release_fraction` was compared with an independent NumPy implementation "
        "of the long-time series, written from the formula (`puckworks_tools.analytic`, which does not "
        f"call puckcore), at {check['n_tau']} values of τ from {check['tau_min']:g} to {check['tau_max']:g} "
        "(log-spaced, plus points around puckcore's switch between its short- and long-time formulas "
        "at τ = 0.01).",
        "",
        f"- Maximum absolute difference: {check['max_abs_diff']:.3e} (at τ = {check['tau_at_max_abs_diff']:.4g}).",
        f"- Maximum relative difference: {check['max_rel_diff']:.3e} (at τ = {check['tau_at_max_rel_diff']:.4g}).",
        "",
        "## Results by grid and scheme",
        "",
    ]
    for combo in doc["combinations"]:
        out += [
            f"### {combo['grid']} · {combo['scheme']}",
            "",
            f"Space refinement ({combo['space_steps']} steps):",
            "",
            *_series_table(combo["space"], combo["space_orders"], "n_shells"),
            "",
            f"Time refinement (N = {cfg['time_shells']}):",
            "",
            *_series_table(combo["time"], combo["time_orders"], "n_steps"),
            "",
        ]
    return "\n".join(out)


def write_report(doc: Mapping[str, Any], output_dir: Path) -> tuple[Path, Path]:
    """Writes the Markdown report and the raw JSON; returns their paths."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    md_path = output_dir / f"{REPORT_NAME}.md"
    json_path = output_dir / f"{REPORT_NAME}.json"
    md_path.write_text(render_markdown(doc), encoding="utf-8")
    json_path.write_text(json.dumps(doc, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return md_path, json_path
