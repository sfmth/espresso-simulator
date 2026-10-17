# SPDX-License-Identifier: GPL-2.0-or-later
"""Calibration harness: parameter mapping, a block-sparse least-squares fit that recovers known
parameters, uncertainties from the Jacobian, and the calibration document."""

from __future__ import annotations

import copy
import math

import numpy as np
import pytest

from puckworks_tools import calibrate as cal
from puckworks_tools.registry import load_registry
from puckworks_tools.units import load_units


# -- parameters and units --------------------------------------------------------------------------


def record(**fields):
    base = {"id": "x.y", "units": "1", "range": {"min": 0}}
    base.update(fields)
    return base


def test_registry_default_and_bounds():
    assert cal.registry_default(record(value=3.0, prior={"distribution": "uniform", "min": 1, "max": 9})) == 3.0
    assert cal.registry_default(record(prior={"distribution": "uniform", "min": 1, "max": 9})) == 5.0
    assert cal.registry_default(record(prior={"distribution": "triangular", "min": 1, "mode": 2, "max": 9})) == 2.0
    lognormal = record(prior={"distribution": "lognormal", "lower": 1e-15, "upper": 1e-13, "coverage": 0.95})
    assert cal.registry_default(lognormal) == pytest.approx(1e-14)
    lo, hi = cal.prior_bounds(lognormal)
    assert lo < 1e-15 and hi > 1e-13  # the 99.7% interval contains the 95% interval
    normal = record(prior={"distribution": "normal", "mean": 12, "sd": 3})
    # mean ± 2.97 sd: the central 99.7% of the prior
    assert cal.prior_bounds(normal) == pytest.approx((12 - 2.968 * 3, 12 + 2.968 * 3), abs=1e-3)
    assert cal.prior_bounds(record(value=1e-3)) == pytest.approx((1e-4, 1e-2))
    clipped = record(range={"min": 0, "max": 1}, prior={"distribution": "normal", "mean": 0.9, "sd": 0.1})
    assert cal.prior_bounds(clipped)[1] == 1


def test_prior_sd_in_fit_coordinates():
    uniform = record(prior={"distribution": "uniform", "min": 1.0, "max": 9.0})
    assert cal.prior_sd(uniform, "linear") == pytest.approx(8.0 / math.sqrt(12.0))
    # log10 of a value uniform on [a, b], against sampling
    wide = record(prior={"distribution": "uniform", "min": 1.9e-11, "max": 1.6e-10})
    sample = np.log10(np.random.default_rng(0).uniform(1.9e-11, 1.6e-10, 400_000))
    assert cal.prior_sd(wide, "log") == pytest.approx(sample.std(), rel=0.01)
    # a 95% interval of two decades: σ(log10) = 1/1.96
    lognormal = record(prior={"distribution": "lognormal", "lower": 1e-15, "upper": 1e-13, "coverage": 0.95})
    assert cal.prior_sd(lognormal, "log") == pytest.approx(1.0 / 1.959964, rel=1e-4)
    assert cal.prior_sd(record(prior={"distribution": "normal", "mean": 12, "sd": 3}), "linear") == 3.0
    triangular = record(prior={"distribution": "triangular", "min": 0, "mode": 1, "max": 2})
    assert cal.prior_sd(triangular, "linear") == pytest.approx(math.sqrt(1 / 6))
    # no prior: uniform in the fit coordinate over the bounds (log-uniform for a log-scaled parameter)
    assert cal.prior_sd(record(value=1e-3), "log", (1e-5, 1e-2)) == pytest.approx(3.0 / math.sqrt(12.0))
    assert cal.prior_sd(record(value=1e-3), "log") is None


def test_fixed_parameters_are_documented(repo):
    records = load_registry(repo)
    config = {"parameters": [], "fixed": [
        {"id": "extraction.surface_rate.grudeva2026", "reason": "not identified by V1"},
        {"field": "hydraulics.dissolution_porosity_share", "reason": "no registry id"}]}
    fixed = cal.fixed_parameters(config, records)
    assert fixed["extraction.surface_rate.grudeva2026"] == {"value": 1e-3, "units": "m/s",
                                                            "reason": "not identified by V1"}
    assert fixed["spec:hydraulics.dissolution_porosity_share"]["value"] is None
    for bad, match in (({"id": "extraction.surface_rate.grudeva2026"}, "reason"),
                       ({"id": "no.such.parameter", "reason": "x"}, "registry"),
                       ({"reason": "x"}, "`id` or a spec `field`")):
        with pytest.raises(cal.CalibrationError, match=match):
            cal.fixed_parameters({"fixed": [bad]}, records)
    both = {"parameters": [{"id": "extraction.surface_rate.grudeva2026"}],
            "fixed": [{"id": "extraction.surface_rate.grudeva2026", "reason": "x"}]}
    with pytest.raises(cal.CalibrationError, match="both fitted and fixed"):
        cal.fixed_parameters(both, records)
    # the repository's configuration is consistent
    cal.fixed_parameters(cal.load_config(repo.root / "data" / "calibration" / "config.yaml"), records)


