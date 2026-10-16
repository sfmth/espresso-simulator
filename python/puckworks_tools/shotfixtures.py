# SPDX-License-Identifier: GPL-2.0-or-later
"""Golden shot fixture for the cross-language check of the M1 shot API.

``data/fixtures/shot_cases.json`` holds a few recipes with the spec the native builder makes of
each and the result the native solver returns for that spec. The web tests feed each ``recipe`` to
the WebAssembly build and compare its spec and result with the file, so browser and native agree on
the shot model (docs/PLAN.md §10; docs/model/m1-contract.md §2, determinism).

Format::

    {"schema": "puckworks.shot-cases/1", "core_version": "0.1.0",
     "generator": "puckworks-tools shot-fixtures",
     "cases": [{"name": "...", "recipe": <Recipe>, "spec": <ShotSpec>, "result": <ShotResult>}]}

``spec`` is ``build.spec`` of ``simulate_recipe(recipe)`` and ``result`` its ``result``. Floats use
Python's shortest round-trip representation, so parsing gives back exactly the doubles the core
produced; the file holds no wall-clock times. The cases cover tiers 0 and 1, a vibratory pump, a
pressurised basket, flow-controlled programs, a custom tapered basket, a measured PSD, and
both a noninteger pore-air permeability exponent and a disabled pore-air closure. Opt-in upstream
pressure-storage cases cover a pump pause, a resume, and either a stored-water tail or a stop vent.

``--check`` regenerates the document from ``CASES`` and compares it with the committed file: names,
recipes, keys and strings exactly; numbers in ``spec`` and ``result`` to ``--tolerance`` (absolute;
default 0, exact).
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from pathlib import Path
from types import ModuleType
from typing import Any

from .fixtures import Comparison, dumps, import_puckcore
from .paths import RepoPaths

SCHEMA = "puckworks.shot-cases/1"
GENERATOR = "puckworks-tools shot-fixtures"
FILENAME = "shot_cases.json"
#: Keys of each case, in the order they are written.
CASE_KEYS = ("name", "recipe", "spec", "result")


def _recipe(**fields: Any) -> dict[str, Any]:
    recipe = {"schema": "puckworks.recipe/1", "bean": {}, "grinder": {}, "basket": {}, "prep": {}, "machine": {},
              "stop": {}}
    recipe.update(fields)
    return recipe


def _compliance_recipe(*, vent: bool) -> dict[str, Any]:
    """A structural pause/resume exercise, not a fit to a measured machine or shot."""
    return _recipe(
        bean={"preset": "medium-washed-arabica"},
        grinder={"preset": "generic-flat-traditional-64", "setting": 190.0},
        basket={"preset": "58-precision-18g"}, prep={"dose_g": 18.0},
        machine={"profile": [{"control": "flow", "target": 3.0, "limit": 9.0,
                              "ramp_s": 0.0, "until_time_s": 30.0},
                             {"control": "flow", "target": 0.0, "limit": 9.0,
                              "ramp_s": 0.0, "until_time_s": 8.0},
                             {"control": "flow", "target": 3.0, "limit": 9.0,
                              "ramp_s": 0.0}],
                 "vent_headspace": vent},
        stop={"time_s": 50.0}, numerics={"tier": 0},
        overrides={"model.machine.hydraulic_compliance": 1.0,
                   "model.machine.drip_time_constant": 1.0},
    )


#: The fixture's recipes. Short shots (35–50 s) keep the file under 3 MB: each case stores every
#: 0.1 s output point, including the hydraulic inventories, and 12 spatial snapshots.
CASES: tuple[tuple[str, dict[str, Any]], ...] = (
    (
        "presets_flat_9bar_tier1",
        _recipe(bean={"preset": "medium-washed-arabica"}, grinder={"preset": "mahlkoenig-ek43", "setting": 1.7},
                basket={"preset": "58-precision-18g"}, prep={"dose_g": 18.0}, machine={"preset": "flat-9-bar"},
                stop={"beverage_g": 36.0, "time_s": 35.0}),
    ),
    (
        "vibratory_pump_pressurised_basket_tier1",
        _recipe(bean={"preset": "dark-80-20-blend"}, grinder={"preset": "generic-conical-50", "setting": 250.0},
                basket={"preset": "58-pressurised-double"}, prep={"dose_g": 16.0},
                machine={"preset": "vibratory-pump"}, stop={"beverage_g": 32.0, "time_s": 35.0}),
    ),
    (
        "flow_control_2ml_s_tier1",
        _recipe(bean={"preset": "light-washed-arabica"}, grinder={"preset": "mahlkoenig-e65s", "setting": 1.7},
                basket={"preset": "58-precision-20g"}, prep={"dose_g": 20.0}, machine={"preset": "flow-2-ml-s"},
                stop={"beverage_g": 40.0, "time_s": 35.0}),
    ),
    (
        "custom_tapered_basket_measured_psd_tier0",
        _recipe(bean={"roast_level": 0.6, "days_off_roast": 12.0},
                grinder={"psd": {"diameter_um": [30.0, 60.0, 150.0, 300.0, 500.0],
                                 "volume_fraction": [0.1, 0.15, 0.2, 0.4, 0.15]}},
                basket={"custom": {"profile_mm": [[0.0, 52.0], [6.0, 56.0], [24.0, 58.0]],
                                   "perforated_diameter_mm": 50.0}},
                prep={"dose_g": 17.0},
                machine={"profile": [{"control": "flow", "target": 4.0, "until_pressure_bar": 3.0},
                                     {"control": "pressure", "target": 8.0, "ramp_s": 3.0}],
                         "temperature_c": 91.0},
                stop={"beverage_g": 40.0, "time_s": 40.0}, numerics={"tier": 0},
                overrides={"model.hydraulics.pore_air_permeability_exponent": 2.5}),
    ),
    (
        "spring_lever_tier0",
        _recipe(bean={"preset": "medium-natural-brazil"}, grinder={"preset": "bentwood-v63", "setting": 200.0},
                basket={"preset": "58-precision-15g"}, prep={"dose_g": 15.0}, machine={"preset": "spring-lever"},
                stop={"beverage_g": 30.0, "time_s": 40.0}, numerics={"tier": 0},
                overrides={"model.hydraulics.pore_air_amplitude": 0}),
    ),
    ("compliance_pause_resume_tail_tier0", _compliance_recipe(vent=False)),
    ("compliance_pause_resume_vent_tier0", _compliance_recipe(vent=True)),
)


def _plain(value: Any) -> Any:
    """A JSON round trip: plain dicts, lists and numbers exactly as JSON gives them back."""
    return json.loads(json.dumps(value, allow_nan=False))


def generate(paths: RepoPaths | None = None, core: ModuleType | None = None) -> dict[str, Any]:
    """Runs every recipe through the native builder and solver and returns the fixture document."""
    core = core or import_puckcore()
    cases = []
    for name, recipe in CASES:
        run = core.simulate_recipe(recipe)
        cases.append({"name": name, "recipe": _plain(recipe), "spec": _plain(run["build"]["spec"]),
                      "result": _plain(run["result"])})
    return {"schema": SCHEMA, "core_version": core.__version__, "generator": GENERATOR, "cases": cases}


def write(path: Path, document: Mapping[str, Any]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(document), encoding="utf-8")
    return path


def _compare(expected: Any, actual: Any, where: str, numeric: bool, out: Comparison) -> None:
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping):
            out.problems.append(f"{where or 'document'}: expected an object")
            return
        if list(expected) != list(actual):
            out.problems.append(f"{where or 'document'}: keys differ ({list(expected)} vs {list(actual)})")
            return
        for key in expected:
            child = f"{where}.{key}" if where else key
            _compare(expected[key], actual[key], child, numeric or key in ("spec", "result"), out)
        return
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) != len(actual):
            got = len(actual) if isinstance(actual, list) else type(actual).__name__
            out.problems.append(f"{where}: expected a list of {len(expected)} items, got {got}")
            return
        for index, (e, a) in enumerate(zip(expected, actual)):
            child = f"{where}[{e['name']}]" if isinstance(e, Mapping) and "name" in e else f"{where}[{index}]"
            _compare(e, a, child, numeric, out)
        return
    is_number = isinstance(expected, (int, float)) and not isinstance(expected, bool)
    if numeric and is_number and isinstance(actual, (int, float)) and not isinstance(actual, bool):
        out.values_compared += 1
        diff = abs(float(actual) - float(expected))
        if math.isnan(diff):
            out.problems.append(f"{where}: NaN")
        elif diff > out.max_abs_diff:
            scale = max(abs(float(actual)), abs(float(expected)))
            out.max_abs_diff, out.max_rel_diff, out.where = diff, (diff / scale if scale > 0 else 0.0), where
        return
    if expected != actual:
        out.problems.append(f"{where}: committed {expected!r}, current build gives {actual!r}")


def compare(expected: Mapping[str, Any], actual: Mapping[str, Any], tolerance: float = 0.0) -> Comparison:
    """Compares two fixture documents (metadata and recipes exact; spec and result numbers to ``tolerance``)."""
    out = Comparison(tolerance=tolerance)
    _compare(expected, actual, "", False, out)
    return out


def check(path: Path, paths: RepoPaths | None = None, tolerance: float = 0.0,
          core: ModuleType | None = None) -> Comparison:
    """Regenerates the fixture in memory and compares it with the file at ``path``."""
    path = Path(path)
    if not path.is_file():
        out = Comparison(tolerance=tolerance)
        out.problems.append(f"{path} does not exist; generate it with `puckworks-tools shot-fixtures`")
        return out
    committed = json.loads(path.read_text(encoding="utf-8"))
    return compare(committed, generate(paths, core), tolerance)
