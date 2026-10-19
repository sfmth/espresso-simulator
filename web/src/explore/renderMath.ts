// SPDX-License-Identifier: GPL-2.0-or-later
/** Pure camera-space sphere bounds and conservative visibility guards. */
export type Vec3 = readonly [number, number, number];
export interface Projection {
  scaleX: number;
  scaleY: number;
  near: number;
  far: number;
  widthPx: number;
  heightPx: number;
}
export interface SphereBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}
/** Exact perspective tangent bounds, before viewport clipping. */
export function sphereBounds(
  centre: Vec3,
  radius: number,
  projection: Projection,
): SphereBounds | null {
  const [x, y, z] = centre;
  const d = -z;
  if (
    ![x, y, z, radius].every(Number.isFinite) ||
    radius <= 0 ||
    d + radius < projection.near ||
    d - radius > projection.far
  )
    return null;
  if (d <= radius) return { left: -1, right: 1, bottom: -1, top: 1 };
  const denominator = d * d - radius * radius;
  const tangentX = radius * Math.sqrt(x * x + denominator);
  const tangentY = radius * Math.sqrt(y * y + denominator);
  const bounds = {
    left: (projection.scaleX * (x * d - tangentX)) / denominator,
    right: (projection.scaleX * (x * d + tangentX)) / denominator,
    bottom: (projection.scaleY * (y * d - tangentY)) / denominator,
    top: (projection.scaleY * (y * d + tangentY)) / denominator,
  };
  return bounds.left > 1 || bounds.right < -1 || bounds.bottom > 1 || bounds.top < -1
    ? null
    : bounds;
}

/** Fixed bounded search; extraction data and source arrays remain untouched. */
export interface ContainmentIndex {
  parentSphere: Float32Array;
  parentIndex: Int32Array;
  candidateCount: number;
  containedCount: number;
  marginMm: number;
}
export function buildContainmentIndex(
  positions: Float32Array,
  radii: Float32Array,
  domainMm: number,
): ContainmentIndex {
  if (
    positions.length !== radii.length * 3 ||
    radii.length > 150_000 ||
    !Number.isFinite(domainMm) ||
    domainMm <= 0 ||
    !positions.every(Number.isFinite) ||
    !radii.every((r) => Number.isFinite(r) && r > 0)
  )
    throw new RangeError('Containment requires finite sphere data and at most 150,000 particles.');
  const candidates: number[] = [];
  for (let i = 0; i < radii.length; i++) {
    if (candidates.length === 32 && radii[i] <= radii[candidates[31]]) continue;
    let at = 0;
    while (at < candidates.length && radii[candidates[at]] >= radii[i]) at++;
    candidates.splice(at, 0, i);
    if (candidates.length > 32) candidates.pop();
  }
  const marginMm = domainMm * 2e-5;
  const parentSphere = new Float32Array(radii.length * 4);
  const parentIndex = new Int32Array(radii.length).fill(-1);
  let containedCount = 0;
  for (let i = 0; i < radii.length; i++) {
    let bestGap = marginMm;
    for (const parent of candidates) {
      const limit = radii[parent] - radii[i] - bestGap;
      if (parent === i || limit <= 0) continue;
      const dx = positions[3 * i] - positions[3 * parent];
      const dy = positions[3 * i + 1] - positions[3 * parent + 1];
      const dz = positions[3 * i + 2] - positions[3 * parent + 2];
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared >= limit * limit) continue;
      bestGap = radii[parent] - radii[i] - Math.sqrt(squared);
      parentIndex[i] = parent;
    }
    const parent = parentIndex[i];
    if (parent < 0) continue;
    parentSphere.set(positions.subarray(parent * 3, parent * 3 + 3), i * 4);
    parentSphere[i * 4 + 3] = radii[parent];
    containedCount++;
  }
  return { parentSphere, parentIndex, candidateCount: candidates.length, containedCount, marginMm };
}

/** Includes Float32 depth arithmetic and depth-buffer ties, not just geometric enclosure. */
export function containmentDepthFactor(
  projection: Pick<Projection, 'scaleX' | 'scaleY' | 'near' | 'far'>,
  depthBits: number,
): number {
  if (
    depthBits < 16 ||
    !Number.isFinite(depthBits) ||
    projection.near <= 0 ||
    projection.far <= projection.near ||
    projection.scaleX <= 0 ||
    projection.scaleY <= 0
  )
    return Infinity;
  const depthUncertainty = 8 * Math.max(2 ** -depthBits, 2 ** -23);
  const inverseMinRayCosine = Math.sqrt(1 + projection.scaleX ** -2 + projection.scaleY ** -2);
  return (
    ((depthUncertainty * (projection.far - projection.near)) / (projection.far * projection.near)) *
    inverseMinRayCosine
  );
}
export interface ContainmentView {
  cutZ: number;
  near: number;
  far: number;
  marginMm: number;
  depthFactor: number;
}
/** CPU equivalent of the conservative vertex guard, for numerical verification. */
export function containmentIsOccluded(
  child: Vec3,
  childRadius: number,
  parent: Vec3,
  parentRadius: number,
  parentView: Vec3,
  view: ContainmentView,
): boolean {
  if (parentRadius <= 0 || parent[2] > view.cutZ || Math.hypot(...parentView) <= parentRadius)
    return false;
  const d = -parentView[2];
  if (d - parentRadius <= view.near + view.marginMm || d + parentRadius >= view.far - view.marginMm)
    return false;
  const gap =
    parentRadius -
    childRadius -
    Math.hypot(child[0] - parent[0], child[1] - parent[1], child[2] - parent[2]);
  return gap > view.marginMm + view.depthFactor * (d + parentRadius) ** 2;
}
