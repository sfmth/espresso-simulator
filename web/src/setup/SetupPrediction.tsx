// SPDX-License-Identifier: GPL-2.0-or-later
import { HelpButton } from '../help/HelpButton';
import { useEffect, useRef, useState } from 'react';
import { useEngine } from '../engine/EngineContext';
import { isAbortError } from '../engine/engine';
import type { BuiltSpec, Catalog, Recipe, Summary } from '../engine/shotTypes';
import { formToRecipe, physicalKey, recipeToForm, withTier } from '../shot/recipeForm';
import { useAppStore } from '../store';
import { useEquipmentStore } from './inferenceStorage';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function equipmentPart(recipe: Recipe) {
  const next = structuredClone(recipe);
  delete next.numerics;
  next.stop = {};
  next.prep.dose_g = 0;
  delete next.grinder.setting;
  delete next.grinder.gap_um;
  delete next.machine.temperature_c;
  return next;
}
function editorRecipe(recipe: Recipe): Recipe {
  const imported = recipeToForm(recipe);
  if (!imported.ok) throw new Error('The saved setup cannot be represented by this editor.');
  const converted = formToRecipe(imported.form);
  if (!converted.ok) throw new Error('The saved setup has invalid recipe settings.');
  return converted.recipe;
}
/** Transfer deliberate recipe changes, keeping each alternative's inferred equipment. */
export function nextShotForAlternative(
  reference: Recipe,
  current: Recipe,
  alternative: Recipe,
): Recipe {
  // Activation passes recipes through this same editor boundary. Compare
  // editor documents rather than incidental omitted/default JSON fields.
  reference = editorRecipe(reference);
  current = editorRecipe(current);
  alternative = editorRecipe(alternative);
  if (stable(equipmentPart(reference)) !== stable(equipmentPart(current)))
    throw new Error(
      'Equipment, coffee or preparation changed. Select or refine a setup before comparing alternatives.',
    );
  const next = structuredClone(alternative);
  next.stop = structuredClone(current.stop);
  if (current.prep.dose_g !== reference.prep.dose_g) next.prep.dose_g = current.prep.dose_g;
  const grindChanged =
    current.grinder.setting !== reference.grinder.setting ||
    current.grinder.gap_um !== reference.grinder.gap_um;
  if (
    grindChanged &&
    current.grinder.gap_um == null &&
    (alternative.grinder.psd ||
      alternative.grinder.gap_um != null ||
      alternative.grinder.preset !== reference.grinder.preset)
  )
    throw new Error(
      'These setups use different grind controls. A dial change cannot be transferred to a measured distribution, explicit gap, or a different named grinder.',
    );
  if (grindChanged && current.grinder.gap_um != null && alternative.grinder.psd)
    throw new Error('A burr-gap change cannot replace a retained measured particle distribution.');
  for (const field of ['setting', 'gap_um'] as const)
    if (current.grinder[field] !== reference.grinder[field]) {
      if (current.grinder[field] === undefined) delete next.grinder[field];
      else next.grinder[field] = current.grinder[field];
    }
  if (current.machine.temperature_c !== reference.machine.temperature_c) {
    if (current.machine.temperature_c === undefined) delete next.machine.temperature_c;
    else next.machine.temperature_c = current.machine.temperature_c;
  }
  return withTier(next, 1);
}

/** A native build must apply the requested grind; clamping is not a comparison. */
export function validateAlternativeGrind(recipe: Recipe, catalog: Catalog, build: BuiltSpec): void {
  const grinder = recipe.grinder;
  if (grinder.psd) return;
  const resolved = build.derived.psd;
  const close = (actual: number | null | undefined, expected: number) =>
    typeof actual === 'number' &&
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected));
  if (grinder.gap_um != null) {
    if (!close(resolved?.gap_um, grinder.gap_um))
      throw new Error(
        'The engine could not apply this burr gap exactly; it would clamp or replace the requested gap. Choose a supported gap before comparing this setup.',
      );
    return;
  }
  const preset = catalog.presets.grinders.find((p) => p.id === grinder.preset);
  const setting = grinder.setting ?? preset?.dial.default;
  if (setting == null || !close(resolved?.setting, setting))
    throw new Error(
      'The engine could not apply this grinder setting exactly; it would clamp or replace the requested dial setting. Choose a supported setting before comparing this setup.',
    );
  const referenceGap = grinder.gap_at_ref_um ?? preset?.dial.gap_at_ref_um;
  const step = grinder.gap_per_unit_um ?? preset?.dial.gap_per_unit_um;
  if (referenceGap == null || step == null)
    throw new Error('This setup has no complete dial calibration for the requested grind.');
  const gap = referenceGap + step * (setting - (grinder.setting_ref ?? preset?.dial.ref ?? 0));
  if (!close(resolved?.gap_um, gap))
    throw new Error(
      'The engine would clamp the gap produced by this dial calibration. Choose a supported setting before comparing this setup.',
    );
}

