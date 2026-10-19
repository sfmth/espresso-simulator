// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { fixtureResult } from '../../test/fixtures/shotFixture';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { EngineClient, type WorkerLike } from './engine';
import type { ExploreRequest } from './exploreTypes';
import { handleRequest, parseRequest, type EngineRequest, type EngineResponse } from './protocol';
import type { RecipeRunData } from './shotData';
import { toJsonResult } from './shotData';
import type { PuckcoreModule } from './types';

const selection: ExploreRequest = { column: 1, cell: 2, resolution: 'high' };
function core(explore = false) {
  const result = fixtureResult({ points: 5 });
  result.spatial.micro = {
    ...selection,
    depth_cells: 150,
    classes: [
      {
        radius_m: 175e-6,
        kernel_radius_m: 150e-6,
        volume_fraction: 1,
        pool_fraction: 0.37,
        shell_outer_radii_m: [100e-6, 150e-6],
        initial_kernel_conc_kg_m3: 300,
      },
    ],
  };
  for (const snapshot of result.spatial.snapshots) {
    snapshot.micro = {
      class_ey: [0.2],
      kernel_conc_kg_m3: [[280, 200]],
      surface_remaining_fraction: [0.4],
    };
    snapshot.column_flow_m3_s = [1e-6, 2e-6, 1e-6];
    snapshot.bed_temperature_c = 90;
  }
  const run = {
    build: { spec: { schema: 'puckworks.shot-spec/1' }, derived: { notes: [] } },
    result,
  };
  const unused = () => {
    throw new Error('unused');
  };
  const simulateRecipe = vi.fn(() => JSON.stringify(run));
  const simulateExplore = vi.fn(() => JSON.stringify(run));
  const module: PuckcoreModule = {
    coreVersion: () => 'fixture',
    presets: () => '{}',
    registry: () => '{}',
    simulateSphereRelease: unused,
    crankSphereReleaseFraction: () => 0,
    buildShotSpec: () => '{}',
    simulateShot: unused,
    simulateRecipe,
    simulateUncertainty: unused,
    ...(explore ? { simulateExplore } : {}),
  };
  return { module, run, simulateRecipe, simulateExplore };
}

class Worker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  onmessageerror: WorkerLike['onmessageerror'] = null;
  posted: EngineRequest[] = [];
  terminated = false;
  postMessage(request: EngineRequest) {
    this.posted.push(request);
  }
  answer(response: EngineResponse) {
    this.onmessage?.({ data: response } as MessageEvent);
  }
  terminate() {
    this.terminated = true;
  }
}

describe('M5 selected-cell worker contract', () => {
  it('forwards both JSON inputs and preserves exact micro arrays through transfer and export', () => {
    const fake = core(true);
    const message = {
      id: 1,
      method: 'simulateExplore',
      params: { recipe: DEFAULT_RECIPE, request: selection },
    };
    const handled = handleRequest(fake.module, message);
    expect(fake.simulateExplore).toHaveBeenCalledWith(
      JSON.stringify(DEFAULT_RECIPE),
      JSON.stringify(selection),
    );
    expect(fake.simulateRecipe).not.toHaveBeenCalled();
    expect(handled.response.ok).toBe(true);
    if (!handled.response.ok || handled.response.method !== 'simulateExplore')
      throw new Error('Expected Explore response');
    const output = handled.response.result;
    expect(output.result.series.t_s).toBeInstanceOf(Float64Array);
    expect(output.result.spatial).toEqual(fake.run.result.spatial);
    expect(toJsonResult(output.result).spatial).toEqual(fake.run.result.spatial);
    expect(handled.transfer.length).toBeGreaterThan(0);
  });

  it('fails explicitly on an older core instead of silently substituting a normal shot', () => {
    const fake = core();
    const { response } = handleRequest(fake.module, {
      id: 1,
      method: 'simulateExplore',
      params: { recipe: DEFAULT_RECIPE, request: selection },
    });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('Expected unsupported-core error');
    expect(response.error.message).toContain('does not support Explore');
    expect(fake.simulateRecipe).not.toHaveBeenCalled();
  });

  it.each([
    { column: -1, cell: 0 },
    { column: 0, cell: 1.2 },
    { column: Number.MAX_SAFE_INTEGER + 1, cell: 0 },
    { column: 0, cell: 0, resolution: 'tier2' },
    { column: 0, cell: 0, extra: true },
    {},
  ])('rejects malformed selections before reaching the core (%o)', (request) => {
    expect(
      parseRequest({
        id: 1,
        method: 'simulateExplore',
        params: { recipe: DEFAULT_RECIPE, request },
      }).ok,
    ).toBe(false);
  });

  it('wires the production client method and cancellation to the existing worker owner', async () => {
    const worker = new Worker();
    const client = new EngineClient({ createWorker: () => worker });
    const fake = core(true);
    const request = client.simulateExplore(DEFAULT_RECIPE, selection);
    expect(worker.posted[0]).toEqual({
      id: 1,
      method: 'simulateExplore',
      params: { recipe: DEFAULT_RECIPE, request: selection },
    });
    worker.answer(handleRequest(fake.module, worker.posted[0]).response);
    const output: RecipeRunData = (await request).result;
    expect(output.result.spatial.micro?.cell).toBe(2);
    const control = new AbortController();
    const pending = client.simulateExplore(DEFAULT_RECIPE, selection, { signal: control.signal });
    control.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    client.terminate();
  });
});
