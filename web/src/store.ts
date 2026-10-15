// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The app's shared state (docs/PLAN.md §1.2, "one state, many views"): the
 * active mode and Lab view, and the M0 verification panel's inputs and latest
 * run (started by lab/useSphereRun.ts). The shot lab keeps its own store
 * (shot/shotStore.ts).
 */
import { create } from 'zustand';
import type { SphereReleaseParams, SphereRunData } from './engine/types';
import { DEFAULT_SPHERE_FORM, type SphereForm } from './lab/sphereForm';

export type Mode = 'dial-in' | 'lab' | 'explore';

/** The Lab's views: the M1 shot lab, and the M0 particle-kernel verification. */
export type LabView = 'shot' | 'verification';

export const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'dial-in', label: 'Dial-in' },
  { id: 'lab', label: 'Lab' },
  { id: 'explore', label: 'Explore' },
];

/** A finished simulation and the parameters that produced it. */
export interface SphereOutcome {
  params: SphereReleaseParams;
  /** The worker's result: long time series arrive thinned to a few thousand points. */
  result: SphereRunData;
  /** Time spent in the worker, ms. */
  runtimeMs: number;
}

export interface SphereRunState {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  /** The latest successful run. It stays on screen while a newer run is pending, failed or was cancelled. */
  latest: SphereOutcome | null;
  /** Why the last run failed, if it did. */
  error: string | null;
  /**
   * What screen readers hear: the outcome of the last run (finished, failed or
   * cancelled). Starting a run and editing inputs leave it unchanged.
   */
  announcement: string;
}

export interface AppState {
  mode: Mode;
  labView: LabView;
  sphereForm: SphereForm;
  sphereRun: SphereRunState;
  setMode: (mode: Mode) => void;
  setLabView: (view: LabView) => void;
  setSphereField: <K extends keyof SphereForm>(field: K, value: SphereForm[K]) => void;
  resetSphereForm: () => void;
  sphereRunStarted: () => void;
  sphereRunSucceeded: (outcome: SphereOutcome) => void;
  sphereRunFailed: (message: string) => void;
  sphereRunCancelled: () => void;
}

const INITIAL_RUN: SphereRunState = { status: 'idle', latest: null, error: null, announcement: '' };

export const useAppStore = create<AppState>()((set) => ({
  mode: 'lab',
  labView: 'shot',
  sphereForm: DEFAULT_SPHERE_FORM,
  sphereRun: INITIAL_RUN,
  setMode: (mode) => set({ mode }),
  setLabView: (labView) => set({ labView }),
  setSphereField: (field, value) =>
    set((state) => ({ sphereForm: { ...state.sphereForm, [field]: value } })),
  resetSphereForm: () => set({ sphereForm: DEFAULT_SPHERE_FORM }),
  sphereRunStarted: () =>
    set((state) => ({ sphereRun: { ...state.sphereRun, status: 'running', error: null } })),
  sphereRunSucceeded: (outcome) =>
    set({
      sphereRun: {
        status: 'done',
        latest: outcome,
        error: null,
        announcement: `Run finished. Max abs error ${outcome.result.maxAbsError.toExponential(2)}.`,
      },
    }),
  sphereRunFailed: (message) =>
    set((state) => ({
      sphereRun: {
        ...state.sphereRun,
        status: 'error',
        error: message,
        announcement: `Run failed: ${message}`,
      },
    })),
  sphereRunCancelled: () =>
    set((state) => ({
      sphereRun: { ...state.sphereRun, status: 'cancelled', announcement: 'Run cancelled.' },
    })),
}));

/** Restores the initial state (used by tests), optionally on another Lab view. */
export function resetAppStore(labView: LabView = 'shot'): void {
  useAppStore.setState({
    mode: 'lab',
    labView,
    sphereForm: DEFAULT_SPHERE_FORM,
    sphereRun: INITIAL_RUN,
  });
}
