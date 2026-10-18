// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The recipe editor's state and its conversion to and from a Recipe
 * (`puckworks.recipe/1`, docs/model/m1-contract.md).
 *
 * The form keeps numbers as typed text, so partial input ("1.", "1e-") can be
 * shown and corrected, and it keeps the values of every mode (a grinder preset,
 * a burr family and a pasted PSD; a basket preset and a custom profile; the
 * preset's program and a custom one), so switching modes loses nothing. Only
 * the active mode reaches the recipe. Empty optional fields are left out of the
 * recipe, so the preset, the bean model or the registry supplies them.
 *
 * Error keys are recipe paths with numeric indices: `prep.dose_g`,
 * `basket.custom.profile_mm.2.0`, `machine.profile.1.target`,
 * `overrides.extraction.max_yield`. The builder's own messages use the same
 * paths (see `builderErrorPath`), so both kinds land next to the same input.
 */
import {
  BEAN_PROCESSES,
  BEAN_STORAGE,
  BEAN_VARIETIES,
  DISTRIBUTIONS,
  PHASE_CONTROLS,
  PSD_METHODS,
  RECIPE_SCHEMA,
  type BasketCustom,
  type BeanInput,
  type BeanProcess,
  type BeanStorage,
  type BeanVariety,
  type Catalog,
  type Distribution,
  type GrinderInput,
  type GrinderPreset,
  type MachineInput,
  type PhaseControl,
  type PhaseInput,
  type PsdMethod,
  type PumpInput,
  type Recipe,
} from '../engine/shotTypes';
import { parseDecimal } from '../lab/sphereForm';
import { checkProfile } from './basketGeometry';
import { formatPsdText, parsePsdText } from './psdParse';
import {
  FIELDS,
  inRange,
  invalidMessage,
  phaseFieldMeta,
  requiredMessage,
  type FieldMeta,
  type PhaseField,
} from './recipeFields';

// ---------------------------------------------------------------- form state

export type GrinderMode = 'preset' | 'family' | 'psd';
/** How the gap is set with a preset or family: by dial setting or directly. */
export type GrindBy = 'setting' | 'gap';
export type BasketMode = 'preset' | 'custom' | 'machine';
export type PumpMode = 'preset' | 'ideal' | 'vibratory';

export interface ProfileRow {
  /** Stable React key. */
  key: string;
  height: string;
  diameter: string;
}

export interface PhaseForm {
  key: string;
  control: PhaseControl;
  target: string;
  ramp_s: string;
  limit: string;
  until_time_s: string;
  until_beverage_g: string;
  until_pressure_bar: string;
}

export const PHASE_FIELDS: readonly PhaseField[] = [
  'target',
  'ramp_s',
  'limit',
  'until_time_s',
  'until_beverage_g',
  'until_pressure_bar',
];

export const WATER_FIELDS = [
  'alkalinity_mg_l_caco3',
  'hardness_mg_l_caco3',
  'calcium_mg_l',
  'magnesium_mg_l',
  'tds_mg_l',
  'ph',
] as const;
export const CHEMISTRY_FIELDS = [
  'aroma_age_s',
  'cup_headspace_ml',
  'sample_temperature_c',
] as const;

export interface RecipeForm {
  bean: {
    /** '' = the default bean preset. */
    preset: string;
    /** Displayed in percent. */
    arabica_fraction: string;
    roast_level: string;
    days_off_roast: string;
    process: '' | BeanProcess;
    bean_temp_c: string;
    altitude_m: string;
    variety_group: '' | BeanVariety;
    storage: '' | BeanStorage;
  };
  water: Record<keyof NonNullable<Recipe['water']>, string>;
  chemistry: {
    enabled: '' | 'yes' | 'no';
    aroma_age_s: string;
    cup_headspace_ml: string;
    sample_temperature_c: string;
    mineral_blank_subtracted: '' | 'yes' | 'no';
  };
  grinder: {
    mode: GrinderMode;
    by: GrindBy;
    preset: string;
    family: string;
    setting: string;
    gap_um: string;
    psdText: string;
    psdMethod: '' | PsdMethod;
    gap_at_ref_um: string;
    gap_per_unit_um: string;
    x50_gap_ratio: string;
    fines_at_340_pct: string;
    coarse_log_width: string;
    /** Displayed in percent. */
    boulder_weight: string;
    burr_diameter_mm: string;
    rpm: string;
  };
  basket: {
    mode: BasketMode;
    preset: string;
    profile: ProfileRow[];
    perforated_diameter_mm: string;
    /** Displayed in percent. */
    open_area_fraction: string;
    outlet: 'holes' | 'pressurised';
    pressurised_orifice_mm: string;
    discharge_coefficient: string;
  };
  prep: {
    dose_g: string;
    distribution: '' | Distribution;
    tamp_kgf: string;
    puck_screen: boolean;
    paper_bottom: boolean;
    paper_top: boolean;
  };
  machine: {
    /** '' = no preset: the program (and pump) are described here. */
    preset: string;
    temperature_c: string;
    /** Use `phases` instead of the preset's program. */
    customProgram: boolean;
    phases: PhaseForm[];
    pumpMode: PumpMode;
    max_flow_ml_s: string;
    max_pressure_bar: string;
    free_flow_ml_s: string;
    stall_pressure_bar: string;
    opv_bar: string;
    headspace_ml: string;
    /** '' follows the preset; 'yes' or 'no' is your own choice. */
    vent_headspace: '' | 'yes' | 'no';
  };
  stop: { beverage_g: string; time_s: string };
  numerics: { tier: '0' | '1'; size_classes: string };
  /** Registry id → value as typed, in the registry's units. */
  overrides: Record<string, string>;
}

let keyCounter = 0;

/** A fresh key for a list row. */
export function nextKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}${keyCounter}`;
}

export function profileRow(height: string, diameter: string): ProfileRow {
  return { key: nextKey('row'), height, diameter };
}

export function phaseForm(patch: Partial<Omit<PhaseForm, 'key'>> = {}): PhaseForm {
  return {
    key: nextKey('phase'),
    control: 'pressure',
    target: '',
    ramp_s: '',
    limit: '',
    until_time_s: '',
    until_beverage_g: '',
    until_pressure_bar: '',
    ...patch,
  };
}

/**
 * The default recipe: generic gear (PLAN §1.2 principle 7: no one's own gear
 * is the default). Every preset it names is in the presets document.
 */
export const DEFAULT_RECIPE: Recipe = {
  schema: RECIPE_SCHEMA,
  bean: { preset: 'medium-washed-arabica' },
  // The preset's own default gap: published espresso fineness by particle size,
  // not tuned to the model's shot times (a test keeps the two equal).
  grinder: { preset: 'generic-flat-traditional-64', setting: 190 },
  basket: { preset: '58-precision-18g' },
  prep: { dose_g: 18, distribution: 'wdt' },
  machine: { preset: 'flat-9-bar' },
  stop: { beverage_g: 36 },
  numerics: { tier: 1 },
};

/** A form with every field empty and sensible starting values for the inactive modes. */
export function emptyForm(): RecipeForm {
  return {
    bean: {
      preset: '',
      arabica_fraction: '',
      roast_level: '',
      days_off_roast: '',
      process: '',
      bean_temp_c: '',
      altitude_m: '',
      variety_group: '',
      storage: '',
    },
    water: {
      alkalinity_mg_l_caco3: '',
      hardness_mg_l_caco3: '',
      calcium_mg_l: '',
      magnesium_mg_l: '',
      tds_mg_l: '',
      ph: '',
    },
    chemistry: {
      enabled: '',
      aroma_age_s: '',
      cup_headspace_ml: '',
      sample_temperature_c: '',
      mineral_blank_subtracted: '',
    },
    grinder: {
      mode: 'preset',
      by: 'setting',
      preset: '',
      family: 'flat-traditional',
      setting: '',
      gap_um: '',
      psdText: '',
      psdMethod: '',
      gap_at_ref_um: '',
      gap_per_unit_um: '',
      x50_gap_ratio: '',
      fines_at_340_pct: '',
      coarse_log_width: '',
      boulder_weight: '',
      burr_diameter_mm: '',
      rpm: '',
    },
    basket: {
      mode: 'preset',
      preset: '',
      // A typical straight-walled 58 mm basket, as a starting point for a custom one.
      profile: [profileRow('0', '54'), profileRow('5', '58'), profileRow('22', '58.5')],
      perforated_diameter_mm: '50',
      open_area_fraction: '',
      outlet: 'holes',
      pressurised_orifice_mm: '0.4',
      discharge_coefficient: '',
    },
    prep: {
      dose_g: '',
      distribution: '',
      tamp_kgf: '',
      puck_screen: false,
      paper_bottom: false,
      paper_top: false,
    },
    machine: {
      preset: '',
      temperature_c: '',
      customProgram: false,
      phases: [phaseForm({ control: 'pressure', target: '9', ramp_s: '2' })],
      pumpMode: 'preset',
      max_flow_ml_s: '',
      max_pressure_bar: '',
      free_flow_ml_s: '',
      stall_pressure_bar: '',
      opv_bar: '',
      headspace_ml: '',
      vent_headspace: '',
    },
    stop: { beverage_g: '', time_s: '' },
    numerics: { tier: '1', size_classes: '' },
    overrides: {},
  };
}

/** The editor's starting state: the default recipe. */
export function defaultForm(): RecipeForm {
  const result = recipeToForm(DEFAULT_RECIPE);
  if (!result.ok) throw new Error(`the default recipe is invalid: ${result.error}`);
  return result.form;
}

// ---------------------------------------------------------------- numbers

/**
 * `value` × 10^power as display text, exactly: the shortest decimal of `value`
 * with its exponent moved, so 0.9 with power 2 is "90" (not 90.00000000000001)
 * and converting back with `parseDecimal(text, -power)` gives `value` again.
 */
export function shiftedText(value: number, power = 0): string {
  if (power === 0) return String(value);
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) return String(value);
  return String(Number(`${match[1]}e${Number(match[2] ?? 0) + power}`));
}

/** A recipe number as form text in the field's display units. */
function displayText(value: number | null | undefined, meta?: FieldMeta): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return shiftedText(value, meta?.shift ?? 0);
}

// ---------------------------------------------------------------- form → recipe

export type FormErrors = Record<string, string>;

export type FormResult =
  | { ok: true; recipe: Recipe; notes: string[] }
  | { ok: false; errors: FormErrors; notes: string[] };

export interface ValidationContext {
  /** Presets and registry; without them, preset ids and overrides are not checked here. */
  catalog?: Catalog | null;
}

class Collector {
  readonly errors: FormErrors = {};
  readonly notes: string[] = [];

  error(path: string, message: string): void {
    this.errors[path] ??= message;
  }

  /** Parses an optional number; undefined when empty or invalid (invalid is recorded). */
  optional(
    path: string,
    text: string,
    meta: FieldMeta | undefined = FIELDS[path],
  ): number | undefined {
    if (text.trim() === '') return undefined;
    return this.parse(path, text, meta);
  }

  /** Parses a required number; undefined when empty or invalid (both recorded). */
  required(
    path: string,
    text: string,
    meta: FieldMeta | undefined = FIELDS[path],
  ): number | undefined {
    if (text.trim() === '') {
      this.error(path, meta ? requiredMessage(meta) : 'Enter a number.');
      return undefined;
    }
    return this.parse(path, text, meta);
  }

  private parse(path: string, text: string, meta: FieldMeta | undefined): number | undefined {
    const value = parseDecimal(text, -(meta?.shift ?? 0));
    const shown = parseDecimal(text);
    if (value === null || shown === null || (meta && !inRange(meta, shown))) {
      this.error(path, meta ? invalidMessage(meta) : 'Enter a number.');
      return undefined;
    }
    return value;
  }
}

function presetExists(
  catalog: Catalog | null | undefined,
  kind: 'beans' | 'grinders' | 'grinder_families' | 'baskets' | 'machines',
  id: string,
): boolean {
  return !catalog || catalog.presets[kind].some((p) => p.id === id);
}

/** Converts the form to a recipe, or reports every invalid field. */
export function formToRecipe(form: RecipeForm, context: ValidationContext = {}): FormResult {
  const c = new Collector();
  const catalog = context.catalog;
  const unknownPreset = (path: string, id: string) =>
    c.error(path, `Unknown preset "${id}": it is not in this version's presets.`);

  // Bean.
  const bean: BeanInput = {};
  const b = form.bean;
  if (b.preset) {
    if (!presetExists(catalog, 'beans', b.preset)) unknownPreset('bean.preset', b.preset);
    bean.preset = b.preset;
  }
  const setNumber = <T extends object>(target: T, key: keyof T & string, value?: number) => {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  };
  setNumber(bean, 'arabica_fraction', c.optional('bean.arabica_fraction', b.arabica_fraction));
  setNumber(bean, 'roast_level', c.optional('bean.roast_level', b.roast_level));
  setNumber(bean, 'days_off_roast', c.optional('bean.days_off_roast', b.days_off_roast));
  if (b.process) bean.process = b.process;
  setNumber(bean, 'bean_temp_c', c.optional('bean.bean_temp_c', b.bean_temp_c));
  setNumber(bean, 'altitude_m', c.optional('bean.altitude_m', b.altitude_m));
  if (b.variety_group) bean.variety_group = b.variety_group;
  if (b.storage) bean.storage = b.storage;

  const water: NonNullable<Recipe['water']> = {};
  for (const key of WATER_FIELDS) {
    setNumber(water, key, c.optional(`water.${key}`, form.water[key]));
  }
  const chemistry: NonNullable<Recipe['chemistry']> = {};
  if (form.chemistry.enabled !== '') chemistry.enabled = form.chemistry.enabled === 'yes';
  for (const key of CHEMISTRY_FIELDS) {
    setNumber(chemistry, key, c.optional(`chemistry.${key}`, form.chemistry[key]));
  }
  if (form.chemistry.mineral_blank_subtracted !== '') {
    chemistry.mineral_blank_subtracted = form.chemistry.mineral_blank_subtracted === 'yes';
  }

  // Grinder.
  const grinder: GrinderInput = {};
  const g = form.grinder;
  if (g.mode === 'psd') {
    const parsed = parsePsdText(g.psdText);
    const diameterMeta = FIELDS['grinder.psd.diameter_um'];
    const outside = parsed.ok
      ? parsed.diameter_um.find((d) => !inRange(diameterMeta, d))
      : undefined;
    if (parsed.ok && outside !== undefined) {
      c.error('grinder.psd', `${outside} µm: ${invalidMessage(diameterMeta)}`);
    } else if (parsed.ok) {
      grinder.psd = { diameter_um: parsed.diameter_um, volume_fraction: parsed.volume_fraction };
      if (g.psdMethod) grinder.psd.method = g.psdMethod;
      c.notes.push(...parsed.notes.map((n) => `Measured PSD: ${n}`));
    } else {
      c.error('grinder.psd', parsed.error);
    }
  } else {
    if (g.mode === 'preset') {
      if (!g.preset) c.error('grinder.preset', 'Choose a grinder preset.');
      else if (!presetExists(catalog, 'grinders', g.preset))
        unknownPreset('grinder.preset', g.preset);
      else grinder.preset = g.preset;
    } else {
      if (!g.family) c.error('grinder.family', 'Choose a burr family.');
      else if (!presetExists(catalog, 'grinder_families', g.family)) {
        unknownPreset('grinder.family', g.family);
      } else grinder.family = g.family;
    }
    if (g.by === 'gap') {
      setNumber(grinder, 'gap_um', c.required('grinder.gap_um', g.gap_um));
    } else {
      const settingMeta: FieldMeta = { label: 'Dial setting', unit: '' };
      // With a preset an empty setting means the dial's default; with a family it is required.
      const setting =
        g.mode === 'family'
          ? c.required('grinder.setting', g.setting, settingMeta)
          : c.optional('grinder.setting', g.setting, settingMeta);
      setNumber(grinder, 'setting', setting);
      const calibration = g.mode === 'family' ? c.required.bind(c) : c.optional.bind(c);
      setNumber(grinder, 'gap_at_ref_um', calibration('grinder.gap_at_ref_um', g.gap_at_ref_um));
      setNumber(
        grinder,
        'gap_per_unit_um',
        calibration('grinder.gap_per_unit_um', g.gap_per_unit_um),
      );
    }
    setNumber(grinder, 'x50_gap_ratio', c.optional('grinder.x50_gap_ratio', g.x50_gap_ratio));
    setNumber(
      grinder,
      'fines_at_340_pct',
      c.optional('grinder.fines_at_340_pct', g.fines_at_340_pct),
    );
    setNumber(
      grinder,
      'coarse_log_width',
      c.optional('grinder.coarse_log_width', g.coarse_log_width),
    );
    setNumber(grinder, 'boulder_weight', c.optional('grinder.boulder_weight', g.boulder_weight));
    setNumber(
      grinder,
      'burr_diameter_mm',
      c.optional('grinder.burr_diameter_mm', g.burr_diameter_mm),
    );
    setNumber(grinder, 'rpm', c.optional('grinder.rpm', g.rpm));
  }

  // Basket.
  const basket: Recipe['basket'] = {};
  const k = form.basket;
  if (k.mode === 'preset') {
    if (!k.preset) c.error('basket.preset', 'Choose a basket preset.');
    else if (!presetExists(catalog, 'baskets', k.preset)) unknownPreset('basket.preset', k.preset);
    else basket.preset = k.preset;
  } else if (k.mode === 'custom') {
    const custom = customBasket(c, k);
    if (custom) basket.custom = custom;
  }

  // Puck preparation.
  const p = form.prep;
  const dose = c.required('prep.dose_g', p.dose_g);
  const prep: Recipe['prep'] = { dose_g: dose ?? Number.NaN };
  if (p.distribution) prep.distribution = p.distribution;
  setNumber(prep, 'tamp_kgf', c.optional('prep.tamp_kgf', p.tamp_kgf));
  if (p.puck_screen) prep.puck_screen = true;
  if (p.paper_bottom) prep.paper_bottom = true;
  if (p.paper_top) prep.paper_top = true;

  // Machine.
  const machine = machineInput(c, form.machine, catalog);

  // Stop rule and numerics.
  const stop: Recipe['stop'] = {};
  setNumber(stop, 'beverage_g', c.optional('stop.beverage_g', form.stop.beverage_g));
  setNumber(stop, 'time_s', c.optional('stop.time_s', form.stop.time_s));
  const numerics: NonNullable<Recipe['numerics']> = { tier: form.numerics.tier === '0' ? 0 : 1 };
  setNumber(
    numerics,
    'size_classes',
    c.optional('numerics.size_classes', form.numerics.size_classes),
  );

  // Sandbox overrides.
  const overrides: Record<string, number> = {};
  for (const [id, text] of Object.entries(form.overrides)) {
    if (text.trim() === '') continue;
    const path = `overrides.${id}`;
    const record = catalog?.registry.parameters.find((r) => r.id === id);
    if (catalog && !record) {
      c.error(path, `Unknown parameter "${id}": it is not in this version's registry.`);
      continue;
    }
    const meta: FieldMeta = {
      label: record?.name ?? id,
      unit: record?.units === '1' ? '' : (record?.units ?? ''),
      min: record?.range.min,
      max: record?.range.max,
    };
    const value = c.required(path, text, meta);
    if (value !== undefined) overrides[id] = value;
  }

  const recipe: Recipe = {
    schema: RECIPE_SCHEMA,
    bean,
    grinder,
    basket,
    prep,
    machine,
    stop,
    numerics,
  };
  if (Object.keys(overrides).length > 0) recipe.overrides = overrides;
  if (Object.keys(water).length > 0) recipe.water = water;
  if (Object.keys(chemistry).length > 0) recipe.chemistry = chemistry;
  if (Object.keys(c.errors).length > 0) return { ok: false, errors: c.errors, notes: c.notes };
  return { ok: true, recipe, notes: c.notes };
}