def test_units_to_spec_fields(repo):
    units = load_units(repo.units)
    assert cal.to_spec_units(units, 12.0, "bar", "hydraulics.poroelastic_pc_pa") == pytest.approx(1.2e6)
    assert cal.to_spec_units(units, 25.0, "um", "solubles.cell_size_m") == pytest.approx(25e-6)
    assert cal.to_spec_units(units, 1.2, "%", "solubles.species[id=caffeine].mass_fraction") == pytest.approx(0.012)
    assert cal.to_spec_units(units, 3e-15, "m^2", "hydraulics.permeability_m2") == pytest.approx(3e-15)
    assert cal.to_spec_units(units, 93.0, "degC", "thermal.water_temp_c") == pytest.approx(93.0)
    with pytest.raises(cal.CalibrationError):
        cal.to_spec_units(units, 1.0, "bar", "hydraulics.permeability_m2")


def test_config_parameters_have_registry_records(repo):
    config = cal.load_config(repo.root / "data" / "calibration" / "config.yaml")
    records = load_registry(repo)
    params = cal.make_parameters(config, records, config["blocks"])
    assert len(params) == len(config["parameters"])
    for p in params:
        assert p.id in records
        assert p.lower <= p.start <= p.upper
        assert set(p.blocks) <= set(config["blocks"])
        if p.mode == "spec":
            assert p.target and p.applies_to
    bad = copy.deepcopy(config)
    bad["parameters"].append({"id": "no.such.parameter", "blocks": ["V1"]})
    with pytest.raises(cal.CalibrationError, match="no parameter-registry record"):
        cal.make_parameters(bad, records, config["blocks"])


def test_app_facing_parameters_are_read_by_the_builder(repo):
    """Every id the calibration writes into `parameters` (override parameters and the reference
    permeability) is one the input models read, so the export embeds no value nothing uses."""
    reads_file = repo.root / "crates" / "puckmodel" / "registry-reads.txt"
    if not reads_file.is_file():
        pytest.skip("crates/puckmodel/registry-reads.txt is not present")
    reads = {line.strip() for line in reads_file.read_text(encoding="utf-8").splitlines()
             if line.strip() and not line.startswith("#")}
    config = cal.load_config(repo.root / "data" / "calibration" / "config.yaml")
    app_facing = {e["id"] for e in config["parameters"] if e.get("mode", "override") == "override"}
    app_facing.add(cal.REFERENCE_PERMEABILITY_ID)
    assert app_facing <= reads, sorted(app_facing - reads)


# -- a synthetic problem: the plumbing without the solver ------------------------------------------


class Curve:
    """A residual block of c(t) = a·exp(−t/b) against noisy synthetic data."""

    def __init__(self, name, ids, a, b, sigma, seed):
        rng = np.random.default_rng(seed)
        self.name, self.ids, self.sigma = name, ids, sigma
        self.t = np.linspace(0.0, 60.0, 25)
        self.data = a * np.exp(-self.t / b) + rng.normal(0.0, sigma, self.t.size)
        self.labels = [f"{name}/{i}" for i in range(self.t.size)]
        self.calls = 0

    def evaluate(self, values, runner, params):
        self.calls += 1
        a, b = values[self.ids[0]], values[self.ids[1]]
        r = (a * np.exp(-self.t / b) - self.data) / self.sigma
        return cal.Evaluation(r, self.labels, [], [])


class Line:
    """A second block depending only on a slope c."""

    def __init__(self, name, c):
        self.name = name
        self.x = np.arange(1.0, 11.0)
        self.data = c * self.x
        self.labels = [f"{name}/{i}" for i in range(self.x.size)]
        self.calls = 0

    def evaluate(self, values, runner, params):
        self.calls += 1
        return cal.Evaluation((values["s.c"] * self.x - self.data) / 0.1, self.labels, [], [])


def synthetic_problem():
    params = [
        cal.Parameter("s.a", "spec", ("A",), "linear", 0.1, 10.0, 1.0, "1"),
        cal.Parameter("s.b", "spec", ("A",), "log", 1.0, 100.0, 40.0, "s"),
        cal.Parameter("s.c", "spec", ("B",), "linear", -5.0, 5.0, 0.0, "1"),
    ]
    blocks = [Curve("A", ("s.a", "s.b"), a=2.0, b=15.0, sigma=0.01, seed=1), Line("B", c=1.5)]
    return cal.Problem(params, blocks, cal.Runner(simulate=lambda spec: spec), fd_step=1e-4)


def test_synthetic_fit_recovers_known_parameters():
    problem = synthetic_problem()
    result = cal.fit(problem)
    values = problem.values(result.x)
    unc = cal.uncertainties(problem, result.x, result.jacobian, result.residuals)["parameters"]
    assert result.success
    for pid, truth in (("s.a", 2.0), ("s.b", 15.0)):
        assert abs(values[pid] - truth) < 4.0 * unc[pid]["sd"], (pid, values[pid], unc[pid])
        assert unc[pid]["identified"]
        assert unc[pid]["interval_68"][0] < values[pid] < unc[pid]["interval_68"][1]
    assert values["s.c"] == pytest.approx(1.5, abs=1e-6)
    # the 25 residuals with σ-normalised noise give a reduced chi-square near 1
    assert 0.3 < cal.uncertainties(problem, result.x, result.jacobian, result.residuals)["reduced_chi2"] < 3.0


