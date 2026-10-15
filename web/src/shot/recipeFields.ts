// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Labels, units and valid ranges of the recipe's numeric fields, keyed by
 * recipe path (docs/model/m1-contract.md: recipes use practical units). One
 * table serves the editor's labels, its validation messages, the list of
 * differences between pinned runs and the sweep's axis labels.
 *
 * The ranges are not written here: they are read from
 * data/schema/recipe.schema.json, which states the builder's plausibility
 * bounds (crates/puckmodel/src/bounds.rs; a Python test keeps the two in step),
 * so the editor cannot drift from the builder. Only labels, units, the display
 * scale and the glossary term live in this file.
 */
import schemaJson from '../../../data/schema/recipe.schema.json';

export interface FieldMeta {
  /** Short label, sentence case: "Dose". */
  label: string;
  /** Unit as displayed: "g", "%", "°C"; empty for dimensionless values. */
  unit: string;
  /**
   * Display scale as a power of ten: displayed value = recipe value × 10^shift.
   * Fractions shown in percent use 2. Ranges are in display units.
   */
  shift?: number;
  min?: number;
  max?: number;
  minExclusive?: boolean;
  integer?: boolean;
  /** Glossary entry explaining the term (glossary.ts). */
  term?: string;
}

/** Phase fields whose unit depends on the phase's control. */
export type PhaseField =
  'target' | 'ramp_s' | 'limit' | 'until_time_s' | 'until_beverage_g' | 'until_pressure_bar';

// ---------------------------------------------------------------- the schema

interface SchemaNode {
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  prefixItems?: SchemaNode[];
  oneOf?: SchemaNode[];
}

const DEFS = (schemaJson as unknown as { $defs: Record<string, SchemaNode> }).$defs;

/** The schema node at a path of property names and indices under `$defs`. */
export function schemaNode(path: readonly (string | number)[]): SchemaNode {
  let node: SchemaNode | undefined = DEFS[String(path[0])];
  for (const step of path.slice(1)) {
    if (!node) break;
    if (step === 'items') node = node.items;
    else if (typeof step === 'number') node = node.prefixItems?.[step] ?? node.oneOf?.[step];
    else node = node.properties?.[step];
  }
  if (!node) throw new Error(`recipe schema has no node at ${path.join('.')}`);
  return node;
}

/** The bounds of a schema node, scaled to display units by 10^shift. */
function boundsOf(
  node: SchemaNode,
  shift = 0,
): Pick<FieldMeta, 'min' | 'max' | 'minExclusive' | 'integer'> {
  const scale = (v: number) => Number(`${v}e${shift}`);
  const out: Pick<FieldMeta, 'min' | 'max' | 'minExclusive' | 'integer'> = {};
  if (node.exclusiveMinimum !== undefined) {
    out.min = scale(node.exclusiveMinimum);
    out.minExclusive = true;
  } else if (node.minimum !== undefined) out.min = scale(node.minimum);
  if (node.maximum !== undefined) out.max = scale(node.maximum);
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('integer')) out.integer = true;
  return out;
}

/** Where each field's bounds sit in the schema. */
const SCHEMA_PATHS: Record<string, (string | number)[]> = {
  'bean.arabica_fraction': ['bean', 'arabica_fraction'],
  'bean.roast_level': ['bean', 'roast_level'],
  'bean.days_off_roast': ['bean', 'days_off_roast'],
  'bean.bean_temp_c': ['bean', 'bean_temp_c'],
  'grinder.gap_um': ['grinder', 'gap_um'],
  'grinder.burr_diameter_mm': ['grinder', 'burr_diameter_mm'],
  'grinder.rpm': ['grinder', 'rpm'],
  'grinder.gap_at_ref_um': ['grinder', 'gap_at_ref_um'],
  'grinder.gap_per_unit_um': ['grinder', 'gap_per_unit_um'],
  'grinder.x50_gap_ratio': ['grinder', 'x50_gap_ratio'],
  'grinder.fines_at_340_pct': ['grinder', 'fines_at_340_pct'],
  'grinder.coarse_log_width': ['grinder', 'coarse_log_width'],
  'grinder.boulder_weight': ['grinder', 'boulder_weight'],
  'grinder.psd.diameter_um': ['psd', 'diameter_um', 'items'],
  'basket.custom.profile_mm.height': ['basket_custom', 'profile_mm', 'items', 0],
  'basket.custom.profile_mm.diameter': ['basket_custom', 'profile_mm', 'items', 1],
  'basket.custom.perforated_diameter_mm': ['basket_custom', 'perforated_diameter_mm'],
  'basket.custom.open_area_fraction': ['basket_custom', 'open_area_fraction'],
  'basket.custom.pressurised_orifice_mm': ['basket_custom', 'pressurised_orifice_mm'],
  'basket.custom.discharge_coefficient': ['basket_custom', 'discharge_coefficient'],
  'prep.dose_g': ['prep', 'dose_g'],
  'prep.tamp_kgf': ['prep', 'tamp_kgf'],
  'machine.temperature_c': ['machine', 'temperature_c'],
  'machine.headspace_ml': ['machine', 'headspace_ml'],
  'machine.pump.max_flow_ml_s': ['pump', 0, 'max_flow_ml_s'],
  'machine.pump.max_pressure_bar': ['pump', 0, 'max_pressure_bar'],
  'machine.pump.free_flow_ml_s': ['pump', 1, 'free_flow_ml_s'],
  'machine.pump.stall_pressure_bar': ['pump', 1, 'stall_pressure_bar'],
  'machine.pump.opv_bar': ['pump', 1, 'opv_bar'],
  'stop.beverage_g': ['stop', 'beverage_g'],
  'stop.time_s': ['stop', 'time_s'],
  'numerics.size_classes': ['numerics', 'size_classes'],
};

