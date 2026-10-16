// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Cross-language check of the M1 shot API (docs/model/m1-contract.md §2 and §7):
 * the browser engine (the WASM build, run here in Node) must reproduce the
 * golden file data/fixtures/shot_cases.json, which the Python tools write
 * through the native core (`puckworks-tools shot-fixtures`), bit for bit.
 *
 * Fixture shape (`puckworks.shot-cases/1`):
 *   {schema, core_version, generator, cases: [{name, recipe, spec, result}]}
 * where `spec` is `build.spec` of `simulate_recipe(recipe)` and `result` its
 * result. For every case:
 * - `buildShotSpec(recipe).spec` must equal `spec`;
 * - `simulateRecipe(recipe)` must return that spec and `result`;
 * - `simulateShot(spec)` must return `result`.
 * Every number must be identical (Object.is), every string, boolean and null
 * equal, and both documents must have the same keys. `core_version` inside a
 * result is not compared (the file's core_version is checked once, up front);
 * the file carries no timing fields.
 *
 * Without the fixture the check is skipped locally but fails in CI (CI set).
 * PUCKWORKS_SHOT_FIXTURE points it at another copy. PUCKWORKS_SHOT_RESULTS=skip
 * skips only the result comparisons (the spec comparisons always run); CI never
 * sets it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPuckcore } from './loadWasm';

const FIXTURE =
  process.env.PUCKWORKS_SHOT_FIXTURE ??
  fileURLToPath(new URL('../../data/fixtures/shot_cases.json', import.meta.url));
const SCHEMA = 'puckworks.shot-cases/1';
const SKIP_RESULTS = process.env.PUCKWORKS_SHOT_RESULTS === 'skip';
/** Fields of a result that are not compared value by value. */
const IGNORED_RESULT_KEYS = new Set(['core_version']);
/** Mismatches listed per comparison before the rest are only counted. */
const MAX_LISTED = 5;

interface ShotCase {
  name: string;
  recipe: Record<string, unknown>;
  spec: Record<string, unknown>;
  result: Record<string, unknown>;
}

interface ShotFixture {
  schema: string;
  core_version: string;
  generator: string;
  cases: ShotCase[];
}

function loadFixture(): { fixture: ShotFixture | null; problem: string | null } {
  if (!existsSync(FIXTURE)) return { fixture: null, problem: null };
  try {
    return { fixture: JSON.parse(readFileSync(FIXTURE, 'utf8')) as ShotFixture, problem: null };
  } catch (error) {
    return { fixture: null, problem: `cannot read ${FIXTURE}: ${String(error)}` };
  }
}

const { fixture, problem } = loadFixture();
const missing = fixture === null && problem === null;
const MISSING_NOTE =
  `${FIXTURE} does not exist. It is written by the Python tools ` +
  '(`puckworks-tools shot-fixtures`, M1 workstream C); generate it, then re-run `npm test`.';

/** Result of comparing two JSON documents. */
interface JsonComparison {
  /** Numbers compared. */
  values: number;
  /** Total differences found. */
  differences: number;
  /** The first few differences, each with its path. */
  listed: string[];
  /** Number differences whose two values are neighbouring doubles (differ in the last bit). */
  lastBit: number;
  /** Largest relative difference |a − e| / max(|a|, |e|) among the numbers that differ. */
  maxRelative: number;
  /** Top-level path segments (e.g. `series.tds_cup`) holding the differing numbers. */
  fields: Set<string>;
}

/** True if `a` and `b` are finite doubles one unit in the last place apart. */
function adjacentDoubles(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.sign(a) !== Math.sign(b)) return false;
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, a);
  view.setFloat64(8, b);
  const diff = view.getBigInt64(0) - view.getBigInt64(8);
  return diff === 1n || diff === -1n;
}

/**
 * Compares `actual` with `expected` exactly: numbers with Object.is, other
 * scalars with ===, arrays by length and element, objects by key set and value.
 * Keys in `ignore` are skipped at the top level.
 */
