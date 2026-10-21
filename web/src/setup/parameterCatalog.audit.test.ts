// SPDX-License-Identifier: GPL-2.0-or-later
/** Real builder regressions: declaring a current value known must not change physics. */
import { describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import type { Recipe } from '../engine/shotTypes';
import { inferenceParameters, setSetupValue } from './parameterCatalog';

const catalog = fixtureCatalog();

function difference(a: unknown, b: unknown, path = 'spec'): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a === 'number' && typeof b === 'number') {
    // Re-expressing an equivalent dial mapping can differ at machine precision.
    if (Math.abs(a - b) <= 2e-13 * Math.max(Math.abs(a), Math.abs(b), 1e-20)) return [];
    return [`${path}: ${a} → ${b}`];
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = a as Record<string, unknown>;
    const bb = b as Record<string, unknown>;
    return [...new Set([...Object.keys(aa), ...Object.keys(bb)])].flatMap((key) =>
      difference(aa[key], bb[key], `${path}.${key}`),
    );
  }
  return [`${path}: ${String(a)} → ${String(b)}`];
}

const defaultRecipe = (): Recipe => structuredClone(DEFAULT_RECIPE);

function lockCurrentValues(recipe: Recipe): Recipe {
  let locked = recipe;
  for (const parameter of inferenceParameters(recipe, catalog)) {
    if (parameter.modeled && parameter.value !== undefined) {
      locked = setSetupValue(locked, parameter.path, parameter.value, catalog);
    }
  }
  return locked;
}

describe('setup catalog agrees with native builder precedence', () => {
  it.each([0.2, 0.5, 0.8])(
    'locking every current physical value preserves the spec at roast %s',
    (roast) => {
      const recipe = defaultRecipe();
      recipe.bean.roast_level = roast;
      delete recipe.prep.distribution;
      const expected = fixtureBuild(recipe).spec;
      const locked = lockCurrentValues(recipe);
      expect(difference(expected, fixtureBuild(locked).spec)).toEqual([]);
    },
  );

  it.each(catalog.presets.grinders.map((preset) => preset.id))(
    'preserves all physics when current settings are locked for grinder %s',
    (preset) => {
      const recipe = defaultRecipe();
      recipe.grinder = { preset };
      expect(
        difference(fixtureBuild(recipe).spec, fixtureBuild(lockCurrentValues(recipe)).spec),
      ).toEqual([]);
    },
  );

  it.each(catalog.presets.machines.map((preset) => preset.id))(
    'preserves all physics when current settings are locked for machine %s',
    (preset) => {
      const recipe = defaultRecipe();
      recipe.machine = { preset };
      expect(
        difference(fixtureBuild(recipe).spec, fixtureBuild(lockCurrentValues(recipe)).spec),
      ).toEqual([]);
    },
  );

  it('preserves recipe values that take precedence over conflicting registry aliases', () => {
    const recipe = defaultRecipe();
    recipe.machine.temperature_c = 91;
    recipe.machine.headspace_ml = 2;
    recipe.grinder.x50_gap_ratio = 1.5;
    recipe.overrides = {
      'shot.temperature': 98,
      'model.machine.group_headspace': 5,
      'psd.x50_gap_ratio': 1.8,
      'model.basket.open_area_fraction': 0.2,
    };
    expect(
      difference(fixtureBuild(recipe).spec, fixtureBuild(lockCurrentValues(recipe)).spec),
    ).toEqual([]);
  });

  it('each current active setting can be locked without changing the default recipe physics', () => {
    const recipe = defaultRecipe();
    const expected = fixtureBuild(recipe).spec;
    const changed: string[] = [];
    for (const parameter of inferenceParameters(recipe, catalog)) {
      if (!parameter.modeled || parameter.value === undefined) continue;
      const locked = setSetupValue(recipe, parameter.path, parameter.value, catalog);
      changed.push(
        ...difference(expected, fixtureBuild(locked).spec).map(
          (item) => `${parameter.path}: ${item}`,
        ),
      );
    }
    expect(changed).toEqual([]);
  });

  it('materializing a basket for an unchanged dimension retains its existing registry override', () => {
    const recipe = defaultRecipe();
    recipe.overrides = { 'model.basket.open_area_fraction': 0.2 };
    const parameters = inferenceParameters(recipe, catalog);
    const diameter = parameters.find(
      (parameter) => parameter.path === 'basket.custom.perforated_diameter_mm',
    );
    expect(diameter?.value).toBeTypeOf('number');
    const locked = setSetupValue(recipe, diameter!.path, diameter!.value!, catalog);
    expect(difference(fixtureBuild(recipe).spec, fixtureBuild(locked).spec)).toEqual([]);
    expect(
      parameters.find((parameter) => parameter.path === 'basket.custom.open_area_fraction')?.value,
    ).toBe(0.2);
  });

  it('locking a named grinder’s current family keeps its effective PSD and dial', () => {
    const recipe = defaultRecipe();
    recipe.grinder = { preset: 'mahlkoenig-e65s', setting: 1.7 };
    const family = inferenceParameters(recipe, catalog).find(
      (parameter) => parameter.path === 'grinder.family',
    );
    expect(family?.value).toBe('flat-traditional');
    const locked = setSetupValue(recipe, family!.path, family!.value!, catalog);
    expect(difference(fixtureBuild(recipe).spec, fixtureBuild(locked).spec)).toEqual([]);
  });
});
