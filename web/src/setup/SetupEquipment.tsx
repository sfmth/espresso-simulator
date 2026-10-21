// SPDX-License-Identifier: GPL-2.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react';
import { tabId } from '../components/ModeTabs';
import { useEngine } from '../engine/EngineContext';
import { isAbortError } from '../engine/engine';
import { datedName, downloadJson } from '../shot/download';
import type { EditorContextValue } from '../shot/editor/context';
import { routeNotes } from '../shot/notes';
import { RecipeEditor } from '../shot/RecipeEditor';
import { formToRecipe, physicalKey, recipeToForm } from '../shot/recipeForm';
import { useOptionalSharedShotRun } from '../shot/ShotRunContext';
import { useShotStore } from '../shot/shotStore';
import { useAppStore } from '../store';
import { ConstraintContextProvider } from './ConstraintContext';
import { ConstraintEditor } from './ConstraintEditor';
import { applySetupLocks, inferSetups } from './inference';
import type { InferenceRequest, InferenceResult, SetupCandidate } from './inferenceTypes';
import {
  MAX_SETUP_ALTERNATIVES,
  MAX_SETUP_OBSERVATIONS,
  useEquipmentStore,
  type SavedSetup,
  type SetupDocument,
} from './inferenceStorage';
import { ObservationEditor } from './ObservationEditor';
import { inferenceParameters } from './parameterCatalog';
import { SetupCandidates } from './SetupCandidates';
import { createSetupStorage, SETUP_SCHEMA } from './setupStorage';
import './SetupEquipment.css';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function SetupEquipment({ active = true }: { active?: boolean }) {
  const engine = useEngine();
  const shared = useOptionalSharedShotRun();
  const form = useShotStore((s) => s.form);
  const catalog = useShotStore((s) => s.catalog);
  const catalogError = useShotStore((s) => s.catalogError);
  const check = useShotStore((s) => s.check);
  const doc = useEquipmentStore((s) => s.document);
  const hydrated = useEquipmentStore((s) => s.hydrated);
  const notice = useEquipmentStore((s) => s.notice);
  const hydrate = useEquipmentStore((s) => s.hydrate);
  const validation = useMemo(() => formToRecipe(form, { catalog }), [form, catalog]);
  const recipe = validation.ok ? validation.recipe : null;
  const parameters = useMemo(
    () => (recipe && catalog ? inferenceParameters(recipe, catalog) : []),
    [recipe, catalog],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [budget, setBudget] = useState(480);
  const [result, setResult] = useState<{
    key: string;
    request: InferenceRequest;
    result: InferenceResult;
  } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(0);
  const currentKey = useRef('');
  const key = JSON.stringify({
    recipe,
    constraints: doc.constraints,
    observations: doc.observations,
    core: catalog?.coreVersion,
  });
  useEffect(hydrate, [hydrate]);
  useEffect(() => {
    currentKey.current = key;
    controller.current?.abort();
  }, [key]);
  useEffect(() => () => controller.current?.abort(), []);
  const context: EditorContextValue | null = useMemo(
    () =>
      catalog
        ? {
            catalog,
            errors: validation.ok ? {} : validation.errors,
            notes: routeNotes(check?.build?.derived.notes ?? [], catalog),
            notesStale: !recipe || check?.key !== physicalKey(recipe),
            build: check?.build ?? null,
            buildStale: !recipe || check?.key !== physicalKey(recipe),
          }
        : null,
    [catalog, validation, check, recipe],
  );
  const update = (edit: (document: SetupDocument) => SetupDocument) => {
    try {
      useEquipmentStore.getState().update(edit);
      setProblem(null);
    } catch (error) {
      setProblem(message(error));
    }
  };
  const stale = !!result && result.key !== key;
  const search = async () => {
    if (!recipe || !catalog || running || !doc.observations.length) return;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    const id = ++operation.current;
    const snapshot: InferenceRequest = structuredClone({
      recipe,
      constraints: doc.constraints,
      observations: doc.observations,
      maxEvaluations: budget,
      seed: 20261021,
    });
    setRunning(true);
    setProblem(null);
    setStatus('Searching the allowed equipment settings…');
    const end = () => {
      if (operation.current === id) setRunning(false);
    };
    abort.signal.addEventListener('abort', end, { once: true });
    shared?.cancel();
    try {
      const output = await inferSetups(engine, catalog, snapshot, {
        signal: abort.signal,
        onProgress: (progress) => {
          if (!abort.signal.aborted)
            setStatus(
              `${progress.stage === 'verify' ? 'Verifying possible setups' : 'Searching possible setups'}: ${progress.completed} / ${progress.total} simulations.`,
            );
        },
      });
      abort.signal.throwIfAborted();
      if (currentKey.current !== key || operation.current !== id) return;
      setResult({ key, request: snapshot, result: output });
      setStatus(
        output.candidates.length
          ? `Found ${output.candidates.length} distinct possible setups within the measurement tolerances.`
          : 'No matching setup found within this search. Review the ranges and measurements, or run a deeper search.',
      );
    } catch (error) {
      if (!isAbortError(error) && !abort.signal.aborted) setProblem(message(error));
    } finally {
      abort.signal.removeEventListener('abort', end);
      end();
      if (controller.current === abort) controller.current = null;
    }
  };
  const keep = (candidate: SetupCandidate, index: number) => {
    if (!result || stale || !catalog) return;
    if (doc.alternatives.length >= MAX_SETUP_ALTERNATIVES) {
      setProblem(
        `Keep up to ${MAX_SETUP_ALTERNATIVES} alternatives. Export or remove one before keeping another.`,
      );
      return;
    }
    const profile: SavedSetup = {
      id: crypto.randomUUID(),
      name: `${doc.name.trim() || 'My equipment'} · option ${index + 1}`,
      createdAt: new Date().toISOString(),
      coreVersion: result.result.coreVersion,
      source: 'inferred',
      recipe: candidate.recipe,
      facts: structuredClone(doc.facts),
      request: result.request,
      candidate,
    };
    update((d) => ({ ...d, alternatives: [...d.alternatives, profile] }));
  };
  const activate = async (profile?: SavedSetup) => {
    if (!(profile?.recipe ?? recipe) || !catalog || running) return;
    if (profile && profile.coreVersion !== catalog.coreVersion) {
      setProblem(
        'This saved setup belongs to another engine version. Recheck it against the recorded shots before using it.',
      );
      return;
    }
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setRunning(true);
    const finish = () => setRunning(false);
    abort.signal.addEventListener('abort', finish, { once: true });
    try {
      setProblem(null);
      const chosen = profile?.recipe ?? applySetupLocks(recipe!, doc.constraints, catalog);
      await engine.buildShotSpec(chosen, { signal: abort.signal });
      abort.signal.throwIfAborted();
      if (currentKey.current !== key) return;
      if (
        profile &&
        JSON.stringify(
          useEquipmentStore.getState().document.alternatives.find((p) => p.id === profile.id),
        ) !== JSON.stringify(profile)
      )
        throw new Error('The saved setup changed while it was being checked. Select it again.');
      const imported = recipeToForm(chosen);
      if (!imported.ok) throw new Error(imported.error);
      let selected = profile;
      if (!selected) {
        if (doc.alternatives.length >= MAX_SETUP_ALTERNATIVES)
          throw new Error('Remove an alternative before saving another setup.');
        selected = {
          id: crypto.randomUUID(),
          name: doc.name.trim() || 'My equipment',
          createdAt: new Date().toISOString(),
          coreVersion: catalog.coreVersion,
          source: 'specified',
          recipe: chosen,
          facts: structuredClone(doc.facts),
          request: { recipe: chosen, constraints: doc.constraints, observations: [] },
        };
      }
      const selectedProfile = selected;
      useEquipmentStore.getState().update((d) => ({
        ...d,
        alternatives: profile ? d.alternatives : [...d.alternatives, selectedProfile],
        activeId: selectedProfile.id,
      }));
      useShotStore.getState().loadForm(imported.form, 'Undo equipment setup selection');
      const saved = createSetupStorage().complete({ schema: SETUP_SCHEMA, recipe: chosen });
      setStatus(saved.notice ?? `Using ${selectedProfile.name}.`);
      useAppStore.getState().setMode('dial-in');
      document.getElementById(tabId('dial-in'))?.focus();
    } catch (error) {
      if (!abort.signal.aborted) setProblem(message(error));
    } finally {
      abort.signal.removeEventListener('abort', finish);
      if (controller.current === abort) {
        controller.current = null;
        finish();
      }
    }
  };
  const selectedShot = doc.observations.find((shot) => shot.id === editing);
  if (!active) return null;
  return (
    <section className="setup-equipment panel-stack" aria-labelledby="setup-equipment-title">
      <div className="panel-header">
        <div>
          <p className="setup-eyebrow">Your equipment, understood through your shots</p>
          <h2 id="setup-equipment-title">Set up equipment</h2>
          <p>Describe what you know, record a shot, and find the settings that could explain it.</p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={!hydrated}
            onClick={() => downloadJson(datedName('equipment-setup', 'json'), doc)}
          >
            Export equipment setup
          </button>
          <label className="button setup-file">
            Import equipment setup
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Import equipment setup"
              disabled={running}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (file.size > 5_000_000) {
                  setProblem('Setup backup exceeds 5 MB.');
                  return;
                }
                void file
                  .text()
                  .then((text) => {
                    useEquipmentStore.getState().importDocument(text);
                    setStatus(
                      'Equipment setup imported. Choose an alternative to load its recipe.',
                    );
                  })
                  .catch((error) => setProblem(message(error)));
              }}
            />
          </label>
        </div>
      </div>
      <ol className="setup-steps" aria-label="Equipment setup steps">
        <li>
          <a href="#setup-known">1. Your equipment</a>
        </li>
        <li>
          <a href="#setup-observed">2. Recorded shots</a>
        </li>
        <li>
          <a href="#setup-find">3. Possible setups</a>
        </li>
      </ol>
      {notice && (
        <p className="run-warning" role="status">
          {notice}
        </p>
      )}
      {problem && (
        <p className="run-error" role="alert">
          {problem}
        </p>
      )}
      {!catalog || !context ? (
        <div className="panel">
          <p role="status">{catalogError ?? 'Loading equipment and settings…'}</p>
          {catalogError && (
            <button type="button" className="button" onClick={shared?.retryCatalog}>
              Retry equipment catalogue
            </button>
          )}
        </div>
      ) : (
        <>
          <section
            className="panel panel-stack"
            id="setup-known"
            aria-labelledby="setup-known-title"
          >
            <div className="panel-header">
              <h3 id="setup-known-title">1. Your equipment and known settings</h3>
            </div>
            <fieldset disabled={running} className="setup-unframed">
              <legend className="visually-hidden">Equipment facts and settings</legend>
              <div className="setup-fields">
                <label className="field">
                  Equipment setup name
                  <input
                    value={doc.name}
                    maxLength={120}
                    onChange={(e) => update((d) => ({ ...d, name: e.target.value }))}
                  />
                </label>
                <label className="field">
                  Known heating system
                  <select
                    value={doc.facts.heater}
                    onChange={(e) =>
                      update((d) => ({
                        ...d,
                        facts: {
                          ...d.facts,
                          heater: e.target.value as SetupDocument['facts']['heater'],
                        },
                      }))
                    }
                  >
                    <option value="unknown">Unknown</option>
                    <option value="boiler">Boiler</option>
                    <option value="thermoblock">Thermoblock</option>
                  </select>
                </label>
                <label className="field">
                  Machine display / set temperature (°C)
                  <input
                    type="number"
                    min="0"
                    max="150"
                    step="any"
                    value={doc.facts.displayedTemperatureC ?? ''}
                    onChange={(e) => {
                      const value = e.target.value === '' ? undefined : e.target.valueAsNumber;
                      if (
                        value !== undefined &&
                        (!Number.isFinite(value) || value < 0 || value > 150)
                      )
                        return;
                      update((d) => ({
                        ...d,
                        facts: { ...d.facts, displayedTemperatureC: value },
                      }));
                    }}
                  />
                </label>
              </div>
              <p className="note">
                Heater type and the machine display are recorded facts. Brew-water temperature below
                is separate. Boiler recovery and PID behavior are not modeled yet.
              </p>
              <ConstraintContextProvider
                parameters={parameters}
                constraints={doc.constraints}
                onChange={(constraints) => update((d) => ({ ...d, constraints }))}
              >
                <RecipeEditor
                  context={context}
                  onSubmit={() => {
                    setStatus(
                      'Equipment settings updated. Add an observed shot below, or continue with these settings.',
                    );
                  }}
                  formLabel="Equipment settings"
                  submitLabel="Keep equipment settings"
                />
                <ConstraintEditor
                  parameters={parameters}
                  constraints={doc.constraints}
                  onChange={(constraints) => update((d) => ({ ...d, constraints }))}
                  onReveal={(path) => useShotStore.getState().revealField(path)}
                />
              </ConstraintContextProvider>
            </fieldset>
            <div className="button-row">
              <button
                type="button"
                className="button"
                disabled={!recipe || running}
                onClick={() => void activate()}
              >
                Use these settings in Dial in
              </button>
              <span className="note">
                You can continue with stated settings and defaults before recording a shot.
              </span>
            </div>
          </section>
          <section
            className="panel panel-stack"
            id="setup-observed"
            aria-labelledby="setup-observed-title"
          >
            <h3 id="setup-observed-title">2. What happened in your shot?</h3>
            <p>
              Start with one shot. Add more to narrow the possible equipment settings. Every
              matching setup must explain all recorded shots.
            </p>
            <fieldset className="setup-unframed" disabled={running}>
              <legend className="visually-hidden">Recorded shots</legend>
              {doc.observations.map((shot) => (
                <article className="setup-observed-shot" key={shot.id}>
                  <div>
                    <h4>{shot.label}</h4>
                    <p>
                      {shot.yieldG} g in {shot.timeS} s ·{' '}
                      {shot.timeBasis === 'pump' ? 'from pump on' : 'from first drip'} ·{' '}
                      {shot.massBasis === 'final' ? 'final cup' : 'at pump stop'}
                      {shot.tdsPercent === undefined ? '' : ` · ${shot.tdsPercent}% TDS`}
                    </p>
                    <small>{shot.changes?.length ?? 0} shot-specific known settings</small>
                  </div>
                  <div className="button-row">
                    <button type="button" className="button" onClick={() => setEditing(shot.id)}>
                      Edit {shot.label}
                    </button>
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => {
                        update((d) => ({
                          ...d,
                          observations: d.observations.filter((o) => o.id !== shot.id),
                        }));
                        if (editing === shot.id) setEditing(null);
                      }}
                    >
                      Remove {shot.label}
                    </button>
                  </div>
                </article>
              ))}
              {recipe && (selectedShot || doc.observations.length < MAX_SETUP_OBSERVATIONS) ? (
                <ObservationEditor
                  key={selectedShot?.id ?? 'new'}
                  recipe={recipe}
                  parameters={
                    selectedShot ? inferenceParameters(selectedShot.recipe, catalog) : parameters
                  }
                  initial={selectedShot}
                  onCancel={selectedShot ? () => setEditing(null) : undefined}
                  onSave={(shot) => {
                    useEquipmentStore.getState().update((d) => ({
                      ...d,
                      observations: selectedShot
                        ? d.observations.map((old) => (old.id === shot.id ? shot : old))
                        : [...d.observations, shot],
                    }));
                    setEditing(null);
                    setStatus('Observed shot recorded. Find setups that match it below.');
                  }}
                />
              ) : (
                <p className="note">
                  {!recipe
                    ? 'Correct the equipment settings to record a shot.'
                    : `This session has ${MAX_SETUP_OBSERVATIONS} recorded shots.`}
                </p>
              )}
            </fieldset>
          </section>
          <section className="panel panel-stack" id="setup-find" aria-labelledby="setup-find-title">
            <h3 id="setup-find-title">3. Find possible setups</h3>
            <p>
              Locked facts stay fixed. Only settings marked with a range or unknown are searched;
              unmarked values remain visible assumptions.
            </p>
            <div className="button-row">
              <label className="field">
                Search depth
                <select
                  value={budget}
                  disabled={running}
                  onChange={(e) => setBudget(Number(e.target.value))}
                >
                  <option value={480}>Standard · up to 480 simulations</option>
                  <option value={1440}>Deeper · up to 1,440 simulations</option>
                </select>
              </label>
              <button
                className="button button-primary"
                type="button"
                disabled={running || !recipe || !doc.observations.length}
                onClick={() => void search()}
              >
                Find setups that match my shots
              </button>
              {running && (
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    controller.current?.abort();
                    setStatus('Search cancelled. Your recorded shots and saved setups are kept.');
                  }}
                >
                  Cancel setup search
                </button>
              )}
            </div>
            <p role="status" aria-live="polite">
              {status}
            </p>
            {result && (
              <>
                {stale && (
                  <p className="run-warning">
                    Settings or observations changed. Search again before keeping these results.
                  </p>
                )}
                <p>
                  {result.result.candidates.length} matching alternatives ·{' '}
                  {result.result.evaluations} simulations · {result.result.skipped} rejected
                  evaluations
                </p>
                <p className="note">
                  These are possible explanations, not proof of the physical setup. Timing is a
                  measured replay condition. A finite search cannot enumerate every continuous
                  combination.
                </p>
                <SetupCandidates
                  candidates={result.result.candidates}
                  parameters={parameters}
                  stale={stale}
                  savedIds={doc.alternatives
                    .filter((a) => JSON.stringify(a.request) === JSON.stringify(result.request))
                    .flatMap((a) => (a.candidate ? [a.candidate.id] : []))}
                  onSave={keep}
                />
                {!!result.result.nearMisses.length && (
                  <details>
                    <summary>Closest results that missed the tolerances</summary>
                    <SetupCandidates
                      candidates={result.result.nearMisses}
                      parameters={parameters}
                      stale={stale}
                      savedIds={[]}
                      onSave={keep}
                      matched={false}
                    />
                  </details>
                )}
                <details>
                  <summary>Search coverage and remaining uncertainty</summary>
                  <ul>
                    {result.result.notes.map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                  {result.result.exploredRanges.map((range) => (
                    <p key={range.path}>
                      {parameters.find((p) => p.path === range.path)?.label ?? range.path}:{' '}
                      {range.values
                        ? range.values.map(String).join(', ')
                        : `${range.min}–${range.max}`}{' '}
                      among retained matching results. This is not a confidence interval.
                    </p>
                  ))}
                </details>
              </>
            )}
          </section>
          <section className="panel panel-stack" aria-labelledby="setup-kept-title">
            <h3 id="setup-kept-title">Your saved setups</h3>
            {!doc.alternatives.length && (
              <p className="note">
                Keep possible setups above, or use your stated settings. You can retain alternatives
                and choose one for Dial in.
              </p>
            )}
            {doc.alternatives.map((profile) => (
              <article className="setup-saved" key={profile.id}>
                <div>
                  <label className="field">
                    Name for saved setup
                    <input
                      value={profile.name}
                      maxLength={120}
                      onChange={(e) => {
                        if (e.target.value.trim())
                          update((d) => ({
                            ...d,
                            alternatives: d.alternatives.map((p) =>
                              p.id === profile.id ? { ...p, name: e.target.value } : p,
                            ),
                          }));
                      }}
                    />
                  </label>
                  <p>
                    {profile.source === 'inferred'
                      ? `Consistent with ${profile.request.observations.length} recorded shots`
                      : 'Stated settings and assumptions'}
                    {doc.activeId === profile.id ? ' · Active setup' : ''}
                  </p>
                  {profile.coreVersion !== catalog.coreVersion && (
                    <p className="run-warning">
                      Saved with engine {profile.coreVersion}; recheck before use with{' '}
                      {catalog.coreVersion}.
                    </p>
                  )}
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={running || profile.coreVersion !== catalog.coreVersion}
                    onClick={() => void activate(profile)}
                  >
                    Use {profile.name} in Dial in
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={running}
                    onClick={() => {
                      const imported = recipeToForm(profile.recipe);
                      if (!imported.ok) {
                        setProblem(imported.error);
                        return;
                      }
                      useShotStore.getState().loadForm(imported.form, 'Undo setup refinement');
                      update((d) => ({
                        ...d,
                        constraints: profile.request.constraints,
                        observations: profile.request.observations,
                        facts: profile.facts,
                      }));
                      setStatus(
                        'Saved setup loaded for refinement. Add a shot or update your known settings, then search again.',
                      );
                    }}
                  >
                    Refine {profile.name}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={running}
                    onClick={() =>
                      update((d) => ({
                        ...d,
                        alternatives: d.alternatives.filter((a) => a.id !== profile.id),
                        activeId: d.activeId === profile.id ? null : d.activeId,
                      }))
                    }
                  >
                    Remove {profile.name}
                  </button>
                </div>
              </article>
            ))}
          </section>
        </>
      )}
    </section>
  );
}
