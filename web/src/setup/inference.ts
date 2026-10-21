// SPDX-License-Identifier: GPL-2.0-or-later
/** Bounded inverse setup search. Physics stays in the shared Rust engine. */
import type { Engine } from '../engine/engine';
import type { Catalog, Recipe } from '../engine/shotTypes';
import { inferenceParameters, setSetupValue } from './parameterCatalog';
import type {
  InferenceProgress,
  InferenceRequest,
  InferenceResult,
  SetupCandidate,
  SetupCheck,
  SetupConstraint,
  SetupObservation,
  SetupParameter,
  SetupValue,
} from './inferenceTypes';

interface Axis {
  parameter: SetupParameter;
  constraint: SetupConstraint;
  min: number;
  max: number;
  values?: SetupValue[];
  initial: number;
}
interface Point {
  coordinates: number[];
  candidate: SetupCandidate;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function validateValue(
  parameter: SetupParameter,
  value: SetupValue | undefined,
): asserts value is SetupValue {
  if (parameter.kind === 'number') {
    if (
      !finite(value) ||
      (parameter.min != null && value < parameter.min) ||
      (parameter.max != null && value > parameter.max)
    ) {
      throw new Error(`${parameter.label}: value must be finite and inside its physical bounds.`);
    }
  } else if (!parameter.choices?.includes(value as SetupValue))
    throw new Error(`${parameter.label}: choose one of the supported values.`);
}
function axisFor(parameter: SetupParameter, constraint: SetupConstraint): Axis {
  if (!parameter.modeled)
    throw new Error(`${parameter.label}: ${parameter.reason ?? 'This parameter is not modeled.'}`);
  if (parameter.kind !== 'number') {
    const values = constraint.choices ?? parameter.choices ?? [];
    if (!values.length || new Set(values).size !== values.length)
      throw new Error(`${parameter.label}: choose at least one distinct allowed value.`);
    values.forEach((v) => validateValue(parameter, v));
    const index = values.indexOf(parameter.value as SetupValue);
    return {
      parameter,
      constraint,
      min: 0,
      max: values.length - 1,
      values,
      initial: Math.max(0, index),
    };
  }
  const min = constraint.min ?? parameter.min;
  const max = constraint.max ?? parameter.max;
  if (!finite(min) || !finite(max) || min > max)
    throw new Error(`${parameter.label}: provide a finite minimum and maximum before searching.`);
  validateValue(parameter, min);
  validateValue(parameter, max);
  if (
    constraint.step != null &&
    (!finite(constraint.step) ||
      constraint.step <= 0 ||
      !Number.isFinite((max - min) / constraint.step) ||
      (max - min) / constraint.step > 1e9)
  )
    throw new Error(
      `${parameter.label}: step must be positive and define at most one billion intervals.`,
    );
  const initial = finite(parameter.value) ? clamp(parameter.value, min, max) : (min + max) / 2;
  return { parameter, constraint, min, max, initial };
}
function decode(axis: Axis, unit: number): SetupValue {
  if (axis.values) return axis.values[Math.round(clamp(unit, 0, 1) * axis.max)];
  const log = axis.parameter.logarithmic && axis.min > 0;
  let value = log
    ? Math.exp(Math.log(axis.min) + clamp(unit, 0, 1) * Math.log(axis.max / axis.min))
    : axis.min + clamp(unit, 0, 1) * (axis.max - axis.min);
  const step = axis.constraint.step ?? axis.parameter.step;
  if (step) {
    const last = Math.floor((axis.max - axis.min) / step + 1e-12);
    const index = clamp(Math.round((value - axis.min) / step), 0, last);
    value = axis.min + index * step;
  }
  return clamp(value, axis.min, axis.max);
}
function encode(axis: Axis, value: number): number {
  if (axis.max === axis.min) return 0;
  return axis.parameter.logarithmic && axis.min > 0
    ? Math.log(value / axis.min) / Math.log(axis.max / axis.min)
    : (value - axis.min) / (axis.max - axis.min);
}
function distance(a: number[], b: number[]): number {
  return a.length ? Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0) / a.length) : 0;
}

