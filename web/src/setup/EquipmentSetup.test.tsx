// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import { EngineContext } from '../engine/EngineContext';
import type { Engine, Timed } from '../engine/engine';
import type { BuiltSpec, Recipe } from '../engine/shotTypes';
import { useOptionalSharedShotRun, type SharedShotRunControls } from '../shot/ShotRunContext';
import {
  DEFAULT_RECIPE,
  defaultForm,
  formToRecipe,
  recipeToForm,
  type RecipeForm,
} from '../shot/recipeForm';
import { resetShotStore, useShotStore } from '../shot/shotStore';
import { loadDraft, saveDraft } from '../shot/storage';
import { EquipmentSetupGate } from './EquipmentSetup';
import { createSetupStorage, type EquipmentSetupRecord, type SetupStorage } from './setupStorage';

vi.mock('./setupStorage', () => ({ createSetupStorage: vi.fn() }));
vi.mock('../shot/ShotRunContext', () => ({ useOptionalSharedShotRun: vi.fn() }));

let restored: EquipmentSetupRecord | null;
let persistence: { persisted: boolean; notice: string | null };
let storage: SetupStorage;
let complete: ReturnType<typeof vi.fn<SetupStorage['complete']>>;
let showModal: ReturnType<typeof vi.fn>;
let build: ReturnType<typeof vi.fn<Engine['buildShotSpec']>>;
let engine: Engine;
let retry: ReturnType<typeof vi.fn>;

function recipeOf(form: RecipeForm): Recipe {
  const result = formToRecipe(form, { catalog: fixtureCatalog() });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}

function formOf(recipe: Recipe): RecipeForm {
  const result = recipeToForm(recipe);
  if (!result.ok) throw new Error(result.error);
  return result.form;
}

function mount() {
  return render(
    <EngineContext.Provider value={engine}>
      <EquipmentSetupGate>
        <main>
          <button>Run the simulator</button>
        </main>
      </EquipmentSetupGate>
    </EngineContext.Provider>,
  );
}