def test_optimizer_record_retains_unfinished_fit_diagnostics():
    problem = synthetic_problem()
    result = cal.fit(problem, max_nfev=1)
    record = cal.optimizer_record(result)
    assert not record["success"]
    assert record["status"] == 0  # the evaluation limit, not a convergence condition
    assert record["evaluations"] == record["jacobian_evaluations"] == 1
    assert math.isfinite(record["optimality"]) and record["optimality"] > 1
    assert record["message"] == result.message


@pytest.mark.parametrize("label", ["v1", "v2", "v3"])
def test_historical_fit_outputs_are_protected(repo, label):
    from types import SimpleNamespace

    args = SimpleNamespace(config=None, out_dir=None, label=label)
    with pytest.raises(cal.CalibrationError, match="preserved historical fits"):
        cal.run(args, repo)


def test_warm_start_records_actual_values_and_refuses_nonphysical_clipping():
    problem = synthetic_problem()
    assert cal.apply_start_values(problem, {"s.a": 2.0, "s.b": 15.0, "not.fitted": 90}) == {"s.a": 2.0, "s.b": 15.0}
    assert problem.values(problem.x0()) == pytest.approx({"s.a": 2, "s.b": 15, "s.c": 0})
    for invalid in (math.nan, math.inf, -1, 100.01):
        with pytest.raises(cal.CalibrationError):
            cal.apply_start_values(problem, {"s.b": invalid})
    assert problem.params[1].start == 15


def test_pipeline_completion_requires_every_declared_refit_but_not_scientific_passes():
    document = {"fit": {"optimizer": {"success": True},
                       "loo": {"experiments": {f"exp{i:02d}": {"optimizer": {"success": True}}
                                                for i in range(1, 16)}, "lambda_within": 0, "cup_within": 0},
                       "sensitivity": {"variants": {name: {"optimizer": {"success": True}}
                                                    for name in cal.SENSITIVITY_VARIANTS}}}}
    assert len(cal.SENSITIVITY_VARIANTS) == 9
    assert cal.completion_issues(document) == []
    document["fit"]["loo"]["experiments"]["exp01"]["optimizer"]["success"] = False
    assert cal.completion_issues(document) == ["one or more leave-one-out optimizers did not converge"]
    del document["fit"]["sensitivity"]["variants"]["wet PSD D32 plus 1 SD"]
    assert "sensitivity does not contain all nine declared variants" in cal.completion_issues(document)
    document["fit"]["blocks"] = {"V1": {"failures": ["missing observation"]}}
    document["fit"]["loo"]["experiments"]["exp02"]["predicted"] = False
    assert "main/pruned fit has unavailable final predictions" in cal.completion_issues(document)
    assert "leave-one-out has unavailable refit or left-out predictions" in cal.completion_issues(document)


def test_jacobian_reruns_only_affected_blocks():
    problem = synthetic_problem()
    x = problem.x0()
    problem.residuals(x)
    calls = [b.calls for b in problem.blocks]
    jac = problem.jacobian(x)
    # block A is perturbed for its two parameters, block B for its one
    assert [b.calls - c for b, c in zip(problem.blocks, calls)] == [2, 1]
    assert np.all(jac[:25, 2] == 0) and np.all(jac[25:, :2] == 0)
    assert np.any(jac[:25, 0] != 0) and np.any(jac[25:, 2] != 0)


def test_prior_ratio_and_bounds_are_reported():
    problem = synthetic_problem()
    for p in problem.params:
        p.prior_sd_x = (p.x_bounds[1] - p.x_bounds[0]) / math.sqrt(12.0)
    result = cal.fit(problem)
    unc = cal.uncertainties(problem, result.x, result.jacobian, result.residuals)["parameters"]
    # 25 points with 1% noise pin the curve far below the width of its bounds
    assert unc["s.a"]["prior_sd_ratio"] < 0.05 and unc["s.b"]["prior_sd_ratio"] < 0.05
    assert not any(u["at_bound"] for u in unc.values())
    # within 1% of the span of a bound counts as at the bound (the solver never lands exactly on it)
    x = result.x.copy()
    lo, hi = problem.params[2].x_bounds
    x[2] = hi - 0.005 * (hi - lo)
    unc = cal.uncertainties(problem, x, problem.jacobian(x), problem.residuals(x))["parameters"]
    assert unc["s.c"]["at_bound"] and not unc["s.a"]["at_bound"]


def test_unidentified_parameter_is_flagged():
    problem = synthetic_problem()
    problem.params.append(cal.Parameter("s.unused", "spec", ("A",), "linear", 0.0, 1.0, 0.5, "1"))
    x = problem.x0()
    unc = cal.uncertainties(problem, x, problem.jacobian(x), problem.residuals(x))["parameters"]
    assert not unc["s.unused"]["identified"]
    assert unc["s.a"]["identified"]


# -- the real problem on the current build ------------------------------------------------------------

puckcore = pytest.importorskip("puckcore")


@pytest.fixture(scope="module")
def config(repo):
    return cal.load_config(repo.root / "data" / "calibration" / "config.yaml")


