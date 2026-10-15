// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Turns a run (already thinned by the worker to a few thousand points per
 * series, see engine/decimate.ts) into chart series and table rows.
 */
import { SAMPLE_COUNT } from '../engine/decimate';
import type { SphereRunData } from '../engine/types';

export interface SphereChartData {
  /** [time, numerical, analytic] */
  release: [Float64Array, Float64Array, Float64Array];
  /** [time, numerical − analytic] */
  error: [Float64Array, Float64Array];
  /** Points drawn, and output times in the full run. */
  drawn: number;
  total: number;
}

export function buildChartData(result: SphereRunData): SphereChartData {
  const { times, releasedFraction: numerical, analyticFraction: analytic } = result;
  const error = Float64Array.from(numerical, (v, i) => v - analytic[i]);
  return {
    release: [times, numerical, analytic],
    error: [times, error],
    drawn: times.length,
    total: result.totalPoints,
  };
}

export interface SampleRow {
  t: number;
  numerical: number;
  analytic: number;
  error: number;
}

/** Index of the time nearest `target` in an ascending array. */
function nearestIndex(times: Float64Array, target: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[hi] - target) < Math.abs(times[lo] - target) ? hi : lo;
}

/**
 * Rows at `count` evenly spaced times from the first to the last. The worker
 * keeps those times when it thins a run, so the rows are exact.
 */
export function sampleRows(result: SphereRunData, count = SAMPLE_COUNT): SampleRow[] {
  const { times } = result;
  const n = times.length;
  if (n === 0) return [];
  const first = times[0];
  const last = times[n - 1];
  const indices = new Set<number>();
  for (let k = 0; k < count; k++) {
    indices.add(nearestIndex(times, first + ((last - first) * k) / Math.max(1, count - 1)));
  }
  return [...indices].map((i) => {
    const numerical = result.releasedFraction[i];
    const analytic = result.analyticFraction[i];
    return { t: times[i], numerical, analytic, error: numerical - analytic };
  });
}
