# SPDX-License-Identifier: GPL-2.0-or-later
"""Small offline neural ensembles; their errors describe a simulator, not espresso accuracy.

Only training rows fit weights or output scales. Calibration rows supply separate
absolute-residual radii; test and boundary rows are frozen evaluation sets. The
artifact deliberately cannot approve browser use.
"""

from __future__ import annotations

import copy
import math
from typing import Any

import numpy as np
from scipy.optimize import minimize

from .surrogate_data import FEATURES, TARGETS, dataset_digest, digest, validate_dataset

SCHEMA = "puckworks.scalar-surrogate/1"
OUTPUTS = (*TARGETS, "tds")
SPLITS = ("train", "calibration", "test", "boundary")
ARCHITECTURE = {"kind": "tanh_mlp", "input_size": 4, "hidden_size": 16, "output_size": 3}
DEFAULT_SEED = 20261020
DEFAULT_MAX_ITER = 2000
MEMBERS = 3
ACCURACY_TARGET = 0.01
L2 = 1e-6
MAX_ARTIFACT_BYTES = 2_000_000


def _integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    return value


def _number(value: Any, name: str, minimum: float = -math.inf) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be finite")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite or value < minimum:
        raise ValueError(f"{name} must be finite and >= {minimum}")
    return float(value)


def _array(value: Any, shape: tuple[int, ...], name: str) -> np.ndarray:
    if not isinstance(value, list) or len(value) != shape[0]:
        raise ValueError(f"{name} must have shape {shape}")
    if len(shape) == 1:
        return np.array([_number(v, name) for v in value], dtype=float)
    return np.stack([_array(v, shape[1:], name) for v in value])


