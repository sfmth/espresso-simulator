// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import schema from '../../../data/schema/recipe.schema.json';
import { FIELD_SCHEMA_PATHS, FIELDS, phaseFieldMeta, schemaNode } from './recipeFields';

describe('field ranges come from the recipe schema', () => {
  it('has a schema node for every field and reads its bounds', () => {
    for (const [path, at] of Object.entries(FIELD_SCHEMA_PATHS)) {
      expect(() => schemaNode(at), path).not.toThrow();
      expect(FIELDS[path], path).toBeDefined();
    }
  });

  it('matches the builder’s plausibility bounds', () => {
    expect(FIELDS['prep.dose_g']).toMatchObject({ min: 1, max: 60 });
    expect(FIELDS['grinder.fines_at_340_pct']).toMatchObject({ min: 1, max: 40 });
    expect(FIELDS['basket.custom.profile_mm.diameter']).toMatchObject({ min: 20, max: 120 });
    expect(FIELDS['basket.custom.profile_mm.height']).toMatchObject({ min: 0, max: 100 });
    expect(FIELDS['basket.custom.perforated_diameter_mm']).toMatchObject({ min: 5 });
    expect(FIELDS['basket.custom.pressurised_orifice_mm']).toMatchObject({ min: 0.05, max: 10 });
    expect(FIELDS['machine.pump.max_flow_ml_s']).toMatchObject({
      min: 0,
      minExclusive: true,
      max: 30,
    });
    expect(phaseFieldMeta('target', 'pressure')).toMatchObject({ min: 0, max: 20, unit: 'bar' });
    expect(phaseFieldMeta('limit', 'flow')).toMatchObject({ max: 30, unit: 'bar' });
    expect(FIELDS['numerics.size_classes']).toMatchObject({ min: 2, max: 60, integer: true });
  });

  it('scales the bounds of fractions shown in percent', () => {
    expect(FIELDS['bean.arabica_fraction']).toMatchObject({ min: 0, max: 100 });
    expect(FIELDS['basket.custom.open_area_fraction']).toMatchObject({ min: 0.1, max: 100 });
    expect(FIELDS['grinder.boulder_weight']).toMatchObject({ min: 0, max: 30 });
  });

  it('covers every numeric property the schema bounds', () => {
    // Walk the schema's $defs and list numeric properties with bounds.
    const bounded: string[] = [];
    const defs = (
      schema as unknown as {
        $defs: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
      }
    ).$defs;
    for (const [def, node] of Object.entries(defs)) {
      for (const [prop, p] of Object.entries(node.properties ?? {})) {
        if ('minimum' in p || 'maximum' in p || 'exclusiveMinimum' in p)
          bounded.push(`${def}.${prop}`);
      }
    }
    const covered = new Set(
      Object.values(FIELD_SCHEMA_PATHS).map((at) => `${String(at[0])}.${String(at[1])}`),
    );
    // Component leaves reuse the single-coffee controls and their exact bounds.
    for (const [prop, rule] of Object.entries(defs.bean_leaf.properties ?? {})) {
      if (covered.has(`bean.${prop}`)) {
        expect(rule, `bean_leaf.${prop} must match the shared control`).toEqual(
          defs.bean.properties?.[prop],
        );
        covered.add(`bean_leaf.${prop}`);
      }
    }
    const phase = [
      'phase.target',
      'phase.ramp_s',
      'phase.limit',
      'phase.until_time_s',
      'phase.until_beverage_g',
      'phase.until_pressure_bar',
    ];
    for (const path of bounded) {
      expect(covered.has(path) || phase.includes(path), `${path} has no editor field`).toBe(true);
    }
  });
});