function customBasket(c: Collector, k: RecipeForm['basket']): BasketCustom | null {
  const heightMeta = FIELDS['basket.custom.profile_mm.height'];
  const diameterMeta = FIELDS['basket.custom.profile_mm.diameter'];
  const profile: [number, number][] = k.profile.map((row, i) => [
    c.required(`basket.custom.profile_mm.${i}.0`, row.height, heightMeta) ?? Number.NaN,
    c.required(`basket.custom.profile_mm.${i}.1`, row.diameter, diameterMeta) ?? Number.NaN,
  ]);
  const perforated =
    c.required('basket.custom.perforated_diameter_mm', k.perforated_diameter_mm) ?? Number.NaN;
  const openArea = c.optional('basket.custom.open_area_fraction', k.open_area_fraction);
  const pressurised = k.outlet === 'pressurised';
  const orifice = pressurised
    ? (c.required('basket.custom.pressurised_orifice_mm', k.pressurised_orifice_mm) ?? Number.NaN)
    : null;
  const cd = pressurised
    ? c.optional('basket.custom.discharge_coefficient', k.discharge_coefficient)
    : undefined;

  const problems = checkProfile(profile, perforated, orifice);
  if (problems.profile) c.error('basket.custom.profile_mm', problems.profile);
  for (const [index, row] of Object.entries(problems.rows)) {
    if (row.height) c.error(`basket.custom.profile_mm.${index}.0`, row.height);
    if (row.diameter) c.error(`basket.custom.profile_mm.${index}.1`, row.diameter);
  }
  if (problems.perforated) c.error('basket.custom.perforated_diameter_mm', problems.perforated);
  if (problems.orifice) c.error('basket.custom.pressurised_orifice_mm', problems.orifice);

  const custom: BasketCustom = { profile_mm: profile, perforated_diameter_mm: perforated };
  if (openArea !== undefined) custom.open_area_fraction = openArea;
  if (orifice !== null) custom.pressurised_orifice_mm = orifice;
  if (cd !== undefined) custom.discharge_coefficient = cd;
  return custom;
}

