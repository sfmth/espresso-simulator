// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, Snapshot } from '../engine/shotTypes';
import { basketFrame } from './BasketDiagram';
import { wallFromRecipe } from './basketGeometry';
import {
  cellPolygons,
  cellValue,
  cellWetted,
  columnBands,
  depthBoundaries,
  fieldRange,
  frontDepth,
  hasWetting,
  scalePosition,
} from './crossSection';

const column = (inner: number, outer: number, area: number, k = 1): ColumnInfo => ({
  inner_radius_m: inner,
  outer_radius_m: outer,
  area_fraction: area,
  permeability_multiplier: k,
});

describe('cross-section geometry', () => {
  it('puts cell boundaries halfway between centres, ending at the bed height', () => {
    expect(depthBoundaries([0.001, 0.003, 0.005], 0.006)).toEqual([0, 2, 4, 6]);
    // Without a bed height past the last centre, the last cell mirrors the one before.
    expect(depthBoundaries([0.001, 0.003], 0)).toEqual([0, 2, 4]);
    expect(depthBoundaries([], 0.01)).toEqual([]);
  });

  it('uses the solver’s own cell faces when they fit, else halves between centres', () => {
    // Finer cells at the top: the faces are not halfway between the centres.
    expect(depthBoundaries([0.0005, 0.002, 0.005], 0.007, [0, 0.001, 0.003, 0.007])).toEqual([
      0, 1, 3, 7,
    ]);
    // Faces of the wrong length, out of order or not finite are ignored.
    expect(depthBoundaries([0.001, 0.003, 0.005], 0.006, [0, 0.002, 0.006])).toEqual([0, 2, 4, 6]);
    expect(depthBoundaries([0.001, 0.003, 0.005], 0.006, [0, 0.004, 0.002, 0.006])).toEqual([
      0, 2, 4, 6,
    ]);
    expect(depthBoundaries([0.001, 0.003, 0.005], 0.006, [0, 0.002, NaN, 0.006])).toEqual([
      0, 2, 4, 6,
    ]);
  });

  it('reads the wetted share, clamped, and finds the wetting front in each column', () => {
    const zeros = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    const plain: Snapshot = { t_s: 1, local_ey: zeros, liquid_conc_kg_m3: zeros };
    const snapshot: Snapshot = {
      ...plain,
      wetted_fraction: [
        [1, 0.25, 0],
        [1.2, 1, -0.1],
      ],
    };
    expect(hasWetting(snapshot)).toBe(true);
    expect(cellWetted(snapshot, 0, 1)).toBe(0.25);
    expect(cellWetted(snapshot, 1, 0)).toBe(1);
    expect(cellWetted(snapshot, 1, 2)).toBe(0);
    // Without the field (older cores) every cell counts as wet.
    expect(hasWetting(plain)).toBe(false);
    expect(cellWetted(plain, 0, 2)).toBe(1);
    const bounds = [0, 2, 4, 8];
    expect(frontDepth(snapshot, 0, bounds)).toBe(2.5);
    expect(frontDepth(snapshot, 1, bounds)).toBe(4);
    expect(frontDepth(plain, 0, bounds)).toBe(8);
  });

  it('keeps distinct annuli as given, in millimetres', () => {
    expect(columnBands([column(0, 0.01, 0.5), column(0.01, 0.02, 0.5)])).toEqual([
      { inner: 0, outer: 10, stratum: false },
      { inner: 10, outer: 20, stratum: false },
    ]);
  });

  it('splits columns that share an annulus by area, in order of permeability', () => {
    const bands = columnBands([column(0, 0.02, 0.25, 2), column(0, 0.02, 0.75, 0.5)]);
    // The less permeable column comes first (inside), taking 75 % of the area.
    expect(bands[1].inner).toBe(0);
    expect(bands[1].outer).toBeCloseTo(20 * Math.sqrt(0.75), 12);
    expect(bands[0].inner).toBeCloseTo(20 * Math.sqrt(0.75), 12);
    expect(bands[0].outer).toBeCloseTo(20, 12);
    expect(bands.every((b) => b.stratum)).toBe(true);
  });

  it('draws one mirrored quadrilateral per column and depth cell, following a taper', () => {
    const wall = wallFromRecipe([
      [0, 40],
      [20, 60],
    ]);
    const frame = basketFrame(wall);
    const bands = columnBands([column(0, 0.02, 1)]);
    const cells = cellPolygons(wall, frame, bands, [0, 5, 10], 10);
    expect(cells).toHaveLength(2);
    const top = cells[0].right.split(' ').map((p) => p.split(',').map(Number));
    // The top cell spans heights 5–10 mm, where the wall radius is 22.5–25 mm.
    expect(top[1][0] - frame.x(0)).toBeCloseTo(22.5, 2);
    expect(top[2][0] - frame.x(0)).toBeCloseTo(25, 2);
    const mirror = cells[0].left.split(' ').map((p) => p.split(',').map(Number));
    expect(frame.x(0) - mirror[1][0]).toBeCloseTo(22.5, 2);
  });

  it('reads cell values in display units and finds the range over snapshots', () => {
    const snapshots: Snapshot[] = [
      { t_s: 1, local_ey: [[-0.01, 0.1]], liquid_conc_kg_m3: [[50, 60]] },
      { t_s: 2, local_ey: [[0.2, 0.25]], liquid_conc_kg_m3: [[40, 30]] },
    ];
    expect(cellValue(snapshots[0], 'local_ey', 0, 1)).toBe(10);
    expect(cellValue(snapshots[0], 'liquid_conc_kg_m3', 0, 0)).toBe(50);
    expect(cellValue(snapshots[0], 'local_ey', 3, 0)).toBeNull();
    expect(fieldRange(snapshots, 'local_ey')).toEqual([-1, 25]);
    expect(fieldRange([snapshots[1]], 'liquid_conc_kg_m3')).toEqual([30, 40]);
    expect(fieldRange([], 'local_ey')).toBeNull();
  });

  it('maps values onto the colour scale, clamped, with a flat field in the middle', () => {
    expect(scalePosition(5, 0, 10)).toBe(0.5);
    expect(scalePosition(-5, 0, 10)).toBe(0);
    expect(scalePosition(15, 0, 10)).toBe(1);
    expect(scalePosition(3, 3, 3)).toBe(0.5);
  });
});
