// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import { EngineContext } from '../engine/EngineContext';
import type { Engine } from '../engine/engine';
import type { Recipe } from '../engine/shotTypes';
import { formToRecipe } from '../shot/recipeForm';
import { resetShotStore, useShotStore } from '../shot/shotStore';
import { resetAppStore, useAppStore } from '../store';
import { SetupEquipment } from './SetupEquipment';
import * as inference from './inference';
import type { InferenceRequest, InferenceResult } from './inferenceTypes';
import { resetEquipmentStore, useEquipmentStore } from './inferenceStorage';

beforeEach(() => {
  localStorage.clear();
  resetEquipmentStore();
  resetShotStore();
  resetAppStore();
  useShotStore.getState().setCatalog(fixtureCatalog());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function renderSetup() {
  const engine = {
    buildShotSpec: vi.fn((recipe: Recipe) =>
      Promise.resolve({ result: fixtureBuild(recipe), runtimeMs: 1 }),
    ),
  } as unknown as Engine;
  render(
    <EngineContext.Provider value={engine}>
      <SetupEquipment />
    </EngineContext.Provider>,
  );
  return engine;
}
function recordShot() {
  fireEvent.change(screen.getByLabelText('Observed time (s)'), { target: { value: '36' } });
  fireEvent.change(screen.getByLabelText('Observed cup weight (g)'), { target: { value: '35' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add observed shot' }));
}
function result(request: InferenceRequest): InferenceResult {
  return {
    coreVersion: fixtureCatalog().coreVersion,
    evaluations: 16,
    skipped: 0,
    notes: ['Synthetic test only.'],
    exploredRanges: [],
    nearMisses: [],
    candidates: [
      {
        id: 'candidate-a',
        recipe: request.recipe,
        values: { 'prep.dose_g': request.recipe.prep.dose_g },
        score: 0,
        matches: true,
        notes: [],
        checks: request.observations.map((o) => ({
          observationId: o.id,
          label: o.label,
          predicted: { timeS: o.timeS, yieldG: o.yieldG, tdsPercent: 10 },
          observed: { timeS: o.timeS, yieldG: o.yieldG },
          residuals: { timeS: 0, yieldG: 0 },
          tolerances: {
            timeS: o.timeToleranceS,
            yieldG: o.yieldToleranceG,
            tdsPercent: o.tdsTolerancePercent,
          },
          matches: true,
          timeIsReplayCondition: true,
        })),
      },
    ],
  };
}
it('records observations first and keeps the displayed machine temperature separate from water', () => {
  renderSetup();
  expect(screen.getByRole('form', { name: 'Equipment settings' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Machine display / set temperature (°C)'), {
    target: { value: '95' },
  });
  recordShot();
  const doc = useEquipmentStore.getState().document;
  expect(doc.facts.displayedTemperatureC).toBe(95);
  expect(doc.observations).toHaveLength(1);
  expect(doc.observations[0].yieldG).toBe(35);
  expect(doc.observations[0].recipe.machine.temperature_c).not.toBe(95);
  expect(screen.queryByRole('button', { name: 'Predict and save before pulling' })).toBeNull();
});
it('keeps a verified alternative and explicitly activates it for Dial in', async () => {
  const solve = vi
    .spyOn(inference, 'inferSetups')
    .mockImplementation((_engine, _catalog, request) => Promise.resolve(result(request)));
  renderSetup();
  recordShot();
  fireEvent.click(screen.getByRole('button', { name: 'Find setups that match my shots' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep possible setup 1' }));
  expect(solve.mock.calls[0][2].observations[0].timeS).toBe(36);
  expect(useEquipmentStore.getState().document.activeId).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Use My equipment · option 1 in Dial in' }));
  await waitFor(() => expect(useAppStore.getState().mode).toBe('dial-in'));
  expect(useEquipmentStore.getState().document.activeId).toBe(
    useEquipmentStore.getState().document.alternatives[0].id,
  );
  expect(document.cookie).toContain('puckworks_setup_v1=done');
});
it('cancels inference and ignores late results when equipment changes', async () => {
  let finish!: (value: InferenceResult) => void;
  const solve = vi.spyOn(inference, 'inferSetups').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderSetup();
  recordShot();
  fireEvent.click(screen.getByRole('button', { name: 'Find setups that match my shots' }));
  act(() => useShotStore.getState().patchForm('prep', { dose_g: '19' }));
  expect(solve.mock.calls[0][3]?.signal?.aborted).toBe(true);
  await act(async () => {
    finish(result(solve.mock.calls[0][2]));
    await Promise.resolve();
  });
  expect(screen.queryByRole('button', { name: 'Keep possible setup 1' })).toBeNull();
});
it('can proceed with specified equipment while preserving the shared recipe', async () => {
  renderSetup();
  act(() => useShotStore.getState().patchForm('prep', { dose_g: '19' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use these settings in Dial in' }));
  await waitFor(() => expect(useAppStore.getState().mode).toBe('dial-in'));
  const check = formToRecipe(useShotStore.getState().form);
  expect(check.ok && check.recipe.prep.dose_g).toBe(19);
  expect(useEquipmentStore.getState().document.alternatives[0].source).toBe('specified');
});
