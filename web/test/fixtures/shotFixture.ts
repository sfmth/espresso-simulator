// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Fixtures for the shot lab's tests: the real catalog and builds (from the
 * WASM engine, so presets, registry and provenance are the true ones) and a
 * small hand-written placeholder ShotResult with known numbers, so component
 * tests can assert exact values.
 */
import { toShotRunData, type RecipeRunData } from '../../src/engine/shotData';
import type { BuiltSpec, Catalog, Recipe, ShotResult } from '../../src/engine/shotTypes';
import { loadPuckcore } from '../loadWasm';

let catalogCache: Catalog | null = null;

/** The engine's presets and registry. */
export function fixtureCatalog(): Catalog {
  const core = loadPuckcore();
  catalogCache ??= {
    coreVersion: core.coreVersion(),
    presets: JSON.parse(core.presets()) as Catalog['presets'],
    registry: JSON.parse(core.registry()) as Catalog['registry'],
  };
  return catalogCache;
}

/** The real build of a recipe. */
export function fixtureBuild(recipe: Recipe): BuiltSpec {
  return JSON.parse(loadPuckcore().buildShotSpec(JSON.stringify(recipe))) as BuiltSpec;
}

export interface FixtureOptions {
  /** Extraction yield of the cup (fraction); TDS and species scale with it. */
  ey?: number;
  /** Output times. */
  points?: number;
  columns?: number;
  cells?: number;
  snapshots?: number;
  /** Size classes reported in class_ey. */
  classes?: number;
  warnings?: string[];
}

/** A small, smooth, self-consistent placeholder result (not physics). */
export function fixtureResult({
  ey = 0.2,
  points = 41,
  columns = 3,
  cells = 4,
  snapshots = 3,
  classes = 6,
  warnings = ['Fixture warning: not a real result.'],
}: FixtureOptions = {}): ShotResult {
  const dose = 0.018;
  const tEnd = 30;
  const t = Array.from({ length: points }, (_, i) => (i * tEnd) / (points - 1));
  const firstDrops = 6;
  const flowOut = t.map((x) => (x < firstDrops ? 0 : 2e-6));
  const beverage = t.map((x) =>
    x < firstDrops ? 0 : (0.036 * (x - firstDrops)) / (tEnd - firstDrops),
  );
  const eyCurve = t.map((x) =>
    x < firstDrops ? 0 : (ey * (x - firstDrops)) / (tEnd - firstDrops),
  );
  const tdsCup = eyCurve.map((e, i) => (beverage[i] > 0 ? (e * dose) / beverage[i] : 0));
  const species = [
    ['caffeine', 0.012],
    ['trigonelline', 0.007],
    ['cqa5', 0.0114],
    ['acids', 0.024],
  ] as const;
  const extracted = Math.min(1, ey / 0.28);
  const depth = Array.from({ length: cells }, (_, k) => ((k + 0.5) * 0.012) / cells);
  const floor = 0.027;
  const columnInfo = Array.from({ length: columns }, (_, j) => ({
    inner_radius_m: floor * Math.sqrt(j / columns),
    outer_radius_m: floor * Math.sqrt((j + 1) / columns),
    area_fraction: 1 / columns,
    permeability_multiplier: 1 + 0.1 * (j - 1),
  }));
  const snapshotTimes = Array.from({ length: snapshots }, (_, s) => ((s + 1) * tEnd) / snapshots);
  return {
    schema: 'puckworks.shot-result/1',
    core_version: 'fixture',
    summary: {
      stop_reason: 'beverage_mass',
      shot_time_s: tEnd,
      first_drops_s: firstDrops,
      beverage_mass_kg: 0.036,
      drip_mass_kg: 0.0015,
      tds: (ey * dose) / 0.036,
      ey,
      max_pressure_pa: 9e5,
      bed_height_m: 0.012,
      headspace_m3: 2.4e-5,
      species: species.map(([id, content]) => ({
        id,
        mass_kg: content * dose * extracted,
        extracted_fraction: extracted,
      })),
      uniformity: { ey_std: 0.02, ey_min: ey - 0.05, ey_max: ey + 0.04, ey_mean: ey + 0.01 },
    },
    series: {
      t_s: t,
      pressure_pa: t.map((x) => Math.min(1, x / 3) * 9e5),
      flow_in_m3_s: t.map((x) => (x < firstDrops ? 4e-6 : 2e-6)),
      flow_out_m3_s: flowOut,
      beverage_mass_kg: beverage,
      tds_cup: tdsCup,
      tds_outlet: t.map((x) => (x < firstDrops ? 0 : 0.2 * Math.exp(-(x - firstDrops) / 10))),
      ey: eyCurve,
      outlet_temp_c: t.map((x) => 85 + x / 6),
      species_cup_kg: species.map(([id, content]) => ({
        id,
        values: eyCurve.map((e) => content * dose * Math.min(1, e / 0.28)),
      })),
      wetted_fraction: t.map((x) => Math.min(1, x / firstDrops)),
    },
    spatial: {
      depth_m: depth,
      depth_edges_m: Array.from({ length: cells + 1 }, (_, k) => (k * 0.012) / cells),
      columns: columnInfo,
      snapshots: snapshotTimes.map((time, s) => {
        const progress = (s + 1) / snapshots;
        return {
          t_s: time,
          local_ey: columnInfo.map((_, j) =>
            depth.map((_d, k) =>
              k === cells - 1 && s === 0 ? -0.01 : progress * (ey + 0.03 * (1 - j) - 0.01 * k),
            ),
          ),
          liquid_conc_kg_m3: columnInfo.map((_, j) =>
            depth.map((_d, k) => 100 * progress + 10 * j + k),
          ),
          // The first snapshot catches the wetting front in the second cell.
          wetted_fraction: columnInfo.map(() =>
            depth.map((_d, k) => (s > 0 || k === 0 ? 1 : k === 1 ? 0.5 : 0)),
          ),
        };
      }),
      class_ey: Array.from({ length: classes }, (_, i) => ({
        radius_m: 10e-6 * 2 ** i,
        ey: Math.max(0.05, 0.3 - 0.03 * i),
      })),
    },
    diagnostics: {
      mass_balance_error: 1.5e-15,
      steps: 400,
      warnings,
      min_concentration_kg_m3: 0,
      tier: 1,
      outflow_integral_error: 1.2e-3,
    },
  };
}

/** What the engine's simulateRecipe returns for `recipe`, with the placeholder result. */
export function fixtureRun(recipe: Recipe, options: FixtureOptions = {}): RecipeRunData {
  return {
    build: fixtureBuild(recipe),
    ...toShotRunData(fixtureResult(options), 12.5),
  };
}
