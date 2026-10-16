// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Parses a measured particle-size distribution pasted as text: two columns,
 * particle diameter (µm) and volume fraction (any scale: fractions, percent or
 * raw volumes; the builder normalises them). Accepted:
 * - tab-, semicolon-, comma- or space-separated columns (a spreadsheet copy is
 *   tab-separated); with tabs, semicolons or spaces, a comma inside a number is
 *   read as a decimal comma ("12,5"; "20 3,5");
 * - header lines (lines that do not start with a number) before the first row,
 *   `#` comments, blank lines; a line that starts with a number but cannot be
 *   read is reported, never skipped;
 * - extra columns, which are ignored (with a note);
 * - rows from coarse to fine, which are reversed (with a note).
 * The diameters must then strictly increase (the builder takes the bins as
 * contiguous in ln d, with edges at the geometric midpoints). A column that
 * looks cumulative (it only grows or only shrinks, to or from 100 % or 1, as a
 * sieve's "% retained" or a laser's "% passing" column does) is refused: the
 * model needs the volume in each bin.
 */

export interface ParsedPsd {
  diameter_um: number[];
  volume_fraction: number[];
  /** Things the parser did that the user should know about. */
  notes: string[];
}

export type PsdParseResult = ({ ok: true } & ParsedPsd) | { ok: false; error: string };

/** Rows accepted at most (a laser-diffraction export has about 100). */
export const MAX_PSD_ROWS = 2000;

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function toNumber(field: string, decimalComma: boolean): number | null {
  let text = field.trim();
  if (decimalComma) text = text.replace(',', '.');
  if (!NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Splits one line into fields and says whether commas are decimal commas. */
/** The numbers of a line, read the way its separators suggest. */
function lineValues(line: string): (number | null)[] {
  const read = (fields: string[], decimalComma: boolean) =>
    fields
      .map((f) => f.trim())
      .filter((f) => f !== '')
      .map((f) => toNumber(f, decimalComma));
  if (line.includes('\t')) return read(line.split('\t'), true);
  if (line.includes(';')) return read(line.split(';'), true);
  const spaced = read(line.trim().split(/\s+/), true);
  if (line.includes(',')) {
    // "100, 0.4" is comma-separated; "20 3,5" has a decimal comma between spaces.
    const comma = read(line.split(','), false);
    const good = (v: (number | null)[]) => v.length >= 2 && v[0] !== null && v[1] !== null;
    return good(comma) || !good(spaced) ? comma : spaced;
  }
  return spaced;
}

/** True if the first field of a line is a number (a data row, not a header). */
function startsWithNumber(line: string): boolean {
  const first = line.trim().split(/[\s,;\t]+/)[0] ?? '';
  return toNumber(first, true) !== null;
}

/**
 * A column that looks cumulative: at least three values, never decreasing or
 * never increasing, reaching about 100 (or 1) at one end, and adding up to much
 * more than its largest value (differential data would add up to about it).
 */
export function looksCumulative(values: readonly number[]): boolean {
  if (values.length < 3) return false;
  const up = values.every((v, i) => i === 0 || v >= values[i - 1]);
  const down = values.every((v, i) => i === 0 || v <= values[i - 1]);
  if (!up && !down) return false;
  const max = Math.max(...values);
  const ends = [values[0], values[values.length - 1]];
  const full = (v: number, target: number) => Math.abs(v - target) <= 0.02 * target;
  const reachesFull = ends.some((v) => full(v, 100) || full(v, 1));
  const sum = values.reduce((a, b) => a + b, 0);
  // Per-bin data that reaches about 100 (or 1) at one end has almost nothing elsewhere.
  return reachesFull && sum > 1.25 * max;
}

export function parsePsdText(text: string): PsdParseResult {
  const notes: string[] = [];
  const rows: { d: number; f: number; line: number }[] = [];
  let extraColumns = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const lineNo = index + 1;
    const values = lineValues(raw);
    if (values.length < 2 || values[0] === null || values[1] === null) {
      if (rows.length === 0 && !startsWithNumber(raw)) continue; // a header line
      return {
        ok: false,
        error: `Line ${lineNo} ("${raw.slice(0, 40)}") does not start with two numbers: a diameter in µm and a volume fraction.`,
      };
    }
    if (values.length > 2) extraColumns = true;
    const [d, f] = values as [number, number];
    if (!(d > 0)) {
      return { ok: false, error: `Line ${lineNo}: the diameter must be more than 0 µm.` };
    }
    if (!(f >= 0)) {
      return { ok: false, error: `Line ${lineNo}: the volume fraction must be 0 or more.` };
    }
    rows.push({ d, f, line: lineNo });
    if (rows.length > MAX_PSD_ROWS) {
      return { ok: false, error: `At most ${MAX_PSD_ROWS} rows are accepted.` };
    }
  }
  if (rows.length === 0) {
    return {
      ok: false,
      error:
        'Paste at least one row: a diameter in µm and a volume fraction, separated by a tab, comma or space.',
    };
  }
  if (extraColumns) notes.push('Only the first two columns are used.');
  if (looksCumulative(rows.map((r) => r.f))) {
    return {
      ok: false,
      error:
        'The second column looks cumulative (it only grows or only shrinks, to or from 100 or 1, like a “% passing” or “% retained” column). Paste the volume fraction in each size bin instead.',
    };
  }
  const decreasing = rows.length > 1 && rows.every((r, i) => i === 0 || r.d < rows[i - 1].d);
  if (decreasing) {
    rows.reverse();
    notes.push('The rows went from coarse to fine; they were put in increasing order.');
  }
  for (let i = 1; i < rows.length; i++) {
    if (!(rows[i].d > rows[i - 1].d)) {
      return {
        ok: false,
        error: `Diameters must increase from row to row: line ${rows[i].line} has ${rows[i].d} µm after ${rows[i - 1].d} µm.`,
      };
    }
  }
  if (!rows.some((r) => r.f > 0)) {
    return { ok: false, error: 'At least one volume fraction must be more than 0.' };
  }
  return {
    ok: true,
    diameter_um: rows.map((r) => r.d),
    volume_fraction: rows.map((r) => r.f),
    notes,
  };
}

/** Writes a distribution as tab-separated text with a header, for the editor. */
export function formatPsdText(diameters: readonly number[], fractions: readonly number[]): string {
  const lines = ['diameter_um\tvolume_fraction'];
  for (let i = 0; i < diameters.length; i++) lines.push(`${diameters[i]}\t${fractions[i] ?? ''}`);
  return lines.join('\n');
}
