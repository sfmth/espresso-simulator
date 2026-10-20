# SPDX-License-Identifier: GPL-2.0-or-later
"""Reproducible, narrowly scoped Tier-1 teacher data for the scalar emulator.

These are synthetic outputs of the current model, not measured espresso data.
Only four controls vary. Every other recipe field must match the template;
calibration overrides, different gear and additional physical inputs are refused.
Cup mass includes post-stop drip, while shot time ends at pump stop.

Independent scrambled Sobol streams form the three statistical splits. All
sixteen domain corners are reserved for boundary evaluation. Failed, capped and
numerically invalid shots are retained as failures, never silently resampled.
The training validator rejects a document containing any failure.
"""

from __future__ import annotations

import copy
import hashlib
import itertools
import json
import math
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor
from numbers import Real
from pathlib import Path
from typing import Any

from scipy.stats import qmc

from .fixtures import import_puckcore
from .paths import RepoPaths

SCHEMA = "puckworks.surrogate-dataset/1"
FEATURES = [
    {"name": "grinder_setting", "path": "grinder.setting", "unit": "um", "min": 170.0, "max": 230.0},
    {"name": "dose_g", "path": "prep.dose_g", "unit": "g", "min": 16.0, "max": 20.0},
    {"name": "ratio", "path": "stop.beverage_g/dose_g", "unit": "g/g", "min": 1.5, "max": 2.5},
    {"name": "temperature_c", "path": "machine.temperature_c", "unit": "degC", "min": 90.0, "max": 96.0},
]
TARGETS = ("shot_time_s", "beverage_mass_kg", "ey")
_SPLITS = ("train", "calibration", "test")
_ALL_SPLITS = (*_SPLITS, "boundary")
_SOURCE_TREES = (
    "crates/puckcore/src", "crates/puckmodel/src",
    "crates/puckcore-py/src", "crates/puckcore-wasm/src",
)
_SOURCE_FILES = (
    "Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
    "crates/puckcore/Cargo.toml", "crates/puckmodel/Cargo.toml",
    "crates/puckcore-py/Cargo.toml", "crates/puckcore-wasm/Cargo.toml",
    "crates/puckmodel/generated/registry.json", "crates/puckmodel/generated/presets.json",
)
_PROBES = ([190.0, 18.0, 2.0, 93.0], [170.0, 16.0, 1.5, 90.0], [230.0, 20.0, 2.5, 96.0])
# Only probe results are cached. Version, embedded defaults and source inputs
# are checked afresh, so a changed teacher cannot reuse an old behavior hash.
_BEHAVIOR_CACHE: OrderedDict[tuple[int, str], tuple[Any, str]] = OrderedDict()
_VOLATILE = frozenset(("digest", "created", "timing", "timings", "timing_s"))


def digest(value: Any) -> str:
    """Full SHA-256 of canonical finite JSON; dictionary insertion order is irrelevant."""
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dataset_digest(document: Mapping[str, Any]) -> str:
    """Scientific identity, excluding the top-level digest and timing/date annotations."""
    return digest({key: value for key, value in document.items() if key not in _VOLATILE})


def base_recipe() -> dict[str, Any]:
    """A fresh fixed-input template, using the application's generic default gear."""
    return {
        "schema": "puckworks.recipe/1",
        "bean": {"preset": "medium-washed-arabica"},
        "grinder": {"preset": "generic-flat-traditional-64", "setting": 190.0},
        "basket": {"preset": "58-precision-18g"},
        "prep": {"dose_g": 18.0, "distribution": "wdt"},
        "machine": {"preset": "flat-9-bar", "temperature_c": 93.0},
        "stop": {"beverage_g": 36.0, "time_s": 60.0},
        "numerics": {"tier": 1},
    }


def _finite(value: Any) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


def _features(values: Sequence[float]) -> list[float]:
    if isinstance(values, (str, bytes, Mapping)):
        raise ValueError("features must be four finite numeric controls")
    try:
        values = list(values)
    except TypeError as exc:
        raise ValueError("features must be four finite numeric controls") from exc
    if len(values) != len(FEATURES):
        raise ValueError("features must contain exactly four controls")
    for feature, value in zip(FEATURES, values):
        if not _finite(value) or not feature["min"] <= value <= feature["max"]:
            raise ValueError(f"{feature['name']} must lie in [{feature['min']}, {feature['max']}]")
    return [float(value) for value in values]