def test_real_problem_builds_and_evaluates(repo, config):
    problem = cal.build_problem(repo, config, tier=0)
    try:
        assert [b.name for b in problem.blocks] == ["V1", "V2", "V4", "V6"]
        assert cal.check_overrides(problem) == []
        r = problem.residuals(problem.x0())
        assert r.size == len(problem.labels) and np.all(np.isfinite(r))
        assert len(set(problem.labels)) == len(problem.labels)
    finally:
        problem.runner.close()


def test_v3_qualified_wet_input_enters_dataset_identity(repo, config):
    from puckworks_tools.cases import schmieder2023 as sch

    problem = cal.build_problem(repo, config, blocks=["V1"])
    try:
        block = problem.blocks[0]
        assert all(case.info["psd_source"] == "wet_cdf" for case in block.cases)
        assert cal.datasets_for_block(block) == (*sch.DATASETS, sch.PSD_DATASET)
        assert all(case.info["psd"]["sauter_offset_sd"] == 0 for case in block.cases)
        for case in block.cases:
            case.info["psd_source"] = "reconstructed"
        assert cal.datasets_for_block(block) == sch.DATASETS
    finally:
        problem.runner.close()


def test_required_observations_reject_nonfinite_fit_inputs_without_scientific_thresholds(repo, config):
    from puckworks_tools.cases import schmieder2023 as sch

    problem = cal.build_problem(repo, config, blocks=["V1"])
    try:
        block, case = problem.blocks[0], problem.blocks[0].cases[0]
        # Finite values far from the measurements remain available predictions.
        observation = {"lambda": {a: 1e6 for a, *_ in sch.ANALYTES},
                       "c0": {a: 1e6 for a, *_ in sch.ANALYTES},
                       "cup_eq3": {a: {mass: 1e6 for mass in (20, 40, 60)} for a, *_ in sch.ANALYTES},
                       "pour_peak_pressure_bar": 100.0}
        assert cal.required_observations_available(block, case, observation)
        observation["lambda"]["caffeine"] = math.nan
        assert not cal.required_observations_available(block, case, observation)
        observation["lambda"]["caffeine"] = 1e6
        observation["cup_eq3"]["tds"][60] = math.inf
        assert not cal.required_observations_available(block, case, observation)
    finally:
        problem.runner.close()


def test_kappa_recovered_through_the_solver(repo, config):
    """Synthetic data from the solver at a known nuisance permeability; the fit recovers it."""
    sub = {**config, "parameters": [p for p in config["parameters"]
                                    if p["id"] == "calibration.waszkiewicz2026.permeability"]}
    problem = cal.build_problem(repo, sub, blocks=["V4"], tier=0)
    try:
        truth = 2.5e-15
        block = problem.blocks[0]
        values = {"calibration.waszkiewicz2026.permeability": truth}
        evaluation = block.evaluate(values, problem.runner, problem.params)
        for case, obs in zip(block.cases, evaluation.observations):
            case.info["longtime"] = {**case.info["longtime"], "flow_g_s": obs["long_time_flow_g_s"], "flow_sem_g_s": 0.0}
        result = cal.fit(problem)
        fitted = problem.values(result.x)["calibration.waszkiewicz2026.permeability"]
        assert fitted == pytest.approx(truth, rel=0.01)
        assert result.cost < 1e-3 * result.start_cost or result.start_cost < 1e-12
    finally:
        problem.runner.close()


def test_calibration_document_round_trip(repo, config, tmp_path):
    from puckworks_tools.export import load_calibration as export_load_calibration

    sub = {**config, "parameters": [p for p in config["parameters"] if "V2" in p["blocks"] or "V6" in p["blocks"]]}
    problem = cal.build_problem(repo, sub, blocks=["V2", "V6"])
    try:
        result = cal.fit(problem, max_nfev=4)
        doc = cal.calibration_document(problem, result, label="test", config_path="config.yaml",
                                       core_version=puckcore.__version__)
    finally:
        problem.runner.close()
    assert doc["schema"] == "puckworks.calibration/1"
    assert list(doc) == ["schema", "label", "created", "core_version", "tools_version", "parameters", "fit"]
    assert set(doc["fit"]) >= {"datasets", "blocks", "residuals", "uncertainties", "correlation", "optimizer",
                               "nuisance", "case_parameters"}
    # only builder-read (override) values are app-facing; the density closure's α is one of them now
    overrides = {p["id"] for p in sub["parameters"] if p.get("mode", "override") == "override"}
    assert {"extraction.dispersion.axial_coefficient", "hydraulics.kozeny_carman.density_exponent"} <= overrides
    assert set(doc["parameters"]) == overrides
    assert doc["fit"]["case_parameters"] == {}
    assert doc["fit"]["inputs"]["config_sha256"] is None or len(doc["fit"]["inputs"]["config_sha256"]) == 16
    assert set(doc["fit"]["inputs"]["datasets_sha256"]) == set(doc["fit"]["datasets"])
    written = cal.write_documents(doc, tmp_path, label="test")
    assert [p.name for p in written] == ["test.yaml", "current.yaml"]
    assert written[0].read_text().startswith("# SPDX-License-Identifier: GPL-2.0-or-later")
    assert cal.load_calibration(written[1]) == pytest.approx({**doc["parameters"], **doc["fit"]["case_parameters"]})
    # the export (workstream D) accepts it: registry ids that exist, values inside their ranges
    records = load_registry(repo)
    values, meta = export_load_calibration(written[1], records, "current.yaml")
    assert values == pytest.approx(doc["parameters"])
    assert meta["label"] == "test"