function machineInput(
  c: Collector,
  m: RecipeForm['machine'],
  catalog: Catalog | null | undefined,
): MachineInput {
  const machine: MachineInput = {};
  if (m.preset) {
    if (!presetExists(catalog, 'machines', m.preset)) {
      c.error(
        'machine.preset',
        `Unknown preset "${m.preset}": it is not in this version's presets.`,
      );
    } else machine.preset = m.preset;
  }
  const temperature = c.optional('machine.temperature_c', m.temperature_c);
  if (temperature !== undefined) machine.temperature_c = temperature;
  if (m.customProgram || !m.preset) {
    if (m.phases.length === 0) c.error('machine.profile', 'Add at least one phase.');
    machine.profile = m.phases.map((phase, i) => phaseInput(c, phase, i, m.phases.length));
  }
  if (m.pumpMode === 'ideal') {
    const pump: PumpInput = { type: 'ideal' };
    const flow = c.optional('machine.pump.max_flow_ml_s', m.max_flow_ml_s);
    const pressure = c.optional('machine.pump.max_pressure_bar', m.max_pressure_bar);
    if (flow !== undefined) pump.max_flow_ml_s = flow;
    if (pressure !== undefined) pump.max_pressure_bar = pressure;
    machine.pump = pump;
  } else if (m.pumpMode === 'vibratory') {
    const pump: PumpInput = { type: 'vibratory' };
    const free = c.optional('machine.pump.free_flow_ml_s', m.free_flow_ml_s);
    const stall = c.optional('machine.pump.stall_pressure_bar', m.stall_pressure_bar);
    const opv = c.optional('machine.pump.opv_bar', m.opv_bar);
    if (free !== undefined) pump.free_flow_ml_s = free;
    if (stall !== undefined) pump.stall_pressure_bar = stall;
    if (opv !== undefined) pump.opv_bar = opv;
    machine.pump = pump;
  }
  const headspace = c.optional('machine.headspace_ml', m.headspace_ml);
  if (headspace !== undefined) machine.headspace_ml = headspace;
  // Sent only when chosen, so a builder without the field still accepts the recipe.
  if (m.vent_headspace !== '') machine.vent_headspace = m.vent_headspace === 'yes';
  return machine;
}

