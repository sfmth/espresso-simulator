// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCatalog, fixtureRun } from '../../test/fixtures/shotFixture';
import { useSharedShotRun, type SharedShotRunControls } from '../shot/ShotRunContext';
import { DEFAULT_RECIPE, physicalKey } from '../shot/recipeForm';
import { resetShotStore, useShotStore, type ShotOutcome } from '../shot/shotStore';
import { Explore } from './Explore';
import { EXPLORE_FRAME_INTERVAL_MS } from './useExploreState';

vi.mock('../shot/ShotRunContext', () => ({ useSharedShotRun: vi.fn() }));
vi.mock('./useMicrostructure', () => ({
  useMicrostructure: () => ({ model: null, loading: false, error: null, runtimeMs: null }),
}));

let controls: SharedShotRunControls;
beforeEach(() => {
  resetShotStore();
  const shot: ShotOutcome = {
    ...fixtureRun(DEFAULT_RECIPE, { snapshots: 3 }),
    key: physicalKey(DEFAULT_RECIPE),
    recipe: DEFAULT_RECIPE,
    kind: 'full',
    tier: 1,
    runtimeMs: 1,
    seq: 1,
  };
  shot.result.spatial.snapshots.forEach((snapshot, i) => {
    snapshot.t_s = [1.25, 4.75, 31][i];
  });
  useShotStore.setState((state) => ({
    catalog: fixtureCatalog(),
    run: { ...state.run, latest: shot, lastFull: shot, status: 'done' },
  }));
  controls = {
    key: shot.key,
    validation: { ok: true, recipe: DEFAULT_RECIPE, notes: [] },
    run: vi.fn(),
    retry: vi.fn(),
    retryCatalog: vi.fn(),
    runExplore: vi.fn(() =>
      useShotStore.setState((state) => ({ run: { ...state.run, fullRunning: true } })),
    ),
    cancel: vi.fn(() =>
      useShotStore.setState((state) => ({ run: { ...state.run, fullRunning: false } })),
    ),
  };
  vi.mocked(useSharedShotRun).mockReturnValue(controls);
});
afterEach(() => {
  cleanup();
  resetShotStore();
  vi.useRealTimers();
});

describe('Explore accessible controls', () => {
  it('reports actual irregular snapshot seconds rather than the slider’s storage index', () => {
    render(<Explore active />);
    const time = screen.getByRole('slider', { name: 'Shot time' });
    expect(time.getAttribute('aria-valuetext')).toBe('31.0 seconds, snapshot 3 of 3');
    fireEvent.change(time, { target: { value: '1' } });
    expect(time.getAttribute('aria-valuetext')).toBe('4.8 seconds, snapshot 2 of 3');
    fireEvent.change(time, { target: { value: '0' } });
    expect(time.getAttribute('aria-valuetext')).toBe('1.3 seconds, snapshot 1 of 3');
    const cut = screen.getByRole('slider', { name: 'Cutaway plane' });
    fireEvent.change(cut, { target: { value: '0.25' } });
    expect(cut.getAttribute('aria-valuetext')).toBe('25% of cube depth');
  });

  it('keeps the run action focusable while busy, rejects duplicate activation, and restores it on cancellation', () => {
    render(<Explore active />);
    const run = screen.getByRole<HTMLButtonElement>('button', { name: 'Run Explore' });
    run.focus();
    fireEvent.click(run);
    expect(run.disabled).toBe(false);
    expect(run.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(run);
    fireEvent.click(run);
    expect(controls.runExplore).toHaveBeenCalledOnce();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    expect(controls.cancel).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(run);
    expect(run.hasAttribute('aria-disabled')).toBe(false);
  });

  it('keeps live cell output quiet during requested playback and restores announcements after Pause', () => {
    vi.useFakeTimers();
    render(<Explore active />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    const diagram = screen.getByRole('img', { name: /Puck cross-section/ });
    const readoutId = diagram.getAttribute('aria-describedby')!.split(' ')[1];
    const readout = document.getElementById(readoutId)!;
    expect(readout.getAttribute('aria-live')).toBe('off');
    act(() => {
      vi.advanceTimersByTime(EXPLORE_FRAME_INTERVAL_MS);
    });
    expect(screen.getByRole('slider', { name: 'Shot time' }).getAttribute('aria-valuetext')).toBe(
      '4.8 seconds, snapshot 2 of 3',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(readout.getAttribute('aria-live')).toBe('polite');
  });
});
