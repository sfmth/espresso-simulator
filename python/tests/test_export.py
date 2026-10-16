# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests for the preset and registry export (``python -m puckworks_tools.export``) and the recipe schema."""

from __future__ import annotations

import copy
import json
import math
import shutil
from pathlib import Path
from typing import Any

import jsonschema
import pytest
import yaml

from puckworks_tools import export
from puckworks_tools.paths import RepoPaths
from puckworks_tools.registry import validate_repo_registry

try:  # the native extension is optional for these tests
    import puckcore
except ImportError:  # pragma: no cover - depends on the environment
    puckcore = None

needs_puckcore = pytest.mark.skipif(puckcore is None, reason="puckcore extension not installed")


# -- fixtures and helpers --------------------------------------------------------------


@pytest.fixture()
def tmp_repo(repo: RepoPaths, tmp_path: Path) -> RepoPaths:
    """A copy of everything the export reads, in a temporary repository."""
    for rel in ("data/params", "data/schema", "data/presets", "docs/research"):
        shutil.copytree(repo.root / rel, tmp_path / rel)
    reads = export.registry_reads_path(repo)
    target = tmp_path / reads.relative_to(repo.root)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(reads, target)
    (tmp_path / "Cargo.toml").write_text("", encoding="utf-8")
    (tmp_path / "docs" / "PLAN.md").write_text("", encoding="utf-8")
    return RepoPaths(tmp_path)


def _write_yaml(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True), encoding="utf-8")


def _preset_file(kind: str, presets: list[dict[str, Any]]) -> dict[str, Any]:
    return {"schema": "puckworks.preset-file/1", "kind": kind, "presets": presets}


def _meta(pid: str) -> dict[str, Any]:
    return {
        "id": pid,
        "name": f"Test {pid}",
        "description": "A preset made by the tests.",
        "flags": ["estimated"],
        "notes": [],
        "sources": [{"citation": "Puckworks test suite (2026)."}],
        "evidence_grade": "D",
        "tag": "estimated",
    }


def _basket(pid: str, **changes: Any) -> dict[str, Any]:
    preset = {
        **_meta(pid),
        "nominal_dose_g": 18,
        "dose_range_g": [16, 19],
        "profile_mm": [[0, 56], [21, 58]],
        "perforated_diameter_mm": 50,
    }
    preset.update(changes)
    return preset


def _problems(paths: RepoPaths) -> str:
    with pytest.raises(export.ExportError) as info:
        export.build_documents(paths)
    return "\n".join(info.value.problems)


# -- the committed files -------------------------------------------------------------


def test_committed_generated_files_are_current(repo: RepoPaths, capsys: pytest.CaptureFixture[str]) -> None:
    status = export.main(["--check", "--root", str(repo.root)])
    out = capsys.readouterr().out
    assert status == 0, f"{out}\nRegenerate with `python -m puckworks_tools.export`."
    assert "up to date" in out


def test_documents_are_complete_and_lean(repo: RepoPaths) -> None:
    docs = export.build_documents(repo)
    presets, registry = docs.presets, docs.registry
    assert presets["schema"] == "puckworks.presets/1"
    assert list(presets)[1:] == list(export.KIND_LISTS.values())
    assert registry["schema"] == "puckworks.registry/1"
    assert registry["calibration"] is None or registry["calibration"]["schema"] == export.CALIBRATION_SCHEMA
    ids = [p["id"] for p in registry["parameters"]]
    assert ids == sorted(validate_repo_registry(repo).ids)
    for record in registry["parameters"]:
        assert "comment" not in record
        assert math.isfinite(record["default"])
        assert record["default_from"] in ("value", "prior", "calibration")
        assert isinstance(record["research_note_ref"], list)
        lo, hi = record["range"].get("min", -math.inf), record["range"].get("max", math.inf)
        assert lo <= record["default"] <= hi, record["id"]
    # Every exported preset is valid against its definition in the preset schema.
    schema = json.loads(export.preset_schema_path(repo).read_text(encoding="utf-8"))
    for kind, name in export.KIND_LISTS.items():
        sub = {"$schema": schema["$schema"], "$defs": schema["$defs"], "$ref": f"#/$defs/{kind}"}
        validator = jsonschema.Draft202012Validator(sub)
        assert presets[name], name
        for preset in presets[name]:
            errors = list(validator.iter_errors(preset))
            assert not errors, (preset["id"], [e.message for e in errors])
        assert [p["id"] for p in presets[name]] == sorted(p["id"] for p in presets[name])
    # Rendering is deterministic, one record per line, and parses back to the same document.
    for doc in (presets, registry):
        text = export.render(doc)
        assert text == export.render(json.loads(text))
        assert json.loads(text) == doc
    assert export.render(registry).count("\n") == len(registry["parameters"]) + 6
    # Lean enough to embed in the WebAssembly module (ADR 0008).
    assert len(export.render(registry).encode()) < 250_000
    assert len(export.render(presets).encode()) < 80_000


