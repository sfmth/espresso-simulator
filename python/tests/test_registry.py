# SPDX-License-Identifier: GPL-2.0-or-later
"""Parameter registry: the real registry passes; crafted bad records fail for the right reason."""

from __future__ import annotations

import copy
import csv
from pathlib import Path
from typing import Any

import pytest
import yaml

from puckworks_tools.cli import main
from puckworks_tools.registry import (
    RegistryReport,
    check_doi,
    load_registry,
    prior_mass_inside,
    validate_registry,
    validate_repo_registry,
)
from puckworks_tools.yamlio import loads_yaml

# -- the real registry ---------------------------------------------------------


def test_real_registry_is_valid(repo):
    report = validate_repo_registry(repo)
    assert report.ok, "\n".join(map(str, report.issues))
    assert len(report.records) >= 60
    assert len(set(report.ids)) == len(report.ids)


def test_registry_covers_the_m1_topics(repo):
    ids = set(load_registry(repo))
    expected = {
        "bed.density.bulk",
        "bed.porosity.intergranular",
        "bed.porosity.intraparticle",
        "hydraulics.permeability.in_shot",
        "hydraulics.permeability.permeameter",
        "hydraulics.poroelastic.critical_pressure",
        "hydraulics.poroelastic.critical_flow",
        "hydraulics.swelling.diameter_increase",
        "hydraulics.wetting.time",
        "hydraulics.viscosity.water_90c",
        "extraction.dispersion.bodenstein",
        "extraction.diffusivity.caffeine.particle_80c",
        "extraction.diffusivity.potassium.particle_80c",
        "extraction.diffusivity.lumped.corrochano_80c",
        "extraction.diffusivity.fitted.cameron2020",
        "extraction.partition.lumped_80c",
        "extraction.saturation.lumped",
        "extraction.max_yield",
        "extraction.timescale.surface.fine",
        "extraction.timescale.kernel.coarse",
        "kinetics.schmieder2023.lambda.caffeine",
        "kinetics.schmieder2023.c0.tds",
        "psd.fines_mode",
        "psd.x50_gap_ratio",
        "psd.fines_slope",
        "psd.sphericity",
        "bean.co2.total.medium",
        "bean.co2.weibull_scale.dark",
        "bean.composition.arabica.caffeine",
        "bean.composition.robusta.cga_total",
        "shot.time.observed",
        # Added after the 2026-10-14 audit.
        "bed.tortuosity.bed",
        "bed.tortuosity.particle",
        "bed.heterogeneity.two_path_delta_lee2023",
        "bed.heterogeneity.edge_centre_ey_ratio.stock",
        "bed.heterogeneity.edge_centre_ey_ratio.paper_or_screen",
        "extraction.surface_pool_fraction.vaca_guerra2024",
        "extraction.surface_pool_fraction.geometric",
        "hydraulics.extract_density.low_temperature",
        "hydraulics.viscosity.extract_activation_energy",
        "psd.grinder.e65s.indicator_step",
        "psd.grinder.e65s.d43_wet.gl1_7",
        "psd.grinder.e65s.d32_wet.gl2_0",
        "psd.grinder.ek43.dark_roast_mean_reduction",
        "shot.dose.cafe",
    }
    assert expected <= ids, sorted(expected - ids)


def test_literature_parameter_sets_are_complete(repo):
    """The 2-class literature mode needs each paper's full parameter set (M1)."""
    registry = load_registry(repo)
    cameron = {
        "extraction.saturation.cameron2020": 212.4,
        "bed.solid_fraction.cameron2020": 0.8272,
        "extraction.diffusivity.fitted.cameron2020": 6.25e-10,
        "extraction.surface_rate.cameron2020": 6e-7,
    }
    grudeva = {
        "extraction.saturation.grudeva2026": 224,
        "extraction.initial_concentration.grain_grudeva2026": 310,
        "psd.two_class.fines_radius.grudeva2026": 3.65,
        "psd.two_class.boulder_radius.grudeva2026": 229,
        "extraction.surface_rate.grudeva2026": 1e-3,
        "extraction.diffusivity.fitted.grudeva2026": 1e-9,
        "bed.height.grudeva2026": 8.4,
        "extraction.dispersion.grudeva2026": 1e-8,
    }
    for rid, value in {**cameron, **grudeva}.items():
        assert registry[rid]["value"] == pytest.approx(value, rel=1e-12), rid