function phaseInput(c: Collector, phase: PhaseForm, i: number, count: number): PhaseInput {
  const out: PhaseInput = { control: phase.control };
  const path = (field: string) => `machine.profile.${i}.${field}`;
  const meta = (field: PhaseField) => phaseFieldMeta(field, phase.control);
  if (phase.control !== 'pump') {
    const target = c.required(path('target'), phase.target, meta('target'));
    if (target !== undefined) out.target = target;
    const limit = c.optional(path('limit'), phase.limit, meta('limit'));
    if (limit !== undefined) out.limit = limit;
  }
  const ramp = c.optional(path('ramp_s'), phase.ramp_s, meta('ramp_s'));
  if (ramp !== undefined) out.ramp_s = ramp;
  let exits = 0;
  for (const field of ['until_time_s', 'until_beverage_g', 'until_pressure_bar'] as const) {
    const value = c.optional(path(field), phase[field], meta(field));
    if (value !== undefined) {
      out[field] = value;
      exits += 1;
    }
  }
  const hasExitText = [phase.until_time_s, phase.until_beverage_g, phase.until_pressure_bar].some(
    (t) => t.trim() !== '',
  );
  if (i < count - 1 && exits === 0 && !hasExitText) {
    c.error(
      `machine.profile.${i}`,
      'Only the last phase may run without an end condition: give a time, a beverage mass or a pressure.',
    );
  }
  return out;
}

