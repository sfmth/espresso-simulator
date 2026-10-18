// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCalibration, scopeKey } from './calibration';
import { emptyJournal, mergeJournal, openJournal, parseJournal, scorecard } from './journal';
import type { CalibrationProfile, JournalDocument, JournalEntry } from './types';
import type { Recipe, Summary } from '../engine/shotTypes';

const recipe: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: {},
  grinder: { preset: 'generic-flat', setting: 5 },
  basket: {},
  prep: { dose_g: 18 },
  machine: {},
  stop: { beverage_g: 36 },
};
const summary: Summary = {
  stop_reason: 'beverage_mass',
  shot_time_s: 30,
  first_drops_s: 6,
  beverage_mass_kg: 0.036,
  tds: 0.1,
  ey: 0.2,
  max_pressure_pa: 900000,
  bed_height_m: 0.012,
  headspace_m3: 0.000002,
  species: [],
  uniformity: { ey_min: 0.1, ey_max: 0.3, ey_std: 0.02 },
};
function entry(id = 'shot', prospective = false): JournalEntry {
  const recordedAt = new Date().toISOString();
  return {
    id,
    createdAt: recordedAt,
    setupId: 'my-setup',
    label: 'My shot',
    recipe: structuredClone(recipe),
    source: 'manual',
    ...(prospective
      ? {
          prediction: {
            recordedAt,
            coreVersion: 'test',
            calibrationId: 'fit',
            origin: 'app' as const,
            executedRecipe: {
              ...structuredClone(recipe),
              overrides: { 'hydraulics.permeability.reference': 3e-14 },
            },
            summary: structuredClone(summary),
          },
        }
      : {}),
  };
}
function profile(): CalibrationProfile {
  return {
    id: 'fit',
    createdAt: '2026-01-01T00:00:00.000Z',
    setupId: 'my-setup',
    scopeKey: scopeKey(recipe),
    coreVersion: 'test',
    trainingIds: [],
    parameters: [],
    permeability: 1,
    grinderScale: 1,
    referencePermeability: 3e-14,
    timeSigmaS: 3,
    tdsSigmaPercent: 0.2,
    posterior: [{ permeability: 1, grinderScale: 1, weight: 1 }],
    checks: [],
    notes: [],
  };
}
function document(entries = [entry()]): JournalDocument {
  return { ...emptyJournal(), entries };
}
function measured(e: JournalEntry): JournalEntry {
  return {
    ...e,
    measurement: {
      recordedAt: new Date(Date.parse(e.createdAt) + 30000).toISOString(),
      timeS: 30,
      yieldG: 36,
      tdsPercent: 10,
      notes: '',
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('journal boundary', () => {
  it('exports/imports stable ids but treats all file predictions as unverified imports', () => {
    const doc = document([measured(entry('shot', true))]);
    const imported = parseJournal(JSON.stringify(doc));
    expect(imported.entries[0].id).toBe('shot');
    expect(imported.entries[0].source).toBe('json');
    expect(imported.entries[0].prediction?.origin).toBe('import');
    expect(doc.entries[0].prediction?.origin).toBe('app');
  });
  it('rejects malformed schema, unknown fields, unsafe keys, duplicate ids and non-finite values', () => {
    expect(() => parseJournal('{"schema":"wrong","entries":[],"calibrations":[]}')).toThrow(
      /schema/,
    );
    expect(() =>
      parseJournal(
        '{"schema":"puckworks.journal/1","entries":[],"calibrations":[],"__proto__":{}}',
      ),
    ).toThrow(/Unsafe/);
    const duplicate = document([entry(), entry()]);
    expect(() => parseJournal(JSON.stringify(duplicate))).toThrow(/Duplicate/);
    const infinite = JSON.stringify(document()).replace('"dose_g":18', '"dose_g":1e999');
    expect(() => parseJournal(infinite)).toThrow(/finite/);
    const wrong = document();
    wrong.entries[0].recipe.prep.dose_g = 0;
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/dose_g/);
    wrong.entries[0].recipe.prep.dose_g = 18;
    (wrong.entries[0].recipe.prep as unknown as Record<string, unknown>).imaginary = 1;
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/unknown recipe field/);
  });
  it('rejects missing nested summary and out-of-range measurement data', () => {
    const wrong = document([measured(entry('x', true))]);
    wrong.entries[0].measurement!.rating = 6;
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/rating/);
    delete wrong.entries[0].measurement!.rating;
    delete (wrong.entries[0].prediction!.summary as unknown as Record<string, unknown>).uniformity;
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/uniformity/);
  });
  it('validates finite ordered PSDs, aligned bins, dates and calibration posteriors', () => {
    const wrong = document();
    wrong.entries[0].recipe.grinder.psd = { diameter_um: [100, 50], volume_fraction: [0.5, 0.5] };
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/increasing/);
    delete wrong.entries[0].recipe.grinder.psd;
    wrong.entries[0].createdAt = '2026-02-30T00:00:00Z';
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/calendar/);
    wrong.entries[0].createdAt = new Date().toISOString();
    wrong.calibrations = [profile()];
    wrong.calibrations[0].referenceX50GapRatio = undefined;
    expect(() => parseJournal(JSON.stringify(wrong))).not.toThrow();
    wrong.calibrations[0].posterior[0].weight = 0.5;
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/weights/);
  });
  it('rejects impossible measured extraction yield even when TDS and mass are individually in range', () => {
    const wrong = document([measured(entry())]);
    wrong.entries[0].measurement!.yieldG = 100;
    wrong.entries[0].measurement!.tdsPercent = 30;
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/EY > 100/);
  });
  it('rejects unsupported single-bin PSDs and inconsistent basket/program geometry', () => {
    const wrong = document();
    wrong.entries[0].recipe.grinder.psd = { diameter_um: [50, 200], volume_fraction: [0, 1] };
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/positive volume/);
    delete wrong.entries[0].recipe.grinder.psd;
    wrong.entries[0].recipe.basket.custom = {
      profile_mm: [
        [0, 50],
        [20, 58],
      ],
      perforated_diameter_mm: 55,
    };
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/floor diameter/);
    delete wrong.entries[0].recipe.basket.custom;
    wrong.entries[0].recipe.machine.profile = [
      { control: 'pump' },
      { control: 'pressure', target: 9 },
    ];
    expect(() => parseJournal(JSON.stringify(wrong))).toThrow(/only the last phase/);
  });
  it('merges idempotently without overwriting conflicting ids', () => {
    const a = document();
    expect(mergeJournal(a, parseJournal(JSON.stringify(a)))).toEqual(a);
    const b = document([entry('other')]);
    expect(mergeJournal(a, b).entries.map((e) => e.id)).toEqual(['shot', 'other']);
    const conflict = structuredClone(a);
    conflict.entries[0].label = 'different';
    expect(() => mergeJournal(a, conflict)).toThrow(/Conflicting entry/);
    expect(a.entries[0].label).toBe('My shot');
    const fitA = { ...emptyJournal(), calibrations: [profile()] },
      fitB = structuredClone(fitA);
    fitB.calibrations[0].permeability *= 2;
    expect(() => mergeJournal(fitA, fitB)).toThrow(/Conflicting calibration/);
  });
});

