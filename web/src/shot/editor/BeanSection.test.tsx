// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fixtureCatalog } from '../../../test/fixtures/shotFixture';
import { COFFEE_CATALOG } from '../../coffee/catalog';
import { emptyRouting } from '../notes';
import { emptyForm, formToRecipe } from '../recipeForm';
import { ConstraintContextProvider, useSetupConstraints } from '../../setup/ConstraintContext';
import type { SetupConstraint } from '../../setup/inferenceTypes';
import { resetShotStore, useShotStore } from '../shotStore';
import { BeanSection } from './BeanSection';
import { EditorContext } from './context';

const catalog = fixtureCatalog();
function Harness() {
  const form = useShotStore((state) => state.form);
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
      <BeanSection />
    </EditorContext.Provider>
  );
}
function KnowledgeHarness({ initial }: { initial: SetupConstraint[] }) {
  const [constraints, setConstraints] = useState(initial);
  return (
    <ConstraintContextProvider parameters={[]} constraints={constraints} onChange={setConstraints}>
      <Harness />
      <output aria-label="Coffee knowledge">{JSON.stringify(constraints)}</output>
      <KnowledgeChange />
    </ConstraintContextProvider>
  );
}
function KnowledgeChange() {
  const context = useSetupConstraints()!;
  return (
    <button
      type="button"
      onClick={() => context.onChange([{ path: 'prep.dose_g', mode: 'locked', value: 20 }])}
    >
      Change known dose
    </button>
  );
}
function recipe() {
  const result = formToRecipe(useShotStore.getState().form, { catalog });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.recipe;
}
beforeEach(() => resetShotStore());
afterEach(cleanup);

