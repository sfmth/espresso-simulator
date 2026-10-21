// SPDX-License-Identifier: GPL-2.0-or-later
/** Search coordinates use recipe/registry units, never display-scaled fractions. */
import type { Catalog, Recipe, RegistryParameter } from '../engine/shotTypes';
import { BEAN_PROCESSES, BEAN_STORAGE, BEAN_VARIETIES, DISTRIBUTIONS } from '../engine/shotTypes';
import { FIELDS, phaseFieldMeta, type FieldMeta, type PhaseField } from '../shot/recipeFields';
import type { SetupParameter, SetupValue } from './inferenceTypes';

const GROUPS: Record<string, string> = {
  bean: 'Coffee',
  grinder: 'Grinder',
  basket: 'Basket',
  prep: 'Preparation',
  machine: 'Machine',
  water: 'Water',
  chemistry: 'Cup measurement',
  overrides: 'Advanced model',
};
/** Aliases are presented once, as a practical setting, so two controls cannot contradict. */
const ALIASES: Record<string, string> = {
  'shot.temperature': 'machine.temperature_c',
  'model.machine.group_headspace': 'machine.headspace_ml',
  'model.machine.ideal_max_flow': 'machine.pump.max_flow_ml_s',
  'model.machine.ideal_max_pressure': 'machine.pump.max_pressure_bar',
  'model.machine.vibratory_free_flow': 'machine.pump.free_flow_ml_s',
  'model.machine.vibratory_stall_pressure': 'machine.pump.stall_pressure_bar',
  'psd.x50_gap_ratio': 'grinder.x50_gap_ratio',
  'model.psd.coarse_log_width': 'grinder.coarse_log_width',
  'model.psd.boulder_weight': 'grinder.boulder_weight',
  'model.basket.open_area_fraction': 'basket.custom.open_area_fraction',
  'model.basket.pressurised_discharge_coefficient': 'basket.custom.discharge_coefficient',
};
for (const field of [
  'alkalinity_mg_l_caco3',
  'hardness_mg_l_caco3',
  'calcium_mg_l',
  'magnesium_mg_l',
  'tds_mg_l',
  'ph',
]) {
  ALIASES[`water.default.${field}`] = `water.${field}`;
}

/** No prototype traversal; registry ids contain dots and are one dictionary key. */
export function readSetupValue(recipe: Recipe, path: string): unknown {
  if (path.startsWith('overrides.')) return recipe.overrides?.[path.slice(10)];
  if (path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)))
    return undefined;
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
      recipe,
    );
}

function rawSet(recipe: Recipe, path: string, value: unknown): void {
  if (path.startsWith('overrides.')) {
    recipe.overrides = { ...recipe.overrides, [path.slice(10)]: value as number };
    return;
  }
  const parts = path.split('.');
  if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)))
    throw new Error('Invalid setup parameter path.');
  let current = recipe as unknown as Record<string, unknown>;
  parts.slice(0, -1).forEach((key, i) => {
    if (!current[key] || typeof current[key] !== 'object')
      current[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    current = current[key] as Record<string, unknown>;
  });
  current[parts.at(-1)!] = value;
}

