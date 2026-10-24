// SPDX-License-Identifier: GPL-2.0-or-later
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tabId } from '../components/ModeTabs';
import { HelpField, HelpButton } from '../help/HelpButton';
import { useEngine } from '../engine/EngineContext';
import { isAbortError } from '../engine/engine';
import type { Recipe } from '../engine/shotTypes';
import { datedName, downloadJson } from '../shot/download';
import {
  changeGrinderPreset,
  formToRecipe,
  physicalKey,
  recipeToForm,
  withTier,
} from '../shot/recipeForm';
import { useShotStore } from '../shot/shotStore';
import { useAppStore } from '../store';
import { beanSummary } from '../shot/editor/summaries';
import { SetupPrediction } from '../setup/SetupPrediction';
import { MAX_SETUP_OBSERVATIONS, useEquipmentStore } from '../setup/inferenceStorage';
import { applyCalibration, calibrate, scopeKey } from './calibration';
import { importShotLog } from './imports';
import { mergeJournal, parseJournal } from './journal';
import { learnTaste, scorecard } from './learning';
import { searchRecipes, type InverseOptions, type InverseResult } from './inverse';
import type { JournalEntry, Measurement } from './types';
import { useJournal } from './useJournal';

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function number(text: string, label: string, min: number, max: number): number {
  const value = Number(text.trim().replace(',', '.'));
  if (!text.trim() || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}
const f = (value: number, digits = 1) => value.toFixed(digits);
/** Encode exact UTF-16 units, including lone surrogates from imported JSON, into safe IDREFs. */
function shotDomId(id: string) {
  return `dial-shot-${id
    .split('')
    .map((unit) => unit.charCodeAt(0).toString(16))
    .join('-')}`;
}
const RECORD_PANEL_ID = 'dial-record-panel';

function MeasureShot({
  entry,
  save,
  disabled,
}: {
  entry: JournalEntry;
  save: (measurement: Measurement) => Promise<void>;
  disabled: boolean;
}) {
  const [time, setTime] = useState('');
  const [yieldG, setYield] = useState('');
  const [tds, setTds] = useState('');
  const [rating, setRating] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="dial-measure"
      aria-label={`Measurements for ${entry.label}`}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const measurement: Measurement = {
            recordedAt: new Date().toISOString(),
            timeS: number(time, 'Shot time', 0.1, 600),
            yieldG: number(yieldG, 'Final beverage', 0.1, 500),
            notes,
            ...(tds.trim() ? { tdsPercent: number(tds, 'TDS', 0.01, 30) } : {}),
            ...(rating ? { rating: number(rating, 'Rating', 1, 5) } : {}),
          };
          setSaving(true);
          void save(measurement)
            .catch((failure: unknown) => setError(message(failure)))
            .finally(() => setSaving(false));
        } catch (failure) {
          setError(message(failure));
        }
      }}
    >
      <div className="dial-fields">
        <HelpField label="Measured time (s)" term="shot-time">
          <input
            id={`${shotDomId(entry.id)}-time`}
            value={time}
            inputMode="decimal"
            onChange={(e) => setTime(e.target.value)}
            required
          />
        </HelpField>
        <HelpField label="Final beverage (g)" term="beverage">
          <input
            value={yieldG}
            inputMode="decimal"
            onChange={(e) => setYield(e.target.value)}
            required
          />
        </HelpField>
        <HelpField label="TDS (%) · optional" term="tds">
          <input value={tds} inputMode="decimal" onChange={(e) => setTds(e.target.value)} />
        </HelpField>
        <HelpField label="Your rating · optional" term="rating">
          <select value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">No rating</option>
            {[1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={v}>
                {v} / 5
              </option>
            ))}
          </select>
        </HelpField>
      </div>
      <HelpField label="Shot notes" term="shot-notes">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
      </HelpField>
      <p className="note">
        Time from pump on to pump off. Weigh the final cup including the drip. TDS is a percentage
        from a cooled sample; omit it without a refractometer.
      </p>
      <button className="button" disabled={disabled || saving} type="submit">
        Save measurements
      </button>
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
    </form>
  );
}

