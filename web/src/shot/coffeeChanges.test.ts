// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { equipmentKnowledge } from '../setup/ConstraintContext';
import { resetEquipmentStore, useEquipmentStore } from '../setup/inferenceStorage';
import type { SetupConstraint } from '../setup/inferenceTypes';
import { coffeeConstraintsAfterChange, replaceCoffee } from './coffeeChanges';
import { defaultForm, emptyForm } from './recipeForm';
import { resetShotStore, useShotStore } from './shotStore';

const locked = (path: string, value: number): SetupConstraint => ({ path, mode: 'locked', value });
const dose = locked('prep.dose_g', 18);

beforeEach(() => {
  window.localStorage.clear();
  resetEquipmentStore();
  resetShotStore();
});

describe('coffee structure and known facts', () => {
  it('removes the selected coffee and moves later locks and weights with their coffees', () => {
    const constraints = [
      dose,
      locked('bean.components.0.bean.days_off_roast', 3),
      locked('bean.components.1.bean.days_off_roast', 8),
      locked('bean.components.1.weight', 2),
      locked('bean.components.2.bean.roast_level', 0.8),
    ];
    expect(coffeeConstraintsAfterChange(constraints, { kind: 'remove', index: 0 })).toEqual([
      dose,
      locked('bean.components.0.bean.days_off_roast', 8),
      locked('bean.components.0.weight', 2),
      locked('bean.components.1.bean.roast_level', 0.8),
    ]);
    expect(constraints[2].path).toBe('bean.components.1.bean.days_off_roast');
  });
  it('clears only a replaced leaf while preserving its amount and the other coffee facts', () => {
    const weight = locked('bean.components.0.weight', 7);
    const other = locked('bean.components.1.bean.days_off_roast', 8);
    expect(
      coffeeConstraintsAfterChange(
        [dose, weight, locked('bean.components.0.bean.days_off_roast', 3), other],
        { kind: 'replace', path: 'bean.components.0.bean' },
      ),
    ).toEqual([dose, weight, other]);
  });
  it('maps single-coffee facts into a blend and retains only the selected leaf when returning', () => {
    const original = [dose, locked('bean.roast_level', 0.4), locked('bean.days_off_roast', 12)];
    const blend = coffeeConstraintsAfterChange(original, { kind: 'create-blend' });
    expect(blend).toEqual([
      dose,
      locked('bean.components.0.bean.roast_level', 0.4),
      locked('bean.components.0.bean.days_off_roast', 12),
    ]);
    expect(
      coffeeConstraintsAfterChange(
        [
          ...blend,
          locked('bean.components.0.weight', 7),
          locked('bean.components.1.bean.roast_level', 0.8),
        ],
        { kind: 'use-alone', index: 0 },
      ),
    ).toEqual(original);
  });
  it('updates global setup knowledge from Lab and restores it with recipe Undo', () => {
    const before = defaultForm();
    const original = [dose, locked('bean.roast_level', 0.4)];
    equipmentKnowledge(null).onChange(original);
    useShotStore.getState().loadForm(before);
    replaceCoffee(before, emptyForm().bean, { kind: 'replace', path: 'bean' }, null);
    expect(useEquipmentStore.getState().document.constraints).toEqual([dose]);
    useShotStore.getState().undoLast();
    expect(useEquipmentStore.getState().document.constraints).toEqual(original);
    expect(useShotStore.getState().form).toEqual(before);
  });
  it('cannot use an old recipe Undo to overwrite later explicit knowledge edits', () => {
    equipmentKnowledge(null).onChange([dose, locked('bean.roast_level', 0.4)]);
    replaceCoffee(defaultForm(), emptyForm().bean, { kind: 'replace', path: 'bean' }, null);
    equipmentKnowledge(null).onChange([locked('prep.dose_g', 20)]);
    expect(useShotStore.getState().undo).toBeNull();
    useShotStore.getState().undoLast();
    expect(useEquipmentStore.getState().document.constraints).toEqual([locked('prep.dose_g', 20)]);
  });
});
