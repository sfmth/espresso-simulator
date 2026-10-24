// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * One-dimensional sweeps: vary one input of the current recipe (grind, dose,
 * temperature, stop mass, a program target, a bean descriptor, or any registry
 * parameter) over a range, and plot chosen outputs against it, one small chart
 * per output. Runs in the engine worker point by point, with progress and
 * Cancel. Sweeps can be pinned and overlaid when they vary the same input.
 */
import { useMemo, useState } from 'react';
import { HelpButton } from '../help/HelpButton';
import type uPlot from 'uplot';
import { LineChart, type ChartSeriesSpec } from '../components/LineChart';
import type { Catalog } from '../engine/shotTypes';
import { formatTick } from '../lab/format';
import { sweepCsv } from './csv';
import { datedName, downloadCsv } from './download';
import { fixed, sig } from './format';
import { focusSoon } from './focus';
import { joinTables } from './PsdPanel';
import { physicalKey, type FormResult } from './recipeForm';
import { MAX_PINS, useShotStore, type SweepOutput, type SweepRun } from './shotStore';
import {
  MAX_SWEEP_POINTS,
  planSweep,
  SWEEP_OUTPUTS,
  sweepOutput,
  sweepTargets,
  type SweepTarget,
} from './sweep';
import { useSweep } from './useSweep';

const sweepTerm = (id: string) =>
  ({
    shot_time: 'shot-time',
    max_pressure: 'pressure',
    first_drops: 'first-drops',
    ey_std: 'uniformity',
  })[id] ?? id;
interface SweepLine {
  label: string;
  slot: number;
  run: SweepRun;
}

function OutputChart({
  output,
  lines,
  unit,
  label,
}: {
  output: SweepOutput;
  lines: readonly SweepLine[];
  unit: string;
  label: string;
}) {
  const info = sweepOutput(output);
  const { data, series } = useMemo(() => {
    const tables = lines.map((line) => ({
      x: line.run.points.map((p) => p.x),
      y: line.run.points.map((p) => (p.ok ? (info.value(p.summary) ?? Number.NaN) : Number.NaN)),
    }));
    const joined = joinTables(tables);
    // NaN marks a failed point: draw a gap there.
    const cleaned = joined.map((column, i) =>
      i === 0 ? column : Array.from(column, (v) => (v === null || Number.isNaN(v) ? null : v)),
    ) as uPlot.AlignedData;
    const specs: ChartSeriesSpec[] = lines.map((line) => ({
      label: line.label,
      slot: line.slot,
      points: true,
    }));
    return { data: cleaned, series: specs };
  }, [lines, info]);
  const formatX = useMemo(() => (v: number) => `${sig(v, 4)}${unit ? ` ${unit}` : ''}`, [unit]);
  const formatY = useMemo(
    () => (v: number) => `${fixed(v, 2)}${info.unit === '%' ? '%' : ` ${info.unit}`}`,
    [info],
  );
  const current = lines[0]?.run.points.filter((p) => p.ok) ?? [];
  const values = current
    .map((p) => (p.ok ? info.value(p.summary) : null))
    .filter((v): v is number => v !== null);
  return (
    <figure className="chart chart-small" data-chart={`sweep-${output}`}>
      <figcaption>
        {info.label} ({info.unit})<HelpButton term={sweepTerm(output)} label={info.label} />
      </figcaption>
      <LineChart
        data={data}
        series={series}
        xLabel={unit ? `${label} (${unit})` : label}
        yLabel={info.unit}
        formatX={formatX}
        formatY={formatY}
        formatTick={formatTick}
        height={170}
        syncKey="sweep-x"
        summary={`${info.label} against ${label.toLowerCase()}: ${values.length} points${
          values.length > 0
            ? `, from ${formatY(Math.min(...values))} to ${formatY(Math.max(...values))}`
            : ''
        }.`}
      />
    </figure>
  );
}

