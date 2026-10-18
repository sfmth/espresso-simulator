// SPDX-License-Identifier: GPL-2.0-or-later
import { useMemo, useState } from 'react';
import type uPlot from 'uplot';
import { LineChart, type ChartSeriesSpec } from '../components/LineChart';
import type {
  EvidenceMode,
  ScenarioBand,
  UncertaintyGroups,
  UncertaintyResult,
} from '../engine/m3Types';
import type { Catalog } from '../engine/shotTypes';
import { formatTick } from '../lab/format';
import { datedName, downloadJson } from './download';
import { fixed, grams, milligrams, percent, seconds, sig } from './format';
import type { FormResult } from './recipeForm';
import type { ShotOutcome } from './shotStore';
import { EVIDENCE_MODES, type useUncertainty } from './useUncertainty';

export type UncertaintyControls = ReturnType<typeof useUncertainty>;

const GROUPS: { id: keyof UncertaintyGroups; label: string; description: string }[] = [
  {
    id: 'grinder_psd',
    label: 'Grinder / particle sizes',
    description:
      'Common particle size scale and fines reweighting; a supplied PSD still has measurement uncertainty.',
  },
  {
    id: 'roast_age',
    label: 'Roast age',
    description: 'Days off roast and the associated degassing and freshness assumptions.',
  },
  {
    id: 'composition',
    label: 'Coffee composition',
    description:
      'Estimated compound inventories and separate phase contents; origin descriptors do not determine a measured composition.',
  },
  {
    id: 'water',
    label: 'Water analysis',
    description: 'Alkalinity, hardness, minerals and pH around the recipe’s water values.',
  },
];

const MODE_LABELS: Record<EvidenceMode, string> = {
  unknown: 'Unknown / estimated',
  measured: 'Measured / narrower scenario',
  fixed: 'Fixed / no variation',
};

export function bandText(
  band: ScenarioBand | undefined,
  format: (v: number) => string,
): string | undefined {
  return band ? `${format(band.p05)}–${format(band.p95)}` : undefined;
}

const METRICS = [
  { path: '/summary/shot_time_s', label: 'Shot time', format: seconds },
  { path: '/summary/beverage_mass_kg', label: 'Beverage', format: grams },
  { path: '/summary/tds', label: 'TDS', format: percent },
  { path: '/summary/ey', label: 'Extraction yield', format: percent },
  { path: '/chemistry/acidity/ph', label: 'Cup pH', format: (v: number) => fixed(v, 2) },
  {
    path: '/chemistry/acidity/titratable_acidity_mmol_l_to_ph_6_6',
    label: 'TA to pH 6.6',
    format: (v: number) => `${fixed(v, 2)} mmol/L`,
  },
  { path: '/chemistry/texture/lipid_mass_kg', label: 'Lipid emulsion', format: milligrams },
  {
    path: '/chemistry/refractometer/apparent_tds',
    label: 'Apparent refractometer TDS',
    format: percent,
  },
] as const;

const CURVES = [
  { id: 'pressure_pa', label: 'Pressure', unit: 'bar', factor: 1e-5 },
  { id: 'flow_out_m3_s', label: 'Outflow', unit: 'mL/s', factor: 1e6 },
  { id: 'tds_cup', label: 'Cup TDS', unit: '%', factor: 100 },
  { id: 'ey', label: 'Extraction yield', unit: '%', factor: 100 },
] as const;
const BAND_SERIES: readonly ChartSeriesSpec[] = [
  { label: 'p95 scenario', slot: 0, width: 1, dash: [4, 3] },
  { label: 'p05 scenario', slot: 0, width: 1, dash: [4, 3] },
  { label: 'Median (Tier 0)', slot: 0, width: 2 },
];
const CHART_BANDS = [{ upper: 1, lower: 2 }] as const;
const formatProgress = (v: number) => `${fixed(v * 100, 0)}% of recorded shot`;
const formatCurve = (v: number) => fixed(v, 2);

