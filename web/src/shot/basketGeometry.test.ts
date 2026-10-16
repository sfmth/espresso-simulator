// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { basketFrame, regionPolygon } from './BasketDiagram';
import {
  checkProfile,
  maxRadius,
  profileIsValid,
  radiusAt,
  volumeBelow,
  wallBetween,
  wallFromRecipe,
  wallFromSpec,
  wallHeight,
} from './basketGeometry';

const STRAIGHT = wallFromRecipe([
  [0, 58],
  [25, 58],
]);
const TAPERED = wallFromRecipe([
  [0, 46],
  [4, 50],
  [12, 55],
  [24, 58],
]);

describe('basket profile checks', () => {
  it('accepts straight, tapered and stepped baskets', () => {
    expect(
      profileIsValid(
        checkProfile(
          [
            [0, 58],
            [25, 58],
          ],
          52,
          null,
        ),
      ),
    ).toBe(true);
    expect(
      profileIsValid(
        checkProfile(
          [
            [0, 46],
            [4, 50],
            [24, 58],
          ],
          40,
          0.4,
        ),
      ),
    ).toBe(true);
    // A stepped wall: two points close together.
    expect(
      profileIsValid(
        checkProfile(
          [
            [0, 50],
            [10, 50],
            [10.01, 56],
            [20, 56],
          ],
          50,
          null,
        ),
      ),
    ).toBe(true);
  });

  it('applies the builder’s rules, row by row', () => {
    const problems = checkProfile(
      [
        [1, 50],
        [1, -2],
        [0.5, 52],
      ],
      51,
      60,
    );
    expect(problems.rows[0]?.height).toMatch(/first point is the floor/);
    expect(problems.rows[1]).toEqual({
      height: 'Heights must increase: 1 mm is not above 1 mm.',
      diameter: 'Diameters must be more than 0 mm.',
    });
    expect(problems.rows[2]?.height).toMatch(/0.5 mm is not above 1 mm/);
    expect(problems.perforated).toBe(
      'The perforated diameter must be at most the floor diameter (50 mm).',
    );
    expect(problems.orifice).toBe('The orifice must be smaller than the perforated diameter.');
    expect(checkProfile([[0, 50]], 40, null).profile).toMatch(/at least two points/);
  });

  it('leaves values that are not numbers to the field checks', () => {
    expect(
      profileIsValid(
        checkProfile(
          [
            [0, 50],
            [Number.NaN, 52],
          ],
          Number.NaN,
          Number.NaN,
        ),
      ),
    ).toBe(true);
  });
});

describe('basket geometry', () => {
  it('converts recipe diameters and spec radii to millimetre wall points', () => {
    expect(wallFromRecipe([[0, 58]])).toEqual([{ z: 0, r: 29 }]);
    expect(wallFromSpec([[0.025, 0.029]])).toEqual([{ z: 25, r: 29 }]);
  });

  it('interpolates the radius linearly and clamps it at the floor and rim', () => {
    expect(radiusAt(TAPERED, 2)).toBe(24);
    expect(radiusAt(TAPERED, 8)).toBeCloseTo(26.25, 12);
    expect(radiusAt(TAPERED, -1)).toBe(23);
    expect(radiusAt(TAPERED, 99)).toBe(29);
    expect(maxRadius(TAPERED)).toBe(29);
    expect(wallHeight(TAPERED)).toBe(24);
  });

  it('integrates volumes as frusta', () => {
    expect(volumeBelow(STRAIGHT, 10)).toBeCloseTo(Math.PI * 29 * 29 * 10, 6);
    // A cone frustum from r = 23 to 25 over 4 mm.
    expect(volumeBelow(TAPERED, 4)).toBeCloseTo(
      (Math.PI * 4 * (23 * 23 + 23 * 25 + 25 * 25)) / 3,
      6,
    );
    expect(volumeBelow(TAPERED, 0)).toBe(0);
    expect(volumeBelow(TAPERED, 24)).toBeGreaterThan(volumeBelow(TAPERED, 12));
  });

  it('lists the wall between two heights, kinks included', () => {
    expect(wallBetween(TAPERED, 2, 13).map((p) => p.z)).toEqual([2, 4, 12, 13]);
  });

  it('draws in millimetres, mirrored about the axis', () => {
    const frame = basketFrame(STRAIGHT);
    expect(frame.x(29) - frame.x(0)).toBe(29);
    expect(frame.x(0) - frame.x(-29)).toBe(29);
    expect(frame.y(0) - frame.y(25)).toBe(25);
    const stretched = basketFrame(STRAIGHT, 2);
    expect(stretched.y(0) - stretched.y(25)).toBe(50);
    const polygon = regionPolygon(STRAIGHT, frame, 0, 10).split(' ');
    expect(polygon).toHaveLength(4);
  });
});
