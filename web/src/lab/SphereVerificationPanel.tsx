// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * M0 "Particle kernel verification" panel (docs/PLAN.md §10, §12 M0): diffusion
 * out of a sphere into a perfect sink, solved by puckcore (WebAssembly, in a
 * worker) and compared with Crank's analytic solution.
 */
import { useEffect, useMemo, useState } from 'react';
import { LineChart, type ChartSeriesSpec } from '../components/LineChart';
import { useEngine } from '../engine/EngineContext';
import { estimateRunBytes, formatMegabytes, MEMORY_WARNING_BYTES } from '../engine/memory';
import { SPHERE_GRIDS, SPHERE_SCHEMES, type SphereGrid, type SphereScheme } from '../engine/types';
import { useAppStore } from '../store';
import { buildChartData, sampleRows } from './chartData';
import { formatMilliseconds, formatScientific, formatSignificant, formatTick } from './format';
import { GRID_LABELS, SCHEME_LABELS } from './sphereForm';
import { useSphereRun } from './useSphereRun';

type TextField = 'radiusUm' | 'diffusivity' | 'nShells' | 'tEnd' | 'nSteps';

const TEXT_FIELDS: readonly {
  field: TextField;
  label: string;
  inputMode: 'decimal' | 'numeric' | 'text';
}[] = [
  { field: 'radiusUm', label: 'Radius (µm)', inputMode: 'decimal' },
  // Scientific notation needs the letter e, which decimal keypads lack.
  { field: 'diffusivity', label: 'Diffusivity (m²/s)', inputMode: 'text' },
  { field: 'nShells', label: 'Shells', inputMode: 'numeric' },
  { field: 'tEnd', label: 'End time (s)', inputMode: 'decimal' },
  { field: 'nSteps', label: 'Steps', inputMode: 'numeric' },
];

const RELEASE_SERIES: readonly ChartSeriesSpec[] = [
  { label: 'Numerical', slot: 0 },
  { label: 'Analytic (Crank)', slot: 1, dash: [6, 4] },
];
const ERROR_SERIES: readonly ChartSeriesSpec[] = [{ label: 'Numerical − analytic', slot: 0 }];
const FRACTION_RANGE = [0, 1] as const;
const formatTime = (t: number) => `${formatSignificant(t, 4)} s`;
const formatFraction = (v: number) => formatSignificant(v, 6);
const formatError = (v: number) => formatScientific(v, 2);

function useCoreVersion(): string | null {
  const engine = useEngine();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    engine.coreVersion().then(
      ({ result }) => {
        if (active) setVersion(result);
      },
      () => {
        if (active) setVersion('unavailable');
      },
    );
    return () => {
      active = false;
    };
  }, [engine]);
  return version;
}

