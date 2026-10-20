# SPDX-License-Identifier: GPL-2.0-or-later
"""Guarded, offline scalar estimates with an actual Tier 1 physics fallback.

This API deliberately does not return a ShotResult: neural outputs cannot supply
curves, local coupled state, species inventories or conservation diagnostics.
The optional intervals quantify approximation of this particular simulator,
not uncertainty about coffee or agreement with measurements.
"""

from __future__ import annotations

import copy
import json
import math
from collections.abc import Callable
from types import ModuleType
from typing import Any

import numpy as np

from .fixtures import import_puckcore
from .paths import RepoPaths
from .surrogate_data import FEATURES, base_recipe, recipe_features, teacher_identity
from .surrogate_train import OUTPUTS, infer_values, validate_artifact

SCHEMA = "puckworks.scalar-prediction/1"


class PredictionCancelled(RuntimeError):
    """The caller cancelled before another inference or physical run started."""


def _check_cancelled(cancelled: Callable[[], bool] | None) -> None:
    if cancelled is not None and cancelled():
        raise PredictionCancelled("scalar prediction cancelled before starting the next operation")


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _recipe_copy(recipe: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(recipe, dict):
        raise ValueError("recipe must be a JSON object")
    try:
        json.dumps(recipe, allow_nan=False)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"recipe must contain finite JSON values: {error}") from error
    result = copy.deepcopy(recipe)
    numerics = result.setdefault("numerics", {})
    if not isinstance(numerics, dict):
        raise ValueError("recipe.numerics must be an object")
    # Only the approximation tier changes. Presets, overrides, profiles, stop
    # conditions and every other user-supplied field reach the actual builder.
    numerics["tier"] = 1
    return result


def _prediction_problem(values: list[float], recipe: dict[str, Any]) -> str | None:
    if len(values) != 4 or not all(_finite(value) for value in values):
        return "the model did not return four finite scalar values"
    time_s, mass_kg, ey, tds = values
    if not 0 < time_s <= 60:
        return "predicted shot time is outside (0, 60] seconds"
    if mass_kg <= 0 or mass_kg < recipe["stop"]["beverage_g"] / 1000:
        return "predicted final cup mass is nonpositive or below the requested stop mass"
    if not 0 <= ey <= 1 or not 0 <= tds <= 1:
        return "predicted EY or TDS is outside [0, 1]"
    expected_tds = ey * (recipe["prep"]["dose_g"] / 1000) / mass_kg
    if not math.isclose(tds, expected_tds, rel_tol=1e-10, abs_tol=1e-12):
        return "predicted TDS does not equal EY times dry dose divided by final cup mass"
    return None


def predict_or_simulate(
    recipe: dict[str, Any],
    artifact: dict[str, Any] | None,
    paths: RepoPaths,
    core: ModuleType | None = None,
    *,
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Return tagged scalar values, falling back to the user's actual Tier 1 run.

    Only an intact, current, qualified small-scope model can be used. Unsupported
    recipes are simulated with all physical inputs intact. Invalid recipes and
    failures of the physical core raise ValueError rather than acquiring guessed
    values. Cancellation is cooperative, before operations; it cannot interrupt
    a synchronous native solve already in progress.
    """
    _check_cancelled(cancelled)
    physical_recipe = _recipe_copy(recipe)
    engine = core if core is not None else import_puckcore()
    reasons: list[dict[str, str]] = []
    artifact_digest: str | None = None

    def reject(code: str, detail: str) -> None:
        reasons.append({"code": code, "detail": detail})

    try:
        validate_artifact(artifact)
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        reject("invalid_artifact", str(error))
    else:
        artifact_digest = artifact["artifact_digest"]
        quality = artifact["quality"]
        if not all(quality.get(key) is True for key in (
            "qualified_small_scope", "accuracy_pass", "no_failures", "physical_predictions"
        )) or quality.get("browser_approved") is not False:
            reject("unqualified_model", "the frozen small-scope scalar accuracy and safety gates are not met")
        if artifact["features"] != FEATURES or artifact["base_recipe"] != base_recipe():
            reject("unsupported_model_domain", "model features or fixed recipe differ from the supported template")
        try:
            features = recipe_features(recipe)
        except ValueError as error:
            reject("unsupported_recipe", str(error))
        if not reasons:
            _check_cancelled(cancelled)
            try:
                current_teacher = teacher_identity(paths, core=engine)
            except (ValueError, OSError, RuntimeError) as error:
                reject("teacher_identity_unavailable", str(error))
            else:
                if artifact["teacher"] != current_teacher:
                    keys = sorted(key for key in set(artifact["teacher"]) | set(current_teacher)
                                  if artifact["teacher"].get(key) != current_teacher.get(key))
                    reject("teacher_identity_mismatch", "current teacher differs in: " + ", ".join(keys))
        if not reasons:
            _check_cancelled(cancelled)
            try:
                predicted = np.asarray(infer_values(artifact, [features]), dtype=float)
                if predicted.shape != (1, 4):
                    raise ValueError("the model did not return a single four-scalar row")
                values = predicted[0].tolist()
                problem = _prediction_problem(values, recipe)
                if problem is not None:
                    raise ValueError(problem)
            except (ValueError, TypeError, OverflowError, FloatingPointError) as error:
                reject("nonphysical_prediction", str(error))
            else:
                calibration = artifact["calibration"]
                return {
                    "schema": SCHEMA, "mode": "surrogate", "qualification": "qualified_small_scope",
                    "browser_approved": False, "core_version": current_teacher["core_version"],
                    "model_artifact_digest": artifact_digest, "fallback_reasons": [],
                    "scalars": dict(zip(OUTPUTS, values, strict=True)),
                    "intervals": {
                        "kind": "simulation_approximation_error",
                        "nominal_coverage": calibration["nominal_coverage"],
                        "interpretation": "Held-out simulator approximation error; not physical or measurement uncertainty.",
                        "outputs": {name: {"lower": value - radius, "upper": value + radius}
                                    for name, value, radius in zip(OUTPUTS, values, calibration["radius"], strict=True)},
                    },
                }

    _check_cancelled(cancelled)
    run = engine.simulate_recipe(physical_recipe)
    try:
        summary = run["result"]["summary"]
        scalars = {name: summary[name] for name in OUTPUTS}
        if not all(_finite(value) for value in scalars.values()):
            raise ValueError("nonfinite scalar")
        version = run["result"]["core_version"]
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Tier 1 core did not return a complete finite scalar summary") from error
    return {
        "schema": SCHEMA, "mode": "physics", "physics_tier": 1,
        "browser_approved": False, "core_version": version,
        "model_artifact_digest": artifact_digest, "fallback_reasons": reasons,
        "scalars": scalars,
    }


__all__ = ["PredictionCancelled", "SCHEMA", "predict_or_simulate"]
