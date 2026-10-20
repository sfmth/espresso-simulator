// SPDX-License-Identifier: GPL-2.0-or-later
/** First-party setup marker only; equipment remains in bounded local browser data. */
import type { Recipe } from '../engine/shotTypes';
import { validateRecipe } from '../dialin/journalValidation';
import { formToRecipe, recipeToForm } from '../shot/recipeForm';
import { browserStorage, DRAFT_KEY, type KeyValueStore } from '../shot/storage';

export type { KeyValueStore } from '../shot/storage';

export const SETUP_SCHEMA = 'puckworks.equipment-setup/1';
export const SETUP_COOKIE_NAME = 'puckworks_setup_v1';
export const SETUP_RECORD_KEY = 'puckworks.equipment-setup.v1';
export const SETUP_MAX_AGE_SECONDS = 31_536_000;
export const MAX_SETUP_BYTES = 200_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface EquipmentSetupRecord {
  schema: typeof SETUP_SCHEMA;
  recipe: Recipe;
  /** Omitted only when a valid draft supplies a damaged saved recipe. */
  completedAt?: string;
  /** Assigned by complete(); mandatory and checked for persisted restoration. */
  expiresAt?: string;
}

export interface CookieJar {
  read(): string;
  write(cookie: string): void;
}

export interface CompleteSetupResult {
  persisted: boolean;
  notice: string | null;
}

export interface ClearSetupResult {
  cleared: boolean;
  notice: string | null;
}

export interface SetupStorage {
  /** Explicit session completion or unexpired local equipment; a cookie alone is insufficient. */
  load(): EquipmentSetupRecord | null;
  /** Invalid recipes throw; blocked persistence still permits the current session. */
  complete(record: EquipmentSetupRecord): CompleteSetupResult;
  /** Removes completion only; Lab drafts, saved recipes and journals are retained. */
  clear(): ClearSetupResult;
  readonly cookiePath: string | null;
  readonly recordKey: string | null;
}

export interface SetupStorageOptions {
  cookies?: CookieJar | null;
  storage?: KeyValueStore | null;
  baseUrl?: string;
  pageUrl?: string;
  baseURI?: string;
  now?: () => number;
}

function documentCookies(): CookieJar | null {
  if (typeof document === 'undefined') return null;
  return {
    read: () => document.cookie,
    write: (cookie) => {
      document.cookie = cookie;
    },
  };
}

/** Relative builds resolve against the actual document base, including repository subpaths. */
export function setupCookiePath(baseUrl: string, baseURI: string, pageUrl = baseURI): string {
  const page = new URL(pageUrl);
  const base = new URL(baseUrl, baseURI);
  if (!['http:', 'https:'].includes(page.protocol) || base.origin !== page.origin)
    throw new Error('Setup persistence needs a same-origin app address.');
  let path = base.pathname;
  if (!path.endsWith('/')) path += '/';
  // Cookie Path is an attribute, not an arbitrary string interpolation target.
  if (
    path.includes(';') ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('Unsupported app cookie path.');
  return path;
}

function boundedJson(value: unknown): string {
  let nodes = 0;
  const visit = (child: unknown, depth: number) => {
    if (++nodes > 20_000 || depth > 24)
      throw new Error('Equipment setup exceeds structural limits.');
    if (child === null || typeof child === 'boolean') return;
    if (typeof child === 'number') {
      if (!Number.isFinite(child)) throw new Error('Equipment setup contains a nonfinite number.');
      return;
    }
    if (typeof child === 'string') {
      if (child.length > 2000) throw new Error('Equipment setup text exceeds its limit.');
      return;
    }
    if (Array.isArray(child)) {
      if (child.length > 2000) throw new Error('Equipment setup array exceeds its limit.');
      child.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (child && typeof child === 'object') {
      const prototype: unknown = Object.getPrototypeOf(child);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('Equipment setup must contain plain JSON objects.');
      for (const [key, item] of Object.entries(child)) {
        if (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key))
          throw new Error('Equipment setup contains an unsafe key.');
        visit(item, depth + 1);
      }
      return;
    }
    throw new Error('Equipment setup must contain only JSON values.');
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_SETUP_BYTES)
    throw new Error('Equipment setup exceeds its storage limit.');
  return text;
}

function validRecipe(value: unknown): value is Recipe {
  try {
    boundedJson(value);
    validateRecipe(value);
    const imported = recipeToForm(value);
    return imported.ok && imported.warnings.length === 0 && formToRecipe(imported.form).ok;
  } catch {
    return false;
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19)
    ? milliseconds
    : null;
}

function readJson(storage: KeyValueStore | null, key: string): unknown {
  try {
    const text = storage?.getItem(key);
    if (typeof text !== 'string' || text.length > MAX_SETUP_BYTES) return null;
    if (new TextEncoder().encode(text).length > MAX_SETUP_BYTES) return null;
    const value: unknown = JSON.parse(text);
    boundedJson(value);
    return value;
  } catch {
    return null;
  }
}

function metadata(value: unknown, now: number): EquipmentSetupRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<EquipmentSetupRecord>;
  if (
    Object.keys(record).some(
      (key) => !['schema', 'recipe', 'completedAt', 'expiresAt'].includes(key),
    ) ||
    record.schema !== SETUP_SCHEMA ||
    !('recipe' in record)
  )
    return null;
  const expiry = timestamp(record.expiresAt);
  if (
    expiry === null ||
    expiry <= now ||
    expiry > now + SETUP_MAX_AGE_SECONDS * 1000 + MAX_CLOCK_SKEW_MS
  )
    return null;
  if (record.completedAt !== undefined) {
    const completed = timestamp(record.completedAt);
    if (
      completed === null ||
      completed > now + MAX_CLOCK_SKEW_MS ||
      completed >= expiry ||
      expiry - completed > SETUP_MAX_AGE_SECONDS * 1000 + MAX_CLOCK_SKEW_MS
    )
      return null;
  }
  return record as EquipmentSetupRecord;
}

