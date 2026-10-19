// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { Ray, Sphere, Vector3 } from 'three';
import {
  buildContainmentIndex,
  containmentDepthFactor,
  containmentIsOccluded,
  sphereBounds,
  type Projection,
  type Vec3,
} from './renderMath';

const projection: Projection = {
  scaleX: 1.8,
  scaleY: 2.4,
  near: 0.001,
  far: 100,
  widthPx: 1200,
  heightPx: 800,
};

describe('sphere rendering bounds', () => {
  it('tightly bounds perspective silhouettes including large off-axis spheres', () => {
    for (const centre of [
      [0, 0, -3],
      [0.7, -0.5, -2],
      [-0.8, 0.7, -3],
      [0.2, 0.1, -0.31],
    ] as Vec3[]) {
      const radius = 0.3;
      const bounds = sphereBounds(centre, radius, projection)!;
      expect(bounds).not.toBeNull();
      for (let y = 0; y <= 60; y++)
        for (let x = 0; x < 120; x++) {
          const theta = (y * Math.PI) / 60,
            phi = (x * Math.PI) / 60;
          const vx = centre[0] + radius * Math.sin(theta) * Math.cos(phi);
          const vy = centre[1] + radius * Math.sin(theta) * Math.sin(phi);
          const d = -(centre[2] + radius * Math.cos(theta));
          expect((projection.scaleX * vx) / d).toBeGreaterThanOrEqual(bounds.left - 1e-10);
          expect((projection.scaleX * vx) / d).toBeLessThanOrEqual(bounds.right + 1e-10);
          expect((projection.scaleY * vy) / d).toBeGreaterThanOrEqual(bounds.bottom - 1e-10);
          expect((projection.scaleY * vy) / d).toBeLessThanOrEqual(bounds.top + 1e-10);
        }
    }
  });

  it('culls only fully clipped spheres and uses a conservative full-screen bound across the eye', () => {
    expect(sphereBounds([20, 0, -2], 0.1, projection)).toBeNull();
    expect(sphereBounds([0, 0, 2], 0.1, projection)).toBeNull();
    expect(sphereBounds([0, 0, -200], 0.1, projection)).toBeNull();
    expect(sphereBounds([0, 0, 0], 0.1, projection)).toEqual({
      left: -1,
      right: 1,
      bottom: -1,
      top: 1,
    });
    expect(sphereBounds([NaN, 0, -2], 1, projection)).toBeNull();
  });

  it('is smaller than the previous conservative cube projection without changing the sphere', () => {
    const centre: Vec3 = [0.7, 0.5, -2];
    const radius = 0.3;
    const bounds = sphereBounds(centre, radius, projection)!;
    const previousExtent =
      (radius * (-centre[2] + Math.hypot(centre[0], centre[1]))) / (-centre[2] - radius);
    const previousArea =
      (4 * previousExtent ** 2 * projection.scaleX * projection.scaleY) / centre[2] ** 2;
    expect((bounds.right - bounds.left) * (bounds.top - bounds.bottom)).toBeLessThan(
      previousArea * 0.7,
    );
  });
});

