// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The basket: a preset, the machine's default, or any axisymmetric basket
 * from scratch (straight, tapered or stepped walls; plain holes or a
 * pressurised orifice), drawn live with the bed once a build exists.
 */
import { useMemo } from 'react';
import { BasketDiagram } from '../BasketDiagram';
import { wallFromRecipe, wallFromSpec, type WallPoint } from '../basketGeometry';
import { fieldId, RadioGroup, SelectField, TextField } from '../fields';
import { focusSoon } from '../focus';
import { BuildNotes, PresetInfo } from '../PresetInfo';
import { FIELDS, labelWithUnit } from '../recipeFields';
import { profileRow, shiftedText, type BasketMode, type RecipeForm } from '../recipeForm';
import { parseDecimal } from '../../lab/sphereForm';
import { useShotStore } from '../shotStore';
import { findPreset, presetOptions, useEditorContext } from './context';

type Basket = RecipeForm['basket'];

/** The custom profile as wall points, or null while any cell is not a number. */
function customWall(basket: Basket): WallPoint[] | null {
  const rows = basket.profile.map((row) => [parseDecimal(row.height), parseDecimal(row.diameter)]);
  if (rows.length < 2 || rows.some(([h, d]) => h === null || d === null)) return null;
  const wall = wallFromRecipe(rows as [number, number][]);
  for (let i = 1; i < wall.length; i++) if (!(wall[i].z > wall[i - 1].z)) return null;
  return wall.every((p) => p.r > 0) ? wall : null;
}

