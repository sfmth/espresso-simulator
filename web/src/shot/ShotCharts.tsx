// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The shot graph: small multiples of pressure, flow, beverage mass, TDS, EY,
 * outlet temperature and wetted bed against time, with a shared crosshair
 * whose live legends read out every run at that time. Pinned runs overlay in
 * their own colours. A table view repeats the current run's values.
 */
import { useMemo } from 'react';
import { LineChart } from '../components/LineChart';
import { HelpButton } from '../help/HelpButton';
import { formatTick } from '../lab/format';
import { fixed } from './format';
import {
  chartHasData,
  chartSummary,
  joinRuns,
  sampleTimes,
  SHOT_CHARTS,
  type ChartRun,
  type ShotChartDef,
} from './shotChartData';

const formatTime = (t: number) => `${fixed(t, 1)} s`;

function ShotChart({ chart, runs }: { chart: ShotChartDef; runs: readonly ChartRun[] }) {
  const { data, series } = useMemo(() => joinRuns(chart, runs), [chart, runs]);
  return (
    <figure className="chart chart-small" data-chart={chart.id}>
      <figcaption>
        {chart.title} ({chart.unit})
        <HelpButton term={`output.chart.${chart.id}`} label={`${chart.title} chart`} />
      </figcaption>
      <LineChart
        data={data}
        series={series}
        xLabel="Time (s)"
        yLabel={chart.unit}
        yFromZero={chart.yFromZero}
        formatX={formatTime}
        formatY={chart.formatY}
        formatTick={formatTick}
        summary={chartSummary(chart, runs)}
        height={170}
        syncKey="shot-time"
      />
    </figure>
  );
}

function SeriesTable({ run }: { run: ChartRun }) {
  const t = run.result.series.t_s;
  const rows = useMemo(() => sampleTimes(t), [t]);
  const charts = SHOT_CHARTS.filter((c) => chartHasData(c, [run]));
  const columns = charts.flatMap((c) =>
    c.quantities
      .map((q) => ({
        chart: c,
        q,
        values: (run.result.series as unknown as Record<string, unknown>)[q.field],
      }))
      .filter(
        (col): col is typeof col & { values: Float64Array } => col.values instanceof Float64Array,
      ),
  );
  return (
    <details className="table-view">
      <summary>Table view ({rows.length} sampled times)</summary>
      <div className="table-wrap">
        <table>
          <caption>{run.label}: values at evenly spaced times</caption>
          <thead>
            <tr>
              <th scope="col">
                Time (s)
                <HelpButton term="output.chart.time" />
              </th>
              {columns.map(({ chart, q }) => (
                <th scope="col" key={`${chart.id}-${q.field}`}>
                  {chart.quantities.length > 1 ? `${chart.title}, ${q.label}` : chart.title} (
                  {chart.unit})
                  <HelpButton
                    term={`output.chart.${chart.id}`}
                    label={chart.quantities.length > 1 ? `${chart.title}, ${q.label}` : chart.title}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i}>
                <th scope="row">{fixed(t[i], 1)}</th>
                {columns.map(({ chart, q, values }) => (
                  <td key={`${chart.id}-${q.field}`}>{chart.formatY(values[i] * q.factor)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ShotCharts({ runs }: { runs: readonly ChartRun[] }) {
  const charts = SHOT_CHARTS.filter((c) => chartHasData(c, runs));
  if (runs.length === 0) return null;
  return (
    <>
      <div className="chart-grid">
        {charts.map((chart) => (
          <ShotChart key={chart.id} chart={chart} runs={runs} />
        ))}
      </div>
      <SeriesTable run={runs[0]} />
    </>
  );
}
