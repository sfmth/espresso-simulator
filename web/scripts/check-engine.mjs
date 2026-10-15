#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Fails with a clear message if the generated WebAssembly engine (src/engine/pkg/) is missing.
// It is built from the Rust core by scripts/build_wasm.sh and is not committed.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('../src/engine/pkg/', import.meta.url));
const required = ['puckcore.js', 'puckcore.d.ts', 'puckcore_bg.wasm'];
const missing = required.filter((name) => !existsSync(pkgDir + name));

if (missing.length > 0) {
  console.error(
    [
      `error: the WebAssembly engine is missing (${missing.join(', ')} in ${pkgDir}).`,
      'Build it from the Rust core first:',
      '',
      '    npm run wasm        # runs ../scripts/build_wasm.sh',
      '',
      'That needs Rust with the wasm32-unknown-unknown target and the wasm-bindgen CLI',
      '(see web/README.md).',
    ].join('\n'),
  );
  process.exit(1);
}
