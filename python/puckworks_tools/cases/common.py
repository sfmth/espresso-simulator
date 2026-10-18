# SPDX-License-Identifier: GPL-2.0-or-later
"""Shared machinery of the case builders: data tables, spec construction, PSDs and observables.

A *case* is one experimental condition of a dataset, written as a complete
ShotSpec (docs/model/m1-contract.md). Every case starts from the builder's
output for a minimal recipe (``puckcore.build_shot_spec``), so it carries the
input models' closures and registry defaults; the physical fields the paper
reports (dose, basket, particle sizes, temperature, machine program, stop) are
then set from the paper. The mapping of each dataset is documented in
docs/validation/case-builders.md.
"""

from __future__ import annotations

import copy
import csv
import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np

from ..fixtures import import_puckcore
from ..paths import RepoPaths
from ..yamlio import load_yaml

RECIPE_SCHEMA = "puckworks.recipe/1"
WATER_DENSITY = 1000.0  # kg/m³, for converting set flows (mL/s) and beverage masses


# -- cases -------------------------------------------------------------------------


@dataclass
class Case:
    """One experimental condition: a recipe for the builder plus the paper's physical conditions.

    ``build(values)`` returns the case's ShotSpec: the builder's spec for ``recipe`` (with the
    registry ids of ``values`` as recipe overrides), then ``finalize(spec, values)``, which sets the
    fields the paper reports and applies the case's own parameters (``case_parameters``, which are
    never passed to the builder). ``spec`` holds the spec built when the case was made.
    """

    dataset: str
    name: str
    recipe: dict[str, Any]
    finalize: Callable[[dict[str, Any], Mapping[str, float]], None]
    #: Key of the group of cases that share a setup-specific (nuisance) parameter, e.g. a grind.
    group: str = ""
    #: Conditions and data needed by the observables and the report.
    info: dict[str, Any] = field(default_factory=dict)
    #: Parameter ids applied by ``finalize`` itself.
    case_parameters: tuple[str, ...] = ()
    spec: dict[str, Any] = field(default_factory=dict)

    def build(self, values: Mapping[str, float] | None = None, module: ModuleType | None = None) -> dict[str, Any]:
        values = dict(values or {})
        recipe = copy.deepcopy(self.recipe)
        recipe["overrides"] = {**recipe.get("overrides", {}),
                               **{k: float(v) for k, v in values.items() if k not in self.case_parameters}}
        spec = base_spec(recipe, module)
        self.finalize(spec, values)
        return spec


def make_case(dataset: str, name: str, recipe: dict[str, Any],
              finalize: Callable[[dict[str, Any], Mapping[str, float]], None], *, group: str = "",
              info: dict[str, Any] | None = None, case_parameters: tuple[str, ...] = (),
              overrides: Mapping[str, float] | None = None, module: ModuleType | None = None) -> Case:
    """A Case with its spec built once (with ``overrides``)."""
    case = Case(dataset, name, recipe, finalize, group, info or {}, case_parameters)
    case.spec = case.build(overrides, module)
    return case


def core(module: ModuleType | None = None) -> ModuleType:
    """The puckcore extension (or the module given, for tests)."""
    return module if module is not None else import_puckcore()


# -- data tables ------------------------------------------------------------------


def read_table(paths: RepoPaths, dataset_id: str, filename: str | None = None) -> list[dict[str, Any]]:
    """Rows of a dataset CSV, typed by its sidecar: numbers as float, integers as int, '' as None."""
    folder = paths.datasets_dir / dataset_id
    meta = load_yaml(folder / "dataset.yaml")
    types = {column["name"]: column["type"] for column in meta["columns"]}
    name = filename or meta["files"][0]["path"]
    rows = []
    with open(folder / name, encoding="utf-8", newline="") as handle:
        for raw in csv.DictReader(handle):
            row: dict[str, Any] = {}
            for key, text in raw.items():
                kind = types.get(key, "string")
                if text == "":
                    row[key] = None
                elif kind == "number":
                    row[key] = float(text)
                elif kind == "integer":
                    row[key] = int(text)
                else:
                    row[key] = text
            rows.append(row)
    return rows


# -- recipes and specs -------------------------------------------------------------


