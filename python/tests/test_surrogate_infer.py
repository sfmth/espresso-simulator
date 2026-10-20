# SPDX-License-Identifier: GPL-2.0-or-later
"""Guard decisions exercise real neural evaluation and real/fake Tier 1 APIs."""

from __future__ import annotations

import copy
from types import SimpleNamespace

import numpy as np
import pytest

from puckworks_tools import surrogate_infer as inference
from puckworks_tools.surrogate_data import FEATURES, TARGETS, base_recipe, digest, recipe_for_features
from puckworks_tools.surrogate_train import ARCHITECTURE, L2, OUTPUTS, validate_artifact


class FakeCore:
    __version__ = "test-core"

    def __init__(self):
        self.calls = []
        self.registry_hash = "a" * 64
        self.presets_hash = "b" * 64

    def simulate_recipe(self, recipe):
        self.calls.append(copy.deepcopy(recipe))
        if recipe.get("prep", {}).get("dose_g", 18) <= 0:
            raise ValueError("prep.dose_g must be positive")
        dose = recipe["prep"]["dose_g"] / 1000
        mass = 0.052
        ey = 0.19
        return {"result": {
            "core_version": self.__version__,
            "summary": {"shot_time_s": 21.234, "beverage_mass_kg": mass, "ey": ey,
                        "tds": ey * dose / mass, "max_pressure_pa": 900000,
                        "species": [{"id": "not-a-model-output"}]},
            "series": {"t_s": [0, 21.234]}, "spatial": {"snapshots": []},
            "diagnostics": {"mass_balance_error": 0},
        }}


def identity(core):
    document = {
        "schema": "puckworks.surrogate-teacher/1", "core_version": core.__version__,
        "registry_sha256": core.registry_hash, "presets_sha256": core.presets_hash,
        "sources_sha256": {"crates/puckcore/src": "c" * 64},
        "embedded_behavior_sha256": "d" * 64,
        "probe_features": [[170.0, 16.0, 1.5, 90.0], [200.0, 18.0, 2.0, 93.0],
                           [230.0, 20.0, 2.5, 96.0]],
    }
    return {**document, "fingerprint": digest(document)}


def resign(artifact):
    artifact["artifact_digest"] = digest({key: value for key, value in artifact.items()
                                         if key != "artifact_digest"})
    return artifact


@pytest.fixture
def engine(monkeypatch):
    core = FakeCore()
    monkeypatch.setattr(inference, "teacher_identity", lambda paths, core: identity(core))
    return core


@pytest.fixture
def artifact(engine):
    """An exactly representable synthetic constant-scalar teacher, not fitted coffee data.

    Zero residual weights encode time 18 s, cup 54 g, EY .22. TDS varies with
    dose through the same final-cup accounting as the production evaluator.
    """
    outputs = {}
    for name in OUTPUTS:
        span = 0.004 / 0.054 * 0.22 if name == "tds" else 0
        outputs[name] = {"mae": 0.0, "rmse": 0.0, "p95_abs": 0.0, "max_abs": 0.0,
                         "train_range": span, "max_over_train_range": 0.0 if span else None,
                         "constant_train_range": not bool(span), "accuracy_pass": True}
    lower = np.array([feature["min"] for feature in FEATURES])
    upper = np.array([feature["max"] for feature in FEATURES])
    result = {
        "schema": "puckworks.scalar-surrogate/1", "teacher": identity(engine),
        "features": copy.deepcopy(FEATURES), "targets": list(TARGETS), "outputs": list(OUTPUTS),
        "base_recipe": base_recipe(), "architecture": dict(ARCHITECTURE),
        "scales": {"input_center": ((lower + upper) / 2).tolist(),
                   "input_scale": ((upper - lower) / 2).tolist(),
                   "output_center": [18.0, 0.054, 0.22], "output_scale": [1.0, 1.0, 1.0]},
        "members": [{"seed": seed, "W1": np.zeros((4, 16)).tolist(), "b1": [0.0] * 16,
                     "W2": np.zeros((16, 3)).tolist(), "b2": [0.0] * 3} for seed in (1, 2, 3)],
        "source_dataset_digest": "e" * 64,
        "training": {"seed": 10, "max_iter": 1, "l2": L2, "optimizer": "L-BFGS-B",
                     "dataset_failures": 0,
                     "fits": [{"converged": True, "iterations": 0, "loss": 0.0,
                               "message": "exact synthetic fixture"} for _ in range(3)]},
        "metrics": {split: {"count": 4, "physical_predictions": True,
                            "outputs": copy.deepcopy(outputs)}
                    for split in ("train", "calibration", "test", "boundary")},
        "calibration": {"kind": "simulation_approximation_error", "nominal_coverage": 0.9,
                        "method": "split_absolute_residual_quantile", "count": 4, "rank": 4,
                        "radius": [0.1, 0.001, 0.002, 0.003],
                        "observed_coverage": {split: [1.0] * 4 for split in ("calibration", "test", "boundary")},
                        "interpretation": "Synthetic simulator residual fixture."},
        "quality": {"qualified_small_scope": True, "browser_approved": False,
                    "accuracy_target_fraction": 0.01, "accuracy_pass": True,
                    "no_failures": True, "physical_predictions": True},
    }
    resign(result)
    validate_artifact(result)
    return result