/** Runtime boundary shared by UI/import consumers. Missing constraints are fixed assumptions. */
export function validateInferenceRequest(request: InferenceRequest, catalog: Catalog): void {
  const parameters = new Map(inferenceParameters(request.recipe, catalog).map((p) => [p.path, p]));
  const paths = new Set<string>();
  for (const constraint of request.constraints) {
    const parameter = parameters.get(constraint.path);
    if (!parameter || paths.has(constraint.path))
      throw new Error(`Unknown or duplicate setup parameter: ${constraint.path}.`);
    paths.add(constraint.path);
    if (!parameter.modeled && constraint.path.startsWith('overrides.'))
      throw new Error(`${parameter.label}: ${parameter.reason}`);
    if (constraint.mode === 'locked') validateValue(parameter, constraint.value ?? parameter.value);
    else if (constraint.mode === 'range' || constraint.mode === 'unknown')
      axisFor(parameter, constraint);
    else throw new Error(`Invalid constraint state for ${parameter.label}.`);
  }
  if (!request.observations.length || request.observations.length > 12)
    throw new Error('Record between one and twelve shots to infer a setup.');
  const ids = new Set<string>();
  for (const observation of request.observations) {
    if (!observation.id || ids.has(observation.id))
      throw new Error('Recorded shot identifiers must be unique.');
    ids.add(observation.id);
    if (
      !finite(observation.timeS) ||
      observation.timeS <= 0 ||
      observation.timeS > 600 ||
      !finite(observation.yieldG) ||
      observation.yieldG <= 0 ||
      observation.yieldG > 500
    )
      throw new Error(
        `${observation.label}: enter 0–600 seconds and 0–500 grams, both greater than zero.`,
      );
    if (
      !finite(observation.timeToleranceS) ||
      observation.timeToleranceS < 0 ||
      observation.timeToleranceS >= observation.timeS ||
      !finite(observation.yieldToleranceG) ||
      observation.yieldToleranceG <= 0
    )
      throw new Error(
        `${observation.label}: use nonnegative timing tolerance smaller than shot time and positive mass tolerance.`,
      );
    if (
      !['pump', 'first-drip'].includes(observation.timeBasis) ||
      !['final', 'pump-stop'].includes(observation.massBasis)
    )
      throw new Error(`${observation.label}: specify timing and weighing conventions.`);
    if (
      observation.tdsPercent != null &&
      (!finite(observation.tdsPercent) ||
        observation.tdsPercent <= 0 ||
        observation.tdsPercent > 30 ||
        !finite(observation.tdsTolerancePercent) ||
        observation.tdsTolerancePercent <= 0)
    )
      throw new Error(
        `${observation.label}: TDS needs a finite percentage and positive tolerance.`,
      );
    const shotParameters = new Map(
      inferenceParameters(observation.recipe, catalog).map((p) => [p.path, p]),
    );
    for (const path of observation.changes ?? []) {
      const parameter = shotParameters.get(path);
      if (!parameter) throw new Error(`${observation.label}: unsupported per-shot change ${path}.`);
      validateValue(parameter, parameter.value);
    }
  }
  const budget = request.maxEvaluations ?? 480;
  if (!Number.isInteger(budget) || budget < request.observations.length * 8 || budget > 10000)
    throw new Error(
      'Search budget must be an integer between eight calls per recorded shot and 10,000 calls.',
    );
  if (request.seed != null && !Number.isInteger(request.seed))
    throw new Error('The search seed must be an integer.');
  // A contradictory set of fixed locks is an input error, not a failed
  // optimization. Validate it before any simulation or worker call.
  candidateRecipe(
    request.recipe,
    request.constraints.filter((c) => c.mode === 'locked'),
    parameters,
    [],
    [],
    catalog,
  );
}

function preserveReferenceGapMeaning(
  before: Recipe,
  after: Recipe,
  constrainedPaths: string[],
  catalog: Catalog,
): void {
  if (
    !constrainedPaths.includes('grinder.gap_at_ref_um') ||
    before.grinder.gap_um != null ||
    after.grinder.gap_um != null ||
    before.grinder.psd ||
    after.grinder.psd
  )
    return;
  const reference = (recipe: Recipe) =>
    catalog.presets.grinders.find((p) => p.id === recipe.grinder.preset)?.dial.ref ?? 0;
  if (reference(before) !== reference(after))
    throw new Error(
      'Changing this grinder would change the named dial reference and reinterpret its constrained reference gap. Choose the grinder or generic dial in the equipment editor before constraining its reference gap.',
    );
}

