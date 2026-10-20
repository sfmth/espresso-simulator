// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { resetAppStore, useAppStore } from '../store';
import { fixtureCatalog, fixtureResult, fixtureRun } from '../../test/fixtures/shotFixture';
import { fixtureTaste } from '../../test/fixtures/m3Fixture';
import { EngineContext } from '../engine/EngineContext';
import type { Engine, Timed } from '../engine/engine';
import type { RecipeRunData } from '../engine/shotData';
import type { Recipe } from '../engine/shotTypes';
import { resetShotStore, useShotStore } from '../shot/shotStore';
import { formToRecipe } from '../shot/recipeForm';
import { DialIn } from './DialIn';
import * as inverse from './inverse';
import * as journalState from './useJournal';
import { emptyJournal } from './journal';
import { learnTaste } from './learning';
import type { CalibrationProfile, JournalDocument, JournalEntry } from './types';
import { scopeKey } from './calibration';

beforeEach(() => {
  resetAppStore();
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

it('uses only matching scope/core ratings and displays the posterior actually used for ranking', async () => {
  const catalog = fixtureCatalog();
  const parsed = formToRecipe(useShotStore.getState().form, { catalog });
  if (!parsed.ok) throw new Error('Expected the default recipe to be valid.');
  const recipe = parsed.recipe;
  const setupId = 'My current bag and setup';
  function rated(id: string, rating: number): JournalEntry {
    return {
      id,
      createdAt: '2026-10-18T00:00:00Z',
      setupId,
      label: id,
      source: 'manual',
      recipe: structuredClone(recipe),
      prediction: {
        recordedAt: '2026-10-18T00:00:00Z',
        coreVersion: catalog.coreVersion,
        executedRecipe: structuredClone(recipe),
        summary: fixtureResult().summary,
        taste: fixtureTaste(),
        origin: 'app',
      },
      measurement: { recordedAt: '2026-10-18T00:05:00Z', timeS: 30, yieldG: 36, rating, notes: '' },
    };
  }
  const matching = [rated('matching-a', 2), rated('matching-b', 5)];
  matching[1].recipe.prep.dose_g += 0.5;
  matching[1].recipe.grinder.setting = (recipe.grinder.setting ?? 100) + 1;
  const otherScope = rated('other-bag', 1);
  otherScope.recipe.bean.roast_level = 0.99;
  const oldCore = rated('old-core', 1);
  oldCore.prediction!.coreVersion = 'old-core-version';
  const otherSetup = rated('other-setup', 1);
  otherSetup.setupId = 'Another setup';
  vi.spyOn(journalState, 'useJournal').mockReturnValue({
    document: { ...emptyJournal(), entries: [...matching, otherScope, oldCore, otherSetup] },
    ready: true,
    persistent: false,
    error: null,
    update: () => Promise.resolve(),
  });
  const taste = fixtureTaste();
  const evaluation: inverse.InverseEvaluation = {
    summary: fixtureResult().summary,
    taste,
    score: 0,
    rankingScore: 0,
    residuals: {},
  };
  const candidate: inverse.InverseCandidate = {
    recipe,
    previewRecipe: recipe,
    executedRecipe: recipe,
    preview: evaluation,
    verified: evaluation,
    score: 0,
    rankingScore: 0,
    warnings: [],
    envelope: {
      kind: 'local_control_perturbation_envelope_not_confidence_interval',
      samples: 1,
      timeS: [30, 30],
      yieldG: [36, 36],
      tdsPercent: [10, 10],
      eyPercent: [20, 20],
    },
  };
  const result: inverse.InverseResult = {
    mode: 'recipe',
    candidates: [candidate],
    evaluations: 1,
    skipped: 0,
    notes: [],
    modelError: 'unavailable',
  };
  const search = vi.spyOn(inverse, 'searchRecipes').mockResolvedValueOnce(result);
  setup();
  expect(screen.getByText(/2 compatible rated shots inform/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Find ranked recipes' }));
  await screen.findByRole('heading', { name: 'Candidate 1' });
  expect(search.mock.calls[0][3].ratedShots?.map((entry) => entry.id)).toEqual(
    matching.map((entry) => entry.id),
  );
  const expected = learnTaste(matching, setupId, taste).prediction!;
  expect(
    screen.getByText(new RegExp(`Personal rating estimate: ${expected.mean.toFixed(1)}`)),
  ).toBeTruthy();
  expect(screen.getByText(/2 rated shots, conditional Bayesian range/)).toBeTruthy();
  search.mockResolvedValueOnce({
    ...result,
    mode: 'next',
    candidates: [{ ...candidate, learnedRating: { mean: 4.7, p05: 4.6, p95: 5, sd: 1, count: 5 } }],
  });
  fireEvent.change(screen.getByLabelText('Advice mode'), { target: { value: 'next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find ranked recipes' }));
  await screen.findByText(/Personal rating estimate: 4.7/);
  expect(screen.getByText(/5 rated shots, conditional Bayesian range/)).toBeTruthy();
});

function journalEntry(id: string, observedAt?: string): JournalEntry {
  const parsed = formToRecipe(useShotStore.getState().form, { catalog: fixtureCatalog() });
  if (!parsed.ok) throw new Error('Expected a valid fixture recipe.');
  return {
    id,
    createdAt: observedAt ?? '2026-10-18T00:00:00Z',
    setupId: 'My current bag and setup',
    label: id,
    source: 'manual',
    recipe: parsed.recipe,
    ...(observedAt
      ? {
          measurement: { recordedAt: observedAt, timeS: 30, yieldG: 36, notes: '' },
        }
      : {}),
  };
}

function reactiveJournal(entries: JournalEntry[], save?: () => Promise<void>) {
  function useFixtureJournal() {
    const [document, setDocument] = useState<JournalDocument>(() => ({
      ...emptyJournal(),
      entries,
    }));
    return {
      document,
      ready: true,
      persistent: false,
      error: null,
      update: async (change: (current: JournalDocument) => JournalDocument) => {
        if (save) await save();
        setDocument(change);
      },
    };
  }
  vi.spyOn(journalState, 'useJournal').mockImplementation(useFixtureJournal);
}

it('names journal actions in row context, safely controls imported IDs and restores focus after saving', async () => {
  const a = { ...journalEntry('imported id /#\ud800'), label: 'Same name' };
  const b = { ...journalEntry('imported-id-/#\ud800'), label: 'Same name' };
  reactiveJournal([a, b]);
  setup();
  const open = screen.getByRole('button', { name: 'Record shot 2: Same name' });
  const panelId = open.getAttribute('aria-controls')!;
  expect(document.getElementById(panelId)?.hidden).toBe(true);
  open.focus();
  fireEvent.click(open);
  const time = screen.getByLabelText('Measured time (s)');
  expect(document.activeElement).toBe(time);
  expect(time.id).not.toMatch(/[\s/#]/);
  expect(open.getAttribute('aria-expanded')).toBe('true');
  expect(
    screen.getByRole('button', { name: 'Record shot 1: Same name' }).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(document.getElementById(panelId)?.hidden).toBe(false);
  fireEvent.change(time, { target: { value: '29' } });
  fireEvent.change(screen.getByLabelText('Final beverage (g)'), { target: { value: '36' } });
  const save = screen.getByRole('button', { name: 'Save measurements' });
  save.focus();
  fireEvent.click(save);
  await screen.findByText('Measured shot saved.');
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Use recipe from shot 2: Same name' }),
  );
  expect(document.getElementById(panelId)?.hidden).toBe(true);
  expect(screen.queryByRole('button', { name: 'Record shot 2: Same name' })).toBeNull();
});

it('returns focus to a surviving journal action after deletion and its heading after the last deletion', async () => {
  reactiveJournal([journalEntry('First'), journalEntry('Second')]);
  setup();
  const remove = screen.getByRole('button', { name: 'Delete shot 1: Second' });
  remove.focus();
  fireEvent.click(remove);
  await screen.findByText('Deleted shot: Second.');
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Use recipe from shot 1: First' }),
  );
  const last = screen.getByRole('button', { name: 'Delete shot 1: First' });
  last.focus();
  fireEvent.click(last);
  await screen.findByText('Deleted shot: First.');
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: '3. Shot journal' }));
  expect(screen.queryByRole('table', { name: 'Shot journal' })).toBeNull();
});

it('does not move focus away from another control when a deletion finishes later', async () => {
  let release!: () => void;
  reactiveJournal(
    [journalEntry('Delete later')],
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  setup();
  const remove = screen.getByRole('button', { name: 'Delete shot 1: Delete later' });
  remove.focus();
  fireEvent.click(remove);
  const setupName = screen.getByLabelText('Bag and setup name');
  setupName.focus();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await screen.findByText('Deleted shot: Delete later.');
  expect(document.activeElement).toBe(setupName);
});

it('retains the expanded measurement form, entered values and user focus when saving fails', async () => {
  let reject!: (error: Error) => void;
  reactiveJournal(
    [journalEntry('Keep me')],
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Record shot 1: Keep me' }));
  fireEvent.change(screen.getByLabelText('Measured time (s)'), { target: { value: '29' } });
  fireEvent.change(screen.getByLabelText('Final beverage (g)'), { target: { value: '36' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save measurements' }));
  const notes = screen.getByLabelText('Shot notes');
  notes.focus();
  await act(async () => {
    reject(new Error('Storage blocked'));
    await Promise.resolve();
  });
  expect(screen.getByRole('alert').textContent).toContain('Storage blocked');
  expect(screen.getByLabelText<HTMLInputElement>('Measured time (s)').value).toBe('29');
  expect(screen.getByLabelText<HTMLInputElement>('Final beverage (g)').value).toBe('36');
  expect(
    screen.getByRole('button', { name: 'Record shot 1: Keep me' }).getAttribute('aria-expanded'),
  ).toBe('true');
  expect(document.activeElement).toBe(notes);
});

it('focuses the visible Lab destination when opening the full recipe', () => {
  useAppStore.getState().setMode('dial-in');
  function Navigation() {
    const mode = useAppStore((state) => state.mode);
    return (
      <>
        <button id="tab-lab" role="tab" aria-selected={mode === 'lab'}>
          Lab
        </button>
        <div hidden={mode !== 'dial-in'}>
          <DialIn />
        </div>
      </>
    );
  }
  render(
    <EngineContext.Provider value={{} as Engine}>
      <Navigation />
    </EngineContext.Provider>,
  );
  const edit = screen.getByRole('button', { name: 'Edit full recipe in Lab' });
  edit.focus();
  fireEvent.click(edit);
  expect(useAppStore.getState().mode).toBe('lab');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Lab', selected: true }));
  expect(screen.queryByRole('button', { name: 'Edit full recipe in Lab' })).toBeNull();
});

it('keeps the newest observed shot as the next-shot reference after an older backup is appended', async () => {
  const newest = journalEntry('newest-measured', '2026-10-18T09:00:00Z');
  const olderImported = journalEntry('older-imported', '2026-10-17T09:00:00Z');
  olderImported.source = 'json';
  // Backup records are appended by mergeJournal; array position is not chronology.
  vi.spyOn(journalState, 'useJournal').mockReturnValue({
    document: { ...emptyJournal(), entries: [newest, olderImported] },
    ready: true,
    persistent: false,
    error: null,
    update: () => Promise.resolve(),
  });
  const search = vi.spyOn(inverse, 'searchRecipes').mockResolvedValue({
    mode: 'next',
    candidates: [],
    evaluations: 1,
    skipped: 0,
    notes: [],
    modelError: 'unavailable',
  });
  setup();
  fireEvent.change(screen.getByLabelText('Advice mode'), { target: { value: 'next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find ranked recipes' }));
  await waitFor(() => expect(search).toHaveBeenCalledOnce());
  expect(search.mock.calls[0][3].lastShot?.id).toBe('newest-measured');
});

it('threads cancellation through a pending prediction save and does not publish late success', async () => {
  let release!: () => void;
  const update = vi.fn(
    (_change: (doc: JournalDocument) => JournalDocument, _signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  vi.spyOn(journalState, 'useJournal').mockReturnValue({
    document: emptyJournal(),
    ready: true,
    persistent: false,
    error: null,
    update,
  });
  const { calls } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Predict and save before pulling' }));
  await act(async () => {
    calls[0].resolve();
    await Promise.resolve();
  });
  expect(update).toHaveBeenCalledOnce();
  const signal = update.mock.calls[0][1];
  expect(signal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel dial-in task' }));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.getByText('Cancelled.')).toBeTruthy();
  expect(
    screen.queryByText('Prediction saved. Pull the shot, then record what happened.'),
  ).toBeNull();
});

it('keeps a newly selected measurement form open when an earlier record finishes saving', async () => {
  let release!: () => void;
  vi.spyOn(journalState, 'useJournal').mockReturnValue({
    document: {
      ...emptyJournal(),
      entries: [journalEntry('Pending A'), journalEntry('Pending B')],
    },
    ready: true,
    persistent: false,
    error: null,
    update: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  setup();
  const table = within(screen.getByRole('table', { name: 'Shot journal' }));
  const rowA = table.getByText('Pending A').closest('tr')!;
  const rowB = table.getByText('Pending B').closest('tr')!;
  fireEvent.click(within(rowA).getByRole('button', { name: /^Record shot/ }));
  fireEvent.change(screen.getByLabelText('Measured time (s)'), { target: { value: '29' } });
  fireEvent.change(screen.getByLabelText('Final beverage (g)'), { target: { value: '36' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save measurements' }));
  fireEvent.click(within(rowB).getByRole('button', { name: /^Record shot/ }));
  fireEvent.change(screen.getByLabelText('Measured time (s)'), { target: { value: '42' } });
  fireEvent.change(screen.getByLabelText('Final beverage (g)'), { target: { value: '40' } });
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.getByRole('form', { name: 'Measurements for Pending B' })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>('Measured time (s)').value).toBe('42');
  expect(screen.getByLabelText<HTMLInputElement>('Final beverage (g)').value).toBe('40');
  expect(document.activeElement).toBe(screen.getByLabelText('Measured time (s)'));
});

it('keeps the newest compatible calibration active when an older imported fit is appended', () => {
  const recipe = journalEntry('profile-recipe').recipe;
  const catalog = fixtureCatalog();
  const reference = catalog.registry.parameters.find(
    (p) => p.id === 'hydraulics.permeability.reference',
  )!.default;
  function profile(id: string, createdAt: string, multiplier: number): CalibrationProfile {
    return {
      id,
      createdAt,
      coreVersion: catalog.coreVersion,
      setupId: 'My current bag and setup',
      scopeKey: scopeKey(recipe),
      trainingIds: ['a', 'b', 'c'],
      permeability: multiplier,
      grinderScale: 1,
      referencePermeability: reference,
      timeSigmaS: 3,
      tdsSigmaPercent: 0.3,
      parameters: [
        {
          id: 'permeability',
          label: `${id} parameter`,
          map: multiplier,
          p05: multiplier,
          p95: multiplier,
          status: 'Fixture',
        },
      ],
      posterior: [{ permeability: multiplier, grinderScale: 1, weight: 1 }],
      checks: [],
      notes: [],
    };
  }
  vi.spyOn(journalState, 'useJournal').mockReturnValue({
    document: {
      ...emptyJournal(),
      calibrations: [
        profile('Newer fit', '2026-10-18T08:00:00Z', 1.4),
        profile('Older fit', '2026-10-17T08:00:00Z', 0.7),
      ],
    },
    ready: true,
    persistent: false,
    error: null,
    update: () => Promise.resolve(),
  });
  const { calls } = setup();
  expect(screen.getByText('Newer fit parameter')).toBeTruthy();
  expect(screen.queryByText('Older fit parameter')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Predict and save before pulling' }));
  expect(calls[0].recipe.overrides?.['hydraulics.permeability.reference']).toBe(reference * 1.4);
});
