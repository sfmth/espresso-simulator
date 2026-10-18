// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Formatting of shot quantities for display. The engine works in SI with
 * fractions (contract §2); people read grams, bar, mL/s, °C and percent. All
 * conversions to display units live here, so tiles, tables, charts and CSV
 * export agree.
 */

import { BAR_PER_PA, G_PER_KG, MG_PER_KG, ML_PER_M3, MM_PER_M, PERCENT } from './units';
import type { CompoundMeta } from '../engine/shotTypes';

const MINUS = '−';

/** Fixed decimals with a real minus sign; "—" for missing or non-finite values. */
export function fixed(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = value.toFixed(digits);
  // Avoid "−0.0" for tiny negative values.
  return (Number(text) === 0 ? (0).toFixed(digits) : text).replace('-', MINUS);
}

/** A number with about `digits` significant digits, plain or scientific as fits. */
export function sig(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  const text =
    magnitude >= 1e-3 && magnitude < 1e6
      ? String(Number(value.toPrecision(digits)))
      : value.toExponential(digits - 1).replace('e+', 'e');
  return text.replaceAll('-', MINUS);
}

/** "18.0 g" etc. */
export function grams(kg: number | null | undefined, digits = 1): string {
  return kg === null || kg === undefined ? '—' : `${fixed(kg * G_PER_KG, digits)} g`;
}

export function milligrams(kg: number | null | undefined, digits = 1): string {
  return kg === null || kg === undefined ? '—' : `${fixed(kg * MG_PER_KG, digits)} mg`;
}

export function seconds(s: number | null | undefined, digits = 1): string {
  return s === null || s === undefined ? '—' : `${fixed(s, digits)} s`;
}

export function bar(pa: number | null | undefined, digits = 1): string {
  return pa === null || pa === undefined ? '—' : `${fixed(pa * BAR_PER_PA, digits)} bar`;
}

/** A fraction as percent: 0.2087 → "20.9%". */
export function percent(fraction: number | null | undefined, digits = 1): string {
  return fraction === null || fraction === undefined
    ? '—'
    : `${fixed(fraction * PERCENT, digits)}%`;
}

/** A difference of fractions as percentage points: 0.012 → "1.2 points". */
export function points(fraction: number | null | undefined, digits = 1): string {
  return fraction === null || fraction === undefined
    ? '—'
    : `${fixed(fraction * PERCENT, digits)} points`;
}

export function millimetres(m: number | null | undefined, digits = 1): string {
  return m === null || m === undefined ? '—' : `${fixed(m * MM_PER_M, digits)} mm`;
}

export function millilitres(m3: number | null | undefined, digits = 1): string {
  return m3 === null || m3 === undefined ? '—' : `${fixed(m3 * ML_PER_M3, digits)} mL`;
}

export function celsius(c: number | null | undefined, digits = 1): string {
  return c === null || c === undefined ? '—' : `${fixed(c, digits)} °C`;
}

/** "1 : 2.0" for a dose and a beverage mass in the same unit. */
export function brewRatio(dose: number, beverage: number): string {
  if (!(dose > 0) || !Number.isFinite(beverage)) return '—';
  return `1 : ${fixed(beverage / dose, 1)}`;
}

/** Scientific notation with superscripts: 1.2e-15 → "1.2 × 10⁻¹⁵". */
export function scientific(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const [mantissa = '', exponent = '0'] = value.toExponential(digits - 1).split('e');
  const sup: Record<string, string> = {
    '-': '⁻',
    '+': '',
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
  };
  if (Number(exponent) === 0) return mantissa.replace('-', MINUS);
  return `${mantissa.replace('-', MINUS)} × 10${[...exponent].map((c) => sup[c] ?? c).join('')}`;
}

/** Why a shot stopped, in words. */
export function stopReasonText(reason: string): string {
  switch (reason) {
    case 'beverage_mass':
      return 'Beverage mass reached';
    case 'time':
      return 'Time reached';
    case 'max_duration':
      return 'Hard time limit reached';
    case 'choked':
      return 'Choked: no flow';
    default:
      return reason ? reason.replaceAll('_', ' ') : '—';
  }
}

/** Display names of the tracked species (unknown ids are shown as they are). */
export const SPECIES_NAMES: Record<string, string> = {
  caffeine: 'Caffeine',
  trigonelline: 'Trigonelline',
  cqa5: '5-CQA (5-caffeoylquinic acid)',
  acids: 'Organic acids (lumped)',
};

export function speciesName(id: string, compounds?: readonly CompoundMeta[]): string {
  return SPECIES_NAMES[id] ?? compounds?.find((m) => m.id === id)?.name ?? id;
}

/** Registry units as displayed: "1" (dimensionless) is shown as nothing. */
export function registryUnit(units: string): string {
  if (units === '1') return '';
  return units
    .replace('degC', '°C')
    .replace('m^2/s', 'm²/s')
    .replace('m^2', 'm²')
    .replace('kg/m^3', 'kg/m³')
    .replace('um', 'µm');
}
