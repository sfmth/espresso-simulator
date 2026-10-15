// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The basket's axisymmetric cross-section in SVG: the wall profile mirrored
 * about the axis, the floor with its perforated field, the outlet orifice of a
 * pressurised basket, and the coffee bed up to its height once a build has
 * computed it. Drawn in millimetres at true proportions (the puck
 * cross-section may stretch the height); colours come from CSS classes, so
 * both themes and forced-colours mode apply.
 */
import { maxRadius, wallBetween, wallHeight, type WallPoint } from './basketGeometry';
import { fixed } from './format';

export interface Frame {
  width: number;
  height: number;
  /** Radius (mm, signed: negative is the left half) → SVG x. */
  x: (r: number) => number;
  /** Height above the floor (mm) → SVG y. */
  y: (z: number) => number;
  /** Vertical exaggeration. */
  vScale: number;
}

/** The SVG frame for a basket: millimetre units, margins for labels. */
export function basketFrame(wall: readonly WallPoint[], vScale = 1): Frame {
  const r = Math.max(maxRadius(wall), 1);
  const h = Math.max(wallHeight(wall), 1);
  const side = Math.max(3, r * 0.1);
  const top = 7;
  const bottom = 8;
  return {
    width: 2 * r + 2 * side,
    height: h * vScale + top + bottom,
    x: (radius) => side + r + radius,
    y: (z) => top + (h - z) * vScale,
    vScale,
  };
}

function points(list: readonly [number, number][]): string {
  return list.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ');
}

/** The region between the floor (or `z0`) and `z1`, both halves: a closed polygon. */
export function regionPolygon(wall: readonly WallPoint[], frame: Frame, z0: number, z1: number) {
  const side = wallBetween(wall, z0, z1);
  const right = side.map((p): [number, number] => [frame.x(p.r), frame.y(p.z)]);
  const left = [...side].reverse().map((p): [number, number] => [frame.x(-p.r), frame.y(p.z)]);
  return points([...right, ...left]);
}

export function BasketOutline({
  wall,
  frame,
  perforatedRadiusMm,
  orificeMm,
}: {
  wall: readonly WallPoint[];
  frame: Frame;
  perforatedRadiusMm: number;
  orificeMm?: number | null;
}) {
  const floor = wall[0];
  const right = wall.map((p): [number, number] => [frame.x(p.r), frame.y(p.z)]);
  const left = wall.map((p): [number, number] => [frame.x(-p.r), frame.y(p.z)]);
  const y0 = frame.y(0);
  const rim = wall[wall.length - 1];
  return (
    <g className="basket-outline">
      <polyline className="basket-wall" points={points([...left].reverse().concat(right))} />
      {floor && (
        <line
          className="basket-wall"
          x1={frame.x(-floor.r)}
          x2={frame.x(floor.r)}
          y1={y0}
          y2={y0}
        />
      )}
      {perforatedRadiusMm > 0 && (
        <line
          className="basket-holes"
          x1={frame.x(-perforatedRadiusMm)}
          x2={frame.x(perforatedRadiusMm)}
          y1={y0 + 1.2}
          y2={y0 + 1.2}
        />
      )}
      {orificeMm ? (
        <rect
          className="basket-orifice"
          x={frame.x(-Math.max(orificeMm, 0.6) / 2)}
          y={y0 + 2}
          width={Math.max(orificeMm, 0.6)}
          height={3}
        />
      ) : null}
      {rim && (
        <text className="basket-label" x={frame.x(0)} y={frame.y(rim.z) - 2.2} textAnchor="middle">
          {fixed(rim.r * 2, 1)} mm
        </text>
      )}
    </g>
  );
}

export interface BasketDiagramProps {
  wall: readonly WallPoint[];
  perforatedRadiusMm: number;
  orificeMm?: number | null;
  /** Height of the dry bed, mm, if a build has computed it. */
  bedHeightMm?: number | null;
  /** Says the bed height comes from a build of earlier inputs. */
  bedNote?: string;
  label: string;
}

export function BasketDiagram({
  wall,
  perforatedRadiusMm,
  orificeMm,
  bedHeightMm,
  bedNote,
  label,
}: BasketDiagramProps) {
  if (wall.length < 2) return null;
  const frame = basketFrame(wall);
  const height = wallHeight(wall);
  const bed =
    bedHeightMm !== null && bedHeightMm !== undefined && bedHeightMm > 0
      ? Math.min(bedHeightMm, height)
      : null;
  const description =
    `${label}: ${fixed(wall[wall.length - 1].r * 2, 1)} mm at the rim, ` +
    `${fixed(wall[0].r * 2, 1)} mm at the floor, ${fixed(height, 1)} mm tall` +
    (bed !== null ? `; the bed fills it to ${fixed(bed, 1)} mm` : '') +
    (orificeMm ? `; pressurised outlet of ${orificeMm} mm` : '') +
    '.';
  return (
    <figure className="basket-figure">
      <svg
        className="basket-svg"
        viewBox={`0 0 ${frame.width.toFixed(3)} ${frame.height.toFixed(3)}`}
        role="img"
        aria-label={description}
      >
        {bed !== null && (
          <>
            <polygon className="basket-bed" points={regionPolygon(wall, frame, 0, bed)} />
            <text
              className="basket-label"
              x={frame.x(0)}
              y={frame.y(bed / 2) + 1}
              textAnchor="middle"
            >
              bed {fixed(bed, 1)} mm
            </text>
          </>
        )}
        <BasketOutline
          wall={wall}
          frame={frame}
          perforatedRadiusMm={perforatedRadiusMm}
          orificeMm={orificeMm}
        />
      </svg>
      <figcaption className="note">
        {description}
        {bedNote ? ` ${bedNote}` : ''}
      </figcaption>
    </figure>
  );
}