describe('volatile journal and snapshots', () => {
  it('explicitly falls back, serializes operations, and returns independent snapshots', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = await openJournal();
    expect(store.persistent).toBe(false);
    const value = document();
    const saved = store.save(value);
    value.entries[0].label = 'mutation after save';
    const loaded = store.load();
    await saved;
    expect((await loaded).entries[0].label).toBe('My shot');
    const independent = await store.load();
    independent.entries.length = 0;
    expect((await store.load()).entries).toHaveLength(1);
    store.close();
    await expect(store.load()).rejects.toThrow(/closed/);
  });
  it('preserves predictions, recipe and provenance when measurement arrives', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = await openJournal(),
      pending = document([entry('pending', true)]);
    await store.save(pending);
    const observed = document([measured(pending.entries[0])]);
    await store.save(observed);
    const edited = structuredClone(observed);
    edited.entries[0].prediction!.summary.ey = 0.25;
    await expect(store.save(edited)).rejects.toThrow(/immutable/);
    edited.entries[0].prediction = observed.entries[0].prediction;
    edited.entries[0].recipe.prep.dose_g = 20;
    await expect(store.save(edited)).rejects.toThrow(/immutable/);
    expect((await store.load()).entries[0]).toEqual(observed.entries[0]);
  });
  it('persists calibration multipliers and optional PSD references, then protects the fit', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = await openJournal(),
      doc = document();
    doc.calibrations = [{ ...profile(), referenceX50GapRatio: undefined }];
    await store.save(doc);
    const loaded = await store.load();
    expect(loaded.calibrations[0].permeability).toBe(1);
    loaded.calibrations[0].grinderScale = 1.1;
    await expect(store.save(loaded)).rejects.toThrow(/saved fit is immutable/);
  });
  it('rejects backfilled predictions, backdating and simultaneous app prediction/measurement', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = await openJournal();
    const simultaneous = document([measured(entry('together', true))]);
    await expect(store.save(simultaneous)).rejects.toThrow(/before adding/);
    const old = document([entry('old', true)]);
    old.entries[0].prediction!.recordedAt = old.entries[0].createdAt = '2020-01-01T00:00:00Z';
    await expect(store.save(old)).rejects.toThrow(/recorded now/);
    const observed = document([measured(entry('existing'))]);
    await store.save(observed);
    observed.entries[0].prediction = entry('existing', true).prediction;
    await expect(store.save(observed)).rejects.toThrow(/after its measurement/);
  });
});

