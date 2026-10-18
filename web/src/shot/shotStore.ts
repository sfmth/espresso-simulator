// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * State of the shot lab (M1 Lab view): the catalog from the engine, the recipe
 * editor's form, the latest runs, pinned runs and sweeps. Runs are started by
 * useShotRun.ts and useSweep.ts; this module only records their outcomes.
 *
 * Two kinds of run reach the same result slot: a live **preview** (tier 0,
 * started by edits) and a **full** run (the recipe's tier, started by Run).
 * Each outcome carries the physical key of its recipe, so the view can tell
 * whether it belongs to the current inputs.
 */
import { create } from 'zustand';
import type { ShotResultData } from '../engine/shotData';
import type { BuiltSpec, Catalog, Recipe, Summary } from '../engine/shotTypes';
import {
  defaultForm,
  dropUnknownOverrides,
  formToRecipe,
  recipeToForm,
  type RecipeForm,
} from './recipeForm';
import { browserStorage, loadDraft } from './storage';

export type RunKind = 'preview' | 'full';

/** A finished shot and what produced it. */
export interface ShotOutcome {
  /** `physicalKey` of the recipe that ran. */
  key: string;
  /** The recipe as run (its tier is the one that ran). */
  recipe: Recipe;
  kind: RunKind;
  tier: 0 | 1;
  build: BuiltSpec;
  result: ShotResultData;
  /** Output times the core produced (the series may hold fewer if thinned). */
  totalPoints: number;
  /** Time in the worker, ms. */
  runtimeMs: number;
  /** Time inside the core call, ms. */
  coreMs: number;
  /** Run number in this session, for labels. */
  seq: number;
}

/** The engine's verdict on a set of inputs: the build, or why it failed. */
export interface BuildCheck {
  key: string;
  build: BuiltSpec | null;
  error: string | null;
  /** The editor input the error names (recipeForm.builderErrorPath), if any. */
  errorPath: string | null;
  /**
   * `input`: the builder rejected the recipe (fix the inputs); `engine`: the
   * engine itself failed (a trap or a lost worker), and the worker was replaced.
   */
  errorKind?: 'input' | 'engine';
  /** For an engine failure: the core's panic message, for bug reports. */
  errorDetail?: string;
}

/** A single-step undo of something that replaced the editor's contents. */
export interface Undo {
  form: RecipeForm;
  /** The button's label: "Undo reset", "Undo load", … */
  label: string;
}

export interface ShotRunState {
  previewRunning: boolean;
  fullRunning: boolean;
  /** Outcome of the last full run: shown until the inputs change. */
  status: 'idle' | 'done' | 'error' | 'cancelled';
  latest: ShotOutcome | null;
  lastFull: ShotOutcome | null;
  /** Why the last run (preview or full) failed. */
  error: string | null;
  /** What screen readers hear: outcomes of full runs and cancellations. */
  announcement: string;
}

/** Most pinned runs (and pinned sweeps) kept for overlays. */
export const MAX_PINS = 6;

export interface Pin {
  id: number;
  /** Categorical colour slot, 1–6 (slot 0 is the current run); kept when others are unpinned. */
  slot: number;
  label: string;
  outcome: ShotOutcome;
}

export type SweepOutput =
  'ey' | 'tds' | 'shot_time' | 'beverage' | 'max_pressure' | 'first_drops' | 'ey_std';

export interface SweepConfig {
  /** A target id from sweep.ts. */
  targetId: string;
  from: string;
  to: string;
  points: string;
  tier: '0' | '1';
  outputs: SweepOutput[];
}

export type SweepPoint =
  | { x: number; ok: true; summary: Summary; warnings: string[] }
  | { x: number; ok: false; error: string };

export interface SweepRun {
  seq: number;
  targetId: string;
  label: string;
  unit: string;
  tier: 0 | 1;
  /** `physicalKey` of the recipe the sweep varied. */
  baseKey: string;
  values: number[];
  /** One per finished value, in order. */
  points: SweepPoint[];
}

export interface SweepState {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  run: SweepRun | null;
  error: string | null;
  /** For an engine failure: the core's panic message. */
  errorDetail?: string;
  announcement: string;
}

export interface PinnedSweep {
  id: number;
  slot: number;
  label: string;
  run: SweepRun;
}

export type OutputTab =
  'shot' | 'particles' | 'compounds' | 'chemistry' | 'section' | 'sweep' | 'provenance';

export interface ShotState {
  catalog: Catalog | null;
  catalogError: string | null;
  form: RecipeForm;
  /** Undo of the last reset, load or machine change, until the next edit. */
  undo: Undo | null;
  /** A request to open the editor where a field is and focus it. */
  reveal: { path: string; nonce: number } | null;
  /** Things the editor did on its own that the user should know (e.g. dropped overrides). */
  notices: string[];
  livePreview: boolean;
  check: BuildCheck | null;
  run: ShotRunState;
  pins: Pin[];
  showPins: boolean;
  outputTab: OutputTab;
  sweepConfig: SweepConfig;
  sweep: SweepState;
  pinnedSweeps: PinnedSweep[];
  /** Counter behind run and sweep numbers. */
  seq: number;
  /** Counter behind pin ids. */
  pinSeq: number;

  setCatalog: (catalog: Catalog) => void;
  setCatalogError: (message: string | null) => void;
  patchForm: <K extends keyof RecipeForm>(section: K, patch: Partial<RecipeForm[K]>) => void;
  setOverride: (id: string, text: string | null) => void;
  clearOverrides: () => void;
  /** Replaces the form (import, saved recipe, pinned run), keeping an undo. */
  loadForm: (form: RecipeForm, undoLabel?: string) => void;
  resetForm: () => void;
  undoLast: () => void;
  revealField: (path: string) => void;
  /** The reveal request has been served (the field has focus). */
  clearReveal: () => void;
  addNotice: (notice: string) => void;
  dismissNotices: () => void;
  setLivePreview: (on: boolean) => void;
  setCheck: (check: BuildCheck) => void;
  previewStarted: () => void;
  fullStarted: () => void;
  runSucceeded: (outcome: Omit<ShotOutcome, 'seq'>) => void;
  runFailed: (kind: RunKind, check: BuildCheck) => void;
  runCancelled: () => void;
  /** A full run was superseded by a preview of newer inputs (no announcement). */
  fullSuperseded: () => void;
  /** The automatic run stopped without a result (its inputs left the screen). */
  previewStopped: () => void;
  pinLatest: () => void;
  unpin: (id: number) => void;
  renamePin: (id: number, label: string) => void;
  setShowPins: (show: boolean) => void;
  setOutputTab: (tab: OutputTab) => void;
  patchSweepConfig: (patch: Partial<SweepConfig>) => void;
  sweepStarted: (run: Omit<SweepRun, 'seq' | 'points'>) => void;
  sweepPointDone: (point: SweepPoint) => void;
  sweepFinished: (status: 'done' | 'cancelled' | 'error', error?: string, detail?: string) => void;
  pinSweep: () => void;
  unpinSweep: (id: number) => void;
}

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  targetId: 'prep.dose_g',
  from: '',
  to: '',
  points: '9',
  tier: '0',
  outputs: ['ey', 'tds', 'shot_time'],
};

