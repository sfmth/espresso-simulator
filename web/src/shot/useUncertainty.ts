// SPDX-License-Identifier: GPL-2.0-or-later
/** A scenario run has its own result slot and cannot replace the central shot. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError } from '../engine/engine';
import { useEngine } from '../engine/EngineContext';
import type {
  EvidenceMode,
  UncertaintyGroups,
  UncertaintyOptions,
  UncertaintyResult,
} from '../engine/m3Types';
import type { Recipe } from '../engine/shotTypes';
import { physicalKey } from './recipeForm';

export interface UncertaintyOutcome {
  key: string;
  recipe: Recipe;
  options: UncertaintyOptions;
  result: UncertaintyResult;
  runtimeMs: number;
}

export function defaultUncertaintyOptions(recipe: Recipe | null): UncertaintyOptions {
  return {
    samples: 16,
    seed: 1729,
    groups: {
      grinder_psd: recipe?.grinder.psd ? 'measured' : 'unknown',
      roast_age: 'unknown',
      composition: 'unknown',
      water: 'unknown',
    },
  };
}

export const EVIDENCE_MODES: readonly EvidenceMode[] = ['unknown', 'measured', 'fixed'];

export function uncertaintyKey(recipe: Recipe, options: UncertaintyOptions): string {
  return `${physicalKey(recipe)}\n${JSON.stringify(options)}`;
}

export function useUncertainty(recipe: Recipe | null) {
  const engine = useEngine();
  const [sampling, setSampling] = useState({ samples: 16, seed: 1729 });
  const [groupOverrides, setGroupOverrides] = useState<Partial<UncertaintyGroups>>({});
  const hasMeasuredPsd = Boolean(recipe?.grinder.psd);
  const options: UncertaintyOptions = useMemo(
    () => ({
      ...sampling,
      groups: {
        grinder_psd: hasMeasuredPsd ? 'measured' : 'unknown',
        roast_age: 'unknown',
        composition: 'unknown',
        water: 'unknown',
        ...groupOverrides,
      },
    }),
    [sampling, hasMeasuredPsd, groupOverrides],
  );
  const setOptions = (value: UncertaintyOptions) =>
    setSampling({ samples: value.samples, seed: value.seed });
  const setGroup = (group: keyof UncertaintyGroups, value: EvidenceMode) =>
    setGroupOverrides((old) => ({ ...old, [group]: value }));
  const [outcome, setOutcome] = useState<UncertaintyOutcome | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'cancelled' | 'error'>('idle');
  const [runKey, setRunKey] = useState<string | null>(null);
  const [startedController, setStartedController] = useState<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const key = recipe ? uncertaintyKey(recipe, options) : null;

  // Edits cancel an in-flight request; old results remain visibly stale for comparison/export.
  useEffect(() => {
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [key]);

  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setState('cancelled');
  }, []);

  const run = useCallback(() => {
    if (!recipe) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setStartedController(controller);
    setError(null);
    setState('running');
    setRunKey(uncertaintyKey(recipe, options));
    engine.simulateUncertainty(recipe, options, { signal: controller.signal }).then(
      ({ result, runtimeMs }) => {
        if (active.current !== controller) return;
        active.current = null;
        setOutcome({ key: uncertaintyKey(recipe, options), recipe, options, result, runtimeMs });
        setState('done');
      },
      (failure: unknown) => {
        if (active.current !== controller) return;
        active.current = null;
        if (isAbortError(failure)) {
          setState('cancelled');
          return;
        }
        setError(failure instanceof Error ? failure.message : String(failure));
        setState('error');
      },
    );
  }, [engine, recipe, options]);

  const current = outcome !== null && outcome.key === key;
  // The key changes before the effect cleanup, so render the cancelled state immediately.
  const running =
    state === 'running' &&
    runKey === key &&
    startedController !== null &&
    !startedController.signal.aborted;
  const visibleState = state === 'running' && !running ? 'cancelled' : state;
  return {
    options,
    setOptions,
    setGroup,
    outcome,
    current,
    running,
    state: visibleState,
    error: runKey === key ? error : null,
    run,
    cancel,
  };
}
