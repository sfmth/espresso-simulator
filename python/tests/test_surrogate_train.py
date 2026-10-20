# SPDX-License-Identifier: GPL-2.0-or-later
"""Neural fitting, held-out isolation, accounting and bounded artifact checks."""

from __future__ import annotations

import copy
import itertools

import numpy as np
import pytest
from scipy.optimize._numdiff import approx_derivative
from scipy.stats import qmc

from puckworks_tools import surrogate_train as train
from puckworks_tools.surrogate_data import (
    FEATURES, TARGETS, base_recipe, dataset_digest, digest, recipe_features, recipe_for_features,
)


def synthetic_dataset():
    """Known smooth function with physical cup accounting, no native teacher dependency."""
    center, scale = train._support()

    def row(x):
        x = np.asarray(x, dtype=float)
        z = (x - center) / scale
        time = 25 + 3 * z[0] + 2 * z[1] + z[2] + 0.5 * z[3] + 0.2 * np.sin(z[0] * z[3])
        mass = x[1] * x[2] / 1000 + 0.002
        ey = 0.20 + 0.01 * z[0] - 0.005 * z[1] + 0.008 * z[3] + 0.002 * z[0] * z[2]
        values = [float(time), float(mass), float(ey)]
        return {"id": digest(x.tolist()), "x": x.tolist(), "y": values,
                "tds": float(ey * x[1] / 1000 / mass), "stop_reason": "beverage_mass"}

    teacher = {
        "schema": "puckworks.surrogate-teacher/1", "core_version": "synthetic-test",
        "registry_sha256": digest("test registry"), "presets_sha256": digest("test presets"),
        "sources_sha256": {"synthetic-test": digest("known smooth test function")},
        "embedded_behavior_sha256": digest("known smooth test outputs"),
        "probe_features": [[190., 18., 2., 93.], [170., 16., 1.5, 90.], [230., 20., 2.5, 96.]],
    }
    teacher["fingerprint"] = digest(teacher)
    counts = {"train": 128, "calibration": 32, "test": 32, "boundary": 16}
    root_seed = 1
    seeds = {name: int(digest({"seed": root_seed, "split": name})[:8], 16)
             for name in ("train", "calibration", "test")}
    splits = {}
    for split, seed in seeds.items():
        points = qmc.Sobol(4, scramble=True, seed=seed).random_base2(counts[split].bit_length() - 1)
        scaled = qmc.scale(points, [feature["min"] for feature in FEATURES],
                           [feature["max"] for feature in FEATURES])
        splits[split] = [row(recipe_features(recipe_for_features(x))) for x in scaled]
    splits["boundary"] = [row(x) for x in itertools.product(*((f["min"], f["max"]) for f in FEATURES))]
    data = {"schema": "puckworks.surrogate-dataset/1", "features": copy.deepcopy(FEATURES),
            "targets": list(TARGETS), "base_recipe": base_recipe(), "teacher": teacher,
            "sampling": {"method": "independent_scrambled_sobol", "seed": root_seed,
                         "split_seeds": seeds, "counts": counts, "boundary": "all_16_corners_test_only",
                         "generator_sha256": digest("synthetic fixture generator")},
            "splits": splits, "failures": []}
    data["digest"] = dataset_digest(data)
    return data


@pytest.fixture(scope="module")
def dataset():
    return synthetic_dataset()


@pytest.fixture(scope="module")
def artifact(dataset):
    return train.train_dataset(dataset, seed=123, max_iter=600)


def reseal(artifact):
    artifact["artifact_digest"] = digest({key: value for key, value in artifact.items() if key != "artifact_digest"})


def test_analytic_gradient_matches_independent_numerical_derivative():
    rng = np.random.default_rng(19)
    x, y = rng.normal(size=(7, 4)), rng.normal(size=(7, 3))
    weights = rng.normal(scale=0.2, size=131)
    loss, gradient = train._loss_gradient(weights, x, y)
    numerical = approx_derivative(lambda p: train._loss_gradient(p, x, y)[0], weights).ravel()
    assert loss > 0
    np.testing.assert_allclose(gradient, numerical, rtol=2e-7, atol=2e-9)


