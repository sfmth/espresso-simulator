// SPDX-License-Identifier: GPL-2.0-or-later
/** Local setup hypotheses are separate from the existing, immutable shot journal. */
import { create } from 'zustand';
import { validateRecipe } from '../dialin/journalValidation';
import type { Recipe } from '../engine/shotTypes';
import { useShotStore } from '../shot/shotStore';
import { browserStorage, type KeyValueStore } from '../shot/storage';
import type {
  InferenceRequest,
  SetupCandidate,
  SetupConstraint,
  SetupObservation,
} from './inferenceTypes';

export const INFERENCE_SCHEMA = 'puckworks.setup-inference/1';
export const INFERENCE_STORAGE_KEY = `puckworks.setup-inference.v1:${import.meta.env.BASE_URL}`;
export const MAX_SETUP_OBSERVATIONS = 12;
export const MAX_SETUP_ALTERNATIVES = 12;
const MAX_BYTES = 5_000_000;

export interface EquipmentFacts {
  heater: 'unknown' | 'boiler' | 'thermoblock';
  /** Machine display/setpoint only. Never substituted for incoming water temperature. */
  displayedTemperatureC?: number;
}
export interface SavedSetup {
  id: string;
  name: string;
  createdAt: string;
  coreVersion: string;
  source: 'inferred' | 'specified';
  recipe: Recipe;
  facts: EquipmentFacts;
  request: InferenceRequest;
  candidate?: SetupCandidate;
}
export interface SetupDocument {
  schema: typeof INFERENCE_SCHEMA;
  name: string;
  facts: EquipmentFacts;
  constraints: SetupConstraint[];
  observations: SetupObservation[];
  alternatives: SavedSetup[];
  activeId: string | null;
}
export function emptySetupDocument(): SetupDocument {
  return {
    schema: INFERENCE_SCHEMA,
    name: 'My equipment',
    facts: { heater: 'unknown' },
    constraints: [],
    observations: [],
    alternatives: [],
    activeId: null,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function text(value: unknown, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid setup text.');
}
function finite(
  value: unknown,
  min = -Number.MAX_VALUE,
  max = Number.MAX_VALUE,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error('Invalid setup number.');
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('Setup exceeds its record limit.');
  return value;
}
function tree(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > 250_000 || depth > 24) throw new Error('Setup exceeds structural limits.');
  if (typeof value === 'number') finite(value);
  else if (typeof value === 'string') {
    if (value.length > 20_000) throw new Error('Setup text is too long.');
  } else if (Array.isArray(value)) value.forEach((v) => tree(v, depth + 1, budget));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Unsafe setup key.');
      if (child !== undefined) tree(child, depth + 1, budget);
    }
  } else if (value !== null && value !== undefined && typeof value !== 'boolean')
    throw new Error('Unsupported setup value.');
}
function path(value: unknown): void {
  text(value, 240);
  if (
    !/^(bean|water|chemistry|grinder|basket|prep|machine|overrides)\.[a-zA-Z0-9_.-]+$/.test(
      value,
    ) ||
    value.split('.').some((s) => ['__proto__', 'prototype', 'constructor'].includes(s))
  )
    throw new Error('Unsupported setup parameter path.');
}
function facts(value: unknown): void {
  const f = record(value);
  if (!['unknown', 'boiler', 'thermoblock'].includes(String(f.heater)))
    throw new Error('Unknown heater description.');
  if (f.displayedTemperatureC !== undefined) finite(f.displayedTemperatureC, 0, 150);
}
function constraints(value: unknown): void {
  const seen = new Set<string>();
  for (const item of array(value, 4000)) {
    const c = record(item);
    path(c.path);
    if (seen.has(String(c.path))) throw new Error('Duplicate setup constraint.');
    seen.add(String(c.path));
    if (!['locked', 'range', 'unknown'].includes(String(c.mode)))
      throw new Error('Invalid constraint state.');
    if (c.value !== undefined && !['number', 'string', 'boolean'].includes(typeof c.value))
      throw new Error('Invalid locked value.');
    for (const key of ['min', 'max', 'step']) if (c[key] !== undefined) finite(c[key]);
    if (typeof c.step === 'number' && c.step <= 0) throw new Error('Search step must be positive.');
    if (typeof c.min === 'number' && typeof c.max === 'number' && c.min > c.max)
      throw new Error('Search bounds are reversed.');
    if (c.choices !== undefined)
      for (const choice of array(c.choices, 1000)) {
        if (!['number', 'string', 'boolean'].includes(typeof choice))
          throw new Error('Invalid allowed choice.');
      }
  }
}
function observations(value: unknown): void {
  const ids = new Set<string>();
  for (const item of array(value, MAX_SETUP_OBSERVATIONS)) {
    const o = record(item);
    text(o.id);
    text(o.label);
    if (ids.has(o.id)) throw new Error('Duplicate observed shot.');
    ids.add(o.id);
    finite(o.timeS, 0.1, 600);
    finite(o.yieldG, 0.1, 500);
    finite(o.timeToleranceS, 0, 60);
    finite(o.yieldToleranceG, 0.001, 50);
    if (o.timeToleranceS >= o.timeS)
      throw new Error('Shot timing tolerance must be smaller than the recorded time.');
    if (o.tdsPercent !== undefined) {
      finite(o.tdsPercent, 0.01, 30);
      finite(o.tdsTolerancePercent, 0.001, 5);
    }
    if (o.tdsTolerancePercent !== undefined) finite(o.tdsTolerancePercent, 0.001, 5);
    if (
      !['pump', 'first-drip'].includes(String(o.timeBasis)) ||
      !['final', 'pump-stop'].includes(String(o.massBasis))
    )
      throw new Error('Unknown shot measurement convention.');
    validateRecipe(o.recipe);
    if (o.changes !== undefined) array(o.changes, 4000).forEach(path);
  }
}
function request(value: unknown): void {
  const r = record(value);
  validateRecipe(r.recipe);
  constraints(r.constraints);
  observations(r.observations);
  if (r.maxEvaluations !== undefined) finite(r.maxEvaluations, 1, 100_000);
  if (r.seed !== undefined) finite(r.seed, 0, 0xffffffff);
}
export function parseSetupDocument(json: string): SetupDocument {
  if (json.length > MAX_BYTES) throw new Error('Setup backup exceeds 5 MB.');
  const d = record(JSON.parse(json) as unknown);
  tree(d);
  if (d.schema !== INFERENCE_SCHEMA) throw new Error('Unsupported equipment setup backup.');
  if (typeof d.name !== 'string' || d.name.length > 120) throw new Error('Invalid setup name.');
  facts(d.facts);
  constraints(d.constraints);
  observations(d.observations);
  const ids = new Set<string>();
  for (const item of array(d.alternatives, MAX_SETUP_ALTERNATIVES)) {
    const a = record(item);
    text(a.id);
    text(a.name, 120);
    text(a.coreVersion, 80);
    text(a.createdAt, 40);
    if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(a.createdAt) || !Number.isFinite(Date.parse(a.createdAt)))
      throw new Error('Invalid setup date.');
    if (ids.has(a.id)) throw new Error('Duplicate saved setup.');
    ids.add(a.id);
    if (!['specified', 'inferred'].includes(String(a.source)))
      throw new Error('Invalid setup source.');
    validateRecipe(a.recipe);
    facts(a.facts);
    request(a.request);
    if (a.source === 'inferred' && !a.candidate)
      throw new Error('Inferred setup has no verification record.');
    if (a.candidate) {
      const c = record(a.candidate);
      text(c.id);
      validateRecipe(c.recipe);
      const inferredValues = record(c.values);
      if (canonical(a.recipe) !== canonical(c.recipe))
        throw new Error('The saved setup recipe differs from its verification record.');
      for (const [key, value] of Object.entries(inferredValues)) {
        path(key);
        if (!['number', 'string', 'boolean'].includes(typeof value))
          throw new Error('Invalid inferred parameter value.');
      }
      finite(c.score, 0);
      if (c.matches !== true)
        throw new Error('Only matching candidates can be saved as inferred setups.');
      const checks = array(c.checks, MAX_SETUP_OBSERVATIONS);
      const sourceShots = (a.request as InferenceRequest).observations;
      if (!checks.length || checks.length !== sourceShots.length)
        throw new Error('Incomplete setup verification.');
      const checkIds = new Set<string>();
      let scoreSum = 0;
      for (const item of checks) {
        const check = record(item);
        text(check.observationId);
        text(check.label);
        if (
          checkIds.has(check.observationId) ||
          !sourceShots.some((s) => s.id === check.observationId)
        )
          throw new Error('Invalid verification shot.');
        checkIds.add(check.observationId);
        if (check.matches !== true || check.timeIsReplayCondition !== true)
          throw new Error('Invalid setup verification status.');
        for (const group of ['predicted', 'observed', 'residuals', 'tolerances']) {
          const values = record(check[group]);
          finite(values.timeS);
          finite(values.yieldG);
          if (values.tdsPercent !== undefined) finite(values.tdsPercent);
        }
        const shot = sourceShots.find((s) => s.id === check.observationId)!;
        const observed = record(check.observed),
          predicted = record(check.predicted);
        const residuals = record(check.residuals),
          tolerances = record(check.tolerances);
        finite(predicted.timeS, 0);
        finite(predicted.yieldG, 0);
        finite(predicted.tdsPercent, 0);
        if (
          observed.timeS !== shot.timeS ||
          observed.yieldG !== shot.yieldG ||
          observed.tdsPercent !== shot.tdsPercent ||
          tolerances.timeS !== shot.timeToleranceS ||
          tolerances.yieldG !== shot.yieldToleranceG ||
          tolerances.tdsPercent !== shot.tdsTolerancePercent
        )
          throw new Error('Verification conditions differ from the recorded shot.');
        if (shot.tdsPercent === undefined && residuals.tdsPercent !== undefined)
          throw new Error('Verification includes a residual for an unmeasured TDS value.');
        for (const key of [
          'timeS',
          'yieldG',
          ...(shot.tdsPercent === undefined ? [] : ['tdsPercent']),
        ]) {
          const prediction = predicted[key];
          const observation = observed[key];
          const residual = residuals[key];
          const tolerance = tolerances[key];
          finite(prediction);
          finite(observation);
          finite(residual);
          finite(tolerance, 0);
          if (
            Math.abs(prediction - observation - residual) > 1e-9 ||
            Math.abs(residual) > tolerance + (key === 'timeS' ? 1e-6 : 1e-9)
          )
            throw new Error('Verification residuals do not match the claimed tolerance.');
        }
        const checked = check as unknown as SetupCandidate['checks'][number];
        scoreSum +=
          (checked.residuals.yieldG / checked.tolerances.yieldG) ** 2 +
          (checked.residuals.tdsPercent === undefined
            ? 0
            : (checked.residuals.tdsPercent / checked.tolerances.tdsPercent!) ** 2) +
          (checked.tolerances.timeS > 0
            ? 0.01 * (checked.residuals.timeS / checked.tolerances.timeS) ** 2
            : 0);
      }
      const expectedScore = scoreSum / checks.length;
      finite(expectedScore, 0);
      if (Math.abs(c.score - expectedScore) > Math.max(1e-12, Math.abs(expectedScore) * 1e-12))
        throw new Error('Verification score differs from its recorded residuals.');
      array(c.notes, 1000).forEach((n) => text(n, 20_000));
    }
  }
  if (d.activeId !== null && (typeof d.activeId !== 'string' || !ids.has(d.activeId)))
    throw new Error('Active setup is missing.');
  return d as unknown as SetupDocument;
}

