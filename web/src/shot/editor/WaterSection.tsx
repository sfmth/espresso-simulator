// SPDX-License-Identifier: GPL-2.0-or-later
/** Brew-water inputs and the conditions used by M2 cup post-processing. */
import { CheckField, SelectField, TextField } from '../fields';
import { BuildNotes } from '../PresetInfo';
import { FIELDS, labelWithUnit } from '../recipeFields';
import { CHEMISTRY_FIELDS, WATER_FIELDS } from '../recipeForm';
import { useShotStore } from '../shotStore';
import { useEditorContext } from './context';

const WATER_DEFAULTS: Record<(typeof WATER_FIELDS)[number], string> = {
  alkalinity_mg_l_caco3: '40',
  hardness_mg_l_caco3: '68',
  calcium_mg_l: '20',
  magnesium_mg_l: '4',
  tds_mg_l: '150',
  ph: '7',
};

export function WaterSection() {
  const { errors, notes, notesStale } = useEditorContext();
  const water = useShotStore((s) => s.form.water);
  const patch = useShotStore((s) => s.patchForm);
  return (
    <>
      <p className="section-intro">
        Enter a water analysis if available. Empty fields use the illustrative defaults shown.
        Alkalinity is buffering capacity; hardness is calcium and magnesium expressed as CaCO₃.
      </p>
      <div className="field-grid">
        {WATER_FIELDS.map((key) => (
          <TextField
            key={key}
            path={`water.${key}`}
            label={labelWithUnit(FIELDS[`water.${key}`])}
            value={water[key]}
            onChange={(value) => patch('water', { [key]: value })}
            placeholder={`${WATER_DEFAULTS[key]} default`}
            error={errors[`water.${key}`]}
          />
        ))}
      </div>
      <BuildNotes notes={notes.water} stale={notesStale} />
    </>
  );
}

export function ChemistrySection() {
  const { errors, notes, notesStale } = useEditorContext();
  const chemistry = useShotStore((s) => s.form.chemistry);
  const patch = useShotStore((s) => s.patchForm);
  const disabled = chemistry.enabled === 'no';
  return (
    <>
      <CheckField
        path="chemistry.enabled"
        label="Calculate cup chemistry"
        checked={!disabled}
        onChange={(enabled) => patch('chemistry', { enabled: enabled ? 'yes' : 'no' })}
        hint="Models acid balance, aroma partitioning, lipid/CO₂ phases and an estimated refractometer reading. Sensory scores are not calculated."
      />
      <div className="field-grid">
        {CHEMISTRY_FIELDS.map((key) => (
          <TextField
            key={key}
            path={`chemistry.${key}`}
            label={labelWithUnit(FIELDS[`chemistry.${key}`])}
            value={chemistry[key]}
            onChange={(value) => patch('chemistry', { [key]: value })}
            error={errors[`chemistry.${key}`]}
          />
        ))}
      </div>
      <SelectField
        path="chemistry.mineral_blank_subtracted"
        label="Refractometer mineral blank"
        value={chemistry.mineral_blank_subtracted}
        onChange={(value) =>
          patch('chemistry', {
            mineral_blank_subtracted: value as typeof chemistry.mineral_blank_subtracted,
          })
        }
        options={[
          { value: '', label: 'Use the model default' },
          { value: 'yes', label: 'Subtract the brew-water mineral blank' },
          { value: 'no', label: 'Include brew-water minerals in the reading' },
        ]}
        hint="This is an instrument estimate. Water minerals and sample temperature can shift the apparent coffee TDS."
      />
      {disabled && (
        <p className="note">Cup chemistry is off; the legacy four tracked species are used.</p>
      )}
      <BuildNotes notes={notes.chemistry} stale={notesStale} />
    </>
  );
}
