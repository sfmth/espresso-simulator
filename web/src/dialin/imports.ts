// SPDX-License-Identifier: GPL-2.0-or-later
/** Local data readers only: never execute Tcl, formulas, or imported source. */
import type { Recipe } from '../engine/shotTypes';
import type { JournalEntry } from './types';
import { number, validateRecipe } from './journalValidation';

const MAX_LOG_BYTES = 2_000_000;
const MAX_SAMPLES = 100_000;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function decimal(value: string, path: string, min?: number, max?: number): number {
  if (!DECIMAL.test(value.trim())) throw new Error(`${path}: expected a plain finite decimal`);
  return number(Number(value), path, min, max);
}
function id(): string {
  return crypto.randomUUID();
}
/** RFC 4180 quoting, including embedded newlines and doubled quotation marks. */
function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const finishField = () => {
    row.push(field);
    field = '';
    state = 'start';
  };
  const finishRow = () => {
    finishField();
    if (row.some((cell) => cell.trim())) rows.push(row);
    row = [];
    if (rows.length > 10_001) throw new Error('CSV exceeds 10,000 shots');
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else state = 'closed';
      } else field += char;
      continue;
    }
    if (char === ',') {
      finishField();
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow();
      continue;
    }
    if (state === 'closed') throw new Error('CSV: unexpected text after closing quote');
    if (char === '"') {
      if (state !== 'start') throw new Error('CSV: quote inside unquoted field');
      state = 'quoted';
    } else {
      field += char;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new Error('CSV: unterminated quoted field');
  if (field || row.length || state === 'closed') finishRow();
  return rows;
}
function importCsv(text: string, recipe: Recipe, setupId: string): JournalEntry[] {
  const rows = csv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('CSV needs a header and at least one shot');
  const headers = rows[0].map((h) => h.trim());
  const accepted = [
    'time_s',
    'yield_g',
    'tds_percent',
    'rating',
    'dose_g',
    'setting',
    'label',
    'notes',
  ];
  if (new Set(headers).size !== headers.length || headers.some((h) => !accepted.includes(h)))
    throw new Error(`CSV headers must be unique canonical names: ${accepted.join(', ')}`);
  if (!headers.includes('time_s') || !headers.includes('yield_g'))
    throw new Error('CSV requires time_s and yield_g columns');
  const now = new Date().toISOString();
  return rows.slice(1).map((row, index) => {
    if (row.length !== headers.length)
      throw new Error(`CSV row ${index + 2}: wrong number of fields`);
    const values = Object.fromEntries(headers.map((h, i) => [h, row[i]]));
    const required = (key: string, min: number, max: number) =>
      decimal(values[key] ?? '', `CSV row ${index + 2} ${key}`, min, max);
    const optional = (key: string, min?: number, max?: number) =>
      values[key]?.trim()
        ? decimal(values[key], `CSV row ${index + 2} ${key}`, min, max)
        : undefined;
    const actual = structuredClone(recipe);
    const dose = optional('dose_g', 1, 60),
      setting = optional('setting');
    if (dose !== undefined) actual.prep.dose_g = dose;
    if (setting !== undefined) actual.grinder.setting = setting;
    validateRecipe(actual);
    const tds = optional('tds_percent', 0.001, 100),
      rating = optional('rating', 1, 5);
    const timeS = required('time_s', 0.001, 3600),
      yieldG = required('yield_g', 0.001, 1000);
    if (tds !== undefined && tds * yieldG > 100 * actual.prep.dose_g + 1e-9)
      throw new Error(
        `CSV row ${index + 2}: measured soluble mass exceeds the dry dose (EY > 100%)`,
      );
    const assumptions = `Imported observation; unreported recipe fields are assumptions from the selected base recipe. ${dose === undefined ? 'Dose assumed from base recipe. ' : ''}${setting === undefined ? 'Grind setting assumed from base recipe. ' : ''}No prior prediction is claimed.`;
    const label = values.label?.trim() || `CSV shot ${index + 1} (base recipe assumed)`;
    if (label.length > 1000 || (values.notes?.length ?? 0) > 18_000)
      throw new Error(`CSV row ${index + 2}: text too long`);
    return {
      id: id(),
      createdAt: now,
      setupId,
      label,
      recipe: actual,
      source: 'csv',
      measurement: {
        recordedAt: now,
        timeS,
        yieldG,
        ...(tds === undefined ? {} : { tdsPercent: tds }),
        ...(rating === undefined ? {} : { rating }),
        notes: `${values.notes ?? ''}${values.notes ? '\n' : ''}${assumptions}`,
      },
    };
  });
}