/** Labels, units, display scales and glossary terms (the ranges come from the schema). */
const LABELS: Record<string, Omit<FieldMeta, 'min' | 'max' | 'minExclusive' | 'integer'>> = {
  'bean.arabica_fraction': { label: 'Arabica share', unit: '%', shift: 2 },
  'bean.roast_level': { label: 'Roast level', unit: '', term: 'roast' },
  'bean.days_off_roast': { label: 'Days off roast', unit: 'days' },
  'bean.bean_temp_c': { label: 'Bean temperature', unit: '°C' },
  'grinder.gap_um': { label: 'Burr gap', unit: 'µm', term: 'gap' },
  'grinder.burr_diameter_mm': { label: 'Burr diameter', unit: 'mm' },
  'grinder.rpm': { label: 'Burr speed', unit: 'rpm' },
  'grinder.gap_at_ref_um': { label: 'Gap at the reference setting', unit: 'µm' },
  'grinder.gap_per_unit_um': { label: 'Gap change per setting unit', unit: 'µm' },
  'grinder.x50_gap_ratio': { label: 'X50 / gap ratio (κ_G)', unit: '', term: 'x50' },
  'grinder.fines_at_340_pct': { label: 'Fines at X50 = 340 µm (u_G)', unit: '%', term: 'fines' },
  'grinder.coarse_log_width': { label: 'Coarse-mode width (σ_c)', unit: '', term: 'coarse-width' },
  'grinder.boulder_weight': { label: 'Boulder share (w_b)', unit: '%', shift: 2, term: 'boulders' },
  'grinder.psd.diameter_um': { label: 'Particle diameter', unit: 'µm' },
  'basket.custom.profile_mm.height': { label: 'Height', unit: 'mm' },
  'basket.custom.profile_mm.diameter': { label: 'Inner diameter', unit: 'mm' },
  'basket.custom.perforated_diameter_mm': {
    label: 'Perforated diameter',
    unit: 'mm',
    term: 'perforated',
  },
  'basket.custom.open_area_fraction': {
    label: 'Open area',
    unit: '%',
    shift: 2,
    term: 'open-area',
  },
  'basket.custom.pressurised_orifice_mm': {
    label: 'Orifice diameter',
    unit: 'mm',
    term: 'pressurised',
  },
  'basket.custom.discharge_coefficient': {
    label: 'Discharge coefficient',
    unit: '',
    term: 'discharge',
  },
  'prep.dose_g': { label: 'Dose', unit: 'g' },
  'prep.tamp_kgf': { label: 'Tamp force', unit: 'kgf', term: 'tamp' },
  'machine.temperature_c': { label: 'Brew temperature', unit: '°C' },
  'machine.headspace_ml': { label: 'Group headspace', unit: 'mL', term: 'headspace' },
  'machine.pump.max_flow_ml_s': { label: 'Maximum flow', unit: 'mL/s' },
  'machine.pump.max_pressure_bar': { label: 'Maximum pressure', unit: 'bar' },
  'machine.pump.free_flow_ml_s': { label: 'Free flow', unit: 'mL/s', term: 'vibratory' },
  'machine.pump.stall_pressure_bar': { label: 'Stall pressure', unit: 'bar', term: 'vibratory' },
  'machine.pump.opv_bar': { label: 'OPV opening pressure', unit: 'bar', term: 'opv' },
  'stop.beverage_g': { label: 'Stop at beverage mass', unit: 'g' },
  'stop.time_s': { label: 'Stop at time', unit: 's' },
  'numerics.size_classes': { label: 'Size classes', unit: '', term: 'size-classes' },
};

