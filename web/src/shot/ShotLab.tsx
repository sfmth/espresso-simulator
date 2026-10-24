// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The M1 Lab view (docs/PLAN.md §9, §12 M1): describe a shot from presets or
 * from scratch, watch a live tier-0 preview while editing, run the standard
 * model, and read the results: shot graph, summary tiles, particle sizes,
 * compounds with provenance, the puck cross-section, sweeps, pinned runs and
 * exports. Everything runs in the browser's engine workers.
 */
import { useEffect, useMemo } from 'react';
import { HelpButton } from '../help/HelpButton';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Tabs } from '../components/Tabs';
import { checkShotResult } from '../engine/shotCheck';
import { toJsonResult } from '../engine/shotData';
import { CompoundTable } from './CompoundTable';
import { CupChemistryPanel } from './CupChemistryPanel';
import { CrossSection } from './CrossSection';
import { seriesCsv } from './csv';
import { datedName, downloadCsv, downloadJson } from './download';
import type { EditorContextValue } from './editor/context';
import { fieldId } from './fields';
import { focusSoon } from './focus';
import { routeNotes } from './notes';
import { PinsPanel } from './PinsPanel';
import { registryIndex } from './provenance';
import { PsdPanel, type PsdRun } from './PsdPanel';
import { ProvenancePanel } from './ProvenancePanel';
import { RecipeEditor } from './RecipeEditor';
import { RecipeFiles } from './RecipeFiles';
import { physicalKey, sectionOf, type FormErrors } from './recipeForm';
import type { Recipe } from '../engine/shotTypes';
import { ShotCharts } from './ShotCharts';
import type { ChartRun } from './shotChartData';
import { MAX_PINS, useShotStore, type OutputTab } from './shotStore';
import { browserStorage, saveDraft } from './storage';
import { SummaryTiles } from './SummaryTiles';
import { SweepPanel } from './SweepPanel';
import { useShotRun, type ShotRunControls } from './useShotRun';
import { useShotCatalog } from './useShotCatalog';
import { useOptionalSharedShotRun } from './ShotRunContext';
import { useUncertainty } from './useUncertainty';
import { UncertaintyPanel } from './UncertaintyPanel';
import { TastePanel } from './TastePanel';

/** Quiet time before the draft is saved to this browser's storage. */
const DRAFT_SAVE_MS = 500;

