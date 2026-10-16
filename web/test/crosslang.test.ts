// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Cross-language check (docs/PLAN.md §10, M0 exit): the browser engine (the
 * WASM build, run here in Node) must reproduce the golden results in
 * data/fixtures/sphere_cases.json, which the Python tools generate through the
 * native core, bit for bit: every value must be identical (Object.is).
 *
 * Without the fixture the check is skipped locally, but fails in CI (CI set).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPuckcore } from './loadWasm';

/** The golden file; PUCKWORKS_SPHERE_FIXTURE points the check at another copy. */
const FIXTURE =
  process.env.PUCKWORKS_SPHERE_FIXTURE ??
  fileURLToPath(new URL('../../data/fixtures/sphere_cases.json', import.meta.url));
const SCHEMA = 'puckworks.sphere-cases/1';

interface FixtureCase {
  name: string;
  params: {
    radius_m: number;
    diffusivity_m2_s: number;
    n_shells: number;
    t_end_s: number;
    n_steps: number;
    grid: string;
    scheme: string;
  };
  result: {
    t_s: number[];
    released_fraction: number[];
    analytic_fraction: number[];
    shell_outer_radii_m: number[];
    final_profile: number[];
    max_abs_error: number;
    mass_balance_error: number;
  };
}

interface Fixture {
  schema: string;
  core_version: string;
  generator: string;
  cases: FixtureCase[];
}

function loadFixture(): { fixture: Fixture | null; problem: string | null } {
  if (!existsSync(FIXTURE)) return { fixture: null, problem: null };
  try {
    return { fixture: JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture, problem: null };
  } catch (error) {
    return { fixture: null, problem: `cannot read ${FIXTURE}: ${String(error)}` };
  }
}

const { fixture, problem } = loadFixture();
const missing = fixture === null && problem === null;
const MISSING_NOTE =
  `${FIXTURE} does not exist. It is written by the Python tools (M0 workstream C); ` +
  'generate it, then re-run `npm test`.';

/** The first index where the arrays differ in any bit (Object.is), or -1. */
function firstMismatch(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  for (let i = 0; i < expected.length; i++) {
    if (!Object.is(actual[i], expected[i])) return i;
  }
  return -1;
}

describe('cross-language check: WASM vs data/fixtures/sphere_cases.json', () => {
  const cases = fixture?.cases ?? [];
  let values = 0;
  const mismatches: string[] = [];

  afterAll(() => {
    if (cases.length === 0) return;
    console.info(
      `[cross-language] ${cases.length} case(s), ${values} values compared: ` +
        (mismatches.length === 0
          ? 'all bit-identical.'
          : `first mismatches: ${mismatches.join('; ')}.`),
    );
  });

  it('reads a fixture with the expected schema and core version', (ctx) => {
    if (missing) {
      // A missing golden file is a broken checkout in CI, not something to skip.
      if (process.env.CI) expect.fail(`CI requires the fixture. ${MISSING_NOTE}`);
      console.warn(`[cross-language] SKIPPED: ${MISSING_NOTE}`);
      ctx.skip(MISSING_NOTE);
    }
    expect(problem).toBeNull();
    expect(fixture?.schema).toBe(SCHEMA);
    expect(cases.length).toBeGreaterThan(0);
    // Results from another core version are not comparable: regenerate the fixture.
    expect(fixture?.core_version).toBe(loadPuckcore().coreVersion());
  });

  for (const c of cases) {
    it(`reproduces case "${c.name}" exactly`, () => {
      const p = c.params;
      const run = loadPuckcore().simulateSphereRelease(
        p.radius_m,
        p.diffusivity_m2_s,
        p.n_shells,
        p.t_end_s,
        p.n_steps,
        p.grid,
        p.scheme,
      );
      try {
        const fields: [string, ArrayLike<number>, ArrayLike<number>][] = [
          ['t_s', run.times, c.result.t_s],
          ['released_fraction', run.releasedFraction, c.result.released_fraction],
          ['analytic_fraction', run.analyticFraction, c.result.analytic_fraction],
          ['shell_outer_radii_m', run.shellOuterRadii, c.result.shell_outer_radii_m],
          ['final_profile', run.finalProfile, c.result.final_profile],
          ['max_abs_error', [run.maxAbsError], [c.result.max_abs_error]],
          ['mass_balance_error', [run.massBalanceError], [c.result.mass_balance_error]],
        ];
        const problems: string[] = [];
        for (const [name, actual, expected] of fields) {
          values += expected.length;
          if (actual.length !== expected.length) {
            problems.push(`${name}: ${actual.length} values, fixture has ${expected.length}`);
            continue;
          }
          const i = firstMismatch(actual, expected);
          if (i >= 0) {
            problems.push(`${name}[${i}]: WASM ${actual[i]}, fixture ${expected[i]}`);
          }
        }
        mismatches.push(...problems.slice(0, 1).map((m) => `${c.name} ${m}`));
        expect(problems, `${c.name}: values that differ from the fixture`).toEqual([]);
      } finally {
        run.free();
      }
    });
  }
});
