# SPDX-License-Identifier: GPL-2.0-or-later
"""Shared helpers for the source importers: hashing, number formatting, CSV output."""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    """Hex SHA-256 of a file."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fmt(value: Any, digits: int | None = None) -> str:
    """A CSV cell: '' for None, round-trip repr for floats (or ``digits`` significant decimals)."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"non-finite value {value!r}")
        if digits is not None:
            text = f"{value:.{digits}f}"
            if "." in text:
                text = text.rstrip("0").rstrip(".")
            return "0" if text in ("-0", "") else text
        return repr(value)
    return str(value)


def write_csv(path: Path, header: Sequence[str], rows: Iterable[Sequence[Any]]) -> Path:
    """Writes a CSV file with Unix line endings; cells are formatted already (strings) or by ``fmt``."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        for row in rows:
            writer.writerow([cell if isinstance(cell, str) else fmt(cell) for cell in row])
    return path


def report_sources(files: Iterable[Path]) -> None:
    """Prints the SHA-256 of each source file (recorded in the sidecars)."""
    for path in files:
        print(f"source {Path(path).name}: sha256 {sha256(Path(path))}")


def importer_parser(description: str) -> argparse.ArgumentParser:
    """Argument parser shared by the importers: SOURCE_DIR and --out."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("source", type=Path, help="directory holding the downloaded source files")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/datasets"),
        help="datasets directory to write into (default: data/datasets)",
    )
    return parser
