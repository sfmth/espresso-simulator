// SPDX-License-Identifier: GPL-2.0-or-later
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEngine } from '../engine/EngineContext';
import { isAbortError } from '../engine/engine';
import type { Catalog, PresetBase, Recipe } from '../engine/shotTypes';
import { useOptionalSharedShotRun } from '../shot/ShotRunContext';
import {
  changeGrinderPreset,
  changeMachinePreset,
  defaultForm,
  emptyForm,
  formToRecipe,
  recipeToForm,
  type RecipeForm,
} from '../shot/recipeForm';
import { useShotStore } from '../shot/shotStore';
import { browserStorage, loadDraft } from '../shot/storage';
import { createSetupStorage, type EquipmentSetupRecord } from './setupStorage';
import './EquipmentSetup.css';

type Gear = 'machine' | 'grinder' | 'basket' | 'bean';
type Choices = Record<Gear, string>;
const KEEP = '__keep_current';
const GEARS: readonly Gear[] = ['machine', 'grinder', 'basket', 'bean'];
const LABELS: Record<Gear, string> = {
  machine: 'Your machine',
  grinder: 'Your grinder',
  basket: 'Your basket',
  bean: 'Your beans',
};

function currentChoices(form: RecipeForm): Choices {
  return {
    machine: form.machine.preset || KEEP,
    grinder: form.grinder.mode === 'preset' ? form.grinder.preset : KEEP,
    basket: form.basket.mode === 'preset' ? form.basket.preset : KEEP,
    bean: form.bean.preset || KEEP,
  };
}

function presets(catalog: Catalog, gear: Gear): readonly PresetBase[] {
  if (gear === 'bean') return catalog.presets.beans;
  if (gear === 'grinder') return catalog.presets.grinders;
  if (gear === 'basket') return catalog.presets.baskets;
  return catalog.presets.machines;
}

function hasValidDraft(): boolean {
  const saved = loadDraft(browserStorage());
  if (!saved) return false;
  const imported = recipeToForm(saved);
  return imported.ok && formToRecipe(imported.form).ok;
}

function validRecord(record: EquipmentSetupRecord | null, catalog: Catalog | null): boolean {
  if (!record || !catalog) return false;
  const imported = recipeToForm(record.recipe);
  return imported.ok && formToRecipe(imported.form, { catalog }).ok;
}

