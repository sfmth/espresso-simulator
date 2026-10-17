# SPDX-License-Identifier: GPL-2.0-or-later
"""Concurrent conditional LOO: ownership, deterministic results and coordinator callbacks.

These checks fit small synthetic scalar problems; no native simulations run.
"""
from __future__ import annotations

import argparse
import copy
import threading
from types import SimpleNamespace

import numpy as np
import pytest

from puckworks_tools import calibrate as cal
from puckworks_tools.cases import schmieder2023 as sch


def install_synthetic(monkeypatch, module=cal, *, incomplete=False):
    state = SimpleNamespace(
        lock=threading.Lock(), runners=[], problems=[], calls=[], callbacks=[],
        active=0, maximum=0, concurrent=False, barrier=threading.Barrier(2, timeout=10),
        release_first=threading.Event(), fail_fold=None,
    )
    base_runner, original_fit = module.Runner, module.fit
    target_values = {1: 2.0, 2: 8.0, 3: 5.0, 4: 17.0}
    target_data = {
        i: {"lambda": {a: (value, 1.0) for a, *_ in sch.ANALYTES},
            "cup": {a: {m: (value, 1.0) for m in (20, 40, 60)} for a, *_ in sch.ANALYTES}}
        for i, value in target_values.items()
    }
    monkeypatch.setattr(sch, "targets", lambda data: data["targets"])

    class TrackedRunner(base_runner):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.owner_thread = threading.get_ident()
            self.closed = 0
            with state.lock:
                state.runners.append(self)

        def close(self):
            self.closed += 1
            super().close()

    class Block:
        def __init__(self, name, module, data, cases, options, units):
            self.name, self.module, self.data, self.cases = name, module, data, cases
            self.options, self.units = options, units
            self.labels = [f"{name}/{case.name}" for case in cases]

        def evaluate(self, values, runner, params):
            assert runner.owner_thread == threading.get_ident()
            value = values["shared.value"]
            observations = []
            for case in self.cases:
                obs = {
                    "lambda": {a: value for a, *_ in sch.ANALYTES},
                    "c0": {a: value for a, *_ in sch.ANALYTES},
                    "cup_eq3": {a: {m: value for m in (20, 40, 60)} for a, *_ in sch.ANALYTES},
                    "pour_peak_pressure_bar": 1.0,
                }
                if incomplete and self.name == "V1" and case.info["experiment"] == 1:
                    del obs["c0"]
                observations.append(obs)
            return module.Evaluation(np.array([value - case.target for case in self.cases]),
                                     self.labels, observations, [])

    def build(paths, config, *, blocks=None, exclude_cases_by_block=None, runner=None,
              jobs=1, simulate=None, fd_step=.01, **kwargs):
        selected = list(config["blocks"] if blocks is None else blocks)
        built = []
        for name in selected:
            if name == "V1":
                cases = [SimpleNamespace(name=f"case{i}", info={"experiment": i}, target=value)
                         for i, value in target_values.items()]
            else:
                # Same name as a V1 case: only the specified block may lose it.
                cases = [SimpleNamespace(name="case1", info={}, target=20.0)]
            excluded = set((exclude_cases_by_block or {}).get(name, ()))
            built.append(Block(name, sch, {"targets": copy.deepcopy(target_data)},
                               [case for case in cases if case.name not in excluded],
                               copy.deepcopy(config["blocks"][name]), {}))
        parameter = module.Parameter("shared.value", "override", ("V1", "V2"),
                                     "linear", .1, 30.0, 10.0, "1")
        problem = module.Problem([parameter], built, runner or module.Runner(simulate, jobs), fd_step)
        exclusions = (exclude_cases_by_block or {}).get("V1", [])
        problem.omitted = int(exclusions[0][4:]) if exclusions else None
        problem.config_for_test = config
        with state.lock:
            state.problems.append(problem)
        return problem

    def fit(problem, **kwargs):
        with state.lock:
            state.active += 1
            state.maximum = max(state.maximum, state.active)
            state.calls.append((problem.omitted, dict(kwargs)))
        try:
            if state.fail_fold == problem.omitted:
                raise RuntimeError("synthetic fold failed")
            if state.concurrent and problem.omitted in (1, 2):
                state.barrier.wait()
                if problem.omitted == 1:
                    assert state.release_first.wait(10), "coordinator did not release the first fold"
            return original_fit(problem, **kwargs)
        finally:
            with state.lock:
                state.active -= 1

    monkeypatch.setattr(module, "Runner", TrackedRunner)
    monkeypatch.setattr(module, "DatasetBlock", Block)
    monkeypatch.setattr(module, "build_problem", build)
    monkeypatch.setattr(module, "fit", fit)
    config = {"parameters": [{"id": "shared.value", "blocks": ["V1", "V2"]}],
              "blocks": {"V1": {}, "V2": {}},
              "fixed": [{"field": "example", "reason": "fixed selected structure"}]}

    def checkpoint(doc):
        state.callbacks.append((threading.get_ident(), doc))
        if "exp02" in doc["experiments"]:
            state.release_first.set()

    return state, config, checkpoint


