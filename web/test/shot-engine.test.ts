// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The M1 shot API of the WASM engine, run in Node (the module the browser
 * runs): `presets()` lists the gear; recipes built from every preset, and from
 * scratch (a measured PSD, a custom pressurised basket, a vibratory pump with a
 * flow program), must build into a spec and simulate into a result that follows
 * the contract's shape with finite numbers, at tier 0 and tier 1.
 */
import { describe, expect, it } from 'vitest';
import { checkShotResult } from '../src/engine/shotCheck';
import type { BuiltSpec, PresetsDoc, Recipe, ShotResult } from '../src/engine/shotTypes';
import { loadPuckcore } from './loadWasm';

const core = loadPuckcore();
const presets = JSON.parse(core.presets()) as PresetsDoc;

/**
 * What the lab draws from every result of this core: the cell faces, the
 * wetted share of every cell, the outflow check, and a local EY that does not
 * dip below zero (beyond round-off; the cross-section keeps a diverging scale
 * only as a fallback for older cores).
 */
function expectLabFields(result: ShotResult) {
  const sp = result.spatial;
  expect(sp.depth_edges_m?.length).toBe(sp.depth_m.length + 1);
  expect(sp.depth_edges_m?.[0]).toBe(0);
  for (const snap of sp.snapshots) {
    expect(snap.wetted_fraction?.length).toBe(sp.columns.length);
    for (const column of snap.wetted_fraction ?? []) {
      expect(column).toHaveLength(sp.depth_m.length);
      for (const w of column) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
    // 1e-8 as a fraction is the cross-section's 1e-6 % tolerance.
    expect(Math.min(...snap.local_ey.flat())).toBeGreaterThan(-1e-8);
  }
  expect(result.diagnostics.outflow_integral_error).toBeTypeOf('number');
  expect(result.diagnostics.hydraulic_volume_balance_error).toBeTypeOf('number');
  expect(result.diagnostics.hydraulic_volume_balance_error).toBeLessThan(1e-9);
}

const BASE: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: { preset: 'medium-washed-arabica' },
  grinder: { preset: 'generic-flat-traditional-64', setting: 190 },
  basket: { preset: '58-precision-18g' },
  prep: { dose_g: 18 },
  machine: { preset: 'flat-9-bar' },
  stop: { beverage_g: 36 },
  numerics: { tier: 0 },
};

function cases(): [string, Recipe][] {
  const out: [string, Recipe][] = [];
  for (const b of presets.beans) out.push([`bean ${b.id}`, { ...BASE, bean: { preset: b.id } }]);
  for (const g of presets.grinders) {
    out.push([`grinder ${g.id}`, { ...BASE, grinder: { preset: g.id, setting: g.dial.default } }]);
  }
  for (const f of presets.grinder_families) {
    out.push([`family ${f.id}`, { ...BASE, grinder: { family: f.id, gap_um: 250 } }]);
  }
  for (const k of presets.baskets) {
    out.push([
      `basket ${k.id}`,
      {
        ...BASE,
        basket: { preset: k.id },
        prep: { dose_g: k.nominal_dose_g },
        stop: { beverage_g: 2 * k.nominal_dose_g },
      },
    ]);
  }
  for (const m of presets.machines) {
    out.push([
      `machine ${m.id}`,
      {
        ...BASE,
        machine: { preset: m.id },
        basket: m.default_basket ? {} : BASE.basket,
        prep: { dose_g: 16 },
        stop: { beverage_g: 32, time_s: 60 },
      },
    ]);
  }
  out.push([
    'from scratch: measured PSD, custom pressurised basket, vibratory pump and flow program',
    {
      schema: 'puckworks.recipe/1',
      bean: { roast_level: 0.7, days_off_roast: 20, arabica_fraction: 0.85 },
      grinder: {
        psd: {
          diameter_um: [20, 50, 120, 250, 400, 700],
          volume_fraction: [5, 10, 15, 40, 25, 5],
          method: 'dry_laser',
        },
      },
      basket: {
        custom: {
          profile_mm: [
            [0, 44],
            [5, 50],
            [10, 50],
            [10.5, 56],
            [22, 57],
          ],
          perforated_diameter_mm: 40,
          open_area_fraction: 0.05,
          pressurised_orifice_mm: 0.5,
          discharge_coefficient: 0.7,
        },
      },
      prep: { dose_g: 15, distribution: 'none', puck_screen: true },
      machine: {
        profile: [
          { control: 'flow', target: 3, until_pressure_bar: 2, until_time_s: 10 },
          { control: 'pump' },
        ],
        pump: { type: 'vibratory', free_flow_ml_s: 7, stall_pressure_bar: 14, opv_bar: 11 },
        temperature_c: 90,
        headspace_ml: 8,
      },
      stop: { beverage_g: 30, time_s: 50 },
      numerics: { tier: 0, size_classes: 10 },
      overrides: { 'extraction.max_yield': 27 },
    },
  ]);
  return out;
}

