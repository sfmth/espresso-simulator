// SPDX-License-Identifier: GPL-2.0-or-later
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { tabId } from '../components/ModeTabs';
import { useEngine } from '../engine/EngineContext';
import { isAbortError } from '../engine/engine';
import type { Catalog } from '../engine/shotTypes';
import { useOptionalSharedShotRun } from '../shot/ShotRunContext';
import { DEFAULT_RECIPE, defaultForm, formToRecipe, recipeToForm } from '../shot/recipeForm';
import { useShotStore } from '../shot/shotStore';
import { browserStorage, loadDraft } from '../shot/storage';
import { useAppStore, type Mode } from '../store';
import { useEquipmentStore } from './inferenceStorage';
import { createSetupStorage, type EquipmentSetupRecord } from './setupStorage';
import './EquipmentSetup.css';

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

function WelcomeDialog({ onSetup, onDefaults }: { onSetup: () => void; onDefaults: () => void }) {
  const engine = useEngine();
  const catalog = useShotStore((state) => state.catalog);
  const catalogError = useShotStore((state) => state.catalogError);
  const controls = useOptionalSharedShotRun();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const controller = useRef<AbortController | null>(null);
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

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
    if (problem) errorRef.current?.focus();
  }, [problem]);

  const openSetup = () => {
    controller.current?.abort();
    controller.current = null;
    onSetup();
  };
  const skip = async () => {
    if (!catalog || checking || controller.current) return;
    const operation = new AbortController();
    controller.current = operation;
    setChecking(true);
    setProblem(null);
    try {
      // Skipping explicitly selects the documented defaults, including when a
      // previous draft contains invalid or custom inputs. Do not persist or
      // replace that draft until the native builder accepts the defaults.
      await engine.buildShotSpec(DEFAULT_RECIPE, { signal: operation.signal });
      operation.signal.throwIfAborted();
      if (controller.current !== operation) return;
      onDefaults();
    } catch (error) {
      if (!operation.signal.aborted && !isAbortError(error))
        setProblem(
          error instanceof Error ? error.message : 'The defaults could not be checked. Try again.',
        );
    } finally {
      if (controller.current === operation && !operation.signal.aborted) {
        controller.current = null;
        setChecking(false);
      }
    }
  };
  return (
    <dialog
      ref={dialogRef}
      className="equipment-setup-dialog"
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-intro`}
      onCancel={(event) => {
        event.preventDefault();
        // Escape opens setup without accepting defaults or changing the recipe.
        openSetup();
      }}
    >
      <div className="equipment-setup-content">
        <h2 id={`${id}-heading`} ref={headingRef} tabIndex={-1}>
          Welcome to Puckworks
        </h2>
        <p id={`${id}-intro`}>
          Set up your equipment using the illustrated settings. Lock what you know, record a shot,
          and find possible setups that explain it. Then use Dial in to plan your next shot.
        </p>
        <div className="equipment-setup-actions">
          <button className="button primary" type="button" onClick={openSetup}>
            Set up equipment
          </button>
          <button
            className="button"
            type="button"
            onClick={() => void skip()}
            disabled={!catalog}
            aria-disabled={checking || undefined}
          >
            {checking ? 'Checking defaults…' : 'Skip setup with defaults'}
          </button>
        </div>
        <p className="note">
          Defaults use generic equipment and an 18 g dose with a 36 g target. They are starting
          assumptions. Skipping replaces the current recipe with these defaults; you can revisit Set
          up equipment at any time.
        </p>
        {!catalog &&
          (catalogError ? (
            <div>
              <p role="alert">{catalogError}</p>
              <button
                className="button"
                type="button"
                onClick={controls?.retryCatalog}
                disabled={!controls?.retryCatalog}
              >
                Retry loading equipment
              </button>
            </div>
          ) : (
            <p role="status" className="note">
              Loading defaults… You can open equipment setup now.
            </p>
          ))}
        {problem && (
          <p ref={errorRef} role="alert" tabIndex={-1} className="equipment-setup-error">
            {problem}
          </p>
        )}
        <p className="note">
          Your equipment and shots stay in this browser. A fixed setup cookie remembers your choice;
          it contains no equipment data. If storage is blocked, you can work for this session.
        </p>
      </div>
    </dialog>
  );
}

/** First-visit choice; saved equipment is restored before mounting its consumers. */
export function EquipmentSetupGate({ children }: { children: ReactNode }) {
  const catalog = useShotStore((state) => state.catalog);
  const catalogError = useShotStore((state) => state.catalogError);
  const [storage] = useState(createSetupStorage);
  const [record] = useState(() => storage.load());
  const [prefill] = useState(hasValidDraft);
  const [restored, setRestored] = useState(record === null);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const focusMode = useRef<Mode | null>(null);
  const recordValid = validRecord(record, catalog);
  const completed = sessionComplete || (recordValid && restored);
  const restoring =
    !!record && !sessionComplete && ((!catalog && !catalogError) || (recordValid && !restored));
  const open = !completed && !restoring;

  useLayoutEffect(() => {
    if (!record || !recordValid || restored || sessionComplete) return;
    // A valid draft may contain newer changes than the completion snapshot.
    if (!prefill) {
      const imported = recipeToForm(record.recipe);
      if (imported.ok) useShotStore.setState({ form: imported.form, undo: null });
    }
    if (useAppStore.getState().mode === 'setup') useAppStore.getState().setMode('dial-in');
    setRestored(true);
  }, [record, recordValid, restored, sessionComplete, prefill]);

  useLayoutEffect(() => {
    if (!open && focusMode.current) {
      document.getElementById(tabId(focusMode.current))?.focus();
      focusMode.current = null;
    }
  }, [open]);

  const enter = (mode: Mode) => {
    focusMode.current = mode;
    useAppStore.getState().setMode(mode);
    setSessionComplete(true);
  };
  const skip = () => {
    // A completion marker can expire independently of retained hypotheses.
    // Choosing defaults must stop claiming that an older hypothesis is active.
    useEquipmentStore.getState().hydrate();
    if (useEquipmentStore.getState().document.activeId !== null) {
      try {
        useEquipmentStore.getState().update((document) => ({ ...document, activeId: null }));
      } catch (error) {
        // Keep another tab's saved document intact while honoring this session's
        // explicit choice, even when persistent storage cannot be changed.
        useEquipmentStore.setState((state) => ({
          document: { ...state.document, activeId: null },
          persistent: false,
          notice: `${error instanceof Error ? error.message : 'Equipment storage is unavailable.'} Defaults are active for this session. Saved alternatives are kept; the previous selection may return on your next visit.`,
        }));
      }
    }
    try {
      const result = storage.complete({
        schema: 'puckworks.equipment-setup/1',
        recipe: DEFAULT_RECIPE,
        completedAt: new Date().toISOString(),
      });
      setNotice(result.notice);
    } catch {
      setNotice(
        'Defaults are ready for this session. Browser storage is unavailable, so you may need to choose again next visit.',
      );
    }
    useShotStore.getState().loadForm(defaultForm(), 'Undo default equipment');
    enter('dial-in');
  };
  return (
    <>
      {restoring && (
        <p role="status" className="equipment-setup-bar">
          Loading your saved equipment setup…
        </p>
      )}
      {completed && (
        <>
          <div className="equipment-setup-bar">
            <button
              type="button"
              className="button"
              onClick={() => {
                useAppStore.getState().setMode('setup');
                document.getElementById(tabId('setup'))?.focus();
              }}
            >
              Equipment setup
            </button>
            {notice && (
              <p role="status" className="note">
                {notice}
              </p>
            )}
          </div>
          {children}
        </>
      )}
      {open && <WelcomeDialog onSetup={() => enter('setup')} onDefaults={skip} />}
    </>
  );
}
