# SPDX-License-Identifier: GPL-2.0-or-later
"""Locating the Puckworks repository and its standard paths."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

#: Environment variable that overrides repository auto-detection.
ROOT_ENV = "PUCKWORKS_ROOT"


class RepoNotFoundError(RuntimeError):
    """Raised when the repository root cannot be determined."""


def _is_repo_root(path: Path) -> bool:
    return (path / "Cargo.toml").is_file() and (path / "docs" / "PLAN.md").is_file()


def find_repo_root(explicit: Path | None = None) -> Path:
    """Returns the repository root.

    Order: ``explicit``; the ``PUCKWORKS_ROOT`` environment variable; the
    current directory or one of its parents; the source tree this package was
    loaded from (editable installs).
    """
    if explicit is not None:
        root = Path(explicit).resolve()
        if not root.is_dir():
            raise RepoNotFoundError(f"{root} is not a directory")
        return root
    env = os.environ.get(ROOT_ENV)
    if env:
        return Path(env).resolve()
    here = Path.cwd().resolve()
    for candidate in (here, *here.parents):
        if _is_repo_root(candidate):
            return candidate
    package_root = Path(__file__).resolve().parents[2]
    if _is_repo_root(package_root):
        return package_root
    raise RepoNotFoundError(
        "cannot find the Puckworks repository root (a directory containing Cargo.toml "
        "and docs/PLAN.md); run inside the repository or pass --root"
    )


@dataclass(frozen=True)
class RepoPaths:
    """Standard locations inside the repository."""

    root: Path

    @property
    def params_dir(self) -> Path:
        return self.root / "data" / "params"

    @property
    def parameter_schema(self) -> Path:
        return self.root / "data" / "schema" / "parameter.schema.json"

    @property
    def dataset_schema(self) -> Path:
        return self.root / "data" / "schema" / "dataset.schema.json"

    @property
    def units(self) -> Path:
        return self.root / "data" / "schema" / "units.yaml"

    @property
    def datasets_dir(self) -> Path:
        return self.root / "data" / "datasets"

    @property
    def notes_dir(self) -> Path:
        return self.root / "docs" / "research"

    @property
    def fixtures_file(self) -> Path:
        return self.root / "data" / "fixtures" / "sphere_cases.json"

    @property
    def validation_dir(self) -> Path:
        return self.root / "docs" / "validation"

    @property
    def cargo_toml(self) -> Path:
        return self.root / "Cargo.toml"

    @property
    def package_json(self) -> Path:
        return self.root / "web" / "package.json"

    @property
    def pyproject(self) -> Path:
        return self.root / "python" / "pyproject.toml"

    @property
    def changelog(self) -> Path:
        return self.root / "CHANGELOG.md"

    def relative(self, path: Path) -> str:
        """``path`` relative to the root when possible, for messages."""
        try:
            return Path(path).resolve().relative_to(self.root.resolve()).as_posix()
        except ValueError:
            return str(path)