@pytest.mark.parametrize("incomplete", [False, True])
@pytest.mark.parametrize("loss", ["linear", "soft_l1"])
def test_concurrent_folds_match_serial_and_isolate_mutable_state(monkeypatch, incomplete, loss):
    state, config, checkpoint = install_synthetic(monkeypatch, incomplete=incomplete)
    original_config = copy.deepcopy(config)
    start = {"shared.value": 10.0}
    serial = cal.leave_one_out(None, config, start, jobs=8, loss=loss)
    assert len(state.runners) == 1 and state.runners[0].closed == 1
    serial_runner = state.runners[0]
    state.concurrent = True
    state.problems.clear()
    state.calls.clear()
    concurrent = cal.leave_one_out(None, config, start, jobs=8, loo_jobs=2,
                                   loss=loss, progress=checkpoint)
    assert state.maximum == 2
    assert concurrent["loo_jobs"] == 2 and concurrent["jobs_per_fold"] == 8
    assert concurrent["loss"] == loss
    assert {key: value for key, value in concurrent.items() if key != "loo_jobs"} == {
        key: value for key, value in serial.items() if key != "loo_jobs"}
    assert list(concurrent["experiments"]) == ["exp01", "exp02", "exp03", "exp04"]
    assert [doc["completed"] for _, doc in state.callbacks] == [1, 2, 3, 4]
    assert list(state.callbacks[0][1]["experiments"])[0] == "exp02"
    assert all(thread_id == threading.get_ident() for thread_id, _ in state.callbacks)
    for _, doc in state.callbacks:
        assert list(doc["experiments"]) == sorted(doc["experiments"])
    workers = [r for r in state.runners if getattr(r, "_process_start_method", None) == "spawn"]
    assert len(workers) == 4
    assert len({id(r._cache) for r in workers}) == 4
    assert all(r.jobs == 8 and r.closed == 1 and r is not serial_runner for r in workers)
    assert all(r.closed == 1 for r in state.runners)
    fold_problems = [p for p in state.problems if p.omitted is not None]
    assert len({id(p.runner) for p in fold_problems}) == 4
    assert len({id(p._cache) for p in fold_problems}) == 4
    assert len({id(p.params[0]) for p in fold_problems}) == 4
    assert len({id(p.config_for_test) for p in fold_problems}) == 4
    assert all(p.config_for_test is not config for p in fold_problems)
    assert len({id(p.blocks[0].data) for p in fold_problems}) == 4
    assert all(call["loss"] == loss for _, call in state.calls)
    assert concurrent["lambda_total"] == 16 and concurrent["cup_total"] == 48
    assert concurrent["all_predictions_available"] is (not incomplete)
    if incomplete:
        assert not concurrent["experiments"]["exp01"]["predicted"]
        assert set(concurrent["experiments"]["exp01"]["errors"]["lambda"].values()) == {None}
    state.callbacks[-1][1]["experiments"]["exp01"]["cost"] = -1
    assert concurrent["experiments"]["exp01"]["cost"] >= 0
    assert config == original_config and start == {"shared.value": 10.0}


