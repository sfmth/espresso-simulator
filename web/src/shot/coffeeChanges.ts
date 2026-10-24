// SPDX-License-Identifier: GPL-2.0-or-later
import { equipmentKnowledge, type useSetupConstraints } from '../setup/ConstraintContext';
import type { SetupConstraint } from '../setup/inferenceTypes';
import type { BeanForm, RecipeForm } from './recipeForm';
import { useShotStore } from './shotStore';

export type CoffeeChange =
  | { kind: 'replace'; path: string }
  | { kind: 'create-blend' }
  | { kind: 'remove'; index: number }
  | { kind: 'use-alone'; index: number }
  | { kind: 'add' };

/** Move known facts with their coffee, never with the old positional row number. */
export function coffeeConstraintsAfterChange(
  constraints: readonly SetupConstraint[],
  change: CoffeeChange,
): SetupConstraint[] {
  return constraints.flatMap((constraint) => {
    const { path } = constraint;
    if (!path.startsWith('bean.')) return [constraint];
    if (change.kind === 'replace')
      return path === change.path || path.startsWith(`${change.path}.`) ? [] : [constraint];
    if (change.kind === 'create-blend')
      return path.startsWith('bean.components.')
        ? []
        : [{ ...constraint, path: `bean.components.0.bean.${path.slice(5)}` }];
    if (change.kind === 'use-alone') {
      const prefix = `bean.components.${change.index}.bean.`;
      return path.startsWith(prefix)
        ? [{ ...constraint, path: `bean.${path.slice(prefix.length)}` }]
        : [];
    }
    if (change.kind === 'remove') {
      const match = /^bean\.components\.(\d+)(\..+)$/.exec(path);
      if (!match) return [constraint];
      const index = Number(match[1]);
      return index === change.index
        ? []
        : [
            {
              ...constraint,
              path: `bean.components.${index > change.index ? index - 1 : index}${match[2]}`,
            },
          ];
    }
    return [constraint];
  });
}

/** Commit knowledge before its recipe; one Undo restores the same pair, in Lab or Setup. */
export function replaceCoffee(
  form: RecipeForm,
  bean: BeanForm,
  change: CoffeeChange,
  context: ReturnType<typeof useSetupConstraints>,
): boolean {
  const knowledge = equipmentKnowledge(context);
  const previous = structuredClone([...knowledge.constraints]);
  const next = coffeeConstraintsAfterChange(previous, change);
  const changed = JSON.stringify(previous) !== JSON.stringify(next);
  if (changed) knowledge.onChange(next);
  useShotStore
    .getState()
    .loadForm(
      { ...form, bean },
      'Undo coffee change',
      changed ? () => knowledge.onChange(previous) : undefined,
    );
  return changed;
}
