# SPDX-License-Identifier: GPL-2.0-or-later
"""Independent unit/basis checks on the audited M2 chemistry intake."""

from __future__ import annotations

import math
import pytest

from puckworks_tools.cases.common import read_table
from puckworks_tools.sources import gloess2013
from puckworks_tools import m2validate


def test_gloess_original_bases_and_double_extractions(repo):
    rows = read_table(repo, "gloess2013-espresso-chemistry")
    assert len(rows) == 112
    assert {r["method"] for r in rows} == {"DE", "SE", "DL", "SL"}
    for method in gloess2013.METHODS:
        selected = [r for r in rows if r["method"] == method]
        find = lambda basis, quantity: next(r["value"] for r in selected
                                            if r["basis"] == basis and r["quantity"] == quantity)
        dose = find("per_extraction", "dry_dose")
        cups = find("per_extraction", "cups_per_extraction")
        cup_ml = find("per_cup", "cup_volume")
        assert cups == 2 and dose >= 16
        for analyte in ("caffeine", "cqa3", "cqa5"):
            per_cup = find("per_cup", analyte)
            per_10_ml = find("per_10_ml", analyte)
            dose_percent = find("per_dose", analyte)
            # Independent bases must agree within the source's printed precision.
            assert math.isclose(per_cup, per_10_ml * cup_ml / 10, rel_tol=0.025)
            assert math.isclose(per_cup * cups, dose_percent / 100 * dose * 1000, rel_tol=0.025)
        for endpoint in ("naoh_to_ph6_6", "naoh_to_ph8"):
            assert math.isclose(find("per_cup", endpoint),
                                find("per_10_ml", endpoint) * cup_ml / 10, rel_tol=0.025)
        assert not any(r["basis"] == "per_dose" and r["quantity"].startswith("naoh")
                       for r in selected)
        assert not any(r["quantity"] in ("cqa4", "trigonelline", "beverage_mass") for r in selected)


def test_gloess_missing_uncertainty_is_not_zero(repo):
    rows = read_table(repo, "gloess2013-espresso-chemistry")
    pressure = [r for r in rows if r["quantity"] == "pressure"]
    assert all(r["uncertainty"] is None for r in pressure)
    measured = [r for r in rows if r["quantity"] == "caffeine"]
    assert all(r["uncertainty"] > 0 for r in measured)


def test_gloess_import_refuses_unaudited_document(tmp_path):
    source = tmp_path / "supplement.docx"
    source.write_bytes(b"a different source, not audited")
    with pytest.raises(ValueError, match="Supplement changed"):
        gloess2013.measurements(source)


def test_m2_scenarios_keep_volume_proxy_and_holdout_role_explicit(repo):
    cases = m2validate.recipes(repo)
    assert len(cases) == 8
    assert {c["fines_volume_fraction"] for c in cases} == {0.1, 0.3}
    for case in cases:
        assert case["mass_proxy_g"] == case["published_volume_ml"]
        assert case["mass_proxy_g"] in (60.0, 240.0)
        assert case["dose_g"] in (16.0, 16.01)
        assert case["recipe"]["chemistry"]["enabled"]
        # Chemistry source observations must never become fitted priors.
        assert not any("chemistry" in key or "composition" in key
                       for key in case["recipe"]["overrides"])


def test_m2_scoring_does_not_confuse_cup_mass_or_accounting_identity(repo):
    case = m2validate.recipes(repo)[0]  # DE: published63mg caffeine per30mL cup
    result = {"summary": {"species": [{"id": "caffeine", "mass_kg": 126e-6},
                                       {"id": "cqa3", "mass_kg": 34.8e-6},
                                       {"id": "cqa5", "mass_kg": 16.6e-6}],
                           "shot_time_s": 28.7, "beverage_mass_kg": 0.060,
                           "stop_reason": "beverage_mass"},
              "chemistry": {"acidity": {"ph": 5.8},
                            "mass_closure": {"lumped_solubles_kg": 0.003,
                                             "unassigned_solubles_kg": 0.002,
                                             "relative_transport_closure_error": 0.4}}}
    scored = m2validate.compare(case, result)
    assert all(c["within_25_percent_under_assumptions"] for c in scored["compound_comparisons"])
    assert scored["compound_comparisons"][0]["measured_double_mg"] == 126
    assert not scored["raw_transport_closure_within_5_percent"]
    assert scored["acidity_comparisons"][1]["measured"] == 11.5
    assert scored["acidity_comparisons"][2]["measured"] == 24.1
    assert "blocked" in scored["v7_status"]
    assert all(r["status"] == "not independently scored" for r in scored["acidity_comparisons"])


def test_m2_missing_chemistry_is_public_failure_not_false_success(repo):
    case = m2validate.recipes(repo)[0]
    result = {"summary": {"species": [], "shot_time_s": 100,
                           "beverage_mass_kg": 0.002, "stop_reason": "choked"}}
    scored = m2validate.compare(case, result)
    assert scored["status"] == "missing M2 chemistry"
    assert not scored["reached_mass_proxy"]
    assert not scored["raw_transport_closure_within_5_percent"]
    assert all(c["predicted_double_mg"] is None for c in scored["compound_comparisons"])


def test_m2_report_keeps_each_simulation_error_visible(repo, tmp_path):
    class MissingRuntime:
        __version__ = "test-unavailable"

        @staticmethod
        def build_shot_spec(_recipe):
            raise ValueError("M2 runtime unavailable")

    report = m2validate.run(repo, tmp_path, module=MissingRuntime)
    assert report["summary"]["simulation_errors"] == 8
    assert report["summary"]["chemistry_available"] == 0
    assert report["v7_status"].startswith("blocked")
    text = (tmp_path / "m2-validation.md").read_text()
    assert "Public simulation errors" in text
    assert text.count("M2 runtime unavailable") == 8
    assert "Full M2 exit: **not met**" in text
    assert report["catalogue"]["total"] == 57
    assert report["catalogue"]["appendix_species"] == 55
