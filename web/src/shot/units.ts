// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Factors from the engine's SI units and fractions (docs/model/m1-contract.md
 * §2) to the units the lab shows. Every display conversion uses these, so the
 * tiles, tables, charts, sweeps and CSV files agree.
 */

/** Pa → bar. */
export const BAR_PER_PA = 1e-5;
/** m³ (and m³/s) → mL (and mL/s). */
export const ML_PER_M3 = 1e6;
/** kg → g. */
export const G_PER_KG = 1e3;
/** kg → mg. */
export const MG_PER_KG = 1e6;
/** m → mm. */
export const MM_PER_M = 1e3;
/** m → µm. */
export const UM_PER_M = 1e6;
/** A fraction → percent (TDS, EY, shares). */
export const PERCENT = 100;
