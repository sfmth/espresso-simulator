// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Memory budget of a sphere run. WebAssembly memory grows but never shrinks,
 * so a worker that ran a large case keeps that memory until it is replaced.
 */
import type { SphereReleaseParams } from './types';

const MiB = 1024 * 1024;

/** A worker whose WebAssembly memory exceeds this after a run is replaced. */
export const RECYCLE_MEMORY_BYTES = 32 * MiB;

/** Runs estimated to need more than this get a warning before they start. */
export const MEMORY_WARNING_BYTES = 32 * MiB;

/**
 * Rough peak memory of a run, in bytes, measured on the M0 core: about 32 B per
 * time step in WebAssembly (three result series plus one copy while it is read
 * out), 24 B per step for the worker's JavaScript copies before thinning, and
 * about 160 B per shell for the solver's arrays.
 */
export function estimateRunBytes(p: Pick<SphereReleaseParams, 'nShells' | 'nSteps'>): number {
  return 56 * (p.nSteps + 1) + 160 * p.nShells;
}

/** Megabytes, rounded for display: "54 MB". */
export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MiB)).toLocaleString('en-US')} MB`;
}
