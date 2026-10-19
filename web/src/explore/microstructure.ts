// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * A reproducible representative volume, and a deliberately small pore lattice.
 * Particle counts are a display budget, not a new discretisation of extraction:
 * statistical dry-mass weights preserve every resolved PSD class exactly. All
 * extraction colours and radial profiles come from the selected coupled cell.
 */
import type { RecipeRunData } from '../engine/shotData';
import type { MicroMetadata, MicroSnapshot } from '../engine/exploreTypes';

export type MicroOutcome = Pick<RecipeRunData, 'build' | 'result'>;
export interface MicroSelection {
  snapshotIndex: number;
  column: number;
  depthCell: number;
}
export interface MicroOptions {
  seed: number;
  count: number;
  cutoffUm?: number;
  packingIterations?: number;
  networkResolution?: number;
}
interface SourceClass {
  radius_m: number;
  volume_fraction: number;
}

export interface PackingReport {
  iterations: number;
  /** Overlapping pairs found in the final bounded audit; a lower bound if incomplete. */
  overlapPairs: number;
  maxOverlapFraction: number;
  checkedPairs: number;
  /** True when the audit reached every neighbour, false when its work budget was reached. */
  auditComplete: boolean;
  bounded: true;
}
export interface PoreNetwork {
  resolution: number;
  positionsMm: Float32Array;
  edges: Uint32Array;
  /** Dimensionless inlet=1, outlet=0 potential; not a physical pressure prediction. */
  pressure: Float32Array;
  /** Signed edge flux divided by total inlet flux; zero if no through path exists. */
  flow: Float32Array;
  clearanceMm: Float32Array;
  relativeResidual: number;
  maxConservationError: number;
  converged: boolean;
  iterations: number;
  inletFlux: number;
  outletFlux: number;
  connected: boolean;
}
export interface Microstructure {
  positionsMm: Float32Array;
  radiiMm: Float32Array;
  classIndex: Uint16Array;
  /** Statistical dry-mass share; sums to the source volume share in each class. */
  massWeight: Float64Array;
  fine: Uint8Array;
  /** Cube edge in mm. Positions are centred on the origin. */
  domainMm: number;
  seed: number;
  classes: SourceClass[];
  packing: PackingReport;
  network: PoreNetwork;
  notes: string[];
}
export interface MicroFrame {
  particleEy: Float32Array | null;
  meanEy: number | null;
  targetEy: number | null;
  consistencyErrorPoints: number | null;
  localConcentrationKgM3: number | null;
  wettedFraction: number | null;
  columnFlowMlS: number | null;
  pressureBar: number | null;
  bedTemperatureC?: number;
  unavailableReason?: string;
}
export interface ParticleProfile {
  classIndex: number;
  radiusMm: number;
  kernelRadiusMm: number;
  /** Shell outer radius divided by intact kernel radius, not full particle radius. */
  radiusFraction: Float64Array;
  concentrationKgM3: Float64Array;
  remainingFraction: Float64Array | null;
  surfaceRemainingFraction: number | null;
  source: 'coupled-core';
}

const MAX_PARTICLES = 150_000;
const MAX_CLASSES = 65_535;
const MAX_NEIGHBOUR_VISITS = 96;

/** Mulberry32: integer-only state update makes a seed reproduce across browsers. */
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function metadata(outcome: MicroOutcome): MicroMetadata | undefined {
  return outcome.result.spatial.micro ?? undefined;
}

/** Largest-remainder number sampling, reserving one marker for every source class. */
function classCounts(classes: readonly SourceClass[], count: number): number[] {
  const odds = classes.map((c) => c.volume_fraction / c.radius_m ** 3);
  const sum = odds.reduce((a, b) => a + b, 0);
  const available = count - classes.length;
  const exact = odds.map((value) => (available * value) / sum);
  const counts = exact.map((value) => 1 + Math.floor(value));
  let left = count - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, remainder: value % 1 }));
  order.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; left > 0; i++, left--) counts[order[i].index]++;
  return counts;
}

