// SPDX-License-Identifier: GPL-2.0-or-later
/** Number formatting for tiles, tables and chart axes. */

const SUPERSCRIPT: Record<string, string> = {
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

const MINUS = '−';

/** Scientific notation for display, e.g. 0.01027 → "1.03 × 10⁻²". */
export function formatScientific(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const [mantissa = '', exponent = '0'] = value.toExponential(fractionDigits).split('e');
  if (exponent === '+0') return mantissa.replace('-', MINUS);
  const power = [...exponent].map((c) => SUPERSCRIPT[c] ?? c).join('');
  return `${mantissa.replace('-', MINUS)} × 10${power}`;
}

/** A duration in milliseconds with about three significant digits. */
export function formatMilliseconds(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms).toLocaleString('en-US')} ms`;
}

/** Compact axis tick: plain decimals for ordinary magnitudes, "2e−5" for tiny or huge ones. */
export function formatTick(value: number): string {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-3 && magnitude < 1e5) {
    return String(Number(value.toPrecision(6))).replace('-', MINUS);
  }
  const [mantissa = '', exponent = ''] = value.toExponential().split('e');
  const shortMantissa = String(Number(Number(mantissa).toPrecision(3)));
  return `${shortMantissa}e${exponent.replace('+', '')}`.replaceAll('-', MINUS);
}

/** A fixed number of significant digits, for table cells. */
export function formatSignificant(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  const text =
    magnitude >= 1e-3 && magnitude < 1e6
      ? value.toPrecision(digits)
      : value.toExponential(digits - 1);
  return text.replaceAll('-', MINUS);
}
