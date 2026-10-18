// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { modelStatusText, validationReportUrl } from './modelStatus';
import { ModelStatusNote } from './ModelStatusNote';

const REPO = 'https://github.com/example/puckworks';
const REPORT = `${REPO}/blob/main/docs/validation/m1-validation.md`;

describe('model status note', () => {
  afterEach(cleanup);

  it('names the calibration and the held-out results, without calling the model uncalibrated', () => {
    const text = modelStatusText(REPO);
    expect(text).toMatch(/^Calibrated against published experiments \(Schmieder 2023, /);
    expect(text).toContain('errors in startup flow and extraction');
    expect(text).toContain('Startup assumptions are estimated');
    expect(text).toContain('input-scenario bands exclude model error');
    expect(text).toContain('not sensory validated');
    expect(text).not.toMatch(/uncalibrated|before calibration/i);
  });

  it('links “Held-out tests” to the validation report in the source repository', () => {
    expect(validationReportUrl(REPO)).toBe(REPORT);
    expect(validationReportUrl(`${REPO}/`)).toBe(REPORT);
    render(<ModelStatusNote sourceUrl={REPO} />);
    const link = screen.getByRole('link', { name: 'Held-out tests' });
    expect(link.getAttribute('href')).toBe(REPORT);
    expect(document.querySelector('.model-status')?.textContent).toBe(modelStatusText(REPO));
  });

  it('names the report’s file in a build without a repository link', () => {
    expect(validationReportUrl(null)).toBeNull();
    render(<ModelStatusNote sourceUrl={null} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('.model-status')?.textContent).toBe(modelStatusText(null));
    expect(modelStatusText(null)).toContain(
      'Held-out tests (docs/validation/m1-validation.md in the source code) still show',
    );
  });
});
