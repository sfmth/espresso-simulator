// SPDX-License-Identifier: GPL-2.0-or-later
/** Puck-preparation and stop/numerics sections of the recipe editor. */
import { DISTRIBUTIONS } from '../../engine/shotTypes';
import { CheckField, SelectField, TextField } from '../fields';
import { BuildNotes } from '../PresetInfo';
import { FIELDS, labelWithUnit } from '../recipeFields';
import { useShotStore } from '../shotStore';
import { defaultRatio } from '../sweep';
import { useEditorContext } from './context';
export { BeanSection } from './BeanSection';

const DISTRIBUTION_LABELS: Record<string, string> = {
  none: 'None',
  tap: 'Tapping',
  wdt: 'WDT (needle stirring)',
};

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
        default ratio). The extract then drips for a moment, and the beverage mass includes the
        drip.
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
      <details>
        <summary>Calculation accuracy</summary>
        <div className="field-grid">
          <SelectField
            path="numerics.tier"
            label="Calculation mode"
            term="tier"
            value={numerics.tier}
            onChange={(tier) => patch('numerics', { tier: tier === '0' ? '0' : '1' })}
            options={[
              { value: '1', label: 'Standard' },
              { value: '0', label: 'Fast preview' },
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
      </details>
      <BuildNotes notes={notes.stop} stale={notesStale} />
    </>
  );
}