describe('coffee and blend editor', () => {
  it('finds sourced single coffees and keeps publisher color separate from the roast assumption', () => {
    render(<Harness />);
    const source = COFFEE_CATALOG.find((c) => c.roast_color)!;
    fireEvent.change(screen.getByLabelText('Find a coffee'), { target: { value: source.roaster } });
    fireEvent.change(screen.getByLabelText('Coffee'), { target: { value: `coffee:${source.id}` } });
    expect(recipe().bean.coffee?.roast_color).toEqual(source.roast_color);
    expect(recipe().bean.roast_level).toBe(source.roast_level);
    expect(screen.getByRole('link', { name: 'Roaster’s source' }).getAttribute('href')).toBe(
      source.source_url,
    );
    fireEvent.change(screen.getByLabelText('Measured roast color'), { target: { value: '112.5' } });
    expect(recipe().bean.coffee?.roast_color?.value).toBe(112.5);
    expect(recipe().bean.roast_level).toBe(source.roast_level);
    fireEvent.change(screen.getByLabelText('Roast description'), { target: { value: '0.8' } });
    expect(recipe().bean.roast_level).toBe(0.8);
    expect(recipe().bean.coffee?.roast_color?.value).toBe(112.5);
    expect(recipe().bean.coffee?.roast_label).toBe(source.roast_label);
    expect(recipe().bean.coffee?.model_roast_basis).toContain(source.assumptions[1]);
    fireEvent.change(screen.getByLabelText('Source URL'), {
      target: { value: 'https://example.com/my-bag-notes' },
    });
    expect(screen.getByRole('link', { name: 'Roaster’s source' }).getAttribute('href')).toBe(
      source.source_url,
    );
    expect(recipe().bean.coffee?.source_url).toBe('https://example.com/my-bag-notes');
  });

  it('hides canned blend presets from normal choices and uses explicit species', () => {
    render(<Harness />);
    const choices = Array.from(screen.getByLabelText<HTMLSelectElement>('Coffee').options).map(
      (o) => o.value,
    );
    expect(choices).not.toContain('preset:dark-80-20-blend');
    expect(choices).not.toContain('preset:medium-dark-90-10-blend');
    fireEvent.change(screen.getByLabelText('Species'), { target: { value: '0' } });
    expect(recipe().bean.arabica_fraction).toBe(0);
  });

  it('describes an inherited legacy species mixture without calling it pure Arabica', () => {
    useShotStore.getState().patchForm('bean', {
      preset: 'dark-80-20-blend',
      arabica_fraction: '',
    });
    render(<Harness />);
    expect(screen.getByLabelText<HTMLSelectElement>('Species').selectedOptions[0].text).toBe(
      'Use imported mixture: 80% Arabica',
    );
    expect(recipe().bean.preset).toBe('dark-80-20-blend');
    expect(recipe().bean.arabica_fraction).toBeUndefined();
  });

  it('composes coffees, displays normalized shares, and can return to one coffee with Undo', () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a blend with this coffee' }));
    fireEvent.change(screen.getByLabelText('Coffee 1 parts by mass'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Coffee 2 parts by mass'), { target: { value: '1' } });
    const cards = container.querySelectorAll<HTMLElement>('.coffee-component');
    fireEvent.change(within(cards[0]).getByLabelText('Days off roast'), { target: { value: '3' } });
    fireEvent.change(within(cards[1]).getByLabelText('Species'), { target: { value: '0' } });
    fireEvent.change(within(cards[1]).getByLabelText('Days off roast'), {
      target: { value: '20' },
    });
    expect(recipe().bean.components?.map((c) => c.weight)).toEqual([3, 1]);
    expect(recipe().bean.components?.map((c) => c.bean.days_off_roast)).toEqual([3, 20]);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('75.0 percent');
    expect(recipe().bean.preset).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Use coffee 2 alone' }));
    expect(recipe().bean.components).toBeUndefined();
    expect(recipe().bean.arabica_fraction).toBe(0);
    expect(recipe().bean.days_off_roast).toBe(20);
    expect(useShotStore.getState().undo?.form.bean.components).toHaveLength(2);
  });

  it('limits the composer to six coffees and announces invalid component weights', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a blend with this coffee' }));
    for (let i = 0; i < 4; i++)
      fireEvent.click(screen.getByRole('button', { name: 'Add another coffee' }));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Add another coffee' }).disabled,
    ).toBe(true);
    const weight = screen.getByLabelText('Coffee 1 parts by mass');
    fireEvent.change(weight, { target: { value: '0' } });
    expect(weight.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Each coffee needs a positive weight.')).toBeTruthy();
  });

  it('only changes recorded age when the user explicitly calculates it for a valid shot date', () => {
    useShotStore.getState().patchForm('bean', { days_off_roast: '7' });
    render(<Harness />);
    const roast = screen.getByLabelText('Roast date (YYYY-MM-DD)');
    const shot = screen.getByLabelText('Shot date for age (YYYY-MM-DD)');
    fireEvent.change(roast, { target: { value: '2026-10-01' } });
    fireEvent.change(shot, { target: { value: '2026-10-23' } });
    expect(recipe().bean.days_off_roast).toBe(7);
    fireEvent.click(
      screen.getByRole('button', { name: 'Calculate age from roast date', hidden: true }),
    );
    expect(recipe().bean.days_off_roast).toBe(22);
    expect(recipe().bean.coffee?.roast_date).toBe('2026-10-01');
    fireEvent.change(shot, { target: { value: '2026-10-24' } });
    expect(recipe().bean.days_off_roast).toBe(22);
    fireEvent.change(roast, { target: { value: '2026-10-25' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Calculate age from roast date', hidden: true }),
    );
    expect(recipe().bean.days_off_roast).toBe(22);
    expect(screen.getByText('The roast date must be on or before the shot date.')).toBeTruthy();
  });

  it('restores custom bag details after replacing a coffee', () => {
    useShotStore.getState().patchForm('bean', {
      days_off_roast: '23',
      roast_level: '0.537',
      coffee: {
        name: 'My measured bag',
        roast_date: '2026-09-30',
        varieties: ['My variety'],
        roast_color: { scale: 'colorette', sample: 'whole-bean', value: '99.3' },
      },
    });
    const before = recipe().bean;
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Coffee'), {
      target: { value: `coffee:${COFFEE_CATALOG[0].id}` },
    });
    expect(recipe().bean.coffee?.id).toBe(COFFEE_CATALOG[0].id);
    fireEvent.click(screen.getByRole('button', { name: 'Undo coffee change' }));
    expect(recipe().bean).toEqual(before);
  });

  it('restores a removed or replaced blend component with its original weight and settings', () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a blend with this coffee' }));
    fireEvent.change(screen.getByLabelText('Coffee 2 parts by mass'), { target: { value: '3' } });
    const second = container.querySelectorAll<HTMLElement>('.coffee-component')[1];
    fireEvent.change(within(second).getByLabelText('Days off roast'), { target: { value: '40' } });
    fireEvent.change(within(second).getByLabelText('Coffee name'), {
      target: { value: 'Keep this coffee' },
    });
    const before = recipe().bean;
    fireEvent.change(within(second).getByLabelText('Coffee'), {
      target: { value: `coffee:${COFFEE_CATALOG[0].id}` },
    });
    expect(recipe().bean.components?.[1].bean.coffee?.id).toBe(COFFEE_CATALOG[0].id);
    fireEvent.click(screen.getByRole('button', { name: 'Undo coffee change' }));
    expect(recipe().bean).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Remove coffee 2', hidden: true }));
    expect(recipe().bean.components).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Undo coffee change' }));
    expect(recipe().bean).toEqual(before);
  });

  it('moves known settings with retained blend coffees and restores both with Undo', () => {
    const bean = emptyForm().bean;
    useShotStore.getState().patchForm('bean', {
      ...bean,
      components: [3, 8, 20].map((age, index) => ({
        key: `known-${index}`,
        weight: String(index + 1),
        bean: { ...bean, days_off_roast: String(age) },
      })),
    });
    const before = recipe().bean;
    const initial: SetupConstraint[] = [
      { path: 'prep.dose_g', mode: 'locked', value: 18 },
      ...[3, 8, 20].map((age, index): SetupConstraint => ({
        path: `bean.components.${index}.bean.days_off_roast`,
        mode: 'locked',
        value: age,
      })),
    ];
    render(<KnowledgeHarness initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove coffee 1' }));
    const changed = JSON.parse(screen.getByLabelText('Coffee knowledge').textContent ?? '[]');
    expect(changed).toEqual([
      initial[0],
      { ...initial[2], path: 'bean.components.0.bean.days_off_roast' },
      { ...initial[3], path: 'bean.components.1.bean.days_off_roast' },
    ]);
    expect(recipe().bean.components?.map((c) => c.bean.days_off_roast)).toEqual([8, 20]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo coffee change' }));
    expect(JSON.parse(screen.getByLabelText('Coffee knowledge').textContent ?? '[]')).toEqual(
      initial,
    );
    expect(recipe().bean).toEqual(before);
  });

  it('invalidates paired coffee Undo after a new explicit knowledge edit', () => {
    render(
      <KnowledgeHarness initial={[{ path: 'bean.roast_level', mode: 'locked', value: 0.4 }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create a blend with this coffee' }));
    expect(screen.getByLabelText('Coffee knowledge').textContent).toContain(
      'bean.components.0.bean.roast_level',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change known dose' }));
    expect(screen.queryByRole('button', { name: 'Undo coffee change' })).toBeNull();
    expect(useShotStore.getState().undo).toBeNull();
  });
});
