// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { importShotLog } from './imports';
import type { Recipe } from '../engine/shotTypes';
const recipe: Recipe = {
  schema: 'puckworks.recipe/1',
  bean: {},
  grinder: { preset: 'generic-flat', setting: 5 },
  basket: {},
  prep: { dose_g: 18 },
  machine: {},
  stop: { beverage_g: 36 },
};
const parse = (text: string, format: 'csv' | 'de1' = 'csv') =>
  importShotLog(text, format, recipe, 'my-setup');
const de1 =
  'espresso_elapsed {0 1 2 30} espresso_pressure {0 1 8 9} espresso_weight {-0.1 1 0.9 36}';
describe('canonical CSV observations', () => {
  it('imports explicit units, overrides only known measurements, and supports quoted multiline text', () => {
    const shots = parse(
      'time_s,yield_g,tds_percent,rating,dose_g,setting,label,notes\r\n30,40,9,4,20,6,"One, nice shot","Line 1\nLine 2 says ""good"""\r\n',
    );
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      source: 'csv',
      setupId: 'my-setup',
      label: 'One, nice shot',
      recipe: { prep: { dose_g: 20 }, grinder: { setting: 6 } },
      measurement: { timeS: 30, yieldG: 40, tdsPercent: 9, rating: 4 },
    });
    expect(shots[0].measurement!.notes).toContain('Line 1\nLine 2 says "good"');
    expect(shots[0].prediction).toBeUndefined();
    expect(recipe.prep.dose_g).toBe(18);
  });
  it('labels recipe assumptions and keeps absent TDS/rating unknown', () => {
    const e = parse('time_s,yield_g\n30,36')[0];
    expect(e.recipe).toEqual(recipe);
    expect(e.measurement!.tdsPercent).toBeUndefined();
    expect(e.measurement!.rating).toBeUndefined();
    expect(e.measurement!.notes).toContain('Dose assumed');
    expect(e.measurement!.notes).toContain('Grind setting assumed');
  });
  it.each([
    'time_s,yield_g\nNaN,36',
    'time_s,yield_g\n1e999,36',
    'time_s,yield_g\n0,36',
    'time_s,yield_g,dose_g\n30,36,0',
    'time_s,yield_g,rating\n30,36,6',
    'time_s,yield_g,tds_percent\n30,100,30',
    'time_s,yield_g,tds_percent\n30,36,101',
    'time_s,yield_g,tds_percent\n30,36,0',
    'time,yield\n30,36',
    'time_s,yield_g,yield_g\n30,36,36',
    'time_s,yield_g\n30',
    'time_s,yield_g,label\n30,36,"open',
    'time_s,yield_g,label\n30,36,"closed"junk',
    'time_s,yield_g,label\n30,36,un"quoted',
  ])('rejects ambiguous or malformed CSV: %s', (text) => expect(() => parse(text)).toThrow());
});
describe('inert DE1 .shot importer', () => {
  it('retains original elapsed end and final sensor mass, documenting scale noise and assumptions', () => {
    const e = parse(
      `${de1} settings {bean_weight 50} private_note {[exec dangerous] $password}`,
      'de1',
    )[0];
    expect(e).toMatchObject({ source: 'de1', recipe, measurement: { timeS: 30, yieldG: 36 } });
    expect(e.measurement!.notes).toContain('1 negative scale samples and 1 downward steps');
    expect(e.measurement!.notes).not.toContain('dangerous');
    expect(e.recipe.prep.dose_g).toBe(18);
    expect(e.measurement!.tdsPercent).toBeUndefined();
  });
  it.each([
    'espresso_elapsed {0 30} espresso_pressure {0 9}',
    'espresso_elapsed {0 30} espresso_pressure {0 9} espresso_weight {0 36 40}',
    'espresso_elapsed {0 0 30} espresso_pressure {0 8 9} espresso_weight {0 30 36}',
    'espresso_elapsed {0 30} espresso_pressure {0 [exec]} espresso_weight {0 36}',
    'espresso_elapsed {0 30} espresso_pressure {0 9} espresso_weight {0 1e999}',
    'espresso_elapsed {0 30} espresso_pressure {0 9} espresso_weight {0 -1}',
    'espresso_elapsed {0 30} espresso_pressure {0 9} espresso_weight {0 36} espresso_flow {0 1 2}',
    'espresso_elapsed {0 30} espresso_elapsed {0 30}',
    'espresso_elapsed {0 30}tail',
    'espresso_elapsed {0 30',
  ])('rejects invalid required or recognized channels: %s', (text) =>
    expect(() => parse(text, 'de1')).toThrow(),
  );
  it('bounds input size before tokenization', () =>
    expect(() => parse(' '.repeat(2_000_001))).toThrow(/2 MB/));
});
