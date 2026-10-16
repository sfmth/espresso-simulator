#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Licence check for the code that ships to browsers (ADR 0007,
// docs/decisions/0007-licensing-and-dependency-policy.md).
//
// 1. npm: walks every production dependency of web/package.json, direct and
//    transitive, through package-lock.json, resolving names the way Node does.
// 2. Rust: lists the third-party crates compiled into the WebAssembly engine
//    (rust-notices.mjs; needs cargo, as building the engine does).
//
// Each package's SPDX licence expression must be satisfiable with the
// allow-list (spdx.mjs). The check exits non-zero on any other licence, a
// missing licence, or an npm dependency it cannot resolve, and warns when a
// package can only be used under Apache-2.0, which makes the build GPLv3 (D12).
// Dev dependencies (build and test tools) are not distributed and not checked.
//
// Dependency-free: Node's standard library only. Run with `npm run licenses`.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cargoMetadata, runtimeCrates } from './rust-notices.mjs';
import { ALLOWED, isAllowedExpression, needsApache } from './spdx.mjs';

export { isAllowedExpression };

/**
 * Reviewed exceptions, as { "package-name": "reason" }. A package listed here
 * passes whatever its licence field says. Keep this empty unless a human has
 * checked the licence text.
 */
const REVIEWED = {};

/** Normalises a package.json `license`/`licenses` value to an SPDX expression (or null). */
function declaredLicense(manifest) {
  const declared = manifest.license ?? manifest.licenses;
  if (typeof declared === 'string') return declared;
  if (declared && typeof declared.type === 'string') return declared.type;
  if (Array.isArray(declared)) {
    const types = declared.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    return types.length ? `(${types.join(' OR ')})` : null;
  }
  return null;
}

/**
 * Judges `{ name, version, license }` rows in place (adding `verdict`) and
 * returns the problems and warnings.
 */
export function judge(rows, { allowed = ALLOWED, reviewed = REVIEWED } = {}) {
  const problems = [];
  const warnings = [];
  for (const row of rows) {
    const id = `${row.name}@${row.version}`;
    if (reviewed[row.name]) {
      row.verdict = `reviewed: ${reviewed[row.name]}`;
      continue;
    }
    if (!row.license) {
      row.verdict = 'NO LICENCE';
      problems.push(`${id} declares no licence`);
      continue;
    }
    let ok = false;
    let malformed = null;
    try {
      ok = isAllowedExpression(row.license, allowed);
    } catch (error) {
      malformed = error.message;
    }
    row.verdict = ok ? 'ok' : 'NOT ALLOWED';
    if (!ok) {
      problems.push(
        malformed
          ? `${id}: ${malformed}`
          : `${id} is licensed "${row.license}", which is not on the allow-list`,
      );
    } else if (needsApache(row.license, allowed)) {
      row.verdict = 'ok (Apache-2.0)';
      warnings.push(`${id} can only be used under Apache-2.0: the combined build is GPLv3 (D12)`);
    }
  }
  return { problems, warnings };
}

/**
 * Checks a parsed package-lock.json (v2+). `readManifest(path)` returns the
 * package.json of an installed package, or null; it is used only when the
 * lockfile lacks a licence field. Returns the visited packages, problems and warnings.
 */
export function checkLockfile(
  lock,
  { allowed = ALLOWED, reviewed = REVIEWED, readManifest = () => null } = {},
) {
  if (!(lock.lockfileVersion >= 2) || typeof lock.packages !== 'object') {
    return {
      rows: [],
      problems: ['package-lock.json must use lockfileVersion 2 or later (npm 7+)'],
      warnings: [],
    };
  }
  const packages = lock.packages;
  const root = packages[''] ?? {};

  /** Installed path of `name` as required from the package at `from` ('' is the root). */
  const resolvePath = (from, name) => {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
      const entry = packages[candidate];
      if (entry) return entry.link ? entry.resolved : candidate;
      if (!base) return null;
      const cut = base.lastIndexOf('node_modules/');
      base = cut <= 0 ? '' : base.slice(0, cut - 1);
    }
  };

  const visited = new Map(); // path -> row, filled in breadth-first order
  const unresolved = [];
  const queue = [];
  const enqueue = (from, name, optional) => {
    const path = resolvePath(from, name);
    if (path === null || !packages[path]) {
      if (!optional) unresolved.push(`${name} (required by ${from || 'the app'}) is not installed`);
      return;
    }
    if (!visited.has(path)) {
      visited.set(path, null);
      queue.push(path);
    }
  };

  for (const name of Object.keys(root.dependencies ?? {})) enqueue('', name, false);
  for (const name of Object.keys(root.optionalDependencies ?? {})) enqueue('', name, true);

  while (queue.length > 0) {
    const path = queue.shift();
    const entry = packages[path];
    const name =
      entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let license = typeof entry.license === 'string' ? entry.license : null;
    if (license === null) {
      const manifest = readManifest(path);
      license = manifest ? declaredLicense(manifest) : null;
    }
    visited.set(path, { name, version: entry.version, license, verdict: '' });
    for (const dep of Object.keys(entry.dependencies ?? {})) enqueue(path, dep, false);
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) enqueue(path, dep, true);
    // Required peers are installed by npm and needed at run time; optional peers are not shipped.
    for (const dep of Object.keys(entry.peerDependencies ?? {})) {
      if (!entry.peerDependenciesMeta?.[dep]?.optional) enqueue(path, dep, false);
    }
  }

  const rows = [...visited.values()].sort((a, b) => a.name.localeCompare(b.name));
  const { problems, warnings } = judge(rows, { allowed, reviewed });
  return { rows, problems: [...unresolved, ...problems], warnings };
}

function printRows(title, rows) {
  console.log(title);
  for (const { name, version, license, verdict } of rows) {
    console.log(`  ${`${name}@${version}`.padEnd(32)} ${String(license).padEnd(36)} ${verdict}`);
  }
}

function main() {
  const webDir = new URL('../', import.meta.url);
  const lockUrl = new URL('package-lock.json', webDir);
  if (!existsSync(lockUrl)) {
    console.error('licence check: web/package-lock.json is missing; run `npm install`.');
    process.exit(1);
  }
  const lock = JSON.parse(readFileSync(lockUrl, 'utf8'));
  const readManifest = (path) => {
    const url = new URL(`${path}/package.json`, webDir);
    return existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : null;
  };
  const npm = checkLockfile(lock, { readManifest });
  printRows('npm production dependencies (bundled into the app):', npm.rows);

  let rust = { rows: [], problems: [], warnings: [] };
  try {
    const manifest = fileURLToPath(new URL('../Cargo.toml', webDir));
    const rows = runtimeCrates(cargoMetadata(manifest)).map(({ name, version, license }) => ({
      name,
      version,
      license,
      verdict: '',
    }));
    rust = { rows, ...judge(rows) };
  } catch (error) {
    rust.problems.push(error.message);
  }
  printRows('\nRust crates compiled into the WebAssembly engine:', rust.rows);

  const problems = [...npm.problems, ...rust.problems];
  const warnings = [...npm.warnings, ...rust.warnings];
  for (const warning of warnings) console.warn(`\nwarning: ${warning}`);
  if (problems.length > 0) {
    console.error(`\nlicence check FAILED (${problems.length} problem(s)):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`\nAllowed: ${[...ALLOWED].join(', ')}.`);
    process.exit(1);
  }
  console.log(
    `\nlicence check passed: ${npm.rows.length} npm packages and ${rust.rows.length} Rust crates, ` +
      'all on the allow-list.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
