// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * One-dimensional sweeps (PLAN §9, Lab): vary one numeric input over a range,
 * run each point through the engine and plot chosen outputs against it.
 *
 * A target knows how to read its current value from a recipe and how to write
 * a new one. Values are in the units the editor shows (an Arabica share in %,
 * not as a fraction); `apply` converts exactly.
 */
import type { Catalog, PhaseInput, Recipe, RegistryParameter, Summary } from '../engine/shotTypes';
import { parseDecimal } from '../lab/sphereForm';
import { registryUnit } from './format';
import { BAR_PER_PA, G_PER_KG, PERCENT } from './units';
import { FIELDS, inRange, invalidMessage, type FieldMeta } from './recipeFields';
import { shiftedText, withTier } from './recipeForm';
import type { SweepConfig, SweepOutput } from './shotStore';

/** The brew ratio the builder stops at when the recipe gives no stop rule. */
export function defaultRatio(catalog: Catalog | null): number {
  return (
    catalog?.registry.parameters.find((p) => p.id === 'model.stop.default_ratio')?.default ?? 2
  );
}

/** Most points a sweep may have. */
export const MAX_SWEEP_POINTS = 41;

export interface SweepTarget {
  id: string;
  label: string;
  unit: string;
  /** Grouping in the picker. */
  group: 'recipe' | 'registry';
  meta: FieldMeta;
  /** The value the current recipe gives (or the preset or registry default), if known. */
  current: number | null;
  /** A sensible range around `current`. */
  defaultRange: [number, number];
  /** The recipe with this input set to `value` (display units). */
  apply: (recipe: Recipe, value: number) => Recipe;
}

/** Sets a dotted path in a copy of the recipe (blocks are copied, not shared). */
function setPath(recipe: Recipe, path: string, value: number): Recipe {
  const [block, field] = path.split('.') as [keyof Recipe, string];
  const copy = structuredClone(recipe);
  const target = (copy[block] ?? {}) as Record<string, unknown>;
  target[field] = value;
  (copy as unknown as Record<string, unknown>)[block] = target;
  return copy;
}

function roundNice(value: number): number {
  return Number(value.toPrecision(12));
}

function clampRange(lo: number, hi: number, meta: FieldMeta): [number, number] {
  let a = lo;
  let b = hi;
  if (meta.min !== undefined) {
    const floor = meta.minExclusive
      ? meta.min + Math.max(Math.abs(meta.min) * 1e-6, 1e-6)
      : meta.min;
    a = Math.max(a, floor);
    b = Math.max(b, floor);
  }
  if (meta.max !== undefined) {
    a = Math.min(a, meta.max);
    b = Math.min(b, meta.max);
  }
  return [roundNice(a), roundNice(b)];
}

/** ±20 % around `current` (or a unit span around 0), clamped to the field's range. */
function relativeRange(current: number, meta: FieldMeta, fraction = 0.2): [number, number] {
  if (current === 0) return clampRange(0, 1, meta);
  const lo = current * (1 - fraction);
  const hi = current * (1 + fraction);
  return clampRange(Math.min(lo, hi), Math.max(lo, hi), meta);
}

/** A numeric field of the recipe, displayed with `meta` (and its shift). */
function fieldTarget(
  path: string,
  meta: FieldMeta,
  current: number | null,
  range: (current: number) => [number, number],
  fallback: number,
): SweepTarget {
  const shift = meta.shift ?? 0;
  const shown = current === null ? null : Number(shiftedText(current, shift));
  return {
    id: path,
    label: meta.label,
    unit: meta.unit,
    group: 'recipe',
    meta,
    current: shown,
    defaultRange: range(shown ?? fallback),
    apply: (recipe, value) =>
      setPath(recipe, path, shift === 0 ? value : (parseDecimal(String(value), -shift) ?? value)),
  };
}

function lookup<T extends { id: string }>(
  list: readonly T[] | undefined,
  id: unknown,
): T | undefined {
  return typeof id === 'string' ? list?.find((p) => p.id === id) : undefined;
}

/** The program the machine runs: the recipe's own, or its preset's. */
export function effectiveProgram(recipe: Recipe, catalog: Catalog | null): PhaseInput[] | null {
  if (recipe.machine.profile) return recipe.machine.profile;
  return lookup(catalog?.presets.machines, recipe.machine.preset)?.program ?? null;
}

