// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECIPE, defaultForm } from '../shot/recipeForm';
import { resetShotStore, useShotStore } from '../shot/shotStore';
import {
  emptySetupDocument,
  INFERENCE_STORAGE_KEY,
  parseSetupDocument,
  resetEquipmentStore,
  useEquipmentStore,
  type SavedSetup,
} from './inferenceStorage';
import type { SetupCandidate, SetupCheck, SetupObservation } from './inferenceTypes';

beforeEach(() => {
  localStorage.clear();
  resetEquipmentStore();
  resetShotStore();
});
afterEach(() => vi.restoreAllMocks());
const specified = (): SavedSetup => ({
  id: 'setup-a',
  name: 'My grinder',
  createdAt: '2026-10-21T08:00:00Z',
  coreVersion: 'test',
  source: 'specified',
  recipe: structuredClone(DEFAULT_RECIPE),
  facts: { heater: 'boiler', displayedTemperatureC: 95 },
  request: { recipe: structuredClone(DEFAULT_RECIPE), constraints: [], observations: [] },
});
const inferred = (): SavedSetup & { candidate: SetupCandidate } => {
  const saved = specified();
  const shot: SetupObservation = {
    id: 'shot-one',
    label: 'Recorded shot',
    timeS: 36,
    yieldG: 35,
    tdsPercent: 9.2,
    timeBasis: 'pump',
    massBasis: 'final',
    timeToleranceS: 0.5,
    yieldToleranceG: 1,
    tdsTolerancePercent: 0.2,
    recipe: structuredClone(DEFAULT_RECIPE),
  };
  const check: SetupCheck = {
    observationId: shot.id,
    label: shot.label,
    predicted: { timeS: 36.25, yieldG: 35.2, tdsPercent: 9.25 },
    observed: { timeS: shot.timeS, yieldG: shot.yieldG, tdsPercent: shot.tdsPercent },
    residuals: { timeS: 0.25, yieldG: 35.2 - 35, tdsPercent: 9.25 - 9.2 },
    tolerances: { timeS: 0.5, yieldG: 1, tdsPercent: 0.2 },
    matches: true,
    timeIsReplayCondition: true,
  };
  return {
    ...saved,
    source: 'inferred',
    request: { ...saved.request, observations: [shot] },
    candidate: {
      id: 'matching-candidate',
      recipe: structuredClone(saved.recipe),
      values: { 'prep.dose_g': saved.recipe.prep.dose_g },
      checks: [check],
      score: check.residuals.yieldG ** 2 + ((9.25 - 9.2) / 0.2) ** 2 + 0.01 * (0.25 / 0.5) ** 2,
      matches: true,
      notes: ['Matching recorded shots does not identify a unique setup.'],
    },
  };
};
describe('local equipment inference records', () => {
  it('restores alternatives, constraints and displayed temperature without touching journal data', () => {
    localStorage.setItem('unrelated-journal-sentinel', 'preserve');
    useEquipmentStore.getState().update((d) => ({
      ...d,
      alternatives: [specified()],
      activeId: 'setup-a',
      constraints: [{ path: 'prep.dose_g', mode: 'locked', value: 18 }],
    }));
    expect(useEquipmentStore.getState().persistent).toBe(true);
    resetEquipmentStore();
    useEquipmentStore.getState().hydrate();
    expect(useEquipmentStore.getState().document.alternatives[0].facts.displayedTemperatureC).toBe(
      95,
    );
    expect(useEquipmentStore.getState().document.constraints[0].value).toBe(18);
    expect(useEquipmentStore.getState().document.activeId).toBe('setup-a');
    expect(localStorage.getItem('unrelated-journal-sentinel')).toBe('preserve');
  });
  it('imports alternatives without activating a recipe before explicit native validation', () => {
    const document = {
      ...emptySetupDocument(),
      alternatives: [inferred()],
      activeId: 'setup-a',
    };
    useEquipmentStore.getState().importDocument(JSON.stringify(document));
    expect(useEquipmentStore.getState().document.alternatives).toEqual(document.alternatives);
    expect(useEquipmentStore.getState().document.activeId).toBeNull();
    resetEquipmentStore();
    useEquipmentStore.getState().hydrate();
    expect(useEquipmentStore.getState().document.activeId).toBeNull();
    expect(useEquipmentStore.getState().document.alternatives).toEqual(document.alternatives);
  });
  it('keeps session edits with an honest warning when a write fails', () => {
    useEquipmentStore.getState().hydrate();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota');
    });
    useEquipmentStore.getState().update((d) => ({ ...d, name: 'Session setup' }));
    expect(useEquipmentStore.getState().document.name).toBe('Session setup');
    expect(useEquipmentStore.getState().persistent).toBe(false);
    expect(useEquipmentStore.getState().notice).toContain('Export a backup');
  });
  it('rejects stale-tab writes without losing the existing in-memory state', () => {
    useEquipmentStore.getState().hydrate();
    localStorage.setItem(
      INFERENCE_STORAGE_KEY,
      JSON.stringify({ ...emptySetupDocument(), name: 'Another tab' }),
    );
    expect(() => useEquipmentStore.getState().update((d) => ({ ...d, name: 'Stale tab' }))).toThrow(
      'another tab',
    );
    expect(useEquipmentStore.getState().document.name).toBe('My equipment');
    expect(JSON.parse(localStorage.getItem(INFERENCE_STORAGE_KEY)!)).toHaveProperty(
      'name',
      'Another tab',
    );
  });
  it('refuses malformed imports atomically and keeps the active alternative', () => {
    useEquipmentStore
      .getState()
      .update((d) => ({ ...d, alternatives: [specified()], activeId: 'setup-a' }));
    const before = localStorage.getItem(INFERENCE_STORAGE_KEY);
    expect(() =>
      useEquipmentStore
        .getState()
        .importDocument(JSON.stringify({ ...emptySetupDocument(), activeId: 'missing' })),
    ).toThrow('missing');
    expect(localStorage.getItem(INFERENCE_STORAGE_KEY)).toBe(before);
    expect(useEquipmentStore.getState().document.activeId).toBe('setup-a');
  });
  it('rejects unsafe paths, duplicate constraints and oversize backups', () => {
    for (const path of ['__proto__.x', 'machine.constructor.x', 'numerics.tier']) {
      expect(() =>
        parseSetupDocument(
          JSON.stringify({
            ...emptySetupDocument(),
            constraints: [{ path, mode: 'locked', value: 1 }],
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      parseSetupDocument(
        JSON.stringify({
          ...emptySetupDocument(),
          constraints: Array(2).fill({ path: 'prep.dose_g', mode: 'locked', value: 18 }),
        }),
      ),
    ).toThrow('Duplicate');
    expect(() => parseSetupDocument(' '.repeat(5_000_001))).toThrow('5 MB');
  });
  it('rejects claimed inferred alternatives without checks on every source shot', () => {
    const p = { ...specified(), source: 'inferred' };
    expect(() =>
      parseSetupDocument(JSON.stringify({ ...emptySetupDocument(), alternatives: [p] })),
    ).toThrow('verification');
  });
  it('round-trips an inferred setup with consistent verification and keeps unfinished constraint drafts', () => {
    const document = {
      ...emptySetupDocument(),
      alternatives: [inferred()],
      activeId: 'setup-a',
      constraints: [{ path: 'prep.dose_g', mode: 'range' as const, min: 17 }],
    };
    expect(parseSetupDocument(JSON.stringify(document))).toEqual(document);
  });
  it.each<[string, (setup: ReturnType<typeof inferred>) => void, string]>([
    [
      'saved recipe',
      (s) => {
        s.recipe.prep.dose_g += 1;
      },
      'recipe differs',
    ],
    [
      'observed mass',
      (s) => {
        s.candidate.checks[0].observed.yieldG += 1;
      },
      'conditions differ',
    ],
    [
      'observed time',
      (s) => {
        s.candidate.checks[0].observed.timeS += 1;
      },
      'conditions differ',
    ],
    [
      'observed TDS',
      (s) => {
        s.candidate.checks[0].observed.tdsPercent = 8;
      },
      'conditions differ',
    ],
    [
      'mass tolerance',
      (s) => {
        s.candidate.checks[0].tolerances.yieldG = 10;
      },
      'conditions differ',
    ],
    [
      'time tolerance',
      (s) => {
        s.candidate.checks[0].tolerances.timeS = 2;
      },
      'conditions differ',
    ],
    [
      'TDS tolerance',
      (s) => {
        s.candidate.checks[0].tolerances.tdsPercent = 2;
      },
      'conditions differ',
    ],
    [
      'mass residual',
      (s) => {
        s.candidate.checks[0].residuals.yieldG = 0;
      },
      'residuals',
    ],
    [
      'time residual',
      (s) => {
        s.candidate.checks[0].residuals.timeS = 0;
      },
      'residuals',
    ],
    [
      'TDS residual',
      (s) => {
        s.candidate.checks[0].residuals.tdsPercent = 0;
      },
      'residuals',
    ],
    [
      'score',
      (s) => {
        s.candidate.score = 0;
      },
      'score',
    ],
    [
      'unsafe inferred path',
      (s) => {
        s.candidate.values['numerics.tier'] = 0;
      },
      'parameter path',
    ],
  ])('rejects inconsistent %s atomically', (_label, mutate, message) => {
    useEquipmentStore.getState().update((d) => ({
      ...d,
      alternatives: [specified()],
      activeId: 'setup-a',
    }));
    const before = localStorage.getItem(INFERENCE_STORAGE_KEY);
    const candidate = inferred();
    mutate(candidate);
    expect(() =>
      useEquipmentStore.getState().importDocument(
        JSON.stringify({
          ...emptySetupDocument(),
          alternatives: [candidate],
          activeId: 'setup-a',
        }),
      ),
    ).toThrow(message);
    expect(localStorage.getItem(INFERENCE_STORAGE_KEY)).toBe(before);
    expect(useEquipmentStore.getState().document.alternatives[0].source).toBe('specified');
  });
  it.each(['timeS', 'yieldG', 'tdsPercent'] as const)(
    'rejects a claimed match outside its %s tolerance even when the residual is consistent',
    (key) => {
      const setup = inferred();
      const check = setup.candidate.checks[0];
      check.predicted[key] = check.observed[key]! + check.tolerances[key]! + 0.01;
      check.residuals[key] = check.predicted[key] - check.observed[key]!;
      expect(() =>
        parseSetupDocument(
          JSON.stringify({
            ...emptySetupDocument(),
            alternatives: [setup],
          }),
        ),
      ).toThrow('residuals');
    },
  );
  it('accepts unmeasured TDS with a saved tolerance but rejects invented TDS evidence', () => {
    const setup = inferred();
    const shot = setup.request.observations[0];
    const check = setup.candidate.checks[0];
    delete shot.tdsPercent;
    delete check.observed.tdsPercent;
    delete check.residuals.tdsPercent;
    setup.candidate.score = check.residuals.yieldG ** 2 + 0.01 * (0.25 / 0.5) ** 2;
    const serialize = () => JSON.stringify({ ...emptySetupDocument(), alternatives: [setup] });
    expect(() => parseSetupDocument(serialize())).not.toThrow();
    check.residuals.tdsPercent = 0;
    expect(() => parseSetupDocument(serialize())).toThrow('unmeasured TDS');
  });
  it('requires predicted TDS and nonnegative predicted quantities', () => {
    for (const mutate of [
      (check: SetupCheck) => {
        Reflect.deleteProperty(check.predicted, 'tdsPercent');
      },
      (check: SetupCheck) => {
        check.predicted.yieldG = -1;
      },
      (check: SetupCheck) => {
        check.predicted.tdsPercent = -1;
      },
    ]) {
      const setup = inferred();
      mutate(setup.candidate.checks[0]);
      expect(() =>
        parseSetupDocument(
          JSON.stringify({
            ...emptySetupDocument(),
            alternatives: [setup],
          }),
        ),
      ).toThrow('number');
    }
  });
  it('rejects TDS without a positive tolerance and timing tolerances that permit zero time', () => {
    const shot = inferred().request.observations[0];
    delete shot.tdsTolerancePercent;
    expect(() =>
      parseSetupDocument(
        JSON.stringify({
          ...emptySetupDocument(),
          observations: [shot],
        }),
      ),
    ).toThrow('number');
    delete shot.tdsPercent;
    shot.timeToleranceS = shot.timeS;
    expect(() =>
      parseSetupDocument(
        JSON.stringify({
          ...emptySetupDocument(),
          observations: [shot],
        }),
      ),
    ).toThrow('smaller');
  });
});

it('invalidates an older paired recipe Undo when another setup backup is imported', () => {
  const restoreKnowledge = vi.fn();
  const form = defaultForm();
  form.prep.dose_g = '19';
  useShotStore.getState().loadForm(form, 'Undo coffee change', restoreKnowledge);
  expect(useShotStore.getState().undo).not.toBeNull();
  const document = emptySetupDocument();
  document.constraints = [{ path: 'prep.dose_g', mode: 'locked', value: 20 }];
  useEquipmentStore.getState().importDocument(JSON.stringify(document));
  expect(useShotStore.getState().undo).toBeNull();
  useShotStore.getState().undoLast();
  expect(restoreKnowledge).not.toHaveBeenCalled();
  expect(useEquipmentStore.getState().document.constraints).toEqual(document.constraints);
  expect(useShotStore.getState().form.prep.dose_g).toBe('19');
});