def test_trains_three_real_networks_and_predicts_known_heldout_function(dataset, artifact):
    assert len(artifact["members"]) == 3
    assert len({member["seed"] for member in artifact["members"]}) == 3
    x = np.array([row["x"] for row in dataset["splits"]["test"]])
    expected = np.array([row["y"] for row in dataset["splits"]["test"]])
    values = train.infer_values(artifact, x)
    assert values.shape == (32, 4)
    np.testing.assert_array_less(np.max(np.abs(values[:, :3] - expected), axis=0), [0.08, 0.00015, 0.0005])
    np.testing.assert_allclose(values[:, 3], values[:, 2] * x[:, 1] / 1000 / values[:, 1], rtol=1e-15)
    assert artifact["metrics"]["test"]["count"] == 32
    assert artifact["metrics"]["boundary"]["count"] == 16
    assert artifact["quality"]["browser_approved"] is False
    assert artifact["source_dataset_digest"] == dataset["digest"]
    # Every member is a learned nonlinear map, rather than copied teacher rows.
    assert all(np.linalg.norm(member["W1"]) > 0 for member in artifact["members"])


def test_deterministic_fit_and_heldout_poison_does_not_change_weights_or_scales(dataset, artifact):
    poisoned = copy.deepcopy(dataset)
    for split in ("calibration", "test", "boundary"):
        for row in poisoned["splits"][split]:
            row["y"][0] = 59.0
            row["y"][1] += 0.02
            row["y"][2] = 0.45
            row["tds"] = row["y"][2] * row["x"][1] / 1000 / row["y"][1]
    poisoned["digest"] = dataset_digest(poisoned)
    other = train.train_dataset(poisoned, seed=123, max_iter=600)
    assert other["members"] == artifact["members"]
    assert other["scales"] == artifact["scales"]
    assert other["training"] == artifact["training"]
    assert other["calibration"]["radius"] != artifact["calibration"]["radius"]
    assert other["metrics"]["test"] != artifact["metrics"]["test"]
    assert not other["quality"]["accuracy_pass"]
    assert not other["quality"]["qualified_small_scope"]
    assert other["quality"]["browser_approved"] is False
    # Report failures explicitly, without relabelling them scientific success.
    report = train.render_report(other)
    assert "qualification: **fail**" in report
    assert "not confidence intervals" in report
    assert "Raw ensemble spread is not treated as confidence" in report
    assert "Browser approved: false" in report


def test_test_and_boundary_poison_cannot_choose_calibration_radius(dataset):
    original = train.train_dataset(dataset, seed=17, max_iter=3)
    changed = copy.deepcopy(dataset)
    for split in ("test", "boundary"):
        for row in changed["splits"][split]:
            row["y"][0] = 59.0
    changed["digest"] = dataset_digest(changed)
    poisoned = train.train_dataset(changed, seed=17, max_iter=3)
    assert poisoned["members"] == original["members"]
    assert poisoned["calibration"]["radius"] == original["calibration"]["radius"]
    assert poisoned["calibration"]["observed_coverage"]["calibration"] == original["calibration"]["observed_coverage"]["calibration"]
    assert not poisoned["quality"]["qualified_small_scope"]


def test_training_output_scales_and_denominators_use_training_rows_only(dataset, artifact):
    y = np.array([row["y"] for row in dataset["splits"]["train"]])
    tds = np.array([row["tds"] for row in dataset["splits"]["train"]])
    np.testing.assert_array_equal(artifact["scales"]["output_center"], y.mean(axis=0))
    np.testing.assert_array_equal(artifact["scales"]["output_scale"], y.std(axis=0))
    ranges = np.ptp(np.column_stack((y, tds)), axis=0)
    for split in train.SPLITS:
        for i, name in enumerate(train.OUTPUTS):
            assert artifact["metrics"][split]["outputs"][name]["train_range"] == pytest.approx(ranges[i])