def recipe_for_features(values: Sequence[float]) -> dict[str, Any]:
    setting, dose, ratio, temperature = _features(values)
    recipe = base_recipe()
    recipe["grinder"]["setting"] = setting
    recipe["prep"]["dose_g"] = dose
    recipe["stop"]["beverage_g"] = dose * ratio
    recipe["machine"]["temperature_c"] = temperature
    return recipe


def recipe_features(recipe: Mapping[str, Any]) -> list[float]:
    """Extract controls only when every non-feature input exactly matches the scope.

    Explicit extra fields, even empty overrides or apparently equivalent gear,
    are refused conservatively. The native builder remains the validator for
    recipes that fall back to physical simulation.
    """
    try:
        candidate = copy.deepcopy(dict(recipe))
        setting = candidate["grinder"]["setting"]
        dose = candidate["prep"]["dose_g"]
        beverage = candidate["stop"]["beverage_g"]
        temperature = candidate["machine"]["temperature_c"]
        if not _finite(dose) or dose <= 0 or not _finite(beverage):
            raise ValueError("dose and pump-stop mass must be finite numbers")
        values = _features([setting, dose, beverage / dose, temperature])
        baseline = base_recipe()
        # Mask only the four accepted controls. Comparing a reconstruction of
        # beverage/dose would spuriously reject an IEEE-754 round-trip by 1 ulp.
        for block, key in (("grinder", "setting"), ("prep", "dose_g"),
                           ("stop", "beverage_g"), ("machine", "temperature_c")):
            candidate[block][key] = baseline[block][key]
        # A browser serializes 60.0 as 60. Both describe the same fixed f64
        # stop; booleans and the integer tier retain their strict meanings.
        fixed_stop = candidate["stop"].get("time_s")
        if _finite(fixed_stop) and fixed_stop == baseline["stop"]["time_s"]:
            candidate["stop"]["time_s"] = baseline["stop"]["time_s"]
        if digest(candidate) != digest(baseline):
            raise ValueError("recipe has inputs outside the scalar surrogate's fixed template")
        return values
    except (KeyError, TypeError, ZeroDivisionError, OverflowError) as exc:
        raise ValueError("recipe does not match the scalar surrogate's fixed template") from exc