def test_placeholder_results_are_not_written_into_the_repository(repo, tmp_path):
    runner = cal.Runner(simulate=lambda spec: spec)
    runner.warnings.add("placeholder shot model: replace in M1 workstream A")
    assert cal.refuse_placeholder(runner, repo.root / "data" / "calibration", repo)
    assert not cal.refuse_placeholder(runner, repo.root / "data" / "calibration", repo, allow=True)
    assert not cal.refuse_placeholder(runner, tmp_path, repo)
    runner.warnings.clear()
    assert not cal.refuse_placeholder(runner, repo.root / "data" / "calibration", repo)


def test_runner_caches_results():
    calls = []

    def simulate(spec):
        calls.append(spec["n"])
        return {"value": spec["n"] * 2}

    runner = cal.Runner(simulate=simulate, cache_size=2)
    assert [r["value"] for r in runner.run([{"n": 1}, {"n": 2}, {"n": 1}])] == [2, 4, 2]
    assert calls == [1, 2]
    runner.run([{"n": 3}])  # evicts {"n": 2}, the least recently used
    runner.run([{"n": 1}])  # still cached
    runner.run([{"n": 2}])  # simulated again
    assert calls == [1, 2, 3, 2]
    assert runner.simulations == 4 and not math.isnan(runner.simulations)


def test_runner_keeps_a_calls_hits_when_the_cache_overflows():
    """A call that mixes cached and new specs on a full cache returns every result (the eviction of old
    entries must not drop this call's own hits)."""
    runner = cal.Runner(simulate=lambda spec: {"value": spec["n"]}, cache_size=3)
    runner.run([{"n": 1}, {"n": 2}, {"n": 3}])
    out = runner.run([{"n": 1}, {"n": 4}, {"n": 5}, {"n": 6}])
    assert [r["value"] for r in out] == [1, 4, 5, 6]
    assert len(runner._cache) == 3


def test_leave_one_out_structure(repo, config):
    """The V1 leave-one-condition-out machinery: one refit per experiment, errors of the one left out."""
    keep = {"calibration.schmieder2023.extractable_fraction", "calibration.schmieder2023.permeability.gl1_7"}
    sub = {**config, "parameters": [p for p in config["parameters"] if p["id"] in keep],
           "blocks": {"V1": config["blocks"]["V1"]}}
    checkpoints = []
    loo = cal.leave_one_out(repo, sub, {}, tier=0, max_nfev=2, progress=checkpoints.append)
    assert len(loo["experiments"]) == 15
    assert loo["lambda_total"] == 60 and loo["cup_total"] == 180
    first = loo["experiments"]["exp01"]["errors"]
    assert set(first["lambda"]) == {"trigonelline", "caffeine", "cqa5", "tds"}
    assert set(first["cup"]["tds"]) == {20, 40, 60}
    assert 0 <= loo["lambda_within"] <= 60 and 0 <= loo["cup_within"] <= 180
    assert [c["completed"] for c in checkpoints] == list(range(1, 16))
    assert all(c["required"] == 15 and len(c["experiments"]) == c["completed"] for c in checkpoints)
    assert loo["completed"] == loo["required"] == 15
    assert loo["all_optimizers_converged"] == all(e["optimizer"]["success"] for e in loo["experiments"].values())
    assert loo["refitted_blocks"] == ["V1"] and loo["held"] == {}
    assert loo["conditional_on_fixed_structure"] is True
    assert all(set(e["fitted_values"]) == keep for e in loo["experiments"].values())


def test_case_exclusion_is_scoped_to_its_block(repo, config):
    # Two blocks deliberately contain the same case names. Excluding a V1 condition must not
    # silently remove another block's observation with that name.
    scoped = {**config, "parameters": [],
              "blocks": {"V1": config["blocks"]["V1"], "second": config["blocks"]["V1"]}}
    full = cal.build_problem(repo, scoped, tier=0)
    try:
        name = full.blocks[0].cases[0].name
        sub = cal.build_problem(repo, scoped, tier=0, exclude_cases_by_block={"V1": [name]})
        try:
            assert len(sub.blocks[0].cases) == 14
            assert len(sub.blocks[1].cases) == 15
            assert name not in {c.name for c in sub.blocks[0].cases}
            assert name in {c.name for c in sub.blocks[1].cases}
        finally:
            sub.runner.close()
    finally:
        full.runner.close()