function SetupDialog({
  catalog,
  catalogError,
  form,
  prefill,
  optional,
  onRetry,
  onCancel,
  onComplete,
}: {
  catalog: Catalog | null;
  catalogError: string | null;
  form: RecipeForm;
  prefill: boolean;
  optional: boolean;
  onRetry: (() => void) | undefined;
  onCancel: () => void;
  onComplete: (form: RecipeForm, recipe: Recipe) => void;
}) {
  const engine = useEngine();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const controller = useRef<AbortController | null>(null);
  const id = useId();
  const [draft, setDraft] = useState<RecipeForm | null>(null);
  const [choices, setChoices] = useState<Choices>(() =>
    prefill ? currentChoices(form) : { machine: '', grinder: '', basket: '', bean: '' },
  );
  const [step, setStep] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = draft ?? form;
  const validation = useMemo(() => formToRecipe(current, { catalog }), [current, catalog]);
  const machinePreset = catalog?.presets.machines.find((p) => p.id === current.machine.preset);
  const grinderPreset = catalog?.presets.grinders.find((p) => p.id === current.grinder.preset);
  const canKeep = prefill;
  const choiceValid = (gear: Gear) =>
    !!catalog &&
    ((choices[gear] === KEEP && canKeep) ||
      presets(catalog, gear).some((p) => p.id === choices[gear]));
  const equipmentReady = GEARS.every(choiceValid);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    headingRef.current?.focus();
    return () => {
      controller.current?.abort();
      dialog.close();
    };
  }, []);
  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, [step, catalog]);
  useLayoutEffect(() => {
    if (problem) errorRef.current?.focus();
  }, [problem]);

  const cancel = () => {
    if (!optional) return;
    controller.current?.abort();
    onCancel();
  };
  const startClean = () => {
    controller.current?.abort();
    controller.current = null;
    setSaving(false);
    setDraft(defaultForm());
    setChoices({ machine: '', grinder: '', basket: '', bean: '' });
    setStep(0);
    setProblem(null);
  };
  const patch = <K extends keyof RecipeForm>(section: K, update: Partial<RecipeForm[K]>) => {
    setDraft((previous) => {
      const next = previous ?? form;
      return { ...next, [section]: { ...next[section], ...update } };
    });
    setProblem(null);
  };
  const choose = (gear: Gear, value: string) => {
    if (!catalog || !value || (value === KEEP && !canKeep)) return;
    if (value !== KEEP && !presets(catalog, gear).some((p) => p.id === value)) return;
    setChoices((previous) => ({ ...previous, [gear]: value }));
    setProblem(null);
    if (value === KEEP) {
      setDraft((previous) => ({ ...(previous ?? form), [gear]: form[gear] }));
      return;
    }
    setDraft((previous) => {
      const next = previous ?? form;
      if (gear === 'machine') {
        if (value === next.machine.preset) return next;
        return { ...next, machine: changeMachinePreset(next.machine, value).machine };
      }
      if (gear === 'grinder') {
        if (next.grinder.mode === 'preset' && value === next.grinder.preset) return next;
        return {
          ...next,
          grinder: changeGrinderPreset(
            { ...next.grinder, mode: 'preset', by: 'setting' },
            catalog.presets.grinders.find((p) => p.id === value),
            value,
          ),
        };
      }
      if (gear === 'basket')
        return { ...next, basket: { ...next.basket, mode: 'preset', preset: value } };
      if (value === next.bean.preset) return next;
      return { ...next, bean: { ...emptyForm().bean, preset: value } };
    });
  };
  const next = () => {
    setProblem(null);
    if (step === 0) {
      if (!equipmentReady) {
        setProblem(
          'Choose a machine, grinder, basket and beans. Generic options are available when you are unsure.',
        );
        return;
      }
      setStep(1);
      return;
    }
    if (!current.stop.beverage_g.trim() && !(prefill && current.stop.time_s.trim())) {
      setProblem('Enter a target beverage mass.');
      return;
    }
    if (!validation.ok) {
      setProblem(Object.values(validation.errors).join(' '));
      return;
    }
    setStep(2);
  };
  const save = async () => {
    if (!catalog || saving || controller.current || !equipmentReady || !validation.ok) return;
    const operation = new AbortController();
    controller.current = operation;
    setSaving(true);
    setProblem(null);
    try {
      await engine.buildShotSpec(validation.recipe, { signal: operation.signal });
      operation.signal.throwIfAborted();
      if (controller.current !== operation) return;
      onComplete(current, validation.recipe);
    } catch (error) {
      if (!operation.signal.aborted && !isAbortError(error))
        setProblem(
          error instanceof Error
            ? error.message
            : 'The setup could not be checked. Please try again.',
        );
    } finally {
      if (controller.current === operation && !operation.signal.aborted) {
        controller.current = null;
        setSaving(false);
      }
    }
  };
  const displayChoice = (gear: Gear) => {
    const value = choices[gear];
    if (value === KEEP) return 'Current custom recipe details';
    return catalog
      ? (presets(catalog, gear).find((p) => p.id === value)?.name ?? 'Choose equipment')
      : '';
  };
  return (
    <dialog
      ref={dialogRef}
      className="equipment-setup-dialog"
      aria-label="Set up your equipment"
      aria-describedby={`${id}-intro`}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <div className="equipment-setup-content">
        <h2>Set up your equipment</h2>
        <p id={`${id}-intro`} className="note">
          {optional
            ? 'Review the equipment and starting shot in your shared recipe.'
            : 'Choose your equipment and a starting shot before using the simulator.'}{' '}
          If you are unsure, choose a generic option. Its parameters are estimates, not measurements
          of your equipment.
        </p>
        {!catalog ? (
          <>
            <h3 ref={headingRef} tabIndex={-1}>
              Loading equipment choices
            </h3>
            {catalogError ? (
              <>
                <p role="alert">{catalogError}</p>
                <button className="button" type="button" onClick={onRetry} disabled={!onRetry}>
                  Retry loading equipment
                </button>
              </>
            ) : (
              <p role="status">Loading the engine and equipment catalogue…</p>
            )}
          </>
        ) : (
          <>
            <h3 ref={headingRef} tabIndex={-1}>
              Step {step + 1} of 3:{' '}
              {['Equipment and beans', 'Starting shot', 'Review your setup'][step]}
            </h3>
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (step < 2) next();
                else void save();
              }}
            >
              <fieldset disabled={saving} className="equipment-setup-fields">
                <legend className="visually-hidden">
                  {step === 0 ? 'Equipment choices' : step === 1 ? 'Starting shot' : 'Setup review'}
                </legend>
                {step === 0 && (
                  <div className="equipment-setup-grid">
                    {GEARS.map((gear) => (
                      <label key={gear}>
                        {LABELS[gear]}
                        <select
                          value={choices[gear]}
                          required
                          onChange={(event) => choose(gear, event.target.value)}
                        >
                          <option value="">Choose {gear === 'bean' ? 'beans' : `a ${gear}`}</option>
                          {canKeep && currentChoices(form)[gear] === KEEP && (
                            <option value={KEEP}>
                              Keep current custom {gear === 'bean' ? 'bean details' : gear}
                            </option>
                          )}
                          {presets(catalog, gear).map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.flags.includes('generic') ||
                              (gear === 'bean' && preset.id === 'medium-washed-arabica')
                                ? 'Generic / unknown · '
                                : ''}
                              {preset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
                {step === 1 && (
                  <>
                    <div className="equipment-setup-grid">
                      <label>
                        Dose (g)
                        <input
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={current.prep.dose_g}
                          onChange={(event) => patch('prep', { dose_g: event.target.value })}
                        />
                      </label>
                      <label>
                        Target beverage (g)
                        <input
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={current.stop.beverage_g}
                          onChange={(event) => patch('stop', { beverage_g: event.target.value })}
                        />
                      </label>
                      <label>
                        Brew temperature (°C)
                        <input
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={current.machine.temperature_c}
                          placeholder={
                            machinePreset?.temperature_c === undefined
                              ? 'Model default'
                              : `Preset: ${machinePreset.temperature_c} °C`
                          }
                          onChange={(event) =>
                            patch('machine', { temperature_c: event.target.value })
                          }
                        />
                      </label>
                      {current.grinder.mode !== 'psd' && (
                        <label>
                          {current.grinder.by === 'gap' ? 'Burr gap (µm)' : 'Grinder setting'}
                          <input
                            type="number"
                            step="any"
                            inputMode="decimal"
                            value={
                              current.grinder.by === 'gap'
                                ? current.grinder.gap_um
                                : current.grinder.setting
                            }
                            placeholder={
                              grinderPreset ? `Preset: ${grinderPreset.dial.default}` : undefined
                            }
                            onChange={(event) =>
                              patch(
                                'grinder',
                                current.grinder.by === 'gap'
                                  ? { gap_um: event.target.value }
                                  : { setting: event.target.value },
                              )
                            }
                          />
                        </label>
                      )}
                    </div>
                    {current.grinder.mode === 'psd' ? (
                      <p className="note">
                        Your measured particle-size distribution is retained; it has no grinder dial
                        to set here.
                      </p>
                    ) : (
                      grinderPreset && (
                        <p className="note">
                          Grind setting uses this grinder’s {grinderPreset.dial.label}. Its stated
                          dial range is {grinderPreset.dial.min}–{grinderPreset.dial.max}.
                        </p>
                      )
                    )}
                    <p className="note">
                      Target beverage is the pump-stop mass. An unvented machine can add drip
                      afterward. An empty temperature keeps the machine or model default.
                    </p>
                  </>
                )}
                {step === 2 && (
                  <>
                    <dl className="equipment-setup-review">
                      {GEARS.map((gear) => (
                        <div key={gear}>
                          <dt>{LABELS[gear]}</dt>
                          <dd>{displayChoice(gear)}</dd>
                        </div>
                      ))}
                      <div>
                        <dt>Dose</dt>
                        <dd>{current.prep.dose_g} g</dd>
                      </div>
                      <div>
                        <dt>Target beverage</dt>
                        <dd>
                          {current.stop.beverage_g
                            ? `${current.stop.beverage_g} g at pump stop`
                            : `Current time stop: ${current.stop.time_s} s`}
                        </dd>
                      </div>
                      <div>
                        <dt>Brew temperature</dt>
                        <dd>
                          {current.machine.temperature_c
                            ? `${current.machine.temperature_c} °C`
                            : machinePreset?.temperature_c === undefined
                              ? 'Model default'
                              : `Machine preset: ${machinePreset.temperature_c} °C`}
                        </dd>
                      </div>
                    </dl>
                    <p className="note">
                      Other recipe details are retained. You can edit the full recipe in Lab after
                      setup.
                    </p>
                  </>
                )}
              </fieldset>
              {problem && (
                <p ref={errorRef} role="alert" tabIndex={-1} className="equipment-setup-error">
                  {problem}
                </p>
              )}
              <div className="equipment-setup-actions">
                {step > 0 && (
                  <button
                    className="button"
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setProblem(null);
                      setStep((value) => value - 1);
                    }}
                  >
                    Back
                  </button>
                )}
                <button
                  className="button primary"
                  type="submit"
                  aria-disabled={saving || undefined}
                >
                  {saving
                    ? 'Checking setup…'
                    : step === 0
                      ? 'Next: starting shot'
                      : step === 1
                        ? 'Review setup'
                        : optional
                          ? 'Save equipment changes'
                          : 'Start simulating'}
                </button>
              </div>
            </form>
          </>
        )}
        {optional && (
          <button className="button" type="button" onClick={cancel}>
            Cancel equipment changes
          </button>
        )}
        {catalog && (
          <div>
            <button className="button" type="button" onClick={startClean}>
              Start with a clean recipe
            </button>
            <p className="note">
              This clears the wizard’s advanced inputs and starts equipment choices again. Your
              original recipe is kept until you confirm the new setup.
            </p>
          </div>
        )}
        <p className="note">
          Your full recipe stays in this browser. A small setup cookie remembers completion; if
          browser storage is blocked, setup works for this session.
        </p>
      </div>
    </dialog>
  );
}

/** Required first-visit setup; mount inside the shared shot provider. */
export function EquipmentSetupGate({ children }: { children: ReactNode }) {
  const form = useShotStore((state) => state.form);
  const catalog = useShotStore((state) => state.catalog);
  const catalogError = useShotStore((state) => state.catalogError);
  const controls = useOptionalSharedShotRun();
  const [storage] = useState(createSetupStorage);
  const [record] = useState(() => storage.load());
  const [prefill] = useState(hasValidDraft);
  const [restored, setRestored] = useState(record === null);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const focusPending = useRef(false);
  const recordValid = validRecord(record, catalog);
  const completed = sessionComplete || (recordValid && restored);
  const restoring =
    !!record && !sessionComplete && ((!catalog && !catalogError) || (recordValid && !restored));
  const open = editing || (!completed && !restoring);

  useLayoutEffect(() => {
    if (!record || !recordValid || restored || sessionComplete) return;
    // The Lab already restored a valid draft. Without one, recover the full
    // saved setup before mounting the workspace, without creating an Undo.
    if (!prefill) {
      const imported = recipeToForm(record.recipe);
      if (imported.ok) useShotStore.setState({ form: imported.form, undo: null });
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Complete restoration from external browser storage before mounting its consumers.
    setRestored(true);
  }, [record, recordValid, restored, sessionComplete, prefill]);

  useLayoutEffect(() => {
    if (!open && focusPending.current) {
      buttonRef.current?.focus();
      focusPending.current = false;
    }
  }, [open]);
  const close = () => {
    focusPending.current = true;
    setEditing(false);
  };
  const complete = (next: RecipeForm, recipe: Recipe) => {
    try {
      const result = storage.complete({
        schema: 'puckworks.equipment-setup/1',
        recipe,
        completedAt: new Date().toISOString(),
      });
      setNotice(result.notice);
    } catch {
      setNotice(
        'Setup is ready for this session. Browser storage is unavailable, so you may need to set it up again next visit.',
      );
    }
    useShotStore.getState().loadForm(next, 'Undo equipment setup');
    focusPending.current = true;
    setSessionComplete(true);
    setEditing(false);
  };
  return (
    <>
      {restoring && (
        <p role="status" className="equipment-setup-bar">
          Loading your saved equipment setup…
        </p>
      )}
      {completed && (
        <div className="equipment-setup-bar">
          <button ref={buttonRef} type="button" className="button" onClick={() => setEditing(true)}>
            Equipment setup
          </button>
          {notice && (
            <p role="status" className="note">
              {notice}
            </p>
          )}
        </div>
      )}
      {completed && children}
      {open && (
        <SetupDialog
          catalog={catalog}
          catalogError={catalogError}
          form={form}
          prefill={completed || prefill}
          optional={completed}
          onRetry={controls?.retryCatalog}
          onCancel={close}
          onComplete={complete}
        />
      )}
    </>
  );
}
