// SPDX-License-Identifier: GPL-2.0-or-later
import { useEffect, useState } from 'react';
import type { Microstructure, MicroOutcome } from './microstructure';
interface Packed {
  outcome: MicroOutcome;
  count: number;
  model: Microstructure;
  runtimeMs: number;
}
export function useMicrostructure(outcome: MicroOutcome | null, count: number, active: boolean) {
  const [packed, setPacked] = useState<Packed | null>(null);
  const [failure, setFailure] = useState<{
    outcome: MicroOutcome;
    count: number;
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!outcome || !active || (packed?.outcome === outcome && packed.count === count)) return;
    if (typeof Worker === 'undefined') return;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./microstructure.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Worker construction can be rejected synchronously by browser security policy.
      setFailure({
        outcome,
        count,
        message: 'Particle worker could not start. The cross-section remains available.',
      });
      return;
    }
    let closed = false;
    worker.onmessage = (
      event: MessageEvent<{ model?: Microstructure; runtimeMs?: number; error?: string }>,
    ) => {
      if (closed) return;
      if (event.data.model)
        setPacked({
          outcome,
          count,
          model: event.data.model,
          runtimeMs: event.data.runtimeMs ?? 0,
        });
      else
        setFailure({ outcome, count, message: event.data.error ?? 'Particle generation failed.' });
      worker.terminate();
    };
    worker.onerror = () => {
      if (closed) return;
      setFailure({ outcome, count, message: 'Particle worker could not start. Reload to retry.' });
      worker.terminate();
    };
    try {
      worker.postMessage({
        outcome: { build: outcome.build, result: outcome.result },
        options: { seed: 20261018, count },
      });
    } catch {
      closed = true;
      worker.terminate();
      setFailure({
        outcome,
        count,
        message:
          'Particle data could not be sent to the worker. The cross-section remains available.',
      });
    }
    return () => {
      closed = true;
      worker.terminate();
    };
  }, [outcome, count, active, packed]);
  const current = packed?.outcome === outcome && packed.count === count ? packed : null;
  const error =
    typeof Worker === 'undefined'
      ? 'Particle workers are unavailable. The cross-section remains available.'
      : failure?.outcome === outcome && failure.count === count
        ? failure.message
        : null;
  return {
    model: current?.model ?? null,
    runtimeMs: current?.runtimeMs ?? null,
    error,
    loading: !!outcome && !current && !error,
  };
}