def minimal_recipe(
    dose_g: float,
    psd: tuple[Sequence[float], Sequence[float]],
    basket: "Basket",
    *,
    profile: Sequence[Mapping[str, Any]] | None = None,
    beverage_g: float | None = None,
    time_s: float | None = None,
    tier: int = 1,
    temperature_c: float | None = None,
    overrides: Mapping[str, float] | None = None,
) -> dict[str, Any]:
    """A recipe without presets: the paper's PSD (µm, volume fractions), basket and program, so that
    the builder's closures (permeability from the Sauter diameter, headspace, prewetting) see them.
    The bean is left to the builder's default."""
    profile_mm, perforated = basket.recipe_profile()
    recipe: dict[str, Any] = {
        "schema": RECIPE_SCHEMA,
        "bean": {},
        "grinder": {"psd": {"diameter_um": [float(d) for d in psd[0]],
                            "volume_fraction": [float(w) for w in psd[1]]}},
        "basket": {"custom": {"profile_mm": profile_mm, "perforated_diameter_mm": perforated}},
        "prep": {"dose_g": float(dose_g)},
        "machine": {"profile": [dict(p) for p in (profile or [{"control": "pressure", "target": 9.0}])]},
        "stop": {},
        "numerics": {"tier": int(tier)},
        # Preserve the M1 calibration/validation boundary. M2 case builders
        # explicitly enable chemistry after constructing their recipe.
        "chemistry": {"enabled": False},
        "overrides": {k: float(v) for k, v in (overrides or {}).items()},
    }
    if temperature_c is not None:
        recipe["machine"]["temperature_c"] = float(temperature_c)
    if beverage_g is not None:
        recipe["stop"]["beverage_g"] = float(beverage_g)
    if time_s is not None:
        recipe["stop"]["time_s"] = float(time_s)
    return recipe


def base_spec(recipe: Mapping[str, Any], module: ModuleType | None = None) -> dict[str, Any]:
    """The builder's ShotSpec for ``recipe`` (a deep copy, safe to edit)."""
    return copy.deepcopy(core(module).build_shot_spec(dict(recipe))["spec"])


@dataclass(frozen=True)
class Basket:
    """A straight-walled basket: inner diameter and height (mm), perforated-area diameter (mm)."""

    name: str
    diameter_mm: float
    height_mm: float
    perforated_diameter_mm: float

    @property
    def radius_m(self) -> float:
        return self.diameter_mm / 2000.0

    @property
    def area_m2(self) -> float:
        return math.pi * self.radius_m**2

    def recipe_profile(self) -> tuple[list[list[float]], float]:
        """The basket as a recipe's custom profile: [[height, diameter]] in mm, and the perforated diameter."""
        return [[0.0, self.diameter_mm], [self.height_mm, self.diameter_mm]], self.perforated_diameter_mm

    def apply(self, spec: dict[str, Any]) -> None:
        basket = spec["basket"]
        basket["profile_m"] = [[0.0, self.radius_m], [self.height_mm / 1000.0, self.radius_m]]
        basket["perforated_radius_m"] = self.perforated_diameter_mm / 2000.0


#: IMS precision 58 mm baskets (Schmieder: BT702Th26.5M; Waszkiewicz: B682TCH26.5E, "internal diameter
#: 58 mm, height 26.5 mm"). The small taper near the floor is ignored; holes over a 54 mm floor area.
IMS_58_H26_5 = Basket("IMS 58 mm, H 26.5 mm", 58.0, 26.5, 54.0)
#: VST 20 g ridgeless baskets (Cameron: "twenty gram ridge-less"; Smrke: VST 20 g): 58.5 mm inner
#: diameter, about 25 mm deep, straight walls assumed.
VST_20G = Basket("VST 20 g", 58.5, 25.0, 54.0)


def set_porosity_for_height(spec: dict[str, Any], basket: Basket, bed_height_m: float) -> float:
    """Sets the intergranular porosity so that the dose fills ``basket`` to ``bed_height_m``."""
    bed = spec["bed"]
    solid = bed["dose_kg"] / ((1.0 - bed["intraparticle_porosity"]) * bed["skeletal_density_kg_m3"])
    porosity = 1.0 - solid / (basket.area_m2 * bed_height_m)
    if not 0.0 < porosity < 0.9:
        raise ValueError(f"bed height {bed_height_m} m needs porosity {porosity:.3f}")
    bed["intergranular_porosity"] = porosity
    return porosity


