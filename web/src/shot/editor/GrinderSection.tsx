// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The grinder: a preset and its dial (or a burr gap), a burr family from
 * scratch, or a measured particle-size distribution pasted from a spreadsheet
 * or an instrument export (PLAN §1.2 principle 7).
 *
 * Calibration and PSD-shape overrides belong to one grinder: choosing another
 * preset or switching modes clears them (recipeForm.changeGrinderPreset and
 * changeGrinderMode), and while any is set the Advanced block stays open and
 * the section's summary lists them, so no hidden value changes the shot.
 */
import { useMemo, useState } from 'react';
import { PSD_METHODS } from '../../engine/shotTypes';
import { fieldId, RadioGroup, SelectField, TextField, useHelp } from '../fields';
import { BuildNotes, PresetInfo } from '../PresetInfo';
import { parsePsdText } from '../psdParse';
import { FIELDS, labelWithUnit } from '../recipeFields';
import {
  changeGrinderMode,
  changeGrinderPreset,
  filledAdvanced,
  GRINDER_ADVANCED,
  type GrinderMode,
  type GrindBy,
  type RecipeForm,
} from '../recipeForm';
import { useShotStore } from '../shotStore';
import { findPreset, presetOptions, useEditorContext } from './context';
import { GrinderInternals } from '../equipment/GrinderInternals';

const METHOD_LABELS: Record<string, string> = {
  dry_laser: 'Laser diffraction, dry',
  wet_laser: 'Laser diffraction, wet',
  image: 'Image analysis',
  sieve: 'Sieves',
  other: 'Other',
};

const PSD_EXAMPLE =
  'diameter_um\tvolume_fraction\n30\t0.10\n60\t0.15\n150\t0.20\n300\t0.40\n500\t0.15';

type Grinder = RecipeForm['grinder'];

/** Error keys of the fields inside the Advanced block. */
const ADVANCED_PATHS = new Set<string>(GRINDER_ADVANCED.map((k) => `grinder.${k}`));

function PsdEditor({ grinder, set }: { grinder: Grinder; set: (p: Partial<Grinder>) => void }) {
  const { errors } = useEditorContext();
  const id = fieldId('grinder.psd');
  const help = useHelp(id, 'fines');
  const parsed = useMemo(() => parsePsdText(grinder.psdText), [grinder.psdText]);
  const error = errors['grinder.psd'];
  const summary =
    parsed.ok &&
    `${parsed.diameter_um.length} bin${parsed.diameter_um.length === 1 ? '' : 's'}, ` +
      `${parsed.diameter_um[0]}–${parsed.diameter_um.at(-1)} µm`;
  return (
    <>
      <div className="field">
        <div className="field-head">
          <label htmlFor={id}>Measured distribution</label>
          {help.button}
        </div>
        {help.text}
        <textarea
          id={id}
          rows={7}
          spellCheck={false}
          value={grinder.psdText}
          placeholder={PSD_EXAMPLE}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          onChange={(event) => set({ psdText: event.target.value })}
        />
        <p className="field-hint" id={`${id}-hint`}>
          Paste two columns, diameter (µm) and the volume fraction in each bin (any scale,
          normalised; not cumulative), separated by tabs, commas, semicolons or spaces; a copy from
          a spreadsheet works. Header lines are skipped.
          {summary && ` Read: ${summary}.`}
          {parsed.ok && parsed.notes.length > 0 && ` ${parsed.notes.join(' ')}`}
        </p>
        {error && (
          <p className="field-error" id={`${id}-error`}>
            {error}
          </p>
        )}
      </div>
      <SelectField
        path="grinder.psd.method"
        label="Measured by"
        value={grinder.psdMethod}
        onChange={(psdMethod) => set({ psdMethod: psdMethod as Grinder['psdMethod'] })}
        options={[
          { value: '', label: 'Not given' },
          ...PSD_METHODS.map((m) => ({ value: m, label: METHOD_LABELS[m] ?? m })),
        ]}
        hint="Recorded with a caveat; dry and wet laser diffraction report different fines."
      />
    </>
  );
}

