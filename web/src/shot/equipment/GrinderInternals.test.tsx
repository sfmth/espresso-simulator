// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../../test/fixtures/shotFixture';
import { EditorContext } from '../editor/context';
import { GrinderSection } from '../editor/GrinderSection';
import { emptyRouting } from '../notes';
import { defaultForm, formToRecipe, type FormErrors } from '../recipeForm';
import { resetShotStore, useShotStore } from '../shotStore';
import { GrinderInternals } from './GrinderInternals';

const catalog = fixtureCatalog();

function Harness({ errors = {}, twice = false }: { errors?: FormErrors; twice?: boolean }) {
  const form = useShotStore((state) => state.form);
  const result = formToRecipe(form, { catalog });
  return (
    <EditorContext.Provider
      value={{
        catalog,
        errors: { ...(result.ok ? {} : result.errors), ...errors },
        notes: emptyRouting(),
        notesStale: false,
        build: null,
        buildStale: false,
      }}
    >
      {twice ? (
        <>
          <GrinderInternals />
          <GrinderInternals />
        </>
      ) : (
        <GrinderSection />
      )}
    </EditorContext.Provider>
  );
}

function recipe() {
  const result = formToRecipe(useShotStore.getState().form, { catalog });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}

describe('illustrated grinder internals', () => {
  beforeEach(() => resetShotStore());
  afterEach(cleanup);

  it('derives the real burr assembly from the named grinder without replacing its fit', () => {
    const form = defaultForm();
    form.grinder.preset = 'amzchef-single-dose';
    resetShotStore(form);
    render(<Harness />);
    const image = screen.getByRole('img', { name: /Conical burr assembly/ });
    expect(image.querySelector('[data-burr-shape="conical"]')).toBeTruthy();
    expect(image.querySelector('desc')?.textContent).toContain('outer toothed ring');
    expect(screen.getByText(/AMZCHEF.*Effective gap:/)).toBeTruthy();
    expect(useShotStore.getState().form).toEqual(form);
    expect(screen.getAllByText('Recorded only; does not change the simulation.')).toHaveLength(2);
  });

  it('swaps the actual family and preserves the mapped dial gap, with complete undo', () => {
    const before = defaultForm();
    before.grinder.x50_gap_ratio = '1.4';
    before.grinder.burr_diameter_mm = '76';
    before.grinder.rpm = '900';
    resetShotStore(before);
    const buildBefore = fixtureBuild(recipe());
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Conical burrs' }));
    const after = recipe();
    expect(after.grinder.family).toBe('conical');
    expect(after.grinder.preset).toBeUndefined();
    expect(useShotStore.getState().form.grinder).toMatchObject({
      mode: 'family',
      by: 'gap',
      x50_gap_ratio: '',
      burr_diameter_mm: '',
      rpm: '',
    });
    expect(fixtureBuild(after).derived.psd?.gap_um).toBe(buildBefore.derived.psd?.gap_um);
    expect(screen.getByRole('button', { name: 'Conical burrs', pressed: true })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Conical burr assembly/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo burr swap' }));
    expect(useShotStore.getState().form).toEqual(before);
    expect(screen.getByRole('img', { name: /Flat burr assembly/ })).toBeTruthy();
  });

  it('keeps the builder’s clamped and calibrated gap before dropping those overrides', () => {
    const form = defaultForm();
    form.grinder.setting = '10000';
    form.grinder.gap_at_ref_um = '80';
    form.grinder.gap_per_unit_um = '1';
    resetShotStore(form);
    const expected = fixtureBuild(recipe()).derived.psd?.gap_um;
    render(<Harness />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Flat burrs, unimodal (low-fines) geometry' }),
    );
    expect(recipe().grinder.gap_um).toBe(expected);
    expect(useShotStore.getState().form.grinder.gap_at_ref_um).toBe('');
    expect(useShotStore.getState().form.grinder.gap_per_unit_um).toBe('');
  });

  it.each(['negative mapped dial', 'zero mapped dial', 'direct subminimum gap'] as const)(
    'preserves the native 5 µm floor for a %s during a family swap',
    (scenario) => {
      const form = defaultForm();
      if (scenario === 'negative mapped dial') {
        Object.assign(form.grinder, {
          preset: 'mahlkoenig-e65s',
          setting: '0',
          gap_at_ref_um: '0',
          gap_per_unit_um: '25',
        });
      } else if (scenario === 'zero mapped dial') {
        const preset = catalog.presets.grinders.find((item) => item.id === 'mahlkoenig-e65s');
        Object.assign(form.grinder, {
          preset: 'mahlkoenig-e65s',
          setting: String(preset?.dial.ref),
          gap_at_ref_um: '0',
        });
      } else {
        Object.assign(form.grinder, { by: 'gap', gap_um: '1.25' });
      }
      resetShotStore(form);
      expect(fixtureBuild(recipe()).derived.psd?.gap_um).toBe(5);
      render(<Harness />);
      expect(screen.getByText(/Effective gap: 5 µm/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Conical burrs' }));
      expect(recipe().grinder.gap_um).toBe(5);
      expect(fixtureBuild(recipe()).derived.psd?.gap_um).toBe(5);
      fireEvent.click(screen.getByRole('button', { name: 'Undo burr swap' }));
      expect(useShotStore.getState().form).toEqual(form);
    },
  );

  it('clears prior shape and calibration on a family-to-family swap and keeps its gap', () => {
    const form = defaultForm();
    Object.assign(form.grinder, {
      mode: 'family',
      family: 'conical',
      by: 'setting',
      setting: '10',
      gap_at_ref_um: '80',
      gap_per_unit_um: '10',
      fines_at_340_pct: '25',
    });
    resetShotStore(form);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Flat burrs, traditional geometry' }));
    expect(recipe().grinder).toEqual({ family: 'flat-traditional', gap_um: 180 });
  });

  it('keeps measured PSD intact with an honest unspecified-geometry drawing until a swap', () => {
    const form = defaultForm();
    form.grinder.mode = 'psd';
    form.grinder.psdText = '30 0.2\n200 0.8';
    resetShotStore(form);
    render(<Harness />);
    const image = screen.getByRole('img', { name: /Measured particle distribution/ });
    expect(image.querySelector('[data-burr-shape="unknown"]')).toBeTruthy();
    expect(image.querySelector('[data-burr-shape="flat"]')).toBeNull();
    expect(screen.getByText(/Measured PSD is active. No burr geometry is assigned./)).toBeTruthy();
    expect(screen.queryByLabelText('Internal burr gap (µm)')).toBeNull();
    expect(useShotStore.getState().form).toEqual(form);
    fireEvent.click(screen.getByRole('button', { name: 'Conical burrs' }));
    expect(recipe().grinder.family).toBe('conical');
    fireEvent.click(screen.getByRole('button', { name: 'Undo burr swap' }));
    expect(recipe().grinder.psd?.diameter_um).toEqual([30, 200]);
    expect(useShotStore.getState().form).toEqual(form);
  });

  it('shares edits and errors with the full grinder controls in both directions', () => {
    const form = defaultForm();
    form.grinder.by = 'gap';
    form.grinder.gap_um = '190';
    resetShotStore(form);
    render(<Harness />);
    const internal = screen.getByLabelText<HTMLInputElement>('Internal burr gap (µm)');
    const classic = screen.getByLabelText<HTMLInputElement>('Burr gap (µm)');
    fireEvent.change(internal, { target: { value: '225' } });
    expect(classic.value).toBe('225');
    expect(recipe().grinder.gap_um).toBe(225);
    fireEvent.change(classic, { target: { value: '210' } });
    expect(internal.value).toBe('210');
    fireEvent.change(internal, { target: { value: '-2' } });
    expect(screen.getByText(/Effective gap: not resolved/)).toBeTruthy();
    expect(internal.getAttribute('aria-invalid')).toBe('true');
    expect(classic.getAttribute('aria-invalid')).toBe('true');
    const messageId = internal.getAttribute('aria-describedby');
    expect(document.getElementById(messageId ?? '')?.textContent).toContain('Burr gap');
    fireEvent.change(screen.getByLabelText('Internal burr diameter (mm)'), {
      target: { value: '64' },
    });
    expect(useShotStore.getState().form.grinder.burr_diameter_mm).toBe('64');
    fireEvent.change(screen.getByLabelText('Internal burr speed (RPM)'), {
      target: { value: '1200' },
    });
    expect(useShotStore.getState().form.grinder.rpm).toBe('1200');
    act(() => useShotStore.getState().patchForm('grinder', { mode: 'family', family: 'conical' }));
    expect(screen.getByRole('img', { name: /Conical burr assembly/ })).toBeTruthy();
  });

  it('links family errors, generates unique IDs and focuses the full grinder field', async () => {
    const { unmount } = render(
      <Harness errors={{ 'grinder.family': 'Choose a known family.' }} twice />,
    );
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of screen.getAllByRole('group', { name: 'Swap burr family' })) {
      const descriptions = group.getAttribute('aria-describedby')?.split(' ');
      expect(
        descriptions?.some(
          (id) => document.getElementById(id)?.textContent === 'Choose a known family.',
        ),
      ).toBe(true);
    }
    unmount();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Full grinder settings' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /^Dial setting/ })),
    );
    expect(useShotStore.getState().reveal).toBeNull();
  });
});