def test_owner_gear_and_disputes_are_flagged(repo: RepoPaths) -> None:
    presets = export.build_documents(repo).presets
    grinder = next(p for p in presets["grinders"] if p["id"] == "amzchef-single-dose")
    machine = next(p for p in presets["machines"] if p["id"] == "amzchef-ultra")
    for preset in (grinder, machine):
        assert {"owner-gear", "unverified", "estimated"} <= set(preset["flags"])
        assert any("UNVERIFIED" in note for note in preset["notes"])
    assert machine["pump"]["opv_bar"] is None
    assert machine["temperature_range_c"] == [88, 96]
    e65s = next(p for p in presets["grinders"] if p["id"] == "mahlkoenig-e65s")
    assert e65s["flags"] == ["disputed"]
    assert all("estimated" in b["flags"] for b in presets["baskets"])


@pytest.mark.parametrize(
    ("record", "expected"),
    [
        ({"value": 3, "prior": {"distribution": "uniform", "min": 1, "max": 9}}, (3.0, "value")),
        ({"prior": {"distribution": "fixed", "value": 2.5}}, (2.5, "prior")),
        ({"prior": {"distribution": "uniform", "min": 1.8e-15, "max": 1.5e-14}}, (8.4e-15, "prior")),
        ({"prior": {"distribution": "normal", "mean": 12, "sd": 3}}, (12.0, "prior")),
        ({"prior": {"distribution": "triangular", "min": 0.1, "mode": 0.17, "max": 0.29}}, (0.17, "prior")),
        ({"prior": {"distribution": "lognormal", "median": 4, "gsd": 2}}, (4.0, "prior")),
        (
            {"prior": {"distribution": "lognormal", "lower": 0.062, "upper": 0.14, "coverage": 0.95}},
            (math.sqrt(0.062 * 0.14), "prior"),
        ),
    ],
)
def test_central_value(record: dict[str, Any], expected: tuple[float, str]) -> None:
    value, source = export.central_value(record)
    assert source == expected[1]
    assert value == pytest.approx(expected[0], rel=1e-11)


# -- calibration --------------------------------------------------------------------------


def test_calibration_replaces_registry_defaults(tmp_repo: RepoPaths) -> None:
    _write_yaml(
        export.calibration_path(tmp_repo),
        {
            "schema": "puckworks.calibration/1",
            "description": "Owner's shots, first session.",
            "date": "2026-10-20",
            "parameters": {"hydraulics.permeability.reference": 3.1e-14, "model.prep.edge_multiplier.base": 0.4},
        },
    )
    registry = export.build_registry(tmp_repo)
    by_id = {p["id"]: p for p in registry["parameters"]}
    assert by_id["hydraulics.permeability.reference"]["default"] == 3.1e-14
    assert by_id["hydraulics.permeability.reference"]["default_from"] == "calibration"
    assert by_id["model.prep.edge_multiplier.base"]["default"] == 0.4
    assert by_id["psd.fines_mode"]["default_from"] == "value"
    meta = registry["calibration"]
    assert meta["parameters"] == ["hydraulics.permeability.reference", "model.prep.edge_multiplier.base"]
    assert "unused_by_builder" not in meta
    assert meta["description"] == "Owner's shots, first session." and meta["date"] == "2026-10-20"
    assert meta["source"] == "data/calibration/current.yaml"


