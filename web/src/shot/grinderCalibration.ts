// SPDX-License-Identifier: GPL-2.0-or-later
/** Dial coordinates map to effective model gap, not a universal mechanical measurement. */
import { parseDecimal } from '../lab/sphereForm';
import type { Catalog, GrinderPreset } from '../engine/shotTypes';
import { inferenceParameters } from '../setup/parameterCatalog';
import { formToRecipe, type RecipeForm } from './recipeForm';

export type DialDirection = 'coarser' | 'finer';
export type CalibrationResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DialCalibration {
  setting: number;
  setting_ref: number;
  gap_at_ref_um: number;
  gap_per_unit_um: number;
}

export function resolveGrinderGap(
  grinder: RecipeForm['grinder'],
  presets: readonly GrinderPreset[],
): number | null {
  if (grinder.mode === 'psd') return null;
  if (grinder.by === 'gap') {
    const gap = parseDecimal(grinder.gap_um);
    return gap !== null && gap >= 5 && gap <= 3000 ? gap : null;
  }
  if (
    [grinder.setting, grinder.setting_ref, grinder.gap_at_ref_um, grinder.gap_per_unit_um].some(
      (text) => text.trim() !== '' && parseDecimal(text) === null,
    )
  )
    return null;
  const preset =
    grinder.mode === 'preset' ? presets.find((p) => p.id === grinder.preset) : undefined;
  const setting = parseDecimal(grinder.setting) ?? preset?.dial.default;
  const reference = parseDecimal(grinder.setting_ref) ?? preset?.dial.ref ?? 0;
  const gap = parseDecimal(grinder.gap_at_ref_um) ?? preset?.dial.gap_at_ref_um;
  const slope = parseDecimal(grinder.gap_per_unit_um) ?? preset?.dial.gap_per_unit_um;
  if (setting === undefined || gap === undefined || slope === undefined || slope === 0) return null;
  if (preset && (setting < preset.dial.min || setting > preset.dial.max)) return null;
  const effective = gap + slope * (setting - reference);
  return Number.isFinite(effective) && effective >= 5 && effective <= 3000 ? effective : null;
}

export function calibrateDialAtSetting(input: {
  setting: number;
  effectiveGapUm: number;
  gapPerUnitUm: number;
}): CalibrationResult<DialCalibration> {
  if (!Object.values(input).every(Number.isFinite))
    return { ok: false, error: 'Enter finite numbers for the dial calibration.' };
  if (input.effectiveGapUm < 5 || input.effectiveGapUm > 3000)
    return { ok: false, error: 'Effective gap must be between 5 and 3,000 µm.' };
  if (input.gapPerUnitUm === 0 || Math.abs(input.gapPerUnitUm) > 1000)
    return {
      ok: false,
      error: 'Sensitivity must be nonzero and no more than 1,000 µm per dial unit.',
    };
  return {
    ok: true,
    value: {
      setting: input.setting,
      setting_ref: input.setting,
      gap_at_ref_um: input.effectiveGapUm,
      gap_per_unit_um: input.gapPerUnitUm,
    },
  };
}

export function calibrateDialFromAnchors(input: {
  first: { setting: number; effectiveGapUm: number };
  second: { setting: number; effectiveGapUm: number };
}): CalibrationResult<DialCalibration> {
  if (
    !Object.values(input.first).every(Number.isFinite) ||
    !Object.values(input.second).every(Number.isFinite) ||
    input.first.setting === input.second.setting
  )
    return { ok: false, error: 'Use two different finite dial numbers.' };
  if (input.second.effectiveGapUm < 5 || input.second.effectiveGapUm > 3000)
    return { ok: false, error: 'Both effective gaps must be between 5 and 3,000 µm.' };
  return calibrateDialAtSetting({
    ...input.first,
    gapPerUnitUm:
      (input.second.effectiveGapUm - input.first.effectiveGapUm) /
      (input.second.setting - input.first.setting),
  });
}

/** Relabel the current fineness without changing its physical grinder distribution. */
export function makeCustomDial(
  form: RecipeForm,
  catalog: Catalog,
  setting: number,
  direction: DialDirection,
): CalibrationResult<RecipeForm> {
  const effectiveGapUm = resolveGrinderGap(form.grinder, catalog.presets.grinders);
  if (effectiveGapUm === null)
    return {
      ok: false,
      error: 'Choose a valid grinder and fineness before assigning your dial numbers.',
    };
  // A starting assumption only; the user's recorded shots can fit this sensitivity.
  const calibration = calibrateDialAtSetting({
    setting,
    effectiveGapUm,
    gapPerUnitUm: direction === 'coarser' ? 10 : -10,
  });
  if (!calibration.ok) return calibration;
  const current = formToRecipe(form, { catalog });
  if (!current.ok)
    return { ok: false, error: 'Correct the current recipe before assigning your dial numbers.' };
  const effective = new Map(
    inferenceParameters(current.recipe, catalog).map((p) => [p.path, p.value]),
  );
  const next = structuredClone(form);
  const preset =
    form.grinder.mode === 'preset'
      ? catalog.presets.grinders.find((p) => p.id === form.grinder.preset)
      : undefined;
  next.grinder.mode = 'family';
  next.grinder.by = 'setting';
  next.grinder.family = preset?.family ?? form.grinder.family;
  next.grinder.preset = '';
  next.grinder.gap_um = '';
  for (const [key, value] of Object.entries(calibration.value))
    next.grinder[key as keyof DialCalibration] = String(value);
  for (const key of [
    'x50_gap_ratio',
    'fines_at_340_pct',
    'coarse_log_width',
    'boulder_weight',
    'burr_diameter_mm',
    'rpm',
  ] as const) {
    const value = effective.get(`grinder.${key}`);
    if (typeof value === 'number')
      next.grinder[key] = String(key === 'boulder_weight' ? value * 100 : value);
  }
  if (
    preset?.psd?.fines_mode_um != null &&
    next.overrides['psd.fines_mode'] === undefined &&
    catalog.registry.parameters.find((p) => p.id === 'psd.fines_mode')?.default_from !==
      'calibration'
  )
    next.overrides['psd.fines_mode'] = String(preset.psd.fines_mode_um);
  return { ok: true, value: next };
}
