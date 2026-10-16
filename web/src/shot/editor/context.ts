// SPDX-License-Identifier: GPL-2.0-or-later
/** What every editor section needs besides the form: errors, notes, catalog, last build. */
import { createContext, useContext } from 'react';
import type { BuiltSpec, Catalog, PresetBase } from '../../engine/shotTypes';
import type { NoteSection } from '../notes';
import type { FormErrors } from '../recipeForm';

export interface EditorContextValue {
  catalog: Catalog;
  /** Errors of the form's own checks, plus the builder's error for the current inputs. */
  errors: FormErrors;
  /** The builder's notes, by section. */
  notes: Record<NoteSection, string[]>;
  /** The notes come from a build of earlier inputs. */
  notesStale: boolean;
  /** The latest build (current inputs or earlier ones), for the basket drawing. */
  build: BuiltSpec | null;
  buildStale: boolean;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditorContext needs an EditorContext provider');
  return value;
}

/** The preset with `id` in a list, if any. */
export function findPreset<T extends PresetBase>(list: readonly T[], id: string): T | undefined {
  return id ? list.find((p) => p.id === id) : undefined;
}

/** Options for a preset picker, in the catalog's order. */
export function presetOptions(list: readonly PresetBase[]): { value: string; label: string }[] {
  return list.map((p) => ({ value: p.id, label: p.name }));
}
