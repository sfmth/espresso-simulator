# SPDX-License-Identifier: GPL-2.0-or-later
"""The synthetic teacher boundary must be reproducible, scoped and leakage-free."""

from __future__ import annotations

import copy
import itertools
import json
import math

import pytest

from puckworks_tools import surrogate_data as data
from puckworks_tools.paths import RepoPaths


class FakeCore:
    __version__ = "0.11.0-test"

    def __init__(self):
        self.registry_value = 2.0
        self.preset_value = 9.0
        self.behavior = 1.0
        self.calls = 0
        self.fail_x = None
        self.failure_mode = "exception"

    def registry(self):
        return {"parameters": [{"id": "effective.permeability", "default": self.registry_value}],
                "calibration": {"label": "published-overlay"}}

    def presets(self):
        return {"machines": [{"id": "flat-9-bar", "pressure": self.preset_value}]}

    def build_shot_spec(self, recipe):
        return {"spec": {"recipe": copy.deepcopy(recipe)}, "derived": {}}

    def simulate_shot(self, spec):
        self.calls += 1
        recipe = spec["recipe"]
        x = data.recipe_features(recipe)
        if x == self.fail_x and self.failure_mode == "exception":
            raise ValueError("injected native failure")
        mass = recipe["stop"]["beverage_g"] / 1000 + 0.003
        ey = (0.18 + (x[0] - 170) * 0.0003 + (x[3] - 90) * 0.001) * self.behavior
        result = {
            "schema": "puckworks.shot-result/1", "core_version": self.__version__,
            "summary": {"shot_time_s": 10 + x[1] / 2, "beverage_mass_kg": mass,
                        "ey": ey, "tds": ey * x[1] / 1000 / mass,
                        "stop_reason": "beverage_mass", "drip_mass_kg": 0.003},
            "diagnostics": {"tier": 1, "mass_balance_error": 1e-14,
                            "hydraulic_volume_balance_error": 2e-14,
                            "min_concentration_kg_m3": 0.0, "outflow_integral_error": 0.007},
        }
        if x == self.fail_x:
            if self.failure_mode == "capped":
                result["summary"]["stop_reason"] = "time"
                result["summary"]["shot_time_s"] = 60.0
            elif self.failure_mode == "negative":
                result["diagnostics"]["min_concentration_kg_m3"] = -1e-6
            elif self.failure_mode == "mass":
                result["diagnostics"]["mass_balance_error"] = 0.01
            elif self.failure_mode == "volume":
                result["diagnostics"]["hydraulic_volume_balance_error"] = float("nan")
            elif self.failure_mode == "tds":
                result["summary"]["tds"] *= 2
            elif self.failure_mode == "version":
                result["core_version"] = "stale"
            elif self.failure_mode == "tier":
                result["diagnostics"]["tier"] = 0
            elif self.failure_mode == "outflow":
                result["diagnostics"]["outflow_integral_error"] = 0.1
            elif self.failure_mode == "nonfinite":
                result["series"] = {"ey": [float("inf")]}
        return result


@pytest.fixture
def teacher_paths(tmp_path):
    # A minimal source checkout lets identity tests mutate behavior inputs,
    # independent of concurrent edits elsewhere in the real repository.
    for group in data._SOURCE_TREES:
        folder = tmp_path / group
        folder.mkdir(parents=True)
        (folder / "lib.rs").write_text("// compiled behavior input\n", encoding="utf-8")
    for name in data._SOURCE_FILES:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n" if path.suffix == ".json" else "# build input\n", encoding="utf-8")
    chemistry = tmp_path / "data/chemistry"
    chemistry.mkdir(parents=True)
    (chemistry / "species.json").write_text("{}\n", encoding="utf-8")
    return RepoPaths(tmp_path)


def _generate(paths, engine=None, **options):
    return data.generate_dataset(paths, train=4, calibration=2, test=2, workers=1,
                                 core=engine or FakeCore(), **options)


def _refresh(document):
    document["digest"] = data.dataset_digest(document)
    return document


def test_domain_roundtrip_preserves_features_and_cannot_mutate_the_template():
    original = data.base_recipe()
    for x in ([170, 16, 1.5, 90], [230, 20, 2.5, 96], [191.234, 18.345, 2.12345, 92.76]):
        recipe = data.recipe_for_features(x)
        assert data.recipe_features(recipe) == pytest.approx(x, abs=1e-14)
        assert recipe["stop"]["beverage_g"] == x[1] * x[2]
    recipe["bean"]["preset"] = "different"
    assert data.base_recipe() == original


