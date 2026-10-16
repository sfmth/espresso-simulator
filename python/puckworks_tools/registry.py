# SPDX-License-Identifier: GPL-2.0-or-later
"""The parameter registry (docs/PLAN.md §7.3, module R): loading and validation.

Registry files are ``data/params/*.yaml``::

    schema: puckworks.parameters/1
    description: ...        # optional
    parameters:
      - id: hydraulics.permeability.in_shot
        ...

Checks:

- every record is valid against data/schema/parameter.schema.json;
- ids are unique and form a tree (no id is a dotted prefix of another);
- units are listed in data/schema/units.yaml;
- the value lies inside the range, and the prior is consistent with the range
  (bounded support inside it; central value inside it and at least 95% of the
  probability inside it for unbounded priors) and with the value;
- DOIs have valid syntax;
- research-note references point to an existing note and heading;
- every id in a record's ``relation.derived_from`` exists (and is not the
  record itself); the schema requires a ``relation`` for derived records.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from statistics import NormalDist
from typing import Any

import jsonschema
import jsonschema.exceptions
import yaml

from .notes import NoteIndex
from .paths import RepoPaths
from .units import UnitVocabulary, load_units
from .yamlio import load_yaml

FILE_SCHEMA = "puckworks.parameters/1"
_FILE_KEYS = {"schema", "description", "parameters"}

#: Minimum share of an unbounded prior's probability that must lie inside the range.
MIN_PRIOR_MASS_IN_RANGE = 0.95

_DOI = re.compile(r"^10\.[0-9]{4,9}(?:\.[0-9]+)*/\S+$")


class RegistryError(RuntimeError):
    """Raised by :func:`load_registry` when the registry does not validate."""


def check_doi(doi: str) -> str | None:
    """None if ``doi`` is a syntactically valid bare DOI, otherwise the problem."""
    lowered = doi.strip().lower()
    if lowered.startswith(("doi:", "http://", "https://", "doi.org/", "dx.doi.org/")):
        return f"{doi!r}: write the bare DOI (e.g. 10.3390/foods12152871), without a 'doi:' or URL prefix"
    if doi != doi.strip() or not _DOI.match(doi):
        return f"{doi!r} is not valid DOI syntax (10.<registrant>/<suffix>, no spaces)"
    if doi[-1] in ".,;:":
        return f"{doi!r} ends with punctuation; a DOI does not"
    return None


@dataclass(frozen=True)
class Issue:
    """One validation problem."""

    location: str
    record_id: str | None
    message: str

    def __str__(self) -> str:
        where = self.location if self.record_id is None else f"{self.location}: {self.record_id}"
        return f"{where}: {self.message}"


@dataclass
class RegistryReport:
    """Result of validating the registry."""

    files: list[Path] = field(default_factory=list)
    records: list[dict[str, Any]] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.issues

    @property
    def ids(self) -> list[str]:
        return [record["id"] for record in self.records]


# -- priors -----------------------------------------------------------------


def _fmt(x: float) -> str:
    return f"{x:g}"


def _fmt_range(lo: float, hi: float) -> str:
    left = "-inf" if lo == -math.inf else _fmt(lo)
    right = "inf" if hi == math.inf else _fmt(hi)
    return f"[{left}, {right}]"


def lognormal_parameters(prior: Mapping[str, Any]) -> tuple[float, float]:
    """(mu, sigma) of ln X for a lognormal prior in either parameterisation."""
    if "median" in prior:
        return math.log(prior["median"]), math.log(prior["gsd"])
    lower, upper, coverage = prior["lower"], prior["upper"], prior["coverage"]
    z = NormalDist().inv_cdf(0.5 + coverage / 2.0)
    mu = 0.5 * (math.log(lower) + math.log(upper))
    sigma = (math.log(upper) - math.log(lower)) / (2.0 * z)
    return mu, sigma


def _triangular_cdf(x: float, a: float, c: float, b: float) -> float:
    if x <= a:
        return 0.0
    if x >= b:
        return 1.0
    if x <= c:
        return (x - a) ** 2 / ((b - a) * (c - a))
    return 1.0 - (b - x) ** 2 / ((b - a) * (b - c))


def prior_mass_inside(prior: Mapping[str, Any], lo: float, hi: float) -> float:
    """Probability that the prior assigns to [lo, hi]."""
    kind = prior["distribution"]
    if kind == "fixed":
        return 1.0 if lo <= prior["value"] <= hi else 0.0
    if kind == "uniform":
        a, b = prior["min"], prior["max"]
        if not a < b:
            return 0.0
        return max(0.0, min(b, hi) - max(a, lo)) / (b - a)
    if kind == "triangular":
        a, c, b = prior["min"], prior["mode"], prior["max"]
        if not (a <= c <= b and a < b):
            return 0.0
        return _triangular_cdf(min(hi, b), a, c, b) - _triangular_cdf(max(lo, a), a, c, b)
    if kind == "normal":
        dist = NormalDist(prior["mean"], prior["sd"])
        upper = 1.0 if hi == math.inf else dist.cdf(hi)
        lower = 0.0 if lo == -math.inf else dist.cdf(lo)
        return upper - lower
    if kind == "lognormal":
        mu, sigma = lognormal_parameters(prior)
        if sigma <= 0:
            return 0.0
        dist = NormalDist(mu, sigma)
        upper = 1.0 if hi == math.inf else (dist.cdf(math.log(hi)) if hi > 0 else 0.0)
        lower = 0.0 if lo <= 0 else dist.cdf(math.log(lo))
        return upper - lower
    raise ValueError(f"unknown distribution {kind!r}")


def check_prior(prior: Mapping[str, Any], value: float | None, lo: float, hi: float) -> list[str]:
    """Problems with a schema-valid prior, given the record's value and range."""
    problems: list[str] = []
    kind = prior["distribution"]
    rng = _fmt_range(lo, hi)

    def inside(x: float) -> bool:
        return lo <= x <= hi

    if kind == "fixed":
        v = prior["value"]
        if not inside(v):
            problems.append(f"prior: fixed value {_fmt(v)} is outside range {rng}")
        if value is not None and not math.isclose(v, value, rel_tol=1e-12, abs_tol=0.0):
            problems.append(f"prior: fixed value {_fmt(v)} differs from value {_fmt(value)}")
        return problems
    if kind in ("uniform", "triangular"):
        a, b = prior["min"], prior["max"]
        if kind == "triangular":
            c = prior["mode"]
            if not (a <= c <= b and a < b):
                problems.append(
                    f"prior: triangular needs min <= mode <= max and min < max "
                    f"(got {_fmt(a)}, {_fmt(c)}, {_fmt(b)})"
                )
                return problems
        elif not a < b:
            problems.append(f"prior: uniform needs min < max (got {_fmt(a)}, {_fmt(b)})")
            return problems
        if not (inside(a) and inside(b)):
            problems.append(f"prior: {kind} support [{_fmt(a)}, {_fmt(b)}] is not inside range {rng}")
        if value is not None and not a <= value <= b:
            problems.append(
                f"value {_fmt(value)} is outside the {kind} prior's support [{_fmt(a)}, {_fmt(b)}]"
            )
        return problems
    if kind == "normal":
        centre, label = prior["mean"], "mean"
    elif "median" in prior:
        centre, label = prior["median"], "median"
    else:
        a, b = prior["lower"], prior["upper"]
        if not a < b:
            problems.append(f"prior: lognormal interval needs lower < upper (got {_fmt(a)}, {_fmt(b)})")
            return problems
        if not (inside(a) and inside(b)):
            problems.append(f"prior: lognormal interval [{_fmt(a)}, {_fmt(b)}] is not inside range {rng}")
            return problems
        centre, label = math.sqrt(a * b), "median"
    if not inside(centre):
        problems.append(f"prior: {kind} {label} {_fmt(centre)} is outside range {rng}")
        return problems
    mass = prior_mass_inside(prior, lo, hi)
    if mass < MIN_PRIOR_MASS_IN_RANGE:
        problems.append(
            f"prior: only {mass:.1%} of the {kind} prior lies inside range {rng} "
            f"(at least {MIN_PRIOR_MASS_IN_RANGE:.0%} required)"
        )
    return problems