describe('prospective V9 scorecard', () => {
  it('requires ten complete prospective shots and uses EY percentage points', () => {
    const entries = Array.from({ length: 10 }, (_, i) => measured(entry(`test-${i}`, true)));
    expect(scorecard(entries.slice(0, 9), [profile()]).met).toBe(false);
    const stats = scorecard(entries, [profile()]);
    expect(stats).toMatchObject({
      evaluated: 10,
      passed: 10,
      required: 10,
      met: true,
      timeMaeS: 0,
      eyMaePoints: 0,
    });
    entries[0].measurement!.tdsPercent = 11;
    const misses = scorecard(entries, [profile()]);
    expect(misses.met).toBe(false);
    expect(misses.passed).toBe(9);
    expect(misses.rows[0].eyErrorPoints).toBeCloseTo(-2);
  });
  it('reports timing-only prospective checks without implying V9 when TDS is absent', () => {
    const entries = Array.from({ length: 10 }, (_, i) => measured(entry(`timing-${i}`, true)));
    for (const e of entries) delete e.measurement!.tdsPercent;
    const stats = scorecard(entries, [profile()]);
    expect(stats.timeOnly).toEqual({ evaluated: 10, passed: 10, maeS: 0, met: true });
    expect(stats).toMatchObject({ evaluated: 0, met: false });
    entries[0].measurement!.timeS = 35;
    expect(scorecard(entries, [profile()]).timeOnly).toMatchObject({
      evaluated: 10,
      passed: 9,
      met: false,
    });
  });
  it('excludes training, imported, pre-calibration/backdated and TDS-absent observations', () => {
    const entries = Array.from({ length: 6 }, (_, i) => measured(entry(`test-${i}`, true)));
    const fit = profile();
    fit.trainingIds = ['test-0'];
    entries[1].source = 'json';
    entries[2].measurement!.recordedAt = entries[2].prediction!.recordedAt;
    entries[3].prediction!.calibrationId = undefined;
    delete entries[4].measurement!.tdsPercent;
    entries[5].prediction!.coreVersion = 'different';
    expect(scorecard(entries, [fit])).toMatchObject({
      evaluated: 0,
      met: false,
      excluded: { training: 1, imported: 1, missingTds: 1, notProspective: 3 },
    });
  });
  it('checks the exact scaled measured PSD and calibration scope', () => {
    const e = measured(entry('psd', true));
    e.recipe.grinder = { psd: { diameter_um: [50, 200], volume_fraction: [0.2, 0.8] } };
    const fit = profile();
    fit.scopeKey = scopeKey(e.recipe);
    fit.grinderScale = 1.1;
    e.prediction!.executedRecipe = applyCalibration(e.recipe, fit, 'test');
    expect(scorecard([e], [fit]).evaluated).toBe(1);
    e.prediction!.executedRecipe.grinder.psd!.diameter_um[1] = 500;
    expect(scorecard([e], [fit]).evaluated).toBe(0);
  });
  it('permits the declared calibration transforms but rejects changed physical conditions', () => {
    const e = measured(entry('x', true));
    const fit = profile();
    fit.grinderScale = 2;
    fit.referenceX50GapRatio = 1;
    e.prediction!.executedRecipe = applyCalibration(e.recipe, fit, 'test');
    e.prediction!.executedRecipe.numerics = { tier: 1 };
    expect(scorecard([e], [fit]).evaluated).toBe(1);
    e.prediction!.executedRecipe.prep.dose_g = 20;
    expect(scorecard([e], [fit]).evaluated).toBe(0);
  });
});
