// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../../test/fixtures/shotFixture';
import { EditorContext } from '../editor/context';
import { emptyRouting } from '../notes';
import { defaultForm, formToRecipe, profileRow } from '../recipeForm';
import { resetShotStore, useShotStore } from '../shotStore';
import { PortafilterInternals } from './PortafilterInternals';

const catalog = fixtureCatalog();
function Harness() {
  const form = useShotStore((s) => s.form);
  const result = formToRecipe(form, { catalog });
  return (
    <EditorContext.Provider
      value={{
        catalog,
        errors: result.ok ? {} : result.errors,
        notes: emptyRouting(),
        notesStale: false,
        build: null,
        buildStale: false,
      }}
    >
      <PortafilterInternals />
    </EditorContext.Provider>
  );
}
function recipe() {
  const result = formToRecipe(useShotStore.getState().form, { catalog });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}

describe('portafilter parts', () => {
  beforeEach(() => resetShotStore());
  afterEach(cleanup);

  it('adds real preparation layers and updates the exploded view from external edits', () => {
    render(<Harness />);
    for (const [name, key] of [
      ['1 Puck screen', 'puck_screen'],
      ['2 Top paper', 'paper_top'],
      ['3 Bottom paper', 'paper_bottom'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
      expect(recipe().prep[key]).toBe(true);
      expect(
        document
          .querySelector(`[data-portafilter-layer="${key}"]`)
          ?.classList.contains('is-installed'),
      ).toBe(true);
    }
    expect(screen.getByText(/Top paper is recorded/)).toBeTruthy();
  });

  it('replaces a custom basket and Undo restores its complete geometry and preparation', () => {
    const form = defaultForm();
    form.basket.mode = 'custom';
    form.basket.profile = [profileRow('0', '48'), profileRow('25', '58')];
    form.basket.perforated_diameter_mm = '45';
    form.prep.paper_bottom = true;
    resetShotStore(form);
    render(<Harness />);
    fireEvent.click(document.querySelector('[data-basket-part-choice="54-double"]')!);
    expect(recipe().basket).toEqual({ preset: '54-double' });
    expect(recipe().prep.paper_bottom).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo basket part change' }));
    expect(useShotStore.getState().form).toEqual(form);
  });

  it('copies the selected preset geometry when replacing its outlet and keeps the coefficients', () => {
    render(<Harness />);
    const source = catalog.presets.baskets.find((p) => p.id === '58-precision-18g')!;
    fireEvent.click(screen.getByRole('button', { name: 'Dual wall' }));
    const current = recipe().basket?.custom;
    expect(current?.profile_mm).toEqual(source.profile_mm);
    expect(current?.perforated_diameter_mm).toBe(source.perforated_diameter_mm);
    expect(current?.open_area_fraction).toBe(source.open_area_fraction);
    expect(current?.pressurised_orifice_mm).toBeGreaterThan(0);
    expect(document.querySelector('[data-portafilter-outlet="pressurised"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plain holes' }));
    expect(recipe().basket?.custom?.pressurised_orifice_mm).toBeUndefined();
    expect(recipe().basket?.custom?.profile_mm).toEqual(source.profile_mm);
  });

  it('withholds malformed custom geometry and links invalid outlet input to its error', () => {
    const form = defaultForm();
    form.basket.mode = 'custom';
    form.basket.outlet = 'pressurised';
    form.basket.pressurised_orifice_mm = '-1';
    form.basket.profile = [profileRow('0', '58'), profileRow('', '58')];
    resetShotStore(form);
    render(<Harness />);
    expect(screen.getByText('Choose a valid basket below')).toBeTruthy();
    expect(document.querySelector('path[d*="NaN"]')).toBeNull();
    const input = screen.getByLabelText('Internal outlet diameter (mm)');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toContain(
      'diameter',
    );
  });
});