def test_every_derived_record_has_a_relation(repo):
    for record in load_registry(repo).values():
        if record["tag"] == "derived":
            assert record.get("relation", {}).get("formula"), record["id"]


def test_axial_dispersion_prior_agrees_with_the_bodenstein_number(repo):
    """D_ax = v L / Bo with v = 2-6 mm/s and L = 14 mm (01 §4.8); the audit's main finding."""
    registry = load_registry(repo)
    bo = registry["extraction.dispersion.bodenstein"]["prior"]
    length = registry["bed.height.waszkiewicz_18g5"]["value"] * 1e-3
    low, high = 2e-3 * length / bo["max"], 6e-3 * length / bo["min"]
    record = registry["extraction.dispersion.axial_coefficient"]
    assert "extraction.dispersion.bodenstein" in record["relation"]["derived_from"]
    assert low <= record["value"] <= high
    assert prior_mass_inside(record["prior"], low, high) >= 0.9


def test_moroney_initial_concentration_follows_from_its_inputs(repo):
    registry = load_registry(repo)
    phi = registry["extraction.soluble_volume_fraction.moroney2019"]["prior"]
    c_s0 = registry["extraction.initial_concentration.pore_moroney2019"]["prior"]
    assert phi["min"] * 1400 / 0.56 == pytest.approx(c_s0["min"], abs=0.05)  # 305.0
    assert phi["max"] * 1400 / 0.56 == pytest.approx(c_s0["max"], rel=0.005)  # 357.5 vs 358.6 printed


def _round_sig(x: float, digits: int) -> float:
    return float(f"{x:.{digits}g}")


def test_schmieder_records_match_the_dataset(repo):
    """Registry values (rounded in note 02) agree with the full-precision dataset."""
    registry = load_registry(repo)
    path = repo.datasets_dir / "schmieder2023-centre-point" / "data.csv"
    with open(path, encoding="utf-8", newline="") as handle:
        rows = {(r["analyte"], r["quantity"]): float(r["value"]) for r in csv.DictReader(handle)}
    for analyte, key in [("trigonelline", "trigonelline"), ("caffeine", "caffeine"), ("5-CQA", "5cqa"), ("TDS", "tds")]:
        lam = registry[f"kinetics.schmieder2023.lambda.{key}"]
        assert lam["value"] == _round_sig(rows[(analyte, "lambda")], 3)
        assert lam["prior"]["min"] == round(rows[(analyte, "lambda_design_min")], 1)
        assert lam["prior"]["max"] == round(rows[(analyte, "lambda_design_max")], 1)
        c0 = registry[f"kinetics.schmieder2023.c0.{key}"]
        assert c0["value"] == _round_sig(rows[(analyte, "c0")], 3)
    tds_c0 = registry["kinetics.schmieder2023.c0.tds"]["prior"]
    assert tds_c0["min"] == round(rows[("TDS", "c0_design_min")], 2)
    assert tds_c0["max"] == round(rows[("TDS", "c0_design_max")], 2)


def test_cli_validate_registry(repo, capsys):
    assert main(["validate-registry", "--root", str(repo.root)]) == 0
    out = capsys.readouterr().out
    assert "registry:" in out and ": ok" in out


# -- crafted records -------------------------------------------------------------