def set_porosity_for_density(spec: dict[str, Any], bulk_density_kg_m3: float) -> float:
    """Sets the intergranular porosity of a bed packed to ``bulk_density_kg_m3`` (dry)."""
    bed = spec["bed"]
    porosity = 1.0 - bulk_density_kg_m3 / ((1.0 - bed["intraparticle_porosity"]) * bed["skeletal_density_kg_m3"])
    if not 0.0 < porosity < 0.9:
        raise ValueError(f"bulk density {bulk_density_kg_m3} kg/m³ gives porosity {porosity:.3f}")
    bed["intergranular_porosity"] = porosity
    return porosity


def kozeny_carman(porosity: float) -> float:
    """Relative Kozeny–Carman factor ε³/(1 − ε)²."""
    return porosity**3 / (1.0 - porosity) ** 2


def ideal_pump(max_flow_m3_s: float = 8e-6, max_pressure_pa: float = 1.2e6) -> dict[str, Any]:
    return {"type": "ideal", "max_flow_m3_s": max_flow_m3_s, "max_pressure_pa": max_pressure_pa}


def phase(control: dict[str, Any], *, ramp_s: float, limit: float | None = None, time_s: float | None = None,
          beverage_kg: float | None = None, pressure_pa: float | None = None) -> dict[str, Any]:
    return {
        "control": control,
        "ramp_s": ramp_s,
        "limit": limit,
        "exit": {"time_s": time_s, "beverage_mass_kg": beverage_kg, "pressure_pa": pressure_pa},
    }


def pressure_control(target_pa: float) -> dict[str, Any]:
    return {"type": "pressure", "target_pa": target_pa}


def flow_control(target_m3_s: float) -> dict[str, Any]:
    return {"type": "flow", "target_m3_s": target_m3_s}


def set_program(spec: dict[str, Any], phases: list[dict[str, Any]], *, pump: dict[str, Any] | None = None,
                stop_beverage_kg: float | None = None, stop_time_s: float | None = None,
                max_duration_s: float | None = None) -> None:
    machine = spec["machine"]
    machine["phases"] = phases
    if pump is not None:
        machine["pump"] = pump
    machine["stop"]["beverage_mass_kg"] = stop_beverage_kg
    machine["stop"]["time_s"] = stop_time_s
    if max_duration_s is not None:
        spec["numerics"]["max_duration_s"] = max_duration_s


def set_temperature(spec: dict[str, Any], water_temp_c: float) -> None:
    spec["thermal"]["water_temp_c"] = float(water_temp_c)


def set_numerics(spec: dict[str, Any], *, tier: int | None = None, output_interval_s: float | None = None,
                 snapshot_count: int | None = None) -> None:
    numerics = spec["numerics"]
    if tier is not None:
        numerics["tier"] = int(tier)
    if output_interval_s is not None:
        numerics["output_interval_s"] = float(output_interval_s)
    if snapshot_count is not None:
        numerics["snapshot_count"] = int(snapshot_count)


# -- spec paths ---------------------------------------------------------------------

_PATH_PART = re.compile(r"^([a-z0-9_]+)(?:\[id=([A-Za-z0-9_.-]+)\])?$")


def _walk(spec: dict[str, Any], path: str) -> tuple[Any, str]:
    parts = path.split(".")
    node: Any = spec
    for part in parts[:-1]:
        match = _PATH_PART.match(part)
        if not match:
            raise KeyError(f"bad spec path {path!r}")
        node = node[match.group(1)]
        if match.group(2) is not None:
            node = next((item for item in node if item.get("id") == match.group(2)), None)
            if node is None:
                raise KeyError(f"{path!r}: no element with id {match.group(2)!r}")
    return node, parts[-1]


def get_path(spec: dict[str, Any], path: str) -> Any:
    """Value at a dotted spec path; ``solubles.species[id=caffeine].mass_fraction`` selects by id."""
    node, key = _walk(spec, path)
    if key not in node:
        raise KeyError(f"spec has no field {path!r}")
    return node[key]


def set_path(spec: dict[str, Any], path: str, value: Any) -> None:
    """Sets an existing field at a dotted spec path (unknown fields are an error, as in the contract)."""
    node, key = _walk(spec, path)
    if key not in node:
        raise KeyError(f"spec has no field {path!r}")
    node[key] = value


# -- particle-size distributions ----------------------------------------------------


