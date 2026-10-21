// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog, fixtureResult } from '../../test/fixtures/shotFixture';
import { loadPuckcore } from '../../test/loadWasm';
import type { Engine } from '../engine/engine';
import { toShotRunData } from '../engine/shotData';
import type { Recipe, ShotResult } from '../engine/shotTypes';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { applySetupLocks, inferSetups, validateInferenceRequest } from './inference';
import type { InferenceRequest, SetupObservation } from './inferenceTypes';

const catalog = fixtureCatalog();
const K = 'hydraulics.permeability.reference';
const K0 = catalog.registry.parameters.find((p) => p.id === K)!.default;
const recipe: Recipe = {
  ...structuredClone(DEFAULT_RECIPE),
  machine: { ...DEFAULT_RECIPE.machine, headspace_ml: 5 },
};
function measured(overrides: Partial<SetupObservation> = {}): SetupObservation {
  return {
    id: 'one',
    label: 'Shot one',
    recipe: structuredClone(recipe),
    timeS: 36,
    yieldG: 31 * (190 / 200) - 5,
    timeBasis: 'pump',
    massBasis: 'final',
    timeToleranceS: 0,
    yieldToleranceG: 0.3,
    ...overrides,
  };
}
function request(patch: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    recipe,
    constraints: [
      { path: `overrides.${K}`, mode: 'range', min: K0 * 0.6, max: K0 * 1.4 },
      { path: 'machine.headspace_ml', mode: 'range', min: 0, max: 10 },
      { path: 'prep.distribution', mode: 'locked', value: 'wdt' },
    ],
    observations: [measured()],
    maxEvaluations: 240,
    ...patch,
  };
}
function fakeEngine(
  options: {
    tierBias?: number;
    onCall?: () => void;
    invalidTier1?: boolean;
    dripping?: boolean;
  } = {},
) {
  const calls: Recipe[] = [];
  const engine = {
    coreVersion: () => Promise.resolve({ result: catalog.coreVersion, runtimeMs: 0 }),
    simulateRecipe: (input: Recipe) => {
      calls.push(structuredClone(input));
      options.onCall?.();
      const build = fixtureBuild(input);
      const result = fixtureResult({ warnings: [] });
      const time = input.stop.time_s!;
      const k = (input.overrides?.[K] ?? K0) / K0;
      const setting = input.grinder.setting ?? 190;
      const finalG =
        (time - 5) * k * (setting / 200) -
        (input.machine.headspace_ml ?? 5) +
        (input.numerics?.tier === 0 ? (options.tierBias ?? 0) : 0);
      result.summary = {
        ...result.summary,
        stop_reason: 'time',
        shot_time_s: time,
        first_drops_s: 5,
        beverage_mass_kg: Math.max(0.0001, finalG / 1000),
        drip_mass_kg: options.dripping ? 0.003 : 0,
        tds: 0.08 + (k - 1) * 0.01,
      };
      result.series.t_s = [0, 5, time, time + 5];
      result.series.tds_cup = [0, 0, 0.1, result.summary.tds];
      if (options.invalidTier1 && input.numerics?.tier === 1)
        result.diagnostics.mass_balance_error = 0.2;
      return Promise.resolve({ result: { build, ...toShotRunData(result, 0) }, runtimeMs: 0 });
    },
  } as unknown as Engine;
  return { engine, calls };
}