// ---------------------------------------------------------------- recipe → form

export type ImportResult =
  { ok: true; form: RecipeForm; warnings: string[] } | { ok: false; error: string };

const KNOWN_KEYS: Record<string, readonly string[]> = {
  '': [
    'schema',
    'bean',
    'water',
    'chemistry',
    'grinder',
    'basket',
    'prep',
    'machine',
    'stop',
    'numerics',
    'overrides',
  ],
  bean: [
    'preset',
    'arabica_fraction',
    'roast_level',
    'days_off_roast',
    'process',
    'bean_temp_c',
    'altitude_m',
    'variety_group',
    'storage',
  ],
  water: [
    'alkalinity_mg_l_caco3',
    'hardness_mg_l_caco3',
    'calcium_mg_l',
    'magnesium_mg_l',
    'tds_mg_l',
    'ph',
  ],
  chemistry: [
    'enabled',
    'aroma_age_s',
    'cup_headspace_ml',
    'sample_temperature_c',
    'mineral_blank_subtracted',
  ],
  grinder: [
    'preset',
    'setting',
    'family',
    'gap_um',
    'psd',
    'burr_diameter_mm',
    'rpm',
    'gap_at_ref_um',
    'gap_per_unit_um',
    'x50_gap_ratio',
    'fines_at_340_pct',
    'coarse_log_width',
    'boulder_weight',
  ],
  'grinder.psd': ['diameter_um', 'volume_fraction', 'method'],
  basket: ['preset', 'custom'],
  'basket.custom': [
    'profile_mm',
    'perforated_diameter_mm',
    'open_area_fraction',
    'pressurised_orifice_mm',
    'discharge_coefficient',
  ],
  prep: ['dose_g', 'distribution', 'tamp_kgf', 'puck_screen', 'paper_bottom', 'paper_top'],
  machine: ['preset', 'temperature_c', 'profile', 'pump', 'headspace_ml', 'vent_headspace'],
  'machine.pump': [
    'type',
    'max_flow_ml_s',
    'max_pressure_bar',
    'free_flow_ml_s',
    'stall_pressure_bar',
    'opv_bar',
  ],
  phase: ['control', ...PHASE_FIELDS],
  stop: ['beverage_g', 'time_s'],
  numerics: ['tier', 'size_classes'],
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts a recipe document (e.g. an imported file) to form state. Fields
 * this version of the editor does not know are reported and dropped (the core
 * rejects unknown fields, so a recipe from a newer version may need them).
 */
export function recipeToForm(input: unknown): ImportResult {
  if (!isRecord(input)) return { ok: false, error: 'A recipe must be a JSON object.' };
  if (input.schema !== RECIPE_SCHEMA) {
    return {
      ok: false,
      error: `Not a Puckworks recipe: "schema" must be "${RECIPE_SCHEMA}" (found ${JSON.stringify(input.schema ?? null)}).`,
    };
  }
  const warnings: string[] = [];
  const unknown = (where: string, value: unknown, known: readonly string[]) => {
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        warnings.push(`Ignored the unknown field ${where ? `${where}.` : ''}${key}.`);
      }
    }
  };
  const block = (key: string): Json => {
    const value = input[key];
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) {
      warnings.push(`Ignored "${key}": it must be an object.`);
      return {};
    }
    unknown(key, value, KNOWN_KEYS[key] ?? []);
    return value;
  };
  unknown('', input, KNOWN_KEYS['']);
  const number = (where: string, value: unknown, meta?: FieldMeta): string => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warnings.push(`Ignored ${where}: it must be a number.`);
      return '';
    }
    return displayText(value, meta);
  };
  const text = (where: string, value: unknown): string => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
      warnings.push(`Ignored ${where}: it must be a string.`);
      return '';
    }
    return value;
  };
  const choice = <T extends string>(
    where: string,
    value: unknown,
    options: readonly T[],
  ): '' | T => {
    const t = text(where, value);
    if (t === '') return '';
    if ((options as readonly string[]).includes(t)) return t as T;
    warnings.push(`Ignored ${where}: "${t}" is not one of ${options.join(', ')}.`);
    return '';
  };
  const flag = (where: string, value: unknown): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') {
      warnings.push(`Ignored ${where}: it must be true or false.`);
      return false;
    }
    return value;
  };

  const form = emptyForm();

  const bean = block('bean');
  form.bean = {
    preset: text('bean.preset', bean.preset),
    arabica_fraction: number(
      'bean.arabica_fraction',
      bean.arabica_fraction,
      FIELDS['bean.arabica_fraction'],
    ),
    roast_level: number('bean.roast_level', bean.roast_level),
    days_off_roast: number('bean.days_off_roast', bean.days_off_roast),
    process: choice('bean.process', bean.process, BEAN_PROCESSES),
    bean_temp_c: number('bean.bean_temp_c', bean.bean_temp_c),
    altitude_m: number('bean.altitude_m', bean.altitude_m),
    variety_group: choice('bean.variety_group', bean.variety_group, BEAN_VARIETIES),
    storage: choice('bean.storage', bean.storage, BEAN_STORAGE),
  };

  const water = block('water');
  for (const key of WATER_FIELDS) form.water[key] = number(`water.${key}`, water[key]);
  const chemistry = block('chemistry');
  for (const key of CHEMISTRY_FIELDS)
    form.chemistry[key] = number(`chemistry.${key}`, chemistry[key]);
  if (chemistry.enabled !== undefined && chemistry.enabled !== null) {
    form.chemistry.enabled =
      typeof chemistry.enabled === 'boolean' ? (chemistry.enabled ? 'yes' : 'no') : '';
    if (typeof chemistry.enabled !== 'boolean')
      warnings.push('Ignored chemistry.enabled: it must be true or false.');
  }
  if (
    chemistry.mineral_blank_subtracted !== undefined &&
    chemistry.mineral_blank_subtracted !== null
  ) {
    const blank = flag('chemistry.mineral_blank_subtracted', chemistry.mineral_blank_subtracted);
    form.chemistry.mineral_blank_subtracted =
      typeof chemistry.mineral_blank_subtracted === 'boolean' ? (blank ? 'yes' : 'no') : '';
  }

  const grinder = block('grinder');
  const g = form.grinder;
  g.preset = text('grinder.preset', grinder.preset);
  g.family = text('grinder.family', grinder.family) || g.family;
  g.setting = number('grinder.setting', grinder.setting);
  g.gap_um = number('grinder.gap_um', grinder.gap_um);
  for (const key of GRINDER_ADVANCED) {
    g[key] = number(`grinder.${key}`, grinder[key], FIELDS[`grinder.${key}`]);
  }
  const psd = grinder.psd;
  if (isRecord(psd)) {
    unknown('grinder.psd', psd, KNOWN_KEYS['grinder.psd']);
    const d = Array.isArray(psd.diameter_um) ? psd.diameter_um : [];
    const f = Array.isArray(psd.volume_fraction) ? psd.volume_fraction : [];
    if (d.length !== f.length) {
      warnings.push('grinder.psd: diameter_um and volume_fraction have different lengths.');
    }
    g.psdText = formatPsdText(d as number[], f as number[]);
    g.psdMethod = choice('grinder.psd.method', psd.method, PSD_METHODS);
    g.mode = 'psd';
  } else if (g.preset) {
    g.mode = 'preset';
  } else if (typeof grinder.family === 'string') {
    g.mode = 'family';
  }
  g.by = g.gap_um !== '' ? 'gap' : 'setting';

  const basket = block('basket');
  const k = form.basket;
  k.preset = text('basket.preset', basket.preset);
  const custom = basket.custom;
  if (isRecord(custom)) {
    unknown('basket.custom', custom, KNOWN_KEYS['basket.custom']);
    k.mode = 'custom';
    const rows = Array.isArray(custom.profile_mm) ? custom.profile_mm : [];
    k.profile = rows.map((row: unknown, i) => {
      const pair = Array.isArray(row) ? row : [];
      return profileRow(
        number(`basket.custom.profile_mm[${i}][0]`, pair[0]),
        number(`basket.custom.profile_mm[${i}][1]`, pair[1]),
      );
    });
    k.perforated_diameter_mm = number(
      'basket.custom.perforated_diameter_mm',
      custom.perforated_diameter_mm,
    );
    k.open_area_fraction = number(
      'basket.custom.open_area_fraction',
      custom.open_area_fraction,
      FIELDS['basket.custom.open_area_fraction'],
    );
    const orifice = number('basket.custom.pressurised_orifice_mm', custom.pressurised_orifice_mm);
    k.outlet = orifice === '' ? 'holes' : 'pressurised';
    if (orifice !== '') k.pressurised_orifice_mm = orifice;
    k.discharge_coefficient = number(
      'basket.custom.discharge_coefficient',
      custom.discharge_coefficient,
    );
  } else {
    k.mode = k.preset ? 'preset' : 'machine';
  }

  const prep = block('prep');
  form.prep = {
    dose_g: number('prep.dose_g', prep.dose_g),
    distribution: choice('prep.distribution', prep.distribution, DISTRIBUTIONS),
    tamp_kgf: number('prep.tamp_kgf', prep.tamp_kgf),
    puck_screen: flag('prep.puck_screen', prep.puck_screen),
    paper_bottom: flag('prep.paper_bottom', prep.paper_bottom),
    paper_top: flag('prep.paper_top', prep.paper_top),
  };

  const machine = block('machine');
  const m = form.machine;
  m.preset = text('machine.preset', machine.preset);
  m.temperature_c = number('machine.temperature_c', machine.temperature_c);
  m.headspace_ml = number('machine.headspace_ml', machine.headspace_ml);
  // Unset (or ignored as not a boolean): the preset decides.
  const vent = flag('machine.vent_headspace', machine.vent_headspace);
  m.vent_headspace = typeof machine.vent_headspace === 'boolean' ? (vent ? 'yes' : 'no') : '';
  if (Array.isArray(machine.profile)) {
    m.customProgram = true;
    m.phases = machine.profile.map((raw: unknown, i) => {
      const phase = isRecord(raw) ? raw : {};
      unknown(`machine.profile[${i}]`, phase, KNOWN_KEYS.phase);
      const control = choice(`machine.profile[${i}].control`, phase.control, PHASE_CONTROLS);
      const out = phaseForm({ control: control || 'pressure' });
      for (const field of PHASE_FIELDS)
        out[field] = number(`machine.profile[${i}].${field}`, phase[field]);
      return out;
    });
  } else {
    m.customProgram = !m.preset;
  }
  const pump = machine.pump;
  if (isRecord(pump)) {
    unknown('machine.pump', pump, KNOWN_KEYS['machine.pump']);
    if (pump.type === 'ideal' || pump.type === 'vibratory') {
      m.pumpMode = pump.type;
      for (const key of [
        'max_flow_ml_s',
        'max_pressure_bar',
        'free_flow_ml_s',
        'stall_pressure_bar',
        'opv_bar',
      ] as const) {
        m[key] = number(`machine.pump.${key}`, pump[key]);
      }
    } else {
      warnings.push('Ignored machine.pump: its type must be "ideal" or "vibratory".');
    }
  }

  const stop = block('stop');
  form.stop = {
    beverage_g: number('stop.beverage_g', stop.beverage_g),
    time_s: number('stop.time_s', stop.time_s),
  };

  const numerics = block('numerics');
  if (
    numerics.tier !== undefined &&
    numerics.tier !== null &&
    numerics.tier !== 0 &&
    numerics.tier !== 1
  ) {
    warnings.push('Ignored numerics.tier: it must be 0 or 1.');
  }
  form.numerics = {
    tier: numerics.tier === 0 ? '0' : '1',
    size_classes: number('numerics.size_classes', numerics.size_classes),
  };

  const overrides = input.overrides;
  if (isRecord(overrides)) {
    for (const [id, value] of Object.entries(overrides)) {
      const shown = number(`overrides.${id}`, value);
      if (shown !== '') form.overrides[id] = shown;
    }
  } else if (overrides !== undefined && overrides !== null) {
    warnings.push('Ignored "overrides": it must be an object.');
  }

  return { ok: true, form, warnings };
}

