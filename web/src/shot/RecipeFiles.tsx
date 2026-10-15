// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Recipe files and storage: export the recipe as JSON, import one, save named
 * recipes in this browser, and reset to the defaults. Loading or resetting can
 * be undone. Nothing is sent anywhere; files are read and written locally.
 */
import { useMemo, useRef, useState } from 'react';
import type { Recipe } from '../engine/shotTypes';
import { datedName, downloadJson } from './download';
import { focusSoon } from './focus';
import { dropUnknownOverrides, recipeToForm, type FormResult } from './recipeForm';
import { droppedOverridesNotice, useShotStore } from './shotStore';
import { browserStorage, deleteRecipe, loadSaved, saveRecipe, type SavedRecipe } from './storage';

/** Largest recipe file accepted (a recipe with a long measured PSD is a few kB). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** Warnings listed in the status line before the rest are counted. */
const MAX_LISTED_WARNINGS = 5;

/** Warnings for the status line: the first few, then a count. */
export function summariseWarnings(warnings: readonly string[]): string {
  if (warnings.length <= MAX_LISTED_WARNINGS) return warnings.join(' ');
  const rest = warnings.length - MAX_LISTED_WARNINGS;
  return `${warnings.slice(0, MAX_LISTED_WARNINGS).join(' ')} And ${rest} more.`;
}

export function RecipeFiles({ validation }: { validation: FormResult }) {
  const loadForm = useShotStore((s) => s.loadForm);
  const resetForm = useShotStore((s) => s.resetForm);
  const undoLast = useShotStore((s) => s.undoLast);
  const undo = useShotStore((s) => s.undo);
  const catalog = useShotStore((s) => s.catalog);
  const storage = useMemo(() => browserStorage(), []);
  const [saved, setSaved] = useState<SavedRecipe[]>(() => loadSaved(storage));
  const [name, setName] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = (recipe: unknown, source: string) => {
    const result = recipeToForm(recipe);
    if (!result.ok) {
      setMessage({ text: `Could not load ${source}: ${result.error}`, error: true });
      return;
    }
    const warnings = [...result.warnings];
    let form = result.form;
    if (catalog) {
      const dropped = dropUnknownOverrides(form, catalog);
      form = dropped.form;
      if (dropped.removed.length > 0) warnings.push(droppedOverridesNotice(dropped.removed));
    }
    loadForm(form, 'Undo load');
    setMessage({
      text: `Loaded ${source}.${warnings.length > 0 ? ` ${summariseWarnings(warnings)}` : ''}`,
      error: false,
    });
  };

  const importFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      setMessage({
        text: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; a recipe file is at most ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
        error: true,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      setMessage({
        text: `${file.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        error: true,
      });
      return;
    }
    load(parsed, file.name);
  };

  const exportRecipe = (recipe: Recipe) => downloadJson(datedName('recipe', 'json'), recipe);

  return (
    <div className="recipe-files">
      <div className="actions">
        <button
          type="button"
          className="button button-small"
          disabled={!validation.ok}
          title={validation.ok ? undefined : 'Fix the highlighted inputs first'}
          onClick={() => {
            if (validation.ok) exportRecipe(validation.recipe);
          }}
        >
          Export recipe
        </button>
        <button
          type="button"
          className="button button-small"
          onClick={() => fileInput.current?.click()}
        >
          Import recipe…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Recipe file to import"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
        <button
          id="recipe-reset"
          type="button"
          className="button button-small button-quiet"
          onClick={resetForm}
        >
          Reset to defaults
        </button>
        {undo && (
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              undoLast();
              setMessage({ text: `${undo.label.replace(/^Undo/, 'Undid the')}.`, error: false });
              focusSoon('recipe-reset');
            }}
          >
            {undo.label}
          </button>
        )}
      </div>
      <details className="saved-recipes">
        <summary>Saved in this browser ({saved.length})</summary>
        {storage ? (
          <>
            <form
              className="save-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (!validation.ok) {
                  setMessage({ text: 'Fix the highlighted inputs before saving.', error: true });
                  return;
                }
                const result = saveRecipe(storage, name, validation.recipe);
                if (result.ok) {
                  setSaved(result.recipes);
                  setMessage({ text: `Saved “${name.trim()}”.`, error: false });
                  setName('');
                } else setMessage({ text: result.error, error: true });
              }}
            >
              <label htmlFor="save-name">Name</label>
              <input
                id="save-name"
                type="text"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" className="button button-small">
                Save
              </button>
            </form>
            {saved.length > 0 ? (
              <ul className="saved-list">
                {saved.map((r, i) => (
                  <li key={r.name}>
                    <span className="saved-name">{r.name}</span>{' '}
                    <span className="note">{new Date(r.savedAt).toLocaleString()}</span>
                    <span className="saved-actions">
                      <button
                        id={`saved-load-${i}`}
                        type="button"
                        className="button button-small"
                        onClick={() => load(r.recipe, `“${r.name}”`)}
                        aria-label={`Load ${r.name}`}
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        className="button button-small button-quiet"
                        onClick={() => {
                          const left = deleteRecipe(storage, r.name);
                          setSaved(left);
                          setMessage({ text: `Deleted “${r.name}”.`, error: false });
                          // Focus the next entry (or the name field when none is left).
                          focusSoon(
                            left.length > 0
                              ? `saved-load-${Math.min(i, left.length - 1)}`
                              : 'save-name',
                          );
                        }}
                        aria-label={`Delete ${r.name}`}
                      >
                        Delete
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="note">No saved recipes yet.</p>
            )}
          </>
        ) : (
          <p className="note">
            This browser does not allow the page to store data, so recipes cannot be saved here.
            Export them as files instead.
          </p>
        )}
      </details>
      <p className={message?.error ? 'field-error' : 'note'} role="status">
        {message?.text}
      </p>
    </div>
  );
}
