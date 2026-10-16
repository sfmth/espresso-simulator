# SPDX-License-Identifier: GPL-2.0-or-later
"""Dataset sidecars (data/datasets/<id>/dataset.yaml): validation.

Checks, for every dataset folder:

- the sidecar is valid against data/schema/dataset.schema.json and its id
  equals the folder name;
- the licensing rules of docs/PLAN.md §11: non-commercial (NC) licences are
  never bundled (redistribution must be ``forbidden`` and no data files ship);
  ``facts-cited`` data are ``cite-only``;
- the DOI syntax and research-note references;
- every listed file exists inside the folder, and each CSV file has exactly
  the declared columns, typed values, and units from the unit vocabulary.
"""

from __future__ import annotations

import csv
import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import jsonschema
import yaml

from .notes import NoteIndex
from .paths import RepoPaths
from .registry import Issue, _format_schema_error, check_doi
from .units import UnitVocabulary, load_units
from .yamlio import load_yaml

SIDECAR = "dataset.yaml"


@dataclass
class DatasetReport:
    """Result of validating the dataset folders."""

    datasets: list[str] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.issues


def _check_licence(meta: Mapping[str, Any]) -> list[str]:
    problems = []
    licence, redistribution = meta["licence"], meta["redistribution"]
    if "NC" in licence.upper().split("-"):
        if redistribution != "forbidden":
            problems.append(
                f"licence {licence} is non-commercial: redistribution must be 'forbidden' (PLAN §11)"
            )
        if meta["files"]:
            problems.append(f"licence {licence} is non-commercial: no data files may be bundled (PLAN §11)")
    if licence == "facts-cited" and redistribution != "cite-only":
        problems.append("licence 'facts-cited' requires redistribution 'cite-only'")
    if redistribution == "forbidden" and meta["files"]:
        problems.append("redistribution is 'forbidden', so no data files may be bundled")
    return problems


def _parse_number(text: str, integer: bool) -> float | None:
    try:
        value = int(text) if integer else float(text)
    except ValueError:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _check_csv(path: Path, columns: list[Mapping[str, Any]], units: UnitVocabulary) -> list[str]:
    problems: list[str] = []
    names = [column["name"] for column in columns]
    with open(path, encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle))
    if not rows:
        return [f"{path.name}: the file is empty"]
    header, body = rows[0], rows[1:]
    if header != names:
        return [f"{path.name}: header {header} does not match the declared columns {names}"]
    if not body:
        problems.append(f"{path.name}: no data rows")
    for line, row in enumerate(body, start=2):
        if len(row) != len(names):
            problems.append(f"{path.name}:{line}: {len(row)} fields, expected {len(names)}")
            continue
        cells = dict(zip(names, row))
        for column in columns:
            name, text = column["name"], cells[column["name"]]
            if text == "":
                if column.get("required", True):
                    problems.append(f"{path.name}:{line}: column {name} is empty")
                continue
            if column["type"] in ("number", "integer"):
                if _parse_number(text, column["type"] == "integer") is None:
                    problems.append(f"{path.name}:{line}: column {name}: {text!r} is not a valid {column['type']}")
                units_column = column.get("units_column")
                if units_column and not units.is_known(cells.get(units_column, "")):
                    problems.append(
                        f"{path.name}:{line}: column {name}: unit {cells.get(units_column, '')!r} "
                        f"(from column {units_column}) is not in the unit vocabulary"
                    )
    return problems


def _check_columns(columns: list[Mapping[str, Any]], units: UnitVocabulary) -> list[str]:
    problems: list[str] = []
    names = [column["name"] for column in columns]
    if len(set(names)) != len(names):
        problems.append("columns: names must be unique")
    by_name = {column["name"]: column for column in columns}
    for column in columns:
        if "units" in column and not units.is_known(column["units"]):
            problems.append(f"columns.{column['name']}: unknown unit {column['units']!r}")
        ref = column.get("units_column")
        if ref is not None and (ref not in by_name or by_name[ref]["type"] != "string"):
            problems.append(f"columns.{column['name']}: units_column {ref!r} must name a string column")
    return problems


def validate_dataset(
    folder: Path,
    *,
    validator: jsonschema.protocols.Validator,
    units: UnitVocabulary,
    notes: NoteIndex,
    location: str,
) -> list[Issue]:
    """Problems of one dataset folder."""
    sidecar = folder / SIDECAR
    if not sidecar.is_file():
        return [Issue(location, None, f"missing {SIDECAR}")]
    try:
        meta = load_yaml(sidecar)
    except (OSError, yaml.YAMLError) as exc:
        return [Issue(location, None, f"cannot read {SIDECAR}: {exc}")]
    errors = list(validator.iter_errors(meta))
    if errors:
        return [Issue(location, None, f"schema: {_format_schema_error(e)}") for e in errors]
    did = meta["id"]
    problems: list[str] = []
    if did != folder.name:
        problems.append(f"id {did!r} must equal the folder name {folder.name!r}")
    problems += _check_licence(meta)
    if "doi" in meta:
        message = check_doi(meta["doi"])
        if message:
            problems.append(f"doi: {message}")
    refs = meta.get("research_note_ref", [])
    for ref in [refs] if isinstance(refs, str) else refs:
        message = notes.check(ref)
        if message:
            problems.append(message)
    problems += _check_columns(meta["columns"], units)
    for entry in meta["files"]:
        path = folder / entry["path"]
        if not path.is_file():
            problems.append(f"files: {entry['path']} does not exist")
        elif entry["format"] == "csv":
            problems += _check_csv(path, meta["columns"], units)
    return [Issue(location, did, problem) for problem in problems]


def validate_datasets(
    datasets_dir: Path,
    *,
    schema: Mapping[str, Any],
    units: UnitVocabulary,
    notes: NoteIndex,
    paths: RepoPaths | None = None,
) -> DatasetReport:
    """Validates every folder in ``datasets_dir`` (loose files such as README.md are ignored)."""
    report = DatasetReport()
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    if not Path(datasets_dir).is_dir():
        location = paths.relative(Path(datasets_dir)) if paths else str(datasets_dir)
        report.issues.append(Issue(location, None, "the datasets folder does not exist"))
        return report
    for folder in sorted(p for p in Path(datasets_dir).iterdir() if p.is_dir()):
        location = paths.relative(folder) if paths else str(folder)
        report.datasets.append(folder.name)
        report.issues.extend(
            validate_dataset(folder, validator=validator, units=units, notes=notes, location=location)
        )
    return report


def validate_repo_datasets(paths: RepoPaths) -> DatasetReport:
    """Validates the dataset folders of the repository at ``paths.root``."""
    schema = json.loads(paths.dataset_schema.read_text(encoding="utf-8"))
    return validate_datasets(
        paths.datasets_dir,
        schema=schema,
        units=load_units(paths.units),
        notes=NoteIndex(paths.notes_dir),
        paths=paths,
    )