function Trajectories({ result }: { result: UncertaintyResult }) {
  const charts = useMemo(
    () =>
      CURVES.flatMap((curve) => {
        const bands = result.series.bands[curve.id];
        if (!bands?.length) return [];
        const data: uPlot.AlignedData = [
          result.series.progress,
          bands.map((b) => b.p95 * curve.factor),
          bands.map((b) => b.p05 * curve.factor),
          bands.map((b) => b.p50 * curve.factor),
        ];
        return [{ ...curve, bands, data }];
      }),
    [result],
  );
  if (!charts.length) return null;
  return (
    <section aria-labelledby="scenario-curves-title">
      <h4 id="scenario-curves-title">Scenario trajectories (Tier 0)</h4>
      <p className="note">
        Shading spans p05–p95; the solid line is the median. Each shot is aligned by its own
        recorded duration, including drip. A point at 50% can occur at a different time in each
        shot; these bands are not aligned by elapsed seconds.
      </p>
      <div className="chart-grid">
        {charts.map((chart) => (
          <figure
            className="chart chart-small"
            key={chart.id}
            data-chart={`uncertainty-${chart.id}`}
          >
            <figcaption>
              {chart.label} ({chart.unit})
            </figcaption>
            <LineChart
              data={chart.data}
              series={BAND_SERIES}
              bands={CHART_BANDS}
              xLabel="Fraction of recorded duration"
              yLabel={chart.unit}
              yFromZero
              formatX={formatProgress}
              formatY={formatCurve}
              formatTick={formatTick}
              summary={`${chart.label}: Tier-0 scenario p05, median and p95 at ${result.series.progress.length} fractions of recorded duration.`}
              syncKey="scenario-progress"
              height={170}
            />
          </figure>
        ))}
      </div>
      <details className="table-view">
        <summary>Trajectory interval table</summary>
        <div className="table-wrap">
          <table>
            <caption>Tier-0 p05–p95 intervals by fraction of recorded duration</caption>
            <thead>
              <tr>
                <th scope="col">Progress</th>
                {charts.map((chart) => (
                  <th scope="col" key={chart.id}>
                    {chart.label} ({chart.unit})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.series.progress.map((progress, i) => (
                <tr key={i}>
                  <th scope="row">{fixed(progress * 100, 0)}%</th>
                  {charts.map((chart) => (
                    <td key={chart.id}>
                      {bandText(chart.bands[i], (v) => fixed(v * chart.factor, 2)) ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function AllBands({ result }: { result: UncertaintyResult }) {
  const [query, setQuery] = useState('');
  const matches = Object.entries(result.bands).filter(([path]) =>
    path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <details className="table-view">
      <summary>All numeric output intervals ({Object.keys(result.bands).length})</summary>
      <div className="field">
        <label htmlFor="uncertainty-band-search">Find an output interval</label>
        <input
          id="uncertainty-band-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="field-hint">
          Paths name the shared engine’s fields; values retain the units in those field names. Taste
          indices are unitless.
        </p>
      </div>
      <p className="note">
        {matches.length} matching intervals.{' '}
        {matches.length > 100 ? 'Showing the first 100; narrow the search to find any field.' : ''}
      </p>
      <div className="table-wrap">
        <table aria-label="All numeric scenario intervals">
          <thead>
            <tr>
              <th scope="col">Output path / native units</th>
              <th scope="col">p05</th>
              <th scope="col">Median</th>
              <th scope="col">p95</th>
              <th scope="col">Members</th>
            </tr>
          </thead>
          <tbody>
            {matches.slice(0, 100).map(([path, band]) => (
              <tr key={path}>
                <th scope="row">
                  <code>{path}</code>
                </th>
                <td>{sig(band.p05, 5)}</td>
                <td>{sig(band.p50, 5)}</td>
                <td>{sig(band.p95, 5)}</td>
                <td>{band.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function valueAt(document: unknown, path: string): number | null {
  let value = document;
  for (const key of path.split('/').slice(1)) {
    if (typeof value !== 'object' || value === null) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function UncertaintyPanel({
  validation,
  controls,
  central,
  catalog,
}: {
  validation: FormResult;
  controls: UncertaintyControls;
  central: ShotOutcome | null;
  catalog?: Catalog;
}) {
  const { options, setOptions, setGroup, outcome, current, running, state, error, run, cancel } =
    controls;
  const validSeed =
    Number.isInteger(options.seed) && options.seed >= 0 && options.seed <= 4294967295;
  const result = outcome?.result;
  let status = 'Choose what is known, then run the input scenarios.';
  if (!validation.ok) status = 'Correct the recipe inputs before running scenarios.';
  else if (running) status = `Running ${options.samples} Tier-0 input scenarios…`;
  else if (state === 'cancelled')
    status = 'Scenario run cancelled. Run again for the current inputs.';
  else if (error) status = 'Scenario run failed. Check the message and run again.';
  else if (result)
    status = `${current ? '' : 'Earlier run: '}${result.samples_completed} of ${result.samples_requested} scenarios completed; seed ${result.seed}.`;
  return (
    <div className="panel-stack uncertainty-panel" aria-label="Input uncertainty">
      <div>
        <h4>Uncertainty in the inputs</h4>
        <p className="note">
          Explore plausible inputs before reading the taste estimates. These are p05–p95 scenario
          percentiles from a fast Tier-0 ensemble, not confidence intervals or a validated
          prediction of the real shot. The standard Run result keeps its selected tier.
        </p>
      </div>
      <form
        className="uncertainty-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (validation.ok && validSeed) run();
        }}
      >
        <fieldset>
          <legend>What do you know about this coffee and setup?</legend>
          <div className="field-grid">
            {GROUPS.map((group) => (
              <div className="field" key={group.id}>
                <label htmlFor={`uncertainty-${group.id}`}>{group.label}</label>
                <select
                  id={`uncertainty-${group.id}`}
                  value={options.groups[group.id]}
                  aria-describedby={`uncertainty-${group.id}-hint`}
                  onChange={(event) => setGroup(group.id, event.target.value as EvidenceMode)}
                >
                  {EVIDENCE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
                <p className="field-hint" id={`uncertainty-${group.id}-hint`}>
                  {group.description}
                </p>
              </div>
            ))}
          </div>
          <p className="note">
            “Measured” narrows the assumed spread; it does not validate the model. “Fixed” holds
            this group constant and can make the bands deceptively narrow. Correlations between
            groups and uncertainty in the model itself are omitted; within-group correlations follow
            the assumptions below.
          </p>
        </fieldset>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="uncertainty-samples">Scenario count</label>
            <select
              id="uncertainty-samples"
              value={options.samples}
              onChange={(event) => setOptions({ ...options, samples: Number(event.target.value) })}
            >
              {[8, 16, 32, 64].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <p className="field-hint">More samples refine the percentiles, not model accuracy.</p>
          </div>
          <div className="field">
            <label htmlFor="uncertainty-seed">Random seed</label>
            <input
              id="uncertainty-seed"
              type="number"
              min={0}
              max={4294967295}
              step={1}
              value={Number.isNaN(options.seed) ? '' : options.seed}
              aria-invalid={!validSeed || undefined}
              aria-describedby="uncertainty-seed-hint"
              onChange={(event) =>
                setOptions({
                  ...options,
                  seed: event.target.value === '' ? Number.NaN : Number(event.target.value),
                })
              }
            />
            <p className="field-hint" id="uncertainty-seed-hint">
              An integer from 0 to 4294967295. The same inputs, count, seed and engine version
              reproduce the run.
            </p>
          </div>
        </div>
        <div className="actions">
          <button
            id="uncertainty-run"
            type="submit"
            className="button button-primary"
            disabled={!validation.ok || !validSeed || running}
          >
            Run uncertainty (Tier 0)
          </button>
          <button
            type="button"
            className="button"
            aria-disabled={!running || undefined}
            onClick={() => {
              if (running) cancel();
            }}
          >
            Cancel uncertainty
          </button>
        </div>
      </form>
      <p id="uncertainty-status" className="run-status" role="status" aria-live="polite">
        {status}
      </p>
      {error && (
        <p className="run-error" role="alert">
          Scenario run failed: {error}
        </p>
      )}
      {outcome && result && (
        <div className="panel-stack" data-stale={!current ? 'true' : undefined} aria-busy={running}>
          {!current && (
            <p>
              <span className="stale-badge">Uncertainty for earlier inputs or settings</span>
            </p>
          )}
          <p className="result-badges">
            <span className="tier-badge">Tier 0 ensemble</span>
            <span className="note">Input scenarios only · model error excluded</span>
          </p>
          {(result.sample_failures.length > 0 ||
            result.sample_results.some((s) => s.summary.stop_reason === 'choked')) && (
            <div className="run-warning" role="note">
              <p>
                {result.sample_failures.length} scenarios failed;{' '}
                {result.sample_results.filter((s) => s.summary.stop_reason === 'choked').length}{' '}
                successful scenarios stopped as choked. Percentiles include successful members only,
                including choked shots. Unavailable outputs are omitted from their own band; check
                its member count.
              </p>
              {result.sample_failures.length > 0 && (
                <ul>
                  {result.sample_failures.map((failure) => (
                    <li key={failure.sample_index}>
                      Scenario {failure.sample_index + 1}: {failure.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <dl className="tiles" aria-label="Scenario output intervals">
            {METRICS.map((metric) => {
              const band = result.bands[metric.path];
              if (!band) return null;
              return (
                <div className="tile" key={metric.path}>
                  <dt>{metric.label}: p05–p95</dt>
                  <dd>
                    <span className="tile-value">{bandText(band, metric.format)}</span>
                    <span className="tile-hint">
                      Median {metric.format(band.p50)} · {band.n} scenarios
                    </span>
                  </dd>
                </div>
              );
            })}
          </dl>
          <div className="table-wrap">
            <table aria-label="Central shot and Tier-0 baseline comparison">
              <caption>Check the solver difference before interpreting the scenario spread</caption>
              <thead>
                <tr>
                  <th scope="col">Output</th>
                  <th scope="col">
                    Current central shot {central ? `(Tier ${central.tier})` : '(run needed)'}
                  </th>
                  <th scope="col">Same-input baseline (Tier 0)</th>
                  <th scope="col">Scenario median (Tier 0)</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map((metric) => {
                  const base = valueAt(result.baseline_preview, metric.path);
                  const centralValue =
                    current && central ? valueAt(central.result, metric.path) : null;
                  const band = result.bands[metric.path];
                  return (
                    <tr key={metric.path}>
                      <th scope="row">{metric.label}</th>
                      <td>{centralValue === null ? '—' : metric.format(centralValue)}</td>
                      <td>{base === null ? '—' : metric.format(base)}</td>
                      <td>{band ? metric.format(band.p50) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">
            The baseline uses the original inputs at Tier 0. Its difference from the central shot
            estimates a solver approximation gap for this recipe; this gap is outside the bands. The
            central shot can lie outside the scenario interval.
          </p>
          <Trajectories result={result} />
          <AllBands result={result} />
          {Object.keys(result.warning_counts).length > 0 && (
            <details className="model-notes">
              <summary>
                Scenario warnings ({Object.keys(result.warning_counts).length} kinds)
              </summary>
              <ul>
                {Object.entries(result.warning_counts).map(([warning, count]) => (
                  <li key={warning}>
                    {count} occurrences: {warning}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details className="model-notes">
            <summary>Scenario assumptions and limits</summary>
            <ul>
              {result.notes.map((note, i) => (
                <li key={`n-${i}`}>{note}</li>
              ))}
              {Object.values(result.unsupported).map((note, i) => (
                <li key={`u-${i}`}>{note}</li>
              ))}
            </ul>
            {catalog && (
              <div className="table-wrap">
                <table aria-label="Assumed scenario supports">
                  <caption>
                    Illustrative sampling half-widths used by this run, before physical bounds
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Assumption</th>
                      <th scope="col">Half-width</th>
                      <th scope="col">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.registry.parameters
                      .filter(
                        (parameter) =>
                          parameter.id.startsWith('uncertainty.') &&
                          result.registry_refs.includes(parameter.id),
                      )
                      .map((parameter) => (
                        <tr key={parameter.id}>
                          <th scope="row">
                            {parameter.name}
                            <br />
                            <small>{parameter.description}</small>
                          </th>
                          <td>
                            {sig(outcome.recipe.overrides?.[parameter.id] ?? parameter.default, 4)}{' '}
                            {parameter.units}
                          </td>
                          <td>
                            {parameter.tag}; grade {parameter.evidence_grade}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="note">
              Each p05–p95 range summarizes the central part of the sampled scenarios using
              interpolated percentiles. With few samples it is coarse. A narrow range can coexist
              with a biased model.
            </p>
          </details>
          <button
            type="button"
            className="button button-small"
            onClick={() => downloadJson(datedName('uncertainty', 'json'), outcome)}
          >
            Download uncertainty report JSON
          </button>
        </div>
      )}
    </div>
  );
}