describe('WASM shot API in Node', () => {
  it('lists presets of every kind, each with its provenance fields', () => {
    expect(presets.schema).toBe('puckworks.presets/1');
    for (const kind of ['beans', 'grinders', 'grinder_families', 'baskets', 'machines'] as const) {
      expect(presets[kind].length, kind).toBeGreaterThan(0);
      for (const p of presets[kind]) {
        expect(typeof p.name, `${kind}/${p.id}`).toBe('string');
        expect(Array.isArray(p.flags) && Array.isArray(p.notes) && Array.isArray(p.sources)).toBe(
          true,
        );
        expect(p.evidence_grade).toMatch(/^[A-D]$/);
      }
    }
    expect(presets.beans.filter((b) => b.default)).toHaveLength(1);
    const registry = JSON.parse(core.registry()) as { schema: string; parameters: unknown[] };
    expect(registry.schema).toBe('puckworks.registry/1');
    expect(registry.parameters.length).toBeGreaterThan(100);
  });

  it.each(cases())('builds and simulates %s (tier 0)', (_name, recipe) => {
    const built = JSON.parse(core.buildShotSpec(JSON.stringify(recipe))) as BuiltSpec;
    expect(built.spec.schema).toBe('puckworks.shot-spec/1');
    expect(built.derived.notes.length).toBeGreaterThan(0);
    expect(Object.keys(built.derived.provenance).length).toBeGreaterThan(20);
    expect(built.derived.psd_curve.diameter_um.length).toBe(
      built.derived.psd_curve.volume_density.length,
    );
    const run = JSON.parse(core.simulateRecipe(JSON.stringify(recipe))) as {
      build: BuiltSpec;
      result: ShotResult;
    };
    expect(run.build).toEqual(built);
    expect(checkShotResult(run.result)).toEqual([]);
    const s = run.result.summary;
    expect(s.ey).toBeGreaterThanOrEqual(0);
    expect(s.ey).toBeLessThan(0.4);
    expect(s.tds).toBeGreaterThanOrEqual(0);
    expect(s.tds).toBeLessThan(0.5);
    expect(run.result.diagnostics.mass_balance_error).toBeLessThan(1e-6);
    // Tier 0 is a coarse grid; its exact size is the solver's choice (contract §4: "about 8").
    expect(run.result.spatial.columns.length).toBeGreaterThan(0);
    expect(run.result.spatial.depth_m.length).toBeGreaterThan(0);
    expectLabFields(run.result);
  });

  it.each([cases()[0], cases().at(-1) as [string, Recipe]])(
    'simulates %s at tier 1, finer than tier 0, with every snapshot on the grid',
    (_name, recipe) => {
      const run = JSON.parse(
        core.simulateRecipe(
          JSON.stringify({ ...recipe, numerics: { ...recipe.numerics, tier: 1 } }),
        ),
      ) as { result: ShotResult };
      expect(checkShotResult(run.result)).toEqual([]);
      // Tier 1 resolves the bed more finely than tier 0.
      const preview = JSON.parse(
        core.simulateRecipe(
          JSON.stringify({ ...recipe, numerics: { ...recipe.numerics, tier: 0 } }),
        ),
      ) as { result: ShotResult };
      expect(run.result.spatial.depth_m.length).toBeGreaterThan(
        preview.result.spatial.depth_m.length,
      );
      expect(run.result.spatial.columns.length).toBeGreaterThanOrEqual(
        preview.result.spatial.columns.length,
      );
      expect(run.result.spatial.snapshots.length).toBeGreaterThan(1);
      expectLabFields(run.result);
      // Early on, the water has not reached the bottom of the bed yet.
      const first = run.result.spatial.snapshots[0].wetted_fraction ?? [];
      expect(Math.min(...first.flat())).toBeLessThan(1);
      expect(run.result.summary.species.map((x) => x.id)).toEqual([
        'caffeine',
        'trigonelline',
        'cqa5',
        'acids',
      ]);
    },
    // Tier 1 takes up to about a second here; CI runners can be several times slower.
    30_000,
  );

  it('simulates a built spec directly, giving the same result as simulateRecipe', () => {
    const recipe = cases()[0][1];
    const run = JSON.parse(core.simulateRecipe(JSON.stringify(recipe))) as {
      build: BuiltSpec;
      result: unknown;
    };
    expect(JSON.parse(core.simulateShot(JSON.stringify(run.build.spec)))).toEqual(run.result);
  });

  it.each([
    ['an unknown field', { ...BASE, colour: 'red' }, /unknown field `colour`/],
    ['a dose that does not fit', { ...BASE, prep: { dose_g: 59 } }, /^prep\.dose_g: 59 g makes a/],
    ['an unknown preset', { ...BASE, basket: { preset: 'no-such' } }, /no-such/],
    [
      'an override out of range',
      { ...BASE, overrides: { 'extraction.max_yield': 150 } },
      /outside its range/,
    ],
  ])('rejects %s with a readable Error', (_name, recipe, message) => {
    expect(() => core.buildShotSpec(JSON.stringify(recipe))).toThrow(message);
  });

  it('catches results that break the contract', () => {
    expect(checkShotResult({})).toContain('summary: must be an object');
    expect(
      checkShotResult({
        schema: 'puckworks.shot-result/1',
        core_version: '1',
        summary: {},
        series: { t_s: [0, 1], pressure_pa: [0] },
        spatial: {},
        diagnostics: {},
      }).length,
    ).toBeGreaterThan(5);
  });
});
