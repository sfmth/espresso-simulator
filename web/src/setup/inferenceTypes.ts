// SPDX-License-Identifier: GPL-2.0-or-later
import type { Recipe } from '../engine/shotTypes';

export type SetupValue = number | string | boolean;
export interface SetupConstraint {
  path: string;
  mode: 'locked' | 'range' | 'unknown';
  value?: SetupValue;
  min?: number;
  max?: number;
  step?: number;
  choices?: SetupValue[];
}
export interface SetupParameter {
  path: string;
  label: string;
  unit: string;
  kind: 'number' | 'category' | 'boolean';
  value?: SetupValue;
  min?: number;
  max?: number;
  step?: number;
  choices?: SetupValue[];
  group: string;
  modeled: boolean;
  reason?: string;
  /** Search transform only; it does not define a prior or uncertainty interval. */
  logarithmic?: boolean;
}
export interface SetupObservation {
  id: string;
  label: string;
  timeS: number;
  yieldG: number;
  tdsPercent?: number;
  timeBasis: 'pump' | 'first-drip';
  massBasis: 'final' | 'pump-stop';
  timeToleranceS: number;
  yieldToleranceG: number;
  tdsTolerancePercent?: number;
  recipe: Recipe;
  /** Exact known per-shot differences; all other fields come from the shared candidate. */
  changes?: string[];
}
export interface InferenceRequest {
  recipe: Recipe;
  constraints: SetupConstraint[];
  observations: SetupObservation[];
  /** Total physics calls, including Tier 1 verification and timing refinements. */
  maxEvaluations?: number;
  seed?: number;
}
export interface SetupCheck {
  observationId: string;
  label: string;
  predicted: { timeS: number; yieldG: number; tdsPercent: number };
  observed: { timeS: number; yieldG: number; tdsPercent?: number };
  residuals: { timeS: number; yieldG: number; tdsPercent?: number };
  tolerances: { timeS: number; yieldG: number; tdsPercent?: number };
  matches: boolean;
  /** Timing is a bounded replay input, not independent prediction evidence. */
  timeIsReplayCondition: true;
}
export interface SetupCandidate {
  id: string;
  recipe: Recipe;
  values: Record<string, SetupValue>;
  checks: SetupCheck[];
  score: number;
  matches: boolean;
  notes: string[];
}
export interface InferenceProgress {
  stage: 'search' | 'verify';
  completed: number;
  total: number;
  bestScore?: number;
}
export interface InferenceResult {
  candidates: SetupCandidate[];
  nearMisses: SetupCandidate[];
  evaluations: number;
  skipped: number;
  coreVersion: string;
  notes: string[];
  /** Sampled ranges only, never confidence or identification claims. */
  exploredRanges: { path: string; min?: number; max?: number; values?: SetupValue[] }[];
}