function chooseEquipment() {
  for (const [label, value] of [
    ['Your machine', 'flat-9-bar'],
    ['Your grinder', 'generic-flat-traditional-64'],
    ['Your basket', '58-precision-18g'],
    ['Your beans', 'medium-washed-arabica'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function nextToReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Next: starting shot' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
}

beforeEach(() => {
  localStorage.clear();
  resetShotStore();
  useShotStore.getState().setCatalog(fixtureCatalog());
  restored = null;
  persistence = { persisted: true, notice: null };
  complete = vi.fn((record) => {
    restored = structuredClone(record);
    return persistence;
  });
  storage = {
    load: vi.fn(() => restored),
    complete,
    clear: vi.fn(() => ({ cleared: true, notice: null })),
    cookiePath: '/',
    recordKey: 'setup-test',
  };
  vi.mocked(createSetupStorage).mockReturnValue(storage);
  retry = vi.fn();
  vi.mocked(useOptionalSharedShotRun).mockReturnValue({
    retryCatalog: retry,
  } as unknown as SharedShotRunControls);
  build = vi.fn<Engine['buildShotSpec']>((recipe) =>
    Promise.resolve({
      result: fixtureBuild(recipe),
      runtimeMs: 1,
    }),
  );
  engine = { buildShotSpec: build } as unknown as Engine;
  showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: showModal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    }),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetShotStore();
  vi.restoreAllMocks();
});

describe('required equipment setup', () => {
  it('blocks the workspace until four explicit choices and confirmation, with no initial Escape bypass', async () => {
    mount();
    const dialog = screen.getByRole<HTMLDialogElement>('dialog', { name: 'Set up your equipment' });
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel equipment changes' })).toBeNull();
    for (const name of ['Your machine', 'Your grinder', 'Your basket', 'Your beans'])
      expect(screen.getByLabelText<HTMLSelectElement>(name).value).toBe('');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Step 1 of 3/ }));
    expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(false);
    expect(dialog.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next: starting shot' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Choose a machine, grinder, basket and beans',
    );
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(complete).not.toHaveBeenCalled();
    chooseEquipment();
    fireEvent.click(screen.getByRole('button', { name: 'Next: starting shot' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Step 2 of 3/ }));
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '17' } });
    fireEvent.change(screen.getByLabelText('Target beverage (g)'), { target: { value: '34' } });
    fireEvent.change(screen.getByLabelText('Brew temperature (°C)'), { target: { value: '92' } });
    fireEvent.change(screen.getByLabelText('Grinder setting'), { target: { value: '210' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Step 3 of 3/ }));
    expect(build).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(build).toHaveBeenCalledOnce();
    const expected = {
      ...DEFAULT_RECIPE,
      grinder: { ...DEFAULT_RECIPE.grinder, setting: 210 },
      prep: { ...DEFAULT_RECIPE.prep, dose_g: 17 },
      machine: { ...DEFAULT_RECIPE.machine, temperature_c: 92 },
      stop: { beverage_g: 34 },
    };
    expect(recipeOf(useShotStore.getState().form)).toEqual(expected);
    expect(build.mock.calls[0][0]).toEqual(expected);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe: expected,
        schema: 'puckworks.equipment-setup/1',
        completedAt: expect.any(String),
      }),
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Equipment setup' }));
    expect(recipeOf(useShotStore.getState().form).machine.vent_headspace).toBe(true);
  });

  it('uses actual selected presets and clears machine/grinder-specific values through existing helpers', async () => {
    mount();
    chooseEquipment();
    fireEvent.change(screen.getByLabelText('Your machine'), {
      target: { value: 'vibratory-pump' },
    });
    fireEvent.change(screen.getByLabelText('Your grinder'), {
      target: { value: 'mahlkoenig-ek43' },
    });
    nextToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    const recipe = recipeOf(useShotStore.getState().form);
    expect(recipe.machine).toEqual({ preset: 'vibratory-pump' });
    const preset = fixtureCatalog().presets.grinders.find((p) => p.id === 'mahlkoenig-ek43');
    expect(recipe.grinder).toEqual({ preset: 'mahlkoenig-ek43', setting: preset?.dial.default });
  });

  it('rejects bad shot inputs and native basket-fit failures without saving or publishing the partial setup', async () => {
    const original = recipeOf(useShotStore.getState().form);
    mount();
    chooseEquipment();
    fireEvent.click(screen.getByRole('button', { name: 'Next: starting shot' }));
    fireEvent.change(screen.getByLabelText('Target beverage (g)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    expect(screen.getByRole('alert').textContent).toContain('Enter a target beverage');
    fireEvent.change(screen.getByLabelText('Target beverage (g)'), { target: { value: '36' } });
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    expect(screen.getByRole('alert').textContent).toMatch(/dose|Dose/);
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    build.mockRejectedValueOnce(new Error('Dose does not fit the selected basket.'));
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByText('Dose does not fit the selected basket.');
    expect(complete).not.toHaveBeenCalled();
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
  });

  it('retries catalogue failures inside the required dialog and focuses the loaded step', () => {
    useShotStore.setState({ catalog: null, catalogError: 'The engine did not load.' });
    mount();
    expect(screen.getByRole('alert').textContent).toBe('The engine did not load.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading equipment' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
    act(() => useShotStore.getState().setCatalog(fixtureCatalog()));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Step 1 of 3/ }));
  });

  it('continues honestly for this session when persistence is blocked', async () => {
    persistence = {
      persisted: false,
      notice: 'Setup is ready for this session; browser storage is blocked.',
    };
    mount();
    chooseEquipment();
    nextToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(screen.getByRole('status').textContent).toContain('this session');
  });

  it('shows persistence notices even when local data can restore setup without a cookie', async () => {
    persistence = {
      persisted: true,
      notice: 'Cookies are blocked; your saved local setup will be used on return.',
    };
    mount();
    chooseEquipment();
    nextToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(screen.getByRole('status').textContent).toContain('saved local setup');
  });

  it('requires review when a stored completion names equipment removed from the current catalogue', () => {
    restored = {
      schema: 'puckworks.equipment-setup/1',
      recipe: {
        ...DEFAULT_RECIPE,
        grinder: { preset: 'removed-grinder', setting: 2 },
      },
    };
    mount();
    expect(screen.getByRole('dialog', { name: 'Set up your equipment' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
  });

  it('recovers from a native-invalid advanced draft only after an explicit local reset and four fresh choices', async () => {
    const original: Recipe = {
      ...DEFAULT_RECIPE,
      overrides: {
        'extraction.saturation.lumped': 1000,
        'model.extraction.solute_apparent_density': 800,
      },
    };
    const form = formOf(original);
    expect(formToRecipe(form, { catalog: fixtureCatalog() }).ok).toBe(true);
    resetShotStore(form);
    useShotStore.getState().setCatalog(fixtureCatalog());
    saveDraft(localStorage, original);
    mount();
    nextToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain(
      'solubles.solute_specific_volume_m3_kg',
    );
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start with a clean recipe' }));
    expect(screen.getByText(/Your original recipe is kept until you confirm/)).toBeTruthy();
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    expect(loadDraft(localStorage)).toEqual(original);
    for (const name of ['Your machine', 'Your grinder', 'Your basket', 'Your beans'])
      expect(screen.getByLabelText<HTMLSelectElement>(name).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Cancel equipment changes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next: starting shot' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Choose a machine, grinder, basket and beans',
    );
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
    chooseEquipment();
    nextToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(recipeOf(useShotStore.getState().form)).toEqual(DEFAULT_RECIPE);
    expect(build).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
  });
});

describe('reviewing an existing setup', () => {
  it('restores a valid setup record without a Lab draft exactly once before mounting the workspace', () => {
    const recipe: Recipe = {
      ...DEFAULT_RECIPE,
      grinder: { preset: 'mahlkoenig-ek43', setting: 2.1 },
      prep: { dose_g: 19, distribution: 'wdt' },
      water: { alkalinity_mg_l_caco3: 25 },
      machine: { preset: 'e61-rotary', vent_headspace: false },
    };
    restored = { schema: 'puckworks.equipment-setup/1', recipe };
    mount();
    expect(recipeOf(useShotStore.getState().form)).toEqual(recipe);
    expect(useShotStore.getState().undo).toBeNull();
    expect(screen.getByRole('button', { name: 'Run the simulator' })).toBeTruthy();
    expect(showModal).not.toHaveBeenCalled();
    act(() => useShotStore.getState().patchForm('prep', { dose_g: '18.5' }));
    expect(recipeOf(useShotStore.getState().form).prep.dose_g).toBe(18.5);
  });

  it('keeps a returning visit quiet while the catalogue loads, then restores without showing a dialog', () => {
    restored = { schema: 'puckworks.equipment-setup/1', recipe: DEFAULT_RECIPE };
    useShotStore.setState({ catalog: null });
    render(<button>Outside toolbar</button>);
    const outside = screen.getByRole('button', { name: 'Outside toolbar' });
    outside.focus();
    mount();
    expect(screen.getByRole('status').textContent).toContain('Loading your saved equipment');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
    expect(showModal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    act(() => useShotStore.getState().setCatalog(fixtureCatalog()));
    expect(screen.getByRole('button', { name: 'Run the simulator' })).toBeTruthy();
    expect(showModal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it('skips setup for a valid record without replacing the current full recipe and can cancel edits', () => {
    restored = { schema: 'puckworks.equipment-setup/1', recipe: DEFAULT_RECIPE };
    const draft = defaultForm();
    draft.prep.dose_g = '19';
    draft.water.alkalinity_mg_l_caco3 = '25';
    draft.overrides = { 'hydraulics.permeability.reference': '3e-13' };
    resetShotStore(draft);
    useShotStore.getState().setCatalog(fixtureCatalog());
    const original = recipeOf(draft);
    saveDraft(localStorage, original);
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Equipment setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: starting shot' }));
    fireEvent.change(screen.getByLabelText('Dose (g)'), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel equipment changes' }));
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    expect(complete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Equipment setup' }));
  });

  it('can cancel an explicit clean restart without altering the original shared or saved draft', () => {
    const original: Recipe = {
      ...DEFAULT_RECIPE,
      water: { alkalinity_mg_l_caco3: 25 },
      overrides: { 'hydraulics.permeability.reference': 3e-13 },
    };
    restored = { schema: 'puckworks.equipment-setup/1', recipe: original };
    resetShotStore(formOf(original));
    useShotStore.getState().setCatalog(fixtureCatalog());
    saveDraft(localStorage, original);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Equipment setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start with a clean recipe' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Your machine').value).toBe('');
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel equipment changes' }));
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    expect(loadDraft(localStorage)).toEqual(original);
    expect(complete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Equipment setup' }));
  });

  it('preserves measured PSD, custom hardware, explicit no-vent, water, overrides and a time stop on review', async () => {
    const recipe: Recipe = {
      ...DEFAULT_RECIPE,
      bean: { roast_level: 0.7, arabica_fraction: 0.8, days_off_roast: 15 },
      grinder: {
        psd: { diameter_um: [40, 300], volume_fraction: [0.2, 0.8], method: 'dry_laser' },
      },
      basket: {
        custom: {
          profile_mm: [
            [0, 58],
            [26, 58],
          ],
          perforated_diameter_mm: 54,
        },
      },
      machine: {
        profile: [{ control: 'pressure', target: 8, ramp_s: 3 }],
        pump: { type: 'ideal', max_flow_ml_s: 7 },
        temperature_c: 92,
        vent_headspace: false,
      },
      water: { alkalinity_mg_l_caco3: 25 },
      stop: { time_s: 30 },
      overrides: { 'hydraulics.permeability.reference': 3e-13 },
    };
    const form = formOf(recipe);
    resetShotStore(form);
    useShotStore.getState().setCatalog(fixtureCatalog());
    saveDraft(localStorage, recipe);
    mount();
    expect(screen.getByLabelText<HTMLSelectElement>('Your grinder').value).toBe('__keep_current');
    nextToReview();
    expect(screen.getByText('Current time stop: 30 s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start simulating' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(build.mock.calls[0][0]).toEqual(recipe);
    expect(recipeOf(useShotStore.getState().form)).toEqual(recipe);
  });

  it('aborts an optional in-flight check and ignores its late completion after cancel', async () => {
    restored = { schema: 'puckworks.equipment-setup/1', recipe: DEFAULT_RECIPE };
    let resolve!: (value: Timed<BuiltSpec>) => void;
    build.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount();
    const original = recipeOf(useShotStore.getState().form);
    fireEvent.click(screen.getByRole('button', { name: 'Equipment setup' }));
    nextToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Save equipment changes' }));
    await waitFor(() => expect(build).toHaveBeenCalledOnce());
    const signal = build.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel equipment changes' }));
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve({ result: fixtureBuild(original), runtimeMs: 1 });
      await Promise.resolve();
    });
    expect(complete).not.toHaveBeenCalled();
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
