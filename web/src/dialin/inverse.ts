// SPDX-License-Identifier: GPL-2.0-or-later
/** Bounded recipe search. Every evaluation calls the existing shared physics engine. */
import { isAbortError, type Engine } from '../engine/engine';
import type { TasteEstimate } from '../engine/m3Types';
import type { Diagnostics, Catalog, Recipe, Summary } from '../engine/shotTypes';
import { FIELDS } from '../shot/recipeFields';
import { applyCalibration, scopeKey } from './calibration';
import { learnTaste } from './learning';
import type { CalibrationProfile, JournalEntry } from './types';

export interface Bounds {
  min: number;
  max: number;
  /** Legal values are min + n * step, including when equipment bounds truncate the range. */
  step: number;
}

export interface InverseOptions {
  mode: 'recipe' | 'outcome' | 'next';
  targetTimeS?: number;
  targetYieldG?: number;
  targetTdsPercent?: number;
  targetEyPercent?: number;
  targetTaste?: { attribute: 'acidity' | 'bitterness' | 'astringency' | 'body'; index: number };
  /** Grinder varies by default. Other controls stay fixed unless bounds are supplied. */
  controls?: { grinder?: Bounds; dose?: Bounds; yield?: Bounds; temp?: Bounds };
  calibration?: CalibrationProfile;
  coreVersion?: string;
  lastShot?: JournalEntry;
  ratedShots?: JournalEntry[];
  /** Optional next-shot preference weight, 0–1; target loss remains separately visible. */
  preferenceWeight?: number;
  /** Tier 0 engine calls, 12–240. Tier 1 and next-shot reference checks are separate. */
  maxEvaluations?: number;
}

export interface InverseEvaluation {
  summary: Summary;
  taste?: TasteEstimate;
  score: number;
  rankingScore: number;
  learnedRating?: { mean: number; p05: number; p95: number; sd: number; count: number };
  /** Signed prediction minus target, in the indicated practical units. */
  residuals: {
    timeS?: number;
    yieldG?: number;
    tdsPercent?: number;
    eyPoints?: number;
    tasteIndex?: number;
  };
}

export interface InverseEnvelope {
  kind: 'local_control_perturbation_envelope_not_confidence_interval';
  samples: number;
  timeS: [number, number];
  yieldG: [number, number];
  tdsPercent: [number, number];
  eyPercent: [number, number];
}

export interface InverseCandidate {
  /** Uncalibrated practical recipe, suitable for loading into the shared editor. */
  recipe: Recipe;
  /** The calibrated Tier 1 recipe that produced verified.summary. */
  executedRecipe: Recipe;
  preview: InverseEvaluation;
  /** Tier 0 can need a different pump stop from the verified Tier 1 candidate. */
  previewRecipe: Recipe;
  verified: InverseEvaluation;
  score: number;
  rankingScore: number;
  learnedRating?: InverseEvaluation['learnedRating'];
  warnings: string[];
  envelope: InverseEnvelope;
}

export interface InverseProgress {
  stage: 'search' | 'verify';
  completed: number;
  total: number;
  bestScore?: number;
}

export interface InverseResult {
  mode: InverseOptions['mode'];
  candidates: InverseCandidate[];
  evaluations: number;
  skipped: number;
  notes: string[];
  modelError: 'unavailable';
}

type Control = 'grinder' | 'dose' | 'yield' | 'temp';
interface Axis {
  control: Control;
  bounds: Bounds;
  first: number;
  last: number;
  initial: number;
}
interface Point {
  coordinates: number[];
  recipe: Recipe;
  evaluation: InverseEvaluation;
  warnings: string[];
}

const finite = (value: number): boolean => Number.isFinite(value);
const clone = (recipe: Recipe): Recipe => structuredClone(recipe);

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Search cancelled.', 'AbortError');
}