@pytest.mark.parametrize(
    ("doc", "message"),
    [
        ({"schema": "puckworks.calibration/1", "parameters": {"no.such.id": 1.0}}, "unknown registry id 'no.such.id'"),
        ({"schema": "puckworks.calibration/1", "parameters": {"psd.sphericity": 2.0}}, "psd.sphericity: 2 is outside"),
        ({"schema": "puckworks.calibration/1", "parameters": {"psd.sphericity": "high"}}, "finite number"),
        ({"schema": "puckworks.calibration/1", "parameters": {"psd.sphericity": True}}, "finite number"),
        ({"schema": "puckworks.calibration/2", "parameters": {}}, "`schema` must be"),
        ({"schema": "puckworks.calibration/1", "parameters": [1, 2]}, "`parameters` must be a mapping"),
    ],
)
def test_calibration_errors(tmp_repo: RepoPaths, doc: dict[str, Any], message: str) -> None:
    _write_yaml(export.calibration_path(tmp_repo), doc)
    assert message in _problems(tmp_repo)


def test_calibrating_an_id_the_builder_never_reads_is_refused(
    tmp_repo: RepoPaths, capsys: pytest.CaptureFixture[str]
) -> None:
    doc = {"schema": "puckworks.calibration/1", "parameters": {"kinetics.schmieder2023.lambda.caffeine": 21.0}}
    _write_yaml(export.calibration_path(tmp_repo), doc)
    assert "silently ignored" in _problems(tmp_repo)
    root = ["--root", str(tmp_repo.root)]
    assert export.main(root) == 1
    # Accepted on request, with a warning and a record in the export.
    assert export.main([*root, "--allow-unused-calibration"]) == 0
    out = capsys.readouterr().out
    assert "warning:" in out and "kinetics.schmieder2023.lambda.caffeine" in out
    registry = json.loads(export.output_paths(tmp_repo)[1].read_text(encoding="utf-8"))
    assert registry["calibration"]["unused_by_builder"] == ["kinetics.schmieder2023.lambda.caffeine"]


def test_registry_reads_must_exist_in_the_registry(repo: RepoPaths, tmp_repo: RepoPaths) -> None:
    reads = export.load_registry_reads(repo)
    assert "hydraulics.permeability.reference" in reads and "psd.x50_gap_ratio" in reads
    assert reads <= set(validate_repo_registry(repo).ids)
    path = export.registry_reads_path(tmp_repo)
    path.write_text(path.read_text(encoding="utf-8") + "model.no_such.id\n", encoding="utf-8")
    assert "lists model.no_such.id, which is not in the registry" in _problems(tmp_repo)


def test_non_finite_numbers_are_rejected(tmp_repo: RepoPaths, capsys: pytest.CaptureFixture[str]) -> None:
    _write_yaml(
        export.calibration_path(tmp_repo),
        {"schema": "puckworks.calibration/1", "parameters": {}, "score": float("nan")},
    )
    assert "metadata numbers must be finite" in _problems(tmp_repo)
    export.calibration_path(tmp_repo).unlink()
    _write_yaml(
        tmp_repo.root / "data" / "presets" / "extra" / "nan.yaml",
        _preset_file("basket", [_basket("t-nan-basket", nominal_dose_g=float("nan"))]),
    )
    problems = _problems(tmp_repo)
    assert "nominal_dose_g" in problems and ("finite" in problems or "outside" in problems)


def test_main_reports_a_broken_schema_cleanly(tmp_repo: RepoPaths, capsys: pytest.CaptureFixture[str]) -> None:
    schema = export.preset_schema_path(tmp_repo)
    doc = json.loads(schema.read_text(encoding="utf-8"))
    doc["properties"]["kind"] = {"enum": "not-a-list"}
    schema.write_text(json.dumps(doc), encoding="utf-8")
    assert export.main(["--root", str(tmp_repo.root)]) == 1
    out = capsys.readouterr().out
    assert "SchemaError" in out and "nothing written" in out


# -- writing and --check --------------------------------------------------------------