def test_browser_numeric_serialization_preserves_the_fixed_time_stop():
    recipe = data.base_recipe()
    recipe["stop"]["time_s"] = 60  # JSON.stringify writes 60.0 as 60.
    assert data.recipe_features(recipe) == [190.0, 18.0, 2.0, 93.0]
    recipe["stop"]["time_s"] = True
    with pytest.raises(ValueError):
        data.recipe_features(recipe)


@pytest.mark.parametrize("mutate", [
    lambda r: r.update(overrides={}),
    lambda r: r.update(overrides={"hydraulics.permeability.reference": 1e-13}),
    lambda r: r.update(water={}),
    lambda r: r.update(chemistry={"enabled": False}),
    lambda r: r["grinder"].update(gap_um=190),
    lambda r: r["grinder"].update(preset="mahlkoenig-ek43"),
    lambda r: r["basket"].update(custom={}),
    lambda r: r["bean"].update(days_off_roast=10),
    lambda r: r["prep"].update(distribution="tap"),
    lambda r: r["machine"].update(profile=[]),
    lambda r: r["stop"].update(time_s=59.0),
    lambda r: r["numerics"].update(tier=0),
    lambda r: r["numerics"].update(tier=True),
    lambda r: r["numerics"].update(size_classes=30),
    lambda r: r["machine"].pop("temperature_c"),
])
def test_domain_refuses_every_nonfeature_difference(mutate):
    recipe = data.base_recipe()
    mutate(recipe)
    with pytest.raises(ValueError):
        data.recipe_features(recipe)


@pytest.mark.parametrize("values", [
    [True, 18, 2, 93], [190, True, 2, 93], [190, 18, False, 93], [190, 18, 2, True],
    [float("nan"), 18, 2, 93], [190, 18, float("inf"), 93],
    [169.99, 18, 2, 93], [190, 20.01, 2, 93], [190, 18, 2.51, 93], [190, 18, 2, 89.99],
    [190, 18, 2], "190,18,2,93", None,
])
def test_domain_rejects_nonfinite_bool_and_out_of_bounds_controls(values):
    with pytest.raises(ValueError):
        data.recipe_for_features(values)


def test_teacher_identity_tracks_effective_overlay_compiled_behavior_and_only_source_inputs(teacher_paths):
    engine = FakeCore()
    first = data.teacher_identity(teacher_paths, engine)
    assert engine.calls == 3
    assert data.teacher_identity(teacher_paths, engine) == first
    assert engine.calls == 3  # Warm prediction compatibility does not run physics again.
    assert len(first["fingerprint"]) == 64
    assert not any(key in json.dumps(first) for key in ("extension_built", "extension_sha256", "python"))

    ignored = teacher_paths.root / "crates/puckcore/src/__pycache__"
    ignored.mkdir()
    (ignored / "local.pyc").write_bytes(b"ignored bytecode")
    (teacher_paths.root / "target").mkdir()
    (teacher_paths.root / "target/compiled-binary").write_bytes(b"different platform")
    assert data.teacher_identity(teacher_paths, engine) == first
    engine.registry_value *= 2
    overlay = data.teacher_identity(teacher_paths, engine)
    assert overlay["registry_sha256"] != first["registry_sha256"]
    assert overlay["fingerprint"] != first["fingerprint"] and engine.calls == 6
    engine.preset_value = 8.0
    preset = data.teacher_identity(teacher_paths, engine)
    assert preset["presets_sha256"] != overlay["presets_sha256"]
    source = teacher_paths.root / "crates/puckcore/src/lib.rs"
    source.write_text("// changed solver\n", encoding="utf-8")
    assert data.teacher_identity(teacher_paths, engine)["sources_sha256"] != preset["sources_sha256"]

    # Same version/defaults/source checkout, but another extension with different
    # embedded behavior cannot borrow the first loaded module's cached probes.
    changed_engine = FakeCore()
    changed_engine.registry_value = engine.registry_value
    changed_engine.preset_value = engine.preset_value
    changed_engine.behavior = 0.9
    assert data.teacher_identity(teacher_paths, changed_engine)["embedded_behavior_sha256"] != preset["embedded_behavior_sha256"]


