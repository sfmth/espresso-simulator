// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '../engine/engine';
import type { TasteEstimate } from '../engine/m3Types';
import type { RecipeRunData } from '../engine/shotData';
import type { Catalog, Diagnostics, Recipe, Summary } from '../engine/shotTypes';
import { scopeKey } from './calibration';
import { searchRecipes, type InverseOptions } from './inverse';
import type { CalibrationProfile, JournalEntry } from './types';

const BASE: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: { preset: 'beans' },
  grinder: { preset: 'grinder', setting: 150 },
  basket: { preset: 'basket' },
  prep: { dose_g: 18 },
  machine: { preset: 'machine' },
  stop: { beverage_g: 36 },
};

const catalog = {
  coreVersion: 'test',
  presets: {
    grinders: [{ id: 'grinder', dial: { min: 100, max: 240, default: 150 } }],
    baskets: [{ id: 'basket', dose_range_g: [16, 20] }],
    machines: [{ id: 'machine', temperature_c: 93, temperature_range_c: [88, 96] }],
  },
} as unknown as Catalog;

function summary(recipe: Recipe): Summary {
  const grind = recipe.grinder.setting ?? recipe.grinder.gap_um ?? 150;
  const yieldG = recipe.stop.beverage_g ?? 36;
  const ey = 0.2 - ((grind - 160) / 100) ** 2 * 0.1;
  return {
    stop_reason: 'beverage_mass',
    shot_time_s: 60 - 0.2 * grind + (recipe.prep.dose_g - 18) + (yieldG - 36) * 0.2,
    first_drops_s: 5,
    beverage_mass_kg: yieldG / 1000,
    tds: (ey * recipe.prep.dose_g) / yieldG,
    ey,
    max_pressure_pa: 9e5,
    bed_height_m: 0.012,
    headspace_m3: 2e-5,
    species: [],
    uniformity: { ey_std: 0.02, ey_min: ey - 0.03, ey_max: ey + 0.03 },
  };
}

const diagnostics: Diagnostics = { mass_balance_error: 1e-8, steps: 10, warnings: [] };

interface FakeOptions {
  change?: (recipe: Recipe, result: Summary) => void;
  fail?: (recipe: Recipe) => boolean;
  warning?: string;
  onCall?: (recipe: Recipe) => void;
  noTaste?: boolean;
}

function fakeEngine(options: FakeOptions = {}) {
  const calls: Recipe[] = [];
  const run = async (recipe: Recipe) => {
    await Promise.resolve();
    calls.push(structuredClone(recipe));
    options.onCall?.(recipe);
    if (options.fail?.(recipe)) throw new Error('Simulation failed.');
    const result = summary(recipe);
    options.change?.(recipe, result);
    return result;
  };
  const sweepPoint = vi.fn(async (recipe: Recipe) => ({
    result: {
      summary: await run(recipe),
      diagnostics: { ...diagnostics, warnings: options.warning ? [options.warning] : [] },
      coreMs: 1,
    },
    runtimeMs: 1,
  }));
  const engine = {
    sweepPoint,
    simulateRecipe: vi.fn(async (recipe: Recipe) => {
      const result = await run(recipe);
      const taste = {
        acidity_index: 100 - (recipe.grinder.setting ?? 150) / 3,
        bitterness_index: 25,
        astringency_index: 20,
        body_index: 70,
      } as TasteEstimate;
      return {
        result: {
          result: {
            summary: result,
            diagnostics: { ...diagnostics, warnings: options.warning ? [options.warning] : [] },
          },
          build: { derived: { notes: ['Estimated mapping.'] } },
          ...(options.noTaste ? {} : { taste }),
          coreMs: 1,
          totalPoints: 2,
        } as RecipeRunData,
        runtimeMs: 1,
      };
    }),
  } as unknown as Engine;
  return { engine, calls, sweepPoint };
}

const recipeOptions: InverseOptions = {
  mode: 'recipe',
  targetTimeS: 28,
  targetYieldG: 36,
  controls: { grinder: { min: 120, max: 200, step: 2 } },
  maxEvaluations: 60,
};