function compareJson(
  actual: unknown,
  expected: unknown,
  ignore: ReadonlySet<string> = new Set(),
): JsonComparison {
  const out: JsonComparison = {
    values: 0,
    differences: 0,
    listed: [],
    lastBit: 0,
    maxRelative: 0,
    fields: new Set(),
  };
  const differ = (path: string, message: string) => {
    out.differences += 1;
    if (out.listed.length < MAX_LISTED) out.listed.push(`${path || '(document)'}: ${message}`);
  };
  const walk = (a: unknown, e: unknown, path: string, top: boolean) => {
    if (typeof e === 'number') {
      out.values += 1;
      if (typeof a !== 'number') differ(path, `expected the number ${e}, got ${JSON.stringify(a)}`);
      else if (!Object.is(a, e)) {
        if (adjacentDoubles(a, e)) out.lastBit += 1;
        const scale = Math.max(Math.abs(a), Math.abs(e));
        if (scale > 0) out.maxRelative = Math.max(out.maxRelative, Math.abs(a - e) / scale);
        out.fields.add(path.replace(/\[\d+\].*$/, ''));
        differ(path, `WASM ${a}, fixture ${e}`);
      }
      return;
    }
    if (Array.isArray(e)) {
      if (!Array.isArray(a)) return differ(path, 'expected an array');
      if (a.length !== e.length) {
        return differ(path, `WASM has ${a.length} items, the fixture ${e.length}`);
      }
      e.forEach((item, i) => walk(a[i], item, `${path}[${i}]`, false));
      return;
    }
    if (typeof e === 'object' && e !== null) {
      if (typeof a !== 'object' || a === null || Array.isArray(a)) {
        return differ(path, 'expected an object');
      }
      const actualKeys = Object.keys(a).filter((k) => !(top && ignore.has(k)));
      const expectedKeys = Object.keys(e).filter((k) => !(top && ignore.has(k)));
      const extra = actualKeys.filter((k) => !(k in e));
      const lacking = expectedKeys.filter((k) => !(k in a));
      if (extra.length > 0) differ(path, `keys only in the WASM output: ${extra.join(', ')}`);
      if (lacking.length > 0) differ(path, `keys only in the fixture: ${lacking.join(', ')}`);
      for (const key of expectedKeys) {
        if (key in a) {
          walk(
            (a as Record<string, unknown>)[key],
            (e as Record<string, unknown>)[key],
            path ? `${path}.${key}` : key,
            false,
          );
        }
      }
      return;
    }
    if (a !== e) differ(path, `WASM ${JSON.stringify(a)}, fixture ${JSON.stringify(e)}`);
  };
  walk(actual, expected, '', true);
  return out;
}

function describeComparison(what: string, c: JsonComparison): string {
  if (c.differences === 0) return `${what}: ${c.values} numbers identical`;
  const bits = c.lastBit > 0 ? `, ${c.lastBit} of them in the last bit only` : '';
  return (
    `${what}: ${c.differences} of ${c.values} values differ (largest relative difference ` +
    `${c.maxRelative.toExponential(2)}${bits}) in ${[...c.fields].join(', ')}; ` +
    `first: ${c.listed.join('; ')}`
  );
}

