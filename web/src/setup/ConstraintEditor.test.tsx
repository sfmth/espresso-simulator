// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCatalog } from '../../test/fixtures/shotFixture';
import { emptyRouting } from '../shot/notes';
import { RecipeEditor } from '../shot/RecipeEditor';
import { resetShotStore, useShotStore } from '../shot/shotStore';
import { TextField } from '../shot/fields';
import { ConstraintContextProvider } from './ConstraintContext';
import { ConstraintEditor } from './ConstraintEditor';
import type { SetupConstraint, SetupParameter } from './inferenceTypes';

const parameters: SetupParameter[] = [
  {
    path: 'prep.dose_g',
    label: 'Dose',
    unit: 'g',
    kind: 'number',
    value: 18,
    min: 1,
    max: 60,
    group: 'Puck preparation',
    modeled: true,
  },
  {
    path: 'prep.distribution',
    label: 'Distribution',
    unit: '',
    kind: 'category',
    value: 'wdt',
    choices: ['none', 'tap', 'wdt'],
    group: 'Puck preparation',
    modeled: true,
  },
  {
    path: 'prep.puck_screen',
    label: 'Puck screen',
    unit: '',
    kind: 'boolean',
    value: false,
    choices: [false, true],
    group: 'Puck preparation',
    modeled: true,
  },
  {
    path: 'grinder.rpm',
    label: 'Burr speed',
    unit: 'RPM',
    kind: 'number',
    value: 1000,
    group: 'Grinder',
    modeled: false,
    reason: 'Recorded only; burr speed has no physical effect in the current model.',
  },
  {
    path: 'overrides.model.permeability',
    label: 'Permeability multiplier',
    unit: '',
    kind: 'number',
    value: 1,
    min: 0.1,
    max: 10,
    group: 'Advanced model',
    modeled: true,
  },
];

function Harness({
  initial = [],
  inline = false,
}: {
  initial?: SetupConstraint[];
  inline?: boolean;
}) {
  const [constraints, setConstraints] = useState(initial);
  return (
    <ConstraintContextProvider
      parameters={parameters}
      constraints={constraints}
      onChange={setConstraints}
    >
      {inline && <TextField path="prep.dose_g" label="Dose (g)" value="18" onChange={vi.fn()} />}
      <ConstraintEditor
        parameters={parameters}
        constraints={constraints}
        onChange={setConstraints}
      />
      <output aria-label="Current constraints">{JSON.stringify(constraints)}</output>
    </ConstraintContextProvider>
  );
}

function constraints(): SetupConstraint[] {
  return JSON.parse(
    screen.getByLabelText('Current constraints').textContent ?? '[]',
  ) as SetupConstraint[];
}

