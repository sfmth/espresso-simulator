// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import type { Engine } from '../engine/engine';
import type { Catalog, Diagnostics, Recipe, Summary } from '../engine/shotTypes';
import { applyCalibration, calibrate, scopeKey } from './calibration';
import type { JournalEntry } from './types';

const VERSION = 'test-core/1';
const REFERENCE_K = 2e-14;
const K = 'hydraulics.permeability.reference';
const catalog: Catalog = {
  coreVersion: VERSION,
  presets: {
    schema: 'puckworks.presets/1',
    grinders: [],
    baskets: [],
    machines: [],
    beans: [],
    grinder_families: [
      {
        id: 'flat',
        name: 'Flat',
        description: '',
        flags: [],
        notes: [],
        sources: [],
        evidence_grade: 'D',
        tag: 'generic',
        burr: 'flat',
        psd: { x50_gap_ratio: 1.4 },
      },
    ],
  },
  registry: {
    schema: 'puckworks.registry/1',
    calibration: null,
    parameters: [
      {
        id: K,
        name: K,
        description: '',
        units: 'm^2',
        range: { min: 1e-16, max: 1e-11 },
        default: REFERENCE_K,
        default_from: 'calibration',
        tag: 'fitted',
        evidence_grade: 'D',
        sources: [],
      },
    ],
  },
};

function recipe(setting = 3): Recipe {
  return {
    schema: 'puckworks.recipe/1',
    bean: { preset: 'bag-a', days_off_roast: 10 },
    grinder: { family: 'flat', setting },
    basket: { preset: 'basket' },
    prep: { dose_g: 18, distribution: 'wdt' },
    machine: { preset: 'machine', temperature_c: 93 },
    water: { alkalinity_mg_l_caco3: 40 },
    stop: { beverage_g: 36 },
  };
}

function summary(r: Recipe): Summary {
  // Deliberately simple fake observable mapping, not duplicated shot physics.
  // Time alone constrains only K*G²; TDS independently responds to G.
  const k = (r.overrides?.[K] ?? REFERENCE_K) / REFERENCE_K;
  const g = (r.grinder.x50_gap_ratio ?? 1.4) / 1.4;
  const flow = k * g * g * ((r.grinder.setting ?? 3) / 3);
  const t = r.stop.time_s ?? (r.stop.beverage_g ?? 36) / flow;
  const finalG = flow * t + 2;
  const tds = (8 + 10 * Math.log(g)) / 100;
  return {
    stop_reason: r.stop.time_s ? 'time' : 'beverage_mass',
    shot_time_s: t,
    first_drops_s: 1,
    beverage_mass_kg: finalG / 1000,
    drip_mass_kg: 0.002,
    tds,
    ey: (tds * finalG) / r.prep.dose_g,
    max_pressure_pa: 9e5,
    bed_height_m: 0.01,
    headspace_m3: 0.000002,
    species: [],
    uniformity: { ey_std: 0, ey_min: 0.1, ey_max: 0.2 },
  };
}

function fakeEngine(
  options: {
    fail?: (r: Recipe) => boolean;
    abort?: AbortController;
    constant?: boolean;
    diagnostics?: (recipe: Recipe) => Partial<Diagnostics>;
  } = {},
) {
  const calls: Recipe[] = [];
  const engine = {
    coreVersion: () => Promise.resolve({ result: VERSION, runtimeMs: 0 }),
    sweepPoint: async (r: Recipe, call?: { signal?: AbortSignal }) => {
      await Promise.resolve();
      call?.signal?.throwIfAborted();
      calls.push(structuredClone(r));
      if (options.abort && calls.length === 2) options.abort.abort();
      if (options.fail?.(r)) throw new Error('failed candidate');
      const output = summary(r);
      if (options.constant && r.stop.time_s) {
        output.beverage_mass_kg = 0.036;
        output.tds = 0.08;
      }
      return {
        result: {
          summary: output,
          diagnostics: {
            mass_balance_error: 0,
            steps: 1,
            warnings: [],
            ...options.diagnostics?.(r),
          },
          coreMs: 0,
        },
        runtimeMs: 0,
      };
    },
  } as unknown as Engine;
  return { engine, calls };
}