// ---------------------------------------------------------------- helpers

/**
 * A recipe's identity for "are these results for the current inputs?": its
 * JSON without `numerics.tier`, which only says how finely to solve.
 */
export function physicalKey(recipe: Recipe): string {
  const numerics = { ...recipe.numerics };
  delete numerics.tier;
  return JSON.stringify({ ...recipe, numerics });
}

/** The recipe with its tier replaced (the live preview always runs tier 0). */
export function withTier(recipe: Recipe, tier: 0 | 1): Recipe {
  return { ...recipe, numerics: { ...recipe.numerics, tier } };
}

/** Grinder fields that describe one grinder: calibration, PSD shape, burrs. */
export const GRINDER_ADVANCED = [
  'gap_at_ref_um',
  'gap_per_unit_um',
  'x50_gap_ratio',
  'fines_at_340_pct',
  'coarse_log_width',
  'boulder_weight',
  'burr_diameter_mm',
  'rpm',
] as const;

export type GrinderAdvancedField = (typeof GRINDER_ADVANCED)[number];

/** The advanced grinder fields that hold a value. */
export function filledAdvanced(grinder: RecipeForm['grinder']): GrinderAdvancedField[] {
  return GRINDER_ADVANCED.filter((key) => grinder[key].trim() !== '');
}

