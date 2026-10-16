# SPDX-License-Identifier: GPL-2.0-or-later
"""The unit vocabulary of data/schema/units.yaml.

Every unit string used by the registry and the dataset sidecars must be listed
in the vocabulary, with its SI dimension exponents and SI scale factor. The
vocabulary is machine-checked: each listed unit is re-derived from its
spelling (atoms, prefixes, ``*``, one ``/`` and ``^`` exponents) and must match
the declared dimensions and scale.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .yamlio import load_yaml

VOCABULARY_SCHEMA = "puckworks.units/1"

_FACTOR = re.compile(r"^(?P<symbol>[A-Za-z%1]+)(?:\^(?P<exponent>[-+]?[0-9]+))?$")


class UnitError(ValueError):
    """An invalid unit expression or an impossible conversion."""


@dataclass(frozen=True)
class Unit:
    """A unit: SI dimension exponents, SI scale factor and (for degC) offset.

    A value ``x`` in this unit is ``scale * x + offset`` in SI units.
    """

    dims: tuple[int, ...]
    scale: float
    offset: float = 0.0


@dataclass(frozen=True)
class _Atom:
    dims: tuple[int, ...]
    scale: float
    offset: float = 0.0
    prefixable: bool = False


@dataclass
class UnitVocabulary:
    """Parsed units.yaml."""

    base_dimensions: tuple[str, ...]
    prefixes: dict[str, float]
    atoms: dict[str, _Atom]
    units: dict[str, Unit]
    descriptions: dict[str, str] = field(default_factory=dict)
    load_errors: list[str] = field(default_factory=list)
    source: str = "units.yaml"

    # -- lookup -------------------------------------------------------------

    def is_known(self, unit: str) -> bool:
        """Whether ``unit`` is listed in the vocabulary."""
        return unit in self.units

    def get(self, unit: str) -> Unit:
        """The listed unit ``unit``; raises UnitError if it is not listed."""
        try:
            return self.units[unit]
        except KeyError:
            raise UnitError(f"unknown unit {unit!r}") from None

    # -- parsing --------------------------------------------------------------

    def _resolve(self, symbol: str) -> tuple[_Atom, float]:
        if symbol in self.atoms:
            return self.atoms[symbol], 1.0
        for prefix in sorted(self.prefixes, key=len, reverse=True):
            rest = symbol[len(prefix) :]
            if symbol.startswith(prefix) and rest in self.atoms and self.atoms[rest].prefixable:
                return self.atoms[rest], self.prefixes[prefix]
        raise UnitError(f"unknown unit symbol {symbol!r}")

    def parse(self, expression: str) -> Unit:
        """Derives dimensions and scale of ``expression`` from its spelling."""
        if not expression or expression != expression.strip() or " " in expression:
            raise UnitError(f"unit {expression!r} must be non-empty and contain no spaces")
        numerator, slash, denominator = expression.partition("/")
        if slash and (not denominator or "/" in denominator):
            raise UnitError(f"unit {expression!r}: use at most one '/' with a denominator after it")
        if not numerator:
            raise UnitError(f"unit {expression!r} has an empty numerator (write '1/s' or 's^-1')")
        dims = [0] * len(self.base_dimensions)
        scale = 1.0
        offset = 0.0
        factors = [(token, 1) for token in numerator.split("*")]
        if slash:
            factors += [(token, -1) for token in denominator.split("*")]
        for token, sign in factors:
            match = _FACTOR.match(token)
            if match is None:
                raise UnitError(f"unit {expression!r}: cannot parse factor {token!r}")
            atom, prefix_scale = self._resolve(match["symbol"])
            exponent = sign * int(match["exponent"] or 1)
            if atom.offset:
                if len(factors) != 1 or exponent != 1:
                    raise UnitError(f"unit {expression!r}: an affine unit cannot be combined")
                offset = atom.offset
            for i, d in enumerate(atom.dims):
                dims[i] += d * exponent
            scale *= (atom.scale * prefix_scale) ** exponent
        return Unit(tuple(dims), scale, offset)

    # -- checks and conversion ----------------------------------------------

    def check(self) -> list[str]:
        """Problems in the vocabulary: listed units that do not match their spelling."""
        problems = list(self.load_errors)
        for name, unit in self.units.items():
            try:
                derived = self.parse(name)
            except UnitError as exc:
                problems.append(f"units.{name}: {exc}")
                continue
            if derived.dims != unit.dims:
                problems.append(
                    f"units.{name}: declared dimensions {self.format_dims(unit.dims)} but its "
                    f"spelling gives {self.format_dims(derived.dims)}"
                )
            if not math.isclose(derived.scale, unit.scale, rel_tol=1e-12):
                problems.append(
                    f"units.{name}: declared scale {unit.scale!r} but its spelling gives {derived.scale!r}"
                )
            if not math.isclose(derived.offset, unit.offset, rel_tol=0.0, abs_tol=1e-12):
                problems.append(
                    f"units.{name}: declared offset {unit.offset!r} but its spelling gives {derived.offset!r}"
                )
        return problems

    def convert(self, value: float, from_unit: str, to_unit: str) -> float:
        """Converts ``value`` between two listed units of the same dimension."""
        source, target = self.get(from_unit), self.get(to_unit)
        if source.dims != target.dims:
            raise UnitError(
                f"cannot convert {from_unit!r} ({self.format_dims(source.dims)}) to "
                f"{to_unit!r} ({self.format_dims(target.dims)})"
            )
        si = value * source.scale + source.offset
        return (si - target.offset) / target.scale

    def format_dims(self, dims: tuple[int, ...]) -> str:
        """Human-readable dimension exponents, e.g. ``kg m^-3``."""
        parts = [
            name if power == 1 else f"{name}^{power}"
            for name, power in zip(self.base_dimensions, dims)
            if power
        ]
        return " ".join(parts) or "dimensionless"


def _dims(spec: Any, base: tuple[str, ...], where: str, errors: list[str]) -> tuple[int, ...]:
    if not isinstance(spec, Mapping):
        errors.append(f"{where}: dims must be a mapping of base dimension to exponent")
        return (0,) * len(base)
    out = [0] * len(base)
    for name, power in spec.items():
        if name not in base:
            errors.append(f"{where}: unknown base dimension {name!r}")
        elif not isinstance(power, int) or isinstance(power, bool):
            errors.append(f"{where}: exponent of {name!r} must be an integer")
        else:
            out[base.index(name)] = power
    return tuple(out)


def _number(spec: Mapping[str, Any], key: str, default: float | None, where: str, errors: list[str]) -> float:
    raw = spec.get(key, default)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
        errors.append(f"{where}: {key} must be a finite number")
        return 1.0 if default is None else float(default)
    return float(raw)


def load_units(path: Path | str) -> UnitVocabulary:
    """Loads units.yaml. Structural problems are recorded in ``load_errors``."""
    doc = load_yaml(path)
    errors: list[str] = []
    if not isinstance(doc, Mapping):
        raise UnitError(f"{path}: expected a mapping at the top level")
    if doc.get("schema") != VOCABULARY_SCHEMA:
        errors.append(f"schema must be {VOCABULARY_SCHEMA!r}")
    base = tuple(doc.get("base_dimensions") or ())
    if not base or not all(isinstance(b, str) for b in base):
        raise UnitError(f"{path}: base_dimensions must be a non-empty list of names")
    prefixes: dict[str, float] = {}
    for name, factor in (doc.get("prefixes") or {}).items():
        if isinstance(factor, bool) or not isinstance(factor, (int, float)) or factor <= 0:
            errors.append(f"prefixes.{name}: must be a positive number")
        else:
            prefixes[str(name)] = float(factor)
    atoms: dict[str, _Atom] = {}
    for name, spec in (doc.get("atoms") or {}).items():
        where = f"atoms.{name}"
        if not isinstance(spec, Mapping):
            errors.append(f"{where}: must be a mapping")
            continue
        atoms[str(name)] = _Atom(
            dims=_dims(spec.get("dims", {}), base, where, errors),
            scale=_number(spec, "scale", None, where, errors),
            offset=_number(spec, "offset", 0.0, where, errors),
            prefixable=bool(spec.get("prefixable", False)),
        )
    units: dict[str, Unit] = {}
    descriptions: dict[str, str] = {}
    for name, spec in (doc.get("units") or {}).items():
        where = f"units.{name}"
        if not isinstance(spec, Mapping):
            errors.append(f"{where}: must be a mapping")
            continue
        units[str(name)] = Unit(
            dims=_dims(spec.get("dims", {}), base, where, errors),
            scale=_number(spec, "scale", None, where, errors),
            offset=_number(spec, "offset", 0.0, where, errors),
        )
        if isinstance(spec.get("description"), str):
            descriptions[str(name)] = spec["description"]
    if not units:
        errors.append("units: the vocabulary lists no units")
    return UnitVocabulary(base, prefixes, atoms, units, descriptions, errors, str(path))
