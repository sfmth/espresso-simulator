// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import { loadPuckcore } from '../../test/loadWasm';
import type { Engine } from '../engine/engine';
import { toShotRunData } from '../engine/shotData';
import type { Recipe, ShotResult } from '../engine/shotTypes';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { applySetupLocks, inferSetups, validateInferenceRequest } from './inference';
import type { SetupConstraint, SetupObservation } from './inferenceTypes';
import { inferenceParameters, setSetupValue } from './parameterCatalog';

const catalog = fixtureCatalog();
function blend(): Recipe {
  return {
    ...structuredClone(DEFAULT_RECIPE),
    prep: { ...DEFAULT_RECIPE.prep, dose_g: 12 },
    bean: {
      components: [
        {
          weight: 3,
          bean: {
            preset: 'light-washed-arabica',
            roast_level: 0.2,
            days_off_roast: 2,
            coffee: {
              name: 'First coffee',
              roast_color: { scale: 'agtron-gourmet', value: 129.2, sample: 'ground' },
            },
          },
        },
        {
          weight: 1,
          bean: { arabica_fraction: 0, roast_level: 0.8, days_off_roast: 20, process: 'anaerobic' },
        },
      ],
    },
    stop: { time_s: 30 },
  };
}
function closeObjects(actual: unknown, expected: unknown): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
      2e-12 * Math.max(Math.abs(expected), 1e-20),
    );
  } else if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    for (const key of Object.keys(expected))
      closeObjects(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
      );
  } else expect(actual).toEqual(expected);
}
function locks(recipe: Recipe): SetupConstraint[] {
  return inferenceParameters(recipe, catalog)
    .filter((p) => p.modeled && p.value !== undefined)
    .map((p) => ({ path: p.path, mode: 'locked', value: p.value }));
}