/** The same inert literal-list subset as python/puckworks_tools/sources/de1.py. */
function literalWords(text: string): string[] {
  const words: string[] = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    let start = i;
    if (text[i] === '{' || text[i] === '"') {
      const opening = text[i++];
      start = i;
      let depth = 1;
      for (; i < text.length; i++) {
        const char = text[i];
        if (char === '\\') {
          if (i + 1 === text.length) throw new Error('DE1: unfinished literal escape');
          i++;
          continue;
        }
        if (opening === '{' && char === '{') {
          if (++depth > 128) throw new Error('DE1: excessive brace nesting');
        } else if ((opening === '{' && char === '}') || (opening === '"' && char === '"'))
          if (--depth === 0) break;
      }
      if (depth) throw new Error('DE1: unterminated literal word');
      words.push(text.slice(start, i++));
      if (i < text.length && !/\s/.test(text[i]))
        throw new Error('DE1: missing whitespace after literal word');
    } else {
      while (i < text.length && !/\s/.test(text[i])) {
        if (text[i] === '\\') {
          if (i + 1 === text.length) throw new Error('DE1: unfinished literal escape');
          i += 2;
        } else i++;
      }
      words.push(text.slice(start, i));
    }
    if (words.length > 2 * MAX_SAMPLES) throw new Error('DE1: too many literal words');
  }
  return words;
}
function literalDict(text: string): Map<string, string> {
  const words = literalWords(text),
    result = new Map<string, string>();
  if (words.length % 2) throw new Error('DE1: expected literal key/value pairs');
  for (let i = 0; i < words.length; i += 2) {
    if (!/^[A-Za-z_][A-Za-z0-9_:.-]*$/.test(words[i]) || result.has(words[i]))
      throw new Error('DE1: invalid or duplicate key');
    result.set(words[i], words[i + 1]);
  }
  return result;
}
const CHANNELS = [
  'espresso_elapsed',
  'espresso_pressure',
  'espresso_weight',
  'espresso_flow',
  'espresso_flow_weight',
  'espresso_flow_weight_raw',
  'espresso_temperature_basket',
  'espresso_temperature_mix',
  'espresso_water_dispensed',
  'espresso_pressure_goal',
  'espresso_flow_goal',
  'espresso_temperature_goal',
];
function importDe1(text: string, recipe: Recipe, setupId: string): JournalEntry[] {
  const raw = literalDict(text),
    channels = new Map<string, number[]>();
  for (const key of CHANNELS) {
    if (!raw.has(key)) continue;
    const samples = raw.get(key)!.trim().split(/\s+/);
    if (samples.length < 2 || samples.length > MAX_SAMPLES)
      throw new Error(`DE1 ${key}: expected 2–${MAX_SAMPLES} samples`);
    channels.set(
      key,
      samples.map((v) => decimal(v, `DE1 ${key}`)),
    );
  }
  for (const key of CHANNELS.slice(0, 3))
    if (!channels.has(key)) throw new Error(`DE1: missing required channel ${key}`);
  const elapsed = channels.get('espresso_elapsed')!,
    weights = channels.get('espresso_weight')!;
  for (const [key, samples] of channels)
    if (samples.length !== elapsed.length)
      throw new Error(`DE1 ${key}: channel length differs from elapsed time`);
  if (elapsed.some((v, i) => i > 0 && v <= elapsed[i - 1]))
    throw new Error('DE1: elapsed time must strictly increase');
  const timeS = number(elapsed[elapsed.length - 1], 'DE1 elapsed end', 0.001, 3600),
    yieldG = number(weights[weights.length - 1], 'DE1 final logged scale mass', 0.001, 1000);
  let decreases = 0,
    negatives = 0;
  weights.forEach((v, i) => {
    if (v < 0) negatives++;
    if (i > 0 && v < weights[i - 1]) decreases++;
  });
  const now = new Date().toISOString();
  return [
    {
      id: id(),
      createdAt: now,
      setupId,
      label: 'DE1 shot (base recipe assumed)',
      recipe: structuredClone(recipe),
      source: 'de1',
      measurement: {
        recordedAt: now,
        timeS,
        yieldG,
        notes: `Imported DE1 sensor observation: ${elapsed.length} samples; original elapsed end ${timeS} s; final logged scale mass ${yieldG} g. No clock shift, drip correction, smoothing or clipping. ${negatives} negative scale samples and ${decreases} downward steps. Dose, grind, machine controls and all recipe conditions are assumptions from the selected base recipe; DE1 metadata and controller goals are not observations. TDS and rating unknown. No prior prediction is claimed.`,
      },
    },
  ];
}
export function importShotLog(
  text: string,
  format: 'csv' | 'de1',
  recipe: Recipe,
  setupId: string,
): JournalEntry[] {
  if (new TextEncoder().encode(text).length > MAX_LOG_BYTES)
    throw new Error('Shot log exceeds 2 MB limit');
  if (!setupId.trim() || setupId.length > 200) throw new Error('A setup id is required');
  validateRecipe(recipe);
  if (format === 'csv') return importCsv(text, recipe, setupId);
  if (format === 'de1') return importDe1(text, recipe, setupId);
  throw new Error('Unsupported shot-log format');
}
