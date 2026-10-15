// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The user's own drafts and saved recipes, in the browser's localStorage only
 * (D9: nothing leaves the browser). Every access is wrapped: storage can be
 * missing, blocked (private modes, site settings) or full, and the app works
 * without it. Stored data is validated when read; anything unreadable is
 * ignored rather than trusted.
 */
import { RECIPE_SCHEMA, type Recipe } from '../engine/shotTypes';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFT_KEY = 'puckworks.lab.draft.v1';
export const SAVED_KEY = 'puckworks.lab.recipes.v1';
const SAVED_SCHEMA = 'puckworks.saved-recipes/1';
/** Most saved recipes kept. */
export const MAX_SAVED = 50;

/** The browser's localStorage if it can be used, else null. */
export function browserStorage(): KeyValueStore | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = '__puckworks_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function isRecipe(value: unknown): value is Recipe {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { schema?: unknown }).schema === RECIPE_SCHEMA
  );
}

function readJson(storage: KeyValueStore | null, key: string): unknown {
  if (!storage) return null;
  try {
    const text = storage.getItem(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function writeJson(storage: KeyValueStore | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The saved draft, or null if there is none or it is unreadable. */
export function loadDraft(storage: KeyValueStore | null): Recipe | null {
  const value = readJson(storage, DRAFT_KEY);
  return isRecipe(value) ? value : null;
}

export function saveDraft(storage: KeyValueStore | null, recipe: Recipe): boolean {
  return writeJson(storage, DRAFT_KEY, recipe);
}

export interface SavedRecipe {
  name: string;
  /** ISO 8601 time of saving. */
  savedAt: string;
  recipe: Recipe;
}

export function loadSaved(storage: KeyValueStore | null): SavedRecipe[] {
  const value = readJson(storage, SAVED_KEY) as { schema?: unknown; recipes?: unknown } | null;
  if (!value || value.schema !== SAVED_SCHEMA || !Array.isArray(value.recipes)) return [];
  return value.recipes.filter(
    (r: unknown): r is SavedRecipe =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as SavedRecipe).name === 'string' &&
      typeof (r as SavedRecipe).savedAt === 'string' &&
      isRecipe((r as SavedRecipe).recipe),
  );
}

export type SaveResult = { ok: true; recipes: SavedRecipe[] } | { ok: false; error: string };

/** Saves (or replaces) a recipe under `name`; the newest first. */
export function saveRecipe(
  storage: KeyValueStore | null,
  name: string,
  recipe: Recipe,
  now: Date = new Date(),
): SaveResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Give the recipe a name.' };
  if (!storage)
    return { ok: false, error: 'This browser does not allow saving (storage is blocked).' };
  const others = loadSaved(storage).filter((r) => r.name !== trimmed);
  if (others.length >= MAX_SAVED) {
    return { ok: false, error: `At most ${MAX_SAVED} recipes can be saved; delete one first.` };
  }
  const recipes = [{ name: trimmed, savedAt: now.toISOString(), recipe }, ...others];
  if (!writeJson(storage, SAVED_KEY, { schema: SAVED_SCHEMA, recipes })) {
    return { ok: false, error: 'The browser refused to save (its storage may be full).' };
  }
  return { ok: true, recipes };
}

export function deleteRecipe(storage: KeyValueStore | null, name: string): SavedRecipe[] {
  const recipes = loadSaved(storage).filter((r) => r.name !== name);
  writeJson(storage, SAVED_KEY, { schema: SAVED_SCHEMA, recipes });
  return recipes;
}

/** An in-memory store, for tests and as a stand-in. */
export function memoryStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}
