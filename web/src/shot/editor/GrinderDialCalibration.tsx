// SPDX-License-Identifier: GPL-2.0-or-later
import { useState } from 'react';
import { parseDecimal } from '../../lab/sphereForm';
import { equipmentKnowledge, useSetupConstraints } from '../../setup/ConstraintContext';
import type { SetupConstraint } from '../../setup/inferenceTypes';
import {
  calibrateDialFromAnchors,
  makeCustomDial,
  type DialDirection,
} from '../grinderCalibration';
import { useShotStore } from '../shotStore';
import { SelectField, TextField } from '../fields';
import { HelpButton } from '../../help/HelpButton';
import type { RecipeForm } from '../recipeForm';
import { useEditorContext } from './context';

export function GrinderDialCalibration() {
  const { catalog } = useEditorContext();
  const form = useShotStore((s) => s.form);
  const setup = useSetupConstraints();
  const [number, setNumber] = useState('');
  const [direction, setDirection] = useState<DialDirection>('coarser');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondSetting, setSecondSetting] = useState('');
  const [secondGap, setSecondGap] = useState('');
  const grinder = form.grinder;
  const custom = grinder.mode === 'family' && grinder.by === 'setting';
  const replaceConstraints = (add: SetupConstraint[]) => {
    const knowledge = equipmentKnowledge(setup);
    const previous = structuredClone([...knowledge.constraints]);
    const replaced = [
      'grinder.preset',
      'grinder.setting',
      'grinder.setting_ref',
      'grinder.gap_um',
      'grinder.gap_at_ref_um',
      'grinder.gap_per_unit_um',
    ];
    knowledge.onChange([
      ...knowledge.constraints.filter((c) => !replaced.includes(c.path)),
      ...add,
    ]);
    return () => knowledge.onChange(previous);
  };
  const applyConversion = (next: RecipeForm, label: string) => {
    try {
      const restoreKnowledge = replaceConstraints([]);
      useShotStore.getState().loadForm(next, label, restoreKnowledge);
      return true;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      return false;
    }
  };
  const configure = () => {
    setError(null);
    const setting = parseDecimal(number);
    if (setting === null) {
      setError('Enter the number shown on your grinder.');
      return;
    }
    const result = makeCustomDial(form, catalog, setting, direction);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!applyConversion(result.value, 'Undo custom grinder numbers')) return;
    setMessage(
      'Your number now represents the current simulated fineness. The conversion is a starting estimate; use recorded shots to refine it.',
    );
  };
  const estimate = () => {
    const setting = parseDecimal(grinder.setting);
    const ref = parseDecimal(grinder.setting_ref);
    const gap = parseDecimal(grinder.gap_at_ref_um);
    const slope = parseDecimal(grinder.gap_per_unit_um);
    if (setting === null || ref === null || gap === null || slope === null || slope === 0) {
      setError('Finish entering your dial calibration first.');
      return;
    }
    const small = Math.max(0.001, Math.abs(slope) * 0.2);
    const large = Math.min(1000, Math.abs(slope) * 5);
    try {
      replaceConstraints([
        { path: 'grinder.setting', mode: 'locked', value: setting },
        { path: 'grinder.setting_ref', mode: 'locked', value: ref },
        {
          path: 'grinder.gap_at_ref_um',
          mode: 'range',
          min: 5,
          max: Math.min(3000, Math.max(10, gap * 2)),
        },
        {
          path: 'grinder.gap_per_unit_um',
          mode: 'range',
          min: slope < 0 ? -large : small,
          max: slope < 0 ? -small : large,
        },
      ]);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      return;
    }
    setError(null);
    setMessage(
      'Dial number and reference are fixed. Reference fineness and sensitivity can now be fitted from your recorded shots. Review their search limits below.',
    );
  };
  return (
    <section className="panel-stack" aria-labelledby="custom-grinder-dial-title">
      <h3 id="custom-grinder-dial-title">Use my grinder numbers</h3>
      <p>
        Enter the number you actually use, such as 12 or 2.5. You do not need to measure a burr gap.
      </p>
      <div className="field-grid">
        <TextField
          path="grinder.my_number"
          label="My current grinder number"
          term="grind"
          value={number}
          placeholder="e.g. 12.5"
          onChange={setNumber}
        />
        <SelectField
          path="grinder.dial_direction"
          label="Larger numbers make my grind"
          term="dial-slope"
          value={direction}
          onChange={(value) => setDirection(value as DialDirection)}
          options={[
            { value: 'coarser', label: 'Coarser' },
            { value: 'finer', label: 'Finer' },
          ]}
        />
      </div>
      <button
        type="button"
        className="button"
        disabled={grinder.mode === 'psd'}
        onClick={configure}
      >
        Use these grinder numbers
      </button>
      {custom && setup && (
        <button type="button" className="button" onClick={estimate}>
          Estimate dial calibration from my shots
        </button>
      )}
      <HelpButton term="grind" label="My grinder numbers">
        <p>
          The conversion starts at the current simulated fineness and assumes a change of 10 µm of
          effective gap per dial unit. This is an editable starting assumption, not a measured
          specification for your grinder. Larger numbers can mean finer or coarser grinding.
        </p>
        <p>
          Record shots at two or more different settings to help estimate the conversion. One shot
          cannot independently determine both reference fineness and sensitivity. Puck preparation
          and other unknown equipment settings can still produce similar results.
        </p>
        <p>
          Use cumulative numbers or clicks if a dial repeats after each turn. This linear conversion
          applies locally to the settings you calibrate; some grinders have different adjustment
          rates elsewhere. Effective model gap is distinct from particle size and from a
          manufacturer’s quoted burr movement.
        </p>
        <p>
          Assigning new numbers replaces the previous dial calibration and its knowledge
          constraints. A measured particle distribution must be changed to a grinder model first.
        </p>
      </HelpButton>
      {custom && (
        <details>
          <summary>Calibrate from two known effective gaps</summary>
          <p>
            The first point is the reference number and gap in the calibration controls below. Enter
            a second point only if you have an independent or fitted effective-gap estimate.
          </p>
          <div className="field-grid">
            <label className="field">
              Second dial number
              <input
                type="text"
                inputMode="decimal"
                value={secondSetting}
                onChange={(e) => setSecondSetting(e.target.value)}
              />
            </label>
            <label className="field">
              Second effective gap (µm)
              <input
                type="text"
                inputMode="decimal"
                value={secondGap}
                onChange={(e) => setSecondGap(e.target.value)}
              />
            </label>
          </div>
          <button
            type="button"
            className="button"
            onClick={() => {
              const result = calibrateDialFromAnchors({
                first: {
                  setting: parseDecimal(grinder.setting_ref) ?? NaN,
                  effectiveGapUm: parseDecimal(grinder.gap_at_ref_um) ?? NaN,
                },
                second: {
                  setting: parseDecimal(secondSetting) ?? NaN,
                  effectiveGapUm: parseDecimal(secondGap) ?? NaN,
                },
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              if (
                !applyConversion(
                  {
                    ...form,
                    grinder: { ...grinder, gap_per_unit_um: String(result.value.gap_per_unit_um) },
                  },
                  'Undo two-point calibration',
                )
              )
                return;
              setError(null);
              setMessage(
                'The two points define your dial sensitivity. The current dial number is unchanged.',
              );
            }}
          >
            Apply two-point calibration
          </button>
        </details>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