/** The central value of a registry parameter's prior, or a span around its default. */
export function registryRange(p: RegistryParameter): [number, number] {
  const meta: FieldMeta = { label: p.name, unit: p.units, min: p.range.min, max: p.range.max };
  const prior = p.prior as Record<string, unknown> | undefined;
  const num = (key: string) => (typeof prior?.[key] === 'number' ? prior[key] : null);
  let lo: number | null = null;
  let hi: number | null = null;
  switch (prior?.distribution) {
    case 'uniform':
    case 'triangular':
      lo = num('min');
      hi = num('max');
      break;
    case 'normal': {
      const mean = num('mean');
      const sd = num('sd');
      if (mean !== null && sd !== null) [lo, hi] = [mean - 2 * sd, mean + 2 * sd];
      break;
    }
    case 'lognormal': {
      const median = num('median');
      const gsd = num('gsd') ?? (num('sigma') !== null ? Math.exp(num('sigma') as number) : null);
      if (median !== null && gsd !== null && gsd > 1)
        [lo, hi] = [median / gsd ** 2, median * gsd ** 2];
      break;
    }
  }
  if (lo !== null && hi !== null && hi > lo) return clampRange(lo, hi, meta);
  return relativeRange(p.default, meta, 0.5);
}

/** Every target the current recipe offers, recipe inputs first, then registry parameters. */
export function sweepTargets(recipe: Recipe, catalog: Catalog | null): SweepTarget[] {
  const targets: SweepTarget[] = [];
  const presets = catalog?.presets;
  const g = recipe.grinder;
  const grinderPreset = lookup(presets?.grinders, g.preset);
  if (!g.psd) {
    if (typeof g.gap_um === 'number') {
      targets.push(
        fieldTarget(
          'grinder.gap_um',
          FIELDS['grinder.gap_um'],
          g.gap_um,
          (c) => relativeRange(c, FIELDS['grinder.gap_um']),
          200,
        ),
      );
    } else if (grinderPreset) {
      const dial = grinderPreset.dial;
      const meta: FieldMeta = {
        label: `Dial setting (${dial.label})`,
        unit: '',
        min: dial.min,
        max: dial.max,
      };
      targets.push(
        fieldTarget(
          'grinder.setting',
          meta,
          g.setting ?? dial.default,
          (c) => relativeRange(c, meta),
          dial.default,
        ),
      );
    } else if (typeof g.setting === 'number') {
      const meta: FieldMeta = { label: 'Dial setting', unit: '' };
      targets.push(
        fieldTarget('grinder.setting', meta, g.setting, (c) => relativeRange(c, meta), 10),
      );
    }
  }
  const dose = recipe.prep.dose_g;
  targets.push(
    fieldTarget(
      'prep.dose_g',
      FIELDS['prep.dose_g'],
      dose,
      (c) => clampRange(c - 2, c + 2, FIELDS['prep.dose_g']),
      18,
    ),
  );
  const machinePreset = lookup(presets?.machines, recipe.machine.preset);
  const temperature = recipe.machine.temperature_c ?? machinePreset?.temperature_c ?? null;
  targets.push(
    fieldTarget(
      'machine.temperature_c',
      FIELDS['machine.temperature_c'],
      temperature,
      (c) => clampRange(c - 4, c + 4, FIELDS['machine.temperature_c']),
      93,
    ),
  );
  const ratio = defaultRatio(catalog);
  const ratioDefault = Number.isFinite(dose) ? ratio * dose : 36;
  targets.push(
    fieldTarget(
      'stop.beverage_g',
      FIELDS['stop.beverage_g'],
      recipe.stop.beverage_g ?? null,
      (c) => clampRange(c * 0.75, c * 1.5, FIELDS['stop.beverage_g']),
      ratioDefault,
    ),
  );
  targets.push(
    fieldTarget(
      'stop.time_s',
      FIELDS['stop.time_s'],
      recipe.stop.time_s ?? null,
      (c) => clampRange(c * 0.75, c * 1.5, FIELDS['stop.time_s']),
      30,
    ),
  );

  // Program targets: every pressure or flow phase. Sweeping one copies the preset's program.
  const program = effectiveProgram(recipe, catalog);
  program?.forEach((phase, i) => {
    if (phase.control === 'pump') return;
    const unit = phase.control === 'flow' ? 'mL/s' : 'bar';
    const meta: FieldMeta = {
      label: `Phase ${i + 1} ${phase.control} target`,
      unit,
      min: 0,
      max: 100,
    };
    const current = typeof phase.target === 'number' ? phase.target : null;
    targets.push({
      id: `phase.${i}.target`,
      label: meta.label,
      unit,
      group: 'recipe',
      meta,
      current,
      defaultRange: relativeRange(current ?? 9, meta, 0.33),
      apply: (r, value) => {
        const copy = structuredClone(r);
        const phases = structuredClone(effectiveProgram(r, catalog) ?? []);
        if (phases[i]) phases[i] = { ...phases[i], target: value };
        copy.machine.profile = phases;
        return copy;
      },
    });
  });

  const beanPreset =
    lookup(presets?.beans, recipe.bean.preset) ?? presets?.beans.find((b) => b.default === true);
  targets.push(
    fieldTarget(
      'bean.roast_level',
      FIELDS['bean.roast_level'],
      recipe.bean.roast_level ?? beanPreset?.roast_level ?? null,
      (c) => clampRange(c - 0.3, c + 0.3, FIELDS['bean.roast_level']),
      0.5,
    ),
    fieldTarget(
      'bean.days_off_roast',
      FIELDS['bean.days_off_roast'],
      recipe.bean.days_off_roast ?? beanPreset?.days_off_roast ?? null,
      () => [3, 30],
      10,
    ),
    fieldTarget(
      'bean.arabica_fraction',
      FIELDS['bean.arabica_fraction'],
      recipe.bean.arabica_fraction ?? beanPreset?.arabica_fraction ?? null,
      () => [0, 100],
      1,
    ),
    fieldTarget(
      'numerics.size_classes',
      FIELDS['numerics.size_classes'],
      recipe.numerics?.size_classes ?? 30,
      () => [8, 40],
      30,
    ),
  );

  for (const p of catalog?.registry.parameters ?? []) {
    const unit = registryUnit(p.units);
    const meta: FieldMeta = { label: p.name, unit, min: p.range.min, max: p.range.max };
    targets.push({
      id: `override:${p.id}`,
      label: `${p.name} (${p.id})`,
      unit,
      group: 'registry',
      meta,
      current: recipe.overrides?.[p.id] ?? p.default,
      defaultRange: registryRange(p),
      apply: (r, value) => ({
        ...structuredClone(r),
        overrides: { ...r.overrides, [p.id]: value },
      }),
    });
  }
  return targets;
}

