// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureResult } from '../../test/fixtures/shotFixture';
import { toShotRunData } from '../engine/shotData';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { buildMicrostructure, frameAt, particleProfile, type MicroOutcome } from './microstructure';

function outcome(): MicroOutcome {
  const build = fixtureBuild(DEFAULT_RECIPE);
  const classes = [
    { radius_m: 20e-6, volume_fraction: 0.12 },
    { radius_m: 80e-6, volume_fraction: 0.28 },
    { radius_m: 240e-6, volume_fraction: 0.6 },
    { radius_m: 300e-6, volume_fraction: 0 },
  ];
  build.spec.bed.size_classes = classes;
  build.spec.bed.intergranular_porosity = 0.42;
  const result = toShotRunData(fixtureResult({ snapshots: 3, classes: 4 }), 0).result;
  const spatial = result.spatial as typeof result.spatial & {
    micro: { column: number; cell: number; classes: Record<string, unknown>[] };
  };
  spatial.micro = {
    column: 0,
    cell: 1,
    classes: classes.map((c, i) => ({
      ...c,
      kernel_radius_m: i === 0 ? 0 : c.radius_m * 0.8,
      pool_fraction: i === 0 ? 1 : 0.2,
      shell_outer_radii_m: i === 0 ? [] : [0.4 * c.radius_m, 0.8 * c.radius_m],
      initial_kernel_conc_kg_m3: i === 0 ? 0 : 500,
    })),
  };
  const yields = [0.25, 0.2, 0.1, 0.08];
  result.spatial.snapshots.forEach((snapshot, index) => {
    const fraction = index / 2;
    snapshot.local_ey[0][1] = classes.reduce(
      (sum, c, i) => sum + c.volume_fraction * yields[i] * fraction,
      0,
    );
    snapshot.liquid_conc_kg_m3[0][1] = 42 * fraction;
    snapshot.wetted_fraction = [
      [1, fraction, 0, 0],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ];
    Object.assign(snapshot, {
      micro: {
        class_ey: yields.map((value) => value * fraction),
        kernel_conc_kg_m3: classes.map((_, i) =>
          i === 0 ? [] : [500 - 100 * fraction, 500 - 400 * fraction],
        ),
        surface_remaining_fraction: classes.map((_, i) => (i === 3 ? null : 1 - fraction)),
      },
      column_flow_m3_s: [fraction * 1.2e-6, fraction * 0.6e-6, 0],
      bed_temperature_c: 92,
    });
  });
  return { build, result };
}

const selected = { snapshotIndex: 2, column: 0, depthCell: 1 };