function TargetPicker({
  targets,
  value,
  onChange,
}: {
  targets: readonly SweepTarget[];
  value: string;
  onChange: (target: SweepTarget) => void;
}) {
  const recipeTargets = targets.filter((t) => t.group === 'recipe');
  const registryTargets = targets.filter((t) => t.group === 'registry');
  const isRegistry = value.startsWith('override:');
  const [query, setQuery] = useState('');
  const matches = registryTargets
    .filter((t) => !query || t.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 60);
  return (
    <>
      <div className="field">
        <div className="field-head">
          <label htmlFor="sweep-target">Vary</label>
          <HelpButton
            term={value.startsWith('override:') ? value.replace('override:', 'overrides.') : value}
            label="Parameter to vary"
          />
        </div>
        <select
          id="sweep-target"
          value={isRegistry ? '__registry__' : value}
          onChange={(e) => {
            const id = e.target.value;
            const target =
              id === '__registry__'
                ? (registryTargets[0] ?? null)
                : (recipeTargets.find((t) => t.id === id) ?? null);
            if (target) onChange(target);
          }}
        >
          {recipeTargets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.unit ? `${t.label} (${t.unit})` : t.label}
            </option>
          ))}
          {registryTargets.length > 0 && (
            <option value="__registry__">A registry parameter…</option>
          )}
        </select>
      </div>
      {isRegistry && (
        <div className="field-grid">
          <div className="field">
            <label htmlFor="sweep-registry-search">Find a parameter</label>
            <input
              id="sweep-registry-search"
              type="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="sweep-registry">Parameter</label>
            <select
              id="sweep-registry"
              value={value}
              onChange={(e) => {
                const target = registryTargets.find((t) => t.id === e.target.value);
                if (target) onChange(target);
              }}
            >
              {!matches.some((t) => t.id === value) && (
                <option value={value}>
                  {registryTargets.find((t) => t.id === value)?.label ?? value}
                </option>
              )}
              {matches.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </>
  );
}

export function SweepPanel({ validation, catalog }: { validation: FormResult; catalog: Catalog }) {
  const config = useShotStore((s) => s.sweepConfig);
  const patch = useShotStore((s) => s.patchSweepConfig);
  const sweep = useShotStore((s) => s.sweep);
  const pinned = useShotStore((s) => s.pinnedSweeps);
  const pinSweep = useShotStore((s) => s.pinSweep);
  const unpinSweep = useShotStore((s) => s.unpinSweep);
  const { start, cancel } = useSweep();
  const recipe = validation.ok ? validation.recipe : null;
  const targets = useMemo(() => (recipe ? sweepTargets(recipe, catalog) : []), [recipe, catalog]);
  const target = targets.find((t) => t.id === config.targetId) ?? targets[0];
  const effective = {
    ...config,
    targetId: target?.id ?? config.targetId,
    from: config.from || (target ? String(target.defaultRange[0]) : ''),
    to: config.to || (target ? String(target.defaultRange[1]) : ''),
  };
  const plan = recipe ? planSweep(recipe, catalog, effective, targets) : null;
  const errors = plan && !plan.ok ? plan.errors : {};
  const running = sweep.status === 'running';
  const run = sweep.run;
  const done = run?.points.length ?? 0;
  const total = run?.values.length ?? 0;
  const failed = run?.points.filter((p) => !p.ok) ?? [];
  const stale = run !== null && recipe !== null && run.baseKey !== physicalKey(recipe);
  const canPin =
    run !== null &&
    run.points.length > 0 &&
    !running &&
    pinned.length < MAX_PINS &&
    !pinned.some((p) => p.run === run);

  const lines: SweepLine[] = useMemo(() => {
    if (!run) return [];
    return [
      { label: `Sweep ${run.seq}`, slot: 0, run },
      ...pinned
        .filter((p) => p.run.targetId === run.targetId && p.run !== run)
        .map((p) => ({ label: p.label, slot: p.slot, run: p.run })),
    ];
  }, [run, pinned]);

  return (
    <div className="panel-stack sweep-panel">
      <form
        className="sweep-form"
        aria-label="Sweep settings"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (plan?.ok && validation.ok) start(plan.plan, validation);
        }}
      >
        {targets.length > 0 && target ? (
          <TargetPicker
            targets={targets}
            value={target.id}
            onChange={(t) => patch({ targetId: t.id, from: '', to: '' })}
          />
        ) : (
          <p className="note">Fix the recipe’s inputs to choose what to sweep.</p>
        )}
        {target && (
          <p className="note">
            Now {target.current !== null ? sig(target.current, 4) : 'unset'}
            {target.unit ? ` ${target.unit}` : ''}; default range {sig(target.defaultRange[0], 4)}–
            {sig(target.defaultRange[1], 4)}.
          </p>
        )}
        <div className="field-grid">
          {(['from', 'to', 'points'] as const).map((key) => (
            <div className="field" key={key}>
              <label htmlFor={`sweep-${key}`}>
                {key === 'from' ? 'From' : key === 'to' ? 'To' : `Points (2–${MAX_SWEEP_POINTS})`}
                {key !== 'points' && target?.unit ? ` (${target.unit})` : ''}
              </label>
              <HelpButton
                term="sweep"
                label={key === 'points' ? 'Number of sweep points' : `Sweep ${key}`}
              />
              <input
                id={`sweep-${key}`}
                type="text"
                inputMode={key === 'points' ? 'numeric' : 'decimal'}
                autoComplete="off"
                value={config[key]}
                placeholder={effective[key]}
                aria-invalid={errors[key] ? true : undefined}
                aria-describedby={errors[key] ? `sweep-${key}-error` : undefined}
                onChange={(e) => patch({ [key]: e.target.value })}
              />
              {errors[key] && (
                <p className="field-error" id={`sweep-${key}-error`}>
                  {errors[key]}
                </p>
              )}
            </div>
          ))}
          <div className="field">
            <div className="field-head">
              <label htmlFor="sweep-tier">Calculation mode</label>
              <HelpButton term="numerical" label="Sweep calculation mode" />
            </div>
            <select
              id="sweep-tier"
              value={config.tier}
              onChange={(e) => patch({ tier: e.target.value === '1' ? '1' : '0' })}
            >
              <option value="0">Fast preview</option>
              <option value="1">Standard (slower)</option>
            </select>
          </div>
        </div>
        <fieldset className="checkbox-group">
          <legend>Plot</legend>
          <div className="radio-options">
            {SWEEP_OUTPUTS.map((o) => (
              <div className="field-head" key={o.id}>
                <label className="radio-option">
                  <input
                    type="checkbox"
                    checked={config.outputs.includes(o.id)}
                    onChange={(e) =>
                      patch({
                        outputs: e.target.checked
                          ? SWEEP_OUTPUTS.map((x) => x.id).filter(
                              (id) => id === o.id || config.outputs.includes(id),
                            )
                          : config.outputs.filter((id) => id !== o.id),
                      })
                    }
                  />
                  {o.label}
                </label>
                <HelpButton term={sweepTerm(o.id)} label={o.label} />
              </div>
            ))}
          </div>
        </fieldset>
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={!plan?.ok || !validation.ok}
          >
            Run sweep
          </button>
          <button
            type="button"
            className="button"
            aria-disabled={running ? undefined : true}
            onClick={() => {
              if (running) cancel();
            }}
          >
            Cancel sweep
          </button>
          <button
            id="sweep-pin"
            type="button"
            className="button"
            aria-disabled={canPin ? undefined : true}
            onClick={() => {
              if (canPin) pinSweep();
            }}
          >
            Pin sweep
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={!run || run.points.length === 0}
            onClick={() => {
              if (run) downloadCsv(datedName('sweep', 'csv'), sweepCsv(run));
            }}
          >
            Export sweep CSV
          </button>
        </div>
        {plan?.ok && (
          <p className="note">
            {plan.plan.values.length} runs at tier {plan.plan.tier}
            {plan.plan.tier === 1 ? '; tier 1 takes up to about a second per point' : ''}.
          </p>
        )}
      </form>
      {run && (
        <div className="sweep-progress">
          <label htmlFor="sweep-progress">
            {running ? 'Running' : sweep.status === 'cancelled' ? 'Cancelled' : 'Finished'}: {done}{' '}
            of {total} points
          </label>
          <progress id="sweep-progress" max={total} value={done} />
        </div>
      )}
      <p className="visually-hidden" role="status">
        {sweep.announcement}
      </p>
      {sweep.status === 'error' && sweep.error && (
        <div className="run-error" role="alert">
          <p>The sweep stopped: {sweep.error}</p>
          {sweep.errorDetail && (
            <details className="panic-details">
              <summary>Technical details for a bug report</summary>
              <pre tabIndex={0}>{sweep.errorDetail}</pre>
            </details>
          )}
        </div>
      )}
      {stale && <p className="stale-badge">Sweep of earlier inputs</p>}
      {failed.length > 0 && (
        <div className="build-notes">
          <p className="build-notes-title">
            {failed.length} point{failed.length === 1 ? '' : 's'} could not be simulated:
          </p>
          <ul>
            {failed.slice(0, 5).map((p) => (
              <li key={p.x}>
                {sig(p.x, 4)}
                {run?.unit ? ` ${run.unit}` : ''}: {p.ok ? '' : p.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      {run && run.points.length > 0 && (
        <div className="chart-grid" data-stale={stale ? 'true' : undefined}>
          {config.outputs.map((o) => (
            <OutputChart key={o} output={o} lines={lines} unit={run.unit} label={run.label} />
          ))}
        </div>
      )}
      {run && run.points.length > 0 && (
        <details className="table-view">
          <summary>Table view ({run.points.length} points)</summary>
          <div className="table-wrap">
            <table>
              <caption>
                {run.label}
                {run.unit ? ` (${run.unit})` : ''}, tier {run.tier}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{run.unit ? `${run.label} (${run.unit})` : run.label}</th>
                  {SWEEP_OUTPUTS.map((o) => (
                    <th scope="col" key={o.id}>
                      {o.label} ({o.unit})<HelpButton term={sweepTerm(o.id)} label={o.label} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.points.map((p) => (
                  <tr key={p.x}>
                    <th scope="row">{sig(p.x, 5)}</th>
                    {SWEEP_OUTPUTS.map((o) => (
                      <td key={o.id}>{p.ok ? fixed(o.value(p.summary), 2) : '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {pinned.length > 0 && (
        <div className="pins">
          <h4 className="subheading">
            Pinned sweeps ({pinned.length}/{MAX_PINS})
          </h4>
          <ul className="pin-list">
            {pinned.map((p, i) => (
              <li key={p.id}>
                <span className={`swatch swatch-${p.slot}`} aria-hidden="true" />
                {p.label}: {p.run.label}
                {p.run.unit ? ` (${p.run.unit})` : ''}, {p.run.points.length} points
                {run && p.run.targetId !== run.targetId ? ' (varies another input: not drawn)' : ''}
                <button
                  id={`sweep-unpin-${p.id}`}
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => {
                    const next = pinned[i + 1] ?? pinned[i - 1];
                    unpinSweep(p.id);
                    focusSoon(next ? [`sweep-unpin-${next.id}`, 'sweep-pin'] : 'sweep-pin');
                  }}
                  aria-label={`Unpin ${p.label}`}
                >
                  Unpin
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