function ProfileEditor({ basket, set }: { basket: Basket; set: (p: Partial<Basket>) => void }) {
  const { errors } = useEditorContext();
  const rows = basket.profile;
  const update = (index: number, patch: Partial<{ height: string; diameter: string }>) =>
    set({ profile: rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const add = () => {
    const last = rows.at(-1);
    const h = last ? (parseDecimal(last.height) ?? 0) : 0;
    set({
      profile: [...rows, profileRow(shiftedText(h + 5), last?.diameter ?? '58')],
    });
  };
  const remove = (index: number) => {
    if (rows.length <= 2) return;
    const neighbour = rows[index + 1] ?? rows[index - 1];
    set({ profile: rows.filter((_, i) => i !== index) });
    // Keep the keyboard focus in the table: the next row's Remove, or Add.
    focusSoon(neighbour ? [`row-${neighbour.key}-remove`, 'profile-add'] : 'profile-add');
  };
  const tableError = errors['basket.custom.profile_mm'] ?? errors['basket.custom'];
  return (
    <div className="profile-editor">
      <p className="section-intro" id="profile-caption">
        Inner wall profile, from the floor (height 0) up to the rim. The wall is straight between
        points.
      </p>
      <div className="table-wrap">
        <table className="edit-table" aria-labelledby="profile-caption">
          <thead>
            <tr>
              <th scope="col">Point</th>
              <th scope="col">Height (mm)</th>
              <th scope="col">Inner diameter (mm)</th>
              <th scope="col">
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const hPath = `basket.custom.profile_mm.${i}.0`;
              const dPath = `basket.custom.profile_mm.${i}.1`;
              const hError = errors[hPath];
              const dError = errors[dPath];
              return (
                <tr key={row.key}>
                  <th scope="row">{i === 0 ? 'Floor' : i === rows.length - 1 ? 'Rim' : i + 1}</th>
                  <td>
                    <input
                      id={fieldId(hPath)}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`Height of point ${i + 1} (mm)`}
                      value={row.height}
                      aria-invalid={hError ? true : undefined}
                      aria-describedby={hError ? `${fieldId(hPath)}-error` : undefined}
                      onChange={(e) => update(i, { height: e.target.value })}
                    />
                    {hError && (
                      <p className="field-error" id={`${fieldId(hPath)}-error`}>
                        {hError}
                      </p>
                    )}
                  </td>
                  <td>
                    <input
                      id={fieldId(dPath)}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`Inner diameter at point ${i + 1} (mm)`}
                      value={row.diameter}
                      aria-invalid={dError ? true : undefined}
                      aria-describedby={dError ? `${fieldId(dPath)}-error` : undefined}
                      onChange={(e) => update(i, { diameter: e.target.value })}
                    />
                    {dError && (
                      <p className="field-error" id={`${fieldId(dPath)}-error`}>
                        {dError}
                      </p>
                    )}
                  </td>
                  <td>
                    <button
                      id={`row-${row.key}-remove`}
                      type="button"
                      className="button button-quiet button-small"
                      aria-label={`Remove point ${i + 1}`}
                      aria-disabled={rows.length <= 2 ? true : undefined}
                      onClick={() => remove(i)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tableError && <p className="field-error">{tableError}</p>}
      <button id="profile-add" type="button" className="button button-small" onClick={add}>
        Add a point
      </button>
    </div>
  );
}

export function BasketSection() {
  const { catalog, errors, notes, notesStale, build, buildStale } = useEditorContext();
  const basket = useShotStore((s) => s.form.basket);
  const machinePresetId = useShotStore((s) => s.form.machine.preset);
  const patch = useShotStore((s) => s.patchForm);
  const set = (p: Partial<Basket>) => patch('basket', p);
  const preset = findPreset(catalog.presets.baskets, basket.preset);
  const machine = findPreset(catalog.presets.machines, machinePresetId);
  const machineDefault = findPreset(catalog.presets.baskets, machine?.default_basket ?? '');

  const copyPreset = () => {
    const source = preset ?? machineDefault;
    if (!source) return;
    set({
      mode: 'custom',
      profile: source.profile_mm.map(([h, d]) => profileRow(String(h), String(d))),
      perforated_diameter_mm: String(source.perforated_diameter_mm),
      open_area_fraction:
        typeof source.open_area_fraction === 'number'
          ? shiftedText(source.open_area_fraction, 2)
          : '',
      outlet: source.pressurised_orifice_mm ? 'pressurised' : 'holes',
      pressurised_orifice_mm: source.pressurised_orifice_mm
        ? String(source.pressurised_orifice_mm)
        : basket.pressurised_orifice_mm,
      discharge_coefficient:
        typeof source.discharge_coefficient === 'number'
          ? String(source.discharge_coefficient)
          : '',
    });
  };

  // What to draw: the custom profile, or the chosen (or default) preset's.
  const drawing = useMemo(() => {
    if (basket.mode === 'custom') {
      const wall = customWall(basket);
      const perforated = parseDecimal(basket.perforated_diameter_mm) ?? 0;
      const orifice =
        basket.outlet === 'pressurised' ? parseDecimal(basket.pressurised_orifice_mm) : null;
      return wall ? { wall, perforated: perforated / 2, orifice } : null;
    }
    const source = basket.mode === 'preset' ? preset : machineDefault;
    if (!source) return null;
    return {
      wall: wallFromRecipe(source.profile_mm),
      perforated: source.perforated_diameter_mm / 2,
      orifice: source.pressurised_orifice_mm ?? null,
    };
  }, [basket, preset, machineDefault]);

  // The bed height of the last build, if that build's basket is the one drawn.
  const builtWall = build ? wallFromSpec(build.spec.basket.profile_m) : null;
  const sameBasket =
    drawing !== null &&
    builtWall !== null &&
    builtWall.length === drawing.wall.length &&
    builtWall.every(
      (p, i) =>
        Math.abs(p.z - drawing.wall[i].z) < 1e-6 && Math.abs(p.r - drawing.wall[i].r) < 1e-6,
    );
  const bedHeight = sameBasket ? (build?.derived.bed?.height_mm ?? null) : null;

  return (
    <>
      <RadioGroup<BasketMode>
        name="basket.mode"
        legend="Basket"
        value={basket.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { value: 'preset', label: 'Preset' },
          { value: 'custom', label: 'Custom shape' },
          { value: 'machine', label: "Machine's default" },
        ]}
      />
      {basket.mode === 'preset' && (
        <>
          <SelectField
            path="basket.preset"
            label="Basket preset"
            value={basket.preset}
            onChange={(id) => set({ preset: id })}
            options={[{ value: '', label: 'Choose…' }, ...presetOptions(catalog.presets.baskets)]}
            error={errors['basket.preset']}
            hint={
              preset
                ? `Nominal dose ${preset.nominal_dose_g} g (${preset.dose_range_g[0]}–${preset.dose_range_g[1]} g).`
                : undefined
            }
          />
          <PresetInfo preset={preset} />
        </>
      )}
      {basket.mode === 'machine' && (
        <p className={machineDefault ? 'section-intro' : 'field-error'}>
          {machineDefault
            ? `The ${machine?.name} preset uses the ${machineDefault.name}.`
            : 'The machine preset has no default basket: choose a preset or describe one.'}
        </p>
      )}
      {basket.mode !== 'custom' && (preset ?? machineDefault) && (
        <button type="button" className="button button-small" onClick={copyPreset}>
          Edit a copy as a custom basket
        </button>
      )}
      {basket.mode === 'custom' && (
        <>
          <ProfileEditor basket={basket} set={set} />
          <div className="field-grid">
            <TextField
              path="basket.custom.perforated_diameter_mm"
              label={labelWithUnit(FIELDS['basket.custom.perforated_diameter_mm'])}
              term="perforated"
              value={basket.perforated_diameter_mm}
              onChange={(perforated_diameter_mm) => set({ perforated_diameter_mm })}
              error={errors['basket.custom.perforated_diameter_mm']}
            />
            <TextField
              path="basket.custom.open_area_fraction"
              label={labelWithUnit(FIELDS['basket.custom.open_area_fraction'])}
              term="open-area"
              value={basket.open_area_fraction}
              onChange={(open_area_fraction) => set({ open_area_fraction })}
              placeholder="registry default"
              error={errors['basket.custom.open_area_fraction']}
            />
          </div>
          <RadioGroup<'holes' | 'pressurised'>
            name="basket.custom.outlet"
            legend="Outlet"
            value={basket.outlet}
            onChange={(outlet) => set({ outlet })}
            options={[
              { value: 'holes', label: 'Plain holes' },
              { value: 'pressurised', label: 'Pressurised (dual wall)' },
            ]}
            term="pressurised"
          />
          {basket.outlet === 'pressurised' && (
            <div className="field-grid">
              <TextField
                path="basket.custom.pressurised_orifice_mm"
                label={labelWithUnit(FIELDS['basket.custom.pressurised_orifice_mm'])}
                value={basket.pressurised_orifice_mm}
                onChange={(pressurised_orifice_mm) => set({ pressurised_orifice_mm })}
                error={errors['basket.custom.pressurised_orifice_mm']}
              />
              <TextField
                path="basket.custom.discharge_coefficient"
                label={FIELDS['basket.custom.discharge_coefficient'].label}
                term="discharge"
                value={basket.discharge_coefficient}
                onChange={(discharge_coefficient) => set({ discharge_coefficient })}
                placeholder="registry default"
                error={errors['basket.custom.discharge_coefficient']}
              />
            </div>
          )}
        </>
      )}
      {errors.basket && <p className="field-error">{errors.basket}</p>}
      {drawing && (
        <BasketDiagram
          wall={drawing.wall}
          perforatedRadiusMm={drawing.perforated}
          orificeMm={drawing.orifice}
          bedHeightMm={bedHeight}
          label="Basket cross-section"
          bedNote={
            bedHeight !== null && buildStale ? 'The bed height is from the last build.' : undefined
          }
        />
      )}
      <BuildNotes notes={notes.basket} stale={notesStale} />
    </>
  );
}
