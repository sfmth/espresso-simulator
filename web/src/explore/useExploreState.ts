// SPDX-License-Identifier: GPL-2.0-or-later
/** View-only playback. Physics and recipes belong to the single shared shot controller. */
import { useEffect, useState } from 'react';
import type { ShotOutcome } from '../shot/shotStore';

export interface ExploreCell {
  col: number;
  cell: number;
}
export const EXPLORE_FRAME_INTERVAL_MS = 500;
interface ViewState {
  seq: number | null;
  snapshotIndex: number;
  selectedCell: ExploreCell | null;
  playing: boolean;
}
function count(outcome: ShotOutcome | null) {
  return outcome?.result.spatial.snapshots.length ?? 0;
}
function initial(outcome: ShotOutcome | null): ViewState {
  const depth = outcome?.result.spatial.depth_m.length ?? 0;
  const columns = outcome?.result.spatial.columns.length ?? 0;
  const micro = outcome?.result.spatial.micro;
  return {
    seq: outcome?.seq ?? null,
    snapshotIndex: Math.max(0, count(outcome) - 1),
    selectedCell:
      depth && columns
        ? {
            col: index(micro?.column ?? 0, columns),
            cell: index(micro?.cell ?? Math.floor(depth / 2), depth),
          }
        : null,
    playing: false,
  };
}
function index(value: number, length: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(Math.max(0, length - 1), Math.round(value)))
    : 0;
}
export function useExploreState(outcome: ShotOutcome | null, active: boolean) {
  const [view, setView] = useState<ViewState>(() => initial(outcome));
  let currentView = view.seq === (outcome?.seq ?? null) ? view : initial(outcome);
  const frameCount = count(outcome);
  const snapshotIndex = index(currentView.snapshotIndex, frameCount);
  const depth = outcome?.result.spatial.depth_m.length ?? 0;
  const columns = outcome?.result.spatial.columns.length ?? 0;
  const playing = active && currentView.playing && snapshotIndex < frameCount - 1;
  if (currentView.playing && !playing) currentView = { ...currentView, playing: false };
  if (currentView !== view) setView(currentView);
  const selectedCell =
    currentView.selectedCell && depth && columns
      ? {
          col: index(currentView.selectedCell.col, columns),
          cell: index(currentView.selectedCell.cell, depth),
        }
      : null;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setView((current) => ({
          ...current,
          snapshotIndex: Math.min(current.snapshotIndex + 1, frameCount - 1),
        })),
      EXPLORE_FRAME_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [playing, frameCount]);
  const selectSnapshot = (value: number) =>
    setView((current) => ({ ...current, snapshotIndex: index(value, frameCount), playing: false }));
  const selectCell = (value: ExploreCell) =>
    setView((current) => ({
      ...current,
      selectedCell:
        depth && columns
          ? { col: index(value.col, columns), cell: index(value.cell, depth) }
          : null,
    }));
  const pause = () => setView((current) => ({ ...current, playing: false }));
  const play = () => {
    if (!active || frameCount < 2) return;
    setView((current) => ({
      ...current,
      playing: true,
      snapshotIndex: current.snapshotIndex >= frameCount - 1 ? 0 : current.snapshotIndex,
    }));
  };
  return {
    snapshotIndex,
    snapshot: outcome?.result.spatial.snapshots[snapshotIndex] ?? null,
    frameCount,
    selectedCell,
    playing,
    selectSnapshot,
    selectCell,
    play,
    pause,
  };
}
