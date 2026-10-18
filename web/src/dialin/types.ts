// SPDX-License-Identifier: GPL-2.0-or-later
/** Local-only M4 records. Practical units are explicit; core summaries use SI. */
import type { Recipe, Summary } from '../engine/shotTypes';
import type { TasteEstimate } from '../engine/m3Types';

export interface Prediction {
  recordedAt: string;
  coreVersion: string;
  calibrationId?: string;
  executedRecipe: Recipe;
  summary: Summary;
  taste?: TasteEstimate;
  origin: 'app' | 'import';
}

export interface Measurement {
  recordedAt: string;
  timeS: number;
  yieldG: number;
  tdsPercent?: number;
  rating?: number;
  notes: string;
}

export interface JournalEntry {
  id: string;
  createdAt: string;
  setupId: string;
  label: string;
  recipe: Recipe;
  prediction?: Prediction;
  measurement?: Measurement;
  source: 'manual' | 'csv' | 'de1' | 'json';
}

export interface CalibrationParameter {
  id: 'permeability' | 'grinderScale';
  label: string;
  map: number;
  p05: number;
  p95: number;
  status: string;
}

export interface CalibrationProfile {
  id: string;
  createdAt: string;
  coreVersion: string;
  setupId: string;
  scopeKey: string;
  trainingIds: string[];
  parameters: CalibrationParameter[];
  permeability: number;
  grinderScale: number;
  referencePermeability: number;
  referenceX50GapRatio?: number;
  timeSigmaS: number;
  tdsSigmaPercent: number;
  posterior: { permeability: number; grinderScale: number; weight: number }[];
  checks: { entryId: string; timeErrorS: number; eyErrorPoints: number | null }[];
  notes: string[];
}

export interface JournalDocument {
  schema: 'puckworks.journal/1';
  entries: JournalEntry[];
  calibrations: CalibrationProfile[];
}
