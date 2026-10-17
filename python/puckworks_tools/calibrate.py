# SPDX-License-Identifier: GPL-2.0-or-later
"""Calibration harness (docs/PLAN.md §12 M1, §7.3 K): fits model parameters to the calibration datasets.

``puckworks-tools calibrate`` reads ``data/calibration/config.yaml``, builds the cases of each
residual block (V1 Schmieder 2023, V2 Vaca Guerra 2024 dispersion, V4 Waszkiewicz 2026 long-time
flow, V6 Corrochano 2017 relative closure; ``cases``), simulates them with ``puckcore``, and
minimises the weighted, normalised residuals with ``scipy.optimize.least_squares`` (trust-region
reflective, box bounds). It writes ``data/calibration/<label>.yaml`` and ``current.yaml``::

    schema: puckworks.calibration/1
    created: 2026-10-14
    parameters: {<registry id>: <value in the registry's units>}
    fit: {datasets, blocks, residuals, uncertainties, correlation, optimizer, ...}

Parameters, registry ids and spec fields (docs/validation/calibration.md):

- every fitted parameter is a parameter-registry record, which gives its units, its starting value
  (the value, or the prior's central value, as the export uses) and its default bounds (the prior's
  support, or its 99.7% interval);
- ``override`` parameters are passed to the builder as recipe overrides, so the calibrated value
  means exactly what the app's builder makes of the registry id; ``spec`` parameters are written
  into one spec field of selected cases (setup-specific nuisance parameters); ``case`` parameters
  are applied by a case builder.

The Jacobian is computed by forward differences, re-running only the blocks a parameter affects,
and parameter uncertainties come from it: cov = s²·(JᵀJ)⁻¹ with s² the reduced chi-square
(pseudo-inverse via SVD; directions with negligible singular values are reported as not identified),
with each SD compared with the registry prior's (``prior_sd_ratio``).

Around the fit: the fitted nuisance permeabilities are pooled into the app's
``hydraulics.permeability.reference`` (``reference_permeability``; re-run on its own with
``--pool-only``); ``--loo`` adds the V1 leave-one-condition-out check and ``--sensitivity`` refits under
changed case and structural assumptions (``SENSITIVITY_VARIANTS``); the config's ``fixed`` section
records parameters reviewed and held at their registry values.
"""

from __future__ import annotations

import argparse
import copy
import datetime
import inspect
import json
import math
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from multiprocessing import get_context
from pathlib import Path
from statistics import NormalDist
from types import ModuleType
from typing import Any

import numpy as np
import yaml

from . import __version__
from .cases import MODULES
from .cases.common import Case, get_path, set_path
from .paths import RepoPaths
from .registry import load_registry, lognormal_parameters
from .units import UnitVocabulary, load_units
from .yamlio import load_yaml

CONFIG_SCHEMA = "puckworks.calibration-config/1"
CALIBRATION_SCHEMA = "puckworks.calibration/1"
#: Normalised residual given to an observable the model could not produce (failed or choked shot).
FAILED_RESIDUAL = 10.0
#: A fitted value within this fraction of its bounds' span of a bound is reported as at the bound.
AT_BOUND_FRACTION = 0.01
#: Local marginal SD at or above this fraction of the prior SD: review the parameter for pruning.
WEAK_IDENTIFICATION_RATIO = 0.5
#: Operational training-cost ceiling for registry-value pruning; not a significance threshold.
PRUNING_COST_TOLERANCE = 0.01


class CalibrationError(RuntimeError):
    """A configuration or setup problem."""


# -- parameters ----------------------------------------------------------------------


def registry_default(record: Mapping[str, Any]) -> float:
    """The number the export uses for a record: its value, else the prior's central value."""
    if "value" in record:
        return float(record["value"])
    prior = record["prior"]
    kind = prior["distribution"]
    if kind == "fixed":
        return float(prior["value"])
    if kind == "uniform":
        return 0.5 * (prior["min"] + prior["max"])
    if kind == "normal":
        return float(prior["mean"])
    if kind == "triangular":
        return float(prior["mode"])
    if kind == "lognormal":
        return math.exp(lognormal_parameters(prior)[0])
    raise CalibrationError(f"{record['id']}: unknown prior {kind!r}")


def prior_bounds(record: Mapping[str, Any]) -> tuple[float, float]:
    """Default bounds: the prior's support, or its 99.7% interval, intersected with the range;
    without a prior, a factor of 10 around a positive value (or ±50% of a signed one)."""
    lo_range = record["range"].get("min", -math.inf)
    hi_range = record["range"].get("max", math.inf)
    prior = record.get("prior")
    z = NormalDist().inv_cdf(0.9985)
    if prior is None or prior["distribution"] == "fixed":
        v = registry_default(record)
        lo, hi = (v / 10.0, v * 10.0) if v > 0 else (v - 0.5 * abs(v) - 1.0, v + 0.5 * abs(v) + 1.0)
    elif prior["distribution"] in ("uniform", "triangular"):
        lo, hi = prior["min"], prior["max"]
    elif prior["distribution"] == "normal":
        lo, hi = prior["mean"] - z * prior["sd"], prior["mean"] + z * prior["sd"]
    else:
        mu, sigma = lognormal_parameters(prior)
        lo, hi = math.exp(mu - z * sigma), math.exp(mu + z * sigma)
    return max(lo, lo_range), min(hi, hi_range)


def _uniform_sd(lo: float, hi: float, log: bool) -> float:
    """SD of a value uniform on [lo, hi], or of its log10."""
    if not log:
        return (hi - lo) / math.sqrt(12.0)

    def m1(v: float) -> float:
        return v * math.log(v) - v

    def m2(v: float) -> float:
        return v * (math.log(v) ** 2 - 2.0 * math.log(v) + 2.0)

    mean = (m1(hi) - m1(lo)) / (hi - lo)
    second = (m2(hi) - m2(lo)) / (hi - lo)
    return math.sqrt(max(second - mean * mean, 0.0)) / math.log(10.0)


def prior_sd(record: Mapping[str, Any], scale: str, bounds: tuple[float, float] | None = None) -> float | None:
    """SD of the record's prior in fit coordinates: of log10 of the value for a log-scaled parameter,
    of the value otherwise. Without a prior, the bounds count as a prior uniform in the fit coordinate
    (log-uniform for a log-scaled parameter)."""
    log = scale == "log"
    prior = record.get("prior")
    kind = prior["distribution"] if prior else None
    ln10 = math.log(10.0)
    if kind == "uniform" and (not log or prior["min"] > 0):
        return _uniform_sd(float(prior["min"]), float(prior["max"]), log)
    if kind == "normal":
        sd, mean = float(prior["sd"]), float(prior["mean"])
        return sd / (abs(mean) * ln10) if log else sd
    if kind == "lognormal":
        mu, sigma = lognormal_parameters(prior)
        return sigma / ln10 if log else math.exp(mu + 0.5 * sigma**2) * math.sqrt(math.expm1(sigma**2))
    if kind == "triangular":
        a, b, c = float(prior["min"]), float(prior["max"]), float(prior["mode"])
        sd = math.sqrt((a * a + b * b + c * c - a * b - a * c - b * c) / 18.0)
        return sd / (c * ln10) if log else sd
    if bounds is not None and (not log or bounds[0] > 0):
        lo, hi = (math.log10(bounds[0]), math.log10(bounds[1])) if log else (float(bounds[0]), float(bounds[1]))
        return (hi - lo) / math.sqrt(12.0)
    return None


#: Spec-field suffix → SI unit spelling (docs/model/m1-contract.md §2: units in field names).
_SUFFIX_UNITS = (
    ("_m3_s", "m^3/s"), ("_kg_m3", "kg/m^3"), ("_m2_s", "m^2/s"), ("_m_s", "m/s"), ("_m2", "m^2"),
    ("_pa", "Pa"), ("_kg", "kg"), ("_s", "s"), ("_c", "degC"), ("_m", "m"),
)


def spec_field_unit(path: str) -> str:
    """SI unit of a spec field, from its name (no suffix: dimensionless)."""
    name = path.split(".")[-1]
    for suffix, unit in _SUFFIX_UNITS:
        if name.endswith(suffix):
            return unit
    return "1"


def to_spec_units(units: UnitVocabulary, value: float, registry_unit: str, path: str) -> float:
    """Converts a registry value to the SI unit of a spec field (dimensions must agree)."""
    source = units.parse(registry_unit)
    target = units.parse(spec_field_unit(path))
    if source.dims != target.dims:
        raise CalibrationError(f"{path}: cannot write a value in {registry_unit!r} into a {spec_field_unit(path)!r} field")
    return (value * source.scale + source.offset - target.offset) / target.scale


@dataclass
class Parameter:
    """One fitted parameter (values in the registry's units)."""

    id: str
    mode: str
    blocks: tuple[str, ...]
    scale: str
    lower: float
    upper: float
    start: float
    units: str
    target: str | None = None
    applies_to: str | None = None
    #: SD of the registry prior in fit coordinates (``prior_sd``); None if the record has none.
    prior_sd_x: float | None = None

    def to_x(self, value: float) -> float:
        return math.log10(value) if self.scale == "log" else value

    def from_x(self, x: float) -> float:
        return 10.0**x if self.scale == "log" else x

    @property
    def x_bounds(self) -> tuple[float, float]:
        return self.to_x(self.lower), self.to_x(self.upper)

    def applies(self, case: Case) -> bool:
        if self.applies_to is None:
            return True
        dataset, _, group = self.applies_to.partition(":")
        return case.dataset == dataset and (not group or case.group == group)


def make_parameters(config: Mapping[str, Any], records: Mapping[str, Mapping[str, Any]],
                    blocks: Iterable[str]) -> list[Parameter]:
    """Parameters of the config that affect at least one of ``blocks``."""
    wanted = set(blocks)
    out = []
    for entry in config["parameters"]:
        rid = entry["id"]
        if rid not in records:
            raise CalibrationError(f"parameter {rid!r} has no parameter-registry record (add one, tagged fitted)")
        record = records[rid]
        mode = entry.get("mode", "override")
        if mode not in ("override", "spec", "case"):
            raise CalibrationError(f"{rid}: unknown mode {mode!r}")
        if mode == "spec" and not entry.get("target"):
            raise CalibrationError(f"{rid}: mode spec needs a target spec field")
        affected = tuple(entry.get("blocks", ()))
        if not affected:
            raise CalibrationError(f"{rid}: list the blocks it affects")
        if not wanted.intersection(affected):
            continue
        lo, hi = entry.get("bounds") or prior_bounds(record)
        lo_range = record["range"].get("min", -math.inf)
        hi_range = record["range"].get("max", math.inf)
        if not (lo_range <= lo < hi <= hi_range):
            raise CalibrationError(f"{rid}: bounds [{lo:g}, {hi:g}] must lie inside the range and be increasing")
        scale = entry.get("scale", "linear")
        if scale == "log" and lo <= 0:
            raise CalibrationError(f"{rid}: a log-scaled parameter needs positive bounds")
        start = min(max(float(entry.get("start", registry_default(record))), lo), hi)
        out.append(Parameter(rid, mode, tuple(b for b in affected if b in wanted), scale, float(lo), float(hi),
                             float(start), record["units"], entry.get("target"), entry.get("applies_to"),
                             prior_sd(record, scale, (float(lo), float(hi)))))
    return out