@pytest.mark.parametrize("incomplete_prediction", [False, True])
def test_leave_one_out_refits_shared_parameter_without_omitted_residual(monkeypatch, incomplete_prediction):
    """A shared scalar has analytically known fold optima, including an independent V2 datum."""
    from types import SimpleNamespace

    from puckworks_tools.cases import schmieder2023 as sch

    cases = {
        "V1": [SimpleNamespace(name="same-name", info={"experiment": 1}, target=2.0),
               SimpleNamespace(name="second", info={"experiment": 2}, target=8.0)],
        "V2": [SimpleNamespace(name="same-name", info={}, target=20.0)],
    }
    targets = {i: {"lambda": {a: (value, 1.0) for a, *_ in sch.ANALYTES},
                   "cup": {a: {m: (value, 1.0) for m in (20, 40, 60)} for a, *_ in sch.ANALYTES}}
               for i, value in ((1, 2.0), (2, 8.0))}
    monkeypatch.setattr(sch, "targets", lambda data: targets)

    class SyntheticBlock:
        def __init__(self, name, module, data, cases, options, units):
            self.name, self.module, self.data, self.cases = name, module, data, cases
            self.options, self.units = options, units
            self.labels = [f"{name}/{case.name}" for case in cases]

        def evaluate(self, values, runner, params):
            value = values["shared.value"]
            observations = []
            for case in self.cases:
                obs = {"lambda": {a: value for a, *_ in sch.ANALYTES},
                       "c0": {a: value for a, *_ in sch.ANALYTES},
                       "cup_eq3": {a: {m: value for m in (20, 40, 60)} for a, *_ in sch.ANALYTES},
                       "pour_peak_pressure_bar": 1.0}
                if incomplete_prediction and self.name == "V1" and case.info["experiment"] == 1:
                    del obs["c0"]
                observations.append(obs)
            return cal.Evaluation(np.array([value - case.target for case in self.cases]),
                                  self.labels, observations, [])

    def build(paths, config, *, blocks=None, exclude_cases=(), exclude_cases_by_block=None, runner=None, **kwargs):
        selected = list(config["blocks"] if blocks is None else blocks)
        built = []
        for name in selected:
            excluded = set(exclude_cases) | set((exclude_cases_by_block or {}).get(name, ()))
            retained = [case for case in cases[name] if case.name not in excluded]
            built.append(SyntheticBlock(name, sch, {}, retained, {}, None))
        parameter = cal.Parameter("shared.value", "override", ("V1", "V2"), "linear", 0.1, 30, 10, "1")
        return cal.Problem([parameter], built, runner or cal.Runner(simulate=lambda spec: spec), fd_step=.01)

    monkeypatch.setattr(cal, "build_problem", build)
    monkeypatch.setattr(cal, "DatasetBlock", SyntheticBlock)
    cfg = {"parameters": [{"id": "shared.value", "blocks": ["V1", "V2"]}],
           "blocks": {"V1": {}, "V2": {}}, "fixed": [{"field": "example", "reason": "selected structure"}]}
    checkpoints = []
    loo = cal.leave_one_out(None, cfg, {"shared.value": 10}, progress=checkpoints.append)
    assert loo["held"] == {} and loo["refitted_blocks"] == ["V1", "V2"]
    assert loo["conditional_on_fixed_structure"] and loo["fixed"] == cfg["fixed"]
    # The full-data mean is 10. Each omitted datum disappears from the optimum, while V2's 20
    # remains: (8+20)/2=14 and (2+20)/2=11. Freezing the shared value or dropping V2 fails this.
    for label, expected in (("exp01", 14.0), ("exp02", 11.0)):
        fold = loo["experiments"][label]
        assert fold["fitted_values"]["shared.value"] == pytest.approx(expected, abs=1e-6)
        assert fold["start_values"] == {"shared.value": 10}
        assert fold["refitted_blocks"] == ["V1", "V2"]
        assert fold["refit_cases"] == {"V1": 1, "V2": 1}
        assert fold["optimizer"]["success"] and fold["optimizer"]["optimality"] is not None
    assert [entry["completed"] for entry in checkpoints] == [1, 2]
    assert all(entry["refitted_blocks"] == ["V1", "V2"] for entry in checkpoints)
    assert loo["lambda_total"] == 8 and loo["cup_total"] == 24
    assert loo["all_predictions_available"] is (not incomplete_prediction)
    if incomplete_prediction:
        assert not loo["experiments"]["exp01"]["predicted"]
        assert set(loo["experiments"]["exp01"]["errors"]["lambda"].values()) == {None}
    # An explicitly selected V1-only fit must not silently admit V2 data during cross-validation.
    selected = cal.leave_one_out(None, cfg, {"shared.value": 10}, refit_blocks=["V1"])
    assert selected["refitted_blocks"] == ["V1"]
    assert selected["experiments"]["exp01"]["fitted_values"]["shared.value"] == pytest.approx(8.0)
    assert selected["experiments"]["exp02"]["fitted_values"]["shared.value"] == pytest.approx(2.0)


def test_parallel_runner_matches_serial(repo):
    from puckworks_tools.cases import MODULES

    module = MODULES["smrke2024"]
    specs = [c.spec for c in module.build_cases(module.load(repo), tier=0, n_classes=6)[:3]]
    serial = cal.Runner().run(specs)
    pool = cal.Runner(jobs=2)
    try:
        assert pool.run(specs) == serial
        assert pool.simulations == 3
    finally:
        pool.close()


