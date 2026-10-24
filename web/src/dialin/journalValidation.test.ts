// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import type { Recipe } from '../engine/shotTypes';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { validateRecipe } from './journalValidation';

function recipe(): Recipe {
  return {
    ...structuredClone(DEFAULT_RECIPE),
    bean: {
      coffee: { name: 'My blend' },
      components: [
        {
          weight: 70,
          bean: {
            roast_level: 0.25,
            coffee: {
              name: 'A',
              varieties: ['SL28', 'Batian'],
              roast_color: { scale: 'agtron-gourmet', value: 129.2, sample: 'ground' },
            },
          },
        },
        { weight: 30, bean: { roast_level: 0.7, coffee: { name: 'B' } } },
      ],
    },
    grinder: {
      family: 'flat-traditional',
      setting: -20,
      setting_ref: -20,
      gap_at_ref_um: 190,
      gap_per_unit_um: -10,
    },
  };
}

describe('saved recipe physical and metadata boundaries', () => {
  it('accepts a sourced blend and an arbitrary reverse dial without changing the document', () => {
    const document = recipe();
    const original = structuredClone(document);
    expect(() => validateRecipe(document)).not.toThrow();
    expect(document).toEqual(original);
  });
  it.each([0, -1, Infinity])('rejects invalid component weight %s', (weight) => {
    const document = recipe();
    document.bean.components![0].weight = weight;
    expect(() => validateRecipe(document)).toThrow();
  });
  it('rejects overflowed weight sums, nested blends and ambiguous top-level physical inputs', () => {
    const overflowing = recipe();
    overflowing.bean.components!.forEach((c) => {
      c.weight = 1e308;
    });
    expect(() => validateRecipe(overflowing)).toThrow(/total relative weight/);
    const nested = recipe();
    nested.bean.components![0].bean.components = [{ weight: 1, bean: {} }];
    expect(() => validateRecipe(nested)).toThrow();
    const conflicting = recipe();
    conflicting.bean.roast_level = 0.5;
    expect(() => validateRecipe(conflicting)).toThrow();
  });
  it('rejects out-of-bounds, unknown and oversized coffee facts', () => {
    const negative = recipe();
    negative.bean.components![0].bean.coffee!.roast_color!.value = -1;
    expect(() => validateRecipe(negative)).toThrow();
    const unknown = recipe() as unknown as {
      bean: { components: { bean: { coffee: Record<string, unknown> } }[] };
    };
    unknown.bean.components[0].bean.coffee.unrecognized_fact = 'ignored?';
    expect(() => validateRecipe(unknown)).toThrow();
    const oversized = recipe();
    oversized.bean.components![0].bean.coffee!.name = 'x'.repeat(2001);
    expect(() => validateRecipe(oversized)).toThrow();
    oversized.bean.components![0].bean.coffee!.name = 'A';
    oversized.bean.components![0].bean.coffee!.varieties = Array(33).fill('Bourbon');
    expect(() => validateRecipe(oversized)).toThrow();
  });
  it('rejects zero sensitivity through the schema while preserving signed and null legacy calibration', () => {
    const document = recipe();
    document.grinder.gap_per_unit_um = 0;
    expect(() => validateRecipe(document)).toThrow(/gap_per_unit_um/);
    document.grinder.gap_per_unit_um = 10;
    expect(() => validateRecipe(document)).not.toThrow();
    document.grinder.gap_per_unit_um = null;
    expect(() => validateRecipe(document)).not.toThrow();
  });
});