describe('setup inference', () => {
  it('rejects a native gap floor even when the dial setting itself is unchanged', async () => {
    const configured = structuredClone(recipe);
    configured.grinder.gap_at_ref_um = 0;
    configured.grinder.gap_per_unit_um = 0.02;
    const build = fixtureBuild(configured);
    expect(build.derived.psd?.setting).toBe(190);
    expect(build.derived.psd?.gap_um).toBe(5);
    const result = await inferSetups(
      fakeEngine().engine,
      catalog,
      request({
        recipe: configured,
        constraints: [
          { path: 'grinder.setting', mode: 'locked', value: 190 },
          { path: 'grinder.gap_at_ref_um', mode: 'locked', value: 0 },
          { path: 'grinder.gap_per_unit_um', mode: 'locked', value: 0.02 },
        ],
        maxEvaluations: 16,
      }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.nearMisses).toHaveLength(0);
    expect(result.notes.join(' ')).toContain('clamp or replace');
  });

  it('applies exact known facts when activating an unfitted setup without inventing unknown values', () => {
    const configured = applySetupLocks(
      recipe,
      [
        { path: 'machine.temperature_c', mode: 'locked', value: 95 },
        { path: 'prep.distribution', mode: 'locked', value: 'wdt' },
        { path: 'machine.headspace_ml', mode: 'range', min: 2, max: 4 },
        { path: `overrides.${K}`, mode: 'unknown' },
      ],
      catalog,
    );
    expect(fixtureBuild(configured).spec.thermal.water_temp_c).toBe(95);
    expect(configured.prep.distribution).toBe('wdt');
    expect(configured.machine.headspace_ml).toBe(recipe.machine.headspace_ml);
    expect(configured.overrides?.[K]).toBeUndefined();
    expect(recipe.machine.temperature_c).toBeUndefined();
    expect(() =>
      applySetupLocks(
        recipe,
        [{ path: 'machine.temperature_c', mode: 'locked', value: NaN }],
        catalog,
      ),
    ).toThrow();
  });

  it('retains distinct confounded explanations and verifies every returned explanation at Tier 1', async () => {
    const fake = fakeEngine();
    const result = await inferSetups(fake.engine, catalog, request());
    expect(result.candidates.length).toBeGreaterThan(1);
    for (const candidate of [...result.candidates, ...result.nearMisses]) {
      expect(candidate.checks).toHaveLength(1);
      expect(candidate.recipe.prep.distribution).toBe('wdt');
      expect(candidate.recipe.stop).toEqual(recipe.stop);
      expect(candidate.matches).toBe(candidate.checks.every((c) => c.matches));
      expect(
        fake.calls.some(
          (r) =>
            r.numerics?.tier === 1 &&
            r.overrides?.[K] === candidate.values[`overrides.${K}`] &&
            r.machine.headspace_ml === candidate.values['machine.headspace_ml'],
        ),
      ).toBe(true);
      expect(candidate.notes.join(' ')).toContain('does not establish a unique setup');
    }
    expect(result.evaluations).toBe(fake.calls.length);
    expect(result.evaluations).toBeLessThanOrEqual(240);
    expect(result.notes.join(' ')).toContain('more free setup coordinates');
  });

  it('uses known shot changes and additional observations to narrow a confounded setup', async () => {
    const single = await inferSetups(
      fakeEngine().engine,
      catalog,
      request({ maxEvaluations: 480 }),
    );
    const second = measured({
      id: 'two',
      label: 'Shot two',
      recipe: { ...recipe, grinder: { ...recipe.grinder, setting: 300 } },
      changes: ['grinder.setting'],
      yieldG: 31 * 1.5 - 5,
    });
    const fake = fakeEngine();
    const multiple = await inferSetups(
      fake.engine,
      catalog,
      request({ maxEvaluations: 480, observations: [measured(), second] }),
    );
    expect(multiple.candidates.length).toBeGreaterThan(0);
    multiple.candidates.forEach((candidate) =>
      expect(candidate.checks.every((c) => c.matches)).toBe(true),
    );
    const span = (result: typeof single) => {
      const values = result.candidates.map((c) => c.values['machine.headspace_ml'] as number);
      return Math.max(...values) - Math.min(...values);
    };
    expect(span(multiple)).toBeLessThan(span(single));
    expect(fake.calls.some((r) => r.grinder.setting === 300)).toBe(true);
  });

  it('does not use recorded shot snapshot differences unless explicitly marked known', async () => {
    const fake = fakeEngine();
    await inferSetups(
      fake.engine,
      catalog,
      request({
        observations: [
          measured({ recipe: { ...recipe, grinder: { ...recipe.grinder, setting: 300 } } }),
        ],
        maxEvaluations: 48,
      }),
    );
    expect(fake.calls.every((r) => r.grinder.setting === 190)).toBe(true);
  });

  it('searches allowed categorical choices and exact numeric grids without changing locks', async () => {
    const fake = fakeEngine();
    const result = await inferSetups(
      fake.engine,
      catalog,
      request({
        constraints: [
          { path: 'prep.distribution', mode: 'range', choices: ['tap', 'wdt'] },
          { path: 'machine.headspace_ml', mode: 'range', min: 4, max: 6, step: 1 },
          { path: 'grinder.setting', mode: 'locked', value: 190 },
          { path: 'machine.temperature_c', mode: 'locked', value: 95 },
        ],
        maxEvaluations: 120,
      }),
    );
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(
      new Set(result.candidates.map((candidate) => candidate.recipe.prep.distribution)),
    ).toEqual(new Set(['tap', 'wdt']));
    expect(
      fake.calls.every(
        (r) =>
          r.machine.temperature_c === 95 &&
          r.grinder.setting === 190 &&
          Number.isInteger(r.machine.headspace_ml),
      ),
    ).toBe(true);
  });

  it('corrects preview disagreement with full-tier refinement and never returns preview-only matches', async () => {
    const fake = fakeEngine({ tierBias: 3 });
    const result = await inferSetups(
      fake.engine,
      catalog,
      request({
        constraints: [{ path: `overrides.${K}`, mode: 'range', min: K0 * 0.6, max: K0 * 1.4 }],
        observations: [measured({ yieldToleranceG: 0.2 })],
        maxEvaluations: 160,
      }),
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(Math.abs(candidate.checks[0].residuals.yieldG)).toBeLessThanOrEqual(0.2);
      expect((candidate.values[`overrides.${K}`] as number) / K0).toBeCloseTo(1, 1);
    }
  });

  it('never returns an upper bound outside the requested numeric step lattice', async () => {
    const fake = fakeEngine();
    await inferSetups(
      fake.engine,
      catalog,
      request({
        constraints: [{ path: 'machine.headspace_ml', mode: 'range', min: 0, max: 10, step: 3 }],
        maxEvaluations: 48,
      }),
    );
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((r) => [0, 3, 6, 9].includes(r.machine.headspace_ml!))).toBe(true);
  });

  it('preserves shared locks while applying an explicitly known change only to its recorded shot', async () => {
    const fake = fakeEngine();
    const result = await inferSetups(
      fake.engine,
      catalog,
      request({
        constraints: [{ path: 'grinder.setting', mode: 'locked', value: 190 }],
        observations: [
          measured(),
          measured({
            id: 'changed',
            recipe: { ...recipe, grinder: { ...recipe.grinder, setting: 250 } },
            changes: ['grinder.setting'],
            yieldG: 31 * 1.25 - 5,
          }),
        ],
        maxEvaluations: 32,
      }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].recipe.grinder.setting).toBe(190);
    expect(result.candidates[0].checks).toHaveLength(2);
    expect(new Set(fake.calls.map((r) => r.grinder.setting))).toEqual(new Set([190, 250]));
  });

  it('refuses a family swap that would reinterpret an exactly locked named-dial reference gap', () => {
    const named = {
      ...structuredClone(recipe),
      grinder: { preset: 'mahlkoenig-e65s', setting: 1.7, gap_at_ref_um: 195, gap_per_unit_um: 25 },
    };
    expect(fixtureBuild(named).derived.psd?.gap_um).toBeCloseTo(202.5);
    const known: InferenceRequest['constraints'] = [
      { path: 'grinder.setting', mode: 'locked', value: 1.7 },
      { path: 'grinder.gap_at_ref_um', mode: 'locked', value: 195 },
      { path: 'grinder.gap_per_unit_um', mode: 'locked', value: 25 },
      { path: 'grinder.family', mode: 'locked', value: 'conical' },
    ];
    expect(() => applySetupLocks(named, known, catalog)).toThrow('named dial reference');
    expect(() =>
      validateInferenceRequest(request({ recipe: named, constraints: known }), catalog),
    ).toThrow('named dial reference');
    known[3].value = 'flat-traditional';
    expect(fixtureBuild(applySetupLocks(named, known, catalog)).derived.psd?.gap_um).toBeCloseTo(
      202.5,
    );
    known[3] = { path: 'grinder.preset', mode: 'locked', value: 'amzchef-single-dose' };
    expect(() => applySetupLocks(named, known, catalog)).toThrow('named dial reference');
    const zeroReference = {
      ...named,
      grinder: { ...named.grinder, preset: 'amzchef-single-dose' },
    };
    known[3].value = 'mahlkoenig-e65s';
    expect(() => applySetupLocks(zeroReference, known, catalog)).toThrow('named dial reference');
  });

  it.each(['locked', 'range'] as const)(
    'does not let a known per-shot preset silently replace another shared %s physical value',
    async (mode) => {
      const fake = fakeEngine();
      const named = {
        ...structuredClone(recipe),
        grinder: { preset: 'mahlkoenig-e65s', setting: 1.7 },
      };
      const different = {
        ...structuredClone(named),
        grinder: { preset: 'amzchef-single-dose', setting: 1.7 },
      };
      const result = await inferSetups(
        fake.engine,
        catalog,
        request({
          recipe: named,
          constraints: [
            {
              path: 'grinder.family',
              mode,
              value: 'flat-traditional',
              choices: ['flat-traditional'],
            },
          ],
          observations: [measured({ recipe: different, changes: ['grinder.preset'] })],
          maxEvaluations: 16,
        }),
      );
      expect(result.candidates).toEqual([]);
      expect(fake.calls).toEqual([]);
      expect(result.notes.join(' ')).toContain(
        `shared ${mode === 'locked' ? 'locked' : 'inferred'} value of Burr family`,
      );
    },
  );

  it('retains the physical meaning of a shared reference-gap lock after a shot-specific preset change', async () => {
    const fake = fakeEngine();
    const named = {
      ...structuredClone(recipe),
      grinder: { preset: 'mahlkoenig-e65s', setting: 1.7 },
    };
    const other = {
      ...structuredClone(named),
      grinder: { preset: 'amzchef-single-dose', setting: 1.7 },
    };
    const result = await inferSetups(
      fake.engine,
      catalog,
      request({
        recipe: named,
        constraints: [{ path: 'grinder.gap_at_ref_um', mode: 'locked', value: 195 }],
        observations: [measured({ recipe: other, changes: ['grinder.preset'] })],
        maxEvaluations: 16,
      }),
    );
    expect(fake.calls).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.notes.join(' ')).toContain('named dial reference');
  });

  it('refuses a clamped exact grinder value rather than presenting it as a successful lock', async () => {
    const explicitGap: Recipe = { ...recipe, grinder: { family: 'flat-traditional', gap_um: 1 } };
    const result = await inferSetups(
      fakeEngine().engine,
      catalog,
      request({
        recipe: explicitGap,
        constraints: [{ path: 'grinder.gap_um', mode: 'locked', value: 1 }],
        observations: [measured({ recipe: explicitGap })],
        maxEvaluations: 16,
      }),
    );
    expect(result.candidates).toEqual([]);
    expect(result.notes.join(' ')).toContain('clamp');
  });

  it('separates verified near misses and rejects failed Tier 1 diagnostics', async () => {
    const impossible = await inferSetups(
      fakeEngine().engine,
      catalog,
      request({ constraints: [], observations: [measured({ yieldG: 100 })], maxEvaluations: 32 }),
    );
    expect(impossible.candidates).toEqual([]);
    expect(impossible.nearMisses).toHaveLength(1);
    expect(impossible.nearMisses[0].checks[0].residuals.yieldG).toBeLessThan(-50);
    const failed = await inferSetups(
      fakeEngine({ invalidTier1: true }).engine,
      catalog,
      request({ constraints: [], maxEvaluations: 32 }),
    );
    expect(failed.candidates).toEqual([]);
    expect(failed.nearMisses).toEqual([]);
    expect(failed.skipped).toBeGreaterThan(0);
  });

  it('keeps observation timing as a bounded replay condition and handles first-drip time', async () => {
    const fake = fakeEngine();
    const result = await inferSetups(
      fake.engine,
      catalog,
      request({
        constraints: [],
        observations: [measured({ timeS: 31, timeBasis: 'first-drip' })],
        maxEvaluations: 32,
      }),
    );
    expect(result.candidates, JSON.stringify(result)).toHaveLength(1);
    expect(result.candidates[0].checks[0].predicted.timeS).toBe(31);
    expect(result.candidates[0].checks[0].timeIsReplayCondition).toBe(true);
    expect(fake.calls.map((r) => r.stop.time_s)).toContain(36);
  });

  it('uses timing tolerance without inflating mass tolerance or claiming imposed time is predicted', async () => {
    const fake = fakeEngine();
    const result = await inferSetups(
      fake.engine,
      catalog,
      request({
        constraints: [],
        observations: [
          measured({ yieldG: measured().yieldG + 0.8, timeToleranceS: 1.5, yieldToleranceG: 0.2 }),
        ],
        maxEvaluations: 32,
      }),
    );
    expect(result.candidates, JSON.stringify(result)).toHaveLength(1);
    const check = result.candidates[0].checks[0];
    expect(Math.abs(check.residuals.timeS)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(check.residuals.yieldG)).toBeLessThanOrEqual(0.2);
    expect(check.tolerances.yieldG).toBe(0.2);
  });

  it('compares pump-stop mass and TDS at pump stop rather than the final dripping cup', async () => {
    const result = await inferSetups(
      fakeEngine({ dripping: true }).engine,
      catalog,
      request({
        constraints: [],
        observations: [
          measured({
            massBasis: 'pump-stop',
            yieldG: measured().yieldG - 3,
            tdsPercent: 10,
            tdsTolerancePercent: 0.01,
          }),
        ],
        maxEvaluations: 32,
      }),
    );
    expect(result.candidates, JSON.stringify(result)).toHaveLength(1);
    expect(result.candidates[0].checks[0].predicted.tdsPercent).toBe(10);
  });

  it('is deterministic, honors the total call budget and propagates cancellation', async () => {
    const a = await inferSetups(
      fakeEngine().engine,
      catalog,
      request({ maxEvaluations: 40, seed: 42 }),
    );
    const b = await inferSetups(
      fakeEngine().engine,
      catalog,
      request({ maxEvaluations: 40, seed: 42 }),
    );
    expect(a).toEqual(b);
    expect(a.evaluations).toBeLessThanOrEqual(40);
    const controller = new AbortController();
    const fake = fakeEngine({ onCall: () => controller.abort() });
    await expect(
      inferSetups(fake.engine, catalog, request(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls).toHaveLength(1);
    await expect(
      inferSetups(fake.engine, catalog, request(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls).toHaveLength(1);
  });

  it('rejects invalid bounds, inactive controls, unknown paths and mismatched versions before physics', async () => {
    for (const constraint of [
      { path: 'grinder.rpm', mode: 'unknown' as const },
      { path: 'prep.dose_g', mode: 'range' as const, min: 20, max: 10 },
      { path: 'numerics.tier', mode: 'range' as const, min: 0, max: 1 },
      { path: '__proto__.polluted', mode: 'locked' as const, value: true },
      { path: 'prep.distribution', mode: 'range' as const, choices: ['invalid'] },
    ]) {
      const fake = fakeEngine();
      await expect(
        inferSetups(fake.engine, catalog, request({ constraints: [constraint] })),
      ).rejects.toThrow();
      expect(fake.calls).toEqual([]);
    }
    expect(() => validateInferenceRequest(request({ observations: [] }), catalog)).toThrow();
    await expect(
      inferSetups(fakeEngine().engine, { ...catalog, coreVersion: 'stale' }, request()),
    ).rejects.toThrow('versions differ');
  });

  it('replays one real native-engine observation with exact physical locks', async () => {
    const core = loadPuckcore();
    const realRecipe = { ...structuredClone(DEFAULT_RECIPE), stop: { time_s: 30 } };
    const nativeRun = (input: Recipe) =>
      JSON.parse(core.simulateRecipe(JSON.stringify(input))) as {
        build: ReturnType<typeof fixtureBuild>;
        result: ShotResult;
      };
    const measuredRun = nativeRun(realRecipe);
    const observation = measured({
      recipe: realRecipe,
      timeS: measuredRun.result.summary.shot_time_s,
      yieldG: measuredRun.result.summary.beverage_mass_kg * 1000,
      tdsPercent: measuredRun.result.summary.tds * 100,
      tdsTolerancePercent: 0.001,
      yieldToleranceG: 0.001,
    });
    const engine = {
      coreVersion: () => Promise.resolve({ result: catalog.coreVersion, runtimeMs: 0 }),
      simulateRecipe: (input: Recipe) => {
        const raw = nativeRun(input);
        return Promise.resolve({
          result: { build: raw.build, ...toShotRunData(raw.result, 0) },
          runtimeMs: 0,
        });
      },
    } as unknown as Engine;
    const result = await inferSetups(engine, catalog, {
      recipe: realRecipe,
      constraints: [{ path: 'prep.distribution', mode: 'locked', value: 'wdt' }],
      observations: [observation],
      maxEvaluations: 12,
    });
    expect(result.candidates, JSON.stringify(result)).toHaveLength(1);
    expect(result.candidates[0].checks[0].residuals.yieldG).toBeCloseTo(0, 8);
    expect(result.candidates[0].checks[0].residuals.tdsPercent).toBeCloseTo(0, 8);
  });
});
