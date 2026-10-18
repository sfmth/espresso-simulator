// SPDX-License-Identifier: GPL-2.0-or-later
/** The bean, puck-preparation and stop/numerics sections of the recipe editor. */
import {
  BEAN_PROCESSES,
  BEAN_STORAGE,
  BEAN_VARIETIES,
  DISTRIBUTIONS,
} from '../../engine/shotTypes';
import { CheckField, SelectField, TextField } from '../fields';
import { BuildNotes, PresetInfo } from '../PresetInfo';
import { FIELDS, labelWithUnit } from '../recipeFields';
import { shiftedText } from '../recipeForm';
import { useShotStore } from '../shotStore';
import { defaultRatio } from '../sweep';
import { findPreset, presetOptions, useEditorContext } from './context';

export const PROCESS_LABELS: Record<string, string> = {
  washed: 'Washed',
  natural: 'Natural',
  honey: 'Honey',
  anaerobic: 'Anaerobic',
};

export const VARIETY_LABELS: Record<string, string> = {
  unspecified: 'Unspecified',
  'typica-bourbon': 'Typica / Bourbon',
  gesha: 'Gesha',
  'ethiopian-landrace': 'Ethiopian landrace',
  canephora: 'Canephora (Robusta)',
  hybrid: 'Hybrid',
};

export const STORAGE_LABELS: Record<string, string> = {
  sealed: 'Sealed',
  open: 'Open to air',
  frozen: 'Frozen',
};

const DISTRIBUTION_LABELS: Record<string, string> = {
  none: 'None',
  tap: 'Tapping',
  wdt: 'WDT (needle stirring)',
};

/** "0.5 from the preset" as a placeholder. */
function fromPreset(value: number | null | undefined, shift = 0): string | undefined {
  return typeof value === 'number' ? `${shiftedText(value, shift)} from the preset` : undefined;
}

export function BeanSection() {
  const { catalog, errors, notes, notesStale } = useEditorContext();
  const bean = useShotStore((s) => s.form.bean);
  const patch = useShotStore((s) => s.patchForm);
  const set = (p: Partial<typeof bean>) => patch('bean', p);
  const beans = catalog.presets.beans;
  const fallback = beans.find((b) => b.default);
  const preset = findPreset(beans, bean.preset) ?? fallback;
  return (
    <>
      <SelectField
        path="bean.preset"
        label="Bean preset"
        value={bean.preset}
        onChange={(preset) => set({ preset })}
        options={[
          { value: '', label: `Default (${fallback?.name ?? 'medium roast'})` },
          ...presetOptions(beans),
        ]}
        error={errors['bean.preset']}
        hint="Fields left empty take the preset's value."
      />
      <PresetInfo preset={preset} />
      <div className="field-grid">
        <TextField
          path="bean.altitude_m"
          label={labelWithUnit(FIELDS['bean.altitude_m'])}
          value={bean.altitude_m}
          onChange={(altitude_m) => set({ altitude_m })}
          placeholder={fromPreset(preset?.altitude_m)}
          error={errors['bean.altitude_m']}
          hint="Optional origin descriptor; no fitted altitude coefficient."
        />
        <TextField
          path="bean.arabica_fraction"
          label={labelWithUnit(FIELDS['bean.arabica_fraction'])}
          value={bean.arabica_fraction}
          onChange={(arabica_fraction) => set({ arabica_fraction })}
          placeholder={fromPreset(preset?.arabica_fraction, 2)}
          error={errors['bean.arabica_fraction']}
          hint="The rest is Robusta."
        />
        <TextField
          path="bean.roast_level"
          label="Roast level (0 light – 1 dark)"
          term="roast"
          value={bean.roast_level}
          onChange={(roast_level) => set({ roast_level })}
          placeholder={fromPreset(preset?.roast_level)}
          error={errors['bean.roast_level']}
        />
        <TextField
          path="bean.days_off_roast"
          label="Days off roast"
          value={bean.days_off_roast}
          onChange={(days_off_roast) => set({ days_off_roast })}
          placeholder={fromPreset(preset?.days_off_roast)}
          error={errors['bean.days_off_roast']}
        />
        <TextField
          path="bean.bean_temp_c"
          label={labelWithUnit(FIELDS['bean.bean_temp_c'])}
          value={bean.bean_temp_c}
          onChange={(bean_temp_c) => set({ bean_temp_c })}
          placeholder="room temperature"
          error={errors['bean.bean_temp_c']}
          hint="When ground. Colder beans grind finer."
        />
      </div>
      <SelectField
        path="bean.process"
        label="Process"
        value={bean.process}
        onChange={(process) => set({ process: process as typeof bean.process })}
        options={[
          {
            value: '',
            label: preset?.process
              ? `From the preset (${PROCESS_LABELS[preset.process] ?? preset.process})`
              : 'Not given',
          },
          ...BEAN_PROCESSES.map((p) => ({ value: p, label: PROCESS_LABELS[p] ?? p })),
        ]}
        error={errors['bean.process']}
        hint="Process effects are limited to the composition assumptions documented by the model."
      />
      <div className="field-grid">
        <SelectField
          path="bean.variety_group"
          label="Variety group"
          value={bean.variety_group}
          onChange={(variety_group) =>
            set({ variety_group: variety_group as typeof bean.variety_group })
          }
          options={[
            {
              value: '',
              label: preset?.variety_group
                ? `From the preset (${VARIETY_LABELS[preset.variety_group] ?? preset.variety_group})`
                : 'Use the model default',
            },
            ...BEAN_VARIETIES.map((value) => ({ value, label: VARIETY_LABELS[value] })),
          ]}
          error={errors['bean.variety_group']}
          hint="Recorded descriptor; the model does not infer a variety-specific composition."
        />
        <SelectField
          path="bean.storage"
          label="Bean storage"
          value={bean.storage}
          onChange={(storage) => set({ storage: storage as typeof bean.storage })}
          options={[
            {
              value: '',
              label: `Default (${STORAGE_LABELS[preset?.storage ?? 'sealed']?.toLowerCase() ?? 'sealed'})`,
            },
            ...BEAN_STORAGE.map((value) => ({ value, label: STORAGE_LABELS[value] })),
          ]}
          error={errors['bean.storage']}
          hint="Storage changes the model’s age-dependent CO₂ inventory."
        />
      </div>
      <BuildNotes notes={notes.bean} stale={notesStale} />
    </>
  );
}

