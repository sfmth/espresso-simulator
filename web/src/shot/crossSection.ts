// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Geometry of the puck cross-section: the solver's columns (radial annuli,
 * `spatial.columns`, radii given at the floor) and depth cells
 * (`spatial.depth_m`, cell centres below the bed top) drawn on the actual
 * basket profile. An annulus keeps its share of the cross-section at every
 * height, so in a tapered basket its radii scale with the wall:
 * r(z) = r_floor · R(z) / R(0).
 *
 * Columns that share an annulus (permeability strata) are drawn side by side
 * inside it, in proportion to their area and in order of permeability; that
 * order is a drawing choice, not physics, and the view says so.
 */
import type { ColumnInfo, Snapshot } from '../engine/shotTypes';
import { radiusAt, type WallPoint } from './basketGeometry';
import type { Frame } from './BasketDiagram';

export type SectionField = 'local_ey' | 'liquid_conc_kg_m3';

export interface Band {
  /** Inner and outer radius at the floor, mm. */
  inner: number;
  outer: number;
  /** Shares its annulus with other columns (strata). */
  stratum: boolean;
}

/**
 * Cell boundaries in depth below the bed top, mm: K + 1 values from 0 to the
 * bed height. The solver's own faces (`spatial.depth_edges_m`) are used when
 * present and consistent; older results only give centres, so the faces are
 * then put halfway between them.
 */
export function depthBoundaries(
  depthM: readonly number[],
  bedHeightM: number,
  edgesM?: readonly number[],
): number[] {
  if (
    edgesM &&
    edgesM.length === depthM.length + 1 &&
    edgesM.every((e, i) => Number.isFinite(e) && (i === 0 || e > edgesM[i - 1]))
  ) {
    return edgesM.map((e) => e * 1000);
  }
  const d = depthM.map((v) => v * 1000);
  const k = d.length;
  if (k === 0) return [];
  const bounds = [0];
  for (let i = 1; i < k; i++) bounds.push((d[i - 1] + d[i]) / 2);
  const last = bounds[k - 1];
  const extrapolated = 2 * d[k - 1] - last;
  const height = bedHeightM * 1000;
  bounds.push(height > d[k - 1] ? height : extrapolated);
  return bounds;
}

/** The radial band of each column, mm at the floor, with strata split inside their annulus. */
export function columnBands(columns: readonly ColumnInfo[]): Band[] {
  const bands: Band[] = columns.map((c) => ({
    inner: c.inner_radius_m * 1000,
    outer: c.outer_radius_m * 1000,
    stratum: false,
  }));
  const groups = new Map<string, number[]>();
  columns.forEach((c, i) => {
    const key = `${c.inner_radius_m}|${c.outer_radius_m}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort(
      (a, b) => columns[a].permeability_multiplier - columns[b].permeability_multiplier,
    );
    const total = ordered.reduce((s, i) => s + Math.max(columns[i].area_fraction, 0), 0);
    const { inner, outer } = bands[ordered[0]];
    let cumulative = 0;
    for (const i of ordered) {
      const share = total > 0 ? Math.max(columns[i].area_fraction, 0) / total : 1 / ordered.length;
      const r0 = Math.sqrt(inner * inner + (outer * outer - inner * inner) * cumulative);
      cumulative = Math.min(1, cumulative + share);
      const r1 = Math.sqrt(inner * inner + (outer * outer - inner * inner) * cumulative);
      bands[i] = { inner: r0, outer: r1, stratum: true };
    }
  }
  return bands;
}

export interface Cell {
  col: number;
  cell: number;
  /** SVG points of the right half and of its mirror image. */
  right: string;
  left: string;
}

function pointsOf(list: [number, number][]): string {
  return list.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ');
}

/** Polygons of every (column, depth cell), on the basket wall, in SVG coordinates. */
export function cellPolygons(
  wall: readonly WallPoint[],
  frame: Frame,
  bands: readonly Band[],
  bounds: readonly number[],
  bedHeightMm: number,
): Cell[] {
  const r0 = wall[0]?.r ?? 1;
  const scale = (z: number) => (r0 > 0 ? radiusAt(wall, z) / r0 : 1);
  const cells: Cell[] = [];
  bands.forEach((band, col) => {
    for (let cell = 0; cell + 1 < bounds.length; cell++) {
      const zTop = Math.max(0, bedHeightMm - bounds[cell]);
      const zBottom = Math.max(0, bedHeightMm - bounds[cell + 1]);
      const sb = scale(zBottom);
      const st = scale(zTop);
      const quad = (sign: number): [number, number][] => [
        [frame.x(sign * band.inner * sb), frame.y(zBottom)],
        [frame.x(sign * band.outer * sb), frame.y(zBottom)],
        [frame.x(sign * band.outer * st), frame.y(zTop)],
        [frame.x(sign * band.inner * st), frame.y(zTop)],
      ];
      cells.push({ col, cell, right: pointsOf(quad(1)), left: pointsOf(quad(-1)) });
    }
  });
  return cells;
}

/** A cell's value in a snapshot, in display units (EY in %), or null if missing. */
export function cellValue(
  snapshot: Snapshot | undefined,
  field: SectionField,
  col: number,
  cell: number,
): number | null {
  const v = snapshot?.[field]?.[col]?.[cell];
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return field === 'local_ey' ? v * 100 : v;
}

/** Wetted share of a cell (0 dry … 1 wet); cells of results without the field count as wet. */
export function cellWetted(snapshot: Snapshot | undefined, col: number, cell: number): number {
  const w = snapshot?.wetted_fraction?.[col]?.[cell];
  return typeof w === 'number' && Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 1;
}

/** True if the snapshot reports wetting at all. */
export function hasWetting(snapshot: Snapshot | undefined): boolean {
  return Array.isArray(snapshot?.wetted_fraction) && snapshot.wetted_fraction.length > 0;
}

/**
 * Depth of the wetting front in a column, mm below the bed top: the wetted
 * thickness, cell by cell from the top (water enters from above).
 */
export function frontDepth(
  snapshot: Snapshot | undefined,
  col: number,
  bounds: readonly number[],
): number {
  let depth = 0;
  for (let cell = 0; cell + 1 < bounds.length; cell++) {
    depth += cellWetted(snapshot, col, cell) * (bounds[cell + 1] - bounds[cell]);
  }
  return depth;
}

/** Smallest and largest value of a field over the given snapshots (display units). */
export function fieldRange(
  snapshots: readonly Snapshot[],
  field: SectionField,
): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of snapshots) {
    for (const column of s[field] ?? []) {
      for (const raw of column) {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        const v = field === 'local_ey' ? raw * 100 : raw;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Position of `value` on a colour scale over [lo, hi], in [0, 1]. */
export function scalePosition(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 0.5;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}
