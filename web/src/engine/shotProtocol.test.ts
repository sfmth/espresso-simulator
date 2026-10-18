// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { fixtureResult } from '../../test/fixtures/shotFixture';
import { fixtureChemistry } from '../../test/fixtures/chemistryFixture';
import { loadPuckcore } from '../../test/loadWasm';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { EngineClient, EngineError, type WorkerLike } from './engine';
import { handleRequest, parseRequest, type EngineRequest, type EngineResponse } from './protocol';
import { checkShotResult } from './shotCheck';
import {
  numericSeries,
  shotThinningIndices,
  shotTransferables,
  toJsonResult,
  toShotRunData,
} from './shotData';
import { HYDRAULIC_VOLUME_FIELDS } from './shotTypes';
import type { PuckcoreModule } from './types';

/** A clock that advances by `step` ms on every reading. */
function clock(start = 100, step = 2.5) {
  let t = start - step;
  return () => (t += step);
}

function fakeCore(overrides: Partial<PuckcoreModule> = {}): PuckcoreModule {
  const run = {
    build: { spec: { schema: 'puckworks.shot-spec/1' }, derived: { notes: [] } },
    result: fixtureResult({ points: 5 }),
  };
  return {
    coreVersion: () => '9.9.9',
    simulateSphereRelease: () => {
      throw new Error('unused');
    },
    crankSphereReleaseFraction: () => 0,
    presets: () => '{"schema":"puckworks.presets/1","beans":[]}',
    registry: () => '{"schema":"puckworks.registry/1","parameters":[]}',
    buildShotSpec: () => JSON.stringify(run.build),
    simulateShot: () => JSON.stringify(run.result),
    simulateRecipe: () => JSON.stringify(run),
    ...overrides,
  };
}

describe('shot results in transfer form', () => {
  it('turns every full-length series into a Float64Array and keeps the rest', () => {
    const doc = fixtureResult({ points: 5 });
    (doc.series as unknown as Record<string, unknown>).future_series = [1, 2, 3, 4, 5];
    (doc.series as unknown as Record<string, unknown>).odd = [1, 2];
    const data = toShotRunData(doc, 3.5);
    expect(data.totalPoints).toBe(5);
    expect(data.coreMs).toBe(3.5);
    expect(data.result.series.t_s).toBeInstanceOf(Float64Array);
    expect(data.result.series.species_cup_kg[0].values).toBeInstanceOf(Float64Array);
    const series = data.result.series as unknown as Record<string, unknown>;
    expect(series.future_series).toBeInstanceOf(Float64Array);
    expect(series.odd).toEqual([1, 2]);
    expect(numericSeries(data.result).map(([k]) => k)).toContain('future_series');
    expect(data.result.summary).toEqual(doc.summary);
  });

  it('converts back to the same JSON document', () => {
    const doc = fixtureResult({ points: 7 });
    expect(toJsonResult(toShotRunData(doc, 0).result)).toEqual(doc);
  });

  it('preserves optional M2 chemistry through worker transfer and JSON export', () => {
    const doc = { ...fixtureResult({ points: 7 }), chemistry: fixtureChemistry() };
    expect(checkShotResult(doc)).toEqual([]);
    const data = toShotRunData(doc, 0);
    expect(data.result.chemistry).toEqual(doc.chemistry);
    expect(toJsonResult(data.result)).toEqual(doc);
    const malformed = {
      ...doc,
      chemistry: { ...doc.chemistry, acidity: { ...doc.chemistry.acidity, ph: Number.NaN } },
    };
    expect(checkShotResult(malformed)).toContain('chemistry.acidity.ph: must be a finite number');
  });

  it('thins very long results with one index set, keeping the ends and the peaks', () => {
    const n = 10_001;
    const doc = fixtureResult({ points: n });
    doc.series.tds_outlet[1234] = 0.9; // a spike that must survive
    const keep = shotThinningIndices(doc.series as unknown as Record<string, unknown>, n, 500);
    expect(keep).not.toBeNull();
    expect(keep?.length).toBeLessThanOrEqual(500);
    expect(keep).toContain(0);
    expect(keep).toContain(n - 1);
    expect(keep).toContain(1234);
    const data = toShotRunData(doc, 0, 500);
    expect(data.totalPoints).toBe(n);
    const lengths = new Set(numericSeries(data.result).map(([, v]) => v.length));
    expect([...lengths]).toEqual([data.result.series.t_s.length]);
    expect(Math.max(...data.result.series.tds_outlet)).toBe(0.9);
  });

  it('lists each buffer once for transfer', () => {
    const data = toShotRunData(fixtureResult({ points: 5 }), 0);
    const buffers = shotTransferables(data.result);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(buffers.length).toBe(numericSeries(data.result).length + 1 + 4); // + t_s + 4 species
  });

  it('survives postMessage-style structured cloning with transfer', () => {
    const data = toShotRunData(fixtureResult({ points: 5 }), 0);
    const copy = structuredClone(data, { transfer: shotTransferables(data.result) });
    expect(Array.from(copy.result.series.ey)).toEqual(fixtureResult({ points: 5 }).series.ey);
    expect(data.result.series.ey.length).toBe(0); // moved, not copied
  });

  it('keeps hydraulic inventories aligned with pressure through thinning, transfer and export', () => {
    const doc = fixtureResult({ points: 101 });
    const s = doc.series;
    s.storage_volume_m3 = s.pressure_pa.map((p) => 1e-11 * p);
    s.cumulative_inlet_volume_m3 = s.t_s.map((t) => 4e-6 * t);
    s.cumulative_outlet_volume_m3 = s.t_s.map((t) => 1e-6 * t);
    s.cumulative_vented_volume_m3 = s.t_s.map((_, i) => (i === s.t_s.length - 1 ? 1e-6 : 0));
    s.retained_volume_m3 = s.t_s.map(
      (_, i) =>
        s.cumulative_inlet_volume_m3![i] -
        s.cumulative_outlet_volume_m3![i] -
        s.cumulative_vented_volume_m3![i],
    );
    const keep = shotThinningIndices(s as unknown as Record<string, unknown>, s.t_s.length, 20)!;
    const data = toShotRunData(doc, 0, 20);
    const copy = structuredClone(data, { transfer: shotTransferables(data.result) });
    const exported = toJsonResult(copy.result);
    for (const key of HYDRAULIC_VOLUME_FIELDS) {
      expect(data.result.series[key]?.length).toBe(0);
      expect(copy.result.series[key]).toBeInstanceOf(Float64Array);
      expect(exported.series[key]).toEqual(keep.map((i) => s[key]![i]));
    }
    const a = exported.series;
    a.t_s.forEach((_, i) => {
      expect(a.storage_volume_m3![i]).toBe(1e-11 * a.pressure_pa[i]);
      expect(
        a.cumulative_inlet_volume_m3![i] -
          a.cumulative_outlet_volume_m3![i] -
          a.cumulative_vented_volume_m3![i] -
          a.retained_volume_m3![i],
      ).toBe(0);
    });
    expect(checkShotResult(exported)).toEqual([]);
  });
});

