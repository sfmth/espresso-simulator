// SPDX-License-Identifier: GPL-2.0-or-later
/** Strict boundary validation. Recipe bounds come from the same schema as the editor. */
import recipeSchema from '../../../data/schema/recipe.schema.json';
import type { Recipe } from '../engine/shotTypes';
import type { JournalDocument } from './types';

export const MAX_JOURNAL_BYTES = 10_000_000;
export const MAX_ENTRIES = 10_000;
export type RecordValue = Record<string, unknown>;
export function object(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path}: expected an object`);
  return value as RecordValue;
}
export function number(
  value: unknown,
  path: string,
  min = -Number.MAX_VALUE,
  max = Number.MAX_VALUE,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${path}: expected a finite number in [${min}, ${max}]`);
  return value;
}
function text(value: unknown, path: string, max = 20_000, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()))
    throw new Error(`${path}: invalid text`);
  return value;
}
function id(value: unknown, path: string): string {
  return text(value, path, 200, true);
}
function list(value: unknown, path: string, max = MAX_ENTRIES): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${path}: invalid array or exceeds ${max} records`);
  return value;
}
function keys(value: RecordValue, accepted: string[], required: string[], path: string) {
  for (const key of Object.keys(value))
    if (!accepted.includes(key)) throw new Error(`${path}.${key}: unknown field`);
  for (const key of required) if (!(key in value)) throw new Error(`${path}.${key}: required`);
}
function date(value: unknown, path: string): number {
  const s = text(value, path, 40, true);
  // Require an unambiguous UTC timestamp; browsers disagree on loose date strings.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) || !Number.isFinite(Date.parse(s)))
    throw new Error(`${path}: expected an ISO UTC timestamp`);
  const ms = Date.parse(s);
  if (new Date(ms).toISOString().slice(0, 19) !== s.slice(0, 19))
    throw new Error(`${path}: invalid calendar date`);
  return ms;
}
function finiteTree(value: unknown, depth = 0, budget = { count: 0 }) {
  if (++budget.count > 500_000 || depth > 32) throw new Error('Journal exceeds structural limits');
  if (typeof value === 'number') number(value, 'journal number');
  else if (typeof value === 'string') text(value, 'journal text');
  else if (Array.isArray(value)) for (const child of value) finiteTree(child, depth + 1, budget);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error(`Unsafe journal key: ${key}`);
      if (child !== undefined) finiteTree(child, depth + 1, budget);
    }
  } else if (value !== null && typeof value !== 'boolean')
    throw new Error('Journal contains unsupported values');
}
/** Evaluates the bounded, local recipe schema, without runtime code generation. */
function schema(value: unknown, rule: RecordValue, path: string): void {
  if (rule.not && typeof rule.not === 'object') {
    let forbidden = true;
    try {
      schema(value, rule.not as RecordValue, path);
    } catch {
      forbidden = false;
    }
    if (forbidden) throw new Error(`${path}: unsupported recipe value`);
  }
  if (typeof rule.$ref === 'string') {
    const name = rule.$ref.split('/').pop()!;
    return schema(value, object((recipeSchema.$defs as RecordValue)[name], name), path);
  }
  if (Array.isArray(rule.oneOf)) {
    let matches = 0;
    for (const variant of rule.oneOf) {
      try {
        schema(value, object(variant, path), path);
        matches++;
      } catch {
        /* try the next schema */
      }
    }
    if (matches !== 1) throw new Error(`${path}: unsupported recipe shape`);
    return;
  }
  if ('const' in rule && value !== rule.const) throw new Error(`${path}: unsupported schema/value`);
  if (Array.isArray(rule.enum) && !rule.enum.includes(value))
    throw new Error(`${path}: unsupported value`);
  if (rule.type) {
    const allowed = Array.isArray(rule.type) ? rule.type : [rule.type];
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (
      !allowed.includes(kind) &&
      !(kind === 'number' && Number.isInteger(value) && allowed.includes('integer'))
    )
      throw new Error(`${path}: expected ${allowed.join(' or ')}`);
  }
  if (typeof value === 'number') {
    number(
      value,
      path,
      typeof rule.minimum === 'number' ? rule.minimum : -Number.MAX_VALUE,
      typeof rule.maximum === 'number' ? rule.maximum : Number.MAX_VALUE,
    );
    if (typeof rule.exclusiveMinimum === 'number' && value <= rule.exclusiveMinimum)
      throw new Error(`${path}: below bound`);
  }
  if (
    typeof value === 'string' &&
    typeof rule.pattern === 'string' &&
    !new RegExp(rule.pattern).test(value)
  )
    throw new Error(`${path}: invalid identifier`);
  if (
    typeof value === 'string' &&
    ((typeof rule.minLength === 'number' && value.length < rule.minLength) ||
      (typeof rule.maxLength === 'number' && value.length > rule.maxLength))
  )
    throw new Error(`${path}: text is outside its supported length`);
  if (Array.isArray(value)) {
    if (
      (typeof rule.minItems === 'number' && value.length < rule.minItems) ||
      (typeof rule.maxItems === 'number' && value.length > rule.maxItems)
    )
      throw new Error(`${path}: wrong array length`);
    if (value.length > 2000) throw new Error(`${path}: array exceeds recipe limit`);
    value.forEach((v, i) => {
      const item: unknown = Array.isArray(rule.prefixItems) ? rule.prefixItems[i] : rule.items;
      if (item && typeof item === 'object') schema(v, item as RecordValue, `${path}[${i}]`);
    });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const block = value as RecordValue;
    const props = (rule.properties ?? {}) as RecordValue;
    for (const key of (rule.required ?? []) as string[])
      if (!(key in block)) throw new Error(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(block)) {
      if (rule.propertyNames) schema(key, rule.propertyNames as RecordValue, `${path} key`);
      if (props[key]) schema(child, props[key] as RecordValue, `${path}.${key}`);
      else if (rule.additionalProperties === false)
        throw new Error(`${path}.${key}: unknown recipe field`);
      else if (rule.additionalProperties && typeof rule.additionalProperties === 'object')
        schema(child, rule.additionalProperties as RecordValue, `${path}.${key}`);
    }
  }
}
export function validateRecipe(value: unknown, path = 'recipe'): asserts value is Recipe {
  schema(value, recipeSchema, path);
  const recipe = value as Recipe;
  if (recipe.bean.components) {
    const total = recipe.bean.components.reduce((sum, component) => sum + component.weight, 0);
    if (!Number.isFinite(total) || total <= 0)
      throw new Error(`${path}.bean.components: total relative weight must be finite and positive`);
  }
  const psd = recipe.grinder.psd;
  if (
    psd &&
    (psd.diameter_um.length !== psd.volume_fraction.length ||
      psd.volume_fraction.filter((v) => v > 0).length < 2 ||
      psd.diameter_um.some((d, i) => i > 0 && d <= psd.diameter_um[i - 1]))
  )
    throw new Error(
      `${path}.grinder.psd: expected aligned increasing diameters and positive volume`,
    );
  const custom = recipe.basket.custom;
  const profile = recipe.basket.custom?.profile_mm;
  if (
    profile &&
    (profile[0][0] !== 0 || profile.some((p, i) => i > 0 && p[0] <= profile[i - 1][0]))
  )
    throw new Error(`${path}.basket.custom.profile_mm: heights must start at zero and increase`);
  if (custom && profile && custom.perforated_diameter_mm > profile[0][1] * (1 + 1e-12))
    throw new Error(`${path}.basket.custom: perforated diameter exceeds the floor diameter`);
  if (
    custom?.pressurised_orifice_mm != null &&
    custom.pressurised_orifice_mm >= custom.perforated_diameter_mm
  )
    throw new Error(
      `${path}.basket.custom: pressurised orifice must be smaller than perforated diameter`,
    );
  recipe.machine.profile?.forEach((phase, i, phases) => {
    if (
      i < phases.length - 1 &&
      phase.until_time_s == null &&
      phase.until_beverage_g == null &&
      phase.until_pressure_bar == null
    )
      throw new Error(`${path}.machine.profile[${i}]: only the last phase may have no exit`);
  });
}
function summary(value: unknown, path: string) {
  const s = object(value, path);
  text(s.stop_reason, `${path}.stop_reason`, 100);
  number(s.shot_time_s, `${path}.shot_time_s`, 0, 3600);
  if (s.first_drops_s !== null) number(s.first_drops_s, `${path}.first_drops_s`, 0, 3600);
  for (const key of ['beverage_mass_kg', 'tds', 'ey']) number(s[key], `${path}.${key}`, 0, 1);
  number(s.max_pressure_pa, `${path}.max_pressure_pa`, 0, 10_000_000);
  number(s.bed_height_m, `${path}.bed_height_m`, 0, 1);
  number(s.headspace_m3, `${path}.headspace_m3`, 0, 1);
  if (s.drip_mass_kg !== undefined) number(s.drip_mass_kg, `${path}.drip_mass_kg`, 0, 1);
  list(s.species, `${path}.species`, 1000).forEach((v) => {
    const item = object(v, path);
    id(item.id, path);
    number(item.mass_kg, path, 0, 1);
    number(item.extracted_fraction, path, 0, 1);
  });
  const uniformity = object(s.uniformity, `${path}.uniformity`);
  for (const key of ['ey_std', 'ey_min', 'ey_max'])
    number(uniformity[key], `${path}.uniformity.${key}`, 0, 1);
  if (uniformity.ey_mean !== undefined)
    number(uniformity.ey_mean, `${path}.uniformity.ey_mean`, 0, 1);
}
function taste(value: unknown, path: string) {
  const t = object(value, path);
  if (t.schema !== 'puckworks.taste/1') throw new Error(`${path}: unsupported taste schema`);
  for (const key of ['trust', 'status', 'score_semantics']) text(t[key], `${path}.${key}`, 1000);
  for (const key of ['acidity_index', 'bitterness_index', 'astringency_index', 'body_index'])
    if (t[key] !== null) number(t[key], `${path}.${key}`, 0, 100);
  list(t.attributes, `${path}.attributes`, 4).forEach((v) => {
    const a = object(v, path);
    if (!['acidity', 'bitterness', 'astringency', 'body'].includes(String(a.id)))
      throw new Error(`${path}: invalid attribute`);
    text(a.label, path, 200);
    text(a.trust, path, 100);
    if (a.index !== null) number(a.index, path, 0, 100);
    list(a.assumptions, path, 100).forEach((s) => text(s, path));
    list(a.drivers, path, 100).forEach((v) => {
      const d = object(v, path);
      id(d.id, path);
      text(d.label, path);
      text(d.units, path);
      number(d.value, path);
      number(d.contribution, path);
      for (const key of ['registry_refs', 'source_refs'])
        list(d[key], path, 100).forEach((s) => text(s, path));
    });
  });
  const c = object(t.conditions, `${path}.conditions`);
  for (const key of ['chemistry_reference_temperature_c', 'serving_temperature_c', 'aroma_age_s'])
    if (c[key] !== null) number(c[key], `${path}.conditions.${key}`, 0, 86400);
  for (const key of ['dilution_water_g', 'original_beverage_g', 'diluted_beverage_g'])
    number(c[key], `${path}.conditions.${key}`, 0, 10000);
  if (typeof c.serving_temperature_modelled !== 'boolean')
    throw new Error(`${path}: invalid temperature flag`);
  list(t.assumptions, path, 100).forEach((s) => text(s, path));
  list(t.sources, path, 100).forEach((v) => {
    const s = object(v, path);
    for (const key of ['id', 'citation', 'url', 'evidence_grade', 'scope']) text(s[key], path);
  });
}
export function validateDocument(value: unknown): asserts value is JournalDocument {
  finiteTree(value);
  const doc = object(value, 'journal');
  keys(
    doc,
    ['schema', 'entries', 'calibrations'],
    ['schema', 'entries', 'calibrations'],
    'journal',
  );
  if (doc.schema !== 'puckworks.journal/1') throw new Error('Unsupported journal schema');
  const seen = new Set<string>();
  list(doc.entries, 'entries').forEach((v, i) => {
    const path = `entries[${i}]`,
      e = object(v, path);
    keys(
      e,
      ['id', 'createdAt', 'setupId', 'label', 'recipe', 'prediction', 'measurement', 'source'],
      ['id', 'createdAt', 'setupId', 'label', 'recipe', 'source'],
      path,
    );
    const entryId = id(e.id, `${path}.id`);
    if (seen.has(entryId)) throw new Error(`Duplicate entry id: ${entryId}`);
    seen.add(entryId);
    date(e.createdAt, `${path}.createdAt`);
    id(e.setupId, `${path}.setupId`);
    text(e.label, `${path}.label`, 1000);
    if (!['manual', 'csv', 'de1', 'json'].includes(String(e.source)))
      throw new Error(`${path}.source: invalid provenance`);
    validateRecipe(e.recipe, `${path}.recipe`);
    if (e.prediction !== undefined) {
      const p = object(e.prediction, `${path}.prediction`);
      keys(
        p,
        [
          'recordedAt',
          'coreVersion',
          'calibrationId',
          'executedRecipe',
          'summary',
          'taste',
          'origin',
        ],
        ['recordedAt', 'coreVersion', 'executedRecipe', 'summary', 'origin'],
        `${path}.prediction`,
      );
      date(p.recordedAt, `${path}.prediction.recordedAt`);
      id(p.coreVersion, `${path}.prediction.coreVersion`);
      if (p.calibrationId !== undefined) id(p.calibrationId, `${path}.prediction.calibrationId`);
      if (!['app', 'import'].includes(String(p.origin)))
        throw new Error(`${path}.prediction.origin: invalid provenance`);
      validateRecipe(p.executedRecipe, `${path}.prediction.executedRecipe`);
      summary(p.summary, `${path}.prediction.summary`);
      if (p.taste !== undefined) taste(p.taste, `${path}.prediction.taste`);
    }
    if (e.measurement !== undefined) {
      const m = object(e.measurement, `${path}.measurement`);
      keys(
        m,
        ['recordedAt', 'timeS', 'yieldG', 'tdsPercent', 'rating', 'notes'],
        ['recordedAt', 'timeS', 'yieldG', 'notes'],
        `${path}.measurement`,
      );
      date(m.recordedAt, `${path}.measurement.recordedAt`);
      number(m.timeS, `${path}.measurement.timeS`, 0.001, 3600);
      number(m.yieldG, `${path}.measurement.yieldG`, 0.001, 1000);
      if (m.tdsPercent !== undefined)
        number(m.tdsPercent, `${path}.measurement.tdsPercent`, 0.001, 100);
      if (m.rating !== undefined) number(m.rating, `${path}.measurement.rating`, 1, 5);
      if (
        typeof m.tdsPercent === 'number' &&
        m.tdsPercent * (m.yieldG as number) > 100 * e.recipe.prep.dose_g + 1e-9
      )
        throw new Error(
          `${path}.measurement: measured soluble mass exceeds the dry dose (EY > 100%)`,
        );
      text(m.notes, `${path}.measurement.notes`);
    }
  });
  seen.clear();
  list(doc.calibrations, 'calibrations', 1000).forEach((v, i) => {
    const path = `calibrations[${i}]`,
      p = object(v, path);
    keys(
      p,
      [
        'id',
        'createdAt',
        'coreVersion',
        'setupId',
        'scopeKey',
        'trainingIds',
        'parameters',
        'permeability',
        'grinderScale',
        'referencePermeability',
        'referenceX50GapRatio',
        'timeSigmaS',
        'tdsSigmaPercent',
        'posterior',
        'checks',
        'notes',
      ],
      [
        'id',
        'createdAt',
        'coreVersion',
        'setupId',
        'scopeKey',
        'trainingIds',
        'parameters',
        'permeability',
        'grinderScale',
        'referencePermeability',
        'timeSigmaS',
        'tdsSigmaPercent',
        'posterior',
        'checks',
        'notes',
      ],
      path,
    );
    const profileId = id(p.id, `${path}.id`);
    if (seen.has(profileId)) throw new Error(`Duplicate calibration id: ${profileId}`);
    seen.add(profileId);
    date(p.createdAt, `${path}.createdAt`);
    for (const key of ['coreVersion', 'setupId']) id(p[key], `${path}.${key}`);
    text(p.scopeKey, `${path}.scopeKey`, 20000, true);
    const training = list(p.trainingIds, path).map((s) => id(s, path));
    if (new Set(training).size !== training.length)
      throw new Error(`${path}: duplicate training id`);
    number(p.permeability, `${path}.permeability`, 1e-6, 1e6);
    number(p.referencePermeability, `${path}.referencePermeability`, 1e-20, 1e-6);
    number(p.grinderScale, `${path}.grinderScale`, 0.01, 100);
    if (p.referenceX50GapRatio !== undefined)
      number(p.referenceX50GapRatio, `${path}.referenceX50GapRatio`, 0.01, 100);
    number(p.timeSigmaS, `${path}.timeSigmaS`, 0.001, 3600);
    number(p.tdsSigmaPercent, `${path}.tdsSigmaPercent`, 0.001, 100);
    list(p.parameters, path, 2).forEach((v) => {
      const a = object(v, path);
      keys(
        a,
        ['id', 'label', 'map', 'p05', 'p95', 'status'],
        ['id', 'label', 'map', 'p05', 'p95', 'status'],
        path,
      );
      if (!['permeability', 'grinderScale'].includes(String(a.id)))
        throw new Error(`${path}: invalid fitted parameter`);
      text(a.label, path, 1000);
      text(a.status, path, 2000);
      const low = number(a.p05, path, 1e-20),
        high = number(a.p95, path, 1e-20);
      number(a.map, path, 1e-20);
      if (low > high) throw new Error(`${path}: invalid parameter interval`);
    });
    const posterior = list(p.posterior, path, 10000);
    if (!posterior.length) throw new Error(`${path}: empty posterior`);
    let weight = 0;
    posterior.forEach((v) => {
      const row = object(v, path);
      keys(
        row,
        ['permeability', 'grinderScale', 'weight'],
        ['permeability', 'grinderScale', 'weight'],
        path,
      );
      number(row.permeability, path, 1e-6, 1e6);
      number(row.grinderScale, path, 0.01, 100);
      weight += number(row.weight, path, 0, 1);
    });
    if (Math.abs(weight - 1) > 1e-5) throw new Error(`${path}: posterior weights must sum to one`);
    list(p.checks, path).forEach((v) => {
      const c = object(v, path);
      keys(
        c,
        ['entryId', 'timeErrorS', 'eyErrorPoints'],
        ['entryId', 'timeErrorS', 'eyErrorPoints'],
        path,
      );
      id(c.entryId, path);
      number(c.timeErrorS, path);
      if (c.eyErrorPoints !== null) number(c.eyErrorPoints, path);
    });
    list(p.notes, path, 100).forEach((s) => text(s, path));
  });
}
export function cloneDocument(value: JournalDocument): JournalDocument {
  validateDocument(value);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > MAX_JOURNAL_BYTES)
    throw new Error('Journal exceeds 10 MB limit');
  return JSON.parse(serialized) as JournalDocument;
}