/** Return a copy with one effective parameter changed, preserving unrelated settings. */
export function setSetupValue(
  recipe: Recipe,
  path: string,
  value: SetupValue,
  catalog: Catalog,
): Recipe {
  const next = structuredClone(recipe);
  if (path.startsWith('basket.custom.') && !next.basket.custom) {
    const machine = catalog.presets.machines.find((p) => p.id === next.machine.preset);
    const preset = catalog.presets.baskets.find(
      (p) => p.id === (next.basket.preset ?? machine?.default_basket),
    );
    if (!preset) throw new Error('Choose a basket before changing its dimensions.');
    next.basket.custom = {
      profile_mm: structuredClone(preset.profile_mm),
      perforated_diameter_mm: preset.perforated_diameter_mm,
      open_area_fraction:
        next.overrides?.['model.basket.open_area_fraction'] ?? preset.open_area_fraction,
      pressurised_orifice_mm: preset.pressurised_orifice_mm,
      discharge_coefficient:
        next.overrides?.['model.basket.pressurised_discharge_coefficient'] ??
        preset.discharge_coefficient,
    };
  }
  if (path.startsWith('machine.profile.') && !next.machine.profile) {
    const preset = catalog.presets.machines.find((p) => p.id === next.machine.preset);
    if (!preset) throw new Error('Choose a machine program before changing a phase.');
    next.machine.profile = structuredClone(preset.program);
  }
  if (path.startsWith('machine.pump.') && !next.machine.pump) {
    const preset = catalog.presets.machines.find((p) => p.id === next.machine.preset);
    next.machine.pump = structuredClone(preset?.pump ?? { type: 'ideal' });
  }
  if (path === 'machine.pump.type' && next.machine.pump?.type !== value) {
    next.machine.pump = value === 'vibratory' ? { type: 'vibratory' } : { type: 'ideal' };
  }
  if (path === 'grinder.family' && next.grinder.preset) {
    // Keep the calibrated dial mapping when replacing the burr family. A
    // generic-family dial has reference zero, while named dials have a ref.
    const preset = catalog.presets.grinders.find((p) => p.id === next.grinder.preset);
    if (preset?.family === value) {
      next.grinder.family = value;
      return next;
    }
    if (preset && next.grinder.gap_um == null) {
      const slope = next.grinder.gap_per_unit_um ?? preset.dial.gap_per_unit_um;
      const intercept =
        (next.grinder.gap_at_ref_um ?? preset.dial.gap_at_ref_um) - slope * preset.dial.ref;
      if (intercept < 0)
        throw new Error(
          'This named dial cannot be converted to a generic family without changing its reference. Select a generic family and explicit gap first.',
        );
      next.grinder.setting ??= preset.dial.default;
      next.grinder.gap_at_ref_um = intercept;
      next.grinder.gap_per_unit_um = slope;
    }
    delete next.grinder.preset;
  }
  rawSet(next, path, value);
  return next;
}

function primitive(value: unknown): SetupValue | undefined {
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'
    ? value
    : undefined;
}
function registryBounds(p: RegistryParameter): { min?: number; max?: number } {
  const prior = p.prior as Record<string, unknown> | undefined;
  return {
    min: p.range.min ?? (typeof prior?.min === 'number' ? prior.min : undefined),
    max: p.range.max ?? (typeof prior?.max === 'number' ? prior.max : undefined),
  };
}