# -- records ------------------------------------------------------------------


def _note_refs(record: Mapping[str, Any]) -> list[str]:
    refs = record["research_note_ref"]
    return [refs] if isinstance(refs, str) else list(refs)


def check_record(record: Mapping[str, Any], units: UnitVocabulary, notes: NoteIndex) -> list[str]:
    """Cross-field problems of one schema-valid record."""
    problems: list[str] = []
    unit = record["units"]
    if not units.is_known(unit):
        problems.append(f"unknown unit {unit!r} (not listed in data/schema/units.yaml)")
    rng = record["range"]
    lo = rng.get("min", -math.inf)
    hi = rng.get("max", math.inf)
    if lo > hi:
        problems.append(f"range: min {_fmt(lo)} is greater than max {_fmt(hi)}")
        return problems
    value = record.get("value")
    if value is not None and not lo <= value <= hi:
        problems.append(f"value {_fmt(value)} is outside range {_fmt_range(lo, hi)}")
    if "prior" in record:
        problems.extend(check_prior(record["prior"], value, lo, hi))
    for index, source in enumerate(record["sources"]):
        if "doi" in source:
            message = check_doi(source["doi"])
            if message:
                problems.append(f"sources[{index}].doi: {message}")
    for ref in _note_refs(record):
        message = notes.check(ref)
        if message:
            problems.append(message)
    return problems


