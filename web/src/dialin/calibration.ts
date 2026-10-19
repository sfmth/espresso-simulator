// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Local Bayesian calibration by exhaustive, bounded finite-grid quadrature.
 * This is neither MCMC nor a Laplace approximation. Only the Rust Engine runs
 * shot physics. The grid posterior is conditional on fixed startup/other model
 * closures; its intervals are not a prediction interval or proof of mechanism.
 */
import type { Engine } from '../engine/engine';
import type { Catalog, Diagnostics, Recipe, Summary } from '../engine/shotTypes';
import type { CalibrationParameter, CalibrationProfile, JournalEntry } from './types';

export interface CalibrationOptions {
  setupId: string;
  fitGrinderScale?: boolean;
  timeSigmaS?: number;
  tdsSigmaPercent?: number;
}

const PERMEABILITY = 'hydraulics.permeability.reference';
const X50 = 'psd.x50_gap_ratio';
const MAX_SHOTS = 12;
const K_LOG_SD = Math.log(2);
const G_LOG_SD = Math.log(1.12);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Exact bag descriptors and equipment/water/prep; settings may vary in a sweep. */
export function scopeKey(recipe: Recipe): string {
  const grinder = Object.fromEntries(
    Object.entries(recipe.grinder).filter(([key]) => !['setting', 'gap_um', 'psd'].includes(key)),
  );
  if (recipe.grinder.psd) grinder.psd = { method: recipe.grinder.psd.method ?? null };
  const prep = Object.fromEntries(Object.entries(recipe.prep).filter(([key]) => key !== 'dose_g'));
  return `puckworks.calibration-scope/1:${canonical({
    schema: recipe.schema,
    bean: recipe.bean,
    water: recipe.water,
    chemistry: recipe.chemistry,
    grinder,
    basket: recipe.basket,
    prep,
    machine: recipe.machine,
    overrides: recipe.overrides,
  })}`;
}

function positive(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
  return value;
}

function adjustedRecipe(
  recipe: Recipe,
  permeability: number,
  grinderScale: number,
  referencePermeability: number,
  referenceX50GapRatio?: number,
): Recipe {
  const copy = structuredClone(recipe);
  copy.overrides = { ...copy.overrides, [PERMEABILITY]: referencePermeability * permeability };
  if (grinderScale !== 1) {
    if (copy.grinder.psd) {
      copy.grinder.psd.diameter_um = copy.grinder.psd.diameter_um.map((d) => d * grinderScale);
    } else {
      // Scaling X50, rather than the dial/gap, also respects a supplied explicit gap.
      copy.grinder.x50_gap_ratio =
        positive(referenceX50GapRatio, 'Reference X50/gap ratio') * grinderScale;
    }
  }
  return copy;
}

/** Refuse stale core versions or a different bag/setup recipe before applying. */
export function applyCalibration(
  recipe: Recipe,
  profile: CalibrationProfile,
  coreVersion?: string,
): Recipe {
  if (!coreVersion || profile.coreVersion !== coreVersion) {
    throw new Error(
      'Calibration requires the matching current core version; refit after a core update.',
    );
  }
  if (scopeKey(recipe) !== profile.scopeKey) {
    throw new Error('Calibration scope does not match this bag, equipment, water or preparation.');
  }
  return adjustedRecipe(
    recipe,
    positive(profile.permeability, 'Permeability multiplier'),
    positive(profile.grinderScale, 'Grinder scale'),
    positive(profile.referencePermeability, 'Reference permeability'),
    profile.referenceX50GapRatio,
  );
}

function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function grid(logExtent: number, halfSteps: number): number[] {
  return Array.from({ length: 2 * halfSteps + 1 }, (_, i) =>
    Math.exp(((i - halfSteps) * logExtent) / halfSteps),
  );
}

function normalise(logWeights: number[]): number[] {
  const max = Math.max(...logWeights);
  if (!Number.isFinite(max))
    throw new Error('No calibration candidate could simulate every training shot.');
  const weights = logWeights.map((v) => Math.exp(v - max));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((v) => v / sum);
}

function quantile(values: number[], weights: number[], fraction: number): number {
  const sorted = values
    .map((value, i) => ({ value, weight: weights[i] }))
    .sort((a, b) => a.value - b.value);
  let cumulative = 0;
  for (const point of sorted) {
    cumulative += point.weight;
    if (cumulative >= fraction) return point.value;
  }
  return sorted.at(-1)!.value;
}

