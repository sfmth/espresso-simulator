# SPDX-License-Identifier: GPL-2.0-or-later
"""The solver identity recorded by calibration files and validation reports."""

from __future__ import annotations

import pytest

from puckworks_tools.identity import SOURCE_TREES, solver_identity, tree_sha256


def test_tree_hash_follows_paths_and_contents(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "x.rs").write_text("fn main() {}")
    first = tree_sha256(tmp_path)
    assert first == tree_sha256(tmp_path) and len(first) == 16
    (tmp_path / "a" / "x.rs").write_text("fn main() { }")
    assert tree_sha256(tmp_path) != first
    assert tree_sha256(tmp_path / "missing") is None


def test_solver_identity_names_the_build(repo):
    pytest.importorskip("puckcore")
    identity = solver_identity(repo)
    assert identity["puckcore_version"]
    assert len(identity["extension_sha256"]) == 16 and identity["extension_built"]
    assert set(identity["sources_sha256"]) == set(SOURCE_TREES)
    assert all(identity["sources_sha256"].values())