export const FIELDS: Record<string, FieldMeta> = Object.fromEntries(
  Object.entries(LABELS).map(([path, meta]) => [
    path,
    { ...meta, ...boundsOf(schemaNode(SCHEMA_PATHS[path]), meta.shift) },
  ]),
);

/** The recipe paths with schema bounds, for tests that keep this table complete. */
export const FIELD_SCHEMA_PATHS: Readonly<Record<string, readonly (string | number)[]>> =
  SCHEMA_PATHS;

/** Metadata of a phase field; the unit follows the phase's control. */
export function phaseFieldMeta(field: PhaseField, control: string): FieldMeta {
  const bounds = boundsOf(schemaNode(['phase', field]));
  switch (field) {
    case 'target':
      return { label: 'Target', unit: control === 'flow' ? 'mL/s' : 'bar', ...bounds };
    case 'ramp_s':
      return { label: 'Ramp', unit: 's', term: 'ramp', ...bounds };
    case 'limit':
      return {
        label: control === 'flow' ? 'Pressure limit' : 'Flow limit',
        unit: control === 'flow' ? 'bar' : 'mL/s',
        term: 'limit',
        ...bounds,
      };
    case 'until_time_s':
      return { label: 'Until time', unit: 's', ...bounds };
    case 'until_beverage_g':
      return { label: 'Until beverage', unit: 'g', ...bounds };
    case 'until_pressure_bar':
      return { label: 'Until pressure', unit: 'bar', ...bounds };
  }
}

/** Labels of recipe paths that are not plain numbers (for the differences table). */
export const OTHER_LABELS: Record<string, string> = {
  'grinder.setting': 'Dial setting',
  'bean.preset': 'Bean preset',
  'bean.process': 'Process',
  'grinder.preset': 'Grinder preset',
  'grinder.family': 'Burr family',
  'grinder.psd': 'Measured PSD',
  'basket.preset': 'Basket preset',
  'basket.custom': 'Custom basket',
  'prep.distribution': 'Distribution',
  'prep.puck_screen': 'Puck screen',
  'prep.paper_bottom': 'Paper below the puck',
  'prep.paper_top': 'Paper on top',
  'machine.preset': 'Machine preset',
  'machine.profile': 'Program',
  'machine.pump': 'Pump',
  'machine.vent_headspace': 'Vents the group after the shot',
  'numerics.tier': 'Tier',
};

const MINUS = '−';

/** A number with its unit: "18 g", "92 °C", "90%", "0.5". */
export function withUnit(value: number | string, unit: string): string {
  const text = typeof value === 'number' ? String(value).replace('-', MINUS) : value;
  if (!unit) return text;
  if (unit === '%') return `${text}%`;
  return `${text} ${unit}`;
}

/** "Dose (g)", "Roast level". */
export function labelWithUnit(meta: FieldMeta): string {
  return meta.unit ? `${meta.label} (${meta.unit})` : meta.label;
}

/** The valid range in words: "between 1 g and 60 g", "a whole number from 2 to 60". */
export function rangeText(meta: FieldMeta): string {
  const { min, max, unit } = meta;
  const u = (v: number) => withUnit(v, unit);
  if (meta.integer && min !== undefined && max !== undefined) {
    return `a whole number from ${min} to ${max}`;
  }
  if (min !== undefined && max !== undefined) {
    return meta.minExclusive
      ? `more than ${u(min)} and at most ${u(max)}`
      : `between ${u(min)} and ${u(max)}`;
  }
  if (min !== undefined) return meta.minExclusive ? `more than ${u(min)}` : `${u(min)} or more`;
  if (max !== undefined) return `at most ${u(max)}`;
  return 'a number';
}

/** The message for a value outside the field's range or not a number. */
export function invalidMessage(meta: FieldMeta): string {
  return `${meta.label} must be ${rangeText(meta)}.`;
}

/** The message for a required field left empty. */
export function requiredMessage(meta: FieldMeta): string {
  return `Enter ${meta.label.toLowerCase()}${meta.unit ? ` (${meta.unit})` : ''}.`;
}

/** True if `value` lies in the field's range. */
export function inRange(meta: FieldMeta, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (meta.integer && !Number.isInteger(value)) return false;
  if (meta.min !== undefined && (meta.minExclusive ? value <= meta.min : value < meta.min)) {
    return false;
  }
  if (meta.max !== undefined && value > meta.max) return false;
  return true;
}