function candidateRecipe(
  recipe: Recipe,
  constraints: SetupConstraint[],
  parameters: Map<string, SetupParameter>,
  axes: Axis[],
  coordinates: number[],
  catalog: Catalog,
): { recipe: Recipe; values: Record<string, SetupValue> } {
  const values: Record<string, SetupValue> = {};
  constraints
    .filter((c) => c.mode === 'locked')
    .forEach((c) => (values[c.path] = c.value ?? parameters.get(c.path)!.value!));
  axes.forEach((axis, i) => (values[axis.parameter.path] = decode(axis, coordinates[i])));
  let copy = structuredClone(recipe);
  // Apply selectors before their subordinate numeric locks. A lock has final
  // precedence even when a categorical equipment choice changes its defaults.
  const entries = Object.entries(values).sort(
    ([a], [b]) => Number(a !== 'grinder.family') - Number(b !== 'grinder.family'),
  );
  for (const [path, value] of entries) copy = setSetupValue(copy, path, value, catalog);
  preserveReferenceGapMeaning(recipe, copy, Object.keys(values), catalog);
  const effective = new Map(inferenceParameters(copy, catalog).map((p) => [p.path, p.value]));
  for (const [path, expected] of entries) {
    if (effective.get(path) !== expected)
      throw new Error(
        `Conflicting setup constraints: ${path} would be replaced by another equipment choice.`,
      );
  }
  return { recipe: copy, values };
}

/** Apply stated known facts before saving an equipment profile without fitting. */
export function applySetupLocks(
  recipe: Recipe,
  constraints: SetupConstraint[],
  catalog: Catalog,
): Recipe {
  const parameters = new Map(inferenceParameters(recipe, catalog).map((p) => [p.path, p]));
  const locked = constraints.filter((constraint) => constraint.mode === 'locked');
  const seen = new Set<string>();
  for (const constraint of locked) {
    const parameter = parameters.get(constraint.path);
    if (!parameter || seen.has(constraint.path))
      throw new Error(`Unknown or duplicate setup parameter: ${constraint.path}.`);
    seen.add(constraint.path);
    if (!parameter.modeled && constraint.path.startsWith('overrides.'))
      throw new Error(`${parameter.label}: ${parameter.reason}`);
    validateValue(parameter, constraint.value ?? parameter.value);
  }
  return candidateRecipe(recipe, locked, parameters, [], [], catalog).recipe;
}