def test_default_uses_serial_runner_and_selected_blocks(monkeypatch):
    state, config, checkpoint = install_synthetic(monkeypatch)
    monkeypatch.setattr(cal, "ThreadPoolExecutor", lambda **kwargs: pytest.fail("serial path created executor"))
    result = cal.leave_one_out(None, config, {"shared.value": 10.0}, refit_blocks=["V1"], progress=checkpoint)
    assert result["loo_jobs"] == 1 and result["jobs_per_fold"] == 1
    assert len(state.runners) == 1 and state.runners[0].closed == 1
    expected = {"exp01": 10.0, "exp02": 8.0, "exp03": 9.0, "exp04": 5.0}
    assert result["refitted_blocks"] == ["V1"]
    for name, fold in result["experiments"].items():
        assert fold["fitted_values"]["shared.value"] == expected[name]
        assert fold["refit_cases"] == {"V1": 3}
    assert all(thread_id == threading.get_ident() for thread_id, _ in state.callbacks)


@pytest.mark.parametrize("failure", ["fold", "checkpoint"])
def test_concurrent_failure_closes_all_started_runners(monkeypatch, failure):
    state, config, checkpoint = install_synthetic(monkeypatch)
    if failure == "fold":
        state.fail_fold = 2
    else:
        def checkpoint(doc):
            assert threading.get_ident() == coordinator
            raise RuntimeError("synthetic checkpoint failed")
    coordinator = threading.get_ident()
    with pytest.raises(RuntimeError, match=f"synthetic {failure} failed"):
        cal.leave_one_out(None, config, {"shared.value": 10.0}, loo_jobs=2, progress=checkpoint)
    assert state.maximum <= 2
    assert all(runner.closed == 1 for runner in state.runners)


@pytest.mark.parametrize("jobs", [0, -1, 1.5, True])
def test_loo_rejects_nonpositive_or_nonintegral_concurrency(jobs):
    with pytest.raises(cal.CalibrationError, match="positive integer"):
        cal.leave_one_out(None, {}, {}, loo_jobs=jobs)


def test_cli_loo_jobs_default_and_validation():
    parser = argparse.ArgumentParser()
    cal.add_arguments(parser)
    assert parser.parse_args([]).loo_jobs == 1
    args = parser.parse_args(["--loo", "--loo-jobs", "2", "--jobs", "8"])
    assert args.loo and args.loo_jobs == 2 and args.jobs == 8
    for value in ("0", "-1", "1.5"):
        with pytest.raises(SystemExit):
            parser.parse_args(["--loo-jobs", value])


def test_runner_process_context_is_opt_in(monkeypatch):
    created = []

    class Pool:
        def __init__(self, **kwargs):
            self.kwargs, self.closed = kwargs, False
            created.append(self)

        def map(self, function, values):
            return [{} for _ in values]  # No function invocation or native simulation.

        def shutdown(self):
            self.closed = True

    monkeypatch.setattr(cal, "ProcessPoolExecutor", Pool)
    for start_method in (None, "spawn"):
        runner = cal.Runner(jobs=8, process_start_method=start_method)
        try:
            runner.run([{"case": 1}, {"case": 2}])
        finally:
            runner.close()
    assert created[0].kwargs == {"max_workers": 8}
    assert created[1].kwargs["max_workers"] == 8
    assert created[1].kwargs["mp_context"].get_start_method() == "spawn"
    assert all(pool.closed for pool in created)