function entries(k = 1, g = 1, tds = false, count = 3): JournalEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const r = recipe(2 + (i % 3));
    const hidden = structuredClone(r);
    hidden.overrides = { [K]: REFERENCE_K * k };
    hidden.grinder.x50_gap_ratio = 1.4 * g;
    hidden.stop = { beverage_g: 34 };
    const observed = summary(hidden);
    return {
      id: `shot-${i}`,
      createdAt: `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
      setupId: 'home',
      label: '',
      source: 'manual',
      recipe: r,
      measurement: {
        recordedAt: '2026-10-01T12:00:00Z',
        timeS: observed.shot_time_s,
        yieldG: 36,
        tdsPercent: tds ? observed.tds * 100 : undefined,
        notes: '',
      },
    };
  });
}

const fitOptions = { setupId: 'home', timeSigmaS: 0.2, tdsSigmaPercent: 0.02 };

describe('local Bayesian calibration', () => {
  it('recovers synthetic permeability, preserves measurements and is deterministic', async () => {
    const shots = entries(Math.SQRT2);
    const original = structuredClone(shots);
    const fake = fakeEngine();
    const progress: [number, number][] = [];
    const profile = await calibrate(
      fake.engine,
      shots,
      catalog,
      fitOptions,
      undefined,
      (done, total) => progress.push([done, total]),
    );
    const repeated = await calibrate(fakeEngine().engine, shots, catalog, fitOptions);
    expect(profile.permeability).toBeCloseTo(Math.SQRT2, 10);
    expect(profile.grinderScale).toBe(1);
    expect(profile.posterior).toEqual(repeated.posterior);
    expect(profile.posterior.reduce((sum, point) => sum + point.weight, 0)).toBeCloseTo(1, 12);
    expect(profile.parameters[0].p05).toBeLessThanOrEqual(Math.SQRT2);
    expect(profile.parameters[0].p95).toBeGreaterThanOrEqual(Math.SQRT2 - 1e-12);
    expect(profile.checks).toHaveLength(3);
    expect(profile.checks.every((check) => Math.abs(check.timeErrorS) < 1e-8)).toBe(true);
    expect(profile.notes.join(' ')).toContain('including drip');
    expect(profile.notes.join(' ')).toContain('not identified or fitted');
    expect(profile.notes.join(' ')).toContain('Tier 0 → Tier 1 discrepancy');
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);
    expect(fake.calls.some((r) => r.numerics?.tier === 1 && r.stop.beverage_g === 34)).toBe(true);
    expect(shots).toEqual(original);
  });

  it('allows a joint size fit only with TDS at three distinct settings', async () => {
    const g = Math.sqrt(1.25);
    const profile = await calibrate(fakeEngine().engine, entries(Math.SQRT2, g, true), catalog, {
      ...fitOptions,
      fitGrinderScale: true,
    });
    expect(profile.permeability).toBeCloseTo(Math.SQRT2, 10);
    expect(profile.grinderScale).toBeCloseTo(g, 10);
    expect(profile.parameters[1].status).toContain('Constrained');
    expect(profile.referenceX50GapRatio).toBe(1.4);
    expect(profile.notes.join(' ')).toContain('Posterior correlation');
    const timeOnly = await calibrate(fakeEngine().engine, entries(1, 1, false), catalog, {
      ...fitOptions,
      fitGrinderScale: true,
    });
    expect(timeOnly.grinderScale).toBe(1);
    expect(timeOnly.parameters[1].status).toContain('not identified');
    const repeatedSetting = entries(1, 1, true).map((entry) => ({ ...entry, recipe: recipe(3) }));
    const degenerate = await calibrate(fakeEngine().engine, repeatedSetting, catalog, {
      ...fitOptions,
      fitGrinderScale: true,
    });
    expect(degenerate.grinderScale).toBe(1);
    expect(degenerate.notes.join(' ')).toContain('Requested grinder fit disabled');
  });

  it('flags locally confounded effects even when a coarse posterior grid looks narrow', async () => {
    const profile = await calibrate(fakeEngine().engine, entries(1, 1, true), catalog, {
      ...fitOptions,
      fitGrinderScale: true,
      tdsSigmaPercent: 100,
    });
    expect(profile.parameters[0].status).toContain('Confounded');
    expect(profile.parameters[1].status).toContain('Confounded');
    expect(profile.notes.join(' ')).toContain('sensitivity cosine');
  });

  it('does not mistake different dials with one explicit gap for varied physical settings', async () => {
    const shots = entries(1, 1, true);
    shots.forEach((entry) => {
      entry.recipe.grinder.gap_um = 200;
    });
    const profile = await calibrate(fakeEngine().engine, shots, catalog, {
      ...fitOptions,
      fitGrinderScale: true,
    });
    expect(profile.grinderScale).toBe(1);
    expect(profile.parameters[1].status).toContain('not identified');
  });

  it('refuses to save a profile if any required Tier 1 verification fails', async () => {
    await expect(
      calibrate(
        fakeEngine({ fail: (r) => r.numerics?.tier === 1 }).engine,
        entries(),
        catalog,
        fitOptions,
      ),
    ).rejects.toThrow('failed candidate');
  });

  it('labels a flat likelihood prior dominated instead of claiming identification', async () => {
    const shots = entries().map((entry) => ({
      ...entry,
      measurement: { ...entry.measurement!, yieldG: 36 },
    }));
    const profile = await calibrate(fakeEngine({ constant: true }).engine, shots, catalog, {
      setupId: 'home',
    });
    expect(profile.parameters[0].status).toContain('Prior dominated');
    expect(profile.parameters[0].p05).toBeLessThan(0.5);
    expect(profile.parameters[0].p95).toBeGreaterThan(2);
  });

  it('rejects no data, too few matching shots, stale cores and invalid noise', async () => {
    await expect(calibrate(fakeEngine().engine, [], catalog, fitOptions)).rejects.toThrow(
      'at least three',
    );
    await expect(
      calibrate(fakeEngine().engine, entries().slice(0, 2), catalog, fitOptions),
    ).rejects.toThrow('at least three');
    const mixed = entries();
    mixed[0].recipe.bean.days_off_roast = 11;
    await expect(calibrate(fakeEngine().engine, mixed, catalog, fitOptions)).rejects.toThrow(
      'same bag',
    );
    await expect(
      calibrate(fakeEngine().engine, entries(), { ...catalog, coreVersion: 'old' }, fitOptions),
    ).rejects.toThrow('versions differ');
    await expect(
      calibrate(fakeEngine().engine, entries(), catalog, { ...fitOptions, timeSigmaS: 0 }),
    ).rejects.toThrow('positive');
  });

  it('uses only completed measurements in the setup and scope and caps recent training at 12', async () => {
    const shots = entries(1, 1, false, 15);
    shots.push({ ...shots[0], id: 'unmeasured', measurement: undefined, createdAt: '2027' });
    shots.push({ ...shots[0], id: 'elsewhere', setupId: 'office', createdAt: '2027' });
    const profile = await calibrate(fakeEngine().engine, shots, catalog, fitOptions);
    expect(profile.trainingIds).toHaveLength(12);
    expect(profile.trainingIds).toContain('shot-14');
    expect(profile.trainingIds).not.toContain('shot-0');
    expect(profile.trainingIds).not.toContain('unmeasured');
    expect(profile.trainingIds).not.toContain('elsewhere');
    expect(profile.checks.map((check) => check.entryId)).toEqual(profile.trainingIds);
  });

  it('assigns failed candidates zero likelihood and refuses an all-failed fit', async () => {
    const fake = fakeEngine({ fail: (r) => (r.overrides?.[K] ?? 0) < REFERENCE_K });
    const profile = await calibrate(fake.engine, entries(), catalog, fitOptions);
    expect(
      profile.posterior
        .filter((point) => point.permeability < 1)
        .every((point) => point.weight === 0),
    ).toBe(true);
    expect(profile.notes.join(' ')).toContain('zero posterior likelihood');
    await expect(
      calibrate(fakeEngine({ fail: () => true }).engine, entries(), catalog, fitOptions),
    ).rejects.toThrow('No calibration candidate');
  });

  it.each([
    { mass_balance_error: 0.01 },
    { min_concentration_kg_m3: -1e-4 },
    { warnings: ['Solver failed to converge'] },
  ])(
    'rejects finite but numerically invalid candidates and Tier 1 checks (%o)',
    async (badDiagnostics) => {
      const candidateFailure = fakeEngine({
        diagnostics: (r) => ((r.overrides?.[K] ?? 0) < REFERENCE_K ? badDiagnostics : {}),
      });
      const profile = await calibrate(candidateFailure.engine, entries(), catalog, fitOptions);
      expect(
        profile.posterior
          .filter((point) => point.permeability < 1)
          .every((point) => point.weight === 0),
      ).toBe(true);
      const verificationFailure = fakeEngine({
        diagnostics: (r) => (r.numerics?.tier === 1 ? badDiagnostics : {}),
      });
      await expect(
        calibrate(verificationFailure.engine, entries(), catalog, fitOptions),
      ).rejects.toThrow('numerical diagnostics');
    },
  );

  it('propagates pre-flight and in-flight cancellation without retaining a fit', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeEngine();
    await expect(
      calibrate(fake.engine, entries(), catalog, fitOptions, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls).toHaveLength(0);
    const inflight = new AbortController();
    const running = fakeEngine({ abort: inflight });
    await expect(
      calibrate(running.engine, entries(), catalog, fitOptions, inflight.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(running.calls).toHaveLength(2);
  });
});

describe('calibration application and scope', () => {
  it('preserves dial and explicit gap, scales resolved X50, and rejects scope/version mismatches', async () => {
    const profile = await calibrate(fakeEngine().engine, entries(), catalog, fitOptions);
    profile.grinderScale = 1.1;
    const input = recipe(5);
    input.grinder.gap_um = 200;
    input.prep.dose_g = 20;
    input.stop = { time_s: 45 };
    input.numerics = { tier: 1 };
    const result = applyCalibration(input, profile, VERSION);
    expect(result.grinder.setting).toBe(5);
    expect(result.grinder.gap_um).toBe(200);
    expect(result.grinder.x50_gap_ratio).toBeCloseTo(1.54);
    expect(result.overrides?.[K]).toBeCloseTo(REFERENCE_K);
    expect(input.grinder.x50_gap_ratio).toBeUndefined();
    expect(() => applyCalibration(input, profile, 'other')).toThrow('core version');
    expect(() => applyCalibration(input, profile)).toThrow('core version');
    const newBag = structuredClone(input);
    newBag.bean.days_off_roast = 11;
    expect(() => applyCalibration(newBag, profile, VERSION)).toThrow('scope');
    const newWater = structuredClone(input);
    newWater.water = { alkalinity_mg_l_caco3: 80 };
    expect(() => applyCalibration(newWater, profile, VERSION)).toThrow('scope');
  });

  it('scales measured PSD diameters without changing bin weights, and honors recipe reference K', async () => {
    const shots = entries();
    shots.forEach((entry) => {
      entry.recipe.grinder.psd = {
        diameter_um: [100, 200, 300],
        volume_fraction: [0.1, 0.7, 0.2],
        method: 'image',
      };
      entry.recipe.overrides = { [K]: REFERENCE_K * 2 };
    });
    const profile = await calibrate(fakeEngine().engine, shots, catalog, fitOptions);
    expect(profile.referencePermeability).toBe(REFERENCE_K * 2);
    profile.grinderScale = 1.2;
    const result = applyCalibration(shots[0].recipe, profile, VERSION);
    expect(result.grinder.psd?.diameter_um).toEqual([120, 240, 360]);
    expect(result.grinder.psd?.volume_fraction).toEqual([0.1, 0.7, 0.2]);
    expect(result.grinder.x50_gap_ratio).toBeUndefined();
  });

  it('canonicalizes property ordering while binding every bag, water, gear and prep descriptor', () => {
    const a = recipe();
    const b = { ...a, bean: { days_off_roast: 10, preset: 'bag-a' } };
    expect(scopeKey(a)).toBe(scopeKey(b));
    b.prep = { ...b.prep, paper_bottom: true };
    expect(scopeKey(a)).not.toBe(scopeKey(b));
  });
});
