// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { loadPuckcore } from '../../test/loadWasm';
import {
  failureFor,
  handleRequest,
  parseRequest,
  transferablesOf,
  type EngineFailure,
  type EngineSuccess,
} from './protocol';
import type { PuckcoreModule, SphereReleaseHandle, SphereReleaseParams } from './types';

const PARAMS: SphereReleaseParams = {
  radiusM: 150e-6,
  diffusivityM2S: 1e-10,
  nShells: 64,
  tEndS: 60,
  nSteps: 20,
  grid: 'equal_volume',
  scheme: 'bdf2',
};

const request = (params: Partial<SphereReleaseParams> = {}, id = 7) => ({
  id,
  method: 'simulateSphereRelease',
  params: { ...PARAMS, ...params },
});

/** A clock that advances by `step` ms on every reading. */
function clock(start = 100, step = 2.5) {
  let t = start - step;
  return () => (t += step);
}

function fakeHandle(
  nShells: number,
  nSteps: number,
  errorAt: (i: number) => number = () => -1e-4,
): SphereReleaseHandle & { freed: number } {
  const series = (f: (i: number) => number, n: number) =>
    Float64Array.from({ length: n }, (_, i) => f(i));
  return {
    freed: 0,
    times: series((i) => i, nSteps + 1),
    releasedFraction: series((i) => i / nSteps + errorAt(i), nSteps + 1),
    analyticFraction: series((i) => i / nSteps, nSteps + 1),
    shellOuterRadii: series((i) => i + 1, nShells),
    finalProfile: series(() => 0.5, nShells),
    maxAbsError: 1e-4,
    massBalanceError: 2e-15,
    free() {
      this.freed += 1;
    },
  };
}

function fakeCore(handle = fakeHandle(PARAMS.nShells, PARAMS.nSteps)) {
  const core = {
    coreVersion: vi.fn(() => '9.9.9'),
    simulateSphereRelease: vi.fn<PuckcoreModule['simulateSphereRelease']>(() => handle),
    crankSphereReleaseFraction: vi.fn(() => 0),
    // The shot functions (M1) are tested in shotProtocol.test.ts.
    presets: vi.fn(() => '{}'),
    registry: vi.fn(() => '{}'),
    buildShotSpec: vi.fn(() => '{}'),
    simulateShot: vi.fn(() => '{}'),
    simulateRecipe: vi.fn(() => '{}'),
    simulateUncertainty: vi.fn(() => '{}'),
  };
  return { core, handle };
}