/** Standalone mounting retains the component's test/embedding contract. */
function StandaloneShotLab({ active }: { active: boolean }) {
  const { retry } = useShotCatalog();
  const controls = useShotRun();
  return <ShotLabView controls={controls} retryCatalog={retry} active={active} />;
}
export function ShotLab({ active = true }: { active?: boolean }) {
  const shared = useOptionalSharedShotRun();
  return shared ? (
    <ShotLabView controls={shared} retryCatalog={shared.retryCatalog} active={active} />
  ) : (
    <StandaloneShotLab active={active} />
  );
}
function ShotLabView({
  controls,
  retryCatalog: retry,
  active,
}: {
  controls: ShotRunControls;
  retryCatalog: () => void;
  active: boolean;
}) {
  const catalog = useShotStore((s) => s.catalog);
  const catalogError = useShotStore((s) => s.catalogError);
  const { validation, key, run, cancel, retry: retryRun } = controls;
  const uncertainty = useUncertainty(validation.ok ? validation.recipe : null);
  const notices = useShotStore((s) => s.notices);
  const dismissNotices = useShotStore((s) => s.dismissNotices);
  const revealField = useShotStore((s) => s.revealField);
  const runState = useShotStore((s) => s.run);
  const check = useShotStore((s) => s.check);
  const livePreview = useShotStore((s) => s.livePreview);
  const setLivePreview = useShotStore((s) => s.setLivePreview);
  const pins = useShotStore((s) => s.pins);
  const showPins = useShotStore((s) => s.showPins);
  const pinLatest = useShotStore((s) => s.pinLatest);
  const outputTab = useShotStore((s) => s.outputTab);
  const setOutputTab = useShotStore((s) => s.setOutputTab);
  const tier = useShotStore((s) => s.form.numerics.tier);
  const registry = useMemo(() => registryIndex(catalog), [catalog]);

  // Keep the current recipe as a draft in this browser (if it allows storage).
  const draftJson = validation.ok ? JSON.stringify(validation.recipe) : null;
  useEffect(() => {
    if (draftJson === null) return;
    const timer = setTimeout(() => {
      saveDraft(browserStorage(), JSON.parse(draftJson) as Recipe);
    }, DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [draftJson]);

  const latest = runState.latest;
  const current = latest !== null && key !== null && latest.key === key;
  const stale = latest !== null && !current;
  const checkCurrent = check !== null && check.key === key;
  const failure = checkCurrent && check.error ? check : null;
  const buildError = failure && failure.errorKind !== 'engine' ? failure : null;
  const engineError = failure && failure.errorKind === 'engine' ? failure : null;

  const errors: FormErrors = useMemo(() => {
    const merged: FormErrors = validation.ok ? {} : { ...validation.errors };
    if (buildError?.errorPath && buildError.error && !merged[buildError.errorPath]) {
      merged[buildError.errorPath] = buildError.error;
    }
    return merged;
  }, [validation, buildError]);

  const lastBuild = check?.build ?? latest?.build ?? null;
  const editorContext: EditorContextValue | null = useMemo(
    () =>
      catalog
        ? {
            catalog,
            errors,
            notes: routeNotes(lastBuild?.derived.notes ?? [], catalog),
            notesStale: !(checkCurrent && check?.build),
            build: lastBuild,
            buildStale: !(checkCurrent && check?.build),
          }
        : null,
    [catalog, errors, lastBuild, checkCurrent, check],
  );

  // A light check of every result against the contract's shape (a newer or broken core).
  const resultProblems = useMemo(
    () => (latest ? checkShotResult(toJsonResult(latest.result)) : []),
    [latest],
  );

  const chartRuns: ChartRun[] = useMemo(
    () =>
      latest
        ? [
            {
              label: latest.kind === 'preview' ? 'This run (preview)' : 'This run',
              slot: 0,
              result: latest.result,
            },
            // A pin of the very result on screen would only hide it.
            ...(showPins
              ? pins
                  .filter((p) => p.outcome !== latest)
                  .map((p) => ({ label: p.label, slot: p.slot, result: p.outcome.result }))
              : []),
          ]
        : [],
    [latest, pins, showPins],
  );
  const psdRuns: PsdRun[] = useMemo(
    () =>
      latest
        ? [
            { label: 'This run', slot: 0, outcome: latest },
            ...(showPins
              ? pins
                  .filter((p) => p.outcome !== latest)
                  .map((p) => ({ label: p.label, slot: p.slot, outcome: p.outcome }))
              : []),
          ]
        : [],
    [latest, pins, showPins],
  );

  if (!catalog || !editorContext) {
    return (
      <section className="panel" aria-labelledby="shot-title">
        <div className="panel-header">
          <h2 id="shot-title">Shot lab</h2>
        </div>
        {catalogError ? (
          <div className="run-error" role="alert">
            <p>The engine could not load the presets and the parameter registry: {catalogError}</p>
            <button type="button" className="button" onClick={retry}>
              Try again
            </button>
          </div>
        ) : (
          <p className="note" role="status">
            Starting the engine and loading the presets…
          </p>
        )}
      </section>
    );
  }

  const fullRunning = runState.fullRunning;
  const canPin =
    latest !== null && pins.length < MAX_PINS && !pins.some((p) => p.outcome === latest);
  const anyRunning = fullRunning || runState.previewRunning;
  let status: string;
  if (!validation.ok) status = 'Check the highlighted inputs.';
  else if (fullRunning) status = `Running tier ${tier}…`;
  else if (buildError) status = 'The model cannot build these inputs; see the message.';
  else if (engineError) status = 'The engine failed; press Retry to run it again.';
  else if (current && latest.kind === 'full') {
    status = `Up to date: tier ${latest.tier}, ${latest.coreMs.toFixed(0)} ms in the engine.`;
  } else if (current) status = 'Preview (tier 0). Press Run for the tier-1 result.';
  else if (runState.previewRunning) status = 'Updating the preview…';
  else if (runState.status === 'cancelled') status = 'Cancelled. Press Run to start it again.';
  else if (!livePreview) status = 'Press Run to simulate these inputs.';
  else status = 'Starting…';

  const warnings = latest?.result.diagnostics.warnings ?? [];
  const allNotes = lastBuild?.derived.notes ?? [];
  const thinned = latest !== null && latest.totalPoints > latest.result.series.t_s.length;

  return (
    <section className="panel shot-lab" aria-labelledby="shot-title">
      <div className="panel-header">
        <h2 id="shot-title">Shot lab</h2>
        <p className="panel-intro">
          Describe a shot with presets or from scratch: any basket shape, any grinder, any machine
          program. A quick tier-0 preview follows your edits; Run solves the standard model. Most
          gear numbers are estimates, flagged as such, and every value shows where it comes from.
        </p>
      </div>
      <div className="shot-layout">
        <div className="editor-column">
          <RecipeFiles validation={validation} />
          {notices.length > 0 && (
            <div className="build-notes" role="status">
              {notices.map((n) => (
                <p key={n}>{n}</p>
              ))}
              <button type="button" className="button button-small" onClick={dismissNotices}>
                Dismiss
              </button>
            </div>
          )}
          {active && (
            <ErrorBoundary name="the recipe editor">
              <RecipeEditor context={editorContext} onSubmit={run} />
            </ErrorBoundary>
          )}
        </div>
        <div className="results-column">
          <div className="run-bar">
            <div className="actions">
              <button
                id="shot-run"
                type="button"
                className="button button-primary"
                disabled={!validation.ok}
                onClick={run}
              >
                Run (tier {tier})
              </button>
              {/* aria-disabled rather than disabled: focus stays on the button after use. */}
              <button
                id="shot-cancel"
                type="button"
                className="button"
                aria-disabled={anyRunning ? undefined : true}
                onClick={() => {
                  if (anyRunning) cancel();
                }}
              >
                Cancel
              </button>
              <button
                id="shot-pin"
                type="button"
                className="button"
                aria-disabled={canPin ? undefined : true}
                onClick={() => {
                  if (canPin) pinLatest();
                }}
              >
                Pin this run
              </button>
            </div>
            <div className="field field-check">
              <div className="field-head">
                <input
                  id="live-preview"
                  type="checkbox"
                  checked={livePreview}
                  onChange={(e) => setLivePreview(e.target.checked)}
                />
                <label htmlFor="live-preview">Live preview while editing</label>
                <HelpButton term="numerical" label="Live preview" />
              </div>
            </div>
            <p className="run-status" id="shot-status">
              {status}
            </p>
            {pins.length >= MAX_PINS && (
              <p className="note">Up to {MAX_PINS} pinned runs: unpin one to pin another.</p>
            )}
            <p className="visually-hidden" role="status">
              {runState.announcement}
            </p>
          </div>

          <div className="results" data-stale={stale ? 'true' : undefined} aria-busy={anyRunning}>
            {buildError && (
              <div className="run-error" role="alert">
                <p>The model cannot build these inputs: {buildError.error}</p>
                {buildError.errorPath && (
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => {
                      const path = buildError.errorPath ?? '';
                      // Open the section (and Advanced) that holds the field, then focus it.
                      revealField(path);
                      focusSoon(
                        [
                          fieldId(path),
                          `override-reset-${path.replace(/^overrides\./, '')}`,
                          `section-${sectionOf(path)}-summary`,
                        ],
                        10,
                        () => useShotStore.getState().clearReveal(),
                      );
                    }}
                  >
                    Go to the field
                  </button>
                )}
              </div>
            )}
            {engineError && (
              <div className="run-error" role="alert">
                <p>
                  The engine failed and was restarted: {engineError.error}. This is a bug in the
                  simulator, not in your inputs.
                </p>
                {engineError.errorDetail && (
                  <details className="panic-details">
                    <summary>Technical details for a bug report</summary>
                    <pre tabIndex={0}>{engineError.errorDetail}</pre>
                  </details>
                )}
                <button type="button" className="button button-small" onClick={retryRun}>
                  Retry
                </button>
              </div>
            )}
            {resultProblems.length > 0 && (
              <div className="run-warning" role="note">
                <p className="build-notes-title">
                  The engine’s result does not have the expected shape, so some panels may be
                  incomplete:
                </p>
                <ul>
                  {resultProblems.slice(0, 3).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {!failure && runState.status === 'error' && runState.error && (
              <p className="run-error" role="alert">
                The run failed: {runState.error}
              </p>
            )}
            {latest && (
              <p className="result-badges">
                {stale && <span className="stale-badge">Results for earlier inputs</span>}
                <span className={latest.kind === 'preview' ? 'stale-badge' : 'tier-badge'}>
                  {latest.kind === 'preview' ? 'Fast preview' : 'Standard simulation'}
                </span>
              </p>
            )}
            {warnings.length > 0 && (
              <div className="run-warning" role="note">
                <p className="build-notes-title">Solver warnings:</p>
                <ul>
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <SummaryTiles
              outcome={latest}
              uncertainty={current && uncertainty.current ? uncertainty.outcome?.result : null}
            />
            {allNotes.length > 0 && (
              <details className="model-notes">
                <summary>Model notes for this recipe ({allNotes.length})</summary>
                <ul>
                  {allNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </details>
            )}
            {latest && (
              <div className="actions export-actions">
                <span className="note">Export:</span>
                <button
                  id="download-full-report"
                  type="button"
                  className="button button-small"
                  onClick={() =>
                    downloadJson(datedName('full-report', 'json'), {
                      schema: 'puckworks.report/1',
                      core_version: catalog.coreVersion,
                      parameter_registry: catalog.registry,
                      created_at: new Date().toISOString(),
                      central: {
                        recipe: latest.recipe,
                        build: latest.build,
                        result: toJsonResult(latest.result),
                        taste: latest.taste ?? null,
                        tier: latest.tier,
                        kind: latest.kind,
                        current,
                        core_ms: latest.coreMs,
                      },
                      uncertainty: uncertainty.outcome,
                      uncertainty_matches_current_inputs_and_settings: uncertainty.current,
                      uncertainty_matches_central_recipe:
                        uncertainty.outcome !== null &&
                        physicalKey(uncertainty.outcome.recipe) === latest.key,
                      interpretation:
                        'Scenario percentiles omit model error, Tier-0/Tier-1 discrepancy and sensory-model uncertainty. Taste indices are unvalidated relative heuristics.',
                    })
                  }
                >
                  Full report JSON
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() =>
                    downloadJson(datedName('result', 'json'), toJsonResult(latest.result))
                  }
                >
                  Result JSON
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => downloadCsv(datedName('series', 'csv'), seriesCsv(latest.result))}
                >
                  Series CSV
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => downloadJson(datedName('recipe', 'json'), latest.recipe)}
                >
                  Recipe of this run
                </button>
                {thinned && (
                  <span className="note">
                    The series hold {latest.result.series.t_s.length.toLocaleString('en-US')} of{' '}
                    {latest.totalPoints.toLocaleString('en-US')} output times.
                  </span>
                )}
              </div>
            )}
            <Tabs<OutputTab>
              idPrefix="shot-out"
              label="Results"
              className="output-tabs"
              value={outputTab}
              onChange={setOutputTab}
              tabs={[
                {
                  id: 'shot',
                  label: 'Shot graph',
                  render: () =>
                    latest ? (
                      <ErrorBoundary name="the shot graph">
                        <div className="panel-stack">
                          <ShotCharts runs={chartRuns} />
                          <PinsPanel
                            current={current ? latest : null}
                            currentRecipe={validation.ok ? validation.recipe : null}
                            catalog={catalog}
                          />
                        </div>
                      </ErrorBoundary>
                    ) : (
                      <p className="note">The shot graph appears after the first run.</p>
                    ),
                },
                {
                  id: 'uncertainty',
                  label: 'Uncertainty',
                  render: () => (
                    <ErrorBoundary name="input uncertainty">
                      <UncertaintyPanel
                        validation={validation}
                        controls={uncertainty}
                        central={current ? latest : null}
                        catalog={catalog}
                      />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: 'taste',
                  label: 'Taste estimates',
                  render: () => (
                    <ErrorBoundary name="taste estimates">
                      <TastePanel
                        outcome={latest}
                        stale={stale}
                        uncertainty={
                          current && uncertainty.current
                            ? (uncertainty.outcome?.result ?? null)
                            : null
                        }
                      />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: 'particles',
                  label: 'Particles',
                  render: () => (
                    <ErrorBoundary name="the particle sizes">
                      <PsdPanel runs={psdRuns} />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: 'compounds',
                  label: 'Compounds',
                  render: () => (
                    <ErrorBoundary name="the compound table">
                      <CompoundTable outcome={latest} registry={registry} catalog={catalog} />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: 'chemistry',
                  label: 'Cup chemistry',
                  render: () => (
                    <ErrorBoundary name="cup chemistry">
                      <CupChemistryPanel outcome={latest} />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: 'section',
                  label: 'Cross-section',
                  render: () =>
                    latest ? (
                      <ErrorBoundary name="the cross-section">
                        <CrossSection outcome={latest} />
                      </ErrorBoundary>
                    ) : (
                      <p className="note">The cross-section appears after the first run.</p>
                    ),
                },
                {
                  id: 'sweep',
                  label: 'Sweep',
                  render: () => (
                    <ErrorBoundary name="the sweep">
                      <SweepPanel validation={validation} catalog={catalog} />
                    </ErrorBoundary>
                  ),
                },
                {
                  id: 'provenance',
                  label: 'Provenance',
                  render: () => (
                    <ErrorBoundary name="the provenance">
                      <ProvenancePanel outcome={latest} registry={registry} catalog={catalog} />
                    </ErrorBoundary>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