def test_teacher_fingerprint_is_portable_across_checkout_location_and_file_dates(teacher_paths, tmp_path):
    import shutil

    other_root = tmp_path / "different-location"
    shutil.copytree(teacher_paths.root / "crates", other_root / "crates")
    shutil.copytree(teacher_paths.root / "data", other_root / "data")
    for name in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml"):
        shutil.copyfile(teacher_paths.root / name, other_root / name)
    original = data.teacher_identity(teacher_paths, FakeCore())
    relocated = data.teacher_identity(RepoPaths(other_root), FakeCore())
    assert relocated == original
    (other_root / "crates/puckmodel/generated/registry.json").unlink()
    with pytest.raises(ValueError, match="source input is missing"):
        data.teacher_identity(RepoPaths(other_root), FakeCore())


def test_generation_has_disjoint_seeded_splits_reserved_corners_and_deterministic_digest(teacher_paths):
    engine = FakeCore()
    progress = []
    first = _generate(teacher_paths, engine, on_progress=lambda done, total: progress.append((done, total)))
    replay = _generate(teacher_paths, engine)
    assert first == replay
    data.validate_dataset(first)
    assert first["failures"] == []
    rows = list(itertools.chain.from_iterable(first["splits"].values()))
    assert len(rows) == 24 and len({row["id"] for row in rows}) == 24
    assert progress == [(done, 24) for done in range(25)]
    corners = set(itertools.product(*((f["min"], f["max"]) for f in data.FEATURES)))
    assert {tuple(row["x"]) for row in first["splits"]["boundary"]} == corners
    for name in ("train", "calibration", "test"):
        assert not {tuple(row["x"]) for row in first["splits"][name]} & corners
    assert len(set(first["sampling"]["split_seeds"].values())) == 3
    changed_seed = _generate(teacher_paths, seed=20261021)
    assert changed_seed["splits"]["train"] != first["splits"]["train"]
    assert changed_seed["splits"]["boundary"] == first["splits"]["boundary"]
    assert changed_seed["digest"] != first["digest"]


def test_final_mass_and_tds_include_post_stop_drip_without_relabeling_it(teacher_paths):
    document = _generate(teacher_paths)
    for row in document["splits"]["train"]:
        dose = row["x"][1] / 1000
        stop_mass = dose * row["x"][2]
        assert row["y"][1] == pytest.approx(stop_mass + 0.003)
        assert row["tds"] == pytest.approx(row["y"][2] * dose / row["y"][1])
        assert not math.isclose(row["tds"], row["y"][2] * dose / stop_mass)


@pytest.mark.parametrize("mode", ["exception", "capped", "negative", "mass", "volume", "tds",
                                 "version", "tier", "outflow", "nonfinite"])
def test_failed_or_capped_teacher_is_accounted_and_training_refuses_it(teacher_paths, mode):
    baseline = _generate(teacher_paths)
    engine = FakeCore()
    engine.fail_x = baseline["splits"]["train"][1]["x"]
    engine.failure_mode = mode
    document = _generate(teacher_paths, engine)
    assert len(document["splits"]["train"]) == 3
    assert len(document["failures"]) == 1
    failure = document["failures"][0]
    assert failure["id"] == baseline["splits"]["train"][1]["id"]
    assert failure["split"] == "train" and failure["x"] == engine.fail_x
    assert failure["error"]
    assert document["sampling"]["counts"]["train"] == 4
    data.validate_dataset(document, allow_failures=True)
    with pytest.raises(ValueError, match="training is refused"):
        data.validate_dataset(document)


def test_capped_boundary_is_retained_without_becoming_a_training_sample(teacher_paths):
    engine = FakeCore()
    engine.fail_x = [170.0, 16.0, 2.5, 90.0]
    engine.failure_mode = "capped"
    document = _generate(teacher_paths, engine)
    assert len(document["splits"]["boundary"]) == 15
    assert document["failures"][0]["split"] == "boundary"
    assert document["failures"][0]["stop_reason"] == "time"
    assert len(document["splits"]["train"]) == 4
    data.validate_dataset(document, allow_failures=True)
    with pytest.raises(ValueError, match="training is refused"):
        data.validate_dataset(document)