def _format_schema_error(error: jsonschema.exceptions.ValidationError) -> str:
    path = ""
    for part in error.absolute_path:
        path += f"[{part}]" if isinstance(part, int) else f".{part}"
    path = path.lstrip(".")
    if error.validator == "anyOf" and list(error.schema_path) == ["anyOf"]:
        message = "needs a `value`, a `prior` or both"
    elif error.validator in ("oneOf", "anyOf") and error.context:
        best = jsonschema.exceptions.best_match(error.context)
        message = best.message if best is not None else error.message
    else:
        message = error.message
    return f"{path}: {message}" if path else message


def _wrapper_records(doc: Any, location: str, issues: list[Issue]) -> list[Any]:
    if not isinstance(doc, Mapping):
        issues.append(Issue(location, None, "top level must be a mapping with `schema` and `parameters`"))
        return []
    unknown = sorted(set(doc) - _FILE_KEYS)
    if unknown:
        issues.append(Issue(location, None, f"unknown top-level keys: {', '.join(map(str, unknown))}"))
    if doc.get("schema") != FILE_SCHEMA:
        issues.append(Issue(location, None, f"`schema` must be {FILE_SCHEMA!r}"))
    if "description" in doc and not isinstance(doc["description"], str):
        issues.append(Issue(location, None, "`description` must be a string"))
    records = doc.get("parameters")
    if not isinstance(records, list) or not records:
        issues.append(Issue(location, None, "`parameters` must be a non-empty list"))
        return []
    return records


def _relation_issues(entries: Iterable[tuple[str, Mapping[str, Any]]], ids: set[str]) -> Iterable[Issue]:
    for location, record in entries:
        for ref in record.get("relation", {}).get("derived_from", []):
            if ref == record["id"]:
                yield Issue(location, record["id"], "relation.derived_from lists the record's own id")
            elif ref not in ids:
                yield Issue(location, record["id"], f"relation.derived_from: unknown id {ref!r}")


def _id_tree_issues(locations: Mapping[str, str]) -> Iterable[Issue]:
    for rid in sorted(locations):
        parts = rid.split(".")
        for i in range(1, len(parts)):
            prefix = ".".join(parts[:i])
            if prefix in locations:
                yield Issue(
                    locations[rid],
                    rid,
                    f"id {prefix!r} (in {locations[prefix]}) is a prefix of this id; ids must "
                    "form a tree with parameters only at the leaves",
                )


def validate_registry(
    params_dir: Path,
    *,
    schema: Mapping[str, Any],
    units: UnitVocabulary,
    notes: NoteIndex,
    paths: RepoPaths | None = None,
) -> RegistryReport:
    """Validates every ``*.yaml`` file in ``params_dir``."""
    report = RegistryReport()

    def where(path: Path) -> str:
        return paths.relative(path) if paths else str(path)

    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    files = sorted(Path(params_dir).glob("*.yaml"))
    if not files:
        report.issues.append(Issue(where(Path(params_dir)), None, "no parameter files (*.yaml)"))
        return report
    for problem in units.check():
        report.issues.append(Issue(where(Path(units.source)), None, problem))
    locations: dict[str, str] = {}
    valid: list[tuple[str, Mapping[str, Any]]] = []
    for path in files:
        location = where(path)
        report.files.append(path)
        try:
            doc = load_yaml(path)
        except (OSError, yaml.YAMLError) as exc:
            report.issues.append(Issue(location, None, f"cannot read YAML: {exc}"))
            continue
        for index, record in enumerate(_wrapper_records(doc, location, report.issues)):
            rid = record.get("id") if isinstance(record, Mapping) else None
            label = rid if isinstance(rid, str) else f"parameters[{index}]"
            errors = sorted(validator.iter_errors(record), key=lambda e: list(map(str, e.absolute_path)))
            if errors:
                report.issues.extend(Issue(location, label, f"schema: {_format_schema_error(e)}") for e in errors)
                continue
            report.records.append(dict(record))
            valid.append((location, record))
            if rid in locations:
                report.issues.append(Issue(location, rid, f"duplicate id (first defined in {locations[rid]})"))
            else:
                locations[rid] = location
            report.issues.extend(Issue(location, rid, m) for m in check_record(record, units, notes))
    report.issues.extend(_id_tree_issues(locations))
    report.issues.extend(_relation_issues(valid, set(locations)))
    return report


def validate_repo_registry(paths: RepoPaths) -> RegistryReport:
    """Validates the registry of the repository at ``paths.root``."""
    schema = json.loads(paths.parameter_schema.read_text(encoding="utf-8"))
    return validate_registry(
        paths.params_dir,
        schema=schema,
        units=load_units(paths.units),
        notes=NoteIndex(paths.notes_dir),
        paths=paths,
    )


def load_registry(paths: RepoPaths) -> dict[str, dict[str, Any]]:
    """All records by id; raises RegistryError if the registry does not validate."""
    report = validate_repo_registry(paths)
    if not report.ok:
        details = "\n".join(f"  {issue}" for issue in report.issues)
        raise RegistryError(f"the parameter registry has {len(report.issues)} problem(s):\n{details}")
    return {record["id"]: record for record in report.records}
