// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureChemistry } from '../../test/fixtures/chemistryFixture';
import { fixtureTaste, fixtureUncertainty } from '../../test/fixtures/m3Fixture';
import { fixtureCatalog, fixtureRun } from '../../test/fixtures/shotFixture';
import { CompoundTable } from './CompoundTable';
import { CupChemistryPanel } from './CupChemistryPanel';
import { PsdPanel } from './PsdPanel';
import { registryIndex } from './provenance';
import { DEFAULT_RECIPE, physicalKey } from './recipeForm';
import { ShotCharts } from './ShotCharts';
import type { ShotOutcome } from './shotStore';
import { TastePanel } from './TastePanel';

vi.mock('uplot', () => ({
  default: class {
    static pxRatio = 1;
    constructor(_options: unknown, _data: unknown, target: HTMLElement) {
      target.append(document.createElement('div'));
    }
    setData() {}
    setSize() {}
    destroy() {}
  },
}));

function outcome(): ShotOutcome {
  const run: ShotOutcome = {
    ...fixtureRun(DEFAULT_RECIPE),
    key: physicalKey(DEFAULT_RECIPE),
    recipe: DEFAULT_RECIPE,
    kind: 'full',
    tier: 1,
    runtimeMs: 3,
    seq: 1,
    taste: fixtureTaste(),
  };
  run.result.chemistry = fixtureChemistry();
  return run;
}

afterEach(cleanup);

describe('explanations beside calculated results', () => {
  it('explains cup pH as a calculated acid balance and returns focus after closing', () => {
    render(<CupChemistryPanel outcome={outcome()} />);
    const trigger = screen.getByRole('button', { name: 'Help for Estimated cup pH' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    const help = screen.getByRole('dialog', { name: 'Estimated cup pH help' });
    expect(help.textContent).toContain('pH alone does not give perceived sourness');
    expect(help.textContent).toContain('calibrated pH meter');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(help, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByText('5.21')).toBeTruthy();
  });

  it('distinguishes apparent instrument TDS from true solids and offers measurement guidance', () => {
    render(<CupChemistryPanel outcome={outcome()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Help for Apparent TDS' }));
    const help = screen.getByRole('dialog', { name: 'Apparent TDS help' });
    expect(help.textContent).toContain('differ from the actual mass fraction');
    expect(help.textContent).toContain('coffee-specific refractometer');
    expect(within(help).getByText('Useful measuring tools')).toBeTruthy();
    fireEvent.click(within(help).getByRole('button', { name: 'Close help for Apparent TDS' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps taste limits accessible without milestone labels or changing the result', () => {
    const { container } = render(
      <TastePanel outcome={outcome()} stale={false} uncertainty={fixtureUncertainty()} />,
    );
    expect(container.textContent).not.toMatch(/\bTier[- ]?\d|\bM[23]\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Help for Acidity potential' }));
    expect(screen.getByRole('dialog').textContent).toContain('not a validated tasting scale');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Help for Acidity potential scenario range' }),
    );
    const help = screen.getByRole('dialog');
    expect(help.textContent).toContain('fast preview calculation');
    expect(help.textContent).toContain('not a confidence interval');
    expect(screen.getByText(/p05–p95 7.0–13.0/)).toBeTruthy();
  });

  it('explains volume-based particle statistics and what numerical size classes mean', () => {
    render(<PsdPanel runs={[{ label: 'Current', slot: 0, outcome: outcome() }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Help for Fines below 100 µm' }));
    expect(screen.getByRole('dialog').textContent).toContain('volume share rather than a count');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Help for Particle-size classes' }));
    expect(screen.getByRole('dialog').textContent).toContain('not a physical measurement');
  });

  it('gives every shot chart its own explanation, including cup versus outlet strength', () => {
    render(<ShotCharts runs={[{ label: 'Current', slot: 0, result: outcome().result }]} />);
    for (const label of [
      'Pressure',
      'Flow',
      'Beverage mass',
      'TDS',
      'Extraction yield',
      'Outlet temperature',
      'Wetted bed',
    ]) {
      expect(screen.getByRole('button', { name: `Help for ${label} chart` })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Help for TDS chart' }));
    const help = screen.getByRole('dialog', { name: 'TDS chart help' });
    expect(help.textContent).toContain('all liquid collected so far');
    expect(help.textContent).toContain('leaving the basket at that moment');
    expect(within(help).getByText('How to find it')).toBeTruthy();
  });

  it('keeps compound recovery distinct from whole-dose extraction and explains caffeine evidence', () => {
    const catalog = fixtureCatalog();
    render(
      <CompoundTable outcome={outcome()} catalog={catalog} registry={registryIndex(catalog)} />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Help for Extracted or recovered fraction' }),
    );
    expect(screen.getByRole('dialog').textContent).toContain(
      'not the percentage of the whole dry dose',
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: 'caffeine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Help for Estimated caffeine' }));
    expect(screen.getByRole('dialog').textContent).toContain('not a measurement of your bag');
    expect(screen.getByRole('dialog').textContent).toContain('cannot separate caffeine');
  });
});