def test_calibration_radius_is_order_statistic_of_calibration_residuals(dataset, artifact):
    rows = dataset["splits"]["calibration"]
    predicted = train.infer_values(artifact, [row["x"] for row in rows])
    actual = np.array([row["y"] + [row["tds"]] for row in rows])
    expected = np.sort(np.abs(predicted - actual), axis=0)[artifact["calibration"]["rank"] - 1]
    np.testing.assert_allclose(artifact["calibration"]["radius"], expected, rtol=1e-12, atol=1e-15)


def test_constant_ranges_are_explicit_and_never_divide_by_zero():
    predicted = np.ones((3, 4))
    metrics = train._metrics(predicted, predicted, np.zeros(4))
    assert all(entry["constant_train_range"] and entry["accuracy_pass"]
               and entry["max_over_train_range"] is None for entry in metrics["outputs"].values())
    changed = train._metrics(predicted + 1e-6, predicted, np.zeros(4))
    assert all(not entry["accuracy_pass"] for entry in changed["outputs"].values())


def test_physical_prediction_gate_includes_requested_stop_mass():
    x = np.array([[190., 18., 2., 93.]])
    physical = np.array([[25., 0.038, 0.2, 0.2 * 0.018 / 0.038]])
    short_cup = np.array([[25., 0.035, 0.2, 0.2 * 0.018 / 0.035]])
    assert train._physical(physical, x)
    assert not train._physical(short_cup, x)
    metrics = train._metrics(short_cup, physical, np.ones(4), x)
    assert not metrics["physical_predictions"]


@pytest.mark.parametrize("mutation", [
    lambda a: a["members"][0]["W1"].pop(),
    lambda a: a["members"][1]["b1"].append(0),
    lambda a: a["members"][2]["W2"][0].append(0),
    lambda a: a["members"][0]["b2"].__setitem__(0, "0"),
    lambda a: a["members"][0]["b2"].__setitem__(0, True),
    lambda a: a["members"][0].update(extra="unknown"),
    lambda a: a["members"].append(copy.deepcopy(a["members"][0])),
    lambda a: a["members"][0].update(seed=a["members"][1]["seed"]),
    lambda a: a["scales"]["output_scale"].__setitem__(0, 0),
    lambda a: a["scales"]["input_scale"].__setitem__(0, 1),
    lambda a: a["features"].reverse(),
    lambda a: a["architecture"].update(hidden_size=32),
    lambda a: a["quality"].update(browser_approved=True),
    lambda a: a["quality"].update(qualified_small_scope=not a["quality"]["qualified_small_scope"]),
    lambda a: a["quality"].update(no_failures=1),
    lambda a: a["calibration"]["radius"].__setitem__(0, -1),
    lambda a: a["calibration"]["observed_coverage"]["test"].__setitem__(0, 1.1),
    lambda a: a["metrics"]["test"]["outputs"]["ey"].update(train_range=100),
])
def test_artifact_rejects_malformed_or_lying_content_even_with_recomputed_digest(artifact, mutation):
    changed = copy.deepcopy(artifact)
    mutation(changed)
    reseal(changed)
    with pytest.raises(ValueError):
        train.validate_artifact(changed)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf"), 10**1000])
def test_nonfinite_or_unrepresentable_weights_are_rejected_before_hashing(artifact, value):
    changed = copy.deepcopy(artifact)
    changed["members"][0]["W1"][0][0] = value
    with pytest.raises(ValueError):
        train.validate_artifact(changed)


