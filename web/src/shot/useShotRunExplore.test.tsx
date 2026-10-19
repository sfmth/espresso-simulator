// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fixtureBuild, fixtureCatalog, fixtureRun } from '../../test/fixtures/shotFixture';
import { EngineError, type CallOptions, type Engine, type Timed } from '../engine/engine';
import { EngineContext } from '../engine/EngineContext';
import type { ExploreRequest } from '../engine/exploreTypes';
import type { RecipeRunData } from '../engine/shotData';
import type { Recipe } from '../engine/shotTypes';
import { ShotLab } from './ShotLab';
import { ShotRunProvider, useSharedShotRun } from './ShotRunContext';
import { resetShotStore, useShotStore } from './shotStore';
import { useShotRun } from './useShotRun';

vi.mock('uplot', () => ({
  default: class {
    static pxRatio = 1;
    constructor(_options: unknown, _data: unknown, target: HTMLElement) {
      target.append(document.createElement('div'));
    }
    setData() {}
    setSize() {}
    destroy() {}
  },
}));
interface Pending {
  recipe: Recipe;
  request?: ExploreRequest;
  signal?: AbortSignal;
  resolve: (ey?: number) => void;
  reject: (error: Error) => void;
}
function fakeEngine() {
  const normal: Pending[] = [],
    detailed: Pending[] = [];
  const pending = (
    jobs: Pending[],
    recipe: Recipe,
    options?: CallOptions,
    request?: ExploreRequest,
  ) =>
    new Promise<Timed<RecipeRunData>>((resolve, reject) => {
      jobs.push({
        recipe,
        request,
        signal: options?.signal,
        reject,
        resolve: (ey) => {
          const run = fixtureRun(recipe, ey === undefined ? {} : { ey });
          if (request)
            run.result.spatial.micro = {
              column: request.column,
              cell: request.cell,
              resolution: request.resolution ?? 'standard',
              depth_cells: run.result.spatial.depth_m.length,
              classes: [],
            };
          resolve({ result: run, runtimeMs: 10 });
        },
      });
    });
  const catalog = vi.fn(() => Promise.resolve({ result: fixtureCatalog(), runtimeMs: 0 }));
  const engine = {
    catalog,
    buildShotSpec: (r: Recipe) => Promise.resolve({ result: fixtureBuild(r), runtimeMs: 0 }),
    simulateRecipe: (r: Recipe, options?: CallOptions) => pending(normal, r, options),
    simulateExplore: (r: Recipe, request: ExploreRequest, options?: CallOptions) =>
      pending(detailed, r, options, request),
    simulateUncertainty: () => new Promise(() => {}),
  } as unknown as Engine;
  return { engine, normal, detailed, catalog };
}
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
function wrapper(engine: Engine) {
  return ({ children }: { children: ReactNode }) => (
    <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  resetShotStore();
  useShotStore.getState().setCatalog(fixtureCatalog());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('shared Explore run channel', () => {
  it('forces Tier 1, forwards refined-grid requests, supersedes preview/full calls and ignores their late results', async () => {
    useShotStore.getState().patchForm('numerics', { tier: '0' });
    const fake = fakeEngine();
    const { result } = renderHook(useShotRun, { wrapper: wrapper(fake.engine) });
    await flush();
    expect(fake.normal).toHaveLength(1);
    act(() => result.current.run());
    expect(fake.normal[0].signal!.aborted).toBe(true);
    const request: ExploreRequest = { column: 2, cell: 3, resolution: 'high' };
    act(() => result.current.runExplore(request));
    expect(fake.normal[1].signal!.aborted).toBe(true);
    expect(fake.detailed[0].recipe.numerics!.tier).toBe(1);
    expect(fake.detailed[0].request).toEqual(request);
    request.cell = 0;
    expect(fake.detailed[0].request!.cell).toBe(3);
    fake.detailed[0].resolve(0.22);
    await flush();
    const accepted = useShotStore.getState().run.latest;
    expect(accepted?.result.spatial.micro).toMatchObject({
      column: 2,
      cell: 3,
      resolution: 'high',
    });
    fake.normal[0].resolve(0.1);
    fake.normal[1].resolve(0.15);
    await flush();
    expect(useShotStore.getState().run.latest).toBe(accepted);
    expect(useShotStore.getState().run.fullRunning).toBe(false);
  });
  it('cancels a detailed call without allowing an engine that ignores abort to publish it', async () => {
    useShotStore.getState().setLivePreview(false);
    const fake = fakeEngine();
    const { result } = renderHook(useShotRun, { wrapper: wrapper(fake.engine) });
    await flush();
    act(() => result.current.runExplore({ column: 0, cell: 0 }));
    act(() => result.current.cancel());
    expect(fake.detailed[0].signal!.aborted).toBe(true);
    fake.detailed[0].resolve();
    await flush();
    expect(useShotStore.getState().run).toMatchObject({
      latest: null,
      status: 'cancelled',
      fullRunning: false,
    });
  });
  it('retries an Explore engine failure with the same requested resolution and cell', async () => {
    useShotStore.getState().setLivePreview(false);
    const fake = fakeEngine();
    const { result } = renderHook(useShotRun, { wrapper: wrapper(fake.engine) });
    await flush();
    act(() => result.current.runExplore({ column: 1, cell: 2, resolution: 'high' }));
    fake.detailed[0].reject(new EngineError('worker', 'Lost worker'));
    await flush();
    expect(useShotStore.getState().run.status).toBe('error');
    act(() => result.current.retry());
    expect(fake.detailed).toHaveLength(2);
    expect(fake.normal).toHaveLength(0);
    expect(fake.detailed[1].request).toEqual({ column: 1, cell: 2, resolution: 'high' });
    fake.detailed[1].resolve();
    await flush();
    expect(useShotStore.getState().run.status).toBe('done');
  });
  it('lets a preview of edited inputs supersede the old detailed run', async () => {
    const fake = fakeEngine();
    const { result } = renderHook(useShotRun, { wrapper: wrapper(fake.engine) });
    await flush();
    act(() => result.current.runExplore({ column: 0, cell: 0 }));
    act(() => useShotStore.getState().patchForm('prep', { dose_g: '19' }));
    await flush(250);
    expect(fake.detailed[0].signal!.aborted).toBe(true);
    fake.normal[1].resolve(0.19);
    await flush();
    const accepted = useShotStore.getState().run.latest;
    expect(accepted?.recipe.prep.dose_g).toBe(19);
    fake.detailed[0].resolve(0.3);
    await flush();
    expect(useShotStore.getState().run.latest).toBe(accepted);
  });
  it('reports an unavailable optional Explore API explicitly', async () => {
    useShotStore.getState().setLivePreview(false);
    const fake = fakeEngine();
    delete fake.engine.simulateExplore;
    const { result } = renderHook(useShotRun, { wrapper: wrapper(fake.engine) });
    await flush();
    act(() => result.current.runExplore({ column: 0, cell: 0 }));
    await flush();
    expect(useShotStore.getState().run.error).toContain('unavailable');
    expect(fake.normal).toHaveLength(0);
  });
});

describe('shared provider ownership', () => {
  it('loads the catalog with no Lab mounted, including an Explore-first route', async () => {
    resetShotStore();
    const fake = fakeEngine();
    renderHook(useSharedShotRun, {
      wrapper: ({ children }) => (
        <EngineContext.Provider value={fake.engine}>
          <ShotRunProvider>{children}</ShotRunProvider>
        </EngineContext.Provider>
      ),
    });
    await flush();
    expect(fake.catalog).toHaveBeenCalledOnce();
    expect(useShotStore.getState().catalog).not.toBeNull();
    expect(fake.normal).toHaveLength(1);
  });
  it('mounts no second automatic controller or catalog request when Lab consumes the provider', async () => {
    resetShotStore();
    const fake = fakeEngine();
    function Consumer() {
      useSharedShotRun();
      return null;
    }
    render(
      <EngineContext.Provider value={fake.engine}>
        <ShotRunProvider>
          <ShotLab />
          <Consumer />
        </ShotRunProvider>
      </EngineContext.Provider>,
    );
    await flush();
    expect(fake.catalog).toHaveBeenCalledOnce();
    expect(fake.normal).toHaveLength(1);
  });
});
