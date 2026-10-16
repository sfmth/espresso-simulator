// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Differences between recipes, for comparing pinned runs: each recipe is
 * flattened into labelled values (in the units the editor shows), and only
 * the fields whose values are not all equal are listed. A field a recipe
 * leaves out shows as "—" (the preset or the registry supplies it).
 */
import type { Catalog, Recipe } from '../engine/shotTypes';
import { FIELDS, OTHER_LABELS, phaseFieldMeta, withUnit } from './recipeFields';
import { PHASE_FIELDS, shiftedText } from './recipeForm';

export interface FlatField {
  label: string;
  value: string;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short checksum (FNV-1a, 32 bit) that tells different data apart in the table. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

function scalar(path: string, value: unknown): string {
  if (typeof value === 'number') {
    const meta = FIELDS[path];
    return withUnit(shiftedText(value, meta?.shift ?? 0), meta?.unit ?? '');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** A recipe as path → labelled display value. */
export function flattenRecipe(
  recipe: Recipe,
  catalog: Catalog | null = null,
): Map<string, FlatField> {
  const out = new Map<string, FlatField>();
  const label = (path: string) => FIELDS[path]?.label ?? OTHER_LABELS[path] ?? path;
  const blocks = ['bean', 'grinder', 'basket', 'prep', 'machine', 'stop', 'numerics'] as const;
  for (const block of blocks) {
    const value = (recipe as unknown as Json)[block];
    if (!isRecord(value)) continue;
    for (const [key, v] of Object.entries(value)) {
      const path = `${block}.${key}`;
      if (v === null || v === undefined) continue;
      if (path === 'grinder.psd' && isRecord(v)) {
        const d = Array.isArray(v.diameter_um) ? (v.diameter_um as number[]) : [];
        out.set(path, {
          label: label(path),
          value: `${d.length} bins, ${d[0] ?? '?'}–${d.at(-1) ?? '?'} µm (#${fingerprint(JSON.stringify(v))})`,
        });
      } else if (path === 'basket.custom' && isRecord(v)) {
        const profile = Array.isArray(v.profile_mm) ? (v.profile_mm as [number, number][]) : [];
        out.set(path, {
          label: label(path),
          value: `${profile.map(([h, d]) => `(${h}, ${d})`).join(' ')} mm; holes ${String(
            v.perforated_diameter_mm,
          )} mm${typeof v.pressurised_orifice_mm === 'number' ? `; ${v.pressurised_orifice_mm} mm orifice` : ''}${
            typeof v.open_area_fraction === 'number'
              ? `; ${shiftedText(v.open_area_fraction, 2)}% open`
              : ''
          }`,
        });
      } else if (path === 'machine.profile' && Array.isArray(v)) {
        out.set('machine.profile.phases', { label: 'Program phases', value: String(v.length) });
        v.forEach((phase: unknown, i) => {
          if (!isRecord(phase)) return;
          const control = String(phase.control);
          out.set(`machine.profile.${i}.control`, {
            label: `Phase ${i + 1} control`,
            value: control,
          });
          for (const field of PHASE_FIELDS) {
            const fv = phase[field];
            if (typeof fv !== 'number') continue;
            const meta = phaseFieldMeta(field, control);
            out.set(`machine.profile.${i}.${field}`, {
              label: `Phase ${i + 1} ${meta.label.toLowerCase()}`,
              value: withUnit(fv, meta.unit),
            });
          }
        });
      } else if (path === 'machine.pump' && isRecord(v)) {
        const parts = Object.entries(v)
          .filter(([k, x]) => k !== 'type' && typeof x === 'number')
          .map(([k, x]) => `${k} ${String(x)}`);
        out.set(path, { label: label(path), value: [String(v.type), ...parts].join(', ') });
      } else if (key === 'preset' && typeof v === 'string' && catalog) {
        const list = {
          bean: catalog.presets.beans,
          grinder: catalog.presets.grinders,
          basket: catalog.presets.baskets,
          machine: catalog.presets.machines,
        }[block as 'bean' | 'grinder' | 'basket' | 'machine'];
        out.set(path, { label: label(path), value: list?.find((p) => p.id === v)?.name ?? v });
      } else if (!isRecord(v) && !Array.isArray(v)) {
        out.set(path, { label: label(path), value: scalar(path, v) });
      }
    }
  }
  for (const [id, v] of Object.entries(recipe.overrides ?? {})) {
    const p = catalog?.registry.parameters.find((r) => r.id === id);
    out.set(`overrides.${id}`, {
      label: `Override: ${p?.name ?? id}`,
      value: `${v}${p && p.units !== '1' ? ` ${p.units}` : ''}`,
    });
  }
  return out;
}

export interface DiffRow {
  path: string;
  label: string;
  /** One value per recipe, "—" where the recipe leaves the field out. */
  values: string[];
}

/** The fields whose values differ between the recipes, in a stable order. */
export function diffRecipes(recipes: readonly Recipe[], catalog: Catalog | null = null): DiffRow[] {
  const flat = recipes.map((r) => flattenRecipe(r, catalog));
  const paths: string[] = [];
  for (const map of flat)
    for (const path of map.keys()) if (!paths.includes(path)) paths.push(path);
  const rows: DiffRow[] = [];
  for (const path of paths) {
    const values = flat.map((map) => map.get(path)?.value ?? '—');
    if (values.every((v) => v === values[0])) continue;
    const label = flat.map((map) => map.get(path)?.label).find(Boolean) ?? path;
    rows.push({ path, label, values });
  }
  return rows;
}
