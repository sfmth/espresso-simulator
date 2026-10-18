// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { fixtureTaste, fixtureUncertainty } from '../../test/fixtures/m3Fixture';
import { fixtureResult } from '../../test/fixtures/shotFixture';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { handleRequest, parseRequest } from './protocol';
import type { PuckcoreModule } from './types';

function fakeCore(): PuckcoreModule {
  return {
    coreVersion: () => 'test',
    presets: () => '{}',
    registry: () => '{}',
    buildShotSpec: () => '{}',
    simulateShot: () => '{}',
    simulateRecipe: () =>
      JSON.stringify({ build: {}, result: fixtureResult(), taste: fixtureTaste() }),
    simulateUncertainty: () => JSON.stringify(fixtureUncertainty()),
    crankSphereReleaseFraction: () => 0,
    simulateSphereRelease: () => {
      throw new Error('unused');
    },
  };
}

const options = {
  samples: 8,
  seed: 1729,
  groups: { grinder_psd: 'measured', roast_age: 'unknown', composition: 'fixed', water: 'unknown' },
};

describe('M3 worker boundary', () => {
  it('passes reproducibility settings into the shared core and preserves all bands and failures', () => {
    const core = fakeCore();
    const call = vi.spyOn(core, 'simulateUncertainty');
    const { response, transfer } = handleRequest(core, {
      id: 12,
      method: 'simulateUncertainty',
      params: { recipe: DEFAULT_RECIPE, options },
    });
    expect(call).toHaveBeenCalledWith(JSON.stringify(DEFAULT_RECIPE), JSON.stringify(options));
    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== 'simulateUncertainty') throw new Error('wrong result');
    expect(response.result).toEqual(fixtureUncertainty());
    expect(transfer).toEqual([]);
  });

  it('retains shared-core taste alongside a normal central shot', () => {
    const { response } = handleRequest(fakeCore(), {
      id: 4,
      method: 'simulateRecipe',
      params: { recipe: DEFAULT_RECIPE },
    });
    if (!response.ok || response.method !== 'simulateRecipe') throw new Error('wrong result');
    expect(response.result.taste).toEqual(fixtureTaste());
    expect(response.result.result.series.t_s).toBeInstanceOf(Float64Array);
  });

  it('rejects missing or array options before invoking WASM', () => {
    for (const params of [
      { recipe: DEFAULT_RECIPE },
      { recipe: DEFAULT_RECIPE, options: [] },
      { recipe: [], options },
    ]) {
      expect(parseRequest({ id: 1, method: 'simulateUncertainty', params }).ok).toBe(false);
    }
  });
});