def test_check_detects_stale_files(tmp_repo: RepoPaths, capsys: pytest.CaptureFixture[str]) -> None:
    root = ["--root", str(tmp_repo.root)]
    assert export.main(["--check", *root]) == 1  # nothing generated yet
    assert export.main(root) == 0
    presets_path, registry_path = export.output_paths(tmp_repo)
    assert presets_path.is_file() and registry_path.is_file()
    assert export.main(["--check", *root]) == 0
    assert export.main(root) == 0 and "already up to date" in capsys.readouterr().out
    # A data change makes the committed files stale until they are regenerated.
    beans = tmp_repo.root / "data" / "presets" / "beans" / "beans.yaml"
    beans.write_text(beans.read_text(encoding="utf-8").replace("days_off_roast: 14", "days_off_roast: 15"), encoding="utf-8")
    assert export.main(["--check", *root]) == 1
    assert "out of date" in capsys.readouterr().out
    assert export.main(root) == 0
    assert export.main(["--check", *root]) == 0


def test_invalid_inputs_write_nothing(tmp_repo: RepoPaths, capsys: pytest.CaptureFixture[str]) -> None:
    _write_yaml(tmp_repo.root / "data" / "presets" / "baskets" / "bad.yaml", _preset_file("basket", [{"id": "x"}]))
    assert export.main(["--root", str(tmp_repo.root)]) == 1
    assert "nothing written" in capsys.readouterr().out
    assert not export.output_paths(tmp_repo)[0].exists()


def test_main_reports_setup_problems(tmp_path: Path) -> None:
    assert export.main(["--root", str(tmp_path / "missing")]) == 2


# -- preset validation ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "presets", "message"),
    [
        ("basket", [_basket("t-basket", bogus=1)], "Unevaluated properties are not allowed"),
        ("basket", [_basket("58-precision-18g")], "duplicate id"),
        ("basket", [_basket("t-basket", profile_mm=[[1, 56], [21, 58]])], "must start at height 0"),
        ("basket", [_basket("t-basket", profile_mm=[[0, 56], [0, 58]])], "strictly increase"),
        ("basket", [_basket("t-basket", perforated_diameter_mm=57)], "larger than the floor diameter"),
        ("basket", [_basket("t-basket", nominal_dose_g=25)], "outside dose_range_g"),
        ("basket", [_basket("t-basket", registry_refs=["no.such.id"])], "unknown registry id 'no.such.id'"),
        ("basket", [_basket("Bad_Id")], "does not match"),
        (
            "grinder",
            [
                {
                    **_meta("t-grinder"),
                    "family": "spiral",
                    "burr_diameter_mm": 50,
                    "dial": {"label": "um", "min": 0, "max": 10, "default": 5, "ref": 0, "gap_at_ref_um": 0, "gap_per_unit_um": 10},
                }
            ],
            "family 'spiral' is not a grinder_family preset",
        ),
        (
            "grinder",
            [
                {
                    **_meta("t-grinder"),
                    "family": "conical",
                    "burr_diameter_mm": 50,
                    "dial": {"label": "um", "min": 0, "max": 10, "default": 12, "ref": 0, "gap_at_ref_um": 0, "gap_per_unit_um": 10},
                }
            ],
            "dial.default is outside",
        ),
        (
            "machine",
            [{**_meta("t-machine"), "program": [{"control": "pump"}], "temperature_c": 93, "default_basket": "nope"}],
            "default_basket 'nope' is not a basket preset",
        ),
        (
            "machine",
            [{**_meta("t-machine"), "program": [{"control": "pressure"}], "temperature_c": 93}],
            "needs a target",
        ),
        (
            "machine",
            [
                {
                    **_meta("t-machine"),
                    "program": [{"control": "pressure", "target": 3}, {"control": "pump"}],
                    "temperature_c": 93,
                }
            ],
            "only the last phase may run without an exit condition",
        ),
        (
            "machine",
            [{**_meta("t-machine"), "program": [{"control": "pump"}], "temperature_c": 99, "temperature_range_c": [88, 96]}],
            "outside temperature_range_c",
        ),
        (
            "bean",
            [{**_meta("t-bean"), "arabica_fraction": 1, "roast_level": 0.5, "days_off_roast": 3, "default": True}],
            "exactly one bean preset must have `default: true`",
        ),
        (
            "bean",
            [{**_meta("t-bean"), "arabica_fraction": 1.5, "roast_level": 0.5, "days_off_roast": 3}],
            "greater than the maximum",
        ),
    ],
)
def test_preset_problems_are_reported(tmp_repo: RepoPaths, kind: str, presets: list[dict[str, Any]], message: str) -> None:
    _write_yaml(tmp_repo.root / "data" / "presets" / "extra" / "test.yaml", _preset_file(kind, presets))
    assert message in _problems(tmp_repo)


