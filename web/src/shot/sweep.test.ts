// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureCatalog, fixtureResult } from '../../test/fixtures/shotFixture';
import type { Recipe, RegistryParameter } from '../engine/shotTypes';
import { DEFAULT_RECIPE } from './recipeForm';
import { DEFAULT_SWEEP_CONFIG } from './shotStore';
import {
  effectiveProgram,
  MAX_SWEEP_POINTS,
  planSweep,
  registryRange,
  SWEEP_OUTPUTS,
  sweepTargets,
  sweepValues,
} from './sweep';

const catalog = fixtureCatalog();

describe('sweep values', () => {
  it('spaces values evenly, ends included, without float noise', () => {
    expect(sweepValues(16, 20, 5)).toEqual([16, 17, 18, 19, 20]);
    expect(sweepValues(0.1, 0.3, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(sweepValues(20, 16, 3)).toEqual([20, 18, 16]);
  });

  it('rounds whole-number targets and drops repeats', () => {
    expect(sweepValues(8, 10, 5, true)).toEqual([8, 9, 10]);
  });
});

describe('sweep targets', () => {
  it('offers the dial of a preset grinder, the dose, temperature, stop, program and bean', () => {
    const ids = sweepTargets(DEFAULT_RECIPE, catalog).map((t) => t.id);
    expect(ids.slice(0, 6)).toEqual([
      'grinder.setting',
      'prep.dose_g',
      'machine.temperature_c',
      'stop.beverage_g',
      'stop.time_s',
      'phase.0.target',
    ]);
    expect(ids).toContain('bean.roast_level');
    expect(ids).toContain('override:extraction.max_yield');
    expect(ids.filter((id) => id.startsWith('override:'))).toHaveLength(
      catalog.registry.parameters.length,
    );
  });

  it('offers the gap when the grind is set by gap, and nothing for a measured PSD', () => {
    const byGap: Recipe = { ...DEFAULT_RECIPE, grinder: { family: 'conical', gap_um: 200 } };
    expect(sweepTargets(byGap, catalog).map((t) => t.id)).toContain('grinder.gap_um');
    const measured: Recipe = {
      ...DEFAULT_RECIPE,
      grinder: { psd: { diameter_um: [100, 300], volume_fraction: [1, 1] } },
    };
    const ids = sweepTargets(measured, catalog).map((t) => t.id);
    expect(ids).not.toContain('grinder.setting');
    expect(ids).not.toContain('grinder.gap_um');
  });

  it('knows the current values and a sensible default range', () => {
    const targets = sweepTargets(DEFAULT_RECIPE, catalog);
    const dose = targets.find((t) => t.id === 'prep.dose_g');
    expect(dose?.current).toBe(18);
    expect(dose?.defaultRange).toEqual([16, 20]);
    const dial = targets.find((t) => t.id === 'grinder.setting');
    expect(dial?.current).toBe(190);
    expect(dial?.label).toMatch(/Dial setting \(µm of burr gap\)/);
    const temperature = targets.find((t) => t.id === 'machine.temperature_c');
    expect(temperature?.current).toBe(93); // from the flat-9-bar preset
    const arabica = targets.find((t) => t.id === 'bean.arabica_fraction');
    expect(arabica?.current).toBe(100); // shown in percent
  });

  it('writes a value into a copy of the recipe, converting units exactly', () => {
    const targets = sweepTargets(DEFAULT_RECIPE, catalog);
    const apply = (id: string, v: number) =>
      targets.find((t) => t.id === id)?.apply(DEFAULT_RECIPE, v);
    expect(apply('prep.dose_g', 19)?.prep).toEqual({ dose_g: 19, distribution: 'wdt' });
    expect(apply('bean.arabica_fraction', 90)?.bean.arabica_fraction).toBe(0.9);
    expect(apply('override:extraction.max_yield', 25)?.overrides).toEqual({
      'extraction.max_yield': 25,
    });
    // Sweeping a program target copies the preset's program into the recipe.
    expect(apply('phase.0.target', 7)?.machine.profile).toEqual([
      { control: 'pressure', target: 7, ramp_s: 2 },
    ]);
    expect(DEFAULT_RECIPE.prep.dose_g).toBe(18);
    expect(DEFAULT_RECIPE.machine.profile).toBeUndefined();
  });

  it('reads the program of the preset when the recipe has none', () => {
    expect(effectiveProgram(DEFAULT_RECIPE, catalog)?.[0]?.target).toBe(9);
    expect(effectiveProgram({ ...DEFAULT_RECIPE, machine: {} }, catalog)).toBeNull();
  });

  it('derives a registry parameter’s range from its prior', () => {
    const base: RegistryParameter = {
      id: 'x',
      name: 'X',
      description: '',
      units: '1',
      range: { min: 0 },
      tag: 'estimated',
      evidence_grade: 'D',
      sources: [],
      default: 2,
      default_from: 'prior',
    };
    expect(registryRange({ ...base, prior: { distribution: 'uniform', min: 1, max: 3 } })).toEqual([
      1, 3,
    ]);
    expect(
      registryRange({ ...base, prior: { distribution: 'normal', mean: 2, sd: 0.25 } }),
    ).toEqual([1.5, 2.5]);
    expect(registryRange({ ...base, prior: { distribution: 'normal', mean: 1, sd: 1 } })).toEqual([
      0, 3,
    ]);
    expect(registryRange({ ...base })).toEqual([1, 3]);
  });
});

describe('sweep plans', () => {
  it('makes one recipe per value at the chosen tier', () => {
    const result = planSweep(DEFAULT_RECIPE, catalog, {
      ...DEFAULT_SWEEP_CONFIG,
      targetId: 'prep.dose_g',
      from: '16',
      to: '20',
      points: '3',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.values).toEqual([16, 18, 20]);
    expect(result.plan.recipes.map((r) => [r.prep.dose_g, r.numerics?.tier])).toEqual([
      [16, 0],
      [18, 0],
      [20, 0],
    ]);
  });

  it('checks the range and the number of points', () => {
    const plan = (patch: Partial<typeof DEFAULT_SWEEP_CONFIG>) =>
      planSweep(DEFAULT_RECIPE, catalog, {
        ...DEFAULT_SWEEP_CONFIG,
        from: '16',
        to: '20',
        ...patch,
      });
    expect(plan({ points: String(MAX_SWEEP_POINTS + 1) })).toEqual({
      ok: false,
      errors: { points: `Points must be a whole number from 2 to ${MAX_SWEEP_POINTS}.` },
    });
    expect(plan({ to: '16' })).toEqual({
      ok: false,
      errors: { to: 'The end must differ from the start.' },
    });
    expect(plan({ from: '0.5' })).toEqual({
      ok: false,
      errors: { from: 'The start must be between 1 g and 60 g.' },
    });
    expect(plan({ targetId: 'nonsense' })).toEqual({
      ok: false,
      errors: { target: 'Choose what to vary.' },
    });
  });

  it('reads every output from a summary in display units', () => {
    const summary = fixtureResult({ ey: 0.2 }).summary;
    const values = Object.fromEntries(SWEEP_OUTPUTS.map((o) => [o.id, o.value(summary)]));
    expect(values).toEqual({
      ey: 20,
      tds: summary.tds * 100,
      shot_time: 30,
      beverage: 36,
      max_pressure: 9,
      first_drops: 6,
      ey_std: 2,
    });
  });
});
