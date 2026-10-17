# SPDX-License-Identifier: GPL-2.0-or-later
"""Registry-fixed pruning profiles use the training objective, bounds and available predictions."""
from __future__ import annotations

import copy
import math
from types import SimpleNamespace

import numpy as np
import pytest

from puckworks_tools import calibrate as cal


def synthetic_pruning(monkeypatch, *, kind='coupled', registry_x=1.5, failures=False):
    if kind == 'independent':
        names, defaults = ['a', 'b'], {'a': 1.0, 'b': 1.0}
    else:
        names = ['x', 'y', 'z'] if kind == 'mixed' else ['x', 'y']
        defaults = {'x': registry_x, 'y': 0.0, 'z': .01}
    records = {key: {'id': key, 'value': defaults[key], 'units': '1'} for key in names}
    monkeypatch.setattr(cal, 'load_registry', lambda paths: records)
    problems = []
    monkeypatch.setitem(cal.BLOCK_DATASETS, 'synthetic', ('synthetic',))

    class Block:
        name = 'train'
        module = SimpleNamespace(KEY='synthetic', DATASETS=('synthetic',))
        cases = []
        weight = 1.0

        def __init__(self, fixed):
            self.fixed = fixed
            count = 4 if kind == 'mixed' else 3
            self.labels = [f'train/{i}' for i in range(count)]

        def evaluate(self, values, runner, params):
            v = {**self.fixed, **values}
            if kind == 'independent':
                residuals = [math.sqrt(.6)*v['a'], math.sqrt(.6)*v['b'], 10.0]
            else:
                residuals = [10*(v['x']+v['y']-.5), .01*(v['x']-.5), 1.0]
                if kind == 'mixed':
                    residuals.insert(2, .05*v['z'])
            unavailable = ['synthetic missing final observation'] if failures and self.fixed else []
            return cal.Evaluation(np.array(residuals), self.labels, [], [], unavailable)

    def build(paths, config, *, runner=None, fd_step=.01, **kwargs):
        parameters = []
        for entry in config['parameters']:
            key = entry['id']
            lo, hi, start = (0., 2., 0.) if key == 'y' else (-3., 3., .5 if key == 'x' else 0.)
            parameters.append(cal.Parameter(key, entry['mode'], ('train',), 'linear', lo, hi, start,
                                            '1', prior_sd_x=1.0))
        fixed = {entry['id']: defaults[entry['id']] for entry in config.get('fixed', [])}
        problem = cal.Problem(parameters, [Block(fixed)], runner or cal.Runner(), fd_step)
        problems.append(problem)
        return problem

    monkeypatch.setattr(cal, 'build_problem', build)
    config = {'parameters': [{'id': key, 'mode': 'spec' if key == 'y' else 'override', 'blocks': ['train']}
                             for key in names], 'blocks': {'train': {}}, 'fixed': []}
    problem = build(None, config)
    result = cal.fit(problem)
    assert result.success
    return config, problem, result, problems


def test_weak_marginal_direction_requiring_bound_violation_is_retained(monkeypatch):
    config, problem, result, problems = synthetic_pruning(monkeypatch)
    original_config, original_x = copy.deepcopy(config), result.x.copy()
    original_starts = [parameter.start for parameter in problem.params]
    uncertainty = cal.uncertainties(problem, result.x, result.jacobian, result.residuals)
    assert uncertainty['parameters']['x']['identified']
    assert uncertainty['parameters']['x']['prior_sd_ratio'] > 10
    assert uncertainty['parameters']['y']['at_bound']
    assert uncertainty['correlation']['matrix'][0][1] < -.99
    # Keeping x+y=.5 after setting x=1.5 would require y=-1, outside its [0,2] box.
    checkpoints = []
    new_config, retained, new_result, pruned = cal.prune(
        None, config, problem, result,
        progress=lambda cfg, prob, res, fixed: checkpoints.append((copy.deepcopy(cfg), prob, res, dict(fixed))))
    assert retained is problem and new_result is result and not pruned
    assert new_config == config == original_config
    assert np.array_equal(result.x, original_x)
    assert [parameter.start for parameter in problem.params] == original_starts
    assert len(problems) == 2 and problems[1]._cache is not problem._cache
    assert all(a is not b for a in problem.params for b in problems[1].params)
    attempt = retained.pruning_review['attempts'][0]
    assert attempt['parameter'] == 'x' and attempt['decision'] == 'retained'
    assert attempt['finite'] and attempt['optimizer']['success'] and attempt['final_failures'] == []
    assert attempt['trial_cost'] > 50*attempt['baseline_cost']
    assert set(attempt['reasons']) == {'current_cost_limit_exceeded', 'initial_cost_limit_exceeded'}
    assert attempt['trial_fitted_values']['y'] >= 0
    assert len(checkpoints) == 1 and checkpoints[0][1] is problem and checkpoints[0][2] is result