def test_reference_permeability_inverts_the_builder_scaling(repo, config):
    """The nuisance κ₀ of a dataset, divided by the builder's PSD scaling of its cases, gives κ_ref."""
    sub = {**config, "parameters": [p for p in config["parameters"]
                                    if p["id"] == "calibration.waszkiewicz2026.permeability"]}
    problem = cal.build_problem(repo, sub, blocks=["V4"], tier=0)
    try:
        x = problem.x0()
        kappa0 = problem.values(x)["calibration.waszkiewicz2026.permeability"]
        unc = {"parameters": {"calibration.waszkiewicz2026.permeability": {"identified": True, "sd": 1.5e-15}}}
        ref = cal.reference_permeability(problem, x, unc)
        case = problem.blocks[0].cases[0]
        scaling, rid = cal.builder_scaling(case)
        assert rid in cal.BASE_PERMEABILITY_IDS
        built = puckcore.build_shot_spec({**case.recipe, "overrides": {rid: 2.0e-14}})["spec"]
        assert built["hydraulics"]["permeability_m2"] == pytest.approx(2.0e-14 * scaling, rel=1e-12)
    finally:
        problem.runner.close()
    assert ref["id"] == "hydraulics.permeability.reference"
    (estimate,) = ref["estimates"]
    assert estimate["cases"] == 11 and estimate["builder_scaling_spread"] == pytest.approx(0.0, abs=1e-12)
    assert estimate["kappa_ref_m2"] == pytest.approx(kappa0 / scaling)
    assert ref["value_m2"] == pytest.approx(estimate["kappa_ref_m2"])
    assert estimate["kappa0_sd_log"] == pytest.approx(1.5e-15 / kappa0)
    assert estimate["scaling_basis"] == "the case's own PSD"


def test_scaling_basis_follows_the_apps_representation_of_each_grind(repo, config):
    """Schmieder's κ₀ is scaled through the E65S preset at the article's grinding level (the app's
    representation of that grind); Waszkiewicz's through its own measured PSD."""
    problem = cal.build_problem(repo, config, blocks=["V1", "V4"], tier=0)
    try:
        v1, v4 = problem.blocks
        recipe, basis = cal.scaling_basis(v1.cases[0])
        assert recipe["grinder"] == {"preset": "mahlkoenig-e65s", "setting": v1.cases[0].info["grind_level"]}
        assert "mahlkoenig-e65s" in basis
        recipe, basis = cal.scaling_basis(v4.cases[0])
        assert recipe is v4.cases[0].recipe and basis == "the case's own PSD"
    finally:
        problem.runner.close()


def test_repool_recomputes_the_reference_without_refitting(repo, config):
    kappa = {"calibration.schmieder2023.permeability.gl1_4": 3.0e-14,
             "calibration.schmieder2023.permeability.gl1_7": 3.2e-14,
             "calibration.schmieder2023.permeability.gl2_0": 3.9e-14,
             "calibration.waszkiewicz2026.permeability": 8.0e-15}
    doc = {"schema": cal.CALIBRATION_SCHEMA, "parameters": {cal.REFERENCE_PERMEABILITY_ID: 1.0e-14},
           "fit": {"nuisance": dict(kappa), "uncertainties": {}}}
    out = cal.repool(repo, doc, config)
    ref = out["fit"]["reference_permeability"]
    assert doc["parameters"][cal.REFERENCE_PERMEABILITY_ID] == 1.0e-14  # the input is not modified
    assert ref["repooled"]["previous_m2"] == 1.0e-14
    assert set(ref["datasets"]) == {"schmieder2023", "waszkiewicz2026"}
    by_parameter = {e["parameter"]: e for e in ref["estimates"]}
    for pid, value in kappa.items():
        e = by_parameter[pid]
        assert e["kappa_ref_m2"] == pytest.approx(value / e["builder_scaling"], rel=1e-5)
    # equal weight per dataset: geometric mean of the two dataset values
    expected = math.sqrt(ref["datasets"]["schmieder2023"] * ref["datasets"]["waszkiewicz2026"])
    assert out["parameters"][cal.REFERENCE_PERMEABILITY_ID] == pytest.approx(expected, rel=1e-5)


