// SPDX-License-Identifier: GPL-2.0-or-later
/** Personal Bayesian linear preference model. It never changes the core M3 taste map. */
import type { TasteEstimate } from '../engine/m3Types';
import type { JournalEntry } from './types';
export { scorecard } from './journal';
export type { Scorecard } from './journal';

export interface PersonalTaste {
  count: number;
  featureNames: string[];
  coefficients: number[];
  prediction: { mean: number; p05: number; p95: number; sd: number } | null;
  notes: string[];
}
const FEATURES = ['acidity_index', 'bitterness_index', 'astringency_index', 'body_index'] as const;
function features(taste?: TasteEstimate): number[] | null {
  if (!taste) return null;
  const values = FEATURES.map((key) => taste[key]);
  if (values.some((v) => v === null || !Number.isFinite(v) || v < 0 || v > 100)) return null;
  return [1, ...values.map((v) => (v! - 50) / 50)];
}
function inverse(matrix: number[][]): number[][] {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let i = 0; i < n; i++) {
    // Positive diagonal priors make this posterior precision positive definite.
    const pivot = a[i][i];
    for (let j = 0; j < 2 * n; j++) a[i][j] /= pivot;
    for (let k = 0; k < n; k++)
      if (k !== i) {
        const factor = a[k][i];
        for (let j = 0; j < 2 * n; j++) a[k][j] -= factor * a[i][j];
      }
  }
  return a.map((row) => row.slice(n));
}
function dot(a: number[], b: number[]): number {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}
/**
 * Fixed, disclosed prior: rating = 3 + intercept + weighted centered M3 indices;
 * coefficients ~ N(0,1), observation noise sigma = 1 rating point. Posterior
 * predictive intervals include observation noise and stay broad with few ratings.
 */
export function learnTaste(
  entries: JournalEntry[],
  setupId: string,
  candidateTaste?: TasteEstimate | null,
): PersonalTaste {
  const rows = entries
    .filter((entry) => entry.setupId === setupId)
    .flatMap((entry) => {
      const x = features(entry.prediction?.taste),
        y = entry.measurement?.rating;
      return x && y !== undefined && Number.isFinite(y) && y >= 1 && y <= 5
        ? [{ x, y: y - 3 }]
        : [];
    });
  const precision = Array.from({ length: 5 }, (_, i) =>
    Array.from({ length: 5 }, (_, j) => (i === j ? 1 : 0)),
  );
  const target = Array<number>(5).fill(0);
  for (const { x, y } of rows)
    for (let i = 0; i < 5; i++) {
      target[i] += x[i] * y;
      for (let j = 0; j < 5; j++) precision[i][j] += x[i] * x[j];
    }
  const covariance = inverse(precision),
    coefficients = covariance.map((row) => dot(row, target));
  const x = features(candidateTaste ?? undefined);
  let prediction: PersonalTaste['prediction'] = null;
  if (x && rows.length) {
    const rawMean = 3 + dot(x, coefficients),
      sd = Math.sqrt(
        1 +
          dot(
            x,
            covariance.map((row) => dot(row, x)),
          ),
      );
    const clamp = (v: number) => Math.max(1, Math.min(5, v));
    prediction = {
      mean: clamp(rawMean),
      p05: clamp(rawMean - 1.644854 * sd),
      p95: clamp(rawMean + 1.644854 * sd),
      sd,
    };
  }
  return {
    count: rows.length,
    featureNames: ['intercept', ...FEATURES],
    coefficients,
    prediction,
    notes: [
      'Local personal preference estimate on your 1–5 ratings; separate from the core taste indices.',
      'Bayesian ridge: independent N(0,1) coefficient priors, centered 0–100 M3 indices, fixed 1-point observation noise.',
      'The 90% predictive interval includes rating noise and is clipped to the 1–5 display range; few ratings and extrapolation remain uncertain.',
      ...(!x ? ['Candidate needs all four M3 indices before a preference can be estimated.'] : []),
      ...(!rows.length ? ['No rated shots with complete M3 indices for this setup.'] : []),
    ],
  };
}
