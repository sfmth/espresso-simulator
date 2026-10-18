// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { learnTaste } from './learning';
import type { TasteEstimate } from '../engine/m3Types';
import type { JournalEntry } from './types';
import type { Recipe } from '../engine/shotTypes';
const recipe: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: {},
  grinder: {},
  basket: {},
  prep: { dose_g: 18 },
  machine: {},
  stop: {},
};
function taste(acidity: number | null): TasteEstimate {
  return {
    schema: 'puckworks.taste/1',
    trust: 'low',
    status: 'estimated',
    score_semantics: 'relative',
    acidity_index: acidity,
    bitterness_index: 50,
    astringency_index: 50,
    body_index: 50,
    attributes: [],
    conditions: {
      chemistry_reference_temperature_c: 20,
      serving_temperature_c: null,
      serving_temperature_modelled: false,
      dilution_water_g: 0,
      original_beverage_g: 36,
      diluted_beverage_g: 36,
      aroma_age_s: 60,
    },
    assumptions: [],
    sources: [],
  };
}
function rated(id: string, acidity: number, rating: number): JournalEntry {
  return {
    id,
    createdAt: '2026-01-01T00:00:00Z',
    setupId: 'mine',
    label: '',
    recipe,
    source: 'manual',
    prediction: {
      recordedAt: '2026-01-01T00:00:00Z',
      coreVersion: 'test',
      executedRecipe: recipe,
      summary: {
        stop_reason: 'time',
        shot_time_s: 30,
        first_drops_s: 6,
        beverage_mass_kg: 0.036,
        tds: 0.1,
        ey: 0.2,
        max_pressure_pa: 900000,
        bed_height_m: 0.012,
        headspace_m3: 0,
        species: [],
        uniformity: { ey_min: 0.1, ey_max: 0.3, ey_std: 0.02 },
      },
      taste: taste(acidity),
      origin: 'app',
    },
    measurement: { recordedAt: '2026-01-01T00:01:00Z', timeS: 30, yieldG: 36, rating, notes: '' },
  };
}
describe('personal Bayesian taste', () => {
  it('keeps an honest cold start and needs all four core indices', () => {
    expect(learnTaste([], 'mine', taste(50))).toMatchObject({
      count: 0,
      prediction: null,
      coefficients: [0, 0, 0, 0, 0],
    });
    expect(learnTaste([rated('x', 50, 5)], 'mine', taste(null)).prediction).toBeNull();
  });
  it('learns a personal gradient without changing M3 and preserves predictive uncertainty', () => {
    const shots = Array.from({ length: 30 }, (_, i) =>
      rated(`r${i}`, i % 2 ? 90 : 10, i % 2 ? 5 : 1),
    );
    const candidate = taste(90),
      before = structuredClone(candidate);
    const liked = learnTaste(shots, 'mine', candidate),
      disliked = learnTaste(shots, 'mine', taste(10));
    expect(liked.count).toBe(30);
    expect(liked.coefficients[1]).toBeGreaterThan(0);
    expect(liked.prediction!.mean).toBeGreaterThan(disliked.prediction!.mean);
    expect(liked.prediction!.sd).toBeGreaterThan(1);
    expect(liked.prediction!.p95 - liked.prediction!.p05).toBeGreaterThan(1);
    expect(candidate).toEqual(before);
  });
  it('does not leak ratings across setups and ignores unmeasured, absent or invalid indices', () => {
    const missing = rated('missing', 50, 4);
    missing.prediction!.taste!.body_index = null;
    const noRating = rated('none', 50, 4);
    delete noRating.measurement!.rating;
    const invalid = rated('bad', 101, 4);
    const other = rated('other', 50, 5);
    other.setupId = 'someone-else';
    expect(learnTaste([missing, noRating, invalid, other], 'mine', taste(50)).count).toBe(0);
  });
  it('leaves sparse predictive intervals broad and shrinks epistemic variance with repeats', () => {
    const one = learnTaste([rated('one', 50, 4)], 'mine', taste(50));
    const repeated = learnTaste(
      Array.from({ length: 20 }, (_, i) => rated(`${i}`, 50, 4)),
      'mine',
      taste(50),
    );
    expect(one.prediction!.sd).toBeGreaterThan(repeated.prediction!.sd);
    expect(repeated.prediction!.sd).toBeGreaterThan(1);
  });
});
