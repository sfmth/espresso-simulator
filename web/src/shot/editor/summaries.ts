// SPDX-License-Identifier: GPL-2.0-or-later
/** One-line summaries of each editor section, shown while the section is folded. */
import type { Catalog } from '../../engine/shotTypes';
import { filledAdvanced, type GrinderAdvancedField, type RecipeForm } from '../recipeForm';
import { defaultRatio } from '../sweep';
import { findPreset } from './context';

const join = (parts: (string | false | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');

export function beanSummary(form: RecipeForm, catalog: Catalog): string {
  const b = form.bean;
  const preset =
    findPreset(catalog.presets.beans, b.preset) ?? catalog.presets.beans.find((x) => x.default);
  return join([
    preset?.name ?? 'Default bean',
    b.roast_level && `roast ${b.roast_level}`,
    b.days_off_roast && `${b.days_off_roast} days`,
    b.arabica_fraction && `${b.arabica_fraction}% Arabica`,
  ]);
}

/** Short names of the advanced grinder overrides, for the section summary. */
const ADVANCED_NAMES: Record<GrinderAdvancedField, (v: string) => string> = {
  gap_at_ref_um: (v) => `gap at ref ${v} µm`,
  gap_per_unit_um: (v) => `${v} µm per unit`,
  x50_gap_ratio: (v) => `κ_G ${v}`,
  fines_at_340_pct: (v) => `u_G ${v}%`,
  coarse_log_width: (v) => `σ_c ${v}`,
  boulder_weight: (v) => `w_b ${v}%`,
  burr_diameter_mm: (v) => `${v} mm burrs`,
  rpm: (v) => `${v} rpm`,
};

export function grinderSummary(form: RecipeForm, catalog: Catalog): string {
  const g = form.grinder;
  const advanced =
    g.mode === 'psd' ? [] : filledAdvanced(g).map((k) => ADVANCED_NAMES[k](g[k].trim()));
  if (g.mode === 'psd') {
    const rows = g.psdText.split(/\r?\n/).filter((l) => /^\s*[\d.]/.test(l)).length;
    return `Measured PSD${rows > 0 ? `, ${rows} bins` : ''}`;
  }
  const name =
    g.mode === 'preset'
      ? (findPreset(catalog.presets.grinders, g.preset)?.name ?? 'Choose a grinder')
      : `${findPreset(catalog.presets.grinder_families, g.family)?.name ?? 'Burr family'}`;
  const setting =
    g.by === 'gap' ? g.gap_um && `${g.gap_um} µm gap` : g.setting && `setting ${g.setting}`;
  return join([name, setting, advanced.length > 0 && `your ${advanced.join(', ')}`]);
}

export function basketSummary(form: RecipeForm, catalog: Catalog): string {
  const k = form.basket;
  if (k.mode === 'custom') {
    const rim = k.profile.at(-1)?.diameter;
    return join([
      'Custom basket',
      rim && `${rim} mm rim`,
      k.outlet === 'pressurised' && 'pressurised',
    ]);
  }
  if (k.mode === 'machine') return "The machine's default basket";
  return findPreset(catalog.presets.baskets, k.preset)?.name ?? 'Choose a basket';
}

const DISTRIBUTION_WORDS: Record<string, string> = {
  none: 'no distribution',
  tap: 'tapped',
  wdt: 'WDT',
};

export function prepSummary(form: RecipeForm): string {
  const p = form.prep;
  return join([
    p.dose_g ? `${p.dose_g} g` : 'Dose missing',
    p.distribution && DISTRIBUTION_WORDS[p.distribution],
    p.puck_screen && 'screen',
    p.paper_bottom && 'paper below',
    p.paper_top && 'paper on top',
  ]);
}

export function machineSummary(form: RecipeForm, catalog: Catalog): string {
  const m = form.machine;
  const preset = findPreset(catalog.presets.machines, m.preset);
  return join([
    preset?.name ?? 'No preset',
    (m.customProgram || !preset) &&
      `own program, ${m.phases.length} phase${m.phases.length === 1 ? '' : 's'}`,
    m.temperature_c && `${m.temperature_c} °C`,
    m.pumpMode !== 'preset' && `${m.pumpMode} pump`,
    (m.vent_headspace === '' ? preset?.vent_headspace === true : m.vent_headspace === 'yes') &&
      'vents after the stop',
  ]);
}

export function stopSummary(form: RecipeForm, catalog: Catalog): string {
  const s = form.stop;
  return join([
    s.beverage_g && `${s.beverage_g} g`,
    s.time_s && `${s.time_s} s`,
    !s.beverage_g && !s.time_s && `${defaultRatio(catalog)} × dose`,
    `tier ${form.numerics.tier}`,
  ]);
}

export function overridesSummary(form: RecipeForm): string {
  const n = Object.values(form.overrides).filter((v) => v.trim() !== '').length;
  return n === 0 ? 'None' : `${n} parameter${n === 1 ? '' : 's'} overridden`;
}