describe('equipment knowledge controls', () => {
  beforeEach(() => resetShotStore());
  afterEach(cleanup);

  it('keeps initial values as assumptions, locks only active physical settings, and allows clearing', () => {
    render(<Harness />);
    expect(screen.getByText('0 locked · 0 to find · 4 fixed assumptions')).toBeTruthy();
    expect(constraints()).toEqual([]);
    expect(screen.getByLabelText('What is known about Burr speed?').hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lock all current physical settings' }));
    expect(constraints()).toHaveLength(4);
    expect(constraints().some((constraint) => constraint.path === 'grinder.rpm')).toBe(false);
    expect(constraints().find((constraint) => constraint.path === 'prep.puck_screen')?.value).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear locks and search choices' }));
    expect(constraints()).toEqual([]);
    expect(screen.getByText('All settings are fixed assumptions again.')).toBeTruthy();
  });

  it('retains exact locks while editing a separate bounded parameter and exposes invalid ranges', () => {
    render(
      <Harness
        initial={[
          { path: 'prep.distribution', mode: 'locked', value: 'wdt' },
          { path: 'prep.dose_g', mode: 'range', min: 16, max: 20 },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Minimum Dose (g)'), { target: { value: '22' } });
    expect(screen.getByText('The lower bound must not exceed the upper bound.')).toBeTruthy();
    expect(constraints().find((constraint) => constraint.path === 'prep.distribution')).toEqual({
      path: 'prep.distribution',
      mode: 'locked',
      value: 'wdt',
    });
    fireEvent.change(screen.getByLabelText('Maximum Dose (g)'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Step for Dose (optional)'), {
      target: { value: '0.5' },
    });
    expect(constraints().find((constraint) => constraint.path === 'prep.dose_g')).toEqual({
      path: 'prep.dose_g',
      mode: 'range',
      min: 22,
      max: 25,
      step: 0.5,
    });
    fireEvent.change(screen.getByLabelText('Minimum Dose (g)'), { target: { value: '' } });
    expect(screen.getByLabelText('Minimum Dose (g)').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a finite lower and upper bound.')).toBeTruthy();
  });

  it('preserves categorical and boolean choices without converting their types', () => {
    render(
      <Harness initial={[{ path: 'prep.puck_screen', mode: 'range', choices: [false, true] }]} />,
    );
    const group = screen.getByRole('group', { name: 'Allowed Puck screen choices' });
    fireEvent.click(within(group).getByLabelText('Yes'));
    expect(constraints()[0].choices).toEqual([false]);
    fireEvent.click(within(group).getByLabelText('No'));
    expect(screen.getByText('Select at least one allowed choice.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What is known about Puck screen?'), {
      target: { value: 'locked' },
    });
    fireEvent.change(screen.getByLabelText('Locked Puck screen'), { target: { value: '1' } });
    expect(constraints()[0].value).toBe(true);
  });

  it('opens and focuses the matching detailed constraint from an inline range control', () => {
    render(<Harness inline />);
    fireEvent.change(screen.getByLabelText('Knowledge of Dose'), { target: { value: 'range' } });
    expect(constraints()).toEqual([{ path: 'prep.dose_g', mode: 'range', min: 1, max: 60 }]);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Constraint for Dose');
    expect(screen.getAllByLabelText('Minimum Dose (g)')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('What is known about Dose?'), {
      target: { value: 'locked' },
    });
    fireEvent.change(screen.getByLabelText('Locked Dose (g)'), { target: { value: '19' } });
    expect(
      screen.getByRole('button', { name: 'Locked: 19 g. Edit constraint for Dose' }).textContent,
    ).toBe('Locked: 19 g');
    expect(
      screen.getByText(
        'The solver will use this locked value instead of the current editor value.',
      ),
    ).toBeTruthy();
  });

  it('searches assumptions and advanced settings, retains unavailable constraints for explicit removal', () => {
    render(<Harness initial={[{ path: 'grinder.old_field', mode: 'unknown' }]} />);
    fireEvent.change(screen.getByLabelText('Find an equipment parameter'), {
      target: { value: 'permeability' },
    });
    fireEvent.change(screen.getByLabelText('What is known about Permeability multiplier?'), {
      target: { value: 'unknown' },
    });
    expect(constraints()).toContainEqual({ path: 'overrides.model.permeability', mode: 'unknown' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove unavailable constraint grinder.old_field' }),
    );
    expect(constraints()).toEqual([{ path: 'overrides.model.permeability', mode: 'unknown' }]);
  });

  it('uses the illustrated Lab controls in setup without changing their shared recipe values', () => {
    const catalog = fixtureCatalog();
    const changed = vi.fn();
    render(
      <ConstraintContextProvider parameters={parameters} constraints={[]} onChange={changed}>
        <RecipeEditor
          formLabel="Equipment setup"
          submitLabel="Save equipment values"
          onSubmit={vi.fn()}
          context={{
            catalog,
            errors: {},
            notes: emptyRouting(),
            notesStale: false,
            build: null,
            buildStale: false,
          }}
        />
      </ConstraintContextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '5 Puck / dose settings' }));
    fireEvent.change(screen.getByLabelText('Knowledge of Dose'), { target: { value: 'locked' } });
    expect(changed).toHaveBeenCalledWith([{ path: 'prep.dose_g', mode: 'locked', value: 18 }]);
    expect(useShotStore.getState().form.prep.dose_g).toBe('18');
    expect(screen.getByRole('form', { name: 'Equipment setup' })).toBeTruthy();
  });
});

it('uses named roast choices for known facts and keeps internal coordinates out of the ordinary inventory', () => {
  const roast: SetupParameter = {
    path: 'bean.roast_level',
    label: 'Model roast estimate',
    unit: '',
    kind: 'number',
    value: 0.5,
    min: 0,
    max: 1,
    group: 'Coffee',
    modeled: true,
  };
  const change = vi.fn();
  const view = render(
    <ConstraintEditor parameters={[roast, parameters[0]]} constraints={[]} onChange={change} />,
  );
  expect(screen.queryByLabelText('What is known about Model roast estimate?')).toBeNull();
  view.rerender(
    <ConstraintEditor
      parameters={[roast, parameters[0]]}
      constraints={[{ path: roast.path, mode: 'locked', value: 0.5 }]}
      onChange={change}
    />,
  );
  const choice = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Locked Model roast estimate',
  });
  expect(choice.selectedOptions[0].textContent).toBe('Medium');
  expect(screen.getByText('Current setting: Medium (estimate)')).toBeTruthy();
  fireEvent.change(choice, { target: { value: '0.25' } });
  expect(change).toHaveBeenLastCalledWith([{ path: roast.path, mode: 'locked', value: 0.25 }]);
});