describe('cross-language check: WASM vs data/fixtures/shot_cases.json', () => {
  const cases = fixture?.cases ?? [];
  const report: string[] = [];
  let compared = 0;

  afterAll(() => {
    if (cases.length === 0) return;
    console.info(
      `[cross-language shot] ${cases.length} case(s), ${compared} numbers compared` +
        (SKIP_RESULTS ? ' (result comparisons SKIPPED: PUCKWORKS_SHOT_RESULTS=skip)' : '') +
        (report.length === 0 ? ': all bit-identical.' : `:\n  ${report.join('\n  ')}`),
    );
  });

  it('reads a fixture with the expected schema and core version', (ctx) => {
    if (missing) {
      // A missing golden file is a broken checkout in CI, not something to skip.
      if (process.env.CI) expect.fail(`CI requires the fixture. ${MISSING_NOTE}`);
      console.warn(`[cross-language shot] SKIPPED: ${MISSING_NOTE}`);
      ctx.skip(MISSING_NOTE);
    }
    expect(problem).toBeNull();
    expect(fixture?.schema).toBe(SCHEMA);
    expect(cases.length).toBeGreaterThan(0);
    // Results from another core version are not comparable: regenerate the fixture.
    expect(fixture?.core_version).toBe(loadPuckcore().coreVersion());
    for (const c of cases) {
      expect(Object.keys(c).sort(), `case ${c.name} keys`).toEqual(
        ['name', 'recipe', 'result', 'spec'].sort(),
      );
    }
  });

  for (const c of cases) {
    it(`builds the fixture's spec for "${c.name}" exactly`, () => {
      const built = JSON.parse(loadPuckcore().buildShotSpec(JSON.stringify(c.recipe))) as {
        spec: unknown;
      };
      const comparison = compareJson(built.spec, c.spec);
      compared += comparison.values;
      if (comparison.differences > 0) {
        report.push(`${c.name}: ${describeComparison('buildShotSpec spec', comparison)}`);
      }
      expect(comparison.listed, describeComparison(`${c.name} spec`, comparison)).toEqual([]);
    });

    it.skipIf(SKIP_RESULTS)(`simulateRecipe reproduces "${c.name}" exactly`, () => {
      const run = JSON.parse(loadPuckcore().simulateRecipe(JSON.stringify(c.recipe))) as {
        build: { spec: unknown };
        result: unknown;
      };
      const spec = compareJson(run.build.spec, c.spec);
      const result = compareJson(run.result, c.result, IGNORED_RESULT_KEYS);
      compared += spec.values + result.values;
      const problems = [spec, result].flatMap((r) => r.listed);
      if (spec.differences > 0) {
        report.push(`${c.name}: ${describeComparison('simulateRecipe spec', spec)}`);
      }
      if (result.differences > 0) {
        report.push(`${c.name}: ${describeComparison('simulateRecipe result', result)}`);
      }
      expect(problems, describeComparison(`${c.name} result`, result)).toEqual([]);
    });

    it.skipIf(SKIP_RESULTS)(`simulateShot on the fixture's spec reproduces "${c.name}"`, () => {
      const result = JSON.parse(loadPuckcore().simulateShot(JSON.stringify(c.spec))) as unknown;
      const comparison = compareJson(result, c.result, IGNORED_RESULT_KEYS);
      compared += comparison.values;
      if (comparison.differences > 0) {
        report.push(`${c.name}: ${describeComparison('simulateShot result', comparison)}`);
      }
      expect(comparison.listed, describeComparison(`${c.name} result`, comparison)).toEqual([]);
    });
  }
});

describe('compareJson', () => {
  it('accepts identical documents and counts their numbers', () => {
    const doc = { a: [1, 2.5, -0], b: { c: 'x', d: null, e: true } };
    expect(compareJson(structuredClone(doc), doc)).toEqual({
      values: 3,
      differences: 0,
      listed: [],
      lastBit: 0,
      maxRelative: 0,
      fields: new Set(),
    });
  });

  it('tells 0 from −0 and spots a last-bit difference', () => {
    const next = 0.1 + Number.EPSILON / 16; // the double after 0.1
    expect(next).not.toBe(0.1);
    const c = compareJson({ x: [0, next] }, { x: [-0, 0.1] });
    expect(c.differences).toBe(2);
    expect(c.lastBit).toBe(1);
    expect(c.listed[0]).toBe('x[0]: WASM 0, fixture 0');
    expect(c.fields).toEqual(new Set(['x']));
    expect(c.maxRelative).toBeCloseTo(Number.EPSILON / 16 / next, 20);
  });

  it('reports missing and extra keys, length changes and type changes', () => {
    const c = compareJson({ a: [1], b: 'y', extra: 1 }, { a: [1, 2], b: 2, gone: 3 });
    expect(c.listed).toEqual([
      '(document): keys only in the WASM output: extra',
      '(document): keys only in the fixture: gone',
      'a: WASM has 1 items, the fixture 2',
      'b: expected the number 2, got "y"',
    ]);
  });

  it('skips ignored keys at the top level only', () => {
    expect(
      compareJson(
        { core_version: 'a', x: 1 },
        { core_version: 'b', x: 1 },
        new Set(['core_version']),
      ).differences,
    ).toBe(0);
    expect(
      compareJson(
        { s: { core_version: 'a' } },
        { s: { core_version: 'b' } },
        new Set(['core_version']),
      ).differences,
    ).toBe(1);
  });
});