function validateTarget(value: number | undefined, label: string, min: number, max: number): void {
  if (value !== undefined && (!finite(value) || value < min || value > max)) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

function axis(
  control: Control,
  bounds: Bounds,
  initial: number,
  limits: [number, number],
  minExclusive = false,
): Axis {
  if (
    ![bounds.min, bounds.max, bounds.step, initial, ...limits].every(finite) ||
    bounds.min > bounds.max ||
    limits[0] > limits[1] ||
    bounds.step <= 0 ||
    (bounds.max - bounds.min) / bounds.step > 100_000
  )
    throw new Error(`Invalid ${control} bounds: use finite min ≤ max and a positive step.`);
  let first = Math.max(0, Math.ceil((limits[0] - bounds.min) / bounds.step - 1e-9));
  let last = Math.floor((Math.min(limits[1], bounds.max) - bounds.min) / bounds.step + 1e-9);
  // Index-space rounding tolerance must never admit a physically out-of-bounds
  // value when an extreme hardware step magnifies that tolerance.
  const grid = (index: number) => bounds.min + index * bounds.step;
  if (grid(first) < Math.max(bounds.min, limits[0]) - 1e-9) first++;
  if (minExclusive && grid(first) <= limits[0]) first++;
  if (grid(last) > Math.min(bounds.max, limits[1]) + 1e-9) last--;
  if (first > last || ![grid(first), grid(last)].every(finite))
    throw new Error(`No ${control} values fit the equipment limits.`);
  return {
    control,
    bounds: { ...bounds },
    first,
    last,
    initial: Math.max(first, Math.min(last, Math.round((initial - bounds.min) / bounds.step))),
  };
}

function recipeLimits(path: string): [number, number] {
  const { min, max } = FIELDS[path];
  if (min === undefined || max === undefined)
    throw new Error(`Missing recipe schema bounds for ${path}.`);
  return [min, max];
}

function valueAt(a: Axis, coordinate: number): number {
  // Round floating point noise, preserving practical hardware step sizes.
  return Number((a.bounds.min + coordinate * a.bounds.step).toPrecision(13));
}

function prepare(base: Recipe, catalog: Catalog, options: InverseOptions) {
  const recipe = clone(base);
  const controls = options.controls ?? {};
  const grinder = catalog.presets.grinders.find((g) => g.id === base.grinder.preset);
  const machine = catalog.presets.machines.find((m) => m.id === base.machine.preset);
  const basket = base.basket.custom
    ? undefined
    : catalog.presets.baskets.find((b) => b.id === (base.basket.preset ?? machine?.default_basket));
  const gapMode = base.grinder.gap_um != null || (!grinder && base.grinder.setting == null);
  const currentGrind = gapMode
    ? base.grinder.gap_um
    : (base.grinder.setting ?? grinder?.dial.default);
  const axes: Axis[] = [];
  if (base.grinder.psd) {
    if (controls.grinder)
      throw new Error('A measured PSD fixes the grind; remove it before varying grinder settings.');
  } else if (currentGrind != null) {
    const limits: [number, number] = gapMode
      ? recipeLimits('grinder.gap_um')
      : grinder
        ? [grinder.dial.min, grinder.dial.max]
        : [-Number.MAX_VALUE, Number.MAX_VALUE];
    const bounds =
      controls.grinder ??
      (gapMode
        ? {
            min: currentGrind * 0.65,
            max: currentGrind * 1.35,
            step: Math.max(1, currentGrind / 100),
          }
        : grinder
          ? { min: limits[0], max: limits[1], step: Math.max(0.01, (limits[1] - limits[0]) / 80) }
          : { min: currentGrind - 10, max: currentGrind + 10, step: 0.25 });
    axes.push(
      axis(
        'grinder',
        bounds,
        currentGrind,
        limits,
        gapMode && FIELDS['grinder.gap_um'].minExclusive,
      ),
    );
  } else if (controls.grinder) {
    throw new Error(
      'Select a grinder preset or supply a burr gap before searching grind settings.',
    );
  }
  // Custom baskets have no nominal dose range: the shared builder checks their
  // actual geometric capacity for each candidate. Unknown presets also reach
  // the builder, which reports the unsupported gear rather than inventing a range.
  const doseLimits = basket?.dose_range_g ?? recipeLimits('prep.dose_g');
  if (controls.dose) axes.push(axis('dose', controls.dose, recipe.prep.dose_g, doseLimits));
  else if (recipe.prep.dose_g < doseLimits[0] || recipe.prep.dose_g > doseLimits[1]) {
    throw new Error(`Dose must fit the basket's ${doseLimits[0]}–${doseLimits[1]} g range.`);
  }
  const yieldG =
    options.targetYieldG ??
    (options.mode === 'next' ? options.lastShot?.measurement?.yieldG : undefined) ??
    recipe.stop.beverage_g;
  if (options.targetYieldG !== undefined) recipe.stop = { beverage_g: options.targetYieldG };
  if (controls.yield && options.targetYieldG === undefined) {
    axes.push(axis('yield', controls.yield, yieldG ?? 36, [1, 250]));
    recipe.stop = { beverage_g: yieldG ?? 36 };
  }
  const temp = recipe.machine.temperature_c ?? machine?.temperature_c ?? 93;
  if (controls.temp)
    axes.push(axis('temp', controls.temp, temp, machine?.temperature_range_c ?? [80, 100]));
  const pumpStop =
    options.targetYieldG === undefined
      ? null
      : axis(
          'yield',
          controls.yield ?? {
            min: 1,
            max: 250,
            step: 0.1,
          },
          yieldG ?? 36,
          [1, 250],
        );
  return { recipe, axes, gapMode, pumpStop };
}

function makeRecipe(base: Recipe, axes: Axis[], coordinates: number[], gapMode: boolean): Recipe {
  const recipe = clone(base);
  for (let i = 0; i < axes.length; i++) {
    const value = valueAt(axes[i], coordinates[i]);
    switch (axes[i].control) {
      case 'grinder':
        if (gapMode) recipe.grinder.gap_um = value;
        else recipe.grinder.setting = value;
        break;
      case 'dose':
        recipe.prep.dose_g = value;
        break;
      case 'yield':
        recipe.stop = { beverage_g: value };
        break;
      case 'temp':
        recipe.machine.temperature_c = value;
        break;
    }
  }
  return recipe;
}

function warningsOf(summary: Summary, diagnostics: Diagnostics): string[] | null {
  if (
    ![summary.shot_time_s, summary.beverage_mass_kg, summary.tds, summary.ey].every(finite) ||
    summary.shot_time_s <= 0 ||
    summary.beverage_mass_kg <= 0 ||
    summary.tds <= 0 ||
    summary.tds > 1 ||
    summary.ey <= 0 ||
    summary.ey > 1 ||
    /choked|max_duration|error|failed/i.test(summary.stop_reason) ||
    !finite(diagnostics.mass_balance_error) ||
    Math.abs(diagnostics.mass_balance_error) > 0.001 ||
    !finite(diagnostics.min_concentration_kg_m3 ?? 0) ||
    (diagnostics.min_concentration_kg_m3 ?? 0) < -1e-10
  )
    return null;
  const warnings = diagnostics.warnings ?? [];
  return warnings.some((warning) =>
    /non.?finite|negative concentration|unstable|not converg|solver fail|mass.balance.*(?:fail|exceed)/i.test(
      warning,
    ),
  )
    ? null
    : [...warnings];
}

function score(
  summary: Summary,
  taste: TasteEstimate | undefined,
  options: InverseOptions,
  timeBias: number,
): InverseEvaluation | null {
  const residuals: InverseEvaluation['residuals'] = {};
  let total = 0;
  const add = (key: keyof typeof residuals, residual: number, scale: number) => {
    residuals[key] = residual;
    total += (residual / scale) ** 2;
  };
  if (options.mode !== 'outcome' || options.targetTimeS !== undefined) {
    add('timeS', summary.shot_time_s + timeBias - (options.targetTimeS ?? 28), 3);
  }
  if (options.targetYieldG !== undefined)
    add('yieldG', summary.beverage_mass_kg * 1000 - options.targetYieldG, 2);
  if (options.mode !== 'recipe') {
    if (options.targetTdsPercent !== undefined)
      add('tdsPercent', summary.tds * 100 - options.targetTdsPercent, 0.5);
    if (options.targetEyPercent !== undefined)
      add('eyPoints', summary.ey * 100 - options.targetEyPercent, 1);
    if (options.targetTaste) {
      const attribute = options.targetTaste.attribute;
      const index = taste?.[`${attribute}_index`];
      if (index == null || !finite(index)) return null;
      // One attribute's own index only; different taste scales are never added together.
      add('tasteIndex', index - options.targetTaste.index, 10);
    }
  }
  return { summary, ...(taste ? { taste } : {}), score: total, rankingScore: total, residuals };
}

function envelope(points: Point[]): InverseEnvelope {
  const range = (get: (summary: Summary) => number): [number, number] => {
    const values = points.map((p) => get(p.evaluation.summary));
    return [Math.min(...values), Math.max(...values)];
  };
  return {
    kind: 'local_control_perturbation_envelope_not_confidence_interval',
    samples: points.length,
    timeS: range((s) => s.shot_time_s),
    yieldG: range((s) => s.beverage_mass_kg * 1000),
    tdsPercent: range((s) => s.tds * 100),
    eyPercent: range((s) => s.ey * 100),
  };
}

function preferenceData(base: Recipe, options: InverseOptions, coreVersion: string) {
  const setup = options.lastShot?.setupId ?? options.calibration?.setupId;
  const possible = (options.ratedShots ?? []).filter((entry) => {
    const rating = entry.measurement?.rating;
    const taste = entry.prediction?.taste;
    return (
      (!setup || entry.setupId === setup) &&
      scopeKey(entry.recipe) === scopeKey(base) &&
      entry.prediction?.coreVersion === coreVersion &&
      rating !== undefined &&
      finite(rating) &&
      rating >= 1 &&
      rating <= 5 &&
      taste &&
      [
        taste.acidity_index,
        taste.bitterness_index,
        taste.astringency_index,
        taste.body_index,
      ].every((value) => value != null && finite(value) && value >= 0 && value <= 100)
    );
  });
  const setupId = setup ?? possible[0]?.setupId ?? '';
  const entries = possible.filter((entry) => entry.setupId === setupId);
  const rows = entries.map((entry) => {
    const t = entry.prediction!.taste!;
    return [t.acidity_index!, t.bitterness_index!, t.astringency_index!, t.body_index!];
  });
  const diverse =
    entries.length >= 5 &&
    new Set(entries.map((e) => e.measurement!.rating)).size >= 2 &&
    new Set(rows.map((row) => row.map((v) => v.toFixed(2)).join(','))).size >= 3 &&
    [0, 1, 2, 3].some(
      (index) =>
        Math.max(...rows.map((r) => r[index])) - Math.min(...rows.map((r) => r[index])) >= 5,
    );
  return { entries, setupId, diverse };
}

/** Deterministic multistart coordinate search, followed by independent Tier 1 verification. */
export async function searchRecipes(
  engine: Engine,
  base: Recipe,
  catalog: Catalog,
  options: InverseOptions,
  signal?: AbortSignal,
  onProgress?: (progress: InverseProgress) => void,
): Promise<InverseResult> {
  abort(signal);
  // A recipe target defaults to the current beverage amount as a final-cup target.
  // Next-shot mode prefers the last measured yield when no explicit yield is supplied.
  options = {
    ...options,
    targetYieldG:
      options.targetYieldG ??
      (options.mode === 'next' ? options.lastShot?.measurement?.yieldG : undefined) ??
      (options.mode !== 'outcome' ? (base.stop.beverage_g ?? 36) : undefined),
  };
  if (!['recipe', 'outcome', 'next'].includes(options.mode))
    throw new Error('Unknown inverse mode.');
  validateTarget(options.targetTimeS, 'Target time', 1, 300);
  validateTarget(options.targetYieldG, 'Target yield', 1, 250);
  validateTarget(options.targetTdsPercent, 'Target TDS', 0.01, 50);
  validateTarget(options.targetEyPercent, 'Target EY', 0.01, 50);
  validateTarget(options.preferenceWeight, 'Preference weight', 0, 1);
  if (options.targetTaste) {
    if (!['acidity', 'bitterness', 'astringency', 'body'].includes(options.targetTaste.attribute))
      throw new Error('Unknown taste attribute.');
    validateTarget(options.targetTaste.index, 'Target taste index', 0, 100);
  }
  if (
    options.mode === 'outcome' &&
    options.targetTdsPercent === undefined &&
    options.targetEyPercent === undefined &&
    !options.targetTaste
  ) {
    throw new Error('Choose an EY, TDS or single taste target for outcome mode.');
  }
  const budget = options.maxEvaluations ?? 96;
  if (!Number.isInteger(budget) || budget < 12 || budget > 240)
    throw new Error('Search evaluations must be an integer from 12 to 240.');
  if (options.coreVersion !== undefined && options.coreVersion !== catalog.coreVersion)
    throw new Error(
      'The requested core version differs from the current catalog; reload before searching.',
    );
  const { recipe, axes, gapMode, pumpStop } = prepare(base, catalog, options);
  if (
    options.calibration &&
    (options.calibration.scopeKey !== scopeKey(base) ||
      options.calibration.coreVersion !== catalog.coreVersion)
  ) {
    throw new Error('The calibration does not match this setup and core version.');
  }
  if (options.calibration && options.controls?.temp) {
    throw new Error(
      'Temperature changes exceed this local calibration scope. Uncheck local calibration before varying temperature.',
    );
  }
  const preference = preferenceData(base, options, catalog.coreVersion);
  if (options.mode === 'next' && !options.lastShot?.measurement && !preference.diverse) {
    throw new Error(
      'Next-shot mode needs a measured last shot or at least five varied rated shots for this setup.',
    );
  }
  const usePreference = options.mode === 'next' && preference.diverse;
  const addPreference = (evaluation: InverseEvaluation): InverseEvaluation => {
    if (!usePreference) return evaluation;
    const personal = learnTaste(preference.entries, preference.setupId, evaluation.taste);
    if (!personal.prediction) return evaluation;
    const learnedRating = { ...personal.prediction, count: personal.count };
    return {
      ...evaluation,
      learnedRating,
      rankingScore:
        evaluation.score + ((options.preferenceWeight ?? 0) * (5 - learnedRating.mean)) / 4,
    };
  };
  const execute = (r: Recipe, tier: 0 | 1): Recipe => {
    const applied = options.calibration
      ? applyCalibration(r, options.calibration, catalog.coreVersion)
      : clone(r);
    return { ...applied, numerics: { ...applied.numerics, tier } };
  };
  const notes = [
    'Search uses the shared Tier 0 physics engine; all returned candidates were checked independently at Tier 1.',
    'Scores express scaled target residuals, not probabilities or measured taste quality. Lower is closer.',
    'Local control perturbation envelopes are sensitivity ranges, not confidence or predictive intervals. Model error is unavailable.',
    'No prospective accuracy claim is established by this search.',
  ];
  if (options.targetYieldG !== undefined)
    notes.push(
      'Yield targets refer to the final cup, including post-stop drip. Pump-stop beverage is adjusted independently at each tier within legal stop limits; residuals report any remaining miss.',
    );
  if (usePreference)
    notes.push(
      `Personal rating predictions use ${preference.entries.length} matching rated shots with at least three varied taste vectors, a ≥5-point attribute span and more than one rating. Preference ranking weight is ${options.preferenceWeight ?? 0}; target loss remains separate. Rating uncertainty is conditional on the stated Bayesian preference model.`,
    );
  else if (options.mode === 'next')
    notes.push(
      'Personal preference ranking is unavailable: it needs at least five matching rated shots, three varied taste vectors spanning ≥5 points, and more than one rating.',
    );
  if (!options.controls?.grinder && !base.grinder.psd)
    notes.push('The default grinder grid is illustrative; set its step to match your equipment.');
  let timeBias0 = 0;
  let timeBias1 = 0;
  let skipped = 0;
  const cache = new Map<string, Point | null>();
  let evaluations = 0;
  const simulateCandidate = async (input: Recipe, tier: 0 | 1, referenceYieldG?: number) => {
    const isReference = referenceYieldG !== undefined;
    const targetCupG = referenceYieldG ?? options.targetYieldG;
    // Observations are reconstructed at their measured final yield, independently
    // of the new recipe's requested hardware search limits.
    const cupStop = isReference
      ? axis('yield', { min: 1, max: 250, step: 0.1 }, referenceYieldG, [1, 250])
      : pumpStop;
    let working = clone(input);
    if (cupStop) working.stop = { beverage_g: valueAt(cupStop, cupStop.initial) };
    type Run = {
      recipe: Recipe;
      executedRecipe: Recipe;
      summary: Summary;
      diagnostics: Diagnostics;
      taste?: TasteEstimate;
      notes: string[];
    };
    let best: Run | null = null;
    let bestYieldError = Infinity;
    // Drip depends on flow and can differ by tier. Re-run the same physics at
    // corrected pump-stop weights, rather than editing a result's cup mass.
    for (let correction = 0; correction < (cupStop ? 4 : 1); correction++) {
      abort(signal);
      if (tier === 0 && !isReference && evaluations >= budget) break;
      const executedRecipe = execute(working, tier);
      if (tier === 0 && !isReference) evaluations++;
      let summary: Summary;
      let diagnostics: Diagnostics;
      let taste: TasteEstimate | undefined;
      let buildNotes: string[] = [];
      if (
        !isReference &&
        (tier === 1 ||
          (options.targetTaste && options.mode !== 'recipe') ||
          (usePreference && (options.preferenceWeight ?? 0) > 0))
      ) {
        const run = await engine.simulateRecipe(executedRecipe, { signal });
        ({ summary, diagnostics } = run.result.result);
        taste = run.result.taste;
        buildNotes = run.result.build.derived.notes;
      } else {
        const run = await engine.sweepPoint(executedRecipe, { signal });
        ({ summary, diagnostics } = run.result);
      }
      abort(signal);
      if (!warningsOf(summary, diagnostics)) return null;
      const current: Run = {
        recipe: working,
        executedRecipe,
        summary,
        diagnostics,
        taste,
        notes: buildNotes,
      };
      const error = targetCupG === undefined ? 0 : targetCupG - summary.beverage_mass_kg * 1000;
      if (Math.abs(error) < bestYieldError) {
        best = current;
        bestYieldError = Math.abs(error);
      }
      if (!cupStop || Math.abs(error) <= 0.15) break;
      const next = Math.max(
        cupStop.first,
        Math.min(
          cupStop.last,
          Math.round((working.stop.beverage_g! + error - cupStop.bounds.min) / cupStop.bounds.step),
        ),
      );
      const stopG = valueAt(cupStop, next);
      if (Math.abs(stopG - working.stop.beverage_g!) < 1e-9) break;
      working = { ...clone(working), stop: { beverage_g: stopG } };
    }
    return best;
  };
  // Compare time at the observed final cup mass, including drip, at both tiers.
  // This local residual correction is explicit and never changes fitted physics.
  if (options.mode === 'next' && options.lastShot?.measurement) {
    if (scopeKey(options.lastShot.recipe) !== scopeKey(base))
      throw new Error('The last shot belongs to a different setup.');
    const measured = options.lastShot.measurement.timeS;
    const observedYieldG = options.lastShot.measurement.yieldG;
    if (!finite(measured) || measured <= 0)
      throw new Error('The last shot needs a positive measured time.');
    validateTarget(observedYieldG, 'Last measured final yield', 1, 250);
    for (const tier of [0, 1] as const) {
      abort(signal);
      const reference = await simulateCandidate(options.lastShot.recipe, tier, observedYieldG);
      abort(signal);
      if (!reference)
        throw new Error('The last shot could not be reproduced for next-shot advice.');
      if (Math.abs(reference.summary.beverage_mass_kg * 1000 - observedYieldG) > 0.2) {
        notes.push(
          `Tier ${tier} last-shot time correction was skipped because the observed final yield could not be matched within 0.2 g.`,
        );
        continue;
      }
      const bias = measured - reference.summary.shot_time_s;
      if (tier === 0) timeBias0 = bias;
      else timeBias1 = bias;
    }
    notes.push(
      `Next-shot time residuals compare the last measurement with predictions at its ${observedYieldG.toFixed(2)} g observed final yield (Tier 0 correction ${timeBias0.toFixed(2)} s; Tier 1 ${timeBias1.toFixed(2)} s). Physical predictions are shown unchanged; transfer to a new recipe is an unvalidated assumption.`,
    );
  }
  const ranked = () =>
    [...cache.values()]
      .filter((p): p is Point => p !== null)
      .sort(
        (a, b) =>
          a.evaluation.rankingScore - b.evaluation.rankingScore ||
          a.coordinates.join(',').localeCompare(b.coordinates.join(',')),
      );
  const evaluate = async (coordinates: number[]): Promise<Point | null> => {
    abort(signal);
    const key = coordinates.join(',');
    if (cache.has(key)) return cache.get(key)!;
    if (evaluations >= budget) return null;
    const candidate = makeRecipe(recipe, axes, coordinates, gapMode);
    let point: Point | null = null;
    try {
      const run = await simulateCandidate(candidate, 0);
      abort(signal);
      const warnings = run ? warningsOf(run.summary, run.diagnostics) : null;
      const scored = run && warnings ? score(run.summary, run.taste, options, timeBias0) : null;
      const evaluation = scored ? addPreference(scored) : null;
      if (evaluation)
        point = {
          coordinates: [...coordinates],
          recipe: run!.recipe,
          evaluation,
          warnings: warnings!,
        };
    } catch (error) {
      abort(signal);
      if (isAbortError(error)) throw error;
    }
    if (!point) skipped++;
    cache.set(key, point);
    onProgress?.({
      stage: 'search',
      completed: evaluations,
      total: budget,
      bestScore: ranked()[0]?.evaluation.score,
    });
    return point;
  };
  const initial = axes.map((a) => a.initial);
  await evaluate(initial);
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    await evaluate(axes.map((a) => a.first + Math.round((a.last - a.first) * fraction)));
  }
  const searchBudget = Math.max(6, budget - Math.min(axes.length * 6, 18));
  // Refine several seeds to avoid assuming that EY or taste is monotone with grind.
  for (const seed of ranked().slice(0, 3)) {
    let current = seed;
    let strides = axes.map((a) => Math.max(1, Math.ceil((a.last - a.first) / 4)));
    for (let pass = 0; pass < 16 && evaluations < searchBudget; pass++) {
      let improved = false;
      for (let dimension = 0; dimension < axes.length && evaluations < searchBudget; dimension++) {
        for (const direction of [-1, 1]) {
          const trial = [...current.coordinates];
          trial[dimension] = Math.max(
            axes[dimension].first,
            Math.min(axes[dimension].last, trial[dimension] + direction * strides[dimension]),
          );
          const point = await evaluate(trial);
          if (point && point.evaluation.rankingScore < current.evaluation.rankingScore - 1e-12) {
            current = point;
            improved = true;
          }
        }
      }
      if (!improved) {
        if (strides.every((s) => s === 1)) break;
        strides = strides.map((s) => Math.max(1, Math.floor(s / 2)));
      }
    }
  }
  const finalists = ranked().slice(0, 3);
  const candidates: InverseCandidate[] = [];
  for (let index = 0; index < finalists.length; index++) {
    const point = finalists[index];
    const neighbours = [point];
    for (let dimension = 0; dimension < axes.length; dimension++) {
      for (const direction of [-1, 1]) {
        const trial = [...point.coordinates];
        trial[dimension] += direction;
        if (trial[dimension] < axes[dimension].first || trial[dimension] > axes[dimension].last)
          continue;
        const neighbour = await evaluate(trial);
        if (neighbour) neighbours.push(neighbour);
      }
    }
    abort(signal);
    try {
      const run = await simulateCandidate(point.recipe, 1);
      abort(signal);
      const warnings = run ? warningsOf(run.summary, run.diagnostics) : null;
      const scored = run && warnings ? score(run.summary, run.taste, options, timeBias1) : null;
      const verified = scored ? addPreference(scored) : null;
      if (verified)
        candidates.push({
          recipe: run!.recipe,
          executedRecipe: run!.executedRecipe,
          preview: point.evaluation,
          previewRecipe: point.recipe,
          verified,
          score: verified.score,
          rankingScore: verified.rankingScore,
          ...(verified.learnedRating ? { learnedRating: verified.learnedRating } : {}),
          warnings: [
            ...new Set([
              ...point.warnings,
              ...warnings!,
              ...run!.notes,
              ...(Math.abs(verified.residuals.yieldG ?? 0) > 0.2
                ? [
                    'The final cup yield target was not reached within the pump-stop limits and correction budget.',
                  ]
                : []),
            ]),
          ],
          envelope: envelope(neighbours),
        });
      else skipped++;
    } catch (error) {
      abort(signal);
      if (isAbortError(error)) throw error;
      skipped++;
    }
    onProgress?.({
      stage: 'verify',
      completed: index + 1,
      total: finalists.length,
      bestScore: candidates.length ? Math.min(...candidates.map((c) => c.score)) : undefined,
    });
  }
  abort(signal);
  candidates.sort((a, b) => a.rankingScore - b.rankingScore);
  if (!candidates.length)
    notes.push('No candidate passed the numerical and Tier 1 checks within the search limits.');
  if (candidates[0] && candidates[0].score > 1)
    notes.push(
      'The highest-ranked verified candidate still misses the combined target tolerances; the targets may be unreachable within these limits.',
    );
  return { mode: options.mode, candidates, evaluations, skipped, notes, modelError: 'unavailable' };
}