def test_digest_tampering_and_oversized_artifacts_are_rejected(artifact):
    changed = copy.deepcopy(artifact)
    changed["members"][0]["b2"][0] += 1
    with pytest.raises(ValueError, match="digest"):
        train.validate_artifact(changed)
    changed = copy.deepcopy(artifact)
    changed["training"]["fits"][0]["message"] = "x" * 100_001
    with pytest.raises(ValueError, match="limit"):
        train.validate_artifact(changed)


def test_canonical_integrity_is_independent_of_dictionary_insertion_order(artifact):
    changed = copy.deepcopy(artifact)
    outputs = changed["metrics"]["boundary"]["outputs"]
    changed["metrics"]["boundary"]["outputs"] = dict(reversed(list(outputs.items())))
    # Key ordering changes neither the canonical digest nor target identities.
    train.validate_artifact(changed)


@pytest.mark.parametrize("change", ["failure", "duplicate", "stale_digest"])
def test_invalid_datasets_fail_before_optimizer(dataset, monkeypatch, change):
    changed = copy.deepcopy(dataset)
    if change == "failure":
        changed["failures"].append({"id": "bad", "error": "simulation failed"})
    elif change == "duplicate":
        changed["splits"]["test"][0] = copy.deepcopy(changed["splits"]["train"][0])
    else:
        changed["splits"]["train"][0]["y"][0] += 0.1
    if change != "stale_digest":
        changed["digest"] = dataset_digest(changed)
    monkeypatch.setattr(train, "minimize", lambda *a, **k: pytest.fail("invalid dataset reached optimizer"))
    with pytest.raises(ValueError):
        train.train_dataset(changed)


@pytest.mark.parametrize("x", [[[1, 2, 3]], [[1, 2, 3, float("nan")]], [[True] * 4], [["1"] * 4]])
def test_inference_rejects_invalid_numeric_shapes(artifact, x):
    with pytest.raises(ValueError):
        train.infer_values(artifact, x)


def test_empty_numeric_batch_has_four_output_columns(artifact):
    assert train.infer_values(artifact, np.empty((0, 4))).shape == (0, 4)


def test_evaluation_replay_validates_actual_weights_without_fitting(dataset, artifact, monkeypatch):
    monkeypatch.setattr(train, "minimize", lambda *a, **k: pytest.fail("evaluation replay fitted weights"))
    train.verify_evaluation(artifact, dataset)
    changed = copy.deepcopy(artifact)
    changed["members"][0]["b2"][0] += 0.25
    reseal(changed)
    # Integrity alone cannot establish that the stored errors describe these weights.
    train.validate_artifact(changed)
    with pytest.raises(ValueError, match="evaluation replay differs at metrics"):
        train.verify_evaluation(changed, dataset)


def test_evaluation_replay_rejects_changed_output_scales_even_if_predictions_are_preserved(dataset, artifact):
    changed = copy.deepcopy(artifact)
    changed["scales"]["output_scale"] = (np.array(changed["scales"]["output_scale"]) * 2).tolist()
    for member in changed["members"]:
        member["W2"] = (np.array(member["W2"]) / 2).tolist()
        member["b2"] = (np.array(member["b2"]) / 2).tolist()
    reseal(changed)
    train.validate_artifact(changed)
    with pytest.raises(ValueError, match="scales.output_scale"):
        train.verify_evaluation(changed, dataset)


def test_evaluation_replay_rejects_invented_calibration_radii(dataset, artifact):
    changed = copy.deepcopy(artifact)
    changed["calibration"]["radius"][0] += 1
    reseal(changed)
    train.validate_artifact(changed)
    with pytest.raises(ValueError, match="calibration.radius"):
        train.verify_evaluation(changed, dataset)


def test_evaluation_replay_binds_the_exact_supplied_dataset(dataset, artifact):
    changed = copy.deepcopy(dataset)
    changed["splits"]["test"][0]["y"][0] += 0.1
    changed["digest"] = dataset_digest(changed)
    with pytest.raises(ValueError, match="dataset digest differs"):
        train.verify_evaluation(artifact, changed)