describe('representative microstructure', () => {
  it('reproduces packing, pore topology and potential from a seed', () => {
    const shot = outcome();
    const options = { count: 400, seed: 743, networkResolution: 6 };
    const a = buildMicrostructure(shot, options);
    const b = buildMicrostructure(shot, options);
    expect(a.positionsMm).toEqual(b.positionsMm);
    expect(a.radiiMm).toEqual(b.radiiMm);
    expect(a.classIndex).toEqual(b.classIndex);
    expect(a.network.edges).toEqual(b.network.edges);
    expect(a.network.pressure).toEqual(b.network.pressure);
    expect(buildMicrostructure(shot, { ...options, seed: 744 }).positionsMm).not.toEqual(
      a.positionsMm,
    );
  });

  it('represents every source class including fines and a zero-weight class, preserving dry-mass shares', () => {
    const model = buildMicrostructure(outcome(), { count: 1000, seed: 1, cutoffUm: 75 });
    const represented = new Set(model.classIndex);
    expect([...represented].sort()).toEqual([0, 1, 2, 3]);
    const shares = new Float64Array(4);
    model.classIndex.forEach((index, i) => {
      shares[index] += model.massWeight[i];
    });
    shares.forEach((share, index) =>
      expect(share).toBeCloseTo(model.classes[index].volume_fraction, 12),
    );
    expect(model.massWeight.reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 12);
    model.classIndex.forEach((index, i) => {
      expect(model.fine[i]).toBe(index === 0 ? 1 : 0);
      expect(model.radiiMm[i]).toBeCloseTo(model.classes[index].radius_m * 1000, 7);
    });
  });

  it('keeps every sphere inside the cube and reports bounded approximate overlaps honestly', () => {
    const model = buildMicrostructure(outcome(), { count: 1800, seed: 2, packingIterations: 3 });
    const volume = model.radiiMm.reduce((sum, r) => sum + (4 * Math.PI * r ** 3) / 3, 0);
    expect(model.domainMm ** 3).toBeCloseTo(volume / (1 - 0.42), 7);
    model.radiiMm.forEach((radius, particle) => {
      for (let axis = 0; axis < 3; axis++)
        expect(Math.abs(model.positionsMm[particle * 3 + axis]) + radius).toBeLessThanOrEqual(
          model.domainMm / 2 + 1e-7,
        );
    });
    expect(model.packing.bounded).toBe(true);
    expect(model.packing.iterations).toBe(3);
    expect(model.packing.checkedPairs).toBeLessThanOrEqual(1800 * 96);
    expect(model.packing.overlapPairs).toBeGreaterThanOrEqual(0);
    expect(model.packing.maxOverlapFraction).toBeGreaterThanOrEqual(0);
    expect(model.notes.join(' ')).toContain('absolute permeability');
    if (!model.packing.auditComplete) expect(model.notes.join(' ')).toContain('lower bounds');
  });

  it('finds and reduces all sphere overlaps when the small audit fits its budget', () => {
    const shot = outcome();
    shot.build.spec.bed.size_classes = [{ radius_m: 0.0001, volume_fraction: 1 }];
    const initial = buildMicrostructure(shot, { count: 60, seed: 1, packingIterations: 0 });
    const relaxed = buildMicrostructure(shot, { count: 60, seed: 1, packingIterations: 12 });
    expect(initial.packing.auditComplete).toBe(true);
    expect(relaxed.packing.auditComplete).toBe(true);
    expect(relaxed.packing.maxOverlapFraction).toBeLessThan(initial.packing.maxOverlapFraction);
    let pairs = 0;
    for (let a = 0; a < 60; a++)
      for (let b = a + 1; b < 60; b++) {
        const distance = Math.hypot(
          ...[0, 1, 2].map(
            (axis) => relaxed.positionsMm[3 * a + axis] - relaxed.positionsMm[3 * b + axis],
          ),
        );
        if (distance < relaxed.radiiMm[a] + relaxed.radiiMm[b]) pairs++;
      }
    expect(relaxed.packing.overlapPairs).toBe(pairs);
  });

  it('solves a geometry-derived pore potential with conserved normalized flux', () => {
    const shot = outcome();
    shot.build.spec.bed.intergranular_porosity = 0.88;
    const model = buildMicrostructure(shot, { count: 400, seed: 7, networkResolution: 8 });
    const network = model.network;
    expect(network.converged).toBe(true);
    expect(network.relativeResidual).toBeLessThan(1e-7);
    expect(network.connected).toBe(true);
    expect(network.outletFlux).toBeCloseTo(network.inletFlux, 5);
    expect(network.maxConservationError).toBeLessThan(1e-5);
    const imbalance = new Float64Array(network.pressure.length);
    network.flow.forEach((flow, edge) => {
      imbalance[network.edges[2 * edge]] += flow;
      imbalance[network.edges[2 * edge + 1]] -= flow;
    });
    const face = network.resolution ** 2;
    let largest = 0;
    for (let i = face; i < imbalance.length - face; i++)
      largest = Math.max(largest, Math.abs(imbalance[i]));
    expect(largest).toBeLessThan(1e-5);
    network.pressure.forEach((pressure) => {
      expect(pressure).toBeGreaterThanOrEqual(-1e-5);
      expect(pressure).toBeLessThanOrEqual(1 + 1e-5);
    });
    for (const node of network.edges) expect(network.clearanceMm[node]).toBeGreaterThan(0);
  });

  it('accepts the high resolution budget and rejects unbounded or malformed generation', () => {
    const shot = outcome();
    const high = buildMicrostructure(shot, {
      count: 150_000,
      seed: 1,
      packingIterations: 0,
      networkResolution: 4,
    });
    expect(high.radiiMm).toHaveLength(150_000);
    expect(high.positionsMm).toHaveLength(450_000);
    expect(high.packing.checkedPairs).toBeLessThanOrEqual(150_000 * 96);
    expect([...new Set(high.classIndex)].sort()).toEqual([0, 1, 2, 3]);
    expect(() => buildMicrostructure(shot, { count: 150_001, seed: 1 })).toThrow(RangeError);
    expect(() => buildMicrostructure(shot, { count: 3, seed: 1 })).toThrow(RangeError);
    expect(() => buildMicrostructure(shot, { count: 10, seed: 1.5 })).toThrow(RangeError);
    expect(() => buildMicrostructure(shot, { count: 10, seed: 1, packingIterations: 21 })).toThrow(
      RangeError,
    );
    expect(() => buildMicrostructure(shot, { count: 10, seed: 1, networkResolution: 19 })).toThrow(
      RangeError,
    );
    expect(() => buildMicrostructure(shot, { count: 10, seed: 1, cutoffUm: NaN })).toThrow(
      RangeError,
    );
    shot.build.spec.bed.size_classes[0].radius_m = 0;
    expect(() => buildMicrostructure(shot, { count: 10, seed: 1 })).toThrow(RangeError);
  });
});

