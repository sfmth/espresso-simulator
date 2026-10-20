// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureCatalog, fixtureResult } from '../../test/fixtures/shotFixture';
import { toShotRunData } from '../engine/shotData';
import type { Recipe } from '../engine/shotTypes';
import { csvField, csvRow, seriesCsv, sweepCsv } from './csv';
import { diffRecipes, fingerprint, flattenRecipe } from './diff';
import { DEFAULT_RECIPE } from './recipeForm';
import type { SweepRun } from './shotStore';
import { chartHasData, chartSummary, joinRuns, sampleTimes, SHOT_CHARTS } from './shotChartData';

const result = toShotRunData(fixtureResult({ points: 5 }), 1).result;
const chart = (id: string) => {
  const found = SHOT_CHARTS.find((c) => c.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe('series → chart data', () => {
  it('converts to display units, one series per run and quantity', () => {
    const { data, series } = joinRuns(chart('flow'), [{ label: 'This run', slot: 0, result }]);
    expect(Array.from(data[0] as Float64Array)).toEqual([0, 7.5, 15, 22.5, 30]);
    expect(data[1]).toEqual([0, 2, 2, 2, 2]); // flow out, mL/s
    expect(data[2]).toEqual([4, 2, 2, 2, 2]); // flow in
    expect(series).toEqual([
      { label: 'This run · out of the basket', slot: 0, dash: undefined, spanGaps: true },
      { label: 'This run · into the headspace', slot: 0, dash: [6, 4], spanGaps: true },
    ]);
  });

  it('joins runs with different times, leaving gaps the lines span', () => {
    const other = toShotRunData(fixtureResult({ points: 3 }), 1).result; // t = 0, 15, 30
    const { data, series } = joinRuns(chart('pressure'), [
      { label: 'A', slot: 0, result },
      { label: 'B', slot: 3, result: other },
    ]);
    expect(Array.from(data[0] as Float64Array)).toEqual([0, 7.5, 15, 22.5, 30]);
    expect(data[1]).toEqual([0, 9, 9, 9, 9]);
    expect(data[2]).toEqual([0, null, 9, null, 9]);
    expect(series.map((s) => [s.label, s.slot])).toEqual([
      ['A', 0],
      ['B', 3],
    ]);
  });

  it('skips charts a result has no data for and describes the others in words', () => {
    const noWetting = toShotRunData(
      {
        ...fixtureResult({ points: 5 }),
        series: { ...fixtureResult({ points: 5 }).series, wetted_fraction: undefined },
      },
      1,
    ).result;
    expect(chartHasData(chart('wetted'), [{ label: 'x', slot: 0, result: noWetting }])).toBe(false);
    expect(chartSummary(chart('pressure'), [{ label: 'This run', slot: 0, result }])).toBe(
      'Pressure (bar) over time. This run: peak 9.00 bar at 7.5 s, final 9.00 bar.',
    );
  });

  it('samples evenly spaced rows for the table view', () => {
    expect(sampleTimes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([0, 5, 10]);
    expect(sampleTimes([0, 1], 11)).toEqual([0, 1]);
    expect(sampleTimes([])).toEqual([]);
  });
});

describe('CSV export', () => {
  it('quotes fields only when needed', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(Number.NaN)).toBe('');
    expect(csvRow([1, null, 'x'])).toBe('1,,x');
  });

  it('writes the series in display units, species and unknown series included', () => {
    const doc = fixtureResult({ points: 3 });
    (doc.series as unknown as Record<string, unknown>).bed_temp_c = [80, 85, 90];
    const csv = seriesCsv(toShotRunData(doc, 1).result).trim().split('\n');
    expect(csv[0]).toBe(
      'time_s,pressure_bar,flow_in_ml_s,flow_out_ml_s,beverage_g,tds_cup_pct,tds_outlet_pct,ey_pct,' +
        'outlet_temp_c,wetted_pct,bed_temp_c,species_caffeine_mg,species_trigonelline_mg,' +
        'species_cqa5_mg,species_acids_mg',
    );
    expect(csv).toHaveLength(4);
    expect(csv[3].split(',').slice(0, 5)).toEqual(['30', '9', '2', '2', '36']);
  });

  it('writes a sweep with every output and the reason a point failed', () => {
    const run: SweepRun = {
      seq: 1,
      targetId: 'prep.dose_g',
      label: 'Dose',
      unit: 'g',
      tier: 0,
      baseKey: '',
      values: [16, 40],
      points: [
        { x: 16, ok: true, summary: fixtureResult().summary, warnings: ['w1', 'w2'] },
        { x: 40, ok: false, error: 'prep.dose_g: too big, really' },
      ],
    };
    const lines = sweepCsv(run).trim().split('\n');
    expect(lines[0]).toBe(
      'prep.dose_g (g),ey_pct,tds_pct,shot_time_s,beverage_g,max_pressure_bar,first_drops_s,ey_std_points,stop_reason,warnings,error',
    );
    expect(lines[1].startsWith('16,20,')).toBe(true);
    expect(lines[1].endsWith(',beverage_mass,w1 | w2,')).toBe(true);
    expect(lines[2]).toBe('40,,,,,,,,,,"prep.dose_g: too big, really"');
  });
});

describe('recipe differences', () => {
  const catalog = fixtureCatalog();

  it('flattens a recipe into labelled values in display units', () => {
    const flat = flattenRecipe(
      {
        ...DEFAULT_RECIPE,
        bean: { arabica_fraction: 0.9 },
        overrides: { 'extraction.max_yield': 26 },
      },
      catalog,
    );
    expect(flat.get('prep.dose_g')).toEqual({ label: 'Dose', value: '18 g' });
    expect(flat.get('bean.arabica_fraction')).toEqual({ label: 'Arabica share', value: '90%' });
    expect(flat.get('basket.preset')).toEqual({
      label: 'Basket preset',
      value: '58 mm precision basket, 18 g',
    });
    expect(flat.get('overrides.extraction.max_yield')?.value).toBe('26 %');
  });

  it('lists only the fields that differ, with — for a field left out', () => {
    const a = DEFAULT_RECIPE;
    const b: Recipe = {
      ...a,
      prep: { dose_g: 20, distribution: 'wdt' },
      stop: { beverage_g: 36, time_s: 30 },
    };
    const c: Recipe = {
      ...a,
      machine: { preset: 'flat-9-bar', profile: [{ control: 'pressure', target: 6 }] },
    };
    const rows = diffRecipes([a, b, c], catalog);
    expect(rows.map((r) => [r.label, ...r.values])).toEqual([
      ['Dose', '18 g', '20 g', '18 g'],
      ['Vents the group after the shot', 'yes', 'yes', '—'],
      ['Stop at time', '—', '30 s', '—'],
      ['Program phases', '—', '—', '1'],
      ['Phase 1 control', '—', '—', 'pressure'],
      ['Phase 1 target', '—', '—', '6 bar'],
    ]);
    expect(diffRecipes([a, a], catalog)).toEqual([]);
  });

  it('summarises a custom basket and a measured PSD, telling different ones apart', () => {
    const psd = (f: number[]): Recipe => ({
      ...DEFAULT_RECIPE,
      grinder: { psd: { diameter_um: [100, 300], volume_fraction: f } },
    });
    const rows = diffRecipes([psd([1, 1]), psd([1, 2])], catalog);
    expect(rows).toHaveLength(1);
    expect(rows[0].values[0]).toMatch(/^2 bins, 100–300 µm \(#[0-9a-f]{6}\)$/);
    expect(rows[0].values[0]).not.toBe(rows[0].values[1]);
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});
