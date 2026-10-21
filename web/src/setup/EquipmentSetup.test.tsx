// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import { ModeTabs } from '../components/ModeTabs';
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
import { resetAppStore, useAppStore } from '../store';
import { EquipmentSetupGate } from './EquipmentSetup';
import {
  emptySetupDocument,
  INFERENCE_STORAGE_KEY,
  resetEquipmentStore,
  useEquipmentStore,
  type SavedSetup,
} from './inferenceStorage';
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

function Workspace() {
  const mode = useAppStore((state) => state.mode);
  return (
    <>
      <ModeTabs mode={mode} onChange={useAppStore.getState().setMode} />
      <EquipmentSetupGate>
        <main>
          <button>Run the simulator</button>
        </main>
      </EquipmentSetupGate>
    </>
  );
}

function mount() {
  return render(
    <EngineContext.Provider value={engine}>
      <Workspace />
    </EngineContext.Provider>,
  );
}

function retainPreviousEquipment() {
  const recipe = structuredClone(DEFAULT_RECIPE);
  recipe.prep.dose_g = 19;
  const previous: SavedSetup = {
    id: 'previous-equipment',
    name: 'Previous equipment',
    createdAt: '2026-10-21T08:00:00Z',
    coreVersion: 'test',
    source: 'specified',
    recipe,
    facts: { heater: 'boiler', displayedTemperatureC: 95 },
    request: { recipe, constraints: [], observations: [] },
  };
  const document = { ...emptySetupDocument(), alternatives: [previous], activeId: previous.id };
  localStorage.setItem(INFERENCE_STORAGE_KEY, JSON.stringify(document));
  return document;
}

beforeEach(() => {
  localStorage.clear();
  resetAppStore();
  resetShotStore();
  resetEquipmentStore();
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
    Promise.resolve({ result: fixtureBuild(recipe), runtimeMs: 1 }),
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
  resetAppStore();
  resetShotStore();
  resetEquipmentStore();
  vi.restoreAllMocks();
});

