// SPDX-License-Identifier: GPL-2.0-or-later
import { useMemo, useState, type KeyboardEvent } from 'react';
import { rampColor, useChartTheme } from '../components/chartTheme';
import { BasketOutline, basketFrame } from '../shot/BasketDiagram';
import { wallFromSpec } from '../shot/basketGeometry';
import {
  cellPolygons,
  cellValue,
  cellWetted,
  columnBands,
  depthBoundaries,
  fieldRange,
  scalePosition,
  type SectionField,
} from '../shot/crossSection';
import type { ShotOutcome } from '../shot/shotStore';
import type { ExploreCell } from './useExploreState';

export function ExploreSection({
  outcome,
  snapshotIndex,
  selected,
  onSelect,
}: {
  outcome: ShotOutcome;
  snapshotIndex: number;
  selected: ExploreCell | null;
  onSelect: (cell: ExploreCell) => void;
}) {
  const theme = useChartTheme();
  const [field, setField] = useState<SectionField>('local_ey');
  const spatial = outcome.result.spatial;
  const snapshot = spatial.snapshots[snapshotIndex];
  const wall = useMemo(() => wallFromSpec(outcome.build.spec.basket.profile_m), [outcome]);
  const frame = useMemo(() => basketFrame(wall, 2), [wall]);
  const bands = useMemo(() => columnBands(spatial.columns), [spatial]);
  const bounds = useMemo(
    () =>
      depthBoundaries(spatial.depth_m, outcome.result.summary.bed_height_m, spatial.depth_edges_m),
    [spatial, outcome],
  );
  const cells = useMemo(
    () => cellPolygons(wall, frame, bands, bounds, outcome.result.summary.bed_height_m * 1000),
    [wall, frame, bands, bounds, outcome],
  );
  const [lo, hi] = useMemo(() => fieldRange(spatial.snapshots, field) ?? [0, 1], [spatial, field]);
  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const current = selected ?? { col: 0, cell: 0 };
    let { col, cell } = current;
    if (event.key === 'ArrowLeft') col = Math.max(0, col - 1);
    else if (event.key === 'ArrowRight') col = Math.min(bands.length - 1, col + 1);
    else if (event.key === 'ArrowUp') cell = Math.max(0, cell - 1);
    else if (event.key === 'ArrowDown') cell = Math.min(spatial.depth_m.length - 1, cell + 1);
    else return;
    event.preventDefault();
    onSelect({ col, cell });
  };
  return (
    <section className="panel panel-stack explore-section" aria-labelledby="explore-section-title">
      <h3 id="explore-section-title">Puck cross-section</h3>
      <label>
        Cross-section field
        <select value={field} onChange={(e) => setField(e.target.value as SectionField)}>
          <option value="local_ey">Local extraction yield (%)</option>
          <option value="liquid_conc_kg_m3">Liquid solubles (kg/m³)</option>
        </select>
      </label>
      <svg
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        className="explore-section-svg"
        role="img"
        aria-label="Puck cross-section. Click a cell or use arrow keys to change the selected column and depth."
        tabIndex={0}
        onKeyDown={keyDown}
      >
        {cells.map((cell) => {
          const value = cellValue(snapshot, field, cell.col, cell.cell);
          const wet = cellWetted(snapshot, cell.col, cell.cell);
          const chosen = selected?.col === cell.col && selected.cell === cell.cell;
          return (
            <g
              key={`${cell.col}-${cell.cell}`}
              onClick={() => onSelect({ col: cell.col, cell: cell.cell })}
            >
              <title>{`Column ${cell.col + 1}, depth cell ${cell.cell + 1}: ${value?.toFixed(2) ?? 'unavailable'} ${field === 'local_ey' ? '%' : 'kg/m³'}, ${(wet * 100).toFixed(0)}% wetted`}</title>
              {[cell.left, cell.right].map((points, i) => (
                <polygon
                  key={i}
                  points={points}
                  fill={
                    wet === 0
                      ? 'var(--dry)'
                      : rampColor(theme.ramp, scalePosition(value ?? lo, lo, hi))
                  }
                  className={chosen ? 'explore-cell selected' : 'explore-cell'}
                />
              ))}
            </g>
          );
        })}
        <BasketOutline
          wall={wall}
          frame={frame}
          perforatedRadiusMm={outcome.build.spec.basket.perforated_radius_m * 1000}
        />
      </svg>
      <p className="note">
        Scale {lo.toFixed(1)}–{hi.toFixed(1)} {field === 'local_ey' ? '%' : 'kg/m³'}, fixed over
        time. Grey = dry. Height ×2. Permeability strata share annuli; their side-by-side order is a
        drawing choice.
      </p>
      {selected && (
        <>
          <div className="explore-controls">
            <label>
              Column
              <select
                aria-label="Column"
                value={selected.col}
                onChange={(e) => onSelect({ ...selected, col: Number(e.target.value) })}
              >
                {spatial.columns.map((_, i) => (
                  <option key={i} value={i}>
                    {i + 1} · permeability ×{spatial.columns[i].permeability_multiplier.toFixed(2)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Depth cell
              <input
                type="number"
                min={1}
                max={spatial.depth_m.length}
                value={selected.cell + 1}
                onChange={(e) => onSelect({ ...selected, cell: Number(e.target.value) - 1 })}
              />
            </label>
          </div>
          <p>
            Selected: column {selected.col + 1}, depth {bounds[selected.cell]?.toFixed(2)}–
            {bounds[selected.cell + 1]?.toFixed(2)} mm below the top. Local EY{' '}
            {cellValue(snapshot, 'local_ey', selected.col, selected.cell)?.toFixed(2) ?? '—'}%;
            wetted {(cellWetted(snapshot, selected.col, selected.cell) * 100).toFixed(0)}%.
          </p>
        </>
      )}
    </section>
  );
}
