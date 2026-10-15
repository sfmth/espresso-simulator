// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Shot series → chart data. The shot graph is a set of small charts, one unit
 * each (never two y scales on one plot), sharing the time axis and the
 * crosshair. Colour identifies the run (slot 0 the current run, slots 1–6
 * pinned runs, kept when others are unpinned); line style tells apart two
 * quantities of one run in the same chart (flow out solid, flow in dashed).
 */
import type uPlot from 'uplot';
import type { ChartSeriesSpec } from '../components/LineChart';
import type { ShotResultData } from '../engine/shotData';
import { fixed } from './format';
import { BAR_PER_PA, G_PER_KG, ML_PER_M3, PERCENT } from './units';

export interface ChartQuantity {
  /** Series field of the result. */
  field: string;
  /** Short name in the legend: "out", "cup". */
  label: string;
  /** SI → display unit. */
  factor: number;
  dash?: number[];
}

export interface ShotChartDef {
  id: string;
  title: string;
  unit: string;
  quantities: readonly ChartQuantity[];
  yFromZero: boolean;
  formatY: (v: number) => string;
}

const DASH = [6, 4];
const fmt = (digits: number, unit: string) => (v: number) =>
  unit === '%' ? `${fixed(v, digits)}%` : `${fixed(v, digits)} ${unit}`;

export const SHOT_CHARTS: readonly ShotChartDef[] = [
  {
    id: 'pressure',
    title: 'Pressure',
    unit: 'bar',
    quantities: [{ field: 'pressure_pa', label: 'pressure', factor: BAR_PER_PA }],
    yFromZero: true,
    formatY: fmt(2, 'bar'),
  },
  {
    id: 'flow',
    title: 'Flow',
    unit: 'mL/s',
    quantities: [
      { field: 'flow_out_m3_s', label: 'out of the basket', factor: ML_PER_M3 },
      { field: 'flow_in_m3_s', label: 'into the headspace', factor: ML_PER_M3, dash: DASH },
    ],
    yFromZero: true,
    formatY: fmt(2, 'mL/s'),
  },
  {
    id: 'beverage',
    title: 'Beverage mass',
    unit: 'g',
    quantities: [{ field: 'beverage_mass_kg', label: 'in the cup', factor: G_PER_KG }],
    yFromZero: true,
    formatY: fmt(1, 'g'),
  },
  {
    id: 'tds',
    title: 'TDS',
    unit: '%',
    quantities: [
      { field: 'tds_cup', label: 'cup', factor: PERCENT },
      { field: 'tds_outlet', label: 'outlet', factor: PERCENT, dash: DASH },
    ],
    yFromZero: true,
    formatY: fmt(1, '%'),
  },
  {
    id: 'ey',
    title: 'Extraction yield',
    unit: '%',
    quantities: [{ field: 'ey', label: 'EY', factor: PERCENT }],
    yFromZero: true,
    formatY: fmt(1, '%'),
  },
  {
    id: 'temperature',
    title: 'Outlet temperature',
    unit: '°C',
    quantities: [{ field: 'outlet_temp_c', label: 'outlet', factor: 1 }],
    yFromZero: false,
    formatY: fmt(1, '°C'),
  },
  {
    id: 'wetted',
    title: 'Wetted bed',
    unit: '%',
    quantities: [{ field: 'wetted_fraction', label: 'wetted', factor: PERCENT }],
    yFromZero: true,
    formatY: fmt(0, '%'),
  },
];

/** One run on the charts. */
export interface ChartRun {
  label: string;
  slot: number;
  result: ShotResultData;
}

function seriesOf(result: ShotResultData, field: string): Float64Array | null {
  const value = (result.series as unknown as Record<string, unknown>)[field];
  const n = result.series.t_s?.length ?? 0;
  return value instanceof Float64Array && value.length === n ? value : null;
}

/** True if any run has data for the chart. */
export function chartHasData(chart: ShotChartDef, runs: readonly ChartRun[]): boolean {
  return runs.some((r) => chart.quantities.some((q) => seriesOf(r.result, q.field) !== null));
}

/**
 * Joins runs on the union of their times. A run has null where another run
 * has a time it lacks; its series span those gaps.
 */
export function joinRuns(
  chart: ShotChartDef,
  runs: readonly ChartRun[],
): { data: uPlot.AlignedData; series: ChartSeriesSpec[] } {
  const all = new Set<number>();
  for (const run of runs) for (const t of run.result.series.t_s ?? []) all.add(t);
  const x = Float64Array.from([...all].sort((a, b) => a - b));
  const position = new Map<number, number>();
  x.forEach((t, i) => position.set(t, i));
  const columns: (number | null)[][] = [];
  const series: ChartSeriesSpec[] = [];
  for (const run of runs) {
    const times = run.result.series.t_s ?? new Float64Array();
    for (const q of chart.quantities) {
      const values = seriesOf(run.result, q.field);
      if (!values) continue;
      const column: (number | null)[] = new Array<number | null>(x.length).fill(null);
      for (let i = 0; i < times.length; i++) {
        const at = position.get(times[i]);
        if (at !== undefined) column[at] = values[i] * q.factor;
      }
      columns.push(column);
      series.push({
        label: chart.quantities.length > 1 ? `${run.label} · ${q.label}` : run.label,
        slot: run.slot,
        dash: q.dash,
        spanGaps: true,
      });
    }
  }
  return { data: [x, ...columns] as uPlot.AlignedData, series };
}

/** Peak of a series (value and time), for text summaries. */
export function peakOf(
  result: ShotResultData,
  field: string,
  factor: number,
): { value: number; t: number } | null {
  const values = seriesOf(result, field);
  const t = result.series.t_s;
  if (!values || values.length === 0 || !t) return null;
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return { value: values[best] * factor, t: t[best] };
}

/** A text alternative for one chart: each run's peak and final value. */
export function chartSummary(chart: ShotChartDef, runs: readonly ChartRun[]): string {
  const parts: string[] = [];
  for (const run of runs) {
    for (const q of chart.quantities) {
      const values = seriesOf(run.result, q.field);
      if (!values || values.length === 0) continue;
      const peak = peakOf(run.result, q.field, q.factor);
      const last = values[values.length - 1] * q.factor;
      const name = chart.quantities.length > 1 ? `${run.label}, ${q.label}` : run.label;
      parts.push(
        `${name}: peak ${chart.formatY(peak?.value ?? last)} at ${fixed(peak?.t ?? 0, 1)} s, ` +
          `final ${chart.formatY(last)}`,
      );
    }
  }
  return `${chart.title} (${chart.unit}) over time. ${parts.join('; ')}.`;
}

/** Indices of `count` evenly spaced times (first and last included). */
export function sampleTimes(t: ArrayLike<number>, count = 11): number[] {
  const n = t.length;
  if (n === 0) return [];
  const first = t[0];
  const last = t[n - 1];
  const picked = new Set<number>();
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = first + ((last - first) * k) / Math.max(1, count - 1);
    while (j < n - 1 && Math.abs(t[j + 1] - target) <= Math.abs(t[j] - target)) j++;
    picked.add(j);
  }
  return [...picked];
}