describe('first-visit equipment choice', () => {
  it('offers setup or an explicit defaults choice and focuses its heading', () => {
    mount();
    expect(screen.getByRole('dialog', { name: 'Welcome to Puckworks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up equipment' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip setup with defaults' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Welcome to Puckworks' }),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('opens setup without replacing or persisting an existing partially edited recipe', () => {
    const form = defaultForm();
    form.prep.dose_g = 'invalid unfinished dose';
    form.water.alkalinity_mg_l_caco3 = '25';
    resetShotStore(form);
    useShotStore.getState().setCatalog(fixtureCatalog());
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Set up equipment' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useAppStore.getState().mode).toBe('setup');
    expect(useShotStore.getState().form).toEqual(form);
    expect(complete).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Set up equipment' }));
  });

  it('Escape opens setup and never silently accepts defaults', () => {
    mount();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useAppStore.getState().mode).toBe('setup');
    expect(complete).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('native-checks defaults before replacing a custom draft, saving completion, and entering Dial in', async () => {
    const form = defaultForm();
    form.prep.dose_g = '19';
    form.water.alkalinity_mg_l_caco3 = '25';
    resetShotStore(form);
    useShotStore.getState().setCatalog(fixtureCatalog());
    const original = recipeOf(form);
    saveDraft(localStorage, original);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    expect(recipeOf(useShotStore.getState().form)).toEqual(original);
    expect(complete).not.toHaveBeenCalled();
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(build.mock.calls[0][0]).toEqual(DEFAULT_RECIPE);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0].recipe).toEqual(DEFAULT_RECIPE);
    expect(recipeOf(useShotStore.getState().form)).toEqual(DEFAULT_RECIPE);
    expect(useShotStore.getState().undo?.form).toEqual(form);
    expect(useAppStore.getState().mode).toBe('dial-in');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Dial in' }));
  });

  it('leaves the recipe and saved completion untouched if the native check fails', async () => {
    build.mockRejectedValueOnce(new Error('Native builder unavailable'));
    mount();
    const original = useShotStore.getState().form;
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toBe('Native builder unavailable');
    expect(document.activeElement).toBe(error);
    expect(complete).not.toHaveBeenCalled();
    expect(useShotStore.getState().form).toBe(original);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('hydrates and deactivates retained equipment when defaults are chosen without a completion marker', async () => {
    const previous = retainPreviousEquipment();
    mount();
    expect(useEquipmentStore.getState().hydrated).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(useEquipmentStore.getState().document).toEqual({ ...previous, activeId: null });
    expect(JSON.parse(localStorage.getItem(INFERENCE_STORAGE_KEY)!)).toEqual({
      ...previous,
      activeId: null,
    });
    expect(recipeOf(useShotStore.getState().form)).toEqual(DEFAULT_RECIPE);
  });

  it('preserves retained equipment selection when validating defaults fails', async () => {
    const previous = retainPreviousEquipment();
    build.mockRejectedValueOnce(new Error('Native builder unavailable'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    await screen.findByRole('alert');
    expect(useEquipmentStore.getState().hydrated).toBe(false);
    expect(JSON.parse(localStorage.getItem(INFERENCE_STORAGE_KEY)!)).toEqual(previous);
  });

  it.each(['quota', 'conflict'] as const)(
    'uses defaults for this session and preserves alternatives when deactivation encounters %s',
    async (failure) => {
      const previous = retainPreviousEquipment();
      useEquipmentStore.getState().hydrate();
      const saved = { ...previous, name: 'Equipment saved by another tab' };
      if (failure === 'conflict') {
        localStorage.setItem(INFERENCE_STORAGE_KEY, JSON.stringify(saved));
      } else {
        const original = localStorage.setItem.bind(localStorage);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
          if (key === INFERENCE_STORAGE_KEY) throw new Error('Quota exceeded');
          original(key, value);
        });
      }
      mount();
      fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
      await screen.findByRole('button', { name: 'Run the simulator' });
      expect(useEquipmentStore.getState().document).toEqual({ ...previous, activeId: null });
      expect(useEquipmentStore.getState().persistent).toBe(false);
      expect(useEquipmentStore.getState().notice).toMatch(/session/i);
      expect(JSON.parse(localStorage.getItem(INFERENCE_STORAGE_KEY)!)).toEqual(
        failure === 'conflict' ? saved : previous,
      );
      expect(recipeOf(useShotStore.getState().form)).toEqual(DEFAULT_RECIPE);
      expect(useAppStore.getState().mode).toBe('dial-in');
    },
  );

  it('aborts a pending defaults check when setup is chosen and ignores late completion', async () => {
    let resolve!: (value: Timed<BuiltSpec>) => void;
    build.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount();
    const original = useShotStore.getState().form;
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    await waitFor(() => expect(build).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Checking defaults…' }));
    expect(build).toHaveBeenCalledOnce();
    const signal = build.mock.calls[0][1]?.signal;
    fireEvent.click(screen.getByRole('button', { name: 'Set up equipment' }));
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve({ result: fixtureBuild(DEFAULT_RECIPE), runtimeMs: 1 });
      await Promise.resolve();
    });
    expect(complete).not.toHaveBeenCalled();
    expect(useShotStore.getState().form).toBe(original);
    expect(useAppStore.getState().mode).toBe('setup');
  });

  it('permits setup while the catalogue loads and offers retry when defaults cannot load', () => {
    useShotStore.setState({ catalog: null, catalogError: 'Cannot load catalogue' });
    mount();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Skip setup with defaults' }).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading equipment' }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Set up equipment' }));
    expect(screen.getByRole('button', { name: 'Run the simulator' })).toBeTruthy();
    expect(useAppStore.getState().mode).toBe('setup');
  });

  it('permits session defaults with an honest blocked-storage notice', async () => {
    persistence = {
      persisted: false,
      notice: 'Equipment is ready for this session. These changes could not be saved completely.',
    };
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(screen.getByRole('status').textContent).toContain('could not be saved completely');
    expect(useAppStore.getState().mode).toBe('dial-in');
  });

  it('permits session defaults if persistence throws', async () => {
    complete.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup with defaults' }));
    await screen.findByRole('button', { name: 'Run the simulator' });
    expect(screen.getByRole('status').textContent).toContain('Browser storage is unavailable');
    expect(recipeOf(useShotStore.getState().form)).toEqual(DEFAULT_RECIPE);
  });
});

describe('returning equipment setup', () => {
  it('restores a complete saved recipe exactly once and opens Dial in without a popup', () => {
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
    expect(useAppStore.getState().mode).toBe('dial-in');
    expect(screen.getByRole('button', { name: 'Run the simulator' })).toBeTruthy();
    expect(showModal).not.toHaveBeenCalled();
    act(() => useShotStore.getState().patchForm('prep', { dose_g: '18.5' }));
    expect(recipeOf(useShotStore.getState().form).prep.dose_g).toBe(18.5);
  });

  it('waits quietly for the catalogue before restoring a returning setup', () => {
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

  it('preserves a newer draft and routes Equipment setup to the new tab without resetting it', () => {
    restored = { schema: 'puckworks.equipment-setup/1', recipe: DEFAULT_RECIPE };
    const recipe: Recipe = {
      ...DEFAULT_RECIPE,
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
    resetShotStore(formOf(recipe));
    useShotStore.getState().setCatalog(fixtureCatalog());
    saveDraft(localStorage, recipe);
    mount();
    expect(recipeOf(useShotStore.getState().form)).toEqual(recipe);
    fireEvent.click(screen.getByRole('button', { name: 'Equipment setup' }));
    expect(useAppStore.getState().mode).toBe('setup');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(recipeOf(useShotStore.getState().form)).toEqual(recipe);
    expect(loadDraft(localStorage)).toEqual(recipe);
    expect(complete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Set up equipment' }));
  });

  it('does not accept a stale setup containing unavailable equipment', () => {
    restored = {
      schema: 'puckworks.equipment-setup/1',
      recipe: { ...DEFAULT_RECIPE, machine: { preset: 'missing-machine' } },
    };
    mount();
    expect(screen.getByRole('dialog', { name: 'Welcome to Puckworks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run the simulator' })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});
