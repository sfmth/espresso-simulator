// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { thinSphereResult } from '../engine/decimate';
import type { SphereRunData } from '../engine/types';
import { buildChartData, sampleRows } from './chartData';
import { formatMilliseconds, formatScientific, formatSignificant, formatTick } from './format';

function run(n: number, error: (i: number) => number = () => 0): SphereRunData {
  const times = Float64Array.from({ length: n }, (_, i) => i);
  const analytic = Float64Array.from({ length: n }, (_, i) => i / (n - 1));
  return {
    times,
    releasedFraction: analytic.map((v, i) => v + error(i)),
    analyticFraction: analytic,
    shellOuterRadii: new Float64Array([1]),
    finalProfile: new Float64Array([0]),
    maxAbsError: 0,
    massBalanceError: 0,
    totalPoints: n,
  };
}

describe('buildChartData', () => {
  it('computes the signed error on the points it was given', () => {
    const data = buildChartData(run(5, (i) => (i === 2 ? 0.01 : 0)));
    expect(data.drawn).toBe(5);
    expect(data.total).toBe(5);
    expect(Array.from(data.error[1])).toEqual([0, 0, 0.01 + 0.5 - 0.5, 0, 0]);
    expect(data.release[0]).toHaveLength(5);
  });

  it('reports how many of the run’s points a thinned result draws', () => {
    const thin = thinSphereResult(run(100_001, (i) => (i === 31_415 ? -0.02 : 0)));
    const data = buildChartData(thin);
    expect(data.total).toBe(100_001);
    expect(data.drawn).toBe(thin.times.length);
    expect(Math.min(...data.error[1])).toBeCloseTo(-0.02, 12);
  });
});

describe('sampleRows', () => {
  it('samples evenly from the first to the last time', () => {
    const rows = sampleRows(run(2001), 11);
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.t)).toEqual([
      0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000,
    ]);
  });

  it('finds the exact sample times in a thinned result', () => {
    const rows = sampleRows(thinSphereResult(run(1_000_001)), 11);
    expect(rows.map((r) => r.t)).toEqual(Array.from({ length: 11 }, (_, k) => k * 100_000));
  });

  it('does not repeat rows for short runs', () => {
    expect(sampleRows(run(3), 11).map((r) => r.t)).toEqual([0, 1, 2]);
  });
});

describe('formatting', () => {
  it('writes scientific values with superscript powers', () => {
    expect(formatScientific(0.010273103891978802)).toBe('1.03 × 10⁻²');
    expect(formatScientific(3.1086244689504383e-15)).toBe('3.11 × 10⁻¹⁵');
    expect(formatScientific(-2.5e-5)).toBe('−2.50 × 10⁻⁵');
    expect(formatScientific(1234)).toBe('1.23 × 10³');
    expect(formatScientific(5)).toBe('5.00');
    expect(formatScientific(0)).toBe('0');
    expect(formatScientific(0.0099999)).toBe('1.00 × 10⁻²');
  });

  it('writes durations', () => {
    expect(formatMilliseconds(2.2812)).toBe('2.28 ms');
    expect(formatMilliseconds(54.14)).toBe('54.1 ms');
    expect(formatMilliseconds(1794.98)).toBe('1,795 ms');
  });

  it('writes compact axis ticks', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(0.25)).toBe('0.25');
    expect(formatTick(60)).toBe('60');
    expect(formatTick(-0.002)).toBe('−0.002');
    expect(formatTick(2e-5)).toBe('2e−5');
    expect(formatTick(-1.5e-4)).toBe('−1.5e−4');
  });

  it('writes table cells with fixed significant digits', () => {
    expect(formatSignificant(0.956260413914931)).toBe('0.956260');
    expect(formatSignificant(6, 4)).toBe('6.000');
    expect(formatSignificant(1e-5)).toBe('1.00000e−5');
    expect(formatSignificant(-1e-5)).toBe('−1.00000e−5');
  });
});