def test_registry_problems_block_the_export(tmp_repo: RepoPaths) -> None:
    model = tmp_repo.params_dir / "model.yaml"
    model.write_text(model.read_text(encoding="utf-8").replace("value: 0.6\n", "value: 9.6\n", 1), encoding="utf-8")
    assert "registry:" in _problems(tmp_repo)


# -- the recipe schema -----------------------------------------------------------------


def _recipe_schema(repo: RepoPaths) -> jsonschema.Draft202012Validator:
    schema = json.loads((repo.root / "data" / "schema" / "recipe.schema.json").read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator(schema)


OWNER_RECIPE: dict[str, Any] = {
    "schema": "puckworks.recipe/1",
    "bean": {"preset": "medium-washed-arabica"},
    "grinder": {"preset": "amzchef-single-dose", "setting": 10},
    "basket": {"preset": "58-stock-double"},
    "prep": {"dose_g": 18, "distribution": "wdt", "tamp_kgf": 15},
    "machine": {"preset": "amzchef-ultra"},
    "stop": {"beverage_g": 36},
}

FROM_SCRATCH_RECIPE: dict[str, Any] = {
    "schema": "puckworks.recipe/1",
    "bean": {"arabica_fraction": 0.9, "roast_level": 0.6, "days_off_roast": 8, "process": None, "bean_temp_c": -18},
    "grinder": {"family": "conical", "setting": 12, "gap_at_ref_um": 40, "gap_per_unit_um": 12, "rpm": 500},
    "basket": {"custom": {"profile_mm": [[0, 40], [6, 40], [6.5, 56], [24, 58]], "perforated_diameter_mm": 36, "pressurised_orifice_mm": 0.4}},
    "prep": {"dose_g": 15, "distribution": "tap", "puck_screen": True, "paper_bottom": False},
    "machine": {
        "profile": [
            {"control": "flow", "target": 4, "limit": 3, "until_pressure_bar": 2.5, "until_time_s": 10},
            {"control": "pressure", "target": 9, "ramp_s": 2},
        ],
        "pump": {"type": "vibratory", "free_flow_ml_s": 8, "stall_pressure_bar": 15, "opv_bar": None},
        "temperature_c": 92,
        "headspace_ml": 4,
    },
    "stop": {"beverage_g": 33, "time_s": 45},
    "numerics": {"tier": 0, "size_classes": 20},
    "overrides": {"hydraulics.permeability.reference": 2e-14},
}

MEASURED_PSD_RECIPE: dict[str, Any] = {
    "schema": "puckworks.recipe/1",
    "bean": {},
    "grinder": {"psd": {"diameter_um": [7.3, 458.0], "volume_fraction": [0.18, 0.82], "method": "other"}},
    "basket": {"preset": "58-precision-18g"},
    "prep": {"dose_g": 18},
    "machine": {"preset": "flow-2-ml-s"},
    "stop": {},
}

VALID_RECIPES = [OWNER_RECIPE, FROM_SCRATCH_RECIPE, MEASURED_PSD_RECIPE]

UNKNOWN_FIELD_PATHS = [
    (),
    ("bean",),
    ("grinder",),
    ("basket",),
    ("basket", "custom"),
    ("prep",),
    ("machine",),
    ("machine", "pump"),
    ("stop",),
    ("numerics",),
]


def _with_unknown_field(recipe: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any]:
    out = copy.deepcopy(recipe)
    target = out
    for key in path:
        target = target[key]
    target["bogus"] = 1
    return out


@pytest.mark.parametrize("recipe", VALID_RECIPES)
def test_recipe_schema_accepts_valid_recipes(repo: RepoPaths, recipe: dict[str, Any]) -> None:
    errors = [e.message for e in _recipe_schema(repo).iter_errors(recipe)]
    assert not errors


@pytest.mark.parametrize("path", UNKNOWN_FIELD_PATHS)
def test_recipe_schema_rejects_unknown_fields(repo: RepoPaths, path: tuple[str, ...]) -> None:
    assert not _recipe_schema(repo).is_valid(_with_unknown_field(FROM_SCRATCH_RECIPE, path))


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("bean", "roast_level"), 1.5),
        (("bean", "process"), "wet-hulled"),
        (("prep", "dose_g"), 0),
        (("prep", "distribution"), "spin"),
        (("numerics", "tier"), 2),
        (("machine", "profile"), []),
        (("schema",), "puckworks.recipe/2"),
    ],
)
def test_recipe_schema_rejects_bad_values(repo: RepoPaths, path: tuple[str, ...], value: Any) -> None:
    recipe = copy.deepcopy(FROM_SCRATCH_RECIPE)
    target = recipe
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    assert not _recipe_schema(repo).is_valid(recipe)


