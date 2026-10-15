// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The engine worker. It owns one WebAssembly instance of puckcore, initialised
 * on the first request, and answers the messages defined in protocol.ts. The
 * simulation runs here, off the main thread, so the page stays responsive.
 *
 * If loading fails, the worker reports an `init` failure and the client
 * replaces it, so there is no retry here.
 */
import init, * as puckcore from './pkg/puckcore.js';
import type { InitOutput } from './pkg/puckcore.js';
import wasmUrl from './pkg/puckcore_bg.wasm?url';
import { failureFor, handleRequest, type EngineResponse } from './protocol';

let ready: Promise<InitOutput> | null = null;

function reply(message: unknown, response: EngineResponse, transfer: Transferable[] = []): void {
  try {
    self.postMessage(response, transfer);
  } catch (error) {
    // E.g. a buffer that cannot be transferred: still answer, so the request never hangs.
    self.postMessage(failureFor(message, 'runtime', error));
  }
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  const start = performance.now();
  ready ??= init({ module_or_path: wasmUrl });
  ready.then(
    (wasm) => {
      const { response, transfer } = handleRequest(puckcore, message, {
        memoryBytes: () => wasm.memory.buffer.byteLength,
      });
      reply(message, response, transfer);
    },
    (error: unknown) => {
      reply(message, failureFor(message, 'init', error, performance.now() - start));
    },
  );
});
