// SPDX-License-Identifier: GPL-2.0-or-later
/** Additive M3 shared-core contracts. Intervals describe input scenarios, not model error. */
import type { CupChemistryResult, Summary } from './shotTypes';

export type EvidenceMode = 'unknown' | 'measured' | 'fixed';
export interface UncertaintyGroups {
  grinder_psd: EvidenceMode;
  roast_age: EvidenceMode;
  composition: EvidenceMode;
  water: EvidenceMode;
}
export interface UncertaintyOptions {
  samples: number;
  seed: number;
  groups: UncertaintyGroups;
  taste_conditions?: { serving_temperature_c?: number | null; dilution_water_g?: number };
}
export interface ScenarioBand {
  p05: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  n: number;
}
export interface ScenarioResult {
  summary: Summary;
  chemistry: CupChemistryResult | null;
  taste: TasteEstimate;
}
export interface UncertaintyResult {
  schema: string;
  seed: number;
  samples_requested: number;
  samples_completed: number;
  ensemble_tier: 0;
  band_kind: 'scenario_percentiles_not_confidence_interval';
  groups: UncertaintyGroups;
  bands: Record<string, ScenarioBand>;
  series: {
    progress: number[];
    time_basis: string;
    bands: Record<string, ScenarioBand[]>;
  };
  baseline_preview: ScenarioResult;
  sample_results: ScenarioResult[];
  sample_inputs: {
    sample_index: number;
    psd_scale: number;
    psd_fines_factor: number;
    days_off_roast: number;
    composition_factor: number;
    water_factor: number;
    water_ph: number | null;
  }[];
  sample_failures: { sample_index: number; message: string }[];
  warning_counts: Record<string, number>;
  notes: string[];
  registry_refs: string[];
  unsupported: Record<string, string>;
}

export interface TasteDriver {
  id: string;
  label: string;
  value: number;
  units: string;
  contribution: number;
  registry_refs: string[];
  source_refs: string[];
}
export interface TasteAttribute {
  id: 'acidity' | 'bitterness' | 'astringency' | 'body';
  label: string;
  index: number | null;
  trust: string;
  drivers: TasteDriver[];
  assumptions: string[];
}
export interface TasteEstimate {
  schema: string;
  trust: string;
  status: string;
  score_semantics: string;
  acidity_index: number | null;
  bitterness_index: number | null;
  astringency_index: number | null;
  body_index: number | null;
  attributes: TasteAttribute[];
  conditions: {
    chemistry_reference_temperature_c: number | null;
    serving_temperature_c: number | null;
    serving_temperature_modelled: boolean;
    dilution_water_g: number;
    original_beverage_g: number;
    diluted_beverage_g: number;
    aroma_age_s: number | null;
  };
  assumptions: string[];
  sources: { id: string; citation: string; url: string; evidence_grade: string; scope: string }[];
}