@dataclass
class Psd:
    """A volume-weighted size distribution on a grid of diameters (µm), weights summing to 1."""

    diameter_um: np.ndarray
    weight: np.ndarray

    def __post_init__(self) -> None:
        self.diameter_um = np.asarray(self.diameter_um, dtype=float)
        weight = np.clip(np.asarray(self.weight, dtype=float), 0.0, None)
        total = weight.sum()
        if not total > 0:
            raise ValueError("a PSD needs positive weights")
        self.weight = weight / total

    def _cdf(self) -> np.ndarray:
        """Cumulative volume share at each grid point, counting half of the point's own weight
        (the grid point is the centre of its cell, so this is unbiased for fine grids)."""
        return np.cumsum(self.weight) - 0.5 * self.weight

    def share_below(self, d_um: float) -> float:
        """Volume share below ``d_um``, interpolating in log diameter between grid points."""
        return float(np.interp(math.log(d_um), np.log(self.diameter_um), self._cdf(), left=0.0, right=1.0))

    def median_um(self) -> float:
        return float(math.exp(np.interp(0.5, self._cdf(), np.log(self.diameter_um))))

    def sauter_um(self) -> float:
        return float(1.0 / np.sum(self.weight / self.diameter_um))

    def de_brouckere_um(self) -> float:
        return float(np.sum(self.weight * self.diameter_um))

    def sauter_above_um(self, d_um: float) -> float:
        """Sauter mean diameter of the particles larger than ``d_um``."""
        sel = self.diameter_um > d_um
        return float(np.sum(self.weight[sel]) / np.sum(self.weight[sel] / self.diameter_um[sel]))

    def classes(self, n: int, d_min_um: float = 2.0, tail: float = 5e-4) -> list[dict[str, float]]:
        """At most ``n`` size classes of equal width in log diameter between the ``tail`` and
        1 − ``tail`` volume quantiles (the tails join the end classes).

        Each class's radius is the Sauter mean (Σw/Σ(w/d)) of its grid points, which preserves the
        class's surface area per volume and so its surface dissolution and diffusion lengths."""
        d = self.diameter_um
        cdf = self._cdf()
        lo = max(float(np.exp(np.interp(tail, cdf, np.log(d)))), d_min_um)
        hi = max(float(np.exp(np.interp(1.0 - tail, cdf, np.log(d)))), lo * 1.01)
        edges = np.exp(np.linspace(math.log(lo), math.log(hi), n + 1))
        index = np.clip(np.searchsorted(edges, d, side="right") - 1, 0, n - 1)
        out = []
        for k in range(n):
            sel = index == k
            w = self.weight[sel]
            if w.sum() <= 1e-12:
                continue
            d32 = float(w.sum() / np.sum(w / d[sel]))
            out.append({"radius_m": d32 / 2.0e6, "volume_fraction": float(w.sum())})
        total = sum(c["volume_fraction"] for c in out)
        for c in out:
            c["volume_fraction"] /= total
        return out

    def recipe_psd(self, n: int) -> tuple[list[float], list[float]]:
        """The ``n`` classes as a recipe PSD (diameters in µm, volume fractions)."""
        classes = self.classes(n)
        return [c["radius_m"] * 2.0e6 for c in classes], [c["volume_fraction"] for c in classes]


def log_grid(d_min_um: float = 1.0, d_max_um: float = 3000.0, per_decade: int = 60) -> np.ndarray:
    n = int(round(math.log10(d_max_um / d_min_um) * per_decade)) + 1
    return np.exp(np.linspace(math.log(d_min_um), math.log(d_max_um), n))


def lognormal_mixture(components: Sequence[tuple[float, float, float]], grid: np.ndarray | None = None) -> Psd:
    """Volume distribution of a mixture of log-normals: (weight, volume median µm, σ of ln d)."""
    grid = log_grid() if grid is None else grid
    logs = np.log(grid)
    density = np.zeros_like(grid)
    for weight, median, sigma in components:
        density += weight * np.exp(-0.5 * ((logs - math.log(median)) / sigma) ** 2) / sigma
    return Psd(grid, density)


#: Defaults of the bimodal construction: the fines mode (registry psd.fines_mode, 40 µm) and the
#: log-widths of the input models' PSD mixture (model.psd.fines_log_width, model.psd.boulder_log_width).
FINES_MODE_UM = 40.0
FINES_SIGMA = 0.6
BOULDER_SIGMA = 0.35