def _source_hashes(paths: RepoPaths) -> dict[str, str]:
    """Hash only behavior inputs, with no build products, bytecode or model weights."""
    files: list[Path] = []
    for name in _SOURCE_TREES:
        folder = paths.root / name
        found = sorted(folder.rglob("*.rs"))
        if not found:
            raise ValueError(f"teacher source input is missing: {name}")
        files.extend(found)
    chemistry = sorted((paths.root / "data/chemistry").glob("*.json"))
    if not chemistry:
        raise ValueError("teacher source input is missing: data/chemistry")
    files.extend(chemistry)
    files.extend(paths.root / name for name in _SOURCE_FILES)
    output = {}
    for path in sorted(set(files)):
        if not path.is_file():
            raise ValueError(f"teacher source input is missing: {paths.relative(path)}")
        output[path.relative_to(paths.root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return output


def teacher_identity(paths: RepoPaths, core: Any = None) -> dict[str, Any]:
    """Portable identity of effective defaults, source inputs and compiled behavior.

    Source hashes describe the checkout, while fixed native probe outputs bind
    the actual extension behavior. Neither a version string alone nor the
    pre-calibration registry hash is sufficient. Three physical probes run once
    per unchanged loaded teacher; their hash is cached, never their compatibility
    inputs. Platform binary hashes, timestamps and Python versions are excluded.
    """
    engine = core if core is not None else import_puckcore()
    version = getattr(engine, "__version__", None)
    if not isinstance(version, str) or not version:
        raise ValueError("teacher must expose its core version")
    identity = {
        "schema": "puckworks.surrogate-teacher/1",
        "core_version": version,
        "registry_sha256": digest(engine.registry()),
        "presets_sha256": digest(engine.presets()),
        "sources_sha256": _source_hashes(paths),
    }
    key = (id(engine), digest(identity))
    cached = _BEHAVIOR_CACHE.get(key)
    if cached is not None and cached[0] is engine:
        behavior = cached[1]
        _BEHAVIOR_CACHE.move_to_end(key)
    else:
        probes = []
        for values in _PROBES:
            built = engine.build_shot_spec(recipe_for_features(values))
            result = engine.simulate_shot(built["spec"])
            if result.get("core_version") != version:
                raise ValueError("teacher probe core version differs from the loaded extension")
            probes.append({"x": values, "spec": built["spec"], "result": result})
        behavior = digest(probes)
        _BEHAVIOR_CACHE[key] = (engine, behavior)
        while len(_BEHAVIOR_CACHE) > 8:
            _BEHAVIOR_CACHE.popitem(last=False)
    identity["embedded_behavior_sha256"] = behavior
    identity["probe_features"] = copy.deepcopy(list(_PROBES))
    identity["fingerprint"] = digest(identity)
    return identity


def _row_id(values: Sequence[float]) -> str:
    return digest(list(values))


def _validate_row(row: Mapping[str, Any]) -> None:
    values = _features(row["x"])
    if row.get("id") != _row_id(values):
        raise ValueError("row id does not match its features")
    targets = row["y"]
    if not isinstance(targets, list) or len(targets) != len(TARGETS) or not all(map(_finite, targets)):
        raise ValueError("teacher row needs three finite scalar targets")
    time_s, mass, ey = targets
    if not (0 < time_s <= 60.0 + 1e-8 and mass > 0 and 0 <= ey <= 1):
        raise ValueError("teacher scalar targets are outside physical bounds")
    if mass < values[1] * values[2] / 1000.0 - 2e-7:
        raise ValueError("final cup mass is below its beverage stop target")
    tds = row.get("tds")
    if not _finite(tds) or not 0 <= tds <= 1:
        raise ValueError("teacher TDS must be a finite mass fraction")
    if not math.isclose(tds, ey * values[1] / 1000.0 / mass, rel_tol=1e-10, abs_tol=1e-12):
        raise ValueError("teacher TDS disagrees with EY, dose and final cup mass")
    if row.get("stop_reason") != "beverage_mass":
        raise ValueError(f"teacher did not reach the beverage target: {row.get('stop_reason')}")


def _run_row(task: tuple[str, list[float], str], engine: Any) -> dict[str, Any]:
    split, values, version = task
    row: dict[str, Any] = {"id": _row_id(values), "x": values}
    try:
        built = engine.build_shot_spec(recipe_for_features(values))
        result = engine.simulate_shot(built["spec"])
        digest(result)  # Reject nonfinite values anywhere in the teacher output.
        summary = result["summary"]
        row.update(y=[summary[key] for key in TARGETS], tds=summary["tds"],
                   stop_reason=summary["stop_reason"])
        if result.get("core_version") != version:
            raise ValueError("teacher result core version mismatch")
        diagnostics = result["diagnostics"]
        if diagnostics.get("tier") != 1 or isinstance(diagnostics.get("tier"), bool):
            raise ValueError("teacher must run Tier 1")
        for name in ("mass_balance_error", "hydraulic_volume_balance_error"):
            value = diagnostics.get(name)
            if not _finite(value) or abs(value) > 1e-8:
                raise ValueError(f"teacher failed {name}")
        minimum = diagnostics.get("min_concentration_kg_m3")
        if not _finite(minimum) or minimum < -1e-10:
            raise ValueError("teacher produced negative or invalid concentration")
        integral = diagnostics.get("outflow_integral_error")
        if not _finite(integral) or abs(integral) > 0.05:
            raise ValueError("teacher outflow quadrature diagnostic exceeds 5%")
        _validate_row(row)
        return {"split": split, "row": row}
    except (ValueError, TypeError, KeyError, RuntimeError, OverflowError) as exc:
        # Keep available *finite* labels for capped runs, without permitting
        # NaN/Infinity to corrupt the deterministic failure document itself.
        failure = {"id": row["id"], "split": split, "x": values, "error": str(exc)}
        for key in ("y", "tds", "stop_reason"):
            if key in row:
                try:
                    digest(row[key])
                except (ValueError, TypeError):
                    continue
                failure[key] = row[key]
        return {"failure": failure}


def _native_row(task: tuple[str, list[float], str]) -> dict[str, Any]:
    return _run_row(task, import_puckcore())


def _count(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 4096 or value & (value - 1):
        raise ValueError(f"{name} must be a power of two between 1 and 4096")
    return value


def _sample_features(counts: Mapping[str, int], seed: int) -> tuple[dict[str, int], dict[str, list[list[float]]]]:
    """Replay the declared protocol, including recipe arithmetic round trips."""
    split_seeds = {name: int(digest({"seed": seed, "split": name})[:8], 16) for name in _SPLITS}
    if len(set(split_seeds.values())) != len(_SPLITS):
        raise ValueError("split seed collision; select a different seed")
    samples: dict[str, list[list[float]]] = {}
    for name in _SPLITS:
        unit = qmc.Sobol(len(FEATURES), scramble=True, seed=split_seeds[name]).random_base2(
            counts[name].bit_length() - 1)
        samples[name] = [recipe_features(recipe_for_features(values)) for values in qmc.scale(
            unit, [feature["min"] for feature in FEATURES], [feature["max"] for feature in FEATURES])]
    samples["boundary"] = [list(values) for values in itertools.product(
        *((feature["min"], feature["max"]) for feature in FEATURES))]
    return split_seeds, samples


def generate_dataset(paths: RepoPaths, train: int = 256, calibration: int = 64, test: int = 128,
                     seed: int = 20261020, workers: int = 4, core: Any = None,
                     on_progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
    counts = {name: _count(value, name) for name, value in zip(_SPLITS, (train, calibration, test))}
    if sum(counts.values()) > 8192:
        raise ValueError("at most 8192 statistical samples are supported")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
        raise ValueError("seed must be an unsigned 32-bit integer")
    if not isinstance(workers, int) or isinstance(workers, bool) or not 1 <= workers <= 4:
        raise ValueError("workers must be between 1 and 4")
    if core is not None and workers != 1:
        raise ValueError("an injected teacher requires workers=1")
    split_seeds, samples = _sample_features(counts, seed)
    ids = [_row_id(values) for values in itertools.chain.from_iterable(samples.values())]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate feature vectors across dataset splits")
    engine = core if core is not None else import_puckcore()
    teacher = teacher_identity(paths, engine)
    document: dict[str, Any] = {
        "schema": SCHEMA, "features": copy.deepcopy(FEATURES), "targets": list(TARGETS),
        "base_recipe": base_recipe(), "teacher": teacher,
        "sampling": {"method": "independent_scrambled_sobol", "seed": seed,
                     "split_seeds": split_seeds, "counts": {**counts, "boundary": 16},
                     "boundary": "all_16_corners_test_only",
                     "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
        "splits": {name: [] for name in _ALL_SPLITS}, "failures": [],
    }
    tasks = [(name, values, teacher["core_version"]) for name in _ALL_SPLITS for values in samples[name]]
    total = len(tasks)
    if on_progress is not None:
        on_progress(0, total)

    def retain(results: Any) -> None:
        for done, item in enumerate(results, 1):
            if "failure" in item:
                document["failures"].append(item["failure"])
            else:
                document["splits"][item["split"]].append(item["row"])
            if on_progress is not None:
                on_progress(done, total)

    if workers == 1:
        retain(_run_row(task, engine) for task in tasks)
    else:
        # The PyO3 boundary holds the GIL. Separate processes provide actual
        # parallelism; reduce results to scalars inside each worker to bound IPC.
        with ProcessPoolExecutor(max_workers=workers) as pool:
            retain(pool.map(_native_row, tasks, chunksize=1))
    document["digest"] = dataset_digest(document)
    validate_dataset(document, allow_failures=True)
    return document


def validate_dataset(document: Mapping[str, Any], *, allow_failures: bool = False) -> None:
    """Reject malformed data, split leakage, changed scientific content or failed teachers."""
    try:
        if document.get("schema") != SCHEMA or document.get("features") != FEATURES or document.get("targets") != list(TARGETS):
            raise ValueError("unsupported dataset schema, ordered features or targets")
        if digest(document["base_recipe"]) != digest(base_recipe()):
            raise ValueError("dataset uses a different fixed recipe template")
        if document.get("digest") != dataset_digest(document):
            raise ValueError("dataset digest mismatch")
        teacher = document["teacher"]
        if (teacher.get("schema") != "puckworks.surrogate-teacher/1"
                or not isinstance(teacher.get("core_version"), str) or not teacher["core_version"]):
            raise ValueError("dataset lacks a versioned teacher identity")
        if teacher.get("fingerprint") != digest({k: v for k, v in teacher.items() if k != "fingerprint"}):
            raise ValueError("teacher fingerprint mismatch")
        def sha256(value: Any) -> bool:
            return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)

        for key in ("registry_sha256", "presets_sha256", "embedded_behavior_sha256"):
            if not sha256(teacher.get(key)):
                raise ValueError(f"invalid teacher {key}")
        sources = teacher.get("sources_sha256")
        if (not isinstance(sources, dict) or not sources or not all(sha256(v) for v in sources.values())
                or teacher.get("probe_features") != list(_PROBES)):
            raise ValueError("teacher lacks source or compiled-behavior provenance")
        sampling, splits, failures = document["sampling"], document["splits"], document["failures"]
        if sampling.get("method") != "independent_scrambled_sobol" or sampling.get("boundary") != "all_16_corners_test_only":
            raise ValueError("unsupported dataset sampling protocol")
        if set(splits) != set(_ALL_SPLITS) or not isinstance(failures, list):
            raise ValueError("dataset needs all four splits and an explicit failure list")
        ids: set[str] = set()
        split_ids: dict[str, set[str]] = {name: set() for name in _ALL_SPLITS}
        per_split = {name: 0 for name in _ALL_SPLITS}
        boundary = set()
        for name in _ALL_SPLITS:
            if not isinstance(splits[name], list):
                raise ValueError("dataset splits must be lists")
            for row in splits[name]:
                _validate_row(row)
                if row["id"] in ids:
                    raise ValueError("duplicate feature vectors across dataset splits")
                ids.add(row["id"])
                split_ids[name].add(row["id"])
                per_split[name] += 1
                if name == "boundary":
                    boundary.add(tuple(row["x"]))
        for failure in failures:
            name = failure["split"]
            values = _features(failure["x"])
            if name not in per_split or not failure.get("error") or failure.get("id") != _row_id(values):
                raise ValueError("invalid failed-teacher record")
            if failure["id"] in ids:
                raise ValueError("duplicate failed/successful feature vector")
            ids.add(failure["id"])
            split_ids[name].add(failure["id"])
            per_split[name] += 1
            if name == "boundary":
                boundary.add(tuple(values))
        expected_boundary = set(itertools.product(*((f["min"], f["max"]) for f in FEATURES)))
        if boundary != expected_boundary:
            raise ValueError("boundary split must contain exactly the sixteen reserved domain corners")
        counts = sampling["counts"]
        if counts != per_split or counts.get("boundary") != 16:
            raise ValueError("dataset sample counts do not account for every teacher run")
        for name in _SPLITS:
            _count(counts[name], name)
        if sum(counts[name] for name in _SPLITS) > 8192:
            raise ValueError("at most 8192 statistical samples are supported")
        seed = sampling["seed"]
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
            raise ValueError("seed must be an unsigned 32-bit integer")
        if not sha256(sampling.get("generator_sha256")):
            raise ValueError("dataset lacks its generator source identity")
        seeds = sampling["split_seeds"]
        if (set(seeds) != set(_SPLITS) or len(set(seeds.values())) != len(_SPLITS)
                or any(not isinstance(v, int) or isinstance(v, bool) or not 0 <= v < 2**32
                       for v in seeds.values())):
            raise ValueError("statistical splits need distinct Sobol seeds")
        expected_seeds, expected_samples = _sample_features(counts, seed)
        if seeds != expected_seeds:
            raise ValueError("Sobol split seeds do not derive from the declared root seed")
        for name in _ALL_SPLITS:
            if split_ids[name] != {_row_id(values) for values in expected_samples[name]}:
                raise ValueError(f"{name} feature vectors do not match the declared Sobol sampling protocol")
        if failures and not allow_failures:
            raise ValueError("dataset contains failed or capped teacher runs; training is refused")
    except (KeyError, TypeError, AttributeError, OverflowError) as exc:
        raise ValueError("malformed scalar-surrogate dataset") from exc


__all__ = ["FEATURES", "TARGETS", "base_recipe", "dataset_digest", "digest", "generate_dataset",
           "recipe_features", "recipe_for_features", "teacher_identity", "validate_dataset"]