describe('conservative hidden-sphere culling', () => {
  it('finds strict enclosing parents deterministically without changing source data', () => {
    const positions = new Float32Array([0, 0, 0, 0.2, 0, 0, 2, 0, 0, 0.99, 0, 0]);
    const radii = new Float32Array([1, 0.1, 0.1, 0.01]);
    const before = positions.slice();
    const result = buildContainmentIndex(positions, radii, 4);
    expect([...result.parentIndex]).toEqual([-1, 0, -1, -1]);
    expect([...result.parentSphere.slice(4, 8)]).toEqual([0, 0, 0, 1]);
    expect(result.containedCount).toBe(1);
    expect(positions).toEqual(before);
    expect(buildContainmentIndex(positions, radii, 4).parentSphere).toEqual(result.parentSphere);
  });
  it('bounds the search to the 32 largest parents and rejects malformed budgets', () => {
    const radii = Float32Array.from({ length: 100 }, (_, i) => 1 + i * 0.01);
    const positions = new Float32Array(300);
    const result = buildContainmentIndex(positions, radii, 10);
    expect(result.candidateCount).toBe(32);
    result.parentIndex.forEach((parent, i) => {
      if (parent >= 0) expect(radii[parent] - radii[i]).toBeGreaterThan(result.marginMm);
    });
    expect(() => buildContainmentIndex(new Float32Array(3), new Float32Array(2), 1)).toThrow(
      RangeError,
    );
    expect(() =>
      buildContainmentIndex(new Float32Array(450003), new Float32Array(150001), 1),
    ).toThrow(RangeError);
  });
  it('retains children when a parent is cut, crosses near/far clipping or contains the eye', () => {
    const child: Vec3 = [0.2, 0, 0],
      parent: Vec3 = [0, 0, 0];
    const view = {
      cutZ: 1,
      near: 0.001,
      far: 40,
      marginMm: 0.00001,
      depthFactor: containmentDepthFactor(projection, 24),
    };
    expect(containmentIsOccluded(child, 0.1, parent, 1, [0, 0, -4], view)).toBe(true);
    expect(containmentIsOccluded(child, 0.1, parent, 1, [0, 0, -4], { ...view, cutZ: -0.1 })).toBe(
      false,
    );
    expect(containmentIsOccluded(child, 0.1, parent, 1, [0, 0, -1], view)).toBe(false);
    expect(containmentIsOccluded(child, 0.1, parent, 1, [0, 0, -39], view)).toBe(false);
    expect(containmentIsOccluded(child, 0.1, parent, 1, [0, 0, -0.5], view)).toBe(false);
    expect(containmentIsOccluded([1, 0, 0], 0.1, parent, 1, [0, 0, -4], view)).toBe(false);
  });
  it('retains shallow geometric overlaps when depth precision could preserve an old draw-order tie', () => {
    const parent: Vec3 = [0, 0, 0];
    const view = {
      cutZ: 1,
      near: 0.001,
      far: 40,
      marginMm: 0.00001,
      depthFactor: containmentDepthFactor(projection, 24),
    };
    expect(containmentIsOccluded([0.899, 0, 0], 0.1, parent, 1, [0, 0, -4], view)).toBe(false);
    expect(containmentDepthFactor(projection, 16)).toBeGreaterThan(view.depthFactor);
    expect(
      containmentIsOccluded([0, 0, 0], 0.1, parent, 1, [0, 0, -4], {
        ...view,
        depthFactor: containmentDepthFactor(projection, 0),
      }),
    ).toBe(false);
  });
  it('keeps the enclosing sphere ahead of every sampled child hit that may be culled', () => {
    const parent = new Sphere(new Vector3(0, 0, -4), 1);
    const child = new Sphere(new Vector3(0.2, 0.1, -4), 0.3);
    const view = {
      cutZ: 1,
      near: projection.near,
      far: projection.far,
      marginMm: 0.00001,
      depthFactor: containmentDepthFactor(projection, 24),
    };
    expect(containmentIsOccluded([0.2, 0.1, -4], 0.3, [0, 0, -4], 1, [0, 0, -4], view)).toBe(true);
    for (let y = -8; y <= 8; y++)
      for (let x = -8; x <= 8; x++) {
        const direction = new Vector3(0.2 + x * 0.025, 0.1 + y * 0.025, -4).normalize();
        const ray = new Ray(new Vector3(), direction);
        const hit = ray.intersectSphere(child, new Vector3());
        if (!hit) continue;
        const cover = ray.intersectSphere(parent, new Vector3());
        expect(cover).not.toBeNull();
        expect(cover!.length()).toBeLessThan(hit.length());
      }
  });
});
