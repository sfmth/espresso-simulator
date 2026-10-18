// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../test/fixtures/shotFixture';
import type { Recipe } from '../engine/shotTypes';
import {
  builderErrorPath,
  changeGrinderMode,
  changeGrinderPreset,
  changeMachinePreset,
  changePumpMode,
  DEFAULT_RECIPE,
  defaultForm,
  dropUnknownOverrides,
  filledAdvanced,
  emptyForm,
  formToRecipe,
  phaseForm,
  physicalKey,
  profileRow,
  recipeToForm,
  sectionOf,
  shiftedText,
  withTier,
  type RecipeForm,
} from './recipeForm';

/** The form of a recipe; fails the test if it does not convert. */
function formOf(recipe: unknown): RecipeForm {
  const result = recipeToForm(recipe);
  if (!result.ok) throw new Error(result.error);
  return result.form;
}

function recipeOf(form: RecipeForm): Recipe {
  const result = formToRecipe(form, { catalog: fixtureCatalog() });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}

function errorsOf(form: RecipeForm): Record<string, string> {
  const result = formToRecipe(form, { catalog: fixtureCatalog() });
  return result.ok ? {} : result.errors;
}

/** Recipes covering every mode of every block. */
const ROUND_TRIP: Recipe[] = [
  DEFAULT_RECIPE,
  {
    schema: 'puckworks.recipe/1',
    bean: {
      roast_level: 0.6,
      days_off_roast: 12,
      arabica_fraction: 0.9,
      process: 'natural',
      bean_temp_c: -18,
      altitude_m: 1900,
      variety_group: 'gesha',
      storage: 'frozen',
    },
    water: {
      alkalinity_mg_l_caco3: 35,
      hardness_mg_l_caco3: 72,
      calcium_mg_l: 22,
      magnesium_mg_l: 4.1,
      tds_mg_l: 125,
      ph: 7.2,
    },
    chemistry: {
      enabled: true,
      aroma_age_s: 30,
      cup_headspace_ml: 100,
      sample_temperature_c: 25,
      mineral_blank_subtracted: true,
    },
    grinder: {
      psd: {
        diameter_um: [30, 60, 150, 300, 500],
        volume_fraction: [0.1, 0.15, 0.2, 0.4, 0.15],
        method: 'wet_laser',
      },
    },
    basket: {
      custom: {
        profile_mm: [
          [0, 52],
          [6, 56],
          [24, 58],
        ],
        perforated_diameter_mm: 50,
        open_area_fraction: 0.07,
        pressurised_orifice_mm: 0.4,
        discharge_coefficient: 0.65,
      },
    },
    prep: {
      dose_g: 17,
      distribution: 'none',
      tamp_kgf: 15,
      puck_screen: true,
      paper_bottom: true,
      paper_top: true,
    },
    machine: {
      profile: [
        { control: 'flow', target: 4, limit: 4, until_pressure_bar: 3, until_time_s: 12 },
        { control: 'flow', target: 0, until_time_s: 20 },
        { control: 'pressure', target: 8, ramp_s: 3, limit: 3 },
      ],
      temperature_c: 91,
      pump: { type: 'vibratory', free_flow_ml_s: 8, stall_pressure_bar: 15, opv_bar: 10 },
      headspace_ml: 7,
    },
    stop: { beverage_g: 40, time_s: 60 },
    numerics: { tier: 0, size_classes: 12 },
    overrides: { 'extraction.max_yield': 26 },
  },
  {
    schema: 'puckworks.recipe/1',
    bean: { preset: 'robusta-medium' },
    grinder: { family: 'conical', setting: 12, gap_at_ref_um: 40, gap_per_unit_um: 15, rpm: 400 },
    basket: {},
    prep: { dose_g: 16 },
    machine: { preset: 'amzchef-ultra', pump: { type: 'ideal', max_flow_ml_s: 6 } },
    stop: {},
    numerics: { tier: 1 },
  },
  {
    schema: 'puckworks.recipe/1',
    bean: {},
    grinder: {
      preset: 'mahlkoenig-ek43',
      gap_um: 250,
      x50_gap_ratio: 1.3,
      fines_at_340_pct: 12,
      coarse_log_width: 0.32,
      boulder_weight: 0.06,
    },
    basket: { preset: '54-double' },
    prep: { dose_g: 18, distribution: 'tap' },
    machine: { preset: 'declining-9-6', temperature_c: 90 },
    stop: { time_s: 28 },
    numerics: { tier: 1 },
  },
];

