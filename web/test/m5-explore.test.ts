// SPDX-License-Identifier: GPL-2.0-or-later
/** Real shared-core synthetic M5 checks. No measured-shot accuracy claim. */
import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/engine/protocol';
import type { RecipeRunData } from '../src/engine/shotData';
import type { Recipe } from '../src/engine/shotTypes';
import { loadPuckcore } from './loadWasm';

const recipe: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: { preset: 'medium-washed-arabica' },
  grinder: { preset: 'generic-flat-traditional-64', setting: 190 },
  basket: { preset: '58-precision-18g' },
  prep: { dose_g: 18 },
  machine: { preset: 'flat-9-bar' },
  stop: { beverage_g: 24 },
  numerics: { tier: 0, size_classes: 3 },
};
function explore(
  resolution: 'standard' | 'high',
  cell: number,
  input: Recipe = recipe,
): RecipeRunData {
  const { response } = handleRequest(loadPuckcore(), {
    id: 1,
    method: 'simulateExplore',
    params: { recipe: input, request: { column: 0, cell, resolution } },
  });
  if (!response.ok) throw new Error(response.error.message);
  if (response.method !== 'simulateExplore') throw new Error('Unexpected Explore result');
  return response.result;
}

describe('M5 actual browser WASM', () => {
  it('exports actual standard/refined Tier1 states through the production worker protocol', () => {
    const standard = explore('standard', 15);
    const high = explore('high', 149);
    expect(standard.build.spec.numerics.tier).toBe(1);
    expect(high.build.spec.numerics.tier).toBe(1);
    expect(high.result.spatial.depth_m).toHaveLength(5 * standard.result.spatial.depth_m.length);
    expect(high.result.spatial.micro?.depth_cells).toBe(150);
    expect(high.result.spatial.micro?.resolution).toBe('high');
    for (const run of [standard, high]) {
      const metadata = run.result.spatial.micro!;
      expect(run.result.diagnostics.mass_balance_error).toBeLessThan(1e-9);
      for (const snapshot of run.result.spatial.snapshots) {
        const micro = snapshot.micro!;
        const weightedEy = micro.class_ey.reduce(
          (sum, ey, i) => sum + ey * metadata.classes[i].volume_fraction,
          0,
        );
        expect(weightedEy).toBeCloseTo(snapshot.local_ey[metadata.column][metadata.cell], 12);
        expect(micro.kernel_conc_kg_m3.flat().every(Number.isFinite)).toBe(true);
        expect(snapshot.column_flow_m3_s?.every(Number.isFinite)).toBe(true);
        expect(snapshot.bed_temperature_c).toBeTypeOf('number');
      }
    }
  }, 60_000);

  it('keeps the full default refined mesh bounded, conservative and thermally physical', () => {
    const full = { ...recipe, stop: { beverage_g: 36 }, numerics: { tier: 0 as const } };
    const high = explore('high', 149, full);
    expect(high.result.spatial.micro?.classes).toHaveLength(30);
    expect(high.result.spatial.depth_m).toHaveLength(150);
    expect(high.result.diagnostics.mass_balance_error).toBeLessThan(1e-9);
    expect(high.result.diagnostics.hydraulic_volume_balance_error).toBeLessThan(1e-9);
    const thermal = high.build.spec.thermal;
    const low = Math.min(
      thermal.initial_bed_temp_c,
      thermal.water_temp_c,
      thermal.ambient_temp_c ?? 20,
    );
    const highTemp = Math.max(
      thermal.initial_bed_temp_c,
      thermal.water_temp_c,
      thermal.ambient_temp_c ?? 20,
    );
    for (const snapshot of high.result.spatial.snapshots) {
      expect(snapshot.bed_temperature_c).toBeGreaterThanOrEqual(low - 1e-8);
      expect(snapshot.bed_temperature_c).toBeLessThanOrEqual(highTemp + 1e-8);
      expect(
        snapshot.local_ey
          .flat()
          .every(
            (ey) =>
              Number.isFinite(ey) &&
              ey >= -1e-12 &&
              ey <= high.build.spec.solubles.extractable_fraction + 1e-10,
          ),
      ).toBe(true);
      expect(
        snapshot.liquid_conc_kg_m3.flat().every((c) => Number.isFinite(c) && c >= -1e-10),
      ).toBe(true);
      expect(
        snapshot.wetted_fraction
          ?.flat()
          .every((wet) => Number.isFinite(wet) && wet >= 0 && wet <= 1),
      ).toBe(true);
      snapshot.micro!.kernel_conc_kg_m3.forEach((shells, i) => {
        const initial = high.result.spatial.micro!.classes[i].initial_kernel_conc_kg_m3;
        expect(shells.every((u) => Number.isFinite(u) && u >= -1e-10 && u <= initial + 1e-8)).toBe(
          true,
        );
      });
    }
  }, 60_000);
});