function clearedAdvanced(): Record<GrinderAdvancedField, string> {
  return Object.fromEntries(GRINDER_ADVANCED.map((k) => [k, ''])) as Record<
    GrinderAdvancedField,
    string
  >;
}

/** Burr gap of a dial setting: g = g_ref + Δ (s − s_ref). */
function dialGap(preset: GrinderPreset, setting: number): number {
  const d = preset.dial;
  return d.gap_at_ref_um + d.gap_per_unit_um * (setting - d.ref);
}

/**
 * The grinder block after choosing another grinder preset. The calibration,
 * PSD-shape and burr overrides described the previous grinder, so they are
 * cleared; the setting moves to the new dial's default.
 */
export function changeGrinderPreset(
  grinder: RecipeForm['grinder'],
  preset: GrinderPreset | undefined,
  id: string,
): RecipeForm['grinder'] {
  return {
    ...grinder,
    ...clearedAdvanced(),
    preset: id,
    setting: preset ? String(preset.dial.default) : '',
  };
}

/**
 * The grinder block after switching between preset, family and measured-PSD
 * descriptions. Calibration and PSD-shape overrides are cleared (they described
 * the grinder of the previous mode). From a preset to a family, the burr gap of
 * the current dial setting is kept; from a family to a preset, the dial setting
 * nearest that gap is chosen.
 */