def bimodal_psd(
    *,
    share_below_100um: float | None = None,
    median_um: float | None = None,
    de_brouckere_um: float | None = None,
    sauter_um: float | None = None,
    sauter_above_100um: float | None = None,
    fines_weight: float | None = None,
    fines_mode_um: float = FINES_MODE_UM,
    fines_sigma: float = FINES_SIGMA,
    boulder_sigma: float = BOULDER_SIGMA,
) -> Psd:
    """A fines + boulders log-normal mixture matching two reported statistics.

    The fines mode and both widths are fixed; the fines weight and the boulder median are solved
    to match two of: the volume share below 100 µm, the median X50, D[4,3], D[3,2], the D[3,2] of
    the particles above 100 µm, or a given fines weight. Used where a paper reports summary
    statistics instead of a distribution.
    """
    from scipy.optimize import least_squares

    targets: list[tuple[Callable[[Psd], float], float, bool]] = []
    if share_below_100um is not None:
        targets.append((lambda p: p.share_below(100.0), share_below_100um, False))
    if median_um is not None:
        targets.append((Psd.median_um, median_um, True))
    if de_brouckere_um is not None:
        targets.append((Psd.de_brouckere_um, de_brouckere_um, True))
    if sauter_um is not None:
        targets.append((Psd.sauter_um, sauter_um, True))
    if sauter_above_100um is not None:
        targets.append((lambda p: p.sauter_above_um(100.0), sauter_above_100um, True))
    fixed_weight = fines_weight
    needed = 1 if fixed_weight is not None else 2
    if len(targets) != needed:
        raise ValueError(f"bimodal_psd needs {needed} statistics, got {len(targets)}")

    def make(x: np.ndarray) -> Psd:
        w = fixed_weight if fixed_weight is not None else 1.0 / (1.0 + math.exp(-x[-1]))
        return lognormal_mixture([(w, fines_mode_um, fines_sigma), (1.0 - w, math.exp(x[0]), boulder_sigma)])

    def residual(x: np.ndarray) -> np.ndarray:
        p = make(x)
        return np.array([math.log(f(p) / t) if log else (f(p) - t) / 0.05 for f, t, log in targets])

    start = [math.log(300.0)] + ([] if fixed_weight is not None else [math.log(0.25 / 0.75)])
    fit = least_squares(residual, np.array(start), xtol=1e-12, ftol=1e-12)
    if np.max(np.abs(fit.fun)) > 1e-3:
        raise ValueError(f"bimodal_psd could not match the statistics (residuals {fit.fun})")
    return make(fit.x)


# -- reading results ----------------------------------------------------------------


def series(result: Mapping[str, Any], key: str) -> np.ndarray:
    return np.asarray(result["series"][key], dtype=float)


def species_cup(result: Mapping[str, Any], species: str) -> np.ndarray:
    """Cumulative cup mass (kg) of a species, or of all dissolved solids for ``tds``."""
    if species == "tds":
        return series(result, "tds_cup") * series(result, "beverage_mass_kg")
    for item in result["series"]["species_cup_kg"]:
        if item["id"] == species:
            return np.asarray(item["values"], dtype=float)
    raise KeyError(f"result has no species {species!r}")


def _monotone(x: np.ndarray) -> np.ndarray:
    return np.maximum.accumulate(x)


def cup_mass_at(result: Mapping[str, Any], species: str, beverage_kg: float) -> float:
    """Cup mass (kg) of a species when the beverage mass reaches ``beverage_kg`` (linear
    interpolation); NaN if the shot never reached that mass."""
    m = _monotone(series(result, "beverage_mass_kg"))
    s = _monotone(species_cup(result, species))
    if beverage_kg > m[-1] + 1e-12:
        return math.nan
    return float(np.interp(beverage_kg, m, s))


def fraction_concentrations(result: Mapping[str, Any], species: str,
                            bounds_kg: Sequence[tuple[float, float]]) -> list[float]:
    """Mean concentration (kg/kg) of a species in beverage-mass windows [m0, m1] (NaN for a window
    the shot did not complete)."""
    m = _monotone(series(result, "beverage_mass_kg"))
    s = _monotone(species_cup(result, species))
    out = []
    for m0, m1 in bounds_kg:
        if m1 > m[-1] + 1e-12:  # the shot ended before this fraction was complete
            out.append(math.nan)
            continue
        out.append(float((np.interp(m1, m, s) - np.interp(m0, m, s)) / (m1 - m0)))
    return out


def time_at_mass(result: Mapping[str, Any], beverage_kg: float) -> float:
    """Time (s) at which the beverage mass first reaches ``beverage_kg``."""
    t = series(result, "t_s")
    m = _monotone(series(result, "beverage_mass_kg"))
    if beverage_kg > m[-1]:
        return float("nan")
    i = int(np.searchsorted(m, beverage_kg))
    if i == 0:
        return float(t[0])
    return float(t[i - 1] + (t[i] - t[i - 1]) * (beverage_kg - m[i - 1]) / max(m[i] - m[i - 1], 1e-30))