interface SetupState {
  document: SetupDocument;
  hydrated: boolean;
  persistent: boolean;
  notice: string | null;
  hydrate: () => void;
  update: (edit: (document: SetupDocument) => SetupDocument) => void;
  importDocument: (json: string) => void;
}
let lastStored: string | null = null;
let storage: KeyValueStore | null = null;
export const useEquipmentStore = create<SetupState>()((set, get) => ({
  document: emptySetupDocument(),
  hydrated: false,
  persistent: false,
  notice: null,
  hydrate: () => {
    if (get().hydrated) return;
    storage = browserStorage();
    try {
      lastStored = storage?.getItem(INFERENCE_STORAGE_KEY) ?? null;
      const document = lastStored ? parseSetupDocument(lastStored) : emptySetupDocument();
      set({
        document,
        hydrated: true,
        persistent: !!storage,
        notice: storage
          ? null
          : 'Setup changes last for this session. Export a backup to keep them.',
      });
    } catch {
      set({
        hydrated: true,
        persistent: false,
        notice:
          'The saved setup could not be read. Existing shot journal entries are unaffected. Import a setup backup or start a new setup.',
      });
    }
  },
  update: (edit) => {
    get().hydrate();
    const document = edit(structuredClone(get().document));
    const json = JSON.stringify(document);
    parseSetupDocument(json);
    if (storage && storage.getItem(INFERENCE_STORAGE_KEY) !== lastStored)
      throw new Error('Equipment setup changed in another tab. Reload before saving.');
    let persistent = false;
    try {
      storage?.setItem(INFERENCE_STORAGE_KEY, json);
      persistent = !!storage && storage.getItem(INFERENCE_STORAGE_KEY) === json;
      if (persistent) lastStored = json;
    } catch {
      /* Keep the session state, with an explicit export reminder. */
    }
    // A later setup edit/import must not leave a recovery action that can
    // overwrite newer equipment knowledge with an older structural snapshot.
    useShotStore.setState({ undo: null });
    set({
      document,
      persistent,
      notice: persistent
        ? null
        : 'Setup changes last for this session. Export a backup to keep them.',
    });
  },
  importDocument: (json) => {
    const incoming = parseSetupDocument(json);
    // Activation must validate and load the recipe through the native engine first.
    get().update(() => ({ ...incoming, activeId: null }));
  },
}));
/** Test/embedding reset; never removes saved user data. */
export function resetEquipmentStore(): void {
  storage = null;
  lastStored = null;
  useEquipmentStore.setState({
    document: emptySetupDocument(),
    hydrated: false,
    persistent: false,
    notice: null,
  });
}
