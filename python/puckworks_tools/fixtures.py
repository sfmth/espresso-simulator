# SPDX-License-Identifier: GPL-2.0-or-later
"""Golden fixture for the cross-language sphere-release check.

``data/fixtures/sphere_cases.json`` holds a few sphere-release runs computed
by the native core (the ``puckcore`` Python extension). The web tests run the
same cases through the WebAssembly build and compare against this file, so
browser and native results are checked against each other (docs/PLAN.md §10).

Format::

    {"schema": "puckworks.sphere-cases/1", "core_version": "0.1.0",
     "generator": "puckworks-tools fixtures",
     "cases": [{"name": ..., "params": {...}, "result": {...}}]}

Floats are written with Python's shortest round-trip representation, so
parsing the file gives back exactly the doubles the core produced.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

SCHEMA = "puckworks.sphere-cases/1"
GENERATOR = "puckworks-tools fixtures"

#: Result keys, in the order they are written.
RESULT_KEYS = (
    "t_s",
    "released_fraction",
    "analytic_fraction",
    "shell_outer_radii_m",
    "final_profile",
    "max_abs_error",
    "mass_balance_error",
)

#: The fixture cases: (name, keyword arguments of puckcore.simulate_sphere_release).
CASES: tuple[tuple[str, dict[str, Any]], ...] = (
    (
        "boulder_bdf2",
        {
            "radius_m": 150e-6,
            "diffusivity_m2_s": 1e-10,
            "n_shells": 64,
            "t_end_s": 60.0,
            "n_steps": 600,
            "grid": "equal_volume",
            "scheme": "bdf2",
        },
    ),
    (
        "fines_cn",
        {
            "radius_m": 20e-6,
            "diffusivity_m2_s": 2e-10,
            "n_shells": 32,
            "t_end_s": 2.0,
            "n_steps": 400,
            "grid": "equal_volume",
            "scheme": "crank_nicolson",
        },
    ),
    (
        "uniform_be",
        {
            "radius_m": 250e-6,
            "diffusivity_m2_s": 6.25e-10,
            "n_shells": 48,
            "t_end_s": 30.0,
            "n_steps": 300,
            "grid": "uniform_radius",
            "scheme": "backward_euler",
        },
    ),
)


def import_puckcore() -> ModuleType:
    """Imports the puckcore extension, with an actionable message if it is missing."""
    try:
        import puckcore
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise RuntimeError(
            "the puckcore Python extension is not installed; build it with "
            "`pip install ./crates/puckcore-py` (or `maturin develop -m crates/puckcore-py/Cargo.toml`)"
        ) from exc
    return puckcore


def _floats(value: Any) -> Any:
    if isinstance(value, list):
        return [float(x) for x in value]
    return float(value)


def generate(core: ModuleType | None = None) -> dict[str, Any]:
    """Runs every case through the core and returns the fixture document."""
    core = core or import_puckcore()
    cases = []
    for name, params in CASES:
        raw = core.simulate_sphere_release(**params)
        missing = [key for key in RESULT_KEYS if key not in raw]
        if missing:
            raise RuntimeError(f"puckcore result for {name!r} lacks keys {missing}")
        result = {key: _floats(raw[key]) for key in RESULT_KEYS}
        cases.append({"name": name, "params": dict(params), "result": result})
    return {"schema": SCHEMA, "core_version": core.__version__, "generator": GENERATOR, "cases": cases}


def dumps(document: Mapping[str, Any]) -> str:
    """Serialises the fixture: two-space indent, round-trip floats, final newline."""
    return json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def write(path: Path, document: Mapping[str, Any] | None = None) -> Path:
    """Writes the fixture (generated now unless ``document`` is given) to ``path``."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(document if document is not None else generate()), encoding="utf-8")
    return path


@dataclass
class Comparison:
    """Outcome of comparing a committed fixture with a freshly generated one."""

    problems: list[str] = field(default_factory=list)
    max_abs_diff: float = 0.0
    max_rel_diff: float = 0.0
    where: str | None = None
    values_compared: int = 0
    tolerance: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.problems and self.max_abs_diff <= self.tolerance

    def summary(self) -> str:
        if self.problems:
            return "; ".join(self.problems)
        text = f"max |difference| = {self.max_abs_diff:.3g} over {self.values_compared} values"
        if self.where is not None and self.max_abs_diff > 0:
            text += f" (at {self.where}, relative {self.max_rel_diff:.3g})"
        return text


def _compare(expected: Any, actual: Any, path: str, numeric: bool, out: Comparison) -> None:
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping):
            out.problems.append(f"{path or 'document'}: expected an object")
            return
        if list(expected) != list(actual):
            out.problems.append(f"{path or 'document'}: keys differ ({list(expected)} vs {list(actual)})")
            return
        for key in expected:
            child = f"{path}.{key}" if path else key
            _compare(expected[key], actual[key], child, numeric or key == "result", out)
        return
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) != len(actual):
            got = len(actual) if isinstance(actual, list) else type(actual).__name__
            out.problems.append(f"{path}: expected a list of {len(expected)} items, got {got}")
            return
        for index, (e, a) in enumerate(zip(expected, actual)):
            if isinstance(e, Mapping) and "name" in e:
                child = f"{path}[{e['name']}]"
            else:
                child = f"{path}[{index}]"
            _compare(e, a, child, numeric, out)
        return
    is_number = isinstance(expected, (int, float)) and not isinstance(expected, bool)
    if numeric and is_number and isinstance(actual, (int, float)) and not isinstance(actual, bool):
        out.values_compared += 1
        diff = abs(float(actual) - float(expected))
        if math.isnan(diff):
            out.problems.append(f"{path}: NaN")
            return
        if diff > out.max_abs_diff:
            scale = max(abs(float(actual)), abs(float(expected)))
            out.max_abs_diff = diff
            out.max_rel_diff = diff / scale if scale > 0 else 0.0
            out.where = path
        return
    if expected != actual or type(expected) is not type(actual):
        out.problems.append(f"{path}: committed {expected!r}, current build gives {actual!r}")


def compare(expected: Mapping[str, Any], actual: Mapping[str, Any], tolerance: float = 0.0) -> Comparison:
    """Compares two fixture documents.

    Metadata and parameters must match exactly; result numbers may differ by at
    most ``tolerance`` (absolute). The maximum difference is always reported.
    """
    out = Comparison(tolerance=tolerance)
    _compare(expected, actual, "", False, out)
    return out


def check(path: Path, tolerance: float = 0.0, core: ModuleType | None = None) -> Comparison:
    """Regenerates the fixture in memory and compares it with the file at ``path``."""
    path = Path(path)
    if not path.is_file():
        out = Comparison(tolerance=tolerance)
        out.problems.append(f"{path} does not exist; generate it with `puckworks-tools fixtures`")
        return out
    committed = json.loads(path.read_text(encoding="utf-8"))
    return compare(committed, generate(core), tolerance)
