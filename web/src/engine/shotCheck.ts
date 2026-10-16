// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Checks a ShotResult document against the contract's shape
 * (docs/model/m1-contract.md, crates/puckcore/src/shot/result.rs): every
 * field the app reads is present with the right type, every number is finite,
 * the time series are as long as `t_s`, and snapshot arrays are
 * [column][depth cell]. Unknown fields are allowed (output documents may gain
 * fields). Returns the problems found; an empty list means the shape is right.
 */

import { HYDRAULIC_VOLUME_FIELDS } from './shotTypes';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkShotResult(result: unknown): string[] {
  const problems: string[] = [];
  const fail = (path: string, why: string) => {
    if (problems.length < 50) problems.push(`${path}: ${why}`);
  };
  const finite = (path: string, value: unknown, { nullable = false } = {}) => {
    if (nullable && value === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  };
  const numbers = (path: string, value: unknown, length?: number) => {
    if (!Array.isArray(value)) return fail(path, 'must be an array of numbers');
    if (length !== undefined && value.length !== length) {
      fail(path, `has ${value.length} values, expected ${length}`);
    }
    const bad = value.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v));
    if (bad >= 0) fail(`${path}[${bad}]`, 'must be a finite number');
  };

  if (!isRecord(result)) return ['result: must be an object'];
  if (result.schema !== 'puckworks.shot-result/1')
    fail('schema', 'must be "puckworks.shot-result/1"');
  if (typeof result.core_version !== 'string') fail('core_version', 'must be a string');

  const summary = result.summary;
  if (!isRecord(summary)) fail('summary', 'must be an object');
  else {
    if (typeof summary.stop_reason !== 'string') fail('summary.stop_reason', 'must be a string');
    for (const key of [
      'shot_time_s',
      'beverage_mass_kg',
      'tds',
      'ey',
      'max_pressure_pa',
      'bed_height_m',
      'headspace_m3',
    ]) {
      finite(`summary.${key}`, summary[key]);
    }
    finite('summary.first_drops_s', summary.first_drops_s, { nullable: true });
    if (!Array.isArray(summary.species)) fail('summary.species', 'must be an array');
    else {
      summary.species.forEach((s: unknown, i) => {
        if (!isRecord(s) || typeof s.id !== 'string')
          return fail(`summary.species[${i}]`, 'needs an id');
        finite(`summary.species[${i}].mass_kg`, s.mass_kg);
        finite(`summary.species[${i}].extracted_fraction`, s.extracted_fraction);
      });
    }
    const u = summary.uniformity;
    if (!isRecord(u)) fail('summary.uniformity', 'must be an object');
    else
      for (const key of ['ey_std', 'ey_min', 'ey_max']) finite(`summary.uniformity.${key}`, u[key]);
  }

  const series = result.series;
  if (!isRecord(series)) fail('series', 'must be an object');
  else {
    numbers('series.t_s', series.t_s);
    const n = Array.isArray(series.t_s) ? series.t_s.length : 0;
    if (n === 0) fail('series.t_s', 'must not be empty');
    for (const key of [
      'pressure_pa',
      'flow_in_m3_s',
      'flow_out_m3_s',
      'beverage_mass_kg',
      'tds_cup',
      'tds_outlet',
      'ey',
      'outlet_temp_c',
    ]) {
      numbers(`series.${key}`, series[key], n);
    }
    for (const key of ['wetted_fraction', ...HYDRAULIC_VOLUME_FIELDS]) {
      if (series[key] !== undefined) numbers(`series.${key}`, series[key], n);
    }
    if (!Array.isArray(series.species_cup_kg)) fail('series.species_cup_kg', 'must be an array');
    else {
      series.species_cup_kg.forEach((s: unknown, i) => {
        if (!isRecord(s) || typeof s.id !== 'string') {
          return fail(`series.species_cup_kg[${i}]`, 'needs an id');
        }
        numbers(`series.species_cup_kg[${i}].values`, s.values, n);
      });
    }
    if (Array.isArray(series.t_s)) {
      const t = series.t_s as number[];
      const back = t.findIndex((v, i) => i > 0 && !(v >= t[i - 1]));
      if (back > 0) fail(`series.t_s[${back}]`, 'times must not decrease');
    }
  }

  const spatial = result.spatial;
  if (!isRecord(spatial)) fail('spatial', 'must be an object');
  else {
    numbers('spatial.depth_m', spatial.depth_m);
    const cells = Array.isArray(spatial.depth_m) ? spatial.depth_m.length : 0;
    const columns = Array.isArray(spatial.columns) ? spatial.columns : [];
    if (!Array.isArray(spatial.columns)) fail('spatial.columns', 'must be an array');
    columns.forEach((c: unknown, i) => {
      if (!isRecord(c)) return fail(`spatial.columns[${i}]`, 'must be an object');
      for (const key of [
        'inner_radius_m',
        'outer_radius_m',
        'area_fraction',
        'permeability_multiplier',
      ]) {
        finite(`spatial.columns[${i}].${key}`, c[key]);
      }
    });
    if (!Array.isArray(spatial.snapshots)) fail('spatial.snapshots', 'must be an array');
    else {
      spatial.snapshots.forEach((s: unknown, k) => {
        if (!isRecord(s)) return fail(`spatial.snapshots[${k}]`, 'must be an object');
        finite(`spatial.snapshots[${k}].t_s`, s.t_s);
        for (const field of ['local_ey', 'liquid_conc_kg_m3', 'wetted_fraction']) {
          // wetted_fraction comes from newer cores only.
          if (field === 'wetted_fraction' && s[field] === undefined) continue;
          const grid = s[field];
          if (!Array.isArray(grid) || grid.length !== columns.length) {
            fail(
              `spatial.snapshots[${k}].${field}`,
              `must have one row per column (${columns.length})`,
            );
            continue;
          }
          grid.forEach((row: unknown, j) =>
            numbers(`spatial.snapshots[${k}].${field}[${j}]`, row, cells),
          );
        }
      });
    }
    if (spatial.depth_edges_m !== undefined) {
      numbers('spatial.depth_edges_m', spatial.depth_edges_m, cells + 1);
    }
    if (!Array.isArray(spatial.class_ey)) fail('spatial.class_ey', 'must be an array');
    else {
      spatial.class_ey.forEach((c: unknown, i) => {
        if (!isRecord(c)) return fail(`spatial.class_ey[${i}]`, 'must be an object');
        finite(`spatial.class_ey[${i}].radius_m`, c.radius_m);
        finite(`spatial.class_ey[${i}].ey`, c.ey);
      });
    }
  }

  const d = result.diagnostics;
  if (!isRecord(d)) fail('diagnostics', 'must be an object');
  else {
    finite('diagnostics.mass_balance_error', d.mass_balance_error);
    if (d.outflow_integral_error !== undefined) {
      finite('diagnostics.outflow_integral_error', d.outflow_integral_error);
    }
    if (d.hydraulic_volume_balance_error !== undefined) {
      finite('diagnostics.hydraulic_volume_balance_error', d.hydraulic_volume_balance_error);
    }
    finite('diagnostics.steps', d.steps);
    if (!Array.isArray(d.warnings) || d.warnings.some((w) => typeof w !== 'string')) {
      fail('diagnostics.warnings', 'must be an array of strings');
    }
  }
  return problems;
}