def mass_flow_g_s(result: Mapping[str, Any], smooth_window_s: float | None = 3.0) -> tuple[np.ndarray, np.ndarray]:
    """Mass flow into the cup (g/s) as the time derivative of the beverage mass, optionally smoothed
    like Waszkiewicz et al. (Savitzky–Golay, order 1, about 3 s)."""
    t = series(result, "t_s")
    m = series(result, "beverage_mass_kg") * 1e3
    # resample to a uniform grid (the series ends with irregular stop and drip points)
    dt = float(np.median(np.diff(t))) if t.size > 2 else 0.1
    grid = np.arange(t[0], t[-1] + 1e-9, dt)
    mg = np.interp(grid, t, m)
    q = np.gradient(mg, grid) if grid.size > 1 else np.zeros_like(grid)
    if smooth_window_s and grid.size > 5:
        from scipy.signal import savgol_filter

        window = max(3, int(round(smooth_window_s / dt)) | 1)
        if window < grid.size:
            q = savgol_filter(q, window_length=window, polyorder=1)
    return grid, q


@dataclass(frozen=True)
class ExpFit:
    c0: float
    lam: float
    c0_se: float
    lam_se: float


def fit_exponential(m: Sequence[float], c: Sequence[float]) -> ExpFit:
    """Least-squares fit of c = c0·exp(−m/λ) (unweighted, as Schmieder et al. fitted in OriginPro)."""
    from scipy.optimize import curve_fit

    m_arr, c_arr = np.asarray(m, float), np.asarray(c, float)
    good = np.isfinite(m_arr) & np.isfinite(c_arr) & (c_arr > 0)
    m_arr, c_arr = m_arr[good], c_arr[good]
    if m_arr.size < 3 or np.ptp(m_arr) <= 0:
        return ExpFit(math.nan, math.nan, math.nan, math.nan)
    slope, intercept = np.polyfit(m_arr, np.log(c_arr), 1)
    lam0 = -1.0 / slope if slope < 0 else 1e3 * max(m_arr.max(), 1.0)
    p0 = (math.exp(intercept), lam0)
    try:
        popt, pcov = curve_fit(lambda x, a, b: a * np.exp(-x / b), m_arr, c_arr, p0=p0, maxfev=20000)
        se = np.sqrt(np.clip(np.diag(pcov), 0.0, None))
    except (RuntimeError, ValueError):  # pragma: no cover - degenerate model output
        popt, se = np.array(p0), np.array([math.nan, math.nan])
    return ExpFit(float(popt[0]), float(popt[1]), float(se[0]), float(se[1]))


# -- validity -------------------------------------------------------------------------


def shot_spec_schema(paths: RepoPaths) -> dict[str, Any] | None:
    """The ShotSpec JSON schema (workstream A), if it exists yet."""
    path = paths.root / "data" / "schema" / "shot-spec.schema.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def spec_problems(spec: Mapping[str, Any], paths: RepoPaths, module: ModuleType | None = None,
                  simulate: bool = True) -> list[str]:
    """Why ``spec`` is not a valid ShotSpec: JSON schema (when present), the same fields as the
    builder's own output, finite numbers, and (with ``simulate``) acceptance by the core."""
    problems: list[str] = []
    schema = shot_spec_schema(paths)
    if schema is not None:
        import jsonschema

        validator = jsonschema.Draft202012Validator(schema)
        problems += [f"schema: {'/'.join(map(str, e.absolute_path))}: {e.message}" for e in validator.iter_errors(spec)]
    try:
        json.dumps(spec, allow_nan=False)
    except ValueError as exc:
        problems.append(f"non-finite number: {exc}")
    reference = base_spec(minimal_recipe(18.0, ([40.0, 300.0], [0.2, 0.8]), IMS_58_H26_5, beverage_g=36.0), module)

    def keys(a: Any, b: Any, where: str) -> None:
        if isinstance(a, Mapping) and isinstance(b, Mapping) and "type" not in a:
            for k in a:
                if k not in b:
                    problems.append(f"unknown field {where}{k}")
                else:
                    keys(a[k], b[k], f"{where}{k}.")

    keys(spec, reference, "")
    if simulate:
        try:
            core(module).simulate_shot(spec)
        except ValueError as exc:
            problems.append(f"rejected by the core: {exc}")
    return problems