export function GrinderSection() {
  const { catalog, errors, notes, notesStale } = useEditorContext();
  const grinder = useShotStore((s) => s.form.grinder);
  const patch = useShotStore((s) => s.patchForm);
  const reveal = useShotStore((s) => s.reveal);
  const set = (p: Partial<Grinder>) => patch('grinder', p);
  const preset = findPreset(catalog.presets.grinders, grinder.preset);
  const familyId = grinder.mode === 'preset' ? preset?.family : grinder.family;
  const family = findPreset(catalog.presets.grinder_families, familyId ?? '');
  const dial = preset?.dial;
  const presetPsd = preset?.psd ?? {};
  const filled = filledAdvanced(grinder);
  const [advancedOpen, setAdvancedOpen] = useState(
    () => filled.length > 0 || (reveal !== null && ADVANCED_PATHS.has(reveal.path)),
  );
  // Open the Advanced block when a field inside it is to be shown.
  const [seenReveal, setSeenReveal] = useState(reveal?.nonce ?? 0);
  if (reveal && reveal.nonce !== seenReveal) {
    setSeenReveal(reveal.nonce);
    if (ADVANCED_PATHS.has(reveal.path)) setAdvancedOpen(true);
  }
  const advancedErrors = [...ADVANCED_PATHS].some((p) => errors[p]);
  const open = advancedOpen || filled.length > 0 || advancedErrors;
  const shape = (
    key: 'x50_gap_ratio' | 'fines_at_340_pct' | 'coarse_log_width' | 'boulder_weight',
  ) => {
    const fromPreset = presetPsd[key];
    const fromFamily = family?.psd[key];
    const scale = key === 'boulder_weight' ? 100 : 1;
    if (fromPreset !== undefined)
      return `${Number((fromPreset * scale).toPrecision(6))} from the preset`;
    if (fromFamily !== undefined)
      return `${Number((fromFamily * scale).toPrecision(6))} from the family`;
    return 'registry default';
  };

  return (
    <>
      <div id="grinder-internals" tabIndex={-1}>
        <GrinderInternals />
      </div>
      <RadioGroup<GrinderMode>
        name="grinder.mode"
        legend="Describe the grinder by"
        value={grinder.mode}
        onChange={(mode) =>
          patch('grinder', changeGrinderMode(grinder, mode, catalog.presets.grinders))
        }
        options={[
          { value: 'preset', label: 'Preset and setting' },
          { value: 'family', label: 'Burr family and gap' },
          { value: 'psd', label: 'Measured PSD' },
        ]}
      />

      {grinder.mode === 'preset' && (
        <>
          <SelectField
            path="grinder.preset"
            label="Grinder preset"
            value={grinder.preset}
            onChange={(id) =>
              patch(
                'grinder',
                changeGrinderPreset(grinder, findPreset(catalog.presets.grinders, id), id),
              )
            }
            options={[{ value: '', label: 'Choose…' }, ...presetOptions(catalog.presets.grinders)]}
            error={errors['grinder.preset']}
            hint={
              filled.length > 0
                ? 'Choosing another preset clears the calibration and PSD overrides below.'
                : undefined
            }
          />
          <PresetInfo preset={preset} />
        </>
      )}

      {grinder.mode === 'family' && (
        <>
          <SelectField
            path="grinder.family"
            label="Burr family"
            value={grinder.family}
            onChange={(familyId) => set({ family: familyId })}
            options={presetOptions(catalog.presets.grinder_families)}
            error={errors['grinder.family']}
          />
          <PresetInfo preset={family} />
        </>
      )}

      {grinder.mode !== 'psd' && (
        <>
          <RadioGroup<GrindBy>
            name="grinder.by"
            legend="Set the grind by"
            value={grinder.by}
            onChange={(by) => set({ by })}
            options={[
              { value: 'setting', label: 'Dial setting' },
              { value: 'gap', label: 'Burr gap' },
            ]}
            term="gap"
          />
          {grinder.by === 'gap' ? (
            <TextField
              path="grinder.gap_um"
              label={labelWithUnit(FIELDS['grinder.gap_um'])}
              value={grinder.gap_um}
              onChange={(gap_um) => set({ gap_um })}
              error={errors['grinder.gap_um']}
            />
          ) : (
            <TextField
              path="grinder.setting"
              label={dial ? `Dial setting (${dial.label})` : 'Dial setting'}
              value={grinder.setting}
              onChange={(setting) => set({ setting })}
              placeholder={dial ? `${dial.default} (the dial's default)` : undefined}
              error={errors['grinder.setting']}
              hint={
                dial
                  ? `Dial ${dial.min}–${dial.max}; gap = ${grinder.gap_at_ref_um || dial.gap_at_ref_um} µm + ` +
                    `${grinder.gap_per_unit_um || dial.gap_per_unit_um} µm per unit from ${dial.ref}` +
                    `${grinder.gap_at_ref_um || grinder.gap_per_unit_um ? ' (your calibration)' : ''}. ` +
                    (dial.anchored
                      ? `Its particle sizes were measured at settings ${dial.anchored.min}–${dial.anchored.max}; outside that the model extrapolates. `
                      : '') +
                    'Settings outside the dial are clamped.'
                  : grinder.mode === 'family'
                    ? 'With a family, a dial setting needs the dial calibration below.'
                    : undefined
              }
            />
          )}
          {grinder.mode === 'family' && grinder.by === 'setting' && (
            <div className="field-grid">
              <TextField
                path="grinder.gap_at_ref_um"
                label="Gap at setting 0 (µm)"
                value={grinder.gap_at_ref_um}
                onChange={(gap_at_ref_um) => set({ gap_at_ref_um })}
                error={errors['grinder.gap_at_ref_um']}
              />
              <TextField
                path="grinder.gap_per_unit_um"
                label={labelWithUnit(FIELDS['grinder.gap_per_unit_um'])}
                value={grinder.gap_per_unit_um}
                onChange={(gap_per_unit_um) => set({ gap_per_unit_um })}
                error={errors['grinder.gap_per_unit_um']}
              />
            </div>
          )}
          <details
            className="advanced"
            open={open}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary>
              Advanced: calibration, PSD shape and burrs
              {filled.length > 0 ? ` (${filled.length} set)` : ''}
            </summary>
            {grinder.mode === 'preset' && grinder.by === 'setting' && (
              <div className="field-grid">
                <TextField
                  path="grinder.gap_at_ref_um"
                  label={`Gap at setting ${dial?.ref ?? 0} (µm)`}
                  value={grinder.gap_at_ref_um}
                  onChange={(gap_at_ref_um) => set({ gap_at_ref_um })}
                  placeholder={dial ? `${dial.gap_at_ref_um} from the preset` : undefined}
                  error={errors['grinder.gap_at_ref_um']}
                />
                <TextField
                  path="grinder.gap_per_unit_um"
                  label={labelWithUnit(FIELDS['grinder.gap_per_unit_um'])}
                  value={grinder.gap_per_unit_um}
                  onChange={(gap_per_unit_um) => set({ gap_per_unit_um })}
                  placeholder={dial ? `${dial.gap_per_unit_um} from the preset` : undefined}
                  error={errors['grinder.gap_per_unit_um']}
                />
              </div>
            )}
            <div className="field-grid">
              {(
                ['x50_gap_ratio', 'fines_at_340_pct', 'coarse_log_width', 'boulder_weight'] as const
              ).map((key) => (
                <TextField
                  key={key}
                  path={`grinder.${key}`}
                  label={labelWithUnit(FIELDS[`grinder.${key}`])}
                  term={FIELDS[`grinder.${key}`].term}
                  value={grinder[key]}
                  onChange={(value) => set({ [key]: value })}
                  placeholder={shape(key)}
                  error={errors[`grinder.${key}`]}
                />
              ))}
              <TextField
                path="grinder.burr_diameter_mm"
                label={labelWithUnit(FIELDS['grinder.burr_diameter_mm'])}
                value={grinder.burr_diameter_mm}
                onChange={(burr_diameter_mm) => set({ burr_diameter_mm })}
                placeholder={
                  preset?.burr_diameter_mm !== undefined
                    ? `${preset.burr_diameter_mm} from the preset`
                    : undefined
                }
                error={errors['grinder.burr_diameter_mm']}
                hint="Recorded; no systematic effect in the evidence."
              />
              <TextField
                path="grinder.rpm"
                label={labelWithUnit(FIELDS['grinder.rpm'])}
                value={grinder.rpm}
                onChange={(rpm) => set({ rpm })}
                placeholder={
                  preset?.rpm !== undefined ? `${preset.rpm} from the preset` : undefined
                }
                error={errors['grinder.rpm']}
                hint="Recorded; no systematic effect in the evidence."
              />
            </div>
          </details>
        </>
      )}

      {grinder.mode === 'psd' && <PsdEditor grinder={grinder} set={set} />}
      {errors.grinder && <p className="field-error">{errors.grinder}</p>}
      <BuildNotes notes={notes.grinder} stale={notesStale} />
    </>
  );
}
