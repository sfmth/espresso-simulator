// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The puck cross-section: a heatmap of local extraction yield (or of the
 * solubles concentration in the bed liquid) over the solver's columns and
 * depth cells, drawn on the actual basket shape, mirrored about the axis.
 * A scrubber moves through the snapshots; a colour legend gives the scale.
 * Cells the water has not (fully) reached are hatched, and a dashed line marks
 * the wetting front in each column. Every cell can be inspected with the
 * pointer or, after focusing the figure, with the arrow keys; table views list
 * the values and the wetted shares.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { rampColor, useChartTheme } from '../components/chartTheme';
import { BasketOutline, basketFrame } from './BasketDiagram';
import { wallFromSpec } from './basketGeometry';
import { radiusAt } from './basketGeometry';
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
  type SectionField,
} from './crossSection';
import { fixed, percent, sig } from './format';
import { HelpHeading } from './fields';
import type { ShotOutcome } from './shotStore';

const FIELDS: Record<SectionField, { label: string; unit: string; digits: number }> = {
  local_ey: { label: 'Local extraction yield', unit: '%', digits: 1 },
  liquid_conc_kg_m3: { label: 'Solubles in the bed liquid', unit: 'kg/m³', digits: 0 },
};

/** Local EY counts as negative below this (in %): smaller values are round-off. */
const NEGATIVE_TOLERANCE = 1e-6;

const PLAY_INTERVAL_MS = 700;

function formatValue(value: number | null, field: SectionField): string {
  if (value === null) return '—';
  const { unit, digits } = FIELDS[field];
  return unit === '%' ? `${fixed(value, digits)}%` : `${fixed(value, digits)} ${unit}`;
}

