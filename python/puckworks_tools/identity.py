# SPDX-License-Identifier: GPL-2.0-or-later
"""Identity of the solver build a run used, so that calibration files and validation reports made on
different builds can be told apart: the puckcore version, a hash and the modification time of the
compiled extension, and hashes of the Rust source trees it was built from (solver, input models and the
generated registry export the input models embed)."""

from __future__ import annotations

import datetime
import hashlib
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from .paths import RepoPaths

#: Source trees whose contents determine the extension's behaviour.
SOURCE_TREES = ("crates/puckcore/src", "crates/puckmodel/src", "crates/puckmodel/generated", "crates/puckcore-py")
#: Single files that pin the build (dependency versions).
SOURCE_FILES = ("Cargo.lock",)


def tree_sha256(root: Path) -> str | None:
    """SHA-256 (first 16 hex digits) over the relative paths and contents of every file under ``root``."""
    if not root.is_dir():
        return None
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


def file_sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16] if path.is_file() else None


def registry_inputs_sha256(paths: RepoPaths) -> str:
    """Numeric registry inputs, before the calibrated-value overlay; prose changes do not invalidate a fit."""
    from .registry import load_registry

    records = load_registry(paths)
    values = {key: {field: record.get(field) for field in ("units", "value", "prior", "range")}
              for key, record in records.items()}
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def calibration_sources_sha256(paths: RepoPaths) -> str | None:
    """Python case builders, observables and calibration code; excludes bytecode and report formatting."""
    package = paths.root / "python" / "puckworks_tools"
    source = [package / "calibrate.py", *sorted((package / "cases").glob("*.py"))]
    if not all(path.is_file() for path in source):
        return None
    digest = hashlib.sha256()
    for path in source:
        digest.update(path.relative_to(package).as_posix().encode() + b"\0")
        digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


def input_hashes(paths: RepoPaths, config_path: str | None, datasets: list[str]) -> dict[str, Any]:
    """Hashes of a calibration's config, datasets, registry, presets and Python model interface."""
    config = paths.root / config_path if config_path else None
    return {"config_sha256": file_sha256(config) if config else None,
            "datasets_sha256": {name: tree_sha256(paths.datasets_dir / name) for name in datasets},
            "registry_inputs_sha256": registry_inputs_sha256(paths),
            "presets_sha256": tree_sha256(paths.root / "data" / "presets"),
            "calibration_sources_sha256": calibration_sources_sha256(paths)}


def extension_file(module: ModuleType | None = None) -> Path | None:
    """The compiled extension behind the ``puckcore`` package (None for a stand-in module)."""
    if module is not None:
        name = getattr(module, "__file__", None)
        return Path(name) if name else None
    import puckcore  # noqa: F401  (loads puckcore.puckcore)

    compiled = sys.modules.get("puckcore.puckcore")
    name = getattr(compiled, "__file__", None)
    return Path(name) if name else None


def solver_identity(paths: RepoPaths, module: ModuleType | None = None) -> dict[str, Any]:
    from .cases.common import core

    so = extension_file(module)
    out: dict[str, Any] = {"puckcore_version": getattr(core(module), "__version__", None)}
    if so is not None and so.is_file():
        out["extension_sha256"] = hashlib.sha256(so.read_bytes()).hexdigest()[:16]
        out["extension_built"] = datetime.datetime.fromtimestamp(so.stat().st_mtime).astimezone().isoformat(
            timespec="seconds")
    out["sources_sha256"] = {tree: tree_sha256(paths.root / tree) for tree in SOURCE_TREES}
    out["files_sha256"] = {name: file_sha256(paths.root / name) for name in SOURCE_FILES}
    versions = {}
    for package in ("numpy", "scipy"):
        try:
            versions[package] = __import__(package).__version__
        except ImportError:
            versions[package] = None
    out["python"] = {"version": sys.version.split()[0], **versions}
    return out


__all__ = ["SOURCE_FILES", "SOURCE_TREES", "calibration_sources_sha256", "extension_file", "file_sha256",
           "input_hashes", "registry_inputs_sha256", "solver_identity", "tree_sha256"]