export function buildMicrostructure(outcome: MicroOutcome, options: MicroOptions): Microstructure {
  const source = outcome.build.spec.bed.size_classes;
  if (
    source.length === 0 ||
    source.length > MAX_CLASSES ||
    source.some(
      (c) =>
        !finite(c.radius_m) ||
        c.radius_m <= 0 ||
        !finite(Math.fround(c.radius_m * 1000)) ||
        Math.fround(c.radius_m * 1000) <= 0 ||
        !finite(c.volume_fraction) ||
        c.volume_fraction < 0,
    )
  )
    throw new RangeError(
      'Microstructure needs finite positive source radii and nonnegative fractions.',
    );
  const totalFraction = source.reduce((sum, c) => sum + c.volume_fraction, 0);
  if (!(totalFraction > 0) || !finite(totalFraction))
    throw new RangeError('Microstructure needs a finite positive PSD volume.');
  if (
    !Number.isInteger(options.count) ||
    options.count < source.length ||
    options.count > MAX_PARTICLES
  ) {
    throw new RangeError(
      `Particle count must be an integer from ${source.length} to ${MAX_PARTICLES}.`,
    );
  }
  if (!Number.isSafeInteger(options.seed)) throw new RangeError('Seed must be a safe integer.');
  const porosity = outcome.build.spec.bed.intergranular_porosity;
  if (!finite(porosity) || porosity <= 0 || porosity >= 1)
    throw new RangeError('Intergranular porosity must lie between zero and one.');
  if (options.cutoffUm !== undefined && (!finite(options.cutoffUm) || options.cutoffUm < 0))
    throw new RangeError('The fine cutoff must be finite and nonnegative.');
  if (
    options.packingIterations !== undefined &&
    (!Number.isInteger(options.packingIterations) ||
      options.packingIterations < 0 ||
      options.packingIterations > 20)
  )
    throw new RangeError('Packing iterations must be an integer from zero to twenty.');
  if (
    options.networkResolution !== undefined &&
    (!Number.isInteger(options.networkResolution) ||
      options.networkResolution < 4 ||
      options.networkResolution > 18)
  )
    throw new RangeError('Network resolution must be an integer from four to eighteen.');
  const classes = source.map((c) => ({
    radius_m: c.radius_m,
    volume_fraction: c.volume_fraction / totalFraction,
  }));
  const counts = classCounts(classes, options.count);
  const classIndex = new Uint16Array(options.count);
  let offset = 0;
  counts.forEach((count, index) => {
    classIndex.fill(index, offset, offset + count);
    offset += count;
  });
  const random = randomSource(options.seed);
  for (let i = classIndex.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const old = classIndex[i];
    classIndex[i] = classIndex[j];
    classIndex[j] = old;
  }
  const radiiMm = Float32Array.from(classIndex, (index) => classes[index].radius_m * 1000);
  const massWeight = Float64Array.from(
    classIndex,
    (index) => classes[index].volume_fraction / counts[index],
  );
  const fine = Uint8Array.from(radiiMm, (radius) =>
    radius * 2000 < (options.cutoffUm ?? 75) ? 1 : 0,
  );
  let volume = 0;
  let largest = 0;
  for (const radius of radiiMm) {
    volume += (4 * Math.PI * radius ** 3) / 3;
    largest = Math.max(largest, radius);
  }
  // Keep a rounding margin so Float32 positions cannot put a sphere outside its cube.
  const domainMm = Math.max(Math.cbrt(volume / (1 - porosity)), 2.001 * largest);
  if (!finite(volume) || !finite(domainMm) || !finite(Math.fround(domainMm))) {
    throw new RangeError('The representative volume exceeds finite display coordinates.');
  }
  const positionsMm = new Float32Array(options.count * 3);
  for (let i = 0; i < options.count; i++)
    for (let axis = 0; axis < 3; axis++) {
      positionsMm[3 * i + axis] = (random() - 0.5) * (domainMm - 2.00001 * radiiMm[i]);
    }
  const iterations =
    options.packingIterations ?? (options.count >= 100_000 ? 2 : options.count >= 20_000 ? 3 : 6);
  const packing = relaxPacking(positionsMm, radiiMm, domainMm, iterations);
  const network = buildPoreNetwork(positionsMm, radiiMm, domainMm, options.networkResolution ?? 10);
  const notes = [
    'Representative cube: source radii are preserved; statistical dry-mass weights reproduce all PSD volume fractions, including sub-grid fines.',
    'CPU soft-sphere packing is approximate. Residual overlaps are reported; this geometry does not predict calibrated absolute permeability.',
    'Pore-lattice potential and relative flux are illustrative. Actual column flow comes only from the coupled shot result.',
  ];
  if (!packing.auditComplete)
    notes.push(
      'The final overlap audit reached its neighbour budget; reported overlaps are lower bounds.',
    );
  if (!network.connected)
    notes.push('The sampled pore lattice has no inlet-to-outlet path at this resolution.');
  return {
    positionsMm,
    radiiMm,
    classIndex,
    massWeight,
    fine,
    domainMm,
    seed: options.seed,
    classes,
    packing,
    network,
    notes,
  };
}