/** What the editor says after dropping overrides of unknown registry parameters. */
export function droppedOverridesNotice(ids: readonly string[]): string {
  const shown = ids.slice(0, 5).join(', ');
  const more = ids.length > 5 ? ` and ${ids.length - 5} more` : '';
  return `Removed overrides of parameters this version’s registry does not have: ${shown}${more}.`;
}

const INITIAL_RUN: ShotRunState = {
  previewRunning: false,
  fullRunning: false,
  status: 'idle',
  latest: null,
  lastFull: null,
  error: null,
  announcement: '',
};

const INITIAL_SWEEP: SweepState = { status: 'idle', run: null, error: null, announcement: '' };

/** The lowest colour slot (1–6) no pin uses. */
function freeSlot(used: readonly number[]): number {
  for (let slot = 1; slot <= MAX_PINS; slot++) if (!used.includes(slot)) return slot;
  return 1;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** The sentence announced when a full run finishes. */
export function finishedAnnouncement(outcome: Pick<ShotOutcome, 'result' | 'tier'>): string {
  const s = outcome.result.summary;
  return (
    `Run finished (tier ${outcome.tier}): ${s.shot_time_s.toFixed(1)} s, ` +
    `${(s.beverage_mass_kg * 1000).toFixed(1)} g, EY ${percent(s.ey)}, TDS ${percent(s.tds)}.`
  );
}

function initialState(form: RecipeForm) {
  return {
    catalog: null,
    catalogError: null,
    form,
    undo: null,
    reveal: null,
    notices: [],
    livePreview: true,
    check: null,
    run: INITIAL_RUN,
    pins: [],
    showPins: true,
    outputTab: 'shot' as OutputTab,
    sweepConfig: DEFAULT_SWEEP_CONFIG,
    sweep: INITIAL_SWEEP,
    pinnedSweeps: [],
    seq: 0,
    pinSeq: 0,
  };
}

/**
 * The form to start with: the draft this browser kept (drafts are saved only
 * while valid), else the defaults. A draft that no longer converts into a
 * valid recipe is ignored.
 */
export function startingForm(): RecipeForm {
  const draft = loadDraft(browserStorage());
  if (draft) {
    const result = recipeToForm(draft);
    if (result.ok && formToRecipe(result.form).ok) return result.form;
  }
  return defaultForm();
}

export const useShotStore = create<ShotState>()((set) => ({
  ...initialState(startingForm()),

  setCatalog: (catalog) =>
    set((state) => {
      // A draft from another version may override parameters this registry lacks.
      const { form, removed } = dropUnknownOverrides(state.form, catalog);
      return {
        catalog,
        catalogError: null,
        form,
        notices:
          removed.length > 0 ? [...state.notices, droppedOverridesNotice(removed)] : state.notices,
      };
    }),
  setCatalogError: (catalogError) => set({ catalogError }),
  patchForm: (section, patch) =>
    set((state) => ({
      form: { ...state.form, [section]: { ...state.form[section], ...patch } },
      undo: null,
    })),
  setOverride: (id, text) =>
    set((state) => {
      const overrides = { ...state.form.overrides };
      if (text === null) delete overrides[id];
      else overrides[id] = text;
      return { form: { ...state.form, overrides }, undo: null };
    }),
  clearOverrides: () => set((state) => ({ form: { ...state.form, overrides: {} }, undo: null })),
  loadForm: (form, undoLabel = 'Undo load') =>
    set((state) => ({ form, undo: { form: state.form, label: undoLabel } })),
  resetForm: () =>
    set((state) => ({ form: defaultForm(), undo: { form: state.form, label: 'Undo reset' } })),
  undoLast: () => set((state) => (state.undo ? { form: state.undo.form, undo: null } : {})),
  revealField: (path) =>
    set((state) => ({ reveal: { path, nonce: (state.reveal?.nonce ?? 0) + 1 } })),
  clearReveal: () => set({ reveal: null }),
  addNotice: (notice) => set((state) => ({ notices: [...state.notices, notice] })),
  dismissNotices: () => set({ notices: [] }),
  setLivePreview: (livePreview) => set({ livePreview }),
  setCheck: (check) => set({ check }),
  previewStarted: () => set((state) => ({ run: { ...state.run, previewRunning: true } })),
  fullStarted: () =>
    set((state) => ({ run: { ...state.run, fullRunning: true, previewRunning: false } })),
  runSucceeded: (partial) =>
    set((state) => {
      const seq = state.seq + 1;
      const outcome: ShotOutcome = { ...partial, seq };
      const full = outcome.kind === 'full';
      return {
        seq,
        check: { key: outcome.key, build: outcome.build, error: null, errorPath: null },
        run: {
          ...state.run,
          previewRunning: full ? state.run.previewRunning : false,
          fullRunning: full ? false : state.run.fullRunning,
          status: full ? 'done' : state.run.status,
          latest: outcome,
          lastFull: full ? outcome : state.run.lastFull,
          error: null,
          announcement: full ? finishedAnnouncement(outcome) : state.run.announcement,
        },
      };
    }),
  runFailed: (kind, check) =>
    set((state) => ({
      check,
      run: {
        ...state.run,
        previewRunning: kind === 'preview' ? false : state.run.previewRunning,
        fullRunning: kind === 'full' ? false : state.run.fullRunning,
        status: kind === 'full' ? 'error' : state.run.status,
        error: check.error,
        announcement: kind === 'full' ? `Run failed: ${check.error}` : state.run.announcement,
      },
    })),
  runCancelled: () =>
    set((state) => ({
      run: {
        ...state.run,
        previewRunning: false,
        fullRunning: false,
        status: 'cancelled',
        announcement: 'Run cancelled.',
      },
    })),
  fullSuperseded: () => set((state) => ({ run: { ...state.run, fullRunning: false } })),
  previewStopped: () =>
    set((state) =>
      state.run.previewRunning ? { run: { ...state.run, previewRunning: false } } : {},
    ),
  pinLatest: () =>
    set((state) => {
      const outcome = state.run.latest;
      if (!outcome || state.pins.length >= MAX_PINS) return {};
      if (state.pins.some((p) => p.outcome === outcome)) return {};
      const id = state.pinSeq + 1;
      const pin: Pin = {
        id,
        slot: freeSlot(state.pins.map((p) => p.slot)),
        label: `Run ${outcome.seq}${outcome.kind === 'preview' ? ' (preview)' : ''}`,
        outcome,
      };
      return { pins: [...state.pins, pin], pinSeq: id };
    }),
  unpin: (id) => set((state) => ({ pins: state.pins.filter((p) => p.id !== id) })),
  renamePin: (id, label) =>
    set((state) => ({ pins: state.pins.map((p) => (p.id === id ? { ...p, label } : p)) })),
  setShowPins: (showPins) => set({ showPins }),
  setOutputTab: (outputTab) => set({ outputTab }),
  patchSweepConfig: (patch) =>
    set((state) => ({ sweepConfig: { ...state.sweepConfig, ...patch } })),
  sweepStarted: (partial) =>
    set((state) => {
      const seq = state.seq + 1;
      return {
        seq,
        sweep: {
          status: 'running',
          run: { ...partial, seq, points: [] },
          error: null,
          announcement: '',
        },
      };
    }),
  sweepPointDone: (point) =>
    set((state) => {
      const run = state.sweep.run;
      if (!run) return {};
      return { sweep: { ...state.sweep, run: { ...run, points: [...run.points, point] } } };
    }),
  sweepFinished: (status, error, detail) =>
    set((state) => {
      const run = state.sweep.run;
      const done = run?.points.length ?? 0;
      const total = run?.values.length ?? 0;
      const failed = run?.points.filter((p) => !p.ok).length ?? 0;
      const announcement =
        status === 'done'
          ? `Sweep finished: ${done} points${failed > 0 ? `, ${failed} could not be simulated` : ''}.`
          : status === 'cancelled'
            ? `Sweep cancelled after ${done} of ${total} points.`
            : `Sweep failed: ${error ?? 'unknown error'}`;
      return {
        sweep: {
          ...state.sweep,
          status,
          error: error ?? null,
          ...(detail ? { errorDetail: detail } : { errorDetail: undefined }),
          announcement,
        },
      };
    }),
  pinSweep: () =>
    set((state) => {
      const run = state.sweep.run;
      if (!run || run.points.length === 0 || state.pinnedSweeps.length >= MAX_PINS) return {};
      if (state.pinnedSweeps.some((p) => p.run === run)) return {};
      const id = state.pinSeq + 1;
      const pinned: PinnedSweep = {
        id,
        slot: freeSlot(state.pinnedSweeps.map((p) => p.slot)),
        label: `Sweep ${run.seq}`,
        run,
      };
      return { pinnedSweeps: [...state.pinnedSweeps, pinned], pinSeq: id };
    }),
  unpinSweep: (id) =>
    set((state) => ({ pinnedSweeps: state.pinnedSweeps.filter((p) => p.id !== id) })),
}));

/** Restores the initial state (tests), optionally with another form. */
export function resetShotStore(form: RecipeForm = defaultForm()): void {
  useShotStore.setState(initialState(form));
}
