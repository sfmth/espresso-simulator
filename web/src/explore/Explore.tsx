// SPDX-License-Identifier: GPL-2.0-or-later
import { lazy, Suspense, useMemo, useState } from 'react';
import type { ExploreResolution } from '../engine/exploreTypes';
import { useSharedShotRun } from '../shot/ShotRunContext';
import { useShotStore } from '../shot/shotStore';
import { ExploreSection } from './ExploreSection';
import { GuidedScenarios } from './GuidedScenarios';
import { ParticleInspector } from './ParticleInspector';
import { mapExploreRequest } from './exploreRequest';
import { frameAt, particleProfile } from './microstructure';
import { scenarioForm } from './scenarios';
import { useExploreState } from './useExploreState';
import { useMicrostructure } from './useMicrostructure';

const PuckView = lazy(() => import('./PuckView').then((module) => ({ default: module.PuckView })));
const fmt = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;

export function Explore({ active }: { active: boolean }) {
  const controls = useSharedShotRun();
  const run = useShotStore((s) => s.run);
  const catalog = useShotStore((s) => s.catalog);
  const check = useShotStore((s) => s.check);
  const undo = useShotStore((s) => s.undo);
  const outcome = run.latest;
  const view = useExploreState(outcome, active);
  const [resolution, setResolution] = useState<ExploreResolution>('standard');
  const [count, setCount] = useState(() => (phone() ? 5000 : 30000));
  const [particle, setParticle] = useState(0);
  const [cut, setCut] = useState(1);
  const [network, setNetwork] = useState(false);
  const packed = useMicrostructure(outcome, count, active);
  const selection = useMemo(
    () => ({
      snapshotIndex: view.snapshotIndex,
      column: view.selectedCell?.col ?? 0,
      depthCell: view.selectedCell?.cell ?? 0,
    }),
    [view.snapshotIndex, view.selectedCell?.col, view.selectedCell?.cell],
  );
  const frame = useMemo(
    () => (outcome && packed.model ? frameAt(outcome, packed.model, selection) : null),
    [outcome, packed.model, selection],
  );
  const index = Math.max(0, Math.min(particle, count - 1));
  const profile = useMemo(
    () =>
      outcome && packed.model ? particleProfile(outcome, packed.model, index, selection) : null,
    [outcome, packed.model, index, selection],
  );
  const micro = outcome?.result.spatial.micro;
  const stale = outcome && outcome.key !== controls.key;
  const start = () => {
    const target =
      check?.key === controls.key && check.build ? check.build.spec : outcome?.build.spec;
    controls.runExplore(
      mapExploreRequest({
        resolution,
        selected: view.selectedCell,
        source: outcome
          ? {
              columns: outcome.result.spatial.columns,
              depthM: outcome.result.spatial.depth_m,
              bedHeightM: outcome.result.summary.bed_height_m,
              edgeAreaFraction: outcome.build.spec.bed.heterogeneity.edge_area_fraction,
            }
          : null,
        target: target
          ? {
              columns: target.bed.heterogeneity.columns,
              edgeAreaFraction: target.bed.heterogeneity.edge_area_fraction,
            }
          : null,
      }),
    );
  };
  const selectedSnapshot = view.snapshot;
  return (
    <div className="explore panel-stack">
      <div className="explore-heading">
        <div>
          <h2>Explore</h2>
          <p>Look inside a representative piece of your puck.</p>
        </div>
        <span className="tag">Experimental · coupled to Tier 1</span>
      </div>
      <section className="panel panel-stack" aria-label="Explore run controls">
        <div className="explore-controls">
          <label>
            Simulation resolution
            <select
              value={resolution}
              onChange={(e) => {
                const next = e.target.value as ExploreResolution;
                setResolution(next);
                setCount(next === 'high' ? (phone() ? 25000 : 150000) : phone() ? 5000 : 30000);
              }}
            >
              <option value="standard">Standard · 30 depth cells</option>
              <option value="high">High resolution · 150 cells (5×)</option>
            </select>
          </label>
          <label>
            Displayed particles
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
              <option value={5000}>5,000 · mobile</option>
              <option value={25000}>25,000 · mobile 5×</option>
              <option value={30000}>30,000 · desktop</option>
              <option value={150000}>150,000 · desktop 5×</option>
            </select>
          </label>
          <button
            className="button primary"
            type="button"
            disabled={!controls.validation.ok || !catalog || run.fullRunning}
            onClick={start}
          >
            {run.fullRunning ? 'Running…' : 'Run Explore'}
          </button>
          {run.fullRunning && (
            <button className="button" type="button" onClick={controls.cancel}>
              Cancel
            </button>
          )}
        </div>
        <p className="note">
          High resolution refines the current parallel 1D solver by 5× in depth and can take longer.
          It is not the future 2D Tier 2 model. Displayed particle count changes visual detail; it
          does not change the extraction calculation. Edit the shared recipe in Lab, or load a
          scenario below.
        </p>
        {!controls.validation.ok && (
          <p role="alert">The shared recipe needs attention in Lab before it can run.</p>
        )}
        {run.error && (
          <p role="alert">
            {run.error}{' '}
            <button className="button" type="button" onClick={controls.retry}>
              Retry
            </button>
          </p>
        )}
        {stale && (
          <p role="status">
            Showing run {outcome.seq} from earlier recipe inputs. Run Explore to update it.
          </p>
        )}
        {outcome && (
          <p>
            Run {outcome.seq} ·{' '}
            {micro?.resolution === 'high'
              ? 'Refined 1D · 5× depth'
              : outcome.tier === 0
                ? 'Tier 0 preview'
                : 'Tier 1 · standard'}{' '}
            · {outcome.result.spatial.depth_m.length} depth cells · cup EY{' '}
            {fmt(outcome.result.summary.ey * 100)}% · {fmt(outcome.result.summary.shot_time_s, 1)} s
            · core {fmt(outcome.coreMs, 0)} ms
          </p>
        )}
      </section>
      {!outcome && (
        <p className="note">
          Run Explore to load the shared recipe and its selected-cell particle data.
        </p>
      )}
      {outcome && (
        <>
          <section className="panel explore-timeline" aria-label="Explore timeline">
            <button
              className="button"
              type="button"
              onClick={view.playing ? view.pause : view.play}
              disabled={view.frameCount < 2}
            >
              {view.playing ? 'Pause' : 'Play'}
            </button>
            <label>
              Shot time
              <input
                type="range"
                min={0}
                max={Math.max(0, view.frameCount - 1)}
                value={view.snapshotIndex}
                onChange={(e) => view.selectSnapshot(Number(e.target.value))}
              />
            </label>
            <output aria-live="off">
              {fmt(selectedSnapshot?.t_s, 1)} s · snapshot {view.snapshotIndex + 1}/
              {view.frameCount}
            </output>
            <p className="note">
              One stored snapshot drives the cross-section, particle colours and shell profile.
              Playback starts only when requested.
            </p>
          </section>
          <div className="explore-grid">
            <section
              className="panel panel-stack explore-volume"
              aria-labelledby="explore-volume-title"
            >
              <h3 id="explore-volume-title">Representative particle volume</h3>
              <div className="explore-controls">
                <label>
                  Cutaway plane
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={cut}
                    onChange={(e) => setCut(Number(e.target.value))}
                  />
                </label>
                <label className="explore-checkbox">
                  <input
                    type="checkbox"
                    checked={network}
                    onChange={(e) => setNetwork(e.target.checked)}
                  />
                  Illustrative pore network
                </label>
              </div>
              {packed.loading && <p role="status">Packing {count.toLocaleString()} particles…</p>}
              {packed.error && <p role="alert">{packed.error}</p>}
              {packed.model && (
                <Suspense fallback={<p>Loading 3D view…</p>}>
                  <PuckView
                    model={packed.model}
                    particleEy={frame?.particleEy ?? null}
                    selectedParticle={index}
                    onSelect={setParticle}
                    active={active}
                    cut={cut}
                    showNetwork={network}
                  />
                </Suspense>
              )}
              <p className="note">
                The cube is an illustrative representative volume of the selected cell, not a
                scanned puck or a map of real cracks. Particle positions and the small void lattice
                do not feed back into the shot solver.
              </p>
              {frame && (
                <>
                  <dl className="explore-metrics">
                    <div>
                      <dt>Weighted particle EY</dt>
                      <dd>{fmt(frame.meanEy === null ? null : frame.meanEy * 100)}%</dd>
                    </div>
                    <div>
                      <dt>Continuum cell EY</dt>
                      <dd>{fmt(frame.targetEy === null ? null : frame.targetEy * 100)}%</dd>
                    </div>
                    <div>
                      <dt>Difference (percentage points)</dt>
                      <dd>{fmt(frame.consistencyErrorPoints, 6)}</dd>
                    </div>
                    <div>
                      <dt>Local liquid solubles</dt>
                      <dd>{fmt(frame.localConcentrationKgM3)} kg/m³</dd>
                    </div>
                    <div>
                      <dt>Column flow</dt>
                      <dd>{fmt(frame.columnFlowMlS)} mL/s</dd>
                    </div>
                    <div>
                      <dt>Bed temperature (one node)</dt>
                      <dd>{fmt(frame.bedTemperatureC, 1)} °C</dd>
                    </div>
                  </dl>
                  {frame.unavailableReason && (
                    <p role="status">
                      {frame.unavailableReason} Run Explore for the selected cell.
                    </p>
                  )}
                </>
              )}
              {packed.model && (
                <details>
                  <summary>Packing and network diagnostics</summary>
                  <p>
                    Seed {packed.model.seed}; generation {fmt(packed.runtimeMs, 0)} ms. Soft-sphere
                    relaxation: {packed.model.packing.iterations} iterations;{' '}
                    {packed.model.packing.overlapPairs.toLocaleString()} residual overlapping pairs
                    {packed.model.packing.auditComplete
                      ? ' (complete audit)'
                      : ' (bounded audit, lower bound)'}
                    , largest relative overlap{' '}
                    {fmt(packed.model.packing.maxOverlapFraction * 100, 1)}%.
                  </p>
                  <p>
                    Pore-lattice CG residual{' '}
                    {packed.model.network.relativeResidual.toExponential(2)};{' '}
                    {packed.model.network.converged ? 'converged' : 'did not converge'};{' '}
                    {packed.model.network.connected
                      ? 'through path present'
                      : 'no through path on this lattice'}
                    . Node potential is dimensionless (inlet 1, outlet 0); it is not the shot
                    pressure. Edge flux is normalized by inlet flux.
                  </p>
                  <ul>
                    {packed.model.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
            <ExploreSection
              outcome={outcome}
              snapshotIndex={view.snapshotIndex}
              selected={view.selectedCell}
              onSelect={view.selectCell}
            />
          </div>
          {packed.model && (
            <ParticleInspector
              profile={profile}
              index={index}
              count={count}
              onSelect={setParticle}
            />
          )}
        </>
      )}
      <GuidedScenarios
        disabled={run.fullRunning}
        onLoad={(id) => useShotStore.getState().loadForm(scenarioForm(id), 'Undo scenario')}
      />
      {undo && (
        <button className="button" type="button" onClick={() => useShotStore.getState().undoLast()}>
          {undo.label}
        </button>
      )}
      <p className="sr-only" role="status">
        {run.announcement}
      </p>
    </div>
  );
}
