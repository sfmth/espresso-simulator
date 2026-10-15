# SPDX-License-Identifier: GPL-2.0-or-later
"""The golden sphere-release fixture: format, round-trip precision and --check."""

from __future__ import annotations

import copy
import json
import math

import pytest

from puckworks_tools import fixtures
from puckworks_tools.cli import main

puckcore = pytest.importorskip("puckcore")


@pytest.fixture(scope="module")
def document():
    return fixtures.generate(puckcore)


def test_document_format(document):
    assert list(document) == ["schema", "core_version", "generator", "cases"]
    assert document["schema"] == "puckworks.sphere-cases/1"
    assert document["core_version"] == puckcore.__version__
    assert document["generator"] == "puckworks-tools fixtures"
    assert [case["name"] for case in document["cases"]] == ["boulder_bdf2", "fines_cn", "uniform_be"]
    for case, (name, params) in zip(document["cases"], fixtures.CASES):
        assert list(case) == ["name", "params", "result"]
        assert case["params"] == params
        result = case["result"]
        assert list(result) == list(fixtures.RESULT_KEYS)
        n_time = params["n_steps"] + 1
        for key in ("t_s", "released_fraction", "analytic_fraction"):
            assert len(result[key]) == n_time
        assert len(result["shell_outer_radii_m"]) == params["n_shells"]
        assert len(result["final_profile"]) == params["n_shells"]
        assert result["t_s"][0] == 0.0
        assert math.isclose(result["t_s"][-1], params["t_end_s"], rel_tol=1e-12)
        assert math.isclose(result["shell_outer_radii_m"][-1], params["radius_m"], rel_tol=1e-12)
        values = [v for key in fixtures.RESULT_KEYS[:5] for v in result[key]]
        values += [result["max_abs_error"], result["mass_balance_error"]]
        assert all(isinstance(v, float) and math.isfinite(v) for v in values)


def test_shared_case_parameters():
    """The cases agreed with the web tests (workstream B) must not drift."""
    assert dict(fixtures.CASES) == {
        "boulder_bdf2": dict(radius_m=150e-6, diffusivity_m2_s=1e-10, n_shells=64, t_end_s=60.0, n_steps=600, grid="equal_volume", scheme="bdf2"),
        "fines_cn": dict(radius_m=20e-6, diffusivity_m2_s=2e-10, n_shells=32, t_end_s=2.0, n_steps=400, grid="equal_volume", scheme="crank_nicolson"),
        "uniform_be": dict(radius_m=250e-6, diffusivity_m2_s=6.25e-10, n_shells=48, t_end_s=30.0, n_steps=300, grid="uniform_radius", scheme="backward_euler"),
    }


def test_floats_round_trip_exactly(document):
    text = fixtures.dumps(document)
    assert text.endswith("}\n")
    assert json.loads(text) == document
    assert "NaN" not in text and "Infinity" not in text


def test_committed_fixture_matches_the_current_build(repo):
    comparison = fixtures.check(repo.fixtures_file, core=puckcore)
    assert comparison.ok, (
        f"{repo.relative(repo.fixtures_file)} is stale: {comparison.summary()}; "
        "regenerate it with `puckworks-tools fixtures`"
    )


def test_check_accepts_a_fresh_file(tmp_path, document):
    path = fixtures.write(tmp_path / "cases.json", document)
    comparison = fixtures.check(path, core=puckcore)
    assert comparison.ok
    assert comparison.max_abs_diff == 0.0
    assert comparison.values_compared == sum(
        3 * (p["n_steps"] + 1) + 2 * p["n_shells"] + 2 for _, p in fixtures.CASES
    )


def test_check_reports_the_maximum_difference(tmp_path, document):
    changed = copy.deepcopy(document)
    changed["cases"][1]["result"]["released_fraction"][17] += 2.5e-6
    changed["cases"][0]["result"]["final_profile"][3] += 1e-9
    path = fixtures.write(tmp_path / "cases.json", changed)
    comparison = fixtures.check(path, core=puckcore)
    assert not comparison.ok
    assert comparison.max_abs_diff == pytest.approx(2.5e-6, rel=1e-6)
    assert comparison.where == "cases[fines_cn].result.released_fraction[17]"
    assert "2.5e-06" in comparison.summary()
    assert fixtures.check(path, tolerance=1e-5, core=puckcore).ok


def test_check_reports_structural_differences(tmp_path, document):
    changed = copy.deepcopy(document)
    changed["cases"].pop()
    changed["core_version"] = "9.9.9"
    path = fixtures.write(tmp_path / "cases.json", changed)
    comparison = fixtures.check(path, core=puckcore)
    assert not comparison.ok
    text = comparison.summary()
    assert "core_version: committed '9.9.9'" in text
    assert "cases: expected a list of 2 items, got 3" in text


def test_check_reports_changed_parameters(tmp_path, document):
    changed = copy.deepcopy(document)
    changed["cases"][2]["params"]["n_shells"] = 47
    path = fixtures.write(tmp_path / "cases.json", changed)
    comparison = fixtures.check(path, core=puckcore)
    assert "cases[uniform_be].params.n_shells: committed 47, current build gives 48" in comparison.summary()


def test_check_missing_file(tmp_path):
    comparison = fixtures.check(tmp_path / "missing.json", core=puckcore)
    assert not comparison.ok and "does not exist" in comparison.summary()


def test_cli_write_and_check(tmp_path, repo, capsys):
    target = tmp_path / "cases.json"
    assert main(["fixtures", "--root", str(repo.root), "--output", str(target)]) == 0
    assert main(["fixtures", "--root", str(repo.root), "--check", "--output", str(target)]) == 0
    doc = json.loads(target.read_text(encoding="utf-8"))
    doc["cases"][0]["result"]["max_abs_error"] += 1e-3
    target.write_text(fixtures.dumps(doc), encoding="utf-8")
    assert main(["fixtures", "--root", str(repo.root), "--check", "--output", str(target)]) == 1
    out = capsys.readouterr().out
    assert "differs from the current build" in out and "max |difference| = 0.001" in out