def good_record(**changes: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": "test.group.param",
        "name": "Test parameter",
        "description": "A parameter used only by the tests.",
        "units": "kg/m^3",
        "value": 500,
        "prior": {"distribution": "uniform", "min": 360, "max": 500},
        "range": {"min": 0},
        "tag": "measured",
        "evidence_grade": "A",
        "sources": [{"citation": "Author A. (2020) A title. Journal 1:1-2.", "doi": "10.1000/xyz123"}],
        "research_note_ref": "01 §4.4",
        "used_by": ["P"],
        "status": "draft",
    }
    for key, value in changes.items():
        if value is None:
            record.pop(key, None)
        else:
            record[key] = value
    return record


def write_file(directory: Path, name: str, records: list[dict[str, Any]], **wrapper: Any) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    doc = {"schema": "puckworks.parameters/1", "parameters": records, **wrapper}
    path = directory / name
    path.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return path


def run(tmp_path: Path, parameter_schema, units, notes) -> RegistryReport:
    return validate_registry(tmp_path / "params", schema=parameter_schema, units=units, notes=notes)


def messages(report: RegistryReport) -> str:
    return "\n".join(str(issue) for issue in report.issues)


def test_good_record_passes(tmp_path, parameter_schema, units, notes):
    write_file(tmp_path / "params", "a.yaml", [good_record()])
    report = run(tmp_path, parameter_schema, units, notes)
    assert report.ok, messages(report)
    assert report.ids == ["test.group.param"]


BAD_RECORDS = [
    ("missing sources", {"sources": None}, "'sources' is a required property"),
    ("no value and no prior", {"value": None, "prior": None}, "needs a `value`, a `prior` or both"),
    ("bad id", {"id": "Test.Param"}, "id: 'Test.Param' does not match"),
    ("single-segment id", {"id": "param"}, "id: 'param' does not match"),
    ("unknown grade", {"evidence_grade": "E"}, "evidence_grade: 'E' is not one of"),
    ("unknown tag", {"tag": "guessed"}, "tag: 'guessed' is not one of"),
    ("unknown module", {"used_by": ["Z"]}, "used_by[0]: 'Z' is not one of"),
    ("unknown field", {"colour": "red"}, "Additional properties are not allowed ('colour'"),
    ("unknown status", {"status": "final"}, "status: 'final' is not one of"),
    ("empty range", {"range": {}}, "range: {} should be non-empty"),
    ("string value", {"value": "500"}, "value: '500' is not of type 'number'"),
    (
        "mixed lognormal parameters",
        {"prior": {"distribution": "lognormal", "median": 400, "lower": 300}},
        "prior",
    ),
    ("unknown unit", {"units": "furlong"}, "unknown unit 'furlong'"),
    ("value outside range", {"value": -5, "prior": None}, "value -5 is outside range [0, inf]"),
    ("range min above max", {"range": {"min": 10, "max": 1}}, "range: min 10 is greater than max 1"),
    (
        "uniform prior outside range",
        {"value": None, "prior": {"distribution": "uniform", "min": -1, "max": 5}},
        "uniform support [-1, 5] is not inside range",
    ),
    (
        "uniform min not below max",
        {"value": None, "prior": {"distribution": "uniform", "min": 5, "max": 5}},
        "uniform needs min < max",
    ),
    (
        "triangular mode outside",
        {"value": None, "prior": {"distribution": "triangular", "min": 1, "mode": 9, "max": 5}},
        "triangular needs min <= mode <= max",
    ),
    (
        "normal mean outside range",
        {"value": None, "range": {"min": 0, "max": 1}, "prior": {"distribution": "normal", "mean": 2, "sd": 0.1}},
        "normal mean 2 is outside range [0, 1]",
    ),
    (
        "normal prior mostly outside range",
        {"value": None, "range": {"min": 0, "max": 1}, "prior": {"distribution": "normal", "mean": 0.1, "sd": 1}},
        "of the normal prior lies inside range",
    ),
    (
        "lognormal interval reversed",
        {"value": None, "prior": {"distribution": "lognormal", "lower": 5, "upper": 1, "coverage": 0.95}},
        "lognormal interval needs lower < upper",
    ),
    (
        "lognormal median outside range",
        {"value": None, "range": {"min": 0, "max": 1}, "prior": {"distribution": "lognormal", "median": 3, "gsd": 2}},
        "lognormal median 3 is outside range [0, 1]",
    ),
    ("value outside prior support", {"value": 600}, "value 600 is outside the uniform prior's support [360, 500]"),
    (
        "fixed prior differs from value",
        {"prior": {"distribution": "fixed", "value": 400}},
        "fixed value 400 differs from value 500",
    ),
    (
        "DOI with prefix",
        {"sources": [{"citation": "Author A. (2020) A title.", "doi": "doi:10.1000/xyz123"}]},
        "sources[0].doi: 'doi:10.1000/xyz123': write the bare DOI",
    ),
    (
        "DOI as URL",
        {"sources": [{"citation": "Author A. (2020) A title.", "doi": "https://doi.org/10.1000/xyz123"}]},
        "write the bare DOI",
    ),
    (
        "DOI with short registrant",
        {"sources": [{"citation": "Author A. (2020) A title.", "doi": "10.10/xyz123"}]},
        "is not valid DOI syntax",
    ),
    (
        "DOI with trailing period",
        {"sources": [{"citation": "Author A. (2020) A title.", "doi": "10.1000/xyz123."}]},
        "ends with punctuation",
    ),
    ("missing research note", {"research_note_ref": "09 §1"}, "there is no research note docs/research/09-*.md"),
    ("missing heading", {"research_note_ref": "01 §99.9"}, "has no heading for §99.9"),
    ("missing lettered section", {"research_note_ref": "02 Implications Z"}, "has no heading for Implications Z"),
    ("malformed reference", {"research_note_ref": "note 1, section 4"}, "is not of the form"),
    ("one bad reference in a list", {"research_note_ref": ["01 §4.4", "01 §77"]}, "has no heading for §77"),
    ("derived without relation", {"tag": "derived"}, "'relation' is a required property"),
    ("relation without formula", {"relation": {"derived_from": ["other.group.param"]}}, "'formula' is a required property"),
    (
        "malformed id in derived_from",
        {"relation": {"derived_from": ["Not.An.Id"], "formula": "x = y"}},
        "relation.derived_from[0]: 'Not.An.Id' does not match",
    ),
    (
        "unknown id in derived_from",
        {"tag": "derived", "relation": {"derived_from": ["other.group.missing"], "formula": "x = y"}},
        "relation.derived_from: unknown id 'other.group.missing'",
    ),
    (
        "derived_from lists itself",
        {"relation": {"derived_from": ["test.group.param"], "formula": "x = x"}},
        "relation.derived_from lists the record's own id",
    ),
]


