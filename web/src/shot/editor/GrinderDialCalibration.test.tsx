// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fixtureBuild, fixtureCatalog } from '../../../test/fixtures/shotFixture';
import { ConstraintContextProvider } from '../../setup/ConstraintContext';
import { inferenceParameters } from '../../setup/parameterCatalog';
import type { SetupConstraint } from '../../setup/inferenceTypes';
import { DEFAULT_RECIPE, formToRecipe } from '../recipeForm';
import { resetShotStore, useShotStore } from '../shotStore';
import { emptyRouting } from '../notes';
import { EditorContext } from './context';
import { GrinderDialCalibration } from './GrinderDialCalibration';
import { makeCustomDial } from '../grinderCalibration';
import { resetEquipmentStore, useEquipmentStore } from '../../setup/inferenceStorage';

const catalog = fixtureCatalog();
beforeEach(() => {
  resetShotStore();
  localStorage.clear();
  resetEquipmentStore();
});
afterEach(cleanup);
function show(
  constraints: SetupConstraint[] | null,
  onChange: (constraints: SetupConstraint[]) => void,
) {
  return render(
    <EditorContext.Provider
      value={{
        catalog,
        errors: {},
        notes: emptyRouting(),
        notesStale: false,
        build: null,
        buildStale: false,
      }}
    >
      {constraints ? (
        <ConstraintContextProvider
          parameters={inferenceParameters(DEFAULT_RECIPE, catalog)}
          constraints={constraints}
          onChange={onChange}
        >
          <GrinderDialCalibration />
        </ConstraintContextProvider>
      ) : (
        <GrinderDialCalibration />
      )}
    </EditorContext.Provider>,
  );
}
it('lets a user enter reverse grinder numbers, then estimate their conversion without supplying microns', () => {
  const onChange = vi.fn();
  show([], onChange);
  fireEvent.change(screen.getByLabelText('My current grinder number'), {
    target: { value: '4.5' },
  });
  fireEvent.change(screen.getByLabelText('Larger numbers make my grind'), {
    target: { value: 'finer' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use these grinder numbers' }));
  const converted = formToRecipe(useShotStore.getState().form, { catalog });
  expect(converted.ok).toBe(true);
  if (!converted.ok) return;
  expect(converted.recipe.grinder).toMatchObject({
    setting: 4.5,
    setting_ref: 4.5,
    gap_per_unit_um: -10,
  });
  expect(fixtureBuild(converted.recipe).spec).toEqual(fixtureBuild(DEFAULT_RECIPE).spec);
  expect(screen.getByRole('status').textContent).toContain('starting estimate');
  fireEvent.click(screen.getByRole('button', { name: 'Estimate dial calibration from my shots' }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      { path: 'grinder.setting', mode: 'locked', value: 4.5 },
      { path: 'grinder.setting_ref', mode: 'locked', value: 4.5 },
      { path: 'grinder.gap_per_unit_um', mode: 'range', min: -50, max: -2 },
      { path: 'grinder.gap_at_ref_um', mode: 'range', min: 5, max: 380 },
    ]),
  );
});

it('Undo restores both a relabeled grinder and its previous setup constraints', () => {
  const previousForm = structuredClone(useShotStore.getState().form);
  const constraints: SetupConstraint[] = [
    { path: 'grinder.setting', mode: 'locked', value: 190 },
    { path: 'grinder.gap_per_unit_um', mode: 'locked', value: 1 },
    { path: 'prep.dose_g', mode: 'locked', value: 18 },
  ];
  const onChange = vi.fn();
  show(constraints, onChange);
  fireEvent.change(screen.getByLabelText('My current grinder number'), {
    target: { value: '3001' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use these grinder numbers' }));
  expect(onChange).toHaveBeenLastCalledWith([constraints[2]]);
  expect(useShotStore.getState().form.grinder.setting).toBe('3001');
  act(() => useShotStore.getState().undoLast());
  expect(useShotStore.getState().form).toEqual(previousForm);
  expect(onChange).toHaveBeenLastCalledWith(constraints);
});

it('Undo restores previous sensitivity and knowledge after two-point calibration', () => {
  const custom = makeCustomDial(useShotStore.getState().form, catalog, 4.5, 'finer');
  if (!custom.ok) throw new Error(custom.error);
  useShotStore.getState().loadForm(custom.value);
  const constraints: SetupConstraint[] = [
    { path: 'grinder.gap_per_unit_um', mode: 'locked', value: -10 },
  ];
  const onChange = vi.fn();
  show(constraints, onChange);
  fireEvent.change(screen.getByLabelText('Second dial number'), { target: { value: '6.5' } });
  fireEvent.change(screen.getByLabelText('Second effective gap (µm)'), {
    target: { value: '150' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply two-point calibration' }));
  expect(useShotStore.getState().form.grinder.gap_per_unit_um).toBe('-20');
  expect(onChange).toHaveBeenLastCalledWith([]);
  act(() => useShotStore.getState().undoLast());
  expect(useShotStore.getState().form.grinder.gap_per_unit_um).toBe('-10');
  expect(onChange).toHaveBeenLastCalledWith(constraints);
});

it('Lab calibration also clears and restores saved equipment knowledge', () => {
  const constraints: SetupConstraint[] = [
    { path: 'grinder.setting', mode: 'locked', value: 190 },
    { path: 'prep.dose_g', mode: 'locked', value: 18 },
  ];
  useEquipmentStore.getState().update((document) => ({ ...document, constraints }));
  show(null, vi.fn());
  fireEvent.change(screen.getByLabelText('My current grinder number'), { target: { value: '-3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use these grinder numbers' }));
  expect(useEquipmentStore.getState().document.constraints).toEqual([constraints[1]]);
  act(() => useShotStore.getState().undoLast());
  expect(useEquipmentStore.getState().document.constraints).toEqual(constraints);
  expect(useShotStore.getState().form.grinder.setting).toBe('190');
});

it('keeps the recipe intact and explains a refused equipment-knowledge change', () => {
  const before = structuredClone(useShotStore.getState().form);
  show([], () => {
    throw new Error('Equipment setup changed in another tab. Reload before saving.');
  });
  fireEvent.change(screen.getByLabelText('My current grinder number'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use these grinder numbers' }));
  expect(useShotStore.getState().form).toEqual(before);
  expect(screen.getByRole('alert').textContent).toContain('another tab');
});