def test_small_loss_registry_profile_is_removable(monkeypatch):
    config, problem, result, _ = synthetic_pruning(monkeypatch, registry_x=.495)
    new_config, accepted, final, pruned = cal.prune(None, config, problem, result)
    assert list(pruned) == ['x']
    assert accepted is not problem
    assert [p.id for p in accepted.params] == ['y']
    assert final.success and final.cost <= result.cost*1.01
    assert new_config['fixed'][0]['id'] == 'x' and config['fixed'] == []
    review = accepted.pruning_review
    assert review['accepted_parameters'] == ['x'] and review['retained_parameters'] == []
    assert review['attempts'][0]['accepted'] and review['attempts'][0]['reasons'] == []
    assert review['attempts'][0]['registry_value'] == .495


def test_cumulative_cost_ceiling_prevents_small_losses_compounding(monkeypatch):
    config, problem, result, _ = synthetic_pruning(monkeypatch, kind='independent')
    checkpoints = []
    def checkpoint(cfg, prob, res, fixed):
        checkpoints.append(cal.calibration_document(prob, res, label='synthetic', config_path=None,
                                                    core_version='test', fixed=fixed))
    _, final, outcome, pruned = cal.prune(None, config, problem, result, progress=checkpoint)
    review = final.pruning_review
    assert result.cost == pytest.approx(50)
    assert len(pruned) == 1 and len(review['retained_parameters']) == 1
    assert len(review['attempts']) == 2
    first, second = review['attempts']
    assert first['accepted'] and first['trial_cost'] == pytest.approx(50.3)
    assert second['trial_cost'] == pytest.approx(50.6)
    assert second['trial_cost'] < second['current_cost_limit']
    assert second['trial_cost'] > second['initial_cost_limit']
    assert second['reasons'] == ['initial_cost_limit_exceeded']
    assert outcome.cost == pytest.approx(50.3)
    retained_checkpoint = checkpoints[-1]
    assert retained_checkpoint['fit']['optimizer']['cost'] == pytest.approx(50.3)
    assert retained_checkpoint['fit']['pruning_review']['attempts'][-1]['trial_cost'] == pytest.approx(50.6)
    assert set(retained_checkpoint['fit']['fixed']) == set(pruned)
    assert set(retained_checkpoint['parameters']) == set(review['retained_parameters'])
    assert len(checkpoints[0]['fit']['pruning_review']['attempts']) == 1