def _keys(value: Any, expected: set[str], name: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{name} has missing or unknown fields")


def _hash(value: Any, name: str) -> None:
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError(f"{name} must be a SHA-256 digest")


def _bounded_document(document: Any) -> None:
    """Bound traversal before serialisation, and reject non-JSON/nonfinite content."""
    remaining = 100_000

    def visit(value: Any, depth: int) -> None:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 32:
            raise ValueError("artifact exceeds structural limits")
        if value is None or isinstance(value, bool):
            return
        if isinstance(value, str):
            if len(value) > 100_000:
                raise ValueError("artifact string exceeds limit")
        elif isinstance(value, (int, float)):
            _number(value, "artifact number")
        elif isinstance(value, list):
            for item in value:
                visit(item, depth + 1)
        elif isinstance(value, dict):
            for key, item in value.items():
                if not isinstance(key, str) or len(key) > 128:
                    raise ValueError("artifact key must be a short string")
                visit(item, depth + 1)
        else:
            raise ValueError("artifact must contain only JSON values")

    visit(document, 0)
    # digest() uses the same finite canonical JSON representation.
    import json
    if len(json.dumps(document, allow_nan=False, separators=(",", ":")).encode()) > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds byte limit")


def _support() -> tuple[np.ndarray, np.ndarray]:
    lower = np.array([feature["min"] for feature in FEATURES], dtype=float)
    upper = np.array([feature["max"] for feature in FEATURES], dtype=float)
    return (lower + upper) / 2, (upper - lower) / 2


def _coupled(values: np.ndarray, x: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        tds = values[:, 2] * (x[:, 1] / 1000) / values[:, 1]
    return np.column_stack((values, tds))


def _physical(values: np.ndarray, x: np.ndarray | None = None) -> bool:
    return bool(np.all(np.isfinite(values)) and np.all(values[:, 0] > 0)
                and np.all(values[:, 0] <= 60) and np.all(values[:, 1] > 0)
                and np.all((values[:, 2:] >= 0) & (values[:, 2:] <= 1))
                and (x is None or np.all(values[:, 1] >= x[:, 1] * x[:, 2] / 1000)))


def _dataset_arrays(dataset: Any) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    validate_dataset(dataset)
    if not isinstance(dataset, dict) or dataset.get("schema") != "puckworks.surrogate-dataset/1":
        raise ValueError("unsupported surrogate dataset schema")
    if dataset.get("features") != FEATURES or dataset.get("targets") != list(TARGETS):
        raise ValueError("dataset feature/target contract differs")
    if not isinstance(dataset.get("teacher"), dict) or not dataset["teacher"]:
        raise ValueError("dataset teacher identity is missing")
    if not isinstance(dataset.get("base_recipe"), dict) or not dataset["base_recipe"]:
        raise ValueError("dataset base recipe is missing")
    if dataset.get("failures") != []:
        raise ValueError("training requires a dataset without simulation failures")
    if dataset.get("digest") != dataset_digest(dataset):
        raise ValueError("dataset digest differs")
    _keys(dataset.get("splits"), set(SPLITS), "dataset splits")
    ids: set[str] = set()
    coordinates: set[tuple[float, ...]] = set()
    arrays = {}
    center, scale = _support()
    for split in SPLITS:
        rows = dataset["splits"][split]
        if not isinstance(rows, list) or not rows or len(rows) > 100_000:
            raise ValueError(f"{split} must contain 1–100000 rows")
        xs, ys = [], []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
                raise ValueError("dataset row needs an id")
            x = _array(row.get("x"), (4,), "row x")
            y = _array(row.get("y"), (3,), "row y")
            tds = _number(row.get("tds"), "row tds", 0)
            if np.any(np.abs((x - center) / scale) > 1 + 1e-12):
                raise ValueError("dataset row lies outside declared support")
            if row["id"] in ids or tuple(x) in coordinates:
                raise ValueError("dataset splits contain duplicate rows")
            ids.add(row["id"])
            coordinates.add(tuple(x))
            coupled = _coupled(y[None, :], x[None, :])
            if not _physical(coupled) or row.get("stop_reason") not in ("time", "beverage_mass"):
                raise ValueError("dataset row is not a physical completed shot")
            if not math.isclose(tds, coupled[0, 3], rel_tol=1e-10, abs_tol=1e-12):
                raise ValueError("dataset TDS disagrees with EY and beverage mass")
            xs.append(x)
            ys.append(coupled[0])
        arrays[split] = (np.stack(xs), np.stack(ys))
    return arrays


def _unpack(weights: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    return weights[:64].reshape(4, 16), weights[64:80], weights[80:128].reshape(16, 3), weights[128:131]


def _loss_gradient(weights: np.ndarray, x: np.ndarray, y: np.ndarray) -> tuple[float, np.ndarray]:
    w1, b1, w2, b2 = _unpack(weights)
    hidden = np.tanh(x @ w1 + b1)
    residual = hidden @ w2 + b2 - y
    loss = float(np.mean(residual ** 2) + L2 * (np.sum(w1 ** 2) + np.sum(w2 ** 2)))
    delta = 2 * residual / residual.size
    dh = (delta @ w2.T) * (1 - hidden ** 2)
    gradient = np.concatenate(((x.T @ dh + 2 * L2 * w1).ravel(), dh.sum(axis=0),
                               (hidden.T @ delta + 2 * L2 * w2).ravel(), delta.sum(axis=0)))
    return loss, gradient


def _member_values(artifact: dict[str, Any], x: np.ndarray) -> np.ndarray:
    scales = artifact["scales"]
    xn = (x - scales["input_center"]) / scales["input_scale"]
    predictions = []
    for member in artifact["members"]:
        hidden = np.tanh(xn @ np.array(member["W1"]) + member["b1"])
        prediction = (hidden @ np.array(member["W2"]) + member["b2"])
        predictions.append(_coupled(prediction * scales["output_scale"] + scales["output_center"], x))
    return np.stack(predictions)


def _infer(artifact: dict[str, Any], x: np.ndarray) -> np.ndarray:
    predictions = _member_values(artifact, x)
    # Deriving TDS after averaging preserves the displayed mean's accounting.
    return _coupled(np.mean(predictions[:, :, :3], axis=0), x)


def infer_values(artifact: dict[str, Any], x: Any) -> np.ndarray:
    """Return [time_s, final_mass_kg, EY, TDS]; no curves, chemistry or solver diagnostics.

    This numerical evaluator is not a domain or physical-validity guard. The
    guarded inference adapter must make those decisions before using its result.
    """
    validate_artifact(artifact)
    values = np.asarray(x)
    if values.ndim != 2 or values.shape[1] != 4 or values.dtype.kind not in "fiu":
        raise ValueError("inference input must have shape (n, 4) with finite numeric values")
    values = values.astype(float)
    if not np.all(np.isfinite(values)):
        raise ValueError("inference input must be finite")
    if len(values) == 0:
        return np.empty((0, 4))
    with np.errstate(over="ignore", invalid="ignore"):
        return _infer(artifact, values)


def _metrics(predicted: np.ndarray, actual: np.ndarray, ranges: np.ndarray,
             x: np.ndarray | None = None) -> dict[str, Any]:
    if not np.all(np.isfinite(predicted)):
        raise ValueError("ensemble produced nonfinite predictions")
    errors = np.abs(predicted - actual)
    outputs = {}
    for i, name in enumerate(OUTPUTS):
        maximum = float(errors[:, i].max())
        span = float(ranges[i])
        normalized = maximum / span if span > 0 else None
        outputs[name] = {
            "mae": float(errors[:, i].mean()),
            "rmse": float(np.sqrt(np.mean(errors[:, i] ** 2))),
            "p95_abs": float(np.quantile(errors[:, i], 0.95)),
            "max_abs": maximum,
            "train_range": span,
            "max_over_train_range": normalized,
            "constant_train_range": span == 0,
            "accuracy_pass": normalized <= ACCURACY_TARGET if normalized is not None else maximum == 0,
        }
    return {"count": len(actual), "physical_predictions": _physical(predicted, x), "outputs": outputs}


def train_dataset(dataset: dict[str, Any], *, seed: int = DEFAULT_SEED,
                  max_iter: int = DEFAULT_MAX_ITER) -> dict[str, Any]:
    """Fit the fixed architecture and report untouched test/boundary accuracy separately."""
    _integer(seed, "seed", 0, 2**32 - 1)
    _integer(max_iter, "max_iter", 1, 100_000)
    arrays = _dataset_arrays(dataset)
    x, y = arrays["train"]
    input_center, input_scale = _support()
    output_center = y[:, :3].mean(axis=0)
    output_scale = y[:, :3].std(axis=0)
    output_scale[output_scale == 0] = 1
    xn = (x - input_center) / input_scale
    yn = (y[:, :3] - output_center) / output_scale
    artifact: dict[str, Any] = {
        "schema": SCHEMA, "teacher": copy.deepcopy(dataset["teacher"]),
        "features": copy.deepcopy(FEATURES), "targets": list(TARGETS), "outputs": list(OUTPUTS),
        "base_recipe": copy.deepcopy(dataset["base_recipe"]), "architecture": dict(ARCHITECTURE),
        "scales": {"input_center": input_center.tolist(), "input_scale": input_scale.tolist(),
                   "output_center": output_center.tolist(), "output_scale": output_scale.tolist()},
        "members": [], "source_dataset_digest": dataset["digest"],
        "training": {"seed": seed, "max_iter": max_iter, "l2": L2,
                     "optimizer": "L-BFGS-B", "dataset_failures": 0, "fits": []},
    }
    for member_seed in np.random.SeedSequence(seed).generate_state(MEMBERS):
        rng = np.random.default_rng(int(member_seed))
        initial = np.concatenate((rng.uniform(-math.sqrt(6 / 20), math.sqrt(6 / 20), 64),
                                  np.zeros(16),
                                  rng.uniform(-math.sqrt(6 / 19), math.sqrt(6 / 19), 48), np.zeros(3)))
        result = minimize(_loss_gradient, initial, args=(xn, yn), jac=True, method="L-BFGS-B",
                          options={"maxiter": max_iter, "ftol": 1e-12, "gtol": 1e-8, "maxls": 40})
        if not np.all(np.isfinite(result.x)) or not math.isfinite(result.fun):
            raise ValueError("neural optimization produced nonfinite weights or loss")
        w1, b1, w2, b2 = _unpack(result.x)
        artifact["members"].append({"seed": int(member_seed), "W1": w1.tolist(), "b1": b1.tolist(),
                                    "W2": w2.tolist(), "b2": b2.tolist()})
        artifact["training"]["fits"].append({"converged": bool(result.success),
                                               "iterations": int(result.nit), "loss": float(result.fun),
                                               "message": str(result.message)})
    ranges = np.ptp(y, axis=0)
    artifact["metrics"] = {}
    for split, (sx, sy) in arrays.items():
        metrics = _metrics(_infer(artifact, sx), sy, ranges, sx)
        metrics["physical_predictions"] &= all(_physical(values, sx) for values in _member_values(artifact, sx))
        artifact["metrics"][split] = metrics
    cx, cy = arrays["calibration"]
    residuals = np.abs(_infer(artifact, cx) - cy)
    rank = min(len(cy), math.ceil((len(cy) + 1) * 0.9))
    artifact["calibration"] = {
        "kind": "simulation_approximation_error", "nominal_coverage": 0.9,
        "method": "split_absolute_residual_quantile", "count": len(cy), "rank": rank,
        "radius": np.sort(residuals, axis=0)[rank - 1].tolist(),
        "observed_coverage": {
            split: np.mean(np.abs(_infer(artifact, sx) - sy)
                           <= np.sort(residuals, axis=0)[rank - 1], axis=0).tolist()
            for split, (sx, sy) in arrays.items() if split != "train"
        },
        "interpretation": "Absolute simulator approximation-error radii; not confidence intervals or calibrated espresso coverage.",
    }
    accuracy = all(artifact["metrics"][split]["outputs"][name]["accuracy_pass"]
                   for split in ("test", "boundary") for name in OUTPUTS)
    physical = all(metrics["physical_predictions"] for metrics in artifact["metrics"].values())
    artifact["quality"] = {"qualified_small_scope": accuracy and physical, "browser_approved": False,
                           "accuracy_target_fraction": ACCURACY_TARGET, "accuracy_pass": accuracy,
                           "no_failures": True, "physical_predictions": physical}
    artifact["artifact_digest"] = digest(artifact)
    validate_artifact(artifact)
    return artifact


def validate_artifact(artifact: Any) -> None:
    """Strict bounded JSON artifact validation; compatibility/domain checks belong to inference."""
    _bounded_document(artifact)
    _keys(artifact, {"schema", "teacher", "features", "targets", "outputs", "base_recipe", "architecture",
                     "scales", "members", "source_dataset_digest", "training", "metrics", "calibration",
                     "quality", "artifact_digest"}, "artifact")
    if artifact["schema"] != SCHEMA or artifact["architecture"] != ARCHITECTURE:
        raise ValueError("unsupported surrogate schema or architecture")
    if artifact["features"] != FEATURES or artifact["targets"] != list(TARGETS) or artifact["outputs"] != list(OUTPUTS):
        raise ValueError("artifact feature/target contract differs")
    for field in ("teacher", "base_recipe"):
        if not isinstance(artifact[field], dict) or not artifact[field]:
            raise ValueError(f"artifact {field} is missing")
    teacher = artifact["teacher"]
    _keys(teacher, {"schema", "core_version", "registry_sha256", "presets_sha256", "sources_sha256",
                    "embedded_behavior_sha256", "probe_features", "fingerprint"}, "teacher")
    if teacher["schema"] != "puckworks.surrogate-teacher/1" or not isinstance(teacher["core_version"], str) or not teacher["core_version"]:
        raise ValueError("invalid teacher schema or core version")
    for field in ("registry_sha256", "presets_sha256", "embedded_behavior_sha256", "fingerprint"):
        _hash(teacher[field], f"teacher {field}")
    if not isinstance(teacher["sources_sha256"], dict) or not teacher["sources_sha256"]:
        raise ValueError("teacher source hashes are missing")
    for value in teacher["sources_sha256"].values():
        _hash(value, "teacher source hash")
    if teacher["fingerprint"] != digest({k: v for k, v in teacher.items() if k != "fingerprint"}):
        raise ValueError("teacher fingerprint differs")
    if not isinstance(teacher["probe_features"], list) or len(teacher["probe_features"]) != 3:
        raise ValueError("teacher must identify three fixed probes")
    for probe in teacher["probe_features"]:
        _array(probe, (4,), "teacher probe")
    if artifact["base_recipe"].get("schema") != "puckworks.recipe/1":
        raise ValueError("invalid base recipe schema")
    for field in ("source_dataset_digest", "artifact_digest"):
        _hash(artifact[field], field)
    if artifact["artifact_digest"] != digest({k: v for k, v in artifact.items() if k != "artifact_digest"}):
        raise ValueError("artifact digest differs")
    scales = artifact["scales"]
    _keys(scales, {"input_center", "input_scale", "output_center", "output_scale"}, "scales")
    center, scale = _support()
    if not np.array_equal(_array(scales["input_center"], (4,), "input center"), center):
        raise ValueError("input center differs from declared support")
    if not np.array_equal(_array(scales["input_scale"], (4,), "input scale"), scale):
        raise ValueError("input scale differs from declared support")
    _array(scales["output_center"], (3,), "output center")
    if np.any(_array(scales["output_scale"], (3,), "output scale") <= 0):
        raise ValueError("output scales must be positive")
    if not isinstance(artifact["members"], list) or len(artifact["members"]) != MEMBERS:
        raise ValueError("artifact must have three independently seeded members")
    member_seeds = set()
    for member in artifact["members"]:
        _keys(member, {"seed", "W1", "b1", "W2", "b2"}, "member")
        member_seeds.add(_integer(member["seed"], "member seed", 0, 2**32 - 1))
        for field, shape in (("W1", (4, 16)), ("b1", (16,)), ("W2", (16, 3)), ("b2", (3,))):
            _array(member[field], shape, field)
    if len(member_seeds) != MEMBERS:
        raise ValueError("member seeds must differ")
    training = artifact["training"]
    _keys(training, {"seed", "max_iter", "l2", "optimizer", "dataset_failures", "fits"}, "training")
    _integer(training["seed"], "training seed", 0, 2**32 - 1)
    _integer(training["max_iter"], "training max_iter", 1, 100_000)
    _integer(training["dataset_failures"], "dataset failures", 0, 0)
    if training["l2"] != L2 or training["optimizer"] != "L-BFGS-B":
        raise ValueError("unsupported training controls or failed dataset")
    if not isinstance(training["fits"], list) or len(training["fits"]) != MEMBERS:
        raise ValueError("training fit count differs")
    for fit in training["fits"]:
        _keys(fit, {"converged", "iterations", "loss", "message"}, "training fit")
        if type(fit["converged"]) is not bool or not isinstance(fit["message"], str):
            raise ValueError("invalid optimization result")
        _integer(fit["iterations"], "fit iterations", 0, training["max_iter"])
        _number(fit["loss"], "fit loss", 0)
    _validate_reports(artifact)


def _compare_replay(stored: Any, actual: Any, path: str) -> None:
    """Compare measured evaluation evidence, allowing only floating-point roundoff."""
    if isinstance(actual, dict):
        if not isinstance(stored, dict) or set(stored) != set(actual):
            raise ValueError(f"evaluation replay differs at {path}")
        for key, value in actual.items():
            _compare_replay(stored[key], value, f"{path}.{key}")
    elif isinstance(actual, list):
        if not isinstance(stored, list) or len(stored) != len(actual):
            raise ValueError(f"evaluation replay differs at {path}")
        for i, value in enumerate(actual):
            _compare_replay(stored[i], value, f"{path}[{i}]")
    elif isinstance(actual, float):
        if isinstance(stored, bool) or not isinstance(stored, (int, float)) or not math.isclose(
                stored, actual, rel_tol=1e-9, abs_tol=1e-12):
            raise ValueError(f"evaluation replay differs at {path}")
    elif stored != actual or (isinstance(actual, bool) and type(stored) is not bool):
        raise ValueError(f"evaluation replay differs at {path}")


def verify_evaluation(artifact: dict[str, Any], dataset: dict[str, Any]) -> None:
    """Replay a frozen model's supplied-data evidence without fitting any weights.

    A matching local digest checks integrity, not authentication. With the frozen
    dataset available this additionally verifies that stored scales, errors,
    physical flags and residual radii describe the actual supplied network.
    """
    validate_artifact(artifact)
    arrays = _dataset_arrays(dataset)
    if artifact["source_dataset_digest"] != dataset["digest"]:
        raise ValueError("evaluation replay dataset digest differs")
    for field in ("teacher", "features", "base_recipe"):
        if artifact[field] != dataset[field]:
            raise ValueError(f"evaluation replay {field} differs")
    _, training_values = arrays["train"]
    output_scale = training_values[:, :3].std(axis=0)
    output_scale[output_scale == 0] = 1
    _compare_replay(artifact["scales"]["output_center"],
                    training_values[:, :3].mean(axis=0).tolist(), "scales.output_center")
    _compare_replay(artifact["scales"]["output_scale"], output_scale.tolist(), "scales.output_scale")
    ranges = np.ptp(training_values, axis=0)
    predictions = {}
    for split, (x, actual) in arrays.items():
        predicted = _infer(artifact, x)
        predictions[split] = predicted
        metrics = _metrics(predicted, actual, ranges, x)
        metrics["physical_predictions"] &= all(_physical(values, x)
                                               for values in _member_values(artifact, x))
        _compare_replay(artifact["metrics"][split], metrics, f"metrics.{split}")
    residuals = np.abs(predictions["calibration"] - arrays["calibration"][1])
    n = len(residuals)
    rank = min(n, math.ceil((n + 1) * 0.9))
    radius = np.sort(residuals, axis=0)[rank - 1]
    _compare_replay(artifact["calibration"]["radius"], radius.tolist(), "calibration.radius")
    coverage = {
        split: np.mean(np.abs(predictions[split] - actual) <= radius, axis=0).tolist()
        for split, (_, actual) in arrays.items() if split != "train"
    }
    _compare_replay(artifact["calibration"]["observed_coverage"], coverage,
                    "calibration.observed_coverage")


def _validate_reports(artifact: dict[str, Any]) -> None:
    _keys(artifact["metrics"], set(SPLITS), "metrics")
    ranges = None
    for split, metrics in artifact["metrics"].items():
        _keys(metrics, {"count", "physical_predictions", "outputs"}, "split metrics")
        _integer(metrics["count"], "metric count", 1, 100_000)
        if type(metrics["physical_predictions"]) is not bool:
            raise ValueError("physical prediction flag must be boolean")
        _keys(metrics["outputs"], set(OUTPUTS), "output metrics")
        spans = []
        for name in OUTPUTS:
            entry = metrics["outputs"][name]
            _keys(entry, {"mae", "rmse", "p95_abs", "max_abs", "train_range", "max_over_train_range",
                          "constant_train_range", "accuracy_pass"}, "error metrics")
            for name in ("mae", "rmse", "p95_abs", "max_abs", "train_range"):
                _number(entry[name], name, 0)
            span, maximum = entry["train_range"], entry["max_abs"]
            spans.append(span)
            if type(entry["constant_train_range"]) is not bool or entry["constant_train_range"] != (span == 0):
                raise ValueError("constant training range flag differs")
            ratio = maximum / span if span > 0 else None
            if ratio is None:
                if entry["max_over_train_range"] is not None:
                    raise ValueError("constant range must have an unavailable normalized error")
            elif not math.isclose(_number(entry["max_over_train_range"], "normalized error", 0), ratio,
                                  rel_tol=1e-12, abs_tol=1e-15):
                raise ValueError("normalized error differs")
            passed = ratio <= ACCURACY_TARGET if ratio is not None else maximum == 0
            if type(entry["accuracy_pass"]) is not bool or entry["accuracy_pass"] != passed:
                raise ValueError("accuracy flag differs from error metrics")
        if ranges is not None and spans != ranges:
            raise ValueError("evaluation must use the training ranges")
        ranges = spans
    calibration = artifact["calibration"]
    _keys(calibration, {"kind", "nominal_coverage", "method", "count", "rank", "radius", "observed_coverage", "interpretation"}, "calibration")
    n = artifact["metrics"]["calibration"]["count"]
    if (calibration["kind"] != "simulation_approximation_error" or calibration["nominal_coverage"] != 0.9
            or calibration["method"] != "split_absolute_residual_quantile" or calibration["count"] != n
            or calibration["rank"] != min(n, math.ceil((n + 1) * 0.9))
            or not isinstance(calibration["interpretation"], str)):
        raise ValueError("unsupported approximation-error calibration")
    if np.any(_array(calibration["radius"], (4,), "calibration radius") < 0):
        raise ValueError("calibration radii must be nonnegative")
    _keys(calibration["observed_coverage"], {"calibration", "test", "boundary"}, "observed coverage")
    for values in calibration["observed_coverage"].values():
        coverage = _array(values, (4,), "observed coverage")
        if np.any((coverage < 0) | (coverage > 1)):
            raise ValueError("observed coverage must lie in [0, 1]")
    accuracy = all(artifact["metrics"][split]["outputs"][name]["accuracy_pass"]
                   for split in ("test", "boundary") for name in OUTPUTS)
    physical = all(metrics["physical_predictions"] for metrics in artifact["metrics"].values())
    expected = {"qualified_small_scope": accuracy and physical, "browser_approved": False,
                "accuracy_target_fraction": ACCURACY_TARGET, "accuracy_pass": accuracy,
                "no_failures": True, "physical_predictions": physical}
    _keys(artifact["quality"], set(expected), "quality")
    for key in expected:
        if key != "accuracy_target_fraction" and type(artifact["quality"][key]) is not bool:
            raise ValueError("quality flags must be boolean")
    if artifact["quality"] != expected or artifact["quality"].get("browser_approved") is not False:
        raise ValueError("quality flags disagree with evaluation or approve browser use")


def render_report(artifact: dict[str, Any]) -> str:
    """Markdown evidence for this fixed offline scope, including failed accuracy gates."""
    validate_artifact(artifact)
    quality = artifact["quality"]
    lines = ["# M6 scalar surrogate: offline evaluation", "",
             f"Artifact `{artifact['artifact_digest']}` · dataset `{artifact['source_dataset_digest']}`.", "",
             f"Teacher core `{artifact['teacher']['core_version']}`; behavior fingerprint `{artifact['teacher']['fingerprint']}`.", "",
             "This is a four-input, three-member 4 → 16 tanh → 3 neural ensemble trained on Tier-1 simulator outputs. "
             "It has no shot curves, species, chemistry or spatial-state predictions. TDS is derived from the ensemble mean EY, "
             "dose and final beverage mass, preserving the reported scalars' accounting.", "",
             f"Small-scope accuracy qualification: **{'pass' if quality['qualified_small_scope'] else 'fail'}**. "
             "**Browser approved: false. M6 and scientific validation gates remain open.**", "",
             "## Frozen evaluation", "",
             "Inputs scale against declared support; output centers/scales use training rows only. "
             "The acceptance threshold is a maximum absolute error ≤1% of each training output's range on both test and boundary sets. "
             "A constant training range has no normalized error and passes only with exactly zero error. "
             "No test or boundary values choose weights, scales, optimizer settings or calibration radii.", "",
             "| Split | Rows | Physical predictions (all members and mean) |", "|---|---:|---|"]
    for split in SPLITS:
        metrics = artifact["metrics"][split]
        lines.append(f"| {split} | {metrics['count']} | {metrics['physical_predictions']} |")
    lines += ["", "| Split | Output | MAE | RMSE | p95 absolute | Maximum absolute | Training range | Max / range | ≤1% |",
              "|---|---|---:|---:|---:|---:|---:|---:|---|"]
    for split in ("test", "boundary"):
        for name in OUTPUTS:
            entry = artifact["metrics"][split]["outputs"][name]
            ratio = entry["max_over_train_range"]
            ratio_text = f"{ratio:.6g}" if ratio is not None else "unavailable (constant)"
            numbers = " | ".join(f"{entry[key]:.6g}" for key in ("mae", "rmse", "p95_abs", "max_abs", "train_range"))
            lines.append(f"| {split} | {name} | {numbers} | {ratio_text} | {entry['accuracy_pass']} |")
    calibration = artifact["calibration"]
    lines += ["", "## Approximation-error bands", "",
              f"The {calibration['count']} calibration rows alone determine separate absolute-residual 90% radii "
              f"(order statistic {calibration['rank']}). These describe simulation approximation error, "
              "not confidence intervals, calibrated espresso coverage, sensory accuracy or M3 input-scenario uncertainty. "
              "Raw ensemble spread is not treated as confidence. Observed coverage below is a finite simulator comparison.", "",
              "| Output | Absolute radius | Calibration coverage | Test coverage | Boundary coverage |",
              "|---|---:|---:|---:|---:|"]
    for i, name in enumerate(OUTPUTS):
        coverage = " | ".join(f"{calibration['observed_coverage'][split][i]:.1%}" for split in ("calibration", "test", "boundary"))
        lines.append(f"| {name} | {calibration['radius'][i]:.6g} | {coverage} |")
    training = artifact["training"]
    lines += ["", "## Fixed training controls", "",
              f"Seed {training['seed']}; L-BFGS-B with analytic gradients; at most {training['max_iter']} iterations "
              f"per independently seeded member; fixed weight penalty {training['l2']}. "
              "Reaching an iteration limit is reported without retrying or tuning against held-out results.", "",
              "| Member seed | Iterations | Converged | Final loss | Optimizer message |", "|---:|---:|---|---:|---|"]
    for member, fit in zip(artifact["members"], training["fits"]):
        message = fit["message"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {member['seed']} | {fit['iterations']} | {fit['converged']} | {fit['loss']:.6g} | {message} |")
    lines += ["", "## Limits", "",
              "- The artifact covers only its fixed recipe template and four declared feature supports. "
              "It is not a general espresso model; out-of-domain and incompatible inputs require full-physics fallback.",
              "- Successful simulator emulation does not correct the teacher's scientific limitations or validate real shots.",
              "- Finite held-out and boundary checks are evidence on sampled inputs, not a uniform accuracy proof over the whole support box.",
              "- Independently scrambled Sobol points are a sampling design, not an exchangeability guarantee; residual bands have no formal coverage guarantee here.",
              "- All dataset failures must be resolved before training; no failed rows are silently discarded.",
              "- Browser integration, curve emulation, calibrated real-world uncertainty and target-device speed gates are not established here.", ""]
    return "\n".join(lines)
