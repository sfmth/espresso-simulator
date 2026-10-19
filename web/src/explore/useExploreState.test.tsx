// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureRun } from '../../test/fixtures/shotFixture';
import { DEFAULT_RECIPE, physicalKey } from '../shot/recipeForm';
import type { ShotOutcome } from '../shot/shotStore';
import { EXPLORE_FRAME_INTERVAL_MS, useExploreState } from './useExploreState';
function outcome(seq = 1, snapshots = 4): ShotOutcome {
  const run = fixtureRun(DEFAULT_RECIPE, { snapshots });
  return {
    ...run,
    key: physicalKey(DEFAULT_RECIPE),
    recipe: DEFAULT_RECIPE,
    kind: 'full',
    tier: 1,
    runtimeMs: 10,
    seq,
  };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('Explore view state', () => {
  it('indexes actual snapshots, clamps cell selection, and starts paused on the final stored snapshot', () => {
    const shot = outcome();
    const { result } = renderHook(() => useExploreState(shot, true));
    expect(result.current.snapshotIndex).toBe(3);
    expect(result.current.snapshot).toBe(shot.result.spatial.snapshots[3]);
    expect(result.current.playing).toBe(false);
    act(() => result.current.selectCell({ col: 100, cell: -20 }));
    expect(result.current.selectedCell).toEqual({ col: 2, cell: 0 });
    act(() => result.current.selectSnapshot(100));
    expect(result.current.snapshotIndex).toBe(3);
  });
  it('restarts from the beginning, stops at the last snapshot, and pauses while hidden', () => {
    vi.useFakeTimers();
    const shot = outcome();
    const { result, rerender } = renderHook(({ active }) => useExploreState(shot, active), {
      initialProps: { active: true },
    });
    act(() => result.current.play());
    expect(result.current.snapshotIndex).toBe(0);
    act(() => {
      vi.advanceTimersByTime(EXPLORE_FRAME_INTERVAL_MS);
    });
    expect(result.current.snapshotIndex).toBe(1);
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(10 * EXPLORE_FRAME_INTERVAL_MS);
    });
    expect(result.current.snapshotIndex).toBe(1);
    expect(result.current.playing).toBe(false);
    rerender({ active: true });
    expect(result.current.playing).toBe(false);
    act(() => result.current.play());
    act(() => {
      vi.advanceTimersByTime(10 * EXPLORE_FRAME_INTERVAL_MS);
    });
    expect(result.current.snapshotIndex).toBe(3);
    expect(result.current.playing).toBe(false);
  });
  it('replaces playback and selection together when a different result arrives', () => {
    const { result, rerender } = renderHook(({ shot }) => useExploreState(shot, true), {
      initialProps: { shot: outcome(1, 4) },
    });
    act(() => {
      result.current.selectSnapshot(0);
      result.current.play();
    });
    rerender({ shot: outcome(2, 2) });
    expect(result.current.snapshotIndex).toBe(1);
    expect(result.current.playing).toBe(false);
    expect(result.current.selectedCell).toEqual({ col: 0, cell: 2 });
  });
  it('uses the returned refined-grid micro cell and handles absent data', () => {
    const shot = outcome();
    shot.result.spatial.micro = { column: 2, cell: 3, classes: [] };
    const { result, rerender } = renderHook<
      ReturnType<typeof useExploreState>,
      { shot: ShotOutcome | null }
    >(({ shot }: { shot: ShotOutcome | null }) => useExploreState(shot, true), {
      initialProps: { shot },
    });
    expect(result.current.selectedCell).toEqual({ col: 2, cell: 3 });
    rerender({ shot: null });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.selectedCell).toBeNull();
    expect(result.current.frameCount).toBe(0);
    act(() => result.current.play());
    expect(result.current.playing).toBe(false);
  });
});