function parameter(
  id: CalibrationParameter['id'],
  values: number[],
  posterior: number[],
  prior: number[],
  map: number,
  correlation: number,
): CalibrationParameter {
  const p05 = quantile(values, posterior, 0.05);
  const p95 = quantile(values, posterior, 0.95);
  // Marginal KL is computed after aggregating the other parameter's grid axis.
  const marginal = new Map<number, { posterior: number; prior: number }>();
  values.forEach((value, i) => {
    const mass = marginal.get(value) ?? { posterior: 0, prior: 0 };
    mass.posterior += posterior[i];
    mass.prior += prior[i];
    marginal.set(value, mass);
  });
  const information = [...marginal.values()].reduce(
    (sum, mass) =>
      sum + (mass.posterior > 0 ? mass.posterior * Math.log(mass.posterior / mass.prior) : 0),
    0,
  );
  let status =
    information < 0.1
      ? 'Prior dominated: data add little information'
      : 'Constrained within the assumed model and finite grid';
  if (Math.abs(correlation) >= 0.85)
    status = 'Confounded: permeability/grinder effects cannot be separated reliably';
  if (p05 === Math.min(...values) || p95 === Math.max(...values))
    status += '; interval reaches grid boundary';
  return {
    id,
    label: id === 'permeability' ? 'Bag permeability multiplier' : 'Grinder X50 scale',
    map,
    p05,
    p95,
    status,
  };
}

function posteriorCorrelation(ks: number[], gs: number[], weights: number[]): number {
  const x = ks.map(Math.log);
  const y = gs.map(Math.log);
  const mx = x.reduce((sum, v, i) => sum + v * weights[i], 0);
  const my = y.reduce((sum, v, i) => sum + v * weights[i], 0);
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  weights.forEach((w, i) => {
    covariance += w * (x[i] - mx) * (y[i] - my);
    vx += w * (x[i] - mx) ** 2;
    vy += w * (y[i] - my) ** 2;
  });
  return vx * vy > 1e-20 ? covariance / Math.sqrt(vx * vy) : 0;
}

/** Detect narrow aliased ridges even when a coarse posterior grid misses them. */
function sensitivityCorrelation(
  candidates: { permeability: number; grinderScale: number }[],
  predictions: Summary[][],
  best: number,
  training: JournalEntry[],
  timeSigmaS: number,
  tdsSigmaPercent: number,
): number | undefined {
  const derivative = (axis: 'permeability' | 'grinderScale'): number[] | undefined => {
    const fixed = axis === 'permeability' ? 'grinderScale' : 'permeability';
    const line = candidates
      .map((candidate, i) => ({ ...candidate, i }))
      .filter((candidate) => candidate[fixed] === candidates[best][fixed])
      .sort((a, b) => a[axis] - b[axis]);
    const index = line.findIndex((candidate) => candidate.i === best);
    const low = line[Math.max(0, index - 1)];
    const high = line[Math.min(line.length - 1, index + 1)];
    if (
      low.i === high.i ||
      predictions[low.i].length !== training.length ||
      predictions[high.i].length !== training.length
    )
      return undefined;
    const delta = Math.log(high[axis]) - Math.log(low[axis]);
    return training.flatMap((entry, j) => {
      const m = entry.measurement!;
      const outputs = [
        ((predictions[high.i][j].beverage_mass_kg - predictions[low.i][j].beverage_mass_kg) *
          1000) /
          ((timeSigmaS * m.yieldG) / m.timeS) /
          delta,
      ];
      if (m.tdsPercent !== undefined)
        outputs.push(
          ((predictions[high.i][j].tds - predictions[low.i][j].tds) * 100) /
            tdsSigmaPercent /
            delta,
        );
      return outputs;
    });
  };
  const x = derivative('permeability');
  const y = derivative('grinderScale');
  if (!x || !y) return undefined;
  const dot = x.reduce((sum, value, i) => sum + value * y[i], 0);
  const xx = x.reduce((sum, value) => sum + value * value, 0);
  const yy = y.reduce((sum, value) => sum + value * value, 0);
  return xx * yy > 1e-20 ? dot / Math.sqrt(xx * yy) : undefined;
}

function resolvedX50(recipe: Recipe, catalog: Catalog): number | undefined {
  if (recipe.grinder.psd) return undefined;
  const grinder = catalog.presets.grinders.find((g) => g.id === recipe.grinder.preset);
  const family = catalog.presets.grinder_families.find(
    (g) => g.id === (grinder?.family ?? recipe.grinder.family),
  );
  return positive(
    recipe.grinder.x50_gap_ratio ??
      recipe.overrides?.[X50] ??
      grinder?.psd?.x50_gap_ratio ??
      family?.psd.x50_gap_ratio ??
      catalog.registry.parameters.find((p) => p.id === X50)?.default,
    'Resolved grinder X50/gap ratio',
  );
}