describe('hydraulic result contract', () => {
  it('accepts older results without hydraulic inventories', () => {
    expect(checkShotResult(fixtureResult())).toEqual([]);
  });

  it.each(HYDRAULIC_VOLUME_FIELDS)('validates the optional series.%s inventory', (field) => {
    const doc = fixtureResult({ points: 3 });
    doc.series[field] = [0, 1e-6, 2e-6];
    expect(checkShotResult(doc)).toEqual([]);
    doc.series[field] = [0, 1e-6];
    expect(checkShotResult(doc)).toContain(`series.${field}: has 2 values, expected 3`);
    doc.series[field] = [0, Number.NaN, 2e-6];
    expect(checkShotResult(doc)).toContain(`series.${field}[1]: must be a finite number`);
  });

  it('rejects a nonfinite hydraulic-volume diagnostic', () => {
    const doc = fixtureResult();
    doc.diagnostics.hydraulic_volume_balance_error = Number.NaN;
    expect(checkShotResult(doc)).toContain(
      'diagnostics.hydraulic_volume_balance_error: must be a finite number',
    );
  });
});

describe('handleRequest: shot calls', () => {
  it('validates the shape of shot requests', () => {
    expect(parseRequest({ id: 1, method: 'catalog' })).toEqual({
      ok: true,
      request: { id: 1, method: 'catalog', params: null },
    });
    expect(parseRequest({ id: 2, method: 'simulateRecipe', params: {} })).toMatchObject({
      ok: false,
      message: 'simulateRecipe needs params.recipe, a recipe object',
    });
    expect(parseRequest({ id: 3, method: 'simulateShot', params: { spec: [] } })).toMatchObject({
      ok: false,
      message: 'simulateShot needs params.spec, a shot spec object',
    });
  });

  it('answers catalog with the parsed presets and registry', () => {
    const { response } = handleRequest(fakeCore(), { id: 1, method: 'catalog' }, { now: clock() });
    expect(response).toEqual({
      id: 1,
      method: 'catalog',
      ok: true,
      result: {
        coreVersion: '9.9.9',
        presets: { schema: 'puckworks.presets/1', beans: [] },
        registry: { schema: 'puckworks.registry/1', parameters: [] },
      },
      runtimeMs: 2.5,
    });
  });

  it('sends the recipe to the core as JSON and transfers the series back', () => {
    const base = fakeCore();
    const simulateRecipe = vi.fn((json: string) => base.simulateRecipe(json));
    const { response, transfer } = handleRequest(
      fakeCore({ simulateRecipe }),
      { id: 4, method: 'simulateRecipe', params: { recipe: DEFAULT_RECIPE } },
      { now: clock(0, 1) },
    );
    expect(simulateRecipe).toHaveBeenCalledWith(JSON.stringify(DEFAULT_RECIPE));
    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== 'simulateRecipe') return;
    expect(response.result.build.spec.schema).toBe('puckworks.shot-spec/1');
    expect(response.result.result.series.pressure_pa).toBeInstanceOf(Float64Array);
    expect(response.result.coreMs).toBe(1);
    expect(transfer.length).toBeGreaterThan(5);
  });

  it('returns only the scalars for a sweep point', () => {
    const { response, transfer } = handleRequest(fakeCore(), {
      id: 5,
      method: 'sweepPoint',
      params: { recipe: DEFAULT_RECIPE },
    });
    expect(response.ok && response.method === 'sweepPoint' && Object.keys(response.result)).toEqual(
      ['summary', 'diagnostics', 'coreMs'],
    );
    expect(transfer).toEqual([]);
  });

  it('reports the builder’s error as invalid-params, with its message', () => {
    const core = fakeCore({
      buildShotSpec: () => {
        throw new Error('prep.dose_g: 60 g makes a 118.8 mL bed');
      },
    });
    const { response } = handleRequest(core, {
      id: 6,
      method: 'buildShotSpec',
      params: { recipe: {} },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'invalid-params', message: 'prep.dose_g: 60 g makes a 118.8 mL bed' },
    });
  });

  it('treats output that breaks the contract as a runtime failure (a bug in the core)', () => {
    const core = fakeCore({ simulateShot: () => 'not json' });
    const { response } = handleRequest(core, {
      id: 7,
      method: 'simulateShot',
      params: { spec: {} },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'runtime', name: 'CoreOutputError' },
    });
  });

  it('reads the core’s panic message after a trap and passes it on', () => {
    const trap = () => {
      throw new WebAssembly.RuntimeError('unreachable');
    };
    const panic = 'panicked at crates/puckcore/src/shot/sim.rs:10:5: index out of bounds';
    const { response } = handleRequest(fakeCore({ simulateRecipe: trap, lastPanic: () => panic }), {
      id: 9,
      method: 'simulateRecipe',
      params: { recipe: DEFAULT_RECIPE },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'runtime', name: 'RuntimeError', message: 'unreachable', panic },
    });
    // No message recorded, a core without lastPanic, or one too broken to answer: no panic field.
    for (const lastPanic of [() => '', undefined, trap]) {
      const { response: plain } = handleRequest(fakeCore({ simulateRecipe: trap, lastPanic }), {
        id: 10,
        method: 'simulateRecipe',
        params: { recipe: DEFAULT_RECIPE },
      });
      expect(plain.ok).toBe(false);
      expect(!plain.ok && plain.error.kind).toBe('runtime');
      expect(!plain.ok && 'panic' in plain.error).toBe(false);
    }
    // An input error is not a trap: the panic message is not read.
    const lastPanic = vi.fn(() => panic);
    const invalid = () => {
      throw new Error('prep.dose_g: too large');
    };
    const { response: input } = handleRequest(fakeCore({ simulateRecipe: invalid, lastPanic }), {
      id: 11,
      method: 'simulateRecipe',
      params: { recipe: DEFAULT_RECIPE },
    });
    expect(!input.ok && input.error.kind).toBe('invalid-params');
    expect(lastPanic).not.toHaveBeenCalled();
  });

  it('asks for the worker to be replaced once its memory is large', () => {
    const { response } = handleRequest(
      fakeCore(),
      { id: 8, method: 'simulateRecipe', params: { recipe: DEFAULT_RECIPE } },
      { memoryBytes: () => 64 * 1024 * 1024 },
    );
    expect(response.ok && response.recycle).toBe(true);
  });
});

