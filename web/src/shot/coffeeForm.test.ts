// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../test/fixtures/shotFixture';
import type { Recipe } from '../engine/shotTypes';
import { DEFAULT_RECIPE, formToRecipe, recipeToForm, type RecipeForm } from './recipeForm';

function formOf(bean: unknown): RecipeForm {
  const result = recipeToForm({ ...DEFAULT_RECIPE, bean });
  if (!result.ok) throw new Error(result.error);
  expect(result.warnings).toEqual([]);
  return result.form;
}
function recipeOf(form: RecipeForm): Recipe {
  const result = formToRecipe(form, { catalog: fixtureCatalog() });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}

describe('coffee recipe editing', () => {
  it('preserves factual coffee metadata and a ground Agtron reading above 100 without converting roast', () => {
    const bean: Recipe['bean'] = {
      roast_level: 0.25,
      coffee: {
        id: 'source-lot',
        name: 'Single origin',
        roaster: 'Roaster',
        country: 'Mexico',
        region: 'Oaxaca',
        producer: 'Community lot',
        varieties: ['Typica', 'Bourbon'],
        process_label: 'Washed',
        roast_label: 'Light',
        roast_color: {
          scale: 'agtron-gourmet',
          value: 129.2,
          sample: 'ground',
          instrument: 'M Basic III',
        },
        roast_date: '2026-10-10',
        source_url: 'https://example.com/coffee',
        verified_at: '2026-10-23',
        harvest: '2026',
        model_roast_basis: 'Estimated from the published label.',
      },
    };
    const form = formOf(bean);
    expect(form.bean.coffee?.roast_color?.value).toBe('129.2');
    expect(recipeOf(form).bean).toEqual(bean);
    form.bean.coffee!.roast_color!.value = '115.4';
    expect(recipeOf(form).bean.roast_level).toBe(0.25);
  });

  it('round-trips original component weights and separate ages, species and roast assumptions', () => {
    const bean: Recipe['bean'] = {
      coffee: { name: 'My blend' },
      components: [
        {
          weight: 7,
          bean: {
            arabica_fraction: 1,
            roast_level: 0.25,
            days_off_roast: 2,
            coffee: { name: 'Coffee A' },
          },
        },
        { weight: 3, bean: { preset: 'robusta-medium', days_off_roast: 20, roast_level: 0.8 } },
      ],
    };
    expect(recipeOf(formOf(bean)).bean).toEqual(bean);
  });

  it.each([
    { components: [] },
    { preset: 'medium-washed-arabica', components: [{ weight: 1, bean: {} }] },
    { components: [{ weight: 1, bean: { components: [{ weight: 1, bean: {} }] } }] },
    { components: [{ weight: 0, bean: {} }] },
    { components: [{ weight: -1, bean: {} }] },
    { components: Array.from({ length: 7 }, () => ({ weight: 1, bean: {} })) },
  ])('rejects invalid blend structure without silently discarding components: %j', (bean) => {
    expect(recipeToForm({ ...DEFAULT_RECIPE, bean }).ok).toBe(false);
  });

  it('accepts native null optional fields in an otherwise valid blend', () => {
    const result = recipeToForm({
      ...DEFAULT_RECIPE,
      bean: {
        preset: null,
        roast_level: null,
        coffee: null,
        components: [
          {
            weight: 1,
            bean: {
              coffee: {
                roast_color: { scale: 'colorette', value: 101, sample: 'ground', instrument: null },
              },
            },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('places errors on the component input and preserves partial draft text', () => {
    const form = formOf({ components: [{ weight: 2, bean: { roast_level: 0.5 } }] });
    form.bean.components![0].weight = '-';
    form.bean.components![0].bean.roast_level = '1.1';
    form.bean.components![0].bean.coffee = {
      roast_color: { scale: 'agtron-gourmet', sample: 'ground', value: '1e-' },
    };
    const result = formToRecipe(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveProperty('bean.components.0.weight');
    expect(result.errors).toHaveProperty('bean.components.0.bean.roast_level');
    expect(result.errors).toHaveProperty('bean.components.0.bean.coffee.roast_color.value');
    expect(form.bean.components![0].bean.coffee.roast_color!.value).toBe('1e-');
  });

  it('retains legacy preset blends and exact custom roast indices', () => {
    const bean = { preset: 'dark-80-20-blend', roast_level: 0.537, arabica_fraction: 0.83 };
    expect(recipeOf(formOf(bean)).bean).toEqual(bean);
  });

  it('refuses invalid color facts and oversized variety metadata', () => {
    for (const coffee of [
      { roast_color: { scale: 'agtron', sample: 'ground', value: 60 } },
      { roast_color: { scale: 'agtron-gourmet', sample: 'ground', value: -1 } },
      { roast_color: { scale: 'cielab-lstar', sample: 'whole-bean', value: 101 } },
      { varieties: Array.from({ length: 33 }, () => 'Typica') },
    ])
      expect(recipeToForm({ ...DEFAULT_RECIPE, bean: { coffee } }).ok).toBe(false);
  });
});