def test_validator_detects_leakage_or_forged_scientific_content_even_after_rehash(teacher_paths):
    baseline = _generate(teacher_paths)
    changed = copy.deepcopy(baseline)
    changed["splits"]["test"][0] = copy.deepcopy(changed["splits"]["train"][0])
    with pytest.raises(ValueError, match="duplicate"):
        data.validate_dataset(_refresh(changed))
    changed = copy.deepcopy(baseline)
    changed["splits"]["train"][0]["y"][0] += 1
    with pytest.raises(ValueError, match="digest mismatch"):
        data.validate_dataset(changed)
    changed = copy.deepcopy(baseline)
    changed["splits"]["boundary"].pop()
    changed["sampling"]["counts"]["boundary"] = 15
    with pytest.raises(ValueError, match="sixteen"):
        data.validate_dataset(_refresh(changed))
    changed = copy.deepcopy(baseline)
    changed["teacher"]["registry_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="teacher fingerprint"):
        data.validate_dataset(_refresh(changed))
    changed = copy.deepcopy(baseline)
    changed["splits"]["train"][0]["tds"] *= 2
    with pytest.raises(ValueError, match="TDS disagrees"):
        data.validate_dataset(_refresh(changed))


@pytest.mark.parametrize("mutation", ["root_seed", "split_seed", "coherent_new_seeds",
                                      "moved_coordinates", "swapped_splits"])
def test_validator_replays_sobol_provenance_even_after_rehash(teacher_paths, mutation):
    document = _generate(teacher_paths)
    if mutation in ("root_seed", "coherent_new_seeds"):
        document["sampling"]["seed"] += 1
    if mutation == "coherent_new_seeds":
        document["sampling"]["split_seeds"] = {
            name: int(data.digest({"seed": document["sampling"]["seed"], "split": name})[:8], 16)
            for name in ("train", "calibration", "test")}
    elif mutation == "split_seed":
        document["sampling"]["split_seeds"]["train"] += 1
    elif mutation == "moved_coordinates":
        row = document["splits"]["train"][0]
        row["x"][3] += 0.001
        row["id"] = data.digest(row["x"])
    elif mutation == "swapped_splits":
        train, test = document["splits"]["train"], document["splits"]["test"]
        train[0], test[0] = test[0], train[0]
    with pytest.raises(ValueError, match="Sobol"):
        data.validate_dataset(_refresh(document))


def test_replay_includes_failed_coordinates_but_allows_reordering_within_the_same_split(teacher_paths):
    document = _generate(teacher_paths)
    for rows in document["splits"].values():
        rows.reverse()
    data.validate_dataset(_refresh(document))
    row = document["splits"]["train"].pop()
    document["failures"].append({"id": row["id"], "split": "train", "x": row["x"],
                                 "error": "recorded native failure"})
    data.validate_dataset(_refresh(document), allow_failures=True)
    failure = document["failures"][0]
    failure["x"][3] += 0.001
    failure["id"] = data.digest(failure["x"])
    with pytest.raises(ValueError, match="Sobol"):
        data.validate_dataset(_refresh(document), allow_failures=True)


def test_scientific_digest_ignores_only_top_level_timing_and_date_annotations(teacher_paths):
    document = _generate(teacher_paths)
    expected = document["digest"]
    document.update(created="2099-01-01", timing_s={"total": 800}, timings={"fit": 3.0})
    assert data.dataset_digest(document) == expected
    data.validate_dataset(document)
    document["sampling"]["seed"] += 1
    assert data.dataset_digest(document) != expected
    assert data.digest({"a": 1, "b": 2}) == data.digest({"b": 2, "a": 1})
    with pytest.raises(ValueError):
        data.digest({"not_finite": float("nan")})


@pytest.mark.parametrize("controls", [
    {"train": 3}, {"calibration": 0}, {"test": 8192}, {"seed": True}, {"seed": -1},
    {"seed": 2**32}, {"workers": 0}, {"workers": 5}, {"workers": True},
])
def test_invalid_generation_controls_fail_before_loading_a_teacher(teacher_paths, monkeypatch, controls):
    def unexpected_import():
        pytest.fail("invalid controls must not load the core")

    monkeypatch.setattr(data, "import_puckcore", unexpected_import)
    with pytest.raises(ValueError):
        data.generate_dataset(teacher_paths, **controls)


def test_custom_teacher_is_never_sent_into_worker_processes(teacher_paths):
    with pytest.raises(ValueError, match="injected teacher requires workers=1"):
        data.generate_dataset(teacher_paths, workers=2, core=FakeCore())
