# SPDX-License-Identifier: GPL-2.0-or-later
"""Smoke test of the kernel verification report (small refinement series)."""

from __future__ import annotations

import json

import pytest

from puckworks_tools import verify
from puckworks_tools.cli import main

puckcore = pytest.importorskip("puckcore")


def test_observed_orders():
    assert verify.observed_orders([4e-4, 1e-4, 2.5e-5]) == pytest.approx([2.0, 2.0])
    assert verify.observed_orders([-2e-3, 1e-3]) == pytest.approx([1.0])
    assert verify.observed_orders([1e-3, 0.0]) == [None]
    assert verify.observed_orders([1e-3]) == []


def test_space_steps_depend_on_the_scheme():
    config = verify.VerifyConfig()
    assert verify.space_steps_for(config, "backward_euler") == config.space_steps_first_order
    assert verify.space_steps_for(config, "bdf2") == config.space_steps


@pytest.fixture(scope="module")
def quick_doc():
    return verify.run(verify.QUICK_CONFIG, core=puckcore)


def test_quick_run_structure(quick_doc):
    cfg = verify.QUICK_CONFIG
    assert quick_doc["schema"] == verify.JSON_SCHEMA
    assert quick_doc["core_version"] == puckcore.__version__
    combos = quick_doc["combinations"]
    assert [(c["grid"], c["scheme"]) for c in combos] == [(g, s) for g in verify.GRIDS for s in verify.SCHEMES]
    for combo in combos:
        assert [r["n_shells"] for r in combo["space"]] == list(cfg.space_shells)
        assert [r["n_steps"] for r in combo["time"]] == list(cfg.time_steps)
        assert all(r["n_steps"] == combo["space_steps"] for r in combo["space"])
        assert len(combo["space_orders"]["error_at_probe"]) == len(cfg.space_shells) - 1
        assert len(combo["time_orders"]["max_abs_error"]) == len(cfg.time_steps) - 1
        for r in [*combo["space"], *combo["time"]]:
            assert r["max_abs_error"] >= abs(r["error_at_probe"])
            assert r["probe_tau"] == pytest.approx(cfg.probe_tau, rel=1e-6)
            assert r["runtime_s"] > 0
            assert r["mass_balance_error"] < 1e-6
    assert set(quick_doc["ignored_options"]) == {"grid", "scheme"}
    assert quick_doc["analytic_check"]["max_abs_diff"] < 1e-12


def test_report_files(quick_doc, tmp_path):
    md_path, json_path = verify.write_report(quick_doc, tmp_path)
    md = md_path.read_text(encoding="utf-8")
    assert md.startswith("<!-- SPDX-License-Identifier: GPL-2.0-or-later -->")
    for heading in ("# M0 kernel verification", "## Summary", "## Independent check of the analytic solution",
                    "### equal_volume · crank_nicolson"):
        assert heading in md
    assert json.loads(json_path.read_text(encoding="utf-8")) == json.loads(json.dumps(quick_doc))


def test_cli_quick(tmp_path, repo, capsys):
    assert main(["verify", "--root", str(repo.root), "--quick", "--output-dir", str(tmp_path)]) == 0
    assert (tmp_path / "m0-kernel-verification.md").is_file()
    assert (tmp_path / "m0-kernel-verification.json").is_file()
    assert "independent analytic check" in capsys.readouterr().out
