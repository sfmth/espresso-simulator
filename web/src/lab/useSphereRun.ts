// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Runs the sphere simulation for the panel: automatically (debounced) when the
 * inputs change and the run is small, or on demand. A new run cancels the one
 * in flight, so a stale result can never overwrite a newer one.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isAbortError } from '../engine/engine';
import { useEngine } from '../engine/EngineContext';
import type { SphereReleaseParams } from '../engine/types';
import { useAppStore } from '../store';
import { canAutoRun, validateSphereForm, type SphereFormResult } from './sphereForm';

/** Quiet time after the last keystroke before an automatic run. */
export const AUTO_RUN_DEBOUNCE_MS = 300;

export interface SphereRunControls {
  validation: SphereFormResult;
  /** False when the inputs are invalid or the run is too large to start by itself. */
  autoRun: boolean;
  /** Starts a run with the current inputs now (dropping any pending automatic run). */
  run: () => void;
  /** Stops the run in flight and any pending automatic run. */
  cancel: () => void;
}

export function useSphereRun(): SphereRunControls {
  const engine = useEngine();
  const form = useAppStore((s) => s.sphereForm);
  const validation = useMemo(() => validateSphereForm(form), [form]);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRun = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const start = useCallback(
    (params: SphereReleaseParams) => {
      clearTimer();
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      hasRun.current = true;
      useAppStore.getState().sphereRunStarted();
      engine.simulateSphereRelease(params, { signal: current.signal }).then(
        ({ result, runtimeMs }) => {
          if (controller.current !== current) return; // superseded or cancelled
          controller.current = null;
          useAppStore.getState().sphereRunSucceeded({ params, result, runtimeMs });
        },
        (error: unknown) => {
          if (isAbortError(error) || controller.current !== current) return;
          controller.current = null;
          const message = error instanceof Error ? error.message : String(error);
          useAppStore.getState().sphereRunFailed(message);
        },
      );
    },
    [engine, clearTimer],
  );

  const cancel = useCallback(() => {
    const pending = timer.current !== null;
    clearTimer();
    if (!controller.current && !pending) return;
    controller.current?.abort();
    controller.current = null;
    useAppStore.getState().sphereRunCancelled();
  }, [clearTimer]);

  const run = useCallback(() => {
    if (validation.ok) start(validation.params);
  }, [validation, start]);

  const autoRun = validation.ok && canAutoRun(validation.params);
  // A value key, so that re-typing the same numbers does not trigger a run.
  const autoRunKey = autoRun ? JSON.stringify(validation.params) : null;

  useEffect(() => {
    if (autoRunKey === null) return;
    const params = JSON.parse(autoRunKey) as SphereReleaseParams;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        start(params);
      },
      hasRun.current ? AUTO_RUN_DEBOUNCE_MS : 0,
    );
    return clearTimer;
  }, [autoRunKey, start, clearTimer]);

  // Leaving the page (or unmounting in tests) cancels the run in flight.
  useEffect(() => () => controller.current?.abort(), []);

  return { validation, autoRun, run, cancel };
}
