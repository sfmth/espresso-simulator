// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { SOURCE_URL } from './config';
import { EngineError, type CallOptions, type Engine, type Timed } from './engine/engine';
import { EngineContext } from './engine/EngineContext';
import type { SphereReleaseParams, SphereRunData } from './engine/types';
import { TAU_MESSAGE } from './lab/sphereForm';
import { resetAppStore } from './store';

// jsdom has no canvas: replace uPlot with a stand-in.
vi.mock('uplot', () => ({
  default: class FakeUPlot {
    static pxRatio = 1;
    constructor(_options: unknown, _data: unknown, target: HTMLElement) {
      target.append(Object.assign(document.createElement('div'), { className: 'uplot' }));
    }
    setData() {}
    setSize() {}
    destroy() {}
  },
}));

const DEFAULT_PARAMS: SphereReleaseParams = {
  radiusM: 150e-6,
  diffusivityM2S: 1e-10,
  nShells: 64,
  tEndS: 60,
  nSteps: 2000,
  grid: 'equal_volume',
  scheme: 'bdf2',
};

function fakeResult(p: SphereReleaseParams, maxAbsError: number): SphereRunData {
  const n = Math.min(p.nSteps, 100) + 1;
  const times = Float64Array.from({ length: n }, (_, i) => (i * p.tEndS) / (n - 1));
  return {
    times,
    releasedFraction: times.map((t) => t / p.tEndS),
    analyticFraction: times.map((t) => t / p.tEndS + 1e-6),
    shellOuterRadii: new Float64Array(p.nShells),
    finalProfile: new Float64Array(p.nShells),
    maxAbsError,
    massBalanceError: 3.1e-15,
    totalPoints: p.nSteps + 1,
  };
}

interface Call {
  params: SphereReleaseParams;
  signal: AbortSignal | undefined;
  resolve: (maxAbsError?: number) => void;
  reject: (error: Error) => void;
}

/**
 * An engine whose runs finish only when a test says so. Like the real client,
 * an aborted call rejects with an AbortError, unless `ignoreAbort` makes it
 * deliver its result anyway (a late answer racing the abort).
 */
function deferredEngine({ ignoreAbort = false } = {}) {
  const calls: Call[] = [];
  const engine: Engine = {
    coreVersion: () => Promise.resolve({ result: '0.1.0', runtimeMs: 0.01 }),
    simulateSphereRelease: (params: SphereReleaseParams, options?: CallOptions) =>
      new Promise<Timed<SphereRunData>>((resolve, reject) => {
        const signal = options?.signal;
        calls.push({
          params,
          signal,
          resolve: (maxAbsError = 1.234e-4) =>
            resolve({ result: fakeResult(params, maxAbsError), runtimeMs: 2.5 }),
          reject,
        });
        if (!ignoreAbort) {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }
      }),
    // The shot lab is not mounted in these tests (they open the verification view).
    catalog: () => new Promise(() => {}),
    buildShotSpec: () => new Promise(() => {}),
    simulateRecipe: () => new Promise(() => {}),
    simulateUncertainty: () => new Promise(() => {}),
    simulateShot: () => new Promise(() => {}),
    sweepPoint: () => new Promise(() => {}),
    terminate: () => {},
  };
  return { engine, calls };
}

function renderApp(engine: Engine) {
  render(
    <EngineContext.Provider value={engine}>
      <App />
    </EngineContext.Provider>,
  );
}