function relaxPacking(
  positions: Float32Array,
  radii: Float32Array,
  edge: number,
  iterations: number,
): PackingReport {
  let smallest = Infinity;
  for (const radius of radii) smallest = Math.min(smallest, radius);
  const levels = Uint16Array.from(radii, (radius) =>
    Math.max(0, Math.ceil(Math.log2(radius / smallest))),
  );
  let topLevel = 0;
  for (const level of levels) topLevel = Math.max(topLevel, level);
  // Each grid contains similarly sized particles. A fine particle queries its
  // own and all coarser grids, avoiding giant buckets full of irrelevant fines.
  const grids = Array.from({ length: topLevel + 1 }, (_, level) => {
    const width = 2.001 * smallest * 2 ** level;
    return { width, cells: Math.max(1, Math.ceil(edge / width)), heads: new Map<number, number>() };
  });
  const next = new Int32Array(radii.length);
  let report: PackingReport = {
    iterations,
    overlapPairs: 0,
    maxOverlapFraction: 0,
    checkedPairs: 0,
    auditComplete: true,
    bounded: true,
  };
  const key = (x: number, y: number, z: number, cells: number) => x + cells * (y + cells * z);
  for (let iteration = 0; iteration <= iterations; iteration++) {
    for (const grid of grids) grid.heads.clear();
    for (let i = 0; i < radii.length; i++) {
      const { width, cells, heads } = grids[levels[i]];
      const x = Math.floor((positions[i * 3] + edge / 2) / width);
      const y = Math.floor((positions[i * 3 + 1] + edge / 2) / width);
      const z = Math.floor((positions[i * 3 + 2] + edge / 2) / width);
      const hash = key(x, y, z, cells);
      next[i] = heads.get(hash) ?? -1;
      heads.set(hash, i);
    }
    report = {
      iterations,
      overlapPairs: 0,
      maxOverlapFraction: 0,
      checkedPairs: 0,
      auditComplete: true,
      bounded: true,
    };
    const move = iteration < iterations;
    for (let i = 0; i < radii.length; i++) {
      let visits = 0;
      neighbours: for (let level = levels[i]; level <= topLevel; level++) {
        const { width, cells, heads } = grids[level];
        const x = Math.floor((positions[i * 3] + edge / 2) / width);
        const y = Math.floor((positions[i * 3 + 1] + edge / 2) / width);
        const z = Math.floor((positions[i * 3 + 2] + edge / 2) / width);
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (
                x + dx < 0 ||
                y + dy < 0 ||
                z + dz < 0 ||
                x + dx >= cells ||
                y + dy >= cells ||
                z + dz >= cells
              )
                continue;
              for (
                let j = heads.get(key(x + dx, y + dy, z + dz, cells)) ?? -1;
                j !== -1;
                j = next[j]
              ) {
                if (++visits > MAX_NEIGHBOUR_VISITS) {
                  report.auditComplete = false;
                  break neighbours;
                }
                if (level === levels[i] && j <= i) continue;
                report.checkedPairs++;
                let vx = positions[3 * i] - positions[3 * j];
                const vy = positions[3 * i + 1] - positions[3 * j + 1];
                const vz = positions[3 * i + 2] - positions[3 * j + 2];
                let distance = Math.hypot(vx, vy, vz);
                const diameter = radii[i] + radii[j];
                if (distance >= diameter) continue;
                report.overlapPairs++;
                report.maxOverlapFraction = Math.max(
                  report.maxOverlapFraction,
                  1 - distance / diameter,
                );
                if (!move) continue;
                if (distance === 0) {
                  vx = 1e-10;
                  distance = 1e-10;
                }
                const amount = (0.8 * (diameter - distance)) / distance;
                const deltas = [vx * amount, vy * amount, vz * amount];
                // Inverse-volume mobility prevents numerous fines from kicking
                // a coarse particle across the domain in one sweep.
                const shareI = radii[j] ** 3 / (radii[i] ** 3 + radii[j] ** 3);
                for (let axis = 0; axis < 3; axis++) {
                  const ai = 3 * i + axis;
                  const aj = 3 * j + axis;
                  positions[ai] = clamp(
                    positions[ai] + shareI * deltas[axis],
                    -edge / 2 + 1.00001 * radii[i],
                    edge / 2 - 1.00001 * radii[i],
                  );
                  positions[aj] = clamp(
                    positions[aj] - (1 - shareI) * deltas[axis],
                    -edge / 2 + 1.00001 * radii[j],
                    edge / 2 - 1.00001 * radii[j],
                  );
                }
              }
            }
      }
    }
  }
  return report;
}