describe('exact coupled micro frames', () => {
  it('recovers dry and end-time local EY under statistical volume weights (G4)', () => {
    const shot = outcome();
    const model = buildMicrostructure(shot, { count: 250, seed: 3 });
    for (let snapshotIndex = 0; snapshotIndex < 3; snapshotIndex++) {
      const frame = frameAt(shot, model, { ...selected, snapshotIndex });
      expect(frame.particleEy).toBeInstanceOf(Float32Array);
      expect(frame.meanEy).toBeCloseTo(frame.targetEy!, 7);
      expect(frame.consistencyErrorPoints).toBeLessThan(0.00001);
      expect(frame.wettedFraction).toBe(snapshotIndex / 2);
    }
    const end = frameAt(shot, model, selected);
    expect(end.localConcentrationKgM3).toBe(42);
    expect(end.columnFlowMlS).toBeCloseTo(1.2, 10);
    expect(end.bedTemperatureC).toBe(92);
    expect(end.pressureBar).toBeGreaterThanOrEqual(0);
  });

  it('returns no particle EY for missing or mismatched cell data, without inventing fields', () => {
    const shot = outcome();
    const model = buildMicrostructure(shot, { count: 250, seed: 3 });
    const other = frameAt(shot, model, { ...selected, column: 1 });
    expect(other.particleEy).toBeNull();
    expect(other.unavailableReason).toContain('selected cell');
    const invalid = frameAt(shot, model, { ...selected, depthCell: 99 });
    expect(invalid.targetEy).toBeNull();
    expect(invalid.unavailableReason).toContain('outside');
    const snapshot = shot.result.spatial.snapshots[2] as unknown as Record<string, unknown>;
    delete snapshot.micro;
    delete snapshot.column_flow_m3_s;
    delete snapshot.bed_temperature_c;
    expect(frameAt(shot, model, selected).particleEy).toBeNull();
    expect(frameAt(shot, model, selected).columnFlowMlS).toBeNull();
    expect(frameAt(shot, model, selected).bedTemperatureC).toBeUndefined();
    expect(particleProfile(shot, model, 0, selected)).toBeNull();
  });

  it('refuses a source class mismatch and inconsistent cell extraction', () => {
    const shot = outcome();
    const model = buildMicrostructure(shot, { count: 250, seed: 3 });
    shot.result.spatial.snapshots[2].local_ey[0][1] = 0.8;
    expect(frameAt(shot, model, selected).particleEy).toBeNull();
    expect(particleProfile(shot, model, 0, selected)).toBeNull();
    expect(frameAt(shot, model, selected).unavailableReason).toContain('0.5 percentage points');
    model.classes[0].radius_m *= 2;
    expect(particleProfile(shot, model, 0, selected)).toBeNull();
  });

  it('copies exact selected class shell values, with kernel-normalized radii and true initial loading', () => {
    const shot = outcome();
    const model = buildMicrostructure(shot, { count: 250, seed: 3 });
    const particle = model.classIndex.findIndex((index) => index === 1);
    const profile = particleProfile(shot, model, particle, selected)!;
    expect(profile.source).toBe('coupled-core');
    expect(profile.classIndex).toBe(1);
    expect(profile.radiusMm).toBeCloseTo(0.08, 12);
    expect(profile.kernelRadiusMm).toBeCloseTo(0.064, 12);
    expect([...profile.radiusFraction]).toEqual([0.5, 1]);
    expect([...profile.concentrationKgM3]).toEqual([400, 100]);
    expect([...profile.remainingFraction!]).toEqual([0.8, 0.2]);
    expect(profile.surfaceRemainingFraction).toBe(0);
    const fine = model.classIndex.findIndex((index) => index === 0);
    expect(particleProfile(shot, model, fine, selected)?.concentrationKgM3).toHaveLength(0);
    expect(particleProfile(shot, model, -1, selected)).toBeNull();
    expect(particleProfile(shot, model, particle, { ...selected, depthCell: 2 })).toBeNull();
    expect(particleProfile(shot, model, particle, { ...selected, snapshotIndex: -1 })).toBeNull();
  });
});
