// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Routes the builder's notes (`derived.notes`: assumptions, clamped inputs,
 * documented no-ops and the notes of the presets used) to the editor section
 * they concern, by their prefix: "Grinder: …", "Puck prep: …", or a preset's
 * name ("58 mm precision basket, 18 g: …").
 */
import type { Catalog } from '../engine/shotTypes';

export type NoteSection =
  'bean' | 'grinder' | 'basket' | 'prep' | 'machine' | 'stop' | 'overrides' | 'other';

const PREFIXES: [string, NoteSection][] = [
  ['Bean:', 'bean'],
  ['Grinder:', 'grinder'],
  ['Measured PSD:', 'grinder'],
  ['Basket:', 'basket'],
  ['Puck prep:', 'prep'],
  ['Prep:', 'prep'],
  ['Machine:', 'machine'],
  ['Stop:', 'stop'],
  ['Override ', 'overrides'],
  ['Overrides:', 'overrides'],
];

export function emptyRouting(): Record<NoteSection, string[]> {
  return {
    bean: [],
    grinder: [],
    basket: [],
    prep: [],
    machine: [],
    stop: [],
    overrides: [],
    other: [],
  };
}

export function routeNotes(
  notes: readonly string[],
  catalog: Catalog | null,
): Record<NoteSection, string[]> {
  const out = emptyRouting();
  const names: [string, NoteSection][] = [];
  if (catalog) {
    const p = catalog.presets;
    for (const x of p.beans) names.push([`${x.name}:`, 'bean']);
    for (const x of p.grinders) names.push([`${x.name}:`, 'grinder']);
    for (const x of p.grinder_families) names.push([`${x.name}:`, 'grinder']);
    for (const x of p.baskets) names.push([`${x.name}:`, 'basket']);
    for (const x of p.machines) names.push([`${x.name}:`, 'machine']);
  }
  // Longer names first, so "58 mm stock double basket, tapered" wins over a shorter prefix.
  names.sort((a, b) => b[0].length - a[0].length);
  for (const note of notes) {
    const hit =
      PREFIXES.find(([prefix]) => note.startsWith(prefix)) ??
      names.find(([prefix]) => note.startsWith(prefix));
    out[hit ? hit[1] : 'other'].push(note);
  }
  return out;
}