def fixed_parameters(config: Mapping[str, Any], records: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """The config's `fixed` entries: parameters reviewed for the calibration and held at their registry
    values (an `id` with a registry record) or at the solver's default (a spec `field`), with the reason."""
    out: dict[str, Any] = {}
    fitted = {e["id"] for e in config.get("parameters") or []}
    for entry in config.get("fixed") or []:
        if entry.get("id") in fitted:
            raise CalibrationError(f"{entry['id']} is both fitted and fixed")
        reason = str(entry.get("reason", "")).strip()
        if not reason:
            raise CalibrationError(f"fixed entry {entry}: give the reason it is not fitted")
        if "id" in entry:
            rid = entry["id"]
            if rid not in records:
                raise CalibrationError(f"fixed parameter {rid!r} has no parameter-registry record")
            out[rid] = {"value": registry_default(records[rid]), "units": records[rid]["units"], "reason": reason}
        elif "field" in entry:
            out[f"spec:{entry['field']}"] = {"value": entry.get("value"), "reason": reason}
        else:
            raise CalibrationError(f"fixed entry {entry}: give an `id` or a spec `field`")
    return out


# -- simulation ----------------------------------------------------------------------


def _simulate_json(spec_json: str) -> dict[str, Any]:
    import puckcore

    try:
        return puckcore.simulate_shot(spec_json)
    except ValueError as exc:
        return {"error": str(exc)}


class Runner:
    """Simulates specs with a result cache (LRU) and, with jobs > 1, a process pool."""

    def __init__(self, simulate: Callable[[dict[str, Any]], dict[str, Any]] | None = None, jobs: int = 1,
                 cache_size: int = 256, *, process_start_method: str | None = None) -> None:
        self._simulate = simulate
        self.jobs = max(1, int(jobs))
        self._cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.cache_size = cache_size
        self._process_start_method = process_start_method
        self._pool: ProcessPoolExecutor | None = None
        self.simulations = 0
        self.warnings: set[str] = set()
        #: Robustness evidence over every simulated shot: the worst value of each solver diagnostic.
        self.diagnostics: dict[str, float] = {}
        self.failed = 0

    def _run_one(self, key: str, spec: dict[str, Any]) -> dict[str, Any]:
        if self._simulate is None:
            return _simulate_json(key)
        try:
            return self._simulate(spec)
        except ValueError as exc:
            return {"error": str(exc)}

    def run(self, specs: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        keys = [json.dumps(s, sort_keys=True, allow_nan=False) for s in specs]
        # this call's results, held locally so that evicting old cache entries cannot lose any of them
        found: dict[str, dict[str, Any]] = {}
        for key in keys:
            if key in self._cache:
                self._cache.move_to_end(key)
                found[key] = self._cache[key]
        unique: dict[str, int] = {}
        for i, key in enumerate(keys):
            if key not in found:
                unique.setdefault(key, i)
        if unique:
            if self.jobs > 1 and self._simulate is None and len(unique) > 1:
                if self._pool is None:
                    if self._process_start_method is None:
                        self._pool = ProcessPoolExecutor(max_workers=self.jobs)
                    else:
                        self._pool = ProcessPoolExecutor(
                            max_workers=self.jobs, mp_context=get_context(self._process_start_method))
                results = list(self._pool.map(_simulate_json, list(unique)))
            else:
                results = [self._run_one(k, specs[i]) for k, i in unique.items()]
            self.simulations += len(unique)
            for key, result in zip(unique, results):
                found[key] = result
                self._cache[key] = result
                for warning in result.get("diagnostics", {}).get("warnings", []):
                    self.warnings.add(warning)
                self._record(result)
        for key in keys:  # least recently used first, in request order
            if key in self._cache:
                self._cache.move_to_end(key)
        while len(self._cache) > self.cache_size:
            self._cache.popitem(last=False)
        return [found[key] for key in keys]

    #: Diagnostics summarised by their largest magnitude, and those summarised by their smallest value.
    WORST_MAX = ("mass_balance_error", "outflow_integral_error", "max_regime_solves", "rejected_steps", "steps")
    WORST_MIN = ("min_concentration_kg_m3",)

    def _record(self, result: Mapping[str, Any]) -> None:
        if "error" in result:
            self.failed += 1
            return
        diagnostics = result.get("diagnostics") or {}
        for name in self.WORST_MAX:
            value = diagnostics.get(name)
            if isinstance(value, (int, float)) and math.isfinite(value):
                self.diagnostics[name] = max(self.diagnostics.get(name, 0.0), abs(float(value)))
        for name in self.WORST_MIN:
            value = diagnostics.get(name)
            if isinstance(value, (int, float)) and math.isfinite(value):
                self.diagnostics[name] = min(self.diagnostics.get(name, math.inf), float(value))

    def robustness(self) -> dict[str, Any]:
        """Worst solver diagnostics over every shot this runner simulated, and the failure count."""
        return {"simulations": self.simulations, "failed": self.failed,
                "worst": {k: self.diagnostics[k] for k in sorted(self.diagnostics)}}

    @property
    def placeholder(self) -> bool:
        """Whether the solver reported itself as a placeholder."""
        return any("placeholder" in w.lower() for w in self.warnings)

    def close(self) -> None:
        if self._pool is not None:
            self._pool.shutdown()
            self._pool = None


# -- residual blocks -------------------------------------------------------------------


@dataclass
class Evaluation:
    residuals: np.ndarray
    labels: list[str]
    observations: list[dict[str, Any]]
    specs: list[dict[str, Any]]
    failures: list[str] = field(default_factory=list)


class DatasetBlock:
    """Residuals of one calibration dataset: cases, observables and their normalisation."""

    def __init__(self, name: str, module: ModuleType, data: Mapping[str, Any], cases: list[Case],
                 options: Mapping[str, Any], units: UnitVocabulary) -> None:
        self.name = name
        self.module = module
        self.data = data
        self.cases = cases
        self.options = dict(options)
        self.weight = float(self.options.get("weight", 1.0))
        self.units = units
        self.residual_fn = _RESIDUALS[module.KEY]
        self.labels = self.residual_fn(self, None, None)[1]

    def spec_for(self, case: Case, values: Mapping[str, float], params: Sequence[Parameter]) -> dict[str, Any]:
        build_values = {p.id: values[p.id] for p in params
                        if p.mode == "override" or (p.mode == "case" and p.id in case.case_parameters)}
        spec = case.build(build_values)
        # structural assumptions set directly in the spec (block option `spec_fields`, for sensitivity runs)
        for path, value in (self.options.get("spec_fields") or {}).items():
            set_path(spec, path, value)
        for p in params:
            if p.mode == "spec" and p.applies(case):
                set_path(spec, p.target, to_spec_units(self.units, values[p.id], p.units, p.target))
        spec["numerics"]["snapshot_count"] = 1  # results stay small; snapshots do not affect the physics
        return spec

    def evaluate(self, values: Mapping[str, float], runner: Runner, params: Sequence[Parameter]) -> Evaluation:
        specs = [self.spec_for(case, values, params) for case in self.cases]
        results = runner.run(specs)
        observations, failures = [], []
        for case, spec, result in zip(self.cases, specs, results):
            if "error" in result:
                observations.append(None)
                failures.append(f"{case.name}: {result['error']}")
                continue
            try:
                obs = observe(self.module, case, result, spec)
            except (ValueError, KeyError, ZeroDivisionError) as exc:
                obs = None
                failures.append(f"{case.name}: {exc}")
            if obs is not None and not required_observations_available(self, case, obs):
                failures.append(f"{case.name}: required fit observations are missing, nonfinite or invalid")
            observations.append(obs)
        r, labels = self.residual_fn(self, observations, values)
        r = np.where(np.isfinite(r), r, FAILED_RESIDUAL)
        return Evaluation(math.sqrt(self.weight) * r, labels, observations, specs, failures)


def observe(module: ModuleType, case: Case, result: Mapping[str, Any], spec: Mapping[str, Any]) -> dict[str, Any]:
    """The module's observables of ``result``; modules whose observables depend on the simulated
    spec (not only on the result) take it as a third argument."""
    if "spec" in inspect.signature(module.observe).parameters:
        return module.observe(case, result, spec)
    return module.observe(case, result)


def required_observations_available(block: DatasetBlock, case: Case, observation: Mapping[str, Any]) -> bool:
    """Availability of the residual's inputs, independent of how closely they match the data."""
    try:
        if block.module.KEY == "schmieder2023":
            values = [observation[kind][analyte] for kind in ("lambda", "c0")
                      for analyte, *_ in block.module.ANALYTES]
            cup = "cup_eq3" if block.options.get("cup", "eq3") == "eq3" else "cup_direct"
            values += [observation[cup][analyte][mass] for analyte, *_ in block.module.ANALYTES
                       for mass in (20, 40, 60)]
            if not all(math.isfinite(value) and value > 0 for value in values):
                return False
            if case.info["experiment"] in (block.options.get("exclude_pressure_experiments") or []):
                return True
            pressure = "peak_pressure_bar" if block.options.get("pressure", "pour") == "max" else "pour_peak_pressure_bar"
            return math.isfinite(observation[pressure])
        field = {"vacaguerra2024": "bodenstein", "waszkiewicz2026": "long_time_flow_g_s",
                 "corrochano2017": "permeability_m2"}[block.module.KEY]
        return math.isfinite(observation[field]) and (observation[field] >= 0 if block.module.KEY == "waszkiewicz2026"
                                                     else observation[field] > 0)
    except (KeyError, TypeError, ValueError):
        return False


def _log_ratio(model: float | None, data: float, sigma: float) -> float:
    if model is None or not (model > 0 and data > 0) or not math.isfinite(model):
        return FAILED_RESIDUAL
    return math.log(model / data) / sigma


def _schmieder_residuals(block: DatasetBlock, observations, values):
    from .cases import schmieder2023 as mod

    targets = mod.targets(block.data)
    floors = {"lambda": 0.03, "c0": 0.03, "cup": 0.02, **block.options.get("relative_floor", {})}
    p_floor = float(block.options.get("pressure_floor_bar", 0.3))
    # "pour": the model's pour-phase maximum (default); "max": its maximum over the whole shot
    pressure = block.options.get("pressure", "pour")
    exit_margin = float(block.options.get("exit_margin_bar", 0.5))
    # sensitivity knobs: the DE1 measures upstream of the puck, so the basket pressure may be lower
    p_scale = float(block.options.get("pressure_scale", 1.0))
    p_offset = float(block.options.get("pressure_offset_bar", 0.0))
    # sensitivity knob: experiments whose peak-pressure residual is left out (a fixed list, e.g. the
    # shots whose pour phase sat at the pump limit in the main fit)
    excluded = {int(e) for e in block.options.get("exclude_pressure_experiments") or []}
    cup_key = "cup_eq3" if block.options.get("cup", "eq3") == "eq3" else "cup_direct"
    r: list[float] = []
    labels: list[str] = []
    for i, case in enumerate(block.cases):
        exp = case.info["experiment"]
        t = targets[exp]
        obs = observations[i] if observations is not None else None
        for analyte, _, _, _ in mod.ANALYTES:
            for kind in ("lambda", "c0"):
                value, se = t[kind][analyte]
                labels.append(f"{block.name}/exp{exp:02d}/{kind}/{analyte}")
                if observations is not None:
                    sigma = max(se / value, floors[kind])
                    r.append(_log_ratio(obs[kind][analyte] if obs else None, value, sigma))
            for m in (20, 40, 60):
                mean, rsd = t["cup"][analyte][m]
                labels.append(f"{block.name}/exp{exp:02d}/cup{m}g/{analyte}")
                if observations is not None:
                    r.append(_log_ratio(obs[cup_key][analyte][m] if obs else None, mean, max(rsd, floors["cup"])))
        measured, rsd = t["pressure_bar"]
        p = measured * p_scale - p_offset
        labels.append(f"{block.name}/exp{exp:02d}/peak_pressure")
        if observations is not None:
            if obs is None:
                r.append(FAILED_RESIDUAL)
            elif exp in excluded:
                r.append(0.0)
            elif pressure == "max":
                r.append((obs["peak_pressure_bar"] - p) / max(rsd * p, p_floor))
            else:
                # the measured maximum is the larger of the transition peak and the pour-phase maximum;
                # the model's transition is not compared. Where the measured maximum is within
                # `exit_margin_bar` of the preinfusion exit pressure, it only bounds the pour phase from above.
                diff = obs["pour_peak_pressure_bar"] - p
                if measured <= mod.PREINFUSION_EXIT_BAR + exit_margin:
                    diff = max(diff, 0.0)
                r.append(diff / max(rsd * p, p_floor))
    return np.array(r, dtype=float), labels


def _vacaguerra_residuals(block: DatasetBlock, observations, values):
    floor = float(block.options.get("bodenstein_floor", 1.0))
    r, labels = [], []
    for i, case in enumerate(block.cases):
        labels.append(f"{block.name}/{case.info['distribution']}_{int(case.info['brewed_g'])}g/bodenstein")
        if observations is not None:
            obs = observations[i]
            if obs is None:
                r.append(FAILED_RESIDUAL)
                continue
            r.append((obs["bodenstein"] - case.info["bodenstein"]) / max(case.info["bodenstein_sd"] or 0.0, floor))
    return np.array(r, dtype=float), labels


def _waszkiewicz_residuals(block: DatasetBlock, observations, values):
    floor = float(block.options.get("flow_floor_g_s", 0.05))
    r, labels = [], []
    for i, case in enumerate(block.cases):
        labels.append(f"{block.name}/p{case.info['group']}/long_time_flow")
        if observations is not None:
            obs = observations[i]
            if obs is None:
                r.append(FAILED_RESIDUAL)
                continue
            row = case.info["longtime"]
            sigma = math.hypot(row["flow_sem_g_s"], floor)
            r.append((obs["long_time_flow_g_s"] - row["flow_g_s"]) / sigma)
    return np.array(r, dtype=float), labels


def _corrochano_residuals(block: DatasetBlock, observations, values):
    floor = float(block.options.get("log_ratio_floor", 0.1))
    by_key = {(c.info["grind"], c.info["density"]): i for i, c in enumerate(block.cases)}
    r, labels = [], []
    for (grind, density), i in sorted(by_key.items()):
        if density == 360.0:
            continue
        j = by_key[(grind, 360.0)]
        labels.append(f"{block.name}/{grind}/{int(density)}_vs_360")
        if observations is None:
            continue
        a, b = observations[i], observations[j]
        d_i, d_j = block.cases[i].info["data"], block.cases[j].info["data"]
        data_ratio = math.log(d_i["permeability_m2"] / d_j["permeability_m2"])
        sigma = max(math.hypot(d_i["permeability_pm_m2"] / d_i["permeability_m2"],
                               d_j["permeability_pm_m2"] / d_j["permeability_m2"]), floor)
        if a is None or b is None or not (a["permeability_m2"] > 0 and b["permeability_m2"] > 0):
            r.append(FAILED_RESIDUAL)
        else:
            r.append((math.log(a["permeability_m2"] / b["permeability_m2"]) - data_ratio) / sigma)
    return np.array(r, dtype=float), labels


_RESIDUALS: dict[str, Callable] = {
    "schmieder2023": _schmieder_residuals,
    "vacaguerra2024": _vacaguerra_residuals,
    "waszkiewicz2026": _waszkiewicz_residuals,
    "corrochano2017": _corrochano_residuals,
}

#: Dataset folders each block's cases and residuals use.
BLOCK_DATASETS: dict[str, tuple[str, ...]] = {
    "schmieder2023": ("schmieder2023-design", "schmieder2023-fractions", "schmieder2023-kinetics",
                      "schmieder2023-replicates"),
    "vacaguerra2024": ("vacaguerra2024-rtd",),
    "waszkiewicz2026": ("waszkiewicz2026-flow-pressure", "waszkiewicz2026-psd"),
    "corrochano2017": ("corrochano2017-permeability", "corrochano2017-psd", "corrochano2017-properties"),
}


def datasets_for_block(block: DatasetBlock) -> tuple[str, ...]:
    """Actual case inputs, including the opt-in measured PSD when V1 uses it."""
    datasets = BLOCK_DATASETS[block.module.KEY]
    if block.module.KEY == "schmieder2023" and any(c.info.get("psd_source") == "wet_cdf" for c in block.cases):
        datasets = (*datasets, block.module.PSD_DATASET)
    return datasets


# -- the problem ---------------------------------------------------------------------------


class Problem:
    """Parameters, residual blocks and a runner; residuals and a block-sparse Jacobian in x space."""

    def __init__(self, params: list[Parameter], blocks: list[Any], runner: Runner, fd_step: float = 0.01) -> None:
        self.params = params
        self.blocks = blocks
        self.runner = runner
        self.fd_step = fd_step
        self.sizes = [len(b.labels) for b in blocks]
        self._cache: dict[tuple, Any] = {}
        self.pruning_review: dict[str, Any] | None = None

    @property
    def labels(self) -> list[str]:
        return [label for b in self.blocks for label in b.labels]

    def x0(self) -> np.ndarray:
        return np.array([p.to_x(p.start) for p in self.params])

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        lo, hi = zip(*(p.x_bounds for p in self.params)) if self.params else ((), ())
        return np.array(lo, dtype=float), np.array(hi, dtype=float)

    def values(self, x: Sequence[float]) -> dict[str, float]:
        return {p.id: p.from_x(float(v)) for p, v in zip(self.params, x)}

    def _block(self, index: int, x: np.ndarray) -> Evaluation:
        key = (index, tuple(np.round(x, 15)))
        if key not in self._cache:
            if len(self._cache) > 64:  # evaluations hold whole observation series: keep only recent ones
                self._cache.clear()
            self._cache[key] = self.blocks[index].evaluate(self.values(x), self.runner, self.params)
        return self._cache[key]

    def evaluations(self, x: Sequence[float]) -> list[Evaluation]:
        x = np.asarray(x, dtype=float)
        return [self._block(i, x) for i in range(len(self.blocks))]

    def residuals(self, x: Sequence[float]) -> np.ndarray:
        parts = [e.residuals for e in self.evaluations(x)]
        return np.concatenate(parts) if parts else np.zeros(0)

    def jacobian(self, x: Sequence[float]) -> np.ndarray:
        x = np.asarray(x, dtype=float)
        base = self.evaluations(x)
        lo, hi = self.bounds()
        offsets = np.cumsum([0, *self.sizes])
        jac = np.zeros((int(offsets[-1]), len(self.params)))
        names = [b.name for b in self.blocks]
        for j, p in enumerate(self.params):
            span = hi[j] - lo[j]
            h = self.fd_step if p.scale == "log" else self.fd_step * span
            if x[j] + h > hi[j]:
                h = -h
            xj = x.copy()
            xj[j] += h
            for name in p.blocks:
                if name not in names:
                    continue
                i = names.index(name)
                diff = (self._block(i, xj).residuals - base[i].residuals) / h
                jac[offsets[i]:offsets[i + 1], j] = diff
        return jac


def uncertainties(problem: Problem, x: np.ndarray, jac: np.ndarray, residuals: np.ndarray) -> dict[str, Any]:
    """Parameter standard errors from the Jacobian (scaled by the reduced chi-square)."""
    m, n = jac.shape
    dof = max(m - n, 1)
    s2 = float(residuals @ residuals) / dof
    if n == 0:
        return {"reduced_chi2": s2, "parameters": {}, "correlation": {"ids": [], "matrix": []}}
    u, s, vt = np.linalg.svd(jac, full_matrices=False)
    tol = (s.max() if s.size else 0.0) * max(m, n) * 1e-10
    inv = np.array([1.0 / v**2 if v > tol else 0.0 for v in s])
    cov = (vt.T * inv) @ vt * s2
    # a parameter is not identified when its column is (numerically) zero or it takes part in a
    # direction of the parameter space that the residuals do not see
    norms = np.linalg.norm(jac, axis=0)
    null = vt[s <= tol] if np.any(s <= tol) else np.zeros((0, n))
    identified = [bool(norms[j] > 1e-8 * max(norms.max(), 1e-300)) and bool(np.all(np.abs(null[:, j]) < 1e-3))
                  for j in range(n)]
    out: dict[str, Any] = {}
    sd_x = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    for j, p in enumerate(problem.params):
        value = p.from_x(x[j])
        entry: dict[str, Any] = {"scale": p.scale, "identified": identified[j]}
        if p.scale == "log":
            entry["sd"] = float(value * math.log(10.0) * sd_x[j])
            entry["interval_68"] = [float(10 ** (x[j] - sd_x[j])), float(10 ** (x[j] + sd_x[j]))]
        else:
            entry["sd"] = float(sd_x[j])
            entry["interval_68"] = [float(value - sd_x[j]), float(value + sd_x[j])]
        if not identified[j]:  # the pseudo-inverse drops the direction: the SD is unbounded, not zero
            entry["sd"] = math.inf
            entry["interval_68"] = [p.lower, p.upper]
        # Local marginal standard error relative to prior spread; this is not a posterior SD.
        entry["prior_sd_ratio"] = ((float(sd_x[j] / p.prior_sd_x) if identified[j] else math.inf)
                                   if p.prior_sd_x else None)
        # the trust-region solver stays strictly inside the box: count 1% of the span as "at" a bound
        tol = AT_BOUND_FRACTION * (p.x_bounds[1] - p.x_bounds[0])
        entry["at_bound"] = bool(x[j] - p.x_bounds[0] < tol or p.x_bounds[1] - x[j] < tol)
        out[p.id] = entry
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = cov / np.outer(sd_x, sd_x)
    corr = np.where(np.isfinite(corr), corr, 0.0)
    return {
        "reduced_chi2": s2,
        "singular_values": [float(v) for v in s],
        "parameters": out,
        "correlation": {"ids": [p.id for p in problem.params],
                        "matrix": [[round(float(v), 4) for v in row] for row in corr]},
    }


@dataclass
class FitResult:
    x: np.ndarray
    residuals: np.ndarray
    jacobian: np.ndarray
    success: bool
    message: str
    nfev: int
    cost: float
    start_cost: float
    status: int | None = None
    optimality: float | None = None
    njev: int | None = None


def fit(problem: Problem, *, max_nfev: int | None = None, loss: str = "linear", verbose: int = 0,
        x0: np.ndarray | None = None) -> FitResult:
    """Least-squares fit of the problem's parameters, starting from their registry values (or ``x0``)."""
    from scipy.optimize import least_squares

    lo, hi = problem.bounds()
    x0 = problem.x0() if x0 is None else np.clip(np.asarray(x0, dtype=float), lo, hi)
    r0 = problem.residuals(x0)
    if not problem.params:
        jac = np.zeros((r0.size, 0))
        return FitResult(x0, r0, jac, True, "no parameters", 1, 0.5 * float(r0 @ r0), 0.5 * float(r0 @ r0))
    result = least_squares(problem.residuals, x0, jac=problem.jacobian, bounds=(lo, hi), method="trf",
                           x_scale="jac", loss=loss, max_nfev=max_nfev, verbose=verbose)
    r = problem.residuals(result.x)
    return FitResult(result.x, r, problem.jacobian(result.x), bool(result.success), str(result.message),
                     int(result.nfev), 0.5 * float(r @ r), 0.5 * float(r0 @ r0),
                     status=int(result.status), optimality=float(result.optimality), njev=int(result.njev))


def optimizer_record(result: FitResult) -> dict[str, Any]:
    """Record termination and first-order optimality separately; xtol is not stationarity."""
    return {"success": result.success, "message": result.message, "evaluations": result.nfev,
            "status": result.status, "jacobian_evaluations": result.njev,
            "optimality": _round(result.optimality) if result.optimality is not None else None}


def apply_start_values(problem: Problem, values: Mapping[str, float]) -> dict[str, float]:
    """Set and record a warm start without silently clipping a different physical value."""
    applied = {}
    for parameter in problem.params:
        if parameter.id not in values:
            continue
        value = float(values[parameter.id])
        if not math.isfinite(value):
            raise CalibrationError(f"warm start {parameter.id}: value must be finite")
        bounded = min(max(value, parameter.lower), parameter.upper)
        if value != bounded and not math.isclose(value, bounded, rel_tol=1e-12, abs_tol=0.0):
            raise CalibrationError(f"warm start {parameter.id}: {value:g} outside [{parameter.lower:g}, {parameter.upper:g}]")
        parameter.start = bounded
        applied[parameter.id] = bounded
    return applied


# -- configuration and building -----------------------------------------------------------


def load_config(path: Path) -> dict[str, Any]:
    config = load_yaml(path)
    if not isinstance(config, Mapping) or config.get("schema") != CONFIG_SCHEMA:
        raise CalibrationError(f"{path}: `schema` must be {CONFIG_SCHEMA!r}")
    for key in ("parameters", "blocks"):
        if key not in config:
            raise CalibrationError(f"{path}: missing `{key}`")
    return dict(config)


def build_problem(
    paths: RepoPaths,
    config: Mapping[str, Any],
    *,
    blocks: Sequence[str] | None = None,
    tier: int | None = None,
    jobs: int = 1,
    simulate: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    module: ModuleType | None = None,
    fd_step: float = 0.01,
    exclude_cases: Sequence[str] = (),
    exclude_cases_by_block: Mapping[str, Sequence[str]] | None = None,
    runner: Runner | None = None,
) -> Problem:
    """The calibration problem of ``config`` (optionally a subset of its blocks and cases)."""
    records = load_registry(paths)
    units = load_units(paths.units)
    names = list(blocks or config["blocks"])
    unknown = [b for b in names if b not in config["blocks"]]
    if unknown:
        raise CalibrationError(f"unknown blocks {unknown}; the config defines {list(config['blocks'])}")
    params = make_parameters(config, records, names)
    fixed_values = {e["id"]: registry_default(records[e["id"]]) for e in config.get("fixed") or []
                    if "id" in e and e["id"] in records}
    # the reference permeability is an output of the calibration, not a fit parameter: every case gets
    # the registry value explicitly, so results never depend on a calibration embedded in puckcore
    if REFERENCE_PERMEABILITY_ID in records and REFERENCE_PERMEABILITY_ID not in {e["id"] for e in config["parameters"]}:
        fixed_values.setdefault(REFERENCE_PERMEABILITY_ID, registry_default(records[REFERENCE_PERMEABILITY_ID]))
    tier = int(config.get("tier", 1) if tier is None else tier)
    n_classes = int(config.get("n_classes", 16))
    built = []
    for name in names:
        options = config["blocks"][name]
        key = options["dataset"]
        if key not in _RESIDUALS:
            raise CalibrationError(f"block {name}: no residuals defined for dataset {key!r}")
        mod = MODULES[key]
        data = mod.load(paths)
        kwargs: dict[str, Any] = {"module": module, **dict(options.get("case_options") or {})}
        if key in ("schmieder2023", "waszkiewicz2026"):
            kwargs.update(tier=tier, n_classes=n_classes)
        excluded = set(exclude_cases)
        excluded.update((exclude_cases_by_block or {}).get(name, ()))
        cases = [c for c in mod.build_cases(data, **kwargs) if c.name not in excluded]
        # fixed parameters at their registry values, so that a calibration embedded in puckcore (an
        # earlier current.yaml) cannot change them; a case's own overrides and the fitted values win
        for case in cases:
            case.recipe["overrides"] = {**fixed_values, **case.recipe.get("overrides", {})}
        built.append(DatasetBlock(name, mod, data, cases, options, units))
    for p in params:
        if p.mode == "case":
            owners = [b for b in built if p.id in getattr(b.module, "CASE_PARAMETERS", ())]
            if not owners:
                raise CalibrationError(f"{p.id}: mode case, but no case builder of {p.blocks} applies it")
    return Problem(params, built, runner or Runner(simulate, jobs), fd_step)


def check_overrides(problem: Problem, module: ModuleType | None = None) -> list[str]:
    """Problems with override parameters: unknown to the registry embedded in puckcore, or not used
    by the builder (no spec field lists ``override:<id>`` in its provenance)."""
    from .cases.common import core

    known = {p["id"] for p in core(module).registry().get("parameters", [])}
    blocks = {b.name: b for b in problem.blocks}
    problems = []
    for p in problem.params:
        if p.mode != "override":
            continue
        if known and p.id not in known:
            problems.append(f"{p.id}: not in the registry embedded in puckcore (re-run the export and rebuild)")
            continue
        used = False
        for name in p.blocks:
            block = blocks.get(name)
            if block is None or not block.cases:
                continue
            recipe = copy.deepcopy(block.cases[0].recipe)
            recipe["overrides"] = {**recipe.get("overrides", {}), p.id: p.start}
            provenance = core(module).build_shot_spec(recipe)["derived"].get("provenance", {})
            used = used or any(f"override:{p.id}" in str(v) for v in provenance.values())
        if not used:
            problems.append(f"{p.id}: the builder does not use this override (no spec field lists it in its provenance)")
    return problems


def check_blocks(problem: Problem, threshold: float = 0.02) -> list[str]:
    """Override parameters that change the residuals of a block they do not declare. Every override
    parameter is applied to every case, but its Jacobian column re-runs only its declared blocks, so an
    undeclared effect would be missed. Perturbs each override parameter by the finite-difference step and
    reports blocks whose normalised residuals move by more than ``threshold`` (RMS)."""
    x = problem.x0()
    base = problem.evaluations(x)
    lo, hi = problem.bounds()
    out = []
    for j, p in enumerate(problem.params):
        if p.mode != "override":
            continue
        h = problem.fd_step if p.scale == "log" else problem.fd_step * (hi[j] - lo[j])
        xj = x.copy()
        xj[j] += h if x[j] + h <= hi[j] else -h
        values = problem.values(xj)
        for i, block in enumerate(problem.blocks):
            if block.name in p.blocks:
                continue
            moved = block.evaluate(values, problem.runner, problem.params).residuals - base[i].residuals
            rms = float(np.sqrt(np.mean(moved**2))) if moved.size else 0.0
            if rms > threshold:
                out.append(f"{p.id}: changes block {block.name} (RMS {rms:.3g} per step) but does not list it")
    return out


def prune(paths: RepoPaths, config: Mapping[str, Any], problem: Problem, result: FitResult, *,
          threshold: float = WEAK_IDENTIFICATION_RATIO, tier: int | None = None, fd_step: float = 0.01,
          max_nfev: int | None = None, loss: str = "linear",
          verbose: int = 0,
          progress: Callable[[dict[str, Any], Problem, FitResult, dict[str, Any]], None] | None = None,
          ) -> tuple[dict[str, Any], Problem, FitResult, dict[str, Any]]:
    """Review weak interior shared parameters by bounded refits at their registry values.

    A large local marginal SD nominates a candidate; it does not establish that the registry value
    is interchangeable with its fitted value. Remove a candidate only when its refit succeeds, is
    finite, has no unavailable final observations, and increases weighted squared-residual cost by
    at most 1% of BOTH the initial pre-prune fit and the current accepted fit. This is an operational
    safeguard, not a significance threshold. Bound-flagged, nuisance and case parameters are kept.
    Each candidate is attempted once; a rejected local refit is retained conservatively, without
    claiming that the coefficient is necessary or that either optimizer found a global minimum.

    ``problem.pruning_review`` records every accepted/rejected trial and is serialized by
    ``calibration_document``. ``progress`` runs after every review, with the current accepted state.
    The return tuple remains config, problem, result, and accepted fixed parameters.
    """
    if not math.isfinite(result.cost) or result.cost < 0:
        raise CalibrationError("pruning requires a finite nonnegative baseline training cost")
    records = load_registry(paths)
    config = copy.deepcopy(dict(config))
    pruned: dict[str, Any] = {}
    attempted: set[str] = set()
    review: dict[str, Any] = {
        "method": "bounded registry-value refit with a training-cost safeguard",
        "sd_ratio_threshold": threshold, "relative_cost_tolerance": PRUNING_COST_TOLERANCE,
        "criterion": "operational tolerance, not a significance or confidence threshold",
        "cost": "weighted squared-residual cost, 0.5 * ||r||^2",
        "cost_references": ["initial_pre_prune", "current_accepted"],
        "initial_cost": float(result.cost), "loss": loss,
        "refitted_blocks": [b.name for b in problem.blocks],
        "retry_policy": "Each candidate is attempted once; rejected local refits are retained conservatively.",
        "attempts": [], "accepted_parameters": [], "retained_parameters": [],
    }
    problem.pruning_review = review
    while True:
        unc = uncertainties(problem, result.x, result.jacobian, result.residuals)["parameters"]
        candidates = []
        for p in problem.params:
            entry = unc[p.id]
            ratio = math.inf if not entry["identified"] else entry.get("prior_sd_ratio")
            if (p.mode == "override" and p.id not in attempted and ratio is not None
                    and not entry["at_bound"] and ratio >= threshold):
                candidates.append((ratio, p.id))
        if not candidates:
            return config, problem, result, pruned
        ratio, worst = max(candidates)
        attempted.add(worst)
        values = problem.values(result.x)
        registry_value = registry_default(records[worst])
        reason = (f"Pruned by the identifiability rule after a bounded registry-value refit: local marginal "
                  f"SD {ratio:.2f}× the prior's (fitted value {values[worst]:.4g}); training cost stayed within "
                  "1% of both the initial pre-prune and current accepted fits.")
        trial_config = copy.deepcopy(config)
        trial_config["parameters"] = [e for e in trial_config["parameters"] if e["id"] != worst]
        trial_config["fixed"] = [*(trial_config.get("fixed") or []), {"id": worst, "reason": reason}]
        trial = build_problem(paths, trial_config, blocks=[b.name for b in problem.blocks], tier=tier,
                              fd_step=fd_step, runner=problem.runner)
        apply_start_values(trial, values)
        trial_result = fit(trial, max_nfev=max_nfev, loss=loss, verbose=verbose)
        finite = (math.isfinite(trial_result.cost) and trial_result.cost >= 0
                  and bool(np.all(np.isfinite(trial_result.x)))
                  and bool(np.all(np.isfinite(trial_result.residuals)))
                  and bool(np.all(np.isfinite(trial_result.jacobian))))
        failures = ([failure for ev in trial.evaluations(trial_result.x) for failure in ev.failures]
                    if finite else None)
        current_limit = result.cost * (1.0 + PRUNING_COST_TOLERANCE)
        initial_limit = review["initial_cost"] * (1.0 + PRUNING_COST_TOLERANCE)
        reasons = []
        if not trial_result.success:
            reasons.append("optimizer_not_converged")
        if not finite:
            reasons.append("nonfinite_trial")
        elif failures:
            reasons.append("final_predictions_unavailable")
        if finite and trial_result.cost > current_limit:
            reasons.append("current_cost_limit_exceeded")
        if finite and trial_result.cost > initial_limit:
            reasons.append("initial_cost_limit_exceeded")
        accepted = not reasons
        attempt = {
            "parameter": worst, "fitted_value": values[worst], "registry_value": registry_value,
            "marginal_uncertainty": copy.deepcopy(unc[worst]),
            "baseline_cost": float(result.cost), "initial_cost": review["initial_cost"],
            "current_cost_limit": float(current_limit), "initial_cost_limit": float(initial_limit),
            "trial_cost": float(trial_result.cost),
            "cost_increase": float(trial_result.cost - result.cost),
            "relative_cost_increase": (float(trial_result.cost / result.cost - 1.0) if result.cost else None),
            "optimizer": optimizer_record(trial_result), "finite": finite, "final_failures": failures,
            "trial_fitted_values": trial.values(trial_result.x) if finite else None,
            "accepted": accepted, "decision": "accepted" if accepted else "retained",
            "reasons": reasons,
        }
        review["attempts"].append(attempt)
        if accepted:
            review["accepted_parameters"].append(worst)
            pruned[worst] = {"value": registry_value, "units": records[worst]["units"], "reason": reason}
            config, problem, result = trial_config, trial, trial_result
            problem.pruning_review = review
        else:
            review["retained_parameters"].append(worst)
        if progress:
            progress(config, problem, result, pruned)


# -- leave one condition out (V1) ------------------------------------------------------------------

LOO_TOLERANCE = 0.15


def leave_one_out(paths: RepoPaths, config: Mapping[str, Any], start: Mapping[str, float], *,
                  tier: int | None = None, jobs: int = 1, max_nfev: int | None = None, fd_step: float = 0.01,
                  simulate: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
                  block: str = "V1", refit_blocks: Sequence[str] | None = None,
                  loo_jobs: int = 1, loss: str = "linear",
                  progress: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Refit all selected calibration blocks while omitting one V1 condition in each fold.

    Every fitted parameter, including shared parameters, is re-estimated from the retained residuals.
    Other blocks retain all their cases. The supplied parameter/fixed structure is preserved: pruning
    is not repeated within folds, so this is conditional cross-validation, not nested model selection.
    Full-fit values in ``start`` initialize each optimizer and are recorded, not held fixed. An explicit
    ``refit_blocks`` preserves the main fit's block selection; the default uses all configured blocks.
    ``loo_jobs`` bounds concurrent folds, each with ``jobs`` simulation processes; the default
    retains the serial runner and cache. Concurrent folds own their runners and mutable inputs,
    and use spawned processes so no process forks from a fold thread. Progress callbacks run
    only on the calling thread, and reported experiments retain their original case order.
    A custom ``simulate`` callback must be thread-safe when ``loo_jobs`` is greater than one.
    """
    from .cases import schmieder2023

    if not isinstance(loo_jobs, int) or isinstance(loo_jobs, bool) or loo_jobs < 1:
        raise CalibrationError("leave_one_out loo_jobs must be a positive integer")
    selected = list(config["blocks"] if refit_blocks is None else refit_blocks)
    if block not in selected:
        raise CalibrationError(f"leave_one_out requires {block} among the refitted blocks")
    if len(selected) != len(set(selected)):
        raise CalibrationError("leave_one_out refitted blocks must not be duplicated")
    full = build_problem(paths, config, blocks=selected, tier=tier, jobs=jobs, simulate=simulate, fd_step=fd_step)
    v1 = next(b for b in full.blocks if b.name == block)
    scope = {
        "block": block, "tolerance": LOO_TOLERANCE, "refitted_blocks": selected,
        "loo_jobs": loo_jobs, "jobs_per_fold": full.runner.jobs, "loss": loss,
        "refitted_parameters": [p.id for p in full.params], "held": {},
        "conditional_on_fixed_structure": True,
        "structure_selection": "Supplied parameter/fixed structure; pruning is not repeated within folds.",
        "warm_start": "Full-fit values supplied in start; all fitted parameters are re-estimated.",
        "fixed": copy.deepcopy(config.get("fixed") or []),
    }
    experiments: dict[str, Any] = {}
    experiment_order = [f"exp{case.info['experiment']:02d}" for case in v1.cases]

    def refit_case(fold_config: Mapping[str, Any], fold_start: Mapping[str, float],
                  context: Problem, case: Case) -> tuple[str, dict[str, Any]]:
        fold_block = next(b for b in context.blocks if b.name == block)
        targets = schmieder2023.targets(fold_block.data)
        excluded = {block: [case.name]}
        sub = build_problem(paths, fold_config, blocks=selected, tier=tier, fd_step=fd_step,
                            exclude_cases_by_block=excluded, runner=context.runner)
        apply_start_values(sub, fold_start)
        start_values = sub.values(sub.x0())
        result = fit(sub, max_nfev=max_nfev, loss=loss)
        values = sub.values(result.x)
        prediction = DatasetBlock(fold_block.name, fold_block.module, fold_block.data, [case],
                                  fold_block.options, fold_block.units)
        prediction_ev = prediction.evaluate(values, context.runner, context.params)
        obs = prediction_ev.observations[0]
        predicted = obs is not None and required_observations_available(fold_block, case, obs)
        exp = case.info["experiment"]
        t = targets[exp]
        errors: dict[str, Any] = {"lambda": {}, "cup": {}}
        for analyte, _, _, _ in schmieder2023.ANALYTES:
            lam = obs["lambda"][analyte] if predicted else math.nan
            errors["lambda"][analyte] = _round(lam / t["lambda"][analyte][0] - 1.0) if predicted else None
            errors["cup"][analyte] = {
                m: (_round(obs["cup_eq3"][analyte][m] / t["cup"][analyte][m][0] - 1.0) if predicted else None)
                for m in (20, 40, 60)}
        return f"exp{exp:02d}", {
            "errors": errors, "cost": _round(result.cost), "evaluations": result.nfev,
            "optimizer": optimizer_record(result), "predicted": predicted,
            "fitted_values": _rounded(values), "start_values": _rounded(start_values),
            "refitted_blocks": list(selected), "excluded_cases": excluded,
            "refit_cases": {b.name: len(b.cases) for b in sub.blocks},
            "prediction_failures": prediction_ev.failures,
            "refit_failures": [failure for ev in sub.evaluations(result.x) for failure in ev.failures]}

    def isolated_fold(case_name: str) -> tuple[str, dict[str, Any]]:
        # Rebuild instead of copying a Problem: its runner, evaluation cache, parameters, cases,
        # loaded data and units must all belong to this fold. Only read-only modules are shared.
        fold_config, fold_start = copy.deepcopy(dict(config)), dict(start)
        runner = Runner(simulate, jobs, process_start_method="spawn")
        try:
            context = build_problem(paths, fold_config, blocks=selected, tier=tier, fd_step=fd_step,
                                    runner=runner)
            fold_block = next(b for b in context.blocks if b.name == block)
            case = next(c for c in fold_block.cases if c.name == case_name)
            return refit_case(fold_config, fold_start, context, case)
        finally:
            runner.close()

    def record(completed: tuple[str, dict[str, Any]]) -> None:
        key, entry = completed
        experiments[key] = entry
        if progress:
            ordered = {name: experiments[name] for name in experiment_order if name in experiments}
            progress({**copy.deepcopy(scope), "experiments": copy.deepcopy(ordered),
                      "completed": len(experiments), "required": len(v1.cases)})

    try:
        if loo_jobs == 1:
            for case in v1.cases:
                record(refit_case(config, start, full, case))
        elif v1.cases:
            with ThreadPoolExecutor(max_workers=min(loo_jobs, len(v1.cases)),
                                    thread_name_prefix="puckworks-loo") as executor:
                futures = [executor.submit(isolated_fold, case.name) for case in v1.cases]
                try:
                    for future in as_completed(futures):
                        record(future.result())
                finally:
                    # On a failed fold or checkpoint, cancel work not yet started. Running folds
                    # still close their own runners before the executor finishes shutting down.
                    for future in futures:
                        future.cancel()
    finally:
        full.runner.close()
    experiments = {name: experiments[name] for name in experiment_order}
    lam_errors = [e for x in experiments.values() for e in x["errors"]["lambda"].values()]
    cup_errors = [e for x in experiments.values() for a in x["errors"]["cup"].values() for e in a.values()]

    def within(errors: list[float | None]) -> int:
        return sum(1 for e in errors if e is not None and abs(e) <= LOO_TOLERANCE)

    return {**scope, "experiments": experiments,
            "lambda_within": within(lam_errors), "lambda_total": len(lam_errors),
            "cup_within": within(cup_errors), "cup_total": len(cup_errors),
            "completed": len(experiments), "required": len(v1.cases),
            "all_optimizers_converged": all(v["optimizer"]["success"] for v in experiments.values()),
            "all_predictions_available": all(v["predicted"] and not v["refit_failures"] for v in experiments.values())}


# -- documents -----------------------------------------------------------------------------


#: Sensitivity variants (``calibrate --sensitivity``): changes to the options of the listed blocks, whose
#: own parameters are refitted. ``structural`` variants change a model assumption (reported with the
#: held-out predictions it implies), the others a case assumption.
SENSITIVITY_VARIANTS: dict[str, dict[str, Any]] = {
    "transition ramp 1 s": {"blocks": ["V1"], "options": {"case_options": {"transition_ramp_s": 1.0}}},
    "transition ramp 0.3 s": {"blocks": ["V1"], "options": {"case_options": {"transition_ramp_s": 0.3}}},
    "upstream pressure loss 0.4 bar": {"blocks": ["V1"], "options": {"pressure_offset_bar": 0.4}},
    "whole-shot peak pressure": {"blocks": ["V1"], "options": {"pressure": "max"}},
    "pressure classification margin 1 bar": {"blocks": ["V1"], "options": {"exit_margin_bar": 1.0}},
    # "capped" is replaced by the experiments whose pour sat at the pump limit in the main fit
    "pump-capped pour pressures excluded": {"blocks": ["V1"], "options": {"exclude_pressure_experiments": "capped"}},
    "wet PSD D32 minus 1 SD": {"blocks": ["V1"], "options": {"case_options": {
        "psd_source": "wet_cdf", "sauter_offset_sd": -1.0}}},
    "wet PSD D32 plus 1 SD": {"blocks": ["V1"], "options": {"case_options": {
        "psd_source": "wet_cdf", "sauter_offset_sd": 1.0}}},
    # a structural assumption changes every shot: recalibrate every block, nothing held
    "dissolution share θ = 0.27 (old proportional rule)": {
        "blocks": ["V1", "V2", "V4", "V6"], "structural": True,
        "options": {"spec_fields": {"hydraulics.dissolution_porosity_share": 0.27}}},
}


def pump_summary(block: Any, observations: Sequence[Mapping[str, Any] | None]) -> dict[str, Any] | None:
    """For the V1 (Schmieder) block: seconds each shot spent at the pump's pressure limit in the
    transition and in the pour, and the shots whose pour phase reached the limit."""
    if getattr(block.module, "KEY", None) != "schmieder2023":
        return None
    transition, pour, capped = {}, {}, []
    for case, obs in zip(block.cases, observations):
        if not obs:
            continue
        exp = int(case.info["experiment"])
        limit = obs.get("pump_limit_s") or {}
        transition[exp] = round(float(limit.get("transition", 0.0)), 2)
        pour[exp] = round(float(limit.get("pour", 0.0)), 2)
        if obs.get("pour_capped"):
            capped.append(exp)
    return {"transition_s": transition, "pour_s": pour, "pour_capped": capped}


def resolve_variants(variants: Mapping[str, Mapping[str, Any]], capped: Sequence[int]) -> dict[str, dict[str, Any]]:
    """Variants with the placeholder "capped" replaced by the main fit's pump-capped experiments."""
    out = {}
    for name, variant in variants.items():
        variant = copy.deepcopy(dict(variant))
        options = variant.get("options", {})
        if options.get("exclude_pressure_experiments") == "capped":
            options["exclude_pressure_experiments"] = sorted(int(e) for e in capped)
        out[name] = variant
    return out


def _merge_options(options: Mapping[str, Any], change: Mapping[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(dict(options))
    for key, value in change.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), Mapping):
            out[key] = {**out[key], **value}
        else:
            out[key] = value
    return out


def sensitivity(paths: RepoPaths, config: Mapping[str, Any], start: Mapping[str, float],
                reference: Mapping[str, Any] | None, *, tier: int | None = None, jobs: int = 1,
                max_nfev: int | None = None, fd_step: float = 0.01,
                variants: Mapping[str, Mapping[str, Any]] | None = None,
                module: ModuleType | None = None,
                progress: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Refits, under each variant, the parameters the config lists for the variant's blocks alone (the
    variant's option changes applied to each of those blocks; parameters shared with other blocks held at
    their full-fit values in ``start``). Reports the refitted values, the reference
    permeability estimates (datasets not refitted keep their full-fit estimates) and their pooled value,
    and for V1 the cost, the peak-pressure residuals and the target counts."""
    from .cases import schmieder2023

    variants = SENSITIVITY_VARIANTS if variants is None else variants
    datasets = dict((reference or {}).get("datasets") or {})
    out: dict[str, Any] = {}
    runner = Runner(jobs=jobs)
    try:
        for name, variant in variants.items():
            blocks = list(variant.get("blocks", ["V1"]))
            own = {e["id"] for e in config["parameters"] if set(e.get("blocks", ())) <= set(blocks)}
            cfg = copy.deepcopy({**config, "parameters": [e for e in config["parameters"] if e["id"] in own]})
            for b in blocks:
                cfg["blocks"][b] = _merge_options(cfg["blocks"][b], variant.get("options", {}))
            full = build_problem(paths, config, blocks=blocks, tier=tier, fd_step=fd_step, runner=runner, module=module)
            held = {p.id: start.get(p.id, p.start) for p in full.params if p.id not in own}
            if any(p.mode != "override" for p in full.params if p.id in held):
                raise CalibrationError("sensitivity holds shared parameters as recipe overrides; they must be override mode")
            sub = build_problem(paths, cfg, blocks=blocks, tier=tier, fd_step=fd_step, runner=runner, module=module)
            for block in sub.blocks:
                for c in block.cases:
                    c.recipe["overrides"] = {**c.recipe.get("overrides", {}), **held}
            apply_start_values(sub, start)
            result = fit(sub, max_nfev=max_nfev)
            unc = uncertainties(sub, result.x, result.jacobian, result.residuals)
            ref = reference_permeability(sub, result.x, unc, module) or {}
            values = sub.values(result.x)
            estimates = {**datasets, **(ref.get("datasets") or {})}
            pooled = math.exp(sum(math.log(v) for v in estimates.values()) / len(estimates)) if estimates else None
            entry: dict[str, Any] = {
                "blocks": blocks, "options": copy.deepcopy(dict(variant.get("options", {}))),
                "structural": bool(variant.get("structural", False)), "held": dict(held), "cost": result.cost,
                "optimizer": optimizer_record(result),
                "nuisance": {p.id: values[p.id] for p in sub.params if p.mode == "spec"},
                "shared": {p.id: values[p.id] for p in sub.params if p.mode != "spec"},
                "kappa_ref_by_dataset": estimates,
                "schmieder_kappa_ref_m2": estimates.get("schmieder2023"),
                "pooled_kappa_ref_m2": pooled,
                "failures": [failure for ev in sub.evaluations(result.x) for failure in ev.failures],
            }
            names = [b.name for b in sub.blocks]
            if "V1" in names:
                i = names.index("V1")
                v1 = sub.blocks[i]
                ev = sub.evaluations(result.x)[i]
                targets = schmieder2023.targets(v1.data)
                entry["pressures"] = [{"experiment": c.info["experiment"],
                                       "data_bar": targets[c.info["experiment"]]["pressure_bar"][0],
                                       "pour_bar": o["pour_peak_pressure_bar"] if o else None,
                                       "shot_bar": o["peak_pressure_bar"] if o else None}
                                      for c, o in zip(v1.cases, ev.observations)]
                within = {"lambda": 0, "cup": 0}
                for c, o in zip(v1.cases, ev.observations):
                    t = targets[c.info["experiment"]]
                    for analyte, _, _, _ in schmieder2023.ANALYTES:
                        if o and abs(o["lambda"][analyte] / t["lambda"][analyte][0] - 1.0) <= 0.10:
                            within["lambda"] += 1
                        within["cup"] += sum(1 for m in (20, 40, 60)
                                             if o and abs(o["cup_eq3"][analyte][m] / t["cup"][analyte][m][0] - 1.0) <= 0.10)
                offsets = np.cumsum([0, *sub.sizes])
                labels = sub.labels[offsets[i]:offsets[i + 1]]
                r = result.residuals[offsets[i]:offsets[i + 1]]
                rows = [k for k, label in enumerate(labels) if label.endswith("peak_pressure")]
                entry.update({"v1_cost": 0.5 * float(r @ r),
                              "pressure_rms": float(np.sqrt(np.mean(r[rows] ** 2))) if rows else None,
                              "lambda_within": within["lambda"], "cup_within": within["cup"],
                              "pump": pump_summary(v1, ev.observations)})
            out[name] = entry
            if progress:
                progress({"reference_datasets": datasets, "variants": copy.deepcopy(out),
                          "completed": len(out), "required": len(variants)})
    finally:
        runner.close()
    return {"reference_datasets": datasets, "variants": out, "completed": len(out), "required": len(variants),
            "all_optimizers_converged": all(v["optimizer"]["success"] for v in out.values()),
            "all_predictions_available": all(not v["failures"] for v in out.values())}


def _round(value: float) -> float:
    return float(f"{value:.6g}")


#: Registry id of the input models' bare base permeability at the reference Sauter diameter.
REFERENCE_PERMEABILITY_ID = "hydraulics.permeability.reference"
#: Ids the builder may read for the base permeability, newest first.
BASE_PERMEABILITY_IDS = (REFERENCE_PERMEABILITY_ID, "hydraulics.permeability.in_shot")


def base_permeability_id(recipe: Mapping[str, Any], module: ModuleType | None = None) -> str:
    """The registry id the builder reads for κ₀, from the provenance of hydraulics.permeability_m2."""
    from .cases.common import core

    provenance = core(module).build_shot_spec(dict(recipe))["derived"].get("provenance", {})
    source = str(provenance.get("hydraulics.permeability_m2", ""))
    for rid in BASE_PERMEABILITY_IDS:
        if rid in source:
            return rid
    raise CalibrationError(f"cannot tell which registry id the builder reads for κ₀ (provenance: {source!r})")


def scaling_basis(case: Case) -> tuple[dict[str, Any], str]:
    """The recipe whose builder scaling maps a case's fitted κ₀ to the reference permeability, and a
    description. It is the app's representation of the case's grind: a grinder preset at the paper's
    setting where the case module defines ``scaling_recipe`` (Schmieder's E65S), else the case's own PSD
    (a measured distribution, entered in the app as a manual PSD)."""
    module = MODULES.get(case.dataset)
    hook = getattr(module, "scaling_recipe", None)
    if hook is not None:
        return hook(case)
    return case.recipe, "the case's own PSD"


def builder_scaling(case: Case, module: ModuleType | None = None) -> tuple[float, str]:
    """The builder's scaling of the base permeability for the case's scaling recipe (``scaling_basis``),
    κ₀ = scaling·κ_base, measured by building that recipe with two values of the base id (it must be
    proportional), and the id it reads. The scaling is (D32/D32_ref)²·KC(ε)/KC(ε_ref) with the D32 the
    builder makes of that recipe."""
    from .cases.common import core

    base, _ = scaling_basis(case)
    rid = base_permeability_id(base, module)
    out = []
    for probe in (1.0e-14, 3.0e-14):
        recipe = copy.deepcopy(base)
        recipe["overrides"] = {**recipe.get("overrides", {}), rid: probe}
        out.append(core(module).build_shot_spec(recipe)["spec"]["hydraulics"]["permeability_m2"] / probe)
    if not math.isclose(out[0], out[1], rel_tol=1e-9):
        raise CalibrationError(f"{case.name}: the builder's κ₀ is not proportional to {rid}")
    return out[0], rid


def reference_permeability(problem: Problem, x: np.ndarray, unc: Mapping[str, Any],
                           module: ModuleType | None = None) -> dict[str, Any] | None:
    """Pools the fitted nuisance permeabilities into the app's reference permeability.

    Each spec-mode parameter that sets ``hydraulics.permeability_m2`` is a bare κ₀ for its cases.
    Dividing it by the builder's scaling for those cases (their own built D32) gives one estimate
    κ_ref,i. Estimates are combined by geometric mean, first within a dataset (its groups, e.g.
    grinding levels) and then across datasets with equal weight; the spread is reported as the
    log-SD over all estimates and as the max/min ratio.
    """
    values = problem.values(x)
    estimates = []
    for p in problem.params:
        if p.mode != "spec" or p.target != "hydraulics.permeability_m2":
            continue
        cases = [c for b in problem.blocks for c in b.cases if p.applies(c)]
        if not cases:
            continue
        scalings = [builder_scaling(c, module) for c in cases]
        logs = [math.log(sc) for sc, _ in scalings]
        scaling = math.exp(sum(logs) / len(logs))
        kappa0 = values[p.id]
        entry = unc.get("parameters", {}).get(p.id, {})
        sd_log = entry.get("sd", math.nan) / kappa0 if kappa0 > 0 and entry.get("identified") else math.nan
        estimates.append({
            "parameter": p.id,
            "dataset": cases[0].dataset,
            "scaling_basis": scaling_basis(cases[0])[1],
            "cases": len(cases),
            "kappa0_m2": kappa0,
            "kappa0_sd_log": sd_log,
            "builder_scaling": scaling,
            "builder_scaling_spread": max(logs) - min(logs),
            "sauter_ratio": math.sqrt(scaling),
            "base_id_read_by_builder": scalings[0][1],
            "kappa_ref_m2": kappa0 / scaling,
        })
    if not estimates:
        return None
    by_dataset: dict[str, list[float]] = {}
    for e in estimates:
        by_dataset.setdefault(e["dataset"], []).append(math.log(e["kappa_ref_m2"]))
    dataset_logs = {d: sum(v) / len(v) for d, v in by_dataset.items()}
    pooled = math.exp(sum(dataset_logs.values()) / len(dataset_logs))
    all_logs = [math.log(e["kappa_ref_m2"]) for e in estimates]
    mean = sum(all_logs) / len(all_logs)
    sd = (sum((v - mean) ** 2 for v in all_logs) / (len(all_logs) - 1)) ** 0.5 if len(all_logs) > 1 else math.nan
    return {
        "id": REFERENCE_PERMEABILITY_ID,
        "value_m2": pooled,
        "pooling": ("geometric mean over datasets, each dataset the geometric mean of its estimates; estimate i = "
                    "fitted bare κ₀,i / builder scaling of case i, (D32_i/D32_ref)²·KC(ε)/KC(ε_ref)"),
        "datasets": {d: math.exp(v) for d, v in dataset_logs.items()},
        "estimates": estimates,
        "log_sd": sd,
        "max_over_min": math.exp(max(all_logs) - min(all_logs)),
    }


def repool(paths: RepoPaths, doc: Mapping[str, Any], config: Mapping[str, Any],
           module: ModuleType | None = None) -> dict[str, Any]:
    """The calibration document with ``hydraulics.permeability.reference`` recomputed by the current
    builder, without refitting: the fitted bare κ₀ of ``fit.nuisance`` divided by the builder scaling
    of each case's scaling recipe (for example after a change of the grinder models)."""
    from .cases.common import core

    nuisance = (doc.get("fit") or {}).get("nuisance") or {}
    wanted = [name for name in config["blocks"]
              if any(e.get("target") == "hydraulics.permeability_m2" and name in e.get("blocks", ())
                     and e["id"] in nuisance for e in config["parameters"])]
    if not wanted:
        raise CalibrationError("the calibration file has no fitted nuisance permeabilities to pool")
    problem = build_problem(paths, config, blocks=wanted, module=module)
    try:
        values = calibrated_values(doc)
        x = np.array([p.to_x(min(max(values.get(p.id, p.start), p.lower), p.upper)) for p in problem.params])
        unc = {"parameters": (doc.get("fit") or {}).get("uncertainties") or {}}
        reference = reference_permeability(problem, x, unc, module)
    finally:
        problem.runner.close()
    out = copy.deepcopy(dict(doc))
    previous = (out.get("parameters") or {}).get(REFERENCE_PERMEABILITY_ID)
    out.setdefault("parameters", {})[REFERENCE_PERMEABILITY_ID] = _round(reference["value_m2"])
    entry = _rounded(reference)
    entry["repooled"] = {"date": datetime.date.today().isoformat(), "core_version": core(module).__version__,
                         "previous_m2": previous}
    out.setdefault("fit", {})["reference_permeability"] = entry
    return out


def _rounded(value: Any) -> Any:
    if isinstance(value, float):
        return _round(value) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _rounded(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_rounded(v) for v in value]
    return value


def calibration_document(problem: Problem, result: FitResult, *, label: str, config_path: str | None,
                         core_version: str, module: ModuleType | None = None,
                         fixed: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The ``puckworks.calibration/1`` document of a fit.

    ``parameters`` holds only what the app's builder reads: the override parameters (registry ids the
    builder maps to spec fields) and the pooled reference permeability. Setup-specific (spec mode)
    values go to ``fit.nuisance`` and case-builder values to ``fit.case_parameters``, so the export never
    embeds a value the builder would ignore.
    """
    evals = problem.evaluations(result.x)
    unc = uncertainties(problem, result.x, result.jacobian, result.residuals)
    blocks = {}
    for block, ev in zip(problem.blocks, evals):
        rr = ev.residuals
        blocks[block.name] = {
            "dataset": block.module.KEY,
            "datasets": list(datasets_for_block(block)),
            "cases": len(block.cases),
            "residuals": int(rr.size),
            "rms": _round(float(np.sqrt(np.mean(rr**2)))) if rr.size else 0.0,
            "chi2": _round(float(rr @ rr)),
            "chi2_per_residual": _round(float(rr @ rr) / rr.size) if rr.size else None,
            "weight": block.weight,
            "failures": ev.failures,
        }
        pump = pump_summary(block, ev.observations)
        if pump is not None:
            blocks[block.name]["pump_limited"] = pump
    values = problem.values(result.x)
    residuals = {label: _round(float(v)) for label, v in zip(problem.labels, result.residuals)}
    weak = [p.id for p in problem.params
            if (unc["parameters"][p.id].get("prior_sd_ratio") or 0.0) >= WEAK_IDENTIFICATION_RATIO]
    reference = reference_permeability(problem, result.x, unc, module)
    parameters = {p.id: _round(values[p.id]) for p in problem.params if p.mode == "override"}
    if reference is not None:
        parameters[REFERENCE_PERMEABILITY_ID] = _round(reference["value_m2"])
    from .identity import solver_identity
    from .paths import find_repo_root

    try:
        solver = solver_identity(RepoPaths(find_repo_root()), module)
    except Exception:  # noqa: BLE001 - identity is informative only
        solver = None
    try:
        from .identity import input_hashes

        inputs = input_hashes(RepoPaths(find_repo_root()), config_path,
                              sorted({d for b in problem.blocks for d in datasets_for_block(b)}))
    except Exception:  # noqa: BLE001 - informative only
        inputs = None
    fit: dict[str, Any] = {
        "datasets": sorted({d for b in problem.blocks for d in datasets_for_block(b)}),
        "config": config_path,
        "solver": solver,
        "inputs": inputs,
        "optimizer": {"method": "scipy.optimize.least_squares (trf, x_scale=jac)", **optimizer_record(result),
                      "simulations": problem.runner.simulations,
                      "start_cost": _round(result.start_cost), "cost": _round(result.cost)},
        "nuisance": {p.id: _round(values[p.id]) for p in problem.params if p.mode == "spec"},
        "case_parameters": {p.id: _round(values[p.id]) for p in problem.params if p.mode == "case"},
        "reference_permeability": _rounded(reference) if reference is not None else None,
        "fixed": _rounded(dict(fixed or {})),
        "weakly_identified": weak,
        "start": {p.id: _round(p.start) for p in problem.params},
        "bounds": {p.id: [_round(p.lower), _round(p.upper)] for p in problem.params},
        "modes": {p.id: p.mode for p in problem.params},
        "blocks": blocks,
        "uncertainties": {pid: _rounded(entry) for pid, entry in unc["parameters"].items()},
        "reduced_chi2": _round(unc["reduced_chi2"]),
        "correlation": unc["correlation"],
        "residuals": residuals,
        "solver_warnings": sorted(problem.runner.warnings),
        "robustness": _rounded(problem.runner.robustness()),
    }
    if problem.pruning_review is not None:
        fit["pruning_review"] = _rounded(problem.pruning_review)
    return {
        "schema": CALIBRATION_SCHEMA,
        "label": label,
        "created": datetime.date.today().isoformat(),
        "core_version": core_version,
        "tools_version": __version__,
        "parameters": parameters,
        "fit": fit,
    }


def dump_document(doc: Mapping[str, Any]) -> str:
    header = (
        "# SPDX-License-Identifier: GPL-2.0-or-later\n"
        "# Written by `puckworks-tools calibrate` (python/puckworks_tools/calibrate.py); do not edit by hand.\n"
        "# Format: docs/validation/calibration.md. `parameters` are in the parameter registry's units.\n"
    )
    return header + yaml.safe_dump(dict(doc), sort_keys=False, allow_unicode=True, width=110)


def write_documents(doc: Mapping[str, Any], out_dir: Path, *, label: str, current: bool = True) -> list[Path]:
    import tempfile

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    text = dump_document(doc)
    written = [out_dir / f"{label}.yaml"]
    if current:
        written.append(out_dir / "current.yaml")
    for path in written:
        # Each checkpoint survives interruption as either the previous complete file or the new one.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=out_dir, delete=False) as stream:
            stream.write(text)
            temporary = Path(stream.name)
        temporary.replace(path)
    return written


def completion_issues(doc: Mapping[str, Any]) -> list[str]:
    """Numerical completion of the declared workflow, separate from scientific acceptance gates."""
    fit_doc = doc.get("fit") or {}
    issues = []
    if not (fit_doc.get("optimizer") or {}).get("success"):
        issues.append("main/pruned optimizer did not converge")
    if any(block.get("failures") for block in (fit_doc.get("blocks") or {}).values()):
        issues.append("main/pruned fit has unavailable final predictions")
    loo = fit_doc.get("loo") or {}
    experiments = loo.get("experiments") or {}
    if set(experiments) != {f"exp{number:02d}" for number in range(1, 16)}:
        issues.append("leave-one-out does not contain all 15 experiments")
    if any(not (row.get("optimizer") or {}).get("success") for row in experiments.values()):
        issues.append("one or more leave-one-out optimizers did not converge")
    if any(row.get("predicted") is False or row.get("refit_failures") for row in experiments.values()):
        issues.append("leave-one-out has unavailable refit or left-out predictions")
    variants = (fit_doc.get("sensitivity") or {}).get("variants") or {}
    if set(variants) != set(SENSITIVITY_VARIANTS):
        issues.append("sensitivity does not contain all nine declared variants")
    if any(not (row.get("optimizer") or {}).get("success") for row in variants.values()):
        issues.append("one or more sensitivity optimizers did not converge")
    if any(row.get("failures") for row in variants.values()):
        issues.append("sensitivity has unavailable final predictions")
    return issues


def load_calibration_document(path: Path) -> dict[str, Any]:
    """A calibration document ({} if the file does not exist)."""
    if not Path(path).is_file():
        return {}
    doc = load_yaml(path)
    if not isinstance(doc, Mapping) or doc.get("schema") != CALIBRATION_SCHEMA:
        raise CalibrationError(f"{path}: not a {CALIBRATION_SCHEMA} document")
    return dict(doc)


def calibrated_values(doc: Mapping[str, Any]) -> dict[str, float]:
    """Every fitted value of a calibration document: the app-facing ``parameters`` and the setup-specific
    and case-builder values recorded under ``fit``."""
    fit = doc.get("fit") or {}
    merged: dict[str, float] = {}
    for section in (fit.get("nuisance") or {}, fit.get("case_parameters") or {}, doc.get("parameters") or {}):
        merged.update({str(k): float(v) for k, v in section.items()})
    return merged


def load_calibration(path: Path) -> dict[str, float]:
    """Every fitted value of the calibration document at ``path`` ({} if it does not exist)."""
    return calibrated_values(load_calibration_document(path))


# -- command line ------------------------------------------------------------------------------


def _positive_int(value: str) -> int:
    result = int(value)
    if result < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return result


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path, help="calibration config (default: data/calibration/config.yaml)")
    parser.add_argument("--out-dir", type=Path, help="output directory (default: data/calibration)")
    parser.add_argument("--label", default="v5", help="name of the versioned output file (default: v5)")
    parser.add_argument("--start-from", type=Path, help="warm-start values from a preserved calibration document")
    parser.add_argument("--checkpoint-dir", type=Path, help="retain main/prune and each completed refit checkpoint")
    parser.add_argument("--no-current", action="store_true", help="do not write current.yaml")
    parser.add_argument("--blocks", help="comma-separated subset of blocks, e.g. V1,V4")
    parser.add_argument("--tier", type=int, help="override the config's numerics tier")
    parser.add_argument("--jobs", type=int, default=1, help="parallel simulation processes (default: 1)")
    parser.add_argument("--max-nfev", type=int, help="maximum residual evaluations of the optimiser")
    parser.add_argument("--fd-step", type=float, default=0.01,
                        help="finite-difference step: log10 units, or a fraction of the bounds (default: 0.01)")
    parser.add_argument("--loss", default="linear", choices=["linear", "soft_l1", "huber", "cauchy"])
    parser.add_argument("--dry-run", action="store_true", help="evaluate at the starting values; fit and write nothing")
    parser.add_argument("--pool-only", action="store_true",
                        help="recompute hydraulics.permeability.reference of <out-dir>/<label>.yaml with the current "
                             "builder (no refit) and rewrite it and current.yaml")
    parser.add_argument("--loo", action="store_true",
                        help="also run the V1 leave-one-condition-out check (15 refits) and record it in the fit")
    parser.add_argument("--loo-jobs", type=_positive_int, default=1,
                        help="concurrent leave-one-out folds, each using --jobs simulation processes (default: 1)")
    parser.add_argument("--prune", action="store_true",
                        help="review interior shared parameters with local marginal SD ≥ 0.5× the prior's; "
                             "fix at registry values only after successful bounded refits within both 1%% cost ceilings")
    parser.add_argument("--sensitivity", action="store_true",
                        help="also refit V1 under the sensitivity variants (transition ramp, upstream pressure loss, "
                             "whole-shot peak) and record them in the fit")
    parser.add_argument("--sensitivity-only", action="store_true",
                        help="re-run the sensitivity refits of <out-dir>/<label>.yaml from its fitted values (no main "
                             "fit) and rewrite it and current.yaml")
    parser.add_argument("--variant", action="append", default=[],
                        help="with --sensitivity-only: re-run only variants whose name contains this text (repeatable)")
    parser.add_argument("--allow-placeholder", action="store_true",
                        help="write results even if the solver reports itself as a placeholder")
    parser.add_argument("--verbose", type=int, default=0, choices=[0, 1, 2])


def run(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .cases.common import core

    config_path = args.config or paths.root / "data" / "calibration" / "config.yaml"
    config = load_config(config_path)
    out_dir = args.out_dir or paths.root / "data" / "calibration"
    if args.label in ("v1", "v2", "v3", "v4") and Path(out_dir).resolve() == (paths.root / "data/calibration").resolve():
        raise CalibrationError("v1/v2/v3/v4 are preserved historical fits; choose a new label or an external output directory")
    fixed = fixed_parameters(config, load_registry(paths))
    if args.pool_only:
        out_dir = args.out_dir or paths.root / "data" / "calibration"
        source = Path(out_dir) / f"{args.label}.yaml"
        doc = load_calibration_document(source)
        if not doc:
            raise CalibrationError(f"{paths.relative(source)} does not exist; run the calibration first")
        doc = repool(paths, doc, config)
        reference = doc["fit"]["reference_permeability"]
        for path in write_documents(doc, out_dir, label=args.label, current=not args.no_current):
            print(f"calibrate: wrote {paths.relative(path)}")
        print(f"calibrate: {REFERENCE_PERMEABILITY_ID} = {reference['value_m2']:.4g} m² (was "
              f"{reference['repooled']['previous_m2']}); by dataset: "
              + ", ".join(f"{d} {v:.3g}" for d, v in reference["datasets"].items()))
        return 0
    if args.sensitivity_only:
        return _rerun_sensitivity(args, paths, config)
    blocks = args.blocks.split(",") if args.blocks else None
    problem = build_problem(paths, config, blocks=blocks, tier=args.tier, jobs=args.jobs, fd_step=args.fd_step)
    try:
        from .identity import input_hashes, solver_identity

        datasets = sorted({name for block in problem.blocks for name in datasets_for_block(block)})
        inputs_before = input_hashes(paths, str(config_path), datasets)
        solver_before = solver_identity(paths)
        warm_start = None
        if args.start_from:
            from .identity import file_sha256

            starting_document = load_calibration_document(args.start_from)
            if not starting_document:
                raise CalibrationError(f"warm-start calibration {args.start_from} does not exist")
            starts = apply_start_values(problem, calibrated_values(starting_document))
            warm_start = {"path": paths.relative(args.start_from), "sha256": file_sha256(args.start_from),
                          "label": starting_document.get("label"), "values": starts}
        for message in check_overrides(problem):
            print(f"calibrate: warning: {message}")
        print(f"calibrate: {len(problem.params)} parameters, {len(problem.labels)} residuals in blocks "
              f"{', '.join(b.name for b in problem.blocks)}")
        if args.dry_run:
            for message in check_blocks(problem):
                print(f"calibrate: warning: {message}")
            r = problem.residuals(problem.x0())
            for block, ev in zip(problem.blocks, problem.evaluations(problem.x0())):
                rms = float(np.sqrt(np.mean(ev.residuals**2))) if ev.residuals.size else 0.0
                print(f"  {block.name}: {len(block.cases)} cases, {ev.residuals.size} residuals, rms {rms:.3g}"
                      + (f", {len(ev.failures)} failed" if ev.failures else ""))
            print(f"calibrate: dry run, cost {0.5 * float(r @ r):.4g}; nothing written")
            return 0
        result = fit(problem, max_nfev=args.max_nfev, loss=args.loss, verbose=args.verbose)

        def save_fit_stage(stage: str, stage_config: Mapping[str, Any], stage_problem: Problem,
                           stage_result: FitResult, pruned_fixed: Mapping[str, Any]) -> None:
            if not args.checkpoint_dir:
                return
            snapshot = calibration_document(stage_problem, stage_result, label=args.label,
                                            config_path=paths.relative(config_path), core_version=core().__version__,
                                            fixed={**fixed, **pruned_fixed})
            snapshot["fit"].update(effective_config=copy.deepcopy(stage_config), warm_start=warm_start,
                                   pipeline={"stage": stage, "completed": False})
            write_documents(snapshot, args.checkpoint_dir, label=f"{args.label}-{stage}", current=False)
            write_documents(snapshot, args.checkpoint_dir, label=f"{args.label}-latest", current=False)

        def save_pruning_stage(cfg: dict[str, Any], prob: Problem, res: FitResult,
                               fixed: dict[str, Any]) -> None:
            review = prob.pruning_review
            latest = review["attempts"][-1]
            stage = (f"prune-{len(fixed):02d}" if latest["accepted"]
                     else f"prune-retained-{len(review['attempts']):02d}")
            save_fit_stage(stage, cfg, prob, res, fixed)
            print(f"calibrate: pruning review {latest['parameter']}: {latest['decision']} "
                  f"(trial cost {latest['trial_cost']:.6g}, baseline {latest['baseline_cost']:.6g})", flush=True)

        save_fit_stage("main", config, problem, result, {})
        if args.prune:
            config, problem, result, pruned = prune(paths, config, problem, result, tier=args.tier,
                                                    fd_step=args.fd_step, max_nfev=args.max_nfev, loss=args.loss,
                                                    verbose=args.verbose,
                                                    progress=save_pruning_stage)
            fixed = {**fixed, **pruned}
            for pid, entry in pruned.items():
                print(f"calibrate: pruned {pid}: {entry['reason']}")
        doc = calibration_document(problem, result, label=args.label, config_path=paths.relative(config_path),
                                   core_version=core().__version__, fixed=fixed)
        doc["fit"]["effective_config"] = copy.deepcopy(config)
        doc["fit"]["warm_start"] = warm_start
        doc["fit"]["run_settings"] = {"jobs": args.jobs, "loo_jobs": getattr(args, "loo_jobs", 1),
                                       "jobs_per_fold": max(1, int(args.jobs)),
                                       "tier": args.tier if args.tier is not None else config.get("tier", 1),
                                       "fd_step": args.fd_step, "loss": args.loss, "max_nfev": args.max_nfev,
                                       "prune": args.prune, "loo": args.loo, "sensitivity": args.sensitivity}
        doc["fit"]["pipeline"] = {"stage": "main-prune", "completed": False,
                                   "required_loo": 15 if args.loo else 0,
                                   "required_sensitivity": len(SENSITIVITY_VARIANTS) if args.sensitivity else 0}

        def checkpoint(stage: str) -> None:
            doc["fit"]["pipeline"]["stage"] = stage
            if args.checkpoint_dir:
                write_documents(doc, args.checkpoint_dir, label=f"{args.label}-{stage}", current=False)
                write_documents(doc, args.checkpoint_dir, label=f"{args.label}-latest", current=False)

        checkpoint("main-prune")
        reference = doc["fit"].get("reference_permeability")
        if reference:
            print(f"calibrate: {REFERENCE_PERMEABILITY_ID} = {reference['value_m2']:.4g} m² (pooled from "
                  f"{len(reference['estimates'])} estimates, log-SD {reference['log_sd']}, max/min {reference['max_over_min']})")
        if args.loo and any(b.name == "V1" for b in problem.blocks):
            def loo_progress(partial: dict[str, Any]) -> None:
                doc["fit"]["loo"] = _rounded(partial)
                checkpoint(f"loo-{partial['completed']:02d}")
                print(f"calibrate: leave-one-out {partial['completed']}/{partial['required']} refits complete", flush=True)

            loo = leave_one_out(paths, config, problem.values(result.x), tier=args.tier, jobs=args.jobs,
                                max_nfev=args.max_nfev, fd_step=args.fd_step,
                                refit_blocks=[b.name for b in problem.blocks],
                                loo_jobs=getattr(args, "loo_jobs", 1), loss=args.loss, progress=loo_progress)
            doc["fit"]["loo"] = _rounded(loo)
            checkpoint("loo-complete")
            print(f"calibrate: leave-one-out: λ within ±15% {loo['lambda_within']}/{loo['lambda_total']}, "
                  f"cup masses {loo['cup_within']}/{loo['cup_total']}")
        if args.sensitivity and any(b.name == "V1" for b in problem.blocks):
            capped = (doc["fit"]["blocks"].get("V1", {}).get("pump_limited") or {}).get("pour_capped", [])

            def sensitivity_progress(partial: dict[str, Any]) -> None:
                doc["fit"]["sensitivity"] = _rounded(partial)
                checkpoint(f"sensitivity-{partial['completed']:02d}")
                print(f"calibrate: sensitivity {partial['completed']}/{partial['required']} refits complete", flush=True)

            sens = sensitivity(paths, config, problem.values(result.x), doc["fit"].get("reference_permeability"),
                               tier=args.tier, jobs=args.jobs, max_nfev=args.max_nfev, fd_step=args.fd_step,
                               variants=resolve_variants(SENSITIVITY_VARIANTS, capped), progress=sensitivity_progress)
            doc["fit"]["sensitivity"] = _rounded(sens)
            for name, v in sens["variants"].items():
                print(f"calibrate: sensitivity {name}: cost {v['cost']:.4g} ({'+'.join(v['blocks'])}), κ_ref by dataset "
                      + ", ".join(f"{d} {k:.3g}" for d, k in v["kappa_ref_by_dataset"].items())
                      + f", pooled {v['pooled_kappa_ref_m2']:.3g} m²")
        doc["fit"]["pipeline"]["completed"] = (
            bool(result.success)
            and not any(block["failures"] for block in doc["fit"]["blocks"].values())
            and (not args.loo or doc["fit"].get("loo", {}).get("all_optimizers_converged", False))
            and (not args.loo or doc["fit"].get("loo", {}).get("all_predictions_available", False))
            and (not args.sensitivity or doc["fit"].get("sensitivity", {}).get("all_optimizers_converged", False))
            and (not args.sensitivity or doc["fit"].get("sensitivity", {}).get("all_predictions_available", False)))
        if inputs_before != input_hashes(paths, str(config_path), datasets) or solver_before != solver_identity(paths):
            doc["fit"]["pipeline"].update(completed=False, source_changed_during_run=True)
            checkpoint("invalid-source-change")
            raise CalibrationError("calibration inputs or solver changed during the run; checkpoint retained, refit on final sources")
        checkpoint("complete" if doc["fit"]["pipeline"]["completed"] else "incomplete")
        out_dir = args.out_dir or paths.root / "data" / "calibration"
        if refuse_placeholder(problem.runner, out_dir, paths, args.allow_placeholder):
            print("calibrate: the solver reports itself as a placeholder; not writing data/calibration "
                  "(use --out-dir elsewhere, or --allow-placeholder)")
            print(json.dumps(doc["parameters"], indent=2))
            return 1
        for path in write_documents(doc, out_dir, label=args.label, current=not args.no_current):
            print(f"calibrate: wrote {paths.relative(path)}")
        print(f"calibrate: cost {result.start_cost:.4g} → {result.cost:.4g} after {result.nfev} evaluations "
              f"({problem.runner.simulations} simulations); {result.message}")
        fitted = problem.values(result.x)
        for p in problem.params:
            entry = doc["fit"]["uncertainties"].get(p.id, {})
            spread = f"± {entry.get('sd', float('nan')):.3g}" if entry.get("identified") else "(not identified)"
            ratio = entry.get("prior_sd_ratio")
            print(f"  {p.id:<52} {fitted[p.id]:<12.6g} {spread} {p.units}"
                  + (f"  (weak: SD {ratio:.2f} of the prior's)" if ratio is not None
                     and ratio >= WEAK_IDENTIFICATION_RATIO else "")
                  + ("  (at bound)" if entry.get("at_bound") else ""))
        return 0
    finally:
        problem.runner.close()


def _rerun_sensitivity(args: argparse.Namespace, paths: RepoPaths, config: Mapping[str, Any]) -> int:
    """``calibrate --sensitivity-only``: the sensitivity refits of an existing calibration file, from its
    fitted values and with its pruned parameters fixed, merged into its ``fit.sensitivity``."""
    out_dir = args.out_dir or paths.root / "data" / "calibration"
    source = Path(out_dir) / f"{args.label}.yaml"
    doc = load_calibration_document(source)
    if not doc:
        raise CalibrationError(f"{paths.relative(source)} does not exist; run the calibration first")
    fit_doc = doc.get("fit") or {}
    from .identity import input_hashes, solver_identity
    from .validate import calibration_reuse_issues

    config_path = args.config or paths.root / "data/calibration/config.yaml"
    datasets = fit_doc.get("datasets") or []
    inputs_before, solver_before = input_hashes(paths, str(config_path), datasets), solver_identity(paths)
    issues = calibration_reuse_issues(doc, solver_before, inputs_before)
    if issues:
        raise CalibrationError("cannot merge sensitivity refits into a historical main fit: " + "; ".join(issues))
    recorded_tier = (fit_doc.get("run_settings") or {}).get("tier", config.get("tier", 1))
    if args.tier is not None and args.tier != recorded_tier:
        raise CalibrationError("sensitivity repair must retain the main fit's numerics tier")
    fixed_ids = set(fit_doc.get("fixed") or {})
    config = copy.deepcopy(dict(config))
    pruned = [e for e in config["parameters"] if e["id"] in fixed_ids]
    config["parameters"] = [e for e in config["parameters"] if e["id"] not in fixed_ids]
    config["fixed"] = [*(config.get("fixed") or []),
                       *({"id": e["id"], "reason": fit_doc["fixed"][e["id"]]["reason"]} for e in pruned)]
    capped = ((fit_doc.get("blocks") or {}).get("V1", {}).get("pump_limited") or {}).get("pour_capped", [])
    variants = {name: v for name, v in resolve_variants(SENSITIVITY_VARIANTS, capped).items()
                if not args.variant or any(text in name for text in args.variant)}
    if not variants:
        raise CalibrationError(f"no sensitivity variant matches {args.variant}")
    sens = sensitivity(paths, config, calibrated_values(doc), fit_doc.get("reference_permeability"),
                       tier=args.tier, jobs=args.jobs, max_nfev=args.max_nfev, fd_step=args.fd_step, variants=variants)
    if inputs_before != input_hashes(paths, str(config_path), datasets) or solver_before != solver_identity(paths):
        raise CalibrationError("inputs or solver changed during the sensitivity rerun; existing fit left untouched")
    for variant in sens["variants"].values():
        variant["rerun_identity"] = {"solver": solver_before, "inputs": inputs_before,
                                     "jobs": args.jobs, "tier": recorded_tier, "fd_step": args.fd_step}
    merged = dict(fit_doc.get("sensitivity") or {})
    merged["reference_datasets"] = sens["reference_datasets"]
    merged["variants"] = {**(merged.get("variants") or {}), **_rounded(sens)["variants"]}
    merged.update(completed=len(merged["variants"]), required=len(SENSITIVITY_VARIANTS),
                  all_optimizers_converged=all(v["optimizer"]["success"] for v in merged["variants"].values()),
                  all_predictions_available=all(not v.get("failures") for v in merged["variants"].values()))
    doc = copy.deepcopy(doc)
    doc["fit"]["sensitivity"] = merged
    issues = completion_issues(doc)
    doc["fit"].setdefault("pipeline", {}).update(stage="complete" if not issues else "incomplete",
                                               completed=not issues, completion_issues=issues)
    for name, v in sens["variants"].items():
        print(f"calibrate: sensitivity {name}: cost {v['cost']:.4g} ({'+'.join(v['blocks'])}), κ_ref by dataset "
              + ", ".join(f"{d} {k:.3g}" for d, k in v["kappa_ref_by_dataset"].items())
              + f", pooled {v['pooled_kappa_ref_m2']:.3g} m²")
    for path in write_documents(doc, out_dir, label=args.label, current=not args.no_current):
        print(f"calibrate: wrote {paths.relative(path)}")
    return 0


def refuse_placeholder(runner: Runner, out_dir: Path, paths: RepoPaths, allow: bool = False) -> bool:
    """Whether to refuse writing: the solver is a placeholder and the target is the repository's
    data/calibration (whose current.yaml the app embeds)."""
    in_repo = Path(out_dir).resolve() == (paths.root / "data" / "calibration").resolve()
    return runner.placeholder and in_repo and not allow


__all__ = [
    "CalibrationError", "DatasetBlock", "Parameter", "Problem", "Runner", "build_problem", "calibration_document",
    "check_blocks", "sensitivity", "prune", "pump_summary", "resolve_variants",
    "calibrated_values", "fit", "get_path", "leave_one_out", "load_calibration", "load_calibration_document",
    "load_config", "reference_permeability", "fixed_parameters", "prior_sd", "repool", "scaling_basis",
    "make_parameters", "prior_bounds", "registry_default", "run", "uncertainties", "write_documents",
]
