# SPDX-License-Identifier: GPL-2.0-or-later
"""Version consistency across the repository (docs/PLAN.md §16).

The same version must appear in:

- the workspace Cargo.toml (``[workspace.package] version``), the reference;
- web/package.json (``version``), if the file exists;
- python/pyproject.toml (``[project] version``);
- the installed puckcore extension (``puckcore.__version__``).

With ``release=True``, CHANGELOG.md must also have a ``## [<version>]`` heading.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10 only
    import tomli as tomllib

from .paths import RepoPaths

_UNSET: Any = object()


@dataclass
class VersionSource:
    """One place a version is recorded."""

    name: str
    location: str
    version: str | None = None
    error: str | None = None


@dataclass
class VersionReport:
    """Result of the version check."""

    sources: list[VersionSource] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    reference: str | None = None
    release: bool = False

    @property
    def ok(self) -> bool:
        return not self.problems


def _toml(path: Path) -> dict[str, Any]:
    with open(path, "rb") as handle:
        return tomllib.load(handle)


def _cargo_version(path: Path) -> str:
    data = _toml(path)
    try:
        version = data["workspace"]["package"]["version"]
    except KeyError:
        raise ValueError("no [workspace.package] version") from None
    if not isinstance(version, str):
        raise ValueError("[workspace.package] version is not a string")
    return version


def _pyproject_version(path: Path) -> str:
    data = _toml(path)
    project = data.get("project", {})
    if "version" in project.get("dynamic", []):
        raise ValueError("[project] version is dynamic; it must be written in the file")
    version = project.get("version")
    if not isinstance(version, str):
        raise ValueError("no [project] version")
    return version


def _package_json_version(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    version = data.get("version") if isinstance(data, dict) else None
    if not isinstance(version, str):
        raise ValueError('no "version" field')
    return version


def _installed_puckcore_version() -> str:
    try:
        import puckcore
    except ImportError as exc:
        raise ValueError(f"cannot import puckcore ({exc}); build it with `pip install ./crates/puckcore-py`") from exc
    version = getattr(puckcore, "__version__", None)
    if not isinstance(version, str):
        raise ValueError("puckcore has no __version__")
    return version


def changelog_has_release(path: Path, version: str) -> bool:
    """Whether CHANGELOG.md has a ``## [<version>]`` heading."""
    pattern = re.compile(rf"^## \[{re.escape(version)}\](\s|$)", re.MULTILINE)
    return bool(pattern.search(path.read_text(encoding="utf-8")))


def check_versions(paths: RepoPaths, release: bool = False, puckcore_version: Any = _UNSET) -> VersionReport:
    """Collects every version and checks that they agree.

    ``puckcore_version`` overrides the installed module's version (for tests);
    pass ``None`` to simulate a missing module.
    """
    report = VersionReport(release=release)

    def add(name: str, location: str, read: Any) -> None:
        source = VersionSource(name, location)
        try:
            source.version = read()
        except (OSError, ValueError, tomllib.TOMLDecodeError) as exc:
            source.error = str(exc)
        report.sources.append(source)

    add("Cargo workspace", paths.relative(paths.cargo_toml), lambda: _cargo_version(paths.cargo_toml))
    if paths.package_json.exists():
        add("web app", paths.relative(paths.package_json), lambda: _package_json_version(paths.package_json))
    add("Python tools", paths.relative(paths.pyproject), lambda: _pyproject_version(paths.pyproject))

    def read_core() -> str:
        if puckcore_version is _UNSET:
            return _installed_puckcore_version()
        if puckcore_version is None:
            raise ValueError("puckcore is not installed")
        return str(puckcore_version)

    add("puckcore extension", "puckcore.__version__", read_core)

    for source in report.sources:
        if source.error:
            report.problems.append(f"{source.name} ({source.location}): {source.error}")
    report.reference = report.sources[0].version
    versions = {s.version for s in report.sources if s.version is not None}
    if len(versions) > 1:
        listing = ", ".join(f"{s.name} {s.version}" for s in report.sources if s.version is not None)
        report.problems.append(f"versions disagree: {listing}")
    if release:
        if report.reference is None:
            report.problems.append("cannot check CHANGELOG.md without the Cargo workspace version")
        elif not paths.changelog.is_file():
            report.problems.append(f"{paths.relative(paths.changelog)} does not exist")
        elif not changelog_has_release(paths.changelog, report.reference):
            report.problems.append(
                f"{paths.relative(paths.changelog)} has no '## [{report.reference}]' heading"
            )
    return report