/** Clearance is rasterised once at lattice nodes and throat midpoints in O(N + grid). */
function buildPoreNetwork(
  positions: Float32Array,
  radii: Float32Array,
  edge: number,
  resolution: number,
): PoreNetwork {
  const n = resolution;
  const grid = 2 * n - 1;
  const step = edge / (n - 1);
  const halfStep = step / 2;
  const clearance = new Float32Array(grid ** 3).fill(step);
  const gridKey = (x: number, y: number, z: number) => x + grid * (y + grid * z);
  for (let particle = 0; particle < radii.length; particle++) {
    const radius = radii[particle];
    const x = positions[3 * particle] + edge / 2;
    const y = positions[3 * particle + 1] + edge / 2;
    const z = positions[3 * particle + 2] + edge / 2;
    const reach = radius + step;
    const x0 = Math.max(0, Math.ceil((x - reach) / halfStep));
    const x1 = Math.min(grid - 1, Math.floor((x + reach) / halfStep));
    const y0 = Math.max(0, Math.ceil((y - reach) / halfStep));
    const y1 = Math.min(grid - 1, Math.floor((y + reach) / halfStep));
    const z0 = Math.max(0, Math.ceil((z - reach) / halfStep));
    const z1 = Math.min(grid - 1, Math.floor((z + reach) / halfStep));
    for (let iz = z0; iz <= z1; iz++)
      for (let iy = y0; iy <= y1; iy++)
        for (let ix = x0; ix <= x1; ix++) {
          const distance =
            Math.hypot(ix * halfStep - x, iy * halfStep - y, iz * halfStep - z) - radius;
          const index = gridKey(ix, iy, iz);
          if (distance < clearance[index]) clearance[index] = distance;
        }
  }
  const nodeCount = n ** 3;
  const positionsMm = new Float32Array(nodeCount * 3);
  const clearanceMm = new Float32Array(nodeCount);
  const edges: number[] = [];
  const conductance: number[] = [];
  const nodeKey = (x: number, y: number, z: number) => x + n * (y + n * z);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const index = nodeKey(x, y, z);
        positionsMm.set([x * step - edge / 2, y * step - edge / 2, z * step - edge / 2], 3 * index);
        clearanceMm[index] = Math.max(0, clearance[gridKey(x * 2, y * 2, z * 2)]);
        for (let axis = 0; axis < 3; axis++) {
          const neighbour = [x, y, z];
          neighbour[axis]++;
          if (neighbour[axis] >= n) continue;
          const midpoint = [x * 2, y * 2, z * 2];
          midpoint[axis]++;
          const throat = Math.min(
            clearance[gridKey(x * 2, y * 2, z * 2)],
            clearance[gridKey(neighbour[0] * 2, neighbour[1] * 2, neighbour[2] * 2)],
            clearance[gridKey(midpoint[0], midpoint[1], midpoint[2])],
          );
          if (!(throat > step * 1e-4)) continue;
          const other = nodeKey(neighbour[0], neighbour[1], neighbour[2]);
          const edgeIndex = conductance.length;
          edges.push(index, other);
          conductance.push((throat / step) ** 4);
          adjacency[index].push(edgeIndex);
          adjacency[other].push(edgeIndex);
        }
      }
  // Every solved component must touch a fixed-pressure face. Sealed pockets
  // retain a neutral potential and zero flux rather than making CG singular.
  const active = new Uint8Array(nodeCount);
  const queue: number[] = [];
  for (let i = 0; i < n * n; i++) {
    active[i] = 1;
    active[nodeCount - 1 - i] = 1;
    queue.push(i, nodeCount - 1 - i);
  }
  for (let k = 0; k < queue.length; k++)
    for (const e of adjacency[queue[k]]) {
      const a = edges[2 * e];
      const b = edges[2 * e + 1];
      const other = a === queue[k] ? b : a;
      if (!active[other]) {
        active[other] = 1;
        queue.push(other);
      }
    }
  const unknown = new Int32Array(nodeCount).fill(-1);
  const nodes: number[] = [];
  for (let i = n * n; i < nodeCount - n * n; i++)
    if (active[i]) {
      unknown[i] = nodes.length;
      nodes.push(i);
    }
  const diagonal = new Float64Array(nodes.length);
  const rhs = new Float64Array(nodes.length);
  for (let e = 0; e < conductance.length; e++) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    const g = conductance[e];
    if (unknown[a] >= 0) {
      diagonal[unknown[a]] += g;
      if (b < n * n) rhs[unknown[a]] += g;
    }
    if (unknown[b] >= 0) {
      diagonal[unknown[b]] += g;
      if (a < n * n) rhs[unknown[b]] += g;
    }
  }
  const apply = (value: Float64Array): Float64Array => {
    const result = Float64Array.from(value, (v, i) => diagonal[i] * v);
    for (let e = 0; e < conductance.length; e++) {
      const a = unknown[edges[2 * e]];
      const b = unknown[edges[2 * e + 1]];
      if (a >= 0 && b >= 0) {
        result[a] -= conductance[e] * value[b];
        result[b] -= conductance[e] * value[a];
      }
    }
    return result;
  };
  const solved = conjugateGradients(apply, diagonal, rhs);
  const pressureFull = new Float64Array(nodeCount).fill(0.5);
  pressureFull.fill(1, 0, n * n);
  pressureFull.fill(0, nodeCount - n * n);
  nodes.forEach((node, i) => {
    pressureFull[node] = solved.value[i];
  });
  const rawFlow = new Float64Array(conductance.length);
  const imbalance = new Float64Array(nodeCount);
  let inlet = 0;
  let outlet = 0;
  for (let e = 0; e < conductance.length; e++) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    const flow = active[a] ? conductance[e] * (pressureFull[a] - pressureFull[b]) : 0;
    rawFlow[e] = flow;
    imbalance[a] += flow;
    imbalance[b] -= flow;
    if (a < n * n) inlet += flow;
    if (b < n * n) inlet -= flow;
    if (b >= nodeCount - n * n) outlet += flow;
    if (a >= nodeCount - n * n) outlet -= flow;
  }
  const scale = inlet > 1e-16 ? inlet : 0;
  let maxConservationError = 0;
  if (scale > 0)
    for (const node of nodes)
      maxConservationError = Math.max(maxConservationError, Math.abs(imbalance[node]) / scale);
  return {
    resolution,
    positionsMm,
    edges: Uint32Array.from(edges),
    pressure: Float32Array.from(pressureFull),
    flow: Float32Array.from(rawFlow, (flow) => (scale > 0 ? flow / scale : 0)),
    clearanceMm,
    relativeResidual: solved.relativeResidual,
    maxConservationError,
    converged: solved.converged,
    iterations: solved.iterations,
    inletFlux: scale > 0 ? 1 : 0,
    outletFlux: scale > 0 ? outlet / scale : 0,
    connected: scale > 0 && outlet > scale * 0.99,
  };
}

