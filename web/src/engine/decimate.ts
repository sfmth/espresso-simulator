// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Thinning of long time series inside the worker, so that a run with millions
 * of time steps sends a few thousand points to the page instead of hundreds of
 * megabytes. The scalars (max error, mass balance) are computed by the core
 * over every point and are not affected.
 */
import type { SphereReleaseData, SphereRunData } from './types';

/** At most this many points per time series leave the worker. */
export const MAX_SERIES_POINTS = 4096;

/** Evenly spaced times always kept (0 %, 10 %, …, 100 % of the run), for the table view. */
export const SAMPLE_COUNT = 11;

/** Indices of `count` evenly spaced points among `n`, first and last included. */
export function sampleIndices(n: number, count = SAMPLE_COUNT): number[] {
  const indices = new Set<number>();
  for (let k = 0; k < count; k++) {
    indices.add(Math.round((k * (n - 1)) / Math.max(1, count - 1)));
  }
  return [...indices];
}

/**
 * Indices to keep from `n` values: the first and the last, every index in
 * `keep`, and in each equal-width bucket in between the smallest and the
 * largest value, so that peaks survive. Sorted and unique; at most `maxPoints`
 * entries. Returns null when all `n` fit.
 */
export function decimationIndices(
  n: number,
  valueAt: (i: number) => number,
  maxPoints: number,
  keep: Iterable<number> = [],
): number[] | null {
  if (n <= maxPoints) return null;
  const extra = [...new Set(keep)].filter((i) => Number.isInteger(i) && i > 0 && i < n - 1);
  const buckets = Math.max(1, Math.floor((maxPoints - 2 - extra.length) / 2));
  const chosen = [0, n - 1, ...extra];
  const inner = n - 2;
  for (let b = 0; b < buckets; b++) {
    const start = 1 + Math.floor((b * inner) / buckets);
    const end = 1 + Math.floor(((b + 1) * inner) / buckets);
    if (end <= start) continue;
    let lo = start;
    let hi = start;
    let low = valueAt(start);
    let high = low;
    for (let i = start + 1; i < end; i++) {
      const v = valueAt(i);
      if (v < low) {
        low = v;
        lo = i;
      }
      if (v > high) {
        high = v;
        hi = i;
      }
    }
    chosen.push(lo);
    if (hi !== lo) chosen.push(hi);
  }
  return [...new Set(chosen)].sort((a, b) => a - b);
}

/**
 * Thins a full result to at most `maxPoints` points per time series, keeping
 * the first and last points, the evenly spaced samples and the point of the
 * largest |numerical − analytic|. Short results pass through unchanged.
 */
export function thinSphereResult(
  full: SphereReleaseData,
  maxPoints = MAX_SERIES_POINTS,
): SphereRunData {
  const { times, releasedFraction: numerical, analyticFraction: analytic } = full;
  const n = times.length;
  const run: SphereRunData = { ...full, totalPoints: n };
  if (n <= maxPoints) return run;

  const error = (i: number) => numerical[i] - analytic[i];
  let worst = 0;
  let worstAbs = -1;
  for (let i = 0; i < n; i++) {
    const e = Math.abs(error(i));
    if (e > worstAbs) {
      worstAbs = e;
      worst = i;
    }
  }
  const keep = decimationIndices(n, error, maxPoints, [...sampleIndices(n), worst]);
  if (keep === null) return run;
  const pick = (array: Float64Array) => Float64Array.from(keep, (i) => array[i]);
  return {
    ...run,
    times: pick(times),
    releasedFraction: pick(numerical),
    analyticFraction: pick(analytic),
  };
}
