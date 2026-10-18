// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixtureCatalog, fixtureRun } from '../../test/fixtures/shotFixture';
import { EngineContext } from '../engine/EngineContext';
import type { Engine, Timed } from '../engine/engine';
import type { RecipeRunData } from '../engine/shotData';
import type { Recipe } from '../engine/shotTypes';
import { resetShotStore, useShotStore } from '../shot/shotStore';
import { DialIn } from './DialIn';
import * as inverse from './inverse';

beforeEach(() => {
  resetShotStore();
  useShotStore.getState().setCatalog(fixtureCatalog());
});
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
function setup() {
  const calls: { recipe: Recipe; signal?: AbortSignal; resolve: () => void }[] = [];
  const engine = {
    simulateRecipe: vi.fn(
      (recipe: Recipe, options?: { signal?: AbortSignal }) =>
        new Promise<Timed<RecipeRunData>>((resolve) => {
          calls.push({
            recipe,
            signal: options?.signal,
            resolve: () => resolve({ result: fixtureRun(recipe), runtimeMs: 1 }),
          });
        }),
    ),
  } as unknown as Engine;
  render(
    <EngineContext.Provider value={engine}>
      <DialIn />
    </EngineContext.Provider>,
  );
  return { engine, calls };
}
it('saves a prediction before enabling a measured record and preserves trimmed setup names', async () => {
  const { calls } = setup();
  await screen.findByText(/This journal lasts only for this session/);
  fireEvent.change(screen.getByLabelText('Bag and setup name'), {
    target: { value: '  Test bag  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Predict and save before pulling' }));
  expect(screen.queryByRole('button', { name: 'Save measurements' })).toBeNull();
  await act(async () => {
    calls[0].resolve();
    await Promise.resolve();
  });
  await screen.findByRole('button', { name: 'Save measurements' });
  expect(screen.getByRole('table', { name: 'Shot journal' })).toBeTruthy();
  expect(calls[0].recipe.numerics?.tier).toBe(1);
  fireEvent.change(screen.getByLabelText('Measured time (s)'), { target: { value: '29' } });
  fireEvent.change(screen.getByLabelText('Final beverage (g)'), { target: { value: '36' } });
  fireEvent.change(screen.getByLabelText('TDS (%) · optional'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save measurements' }));
  await screen.findByText('Measured shot saved.');
  expect(
    within(screen.getByRole('table', { name: 'Shot journal' })).getByText(/29.0 s/),
  ).toBeTruthy();
  expect(screen.getByText(/V9 remains open/)).toBeTruthy();
});
it('aborts prediction on recipe changes and ignores a worker that answers late', async () => {
  const { calls } = setup();
  await screen.findByText(/This journal lasts only for this session/);
  fireEvent.click(screen.getByRole('button', { name: 'Predict and save before pulling' }));
  fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '19' } });
  await waitFor(() => expect(calls[0].signal?.aborted).toBe(true));
  fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '18' } });
  expect(
    screen.getByRole('button', { name: 'Predict and save before pulling' }),
  ).not.toHaveProperty('disabled', true);
  await act(async () => {
    calls[0].resolve();
    await Promise.resolve();
  });
  expect(screen.queryByRole('table', { name: 'Shot journal' })).toBeNull();
});
it('rejects invalid measurement input without attaching it to the snapshot', async () => {
  const { calls } = setup();
  await screen.findByText(/This journal lasts only for this session/);
  fireEvent.click(screen.getByRole('button', { name: 'Predict and save before pulling' }));
  await act(async () => {
    calls[0].resolve();
    await Promise.resolve();
  });
  await screen.findByRole('button', { name: 'Save measurements' });
  fireEvent.change(screen.getByLabelText('Measured time (s)'), { target: { value: '-1' } });
  fireEvent.change(screen.getByLabelText('Final beverage (g)'), { target: { value: '36' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Measurements for Next shot' }));
  await screen.findByText(/Shot time must be between/);
  expect(
    within(screen.getByRole('table', { name: 'Shot journal' })).getByText(
      'Waiting for measurements',
    ),
  ).toBeTruthy();
});

it('ignores advice that returns after the requested target changes', async () => {
  let resolve!: (result: inverse.InverseResult) => void;
  const search = vi.spyOn(inverse, 'searchRecipes').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  setup();
  await screen.findByText(/This journal lasts only for this session/);
  fireEvent.click(screen.getByRole('button', { name: 'Find ranked recipes' }));
  expect(search).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('Target time (s)'), { target: { value: '31' } });
  await act(async () => {
    resolve({
      mode: 'recipe',
      candidates: [],
      evaluations: 1,
      skipped: 0,
      notes: ['Late result'],
      modelError: 'unavailable',
    });
    await Promise.resolve();
  });
  expect(screen.queryByText('Late result')).toBeNull();
  expect(screen.getByRole('button', { name: 'Find ranked recipes' })).not.toHaveProperty(
    'disabled',
    true,
  );
});