export function inferenceParameters(recipe: Recipe, catalog: Catalog): SetupParameter[] {
  const out: SetupParameter[] = [];
  const reg = (id: string): number | undefined =>
    recipe.overrides?.[id] ?? catalog.registry.parameters.find((p) => p.id === id)?.default;
  const inherited = (id: string, preset?: number | null): number | undefined => {
    const parameter = catalog.registry.parameters.find((p) => p.id === id);
    return (
      recipe.overrides?.[id] ??
      (parameter?.default_from === 'calibration' ? parameter.default : undefined) ??
      preset ??
      parameter?.default
    );
  };
  const bean =
    catalog.presets.beans.find((p) => p.id === recipe.bean.preset) ??
    catalog.presets.beans.find((p) => p.default);
  const grinder = catalog.presets.grinders.find((p) => p.id === recipe.grinder.preset);
  const family = catalog.presets.grinder_families.find(
    (p) => p.id === (grinder?.family ?? recipe.grinder.family),
  );
  const machine = catalog.presets.machines.find((p) => p.id === recipe.machine.preset);
  const basket =
    recipe.basket.custom ??
    catalog.presets.baskets.find((p) => p.id === (recipe.basket.preset ?? machine?.default_basket));
  const defaults: Record<string, unknown> = {
    'bean.preset': bean?.id,
    'bean.bean_temp_c': reg('model.thermal.room_temperature'),
    'machine.temperature_c': inherited('shot.temperature', machine?.temperature_c),
    'machine.headspace_ml': inherited('model.machine.group_headspace', machine?.headspace_ml),
    'machine.vent_headspace': machine?.vent_headspace ?? false,
    'prep.distribution': 'tap',
    'prep.puck_screen': false,
    'prep.paper_bottom': false,
    'prep.paper_top': false,
    'bean.storage': 'sealed',
    'grinder.family': family?.id,
    'grinder.setting': grinder?.dial.default,
    'grinder.gap_at_ref_um': grinder?.dial.gap_at_ref_um,
    'grinder.gap_per_unit_um': grinder?.dial.gap_per_unit_um,
    'grinder.burr_diameter_mm': grinder?.burr_diameter_mm,
    'grinder.rpm': grinder?.rpm,
  };
  if (bean) for (const [key, value] of Object.entries(bean)) defaults[`bean.${key}`] = value;
  if (basket)
    for (const [key, value] of Object.entries(basket)) defaults[`basket.custom.${key}`] = value;
  for (const [id, path] of Object.entries(ALIASES)) {
    if (path.startsWith('water.')) defaults[path] = reg(id);
    else if (path.startsWith('grinder.')) {
      const key = path.slice(8) as keyof NonNullable<typeof family>['psd'];
      defaults[path] = inherited(id, grinder?.psd?.[key] ?? family?.psd[key]);
    }
  }
  defaults['grinder.fines_at_340_pct'] =
    grinder?.psd?.fines_at_340_pct ?? family?.psd.fines_at_340_pct;
  const pump = recipe.machine.pump ?? machine?.pump ?? { type: 'ideal' };
  defaults['machine.pump.type'] = pump.type;
  for (const [id, path] of Object.entries(ALIASES).filter(([, path]) =>
    path.startsWith('machine.pump.'),
  )) {
    const key = path.slice(13);
    const presetPump = machine?.pump?.type === pump.type ? machine.pump : undefined;
    defaults[path] = inherited(
      id,
      (presetPump as unknown as Record<string, number> | undefined)?.[key],
    );
  }
  defaults['machine.pump.opv_bar'] = pump.type === 'vibratory' ? pump.opv_bar : undefined;
  defaults['basket.custom.open_area_fraction'] = inherited(
    'model.basket.open_area_fraction',
    basket?.open_area_fraction,
  );
  defaults['basket.custom.discharge_coefficient'] = inherited(
    'model.basket.pressurised_discharge_coefficient',
    basket?.discharge_coefficient,
  );
  const value = (path: string): SetupValue | undefined =>
    primitive(
      path === 'grinder.family' ? family?.id : (readSetupValue(recipe, path) ?? defaults[path]),
    );
  const addNumber = (path: string, meta: FieldMeta, fallback?: number, reason?: string) => {
    const scale = 10 ** (meta.shift ?? 0);
    const min = meta.min === undefined ? undefined : meta.min / scale;
    const max = meta.max === undefined ? undefined : meta.max / scale;
    const lo =
      meta.minExclusive && min != null ? min + Math.max(Number.MIN_VALUE, (max ?? 1) * 1e-9) : min;
    out.push({
      path,
      label: meta.label,
      unit: meta.shift ? 'fraction' : meta.unit,
      kind: 'number',
      value: value(path) ?? fallback,
      min: lo,
      max,
      step: meta.integer ? 1 : undefined,
      group: GROUPS[path.split('.')[0]],
      modeled: !reason,
      reason,
    });
  };
  for (const [path, meta] of Object.entries(FIELDS)) {
    if (
      path.startsWith('stop.') ||
      path.startsWith('numerics.') ||
      path.includes('.profile_mm.') ||
      path.startsWith('grinder.psd.')
    )
      continue;
    if (path.startsWith('basket.custom.') && !basket) continue;
    if (
      path.startsWith('machine.pump.') &&
      (pump.type === 'ideal' ? !path.includes('.max_') : path.includes('.max_'))
    )
      continue;
    let reason: string | undefined;
    if (
      ['grinder.burr_diameter_mm', 'grinder.rpm', 'bean.altitude_m', 'prep.tamp_kgf'].includes(path)
    )
      reason = 'Recorded only; this setting has no physical effect in the current model.';
    if (path.startsWith('grinder.') && recipe.grinder.psd)
      reason = 'The measured particle distribution replaces the grinder model.';
    if (
      ['grinder.gap_at_ref_um', 'grinder.gap_per_unit_um'].includes(path) &&
      recipe.grinder.gap_um != null
    )
      reason = 'An explicit burr gap replaces the dial calibration.';
    if (path === 'grinder.gap_um' && recipe.grinder.gap_um == null)
      reason =
        'The current setup uses a dial. Choose explicit gap in the equipment editor to infer a gap instead.';
    if (path === 'basket.custom.pressurised_orifice_mm' && !basket?.pressurised_orifice_mm)
      reason = 'Choose a dual-wall outlet before inferring its orifice.';
    if (path === 'basket.custom.discharge_coefficient' && !basket?.pressurised_orifice_mm)
      reason = 'Only active for a dual-wall outlet.';
    addNumber(path, meta, undefined, reason);
  }
  if (
    !recipe.grinder.psd &&
    recipe.grinder.gap_um == null &&
    (grinder || recipe.grinder.setting != null)
  ) {
    out.push({
      path: 'grinder.setting',
      label: 'Grinder setting',
      unit: '',
      kind: 'number',
      value: value('grinder.setting'),
      min: grinder?.dial.min,
      max: grinder?.dial.max,
      group: 'Grinder',
      modeled: true,
    });
  }
  const addChoice = (path: string, label: string, choices: SetupValue[], reason?: string) =>
    out.push({
      path,
      label,
      unit: '',
      kind: typeof choices[0] === 'boolean' ? ('boolean' as const) : ('category' as const),
      value: value(path),
      choices,
      group: GROUPS[path.split('.')[0]],
      modeled: !reason,
      reason,
    });
  addChoice('bean.process', 'Coffee process', [...BEAN_PROCESSES]);
  addChoice('bean.storage', 'Bean storage', [...BEAN_STORAGE]);
  addChoice(
    'bean.variety_group',
    'Variety',
    [...BEAN_VARIETIES],
    'Recorded only; no physical effect in the current model.',
  );
  addChoice(
    'grinder.family',
    'Burr family',
    catalog.presets.grinder_families.map((p) => p.id),
    recipe.grinder.psd ? 'A measured particle distribution fixes the grinder output.' : undefined,
  );
  addChoice('prep.distribution', 'Distribution', [...DISTRIBUTIONS]);
  for (const field of ['puck_screen', 'paper_bottom', 'paper_top'])
    addChoice(
      `prep.${field}`,
      field === 'puck_screen'
        ? 'Puck screen'
        : field === 'paper_bottom'
          ? 'Bottom paper'
          : 'Top paper',
      [false, true],
      field === 'paper_top' ? 'Recorded only; no physical effect in the current model.' : undefined,
    );
  addChoice('machine.vent_headspace', 'Three-way valve vents after stop', [false, true]);
  addChoice('machine.pump.type', 'Pump type', ['ideal', 'vibratory']);
  for (const [path, label, choices] of [
    ['bean.preset', 'Coffee preset', catalog.presets.beans.map((p) => p.id)],
    ['grinder.preset', 'Grinder preset', catalog.presets.grinders.map((p) => p.id)],
    ['basket.preset', 'Basket preset', catalog.presets.baskets.map((p) => p.id)],
    ['machine.preset', 'Machine preset', catalog.presets.machines.map((p) => p.id)],
  ] as [string, string, string[]][])
    addChoice(path, label, choices);
  const profile = recipe.machine.profile ?? machine?.program ?? [];
  profile.forEach((phase, i) => {
    for (const field of [
      'target',
      'ramp_s',
      'limit',
      'until_time_s',
      'until_beverage_g',
      'until_pressure_bar',
    ] as PhaseField[]) {
      if (field === 'target' && phase.control === 'pump') continue;
      const v = phase[field] ?? (field === 'ramp_s' ? reg('model.machine.ramp_time') : undefined);
      if (v == null) continue;
      const meta = phaseFieldMeta(field, phase.control);
      addNumber(
        `machine.profile.${i}.${field}`,
        { ...meta, label: `Phase ${i + 1} ${meta.label.toLowerCase()}` },
        v,
      );
    }
  });
  basket?.profile_mm.forEach((point, i) =>
    point.forEach((v, j) => {
      const meta = FIELDS[`basket.custom.profile_mm.${j ? 'diameter' : 'height'}`];
      addNumber(
        `basket.custom.profile_mm.${i}.${j}`,
        { ...meta, label: `Basket point ${i + 1} ${meta.label.toLowerCase()}` },
        v,
      );
    }),
  );
  recipe.grinder.psd?.diameter_um.forEach((v, i) =>
    addNumber(
      `grinder.psd.diameter_um.${i}`,
      { ...FIELDS['grinder.psd.diameter_um'], label: `Particle bin ${i + 1} diameter` },
      v,
    ),
  );
  recipe.grinder.psd?.volume_fraction.forEach((v, i) =>
    addNumber(
      `grinder.psd.volume_fraction.${i}`,
      { label: `Particle bin ${i + 1} weight`, unit: 'relative', min: 0 },
      v,
    ),
  );
  for (const parameter of catalog.registry.parameters) {
    const path = `overrides.${parameter.id}`;
    const bounds = registryBounds(parameter);
    let reason = ALIASES[parameter.id]
      ? `Use ${ALIASES[parameter.id]} to change this physical parameter; its registry alias is not a second independent control.`
      : undefined;
    if (
      /numerics|resolution|size.classes|depth.cells|kernel.shells|output.interval|snapshot|model\.stop\./.test(
        parameter.id,
      )
    )
      reason = 'Numerical accuracy and replay stop conditions are fixed by the solver.';
    let resolved = recipe.overrides?.[parameter.id] ?? parameter.default;
    if (parameter.id === 'model.thermal.hardware_temperature')
      resolved = inherited(parameter.id, machine?.preheat_temp_c)!;
    if (parameter.id === 'model.machine.drip_time_constant')
      resolved = inherited(parameter.id, machine?.drip_tau_s)!;
    if (parameter.id === 'psd.fines_mode')
      resolved = inherited(parameter.id, grinder?.psd?.fines_mode_um ?? family?.psd.fines_mode_um)!;
    if (
      parameter.id === 'bed.porosity.intraparticle' &&
      recipe.overrides?.[parameter.id] == null &&
      parameter.default_from !== 'calibration'
    ) {
      const roast = recipe.bean.roast_level ?? bean?.roast_level ?? 0.5;
      resolved = Math.max(
        0.2,
        Math.min(
          0.8,
          reg('model.bean.intraparticle_porosity_medium')! +
            reg('model.bean.intraparticle_porosity_roast_slope')! * (roast - 0.5),
        ),
      );
    }
    out.push({
      path,
      label: parameter.name,
      unit: parameter.units,
      kind: 'number',
      value: resolved,
      ...bounds,
      logarithmic:
        bounds.min != null && bounds.max != null && bounds.min > 0 && bounds.max / bounds.min > 100,
      group: 'Advanced model',
      modeled: !reason,
      reason:
        reason ??
        'Conditional model parameter: an unused override cannot identify a physical property. The solver reports uninformative coordinates.',
    });
  }
  return out;
}

export const buildParameterCatalog = inferenceParameters;
