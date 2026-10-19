// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { mapExploreRequest } from './exploreRequest';

function layout(count: number, edge: number, cells = 30) {
  const inner = count - (edge > 0 && count > 1 ? 1 : 0);
  return {
    columns: Array.from({ length: count }, (_, col) => {
      const a = col < inner ? ((1 - edge) * col) / inner : 1 - edge;
      const b = col < inner ? ((1 - edge) * (col + 1)) / inner : 1;
      return { inner_radius_m: Math.sqrt(a) * 0.027, outer_radius_m: Math.sqrt(b) * 0.027 };
    }),
    depthM: Array.from({ length: cells }, (_, cell) => ((cell + 0.5) * 0.012) / cells),
    bedHeightM: 0.012,
    edgeAreaFraction: edge,
  };
}

describe('Explore region mapping', () => {
  it('preserves the outer edge when the four-column preview becomes eight-column Tier 1', () => {
    expect(
      mapExploreRequest({
        resolution: 'standard',
        selected: { col: 3, cell: 4 },
        source: layout(4, 0.25, 8),
        target: { columns: 8, edgeAreaFraction: 0.25 },
      }),
    ).toEqual({ column: 7, cell: 16, resolution: 'standard' });
  });

  it('preserves every same-grid cell and annulus', () => {
    const source = layout(8, 0.25);
    for (let col = 0; col < 8; col++)
      for (let cell = 0; cell < 30; cell++) {
        expect(
          mapExploreRequest({
            resolution: 'standard',
            selected: { col, cell },
            source,
            target: { columns: 8, edgeAreaFraction: 0.25 },
          }),
        ).toEqual({ column: col, cell, resolution: 'standard' });
      }
  });

  it('maps standard and refined depth through actual physical centres', () => {
    expect(
      mapExploreRequest({
        resolution: 'high',
        selected: { col: 0, cell: 15 },
        source: layout(8, 0.25),
        target: { columns: 8, edgeAreaFraction: 0.25 },
      }).cell,
    ).toBe(77);
    expect(
      mapExploreRequest({
        resolution: 'standard',
        selected: { col: 0, cell: 77 },
        source: layout(8, 0.25, 150),
        target: { columns: 8, edgeAreaFraction: 0.25 },
      }).cell,
    ).toBe(15);
    const nonuniform = { ...layout(8, 0.25), depthM: [0.001, 0.009], bedHeightM: 0.012 };
    expect(
      mapExploreRequest({ resolution: 'high', selected: { col: 0, cell: 1 }, source: nonuniform })
        .cell,
    ).toBe(112);
  });

  it('preserves annular area, clamps changed layouts and supports no edge region', () => {
    expect(
      mapExploreRequest({
        resolution: 'standard',
        selected: { col: 1, cell: 0 },
        source: layout(4, 0.25),
        target: { columns: 8, edgeAreaFraction: 0.25 },
      }).column,
    ).toBe(3);
    expect(
      mapExploreRequest({
        resolution: 'standard',
        selected: { col: 1, cell: 0 },
        source: layout(4, 0.25),
        target: { columns: 4, edgeAreaFraction: 0 },
      }).column,
    ).toBe(1);
    expect(
      mapExploreRequest({
        resolution: 'standard',
        selected: { col: 3, cell: 0 },
        source: layout(4, 0.25),
        target: { columns: 4, edgeAreaFraction: 0 },
      }).column,
    ).toBe(3);
    expect(
      mapExploreRequest({
        resolution: 'standard',
        selected: { col: 6, cell: 0 },
        source: layout(8, 0),
        target: { columns: 2, edgeAreaFraction: 0 },
      }).column,
    ).toBe(1);
    expect(
      mapExploreRequest({
        resolution: 'standard',
        selected: { col: 7, cell: 0 },
        source: layout(8, 0.25),
        target: { columns: 1, edgeAreaFraction: 0.5 },
      }).column,
    ).toBe(0);
  });

  it('centres the first request and handles absent or invalid metadata without invalid indices', () => {
    expect(mapExploreRequest({ resolution: 'standard' })).toEqual({
      column: 0,
      cell: 15,
      resolution: 'standard',
    });
    expect(mapExploreRequest({ resolution: 'high', selected: null })).toEqual({
      column: 0,
      cell: 75,
      resolution: 'high',
    });
    const invalid = {
      columns: [{ inner_radius_m: NaN, outer_radius_m: NaN }],
      depthM: [NaN, NaN],
      bedHeightM: NaN,
    };
    expect(
      mapExploreRequest({
        resolution: 'standard',
        source: invalid,
        selected: { col: Infinity, cell: 999 },
        target: { columns: NaN, edgeAreaFraction: NaN },
      }),
    ).toEqual({ column: 0, cell: 22, resolution: 'standard' });
    expect(
      mapExploreRequest({
        resolution: 'high',
        source: { columns: [], depthM: [], bedHeightM: 0 },
        selected: { col: -5, cell: -5 },
        target: { columns: -1, edgeAreaFraction: -1 },
      }),
    ).toEqual({ column: 0, cell: 75, resolution: 'high' });
  });
});
