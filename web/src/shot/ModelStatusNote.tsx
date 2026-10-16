// SPDX-License-Identifier: GPL-2.0-or-later
import { SOURCE_URL } from '../config';
import { MODEL_STATUS, VALIDATION_REPORT_PATH, validationReportUrl } from './modelStatus';

/**
 * The model's status under the summary tiles. "Held-out tests" links to the
 * validation report when the build knows its repository; otherwise the note
 * names the file.
 */
export function ModelStatusNote({ sourceUrl = SOURCE_URL }: { sourceUrl?: string | null }) {
  const report = validationReportUrl(sourceUrl);
  return (
    <p className="model-status note">
      {MODEL_STATUS.calibrated}{' '}
      {report ? (
        <a href={report}>{MODEL_STATUS.heldOut}</a>
      ) : (
        <>
          {MODEL_STATUS.heldOut} (<code>{VALIDATION_REPORT_PATH}</code> in the source code)
        </>
      )}{' '}
      {MODEL_STATUS.findings}
    </p>
  );
}
