// SPDX-License-Identifier: GPL-2.0-or-later
/** Illustrative UI values, never a scientific reference case. */
import type { TasteEstimate, UncertaintyResult } from '../../src/engine/m3Types';
import { fixtureChemistry } from './chemistryFixture';
import { fixtureResult } from './shotFixture';

export function fixtureTaste(): TasteEstimate {
  return {
    schema: 'puckworks.taste/1',
    trust: 'low',
    status: 'estimated',
    score_semantics: 'Illustrative relative indices; not validated sensory ratings.',
    acidity_index: 10,
    bitterness_index: 20,
    astringency_index: 30,
    body_index: 40,
    conditions: {
      chemistry_reference_temperature_c: 25,
      serving_temperature_c: null,
      serving_temperature_modelled: false,
      dilution_water_g: 0,
      original_beverage_g: 36,
      diluted_beverage_g: 36,
      aroma_age_s: 30,
    },
    attributes: (['acidity', 'bitterness', 'astringency', 'body'] as const).map((id, i) => ({
      id,
      label: `${id[0].toUpperCase()}${id.slice(1)} potential`,
      index: (i + 1) * 10,
      trust: id === 'astringency' ? 'very_low' : 'low',
      assumptions: [`Illustrative ${id} assumption.`],
      drivers: [
        {
          id: `${id}-driver`,
          label: `${id} driver`,
          value: 1.25,
          units: 'g/L',
          contribution: 0.2,
          registry_refs: ['taste.fixture'],
          source_refs: ['fixture-source'],
        },
      ],
    })),
    assumptions: ['All taste coefficients are grade D estimates.'],
    sources: [
      {
        id: 'fixture-source',
        citation: 'Illustrative source',
        url: 'https://example.com/paper',
        evidence_grade: 'D',
        scope: 'Does not validate the index mapping.',
      },
    ],
  };
}

export function fixtureUncertainty(): UncertaintyResult {
  const band = { p05: 0.17, p50: 0.2, p95: 0.24, min: 0.16, max: 0.25, n: 8 };
  const scenario = {
    summary: fixtureResult().summary,
    chemistry: fixtureChemistry(),
    taste: fixtureTaste(),
  };
  return {
    schema: 'puckworks.uncertainty/1',
    seed: 1729,
    samples_requested: 8,
    samples_completed: 8,
    ensemble_tier: 0,
    band_kind: 'scenario_percentiles_not_confidence_interval',
    groups: {
      grinder_psd: 'unknown',
      roast_age: 'unknown',
      composition: 'unknown',
      water: 'unknown',
    },
    bands: {
      '/summary/ey': band,
      '/summary/tds': { ...band, p05: 0.08, p50: 0.09, p95: 0.1 },
      '/chemistry/acidity/ph': { ...band, p05: 5.1, p50: 5.2, p95: 5.3 },
      '/taste/acidity_index': { ...band, p05: 7, p50: 10, p95: 13 },
    },
    series: {
      progress: [0, 0.5, 1],
      time_basis: 'fraction_of_recorded_duration_including_drip',
      bands: { ey: [band, band, band] },
    },
    baseline_preview: scenario,
    sample_results: Array.from({ length: 8 }, () => structuredClone(scenario)),
    sample_inputs: [],
    sample_failures: [],
    warning_counts: {},
    notes: ['Illustrative scenario supports.'],
    registry_refs: ['uncertainty.fixture'],
    unsupported: { model_discrepancy: 'Model discrepancy is excluded.' },
  };
}