function conjugateGradients(
  apply: (x: Float64Array) => Float64Array,
  diagonal: Float64Array,
  rhs: Float64Array,
): { value: Float64Array; relativeResidual: number; converged: boolean; iterations: number } {
  const dot = (a: Float64Array, b: Float64Array) =>
    a.reduce((sum, value, i) => sum + value * b[i], 0);
  const value = new Float64Array(rhs.length);
  const residual = rhs.slice();
  const preconditioned = Float64Array.from(residual, (v, i) =>
    diagonal[i] > 0 ? v / diagonal[i] : 0,
  );
  const direction = preconditioned.slice();
  const norm = Math.sqrt(dot(rhs, rhs));
  if (norm === 0) return { value, relativeResidual: 0, converged: true, iterations: 0 };
  let rz = dot(residual, preconditioned);
  let relativeResidual = 1;
  let iterations = 0;
  const limit = Math.min(2000, Math.max(40, rhs.length * 2));
  while (iterations < limit && relativeResidual > 1e-8) {
    const applied = apply(direction);
    const denominator = dot(direction, applied);
    if (!(denominator > 0)) break;
    const alpha = rz / denominator;
    for (let i = 0; i < value.length; i++) {
      value[i] += alpha * direction[i];
      residual[i] -= alpha * applied[i];
    }
    iterations++;
    relativeResidual = Math.sqrt(dot(residual, residual)) / norm;
    for (let i = 0; i < value.length; i++)
      preconditioned[i] = diagonal[i] > 0 ? residual[i] / diagonal[i] : 0;
    const next = dot(residual, preconditioned);
    const beta = next / rz;
    for (let i = 0; i < value.length; i++) direction[i] = preconditioned[i] + beta * direction[i];
    rz = next;
  }
  // Recompute the true residual so convergence is not inferred from a stale CG recurrence.
  const actual = apply(value);
  relativeResidual = Math.sqrt(actual.reduce((sum, v, i) => sum + (v - rhs[i]) ** 2, 0)) / norm;
  return { value, relativeResidual, converged: relativeResidual <= 1e-7, iterations };
}

