// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Loads the generated WebAssembly engine in Node, the same module the browser
 * runs. Fails if src/engine/pkg/ is missing: build it with `npm run wasm`.
 * Works in Node and in jsdom test environments.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as puckcore from '../src/engine/pkg/puckcore.js';

export type Puckcore = typeof puckcore;

function wasmPath(): string {
  // String paths only: under jsdom the global URL is jsdom's, which node:fs does not accept.
  if (import.meta.url.startsWith('file:')) {
    return resolve(dirname(fileURLToPath(import.meta.url)), '../src/engine/pkg/puckcore_bg.wasm');
  }
  // Vitest runs from web/ (its config lives there).
  return resolve(process.cwd(), 'src/engine/pkg/puckcore_bg.wasm');
}

let loaded = false;

export function loadPuckcore(): Puckcore {
  if (!loaded) {
    puckcore.initSync({ module: readFileSync(wasmPath()) });
    loaded = true;
  }
  return puckcore;
}
