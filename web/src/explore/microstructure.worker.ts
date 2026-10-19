// SPDX-License-Identifier: GPL-2.0-or-later
import { buildMicrostructure, type MicroOptions, type MicroOutcome } from './microstructure';
self.onmessage = (event: MessageEvent<{ outcome: MicroOutcome; options: MicroOptions }>) => {
  try {
    const started = performance.now();
    const model = buildMicrostructure(event.data.outcome, event.data.options);
    const transfer: Transferable[] = [
      model.positionsMm.buffer,
      model.radiiMm.buffer,
      model.classIndex.buffer,
      model.massWeight.buffer,
      model.fine.buffer,
      model.network.positionsMm.buffer,
      model.network.edges.buffer,
      model.network.pressure.buffer,
      model.network.flow.buffer,
      model.network.clearanceMm.buffer,
    ];
    self.postMessage({ model, runtimeMs: performance.now() - started }, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