function marker(cookies: CookieJar | null): boolean {
  try {
    const matches = cookies
      ?.read()
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name]) => name === SETUP_COOKIE_NAME);
    return matches?.length === 1 && matches[0].length === 2 && matches[0][1] === 'done';
  } catch {
    return false;
  }
}

/** Synchronous and injectable: the setup gate can decide before mounting run controls. */
export function createSetupStorage(options: SetupStorageOptions = {}): SetupStorage {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const cookies = options.cookies === undefined ? documentCookies() : options.cookies;
  const pageUrl = options.pageUrl ?? (typeof location === 'undefined' ? '' : location.href);
  const baseURI = options.baseURI ?? (typeof document === 'undefined' ? pageUrl : document.baseURI);
  const now = options.now ?? Date.now;
  let cookiePath: string | null = null;
  try {
    cookiePath = setupCookiePath(options.baseUrl ?? import.meta.env.BASE_URL, baseURI, pageUrl);
  } catch {
    /* Invalid/non-browser addresses still permit explicit setup in this session. */
  }
  const recordKey = cookiePath === null ? null : `${SETUP_RECORD_KEY}:${cookiePath}`;
  const secure = pageUrl.startsWith('https:') ? '; Secure' : '';
  const cookie = (maxAge: number) =>
    `${SETUP_COOKIE_NAME}=${maxAge === 0 ? '' : 'done'}; Path=${cookiePath}; Max-Age=${maxAge}; SameSite=Strict${secure}`;
  let session: EquipmentSetupRecord | null = null;
  let clearedInSession = false;
  return {
    cookiePath,
    recordKey,
    load() {
      if (session) return structuredClone(session);
      if (clearedInSession || !recordKey) return null;
      const saved = metadata(readJson(storage, recordKey), now());
      if (!saved) return null;
      // The existing draft may have newer advanced inputs than the setup snapshot.
      const draft = readJson(storage, DRAFT_KEY);
      const recipe = validRecipe(draft) ? draft : validRecipe(saved.recipe) ? saved.recipe : null;
      return recipe ? structuredClone({ ...saved, recipe }) : null;
    },
    complete(record) {
      boundedJson(record);
      if (
        !record ||
        record.schema !== SETUP_SCHEMA ||
        Object.keys(record).some(
          (key) => !['schema', 'recipe', 'completedAt', 'expiresAt'].includes(key),
        ) ||
        !validRecipe(record.recipe)
      )
        throw new Error('Equipment setup needs a valid complete recipe.');
      const completedAt = record.completedAt ?? new Date(now()).toISOString();
      const completed = timestamp(completedAt);
      const current = now();
      if (completed === null || Math.abs(current - completed) > MAX_CLOCK_SKEW_MS)
        throw new Error('Equipment setup completion must use the current time.');
      const saved: EquipmentSetupRecord = {
        schema: SETUP_SCHEMA,
        recipe: structuredClone(record.recipe),
        completedAt,
        expiresAt: new Date(current + SETUP_MAX_AGE_SECONDS * 1000).toISOString(),
      };
      session = saved;
      clearedInSession = false;
      let dataSaved = false;
      try {
        if (storage && recordKey) {
          const text = boundedJson(saved);
          const draft = boundedJson(saved.recipe);
          // Publish completion last: a rejected draft must never leave a new
          // completion record that restores an older surviving Lab draft.
          storage.setItem(DRAFT_KEY, draft);
          if (storage.getItem(DRAFT_KEY) === draft) {
            storage.setItem(recordKey, text);
            dataSaved = storage.getItem(recordKey) === text;
          }
        }
      } catch {
        /* Session completion remains available when browser data is blocked/full. */
      }
      let cookieSaved = false;
      if (dataSaved && cookies && cookiePath) {
        try {
          cookies.write(cookie(SETUP_MAX_AGE_SECONDS));
          cookieSaved = marker(cookies);
        } catch {
          /* Cookie settings can independently refuse the nonunique marker. */
        }
      }
      const persisted = dataSaved;
      return {
        persisted,
        notice:
          persisted && cookieSaved
            ? null
            : dataSaved
              ? 'Equipment is saved on this device, but the setup cookie is unavailable. Saved local setup will be used on return.'
              : 'Equipment is ready for this session. These changes could not be saved completely. Next visit may restore an earlier setup or require setup again.',
      };
    },
    clear() {
      session = null;
      clearedInSession = true;
      let dataCleared = false;
      let cookieCleared = false;
      try {
        if (storage && recordKey) {
          storage.removeItem(recordKey);
          dataCleared = storage.getItem(recordKey) === null;
        }
      } catch {
        /* A blocked store cannot prevent a setup review in this session. */
      }
      try {
        if (cookies && cookiePath) {
          cookies.write(cookie(0));
          cookieCleared = !marker(cookies);
        }
      } catch {
        /* Retain the explicit in-session reset even if browser data persists. */
      }
      const cleared = dataCleared && cookieCleared;
      return {
        cleared,
        notice: cleared
          ? null
          : 'Setup is reset for this session. This browser could not clear all saved setup data; it may return next visit.',
      };
    },
  };
}
