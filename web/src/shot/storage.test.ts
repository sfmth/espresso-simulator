// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECIPE } from './recipeForm';
import { startingForm } from './shotStore';
import {
  browserStorage,
  deleteRecipe,
  DRAFT_KEY,
  loadDraft,
  loadSaved,
  MAX_SAVED,
  memoryStorage,
  SAVED_KEY,
  saveDraft,
  saveRecipe,
  type KeyValueStore,
} from './storage';

const throwing: KeyValueStore = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
  removeItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
};

describe('storage of drafts and saved recipes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('saves and restores the draft', () => {
    const storage = memoryStorage();
    expect(loadDraft(storage)).toBeNull();
    expect(saveDraft(storage, DEFAULT_RECIPE)).toBe(true);
    expect(loadDraft(storage)).toEqual(DEFAULT_RECIPE);
  });

  it('ignores drafts that are corrupt or not recipes', () => {
    expect(loadDraft(memoryStorage({ [DRAFT_KEY]: '{not json' }))).toBeNull();
    expect(loadDraft(memoryStorage({ [DRAFT_KEY]: '{"schema":"other"}' }))).toBeNull();
    expect(loadDraft(memoryStorage({ [DRAFT_KEY]: 'null' }))).toBeNull();
  });

  it('works without storage, and when the browser refuses access', () => {
    expect(loadDraft(null)).toBeNull();
    expect(saveDraft(null, DEFAULT_RECIPE)).toBe(false);
    expect(loadDraft(throwing)).toBeNull();
    expect(saveDraft(throwing, DEFAULT_RECIPE)).toBe(false);
    expect(loadSaved(throwing)).toEqual([]);
    expect(saveRecipe(throwing, 'x', DEFAULT_RECIPE)).toEqual({
      ok: false,
      error: 'The browser refused to save (its storage may be full).',
    });
    expect(saveRecipe(null, 'x', DEFAULT_RECIPE)).toEqual({
      ok: false,
      error: 'This browser does not allow saving (storage is blocked).',
    });
  });

  it('saves named recipes, newest first, replacing one of the same name', () => {
    const storage = memoryStorage();
    const t1 = new Date('2026-10-14T10:00:00Z');
    const t2 = new Date('2026-10-14T11:00:00Z');
    saveRecipe(storage, ' Morning ', DEFAULT_RECIPE, t1);
    saveRecipe(storage, 'Turbo', { ...DEFAULT_RECIPE, prep: { dose_g: 16 } }, t2);
    const again = saveRecipe(storage, 'Morning', { ...DEFAULT_RECIPE, prep: { dose_g: 19 } }, t2);
    expect(again.ok && again.recipes.map((r) => [r.name, r.recipe.prep.dose_g, r.savedAt])).toEqual(
      [
        ['Morning', 19, t2.toISOString()],
        ['Turbo', 16, t2.toISOString()],
      ],
    );
    expect(loadSaved(storage).map((r) => r.name)).toEqual(['Morning', 'Turbo']);
    expect(deleteRecipe(storage, 'Morning').map((r) => r.name)).toEqual(['Turbo']);
    expect(saveRecipe(storage, '  ', DEFAULT_RECIPE)).toEqual({
      ok: false,
      error: 'Give the recipe a name.',
    });
  });

  it('caps the number of saved recipes and drops unreadable entries', () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_SAVED; i++) saveRecipe(storage, `r${i}`, DEFAULT_RECIPE);
    expect(saveRecipe(storage, 'one more', DEFAULT_RECIPE).ok).toBe(false);
    expect(saveRecipe(storage, 'r3', DEFAULT_RECIPE).ok).toBe(true);
    const mixed = memoryStorage({
      [SAVED_KEY]: JSON.stringify({
        schema: 'puckworks.saved-recipes/1',
        recipes: [{ name: 'ok', savedAt: 'x', recipe: DEFAULT_RECIPE }, { name: 'bad' }, null],
      }),
    });
    expect(loadSaved(mixed).map((r) => r.name)).toEqual(['ok']);
  });

  it('starts the editor from the saved draft, or from the defaults without one', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(startingForm().prep.dose_g).toBe('18');
    saveDraft(storage, { ...DEFAULT_RECIPE, prep: { dose_g: 16.5 } });
    expect(startingForm().prep.dose_g).toBe('16.5');
    // A draft that no longer makes a valid recipe is ignored.
    storage.setItem(DRAFT_KEY, '{"schema":"puckworks.recipe/1","bean":7}');
    expect(startingForm().prep.dose_g).toBe('18');
    vi.stubGlobal('localStorage', throwing);
    expect(startingForm().prep.dose_g).toBe('18');
  });

  it('finds the browser’s storage only when it can be used', () => {
    vi.stubGlobal('localStorage', throwing);
    expect(browserStorage()).toBeNull();
    const working = memoryStorage();
    vi.stubGlobal('localStorage', working);
    expect(browserStorage()).toBe(working);
    vi.stubGlobal('localStorage', undefined);
    expect(browserStorage()).toBeNull();
  });
});
