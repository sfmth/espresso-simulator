// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { decimationIndices, MAX_SERIES_POINTS, sampleIndices, thinSphereResult } from './decimate';
import type { SphereReleaseData } from './types';

function full(n: number, error: (i: number) => number = () => 0): SphereReleaseData {
  const times = Float64Array.from({ length: n }, (_, i) => i);
  const analytic = Float64Array.from({ length: n }, (_, i) => i / (n - 1));
  return {
    times,
    releasedFraction: analytic.map((v, i) => v + error(i)),
    analyticFraction: analytic,
    shellOuterRadii: new Float64Array([1, 2]),
    finalProfile: new Float64Array([0.5, 0.25]),
    maxAbsError: 0.125,
    massBalanceError: 1e-15,
  };
}

describe('sampleIndices', () => {
  it('spreads the samples evenly from the first to the last index', () => {
    expect(sampleIndices(2001)).toEqual([
      0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000,
    ]);
    expect(sampleIndices(3)).toEqual([0, 1, 2]);
  });
});

describe('decimationIndices', () => {
  it('keeps everything when it fits', () => {
    expect(decimationIndices(3, () => 0, 3)).toBeNull();
  });

  it('keeps the ends, the extremes of every bucket and the requested indices, in order', () => {
    const values = Array.from({ length: 10_001 }, (_, i) => Math.sin(i / 50));
    values[5_000] = 9; // a spike
    values[7_777] = -9; // and a dip
    const indices = decimationIndices(
      values.length,
      (i) => values[i],
      500,
      [1_234, 1_234, 0, 10_000],
    );
    expect(indices).not.toBeNull();
    if (!indices) return;
    expect(indices.length).toBeLessThanOrEqual(500);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(10_000);
    for (const i of [5_000, 7_777, 1_234]) expect(indices).toContain(i);
    for (let k = 1; k < indices.length; k++) expect(indices[k]).toBeGreaterThan(indices[k - 1]);
  });
});

describe('thinSphereResult', () => {
  it('passes short results through unchanged', () => {
    const data = full(100);
    const thin = thinSphereResult(data);
    expect(thin.times).toBe(data.times);
    expect(thin.totalPoints).toBe(100);
  });

  it('caps long series and keeps the largest error, the samples and the scalars', () => {
    const n = 1_000_001;
    const thin = thinSphereResult(full(n, (i) => (i === 654_321 ? 0.03 : 1e-6 * Math.cos(i))));
    expect(thin.totalPoints).toBe(n);
    expect(thin.times.length).toBeLessThanOrEqual(MAX_SERIES_POINTS);
    const times = Array.from(thin.times);
    for (const i of [...sampleIndices(n), 654_321]) expect(times).toContain(i);
    const errors = Array.from(thin.releasedFraction, (v, i) => v - thin.analyticFraction[i]);
    expect(Math.max(...errors)).toBeCloseTo(0.03, 12);
    expect(thin.maxAbsError).toBe(0.125);
    expect(Array.from(thin.finalProfile)).toEqual([0.5, 0.25]);
  });
});
