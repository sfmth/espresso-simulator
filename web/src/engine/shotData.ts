// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Shot results as they travel from the engine worker to the page.
 *
 * The core returns a ShotResult JSON document with plain arrays. The worker
 * parses it and turns every time series into a Float64Array, so the arrays move
 * to the main thread as transferables (no copy) and stay compact there. A shot
 * normally has a few hundred to a few thousand output times; should a result
 * ever exceed `MAX_SERIES_POINTS`, every series is thinned with the same index
 * set (decimate.ts), always keeping the first and last points and the peaks of
 * pressure, outflow and outlet TDS. The summary numbers come from the core and
 * use every point.
 *
 * Unknown fields (a newer core may add series or other outputs) are kept: an
 * unknown numeric array as long as `t_s` is converted and thinned like the
 * known series, anything else passes through unchanged.
 */
import { decimationIndices, MAX_SERIES_POINTS } from './decimate';
import type { BuiltSpec, Diagnostics, ShotResult, Summary } from './shotTypes';
import type { TasteEstimate } from './m3Types';

/** A result whose time series are Float64Arrays. */
export type ShotResultData = ShotResult<Float64Array>;

export interface ShotRunData {
  result: ShotResultData;
  /** Output times the core produced (more than `result.series.t_s.length` if thinned). */
  totalPoints: number;
  /** Milliseconds spent inside the core call (the solve), out of the request's runtime. */
  coreMs: number;
}

/** `simulateRecipe`: the build and the result. */
export interface RecipeRunData extends ShotRunData {
  build: BuiltSpec;
  taste?: TasteEstimate;
}

/** One point of a sweep: the scalar outputs only. */
export interface SweepPointData {
  summary: Summary;
  diagnostics: Diagnostics;
  /** Milliseconds spent inside the core call. */
  coreMs: number;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) && value.length === length && value.every((v) => typeof v === 'number')
  );
}

function argMax(values: ArrayLike<number> | undefined): number | null {
  if (!values || values.length === 0) return null;
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * Indices to keep when thinning `n` output times to at most `maxPoints`, or
 * null when everything fits. The pressure curve drives the buckets; the peaks
 * of outflow and outlet TDS are always kept.
 */
export function shotThinningIndices(
  series: Json,
  n: number,
  maxPoints = MAX_SERIES_POINTS,
): number[] | null {
  if (n <= maxPoints) return null;
  const pressure = isNumberArray(series.pressure_pa, n) ? series.pressure_pa : null;
  const keep = [
    argMax(pressure ?? undefined),
    argMax(isNumberArray(series.flow_out_m3_s, n) ? series.flow_out_m3_s : undefined),
    argMax(isNumberArray(series.tds_outlet, n) ? series.tds_outlet : undefined),
  ].filter((i): i is number => i !== null);
  return decimationIndices(n, pressure ? (i) => pressure[i] : () => 0, maxPoints, keep);
}

/**
 * Converts a parsed ShotResult document to the transfer form: Float64Array
 * series, thinned if needed. Never throws on unexpected shapes: whatever it
 * does not recognise passes through.
 */
export function toShotRunData(
  document: unknown,
  coreMs: number,
  maxPoints = MAX_SERIES_POINTS,
): ShotRunData {
  const result = isRecord(document) ? { ...document } : {};
  const series = isRecord(result.series) ? result.series : {};
  const times = series.t_s;
  const n = Array.isArray(times) ? times.length : 0;
  const keep = shotThinningIndices(series, n, maxPoints);
  const convert = (values: number[]): Float64Array =>
    keep === null ? Float64Array.from(values) : Float64Array.from(keep, (i) => values[i]);

  const converted: Json = {};
  for (const [key, value] of Object.entries(series)) {
    if (key === 'species_cup_kg' && Array.isArray(value)) {
      converted[key] = value.map((entry: unknown) =>
        isRecord(entry) && isNumberArray(entry.values, n)
          ? { ...entry, values: convert(entry.values) }
          : entry,
      );
    } else if (isNumberArray(value, n)) {
      converted[key] = convert(value);
    } else {
      converted[key] = value;
    }
  }
  result.series = converted;
  return { result: result as unknown as ShotResultData, totalPoints: n, coreMs };
}

/** The distinct buffers behind a converted result's series, for postMessage transfer. */
export function shotTransferables(result: ShotResultData): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (value: unknown) => {
    if (value instanceof Float64Array && value.buffer instanceof ArrayBuffer) {
      buffers.add(value.buffer);
    }
  };
  for (const [key, value] of Object.entries(result.series as unknown as Json)) {
    if (key === 'species_cup_kg' && Array.isArray(value)) {
      for (const entry of value) if (isRecord(entry)) add(entry.values);
    } else {
      add(value);
    }
  }
  return [...buffers];
}

/** Back to a plain JSON document (for export): Float64Arrays become arrays again. */
export function toJsonResult(result: ShotResultData): ShotResult {
  const plain = (value: unknown): unknown => {
    if (value instanceof Float64Array) return Array.from(value);
    if (Array.isArray(value)) return value.map(plain);
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    }
    return value;
  };
  return plain(result) as ShotResult;
}

/** The series of a converted result that are Float64Arrays of the full length, known or not. */
export function numericSeries(result: ShotResultData): [string, Float64Array][] {
  const n = result.series.t_s?.length ?? 0;
  return Object.entries(result.series as unknown as Json).filter(
    (entry): entry is [string, Float64Array] =>
      entry[0] !== 't_s' && entry[1] instanceof Float64Array && entry[1].length === n,
  );
}