def codes(result):
    return {reason["code"] for reason in result["fallback_reasons"]}


def assert_scalar_only(result):
    assert result["schema"] == "puckworks.scalar-prediction/1"
    assert set(result["scalars"]) == set(OUTPUTS)
    assert result["browser_approved"] is False
    assert not {"summary", "result", "series", "spatial", "chemistry", "species", "diagnostics"} & result.keys()


@pytest.mark.parametrize("features", [[190, 18, 2, 93], [170, 16, 1.5, 90], [230, 20, 2.5, 96]])
def test_qualified_in_domain_real_network_and_accounting(repo, engine, artifact, features):
    recipe = recipe_for_features(features)
    result = inference.predict_or_simulate(recipe, artifact, repo, core=engine)
    assert result["mode"] == "surrogate"
    assert result["qualification"] == "qualified_small_scope"
    assert result["fallback_reasons"] == []
    assert result["scalars"] == pytest.approx({
        "shot_time_s": 18, "beverage_mass_kg": 0.054, "ey": 0.22,
        "tds": 0.22 * features[1] / 1000 / 0.054,
    })
    assert not engine.calls
    intervals = result["intervals"]
    assert intervals["kind"] == "simulation_approximation_error"
    assert "not physical" in intervals["interpretation"]
    assert intervals["outputs"]["ey"] == pytest.approx({"lower": 0.218, "upper": 0.222})
    assert_scalar_only(result)


@pytest.mark.parametrize("mutate", [
    lambda recipe: recipe["numerics"].update(tier=0),
    lambda recipe: recipe["grinder"].update(setting=169),
    lambda recipe: recipe["bean"].update(days_off_roast=12),
    lambda recipe: recipe["machine"].update(preset="lever-declining"),
    lambda recipe: recipe.update(overrides={"hydraulics.permeability.reference": 1e-13}),
    lambda recipe: recipe.update(water={"ph": 6.7}),
])
def test_unsupported_inputs_use_physics_without_discarding_any_fields(repo, engine, artifact, mutate):
    recipe = base_recipe()
    mutate(recipe)
    original = copy.deepcopy(recipe)
    result = inference.predict_or_simulate(recipe, artifact, repo, core=engine)
    expected = copy.deepcopy(recipe)
    expected["numerics"]["tier"] = 1
    assert engine.calls == [expected]
    assert recipe == original
    assert result["mode"] == "physics" and "unsupported_recipe" in codes(result)
    assert result["scalars"]["shot_time_s"] == 21.234
    assert result["scalars"]["tds"] == pytest.approx(0.19 * 0.018 / 0.052)
    assert "intervals" not in result
    assert_scalar_only(result)


@pytest.mark.parametrize("field", ["__version__", "registry_hash", "presets_hash"])
def test_current_version_registry_and_preset_identity_must_match(repo, engine, artifact, field):
    setattr(engine, field, "changed")
    result = inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine)
    assert result["mode"] == "physics"
    assert codes(result) == {"teacher_identity_mismatch"}
    assert len(engine.calls) == 1


@pytest.mark.parametrize("error", [ValueError("missing source"), OSError("unreadable source"),
                                 RuntimeError("identity probe failed")])
def test_unavailable_teacher_identity_falls_back_and_keeps_actual_core_errors(repo, engine, artifact, monkeypatch, error):
    def unavailable(*args, **kwargs):
        raise error

    monkeypatch.setattr(inference, "teacher_identity", unavailable)
    result = inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine)
    assert result["mode"] == "physics" and codes(result) == {"teacher_identity_unavailable"}
    assert len(engine.calls) == 1

    def failed_physics(recipe):
        raise ValueError("actual physical run failed")

    monkeypatch.setattr(engine, "simulate_recipe", failed_physics)
    with pytest.raises(ValueError, match="actual physical run failed"):
        inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine)


