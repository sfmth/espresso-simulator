// SPDX-License-Identifier: GPL-2.0-or-later
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cargoMetadata,
  pickLicenseFiles,
  runtimeCrates,
  rustNoticesMarkdown,
} from '../scripts/rust-notices.mjs';
import { isAllowedExpression } from '../scripts/spdx.mjs';

/** A cargo-metadata-shaped graph: `deps` maps a package to [dependency, kind] pairs. */
function metadata(packages, deps, members = ['root', 'own']) {
  const id = (name) => `${name} 1.0.0`;
  return {
    workspace_members: members.map(id),
    packages: packages.map(({ name, license = 'MIT', procMacro = false }) => ({
      id: id(name),
      name,
      version: '1.0.0',
      license,
      repository: `https://example.org/${name}`,
      manifest_path: `/registry/${name}-1.0.0/Cargo.toml`,
      targets: [{ kind: [procMacro ? 'proc-macro' : 'lib'] }],
    })),
    resolve: {
      nodes: Object.entries(deps).map(([name, list]) => ({
        id: id(name),
        deps: list.map(([dep, kind = null]) => ({
          pkg: id(dep),
          dep_kinds: [{ kind, target: null }],
        })),
      })),
    },
  };
}

describe('runtimeCrates', () => {
  it('keeps third-party runtime crates, transitively, and drops the rest', () => {
    const graph = metadata(
      [
        { name: 'root', license: 'GPL-2.0-or-later' },
        { name: 'own', license: 'GPL-2.0-or-later' },
        { name: 'bindgen', license: 'MIT OR Apache-2.0' },
        { name: 'shared' },
        { name: 'macro', procMacro: true },
        { name: 'quote' },
        { name: 'builder' },
        { name: 'tester' },
      ],
      {
        root: [['own'], ['bindgen'], ['builder', 'build'], ['tester', 'dev']],
        bindgen: [['shared'], ['macro']],
        macro: [['quote'], ['shared']],
        shared: [],
        own: [],
      },
    );
    const crates = runtimeCrates(graph, 'root');
    expect(crates.map((c) => c.name)).toEqual(['bindgen', 'shared']);
    expect(crates[0]).toMatchObject({
      version: '1.0.0',
      license: 'MIT OR Apache-2.0',
      dir: '/registry/bindgen-1.0.0',
    });
  });

  it('requires the root crate to be a workspace member', () => {
    expect(() => runtimeCrates(metadata([{ name: 'x' }], { x: [] }, []), 'x')).toThrow(/workspace/);
  });
});

describe('pickLicenseFiles', () => {
  const files = ['Cargo.toml', 'LICENSE-APACHE', 'LICENSE-MIT', 'LICENSE-UNICODE', 'README.md'];

  it('ships only the texts of the licences a crate is used under', () => {
    expect(pickLicenseFiles(files, new Set(['MIT']))).toEqual(['LICENSE-MIT']);
    expect(pickLicenseFiles(files, new Set(['MIT', 'Unicode-3.0']))).toEqual([
      'LICENSE-MIT',
      'LICENSE-UNICODE',
    ]);
  });

  it('falls back to every licence file when names do not say which licence they hold', () => {
    expect(pickLicenseFiles(['LICENSE', 'src'], new Set(['MIT']))).toEqual(['LICENSE']);
    expect(pickLicenseFiles(files, null)).toEqual([
      'LICENSE-APACHE',
      'LICENSE-MIT',
      'LICENSE-UNICODE',
    ]);
  });
});

describe('rustNoticesMarkdown', () => {
  it('lists each crate with its licence choice, source and licence text', () => {
    const text = rustNoticesMarkdown(
      [
        {
          name: 'bindgen',
          version: '0.2.0',
          license: 'MIT OR Apache-2.0',
          repository: 'https://example.org/b',
          dir: '/b',
        },
        { name: 'solo', version: '1.0.0', license: 'Zlib', repository: null, dir: '/s' },
      ],
      (dir) => (dir === '/b' ? ['LICENSE-APACHE', 'LICENSE-MIT'] : ['LICENSE']),
      (path) => `text of ${path}\n`,
    );
    expect(text).toContain('# Rust crates in the WebAssembly engine');
    expect(text).toContain('## bindgen - 0.2.0 (MIT OR Apache-2.0)\n\nUsed under MIT.');
    expect(text).toContain('Source: https://example.org/b');
    expect(text).toContain('text of /b/LICENSE-MIT');
    expect(text).not.toContain('LICENSE-APACHE');
    expect(text).toContain('## solo - 1.0.0 (Zlib)');
    expect(text).toContain('text of /s/LICENSE');
    expect(text).not.toContain('Used under Zlib');
  });
});

describe('the real engine (cargo metadata)', () => {
  let meta = null;
  try {
    meta = cargoMetadata(fileURLToPath(new URL('../../Cargo.toml', import.meta.url)));
  } catch {
    // No cargo here: the engine cannot have been built either.
  }

  it.skipIf(meta === null)('lists wasm-bindgen but no compile-time crates, all allowed', () => {
    const crates = runtimeCrates(meta);
    const names = crates.map((c) => c.name);
    expect(names).toContain('wasm-bindgen');
    for (const name of ['wasm-bindgen-macro', 'syn', 'quote', 'proc-macro2', 'puckcore']) {
      expect(names).not.toContain(name);
    }
    for (const crate of crates) expect(isAllowedExpression(crate.license)).toBe(true);
  });
});