def test_peak_pressure_residual_compares_the_pour_phase(repo, config):
    """Pour-dominated experiments compare the model's pour-phase maximum both ways; where the measured
    maximum is the preinfusion exit level, it only bounds the pour phase from above."""
    from puckworks_tools.cases import schmieder2023 as sch

    problem = cal.build_problem(repo, config, blocks=["V1"], tier=0)
    try:
        block = problem.blocks[0]
        targets = sch.targets(block.data)

        def perfect(case, pour):
            t = targets[case.info["experiment"]]
            return {"lambda": {a: t["lambda"][a][0] for a, *_ in sch.ANALYTES},
                    "c0": {a: t["c0"][a][0] for a, *_ in sch.ANALYTES},
                    "cup_eq3": {a: {m: t["cup"][a][m][0] for m in (20, 40, 60)} for a, *_ in sch.ANALYTES},
                    "peak_pressure_bar": 12.0, "pour_peak_pressure_bar": pour}

        labels = block.labels
        pressure_rows = [i for i, label in enumerate(labels) if label.endswith("peak_pressure")]
        low = [c for c in block.cases if targets[c.info["experiment"]]["pressure_bar"][0] <= 3.0]
        high = [c for c in block.cases if targets[c.info["experiment"]]["pressure_bar"][0] > 3.0]
        assert low and high
        obs = [perfect(c, 0.5) for c in block.cases]  # pour phase far below every measured maximum
        r, _ = block.residual_fn(block, obs, {})
        by_case = dict(zip([c.name for c in block.cases], r[pressure_rows]))
        assert all(by_case[c.name] == 0.0 for c in low)  # consistent with an exit-level maximum
        assert all(by_case[c.name] < 0.0 for c in high)  # too low for a pour-dominated maximum
        obs = [perfect(c, 12.0) for c in block.cases]
        r, _ = block.residual_fn(block, obs, {})
        assert np.all(r[pressure_rows] > 0.0)
        assert np.all(r[[i for i in range(len(r)) if i not in pressure_rows]] == pytest.approx(0.0, abs=1e-12))
    finally:
        problem.runner.close()


def test_sensitivity_refits_v1_under_each_variant(repo, config):
    keep = {"calibration.schmieder2023.extractable_fraction", "calibration.schmieder2023.permeability.gl1_7",
            "calibration.waszkiewicz2026.permeability", "hydraulics.poroelastic.critical_pressure"}
    sub = {**config, "parameters": [p for p in config["parameters"] if p["id"] in keep]}
    variants = {"ramp 1 s": {"blocks": ["V1"], "options": {"case_options": {"transition_ramp_s": 1.0}}},
                "theta": {"blocks": ["V1", "V4"], "structural": True,
                          "options": {"spec_fields": {"hydraulics.dissolution_porosity_share": 0.27}}}}
    reference = {"datasets": {"schmieder2023": 9e-14, "waszkiewicz2026": 8e-14}}
    checkpoints = []
    out = cal.sensitivity(repo, sub, {"hydraulics.poroelastic.critical_pressure": 10.0}, reference,
                          tier=0, max_nfev=2, variants=variants, progress=checkpoints.append)
    assert set(out["variants"]) == set(variants)
    ramp, theta = out["variants"]["ramp 1 s"], out["variants"]["theta"]
    # the critical pressure is shared with V6 as well: held at its full-fit value, not refitted
    for v in (ramp, theta):
        assert v["held"] == {"hydraulics.poroelastic.critical_pressure": 10.0} and v["shared"] == {}
        assert len(v["pressures"]) == 15 and 0 <= v["lambda_within"] <= 60 and 0 <= v["cup_within"] <= 180
    # a V1-only variant keeps the other dataset's estimate; the V1+V4 variant refits both
    assert set(ramp["nuisance"]) == {"calibration.schmieder2023.extractable_fraction",
                                     "calibration.schmieder2023.permeability.gl1_7"}
    assert ramp["kappa_ref_by_dataset"]["waszkiewicz2026"] == 8e-14
    assert ramp["pooled_kappa_ref_m2"] == pytest.approx(math.sqrt(ramp["schmieder_kappa_ref_m2"] * 8e-14))
    assert "calibration.waszkiewicz2026.permeability" in theta["nuisance"] and theta["structural"]
    assert theta["kappa_ref_by_dataset"]["waszkiewicz2026"] != 8e-14
    assert [c["completed"] for c in checkpoints] == [1, 2]
    assert len(checkpoints[0]["variants"]) == 1 and len(checkpoints[1]["variants"]) == 2
    assert out["completed"] == out["required"] == 2
    assert out["all_optimizers_converged"] == all(v["optimizer"]["success"] for v in out["variants"].values())


def test_prune_fixes_parameters_the_data_do_not_constrain(repo, config):
    """The V2 Bodenstein numbers constrain the dispersion but not the surface rate: pruning fixes the
    surface rate at its registry value, records why, and keeps the dispersion."""
    sub = {**config, "fixed": [], "parameters": [
        {"id": "extraction.dispersion.axial_coefficient", "mode": "override", "blocks": ["V2"], "scale": "log"},
        {"id": "extraction.surface_rate.grudeva2026", "mode": "override", "blocks": ["V2"], "scale": "log",
         "bounds": [1.0e-5, 1.0e-2]}]}
    problem = cal.build_problem(repo, sub, blocks=["V2"])
    try:
        result = cal.fit(problem, max_nfev=3)
        pruned_config, problem, result, pruned = cal.prune(repo, sub, problem, result, max_nfev=3)
    finally:
        problem.runner.close()
    assert list(pruned) == ["extraction.surface_rate.grudeva2026"]
    assert pruned["extraction.surface_rate.grudeva2026"]["value"] == 1e-3
    assert "identifiability rule" in pruned["extraction.surface_rate.grudeva2026"]["reason"]
    assert [p.id for p in problem.params] == ["extraction.dispersion.axial_coefficient"]
    assert [e["id"] for e in pruned_config["fixed"]] == ["extraction.surface_rate.grudeva2026"]
    assert [e["id"] for e in sub["parameters"]][1] == "extraction.surface_rate.grudeva2026"  # input untouched
