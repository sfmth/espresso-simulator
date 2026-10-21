// SPDX-License-Identifier: GPL-2.0-or-later
import { useState } from 'react';
import type { Recipe } from '../engine/shotTypes';
import type { SetupObservation, SetupParameter } from './inferenceTypes';

function measured(text: string, label: string, min: number, max: number): number {
  const number = Number(text.trim().replace(',', '.'));
  if (!text.trim() || !Number.isFinite(number) || number < min || number > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return number;
}
export function ObservationEditor({
  recipe,
  parameters,
  initial,
  onSave,
  onCancel,
}: {
  recipe: Recipe;
  parameters: SetupParameter[];
  initial?: SetupObservation;
  onSave: (shot: SetupObservation) => void;
  onCancel?: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? 'Observed shot');
  const [time, setTime] = useState(String(initial?.timeS ?? ''));
  const [mass, setMass] = useState(String(initial?.yieldG ?? ''));
  const [tds, setTds] = useState(String(initial?.tdsPercent ?? ''));
  const [timeBasis, setTimeBasis] = useState<SetupObservation['timeBasis']>(
    initial?.timeBasis ?? 'pump',
  );
  const [massBasis, setMassBasis] = useState<SetupObservation['massBasis']>(
    initial?.massBasis ?? 'final',
  );
  const [timeTolerance, setTimeTolerance] = useState(String(initial?.timeToleranceS ?? 1));
  const [massTolerance, setMassTolerance] = useState(String(initial?.yieldToleranceG ?? 0.5));
  const [tdsTolerance, setTdsTolerance] = useState(String(initial?.tdsTolerancePercent ?? 0.2));
  const [changes, setChanges] = useState<string[]>(initial?.changes ?? []);
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const choices = parameters.filter(
    (p) =>
      p.modeled &&
      p.value !== undefined &&
      (!query
        ? !p.path.startsWith('overrides.')
        : `${p.label} ${p.path}`.toLowerCase().includes(query.toLowerCase())),
  );
  return (
    <form
      className="setup-observation-editor"
      aria-label={initial ? `Edit ${initial.label}` : 'Record an observed shot'}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          if (!label.trim()) throw new Error('Give this shot a name.');
          onSave({
            id: initial?.id ?? crypto.randomUUID(),
            label: label.trim(),
            timeS: measured(time, 'Observed time', 0.1, 600),
            yieldG: measured(mass, 'Observed cup weight', 0.1, 500),
            ...(tds.trim() ? { tdsPercent: measured(tds, 'Measured TDS', 0.01, 30) } : {}),
            timeBasis,
            massBasis,
            timeToleranceS: measured(timeTolerance, 'Time tolerance', 0, 60),
            yieldToleranceG: measured(massTolerance, 'Weight tolerance', 0.001, 50),
            tdsTolerancePercent: measured(tdsTolerance, 'TDS tolerance', 0.001, 5),
            recipe: structuredClone(initial?.recipe ?? recipe),
            changes,
          });
          if (!initial) {
            setTime('');
            setMass('');
            setTds('');
          }
          setProblem(null);
        } catch (error) {
          setProblem(error instanceof Error ? error.message : String(error));
        }
      }}
    >
      <div className="setup-fields">
        <label className="field">
          Observed shot name
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        </label>
        <label className="field">
          Observed time (s)
          <input
            value={time}
            onChange={(e) => setTime(e.target.value)}
            inputMode="decimal"
            required
          />
        </label>
        <label className="field">
          Observed cup weight (g)
          <input
            value={mass}
            onChange={(e) => setMass(e.target.value)}
            inputMode="decimal"
            required
          />
        </label>
        <label className="field">
          Measured TDS (%) · optional
          <input value={tds} onChange={(e) => setTds(e.target.value)} inputMode="decimal" />
        </label>
        <label className="field">
          Timer started at
          <select
            value={timeBasis}
            onChange={(e) => setTimeBasis(e.target.value as SetupObservation['timeBasis'])}
          >
            <option value="pump">Pump on</option>
            <option value="first-drip">First drip into the cup</option>
          </select>
        </label>
        <label className="field">
          Cup was weighed
          <select
            value={massBasis}
            onChange={(e) => setMassBasis(e.target.value as SetupObservation['massBasis'])}
          >
            <option value="final">After dripping finished</option>
            <option value="pump-stop">At pump stop</option>
          </select>
        </label>
      </div>
      <p className="note">
        The timer ends when the pump stops. Record what happened; a prediction is not required.
      </p>
      <details>
        <summary>Measurement tolerances</summary>
        <div className="setup-fields">
          <label className="field">
            Time tolerance (± s)
            <input
              value={timeTolerance}
              onChange={(e) => setTimeTolerance(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <label className="field">
            Weight tolerance (± g)
            <input
              value={massTolerance}
              onChange={(e) => setMassTolerance(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <label className="field">
            TDS tolerance (± percentage points)
            <input
              value={tdsTolerance}
              onChange={(e) => setTdsTolerance(e.target.value)}
              inputMode="decimal"
            />
          </label>
        </div>
      </details>
      <details>
        <summary>Known settings specific to this shot ({changes.length})</summary>
        <p className="note">
          Select settings you know for this shot, such as its dose or grinder dial. These use the
          values in the equipment editor when you record the shot. They override shared values for
          this shot only. All other values come from the setup being inferred.
        </p>
        <label className="field">
          Find a shot-specific setting
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="setup-shot-settings">
          {choices.map((p) => (
            <label className="checkbox-field" key={p.path}>
              <input
                type="checkbox"
                checked={changes.includes(p.path)}
                onChange={(e) =>
                  setChanges((old) =>
                    e.target.checked ? [...old, p.path] : old.filter((path) => path !== p.path),
                  )
                }
              />
              {p.label}: {String(p.value)} {p.unit}
            </label>
          ))}
        </div>
        {changes
          .filter((path) => !choices.some((p) => p.path === path))
          .map((path) => (
            <p key={path}>
              {path} is selected.{' '}
              <button
                type="button"
                className="button button-small"
                onClick={() => setChanges((old) => old.filter((p) => p !== path))}
              >
                Remove shot-specific {path}
              </button>
            </p>
          ))}
      </details>
      {problem && (
        <p className="run-error" role="alert">
          {problem}
        </p>
      )}
      <div className="button-row">
        <button className="button button-primary" type="submit">
          {initial ? 'Save observed shot changes' : 'Add observed shot'}
        </button>
        {onCancel && (
          <button className="button" type="button" onClick={onCancel}>
            Cancel shot edit
          </button>
        )}
      </div>
    </form>
  );
}