function coupledAt(
  outcome: MicroOutcome,
  model: Microstructure,
  selection: MicroSelection,
): { metadata: MicroMetadata; state: MicroSnapshot } | null {
  const meta = metadata(outcome);
  const snapshot = outcome.result.spatial.snapshots[selection.snapshotIndex];
  const state = snapshot?.micro;
  if (
    !meta ||
    !state ||
    !Array.isArray(meta.classes) ||
    !Array.isArray(state.class_ey) ||
    meta.column !== selection.column ||
    meta.cell !== selection.depthCell ||
    meta.classes.length !== model.classes.length ||
    state.class_ey.length !== model.classes.length
  )
    return null;
  for (let i = 0; i < meta.classes.length; i++) {
    const source = meta.classes[i];
    const expected = model.classes[i];
    if (
      !source ||
      !finite(source.radius_m) ||
      Math.abs(source.radius_m - expected.radius_m) > expected.radius_m * 1e-6 ||
      !finite(source.volume_fraction) ||
      Math.abs(source.volume_fraction - expected.volume_fraction) > 1e-6 ||
      !finite(state.class_ey[i])
    )
      return null;
  }
  return { metadata: meta, state };
}

function validSelection(outcome: MicroOutcome, selection: MicroSelection): boolean {
  return (
    Number.isInteger(selection.snapshotIndex) &&
    Number.isInteger(selection.column) &&
    Number.isInteger(selection.depthCell) &&
    selection.snapshotIndex >= 0 &&
    selection.snapshotIndex < outcome.result.spatial.snapshots.length &&
    selection.column >= 0 &&
    selection.column < outcome.result.spatial.columns.length &&
    selection.depthCell >= 0 &&
    selection.depthCell < outcome.result.spatial.depth_m.length
  );
}

function seriesAt(outcome: MicroOutcome, values: ArrayLike<number>, time: number): number | null {
  const times = outcome.result.series.t_s;
  if (times.length === 0 || times.length !== values.length) return null;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  const index = lo > 0 && Math.abs(times[lo - 1] - time) < Math.abs(times[lo] - time) ? lo - 1 : lo;
  return finite(values[index]) ? values[index] : null;
}