export function CrossSection({ outcome }: { outcome: ShotOutcome }) {
  const theme = useChartTheme();
  const spatial = outcome.result.spatial;
  const snapshots = useMemo(() => spatial.snapshots ?? [], [spatial]);
  const [field, setField] = useState<SectionField>('local_ey');
  const [index, setIndex] = useState(Math.max(0, snapshots.length - 1));
  const [vScale, setVScale] = useState(2);
  // Each snapshot on its own scale by default; one scale for all compares them.
  const [fixedScale, setFixedScale] = useState(false);
  const [selected, setSelected] = useState<{ col: number; cell: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  // A new result (every preview makes one) moves to its last snapshot; the
  // chosen field and scales stay.
  const [shownSeq, setShownSeq] = useState(outcome.seq);
  if (shownSeq !== outcome.seq) {
    setShownSeq(outcome.seq);
    setIndex(Math.max(0, snapshots.length - 1));
    setSelected(null);
    setPlaying(false);
  }

  const wall = useMemo(() => wallFromSpec(outcome.build.spec.basket.profile_m), [outcome]);
  const bedHeightMm = outcome.result.summary.bed_height_m * 1000;
  const bands = useMemo(() => columnBands(spatial.columns ?? []), [spatial]);
  const bounds = useMemo(
    () =>
      depthBoundaries(
        spatial.depth_m ?? [],
        outcome.result.summary.bed_height_m,
        spatial.depth_edges_m,
      ),
    [spatial, outcome],
  );
  const frame = useMemo(() => basketFrame(wall, vScale), [wall, vScale]);
  const cells = useMemo(
    () => cellPolygons(wall, frame, bands, bounds, bedHeightMm),
    [wall, frame, bands, bounds, bedHeightMm],
  );
  const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
  const range = useMemo(
    () => fieldRange(fixedScale ? snapshots : snapshot ? [snapshot] : [], field),
    [snapshots, snapshot, field, fixedScale],
  );

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () => setIndex((i) => Math.min(i + 1, snapshots.length - 1)),
      PLAY_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [playing, snapshots.length]);
  // Playback stops at the last snapshot.
  if (playing && index >= snapshots.length - 1) setPlaying(false);

  if (snapshots.length === 0 || bands.length === 0 || bounds.length < 2) {
    return <p className="note">This result has no spatial snapshots to draw.</p>;
  }

  const [lo, hi] = range ?? [0, 1];
  // The solver keeps local EY at or above zero. Should a result still carry
  // negatives (an older core), fall back to a diverging scale centred on zero,
  // symmetric so small negatives look small.
  const diverging = field === 'local_ey' && lo < -NEGATIVE_TOLERANCE;
  const magnitude = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  const colorOf = (v: number | null) => {
    if (v === null) return 'transparent';
    if (diverging) {
      const t = Math.min(1, Math.max(-1, v / magnitude));
      return rampColor(theme.diverging, (t + 1) / 2);
    }
    return rampColor(theme.ramp, scalePosition(v, lo, hi));
  };
  const legendStops = diverging ? theme.diverging : theme.ramp;
  const legendLo = diverging ? -magnitude : lo;
  const legendHi = diverging ? magnitude : hi;
  const strata = bands.some((b) => b.stratum);
  const hasNegative = diverging;
  const depthCount = bounds.length - 1;
  const wetting = hasWetting(snapshot);
  const fronts = bands.map((_, col) => frontDepth(snapshot, col, bounds));
  const partlyDry = wetting && fronts.some((d) => d < bedHeightMm - 1e-9);

  const describe = (col: number, cell: number) => {
    const band = bands[col];
    const depth0 = bounds[cell];
    const depth1 = bounds[cell + 1];
    return (
      `Column ${col + 1} of ${bands.length} (radius ${fixed(band.inner, 1)}–${fixed(band.outer, 1)} mm at the floor, ` +
      `permeability ×${sig(spatial.columns[col]?.permeability_multiplier, 3)}), ` +
      `depth ${fixed(depth0, 1)}–${fixed(depth1, 1)} mm below the top: ` +
      `${FIELDS[field].label.toLowerCase()} ${formatValue(cellValue(snapshot, field, col, cell), field)}` +
      (wetting ? wettingText(col, cell) : '')
    );
  };
  const wettingText = (col: number, cell: number) => {
    const w = cellWetted(snapshot, col, cell);
    const state = w <= 0 ? 'dry' : w >= 1 ? 'wet' : `${percent(w, 0)} wetted (the front is here)`;
    const front =
      fronts[col] < bedHeightMm - 1e-9
        ? `; in this column the wetting front is ${fixed(fronts[col], 1)} mm below the top`
        : '';
    return `; ${state}${front}`;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const arrows = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
    if (selected === null && arrows.includes(event.key)) {
      // The first arrow press selects the top cell at the axis.
      event.preventDefault();
      setSelected({ col: 0, cell: 0 });
      return;
    }
    let { col, cell } = selected ?? { col: 0, cell: 0 };
    if (event.key === 'ArrowRight') col = Math.min(bands.length - 1, col + 1);
    else if (event.key === 'ArrowLeft') col = Math.max(0, col - 1);
    else if (event.key === 'ArrowDown') cell = Math.min(depthCount - 1, cell + 1);
    else if (event.key === 'ArrowUp') cell = Math.max(0, cell - 1);
    else if (event.key === 'Escape') {
      setSelected(null);
      return;
    } else return;
    event.preventDefault();
    setSelected({ col, cell });
  };

  const stops = legendStops.map((color, i) => (
    <stop
      key={i}
      offset={`${(i / Math.max(1, legendStops.length - 1)) * 100}%`}
      stopColor={color}
    />
  ));
  const gradientId = `section-gradient-${outcome.seq}`;
  const hatchId = `section-hatch-${outcome.seq}`;

  return (
    <div className="panel-stack cross-section">
      <HelpHeading id="section-title" term="local-ey" level={4}>
        Puck cross-section at {fixed(snapshot?.t_s, 1)} s
      </HelpHeading>
      <div className="section-controls">
        <div className="field">
          <label htmlFor="section-field">Show</label>
          <select
            id="section-field"
            value={field}
            onChange={(e) => setField(e.target.value as SectionField)}
          >
            <option value="local_ey">Local extraction yield (%)</option>
            <option value="liquid_conc_kg_m3">Solubles in the bed liquid (kg/m³ of liquid)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="section-stretch">Depth scale</label>
          <select
            id="section-stretch"
            value={vScale}
            onChange={(e) => setVScale(Number(e.target.value))}
          >
            <option value={1}>True proportions</option>
            <option value={2}>Stretched 2×</option>
            <option value={3}>Stretched 3×</option>
          </select>
        </div>
        <div className="field field-check">
          <div className="field-head">
            <input
              id="section-fixed-scale"
              type="checkbox"
              checked={fixedScale}
              onChange={(e) => setFixedScale(e.target.checked)}
            />
            <label htmlFor="section-fixed-scale">Same colour scale for every snapshot</label>
          </div>
        </div>
      </div>
      <div className="section-scrubber">
        <label htmlFor="section-time">Snapshot</label>
        <input
          id="section-time"
          type="range"
          min={0}
          max={snapshots.length - 1}
          step={1}
          value={Math.min(index, snapshots.length - 1)}
          aria-valuetext={`${fixed(snapshot?.t_s, 1)} s, snapshot ${index + 1} of ${snapshots.length}`}
          onChange={(e) => {
            setPlaying(false);
            setIndex(Number(e.target.value));
          }}
        />
        <output htmlFor="section-time">
          t = {fixed(snapshot?.t_s, 1)} s ({index + 1} of {snapshots.length})
        </output>
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            if (!playing && index >= snapshots.length - 1) setIndex(0);
            setPlaying(!playing);
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
      </div>
      <div
        className="section-figure"
        tabIndex={0}
        role="group"
        aria-label="Cross-section cells: use the arrow keys to inspect them"
        onKeyDown={onKeyDown}
      >
        <svg
          className="section-svg"
          viewBox={`0 0 ${frame.width.toFixed(3)} ${frame.height.toFixed(3)}`}
          role="img"
          aria-label={`${FIELDS[field].label} at ${fixed(snapshot?.t_s, 1)} s from ${formatValue(lo, field)} to ${formatValue(hi, field)}, over ${bands.length} columns and ${depthCount} depth cells.`}
          onPointerLeave={() => setSelected(null)}
        >
          <defs>
            {/* Dry cells: a 45° hatch in millimetres of the drawing. */}
            <pattern
              id={hatchId}
              patternUnits="userSpaceOnUse"
              width="1.2"
              height="1.2"
              patternTransform="rotate(45)"
            >
              <line className="section-hatch-line" x1="0" y1="0" x2="0" y2="1.2" />
            </pattern>
          </defs>
          {cells.map((c) => {
            const w = cellWetted(snapshot, c.col, c.cell);
            const dry = wetting && w <= 0;
            const fill = dry ? undefined : colorOf(cellValue(snapshot, field, c.col, c.cell));
            const hover = () => setSelected({ col: c.col, cell: c.cell });
            return (
              <g key={`${c.col}-${c.cell}`} onPointerEnter={hover}>
                <polygon
                  className={`section-cell${dry ? ' section-dry' : ''}`}
                  points={c.right}
                  fill={fill}
                  stroke={fill}
                />
                <polygon
                  className={`section-cell${dry ? ' section-dry' : ''}`}
                  points={c.left}
                  fill={fill}
                  stroke={fill}
                />
                {wetting && w < 1 && (
                  <g className="section-hatch" opacity={1 - w}>
                    <polygon points={c.right} fill={`url(#${hatchId})`} />
                    <polygon points={c.left} fill={`url(#${hatchId})`} />
                  </g>
                )}
              </g>
            );
          })}
          {partlyDry &&
            bands.map((band, col) => {
              const d = fronts[col];
              if (!(d < bedHeightMm - 1e-9)) return null;
              // The front at height z, across the column's span there (both halves).
              const z = Math.max(0, bedHeightMm - d);
              const scale = (wall[0]?.r ?? 1) > 0 ? radiusAt(wall, z) / (wall[0]?.r ?? 1) : 1;
              const r0 = band.inner * scale;
              const r1 = band.outer * scale;
              return (
                <g key={`front-${col}`} className="section-front">
                  <line x1={frame.x(r0)} x2={frame.x(r1)} y1={frame.y(z)} y2={frame.y(z)} />
                  <line x1={frame.x(-r0)} x2={frame.x(-r1)} y1={frame.y(z)} y2={frame.y(z)} />
                </g>
              );
            })}
          {selected &&
            cells
              .filter((c) => c.col === selected.col && c.cell === selected.cell)
              .map((c) => (
                <g key="selected" className="section-selected">
                  <polygon points={c.right} />
                  <polygon points={c.left} />
                </g>
              ))}
          <BasketOutline
            wall={wall}
            frame={frame}
            perforatedRadiusMm={outcome.build.spec.basket.perforated_radius_m * 1000}
            orificeMm={
              outcome.build.spec.basket.outlet.type === 'pressurised'
                ? outcome.build.spec.basket.outlet.orifice_diameter_m * 1000
                : null
            }
          />
          <line
            className="section-axis"
            x1={frame.x(0)}
            x2={frame.x(0)}
            y1={frame.y(bedHeightMm)}
            y2={frame.y(0)}
          />
        </svg>
      </div>
      <p className="section-readout" aria-live="polite">
        {selected
          ? describe(selected.col, selected.cell)
          : 'Point at a cell, or focus the figure and use the arrow keys, to read its value.'}
      </p>
      <figure className="section-legend">
        <svg
          viewBox="0 0 200 26"
          role="img"
          aria-label={
            diverging
              ? `Diverging colour scale, red below zero and blue above, from ${formatValue(legendLo, field)} to ${formatValue(legendHi, field)}; the values here run from ${formatValue(lo, field)} to ${formatValue(hi, field)}`
              : `Colour scale from ${formatValue(lo, field)} to ${formatValue(hi, field)}`
          }
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
              {stops}
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="200" height="10" fill={`url(#${gradientId})`} />
          <text className="legend-label" x="0" y="23">
            {formatValue(legendLo, field)}
          </text>
          <text className="legend-label" x="100" y="23" textAnchor="middle">
            {formatValue((legendLo + legendHi) / 2, field)}
          </text>
          <text className="legend-label" x="200" y="23" textAnchor="end">
            {formatValue(legendHi, field)}
          </text>
        </svg>
        <figcaption className="note">
          {FIELDS[field].label}:{' '}
          {fixedScale ? 'one scale for all snapshots' : 'scale of this snapshot'}.{' '}
          {vScale > 1 ? `Depth stretched ${vScale}× for legibility. ` : ''}
          {`This result (tier ${outcome.tier}) has ${bands.length === 1 ? 'one column' : `${bands.length} columns`} and ${depthCount} depth cells. `}
          {strata
            ? 'Columns that share an annulus are drawn side by side inside it; that order is a drawing choice. '
            : ''}
          {hasNegative
            ? 'Values below 0 mean the particles there took solubles back up from the liquid. '
            : ''}
          {partlyDry
            ? 'Hatched cells are not yet (fully) wetted, the denser the drier; the dashed line marks the wetting front in each column. '
            : ''}
          {field === 'liquid_conc_kg_m3'
            ? 'The concentration is per volume of liquid (between and inside the particles); it is 0 where the bed is dry. '
            : ''}
        </figcaption>
      </figure>
      <details className="table-view">
        <summary>
          Table view ({depthCount} depth cells × {bands.length} columns)
        </summary>
        <div className="table-wrap">
          <table>
            <caption>
              {FIELDS[field].label} ({FIELDS[field].unit}) at {fixed(snapshot?.t_s, 1)} s; columns
              from the axis to the wall
            </caption>
            <thead>
              <tr>
                <th scope="col">Depth (mm)</th>
                {bands.map((b, col) => (
                  <th scope="col" key={col}>
                    {fixed(b.inner, 1)}–{fixed(b.outer, 1)} mm
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: depthCount }, (_, cell) => (
                <tr key={cell}>
                  <th scope="row">{fixed((bounds[cell] + bounds[cell + 1]) / 2, 2)}</th>
                  {bands.map((_, col) => (
                    <td key={col}>{formatValue(cellValue(snapshot, field, col, cell), field)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {wetting && (
            <table>
              <caption>
                Wetted share at {fixed(snapshot?.t_s, 1)} s (0% dry, 100% wet); columns from the
                axis to the wall
              </caption>
              <thead>
                <tr>
                  <th scope="col">Depth (mm)</th>
                  {bands.map((b, col) => (
                    <th scope="col" key={col}>
                      {fixed(b.inner, 1)}–{fixed(b.outer, 1)} mm
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: depthCount }, (_, cell) => (
                  <tr key={cell}>
                    <th scope="row">{fixed((bounds[cell] + bounds[cell + 1]) / 2, 2)}</th>
                    {bands.map((_, col) => (
                      <td key={col}>{percent(cellWetted(snapshot, col, cell), 0)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </details>
    </div>
  );
}