describe('recipe form', () => {
  it('starts from the default recipe, which uses no one’s own gear', () => {
    expect(recipeOf(defaultForm())).toEqual(DEFAULT_RECIPE);
    const presets = fixtureCatalog().presets;
    const flagged = [
      presets.beans.find((p) => p.id === DEFAULT_RECIPE.bean.preset),
      presets.grinders.find((p) => p.id === DEFAULT_RECIPE.grinder.preset),
      presets.baskets.find((p) => p.id === DEFAULT_RECIPE.basket.preset),
      presets.machines.find((p) => p.id === DEFAULT_RECIPE.machine.preset),
    ];
    expect(flagged.every((p) => p !== undefined)).toBe(true);
    expect(flagged.some((p) => p?.flags.includes('owner-gear'))).toBe(false);
    // The grinder's own default setting (published espresso fineness), not one
    // tuned to the model's shot times.
    const grinder = presets.grinders.find((p) => p.id === DEFAULT_RECIPE.grinder.preset);
    expect(DEFAULT_RECIPE.grinder.setting).toBe(grinder?.dial.default);
  });

  it.each(ROUND_TRIP.map((r, i) => [i, r] as const))(
    'converts recipe %i to a form and back without change',
    (_i, recipe) => {
      expect(recipeOf(formOf(recipe))).toEqual(recipe);
    },
  );

  it('shows fractions as exact percentages and reads them back exactly', () => {
    expect(shiftedText(0.9, 2)).toBe('90');
    expect(shiftedText(0.07, 2)).toBe('7');
    expect(shiftedText(0.123456789, 2)).toBe('12.3456789');
    expect(shiftedText(1e-7, 2)).toBe('0.00001');
    const form = formOf({ ...DEFAULT_RECIPE, bean: { arabica_fraction: 0.9 } });
    expect(form.bean.arabica_fraction).toBe('90');
    expect(recipeOf(form).bean.arabica_fraction).toBe(0.9);
  });

  it('keeps every mode’s values but sends only the active mode', () => {
    const form = defaultForm();
    form.grinder.psdText = '100\t0.5\n300\t0.5';
    form.grinder.mode = 'psd';
    expect(recipeOf(form).grinder).toEqual({
      psd: { diameter_um: [100, 300], volume_fraction: [0.5, 0.5] },
    });
    form.grinder.mode = 'preset';
    expect(recipeOf(form).grinder).toEqual(DEFAULT_RECIPE.grinder);
    form.basket.mode = 'machine';
    expect(recipeOf(form).basket).toEqual({});
  });

  it('leaves empty optional fields out so presets and the registry supply them', () => {
    const recipe = recipeOf(defaultForm());
    expect(Object.keys(recipe.bean)).toEqual(['preset']);
    expect(recipe.prep).toEqual({ dose_g: 18, distribution: 'wdt' });
    expect(recipe.overrides).toBeUndefined();
    expect(recipe.water).toBeUndefined();
    expect(recipe.chemistry).toBeUndefined();
  });

  it('migrates old recipes and nullable M2 blocks without filling in assumed measurements', () => {
    const imported = recipeToForm({ ...DEFAULT_RECIPE, water: null, chemistry: null });
    expect(imported.ok && imported.warnings).toEqual([]);
    if (!imported.ok) throw new Error(imported.error);
    expect(recipeOf(imported.form)).toEqual(DEFAULT_RECIPE);
    expect(imported.form.bean.altitude_m).toBe('');
    expect(imported.form.bean.storage).toBe('');
  });

  it('retains explicit chemistry toggles and records every water change in the physical key', () => {
    const recipe: Recipe = {
      ...DEFAULT_RECIPE,
      chemistry: { enabled: false, mineral_blank_subtracted: false },
      bean: { variety_group: 'unspecified' },
    };
    expect(recipeOf(formOf(recipe))).toEqual(recipe);
    expect(physicalKey({ ...DEFAULT_RECIPE, water: { alkalinity_mg_l_caco3: 10 } })).not.toBe(
      physicalKey({ ...DEFAULT_RECIPE, water: { alkalinity_mg_l_caco3: 80 } }),
    );
  });

  it('validates water and cup observation conditions against the shared recipe schema', () => {
    const form = defaultForm();
    form.bean.altitude_m = '5000';
    form.water.alkalinity_mg_l_caco3 = '-1';
    form.water.ph = '14.1';
    form.chemistry.aroma_age_s = '-1';
    form.chemistry.sample_temperature_c = '101';
    expect(Object.keys(errorsOf(form)).sort()).toEqual([
      'bean.altitude_m',
      'chemistry.aroma_age_s',
      'chemistry.sample_temperature_c',
      'water.alkalinity_mg_l_caco3',
      'water.ph',
    ]);
    expect(builderErrorPath('water.ph = 15 is outside its range')).toBe('water.ph');
  });

  it('flags missing and out-of-range numbers with readable messages', () => {
    const form = defaultForm();
    form.prep.dose_g = '';
    form.bean.roast_level = '1.5';
    form.numerics.size_classes = '1.5';
    form.stop.beverage_g = '-3';
    form.bean.arabica_fraction = '120';
    expect(errorsOf(form)).toEqual({
      'prep.dose_g': 'Enter dose (g).',
      'bean.roast_level': 'Roast level must be between 0 and 1.',
      'numerics.size_classes': 'Size classes must be a whole number from 2 to 60.',
      'stop.beverage_g': 'Stop at beverage mass must be more than 0 g and at most 500 g.',
      'bean.arabica_fraction': 'Arabica share must be between 0% and 100%.',
    });
  });

  it('checks a custom basket as the builder does', () => {
    const form = formOf(ROUND_TRIP[1]);
    form.basket.profile = [profileRow('0', '52'), profileRow('0', '56'), profileRow('24', 'x')];
    form.basket.perforated_diameter_mm = '60';
    form.basket.pressurised_orifice_mm = '5';
    expect(errorsOf(form)).toEqual({
      'basket.custom.profile_mm.2.1': 'Inner diameter must be between 20 mm and 120 mm.',
      'basket.custom.profile_mm.1.0': 'Heights must increase: 0 mm is not above 0 mm.',
      'basket.custom.perforated_diameter_mm':
        'The perforated diameter must be at most the floor diameter (52 mm).',
    });
    // The schema's plausibility bounds apply too (crates/puckmodel/src/bounds.rs).
    form.basket.profile = [profileRow('0', '52'), profileRow('150', '56')];
    form.basket.perforated_diameter_mm = '4';
    form.basket.pressurised_orifice_mm = '70';
    expect(errorsOf(form)).toEqual({
      'basket.custom.profile_mm.1.0': 'Height must be between 0 mm and 100 mm.',
      'basket.custom.perforated_diameter_mm':
        'Perforated diameter must be between 5 mm and 120 mm.',
      'basket.custom.pressurised_orifice_mm': 'Orifice diameter must be between 0.05 mm and 10 mm.',
    });
    form.basket.profile = [profileRow('3', '52')];
    form.basket.perforated_diameter_mm = '50';
    form.basket.pressurised_orifice_mm = '0.4';
    expect(errorsOf(form)).toEqual({
      'basket.custom.profile_mm':
        'The wall profile needs at least two points: the floor and the rim.',
      'basket.custom.profile_mm.0.0': 'The first point is the floor: its height must be 0.',
    });
  });

  it('requires an end condition on every phase but the last, and a target where needed', () => {
    const form = defaultForm();
    form.machine.customProgram = true;
    form.machine.phases = [
      phaseForm({ control: 'pressure', target: '3' }),
      phaseForm({ control: 'flow', target: '' }),
      phaseForm({ control: 'pump', target: 'ignored', limit: 'ignored' }),
    ];
    expect(errorsOf(form)).toEqual({
      'machine.profile.0':
        'Only the last phase may run without an end condition: give a time, a beverage mass or a pressure.',
      'machine.profile.1.target': 'Enter target (mL/s).',
      'machine.profile.1':
        'Only the last phase may run without an end condition: give a time, a beverage mass or a pressure.',
    });
    form.machine.phases[0].until_time_s = '8';
    form.machine.phases[1] = phaseForm({ control: 'flow', target: '2', until_beverage_g: '5' });
    expect(recipeOf(form).machine.profile).toEqual([
      { control: 'pressure', target: 3, until_time_s: 8 },
      { control: 'flow', target: 2, until_beverage_g: 5 },
      { control: 'pump' },
    ]);
  });

  it('needs the dial calibration for a family set by dial setting', () => {
    const form = defaultForm();
    form.grinder.mode = 'family';
    form.grinder.by = 'setting';
    form.grinder.setting = '10';
    expect(errorsOf(form)).toEqual({
      'grinder.gap_at_ref_um': 'Enter gap at the reference setting (µm).',
      'grinder.gap_per_unit_um': 'Enter gap change per setting unit (µm).',
    });
  });

  it('reports a pasted PSD that cannot be read', () => {
    const form = defaultForm();
    form.grinder.mode = 'psd';
    form.grinder.psdText = '300\t0.5\n100\t0.2\n200\t0.3';
    expect(errorsOf(form)['grinder.psd']).toMatch(/Diameters must increase/);
  });

  it('checks overrides against the registry when it is known', () => {
    const form = defaultForm();
    form.overrides = {
      'extraction.max_yield': '150',
      'no.such.parameter': '1',
      'bed.porosity.intergranular': ' ',
    };
    const errors = errorsOf(form);
    expect(errors['overrides.extraction.max_yield']).toMatch(/must be between 1% and 60%/);
    expect(errors['overrides.no.such.parameter']).toMatch(/Unknown parameter/);
    expect(Object.keys(errors)).toHaveLength(2);
    form.overrides = { 'extraction.max_yield': '26' };
    expect(recipeOf(form).overrides).toEqual({ 'extraction.max_yield': 26 });
  });

  it('rejects preset ids that this version does not have', () => {
    const form = defaultForm();
    form.basket.preset = 'no-such-basket';
    expect(errorsOf(form)['basket.preset']).toMatch(/Unknown preset "no-such-basket"/);
  });

  it('imports recipes with unknown fields, reporting what it dropped', () => {
    const result = recipeToForm({
      ...DEFAULT_RECIPE,
      colour: 'red',
      bean: { preset: 'light-washed-arabica', origin: 'Kenya', roast_level: 'dark' },
      numerics: { tier: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([
      'Ignored the unknown field colour.',
      'Ignored the unknown field bean.origin.',
      'Ignored bean.roast_level: it must be a number.',
      'Ignored numerics.tier: it must be 0 or 1.',
    ]);
    expect(recipeOf(result.form).bean).toEqual({ preset: 'light-washed-arabica' });
  });

  it('refuses documents that are not recipes', () => {
    expect(recipeToForm([])).toEqual({ ok: false, error: 'A recipe must be a JSON object.' });
    const wrong = recipeToForm({ schema: 'puckworks.shot-spec/1' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/"schema" must be "puckworks.recipe\/1"/);
  });

  it('identifies results by the physical inputs, not the tier', () => {
    const tier0 = withTier(DEFAULT_RECIPE, 0);
    expect(tier0.numerics?.tier).toBe(0);
    expect(DEFAULT_RECIPE.numerics?.tier).toBe(1);
    expect(physicalKey(tier0)).toBe(physicalKey(DEFAULT_RECIPE));
    expect(physicalKey({ ...DEFAULT_RECIPE, prep: { dose_g: 19 } })).not.toBe(
      physicalKey(DEFAULT_RECIPE),
    );
  });

  it('starts empty forms with sensible values for the inactive modes', () => {
    const form = emptyForm();
    expect(form.basket.profile.map((r) => [r.height, r.diameter])).toEqual([
      ['0', '54'],
      ['5', '58'],
      ['22', '58.5'],
    ]);
    expect(new Set(form.basket.profile.map((r) => r.key)).size).toBe(3);
    expect(form.machine.phases).toHaveLength(1);
  });
});

describe('builder error paths', () => {
  it.each([
    ['prep.dose_g: 60 g makes a 118.8 mL bed', 'prep.dose_g'],
    [
      'machine.profile[1]: only the last phase may run without an exit condition',
      'machine.profile.1',
    ],
    ['machine.profile[0].target must be between 0 and 100', 'machine.profile.0.target'],
    ['overrides: unknown parameter-registry id "x.y"', 'overrides.x.y'],
    [
      'overrides: extraction.max_yield = 150 is outside its range [0, 100] (%)',
      'overrides.extraction.max_yield',
    ],
    ['basket preset: profile_mm needs at least two points', 'basket.preset'],
    ['basket.custom: profile_mm heights must strictly increase', 'basket.custom.profile_mm'],
    [
      'basket.custom.profile_mm[1] diameter = 150 is outside the plausible range',
      'basket.custom.profile_mm.1.1',
    ],
    [
      'basket.custom.profile_mm[2] height = 150 is outside the plausible range',
      'basket.custom.profile_mm.2.0',
    ],
    ['grinder.psd.volume_fraction looks cumulative', 'grinder.psd'],
    ['prep.dose_g = 0.5 is outside the plausible range 1 to 60 g', 'prep.dose_g'],
    ['machine preset flat-9-bar program[0]: …', 'machine.preset'],
    ['grinder: give a preset, a family with gap_um, or a measured psd', 'grinder'],
    ['invalid recipe: unknown field `foo`', null],
    ['shot solver failed: diverged', null],
  ])('%s → %s', (message, path) => {
    expect(builderErrorPath(message)).toBe(path);
  });

  it('names the section of an error key', () => {
    expect(sectionOf('basket.custom.profile_mm.2.0')).toBe('basket');
    expect(sectionOf('overrides.extraction.max_yield')).toBe('overrides');
  });
});

describe('gear changes clear what belonged to the old gear', () => {
  const catalog = fixtureCatalog();
  const grinders = catalog.presets.grinders;
  const ek43 = grinders.find((g) => g.id === 'mahlkoenig-ek43');

  it('drops a family’s dial calibration when switching to a preset (review repro)', () => {
    // Family + dial 20 with a 100 µm + 10 µm/unit calibration …
    const form = defaultForm();
    form.grinder = {
      ...form.grinder,
      mode: 'family',
      by: 'setting',
      setting: '20',
      gap_at_ref_um: '100',
      gap_per_unit_um: '10',
    };
    expect(recipeOf(form).grinder).toMatchObject({ gap_at_ref_um: 100, gap_per_unit_um: 10 });
    // … then Preset → EK43: the preset's own dial must decide the gap.
    let g = changeGrinderMode(form.grinder, 'preset', grinders);
    g = changeGrinderPreset(g, ek43, 'mahlkoenig-ek43');
    form.grinder = g;
    const recipe = recipeOf(form);
    expect(recipe.grinder).toEqual({ preset: 'mahlkoenig-ek43', setting: ek43?.dial.default });
    expect(filledAdvanced(g)).toEqual([]);
  });

  it('clears every advanced override on a preset change and sets the new dial’s default', () => {
    const form = defaultForm();
    form.grinder = {
      ...form.grinder,
      x50_gap_ratio: '1.3',
      coarse_log_width: '0.3',
      rpm: '900',
      gap_at_ref_um: '10',
    };
    expect(filledAdvanced(form.grinder)).toHaveLength(4);
    const next = changeGrinderPreset(form.grinder, ek43, 'mahlkoenig-ek43');
    expect(filledAdvanced(next)).toEqual([]);
    expect(next.setting).toBe(String(ek43?.dial.default));
  });

  it('keeps the burr gap when moving between a preset and a family', () => {
    const form = defaultForm(); // generic flat burrs: gap = setting µm, setting 190
    const family = changeGrinderMode(form.grinder, 'family', grinders);
    expect(family).toMatchObject({
      mode: 'family',
      by: 'gap',
      gap_um: '190',
      family: 'flat-traditional',
    });
    const back = changeGrinderMode({ ...family, gap_um: '300' }, 'preset', grinders);
    expect(back).toMatchObject({ mode: 'preset', by: 'setting', setting: '300' });
  });

  it('copies the preset’s pump into the fields, since a recipe pump replaces it whole', () => {
    const form = defaultForm();
    const vibratory = catalog.presets.machines.find((m) => m.id === 'vibratory-pump');
    form.machine = { ...form.machine, preset: 'vibratory-pump' };
    form.machine = changePumpMode(form.machine, 'vibratory', vibratory?.pump);
    expect(form.machine.opv_bar).toBe('12');
    expect(recipeOf(form).machine.pump).toEqual({ type: 'vibratory', opv_bar: 12 });
    // Another type starts empty (registry defaults).
    expect(changePumpMode(form.machine, 'ideal', vibratory?.pump).max_flow_ml_s).toBe('');
  });

  it('lets a new machine preset bring its own program and pump, saying when it dropped one', () => {
    const machine = { ...defaultForm().machine, customProgram: true, pumpMode: 'ideal' as const };
    expect(changeMachinePreset(machine, 'turbo-6-bar')).toEqual({
      machine: { ...machine, preset: 'turbo-6-bar', customProgram: false, pumpMode: 'preset' },
      discarded: true,
    });
    expect(changeMachinePreset(defaultForm().machine, 'turbo-6-bar').discarded).toBe(false);
    expect(changeMachinePreset(machine, '').machine.customProgram).toBe(true);
  });

  it('sends the vent only when chosen, reads it back, and lets a new preset reset it', () => {
    expect(recipeOf(defaultForm()).machine).not.toHaveProperty('vent_headspace');
    for (const vent of [true, false]) {
      const form = formOf({
        ...DEFAULT_RECIPE,
        machine: { ...DEFAULT_RECIPE.machine, vent_headspace: vent },
      });
      expect(form.machine.vent_headspace).toBe(vent ? 'yes' : 'no');
      expect(recipeOf(form).machine.vent_headspace).toBe(vent);
    }
    // Unset, null or not a boolean: the preset decides (the last with a warning).
    for (const vent of [undefined, null, 'yes']) {
      const result = recipeToForm({
        ...DEFAULT_RECIPE,
        machine: { ...DEFAULT_RECIPE.machine, vent_headspace: vent },
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.form.machine.vent_headspace).toBe('');
      expect(result.warnings.some((w) => w.includes('machine.vent_headspace'))).toBe(
        vent === 'yes',
      );
    }
    const chosen = { ...defaultForm().machine, vent_headspace: 'yes' as const };
    expect(changeMachinePreset(chosen, 'turbo-6-bar').machine.vent_headspace).toBe('');
    // With no preset, the choice is the only source: it stays.
    expect(changeMachinePreset(chosen, '').machine.vent_headspace).toBe('yes');
  });

  it('drops overrides of registry ids this version does not have', () => {
    const form = defaultForm();
    form.overrides = { 'model.psd.fines_floor': '5', 'extraction.max_yield': '26' };
    expect(errorsOf(form)['overrides.model.psd.fines_floor']).toMatch(/Unknown parameter/);
    const { form: clean, removed } = dropUnknownOverrides(form, catalog);
    expect(removed).toEqual(['model.psd.fines_floor']);
    expect(recipeOf(clean).overrides).toEqual({ 'extraction.max_yield': 26 });
  });

  it('reads and writes σ_c and w_b (w_b shown in percent)', () => {
    const imported = formOf({
      ...DEFAULT_RECIPE,
      grinder: { family: 'conical', gap_um: 200, coarse_log_width: 0.42, boulder_weight: 0.07 },
    });
    expect(imported.grinder.coarse_log_width).toBe('0.42');
    expect(imported.grinder.boulder_weight).toBe('7');
    expect(recipeOf(imported).grinder).toEqual({
      family: 'conical',
      gap_um: 200,
      coarse_log_width: 0.42,
      boulder_weight: 0.07,
    });
    imported.grinder.boulder_weight = '31';
    expect(errorsOf(imported)['grinder.boulder_weight']).toBe(
      'Boulder share (w_b) must be between 0% and 30%.',
    );
  });
});
