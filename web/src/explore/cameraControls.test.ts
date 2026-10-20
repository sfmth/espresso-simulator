// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { homeCameraPose, moveCamera } from './cameraControls';

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((v, i) => v - b[i]));

describe('discrete representative-volume camera controls', () => {
  it('orbits around the current target without moving it or changing viewing distance', () => {
    const target = [3, -2, 1] as const;
    const position = [3, -2, 3] as const;
    const right = moveCamera('right', position, target, 1);
    expect(right.target).toEqual(target);
    expect(distance(right.position, target)).toBeCloseTo(2, 12);
    expect(right.position[0]).toBeGreaterThan(position[0]);
    const back = moveCamera('left', right.position, right.target, 1);
    back.position.forEach((v, i) => expect(v).toBeCloseTo(position[i], 12));
    expect(moveCamera('up', position, target, 1).position[1]).toBeGreaterThan(position[1]);
    expect(moveCamera('down', position, target, 1).position[1]).toBeLessThan(position[1]);
  });

  it('zooms along the same sightline and respects near/far interactive distance limits', () => {
    const initial = homeCameraPose(2);
    const near = moveCamera('in', initial.position, initial.target, 2);
    expect(distance(near.position, near.target)).toBeCloseTo(
      distance(initial.position, initial.target) / 1.2,
      12,
    );
    expect(near.position[0] / near.position[2]).toBeCloseTo(
      initial.position[0] / initial.position[2],
      12,
    );
    let pose = initial;
    for (let i = 0; i < 100; i++) pose = moveCamera('in', pose.position, pose.target, 2);
    expect(distance(pose.position, pose.target)).toBeCloseTo(1.2, 12);
    for (let i = 0; i < 100; i++) pose = moveCamera('out', pose.position, pose.target, 2);
    expect(distance(pose.position, pose.target)).toBeCloseTo(10, 12);
  });

  it('avoids crossing the polar singularities and restores the original centre after panning', () => {
    let pose = homeCameraPose(1);
    for (let i = 0; i < 100; i++) pose = moveCamera('up', pose.position, pose.target, 1);
    expect(pose.position.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(pose.position[0], pose.position[2])).toBeGreaterThan(0);
    const reset = moveCamera('reset', [40, -20, 10], [30, -10, 10], 2);
    expect(reset).toEqual({ position: [2.7, 1.8, 3.2], target: [0, 0, 0] });
  });
});
