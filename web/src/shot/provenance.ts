// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Provenance (PLAN §1.2 principle 3): `derived.provenance` maps each spec field
 * to comma-separated tokens: `registry:<id>`, `calibration:<id>`,
 * `override:<id>`, `preset:<kind>/<id>`, `recipe:<field>` or
 * `model:<description>` (docs/model/input-models.md §1). This module parses the
 * tokens and joins them with the registry and the presets.
 */
import type { Catalog, PresetBase, RegistryParameter } from '../engine/shotTypes';

export type TokenKind = 'registry' | 'calibration' | 'override' | 'preset' | 'recipe' | 'model';

export interface ProvenanceToken {
  kind: TokenKind | 'other';
  /** Registry id, preset id, recipe field or model description. */
  id: string;
  /** For presets: `bean`, `grinder`, `grinder_family`, `basket` or `machine`. */
  presetKind?: string;
  raw: string;
}

const KINDS = ['registry', 'calibration', 'override', 'preset', 'recipe', 'model'] as const;
const SPLIT = new RegExp(`,\\s*(?=(?:${KINDS.join('|')}):)`);

export function parseProvenance(value: string): ProvenanceToken[] {
  return value
    .split(SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((raw): ProvenanceToken => {
      const match = /^([a-z]+):(.*)$/s.exec(raw);
      const kind = match?.[1] as TokenKind | undefined;
      if (!match || !kind || !(KINDS as readonly string[]).includes(kind)) {
        return { kind: 'other', id: raw, raw };
      }
      const id = match[2].trim();
      if (kind === 'preset') {
        const slash = id.indexOf('/');
        return slash > 0
          ? { kind, id: id.slice(slash + 1), presetKind: id.slice(0, slash), raw }
          : { kind, id, raw };
      }
      return { kind, id, raw };
    });
}

/** Registry ids a build consulted (registry, calibration and override tokens). */
export function registryIdsUsed(provenance: Record<string, string> | undefined): Set<string> {
  const ids = new Set<string>();
  for (const value of Object.values(provenance ?? {})) {
    for (const token of parseProvenance(value)) {
      if (token.kind === 'registry' || token.kind === 'calibration' || token.kind === 'override') {
        ids.add(token.id);
      }
    }
  }
  return ids;
}

/** Registry records by id. */
export function registryIndex(catalog: Catalog | null): Map<string, RegistryParameter> {
  return new Map((catalog?.registry.parameters ?? []).map((p) => [p.id, p]));
}

const PRESET_LISTS: Record<string, keyof Catalog['presets']> = {
  bean: 'beans',
  grinder: 'grinders',
  grinder_family: 'grinder_families',
  basket: 'baskets',
  machine: 'machines',
};

/** The preset a token names, if it is in the catalog. */
export function presetOf(catalog: Catalog | null, token: ProvenanceToken): PresetBase | undefined {
  if (token.kind !== 'preset' || !catalog || !token.presetKind) return undefined;
  const list = PRESET_LISTS[token.presetKind];
  if (!list) return undefined;
  const presets = catalog.presets[list];
  return Array.isArray(presets)
    ? (presets as PresetBase[]).find((p) => p.id === token.id)
    : undefined;
}

/** The provenance tokens of one spec field (empty when the field has none). */
export function tokensFor(provenance: Record<string, string> | undefined, path: string) {
  const value = provenance?.[path];
  return value ? parseProvenance(value) : [];
}

/** Words for a token kind, for badges and screen readers. */
export const TOKEN_KIND_LABELS: Record<ProvenanceToken['kind'], string> = {
  registry: 'Registry',
  calibration: 'Calibrated',
  override: 'Your override',
  preset: 'Preset',
  recipe: 'Your recipe',
  model: 'Model',
  other: 'Other',
};
