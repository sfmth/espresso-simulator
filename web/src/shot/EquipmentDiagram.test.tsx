// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCatalog } from '../../test/fixtures/shotFixture';
import { emptyRouting } from './notes';
import { defaultForm, formToRecipe } from './recipeForm';
import { RecipeEditor } from './RecipeEditor';
import { resetShotStore, useShotStore } from './shotStore';

const catalog = fixtureCatalog();

function EditorHarness() {
  const form = useShotStore((state) => state.form);
  const validation = formToRecipe(form, { catalog });
  return (
    <RecipeEditor
      onSubmit={vi.fn()}
      context={{
        catalog,
        errors: validation.ok ? {} : validation.errors,
        notes: emptyRouting(),
        notesStale: false,
        build: null,
        buildStale: false,
      }}
    />
  );
}

function recipe() {
  const result = formToRecipe(useShotStore.getState().form, { catalog });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}

function openClassic(id: string) {
  const details = document.getElementById(`section-${id}`);
  if (!(details instanceof HTMLDetailsElement)) throw new Error(`missing section ${id}`);
  act(() => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  });
}

function panel() {
  const element = document.getElementById('equipment-settings');
  if (!element) throw new Error('missing equipment panel');
  return element;
}

describe('visual equipment editor', () => {
  beforeEach(() => resetShotStore());
  afterEach(cleanup);

  it('links six native callout buttons to a described SVG and a single expanded panel', () => {
    render(<EditorHarness />);
    const image = screen.getByRole('img', { name: /Espresso equipment and the coffee’s path/ });
    expect(image.querySelector('desc')?.textContent).toContain('handled portafilter');
    const group = screen.getByRole('group', { name: 'Equipment settings' });
    expect(within(group).getAllByRole('button')).toHaveLength(6);
    // Spoken names contain the visible number and label, including "Basket"
    // rather than replacing that label with "Portafilter".
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      '1 Beans settings',
      '2 Grinder settings',
      '3 Machine settings',
      '4 Basket settings',
      '5 Puck / dose settings',
      '6 Cup / stop settings',
    ]);
    expect(panel().hidden).toBe(true);
    const beans = within(group).getByRole('button', { name: '1 Beans settings' });
    fireEvent.click(beans);
    expect(beans.getAttribute('aria-expanded')).toBe('true');
    expect(beans.getAttribute('aria-controls')).toBe(panel().id);
    expect(within(panel()).getByRole('heading', { name: 'Beans' })).toBeTruthy();
    expect(
      image.querySelector('[data-equipment-part="bean"]')?.classList.contains('is-active'),
    ).toBe(true);
    expect(
      image.querySelector('[data-equipment-leader="bean"]')?.classList.contains('is-active'),
    ).toBe(true);
    const grinder = within(group).getByRole('button', { name: '2 Grinder settings' });
    fireEvent.click(grinder);
    expect(beans.getAttribute('aria-expanded')).toBe('false');
    expect(within(group).getAllByRole('button', { expanded: true })).toEqual([grinder]);
    expect(screen.queryByLabelText('Diagram bean preset')).toBeNull();
    fireEvent.click(grinder);
    expect(panel().hidden).toBe(true);
  });

  it('shares quick edits with classic fields in both directions and exposes the same validation', () => {
    render(<EditorHarness />);
    fireEvent.click(screen.getByRole('button', { name: '5 Puck / dose settings' }));
    openClassic('prep');
    const quick = screen.getByLabelText<HTMLInputElement>('Diagram dry dose (g)');
    const classic = screen.getByLabelText<HTMLInputElement>('Dose (g)');
    fireEvent.change(quick, { target: { value: '19.25' } });
    expect(classic.value).toBe('19.25');
    expect(recipe().prep.dose_g).toBe(19.25);
    fireEvent.change(classic, { target: { value: '17' } });
    expect(quick.value).toBe('17');
    fireEvent.change(quick, { target: { value: '-1' } });
    expect(quick.getAttribute('aria-invalid')).toBe('true');
    expect(classic.getAttribute('aria-invalid')).toBe('true');
    const description = quick
      .getAttribute('aria-describedby')
      ?.split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(description).toContain('Dose must be between 1 g and 60 g.');
    expect(screen.getByRole('button', { name: '5 Puck / dose settings, 1 problem' })).toBeTruthy();
  });

  it('uses the grinder transition helpers and leaves measured inputs intact until a preset is chosen', () => {
    const form = defaultForm();
    form.grinder.mode = 'psd';
    form.grinder.psdText = '30 0.2\n200 0.8';
    form.grinder.gap_at_ref_um = '333';
    form.grinder.boulder_weight = '25';
    resetShotStore(form);
    render(<EditorHarness />);
    fireEvent.click(screen.getByRole('button', { name: '2 Grinder settings' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Diagram grinder preset').value).toBe(
      '__custom',
    );
    expect(useShotStore.getState().form.grinder.mode).toBe('psd');
    const ek43 = catalog.presets.grinders.find((preset) => preset.id === 'mahlkoenig-ek43');
    fireEvent.change(screen.getByLabelText('Diagram grinder preset'), {
      target: { value: 'mahlkoenig-ek43' },
    });
    expect(recipe().grinder).toEqual({ preset: 'mahlkoenig-ek43', setting: ek43?.dial.default });
    expect(useShotStore.getState().form.grinder.gap_at_ref_um).toBe('');
    expect(useShotStore.getState().form.grinder.boulder_weight).toBe('');
    openClassic('grinder');
    const quickDial = screen.getByLabelText<HTMLInputElement>(/^Diagram grinder setting/);
    fireEvent.change(quickDial, { target: { value: '1.8' } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: /^Dial setting/ }).value).toBe(
      '1.8',
    );
    expect(recipe().grinder.setting).toBe(1.8);
  });

  it('preserves machine preset, vent and custom-program undo semantics', () => {
    const form = defaultForm();
    form.machine.customProgram = true;
    form.machine.pumpMode = 'ideal';
    resetShotStore(form);
    render(<EditorHarness />);
    fireEvent.click(screen.getByRole('button', { name: '3 Machine settings' }));
    const vent = screen.getByLabelText<HTMLInputElement>('Diagram vent after stop');
    expect(vent.checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Diagram machine preset'), {
      target: { value: 'vibratory-pump' },
    });
    expect(vent.checked).toBe(false);
    expect(recipe().machine).toEqual({ preset: 'vibratory-pump' });
    expect(useShotStore.getState().form.machine.customProgram).toBe(false);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Undo machine change' }));
    expect(useShotStore.getState().form.machine).toEqual(form.machine);
    fireEvent.change(screen.getByLabelText('Diagram machine preset'), {
      target: { value: 'vibratory-pump' },
    });
    fireEvent.click(vent);
    expect(recipe().machine.vent_headspace).toBe(true);
    fireEvent.change(screen.getByLabelText('Diagram brew temperature (°C)'), {
      target: { value: '91' },
    });
    expect(recipe().machine.temperature_c).toBe(91);
  });

  it('maps bean, basket and stop controls to their actual recipe fields', () => {
    render(<EditorHarness />);
    fireEvent.click(screen.getByRole('button', { name: '1 Beans settings' }));
    fireEvent.change(screen.getByLabelText('Diagram bean preset'), {
      target: { value: 'robusta-medium' },
    });
    fireEvent.change(screen.getByLabelText('Diagram roast level (0–1)'), {
      target: { value: '0.7' },
    });
    fireEvent.change(screen.getByLabelText('Diagram days off roast'), { target: { value: '14' } });
    expect(recipe().bean).toEqual({
      preset: 'robusta-medium',
      roast_level: 0.7,
      days_off_roast: 14,
    });
    fireEvent.click(screen.getByRole('button', { name: '4 Basket settings' }));
    fireEvent.change(screen.getByLabelText('Diagram basket preset'), {
      target: { value: '54-double' },
    });
    expect(recipe().basket).toEqual({ preset: '54-double' });
    fireEvent.change(screen.getByLabelText('Diagram basket preset'), {
      target: { value: '__machine' },
    });
    expect(recipe().basket).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: '6 Cup / stop settings' }));
    fireEvent.change(screen.getByLabelText('Diagram beverage stop (g)'), {
      target: { value: '42' },
    });
    fireEvent.change(screen.getByLabelText('Diagram time stop (s)'), { target: { value: '35' } });
    expect(recipe().stop).toEqual({ beverage_g: 42, time_s: 35 });
  });

  it('keeps IDs unique with classic sections open and returns keyboard focus on Escape', () => {
    render(<EditorHarness />);
    for (const part of ['bean', 'grinder', 'machine', 'basket', 'prep', 'stop']) openClassic(part);
    for (const name of [
      '1 Beans settings',
      '2 Grinder settings',
      '3 Machine settings',
      '4 Basket settings',
      '5 Puck / dose settings',
      '6 Cup / stop settings',
    ]) {
      fireEvent.click(screen.getByRole('button', { name }));
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const stop = screen.getByRole('button', { name: '6 Cup / stop settings' });
    screen.getByLabelText('Diagram beverage stop (g)').focus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(stop);
  });

  it('opens and focuses the full editor field through More settings', async () => {
    render(<EditorHarness />);
    fireEvent.click(screen.getByRole('button', { name: '5 Puck / dose settings' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'More puck / dose settings' }));
    expect(panel().hidden).toBe(true);
    expect(screen.getByLabelText('Dose (g)')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Dose (g)')));
  });

  it('opens each detailed cutaway and puts keyboard focus at its start', async () => {
    render(<EditorHarness />);
    for (const [part, name] of [
      ['machine', 'Open machine · parts and settings'],
      ['grinder', 'Open grinder · burrs and settings'],
      ['basket', 'Open portafilter · layers and baskets'],
    ]) {
      fireEvent.click(document.querySelector(`[data-equipment-callout="${part}"]`)!);
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(document.activeElement?.id).toBe(`${part}-internals`));
      expect((document.getElementById(`section-${part}`) as HTMLDetailsElement).open).toBe(true);
    }
  });
});
