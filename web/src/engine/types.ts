// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * TypeScript mirror of the frozen `puckcore-wasm` binding contract
 * (crates/puckcore-wasm/src/lib.rs). Names and valid ranges, including the
 * limit on the dimensionless end time (`SPHERE_LIMITS`), must stay in step
 * with the core (crates/puckcore/src/kernel/sphere.rs).
 */

/** Radial discretisation of the sphere into shells. */
export type SphereGrid = 'uniform_radius' | 'equal_volume';

/** Time-integration scheme. */
export type SphereScheme = 'backward_euler' | 'bdf2' | 'crank_nicolson';

export const SPHERE_GRIDS: readonly SphereGrid[] = ['uniform_radius', 'equal_volume'];
export const SPHERE_SCHEMES: readonly SphereScheme[] = ['backward_euler', 'bdf2', 'crank_nicolson'];

/** Inputs of `simulateSphereRelease`, in SI units. */
export interface SphereReleaseParams {
  /** Sphere radius, m (finite, > 0). */
  radiusM: number;
  /** Diffusivity, m²/s (finite, > 0). */
  diffusivityM2S: number;
  /** Number of radial shells (integer, 2 to 100 000). */
  nShells: number;
  /** End time, s (finite, > 0). */
  tEndS: number;
  /** Number of equal time steps (integer, 1 to 10 000 000). */
  nSteps: number;
  grid: SphereGrid;
  scheme: SphereScheme;
}

/**
 * Ranges accepted by the core (puckcore `validate` and `simulate_sphere_release_with`):
 * - radius, diffusivity and end time finite and > 0;
 * - integer shell and step counts in the ranges below;
 * - the dimensionless end time τ = D·t_end/a², computed in that order, finite
 *   and at most `maxTau` (the core reports it against `t_end_s`).
 */
export const SPHERE_LIMITS = {
  nShells: { min: 2, max: 100_000 },
  nSteps: { min: 1, max: 10_000_000 },
  maxTau: 1e200,
} as const;

/** Dimensionless end time τ = D·t_end/a², evaluated exactly as the core does. */
export function dimensionlessEndTime(
  p: Pick<SphereReleaseParams, 'radiusM' | 'diffusivityM2S' | 'tEndS'>,
): number {
  return (p.diffusivityM2S * p.tEndS) / (p.radiusM * p.radiusM);
}

/**
 * Plain-data copy of a `SphereRelease`. Every array has `nSteps + 1` entries
 * starting at t = 0, except the per-shell arrays, which have `nShells`.
 */
export interface SphereReleaseData {
  /** Output times, s. */
  times: Float64Array;
  /** Numerical released fraction M_t/M_inf at each output time. */
  releasedFraction: Float64Array;
  /** Analytic (Crank) released fraction at each output time. */
  analyticFraction: Float64Array;
  /** Outer radius of each shell, m. */
  shellOuterRadii: Float64Array;
  /** c/c0 in each shell at the end time. */
  finalProfile: Float64Array;
  /** Largest |numerical − analytic| released fraction. */
  maxAbsError: number;
  /** Discrete mass-conservation error, as a fraction of the initial mass. */
  massBalanceError: number;
}

/**
 * A run as the engine worker returns it (engine/decimate.ts): the same fields,
 * but the three time series hold at most a few thousand of the `totalPoints`
 * output times. They always include the first and last times, the evenly
 * spaced samples and the time of the largest error. The scalars and the
 * per-shell arrays are complete.
 */
export interface SphereRunData extends SphereReleaseData {
  /** Number of output times the core produced (`nSteps + 1`). */
  totalPoints: number;
}

/** The WASM-owned result object; it must be freed after use. */
export interface SphereReleaseHandle {
  readonly times: Float64Array;
  readonly releasedFraction: Float64Array;
  readonly analyticFraction: Float64Array;
  readonly shellOuterRadii: Float64Array;
  readonly finalProfile: Float64Array;
  readonly maxAbsError: number;
  readonly massBalanceError: number;
  free(): void;
}

/**
 * The functions of the generated module (web/src/engine/pkg/puckcore.js) the app uses.
 * The shot functions (M1, docs/model/m1-contract.md §3) take and return JSON
 * text and throw an `Error` with a readable message on invalid input.
 */
export interface PuckcoreModule {
  coreVersion(): string;
  /** A `puckworks.presets/1` document. */
  presets(): string;
  /** A `puckworks.registry/1` document. */
  registry(): string;
  /** Recipe JSON → `{spec, derived}` JSON. */
  buildShotSpec(recipeJson: string): string;
  /** ShotSpec JSON → ShotResult JSON. */
  simulateShot(specJson: string): string;
  /** Recipe JSON → `{build: {spec, derived}, result}` JSON. */
  simulateRecipe(recipeJson: string): string;
  /**
   * The message of the most recent Rust panic, or "" (read after a trap, from the
   * same instance, before the worker is replaced). Newer cores only.
   */
  lastPanic?(): string;
  /** Throws on invalid input. */
  simulateSphereRelease(
    radiusM: number,
    diffusivityM2S: number,
    nShells: number,
    tEndS: number,
    nSteps: number,
    grid: string,
    scheme: string,
  ): SphereReleaseHandle;
  crankSphereReleaseFraction(tS: number, radiusM: number, diffusivityM2S: number): number;
}

/**
 * Checks parameters against the contract before they reach WebAssembly, where
 * a fractional or out-of-range shell count would be silently truncated or wrapped.
 * Returns a message, or null if the parameters are valid.
 */
export function checkSphereParams(p: SphereReleaseParams): string | null {
  const positive = (x: number) => Number.isFinite(x) && x > 0;
  const inRange = (x: number, r: { min: number; max: number }) =>
    Number.isInteger(x) && x >= r.min && x <= r.max;
  if (!positive(p.radiusM)) return 'radiusM must be finite and > 0';
  if (!positive(p.diffusivityM2S)) return 'diffusivityM2S must be finite and > 0';
  if (!positive(p.tEndS)) return 'tEndS must be finite and > 0';
  if (!inRange(p.nShells, SPHERE_LIMITS.nShells)) {
    return `nShells must be an integer from ${SPHERE_LIMITS.nShells.min} to ${SPHERE_LIMITS.nShells.max}`;
  }
  if (!inRange(p.nSteps, SPHERE_LIMITS.nSteps)) {
    return `nSteps must be an integer from ${SPHERE_LIMITS.nSteps.min} to ${SPHERE_LIMITS.nSteps.max}`;
  }
  if (!SPHERE_GRIDS.includes(p.grid)) return `grid must be one of ${SPHERE_GRIDS.join(', ')}`;
  if (!SPHERE_SCHEMES.includes(p.scheme))
    return `scheme must be one of ${SPHERE_SCHEMES.join(', ')}`;
  const tau = dimensionlessEndTime(p);
  if (!(Number.isFinite(tau) && tau <= SPHERE_LIMITS.maxTau)) {
    return `tEndS: the dimensionless time D * t_end / radius^2 must not exceed ${SPHERE_LIMITS.maxTau}`;
  }
  return null;
}