export function SphereVerificationPanel() {
  const form = useAppStore((s) => s.sphereForm);
  const setField = useAppStore((s) => s.setSphereField);
  const resetForm = useAppStore((s) => s.resetSphereForm);
  const run = useAppStore((s) => s.sphereRun);
  const { validation, autoRun, run: runNow, cancel } = useSphereRun();
  const coreVersion = useCoreVersion();

  const errors = validation.ok ? {} : validation.errors;
  const latest = run.latest;
  const running = run.status === 'running';
  const current =
    latest !== null &&
    validation.ok &&
    JSON.stringify(latest.params) === JSON.stringify(validation.params);
  const stale = latest !== null && (running || !current);
  const memory = validation.ok ? estimateRunBytes(validation.params) : 0;

  const chartData = useMemo(() => (latest ? buildChartData(latest.result) : null), [latest]);
  const rows = useMemo(() => (latest ? sampleRows(latest.result) : []), [latest]);

  // Visible status. Screen readers hear only run outcomes (`run.announcement`), not every edit.
  let status: string;
  if (!validation.ok) status = 'Check the highlighted inputs.';
  else if (running) status = 'Running…';
  else if (run.status === 'error') status = 'The last run failed.';
  else if (current) {
    status = `Up to date: ${latest.result.totalPoints.toLocaleString('en-US')} time points.`;
  } else if (run.status === 'cancelled') status = 'Cancelled. Press Run to start it again.';
  else if (!autoRun) {
    status =
      `Large run (${validation.params.nSteps.toLocaleString('en-US')} steps, ` +
      `${validation.work.toLocaleString('en-US')} shell-steps): press Run to start it.`;
  } else status = 'Starting…';

  const tile = (label: string, value: string, hint: string, raw?: number) => (
    <div className="tile">
      <dt>{label}</dt>
      <dd>
        <span className="tile-value" data-value={raw === undefined ? undefined : String(raw)}>
          {value}
        </span>
        <span className="tile-hint">{hint}</span>
      </dd>
    </div>
  );

  return (
    <section className="panel" aria-labelledby="sphere-title">
      <div className="panel-header">
        <h2 id="sphere-title">Particle kernel verification</h2>
        <p className="panel-intro">
          A sphere starts full of solute and releases it into a perfect sink. The puckcore engine
          (WebAssembly, in a background worker) solves the diffusion numerically; the result is
          compared with Crank’s analytic solution. Every particle in the espresso model is built on
          this kernel.
        </p>
      </div>

      <div className="lab-layout">
        <form
          className="controls"
          aria-label="Simulation inputs"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            runNow();
          }}
        >
          {TEXT_FIELDS.map(({ field, label, inputMode }) => {
            const id = `sphere-${field}`;
            const error = errors[field];
            return (
              <div className="field" key={field}>
                <label htmlFor={id}>{label}</label>
                <input
                  id={id}
                  name={field}
                  type="text"
                  inputMode={inputMode}
                  autoComplete="off"
                  spellCheck={false}
                  value={form[field]}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(event) => setField(field, event.target.value)}
                />
                {error && (
                  <p className="field-error" id={`${id}-error`}>
                    {error}
                  </p>
                )}
              </div>
            );
          })}

          <div className="field">
            <label htmlFor="sphere-grid">Grid</label>
            <select
              id="sphere-grid"
              name="grid"
              value={form.grid}
              onChange={(event) => setField('grid', event.target.value as SphereGrid)}
            >
              {SPHERE_GRIDS.map((grid) => (
                <option key={grid} value={grid}>
                  {GRID_LABELS[grid]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="sphere-scheme">Scheme</label>
            <select
              id="sphere-scheme"
              name="scheme"
              value={form.scheme}
              onChange={(event) => setField('scheme', event.target.value as SphereScheme)}
            >
              {SPHERE_SCHEMES.map((scheme) => (
                <option key={scheme} value={scheme}>
                  {SCHEME_LABELS[scheme]}
                </option>
              ))}
            </select>
          </div>

          <div className="actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={!validation.ok}
              aria-describedby={memory > MEMORY_WARNING_BYTES ? 'sphere-memory' : undefined}
            >
              Run
            </button>
            {/* aria-disabled rather than disabled: focus stays on the button after it is used. */}
            <button
              type="button"
              className="button"
              aria-disabled={running ? undefined : true}
              onClick={() => {
                if (running) cancel();
              }}
            >
              Cancel
            </button>
            <button type="button" className="button button-quiet" onClick={resetForm}>
              Defaults
            </button>
          </div>
          {memory > MEMORY_WARNING_BYTES && (
            <p className="run-warning" id="sphere-memory">
              This run needs about {formatMegabytes(memory)} of memory.
            </p>
          )}
          <p className="run-status" id="sphere-status">
            {status}
          </p>
          <p className="visually-hidden" role="status">
            {run.announcement}
          </p>
        </form>

        <div className="results" data-stale={stale ? 'true' : undefined} aria-busy={running}>
          {run.status === 'error' && run.error && (
            <p className="run-error" role="alert">
              The run failed: {run.error}
            </p>
          )}
          {stale && (
            <p className="stale-badge">{running ? 'Updating…' : 'Results for earlier inputs'}</p>
          )}

          <dl className="tiles" aria-label="Run summary">
            {tile(
              'Max abs error',
              latest ? formatScientific(latest.result.maxAbsError) : '—',
              'largest |numerical − analytic|',
              latest?.result.maxAbsError,
            )}
            {tile(
              'Mass balance error',
              latest ? formatScientific(latest.result.massBalanceError) : '—',
              'fraction of the initial mass',
              latest?.result.massBalanceError,
            )}
            {tile(
              'Runtime',
              latest ? formatMilliseconds(latest.runtimeMs) : '—',
              'in the worker',
              latest?.runtimeMs,
            )}
            {tile('Core version', coreVersion ?? '…', 'puckcore (WebAssembly)')}
          </dl>

          {latest && chartData ? (
            <>
              <figure className="chart">
                <figcaption>Released fraction over time</figcaption>
                <LineChart
                  data={chartData.release}
                  series={RELEASE_SERIES}
                  xLabel="Time (s)"
                  yLabel="Released fraction"
                  yRange={FRACTION_RANGE}
                  syncKey="sphere-time"
                  formatX={formatTime}
                  formatY={formatFraction}
                  formatTick={formatTick}
                  summary={`Released fraction from 0 to ${formatTime(latest.params.tEndS)}. At the end, numerical ${formatFraction(
                    latest.result.releasedFraction.at(-1) ?? Number.NaN,
                  )}, analytic ${formatFraction(latest.result.analyticFraction.at(-1) ?? Number.NaN)}.`}
                />
              </figure>
              <figure className="chart">
                <figcaption>Error over time (numerical − analytic)</figcaption>
                <LineChart
                  data={chartData.error}
                  series={ERROR_SERIES}
                  xLabel="Time (s)"
                  yLabel="Error"
                  baseline={0}
                  syncKey="sphere-time"
                  formatX={formatTime}
                  formatY={formatError}
                  formatTick={formatTick}
                  summary={`Numerical minus analytic released fraction over time. Largest absolute difference ${formatError(
                    latest.result.maxAbsError,
                  )}.`}
                />
              </figure>
              {chartData.drawn < chartData.total && (
                <p className="note">
                  The charts draw {chartData.drawn.toLocaleString('en-US')} of{' '}
                  {chartData.total.toLocaleString('en-US')} time points: each interval’s largest and
                  smallest error, the largest error overall and the times in the table. The tiles
                  use every point.
                </p>
              )}
              <details className="table-view">
                <summary>Table view ({rows.length} sampled times)</summary>
                <div className="table-wrap">
                  <table>
                    <caption>Released fraction at sampled times</caption>
                    <thead>
                      <tr>
                        <th scope="col">Time (s)</th>
                        <th scope="col">Numerical</th>
                        <th scope="col">Analytic</th>
                        <th scope="col">Numerical − analytic</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.t}>
                          <td>{formatSignificant(row.t, 4)}</td>
                          <td>{formatFraction(row.numerical)}</td>
                          <td>{formatFraction(row.analytic)}</td>
                          <td>{formatError(row.error)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <p className="note">The charts appear after the first run.</p>
          )}
        </div>
      </div>
    </section>
  );
}
