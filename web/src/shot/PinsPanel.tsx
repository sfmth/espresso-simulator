// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Pinned runs: up to six earlier results kept for comparison. Each keeps its
 * colour on every chart; its label can be edited; its recipe can be loaded
 * back into the editor. The table lists the recipe fields that differ between
 * the current inputs and the pinned runs, with their headline results.
 */
import { useMemo } from 'react';
import type { Catalog, Recipe } from '../engine/shotTypes';
import { diffRecipes } from './diff';
import { fieldId } from './fields';
import { focusSoon } from './focus';
import { grams, percent, seconds } from './format';
import { recipeToForm } from './recipeForm';
import { MAX_PINS, useShotStore, type ShotOutcome } from './shotStore';

export function PinsPanel({
  current,
  currentRecipe,
  catalog,
}: {
  current: ShotOutcome | null;
  currentRecipe: Recipe | null;
  catalog: Catalog | null;
}) {
  const pins = useShotStore((s) => s.pins);
  const showPins = useShotStore((s) => s.showPins);
  const setShowPins = useShotStore((s) => s.setShowPins);
  const unpin = useShotStore((s) => s.unpin);
  const renamePin = useShotStore((s) => s.renamePin);
  const loadForm = useShotStore((s) => s.loadForm);
  const currentTier = useShotStore((s) => s.form.numerics.tier);

  const recipes = useMemo(
    () => [...(currentRecipe ? [currentRecipe] : []), ...pins.map((p) => p.outcome.recipe)],
    [currentRecipe, pins],
  );
  const rows = useMemo(() => diffRecipes(recipes, catalog), [recipes, catalog]);
  if (pins.length === 0) {
    return (
      <p className="note">
        Pin a run to keep it on the charts while you change the recipe (up to {MAX_PINS}).
      </p>
    );
  }
  const columns = [
    ...(currentRecipe
      ? [{ key: 'current', label: 'Current inputs', slot: 0, outcome: current }]
      : []),
    ...pins.map((p) => ({ key: `pin-${p.id}`, label: p.label, slot: p.slot, outcome: p.outcome })),
  ];
  return (
    <div className="pins">
      <div className="field field-check">
        <div className="field-head">
          <input
            id="show-pins"
            type="checkbox"
            checked={showPins}
            onChange={(e) => setShowPins(e.target.checked)}
          />
          <label htmlFor="show-pins">Show pinned runs on the charts</label>
        </div>
      </div>
      <ul className="pin-list">
        {pins.map((pin, index) => {
          const s = pin.outcome.result.summary;
          const id = fieldId(`pin-${pin.id}-label`);
          return (
            <li key={pin.id}>
              <span className={`swatch swatch-${pin.slot}`} aria-hidden="true" />
              <label htmlFor={id} className="visually-hidden">
                Label of pinned run {pin.id}
              </label>
              <input
                id={id}
                className="pin-label"
                type="text"
                value={pin.label}
                onChange={(e) => renamePin(pin.id, e.target.value)}
              />
              <span className="note">
                tier {pin.outcome.tier}: {seconds(s.shot_time_s)}, {grams(s.beverage_mass_kg)}, EY{' '}
                {percent(s.ey)}, TDS {percent(s.tds)}
              </span>
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  const result = recipeToForm(pin.outcome.recipe);
                  if (!result.ok) return;
                  // A preview ran at tier 0; keep the tier the user chose for Run.
                  const form = {
                    ...result.form,
                    numerics: { ...result.form.numerics, tier: currentTier },
                  };
                  loadForm(form, 'Undo load');
                }}
                aria-label={`Load the recipe of ${pin.label}`}
              >
                Load recipe
              </button>
              <button
                id={`unpin-${pin.id}`}
                type="button"
                className="button button-quiet button-small"
                onClick={() => {
                  const next = pins[index + 1] ?? pins[index - 1];
                  unpin(pin.id);
                  // Focus the neighbouring pin, or the Pin button when none is left.
                  focusSoon(next ? [`unpin-${next.id}`, 'shot-pin'] : 'shot-pin');
                }}
                aria-label={`Unpin ${pin.label}`}
              >
                Unpin
              </button>
            </li>
          );
        })}
      </ul>
      <div className="table-wrap">
        <table className="diff-table">
          <caption>
            {rows.length === 0
              ? 'The pinned runs have the same recipe as the current inputs.'
              : 'Recipe fields that differ (— means the preset or registry value)'}
          </caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              {columns.map((c) => (
                <th scope="col" key={c.key}>
                  <span className={`swatch swatch-${c.slot}`} aria-hidden="true" /> {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.path}>
                <th scope="row">{row.label}</th>
                {row.values.map((v, i) => (
                  <td key={columns[i]?.key ?? i}>{v}</td>
                ))}
              </tr>
            ))}
            <tr className="diff-results">
              <th scope="row">Shot time · EY · TDS</th>
              {columns.map((c) => (
                <td key={c.key}>
                  {c.outcome
                    ? `${seconds(c.outcome.result.summary.shot_time_s)} · ${percent(c.outcome.result.summary.ey)} · ${percent(c.outcome.result.summary.tds)}`
                    : '—'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
