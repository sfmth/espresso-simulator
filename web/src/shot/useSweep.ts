// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Runs a sweep: one engine call per value, in order, so progress shows point
 * by point and the other worker stays free for the live preview. A point the
 * builder rejects (e.g. a dose that does not fit the basket) is recorded with
 * its message and the sweep goes on; a failure of the engine itself stops it.
 * Cancel aborts the point in flight (replacing that worker) and stops; a new
 * sweep supersedes the old one, whose late answers are ignored.
 */
import { useCallback, useEffect, useRef } from 'react';
import { EngineError, isAbortError } from '../engine/engine';
import { useEngine } from '../engine/EngineContext';
import { physicalKey, type FormResult } from './recipeForm';
import { useShotStore } from './shotStore';
import type { SweepPlan } from './sweep';

export interface SweepControls {
  start: (plan: SweepPlan, base: FormResult) => void;
  cancel: () => void;
}

export function useSweep(): SweepControls {
  const engine = useEngine();
  const controller = useRef<AbortController | null>(null);

  const start = useCallback(
    (plan: SweepPlan, base: FormResult) => {
      if (!base.ok) return;
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      const store = useShotStore.getState();
      store.sweepStarted({
        targetId: plan.target.id,
        label: plan.target.label,
        unit: plan.target.unit,
        tier: plan.tier,
        baseKey: physicalKey(base.recipe),
        values: plan.values,
      });
      const run = async () => {
        for (let i = 0; i < plan.recipes.length; i++) {
          if (controller.current !== current) return;
          const x = plan.values[i];
          try {
            const { result } = await engine.sweepPoint(plan.recipes[i], { signal: current.signal });
            if (controller.current !== current) return;
            useShotStore.getState().sweepPointDone({
              x,
              ok: true,
              summary: result.summary,
              warnings: result.diagnostics.warnings ?? [],
            });
          } catch (error) {
            if (isAbortError(error) || controller.current !== current) return;
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof EngineError && error.kind === 'invalid-params') {
              useShotStore.getState().sweepPointDone({ x, ok: false, error: message });
              continue;
            }
            controller.current = null;
            const detail = error instanceof EngineError ? error.detail : undefined;
            useShotStore.getState().sweepFinished('error', message, detail);
            return;
          }
        }
        if (controller.current !== current) return;
        controller.current = null;
        useShotStore.getState().sweepFinished('done');
      };
      void run();
    },
    [engine],
  );

  const cancel = useCallback(() => {
    if (!controller.current) return;
    controller.current.abort();
    controller.current = null;
    useShotStore.getState().sweepFinished('cancelled');
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return { start, cancel };
}