export function changeGrinderMode(
  grinder: RecipeForm['grinder'],
  mode: GrinderMode,
  presets: readonly GrinderPreset[],
): RecipeForm['grinder'] {
  if (mode === grinder.mode) return grinder;
  const next: RecipeForm['grinder'] = { ...grinder, ...clearedAdvanced(), mode };
  const preset = presets.find((p) => p.id === grinder.preset);
  const setting = parseDecimal(grinder.setting);
  const gap = parseDecimal(grinder.gap_um);
  if (grinder.mode === 'preset' && mode === 'family') {
    const g =
      grinder.by === 'gap' ? gap : preset ? dialGap(preset, setting ?? preset.dial.default) : null;
    next.by = 'gap';
    next.gap_um = g !== null && g > 0 ? shiftedText(Number(g.toPrecision(12))) : grinder.gap_um;
    if (preset) next.family = preset.family;
  } else if (mode === 'preset' && preset) {
    const d = preset.dial;
    const fromGap =
      grinder.by === 'gap' && gap !== null && d.gap_per_unit_um > 0
        ? d.ref + (gap - d.gap_at_ref_um) / d.gap_per_unit_um
        : null;
    const s = fromGap === null ? d.default : Math.min(d.max, Math.max(d.min, fromGap));
    next.by = 'setting';
    next.setting = shiftedText(Number(s.toPrecision(6)));
  }
  return next;
}

/**
 * The machine block after choosing another pump mode. A recipe pump replaces the
 * preset's pump entirely and its empty fields take registry defaults, so the
 * preset pump's values are copied into the fields when its type matches: the
 * pump then stays what it was until a field is changed.
 */
export function changePumpMode(
  machine: RecipeForm['machine'],
  mode: PumpMode,
  presetPump: PumpInput | null | undefined,
): RecipeForm['machine'] {
  const next = { ...machine, pumpMode: mode };
  const text = (v: number | null | undefined) => (typeof v === 'number' ? String(v) : '');
  if (mode === 'ideal' && presetPump?.type === 'ideal') {
    next.max_flow_ml_s = text(presetPump.max_flow_ml_s);
    next.max_pressure_bar = text(presetPump.max_pressure_bar);
  } else if (mode === 'vibratory' && presetPump?.type === 'vibratory') {
    next.free_flow_ml_s = text(presetPump.free_flow_ml_s);
    next.stall_pressure_bar = text(presetPump.stall_pressure_bar);
    next.opv_bar = text(presetPump.opv_bar);
  }
  return next;
}

/**
 * The machine block after choosing another machine preset: the program and the
 * pump follow the new preset (a custom program or pump made for the old one is
 * dropped; `discarded` says so, for an undo). With no preset, the program is
 * described here.
 */
export function changeMachinePreset(
  machine: RecipeForm['machine'],
  id: string,
): { machine: RecipeForm['machine']; discarded: boolean } {
  if (!id) return { machine: { ...machine, preset: '', customProgram: true }, discarded: false };
  const discarded =
    Boolean(machine.preset) && (machine.customProgram || machine.pumpMode !== 'preset');
  return {
    machine: {
      ...machine,
      preset: id,
      customProgram: false,
      pumpMode: 'preset',
      vent_headspace: '',
    },
    discarded,
  };
}

/** Unknown override ids (not in this version's registry) removed from a form. */
export function dropUnknownOverrides(
  form: RecipeForm,
  catalog: Catalog,
): { form: RecipeForm; removed: string[] } {
  const known = new Set(catalog.registry.parameters.map((p) => p.id));
  const removed = Object.keys(form.overrides).filter((id) => !known.has(id));
  if (removed.length === 0) return { form, removed };
  const overrides = Object.fromEntries(
    Object.entries(form.overrides).filter(([id]) => known.has(id)),
  );
  return { form: { ...form, overrides }, removed };
}

const ERROR_PATH =
  /^((?:bean|water|chemistry|grinder|basket|prep|machine|stop|numerics|overrides)(?:\.[a-z0-9_]+|\[\d+\])*)/;

/**
 * The editor input a builder error is about, from the recipe path at the start
 * of its message, as an error key: "prep.dose_g = 0.5 is outside …" →
 * `prep.dose_g`; "machine.profile[1]: only the last phase …" →
 * `machine.profile.1`; "basket.custom.profile_mm[1] diameter = 150 …" →
 * `basket.custom.profile_mm.1.1` (the diameter cell); "grinder.psd.volume_fraction
 * looks cumulative" → `grinder.psd` (the pasted text); "overrides: x.y = 5 is
 * outside its range" → `overrides.x.y`. Null when the message names no field.
 */
export function builderErrorPath(message: string): string | null {
  const override =
    /^overrides: (?:unknown parameter-registry id "([^"]+)"|([a-z][a-z0-9_.]*[a-z0-9_]) )/.exec(
      message,
    );
  if (override) return `overrides.${override[1] ?? override[2]}`;
  if (message.startsWith('basket preset')) return 'basket.preset';
  if (message.startsWith('machine preset')) return 'machine.preset';
  const match = ERROR_PATH.exec(message);
  if (!match) return null;
  const path = match[1].replace(/\[(\d+)\]/g, '.$1');
  if (path.startsWith('grinder.psd')) return 'grinder.psd';
  const row = /^basket\.custom\.profile_mm\.(\d+)$/.exec(path);
  if (row) return `basket.custom.profile_mm.${row[1]}.${/diameter/.test(message) ? 1 : 0}`;
  if (path === 'basket.custom' || path === 'basket.custom.profile_mm') {
    return 'basket.custom.profile_mm';
  }
  return path;
}

/** The section an error key belongs to: `prep.dose_g` → `prep`. */
export function sectionOf(path: string): string {
  return path.split('.')[0] ?? path;
}