@pytest.mark.parametrize("mutate,refresh_digest", [
    (lambda model: model["members"][0]["W1"].pop(), True),
    (lambda model: model["members"][0]["b2"].__setitem__(0, float("nan")), False),
    (lambda model: model["quality"].update(qualified_small_scope=False), True),
    (lambda model: model["quality"].update(browser_approved=True), True),
    (lambda model: model.update(artifact_digest="0" * 64), False),
])
def test_invalid_weight_shape_nonfinite_weights_digest_or_gate_never_infer(repo, engine, artifact, monkeypatch, mutate, refresh_digest):
    mutate(artifact)
    if refresh_digest:
        resign(artifact)
    monkeypatch.setattr(inference, "infer_values", lambda *args: pytest.fail("invalid model was evaluated"))
    result = inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine)
    assert result["mode"] == "physics" and codes(result) == {"invalid_artifact"}
    assert len(engine.calls) == 1


def test_valid_but_failed_heldout_accuracy_uses_physics(repo, engine, artifact, monkeypatch):
    entry = artifact["metrics"]["test"]["outputs"]["tds"]
    entry.update(max_abs=entry["train_range"] * 0.02, max_over_train_range=0.02, accuracy_pass=False)
    artifact["quality"].update(qualified_small_scope=False, accuracy_pass=False)
    resign(artifact)
    validate_artifact(artifact)
    monkeypatch.setattr(inference, "infer_values", lambda *args: pytest.fail("unqualified model was evaluated"))
    result = inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine)
    assert codes(result) == {"unqualified_model"}


@pytest.mark.parametrize("values", [[0, .054, .22, .22 * .018 / .054],
                                    [60.01, .054, .22, .22 * .018 / .054],
                                    [18, .035, .22, .22 * .018 / .035],
                                    [18, -.054, .22, -.22 * .018 / .054],
                                    [18, .054, 1.01, 1.01 * .018 / .054],
                                    [18, .054, .22, .9], [18, .054, .22, float("nan")]])
def test_nonphysical_predictions_are_not_clipped_or_accepted(repo, engine, artifact, monkeypatch, values):
    monkeypatch.setattr(inference, "infer_values", lambda *args: np.array([values]))
    result = inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine)
    assert result["mode"] == "physics" and codes(result) == {"nonphysical_prediction"}
    assert result["scalars"]["shot_time_s"] == 21.234


def test_valid_finite_weights_can_predict_below_stop_mass_and_must_fall_back(repo, engine, artifact):
    artifact["scales"]["output_center"][1] = 0.03
    resign(artifact)
    validate_artifact(artifact)
    result = inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine)
    assert result["mode"] == "physics" and codes(result) == {"nonphysical_prediction"}


def test_actual_bad_recipe_is_an_error_not_an_estimate(repo, engine, artifact):
    recipe = base_recipe()
    recipe["prep"]["dose_g"] = -1
    with pytest.raises(ValueError, match="dose_g"):
        inference.predict_or_simulate(recipe, artifact, repo, core=engine)
    recipe["prep"]["dose_g"] = float("nan")
    with pytest.raises(ValueError, match="finite JSON"):
        inference.predict_or_simulate(recipe, artifact, repo, core=engine)


def test_cancel_before_work_or_before_fallback_never_starts_physics(repo, engine, artifact, monkeypatch):
    with pytest.raises(inference.PredictionCancelled):
        inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine, cancelled=lambda: True)
    checks = iter([False, True])
    with pytest.raises(inference.PredictionCancelled):
        inference.predict_or_simulate(base_recipe(), None, repo, core=engine, cancelled=lambda: next(checks))
    monkeypatch.setattr(inference, "infer_values", lambda *args: pytest.fail("cancelled model was evaluated"))
    checks = iter([False, False, True])
    with pytest.raises(inference.PredictionCancelled):
        inference.predict_or_simulate(base_recipe(), artifact, repo, core=engine, cancelled=lambda: next(checks))
    assert not engine.calls


def test_missing_or_nonfinite_physics_summary_is_not_fabricated(repo):
    engine = SimpleNamespace(simulate_recipe=lambda recipe: {"result": {"summary": {}}})
    with pytest.raises(ValueError, match="complete finite scalar summary"):
        inference.predict_or_simulate(base_recipe(), None, repo, core=engine)


def test_native_fallback_matches_actual_tier1_with_physical_override(repo):
    core = pytest.importorskip("puckcore")
    recipe = base_recipe()
    recipe["numerics"].update(tier=0, size_classes=4)
    recipe["machine"]["temperature_c"] = 88
    recipe["stop"]["beverage_g"] = 24
    recipe["overrides"] = {"hydraulics.permeability.reference": 1e-13}
    expected_recipe = copy.deepcopy(recipe)
    expected_recipe["numerics"]["tier"] = 1
    expected = core.simulate_recipe(expected_recipe)["result"]["summary"]
    result = inference.predict_or_simulate(recipe, None, repo, core=core)
    assert result["mode"] == "physics"
    assert result["scalars"] == {key: expected[key] for key in OUTPUTS}
    assert_scalar_only(result)
