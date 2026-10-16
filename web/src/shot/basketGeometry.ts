// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Axisymmetric basket geometry (docs/model/input-models.md §4): an inner wall
 * profile of (height, radius) points, the radius linear between points, so
 * volumes are sums of frusta. Used by the basket editor (validation and the
 * live drawing) and by the puck cross-section, which draws the solver's
 * columns on the actual basket shape.
 */

/** A wall point: height above the floor and inner radius, in one length unit. */
export interface WallPoint {
  z: number;
  r: number;
}

/** Recipe profile ([height mm, diameter mm]) → wall points in mm. */
export function wallFromRecipe(profileMm: readonly (readonly [number, number])[]): WallPoint[] {
  return profileMm.map(([z, d]) => ({ z, r: d / 2 }));
}

/** Spec profile ([height m, radius m]) → wall points in mm. */
export function wallFromSpec(profileM: readonly (readonly [number, number])[]): WallPoint[] {
  return profileM.map(([z, r]) => ({ z: z * 1000, r: r * 1000 }));
}

/**
 * Problems with a recipe profile, as the builder would report them, keyed by
 * row: `rows[i]` holds the message for row i (height or diameter), `profile`
 * a message about the profile as a whole. Empty when the profile is valid.
 */
export interface ProfileProblems {
  profile?: string;
  rows: Record<number, { height?: string; diameter?: string }>;
  perforated?: string;
  orifice?: string;
}

/**
 * Checks a profile and the floor features against the builder's rules:
 * at least two points; heights start at 0 and strictly increase; diameters
 * positive; the perforated diameter positive and at most the floor diameter;
 * a pressurised orifice positive and smaller than the perforated diameter.
 * Values that are not numbers (NaN) are assumed to be reported elsewhere.
 */
export function checkProfile(
  profileMm: readonly (readonly [number, number])[],
  perforatedMm: number,
  orificeMm: number | null,
): ProfileProblems {
  const problems: ProfileProblems = { rows: {} };
  const row = (i: number) => (problems.rows[i] ??= {});
  if (profileMm.length < 2) {
    problems.profile = 'The wall profile needs at least two points: the floor and the rim.';
  }
  profileMm.forEach(([z, d], i) => {
    if (Number.isNaN(z) || Number.isNaN(d)) return;
    if (i === 0 && z !== 0) row(0).height = 'The first point is the floor: its height must be 0.';
    else if (!(z >= 0)) row(i).height = 'Heights must be 0 mm or more.';
    if (!(d > 0)) row(i).diameter = 'Diameters must be more than 0 mm.';
    if (i > 0) {
      const previous = profileMm[i - 1][0];
      if (!Number.isNaN(previous) && !(z > previous)) {
        row(i).height ??= `Heights must increase: ${z} mm is not above ${previous} mm.`;
      }
    }
  });
  const floor = profileMm[0]?.[1];
  if (!Number.isNaN(perforatedMm)) {
    if (!(perforatedMm > 0))
      problems.perforated = 'The perforated diameter must be more than 0 mm.';
    else if (floor !== undefined && floor > 0 && perforatedMm > floor * (1 + 1e-12)) {
      problems.perforated = `The perforated diameter must be at most the floor diameter (${floor} mm).`;
    }
  }
  if (orificeMm !== null && !Number.isNaN(orificeMm)) {
    if (!(orificeMm > 0)) problems.orifice = 'The orifice diameter must be more than 0 mm.';
    else if (perforatedMm > 0 && !(orificeMm < perforatedMm)) {
      problems.orifice = 'The orifice must be smaller than the perforated diameter.';
    }
  }
  return problems;
}

/** True if `checkProfile` found nothing. */
export function profileIsValid(problems: ProfileProblems): boolean {
  return (
    !problems.profile &&
    !problems.perforated &&
    !problems.orifice &&
    Object.keys(problems.rows).length === 0
  );
}

/** Inner radius at height `z` (clamped to the floor and the rim). */
export function radiusAt(wall: readonly WallPoint[], z: number): number {
  if (wall.length === 0) return 0;
  if (z <= wall[0].z) return wall[0].r;
  for (let i = 1; i < wall.length; i++) {
    const a = wall[i - 1];
    const b = wall[i];
    if (z <= b.z) {
      const span = b.z - a.z;
      return span > 0 ? a.r + ((b.r - a.r) * (z - a.z)) / span : b.r;
    }
  }
  return wall[wall.length - 1].r;
}

/** Volume of a frustum of height h between radii r1 and r2. */
function frustum(h: number, r1: number, r2: number): number {
  return (Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
}

/** Volume enclosed from the floor up to height `z` (unit³; mm³ for mm). */
export function volumeBelow(wall: readonly WallPoint[], z: number): number {
  let volume = 0;
  for (let i = 1; i < wall.length; i++) {
    const a = wall[i - 1];
    const b = wall[i];
    if (z <= a.z) break;
    const top = Math.min(z, b.z);
    volume += frustum(top - a.z, a.r, radiusAt(wall, top));
  }
  return volume;
}

/** Total height of the basket (the rim). */
export function wallHeight(wall: readonly WallPoint[]): number {
  return wall.length > 0 ? wall[wall.length - 1].z : 0;
}

/** Largest radius of the profile. */
export function maxRadius(wall: readonly WallPoint[]): number {
  return wall.reduce((m, p) => Math.max(m, p.r), 0);
}

/**
 * The wall points between heights `z0` and `z1`, including both ends: the
 * outline of one side of the region (e.g. the bed from the floor to its top).
 */
export function wallBetween(wall: readonly WallPoint[], z0: number, z1: number): WallPoint[] {
  const points: WallPoint[] = [{ z: z0, r: radiusAt(wall, z0) }];
  for (const p of wall) if (p.z > z0 && p.z < z1) points.push(p);
  points.push({ z: z1, r: radiusAt(wall, z1) });
  return points;
}
