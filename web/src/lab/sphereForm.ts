// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Inputs of the particle-kernel verification panel: the raw form values, their
 * validation, and their conversion to engine parameters (µm → m).
 */
import {
  dimensionlessEndTime,
  SPHERE_GRIDS,
  SPHERE_LIMITS,
  SPHERE_SCHEMES,
  type SphereGrid,
  type SphereReleaseParams,
  type SphereScheme,
} from '../engine/types';

/** Form values as typed, so that partial input such as "1e-" can be shown and corrected. */
export interface SphereForm {
  radiusUm: string;
  diffusivity: string;
  nShells: string;
  tEnd: string;
  nSteps: string;
  grid: SphereGrid;
  scheme: SphereScheme;
}

export type SphereField = keyof SphereForm;

export const DEFAULT_SPHERE_FORM: SphereForm = {
  radiusUm: '150',
  diffusivity: '1e-10',
  nShells: '64',
  tEnd: '60',
  nSteps: '2000',
  grid: 'equal_volume',
  scheme: 'bdf2',
};

export const GRID_LABELS: Record<SphereGrid, string> = {
  equal_volume: 'Equal volume',
  uniform_radius: 'Uniform radius',
};

export const SCHEME_LABELS: Record<SphereScheme, string> = {
  bdf2: 'BDF2',
  crank_nicolson: 'Crank–Nicolson',
  backward_euler: 'Backward Euler',
};

/**
 * Runs start automatically only when they are quick and small:
 * - at most this many shell-steps (shells × steps). The core needs roughly
 *   10 ns per shell-step, so this is about half a second;
 * - at most this many steps, which bounds the output: about 11 MB at the peak
 *   (engine/memory.ts), whatever the shell count.
 * Larger runs, which the core also accepts, wait for the Run button.
 */
export const AUTO_RUN_MAX_WORK = 50_000_000;
export const AUTO_RUN_MAX_STEPS = 200_000;

/** Whether a valid run is small enough to start without the Run button. */
export function canAutoRun(params: Pick<SphereReleaseParams, 'nShells' | 'nSteps'>): boolean {
  return params.nSteps <= AUTO_RUN_MAX_STEPS && params.nShells * params.nSteps <= AUTO_RUN_MAX_WORK;
}

export const MESSAGES = {
  radiusUm: 'Enter a radius in µm greater than 0.',
  diffusivity: 'Enter a diffusivity in m²/s greater than 0, such as 1e-10.',
  nShells: `Enter a whole number of shells from ${SPHERE_LIMITS.nShells.min} to ${SPHERE_LIMITS.nShells.max}.`,
  tEnd: 'Enter an end time in seconds greater than 0.',
  nSteps: `Enter a whole number of steps from ${SPHERE_LIMITS.nSteps.min} to ${SPHERE_LIMITS.nSteps.max}.`,
  grid: 'Choose a grid.',
  scheme: 'Choose a scheme.',
} as const satisfies Record<SphereField, string>;

/** The core's limit on τ = D·t_end/a², reported against the end time as the core does. */
export const TAU_MESSAGE =
  'This end time is too long for the radius and diffusivity: D × t_end / radius² must not exceed 1e200.';

export type SphereFormErrors = Partial<Record<SphereField, string>>;

export type SphereFormResult =
  { ok: true; params: SphereReleaseParams; work: number } | { ok: false; errors: SphereFormErrors };

const DECIMAL = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:e([+-]?\d+))?$/i;

/** One decimal comma ("18,5"), as European keypads type it; not the thousands shape "1,500". */
const DECIMAL_COMMA = /^([+-]?\d*),(\d+)((?:e[+-]?\d+)?)$/i;

/**
 * Parses a plain decimal such as "150", "0.5", "1e-10" or "18,5", times
 * 10^`power`; null for anything else. A single comma is read as a decimal
 * comma, except in the shape of a thousands separator ("1,500" is ambiguous and
 * rejected; "0,125" and "18,5" are not). Scaling the decimal exponent instead of
 * multiplying gives the double nearest the exact value: "0.1" with power −6 is
 * exactly the literal 0.1e-6, as Python or Rust would read it.
 */
export function parseDecimal(text: string, power = 0): number | null {
  let trimmed = text.trim();
  const comma = DECIMAL_COMMA.exec(trimmed);
  if (comma) {
    const integer = comma[1].replace(/^[+-]/, '');
    const thousands = /^[1-9]\d{0,2}$/.test(integer) && comma[2].length === 3;
    if (thousands) return null;
    trimmed = `${comma[1]}.${comma[2]}${comma[3]}`;
  }
  const match = DECIMAL.exec(trimmed);
  if (!match) return null;
  const exponent = (match[2] === undefined ? 0 : Number.parseInt(match[2], 10)) + power;
  const value = Number(`${match[1]}e${exponent}`);
  return Number.isFinite(value) ? value : null;
}

export function validateSphereForm(form: SphereForm): SphereFormResult {
  const errors: SphereFormErrors = {};

  const positive = (field: SphereField, text: string, power = 0): number => {
    const value = parseDecimal(text, power);
    if (value === null || !(value > 0)) {
      errors[field] = MESSAGES[field];
      return Number.NaN;
    }
    return value;
  };

  const whole = (field: SphereField, text: string, range: { min: number; max: number }): number => {
    const value = parseDecimal(text);
    if (value === null || !Number.isInteger(value) || value < range.min || value > range.max) {
      errors[field] = MESSAGES[field];
      return Number.NaN;
    }
    return value;
  };

  const radiusM = positive('radiusUm', form.radiusUm, -6); // µm → m
  const diffusivityM2S = positive('diffusivity', form.diffusivity);
  const nShells = whole('nShells', form.nShells, SPHERE_LIMITS.nShells);
  const tEndS = positive('tEnd', form.tEnd);
  const nSteps = whole('nSteps', form.nSteps, SPHERE_LIMITS.nSteps);
  if (!SPHERE_GRIDS.includes(form.grid)) errors.grid = MESSAGES.grid;
  if (!SPHERE_SCHEMES.includes(form.scheme)) errors.scheme = MESSAGES.scheme;
  if (!errors.radiusUm && !errors.diffusivity && !errors.tEnd) {
    const tau = dimensionlessEndTime({ radiusM, diffusivityM2S, tEndS });
    if (!(Number.isFinite(tau) && tau <= SPHERE_LIMITS.maxTau)) errors.tEnd = TAU_MESSAGE;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    params: {
      radiusM,
      diffusivityM2S,
      nShells,
      tEndS,
      nSteps,
      grid: form.grid,
      scheme: form.scheme,
    },
    work: nShells * nSteps,
  };
}
