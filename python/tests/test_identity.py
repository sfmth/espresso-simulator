# SPDX-License-Identifier: GPL-2.0-or-later
"""The solver identity recorded by calibration files and validation reports."""

from __future__ import annotations

import pytest

from puckworks_tools.identity import SOURCE_TREES, registry_inputs_sha256, solver_identity, tree_sha256


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


def test_numeric_registry_identity_ignores_prose_but_tracks_fixed_startup_priors(repo, monkeypatch):
    from puckworks_tools import registry

    records = {"model.hydraulics.pore_air_amplitude": {"units": "1", "value": 0.5,
               "prior": {"distribution": "uniform", "min": 0.1, "max": 0.8}, "comment": "original prose"}}
    monkeypatch.setattr(registry, "load_registry", lambda paths: records)
    original = registry_inputs_sha256(repo)
    records["model.hydraulics.pore_air_amplitude"]["comment"] = "clarified provenance, same numeric assumption"
    assert registry_inputs_sha256(repo) == original
    records["model.hydraulics.pore_air_amplitude"]["value"] = 0.8
    assert registry_inputs_sha256(repo) != original


def test_input_identity_tracks_machine_preset_edits(tmp_path, monkeypatch):
    from puckworks_tools import identity
    from puckworks_tools.paths import RepoPaths

    monkeypatch.setattr(identity, "registry_inputs_sha256", lambda paths: "unchanged-registry")
    folder = tmp_path / "data/presets"
    folder.mkdir(parents=True)
    machine = folder / "machine.yaml"
    machine.write_text("max_flow_ml_s: 8.0\n")
    paths = RepoPaths(tmp_path)
    before = identity.input_hashes(paths, None, [])
    machine.write_text("max_flow_ml_s: 6.0\n")
    after = identity.input_hashes(paths, None, [])
    assert before["registry_inputs_sha256"] == after["registry_inputs_sha256"]
    assert before["presets_sha256"] != after["presets_sha256"]
