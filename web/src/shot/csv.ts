// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * CSV export of a shot's time series and of a sweep, in the units the lab
 * shows (s, bar, mL/s, g, %, °C, mg); each column name ends in its unit.
 * Numbers keep their full precision. Series this version does not know (a
 * newer core may add some) are exported too, in SI under their own names.
 */
import { numericSeries, type ShotResultData } from '../engine/shotData';
import type { SweepRun } from './shotStore';
import { SWEEP_OUTPUTS } from './sweep';
import { BAR_PER_PA, G_PER_KG, MG_PER_KG, ML_PER_M3, PERCENT } from './units';

/** Quotes a CSV field when needed (RFC 4180). */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(values: readonly (string | number | null | undefined)[]): string {
  return values.map(csvField).join(',');
}

/** Known series: column name and the factor from SI to the display unit. */
const SERIES_COLUMNS: Record<string, [string, number]> = {
  pressure_pa: ['pressure_bar', BAR_PER_PA],
  flow_in_m3_s: ['flow_in_ml_s', ML_PER_M3],
  flow_out_m3_s: ['flow_out_ml_s', ML_PER_M3],
  beverage_mass_kg: ['beverage_g', G_PER_KG],
  tds_cup: ['tds_cup_pct', PERCENT],
  tds_outlet: ['tds_outlet_pct', PERCENT],
  ey: ['ey_pct', PERCENT],
  outlet_temp_c: ['outlet_temp_c', 1],
  wetted_fraction: ['wetted_pct', PERCENT],
};

/** The time series as CSV: one row per output time. */
export function seriesCsv(result: ShotResultData): string {
  const t = result.series.t_s ?? new Float64Array();
  const columns: [string, ArrayLike<number>, number][] = [];
  const known = numericSeries(result);
  // Known series first, in their usual order, then unknown ones.
  for (const [key, [name, factor]] of Object.entries(SERIES_COLUMNS)) {
    const values = known.find(([k]) => k === key)?.[1];
    if (values) columns.push([name, values, factor]);
  }
  for (const [key, values] of known) {
    if (!(key in SERIES_COLUMNS)) columns.push([key, values, 1]);
  }
  for (const species of result.series.species_cup_kg ?? []) {
    if (species.values instanceof Float64Array && species.values.length === t.length) {
      columns.push([`species_${species.id}_mg`, species.values, MG_PER_KG]);
    }
  }
  const lines = [csvRow(['time_s', ...columns.map(([name]) => name)])];
  for (let i = 0; i < t.length; i++) {
    lines.push(csvRow([t[i], ...columns.map(([, values, factor]) => values[i] * factor)]));
  }
  return `${lines.join('\n')}\n`;
}

const SWEEP_COLUMN_NAMES: Record<string, string> = {
  ey: 'ey_pct',
  tds: 'tds_pct',
  shot_time: 'shot_time_s',
  beverage: 'beverage_g',
  max_pressure: 'max_pressure_bar',
  first_drops: 'first_drops_s',
  ey_std: 'ey_std_points',
};

/** A sweep as CSV: one row per value, every output, and why a point failed. */
export function sweepCsv(run: SweepRun): string {
  const xName = run.unit ? `${run.targetId} (${run.unit})` : run.targetId;
  const header = [
    xName,
    ...SWEEP_OUTPUTS.map((o) => SWEEP_COLUMN_NAMES[o.id] ?? o.id),
    'stop_reason',
    'warnings',
    'error',
  ];
  const lines = [csvRow(header)];
  for (const point of run.points) {
    if (point.ok) {
      lines.push(
        csvRow([
          point.x,
          ...SWEEP_OUTPUTS.map((o) => o.value(point.summary)),
          point.summary.stop_reason,
          point.warnings.join(' | '),
          '',
        ]),
      );
    } else {
      lines.push(csvRow([point.x, ...SWEEP_OUTPUTS.map(() => null), '', '', point.error]));
    }
  }
  return `${lines.join('\n')}\n`;
}