describe('bounded recipe inverse search', () => {
  it('finds a target, runs Tier 1 verification and leaves the input unchanged', async () => {
    const original = structuredClone(BASE);
    const { engine, calls } = fakeEngine();
    const progress = vi.fn();
    const result = await searchRecipes(engine, BASE, catalog, recipeOptions, undefined, progress);
    expect(BASE).toEqual(original);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].recipe.grinder.setting).toBe(160);
    expect(result.candidates[0].verified.residuals.timeS).toBeCloseTo(0);
    expect(result.candidates[0].executedRecipe.numerics?.tier).toBe(1);
    expect(calls.filter((r) => r.numerics?.tier === 1)).toHaveLength(3);
    expect(calls.filter((r) => r.numerics?.tier === 0)).toHaveLength(result.evaluations);
    expect(result.evaluations).toBeLessThanOrEqual(60);
    expect(result.modelError).toBe('unavailable');
    expect(result.candidates[0].envelope.kind).toContain('not_confidence_interval');
    expect(result.candidates[0].envelope.samples).toBeGreaterThan(1);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'verify', completed: 3 }),
    );
  });

  it('preserves the requested hardware lattice while enforcing gear bounds', async () => {
    const { engine, calls } = fakeEngine();
    const limitedCatalog = structuredClone(catalog);
    limitedCatalog.presets.grinders[0].dial.min = 130;
    limitedCatalog.presets.grinders[0].dial.max = 180;
    const result = await searchRecipes(engine, BASE, limitedCatalog, {
      ...recipeOptions,
      maxEvaluations: 80,
      controls: {
        grinder: { min: 125, max: 190, step: 6 },
        dose: { min: 14, max: 24, step: 1 },
        temp: { min: 80, max: 100, step: 2 },
      },
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const recipe of calls) {
      const setting = recipe.grinder.setting!;
      expect(setting).toBeGreaterThanOrEqual(130);
      expect(setting).toBeLessThanOrEqual(180);
      expect((setting - 125) % 6).toBe(0);
      expect(recipe.prep.dose_g).toBeGreaterThanOrEqual(16);
      expect(recipe.prep.dose_g).toBeLessThanOrEqual(20);
      expect(recipe.machine.temperature_c).toBeGreaterThanOrEqual(88);
      expect(recipe.machine.temperature_c).toBeLessThanOrEqual(96);
    }
  });

  it('reranks by verified residuals instead of presenting the preview winner as best', async () => {
    const { engine } = fakeEngine({
      change: (recipe, result) => {
        if (recipe.numerics?.tier === 1 && recipe.grinder.setting === 160) result.shot_time_s += 10;
      },
    });
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      controls: { grinder: { min: 140, max: 180, step: 10 } },
    });
    expect(result.candidates[0].recipe.grinder.setting).not.toBe(160);
    const previewWinner = result.candidates.find((c) => c.recipe.grinder.setting === 160)!;
    expect(previewWinner.preview.score).toBe(0);
    expect(previewWinner.verified.score).toBeGreaterThan(10);
  });

  it('solves pump-stop weight separately at both tiers to hit final beverage including drip', async () => {
    const { engine, calls } = fakeEngine({
      change: (recipe, result) => {
        const dripG = recipe.numerics?.tier === 1 ? 3 : 2;
        result.beverage_mass_kg += dripG / 1000;
        result.drip_mass_kg = dripG / 1000;
      },
    });
    const result = await searchRecipes(engine, BASE, catalog, recipeOptions);
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.preview.summary.beverage_mass_kg * 1000).toBeCloseTo(36);
      expect(candidate.verified.summary.beverage_mass_kg * 1000).toBeCloseTo(36);
      expect(candidate.previewRecipe.stop.beverage_g).toBe(34);
      expect(candidate.recipe.stop.beverage_g).toBe(33);
      expect(candidate.executedRecipe.stop.beverage_g).toBe(33);
      expect(candidate.verified.residuals.yieldG).toBeCloseTo(0);
    }
    expect(result.evaluations).toBe(calls.filter((r) => r.numerics?.tier === 0).length);
    expect(result.evaluations).toBeLessThanOrEqual(recipeOptions.maxEvaluations!);
  });

  it('respects explicit stop-weight hardware limits and discloses an unreachable cup target', async () => {
    const { engine, calls } = fakeEngine({
      change: (_recipe, result) => {
        result.beverage_mass_kg += 0.003;
      },
    });
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      controls: { ...recipeOptions.controls, yield: { min: 35, max: 40, step: 1 } },
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const recipe of calls) {
      expect(recipe.stop.beverage_g).toBeGreaterThanOrEqual(35);
      expect(recipe.stop.beverage_g).toBeLessThanOrEqual(40);
      expect(recipe.stop.beverage_g! % 1).toBe(0);
    }
    expect(result.candidates[0].verified.residuals.yieldG).toBeCloseTo(2);
    expect(result.candidates[0].warnings.join(' ')).toContain(
      'final cup yield target was not reached',
    );
  });

  it('excludes a failed or empty Tier 1 result and reports an unreachable target', async () => {
    const { engine } = fakeEngine({
      change: (recipe, result) => {
        if (recipe.numerics?.tier === 1 && recipe.grinder.setting === 160)
          result.beverage_mass_kg = 0;
      },
    });
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      controls: { grinder: { min: 140, max: 180, step: 10 } },
      targetTimeS: 10,
    });
    expect(result.candidates.some((c) => c.recipe.grinder.setting === 160)).toBe(false);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.notes.join(' ')).toContain('unreachable');
  });

  it('skips numerical failures and critical warnings without inventing a candidate', async () => {
    for (const fake of [
      fakeEngine({ fail: () => true }),
      fakeEngine({ warning: 'Solver failed: not converged.' }),
    ]) {
      const result = await searchRecipes(fake.engine, BASE, catalog, recipeOptions);
      expect(result.candidates).toEqual([]);
      expect(result.skipped).toBeGreaterThan(0);
      expect(result.notes.join(' ')).toContain('No candidate passed');
    }
  });

  it.each([
    { controls: { grinder: { min: 180, max: 120, step: 1 } } },
    { controls: { grinder: { min: 120, max: 180, step: 0 } } },
    { controls: { grinder: { min: NaN, max: 180, step: 1 } } },
    { controls: { dose: { min: 7, max: 12, step: 1 } } },
    { targetTimeS: NaN },
    { targetYieldG: 0 },
    { maxEvaluations: 1000 },
    { controls: { grinder: { min: -1e308, max: 1e308, step: 1 } } },
    { controls: { grinder: { min: 0, max: 1e308, step: 1e308 } } },
  ])('rejects invalid limits before invoking physics: %j', async (patch) => {
    const { engine, calls } = fakeEngine();
    await expect(
      searchRecipes(engine, BASE, catalog, { ...recipeOptions, ...patch }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('uses burr gap when the explicit gap overrides a preset dial', async () => {
    const { engine, calls } = fakeEngine();
    await searchRecipes(engine, { ...BASE, grinder: { ...BASE.grinder, gap_um: 150 } }, catalog, {
      ...recipeOptions,
      controls: { grinder: { min: 100, max: 200, step: 10 } },
    });
    expect(new Set(calls.map((r) => r.grinder.gap_um)).size).toBeGreaterThan(3);
    expect(calls.every((r) => r.grinder.setting === 150)).toBe(true);
  });

  it('applies a matching profile once to physics while keeping editable recipes uncalibrated', async () => {
    const profile: CalibrationProfile = {
      id: 'profile',
      createdAt: '2026-10-18T00:00:00Z',
      coreVersion: 'test',
      setupId: 'setup',
      scopeKey: scopeKey(BASE),
      trainingIds: [],
      parameters: [],
      permeability: 1.25,
      grinderScale: 1.1,
      referencePermeability: 6e-15,
      referenceX50GapRatio: 1.4,
      timeSigmaS: 3,
      tdsSigmaPercent: 0.5,
      posterior: [],
      checks: [],
      notes: [],
    };
    const { engine, calls } = fakeEngine();
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      calibration: profile,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const recipe of calls) {
      expect(recipe.grinder.x50_gap_ratio).toBeCloseTo(1.54);
      expect(recipe.overrides?.['hydraulics.permeability.reference']).toBeCloseTo(7.5e-15, 22);
    }
    expect(result.candidates[0].recipe.grinder.x50_gap_ratio).toBeUndefined();
    expect(result.candidates[0].executedRecipe.grinder.x50_gap_ratio).toBeCloseTo(1.54);
    await expect(
      searchRecipes(engine, BASE, catalog, {
        ...recipeOptions,
        calibration: { ...profile, coreVersion: 'old' },
      }),
    ).rejects.toThrow('core version');
    await expect(
      searchRecipes(engine, { ...BASE, bean: { preset: 'different-bag' } }, catalog, {
        ...recipeOptions,
        calibration: profile,
      }),
    ).rejects.toThrow('setup');
    await expect(
      searchRecipes(engine, BASE, catalog, {
        ...recipeOptions,
        calibration: profile,
        controls: { ...recipeOptions.controls, temp: { min: 90, max: 95, step: 1 } },
      }),
    ).rejects.toThrow('Uncheck local calibration');
  });

  it('searches a custom-family dial without replacing its mapping by a gap', async () => {
    const { engine, calls } = fakeEngine();
    await searchRecipes(
      engine,
      {
        ...BASE,
        grinder: { family: 'conical', setting: 150, gap_at_ref_um: 50, gap_per_unit_um: 1 },
      },
      catalog,
      recipeOptions,
    );
    expect(new Set(calls.map((r) => r.grinder.setting)).size).toBeGreaterThan(3);
    expect(
      calls.every((r) => r.grinder.gap_um === undefined && r.grinder.gap_at_ref_um === 50),
    ).toBe(true);
  });

  it('rejects a grinder search when a measured PSD fixes the distribution', async () => {
    const { engine } = fakeEngine();
    const measured = {
      ...BASE,
      grinder: { psd: { diameter_um: [10, 100], volume_fraction: [1, 2] } },
    };
    await expect(searchRecipes(engine, measured, catalog, recipeOptions)).rejects.toThrow(
      'measured PSD',
    );
  });

  it('propagates cancellation before work and during an engine call', async () => {
    const early = new AbortController();
    early.abort();
    const first = fakeEngine();
    await expect(
      searchRecipes(first.engine, BASE, catalog, recipeOptions, early.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.calls).toEqual([]);
    const during = new AbortController();
    const second = fakeEngine({ onCall: () => during.abort() });
    await expect(
      searchRecipes(second.engine, BASE, catalog, recipeOptions, during.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(second.calls).toHaveLength(1);
  });
});

describe('outcome and next-shot modes', () => {
  it('rejects next-shot advice without a measured shot or sufficiently varied personal ratings', async () => {
    const { engine, calls } = fakeEngine();
    await expect(
      searchRecipes(engine, BASE, catalog, { ...recipeOptions, mode: 'next' }),
    ).rejects.toThrow('five varied rated shots');
    expect(calls).toEqual([]);
  });

  it('defaults recipe targets to the current beverage amount without dropping yield from the loss', async () => {
    const { engine } = fakeEngine();
    const result = await searchRecipes(engine, BASE, catalog, { mode: 'recipe' });
    expect(result.candidates[0].verified.residuals).toHaveProperty('yieldG');
    expect(result.candidates[0].verified.summary.beverage_mass_kg).toBeCloseTo(0.036);
  });
  it('finds a nonmonotone EY peak without introducing an unrequested time target', async () => {
    const { engine } = fakeEngine();
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      mode: 'outcome',
      targetTimeS: undefined,
      targetEyPercent: 20,
    });
    expect(result.candidates[0].recipe.grinder.setting).toBe(160);
    expect(result.candidates[0].verified.residuals).not.toHaveProperty('timeS');
    expect(result.candidates[0].verified.residuals.eyPoints).toBeCloseTo(0);
  });

  it('optimizes one taste index using full recipe calls at both tiers', async () => {
    const { engine, sweepPoint } = fakeEngine();
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      mode: 'outcome',
      targetTimeS: undefined,
      targetTaste: { attribute: 'acidity', index: 50 },
    });
    expect(result.candidates[0].recipe.grinder.setting).toBe(150);
    expect(result.candidates[0].verified.residuals.tasteIndex).toBeCloseTo(0);
    expect(sweepPoint).not.toHaveBeenCalled();
    const missing = fakeEngine({ noTaste: true });
    const empty = await searchRecipes(missing.engine, BASE, catalog, {
      ...recipeOptions,
      mode: 'outcome',
      targetTaste: { attribute: 'acidity', index: 50 },
    });
    expect(empty.candidates).toEqual([]);
  });

  it('uses the last measured residual for next-shot advice while retaining physical predictions', async () => {
    const { engine } = fakeEngine();
    const lastShot: JournalEntry = {
      id: 'last',
      createdAt: '2026-10-18T00:00:00Z',
      setupId: 'test',
      label: 'Last shot',
      recipe: BASE,
      source: 'manual',
      measurement: { recordedAt: '2026-10-18T00:05:00Z', timeS: 34, yieldG: 36, notes: '' },
    };
    // The current engine predicts 30 s for the last recipe. The observed +4 s
    // residual means a new physical prediction of 24 s targets 28 s observed.
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      mode: 'next',
      lastShot,
    });
    expect(result.candidates[0].recipe.grinder.setting).toBe(180);
    expect(result.candidates[0].verified.summary.shot_time_s).toBeCloseTo(24);
    expect(result.candidates[0].verified.residuals.timeS).toBeCloseTo(0);
    expect(result.notes.join(' ')).toContain('unvalidated assumption');
  });

  it('derives next-shot time correction at the measured final yield rather than nominal pump stop', async () => {
    const { engine, calls } = fakeEngine({
      change: (recipe, result) => {
        const dripG = recipe.numerics?.tier === 1 ? 3 : 2;
        result.beverage_mass_kg += dripG / 1000;
        result.drip_mass_kg = dripG / 1000;
      },
    });
    const lastShot: JournalEntry = {
      id: 'last',
      createdAt: '2026-10-18T00:00:00Z',
      setupId: 'test',
      label: 'Last shot',
      recipe: BASE,
      source: 'manual',
      measurement: { recordedAt: '2026-10-18T00:05:00Z', timeS: 34, yieldG: 42, notes: '' },
    };
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      mode: 'next',
      lastShot,
    });
    expect(calls.slice(0, 4).map((recipe) => recipe.stop.beverage_g)).toEqual([42, 40, 42, 39]);
    expect(result.candidates[0].recipe.grinder.setting).toBe(174);
    expect(result.candidates[0].verified.summary.beverage_mass_kg * 1000).toBeCloseTo(36);
    expect(result.candidates[0].verified.residuals.timeS).toBeCloseTo(0);
    expect(result.notes.join(' ')).toContain('42.00 g observed final yield');
    expect(result.evaluations).toBe(
      calls.filter((recipe) => recipe.numerics?.tier === 0).length - 2,
    );
  });

  it('discloses skipped next-shot correction when observed final yield cannot be reproduced', async () => {
    const { engine } = fakeEngine({
      change: (_recipe, result) => {
        result.beverage_mass_kg = 0.036;
      },
    });
    const lastShot: JournalEntry = {
      id: 'last',
      createdAt: '2026-10-18T00:00:00Z',
      setupId: 'test',
      label: 'Last shot',
      recipe: BASE,
      source: 'manual',
      measurement: { recordedAt: '2026-10-18T00:05:00Z', timeS: 34, yieldG: 42, notes: '' },
    };
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      mode: 'next',
      lastShot,
    });
    expect(result.notes.filter((note) => note.includes('correction was skipped'))).toHaveLength(2);
    expect(result.notes.join(' ')).toContain('0.2 g');
  });

  it('is deterministic for the same recipe and target', async () => {
    const a = await searchRecipes(fakeEngine().engine, BASE, catalog, recipeOptions);
    const b = await searchRecipes(fakeEngine().engine, BASE, catalog, recipeOptions);
    expect(a).toEqual(b);
  });

  it('uses an optional learned rating preference while exposing the unmodified target loss', async () => {
    const entries: JournalEntry[] = [120, 140, 160, 180, 200].map((setting, index) => {
      const recipe = { ...BASE, grinder: { ...BASE.grinder, setting } };
      const taste = {
        acidity_index: 100 - setting / 3,
        bitterness_index: 25,
        astringency_index: 20,
        body_index: 70,
      } as TasteEstimate;
      return {
        id: `rated-${index}`,
        createdAt: '2026-10-18T00:00:00Z',
        setupId: 'setup',
        label: 'Rated shot',
        recipe,
        source: 'manual',
        prediction: {
          recordedAt: '2026-10-18T00:00:00Z',
          coreVersion: 'test',
          executedRecipe: recipe,
          summary: summary(recipe),
          taste,
          origin: 'app',
        },
        measurement: {
          recordedAt: '2026-10-18T00:05:00Z',
          timeS: 28,
          yieldG: 36,
          rating: index + 1,
          notes: '',
        },
      };
    });
    const { engine } = fakeEngine({
      change: (_recipe, result) => {
        result.shot_time_s = 28;
      },
    });
    const result = await searchRecipes(engine, BASE, catalog, {
      ...recipeOptions,
      mode: 'next',
      ratedShots: entries,
      preferenceWeight: 1,
    });
    expect(result.candidates[0].recipe.grinder.setting).toBe(200);
    expect(result.candidates[0].score).toBe(0);
    expect(result.candidates[0].rankingScore).toBeGreaterThan(0);
    expect(result.candidates[0].learnedRating?.count).toBe(5);
    expect(result.candidates[0].learnedRating?.p05).toBeLessThan(
      result.candidates[0].learnedRating!.mean,
    );
    const repeated = entries.map((entry) => ({ ...entry, prediction: entries[0].prediction }));
    await expect(
      searchRecipes(engine, BASE, catalog, {
        ...recipeOptions,
        mode: 'next',
        ratedShots: repeated,
        preferenceWeight: 1,
      }),
    ).rejects.toThrow('five varied rated shots');
  });
});