describe('coffee blend setup inference', () => {
  function recorded(recipe: Recipe, changes: string[]): SetupObservation {
    return {
      id: 'historical',
      label: 'Earlier blend shot',
      recipe: structuredClone(recipe),
      changes,
      timeS: 30,
      yieldG: 36,
      timeBasis: 'pump',
      massBasis: 'final',
      timeToleranceS: 0,
      yieldToleranceG: 1,
    };
  }
  it('rejects removal and reindexing before any engine call, without rewriting shot history', async () => {
    const original = blend();
    original.bean.components!.push({
      weight: 1,
      bean: { coffee: { name: 'Third coffee' }, roast_level: 0.5 },
    });
    const observation = recorded(original, ['bean.components.1.bean.days_off_roast']);
    const before = structuredClone(observation);
    const current = structuredClone(original);
    current.bean.components!.shift();
    // The old index1 still exists, but now means the original third coffee.
    await expect(
      inferSetups({} as Engine, catalog, {
        recipe: current,
        constraints: [],
        observations: [observation],
        maxEvaluations: 16,
      }),
    ).rejects.toThrow(/component count differs.*Review this recorded shot/);
    expect(observation).toEqual(before);
  });
  it('rejects equal-length reorderings and replacement of a catalog coffee', () => {
    const original = blend();
    original.bean.components![0].bean.coffee!.id = 'first-origin';
    original.bean.components![1].bean.coffee = { id: 'second-origin' };
    const observation = recorded(original, ['bean.components.1.weight']);
    const current = structuredClone(original);
    current.bean.components!.reverse();
    expect(() =>
      validateInferenceRequest(
        { recipe: current, constraints: [], observations: [observation] },
        catalog,
      ),
    ).toThrow(/Coffee 1 no longer has the recorded origin or identity/);
    current.bean.components!.reverse();
    current.bean.components![1].bean.coffee!.id = 'replacement-origin';
    expect(() =>
      validateInferenceRequest(
        { recipe: current, constraints: [], observations: [observation] },
        catalog,
      ),
    ).toThrow(/Coffee 2 no longer has the recorded origin or identity/);
  });
  it('checks anonymous leaf consistency while allowing explicitly recorded age and weight differences', () => {
    const current = blend();
    const observation = recorded(current, [
      'bean.components.1.bean.days_off_roast',
      'bean.components.1.weight',
    ]);
    observation.recipe.bean.components![1].bean.days_off_roast = 30;
    observation.recipe.bean.components![1].weight = 2;
    expect(() =>
      validateInferenceRequest(
        { recipe: current, constraints: [], observations: [observation] },
        catalog,
      ),
    ).not.toThrow();
    current.bean.components![1].bean.roast_level = 0.4;
    expect(() =>
      validateInferenceRequest(
        { recipe: current, constraints: [], observations: [observation] },
        catalog,
      ),
    ).toThrow(/no unique recorded identity.*distinct name/);
  });

  it('exposes each leaf and relative weight while coffee facts remain recorded only', () => {
    const parameters = inferenceParameters(blend(), catalog);
    expect(parameters.some((p) => p.path === 'bean.roast_level' || p.path === 'bean.preset')).toBe(
      false,
    );
    expect(parameters.find((p) => p.path === 'bean.components.1.bean.roast_level')).toMatchObject({
      value: 0.8,
      modeled: true,
    });
    expect(parameters.find((p) => p.path === 'bean.components.0.weight')).toMatchObject({
      value: 3,
      modeled: true,
    });
    expect(
      parameters.find((p) => p.path === 'bean.components.0.bean.coffee.roast_color.value'),
    ).toMatchObject({ value: 129.2, modeled: false });
    expect(parameters.find((p) => p.path === 'bean.components.0.bean.coffee.name')).toMatchObject({
      value: 'First coffee',
      modeled: false,
    });
  });

  it('locking all current modeled values preserves the native blend spec', () => {
    const recipe = blend();
    const locked = applySetupLocks(recipe, locks(recipe), catalog);
    expect(locked.bean.preset).toBeUndefined();
    expect(locked.bean.roast_level).toBeUndefined();
    closeObjects(fixtureBuild(locked).spec, fixtureBuild(recipe).spec);
  });

  it('individual component locks preserve the spec, while a changed leaf affects only that leaf', () => {
    const recipe = blend();
    const expected = fixtureBuild(recipe).spec;
    for (const constraint of locks(recipe).filter((c) => c.path.startsWith('bean.components.'))) {
      closeObjects(fixtureBuild(applySetupLocks(recipe, [constraint], catalog)).spec, expected);
    }
    const changed = setSetupValue(recipe, 'bean.components.1.bean.roast_level', 0.5, catalog);
    expect(changed.bean.components![0]).toEqual(recipe.bean.components![0]);
    expect(changed.bean.components![1].bean.roast_level).toBe(0.5);
    expect(fixtureBuild(changed).spec).not.toEqual(expected);
    expect(() =>
      applySetupLocks(
        recipe,
        [{ path: 'bean.components.0.weight', mode: 'locked', value: 0 }],
        catalog,
      ),
    ).toThrow(/physical bounds/);
  });

  it('replays two real shots with explicit leaf changes and one shared blend', async () => {
    const recipe = blend();
    const core = loadPuckcore();
    const run = (input: Recipe) =>
      JSON.parse(core.simulateRecipe(JSON.stringify(input))) as {
        build: ReturnType<typeof fixtureBuild>;
        result: ShotResult;
      };
    const calls: Recipe[] = [];
    const engine = {
      coreVersion: () => Promise.resolve({ result: catalog.coreVersion, runtimeMs: 0 }),
      simulateRecipe: (input: Recipe) => {
        calls.push(input);
        const raw = run(input);
        return Promise.resolve({
          result: { build: raw.build, ...toShotRunData(raw.result, 0) },
          runtimeMs: 0,
        });
      },
    } as unknown as Engine;
    const observations: SetupObservation[] = [20, 30].map((days, i) => {
      const shot = setSetupValue(recipe, 'bean.components.1.bean.days_off_roast', days, catalog);
      const summary = run(shot).result.summary;
      return {
        id: String(i),
        label: `Shot ${i + 1}`,
        recipe: shot,
        changes: ['bean.components.1.bean.days_off_roast'],
        timeS: summary.shot_time_s,
        yieldG: summary.beverage_mass_kg * 1000,
        tdsPercent: summary.tds * 100,
        timeBasis: 'pump',
        massBasis: 'final',
        timeToleranceS: 0,
        yieldToleranceG: 0.001,
        tdsTolerancePercent: 0.001,
      };
    });
    const result = await inferSetups(engine, catalog, {
      recipe,
      observations,
      maxEvaluations: 16,
      constraints: [
        { path: 'bean.components.0.weight', mode: 'locked', value: 3 },
        { path: 'bean.components.1.bean.days_off_roast', mode: 'locked', value: 20 },
        { path: 'bean.components.1.bean.roast_level', mode: 'range', min: 0.8, max: 0.8 },
      ],
    });
    expect(result.candidates, JSON.stringify(result)).toHaveLength(1);
    expect(result.candidates[0].checks.every((c) => c.matches)).toBe(true);
    expect(result.candidates[0].recipe.bean.components![1].bean.days_off_roast).toBe(20);
    expect(
      calls
        .filter((c) => c.numerics?.tier === 1)
        .map((c) => c.bean.components![1].bean.days_off_roast),
    ).toEqual([20, 30]);
  }, 30_000);
});

// Recorded water totals must not become unidentifiable optimization axes.
it('keeps hardness and individual minerals recorded-only while preserving alkalinity and total water TDS as modeled controls', () => {
  const parameters = inferenceParameters(DEFAULT_RECIPE, catalog);
  for (const field of ['hardness_mg_l_caco3', 'calcium_mg_l', 'magnesium_mg_l'])
    expect(parameters.find((p) => p.path === `water.${field}`)?.modeled).toBe(false);
  for (const field of ['alkalinity_mg_l_caco3', 'tds_mg_l', 'ph'])
    expect(parameters.find((p) => p.path === `water.${field}`)?.modeled).toBe(true);
});