export function PrepSection() {
  const { errors, notes, notesStale } = useEditorContext();
  const prep = useShotStore((s) => s.form.prep);
  const patch = useShotStore((s) => s.patchForm);
  const set = (p: Partial<typeof prep>) => patch('prep', p);
  return (
    <>
      <div className="field-grid">
        <TextField
          path="prep.dose_g"
          label={labelWithUnit(FIELDS['prep.dose_g'])}
          value={prep.dose_g}
          onChange={(dose_g) => set({ dose_g })}
          error={errors['prep.dose_g']}
          hint="Dry coffee in the basket."
        />
        <TextField
          path="prep.tamp_kgf"
          label={labelWithUnit(FIELDS['prep.tamp_kgf'])}
          term="tamp"
          value={prep.tamp_kgf}
          onChange={(tamp_kgf) => set({ tamp_kgf })}
          error={errors['prep.tamp_kgf']}
        />
      </div>
      <SelectField
        path="prep.distribution"
        label="Distribution"
        term="wdt"
        value={prep.distribution}
        onChange={(distribution) => set({ distribution: distribution as typeof prep.distribution })}
        options={[
          { value: '', label: 'Not given (tapping assumed)' },
          ...DISTRIBUTIONS.map((d) => ({ value: d, label: DISTRIBUTION_LABELS[d] ?? d })),
        ]}
        error={errors['prep.distribution']}
      />
      <CheckField
        path="prep.puck_screen"
        label="Puck screen on top"
        checked={prep.puck_screen}
        onChange={(puck_screen) => set({ puck_screen })}
      />
      <CheckField
        path="prep.paper_bottom"
        label="Paper filter below the puck"
        checked={prep.paper_bottom}
        onChange={(paper_bottom) => set({ paper_bottom })}
      />
      <CheckField
        path="prep.paper_top"
        label="Paper filter on top"
        checked={prep.paper_top}
        onChange={(paper_top) => set({ paper_top })}
        hint="Recorded; no measurable effect."
      />
      <BuildNotes notes={notes.prep} stale={notesStale} />
    </>
  );
}

export function StopSection() {
  const { catalog, errors, notes, notesStale } = useEditorContext();
  const ratio = defaultRatio(catalog);
  const stop = useShotStore((s) => s.form.stop);
  const numerics = useShotStore((s) => s.form.numerics);
  const patch = useShotStore((s) => s.patchForm);
  return (
    <>
      <p className="section-intro">
        The shot stops at the first condition met; with neither, at {ratio} times the dose (the
        registry’s default ratio). The extract then drips for a moment, and the beverage mass
        includes the drip.
      </p>
      <div className="field-grid">
        <TextField
          path="stop.beverage_g"
          label={labelWithUnit(FIELDS['stop.beverage_g'])}
          value={stop.beverage_g}
          onChange={(beverage_g) => patch('stop', { beverage_g })}
          error={errors['stop.beverage_g']}
        />
        <TextField
          path="stop.time_s"
          label={labelWithUnit(FIELDS['stop.time_s'])}
          value={stop.time_s}
          onChange={(time_s) => patch('stop', { time_s })}
          error={errors['stop.time_s']}
        />
      </div>
      <div className="field-grid">
        <SelectField
          path="numerics.tier"
          label="Tier for Run"
          term="tier"
          value={numerics.tier}
          onChange={(tier) => patch('numerics', { tier: tier === '0' ? '0' : '1' })}
          options={[
            { value: '1', label: 'Tier 1, standard' },
            { value: '0', label: 'Tier 0, preview' },
          ]}
        />
        <TextField
          path="numerics.size_classes"
          label="Size classes"
          term="size-classes"
          inputMode="numeric"
          value={numerics.size_classes}
          onChange={(size_classes) => patch('numerics', { size_classes })}
          placeholder="30"
          error={errors['numerics.size_classes']}
        />
      </div>
      <BuildNotes notes={notes.stop} stale={notesStale} />
    </>
  );
}
