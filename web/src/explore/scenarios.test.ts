// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { fixtureBuild, fixtureCatalog } from '../../test/fixtures/shotFixture';
import { formToRecipe } from '../shot/recipeForm';
import { GUIDED_SCENARIOS, scenarioForm, scenarioRecipe, type ScenarioId } from './scenarios';

function changed(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aa = a as Record<string, unknown>,
      bb = b as Record<string, unknown>;
    return [...new Set([...Object.keys(aa), ...Object.keys(bb)])].flatMap((key) =>
      changed(aa[key], bb[key], path ? `${path}.${key}` : key),
    );
  }
  return [path];
}
describe('fixed guided inputs', () => {
  it('builds every complete Tier 1 scenario in the actual WASM core and shared editor', () => {
    for (const { id } of GUIDED_SCENARIOS) {
      const recipe = scenarioRecipe(id),
        build = fixtureBuild(recipe);
      expect(build.spec.numerics.tier).toBe(1);
      expect(build.spec.bed.dose_kg).toBeCloseTo(0.018);
      expect(build.spec.bed.size_classes.length).toBeGreaterThan(0);
      expect(formToRecipe(scenarioForm(id), { catalog: fixtureCatalog() }).ok).toBe(true);
    }
  });
  it.each<[ScenarioId, string[]]>([
    ['finer', ['grinder.setting']],
    ['coarser', ['grinder.setting']],
    ['uneven', ['prep.distribution']],
    ['paper', ['prep.paper_bottom']],
    ['bloom', ['machine.preset']],
    ['turbo', ['grinder.setting', 'machine.preset', 'stop.beverage_g']],
  ])('changes exactly the declared physical inputs for %s', (id, paths) =>
    expect(changed(scenarioRecipe('reference'), scenarioRecipe(id)).sort()).toEqual(paths.sort()),
  );
  it('changes actual particle distributions, prep spread, edge access and machine controls', () => {
    const builds = Object.fromEntries(
      GUIDED_SCENARIOS.map(({ id }) => [id, fixtureBuild(scenarioRecipe(id))]),
    );
    const sizes = (id: ScenarioId) => builds[id].spec.bed.size_classes.map((c) => c.radius_m);
    expect(sizes('finer')[15]).toBeLessThan(sizes('reference')[15]);
    expect(sizes('reference')[15]).toBeLessThan(sizes('coarser')[15]);
    expect(builds.uneven.spec.bed.heterogeneity.sigma_ln_permeability).toBeGreaterThan(
      builds.reference.spec.bed.heterogeneity.sigma_ln_permeability,
    );
    expect(builds.paper.spec.bed.heterogeneity.edge_multiplier).toBeGreaterThan(
      builds.reference.spec.bed.heterogeneity.edge_multiplier,
    );
    expect(builds.bloom.spec.machine.phases).toHaveLength(3);
    expect(builds.bloom.spec.machine.phases[1]).toMatchObject({
      control: { type: 'flow', target_m3_s: 0 },
      exit: { time_s: 20 },
    });
    expect(builds.turbo.spec.machine.phases[0].control).toMatchObject({
      type: 'pressure',
      target_pa: 600000,
    });
    expect(builds.turbo.spec.machine.stop.beverage_mass_kg).toBeCloseTo(0.054);
  });
  it('returns isolated recipes and does not claim guaranteed measured outcomes', () => {
    const a = scenarioRecipe('reference');
    a.prep.dose_g = 50;
    a.grinder.setting = 1;
    a.overrides = { 'hydraulics.permeability.reference': 1e-12 };
    expect(scenarioRecipe('reference').prep.dose_g).toBe(18);
    expect(scenarioRecipe('reference').overrides).toBeUndefined();
    expect(GUIDED_SCENARIOS.find((s) => s.id === 'finer')!.assumptions.join(' ')).toContain(
      'does not guarantee',
    );
    expect(GUIDED_SCENARIOS.find((s) => s.id === 'turbo')!.assumptions.join(' ')).toContain(
      'pump-stop target',
    );
  });
});