export async function inferSetups(
  engine: Engine,
  catalog: Catalog,
  request: InferenceRequest,
  options: { signal?: AbortSignal; onProgress?: (progress: InferenceProgress) => void } = {},
): Promise<InferenceResult> {
  const { signal, onProgress } = options;
  abort(signal);
  validateInferenceRequest(request, catalog);
  if ((await engine.coreVersion({ signal })).result !== catalog.coreVersion)
    throw new Error('Engine and catalog versions differ; reload before searching.');
  abort(signal);
  const parameters = new Map(inferenceParameters(request.recipe, catalog).map((p) => [p.path, p]));
  const axes = request.constraints
    .filter((c) => c.mode !== 'locked')
    .map((c) => axisFor(parameters.get(c.path)!, c));
  const budget = request.maxEvaluations ?? 480;
  const random = randomSource(request.seed ?? 20261021);
  const initial = axes.map((axis) => encode(axis, axis.initial));
  const points: Point[] = [];
  const verified: Point[] = [];
  const seen = new Set<string>();
  const inactive = new Set<string>();
  const failures = new Set<string>();
  let evaluations = 0;
  let skipped = 0;
  let stage: InferenceProgress['stage'] = 'search';
  let bestScore = Infinity;
  const progress = () =>
    onProgress?.({
      stage,
      completed: evaluations,
      total: budget,
      bestScore: Number.isFinite(bestScore) ? bestScore : undefined,
    });
  progress();

  const runShot = async (
    recipe: Recipe,
    observation: SetupObservation,
    tier: 0 | 1,
    pumpTime: number,
  ) => {
    abort(signal);
    if (evaluations >= budget) throw new Error('Search call budget exhausted.');
    const replay = structuredClone(recipe);
    replay.stop = { time_s: pumpTime };
    replay.numerics = { ...request.recipe.numerics, tier };
    evaluations++;
    progress();
    const run = (await engine.simulateRecipe(replay, { signal })).result;
    abort(signal);
    const { summary, diagnostics, series } = run.result;
    if (
      !['time', 'beverage_mass'].includes(summary.stop_reason) ||
      ![summary.beverage_mass_kg, summary.tds, summary.shot_time_s].every(Number.isFinite) ||
      summary.beverage_mass_kg <= 0 ||
      summary.tds < 0 ||
      summary.tds > 1 ||
      Math.abs(summary.shot_time_s - pumpTime) > 0.51 ||
      !Number.isFinite(diagnostics.mass_balance_error) ||
      Math.abs(diagnostics.mass_balance_error) > 0.001 ||
      diagnostics.warnings.some((w) =>
        /non.?finite|negative concentration|unstable|not converg|solver fail|mass.balance.*(?:fail|exceed)/i.test(
          w,
        ),
      )
    )
      throw new Error('Replay failed physical or numerical verification.');
    for (const axis of axes.filter((a) => a.parameter.path.startsWith('overrides.'))) {
      const id = axis.parameter.path.slice(10);
      if (run.build.derived.notes.some((note) => note.startsWith(`Override ${id} has no effect`)))
        inactive.add(axis.parameter.path);
    }
    if (
      replay.grinder.setting != null &&
      replay.grinder.gap_um == null &&
      !replay.grinder.psd &&
      run.build.derived.psd?.setting !== replay.grinder.setting
    )
      throw new Error('The grinder would clamp the requested dial setting.');
    if (!replay.grinder.psd) {
      const grinder = replay.grinder;
      const preset = catalog.presets.grinders.find((p) => p.id === grinder.preset);
      const setting = grinder.setting ?? preset?.dial.default;
      const referenceGap = grinder.gap_at_ref_um ?? preset?.dial.gap_at_ref_um;
      const slope = grinder.gap_per_unit_um ?? preset?.dial.gap_per_unit_um;
      const expectedGap =
        grinder.gap_um ??
        (setting != null && referenceGap != null && slope != null
          ? referenceGap + slope * (setting - (preset?.dial.ref ?? 0))
          : NaN);
      const actualGap = run.build.derived.psd?.gap_um;
      if (
        !finite(expectedGap) ||
        !finite(actualGap) ||
        Math.abs(actualGap - expectedGap) > 1e-10 * Math.max(1, Math.abs(expectedGap))
      )
        throw new Error(
          'The grinder would clamp or replace the requested burr gap or dial calibration.',
        );
    }
    const first = summary.first_drops_s;
    if (observation.timeBasis === 'first-drip' && (!finite(first) || first >= summary.shot_time_s))
      throw new Error('No first drip occurred before the replay stopped.');
    let tds = summary.tds * 100;
    const yieldG =
      (summary.beverage_mass_kg -
        (observation.massBasis === 'pump-stop' ? (summary.drip_mass_kg ?? 0) : 0)) *
      1000;
    if (observation.massBasis === 'pump-stop' && observation.tdsPercent != null) {
      const times = Array.from(series.t_s);
      const index = times.reduce(
        (best, time, i) =>
          Math.abs(time - summary.shot_time_s) < Math.abs(times[best] - summary.shot_time_s)
            ? i
            : best,
        0,
      );
      if (!times.length || Math.abs(times[index] - summary.shot_time_s) > 0.05)
        throw new Error('The returned trace cannot resolve TDS at pump stop.');
      tds = series.tds_cup[index] * 100;
    }
    if (![yieldG, tds].every(Number.isFinite) || yieldG <= 0 || tds < 0 || tds > 100)
      throw new Error('Replay did not produce finite physical cup measurements.');
    return {
      timeS: summary.shot_time_s - (observation.timeBasis === 'first-drip' ? first! : 0),
      yieldG,
      tdsPercent: tds,
      first: first ?? 0,
    };
  };

  const evaluate = async (coordinates: number[], tier: 0 | 1): Promise<Point | undefined> => {
    abort(signal);
    const key = `${tier}:${JSON.stringify(axes.map((axis, i) => decode(axis, coordinates[i])))}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    try {
      const resolved = candidateRecipe(
        request.recipe,
        request.constraints,
        parameters,
        axes,
        coordinates,
        catalog,
      );
      const checks: SetupCheck[] = [];
      for (const observation of request.observations) {
        let replay = resolved.recipe;
        const descriptors = inferenceParameters(observation.recipe, catalog);
        const shotParameters = new Map(descriptors.map((p) => [p.path, p]));
        const shotLocks: SetupConstraint[] = (observation.changes ?? []).map((path) => ({
          path,
          mode: 'locked',
          value: shotParameters.get(path)!.value,
        }));
        replay = candidateRecipe(replay, shotLocks, shotParameters, [], [], catalog).recipe;
        preserveReferenceGapMeaning(
          resolved.recipe,
          replay,
          request.constraints
            .filter((c) => !observation.changes?.includes(c.path))
            .map((c) => c.path),
          catalog,
        );
        const shotEffective = new Map(
          inferenceParameters(replay, catalog).map((p) => [p.path, p.value]),
        );
        for (const constraint of request.constraints) {
          if (observation.changes?.includes(constraint.path)) continue;
          if (shotEffective.get(constraint.path) !== resolved.values[constraint.path]) {
            throw new Error(
              `${observation.label}: a shot-specific equipment change would replace the shared ${constraint.mode === 'locked' ? 'locked' : 'inferred'} value of ${parameters.get(constraint.path)?.label ?? constraint.path}. Record that setting as a known shot-specific change too, or keep the shared equipment choice.`,
            );
          }
        }
        // A short interval measured from first drip may be shorter than the
        // initial wetting period. Find first drip on a pilot that can reach it.
        let pumpTime =
          observation.timeBasis === 'first-drip'
            ? Math.min(600, Math.max(60, observation.timeS))
            : observation.timeS;
        let prediction = await runShot(replay, observation, tier, pumpTime);
        if (observation.timeBasis === 'first-drip') {
          pumpTime = observation.timeS + prediction.first;
          prediction = await runShot(replay, observation, tier, pumpTime);
        }
        // Timing is a measured boundary condition. A bounded nuisance-time
        // replay uses its stated tolerance, rather than counting an imposed
        // stop time as a successful independent prediction.
        if (
          Math.abs(prediction.yieldG - observation.yieldG) > observation.yieldToleranceG &&
          observation.timeToleranceS > 0
        ) {
          const flow = prediction.yieldG / Math.max(0.1, pumpTime - prediction.first);
          const adjustment = clamp(
            (observation.yieldG - prediction.yieldG) / flow,
            -observation.timeToleranceS,
            observation.timeToleranceS,
          );
          const adjusted = await runShot(replay, observation, tier, pumpTime + adjustment);
          if (
            Math.abs(adjusted.yieldG - observation.yieldG) <
            Math.abs(prediction.yieldG - observation.yieldG)
          )
            prediction = adjusted;
        }
        const residuals = {
          timeS: prediction.timeS - observation.timeS,
          yieldG: prediction.yieldG - observation.yieldG,
          ...(observation.tdsPercent != null
            ? { tdsPercent: prediction.tdsPercent - observation.tdsPercent }
            : {}),
        };
        const matches =
          Math.abs(residuals.timeS) <= observation.timeToleranceS + 1e-6 &&
          Math.abs(residuals.yieldG) <= observation.yieldToleranceG + 1e-9 &&
          (residuals.tdsPercent == null ||
            Math.abs(residuals.tdsPercent) <= observation.tdsTolerancePercent! + 1e-9);
        checks.push({
          observationId: observation.id,
          label: observation.label,
          predicted: {
            timeS: prediction.timeS,
            yieldG: prediction.yieldG,
            tdsPercent: prediction.tdsPercent,
          },
          observed: {
            timeS: observation.timeS,
            yieldG: observation.yieldG,
            tdsPercent: observation.tdsPercent,
          },
          residuals,
          tolerances: {
            timeS: observation.timeToleranceS,
            yieldG: observation.yieldToleranceG,
            tdsPercent: observation.tdsTolerancePercent,
          },
          matches,
          timeIsReplayCondition: true,
        });
      }
      const score =
        checks.reduce(
          (sum, c) =>
            sum +
            (c.residuals.yieldG / c.tolerances.yieldG) ** 2 +
            (c.residuals.tdsPercent == null
              ? 0
              : (c.residuals.tdsPercent / c.tolerances.tdsPercent!) ** 2) +
            (c.tolerances.timeS > 0 ? 0.01 * (c.residuals.timeS / c.tolerances.timeS) ** 2 : 0),
          0,
        ) / checks.length;
      const notes = [
        'Matching these shots does not establish a unique setup or predict accuracy on future shots.',
      ];
      const boundary = axes.filter(
        (axis, i) => !axis.values && (coordinates[i] <= 0.01 || coordinates[i] >= 0.99),
      );
      if (boundary.length)
        notes.push(`At a search boundary: ${boundary.map((a) => a.parameter.label).join(', ')}.`);
      const candidate: SetupCandidate = {
        id: `setup-${hash(JSON.stringify(resolved.recipe))}`,
        recipe: resolved.recipe,
        values: resolved.values,
        checks,
        score,
        matches: checks.every((c) => c.matches),
        notes,
      };
      bestScore = Math.min(bestScore, score);
      return { coordinates: [...coordinates], candidate };
    } catch (error) {
      abort(signal);
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof Error && failures.size < 3) failures.add(error.message);
      skipped++;
      return undefined;
    }
  };

  // Seeded space-filling starts plus differential mutation and coordinate
  // refinements retain disconnected explanations. Finite search is not an
  // enumeration of all continuous solutions and makes no probability claim.
  const worstCalls = request.observations.reduce(
    (sum, observation) => sum + (observation.timeBasis === 'first-drip' ? 3 : 2),
    0,
  );
  const searchLimit = Math.max(worstCalls, Math.floor(budget * 0.6));
  let attempts = 0;
  while (evaluations + worstCalls <= searchLimit && attempts < Math.max(40, budget * 5)) {
    abort(signal);
    const index = attempts++;
    let coordinates: number[];
    if (index === 0) coordinates = initial;
    else if (axes.length === 1 && index <= 16) coordinates = [(index - 1) / 15];
    else if (index < Math.max(12, axes.length * 3) || points.length < 4)
      coordinates = axes.map(() => random());
    else {
      const ranked = [...points].sort((a, b) => a.candidate.score - b.candidate.score);
      const parent = ranked[Math.floor(random() * Math.min(ranked.length, 12))];
      if (index % 3 === 0) {
        coordinates = [...parent.coordinates];
        const axis = Math.floor(index / 3) % axes.length;
        coordinates[axis] = clamp(
          coordinates[axis] +
            (random() < 0.5 ? -1 : 1) * Math.max(0.004, 0.25 * (1 - evaluations / searchLimit)),
          0,
          1,
        );
      } else {
        const a = points[Math.floor(random() * points.length)].coordinates;
        const b = points[Math.floor(random() * points.length)].coordinates;
        const forced = Math.floor(random() * axes.length);
        coordinates = parent.coordinates.map((v, j) =>
          j === forced || random() < 0.65
            ? clamp(v + 0.7 * (a[j] - b[j]) + (random() - 0.5) * 0.025, 0, 1)
            : v,
        );
      }
    }
    const point = await evaluate(coordinates, 0);
    if (point) points.push(point);
    if (!axes.length) break;
  }
  stage = 'verify';
  progress();
  const ranked = points.sort((a, b) => a.candidate.score - b.candidate.score);
  const finalists: Point[] = [];
  const verifyCount = Math.max(1, Math.min(12, Math.floor((budget - evaluations) / worstCalls)));
  for (const point of ranked) {
    if (
      !finalists.length ||
      finalists.every((other) => distance(other.coordinates, point.coordinates) >= 0.04)
    )
      finalists.push(point);
    if (finalists.length >= verifyCount) break;
  }
  for (const point of finalists) {
    if (evaluations + worstCalls > budget) break;
    const checked = await evaluate(point.coordinates, 1);
    if (checked) verified.push(checked);
  }
  // Full-tier local corrections avoid promoting a preview-only match when
  // Tier 0 and Tier 1 differ. Every correction still replays every shot.
  let refinement = 0;
  while (axes.length && verified.length && evaluations + worstCalls <= budget && refinement < 80) {
    const parent = [...verified].sort((a, b) => a.candidate.score - b.candidate.score)[
      Math.floor(refinement / (2 * axes.length)) % Math.min(3, verified.length)
    ];
    const coordinates = [...parent.coordinates];
    const index = Math.floor(refinement / 2) % axes.length;
    const delta = 0.08 / (1 + Math.floor(refinement / (2 * axes.length)));
    coordinates[index] = clamp(coordinates[index] + (refinement % 2 ? 1 : -1) * delta, 0, 1);
    refinement++;
    const point = await evaluate(coordinates, 1);
    if (point) verified.push(point);
  }
  abort(signal);
  const unique = (matches: boolean, max: number) => {
    const chosen: Point[] = [];
    for (const point of verified
      .filter((p) => p.candidate.matches === matches)
      .sort((a, b) => a.candidate.score - b.candidate.score)) {
      if (!chosen.length || chosen.every((p) => distance(p.coordinates, point.coordinates) >= 0.02))
        chosen.push(point);
      if (chosen.length >= max) break;
    }
    return chosen.map((p) => p.candidate);
  };
  const candidates = unique(true, 12);
  const nearMisses = unique(false, 5);
  const notes = [
    'Seeded bounded multistart search with differential mutation and coordinate refinement. Returned results are representative combinations found within the budget, not every possible solution.',
    'Every returned match and near miss was independently replayed at Tier 1 against every recorded shot. Timing is an observed replay condition; its tolerance permits a bounded adjustment. Mass and optional TDS provide the matching evidence.',
    'Controls not listed keep the recipe values and preset inheritance. Numerical settings are held fixed except for the declared preview/verification tier; explicit per-shot changes replace shared values only for that recorded shot.',
    'Reported ranges describe retained solutions, not confidence intervals. A narrow sampled range cannot establish identification. Independent future shots are needed to test predictions.',
  ];
  if (!candidates.length)
    notes.push(
      'No setup matched every stated tolerance within this search. Closest verified misses are shown separately; locks and tolerances were not relaxed.',
    );
  if (failures.size) notes.push(`Rejected candidate examples: ${[...failures].join(' ')}`);
  if (inactive.size)
    notes.push(
      `Uninformative in at least one replay: ${[...inactive].map((path) => parameters.get(path)?.label ?? path).join(', ')}. These values cannot be inferred from an inactive model branch.`,
    );
  if (axes.length > request.observations.reduce((n, o) => n + 1 + Number(o.tdsPercent != null), 0))
    notes.push(
      'There are more free setup coordinates than independent mass/TDS measurements. Multiple or continuously varying explanations should be expected.',
    );
  for (const candidate of [...candidates, ...nearMisses]) {
    if (inactive.size)
      candidate.notes.push(
        'Some searched model coordinates were inactive in a replay; their sampled values are unresolved assumptions.',
      );
  }
  progress();
  return {
    candidates,
    nearMisses,
    evaluations,
    skipped,
    coreVersion: catalog.coreVersion,
    notes,
    exploredRanges: axes.map((axis) => {
      const values = candidates.map((candidate) => candidate.values[axis.parameter.path]);
      return axis.values
        ? { path: axis.parameter.path, values: [...new Set(values)] }
        : {
            path: axis.parameter.path,
            min: values.length ? Math.min(...(values as number[])) : undefined,
            max: values.length ? Math.max(...(values as number[])) : undefined,
          };
    }),
  };
}
