// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Runs shots for the lab, race-free:
 * - **Automatic**, after edits settle (debounced): a tier-0 preview of the
 *   current recipe with the live preview on, or only a build check with it off
 *   (so the builder's notes and errors still appear next to the inputs).
 * - **Full**, when Run is pressed: the recipe at its own tier (1 by default).
 *
 * Each channel keeps one AbortController; a result is accepted only while its
 * controller is still the current one, so a superseded or cancelled run can
 * never overwrite a newer result (the M0 pattern, lab/useSphereRun.ts). A
 * preview for new inputs supersedes a full run of old ones; Run supersedes
 * everything. When the inputs change back to ones that already have a result,
 * the automatic run in flight is stopped, and a preview or build check that
 * still arrives for inputs no longer on screen is dropped. Aborting a call the
 * engine is executing replaces that worker (WebAssembly cannot be interrupted).
 *
 * Failures are of two kinds: the builder rejecting the recipe (an input error,
 * shown next to the field it names) and the engine itself failing (a trap or a
 * lost worker; the worker is replaced and Retry repeats the run).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { EngineError, isAbortError } from '../engine/engine';
import { useEngine } from '../engine/EngineContext';
import type { Recipe } from '../engine/shotTypes';
import {
  builderErrorPath,
  formToRecipe,
  physicalKey,
  withTier,
  type FormResult,
} from './recipeForm';
import { useShotStore, type BuildCheck, type RunKind } from './shotStore';

/** Quiet time after the last edit before the automatic run. */
export const PREVIEW_DEBOUNCE_MS = 250;

export interface ShotRunControls {
  validation: FormResult;
  /** physicalKey of the current recipe, or null while the form is invalid. */
  key: string | null;
  /** Starts a full run of the current recipe now. */
  run: () => void;
  /** Stops the full run, the automatic run and any pending automatic run. */
  cancel: () => void;
  /** Repeats the run that failed in the engine (its worker has been replaced). */
  retry: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed run as a build check: an input error, or a failure of the engine itself. */
export function failedCheck(key: string, error: unknown): BuildCheck {
  const message = messageOf(error);
  if (error instanceof EngineError && error.kind === 'invalid-params') {
    return {
      key,
      build: null,
      error: message,
      errorPath: builderErrorPath(message),
      errorKind: 'input',
    };
  }
  const detail = error instanceof EngineError ? error.detail : undefined;
  return {
    key,
    build: null,
    error: message,
    errorPath: null,
    errorKind: 'engine',
    ...(detail ? { errorDetail: detail } : {}),
  };
}

export function useShotRun(): ShotRunControls {
  const engine = useEngine();
  const form = useShotStore((s) => s.form);
  const catalog = useShotStore((s) => s.catalog);
  const livePreview = useShotStore((s) => s.livePreview);
  const validation = useMemo(() => formToRecipe(form, { catalog }), [form, catalog]);
  const recipeJson = validation.ok ? JSON.stringify(validation.recipe) : null;
  const key = validation.ok ? physicalKey(validation.recipe) : null;

  const autoController = useRef<AbortController | null>(null);
  const runController = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);
  /** The inputs on screen, for results that arrive later. */
  const currentKey = useRef<string | null>(key);
  /** What failed in the engine last, for Retry. */
  const lastFailure = useRef<RunKind | 'build' | null>(null);
  useEffect(() => {
    currentKey.current = key;
  }, [key]);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** Stops the automatic run in flight (its result would be for other inputs). */
  const stopAuto = useCallback(() => {
    if (!autoController.current) return;
    autoController.current.abort();
    autoController.current = null;
    useShotStore.getState().previewStopped();
  }, []);

  const simulate = useCallback(
    (kind: RunKind, recipe: Recipe, controller: AbortController, owner: typeof runController) => {
      const store = useShotStore.getState();
      if (kind === 'full') store.fullStarted();
      else store.previewStarted();
      const key = physicalKey(recipe);
      const tier = recipe.numerics?.tier === 0 ? 0 : 1;
      engine.simulateRecipe(recipe, { signal: controller.signal }).then(
        ({ result, runtimeMs }) => {
          if (owner.current !== controller) return; // superseded or cancelled
          owner.current = null;
          if (kind === 'preview' && key !== currentKey.current) {
            // The inputs changed while it ran and no newer preview replaced it.
            useShotStore.getState().previewStopped();
            return;
          }
          lastFailure.current = null;
          useShotStore.getState().runSucceeded({
            key,
            recipe,
            kind,
            tier,
            build: result.build,
            result: result.result,
            totalPoints: result.totalPoints,
            runtimeMs,
            coreMs: result.coreMs,
          });
        },
        (error: unknown) => {
          if (isAbortError(error) || owner.current !== controller) return;
          owner.current = null;
          const check = failedCheck(key, error);
          if (kind === 'preview' && key !== currentKey.current && check.errorKind === 'input') {
            useShotStore.getState().previewStopped();
            return;
          }
          lastFailure.current = check.errorKind === 'engine' ? kind : null;
          useShotStore.getState().runFailed(kind, check);
        },
      );
    },
    [engine],
  );

  const startAuto = useCallback(
    (recipe: Recipe, preview: boolean) => {
      clearTimer();
      autoController.current?.abort();
      const controller = new AbortController();
      autoController.current = controller;
      started.current = true;
      if (preview) {
        // The preview is for newer inputs than a full run in flight: it supersedes it.
        if (runController.current) {
          runController.current.abort();
          runController.current = null;
          useShotStore.getState().fullSuperseded();
        }
        simulate('preview', withTier(recipe, 0), controller, autoController);
        return;
      }
      const key = physicalKey(recipe);
      engine.buildShotSpec(recipe, { signal: controller.signal }).then(
        ({ result }) => {
          if (autoController.current !== controller) return;
          autoController.current = null;
          if (key !== currentKey.current) return;
          lastFailure.current = null;
          useShotStore
            .getState()
            .setCheck({ key, build: result, error: null, errorPath: null, errorKind: undefined });
        },
        (error: unknown) => {
          if (isAbortError(error) || autoController.current !== controller) return;
          autoController.current = null;
          if (key !== currentKey.current) return;
          const check = failedCheck(key, error);
          lastFailure.current = check.errorKind === 'engine' ? 'build' : null;
          useShotStore.getState().setCheck(check);
        },
      );
    },
    [engine, clearTimer, simulate],
  );

  const run = useCallback(() => {
    if (!validation.ok) return;
    clearTimer();
    stopAuto();
    runController.current?.abort();
    const controller = new AbortController();
    runController.current = controller;
    started.current = true;
    simulate('full', validation.recipe, controller, runController);
  }, [validation, clearTimer, stopAuto, simulate]);

  const cancel = useCallback(() => {
    const pending = timer.current !== null;
    clearTimer();
    if (!runController.current && !autoController.current && !pending) return;
    runController.current?.abort();
    runController.current = null;
    autoController.current?.abort();
    autoController.current = null;
    useShotStore.getState().runCancelled();
  }, [clearTimer]);

  const retry = useCallback(() => {
    if (!validation.ok) return;
    const failed = lastFailure.current;
    lastFailure.current = null;
    if (failed === 'full') run();
    else startAuto(validation.recipe, livePreview);
  }, [validation, livePreview, run, startAuto]);

  useEffect(() => {
    if (recipeJson === null || catalog === null) {
      stopAuto();
      return;
    }
    const recipe = JSON.parse(recipeJson) as Recipe;
    const current = physicalKey(recipe);
    const state = useShotStore.getState();
    // Nothing new to compute for these inputs: stop an automatic run for others.
    if (state.run.latest?.key === current) {
      stopAuto();
      return;
    }
    if (livePreview && state.run.lastFull?.key === current) {
      // Back to inputs that already have a full result: show it again.
      stopAuto();
      useShotStore.setState((s) => ({
        run: { ...s.run, latest: s.run.lastFull },
        check: s.run.lastFull
          ? { key: current, build: s.run.lastFull.build, error: null, errorPath: null }
          : s.check,
      }));
      return;
    }
    if (!livePreview && state.check?.key === current) {
      stopAuto();
      return;
    }
    timer.current = setTimeout(
      () => {
        timer.current = null;
        startAuto(recipe, livePreview);
      },
      started.current ? PREVIEW_DEBOUNCE_MS : 0,
    );
    return clearTimer;
  }, [recipeJson, livePreview, catalog, startAuto, stopAuto, clearTimer]);

  // Leaving the lab (or unmounting in tests) stops whatever is running.
  useEffect(
    () => () => {
      autoController.current?.abort();
      runController.current?.abort();
    },
    [],
  );

  return { validation, key, run, cancel, retry };
}