@pytest.mark.parametrize("label,changes,expected", BAD_RECORDS, ids=[case[0] for case in BAD_RECORDS])
def test_bad_record_fails_for_the_right_reason(tmp_path, parameter_schema, units, notes, label, changes, expected):
    write_file(tmp_path / "params", "a.yaml", [good_record(**copy.deepcopy(changes))])
    report = run(tmp_path, parameter_schema, units, notes)
    assert not report.ok, label
    text = messages(report)
    assert expected in text, text
    assert len(report.issues) == 1, text


def test_relation_may_point_to_another_file(tmp_path, parameter_schema, units, notes):
    params = tmp_path / "params"
    write_file(params, "a.yaml", [good_record(id="other.group.param")])
    write_file(
        params,
        "b.yaml",
        [good_record(tag="derived", relation={"derived_from": ["other.group.param"], "formula": "y = 2x"})],
    )
    report = run(tmp_path, parameter_schema, units, notes)
    assert report.ok, messages(report)


def test_duplicate_ids_across_files(tmp_path, parameter_schema, units, notes):
    write_file(tmp_path / "params", "a.yaml", [good_record()])
    write_file(tmp_path / "params", "b.yaml", [good_record()])
    report = run(tmp_path, parameter_schema, units, notes)
    assert "duplicate id (first defined in" in messages(report)