export function SetupPrediction({
  recipe,
  catalog,
}: {
  recipe: Recipe | null;
  catalog: Catalog | null;
}) {
  const engine = useEngine();
  const doc = useEquipmentStore((s) => s.document);
  const storageNotice = useEquipmentStore((s) => s.notice);
  const hydrate = useEquipmentStore((s) => s.hydrate);
  const selected = doc.alternatives.find((p) => p.id === doc.activeId);
  const alternatives = doc.alternatives.filter((p) => p.coreVersion === catalog?.coreVersion);
  const [results, setResults] = useState<{
    key: string;
    rows: { id: string; name: string; summary?: Summary; error?: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const key = JSON.stringify({
    recipe: recipe ? physicalKey(recipe) : null,
    selected: selected?.id,
    alternatives: alternatives.map((p) => ({
      id: p.id,
      name: p.name,
      recipe: p.recipe,
      coreVersion: p.coreVersion,
    })),
  });
  const latestKey = useRef(key);
  useEffect(hydrate, [hydrate]);
  useEffect(() => {
    latestKey.current = key;
    controller.current?.abort();
  }, [key]);
  useEffect(() => () => controller.current?.abort(), []);
  const run = async () => {
    if (!recipe || !selected || !catalog) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    const finish = () => setBusy(false);
    abort.signal.addEventListener('abort', finish, { once: true });
    try {
      const rows: NonNullable<typeof results>['rows'] = [];
      // Equipment changes invalidate the comparison as a whole. A different
      // alternative's incompatible grind is instead reported on its own row.
      nextShotForAlternative(selected.recipe, recipe, selected.recipe);
      for (const profile of alternatives) {
        abort.signal.throwIfAborted();
        try {
          const next = nextShotForAlternative(selected.recipe, recipe, profile.recipe);
          const { result } = await engine.simulateRecipe(next, { signal: abort.signal });
          abort.signal.throwIfAborted();
          validateAlternativeGrind(next, catalog, result.build);
          if (!['time', 'beverage_mass'].includes(result.result.summary.stop_reason))
            throw new Error(`Shot stopped: ${result.result.summary.stop_reason}.`);
          rows.push({ id: profile.id, name: profile.name, summary: result.result.summary });
        } catch (failure) {
          if (abort.signal.aborted || isAbortError(failure)) throw failure;
          rows.push({
            id: profile.id,
            name: profile.name,
            error: failure instanceof Error ? failure.message : String(failure),
          });
        }
      }
      if (latestKey.current === key && !abort.signal.aborted) setResults({ key, rows });
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      abort.signal.removeEventListener('abort', finish);
      if (controller.current === abort) {
        controller.current = null;
        finish();
      }
    }
  };
  return (
    <section
      className="panel setup-active-banner panel-stack setup-comparison"
      aria-labelledby="active-equipment-title"
    >
      <h3 id="active-equipment-title">Your equipment setup</h3>
      {storageNotice && (
        <p className="run-warning" role="status">
          {storageNotice}
        </p>
      )}
      <p>
        {selected ? (
          <>
            <strong>{selected.name}</strong> ·{' '}
            {selected.source === 'inferred'
              ? `a possible setup matching ${selected.request.observations.length} recorded shots`
              : 'stated settings and assumptions'}
            .
          </>
        ) : (
          'Using the current recipe and its equipment defaults. You can describe or infer your equipment in Set up equipment.'
        )}
      </p>
      {selected?.facts.displayedTemperatureC !== undefined && (
        <p className="note">
          Recorded machine display: {selected.facts.displayedTemperatureC}°C. Simulated brew-water
          temperature is a separate recipe setting.
        </p>
      )}
      {selected && selected.coreVersion !== catalog?.coreVersion && (
        <p className="run-warning">
          This saved setup used another engine version. Recheck it in Set up equipment before
          relying on its fit.
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="button"
          onClick={() => useAppStore.getState().setMode('setup')}
        >
          Review or refine equipment setup
        </button>
        {!!selected && alternatives.length > 1 && (
          <button
            type="button"
            className="button"
            disabled={busy || !recipe || selected.coreVersion !== catalog?.coreVersion}
            onClick={() => void run()}
          >
            Compare next shot across saved setups
          </button>
        )}
        {busy && (
          <button type="button" className="button" onClick={() => controller.current?.abort()}>
            Cancel setup comparison
          </button>
        )}
      </div>
      {busy && <p role="status">Simulating your next recipe with each saved setup…</p>}
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
      {results && (
        <>
          <p className="note">
            {results.key !== key
              ? 'Recipe or alternatives changed. Compare again to update these predictions.'
              : 'Each alternative retains its equipment parameters. Deliberate changes to dose, grind, brew-water temperature and stop rule apply to all alternatives.'}
          </p>
          <div className="setup-table-scroll">
            <table>
              <caption>Predictions from retained equipment alternatives</caption>
              <thead>
                <tr>
                  <th>Setup</th>
                  <th>
                    Time
                    <HelpButton term="shot-time" label="Time" />
                  </th>
                  <th>
                    Final cup
                    <HelpButton term="beverage" label="Final cup" />
                  </th>
                  <th>
                    TDS
                    <HelpButton term="tds" label="TDS" />
                  </th>
                  <th>
                    EY
                    <HelpButton term="ey" label="EY" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.name}</th>
                    {row.summary ? (
                      <>
                        <td>{row.summary.shot_time_s.toFixed(1)} s</td>
                        <td>{(row.summary.beverage_mass_kg * 1000).toFixed(1)} g</td>
                        <td>{(row.summary.tds * 100).toFixed(2)}%</td>
                        <td>{(row.summary.ey * 100).toFixed(1)}%</td>
                      </>
                    ) : (
                      <td colSpan={4}>{row.error}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            Differences show ambiguity between these setups. They are not statistical confidence
            limits or a guarantee of real-world accuracy.
          </p>
        </>
      )}
    </section>
  );
}