describe('handleRequest against the real WASM engine', () => {
  const core = loadPuckcore();

  it('records no panic before one happens', () => {
    expect(core.lastPanic?.()).toBe('');
  });

  it('loads the catalog', () => {
    const { response } = handleRequest(core, { id: 1, method: 'catalog' });
    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== 'catalog') return;
    expect(response.result.presets.schema).toBe('puckworks.presets/1');
    expect(response.result.registry.parameters.length).toBeGreaterThan(100);
  });

  it('runs a tier-0 recipe whose result follows the contract', () => {
    const recipe = { ...DEFAULT_RECIPE, numerics: { tier: 0 as const } };
    const { response } = handleRequest(core, {
      id: 2,
      method: 'simulateRecipe',
      params: { recipe },
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== 'simulateRecipe') return;
    expect(checkShotResult(toJsonResult(response.result.result))).toEqual([]);
    const direct = JSON.parse(core.simulateRecipe(JSON.stringify(recipe))) as { result: unknown };
    expect(toJsonResult(response.result.result)).toEqual(direct.result);
  });

  it('passes the builder’s readable message through', () => {
    const recipe = { ...DEFAULT_RECIPE, prep: { dose_g: 59 } };
    const { response } = handleRequest(core, {
      id: 3,
      method: 'buildShotSpec',
      params: { recipe },
    });
    expect(response).toMatchObject({ ok: false, error: { kind: 'invalid-params' } });
    expect(!response.ok && response.error.message).toMatch(/^prep\.dose_g: 59 g makes a/);
  });
});