export function DialIn() {
  const engine = useEngine();
  const journal = useJournal();
  const catalog = useShotStore((s) => s.catalog);
  const form = useShotStore((s) => s.form);
  const patch = useShotStore((s) => s.patchForm);
  const validation = useMemo(() => formToRecipe(form, { catalog }), [form, catalog]);
  const recipe = validation.ok ? validation.recipe : null;
  const recipeKey = recipe ? physicalKey(recipe) : '';
  const equipment = useEquipmentStore((s) => s.document);
  const equipmentProfile = equipment.alternatives.find((p) => p.id === equipment.activeId);
  const [setupNameOverride, setSetupNameOverride] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const setupName =
    setupNameOverride?.id === equipment.activeId
      ? setupNameOverride.name
      : (equipmentProfile?.name ?? 'My current bag and setup');
  const setSetupId = (name: string) => setSetupNameOverride({ id: equipment.activeId, name });
  const setupId = setupName.trim();
  const [label, setLabel] = useState('Next shot');
  const [job, setJob] = useState<{ text: string; key: string; id: number } | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [useLocal, setUseLocal] = useState(true);
  const [fitGrinder, setFitGrinder] = useState(false);
  const [timeSigma, setTimeSigma] = useState('3');
  const [tdsSigma, setTdsSigma] = useState('0.3');
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const selectedEntryRef = useRef<string | null>(null);
  const requestedMeasurementFocus = useRef<string | null>(null);
  const dialRef = useRef<HTMLElement>(null);
  const selectEntry = (id: string | null) => {
    selectedEntryRef.current = id;
    setSelectedEntry(id);
  };
  const [mode, setMode] = useState<InverseOptions['mode']>('recipe');
  const [targetTime, setTargetTime] = useState('28');
  const [targetYield, setTargetYield] = useState('36');
  const [targetTds, setTargetTds] = useState('10');
  const [targetEy, setTargetEy] = useState('20');
  const [tasteAttribute, setTasteAttribute] = useState('');
  const [tasteTarget, setTasteTarget] = useState('50');
  const [preferRatings, setPreferRatings] = useState(false);
  const [grindMin, setGrindMin] = useState('');
  const [grindMax, setGrindMax] = useState('');
  const [grindStep, setGrindStep] = useState('1');
  const [varyDose, setVaryDose] = useState(false);
  const [doseMin, setDoseMin] = useState('16');
  const [doseMax, setDoseMax] = useState('20');
  const [varyTemp, setVaryTemp] = useState(false);
  const [tempMin, setTempMin] = useState('88');
  const [tempMax, setTempMax] = useState('96');
  const [suggestions, setSuggestions] = useState<{
    key: string;
    setup: string;
    result: InverseResult;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const taskSequence = useRef(0);
  const mounted = useRef(true);
  const current = useRef({ key: recipeKey, setup: setupId });
  useEffect(() => {
    current.current = { key: recipeKey, setup: setupId };
  }, [recipeKey, setupId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const entries = journal.document.entries.filter((entry) => entry.setupId === setupId);
  const scope = recipe ? scopeKey(recipe) : '';
  const compatible = journal.document.calibrations.filter(
    (profile) =>
      profile.setupId === setupId &&
      profile.scopeKey === scope &&
      profile.coreVersion === catalog?.coreVersion,
  );
  const latestProfile = compatible.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
  )[0];
  // Inferred setup recipes already include their fitted parameters. Never apply a
  // second, older two-parameter calibration over the selected setup implicitly.
  const activeProfile = useLocal && !equipmentProfile ? latestProfile : undefined;
  const training = entries.filter(
    (entry) => !!entry.measurement && scopeKey(entry.recipe) === scope,
  );
  const card = scorecard(entries, journal.document.calibrations);
  const learningEntries = entries.filter(
    (entry) =>
      scopeKey(entry.recipe) === scope && entry.prediction?.coreVersion === catalog?.coreVersion,
  );
  const learning = learnTaste(learningEntries, setupId);
  const lastShot = [...training].sort(
    (a, b) =>
      Date.parse(b.measurement!.recordedAt) - Date.parse(a.measurement!.recordedAt) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      b.id.localeCompare(a.id),
  )[0];
  const adviceKey = JSON.stringify({
    recipeKey,
    setupId,
    coreVersion: catalog?.coreVersion,
    calibration: activeProfile?.id,
    mode,
    targetTime,
    targetYield,
    targetTds,
    targetEy,
    tasteAttribute,
    tasteTarget,
    preferRatings,
    grindMin,
    grindMax,
    grindStep,
    varyDose,
    doseMin,
    doseMax,
    varyTemp,
    tempMin,
    tempMax,
    observations: entries.map((entry) => [entry.id, entry.measurement]),
  });
  const operationKey = JSON.stringify([adviceKey, label, fitGrinder, timeSigma, tdsSigma]);
  const busy = job?.key === operationKey ? job.text : '';
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
  }, [operationKey]);
  const canRun = journal.ready && !!catalog && !!recipe && !!setupId.trim() && !busy;
  const pending = entries.find((entry) => entry.id === selectedEntry && !entry.measurement);
  const journalRows = [...entries].reverse();
  useLayoutEffect(() => {
    if (pending && requestedMeasurementFocus.current === pending.id) {
      requestedMeasurementFocus.current = null;
      document.getElementById(`${shotDomId(pending.id)}-time`)?.focus();
    }
  }, [pending]);
  const restoreJournalFocus = (ids: string[], removedRegion?: Element | null) => {
    if (!mounted.current || !dialRef.current || dialRef.current.closest('[hidden]')) return;
    const active = document.activeElement;
    if (active !== document.body && !removedRegion?.contains(active)) return;
    for (const id of [...ids, 'dial-journal-title']) {
      const target = document.getElementById(id);
      if (target) {
        target.focus();
        return;
      }
    }
  };
  const staleSuggestions =
    suggestions && (suggestions.key !== adviceKey || suggestions.setup !== setupId);

  async function task(name: string, work: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    const control = new AbortController();
    const id = ++taskSequence.current;
    controller.current = control;
    setJob({ text: name, key: operationKey, id });
    const clearJob = () => {
      if (mounted.current) setJob((existing) => (existing?.id === id ? null : existing));
    };
    control.signal.addEventListener('abort', clearJob, { once: true });
    setError(null);
    setStatus('');
    try {
      await work(control.signal);
    } catch (failure) {
      if (!control.signal.aborted && !isAbortError(failure)) setError(message(failure));
    } finally {
      control.signal.removeEventListener('abort', clearJob);
      if (controller.current === control) controller.current = null;
      clearJob();
    }
  }
  function loadRecipe(next: Recipe) {
    const imported = recipeToForm(next);
    if (!imported.ok) {
      setError('The candidate recipe cannot be opened by this version.');
      return;
    }
    useShotStore.getState().loadForm(imported.form, 'Undo dial-in recipe');
  }
  function editInLab() {
    useAppStore.getState().setLabView('shot');
    useAppStore.getState().setMode('lab');
    document.getElementById(tabId('lab'))?.focus();
  }
  async function predict(signal: AbortSignal) {
    if (!recipe || !catalog) return;
    const executed = withTier(
      activeProfile ? applyCalibration(recipe, activeProfile, catalog.coreVersion) : recipe,
      1,
    );
    const { result: run } = await engine.simulateRecipe(executed, { signal });
    signal.throwIfAborted();
    if (current.current.key !== recipeKey || current.current.setup !== setupId) return;
    const summary = run.result.summary;
    if (!['beverage_mass', 'time'].includes(summary.stop_reason) || summary.beverage_mass_kg <= 0) {
      throw new Error(
        `Prediction stopped with ${summary.stop_reason}. Check the recipe in the Lab before logging it.`,
      );
    }
    const now = new Date().toISOString();
    const entry: JournalEntry = {
      id: crypto.randomUUID(),
      createdAt: now,
      setupId: setupId.trim(),
      label: label.trim() || 'Shot',
      recipe: structuredClone(recipe),
      source: 'manual',
      prediction: {
        recordedAt: now,
        coreVersion: run.result.core_version,
        executedRecipe: executed,
        summary,
        ...(run.taste ? { taste: run.taste } : {}),
        origin: 'app',
        ...(activeProfile ? { calibrationId: activeProfile.id } : {}),
      },
    };
    await journal.update((doc) => ({ ...doc, entries: [...doc.entries, entry] }), signal);
    signal.throwIfAborted();
    if (mounted.current) {
      selectEntry(entry.id);
      setStatus('Prediction saved. Pull the shot, then record what happened.');
    }
  }

  return (
    <section ref={dialRef} className="dial-in panel-stack" aria-labelledby="dial-in-title">
      <div className="panel-header">
        <div>
          <h2 id="dial-in-title">Dial in</h2>
          <p>
            Use your equipment setup to adjust the next shot, predict it, and record the result.
          </p>
        </div>
        <button className="button" onClick={editInLab}>
          Edit full recipe in Lab
        </button>
      </div>
      <SetupPrediction recipe={recipe} catalog={catalog} />
      <details className="calculation-details">
        <summary>Prediction limits</summary>
        <p>
          These are estimates from a physical model. A fitted setup can explain your recorded shots
          without uniquely identifying the equipment or guaranteeing the next shot. Taste estimates
          have not been validated against sensory measurements.
        </p>
      </details>
      {journal.error && (
        <p role="alert" className="run-error">
          Journal: {journal.error}
        </p>
      )}
      <p className="note">
        {!journal.ready
          ? 'Opening the local journal…'
          : journal.persistent
            ? 'Journal saved on this device in IndexedDB. Export a backup before clearing browser data.'
            : 'Persistent storage is unavailable. This journal lasts only for this session; export it to keep your shots.'}
      </p>
      <div className="dial-grid">
        <section className="panel panel-stack" aria-labelledby="dial-recipe-title">
          <h3 id="dial-recipe-title">Your next shot</h3>
          <div className="dial-fields">
            <HelpField label="Bag and setup name" term="setup-name">
              <input
                value={setupName}
                maxLength={120}
                onChange={(e) => setSetupId(e.target.value)}
              />
            </HelpField>
            <HelpField label="Shot name" term="shot-label">
              <input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
            </HelpField>
            {catalog && (
              <>
                <div className="field">
                  <div className="field-head">
                    <strong>Coffee</strong>
                    <HelpButton term="roast" label="Selected coffee" />
                  </div>
                  <span>{beanSummary(form, catalog)}</span>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => useAppStore.getState().setMode('setup')}
                  >
                    Change coffee in Set up equipment
                  </button>
                </div>
                {form.grinder.mode === 'preset' && (
                  <HelpField label="Grinder preset" term="grind">
                    <select
                      value={form.grinder.preset}
                      onChange={(e) =>
                        patch(
                          'grinder',
                          changeGrinderPreset(
                            form.grinder,
                            catalog.presets.grinders.find((p) => p.id === e.target.value),
                            e.target.value,
                          ),
                        )
                      }
                    >
                      {catalog.presets.grinders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </HelpField>
                )}
              </>
            )}
            <HelpField label="Dose (g)" term="dose">
              <input
                value={form.prep.dose_g}
                inputMode="decimal"
                onChange={(e) => patch('prep', { dose_g: e.target.value })}
              />
            </HelpField>
            {form.grinder.mode !== 'psd' && (
              <HelpField
                label={
                  form.grinder.by === 'setting' ? 'Grinder setting' : 'Effective fineness (µm)'
                }
                term={form.grinder.by === 'setting' ? 'grind' : 'gap'}
              >
                <input
                  value={form.grinder.by === 'setting' ? form.grinder.setting : form.grinder.gap_um}
                  inputMode="decimal"
                  onChange={(e) =>
                    patch('grinder', {
                      [form.grinder.by === 'setting' ? 'setting' : 'gap_um']: e.target.value,
                    })
                  }
                />
              </HelpField>
            )}
            <HelpField label="Stop beverage (g)" term="beverage">
              <input
                value={form.stop.beverage_g}
                inputMode="decimal"
                onChange={(e) => patch('stop', { beverage_g: e.target.value })}
              />
            </HelpField>
            <HelpField label="Water temperature (°C)" term="temperature">
              <input
                value={form.machine.temperature_c}
                placeholder="From machine preset"
                inputMode="decimal"
                onChange={(e) => patch('machine', { temperature_c: e.target.value })}
              />
            </HelpField>
          </div>
          <p className="note">
            These controls share the Lab recipe, including its basket, water, machine program and
            advanced overrides. Stop beverage is the pump-stop target; the final cup can include
            extra drip.
          </p>
          {!validation.ok && (
            <ul role="alert" className="run-error">
              {Object.entries(validation.errors).map(([key, value]) => (
                <li key={key}>
                  {key}: {value}
                </li>
              ))}
            </ul>
          )}
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={useLocal}
              onChange={(e) => setUseLocal(e.target.checked)}
            />
            Use compatible local calibration
          </label>
          <p className="note">
            {activeProfile
              ? `Local fit from ${activeProfile.trainingIds.length} shots, saved ${new Date(activeProfile.createdAt).toLocaleString()}.`
              : 'Using the published model. No compatible local fit is active for this recipe and engine version.'}
          </p>
          <button
            className="button button-primary"
            disabled={!canRun}
            onClick={() => {
              void task('Predicting and saving…', predict);
            }}
          >
            Predict and save before pulling
          </button>
        </section>
        <details className="panel panel-stack">
          <summary>Earlier local calibration tools</summary>
          <section className="panel-stack" aria-labelledby="dial-calibration-title">
            <h3 id="dial-calibration-title">Earlier local calibration</h3>
            <p className="note">
              Existing calibration records are kept here. Use Set up equipment for the full
              observed-shot workflow. Selecting an equipment setup disables automatic application of
              these earlier fits.
            </p>
            <ol>
              <li>Log at least three completed shots with the same bag and equipment.</li>
              <li>Use varied grinder settings; TDS is optional for permeability alone.</li>
              <li>Fit locally, then test new predictions on future shots.</li>
            </ol>
            <p>{training.length} matching completed shots available.</p>
            <div className="dial-fields">
              <label>
                Timing uncertainty (s)
                <input
                  value={timeSigma}
                  inputMode="decimal"
                  onChange={(e) => setTimeSigma(e.target.value)}
                />
              </label>
              <label>
                TDS uncertainty (percentage points)
                <input
                  value={tdsSigma}
                  inputMode="decimal"
                  onChange={(e) => setTdsSigma(e.target.value)}
                />
              </label>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={fitGrinder}
                onChange={(e) => setFitGrinder(e.target.checked)}
              />
              Also fit particle-size scale (needs varied settings and TDS)
            </label>
            <button
              className="button"
              disabled={!canRun || training.length < 3 || !!equipmentProfile}
              onClick={() => {
                void task('Fitting local calibration…', async (signal) => {
                  if (!catalog) return;
                  const profile = await calibrate(
                    engine,
                    training,
                    catalog,
                    {
                      setupId,
                      fitGrinderScale: fitGrinder,
                      timeSigmaS: number(timeSigma, 'Timing uncertainty', 0.1, 60),
                      tdsSigmaPercent: number(tdsSigma, 'TDS uncertainty', 0.01, 5),
                    },
                    signal,
                    (done, total) => {
                      if (!signal.aborted) setStatus(`Calibration: ${done} / ${total} evaluations`);
                    },
                  );
                  signal.throwIfAborted();
                  await journal.update(
                    (doc) => ({
                      ...doc,
                      calibrations: [...doc.calibrations, profile],
                    }),
                    signal,
                  );
                  signal.throwIfAborted();
                  setStatus('Local fit saved. Training checks do not establish future accuracy.');
                });
              }}
            >
              Fit local calibration
            </button>
            {latestProfile && (
              <div className="dial-fit">
                <h4>Identifiability and training checks</h4>
                <table>
                  <thead>
                    <tr>
                      <th>Parameter</th>
                      <th>MAP multiplier</th>
                      <th>p05–p95</th>
                      <th>What the data constrain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestProfile.parameters.map((p) => (
                      <tr key={p.id}>
                        <th scope="row">{p.label}</th>
                        <td>{f(p.map, 2)}×</td>
                        <td>
                          {f(p.p05, 2)}–{f(p.p95, 2)}
                        </td>
                        <td>{p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <details>
                  <summary>Fit assumptions and simulation checks</summary>
                  <ul>
                    {latestProfile.notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                  <p>
                    {latestProfile.checks.length} training shots rechecked with the full simulation.
                    These are training residuals.
                  </p>
                  <ul>
                    {latestProfile.checks.map((c) => (
                      <li key={c.entryId}>
                        Time error {f(c.timeErrorS)} s;{' '}
                        {c.eyErrorPoints === null
                          ? 'EY unmeasured'
                          : `EY error ${f(c.eyErrorPoints)} percentage points`}
                        .
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </section>
        </details>
      </div>
      <section className="panel panel-stack" aria-labelledby="dial-journal-title">
        <div className="panel-header">
          <h3 id="dial-journal-title" tabIndex={-1}>
            Shot journal
          </h3>
          <div className="button-row">
            <button
              className="button"
              disabled={!journal.ready}
              onClick={() => downloadJson(datedName('journal', 'json'), journal.document)}
            >
              Export journal
            </button>
            <label className="button dial-file">
              Import journal or shot log
              <input
                aria-label="Import journal or shot log"
                type="file"
                accept=".json,.csv,.shot,.txt"
                disabled={!journal.ready || !!busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (!file) return;
                  void task('Importing…', async (signal) => {
                    const isJournal = file.name.toLowerCase().endsWith('.json');
                    const limit = isJournal ? 10_000_000 : 2_000_000;
                    if (file.size > limit)
                      throw new Error(
                        isJournal
                          ? 'Journal backups must be at most 10 MB.'
                          : 'Shot logs must be at most 2 MB.',
                      );
                    const text = await file.text();
                    signal.throwIfAborted();
                    if (isJournal) {
                      const incoming = parseJournal(text);
                      await journal.update((doc) => mergeJournal(doc, incoming), signal);
                    } else {
                      if (!recipe)
                        throw new Error('Choose a valid base recipe before importing a shot log.');
                      const incoming = importShotLog(
                        text,
                        file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'de1',
                        recipe,
                        setupId,
                      );
                      await journal.update(
                        (doc) => ({
                          ...doc,
                          entries: [...doc.entries, ...incoming],
                        }),
                        signal,
                      );
                    }
                    signal.throwIfAborted();
                    setStatus(
                      'Import complete. Imported shots can train local models; they do not count as prospective predictions.',
                    );
                  });
                }}
              />
            </label>
          </div>
        </div>
        <p className="note">
          CSV: time_s,yield_g, optional dose_g,setting,tds_percent,rating,notes. DE1 .shot logs use
          observed elapsed and scale-weight channels. Missing gear uses your current recipe and is
          labelled assumed.
        </p>
        {!entries.length ? (
          <p>No shots in this bag and setup yet. Save a prediction or import a log to start.</p>
        ) : (
          <div className="table-wrap">
            <table aria-label="Shot journal">
              <thead>
                <tr>
                  <th>Shot</th>
                  <th>Prediction</th>
                  <th>Measured</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {journalRows.map((entry, rowIndex) => (
                  <tr key={entry.id}>
                    <th scope="row">
                      <span className="visually-hidden">Shot {rowIndex + 1}: </span>
                      {entry.label}
                      <small>
                        {new Date(entry.createdAt).toLocaleString()} · {entry.source}
                      </small>
                    </th>
                    <td>
                      {entry.prediction ? (
                        <>
                          {f(entry.prediction.summary.shot_time_s)} s ·{' '}
                          {f(entry.prediction.summary.beverage_mass_kg * 1000)} g<br />
                          {f(entry.prediction.summary.tds * 100)}% TDS ·{' '}
                          {f(entry.prediction.summary.ey * 100)}% EY
                        </>
                      ) : (
                        'No prior prediction'
                      )}
                    </td>
                    <td>
                      {entry.measurement ? (
                        <>
                          {f(entry.measurement.timeS)} s · {f(entry.measurement.yieldG)} g<br />
                          {entry.measurement.tdsPercent === undefined
                            ? 'TDS unmeasured'
                            : `${f(entry.measurement.tdsPercent, 2)}% TDS`}{' '}
                          {entry.measurement.rating ? `· ${entry.measurement.rating}/5` : ''}
                          <small>{entry.measurement.notes}</small>
                        </>
                      ) : (
                        'Waiting for measurements'
                      )}
                    </td>
                    <td>
                      <div className="button-row">
                        {!entry.measurement && (
                          <button
                            className="button"
                            disabled={!!busy}
                            aria-label={`Record shot ${rowIndex + 1}: ${entry.label}`}
                            aria-expanded={selectedEntry === entry.id}
                            aria-controls={RECORD_PANEL_ID}
                            onClick={() => {
                              const next = selectedEntry === entry.id ? null : entry.id;
                              requestedMeasurementFocus.current = next;
                              selectEntry(next);
                            }}
                          >
                            Record shot
                          </button>
                        )}
                        <button
                          id={`${shotDomId(entry.id)}-use`}
                          className="button"
                          aria-label={`Use recipe from shot ${rowIndex + 1}: ${entry.label}`}
                          disabled={!!busy}
                          onClick={() => loadRecipe(entry.recipe)}
                        >
                          Use recipe
                        </button>
                        {entry.measurement && (
                          <button
                            type="button"
                            className="button"
                            aria-label={`Use shot to refine equipment: shot ${rowIndex + 1}`}
                            disabled={!!busy}
                            onClick={() => {
                              try {
                                const measurement = entry.measurement!;
                                useEquipmentStore.getState().update((d) => {
                                  if (d.observations.length >= MAX_SETUP_OBSERVATIONS)
                                    throw new Error(
                                      'Remove a setup observation before adding another.',
                                    );
                                  if (d.observations.some((o) => o.id === `journal-${entry.id}`))
                                    throw new Error(
                                      'This shot is already included in equipment setup.',
                                    );
                                  return {
                                    ...d,
                                    observations: [
                                      ...d.observations,
                                      {
                                        id: `journal-${entry.id}`,
                                        label: entry.label,
                                        recipe: entry.prediction?.executedRecipe ?? entry.recipe,
                                        timeS: measurement.timeS,
                                        yieldG: measurement.yieldG,
                                        ...(measurement.tdsPercent === undefined
                                          ? {}
                                          : { tdsPercent: measurement.tdsPercent }),
                                        timeBasis: 'pump',
                                        massBasis: 'final',
                                        timeToleranceS: 1,
                                        yieldToleranceG: 0.5,
                                        tdsTolerancePercent: 0.2,
                                        changes: [
                                          'prep.dose_g',
                                          ...(entry.recipe.grinder.gap_um !== undefined
                                            ? ['grinder.gap_um']
                                            : entry.recipe.grinder.setting !== undefined
                                              ? ['grinder.setting']
                                              : []),
                                          ...((entry.prediction?.executedRecipe ?? entry.recipe)
                                            .machine.temperature_c != null
                                            ? ['machine.temperature_c']
                                            : []),
                                        ],
                                      },
                                    ],
                                  };
                                });
                                useAppStore.getState().setMode('setup');
                              } catch (failure) {
                                setError(message(failure));
                              }
                            }}
                          >
                            Use shot to refine equipment
                          </button>
                        )}
                        <button
                          className="button"
                          aria-label={`Delete shot ${rowIndex + 1}: ${entry.label}`}
                          disabled={!!busy}
                          onClick={(event) => {
                            const row = event.currentTarget.closest('tr');
                            const neighbor = journalRows[rowIndex + 1] ?? journalRows[rowIndex - 1];
                            void journal
                              .update((doc) => ({
                                ...doc,
                                entries: doc.entries.filter((e) => e.id !== entry.id),
                              }))
                              .then(() => {
                                if (selectedEntryRef.current === entry.id) selectEntry(null);
                                setStatus(`Deleted shot: ${entry.label}.`);
                                restoreJournalFocus(
                                  neighbor ? [`${shotDomId(neighbor.id)}-use`] : [],
                                  row,
                                );
                              })
                              .catch((e) => setError(message(e)));
                          }}
                        >
                          Delete shot
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="dial-record" id={RECORD_PANEL_ID} hidden={!pending}>
          {pending && (
            <>
              <h4>Record {pending.label}</h4>
              <MeasureShot
                key={pending.id}
                entry={pending}
                disabled={!!busy}
                save={async (measurement) => {
                  const region = document.getElementById(RECORD_PANEL_ID);
                  await journal.update((doc) => ({
                    ...doc,
                    entries: doc.entries.map((entry) =>
                      entry.id === pending.id ? { ...entry, measurement } : entry,
                    ),
                  }));
                  if (selectedEntryRef.current === pending.id) {
                    selectEntry(null);
                    restoreJournalFocus([`${shotDomId(pending.id)}-use`], region);
                  }
                  setStatus('Measured shot saved.');
                }}
              />
            </>
          )}
        </div>
      </section>
      <section className="panel panel-stack" aria-labelledby="dial-advice-title">
        <h3 id="dial-advice-title">Find the next recipe</h3>
        <div className="dial-fields">
          <HelpField label="Advice mode" term="advice">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as InverseOptions['mode'])}
            >
              <option value="recipe">Recipe target: time and yield</option>
              <option value="outcome">Cup target: TDS, EY or taste</option>
              <option value="next">Next shot from the last result</option>
            </select>
          </HelpField>
          <HelpField label="Target time (s)" term="shot-time">
            <input
              value={targetTime}
              inputMode="decimal"
              onChange={(e) => setTargetTime(e.target.value)}
            />
          </HelpField>
          <HelpField label="Target final beverage (g)" term="beverage">
            <input
              value={targetYield}
              inputMode="decimal"
              onChange={(e) => setTargetYield(e.target.value)}
            />
          </HelpField>
          {mode === 'outcome' && (
            <>
              <HelpField label="Target TDS (%)" term="tds">
                <input
                  value={targetTds}
                  inputMode="decimal"
                  onChange={(e) => setTargetTds(e.target.value)}
                />
              </HelpField>
              <HelpField label="Target EY (%)" term="ey">
                <input
                  value={targetEy}
                  inputMode="decimal"
                  onChange={(e) => setTargetEy(e.target.value)}
                />
              </HelpField>
              <HelpField label="Optional taste attribute" term="taste">
                <select value={tasteAttribute} onChange={(e) => setTasteAttribute(e.target.value)}>
                  <option value="">No taste target</option>
                  {['acidity', 'bitterness', 'astringency', 'body'].map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </HelpField>
              {tasteAttribute && (
                <HelpField label="Target relative taste index" term="taste">
                  <input
                    value={tasteTarget}
                    inputMode="decimal"
                    onChange={(e) => setTasteTarget(e.target.value)}
                  />
                </HelpField>
              )}
            </>
          )}
        </div>
        {mode === 'next' && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={preferRatings}
              onChange={(e) => setPreferRatings(e.target.checked)}
            />
            Include personal rating preference in ranking (needs five varied rated shots)
          </label>
        )}
        <details>
          <summary>Equipment limits and allowed changes</summary>
          <p className="note">
            Grinder values are dial units when the recipe uses a setting, otherwise µm of burr gap.
            Empty limits use the preset’s range. Only selected controls change. Basket capacity
            remains enforced by the builder.
          </p>
          <div className="dial-fields">
            <HelpField label="Minimum grind" term="grind">
              <input
                value={grindMin}
                inputMode="decimal"
                onChange={(e) => setGrindMin(e.target.value)}
              />
            </HelpField>
            <HelpField label="Maximum grind" term="grind">
              <input
                value={grindMax}
                inputMode="decimal"
                onChange={(e) => setGrindMax(e.target.value)}
              />
            </HelpField>
            <HelpField label="Grinder step" term="grind">
              <input
                value={grindStep}
                inputMode="decimal"
                onChange={(e) => setGrindStep(e.target.value)}
              />
            </HelpField>
          </div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={varyDose}
              onChange={(e) => setVaryDose(e.target.checked)}
            />
            Allow dose changes (0.5 g increments)
          </label>
          {varyDose && (
            <div className="dial-fields">
              <HelpField label="Minimum dose (g)" term="dose">
                <input
                  value={doseMin}
                  inputMode="decimal"
                  onChange={(e) => setDoseMin(e.target.value)}
                />
              </HelpField>
              <HelpField label="Maximum dose (g)" term="dose">
                <input
                  value={doseMax}
                  inputMode="decimal"
                  onChange={(e) => setDoseMax(e.target.value)}
                />
              </HelpField>
            </div>
          )}
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={varyTemp}
              onChange={(e) => setVaryTemp(e.target.checked)}
            />
            Allow temperature changes (1 °C increments)
          </label>
          {varyTemp && (
            <div className="dial-fields">
              <HelpField label="Minimum temperature (°C)" term="temperature">
                <input
                  value={tempMin}
                  inputMode="decimal"
                  onChange={(e) => setTempMin(e.target.value)}
                />
              </HelpField>
              <HelpField label="Maximum temperature (°C)" term="temperature">
                <input
                  value={tempMax}
                  inputMode="decimal"
                  onChange={(e) => setTempMax(e.target.value)}
                />
              </HelpField>
            </div>
          )}
        </details>
        <button
          className="button"
          disabled={!canRun || (mode === 'next' && !lastShot)}
          onClick={() => {
            void task('Searching recipes…', async (signal) => {
              if (!recipe || !catalog) return;
              const dial = catalog.presets.grinders.find(
                (p) => p.id === recipe.grinder.preset,
              )?.dial;
              const directGap = recipe.grinder.gap_um != null;
              const grindLower = directGap ? 5 : (dial?.min ?? -Number.MAX_SAFE_INTEGER);
              const grindUpper = directGap ? 3000 : (dial?.max ?? Number.MAX_SAFE_INTEGER);
              const controlsGrinder =
                grindMin.trim() || grindMax.trim() || (dial && !recipe.grinder.gap_um)
                  ? {
                      min: number(
                        grindMin || String(dial?.min ?? ''),
                        'Minimum grind',
                        grindLower,
                        grindUpper,
                      ),
                      max: number(
                        grindMax || String(dial?.max ?? ''),
                        'Maximum grind',
                        grindLower,
                        grindUpper,
                      ),
                      step: number(grindStep, 'Grinder step', 0.001, 1000),
                    }
                  : undefined;
              const options: InverseOptions = {
                mode,
                targetTimeS: number(targetTime, 'Target time', 1, 600),
                targetYieldG: number(targetYield, 'Target final beverage', 1, 250),
                coreVersion: catalog.coreVersion,
                calibration: activeProfile,
                lastShot,
                ratedShots: learningEntries,
                preferenceWeight: mode === 'next' && preferRatings ? 0.5 : 0,
                controls: {
                  ...(controlsGrinder ? { grinder: controlsGrinder } : {}),
                  ...(varyDose
                    ? {
                        dose: {
                          min: number(doseMin, 'Minimum dose', 1, 50),
                          max: number(doseMax, 'Maximum dose', 1, 50),
                          step: 0.5,
                        },
                      }
                    : {}),
                  ...(varyTemp
                    ? {
                        temp: {
                          min: number(tempMin, 'Minimum temperature', 50, 100),
                          max: number(tempMax, 'Maximum temperature', 50, 100),
                          step: 1,
                        },
                      }
                    : {}),
                },
                ...(mode === 'outcome'
                  ? {
                      targetTdsPercent: number(targetTds, 'Target TDS', 0.01, 30),
                      targetEyPercent: number(targetEy, 'Target EY', 0.1, 40),
                      ...(tasteAttribute
                        ? {
                            targetTaste: {
                              attribute: tasteAttribute as
                                'acidity' | 'bitterness' | 'astringency' | 'body',
                              index: number(tasteTarget, 'Target taste index', 0, 100),
                            },
                          }
                        : {}),
                    }
                  : {}),
              };
              const result = await searchRecipes(
                engine,
                recipe,
                catalog,
                options,
                signal,
                (progress) => {
                  if (!signal.aborted)
                    setStatus(`${progress.stage}: ${progress.completed} / ${progress.total}`);
                },
              );
              signal.throwIfAborted();
              setSuggestions({ key: adviceKey, setup: setupId, result });
              setStatus('Search finished; candidates checked with the full simulation.');
            });
          }}
        >
          Find ranked recipes
        </button>
        {mode === 'next' && !lastShot && (
          <p className="note">Record a completed shot for this recipe’s bag and setup first.</p>
        )}
        {suggestions && (
          <div data-stale={staleSuggestions ? 'true' : undefined}>
            {staleSuggestions && (
              <p className="run-warning">
                Suggestions for earlier inputs. Search again before using them.
              </p>
            )}
            <ul className="note">
              {suggestions.result.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
            {!suggestions.result.candidates.length && (
              <p>No valid verified candidate found within these equipment limits.</p>
            )}
            <div className="dial-candidates">
              {suggestions.result.candidates.map((candidate, i) => {
                const personal = candidate.learnedRating
                  ? { prediction: candidate.learnedRating, count: candidate.learnedRating.count }
                  : learnTaste(learningEntries, setupId, candidate.verified.taste);
                return (
                  <article className="dial-candidate" key={i}>
                    <h4>Candidate {i + 1}</h4>
                    <p>
                      {candidate.recipe.prep.dose_g} g in · grinder{' '}
                      {candidate.recipe.grinder.gap_um ??
                        candidate.recipe.grinder.setting ??
                        'measured PSD'}{' '}
                      · {candidate.recipe.stop?.beverage_g} g stop ·{' '}
                      {candidate.recipe.machine?.temperature_c ?? 'preset'} °C
                    </p>
                    <p>
                      <strong>Prediction:</strong> {f(candidate.verified.summary.shot_time_s)} s ·{' '}
                      {f(candidate.verified.summary.beverage_mass_kg * 1000)} g final ·{' '}
                      {f(candidate.verified.summary.tds * 100)}% TDS ·{' '}
                      {f(candidate.verified.summary.ey * 100)}% EY
                    </p>
                    <p className="note">
                      Fast search estimate: {f(candidate.preview.summary.shot_time_s)} s. Prediction
                      intervals for model error are unavailable.
                    </p>
                    <p className="note">
                      Target residual score: {f(candidate.score, 2)} (lower is closer).{' '}
                      {candidate.learnedRating
                        ? 'Ranking also includes your optional preference model.'
                        : ''}
                    </p>
                    <details>
                      <summary>
                        Local control sensitivity ({candidate.envelope.samples} preview samples)
                      </summary>
                      <p>
                        Time {f(candidate.envelope.timeS[0])}–{f(candidate.envelope.timeS[1])} s;
                        final cup {f(candidate.envelope.yieldG[0])}–
                        {f(candidate.envelope.yieldG[1])} g; TDS{' '}
                        {f(candidate.envelope.tdsPercent[0])}–{f(candidate.envelope.tdsPercent[1])}
                        %; EY {f(candidate.envelope.eyPercent[0])}–
                        {f(candidate.envelope.eyPercent[1])}%.
                      </p>
                      <p className="note">
                        Nearby equipment changes only. This range excludes model error and is not a
                        confidence interval.
                      </p>
                    </details>
                    {personal.prediction && (
                      <p>
                        Personal rating estimate: {f(personal.prediction.mean)} / 5 (
                        {f(personal.prediction.p05)}–{f(personal.prediction.p95)}); {personal.count}{' '}
                        rated shots, conditional Bayesian range.
                      </p>
                    )}
                    {candidate.warnings.length > 0 && (
                      <ul className="run-warning">
                        {candidate.warnings.map((warning, j) => (
                          <li key={j}>{warning}</li>
                        ))}
                      </ul>
                    )}
                    <button
                      className="button"
                      disabled={!!staleSuggestions || !!busy}
                      onClick={() => loadRecipe(candidate.recipe)}
                    >
                      Use candidate {i + 1}
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="panel panel-stack" aria-labelledby="dial-scorecard-title">
        <h3 id="dial-scorecard-title">Earlier local calibration scorecard</h3>
        <p className="note">
          This scorecard evaluates predictions attached to the earlier local calibration tools. It
          does not grade equipment profiles from Set up equipment. Compare those profiles’ saved
          forecasts with their measured results in the shot journal; their future accuracy has not
          been established by this scorecard.
        </p>
        <p>
          {card.timeOnly.evaluated} prospective timing checks · {card.timeOnly.passed} within ±3 s
          {card.timeOnly.maeS === null ? '' : ` · mean absolute error ${f(card.timeOnly.maeS)} s`}.
          TDS is optional for this timing-only check.
        </p>
        <p>
          {card.evaluated} complete prospective shots · {card.passed} within ±3 s and ±1 EY point ·{' '}
          {card.required} required.
        </p>
        <p className={card.met ? 'note' : 'run-warning'}>
          {card.met
            ? 'The earlier calibration met its check on subsequent measured shots. This does not establish the accuracy of an active equipment profile.'
            : 'Accuracy check incomplete. Calibration training shots, imported predictions and shots without measured TDS cannot establish the complete target.'}
        </p>
        <p className="note">
          {learning.count} compatible rated shots inform your local preference model. Ratings stay
          separate from the chemistry’s relative taste indices; sparse ratings do not establish a
          reliable preference predictor.
        </p>
      </section>
      {busy && (
        <div className="dial-job">
          <span role="status">{busy}</span>
          <button
            className="button"
            onClick={() => {
              controller.current?.abort();
              controller.current = null;
              setJob(null);
              setStatus('Cancelled.');
            }}
          >
            Cancel dial-in task
          </button>
        </div>
      )}
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
    </section>
  );
}
