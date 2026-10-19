// SPDX-License-Identifier: GPL-2.0-or-later
/** Opt-in read-only state from one cell of the coupled Tier 1 shot model. */
export type ExploreResolution = 'standard' | 'high';
export interface ExploreRequest {
  column: number;
  cell: number;
  /** High refines depth cells by 5×; the solver remains the parallel 1D Tier 1 model. */
  resolution?: ExploreResolution;
}
export interface MicroClass {
  radius_m: number;
  kernel_radius_m: number;
  /** Normalized particle-envelope volume share; also dry-mass share at the common density. */
  volume_fraction: number;
  /** Broken-cell surface-pool share of full particle volume. */
  pool_fraction: number;
  /** Kernel-shell outer faces, not full particle radii; empty for all-surface classes. */
  shell_outer_radii_m: number[];
  initial_kernel_conc_kg_m3: number;
}
export interface MicroMetadata {
  column: number;
  cell: number;
  classes: MicroClass[];
  resolution?: ExploreResolution;
  depth_cells?: number;
}
export interface MicroSnapshot {
  class_ey: number[];
  /** [class][shell] exact concentration-equivalent loading, kg/m³ of reference capacity; not a separate pore-liquid inventory. */
  kernel_conc_kg_m3: number[][];
  /** null means this class has no initial surface-pool content. */
  surface_remaining_fraction: (number | null)[];
}