describe('handleRequest', () => {
  it('answers coreVersion with the version and the time spent', () => {
    const { core } = fakeCore();
    const { response, transfer } = handleRequest(
      core,
      { id: 1, method: 'coreVersion' },
      { now: clock() },
    );
    expect(response).toEqual({
      id: 1,
      method: 'coreVersion',
      ok: true,
      result: '9.9.9',
      runtimeMs: 2.5,
    });
    expect(transfer).toEqual([]);
  });

  it('runs simulateSphereRelease, frees the WASM result and transfers every array', () => {
    const { core, handle } = fakeCore();
    const { response, transfer } = handleRequest(core, request(), { now: clock() });
    expect(core.simulateSphereRelease).toHaveBeenCalledWith(
      150e-6,
      1e-10,
      64,
      60,
      20,
      'equal_volume',
      'bdf2',
    );
    expect(handle.freed).toBe(1);
    expect(response.ok).toBe(true);
    const success = response as Extract<EngineSuccess, { method: 'simulateSphereRelease' }>;
    expect(success.id).toBe(7);
    expect(success.runtimeMs).toBe(2.5);
    expect(success.result.maxAbsError).toBe(1e-4);
    expect(success.result.massBalanceError).toBe(2e-15);
    expect(success.result.times).toHaveLength(21);
    const arrays = [
      success.result.times,
      success.result.releasedFraction,
      success.result.analyticFraction,
      success.result.shellOuterRadii,
      success.result.finalProfile,
    ];
    expect(transfer).toHaveLength(5);
    expect(new Set(transfer)).toEqual(new Set(arrays.map((a) => a.buffer)));
  });

  it('produces messages that survive postMessage-style structured cloning with transfer', () => {
    const { core } = fakeCore();
    const { response, transfer } = handleRequest(core, request(), { now: clock() });
    const copy = structuredClone<typeof response>(response, { transfer });
    expect(copy.ok && copy.method === 'simulateSphereRelease' && copy.result.times[20]).toBe(20);
    // Transferred buffers are detached on the sending side: nothing was copied.
    expect((transfer[0] as ArrayBuffer).byteLength).toBe(0);
  });

  it.each([
    [{ nShells: 1 }, 'nShells'],
    [{ nShells: 64.5 }, 'nShells'],
    [{ nShells: 2 ** 32 + 64 }, 'nShells'],
    [{ nSteps: 0 }, 'nSteps'],
    [{ nSteps: 10_000_001 }, 'nSteps'],
    [{ radiusM: 0 }, 'radiusM'],
    [{ radiusM: Number.NaN }, 'radiusM'],
    [{ diffusivityM2S: -1e-10 }, 'diffusivityM2S'],
    [{ tEndS: Number.POSITIVE_INFINITY }, 'tEndS'],
    [{ grid: 'spherical' as never }, 'grid'],
    [{ scheme: 'rk4' as never }, 'scheme'],
  ])('rejects %o before calling the core', (params, field) => {
    const { core } = fakeCore();
    const { response } = handleRequest(core, request(params), { now: clock() });
    expect(core.simulateSphereRelease).not.toHaveBeenCalled();
    const failure = response as EngineFailure;
    expect(failure).toMatchObject({ id: 7, ok: false, method: 'simulateSphereRelease' });
    expect(failure.error.kind).toBe('invalid-params');
    expect(failure.error.name).toBe('RangeError');
    expect(failure.error.message).toContain(field);
  });

  it('reports an error thrown by the core as invalid-params', () => {
    const { core } = fakeCore();
    core.simulateSphereRelease.mockImplementation(() => {
      throw new Error('invalid parameter `n_shells`: must be between 2 and 100000');
    });
    const { response } = handleRequest(core, request(), { now: clock() });
    expect(response).toMatchObject({
      id: 7,
      ok: false,
      error: {
        kind: 'invalid-params',
        name: 'Error',
        message: expect.stringContaining('n_shells'),
      },
    });
  });

  it('reports a WebAssembly trap as a runtime failure', () => {
    const { core } = fakeCore();
    core.simulateSphereRelease.mockImplementation(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });
    const { response } = handleRequest(core, request(), { now: clock() });
    expect(response).toMatchObject({ ok: false, error: { kind: 'runtime', name: 'RuntimeError' } });
  });

  it('still frees the WASM result when reading it fails', () => {
    const handle = fakeHandle(PARAMS.nShells, PARAMS.nSteps);
    Object.defineProperty(handle, 'finalProfile', {
      get: () => {
        throw new WebAssembly.RuntimeError('memory access out of bounds');
      },
    });
    const { core } = fakeCore(handle);
    const { response } = handleRequest(core, request(), { now: clock() });
    expect(handle.freed).toBe(1);
    expect(response).toMatchObject({ ok: false, error: { kind: 'runtime' } });
  });

  it('turns a non-Error throw into a message', () => {
    const { core } = fakeCore();
    core.coreVersion.mockImplementation(() => {
      throw 'boom'; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    const { response } = handleRequest(core, { id: 3, method: 'coreVersion' }, { now: clock() });
    expect(response).toMatchObject({ id: 3, ok: false, error: { name: 'Error', message: 'boom' } });
  });

  it.each([
    [null, -1, 'request must be an object'],
    ['coreVersion', -1, 'request must be an object'],
    [{ method: 'coreVersion' }, -1, 'id'],
    [{ id: -2, method: 'coreVersion' }, -1, 'id'],
    [{ id: 1.5, method: 'coreVersion' }, -1, 'id'],
    [{ id: 4, method: 'launchRockets' }, 4, 'unknown method'],
    [{ id: 4 }, 4, 'unknown method'],
    [{ id: 5, method: 'simulateSphereRelease' }, 5, 'params'],
    [
      { id: 5, method: 'simulateSphereRelease', params: { ...PARAMS, nShells: '64' } },
      5,
      'nShells',
    ],
    [{ id: 5, method: 'simulateSphereRelease', params: { ...PARAMS, grid: 3 } }, 5, 'grid'],
  ])('answers malformed request %j with invalid-request', (message, id, text) => {
    const { core } = fakeCore();
    const { response, transfer } = handleRequest(core, message, { now: clock() });
    expect(response.ok).toBe(false);
    const failure = response as EngineFailure;
    expect(failure.id).toBe(id);
    expect(failure.error.kind).toBe('invalid-request');
    expect(failure.error.message).toContain(text);
    expect(transfer).toEqual([]);
    expect(core.simulateSphereRelease).not.toHaveBeenCalled();
    expect(core.coreVersion).not.toHaveBeenCalled();
  });
});

describe('thinning and recycling', () => {
  const MiB = 1024 * 1024;

  it('thins long series, keeping the ends, the evenly spaced samples and the largest error', () => {
    const nSteps = 100_000;
    const spike = 31_415;
    const { core, handle } = fakeCore(
      fakeHandle(8, nSteps, (i) => (i === spike ? -0.02 : 1e-5 * Math.sin(i))),
    );
    const { response, transfer } = handleRequest(core, request({ nSteps, nShells: 8 }), {
      now: clock(),
    });
    if (!response.ok || response.method !== 'simulateSphereRelease')
      throw new Error('expected a result');
    const r = response.result;
    expect(handle.freed).toBe(1);
    expect(r.totalPoints).toBe(nSteps + 1);
    expect(r.times.length).toBeLessThanOrEqual(4096);
    expect(r.releasedFraction).toHaveLength(r.times.length);
    expect(r.analyticFraction).toHaveLength(r.times.length);
    const times = Array.from(r.times);
    for (const t of [0, nSteps, spike, 10_000, 50_000, 90_000]) expect(times).toContain(t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Per-shell arrays and scalars are untouched.
    expect(r.shellOuterRadii).toHaveLength(8);
    expect(r.maxAbsError).toBe(1e-4);
    expect(transfer).toHaveLength(5);
    expect(response.recycle).toBeUndefined();
  });

  it('sends short series whole', () => {
    const { core, handle } = fakeCore();
    const { response } = handleRequest(core, request(), { now: clock() });
    if (!response.ok || response.method !== 'simulateSphereRelease')
      throw new Error('expected a result');
    expect(response.result.totalPoints).toBe(21);
    expect(Array.from(response.result.times)).toEqual(Array.from(handle.times));
    expect(Array.from(response.result.releasedFraction)).toEqual(
      Array.from(handle.releasedFraction),
    );
  });

  it('asks the client to replace the worker once WebAssembly memory passes 32 MiB', () => {
    const big = handleRequest(fakeCore().core, request(), { memoryBytes: () => 33 * MiB });
    expect(big.response).toMatchObject({ ok: true, recycle: true });
    const small = handleRequest(fakeCore().core, request(), { memoryBytes: () => 31 * MiB });
    expect(small.response.ok && small.response.recycle).toBeFalsy();
  });
});

describe('parseRequest', () => {
  it('accepts well-formed requests', () => {
    expect(parseRequest({ id: 0, method: 'coreVersion' })).toEqual({
      ok: true,
      request: { id: 0, method: 'coreVersion', params: null },
    });
    expect(parseRequest(request())).toEqual({ ok: true, request: request() });
  });
});

describe('failureFor', () => {
  it('builds an init failure that carries the request id', () => {
    expect(failureFor(request({}, 12), 'init', new TypeError('fetch failed'), 3)).toEqual({
      id: 12,
      method: 'simulateSphereRelease',
      ok: false,
      error: { kind: 'init', name: 'TypeError', message: 'fetch failed' },
      runtimeMs: 3,
    });
  });
});

describe('transferablesOf', () => {
  it('lists each buffer once', () => {
    const shared = new Float64Array(8);
    const own = new Float64Array(2);
    const buffers = transferablesOf({
      times: shared.subarray(0, 4),
      releasedFraction: shared.subarray(4),
      analyticFraction: own,
      shellOuterRadii: own,
      finalProfile: new Float64Array(1),
      maxAbsError: 0,
      massBalanceError: 0,
    });
    expect(buffers).toHaveLength(3);
  });
});

describe('with the real engine (WASM in Node)', () => {
  const core = loadPuckcore();

  it('reports the core version', () => {
    const { response } = handleRequest(core, { id: 1, method: 'coreVersion' });
    expect(response.ok).toBe(true);
    expect((response as EngineSuccess).result).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('follows the binding contract for a small run', () => {
    const { response, transfer } = handleRequest(core, request({ nSteps: 200, nShells: 32 }));
    if (!response.ok || response.method !== 'simulateSphereRelease') {
      throw new Error(`unexpected response ${JSON.stringify(response)}`);
    }
    const r = response.result;
    expect(r.times).toHaveLength(201);
    expect(r.releasedFraction).toHaveLength(201);
    expect(r.analyticFraction).toHaveLength(201);
    expect(r.shellOuterRadii).toHaveLength(32);
    expect(r.finalProfile).toHaveLength(32);
    expect(r.times[0]).toBe(0);
    expect(r.times[200]).toBeCloseTo(60, 12);
    expect(r.shellOuterRadii[31]).toBeCloseTo(150e-6, 18);
    for (const i of [1, 50, 200]) {
      const expected = core.crankSphereReleaseFraction(r.times[i], 150e-6, 1e-10);
      expect(Math.abs(r.analyticFraction[i] - expected)).toBeLessThan(1e-14);
    }
    expect(Number.isFinite(r.maxAbsError) && r.maxAbsError >= 0).toBe(true);
    expect(Math.abs(r.massBalanceError)).toBeLessThan(1e-9);
    expect(response.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(transfer).toHaveLength(5);
  });

  it('lets the core reject what only the core checks', () => {
    // The worker's own check mirrors the core; calling the core directly shows the core throws too.
    expect(() =>
      core.simulateSphereRelease(150e-6, 1e-10, 1, 60, 10, 'equal_volume', 'bdf2'),
    ).toThrow(/n_shells/);
    expect(() => core.simulateSphereRelease(150e-6, 1e-10, 64, 60, 10, 'bogus', 'bdf2')).toThrow(
      /grid/,
    );
  });
});
