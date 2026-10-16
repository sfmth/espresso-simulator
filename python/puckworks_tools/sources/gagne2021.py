# SPDX-License-Identifier: GPL-2.0-or-later
"""Qualify a local copy of Gagné's 2021 blooming-espresso experiment.

No downloads, Tcl execution, fitting or calibration admission occur here. The
original logs have no established redistribution licence; use local ignored
output directories and do not commit the normalized traces. Input identities are
pinned by default. ``verify_hashes=False`` is for explicit local diagnostics and
synthetic tests, and labels its result unverified.

Run ``python -m puckworks_tools.sources.gagne2021 --help`` for the offline CLI.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import stat
import statistics
import subprocess
import tempfile
import zipfile
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from .de1 import CHANNELS, MAX_SHOT_BYTES, ShotFormatError, _number, observed_summary, parse_shot

ARTICLE_URL = "https://coffeeadastra.com/2021/05/10/a-comparison-between-standard-and-low-fines-espresso-shots/"
ARCHIVE_URL = "https://www.dropbox.com/s/l0v4a5d3h98kasn/shotfiles_Mar2_2021.zip?raw=1"
LOG_URL = "https://docs.google.com/spreadsheets/d/1r33CI6lczJhuYcNjy8z3jABagZoxO8Z0kkd6h5Ppos0/export?format=csv"
ARCHIVE_SHA256 = "a41f92b755cf028e310d0d4de2cc24051d75f719fe65dbc3d022a215d469c73b"
LOG_SHA256 = "490c691d06920f2c3d9cba18398d8d2193acefe037530cabcab8488cbdeb2e6d"
SCHEMA_VERSION = 1
_BASENAME = re.compile(r"[0-9]{8}T[0-9]{6}\.shot\Z")
_MAX_ARCHIVE_BYTES = 25_000_000
_MAX_LOG_BYTES = 1_000_000
_MAX_SHOTS = 100

LIMITATIONS = [
    "Local source qualification only; these cases are not admitted calibration or independent validation data.",
    "No explicit source-data redistribution licence has been established; keep normalized traces local and ignored.",
    "Times use each file's elapsed clock; pump start, scale latency and synchronization are not established.",
    "Mass thresholds use first upward linear crossings of signed samples, without smoothing, clipping or clock shifts.",
    "Last logged mass and annotated final beverage mass are different endpoints; their difference is not inferred post-stop drip.",
    "The spreadsheet drip annotation concerns bloom drainage and is kept distinct from that endpoint difference.",
    "DE1 inlet flow and dispensed volume are firmware estimates; controller goals are not measured flows or pressures.",
    "One session, operator, coffee and blooming profile do not isolate a causal grinder effect; PSD was not measured.",
]


def _read_limited(path: Path, limit: int) -> bytes:
    with path.open("rb") as source:
        content = source.read(limit + 1)
    if len(content) > limit:
        raise ValueError(f"{path.name}: exceeds input size limit")
    return content


def _source_identity(content: bytes, expected: str, url: str, *, verify: bool) -> dict[str, Any]:
    digest = hashlib.sha256(content).hexdigest()
    if verify and digest != expected:
        raise ValueError(f"source SHA-256 mismatch: expected {expected}, got {digest}")
    return {"url": url, "sha256": digest, "bytes": len(content), "expected_sha256": expected,
            "matches_pin": digest == expected}


def _log_rows(content: bytes) -> dict[str, dict[str, Any]]:
    try:
        reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig"), newline=""), strict=True)
        fields = reader.fieldnames
        required = {"N", "Grinder", "File", "Output weight", "dose", "drip", "TDS", "TDS-f", "eTDS"}
        if not fields or len(fields) != len(set(fields)) or not required.issubset(fields):
            raise ValueError("measurement log: missing or duplicate column names")
        rows = {}
        seen_numbers = set()
        for line, row in enumerate(reader, 2):
            context = f"measurement log row {line}"
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f"{context}: column count differs from header")
            basename = row["File"]
            if not _BASENAME.fullmatch(basename):
                raise ValueError(f"{context}: File must be an exact shot basename")
            if basename in rows:
                raise ValueError(f"{context}: duplicate File basename")
            if not re.fullmatch(r"[1-9][0-9]*", row["N"]):
                raise ValueError(f"{context}: N must be a positive integer")
            number = int(row["N"])
            if number in seen_numbers:
                raise ValueError(f"{context}: duplicate N")
            seen_numbers.add(number)
            if row["Grinder"] not in {"EG1", "Niche"}:
                raise ValueError(f"{context}: unsupported grinder group")
            annotations: dict[str, Any] = {"id": f"gagne2021-{number:02d}", "grinder_group": row["Grinder"]}
            mapping = {"dose": "dose_g", "Output weight": "final_beverage_g", "drip": "annotated_drip_g",
                       "TDS": "tds_percent", "TDS-f": "filtered_tds_percent", "eTDS": "tds_error_percent"}
            optional = {"drip", "postgrind_dose", "postwdt_dose"}
            for field in [*mapping, *(key for key in ("pregrind_dose", "postgrind_dose", "postwdt_dose") if key in row)]:
                raw = row[field].strip()
                if field in optional and raw in {"", "NaN"}:
                    value = None
                else:
                    value = _number(raw, context=f"{context}.{field}")
                    if value < 0 or (field in {"dose", "Output weight", "pregrind_dose"} and value == 0):
                        raise ValueError(f"{context}.{field}: invalid negative or zero measurement")
                    if field in {"TDS", "TDS-f", "eTDS"} and value > 100:
                        raise ValueError(f"{context}.{field}: percentage exceeds 100")
                if field in mapping:
                    annotations[mapping[field]] = value
            rows[basename] = annotations
            if len(rows) > _MAX_SHOTS:
                raise ValueError("measurement log: too many rows")
    except (UnicodeDecodeError, csv.Error) as exc:
        raise ValueError("measurement log: malformed UTF-8 CSV") from exc
    if not rows:
        raise ValueError("measurement log: no shot rows")
    return rows


def _archive_shots(content: bytes) -> dict[str, bytes]:
    shots = {}
    seen_members = set()
    total_size = 0
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            if len(archive.infolist()) > 1_000:
                raise ValueError("shot archive: too many members")
            for member in archive.infolist():
                name = member.filename
                path = PurePosixPath(name)
                if name in seen_members:
                    raise ValueError("shot archive: duplicate member path")
                seen_members.add(name)
                if path.is_absolute() or ".." in path.parts or "\\" in name or "\x00" in name:
                    raise ValueError("shot archive: unsafe member path")
                if stat.S_ISLNK(member.external_attr >> 16):
                    raise ValueError("shot archive: symbolic-link members are unsupported")
                if member.is_dir() or "__MACOSX" in path.parts or path.name == ".DS_Store":
                    continue
                if path.suffix != ".shot":
                    continue
                if not _BASENAME.fullmatch(path.name):
                    raise ValueError("shot archive: invalid shot basename")
                if path.name in shots:
                    raise ValueError("shot archive: duplicate shot basename")
                if member.file_size > MAX_SHOT_BYTES or member.flag_bits & 1:
                    raise ValueError("shot archive: oversized or encrypted shot")
                total_size += member.file_size
                if total_size > _MAX_ARCHIVE_BYTES or len(shots) >= _MAX_SHOTS:
                    raise ValueError("shot archive: expanded data exceed size limit")
                shots[path.name] = archive.read(member)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise ValueError("shot archive: unreadable ZIP member") from exc
    if not shots:
        raise ValueError("shot archive: no shot records")
    return shots


def _range(values: Sequence[float]) -> dict[str, float | int | None]:
    return {"count": len(values), "min": min(values) if values else None,
            "median": statistics.median(values) if values else None, "max": max(values) if values else None}


def _summarize(cases: Sequence[dict[str, Any]]) -> dict[str, Any]:
    summary = {
        "case_count": len(cases),
        "sample_count": sum(case["observed"]["sample_count"] for case in cases),
        "dose_g": _range([case["dose_g"] for case in cases]),
        "annotated_final_beverage_g": _range([case["final_beverage_g"] for case in cases]),
        "elapsed_end_s": _range([case["observed"]["elapsed_end_s"] for case in cases]),
        "final_logged_mass_g": _range([case["observed"]["final_logged_mass_g"] for case in cases]),
        "annotated_minus_logged_mass_g": _range([case["observed"]["annotated_minus_logged_mass_g"] for case in cases]),
        "negative_mass_samples": sum(case["observed"]["negative_mass_samples"] for case in cases),
        "downward_mass_steps": sum(case["observed"]["downward_mass_steps"] for case in cases),
        "minimum_logged_mass_g": min(case["observed"]["minimum_logged_mass_g"] for case in cases),
        "largest_downward_mass_step_g": max(case["observed"]["largest_downward_mass_step_g"] for case in cases),
        "thresholds": [],
    }
    for index, mass in enumerate((0.5, 1.0)):
        observations = [case["observed"]["thresholds"][index] for case in cases]
        summary["thresholds"].append({
            "mass_g": mass,
            "time_s": _range([obs["time_s"] for obs in observations if obs["status"] == "observed"]),
            "left_censored_count": sum(obs["status"] == "left_censored" for obs in observations),
            "not_reached_count": sum(obs["status"] == "not_reached" for obs in observations),
        })
    return summary


def load_experiment(
    archive_path: str | Path, log_path: str | Path, *, verify_hashes: bool = True,
) -> dict[str, Any]:
    """Join local ZIP shots and CSV annotations by exact, unique basename.

    Return ``sources``, flat ``cases``, descriptive ``summaries`` and limitations.
    Every selected channel is finite, aligned and explicitly named by provenance.
    All archive shots and CSV rows must join one-to-one. Source paths and personal
    metadata are omitted; basenames and per-shot hashes support a local audit.
    """
    archive_bytes = _read_limited(Path(archive_path), _MAX_ARCHIVE_BYTES)
    log_bytes = _read_limited(Path(log_path), _MAX_LOG_BYTES)
    sources = {
        "article_url": ARTICLE_URL,
        "identity_verified": verify_hashes,
        "archive": _source_identity(archive_bytes, ARCHIVE_SHA256, ARCHIVE_URL, verify=verify_hashes),
        "measurement_log": _source_identity(log_bytes, LOG_SHA256, LOG_URL, verify=verify_hashes),
    }
    annotations = _log_rows(log_bytes)
    shots = _archive_shots(archive_bytes)
    if set(annotations) != set(shots):
        absent_shots = len(set(annotations) - set(shots))
        absent_rows = len(set(shots) - set(annotations))
        raise ValueError(f"source join: {absent_shots} log rows lack shots; {absent_rows} shots lack log rows")
    cases = []
    for basename, annotation in sorted(annotations.items(), key=lambda item: int(item[1]["id"].rsplit("-", 1)[1])):
        parsed = parse_shot(shots[basename], source_name=basename)
        if missing := set(CHANNELS.values()).difference(parsed):
            raise ShotFormatError(f"{basename}: missing Gagné channels {', '.join(sorted(missing))}")
        if not parsed["profile_steps"]:
            raise ShotFormatError(f"{basename}: missing recorded advanced profile")
        case = {**annotation, **parsed,
                "source": {"basename": basename, "sha256": hashlib.sha256(shots[basename]).hexdigest()}}
        case["observed"] = observed_summary(case["t_s"], case["scale_mass_g"], final_beverage_g=case["final_beverage_g"])
        cases.append(case)
    groups = sorted({case["grinder_group"] for case in cases})
    return {
        "schema_version": SCHEMA_VERSION,
        "sources": sources,
        "cases": cases,
        "summaries": {"all": _summarize(cases), "groups": {
            group: _summarize([case for case in cases if case["grinder_group"] == group]) for group in groups}},
        "limitations": [*LIMITATIONS, *([] if verify_hashes else [
            "Input identity was not verified against the pinned experiment; do not attribute these inputs to that source."]),],
    }


load_gagne2021 = load_experiment


def ensure_local_output(path: str | Path) -> Path:
    """Validate a local output directory: outside Git, or wholly ignored in Git.

    Resolve symlinks before checking. Refuse Git administration directories and
    directories containing tracked files even when an ignore rule matches them.
    The function does not create the directory. Writers should use atomic replace
    so an existing output-file symlink cannot redirect a write into tracked data.
    """
    if "://" in os.fspath(path):
        raise ValueError("output must be a local directory")
    target = Path(path).expanduser().resolve()
    if target.exists() and not target.is_dir():
        raise ValueError("output must be a directory")
    repository = next((parent for parent in (target, *target.parents) if (parent / ".git").exists()), None)
    if repository is None:
        return target
    relative = target.relative_to(repository)
    if not relative.parts or ".git" in relative.parts:
        raise ValueError("output must be outside the repository or in an ignored local directory")
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    command = ["git", "-C", str(repository)]
    try:
        tracked = subprocess.run([*command, "ls-files", "-z", "--", relative.as_posix()],
                                 capture_output=True, check=False, env=env)
        ignored = subprocess.run([*command, "check-ignore", "--quiet", "--", relative.as_posix() + "/"],
                                 capture_output=True, check=False, env=env)
    except OSError as exc:
        raise ValueError("cannot verify that repository output is ignored") from exc
    if tracked.returncode != 0 or ignored.returncode not in (0, 1):
        raise ValueError("cannot verify that repository output is ignored")
    if tracked.stdout or ignored.returncode != 0:
        raise ValueError("repository output must be Git-ignored and contain no tracked files")
    return target


def _write_json(path: Path, value: Any) -> None:
    content = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_bundle(bundle: dict[str, Any], output_dir: str | Path) -> list[Path]:
    """Write deterministic local cases and a separate trace-free observable report."""
    output = ensure_local_output(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    cases_path = output / "normalized-cases.json"
    summary_path = output / "observables.json"
    summary = {key: bundle[key] for key in ("schema_version", "sources", "summaries", "limitations")}
    summary["cases"] = [{key: case[key] for key in (
        "id", "grinder_group", "dose_g", "final_beverage_g", "annotated_drip_g", "observed", "source",
    )} for case in bundle["cases"]]
    _write_json(cases_path, bundle)
    _write_json(summary_path, summary)
    return [cases_path, summary_path]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--archive", type=Path, required=True, help="local original shot ZIP")
    parser.add_argument("--log", type=Path, required=True, help="local measurement-log CSV")
    parser.add_argument("--out", type=Path, required=True, help="local ignored or external output directory")
    parser.add_argument("--allow-unverified", action="store_true", help="explicitly bypass pinned hashes for local diagnostics")
    args = parser.parse_args(argv)
    try:
        ensure_local_output(args.out)
        bundle = load_experiment(args.archive, args.log, verify_hashes=not args.allow_unverified)
        for path in write_bundle(bundle, args.out):
            print(f"wrote {path}")
        print(f"qualified {len(bundle['cases'])} local cases; no fitting or calibration admission")
    except (OSError, ValueError) as exc:
        parser.exit(2, f"error: {exc}\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
