// SPDX-License-Identifier: GPL-2.0-or-later
//
// Third-party Rust crates compiled into the WebAssembly engine, for the
// licence notices that ship with the site (vite.config.ts appends them to
// dist/third-party-licenses.md) and for the licence check (check-licenses.mjs).
//
// The list comes from `cargo metadata` for the wasm32 target: the runtime
// dependencies of puckcore-wasm, transitively, without proc-macro crates
// (which run only at compile time), build dependencies or our own crates.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { electLicences } from './spdx.mjs';

export const WASM_TARGET = 'wasm32-unknown-unknown';
export const ENGINE_CRATE = 'puckcore-wasm';

/**
 * Runs `cargo metadata` for the workspace, resolved for the WebAssembly target.
 * Cargo is needed anyway to build the engine; ~/.cargo/bin is tried as well.
 * @param {string} manifestPath path of the workspace Cargo.toml
 */
export function cargoMetadata(manifestPath) {
  const path = [process.env.PATH, join(homedir(), '.cargo', 'bin')].filter(Boolean).join(delimiter);
  try {
    const output = execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--filter-platform',
        WASM_TARGET,
        '--manifest-path',
        manifestPath,
      ],
      {
        env: { ...process.env, PATH: path },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return JSON.parse(output);
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : String(error?.message ?? error);
    throw new Error(
      `cannot list the Rust crates in the WebAssembly engine with \`cargo metadata\` (${detail}). ` +
        'Cargo is required, as for `npm run wasm`.',
      { cause: error },
    );
  }
}

/**
 * The engine's third-party runtime crates, sorted by name.
 * @param {any} metadata output of `cargo metadata --filter-platform <target>`
 * @returns {{ name: string, version: string, license: string | null, repository: string | null, dir: string }[]}
 */
export function runtimeCrates(metadata, root = ENGINE_CRATE) {
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(metadata.workspace_members);
  const start = metadata.packages.find((p) => p.name === root && members.has(p.id));
  if (!start) throw new Error(`crate ${root} is not in the workspace`);
  const isProcMacro = (pkg) => pkg.targets.some((t) => t.kind.includes('proc-macro'));
  const seen = new Set([start.id]);
  const queue = [start.id];
  const crates = [];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const dep of nodes.get(id)?.deps ?? []) {
      const normal = dep.dep_kinds.some((k) => k.kind === null);
      const pkg = packages.get(dep.pkg);
      if (!normal || !pkg || seen.has(dep.pkg) || isProcMacro(pkg)) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
      if (!members.has(dep.pkg)) {
        crates.push({
          name: pkg.name,
          version: pkg.version,
          license: pkg.license ?? null,
          repository: pkg.repository ?? null,
          dir: dirname(pkg.manifest_path),
        });
      }
    }
  }
  return crates.sort((a, b) => a.name.localeCompare(b.name));
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;
const FAMILIES = ['mit', 'apache', 'unicode', 'bsd', 'isc', 'zlib', 'cc0', 'blueoak'];

/**
 * Licence files to ship for a crate: those for the licences it is used under
 * when the file names say which licence they hold (LICENSE-MIT,
 * LICENSE-APACHE, …), otherwise every licence file.
 * @param {string[]} files file names in the crate's directory
 * @param {Set<string> | null} elected
 */
export function pickLicenseFiles(files, elected) {
  const candidates = files.filter((f) => LICENSE_FILE.test(f)).sort();
  if (!elected) return candidates;
  const wanted = [...elected].map((id) => id.toLowerCase());
  const chosen = candidates.filter((f) => {
    const family = FAMILIES.find((name) => f.toLowerCase().includes(name));
    return family !== undefined && wanted.some((id) => id.includes(family));
  });
  return chosen.length > 0 ? chosen : candidates;
}

/**
 * Markdown notices for the crates, with their licence texts.
 * @param {ReturnType<typeof runtimeCrates>} crates
 */
export function rustNoticesMarkdown(crates, readDir = readdirSync, readFile = readFileSync) {
  let text =
    '\n# Rust crates in the WebAssembly engine\n\n' +
    'The engine (assets/puckcore_bg-*.wasm) is compiled from the Puckworks crates puckcore and ' +
    'puckcore-wasm (GPL-2.0-or-later) and from the following third-party crates. Where a crate ' +
    'offers a choice of licences, the one Puckworks uses is named.\n';
  for (const crate of crates) {
    const elected = crate.license ? electLicences(crate.license) : null;
    text += `\n## ${crate.name} - ${crate.version} (${crate.license ?? 'no licence declared'})\n`;
    if (elected && /\bOR\b/.test(crate.license))
      text += `\nUsed under ${[...elected].join(' AND ')}.\n`;
    if (crate.repository) text += `\nSource: ${crate.repository}\n`;
    for (const file of pickLicenseFiles(readDir(crate.dir), elected)) {
      text += `\n${String(readFile(join(crate.dir, file), 'utf8')).trim()}\n`;
    }
  }
  return text;
}

/**
 * The notices section for the engine of the workspace at `manifestPath`.
 * @param {string} manifestPath
 * @returns {string}
 */
export function engineNotices(manifestPath) {
  return rustNoticesMarkdown(runtimeCrates(cargoMetadata(manifestPath)));
}