export function frameAt(
  outcome: MicroOutcome,
  model: Microstructure,
  selection: MicroSelection,
): MicroFrame {
  const unavailable: MicroFrame = {
    particleEy: null,
    meanEy: null,
    targetEy: null,
    consistencyErrorPoints: null,
    localConcentrationKgM3: null,
    wettedFraction: null,
    columnFlowMlS: null,
    pressureBar: null,
  };
  if (!validSelection(outcome, selection))
    return {
      ...unavailable,
      unavailableReason: 'Selected snapshot or cell is outside this result.',
    };
  const snapshot = outcome.result.spatial.snapshots[selection.snapshotIndex];
  const target = snapshot.local_ey[selection.column]?.[selection.depthCell];
  const concentration = snapshot.liquid_conc_kg_m3[selection.column]?.[selection.depthCell];
  const wetted = snapshot.wetted_fraction?.[selection.column]?.[selection.depthCell];
  const extras = snapshot as typeof snapshot & {
    column_flow_m3_s?: number[];
    bed_temperature_c?: number;
  };
  const flow = extras.column_flow_m3_s?.[selection.column];
  const pressure = seriesAt(outcome, outcome.result.series.pressure_pa, snapshot.t_s);
  const frame: MicroFrame = {
    ...unavailable,
    targetEy: finite(target) ? target : null,
    localConcentrationKgM3: finite(concentration) ? concentration : null,
    wettedFraction: finite(wetted) ? clamp(wetted, 0, 1) : null,
    columnFlowMlS: finite(flow) ? flow * 1e6 : null,
    pressureBar: pressure === null ? null : pressure / 1e5,
  };
  if (finite(extras.bed_temperature_c)) frame.bedTemperatureC = extras.bed_temperature_c;
  const coupled = coupledAt(outcome, model, selection);
  if (!coupled)
    return {
      ...frame,
      unavailableReason:
        'Exact particle extraction is unavailable for the selected cell; run this cell with coupled micro output.',
    };
  const particleEy = Float32Array.from(model.classIndex, (index) => coupled.state.class_ey[index]);
  let mean = 0;
  let mass = 0;
  for (let i = 0; i < particleEy.length; i++) {
    mean += particleEy[i] * model.massWeight[i];
    mass += model.massWeight[i];
  }
  mean /= mass;
  const error = frame.targetEy === null ? null : 100 * Math.abs(mean - frame.targetEy);
  if (error === null || error > 0.5)
    return {
      ...frame,
      unavailableReason:
        'Coupled class extraction does not match the selected cell within 0.5 percentage points.',
    };
  return { ...frame, particleEy, meanEy: mean, consistencyErrorPoints: error };
}

/** No analytic diffusion surrogate: every shell value is copied from the coupled solver. */
export function particleProfile(
  outcome: MicroOutcome,
  model: Microstructure,
  particleIndex: number,
  selection: MicroSelection,
): ParticleProfile | null {
  if (
    !validSelection(outcome, selection) ||
    !Number.isInteger(particleIndex) ||
    particleIndex < 0 ||
    particleIndex >= model.radiiMm.length
  )
    return null;
  const coupled = coupledAt(outcome, model, selection);
  if (!coupled) return null;
  const snapshot = outcome.result.spatial.snapshots[selection.snapshotIndex];
  const target = snapshot.local_ey[selection.column]?.[selection.depthCell];
  const mean = coupled.state.class_ey.reduce(
    (sum, ey, index) => sum + ey * coupled.metadata.classes[index].volume_fraction,
    0,
  );
  if (!finite(target) || Math.abs(mean - target) > 0.005) return null;
  const classIndex = model.classIndex[particleIndex];
  const source = coupled.metadata.classes[classIndex];
  const concentrations = coupled.state.kernel_conc_kg_m3?.[classIndex];
  if (
    !Array.isArray(concentrations) ||
    !Array.isArray(source.shell_outer_radii_m) ||
    concentrations.length !== source.shell_outer_radii_m.length ||
    !concentrations.every(finite) ||
    !finite(source.kernel_radius_m) ||
    source.kernel_radius_m < 0 ||
    !finite(source.initial_kernel_conc_kg_m3) ||
    source.initial_kernel_conc_kg_m3 < 0
  )
    return null;
  if (
    source.shell_outer_radii_m.some(
      (r, i, values) =>
        !finite(r) ||
        r <= 0 ||
        r > source.kernel_radius_m * (1 + 1e-6) ||
        (i > 0 && r <= values[i - 1]),
    )
  )
    return null;
  const surface = coupled.state.surface_remaining_fraction?.[classIndex];
  const initial = source.initial_kernel_conc_kg_m3;
  return {
    classIndex,
    radiusMm: source.radius_m * 1000,
    kernelRadiusMm: source.kernel_radius_m * 1000,
    radiusFraction: Float64Array.from(
      source.shell_outer_radii_m,
      (radius) => radius / source.kernel_radius_m,
    ),
    concentrationKgM3: Float64Array.from(concentrations),
    remainingFraction:
      initial > 0
        ? Float64Array.from(concentrations, (c) => c / initial)
        : concentrations.length === 0
          ? new Float64Array()
          : null,
    surfaceRemainingFraction: finite(surface) ? surface : null,
    source: 'coupled-core',
  };
}
