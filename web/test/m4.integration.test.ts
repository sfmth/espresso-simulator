// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Synthetic M4 plumbing verification against the actual browser WASM module.
 * These generated observations are not independent measurements or V9 evidence.
 */
import { describe, expect, it } from 'vitest';
import { EngineError, type CallOptions, type Engine, type Timed } from '../src/engine/engine';
import { handleRequest, type EngineMethod, type EngineMethods } from '../src/engine/protocol';
import type { PuckcoreModule } from '../src/engine/types';
import type { Recipe } from '../src/engine/shotTypes';
import { applyCalibration, calibrate } from '../src/dialin/calibration';
import { searchRecipes } from '../src/dialin/inverse';
import { emptyJournal, openJournal, parseJournal, scorecard } from '../src/dialin/journal';
import { learnTaste } from '../src/dialin/learning';
import type { JournalEntry } from '../src/dialin/types';
import { loadPuckcore } from './loadWasm';

/** Same request handler and WASM as a worker, without a browser Worker wrapper. */
function actualEngine(): Engine {
  const core = loadPuckcore() as unknown as PuckcoreModule;
  let requestId = 0;
  const call = async <T extends EngineMethod>(
    method: T,
    params: EngineMethods[T]['params'],
    options?: CallOptions,
  ): Promise<Timed<EngineMethods[T]['result']>> => {
    await Promise.resolve();
    options?.signal?.throwIfAborted();
    const { response } = handleRequest(core, { id: ++requestId, method, params });
    if (!response.ok) throw new EngineError(response.error.kind, response.error.message);
    return { result: response.result, runtimeMs: response.runtimeMs };
  };
  return {
    coreVersion: (options) => call('coreVersion', null, options),
    catalog: (options) => call('catalog', null, options),
    buildShotSpec: (recipe, options) => call('buildShotSpec', { recipe }, options),
    simulateRecipe: (recipe, options) => call('simulateRecipe', { recipe }, options),
    sweepPoint: (recipe, options) => call('sweepPoint', { recipe }, options),
    simulateShot: (spec, options) => call('simulateShot', { spec }, options),
    simulateUncertainty: (recipe, uncertainty, options) =>
      call('simulateUncertainty', { recipe, options: uncertainty }, options),
    simulateSphereRelease: (params, options) => call('simulateSphereRelease', params, options),
    terminate() {
      /* Synchronous Node adapter owns no workers. */
    },
  };
}

const base: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: { preset: 'medium-washed-arabica' },
  chemistry: { enabled: true },
  grinder: { preset: 'generic-flat-traditional-64', setting: 190 },
  basket: { preset: '58-precision-18g' },
  prep: { dose_g: 18 },
  machine: { preset: 'flat-9-bar' },
  stop: { beverage_g: 36 },
  numerics: { tier: 0, size_classes: 8 },
};

describe('synthetic M4 workflow using real WASM (not prospective validation)', () => {
  it('saves observations, fits/applies a profile and verifies all three inverse modes', async () => {
    const engine = actualEngine();
    const catalog = (await engine.catalog()).result;
    const reference = catalog.registry.parameters.find(
      (p) => p.id === 'hydraulics.permeability.reference',
    )!.default;
    const store = await openJournal();
    const document = emptyJournal();
    try {
      for (const [i, setting] of [175, 190, 205].entries()) {
        const recipe = structuredClone(base);
        recipe.grinder.setting = setting;
        const predicted = (await engine.simulateRecipe(recipe)).result;
        expect(predicted.taste).toBeDefined();
        const at = new Date().toISOString();
        const entry: JournalEntry = {
          id: `synthetic-training-${i}`,
          setupId: 'synthetic-home',
          source: 'manual',
          createdAt: at,
          label: 'Synthetic WASM integration fixture, not a measured shot',
          recipe,
          prediction: {
            recordedAt: at,
            coreVersion: catalog.coreVersion,
            executedRecipe: recipe,
            summary: predicted.result.summary,
            ...(predicted.taste ? { taste: predicted.taste } : {}),
            origin: 'app',
          },
        };
        document.entries.push(entry);
        await store.save(document); // Prediction must commit before an observation is added.
        const hidden = structuredClone(recipe);
        hidden.overrides = { 'hydraulics.permeability.reference': reference * Math.SQRT2 };
        const generated = (await engine.sweepPoint(hidden)).result.summary;
        entry.measurement = {
          recordedAt: new Date(Math.max(Date.now(), Date.parse(at) + 1)).toISOString(),
          timeS: generated.shot_time_s,
          yieldG: generated.beverage_mass_kg * 1000,
          tdsPercent: generated.tds * 100,
          rating: 4,
          notes: 'Synthetic generated observation; never V9 evidence.',
        };
        await store.save(document);
      }
      const reloaded = await store.load();
      const profile = await calibrate(engine, reloaded.entries, catalog, {
        setupId: 'synthetic-home',
        timeSigmaS: 0.5,
        tdsSigmaPercent: 0.2,
      });
      expect(profile.permeability).toBeCloseTo(Math.SQRT2, 8);
      expect(profile.checks).toHaveLength(3);
      expect(profile.checks.every((check) => Number.isFinite(check.timeErrorS))).toBe(true);
      document.calibrations.push(profile);
      await store.save(document);
      const imported = parseJournal(JSON.stringify(await store.load()));
      expect(imported.calibrations[0].id).toBe(profile.id);
      expect(imported.entries.every((entry) => entry.prediction?.origin === 'import')).toBe(true);
      expect(scorecard(imported.entries, imported.calibrations).met).toBe(false);
      expect(scorecard(reloaded.entries, [profile]).excluded.training).toBe(3);
      const applied = applyCalibration(base, profile, catalog.coreVersion);
      expect(applied.overrides?.['hydraulics.permeability.reference']).toBeCloseTo(
        reference * Math.SQRT2,
        25,
      );
      const target = (
        await engine.sweepPoint({ ...applied, numerics: { ...applied.numerics, tier: 1 } })
      ).result.summary;
      for (const mode of ['recipe', 'outcome', 'next'] as const) {
        const result = await searchRecipes(engine, base, catalog, {
          mode,
          calibration: profile,
          coreVersion: catalog.coreVersion,
          maxEvaluations: 12,
          targetTimeS: target.shot_time_s,
          targetYieldG: 36,
          ...(mode === 'outcome' ? { targetEyPercent: target.ey * 100 } : {}),
          ...(mode === 'next' ? { lastShot: reloaded.entries[1] } : {}),
          controls: { grinder: { min: 175, max: 205, step: 5 } },
        });
        expect(result.candidates.length, `${mode}: ${result.notes.join('; ')}`).toBeGreaterThan(0);
        expect(result.evaluations).toBeLessThanOrEqual(12);
        for (const candidate of result.candidates) {
          expect(candidate.executedRecipe.numerics?.tier).toBe(1);
          expect(candidate.score).toBeTypeOf('number');
          expect(candidate.verified.summary.stop_reason).not.toMatch(/choked|max_duration/);
          expect(candidate.envelope.kind).toBe(
            'local_control_perturbation_envelope_not_confidence_interval',
          );
        }
      }
      const preference = learnTaste(
        reloaded.entries,
        'synthetic-home',
        reloaded.entries[1].prediction?.taste,
      );
      expect(preference.count).toBe(3);
      expect(preference.prediction?.mean).toBeGreaterThanOrEqual(1);
      expect(preference.prediction?.mean).toBeLessThanOrEqual(5);
    } finally {
      store.close();
    }
  }, 60_000);
});
