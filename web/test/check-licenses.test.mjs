// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { checkLockfile, isAllowedExpression, judge } from '../scripts/check-licenses.mjs';
import { electLicences, needsApache } from '../scripts/spdx.mjs';

describe('isAllowedExpression', () => {
  it.each([
    ['MIT', true],
    ['Apache-2.0', true],
    ['(MIT OR GPL-3.0-only)', true],
    ['MIT AND ISC', true],
    ['(MIT AND CC-BY-4.0)', false],
    ['GPL-3.0-only', false],
    ['SSPL-1.0', false],
    ['BUSL-1.1', false],
    ['CC-BY-NC-4.0', false],
    ['UNLICENSED', false],
    ['Apache-2.0 WITH LLVM-exception', true],
    ['(BSD-3-Clause OR (MIT AND MPL-2.0))', true],
    ['((MIT AND MPL-2.0) OR CC-BY-NC-4.0)', false],
    ['Apache-2.0+', true],
    ['Unicode-DFS-2016', true],
    ['(MIT OR Apache-2.0) AND Unicode-3.0', true],
  ])('%s → %s', (expression, allowed) => {
    expect(isAllowedExpression(expression)).toBe(allowed);
  });

  it.each(['', '(MIT', 'MIT OR', 'AND MIT', 'MIT ISC'])('rejects malformed %j', (expression) => {
    expect(() => isAllowedExpression(expression)).toThrow(/licence expression|parentheses/);
  });
});

describe('electLicences', () => {
  it.each([
    ['MIT OR Apache-2.0', ['MIT']],
    ['Apache-2.0 OR MIT', ['MIT']], // avoids Apache-2.0 when there is a choice
    ['Apache-2.0 OR GPL-3.0-only', ['Apache-2.0']],
    ['(MIT OR Apache-2.0) AND Unicode-3.0', ['MIT', 'Unicode-3.0']],
    ['BSD-3-Clause OR ISC', ['BSD-3-Clause']], // otherwise the first named
    ['GPL-3.0-only', null],
  ])('%s → %j', (expression, expected) => {
    const elected = electLicences(expression);
    expect(elected === null ? null : [...elected]).toEqual(expected);
  });

  it('flags packages that can only be used under Apache-2.0', () => {
    expect(needsApache('Apache-2.0')).toBe(true);
    expect(needsApache('Apache-2.0 WITH LLVM-exception')).toBe(true);
    expect(needsApache('MIT OR Apache-2.0')).toBe(false);
    expect(needsApache('MIT AND Apache-2.0')).toBe(true);
  });
});

describe('judge', () => {
  it('passes allowed licences, warns about Apache-2.0 and fails the rest', () => {
    const rows = [
      { name: 'a', version: '1', license: 'MIT' },
      { name: 'b', version: '1', license: 'Apache-2.0' },
      { name: 'c', version: '1', license: 'MIT OR Apache-2.0' },
      { name: 'd', version: '1', license: 'CC-BY-NC-4.0' },
      { name: 'e', version: '1', license: null },
      { name: 'f', version: '1', license: 'MIT ISC' },
    ];
    const { problems, warnings } = judge(rows);
    expect(rows.map((r) => r.verdict)).toEqual([
      'ok',
      'ok (Apache-2.0)',
      'ok',
      'NOT ALLOWED',
      'NO LICENCE',
      'NOT ALLOWED',
    ]);
    expect(warnings).toEqual([
      'b@1 can only be used under Apache-2.0: the combined build is GPLv3 (D12)',
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[2]).toContain('trailing tokens');
  });
});

/** A minimal lockfile: the app depends on `deps`; `packages` maps names to entries. */
function lockfile(deps, packages) {
  const entries = {
    '': { name: 'app', dependencies: Object.fromEntries(deps.map((d) => [d, '*'])) },
  };
  for (const [path, entry] of Object.entries(packages))
    entries[path] = { version: '1.0.0', ...entry };
  return { lockfileVersion: 3, packages: entries };
}

describe('checkLockfile', () => {
  it('walks transitive and nested dependencies and required peers', () => {
    const lock = lockfile(['a'], {
      'node_modules/a': { license: 'MIT', dependencies: { b: '*' }, peerDependencies: { p: '*' } },
      'node_modules/a/node_modules/b': { license: 'ISC', dependencies: { c: '*' } },
      'node_modules/c': { license: '(MIT OR Apache-2.0)' },
      'node_modules/p': { license: 'BSD-3-Clause' },
      'node_modules/devtool': { license: 'GPL-3.0-only', dev: true },
    });
    const { rows, problems } = checkLockfile(lock);
    expect(problems).toEqual([]);
    expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c', 'p']);
  });

  it('fails on a disallowed or missing licence', () => {
    const lock = lockfile(['a', 'b'], {
      'node_modules/a': { license: 'GPL-3.0-only' },
      'node_modules/b': {},
    });
    const { problems } = checkLockfile(lock);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('GPL-3.0-only');
    expect(problems[1]).toContain('declares no licence');
  });

  it('falls back to the installed package.json for the licence', () => {
    const lock = lockfile(['old'], { 'node_modules/old': {} });
    const { problems, rows } = checkLockfile(lock, {
      readManifest: () => ({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
    });
    expect(problems).toEqual([]);
    expect(rows[0]?.license).toBe('(MIT OR Apache-2.0)');
  });

  it('skips optional peers and missing optional dependencies, but not missing required ones', () => {
    const lock = lockfile(['a'], {
      'node_modules/a': {
        license: 'MIT',
        dependencies: { gone: '*' },
        optionalDependencies: { maybe: '*' },
        peerDependencies: { types: '*' },
        peerDependenciesMeta: { types: { optional: true } },
      },
      'node_modules/types': { license: 'GPL-3.0-only', dev: true },
    });
    const { rows, problems } = checkLockfile(lock);
    expect(rows.map((r) => r.name)).toEqual(['a']);
    expect(problems).toEqual(['gone (required by node_modules/a) is not installed']);
  });

  it('honours reviewed exceptions', () => {
    const lock = lockfile(['odd'], {
      'node_modules/odd': { license: 'SEE LICENSE IN LICENSE.txt' },
    });
    expect(checkLockfile(lock).problems).toHaveLength(1);
    expect(
      checkLockfile(lock, { reviewed: { odd: 'MIT text, checked by hand' } }).problems,
    ).toEqual([]);
  });

  it('rejects old lockfiles', () => {
    expect(checkLockfile({ lockfileVersion: 1, dependencies: {} }).problems[0]).toContain(
      'lockfileVersion',
    );
  });
});