def test_rejected_id_is_not_retried_after_another_acceptance_and_review_is_serialized(monkeypatch):
    config, problem, result, _ = synthetic_pruning(monkeypatch, kind='mixed')
    checkpoints = []

    def checkpoint(cfg, prob, res, fixed):
        checkpoints.append(cal.calibration_document(prob, res, label='synthetic', config_path=None,
                                                    core_version='test', fixed=fixed))

    _, final, outcome, pruned = cal.prune(None, config, problem, result, progress=checkpoint)
    attempts = final.pruning_review['attempts']
    assert [(a['parameter'], a['decision']) for a in attempts] == [('x', 'retained'), ('z', 'accepted')]
    assert list(pruned) == ['z'] and [p.id for p in final.params] == ['x', 'y']
    assert len(checkpoints) == 2
    # A rejected checkpoint still describes its retained baseline, with the failed profile separate.
    first = checkpoints[0]['fit']
    assert first['optimizer']['cost'] == cal._round(result.cost)
    assert first['pruning_review']['attempts'][0]['trial_cost'] > 50*first['optimizer']['cost']
    assert 'x' not in first['fixed']
    assert len(first['pruning_review']['attempts']) == 1  # later updates cannot mutate prior snapshots
    document = cal.calibration_document(final, outcome, label='synthetic', config_path=None,
                                        core_version='test', fixed=pruned)
    assert document['fit']['pruning_review']['retained_parameters'] == ['x']
    assert document['fit']['pruning_review']['accepted_parameters'] == ['z']
    assert 'local marginal' in document['fit']['fixed']['z']['reason']
    assert document['fit']['pruning_review']['cost_references'] == ['initial_pre_prune', 'current_accepted']


@pytest.mark.parametrize('fault', ['unsuccessful', 'nonfinite', 'unavailable'])
def test_trial_must_converge_be_finite_and_have_available_final_predictions(monkeypatch, fault):
    config, problem, result, _ = synthetic_pruning(monkeypatch, registry_x=.495, failures=fault=='unavailable')
    fit = cal.fit

    def trial_fit(*args, **kwargs):
        trial = fit(*args, **kwargs)
        if fault == 'unsuccessful':
            trial.success = False
            trial.status = 0
            trial.message = 'synthetic evaluation limit'
        elif fault == 'nonfinite':
            trial.x[0] = math.nan
        return trial

    monkeypatch.setattr(cal, 'fit', trial_fit)
    _, retained, final, pruned = cal.prune(None, config, problem, result)
    assert retained is problem and final is result and not pruned
    attempt = retained.pruning_review['attempts'][0]
    expected = {'unsuccessful':'optimizer_not_converged', 'nonfinite':'nonfinite_trial',
                'unavailable':'final_predictions_unavailable'}[fault]
    assert expected in attempt['reasons'] and not attempt['accepted']
    if fault == 'nonfinite':
        assert attempt['final_failures'] is None and attempt['trial_fitted_values'] is None


def test_accepted_pruning_forwards_loss_and_preserves_blocks(monkeypatch):
    config, problem, result, _ = synthetic_pruning(monkeypatch, registry_x=.495)
    fit = cal.fit
    calls = []

    def trial_fit(prob, **kwargs):
        outcome = fit(prob, **kwargs)
        raw_cost = .5*float(outcome.residuals@outcome.residuals)
        robust_cost = float(np.sum(np.sqrt(1+outcome.residuals**2)-1))
        calls.append((list(b.name for b in prob.blocks), kwargs, raw_cost, robust_cost))
        return outcome

    monkeypatch.setattr(cal, 'fit', trial_fit)
    _, final, _, _ = cal.prune(None, config, problem, result, loss='soft_l1', max_nfev=100)
    assert calls[0][0] == ['train'] and calls[0][1]['loss'] == 'soft_l1'
    assert calls[0][1]['max_nfev'] == 100
    assert final.pruning_review['loss'] == 'soft_l1'
    assert final.pruning_review['refitted_blocks'] == ['train']
    assert final.pruning_review['attempts'][0]['trial_cost'] == calls[0][2]
    assert calls[0][2] != pytest.approx(calls[0][3])


@pytest.mark.parametrize('cost', [math.nan, math.inf, -1.0])
def test_pruning_rejects_invalid_baseline_cost(monkeypatch, cost):
    config, problem, result, _ = synthetic_pruning(monkeypatch)
    result.cost = cost
    with pytest.raises(cal.CalibrationError, match='finite nonnegative baseline'):
        cal.prune(None, config, problem, result)