describe('EngineClient: shot calls', () => {
  class FakeWorker implements WorkerLike {
    onmessage: WorkerLike['onmessage'] = null;
    onerror: WorkerLike['onerror'] = null;
    onmessageerror: WorkerLike['onmessageerror'] = null;
    readonly posted: EngineRequest[] = [];
    postMessage(message: EngineRequest): void {
      this.posted.push(message);
    }
    terminate(): void {}
    reply(response: EngineResponse): void {
      this.onmessage?.({ data: response } as MessageEvent);
    }
  }

  it('posts each shot method with its params and resolves with the result', async () => {
    const workers: FakeWorker[] = [];
    const client = new EngineClient({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    const calls = [
      client.catalog(),
      client.buildShotSpec(DEFAULT_RECIPE),
      client.simulateRecipe(DEFAULT_RECIPE),
      client.simulateShot({ schema: 'x' } as never),
      client.sweepPoint(DEFAULT_RECIPE),
    ];
    for (let i = 0; i < calls.length; i++) {
      const request = workers[0].posted[i];
      workers[0].reply({
        id: request.id,
        method: request.method,
        ok: true,
        result: i,
        runtimeMs: 1,
      } as unknown as EngineResponse);
      await calls[i];
    }
    expect(workers[0].posted.map((r) => [r.method, r.params])).toEqual([
      ['catalog', null],
      ['buildShotSpec', { recipe: DEFAULT_RECIPE }],
      ['simulateRecipe', { recipe: DEFAULT_RECIPE }],
      ['simulateShot', { spec: { schema: 'x' } }],
      ['sweepPoint', { recipe: DEFAULT_RECIPE }],
    ]);
    await expect(calls[4]).resolves.toEqual({ result: 4, runtimeMs: 1 });
  });

  it('rejects with the builder’s message as an EngineError', async () => {
    const worker = new FakeWorker();
    const client = new EngineClient({ createWorker: () => worker });
    const call = client.buildShotSpec(DEFAULT_RECIPE);
    const request = worker.posted[0];
    worker.reply({
      id: request.id,
      method: request.method,
      ok: false,
      error: { kind: 'invalid-params', name: 'Error', message: 'basket: give a preset' },
      runtimeMs: 0,
    });
    await expect(call).rejects.toEqual(new EngineError('invalid-params', 'basket: give a preset'));
  });

  it('keeps the panic message of a trap as the error’s detail', async () => {
    const worker = new FakeWorker();
    const client = new EngineClient({ createWorker: () => worker });
    const call = client.simulateRecipe(DEFAULT_RECIPE);
    const request = worker.posted[0];
    worker.reply({
      id: request.id,
      method: request.method,
      ok: false,
      error: {
        kind: 'runtime',
        name: 'RuntimeError',
        message: 'unreachable',
        panic: 'panicked at sim.rs:10:5',
      },
      runtimeMs: 0,
    });
    const error = await call.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({
      kind: 'runtime',
      message: 'unreachable',
      detail: 'panicked at sim.rs:10:5',
    });
  });
});
