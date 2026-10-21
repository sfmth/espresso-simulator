// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { fixtureBuild, fixtureCatalog, fixtureRun } from '../../test/fixtures/shotFixture';
import { EngineContext } from '../engine/EngineContext';
import type { Engine } from '../engine/engine';
import type { Recipe } from '../engine/shotTypes';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import {
  nextShotForAlternative,
  SetupPrediction,
  validateAlternativeGrind,
} from './SetupPrediction';
import {
  emptySetupDocument,
  resetEquipmentStore,
  useEquipmentStore,
  type SavedSetup,
} from './inferenceStorage';

const catalog = fixtureCatalog();
beforeEach(() => {
  localStorage.clear();
  resetEquipmentStore();
});
afterEach(cleanup);

describe('future recipe transfer between retained equipment alternatives', () => {
  it('normalizes redundant preset family values after selecting a setup in the editor', () => {
    const reference = structuredClone(DEFAULT_RECIPE);
    reference.grinder = {
      preset: 'generic-flat-traditional-64',
      family: 'flat-traditional',
      setting: 190,
    };
    const current = structuredClone(reference);
    delete current.grinder.family;
    current.prep.dose_g = 19;
    expect(nextShotForAlternative(reference, current, reference).prep.dose_g).toBe(19);
  });
  it('does not silently ignore a changed dial when another setup uses an explicit gap', () => {
    const reference = structuredClone(DEFAULT_RECIPE);
    reference.grinder = { preset: 'generic-flat-traditional-64', setting: 190 };
    const current = structuredClone(reference);
    current.grinder.setting = 200;
    const alternative = structuredClone(reference);
    alternative.grinder.gap_um = 200;
    expect(() => nextShotForAlternative(reference, current, alternative)).toThrow(
      'different grind controls',
    );
  });
  it('preserves alternative parameters while applying deliberate dose, grind and stop changes', () => {
    const reference = structuredClone(DEFAULT_RECIPE);
    reference.grinder.gap_um = 180;
    reference.overrides = { 'hydraulics.permeability.reference': 1e-14 };
    const alternative = structuredClone(reference);
    alternative.grinder.gap_um = 200;
    alternative.overrides!['hydraulics.permeability.reference'] = 8e-15;
    const current = structuredClone(reference);
    current.prep.dose_g = 20;
    current.stop = { beverage_g: 42 };
    const result = nextShotForAlternative(reference, current, alternative);
    expect(result.grinder.gap_um).toBe(200);
    expect(result.overrides!['hydraulics.permeability.reference']).toBe(8e-15);
    expect(result.prep.dose_g).toBe(20);
    expect(result.stop.beverage_g).toBe(42);
    current.grinder.gap_um = 190;
    expect(nextShotForAlternative(reference, current, alternative).grinder.gap_um).toBe(190);
    expect(alternative.grinder.gap_um).toBe(200);
  });
  it('refuses to compare stale equipment or bean conditions', () => {
    const reference = structuredClone(DEFAULT_RECIPE);
    const changed = structuredClone(reference);
    changed.prep.distribution = 'none';
    expect(() => nextShotForAlternative(reference, changed, reference)).toThrow(
      'preparation changed',
    );
    changed.prep = reference.prep;
    changed.bean.days_off_roast = 40;
    expect(() => nextShotForAlternative(reference, changed, reference)).toThrow('coffee');
  });
  it('accepts equivalent property order and fixes computation at the full simulation tier', () => {
    const reference = structuredClone(DEFAULT_RECIPE);
    const current = {
      ...reference,
      machine: { ...reference.machine },
      numerics: { tier: 0 as const },
    };
    const result = nextShotForAlternative(reference, current, reference);
    expect(result.numerics?.tier).toBe(1);
  });

  it('rejects a native dial clamp, even when both alternatives use the same named grinder', () => {
    const reference = structuredClone(DEFAULT_RECIPE);
    const current = structuredClone(reference);
    const preset = catalog.presets.grinders.find((p) => p.id === current.grinder.preset)!;
    current.grinder.setting = preset.dial.max + 1;
    const next = nextShotForAlternative(reference, current, reference);
    const build = fixtureBuild(next);
    expect(build.derived.psd?.setting).toBe(preset.dial.max);
    expect(() => validateAlternativeGrind(next, catalog, build)).toThrow('dial setting');
  });

  it('rejects a native floor on a requested explicit gap and on a calibrated dial gap', () => {
    const gap = {
      ...structuredClone(DEFAULT_RECIPE),
      grinder: { family: 'flat-traditional', gap_um: 1 },
    };
    expect(fixtureBuild(gap).derived.psd?.gap_um).toBe(5);
    expect(() => validateAlternativeGrind(gap, catalog, fixtureBuild(gap))).toThrow(
      'requested gap',
    );
    const dial = {
      ...gap,
      grinder: { family: 'flat-traditional', setting: 0, gap_at_ref_um: 0, gap_per_unit_um: 1 },
    };
    expect(fixtureBuild(dial).derived.psd?.gap_um).toBe(5);
    expect(() => validateAlternativeGrind(dial, catalog, fixtureBuild(dial))).toThrow(
      'dial calibration',
    );
  });

  it('accepts supported native named-dial calibration and preserves each alternative mapping', () => {
    const named = {
      ...structuredClone(DEFAULT_RECIPE),
      grinder: { preset: 'mahlkoenig-e65s', setting: 1.7 },
    };
    const alternative = {
      ...structuredClone(named),
      grinder: { ...named.grinder, gap_at_ref_um: 200, gap_per_unit_um: 20 },
    };
    const current = { ...structuredClone(named), grinder: { ...named.grinder, setting: 1.8 } };
    const next = nextShotForAlternative(named, current, alternative);
    const build = fixtureBuild(next);
    expect(build.derived.psd?.gap_um).toBeCloseTo(208);
    expect(() => validateAlternativeGrind(next, catalog, build)).not.toThrow();
  });

  it('keeps valid comparison rows while reporting a rejected native gap and session storage notice', async () => {
    const recipe = structuredClone(DEFAULT_RECIPE);
    const badGap = { ...structuredClone(recipe), grinder: { ...recipe.grinder, gap_um: 1 } };
    const profile = (id: string, value: Recipe): SavedSetup => ({
      id,
      name: id,
      createdAt: '2026-10-21T00:00:00.000Z',
      coreVersion: catalog.coreVersion,
      source: 'specified',
      recipe: value,
      facts: { heater: 'unknown' },
      request: { recipe: value, constraints: [], observations: [] },
    });
    useEquipmentStore.setState({
      hydrated: true,
      notice: 'Setup changes last for this session. Export a backup to keep them.',
      document: {
        ...emptySetupDocument(),
        alternatives: [profile('Supported setup', recipe), profile('Clamped setup', badGap)],
        activeId: 'Supported setup',
      },
    });
    const engine = {
      simulateRecipe: (next: Recipe) => Promise.resolve({ result: fixtureRun(next), runtimeMs: 0 }),
    } as unknown as Engine;
    render(
      createElement(
        EngineContext.Provider,
        { value: engine },
        createElement(SetupPrediction, { recipe, catalog }),
      ),
    );
    expect(screen.getByRole('status').textContent).toContain('Export a backup');
    fireEvent.click(screen.getByRole('button', { name: 'Compare next shot across saved setups' }));
    const table = await screen.findByRole('table', {
      name: 'Predictions from retained equipment alternatives',
    });
    const good = within(table).getByRole('row', { name: /Supported setup/ });
    expect(good.textContent).toContain('30.0 s');
    const rejected = within(table).getByRole('row', { name: /Clamped setup/ });
    expect(rejected.textContent).toContain('requested gap');
    expect(rejected.textContent).not.toContain('30.0 s');
  });
});
