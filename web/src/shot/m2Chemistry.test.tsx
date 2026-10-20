// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureChemistry } from '../../test/fixtures/chemistryFixture';
import { fixtureCatalog, fixtureRun } from '../../test/fixtures/shotFixture';
import type { CompoundMeta } from '../engine/shotTypes';
import { CompoundTable } from './CompoundTable';
import { CupChemistryPanel } from './CupChemistryPanel';
import { emptyRouting } from './notes';
import { registryIndex } from './provenance';
import { RecipeEditor } from './RecipeEditor';
import { DEFAULT_RECIPE, formToRecipe, physicalKey } from './recipeForm';
import { resetShotStore, useShotStore, type ShotOutcome } from './shotStore';

function outcome(): ShotOutcome {
  return {
    ...fixtureRun(DEFAULT_RECIPE),
    key: physicalKey(DEFAULT_RECIPE),
    recipe: DEFAULT_RECIPE,
    kind: 'full',
    tier: 1,
    runtimeMs: 20,
    seq: 1,
  };
}

function openSection(id: string) {
  act(() => {
    const details = document.getElementById(`section-${id}`) as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
}

describe('M2 recipe and cup UI', () => {
  beforeEach(() => resetShotStore());
  afterEach(cleanup);

  it('edits bean, water and observation conditions into a runnable recipe', () => {
    const catalog = fixtureCatalog();
    render(
      <RecipeEditor
        context={{
          catalog,
          errors: {},
          notes: emptyRouting(),
          notesStale: false,
          build: null,
          buildStale: false,
        }}
        onSubmit={() => {}}
      />,
    );
    openSection('bean');
    fireEvent.change(screen.getByLabelText('Growing altitude (m)'), { target: { value: '1850' } });
    fireEvent.change(screen.getByLabelText('Variety group'), { target: { value: 'gesha' } });
    fireEvent.change(screen.getByLabelText('Bean storage'), { target: { value: 'frozen' } });
    openSection('water');
    fireEvent.change(screen.getByLabelText('Alkalinity (mg/L as CaCO₃)'), {
      target: { value: '25' },
    });
    fireEvent.change(screen.getByLabelText('Water pH'), { target: { value: '7.4' } });
    openSection('chemistry');
    fireEvent.change(screen.getByLabelText('Time in the cup (s)'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Refractometer mineral blank'), {
      target: { value: 'yes' },
    });
    const result = formToRecipe(useShotStore.getState().form, { catalog });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.recipe.bean).toMatchObject({
      altitude_m: 1850,
      variety_group: 'gesha',
      storage: 'frozen',
    });
    expect(result.recipe.water).toEqual({ alkalinity_mg_l_caco3: 25, ph: 7.4 });
    expect(result.recipe.chemistry).toEqual({ aroma_age_s: 45, mineral_blank_subtracted: true });
    fireEvent.click(screen.getByLabelText('Calculate cup chemistry'));
    const disabled = formToRecipe(useShotStore.getState().form);
    expect(disabled.ok && disabled.recipe.chemistry?.enabled).toBe(false);
  });

  it('renders physical chemistry values with units and discloses estimated proxies', () => {
    const run = outcome();
    run.result.chemistry = fixtureChemistry();
    render(<CupChemistryPanel outcome={run} />);
    expect(screen.getByText('5.21')).toBeTruthy();
    expect(screen.getByText('7.25 mmol/L')).toBeTruthy();
    expect(screen.getByText('9.81%')).toBeTruthy();
    expect(screen.getByText(/not a measured foam volume/)).toBeTruthy();
    const aroma = screen.getByRole('table', { name: 'Aroma partitioning', hidden: true });
    expect(within(aroma).getByText('0.15')).toBeTruthy();
    expect(within(aroma).getByText('0.01')).toBeTruthy();
    expect(screen.getByText('Fixture chemistry uses illustrative parameters.')).toBeTruthy();
  });

  it('handles results from an older or chemistry-disabled engine', () => {
    render(<CupChemistryPanel outcome={outcome()} />);
    expect(screen.getByText(/Enable cup chemistry/)).toBeTruthy();
  });

  it('keeps a large catalogue folded and searches names, families, phases and K classes', () => {
    const run = outcome();
    const compounds: CompoundMeta[] = Array.from({ length: 8 }, (_, i) => ({
      id: `test-${i}`,
      name: `Test compound ${i}`,
      family: i < 4 ? 'organic_acids' : 'gas',
      kinetic_class: i < 4 ? 'K1' : 'K6',
      phase: i < 4 ? 'dissolved' : 'gas',
      counts_toward_tds: i < 4,
      transport_evidence: 'Estimated transport',
      composition_evidence: 'Estimated composition',
      registry_refs: [],
      notes: [],
    }));
    run.build.derived.compounds = compounds;
    run.result.summary.species = compounds.slice(0, 4).map((s) => ({
      id: s.id,
      mass_kg: 1e-6,
      extracted_fraction: 0.5,
    }));
    run.result.chemistry = fixtureChemistry();
    run.result.chemistry.phases = compounds.slice(4).map((s) => ({
      id: s.id,
      available_mass_kg: 2e-6,
      cup_mass_kg: 1e-6,
      retained_mass_kg: 1e-6,
    }));
    const catalog = fixtureCatalog();
    render(<CompoundTable outcome={run} registry={registryIndex(catalog)} catalog={catalog} />);
    expect(screen.queryByText('Test compound 0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /organic acids/ }));
    expect(screen.getByText('Test compound 0')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: 'K6' } });
    expect(screen.queryByText('Test compound 0')).toBeNull();
    expect(screen.getByText('Test compound 7')).toBeTruthy();
    expect(screen.getByText('4 of 8 tracked compounds.', { exact: false })).toBeTruthy();
    const gas = screen.getByRole('button', { name: /Gas inventory/ });
    expect(gas.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(gas);
    expect(gas.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Test compound 7')).toBeNull();
    fireEvent.click(gas);
    expect(screen.getByText('Test compound 7')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: 'gas' } });
    expect(gas.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(gas);
    expect(screen.queryByText('Test compound 7')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: 'K6' } });
    expect(gas.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: 'gas' } });
    expect(gas.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(gas);
    expect(screen.queryByText('Test compound 7')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: '' } });
    expect(screen.getByText('Test compound 0')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: 'gas' } });
    expect(gas.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Compound family'), {
      target: { value: 'Gas inventory' },
    });
    const filteredGas = screen.getByRole('button', { name: /Gas inventory/ });
    expect(filteredGas.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(filteredGas);
    expect(filteredGas.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Test compound 7')).toBeNull();
    fireEvent.click(filteredGas);
    expect(screen.getByText('Test compound 7')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search compounds'), { target: { value: 'no match' } });
    expect(screen.getByText('No compounds match these filters.')).toBeTruthy();
  });

  it('opens sections with errors present on the first editor render, leaving valid sections folded', () => {
    const catalog = fixtureCatalog();
    useShotStore.getState().patchForm('grinder', { preset: 'removed-preset' });
    const validation = formToRecipe(useShotStore.getState().form, { catalog });
    if (validation.ok) throw new Error('Expected the obsolete preset to be rejected.');
    render(
      <RecipeEditor
        context={{
          catalog,
          errors: validation.errors,
          notes: emptyRouting(),
          notesStale: false,
          build: null,
          buildStale: false,
        }}
        onSubmit={() => {}}
      />,
    );
    expect(document.getElementById('section-grinder')?.hasAttribute('open')).toBe(true);
    const preset = screen.getByRole('combobox', { name: 'Grinder preset' });
    expect(preset.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Unknown preset "removed-preset"/)).toBeTruthy();
    expect(document.getElementById('section-bean')?.hasAttribute('open')).toBe(false);
  });
});