function complete(entry: JournalEntry): boolean {
  const m = entry.measurement;
  return (
    !!m &&
    Number.isFinite(m.timeS) &&
    m.timeS > 0 &&
    Number.isFinite(m.yieldG) &&
    m.yieldG > 0 &&
    (m.tdsPercent === undefined ||
      (Number.isFinite(m.tdsPercent) && m.tdsPercent > 0 && m.tdsPercent <= 100))
  );
}

function valid(summary: Summary, diagnostics: Diagnostics): void {
  if (
    ![summary.shot_time_s, summary.beverage_mass_kg, summary.tds, summary.ey].every(
      Number.isFinite,
    ) ||
    summary.shot_time_s <= 0 ||
    summary.beverage_mass_kg <= 0 ||
    summary.tds <= 0 ||
    summary.tds > 1 ||
    summary.ey <= 0 ||
    summary.ey > 1 ||
    /choked|max_duration|error|failed/i.test(summary.stop_reason)
  ) {
    throw new Error('Shot did not complete with finite physical observable outputs.');
  }
  if (
    !Number.isFinite(diagnostics.mass_balance_error) ||
    Math.abs(diagnostics.mass_balance_error) > 0.001 ||
    !Number.isFinite(diagnostics.min_concentration_kg_m3 ?? 0) ||
    (diagnostics.min_concentration_kg_m3 ?? 0) < -1e-10 ||
    diagnostics.warnings.some((warning) =>
      /non.?finite|negative concentration|unstable|not converg|solver fail|mass.balance.*(?:fail|exceed)/i.test(
        warning,
      ),
    )
  ) {
    throw new Error('Shot failed numerical diagnostics checks.');
  }
}

/**
 * The latest completed measured scope in the setup supplies at most 12 shots.
 * Likelihood replays to measured pump-off time and scores final yield, including
 * drip. Its yield sigma is timeSigmaS * observedYield/observedTime, an explicit
 * average-flow approximation. TDS noise is in absolute percentage points.
 */
