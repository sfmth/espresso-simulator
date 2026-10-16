# SPDX-License-Identifier: GPL-2.0-or-later
"""The golden shot fixture: format, coverage, round-trip precision and --check."""

from __future__ import annotations

import copy
import json

import pytest

from puckworks_tools import shotfixtures
from puckworks_tools.cli import main

puckcore = pytest.importorskip("puckcore")


@pytest.fixture(scope="module")
def document(repo):
    return shotfixtures.generate(repo, puckcore)


def test_document_format(document):
    assert list(document) == ["schema", "core_version", "generator", "cases"]
    assert document["schema"] == "puckworks.shot-cases/1"
    assert document["core_version"] == puckcore.__version__
    assert document["generator"] == "puckworks-tools shot-fixtures"
    assert [c["name"] for c in document["cases"]] == [name for name, _ in shotfixtures.CASES]
    for case in document["cases"]:
        assert list(case) == list(shotfixtures.CASE_KEYS)
        assert case["spec"]["schema"] == "puckworks.shot-spec/1"
        assert case["result"]["schema"] == "puckworks.shot-result/1"
        # the spec is the builder's, i.e. what simulate_recipe built and simulated
        assert puckcore.build_shot_spec(case["recipe"])["spec"] == case["spec"]


def test_coverage(document):
    specs = [c["spec"] for c in document["cases"]]
    assert {s["numerics"]["tier"] for s in specs} == {0, 1}
    assert any(s["machine"]["pump"]["type"] == "vibratory" for s in specs)
    assert any(s["basket"]["outlet"]["type"] == "pressurised" for s in specs)
    assert any(p["control"]["type"] == "flow" for s in specs for p in s["machine"]["phases"])
    assert any(s["hydraulics"]["pore_air_permeability_exponent"] == 2.5 for s in specs)
    assert any(s["hydraulics"]["pore_air"]["amplitude"] == 0 for s in specs)
    assert any(s["hydraulics"]["pore_air"]["amplitude"] > 0 for s in specs)
    assert all(s["hydraulics"]["intraparticle_water_fraction"] == 1 for s in specs)
    recipes = [c["recipe"] for c in document["cases"]]
    assert any("psd" in r["grinder"] for r in recipes)
    tapered = [r["basket"]["custom"]["profile_mm"] for r in recipes if "custom" in r["basket"]]
    assert tapered and len({d for _, d in tapered[0]}) > 1


def test_no_wall_clock_fields_and_size(document):
    text = shotfixtures.dumps(document)
    assert len(text.encode()) < 2_000_000
    for word in ("elapsed", "runtime", "wall_clock", "timestamp", "duration_ms"):
        assert word not in text


def test_floats_round_trip_exactly(document):
    text = shotfixtures.dumps(document)
    assert json.loads(text) == document
    assert "NaN" not in text and "Infinity" not in text


def test_committed_fixture_matches_the_current_build(repo):
    """Fails whenever the builder's or solver's numbers change: regenerate with `puckworks-tools shot-fixtures`."""
    comparison = shotfixtures.check(repo.root / "data" / "fixtures" / shotfixtures.FILENAME, repo, core=puckcore)
    assert comparison.ok, comparison.summary()


def test_compare_detects_changes(document):
    changed = copy.deepcopy(document)
    changed["cases"][0]["result"]["summary"]["ey"] += 1e-9
    comparison = shotfixtures.compare(document, changed)
    assert not comparison.ok and "summary.ey" in comparison.where
    assert shotfixtures.compare(document, changed, tolerance=1e-8).ok
    renamed = copy.deepcopy(document)
    renamed["cases"][1]["recipe"]["prep"]["dose_g"] = 99.0
    assert "dose_g" in shotfixtures.compare(document, renamed).summary()


def test_cli_write_and_check(repo, tmp_path):
    target = tmp_path / "shot.json"
    assert main(["shot-fixtures", "--output", str(target), "--root", str(repo.root)]) == 0
    assert main(["shot-fixtures", "--check", "--output", str(target), "--root", str(repo.root)]) == 0
    doc = json.loads(target.read_text())
    doc["cases"][0]["result"]["summary"]["tds"] *= 1.001
    target.write_text(json.dumps(doc))
    assert main(["shot-fixtures", "--check", "--output", str(target), "--root", str(repo.root)]) == 1
    assert main(["shot-fixtures", "--check", "--output", str(tmp_path / "missing.json"), "--root", str(repo.root)]) == 1
