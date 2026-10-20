// SPDX-License-Identifier: GPL-2.0-or-later
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { rampColor, useChartTheme } from '../components/chartTheme';
import { BasketOutline, basketFrame } from '../shot/BasketDiagram';
import { wallBetween, wallFromSpec } from '../shot/basketGeometry';
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

type DepthView = 'overview' | 'detail';

function initialView(outcome: ShotOutcome) {
  const refined = outcome.result.spatial.depth_m.length > 30;
  return {
    seq: outcome.seq,
    depthView: refined ? ('detail' as const) : ('overview' as const),
    boundaries: refined,
  };
}

export function ExploreSection({
  outcome,
  snapshotIndex,
  selected,
  onSelect,
  playing = false,
}: {
  outcome: ShotOutcome;
  snapshotIndex: number;
  selected: ExploreCell | null;
  onSelect: (cell: ExploreCell) => void;
  playing?: boolean;
}) {
  const theme = useChartTheme();
  const [field, setField] = useState<SectionField>('local_ey');
  const readoutId = useId();
  const instructionsId = useId();
  const [view, setView] = useState(() => initialView(outcome));
  const currentView = view.seq === outcome.seq ? view : initialView(outcome);
  if (currentView !== view) setView(currentView);
  const { depthView, boundaries } = currentView;
  const viewportRef = useRef<HTMLDivElement>(null);
  const selectedCellRef = useRef<SVGGElement>(null);
  const spatial = outcome.result.spatial;
  const snapshot = spatial.snapshots[snapshotIndex];
  const bedHeightMm = outcome.result.summary.bed_height_m * 1000;
  const wall = useMemo(() => wallFromSpec(outcome.build.spec.basket.profile_m), [outcome]);
  const bands = useMemo(() => columnBands(spatial.columns), [spatial]);
  const bounds = useMemo(
    () =>
      depthBoundaries(spatial.depth_m, outcome.result.summary.bed_height_m, spatial.depth_edges_m),
    [spatial, outcome],
  );
  const visibleWall = useMemo(
    () => (depthView === 'detail' ? wallBetween(wall, 0, bedHeightMm) : wall),
    [wall, depthView, bedHeightMm],
  );
  const frame = useMemo(() => {
    // Detail uses one SVG y unit per CSS pixel, independent of the panel width.
    // Keep every stored row at least four pixels tall, including uneven grids.
    const minDepthMm = bounds.reduce(
      (min, edge, i) => (i > 0 && edge > bounds[i - 1] ? Math.min(min, edge - bounds[i - 1]) : min),
      Infinity,
    );
    const scale = depthView === 'detail' ? Math.max(2, 4 / minDepthMm) : 2;
    return basketFrame(visibleWall, scale);
  }, [visibleWall, depthView, bounds]);
  const cells = useMemo(
    () => cellPolygons(wall, frame, bands, bounds, bedHeightMm),
    [wall, frame, bands, bounds, bedHeightMm],
  );
  const [lo, hi] = useMemo(() => fieldRange(spatial.snapshots, field) ?? [0, 1], [spatial, field]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (depthView === 'overview') {
      viewport.scrollTop = 0;
      return;
    }
    const cell = selectedCellRef.current;
    if (!cell) return;
    const viewportRect = viewport.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const margin = 4;
    if (cellRect.top < viewportRect.top + margin) {
      viewport.scrollTop += cellRect.top - viewportRect.top - margin;
    } else if (cellRect.bottom > viewportRect.bottom - margin) {
      viewport.scrollTop += cellRect.bottom - viewportRect.bottom + margin;
    }
  }, [selected?.col, selected?.cell, depthView, outcome.seq, frame.height]);
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
      <div className="explore-controls">
        <label>
          Depth view
          <select
            aria-label="Depth view"
            value={depthView}
            onChange={(e) => setView({ ...currentView, depthView: e.target.value as DepthView })}
          >
            <option value="overview">Overview</option>
            <option value="detail">Cell detail</option>
          </select>
        </label>
        <label className="explore-checkbox">
          <input
            type="checkbox"
            checked={boundaries}
            onChange={(e) => setView({ ...currentView, boundaries: e.target.checked })}
          />
          Cell boundaries
        </label>
      </div>
      <p className="note explore-section-grid-size">
        Showing {spatial.columns.length} columns × {spatial.depth_m.length} depth cells.
      </p>
      <div
        ref={viewportRef}
        className={`explore-section-viewport${depthView === 'detail' ? ' cell-detail' : ''}`}
      >
        <svg
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          height={depthView === 'detail' ? Math.ceil(frame.height) : undefined}
          preserveAspectRatio={depthView === 'detail' ? 'none' : 'xMidYMid meet'}
          className={`explore-section-svg${boundaries ? ' show-cell-boundaries' : ''}`}
          role="img"
          aria-label={`Puck cross-section: ${field === 'local_ey' ? 'local extraction yield' : 'liquid solubles'}, ${spatial.columns.length} columns and ${spatial.depth_m.length} depth cells.`}
          aria-describedby={`${instructionsId} ${readoutId}`}
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
                data-col={cell.col}
                data-cell={cell.cell}
                ref={chosen ? selectedCellRef : undefined}
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
            wall={visibleWall}
            frame={frame}
            perforatedRadiusMm={outcome.build.spec.basket.perforated_radius_m * 1000}
          />
        </svg>
      </div>
      <p id={instructionsId} className="note">
        Focus the diagram and use arrow keys to inspect cells, or use the Column and Depth cell
        controls below.
      </p>
      <p className="note">
        Scale {lo.toFixed(1)}–{hi.toFixed(1)} {field === 'local_ey' ? '%' : 'kg/m³'}, fixed over
        time. Grey = dry.{' '}
        {depthView === 'detail'
          ? 'Cell detail shows the coffee bed only, with depth expanded to show every stored cell. Scroll to inspect the full bed.'
          : 'Overview shows the full basket. Height ×2.'}{' '}
        Permeability strata share annuli; their side-by-side order is a drawing choice.
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
        </>
      )}
      <p id={readoutId} aria-live={playing ? 'off' : 'polite'} aria-atomic="true">
        {selected ? (
          <>
            Selected: column {selected.col + 1}, depth {bounds[selected.cell]?.toFixed(2)}–
            {bounds[selected.cell + 1]?.toFixed(2)} mm below the top.{' '}
            {field === 'local_ey' ? 'Local EY' : 'Liquid solubles'}{' '}
            {cellValue(snapshot, field, selected.col, selected.cell)?.toFixed(2) ?? 'unavailable'}{' '}
            {field === 'local_ey' ? '%' : 'kg/m³'}; wetted{' '}
            {(cellWetted(snapshot, selected.col, selected.cell) * 100).toFixed(0)}%.
          </>
        ) : (
          'Select a cell to read its values.'
        )}
      </p>
    </section>
  );
}