export async function calibrate(
  engine: Engine,
  entries: JournalEntry[],
  catalog: Catalog,
  options: CalibrationOptions,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<CalibrationProfile> {
  abort(signal);
  const timeSigmaS = positive(options.timeSigmaS ?? 3, 'Time uncertainty');
  const tdsSigmaPercent = positive(options.tdsSigmaPercent ?? 0.15, 'TDS uncertainty');
  const eligible = entries
    .filter((entry) => entry.setupId === options.setupId && complete(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  if (!eligible.length)
    throw new Error(
      'Log at least three completed measured shots in this setup before calibration.',
    );
  const scope = scopeKey(eligible[0].recipe);
  const matching = eligible.filter((entry) => scopeKey(entry.recipe) === scope);
  const training = matching.slice(0, MAX_SHOTS);
  if (training.length < 3)
    throw new Error(
      'Calibration needs at least three completed measurements with the same bag and equipment scope.',
    );
  const currentVersion = (await engine.coreVersion({ signal })).result;
  abort(signal);
  if (currentVersion !== catalog.coreVersion)
    throw new Error('Engine/catalog core versions differ; reload before calibration.');
  const anchor = training[0].recipe;
  const registryK = catalog.registry.parameters.find((p) => p.id === PERMEABILITY);
  const referencePermeability = positive(
    anchor.overrides?.[PERMEABILITY] ?? registryK?.default,
    'Reference permeability',
  );
  const referenceX50GapRatio = resolvedX50(anchor, catalog);
  const settingsWithTds = new Set(
    training
      .filter((entry) => entry.measurement!.tdsPercent !== undefined)
      .map((entry) =>
        canonical(
          entry.recipe.grinder.psd ??
            (entry.recipe.grinder.gap_um != null
              ? { gap_um: entry.recipe.grinder.gap_um }
              : { setting: entry.recipe.grinder.setting }),
        ),
      ),
  );
  const joint = !!options.fitGrinderScale && settingsWithTds.size >= 3;
  const kGrid = grid(Math.log(4), 8).filter(
    (k) =>
      referencePermeability * k >= (registryK?.range.min ?? 0) &&
      referencePermeability * k <= (registryK?.range.max ?? Infinity),
  );
  const gGrid = joint ? grid(Math.log(1.25), 4) : [1];
  const candidates = kGrid.flatMap((k) => gGrid.map((g) => ({ permeability: k, grinderScale: g })));
  if (!candidates.length)
    throw new Error('Reference permeability lies outside the supported calibration bounds.');
  const logPrior = candidates.map(
    (c) =>
      -0.5 * (Math.log(c.permeability) / K_LOG_SD) ** 2 -
      0.5 * (Math.log(c.grinderScale) / G_LOG_SD) ** 2,
  );
  const logPosterior = [...logPrior];
  const total = candidates.length * training.length + training.length;
  let done = 0;
  let failedCandidates = 0;
  onProgress?.(done, total);
  const predictions: Summary[][] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const summaries: Summary[] = [];
    predictions.push(summaries);
    for (let j = 0; j < training.length; j++) {
      abort(signal);
      const entry = training[j];
      const observation = entry.measurement!;
      const recipe = adjustedRecipe(
        entry.recipe,
        candidate.permeability,
        candidate.grinderScale,
        referencePermeability,
        referenceX50GapRatio,
      );
      recipe.stop = { time_s: observation.timeS };
      recipe.numerics = { ...recipe.numerics, tier: 0 };
      try {
        const point = (await engine.sweepPoint(recipe, { signal })).result;
        const summary = point.summary;
        abort(signal);
        valid(summary, point.diagnostics);
        if (Math.abs(summary.shot_time_s - observation.timeS) > 0.5)
          throw new Error('Replay did not reach the measured pump-off time.');
        const yieldSigmaG = (timeSigmaS * observation.yieldG) / observation.timeS;
        const yieldResidual = (summary.beverage_mass_kg * 1000 - observation.yieldG) / yieldSigmaG;
        logPosterior[i] -= 0.5 * yieldResidual ** 2;
        if (observation.tdsPercent !== undefined)
          logPosterior[i] -=
            0.5 * ((summary.tds * 100 - observation.tdsPercent) / tdsSigmaPercent) ** 2;
        summaries.push(summary);
        onProgress?.(++done, total);
      } catch (error) {
        abort(signal);
        if (error instanceof Error && error.name === 'AbortError') throw error;
        // A candidate must explain every shot: a failed solve is zero likelihood.
        logPosterior[i] = -Infinity;
        failedCandidates++;
        done += training.length - j;
        onProgress?.(done, total);
        break;
      }
    }
  }
  const weights = normalise(logPosterior);
  const priorWeights = normalise(logPrior);
  const best = weights.indexOf(Math.max(...weights));
  const map = candidates[best];
  const ks = candidates.map((c) => c.permeability);
  const gs = candidates.map((c) => c.grinderScale);
  const correlation = joint ? posteriorCorrelation(ks, gs, weights) : 0;
  const sensitivity = joint
    ? sensitivityCorrelation(candidates, predictions, best, training, timeSigmaS, tdsSigmaPercent)
    : undefined;
  const diagnosticCorrelation =
    sensitivity !== undefined && Math.abs(sensitivity) >= 0.98 ? sensitivity : correlation;
  const parameters = [
    parameter('permeability', ks, weights, priorWeights, map.permeability, diagnosticCorrelation),
  ];
  parameters.push(
    joint
      ? parameter(
          'grinderScale',
          gs,
          weights,
          priorWeights,
          map.grinderScale,
          diagnosticCorrelation,
        )
      : {
          id: 'grinderScale',
          label: 'Grinder X50 scale',
          map: 1,
          p05: 1,
          p95: 1,
          status:
            'Fixed, not identified: joint fitting requires TDS at three distinct grind settings and opt-in',
        },
  );
  const notes = [
    `Finite-grid Bayesian quadrature: ${kGrid.length} permeability × ${gGrid.length} grinder candidates; independent zero-mean log-scale Gaussian priors with SD ln(2) and ln(1.12), truncated to multipliers [0.25,4] and [0.8,1.25].`,
    'Likelihood replays each measured pump-off time and compares final cup yield including drip. Yield SD = time SD × observed final yield / observed time; this average-flow noise conversion is approximate. TDS SD is absolute percentage points (not relative percent).',
    'Measurements must use pump-on to pump-off seconds and final cup grams/TDS after drip; predictions, ratings and notes are not likelihood evidence.',
    'Intervals are marginal 5–95% grid credible intervals conditional on the fixed physics and observation assumptions; grid resolution limits interval precision and can collapse it to a single node. Startup, grinder zero, heterogeneity and machine offsets are not identified or fitted.',
    `Training uses ${training.length} of ${matching.length} completed matching shots (latest ${MAX_SHOTS} maximum); ${eligible.length - matching.length} different-scope shots excluded. These are in-sample checks, not prospective validation.`,
    'Application refuses missing/mismatched core versions and different bag/equipment/water/prep scopes; refit when those change. Non-physical outputs or failed numerical diagnostics give zero candidate likelihood; every Tier 1 verification must pass.',
  ];
  if (options.fitGrinderScale && !joint)
    notes.push(
      'Requested grinder fit disabled: at least three distinct measured grind settings with TDS are required to reduce permeability/size confounding.',
    );
  if (joint)
    notes.push(
      `Posterior correlation between log permeability and log grinder scale: ${correlation.toFixed(3)}. High absolute correlation signals confounding even when either marginal interval looks narrow.`,
    );
  if (joint)
    notes.push(
      sensitivity === undefined
        ? 'Local sensitivity separation could not be checked (a neighboring solve failed or sensitivities vanished); avoid interpreting narrow intervals as identification.'
        : `Local noise-scaled permeability/grinder sensitivity cosine: ${sensitivity.toFixed(3)}; absolute values ≥0.98 flag similar observable effects and possible grid-aliasing confounding.`,
    );
  if (failedCandidates)
    notes.push(
      `${failedCandidates} candidates received zero posterior likelihood because at least one training simulation failed.`,
    );
  const checks: CalibrationProfile['checks'] = [];
  let maxTierYieldDifferenceG = 0;
  let maxTierTdsDifference = 0;
  for (let j = 0; j < training.length; j++) {
    abort(signal);
    const entry = training[j];
    const observation = entry.measurement!;
    const recipe = adjustedRecipe(
      entry.recipe,
      map.permeability,
      map.grinderScale,
      referencePermeability,
      referenceX50GapRatio,
    );
    recipe.numerics = { ...recipe.numerics, tier: 1 };
    // First reproduce the likelihood at Tier 1, retaining a discrepancy for all shots.
    recipe.stop = { time_s: observation.timeS };
    let point = (await engine.sweepPoint(recipe, { signal })).result;
    let summary = point.summary;
    abort(signal);
    valid(summary, point.diagnostics);
    maxTierYieldDifferenceG = Math.max(
      maxTierYieldDifferenceG,
      Math.abs(summary.beverage_mass_kg - predictions[best][j].beverage_mass_kg) * 1000,
    );
    maxTierTdsDifference = Math.max(
      maxTierTdsDifference,
      Math.abs(summary.tds - predictions[best][j].tds) * 100,
    );
    // Actual time-at-final-yield check, solving pump-stop mass = observed final mass − drip.
    let pumpStopG = observation.yieldG;
    for (let replay = 0; replay < 3; replay++) {
      recipe.stop = { beverage_g: pumpStopG };
      point = (await engine.sweepPoint(recipe, { signal })).result;
      summary = point.summary;
      abort(signal);
      valid(summary, point.diagnostics);
      if (Math.abs(summary.beverage_mass_kg * 1000 - observation.yieldG) <= 0.1) break;
      const dripG =
        (summary.drip_mass_kg ?? Math.max(0, summary.beverage_mass_kg - pumpStopG / 1000)) * 1000;
      pumpStopG = observation.yieldG - dripG;
      if (pumpStopG <= 0)
        throw new Error(
          'Observed final yield is smaller than predicted post-stop drip; cannot verify calibration.',
        );
    }
    if (Math.abs(summary.beverage_mass_kg * 1000 - observation.yieldG) > 0.1)
      notes.push(
        `Tier 1 ${entry.id}: bounded drip correction leaves ${(summary.beverage_mass_kg * 1000 - observation.yieldG).toFixed(2)} g final-yield error; timing check is approximate.`,
      );
    checks.push({
      entryId: entry.id,
      timeErrorS: summary.shot_time_s - observation.timeS,
      eyErrorPoints:
        observation.tdsPercent === undefined
          ? null
          : summary.ey * 100 -
            (observation.tdsPercent * observation.yieldG) / entry.recipe.prep.dose_g,
    });
    onProgress?.(++done, total);
  }
  notes.push(
    `Tier 0 → Tier 1 discrepancy at measured times, maximum across all training shots: ${maxTierYieldDifferenceG.toFixed(2)} g final yield and ${maxTierTdsDifference.toFixed(3)} TDS percentage points. Tier 1 actual timing checks use up to three pump-stop/drip corrections per shot.`,
  );
  abort(signal);
  return {
    id: `cal-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    coreVersion: currentVersion,
    setupId: options.setupId,
    scopeKey: scope,
    trainingIds: training.map((entry) => entry.id),
    parameters,
    ...map,
    referencePermeability,
    referenceX50GapRatio,
    timeSigmaS,
    tdsSigmaPercent,
    posterior: candidates.map((candidate, i) => ({ ...candidate, weight: weights[i] })),
    checks,
    notes,
  };
}
