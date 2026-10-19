// SPDX-License-Identifier: GPL-2.0-or-later
/** Map an inspected representative region onto the next resolved Tier 1 grid. */
import type { ExploreRequest, ExploreResolution } from '../engine/exploreTypes';
import type { ColumnInfo } from '../engine/shotTypes';
import type { ExploreCell } from './useExploreState';

interface SourceLayout {
  columns: readonly Pick<ColumnInfo, 'inner_radius_m' | 'outer_radius_m'>[];
  depthM: readonly number[];
  bedHeightM: number;
  edgeAreaFraction?: number;
}
interface TargetLayout {
  columns: number;
  edgeAreaFraction: number;
}
export interface ExploreRequestMapping {
  resolution: ExploreResolution;
  selected?: ExploreCell | null;
  source?: SourceLayout | null;
  target?: TargetLayout | null;
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const index = (value: number, length: number) =>
  finite(value) ? clamp(Math.round(value), 0, Math.max(0, length - 1)) : 0;

/**
 * Columns occupy annuli, so radius squared is their physical area coordinate.
 * An explicit edge selection remains outermost as the number of strata changes.
 * Depth follows its fractional position in the source bed; no old result values
 * are interpreted as state on the new grid.
 */
export function mapExploreRequest({
  resolution,
  selected,
  source,
  target,
}: ExploreRequestMapping): ExploreRequest {
  const depthCells = resolution === 'high' ? 150 : 30;
  const columns =
    finite(target?.columns) && target.columns >= 1 ? clamp(Math.floor(target.columns), 1, 64) : 8;
  const edge = finite(target?.edgeAreaFraction) ? clamp(target.edgeAreaFraction, 0, 1) : 0;
  let column = 0;
  let depthFraction = 0.5;
  if (selected && source) {
    const sourceColumn = index(selected.col, source.columns.length);
    const sourceCell = index(selected.cell, source.depthM.length);
    const centre = source.depthM[sourceCell];
    if (finite(centre) && finite(source.bedHeightM) && source.bedHeightM > 0) {
      depthFraction = clamp(centre / source.bedHeightM, 0, 1);
    } else if (source.depthM.length > 0) {
      depthFraction = (sourceCell + 0.5) / source.depthM.length;
    }
    const annulus = source.columns[sourceColumn];
    let floorRadius = 0;
    for (const candidate of source.columns) {
      if (finite(candidate.outer_radius_m))
        floorRadius = Math.max(floorRadius, candidate.outer_radius_m);
    }
    const sourceIsEdge =
      source.columns.length > 1 &&
      finite(source.edgeAreaFraction) &&
      source.edgeAreaFraction > 0 &&
      sourceColumn === source.columns.length - 1;
    if (sourceIsEdge) {
      column = columns - 1;
    } else if (
      annulus &&
      finite(annulus.inner_radius_m) &&
      finite(annulus.outer_radius_m) &&
      annulus.inner_radius_m >= 0 &&
      annulus.outer_radius_m >= annulus.inner_radius_m &&
      floorRadius > 0
    ) {
      const area = clamp(
        (annulus.inner_radius_m ** 2 + annulus.outer_radius_m ** 2) / (2 * floorRadius ** 2),
        0,
        1,
      );
      const innerColumns = columns - (edge > 0 && columns > 1 ? 1 : 0);
      if (edge > 0 && columns > 1 && area >= 1 - edge) column = columns - 1;
      else if (1 - edge > 0)
        column = index(Math.floor((area / (1 - edge)) * innerColumns), innerColumns);
    } else {
      column = index(selected.col, columns);
    }
  }
  return {
    column,
    cell: Math.min(depthCells - 1, Math.floor(depthFraction * depthCells)),
    resolution,
  };
}