def test_ids_must_form_a_tree(tmp_path, parameter_schema, units, notes):
    write_file(tmp_path / "params", "a.yaml", [good_record(id="test.group"), good_record(id="test.group.param")])
    report = run(tmp_path, parameter_schema, units, notes)
    text = messages(report)
    assert "id 'test.group'" in text and "is a prefix of this id" in text


def test_wrapper_needs_schema_and_parameters(tmp_path, parameter_schema, units, notes):
    params = tmp_path / "params"
    write_file(params, "a.yaml", [good_record()], schema="something-else")
    write_file(params, "b.yaml", [])
    (params / "c.yaml").write_text("- just\n- a list\n", encoding="utf-8")
    write_file(params, "d.yaml", [good_record(id="test.other.param")], extra=1)
    text = messages(run(tmp_path, parameter_schema, units, notes))
    assert "a.yaml: `schema` must be 'puckworks.parameters/1'" in text
    assert "b.yaml: `parameters` must be a non-empty list" in text
    assert "c.yaml: top level must be a mapping" in text
    assert "d.yaml: unknown top-level keys: extra" in text


def test_yaml_duplicate_keys_are_rejected(tmp_path, parameter_schema, units, notes):
    params = tmp_path / "params"
    path = write_file(params, "a.yaml", [good_record()])
    path.write_text(path.read_text(encoding="utf-8").replace("  value: 500\n", "  value: 500\n  value: 400\n"))
    text = messages(run(tmp_path, parameter_schema, units, notes))
    assert "cannot read YAML" in text and "duplicate key 'value'" in text


def test_empty_registry_is_an_error(tmp_path, parameter_schema, units, notes):
    (tmp_path / "params").mkdir()
    assert "no parameter files" in messages(run(tmp_path, parameter_schema, units, notes))


# -- helpers ---------------------------------------------------------------------


def test_yaml_loader_reads_yaml_1_2_floats():
    doc = loads_yaml("a: 1e-10\nb: 2.5E+4\nc: 1.0e-3\nd: 7\ne: '1e-3'\n")
    assert doc == {"a": 1e-10, "b": 2.5e4, "c": 1e-3, "d": 7, "e": "1e-3"}
    assert isinstance(doc["a"], float)


@pytest.mark.parametrize(
    "doi",
    [
        "10.3390/foods12152871",
        "10.1002/(SICI)1097-0010(199902)79:2<323::AID-JSFA201>3.0.CO;2-E",
        "10.1002/(SICI)1097-0010(20000101)80:1<85::AID-JSFA489>3.0.CO;2-#",
        "10.1016/S0260-8774(02)00432-6",
        "10.1000.10/abc",
    ],
)
def test_valid_dois(doi):
    assert check_doi(doi) is None


def test_prior_mass_inside():
    assert prior_mass_inside({"distribution": "normal", "mean": 0, "sd": 1}, -1.96, 1.96) == pytest.approx(0.95, abs=1e-3)
    interval = {"distribution": "lognormal", "lower": 1e-15, "upper": 1e-13, "coverage": 0.95}
    assert prior_mass_inside(interval, 1e-15, 1e-13) == pytest.approx(0.95, abs=1e-9)
    assert prior_mass_inside(interval, 0, float("inf")) == pytest.approx(1.0)
    assert prior_mass_inside({"distribution": "uniform", "min": 1, "max": 2}, 0, 1.5) == pytest.approx(0.5)
    assert prior_mass_inside({"distribution": "uniform", "min": 1, "max": 2}, 3, 4) == 0.0
    triangle = {"distribution": "triangular", "min": 0, "mode": 1, "max": 2}
    assert prior_mass_inside(triangle, 0, 1) == pytest.approx(0.5)
    assert prior_mass_inside(triangle, 0.5, 1.5) == pytest.approx(0.75)
    edge = {"distribution": "triangular", "min": 0.75, "mode": 0.75, "max": 0.85}
    assert prior_mass_inside(edge, 0, 1) == pytest.approx(1.0)
    assert prior_mass_inside({"distribution": "fixed", "value": 3}, 0, 1) == 0.0
