# SPDX-License-Identifier: GPL-2.0-or-later
"""Export of presets and the parameter registry for the model crate.

``python -m puckworks_tools.export [--check] [--root PATH]`` reads

- ``data/presets/**/*.yaml``: preset files, validated against
  ``data/schema/preset.schema.json`` plus cross-reference checks;
- ``data/params/*.yaml``: the parameter registry, validated as by
  ``puckworks-tools validate-registry``;
- ``data/calibration/current.yaml`` if it exists: calibrated values that
  replace registry defaults (``schema: puckworks.calibration/1``,
  ``parameters: {<registry id>: <value>}``),

and writes the two documents that ``crates/puckmodel`` embeds at build time
(docs/model/m1-contract.md, ADR 0008):

- ``crates/puckmodel/generated/presets.json``: ``puckworks.presets/1``;
- ``crates/puckmodel/generated/registry.json``: ``puckworks.registry/1``.

A calibration of an id the input models never read
(``crates/puckmodel/registry-reads.txt``) would be silently ignored, so it is
refused unless ``--allow-unused-calibration`` is given (then it is reported
as a warning and listed under ``calibration.unused_by_builder``). Every id in
that list must exist in the registry.

Each registry record keeps its provenance (sources, grade, tag, conditions,
relation, note references) and gains ``default``, the number the model uses,
and ``default_from``: ``"value"``, ``"prior"`` (the prior's central value:
uniform midpoint, normal mean, lognormal median, triangular mode, fixed value)
or ``"calibration"``. Long ``comment`` fields are left out to keep the
embedded JSON (and the WebAssembly module) lean; they stay in the YAML.

The JSON is written one record per line, so diffs stay readable.
``--check`` regenerates both documents in memory and fails (exit 1) if the
committed files differ. Exit status: 0 success, 1 a check or validation
failed, 2 a setup problem. ``main(argv)`` is the entry point for the
``puckworks-tools export`` subcommand.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import jsonschema
import yaml

from .paths import RepoNotFoundError, RepoPaths, find_repo_root
from .registry import validate_repo_registry
from .yamlio import load_yaml

PRESETS_SCHEMA = "puckworks.presets/1"
REGISTRY_SCHEMA = "puckworks.registry/1"
PRESET_FILE_SCHEMA = "puckworks.preset-file/1"
CALIBRATION_SCHEMA = "puckworks.calibration/1"

#: Preset kind → list name in the presets document, in output order.
KIND_LISTS: dict[str, str] = {
    "grinder_family": "grinder_families",
    "grinder": "grinders",
    "basket": "baskets",
    "machine": "machines",
    "bean": "beans",
}

#: Registry record fields copied into the export, in this order. ``comment``
#: is deliberately left out (long; stays in the YAML).
REGISTRY_FIELDS: tuple[str, ...] = (
    "id",
    "name",
    "symbol",
    "description",
    "units",
    "value",
    "prior",
    "range",
    "relation",
    "conditions",
    "tag",
    "evidence_grade",
    "sources",
    "research_note_ref",
    "used_by",
    "status",
    "licence_note",
)


class ExportError(RuntimeError):
    """The inputs do not validate; ``problems`` lists every problem found."""

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = list(problems)
        super().__init__(f"{len(self.problems)} problem(s):\n" + "\n".join(f"  {p}" for p in self.problems))


@dataclass
class Documents:
    """The two generated documents."""

    presets: dict[str, Any]
    registry: dict[str, Any]
    preset_files: list[Path] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# -- paths ---------------------------------------------------------------------


def presets_dir(paths: RepoPaths) -> Path:
    return paths.root / "data" / "presets"


def preset_schema_path(paths: RepoPaths) -> Path:
    return paths.root / "data" / "schema" / "preset.schema.json"


def calibration_path(paths: RepoPaths) -> Path:
    return paths.root / "data" / "calibration" / "current.yaml"


def registry_reads_path(paths: RepoPaths) -> Path:
    return paths.root / "crates" / "puckmodel" / "registry-reads.txt"


def load_registry_reads(paths: RepoPaths) -> set[str]:
    """The registry ids the input models read (one per line; ``#`` comments)."""
    path = registry_reads_path(paths)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ExportError([f"{paths.relative(path)}: cannot read: {exc}"]) from exc
    return {line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")}


def generated_dir(paths: RepoPaths) -> Path:
    return paths.root / "crates" / "puckmodel" / "generated"


def output_paths(paths: RepoPaths) -> tuple[Path, Path]:
    """(presets.json, registry.json)."""
    out = generated_dir(paths)
    return out / "presets.json", out / "registry.json"


# -- registry ------------------------------------------------------------------


def _clean(x: float) -> float:
    """Rounds a computed number to 12 significant digits, so the JSON stays readable."""
    return float(f"{x:.12g}")


def central_value(record: Mapping[str, Any]) -> tuple[float, str]:
    """The number the model uses for a registry record, and where it came from.

    The record's ``value`` if it has one; otherwise the prior's central value:
    the fixed value, the uniform midpoint, the normal mean, the lognormal
    median or the triangular mode.
    """
    if "value" in record:
        return float(record["value"]), "value"
    prior = record["prior"]
    kind = prior["distribution"]
    if kind == "fixed":
        centre = prior["value"]
    elif kind == "uniform":
        centre = 0.5 * (prior["min"] + prior["max"])
    elif kind == "normal":
        centre = prior["mean"]
    elif kind == "triangular":
        centre = prior["mode"]
    elif kind == "lognormal":
        centre = prior["median"] if "median" in prior else math.sqrt(prior["lower"] * prior["upper"])
    else:  # the schema allows no other distribution
        raise ValueError(f"unknown distribution {kind!r}")
    return _clean(float(centre)), "prior"


def load_calibration(
    path: Path,
    records: Mapping[str, Mapping[str, Any]],
    where: str,
    reads: set[str] | None = None,
    allow_unused: bool = False,
    warnings: list[str] | None = None,
) -> tuple[dict[str, float], dict[str, Any] | None]:
    """Calibrated values by registry id, and metadata for the export; ({}, None) without a file.

    With ``reads`` (the ids the builder reads), calibrating any other id is an
    error, or a warning appended to ``warnings`` when ``allow_unused``.
    """
    if not path.is_file():
        return {}, None
    try:
        doc = load_yaml(path)
    except (OSError, yaml.YAMLError) as exc:
        raise ExportError([f"{where}: cannot read YAML: {exc}"]) from exc
    problems: list[str] = []
    if not isinstance(doc, Mapping):
        raise ExportError([f"{where}: top level must be a mapping with `schema` and `parameters`"])
    if doc.get("schema") != CALIBRATION_SCHEMA:
        problems.append(f"{where}: `schema` must be {CALIBRATION_SCHEMA!r}")
    params = doc.get("parameters")
    values: dict[str, float] = {}
    if not isinstance(params, Mapping):
        problems.append(f"{where}: `parameters` must be a mapping of registry id to value")
        params = {}
    for rid, value in params.items():
        if rid not in records:
            problems.append(f"{where}: parameters.{rid}: unknown registry id {rid!r}")
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            problems.append(f"{where}: parameters.{rid}: value must be a finite number, got {value!r}")
            continue
        rng = records[rid]["range"]
        lo, hi = rng.get("min", -math.inf), rng.get("max", math.inf)
        if not lo <= value <= hi:
            problems.append(
                f"{where}: parameters.{rid}: {value:g} is outside the record's range "
                f"[{lo:g}, {hi:g}] ({records[rid]['units']})"
            )
            continue
        values[rid] = float(value)
    unused = sorted(rid for rid in values if reads is not None and rid not in reads)
    for rid in unused:
        message = (
            f"{where}: parameters.{rid}: the input models do not read this id, so the calibrated value "
            "would be silently ignored (ids they read: crates/puckmodel/registry-reads.txt)"
        )
        if allow_unused:
            if warnings is not None:
                warnings.append(message)
        else:
            problems.append(message + "; pass --allow-unused-calibration to keep it anyway")
    meta: dict[str, Any] = {"source": where, "schema": CALIBRATION_SCHEMA, "parameters": sorted(values)}
    if unused:
        meta["unused_by_builder"] = unused
    for key, value in doc.items():
        if key in ("schema", "parameters"):
            continue
        if isinstance(value, float) and not math.isfinite(value):
            problems.append(f"{where}: {key}: metadata numbers must be finite, got {value!r}")
        elif isinstance(value, (str, int, float, bool)):
            meta[key] = value
    if problems:
        raise ExportError(problems)
    return values, meta


def build_registry(
    paths: RepoPaths, allow_unused_calibration: bool = False, warnings: list[str] | None = None
) -> dict[str, Any]:
    """The ``puckworks.registry/1`` document; raises ExportError if the registry does not validate."""
    report = validate_repo_registry(paths)
    if not report.ok:
        raise ExportError([f"registry: {issue}" for issue in report.issues])
    records = {record["id"]: record for record in report.records}
    reads = load_registry_reads(paths)
    missing = sorted(reads - set(records))
    if missing:
        where = paths.relative(registry_reads_path(paths))
        raise ExportError(
            [f"{where}: lists {rid}, which is not in the registry (the input models would fail)" for rid in missing]
        )
    calibrated, meta = load_calibration(
        calibration_path(paths),
        records,
        paths.relative(calibration_path(paths)),
        reads,
        allow_unused_calibration,
        warnings,
    )
    parameters = []
    for rid in sorted(records):
        record = records[rid]
        out: dict[str, Any] = {key: record[key] for key in REGISTRY_FIELDS if key in record}
        refs = record["research_note_ref"]
        out["research_note_ref"] = [refs] if isinstance(refs, str) else list(refs)
        if rid in calibrated:
            out["default"], out["default_from"] = calibrated[rid], "calibration"
        else:
            out["default"], out["default_from"] = central_value(record)
        parameters.append(out)
    return {"schema": REGISTRY_SCHEMA, "calibration": meta, "parameters": parameters}


# -- presets -------------------------------------------------------------------


def _schema_error(error: jsonschema.exceptions.ValidationError) -> str:
    path = "".join(f"[{p}]" if isinstance(p, int) else f".{p}" for p in error.absolute_path).lstrip(".")
    if error.validator in ("oneOf", "anyOf") and error.context:
        best = jsonschema.exceptions.best_match(error.context)
        message = best.message if best is not None else error.message
    else:
        message = error.message
    return f"{path}: {message}" if path else message


def _non_finite(value: Any, path: str = "") -> list[str]:
    """Paths of NaN or infinite numbers in a nested document."""
    if isinstance(value, float) and not math.isfinite(value):
        return [path or "(value)"]
    if isinstance(value, Mapping):
        return [p for k, v in value.items() for p in _non_finite(v, f"{path}.{k}" if path else str(k))]
    if isinstance(value, list):
        return [p for i, v in enumerate(value) for p in _non_finite(v, f"{path}[{i}]")]
    return []


def _check_basket(preset: Mapping[str, Any]) -> list[str]:
    problems = []
    profile = preset["profile_mm"]
    if profile[0][0] != 0:
        problems.append("profile_mm must start at height 0")
    if any(b[0] <= a[0] for a, b in zip(profile, profile[1:])):
        problems.append("profile_mm heights must strictly increase")
    if preset["perforated_diameter_mm"] > profile[0][1]:
        problems.append("perforated_diameter_mm is larger than the floor diameter (profile_mm[0])")
    lo, hi = preset["dose_range_g"]
    if not lo <= preset["nominal_dose_g"] <= hi:
        problems.append("nominal_dose_g is outside dose_range_g")
    return problems


def _check_machine(preset: Mapping[str, Any], baskets: set[str]) -> list[str]:
    problems = []
    program = preset["program"]
    for index, phase in enumerate(program):
        if phase["control"] in ("pressure", "flow") and "target" not in phase:
            problems.append(f"program[{index}]: a {phase['control']} phase needs a target")
        last = index == len(program) - 1
        if not last and not any(key.startswith("until_") for key in phase):
            problems.append(f"program[{index}]: only the last phase may run without an exit condition")
    if "temperature_range_c" in preset:
        lo, hi = preset["temperature_range_c"]
        if not lo <= preset["temperature_c"] <= hi:
            problems.append("temperature_c is outside temperature_range_c")
    basket = preset.get("default_basket")
    if basket is not None and basket not in baskets:
        problems.append(f"default_basket {basket!r} is not a basket preset")
    return problems


def _check_grinder(preset: Mapping[str, Any], families: set[str]) -> list[str]:
    problems = []
    if preset["family"] not in families:
        problems.append(f"family {preset['family']!r} is not a grinder_family preset")
    dial = preset["dial"]
    if not dial["min"] <= dial["default"] <= dial["max"]:
        problems.append("dial.default is outside [dial.min, dial.max]")
    for end in ("min", "max"):
        gap = dial["gap_at_ref_um"] + dial["gap_per_unit_um"] * (dial[end] - dial["ref"])
        if gap < 0:
            problems.append(f"dial.{end} maps to a negative gap ({gap:g} µm)")
    return problems


def build_presets(paths: RepoPaths, registry_ids: set[str]) -> tuple[dict[str, Any], list[Path]]:
    """The ``puckworks.presets/1`` document; raises ExportError listing every problem."""
    schema = json.loads(preset_schema_path(paths).read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    files = sorted(presets_dir(paths).rglob("*.yaml"))
    problems: list[str] = []
    if not files:
        problems.append(f"{paths.relative(presets_dir(paths))}: no preset files (*.yaml)")
    lists: dict[str, list[tuple[str, dict[str, Any]]]] = {kind: [] for kind in KIND_LISTS}
    for path in files:
        where = paths.relative(path)
        try:
            doc = load_yaml(path)
        except (OSError, yaml.YAMLError) as exc:
            problems.append(f"{where}: cannot read YAML: {exc}")
            continue
        errors = sorted(validator.iter_errors(doc), key=lambda e: [str(p) for p in e.absolute_path])
        if errors:
            problems.extend(f"{where}: schema: {_schema_error(e)}" for e in errors)
            continue
        bad_numbers = _non_finite(doc)
        if bad_numbers:
            problems.extend(f"{where}: {p}: numbers must be finite" for p in bad_numbers)
            continue
        for preset in doc["presets"]:
            lists[doc["kind"]].append((where, dict(preset)))

    families = {p["id"] for _, p in lists["grinder_family"]}
    baskets = {p["id"] for _, p in lists["basket"]}
    for kind, entries in lists.items():
        seen: dict[str, str] = {}
        for where, preset in entries:
            label = f"{where}: {kind} {preset['id']}"
            if preset["id"] in seen:
                problems.append(f"{label}: duplicate id (first defined in {seen[preset['id']]})")
            seen.setdefault(preset["id"], where)
            for ref in preset.get("registry_refs", []):
                if ref not in registry_ids:
                    problems.append(f"{label}: registry_refs: unknown registry id {ref!r}")
            if kind == "grinder":
                problems.extend(f"{label}: {m}" for m in _check_grinder(preset, families))
            elif kind == "basket":
                problems.extend(f"{label}: {m}" for m in _check_basket(preset))
            elif kind == "machine":
                problems.extend(f"{label}: {m}" for m in _check_machine(preset, baskets))
    defaults = [p["id"] for _, p in lists["bean"] if p.get("default")]
    if len(defaults) != 1:
        problems.append(f"beans: exactly one bean preset must have `default: true` (found {defaults or 'none'})")
    if problems:
        raise ExportError(problems)
    doc: dict[str, Any] = {"schema": PRESETS_SCHEMA}
    for kind, name in KIND_LISTS.items():
        doc[name] = [preset for _, preset in sorted(lists[kind], key=lambda e: e[1]["id"])]
    return doc, files


# -- documents -----------------------------------------------------------------


def build_documents(paths: RepoPaths, allow_unused_calibration: bool = False) -> Documents:
    """Both documents; raises ExportError if any input does not validate."""
    problems: list[str] = []
    warnings: list[str] = []
    registry: dict[str, Any] | None = None
    try:
        registry = build_registry(paths, allow_unused_calibration, warnings)
    except ExportError as exc:
        problems.extend(exc.problems)
    registry_ids = {p["id"] for p in registry["parameters"]} if registry else set()
    presets: dict[str, Any] | None = None
    files: list[Path] = []
    try:
        presets, files = build_presets(paths, registry_ids)
    except ExportError as exc:
        problems.extend(exc.problems)
    if problems or registry is None or presets is None:
        raise ExportError(problems)
    return Documents(presets=presets, registry=registry, preset_files=files, warnings=warnings)


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def render(doc: Mapping[str, Any]) -> str:
    """Compact JSON with each top-level list item on its own line, ending in a newline."""
    lines = []
    for key, value in doc.items():
        if isinstance(value, list) and value and all(isinstance(item, Mapping) for item in value):
            items = ",\n".join(_dumps(item) for item in value)
            lines.append(f"{_dumps(key)}:[\n{items}\n]")
        else:
            lines.append(f"{_dumps(key)}:{_dumps(value)}")
    return "{\n" + ",\n".join(lines) + "\n}\n"


def stale_outputs(paths: RepoPaths, docs: Documents) -> list[Path]:
    """Generated files that are missing or differ from ``docs``."""
    stale = []
    for path, doc in zip(output_paths(paths), (docs.presets, docs.registry)):
        if not path.is_file() or path.read_text(encoding="utf-8") != render(doc):
            stale.append(path)
    return stale


def write_outputs(paths: RepoPaths, docs: Documents) -> list[Path]:
    """Writes the generated files that changed; returns them."""
    written = []
    for path, doc in zip(output_paths(paths), (docs.presets, docs.registry)):
        text = render(doc)
        if not path.is_file() or path.read_text(encoding="utf-8") != text:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            written.append(path)
    return written


def _summary(docs: Documents) -> str:
    counts = ", ".join(f"{len(docs.presets[name])} {name.replace('_', ' ')}" for name in KIND_LISTS.values())
    calibrated = sum(1 for p in docs.registry["parameters"] if p["default_from"] == "calibration")
    return f"{counts}; {len(docs.registry['parameters'])} registry parameters ({calibrated} calibrated)"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="puckworks-tools export",
        description="Write crates/puckmodel/generated/presets.json and registry.json from data/.",
    )
    parser.add_argument(
        "--check", action="store_true", help="fail if the committed files differ from a fresh export"
    )
    parser.add_argument("--root", type=Path, help="repository root (default: found from the current directory)")
    parser.add_argument(
        "--allow-unused-calibration",
        action="store_true",
        help="accept calibrated ids the input models do not read (reported as warnings)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point: ``python -m puckworks_tools.export`` and ``puckworks-tools export``."""
    args = build_parser().parse_args(argv)
    try:
        paths = RepoPaths(find_repo_root(args.root))
    except RepoNotFoundError as exc:
        print(f"export: {exc}", file=sys.stderr)
        return 2
    try:
        docs = build_documents(paths, args.allow_unused_calibration)
        for doc in (docs.presets, docs.registry):
            render(doc)  # fails on anything JSON cannot carry, before anything is written
    except ExportError as exc:
        for problem in exc.problems:
            print(f"error: {problem}")
        print(f"export: {len(exc.problems)} problem(s); nothing written")
        return 1
    except (jsonschema.exceptions.SchemaError, ValueError, TypeError) as exc:
        print(f"error: {type(exc).__name__}: {exc}")
        print("export: the inputs could not be validated; nothing written")
        return 1
    except (OSError, json.JSONDecodeError) as exc:
        print(f"export: {exc}", file=sys.stderr)
        return 2
    for warning in docs.warnings:
        print(f"warning: {warning}")
    if args.check:
        stale = stale_outputs(paths, docs)
        if stale:
            names = ", ".join(paths.relative(p) for p in stale)
            print(f"export: {names} out of date with data/ ({_summary(docs)})")
            print("Regenerate with `python -m puckworks_tools.export` and commit the result.")
            return 1
        print(f"export: generated files are up to date ({_summary(docs)})")
        return 0
    written = write_outputs(paths, docs)
    for path in written:
        print(f"export: wrote {paths.relative(path)} ({path.stat().st_size:,} bytes)")
    if not written:
        print("export: generated files already up to date")
    print(f"export: {_summary(docs)}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