# (path, a value outside the plausibility bounds, a value just inside them)
BOUNDARY_CASES: list[tuple[tuple[str, ...], Any, Any]] = [
    (("prep", "dose_g"), 0.5, 1.0),
    (("prep", "dose_g"), 61, 60),
    (("prep", "tamp_kgf"), 101, 100),
    (("bean", "bean_temp_c"), 61, 60),
    (("bean", "days_off_roast"), 3651, 3650),
    (("grinder", "gap_at_ref_um"), 3001, 3000),
    (("grinder", "gap_per_unit_um"), 1001, 1000),
    (("grinder", "rpm"), 5001, 5000),
    (("grinder", "coarse_log_width"), 1.1, 1.0),
    (("grinder", "coarse_log_width"), 0.05, 0.1),
    (("grinder", "boulder_weight"), 0.31, 0.3),
    (("grinder", "fines_at_340_pct"), 41, 40),
    (("grinder", "fines_at_340_pct"), 0.5, 1),
    (("machine", "temperature_c"), 101, 100),
    (("machine", "headspace_ml"), 201, 200),
    (("machine", "pump", "free_flow_ml_s"), 31, 30),
    (("stop", "time_s"), 601, 600),
    (("stop", "beverage_g"), 501, 60),
]


def _set_path(recipe: dict[str, Any], path: tuple[str, ...], value: Any) -> dict[str, Any]:
    out = copy.deepcopy(recipe)
    target = out
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return out


@pytest.mark.parametrize(("path", "bad", "good"), BOUNDARY_CASES)
def test_recipe_schema_bounds(repo: RepoPaths, path: tuple[str, ...], bad: Any, good: Any) -> None:
    validator = _recipe_schema(repo)
    assert not validator.is_valid(_set_path(FROM_SCRATCH_RECIPE, path, bad))
    assert validator.is_valid(_set_path(FROM_SCRATCH_RECIPE, path, good))


@needs_puckcore
@pytest.mark.parametrize(("path", "bad", "good"), BOUNDARY_CASES)
def test_builder_and_schema_share_the_bounds(path: tuple[str, ...], bad: Any, good: Any) -> None:
    field = ".".join(path)
    with pytest.raises(ValueError, match=f"{field} = "):
        puckcore.build_shot_spec(_set_path(FROM_SCRATCH_RECIPE, path, bad))
    recipe = _set_path(FROM_SCRATCH_RECIPE, path, good)
    if path == ("stop", "time_s"):
        recipe["stop"].pop("beverage_g")
    try:
        puckcore.build_shot_spec(recipe)
    except ValueError as exc:
        # A just-inside value may still fail for another reason (a 60 g dose that does not fit
        # this basket, a dial calibration whose combined gap is too large), never its own bound.
        assert f"{field} = " not in str(exc), str(exc)


@needs_puckcore
def test_builder_agrees_with_the_recipe_schema() -> None:
    for recipe in VALID_RECIPES:
        built = puckcore.build_shot_spec(recipe)
        assert built["spec"]["schema"] == "puckworks.shot-spec/1"
        assert built["derived"]["provenance"]
    for path in UNKNOWN_FIELD_PATHS:
        with pytest.raises(ValueError, match="unknown field"):
            puckcore.build_shot_spec(_with_unknown_field(FROM_SCRATCH_RECIPE, path))


@needs_puckcore
def test_extension_embeds_the_committed_export(repo: RepoPaths) -> None:
    presets_path, registry_path = export.output_paths(repo)
    assert puckcore.presets() == json.loads(presets_path.read_text(encoding="utf-8"))
    assert puckcore.registry() == json.loads(registry_path.read_text(encoding="utf-8"))
