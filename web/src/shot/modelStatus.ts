// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * How far to trust the numbers (PLAN §1.2 principle 4, honest uncertainty),
 * shown under the summary tiles. Keep it in step with the validation report
 * (docs/validation/m1-validation.md) whenever the model or its calibration
 * changes.
 */

/** The validation report, as a path in the repository. */
export const VALIDATION_REPORT_PATH = 'docs/validation/m1-validation.md';

/** The note in three parts; the middle one links to the validation report. */
export const MODEL_STATUS = {
  calibrated:
    'Calibrated against published experiments (Schmieder 2023, Waszkiewicz 2026, Corrochano 2017, Vaca Guerra 2024).',
  heldOut: 'Held-out tests',
  findings:
    'still show errors in startup flow and extraction with the M1.1 model. Startup assumptions are estimated, so treat times and EY as indicative. No uncertainty bands yet.',
} as const;

/** The validation report in the source repository, or null for a build that has none. */
export function validationReportUrl(sourceUrl: string | null): string | null {
  return sourceUrl ? `${sourceUrl.replace(/\/+$/, '')}/blob/main/${VALIDATION_REPORT_PATH}` : null;
}

/** The whole note as plain text, as it reads on the page. */
export function modelStatusText(sourceUrl: string | null): string {
  const heldOut = sourceUrl
    ? MODEL_STATUS.heldOut
    : `${MODEL_STATUS.heldOut} (${VALIDATION_REPORT_PATH} in the source code)`;
  return `${MODEL_STATUS.calibrated} ${heldOut} ${MODEL_STATUS.findings}`;
}
