# SPDX-License-Identifier: GPL-2.0-or-later
"""Version consistency across Cargo, web, Python tools, puckcore and the changelog."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from puckworks_tools.cli import main
from puckworks_tools.paths import RepoPaths
from puckworks_tools.versions import changelog_has_release, check_versions

CHANGELOG_WITH_RELEASE = "# Changelog\n\n## [0.1.0] — 2026-10-14\n\n### Added\n- Things.\n\n## [0.0.1] — 2026-10-13\n"
CHANGELOG_WITHOUT_RELEASE = "# Changelog\n\n## [0.0.1] — 2026-10-13\n"


def make_repo(
    root: Path,
    cargo: str = "0.1.0",
    pyproject: str = "0.1.0",
    package_json: str | None = "0.1.0",
    changelog: str = CHANGELOG_WITH_RELEASE,
) -> RepoPaths:
    (root / "docs").mkdir(parents=True)
    (root / "docs" / "PLAN.md").write_text("# Plan\n", encoding="utf-8")
    (root / "Cargo.toml").write_text(
        f'[workspace]\nmembers = []\n\n[workspace.package]\nversion = "{cargo}"\nedition = "2024"\n',
        encoding="utf-8",
    )
    (root / "python").mkdir()
    (root / "python" / "pyproject.toml").write_text(
        f'[project]\nname = "puckworks-tools"\nversion = "{pyproject}"\n', encoding="utf-8"
    )
    if package_json is not None:
        (root / "web").mkdir()
        (root / "web" / "package.json").write_text(
            json.dumps({"name": "puckworks-web", "version": package_json}), encoding="utf-8"
        )
    (root / "CHANGELOG.md").write_text(changelog, encoding="utf-8")
    return RepoPaths(root)


def test_consistent_versions_pass(tmp_path):
    report = check_versions(make_repo(tmp_path), puckcore_version="0.1.0")
    assert report.ok, report.problems
    assert report.reference == "0.1.0"
    assert [s.name for s in report.sources] == ["Cargo workspace", "web app", "Python tools", "puckcore extension"]


def test_package_json_is_optional(tmp_path):
    report = check_versions(make_repo(tmp_path, package_json=None), puckcore_version="0.1.0")
    assert report.ok, report.problems
    assert "web app" not in [s.name for s in report.sources]


@pytest.mark.parametrize(
    "kwargs,core,expected",
    [
        ({"pyproject": "0.2.0"}, "0.1.0", "Python tools 0.2.0"),
        ({"package_json": "0.1.1"}, "0.1.0", "web app 0.1.1"),
        ({}, "0.0.9", "puckcore extension 0.0.9"),
        ({"cargo": "1.0.0"}, "0.1.0", "Cargo workspace 1.0.0"),
    ],
)
def test_mismatches_are_reported(tmp_path, kwargs, core, expected):
    report = check_versions(make_repo(tmp_path, **kwargs), puckcore_version=core)
    assert not report.ok
    assert any(p.startswith("versions disagree") and expected in p for p in report.problems), report.problems


def test_missing_puckcore_is_reported(tmp_path):
    report = check_versions(make_repo(tmp_path), puckcore_version=None)
    assert not report.ok
    assert any("puckcore extension" in p and "not installed" in p for p in report.problems)


def test_package_json_without_version(tmp_path):
    paths = make_repo(tmp_path)
    paths.package_json.write_text(json.dumps({"name": "puckworks-web"}), encoding="utf-8")
    report = check_versions(paths, puckcore_version="0.1.0")
    assert any('web app (web/package.json): no "version" field' in p for p in report.problems)


def test_dynamic_pyproject_version_is_rejected(tmp_path):
    paths = make_repo(tmp_path)
    paths.pyproject.write_text('[project]\nname = "x"\ndynamic = ["version"]\n', encoding="utf-8")
    report = check_versions(paths, puckcore_version="0.1.0")
    assert any("dynamic" in p for p in report.problems)


def test_release_requires_a_changelog_heading(tmp_path):
    paths = make_repo(tmp_path, changelog=CHANGELOG_WITHOUT_RELEASE)
    assert check_versions(paths, puckcore_version="0.1.0").ok
    report = check_versions(paths, release=True, puckcore_version="0.1.0")
    assert not report.ok
    assert "CHANGELOG.md has no '## [0.1.0]' heading" in report.problems


def test_release_passes_with_a_heading(tmp_path):
    report = check_versions(make_repo(tmp_path), release=True, puckcore_version="0.1.0")
    assert report.ok, report.problems


def test_changelog_heading_must_match_exactly(tmp_path):
    path = tmp_path / "CHANGELOG.md"
    path.write_text("## [0.1.0-rc1] — 2026-10-01\n### [0.1.0] not a release heading\n", encoding="utf-8")
    assert not changelog_has_release(path, "0.1.0")
    path.write_text("## [0.1.0]\n", encoding="utf-8")
    assert changelog_has_release(path, "0.1.0")


def test_cli_exit_codes(tmp_path, capsys):
    paths = make_repo(tmp_path, pyproject="0.3.0")
    # The installed puckcore is used here; the pyproject mismatch fails regardless of its version.
    assert main(["check-versions", "--root", str(paths.root)]) == 1
    assert "versions disagree" in capsys.readouterr().out


def test_repository_versions_agree(repo):
    """Plain check on the real repository (the --release check needs the CHANGELOG entry)."""
    pytest.importorskip("puckcore")
    report = check_versions(repo)
    assert report.ok, report.problems