/** `n` evenly spaced values from `from` to `to` (integers rounded and deduplicated). */
export function sweepValues(from: number, to: number, n: number, integer = false): number[] {
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = n === 1 ? from : from + ((to - from) * i) / (n - 1);
    values.push(integer ? Math.round(v) : roundNice(v));
  }
  return integer ? [...new Set(values)] : values;
}

export interface SweepPlan {
  target: SweepTarget;
  values: number[];
  recipes: Recipe[];
  tier: 0 | 1;
}

export type SweepPlanResult =
  | { ok: true; plan: SweepPlan }
  | { ok: false; errors: Partial<Record<'target' | 'from' | 'to' | 'points', string>> };

/** Checks a sweep's settings and makes one recipe per value. */
export function planSweep(
  recipe: Recipe,
  catalog: Catalog | null,
  config: SweepConfig,
  targets: readonly SweepTarget[] = sweepTargets(recipe, catalog),
): SweepPlanResult {
  const errors: Partial<Record<'target' | 'from' | 'to' | 'points', string>> = {};
  const target = targets.find((t) => t.id === config.targetId);
  if (!target) errors.target = 'Choose what to vary.';
  const from = parseDecimal(config.from);
  const to = parseDecimal(config.to);
  const points = parseDecimal(config.points);
  if (target) {
    if (from === null || !inRange(target.meta, from))
      errors.from = invalidMessage({ ...target.meta, label: 'The start' });
    if (to === null || !inRange(target.meta, to))
      errors.to = invalidMessage({ ...target.meta, label: 'The end' });
    if (!errors.from && !errors.to && from === to)
      errors.to = 'The end must differ from the start.';
  }
  if (points === null || !Number.isInteger(points) || points < 2 || points > MAX_SWEEP_POINTS) {
    errors.points = `Points must be a whole number from 2 to ${MAX_SWEEP_POINTS}.`;
  }
  if (!target || Object.keys(errors).length > 0) return { ok: false, errors };
  const values = sweepValues(from as number, to as number, points as number, target.meta.integer);
  const tier = config.tier === '1' ? 1 : 0;
  const recipes = values.map((v) => withTier(target.apply(recipe, v), tier));
  return { ok: true, plan: { target, values, recipes, tier } };
}

export interface SweepOutputInfo {
  id: SweepOutput;
  label: string;
  unit: string;
  value: (s: Summary) => number | null;
}

export const SWEEP_OUTPUTS: readonly SweepOutputInfo[] = [
  { id: 'ey', label: 'Extraction yield', unit: '%', value: (s) => s.ey * PERCENT },
  { id: 'tds', label: 'TDS', unit: '%', value: (s) => s.tds * PERCENT },
  { id: 'shot_time', label: 'Shot time', unit: 's', value: (s) => s.shot_time_s },
  {
    id: 'beverage',
    label: 'Beverage mass',
    unit: 'g',
    value: (s) => s.beverage_mass_kg * G_PER_KG,
  },
  {
    id: 'max_pressure',
    label: 'Maximum pressure',
    unit: 'bar',
    value: (s) => s.max_pressure_pa * BAR_PER_PA,
  },
  { id: 'first_drops', label: 'First drops', unit: 's', value: (s) => s.first_drops_s },
  {
    id: 'ey_std',
    label: 'EY spread across the bed (std)',
    unit: '% points',
    value: (s) => s.uniformity.ey_std * PERCENT,
  },
];

export function sweepOutput(id: SweepOutput): SweepOutputInfo {
  return SWEEP_OUTPUTS.find((o) => o.id === id) ?? SWEEP_OUTPUTS[0];
}
