// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../../test/fixtures/shotFixture';
import { EditorContext } from '../editor/context';
import { emptyRouting } from '../notes';
import { defaultForm, formToRecipe } from '../recipeForm';
import { resetShotStore, useShotStore } from '../shotStore';
import { MachineInternals } from './MachineInternals';

const catalog = fixtureCatalog();
const mass = 'model.thermal.hardware_water_equivalent';
const preheat = 'model.thermal.hardware_temperature';
const cooling = 'model.thermal.loss_time_constant';

function Harness() {
  const form = useShotStore((state) => state.form);
  const validation = formToRecipe(form, { catalog });
  return (
    <EditorContext.Provider
      value={{
        catalog,
        errors: validation.ok ? {} : validation.errors,
        notes: emptyRouting(),
        notesStale: false,
        build: null,
        buildStale: false,
      }}
    >
      <MachineInternals />
    </EditorContext.Provider>
  );
}
function recipe() {
  const validation = formToRecipe(useShotStore.getState().form, { catalog });
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  return validation.recipe;
}
function group() {
  fireEvent.click(screen.getByRole('button', { name: '3 Group / valve internal settings' }));
}

describe('machine internals', () => {
  beforeEach(() => resetShotStore());
  afterEach(cleanup);

  it('switches the heater illustration without changing or pretending to save physics', () => {
    render(<Harness />);
    const before = structuredClone(useShotStore.getState().form);
    expect(screen.getByRole('img', { name: /Machine cutaway with a boiler/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thermoblock illustration' }));
    expect(screen.getByRole('img', { name: /Machine cutaway with a thermoblock/ })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Thermoblock illustration' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText(/Illustration only, not saved as equipment/).textContent).toContain(
      'PID control are not simulated',
    );
    expect(useShotStore.getState().form).toEqual(before);
    fireEvent.change(screen.getByLabelText('Internal Brew temperature (°C)'), {
      target: { value: '91' },
    });
    expect(fixtureBuild(recipe()).spec.thermal.water_temp_c).toBe(91);
  });

  it('applies user-entered thermal settings to real physics and preserves unrelated values', () => {
    const original = defaultForm();
    original.overrides = { [mass]: '38', [cooling]: '333', 'extraction.max_yield': '29' };
    resetShotStore(original);
    render(<Harness />);
    group();
    expect(screen.getByText('Custom group thermal settings.')).toBeTruthy();
    const before = fixtureBuild(recipe()).spec.thermal;
    expect(useShotStore.getState().form.overrides['extraction.max_yield']).toBe('29');
    fireEvent.change(screen.getByLabelText('Internal Group thermal mass (water-equivalent g)'), {
      target: { value: '80' },
    });
    fireEvent.change(screen.getByLabelText('Internal Group starting temperature (°C)'), {
      target: { value: '90' },
    });
    const after = fixtureBuild(recipe()).spec.thermal;
    expect(after.heat_capacity_j_k).toBeGreaterThan(before.heat_capacity_j_k);
    expect(after.initial_bed_temp_c).toBeGreaterThan(before.initial_bed_temp_c);
    expect(Object.keys(recipe().overrides ?? {})).toHaveLength(4);
    expect(useShotStore.getState().form.overrides['extraction.max_yield']).toBe('29');
  });

  it('resets only group assumptions and restores prior overrides with Undo', () => {
    const original = defaultForm();
    original.overrides = {
      [mass]: '49',
      [preheat]: '80',
      [cooling]: '230',
      'extraction.max_yield': '30',
    };
    resetShotStore(original);
    render(<Harness />);
    group();
    fireEvent.click(screen.getByRole('button', { name: 'Use existing group defaults' }));
    expect(useShotStore.getState().form.overrides).toEqual({ 'extraction.max_yield': '30' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo group assembly change' }));
    expect(useShotStore.getState().form.overrides).toEqual(original.overrides);
  });

  it('marks custom thermal inputs, exposes shared validation and clears back to registry defaults', () => {
    render(<Harness />);
    group();
    expect(screen.getByText('Using existing group defaults.')).toBeTruthy();
    const field = screen.getByLabelText('Internal Group thermal mass (water-equivalent g)');
    fireEvent.change(field, { target: { value: '1001' } });
    expect(screen.getByText('Custom group thermal settings.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(field.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('1000');
    fireEvent.change(field, { target: { value: '' } });
    expect(useShotStore.getState().form.overrides[mass]).toBeUndefined();
    expect(screen.getByText('Using existing group defaults.')).toBeTruthy();
    expect(fixtureBuild(recipe()).spec.thermal.heat_capacity_j_k).toBeGreaterThan(0);
  });

  it('uses actual pump transitions, honors preset values and builds edited pump curves', () => {
    const form = defaultForm();
    form.machine.preset = 'amzchef-ultra';
    resetShotStore(form);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '2 Pump internal settings' }));
    const selector = screen.getByLabelText('Internal pump model');
    fireEvent.change(selector, { target: { value: 'vibratory' } });
    const preset = catalog.presets.machines.find((p) => p.id === 'amzchef-ultra')?.pump;
    expect(preset?.type).toBe('vibratory');
    if (preset?.type !== 'vibratory') throw new Error('vibratory fixture required');
    expect(useShotStore.getState().form.machine.free_flow_ml_s).toBe(String(preset.free_flow_ml_s));
    fireEvent.change(screen.getByLabelText('Internal Free pump flow (mL/s)'), {
      target: { value: '7' },
    });
    const pump = fixtureBuild(recipe()).spec.machine.pump;
    expect(pump.type).toBe('vibratory');
    if (pump.type !== 'vibratory') throw new Error('vibratory output required');
    expect(pump.free_flow_m3_s).toBeCloseTo(7e-6, 12);
    fireEvent.change(selector, { target: { value: 'ideal' } });
    expect(fixtureBuild(recipe()).spec.machine.pump.type).toBe('ideal');
    fireEvent.change(selector, { target: { value: 'preset' } });
    expect(recipe().machine.pump).toBeUndefined();
  });

  it('switches the real stop valve and updates the cutaway', () => {
    render(<Harness />);
    group();
    const valve = screen.getByLabelText('Internal three-way valve: vent the group after stop');
    expect(fixtureBuild(recipe()).spec.machine.stop.vent_headspace).toBe(true);
    fireEvent.click(valve);
    expect(fixtureBuild(recipe()).spec.machine.stop.vent_headspace).toBe(false);
    expect(screen.getByRole('img', { name: /unvented group/ })).toBeTruthy();
    fireEvent.click(valve);
    expect(fixtureBuild(recipe()).spec.machine.stop.vent_headspace).toBe(true);
  });

  it('keeps controls and leaders synchronized and closes to the triggering part on Escape', () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: '2 Pump internal settings' });
    fireEvent.click(button);
    expect(
      document
        .querySelector('[data-machine-internal-part="pump"]')
        ?.classList.contains('is-active'),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-machine-internal-leader="pump"]')
        ?.classList.contains('is-active'),
    ).toBe(true);
    screen.getByLabelText('Internal pump model').focus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')?.hidden).toBe(true);
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