/** Advances fake time and lets React and pending promises settle. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const status = () => document.getElementById('sphere-status')?.textContent ?? '';
const announcement = () => screen.getByRole('status').textContent;
const tileValue = (label: string) =>
  screen.getByText(label).closest('.tile')?.querySelector('.tile-value')?.textContent;
const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The M0 verification panel lives in the Lab's second view.
    resetAppStore('verification');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the header, the three modes and the footer', () => {
    renderApp(deferredEngine().engine);
    expect(screen.getByRole('heading', { level: 1, name: 'Puckworks' })).toBeTruthy();
    const modes = within(screen.getByRole('tablist', { name: 'Mode' })).getAllByRole('tab');
    expect(modes.map((t) => t.textContent)).toEqual(['Dial-in', 'Lab', 'Explore']);
    expect(screen.getByRole('tab', { name: 'Lab' }).getAttribute('aria-selected')).toBe('true');
    expect(
      screen.getByRole('tab', { name: 'Kernel verification' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Particle kernel verification' }),
    ).toBeTruthy();
    expect(screen.getByText('GPL-2.0-or-later')).toBeTruthy();
    expect(screen.getByText('Nothing you enter leaves your browser')).toBeTruthy();
    if (SOURCE_URL) {
      expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe(
        SOURCE_URL,
      );
    } else {
      expect(screen.getByText('Source code: not linked in this local build')).toBeTruthy();
    }
    // The notices file exists only in production builds, which link it (checked by the e2e test).
    expect(screen.queryByRole('link', { name: 'Third-party licences' })).toBeNull();
  });

  it('labels every input and starts from the documented defaults', () => {
    renderApp(deferredEngine().engine);
    expect(field('Radius (µm)').value).toBe('150');
    expect(field('Diffusivity (m²/s)').value).toBe('1e-10');
    expect(field('Shells').value).toBe('64');
    expect(field('End time (s)').value).toBe('60');
    expect(field('Steps').value).toBe('2000');
    expect(field('Grid').value).toBe('equal_volume');
    expect(field('Scheme').value).toBe('bdf2');
  });

  it('runs the default case automatically and shows and announces the result', async () => {
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    await advance();
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(DEFAULT_PARAMS);
    expect(status()).toBe('Running…');
    expect(announcement()).toBe('');

    calls[0].resolve();
    await advance();
    expect(tileValue('Max abs error')).toBe('1.23 × 10⁻⁴');
    expect(tileValue('Mass balance error')).toBe('3.10 × 10⁻¹⁵');
    expect(tileValue('Runtime')).toBe('2.50 ms');
    expect(tileValue('Core version')).toBe('0.1.0');
    expect(screen.getByText('Released fraction over time')).toBeTruthy();
    expect(status()).toBe('Up to date: 2,001 time points.');
    expect(announcement()).toBe('Run finished. Max abs error 1.23e-4.');
    expect(screen.getByText(/The charts draw 101 of 2,001 time points/)).toBeTruthy();
  });

  it('flags invalid input without announcing it, and never runs it', async () => {
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    await advance();
    calls[0].resolve();
    await advance();
    type('Shells', '1.5');
    const shells = field('Shells');
    expect(shells.getAttribute('aria-invalid')).toBe('true');
    const message = document.getElementById(shells.getAttribute('aria-describedby') ?? '');
    expect(message?.textContent).toMatch(/whole number of shells from 2 to 100000/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true);
    expect(status()).toBe('Check the highlighted inputs.');
    expect(announcement()).toBe('Run finished. Max abs error 1.23e-4.');
    await advance(1000);
    expect(calls).toHaveLength(1);
  });

  it('applies the core’s limit on D·t_end/a² to the end time', async () => {
    renderApp(deferredEngine().engine);
    await advance();
    type('End time (s)', '1e203');
    const end = field('End time (s)');
    expect(end.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(end.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      TAU_MESSAGE,
    );
  });

  it('aborts the run in flight when the inputs change and ignores its late result', async () => {
    const { engine, calls } = deferredEngine({ ignoreAbort: true });
    renderApp(engine);
    await advance();
    type('Shells', '128');
    await advance(299);
    expect(calls).toHaveLength(1);
    expect(status()).toBe('Running…');
    await advance(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].params.nShells).toBe(128);

    calls[1].resolve(2e-4);
    await advance();
    expect(tileValue('Max abs error')).toBe('2.00 × 10⁻⁴');
    calls[0].resolve(0.5); // the superseded run answers anyway
    await advance();
    expect(tileValue('Max abs error')).toBe('2.00 × 10⁻⁴');
    expect(status()).toBe('Up to date: 2,001 time points.');
  });

  it('marks results for earlier inputs with a badge', async () => {
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    await advance();
    calls[0].resolve();
    await advance();
    expect(screen.queryByText('Results for earlier inputs')).toBeNull();
    type('Shells', 'x');
    expect(screen.getByText('Results for earlier inputs')).toBeTruthy();
    type('Shells', '64');
    expect(screen.queryByText('Results for earlier inputs')).toBeNull();
  });

  it('cancels a run, says so, and keeps focus on Cancel', async () => {
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    await advance();
    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' });
    expect(cancel.getAttribute('aria-disabled')).toBeNull();
    cancel.focus();
    fireEvent.click(cancel);
    await advance();
    expect(calls[0].signal?.aborted).toBe(true);
    expect(status()).toBe('Cancelled. Press Run to start it again.');
    expect(announcement()).toBe('Run cancelled.');
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    expect(cancel.disabled).toBe(false);
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(cancel); // nothing to cancel now
    await advance(1000);
    expect(calls).toHaveLength(1);
    expect(status()).toBe('Cancelled. Press Run to start it again.');

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await advance();
    expect(calls).toHaveLength(2);
    expect(status()).toBe('Running…');
  });

  it('reports a failed run in an alert', async () => {
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    await advance();
    calls[0].reject(new EngineError('worker', 'The engine worker failed: boom'));
    await advance();
    expect(screen.getByRole('alert').textContent).toBe(
      'The run failed: The engine worker failed: boom',
    );
    expect(status()).toBe('The last run failed.');
    expect(announcement()).toBe('Run failed: The engine worker failed: boom');
  });

  it('runs once when Run is pressed before the automatic run starts', async () => {
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    await advance();
    calls[0].resolve();
    await advance();
    type('Shells', '128');
    await advance(100);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await advance();
    expect(calls).toHaveLength(2);
    expect(calls[1].params.nShells).toBe(128);
    await advance(1000);
    expect(calls).toHaveLength(2);
    expect(calls[1].signal?.aborted).toBe(false);
  });

  it('leaves large runs to the Run button and warns about their memory', async () => {
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    await advance();
    calls[0].resolve();
    await advance();
    type('Shells', '2');
    type('Steps', '10000000');
    await advance(1000);
    expect(calls).toHaveLength(1);
    expect(status()).toMatch(/^Large run \(10,000,000 steps/);
    const warning = screen.getByText('This run needs about 534 MB of memory.');
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run.getAttribute('aria-describedby')).toBe(warning.id);

    fireEvent.click(run);
    await advance();
    expect(calls).toHaveLength(2);
    expect(calls[1].params).toMatchObject({ nShells: 2, nSteps: 10_000_000 });
  });

  it('opens the Lab on the shot lab, with the kernel verification one tab away', async () => {
    resetAppStore();
    const { engine, calls } = deferredEngine();
    renderApp(engine);
    expect(screen.getByRole('tab', { name: 'Shot lab' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Shot lab' })).toBeTruthy();
    expect(screen.getByText('Starting the engine and loading the presets…')).toBeTruthy();
    // The verification panel is not mounted, so it has not run yet.
    await advance();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Kernel verification' }));
    expect(
      screen.getByRole('heading', { level: 2, name: 'Particle kernel verification' }),
    ).toBeTruthy();
    await advance();
    expect(calls).toHaveLength(1);
  });

  it('switches modes with the mouse and the keyboard', () => {
    renderApp(deferredEngine().engine);
    fireEvent.click(screen.getByRole('tab', { name: 'Dial-in' }));
    expect(screen.getByRole('heading', { name: 'Dial-in' })).toBeTruthy();
    expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('panel-dial-in');

    const dialIn = screen.getByRole('tab', { name: 'Dial-in' });
    fireEvent.keyDown(dialIn, { key: 'ArrowLeft' });
    const explore = screen.getByRole('tab', { name: 'Explore' });
    expect(explore.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(explore);
    expect(screen.getByText('Coming in M5')).toBeTruthy();

    fireEvent.keyDown(explore, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Dial-in' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Lab' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Lab' }).tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Explore' }).tabIndex).toBe(-1);
  });
});
