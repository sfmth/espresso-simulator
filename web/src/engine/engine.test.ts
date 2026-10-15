// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { EngineClient, EngineError, isAbortError, type WorkerLike } from './engine';
import type { EngineRequest, EngineResponse } from './protocol';
import type { SphereReleaseParams, SphereRunData } from './types';

const PARAMS: SphereReleaseParams = {
  radiusM: 150e-6,
  diffusivityM2S: 1e-10,
  nShells: 64,
  tEndS: 60,
  nSteps: 2000,
  grid: 'equal_volume',
  scheme: 'bdf2',
};

const RESULT: SphereRunData = {
  times: new Float64Array([0, 1]),
  releasedFraction: new Float64Array([0, 0.5]),
  analyticFraction: new Float64Array([0, 0.5]),
  shellOuterRadii: new Float64Array([1, 2]),
  finalProfile: new Float64Array([0.5, 0.25]),
  maxAbsError: 1e-5,
  massBalanceError: 1e-15,
  totalPoints: 2,
};

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  onmessageerror: WorkerLike['onmessageerror'] = null;
  readonly posted: EngineRequest[] = [];
  terminated = false;

  postMessage(message: EngineRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The request currently waiting for an answer. */
  get last(): EngineRequest {
    const request = this.posted.at(-1);
    if (!request) throw new Error('nothing was posted');
    return request;
  }

  reply(response: EngineResponse): void {
    this.onmessage?.({ data: response } as MessageEvent);
  }

  succeed(result: unknown = '0.1.0', runtimeMs = 1.5, recycle = false): void {
    const { id, method } = this.last;
    this.reply({
      id,
      method,
      ok: true,
      result,
      runtimeMs,
      ...(recycle ? { recycle } : {}),
    } as EngineResponse);
  }

  fail(kind: 'invalid-params' | 'runtime' | 'init', message = 'nope'): void {
    const { id, method } = this.last;
    this.reply({ id, method, ok: false, error: { kind, name: 'Error', message }, runtimeMs: 0 });
  }

  crash(message = 'script error'): void {
    this.onerror?.({ message, preventDefault: () => {} } as unknown as ErrorEvent);
  }
}

function setup(size = 1) {
  const workers: FakeWorker[] = [];
  const client = new EngineClient({
    size,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { client, workers };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('EngineClient', () => {
  it('starts its worker on the first call, not before', () => {
    const { client, workers } = setup();
    expect(workers).toHaveLength(0);
    void client.coreVersion();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.posted).toEqual([{ id: 1, method: 'coreVersion', params: null }]);
  });

  it('resolves with the result and the worker-side runtime', async () => {
    const { client, workers } = setup();
    const call = client.coreVersion();
    workers[0]?.succeed('0.1.0', 0.25);
    await expect(call).resolves.toEqual({ result: '0.1.0', runtimeMs: 0.25 });
  });

  it('sends simulateSphereRelease with its parameters and returns the arrays', async () => {
    const { client, workers } = setup();
    const call = client.simulateSphereRelease(PARAMS);
    expect(workers[0]?.last).toEqual({ id: 1, method: 'simulateSphereRelease', params: PARAMS });
    workers[0]?.succeed(RESULT, 12);
    await expect(call).resolves.toEqual({ result: RESULT, runtimeMs: 12 });
  });

  it('keeps one request in flight per worker and answers in order', async () => {
    const { client, workers } = setup();
    const worker = () => workers[0];
    const first = client.coreVersion();
    const second = client.simulateSphereRelease(PARAMS);
    expect(worker().posted).toHaveLength(1);
    worker().succeed('a');
    await expect(first).resolves.toMatchObject({ result: 'a' });
    expect(worker().posted).toHaveLength(2);
    worker().succeed(RESULT);
    await expect(second).resolves.toMatchObject({ result: RESULT });
    expect(workers).toHaveLength(1);
  });

  it('rejects with the reported kind and keeps the worker after invalid parameters', async () => {
    const { client, workers } = setup();
    const call = client.simulateSphereRelease(PARAMS);
    workers[0]?.fail('invalid-params', 'nShells must be an integer');
    const error: unknown = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ kind: 'invalid-params', message: 'nShells must be an integer' });
    void client.coreVersion();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminated).toBe(false);
  });

  it.each(['runtime', 'init'] as const)('replaces the worker after a %s failure', async (kind) => {
    const { client, workers } = setup();
    const call = client.coreVersion();
    workers[0]?.fail(kind);
    await expect(call).rejects.toMatchObject({ kind });
    expect(workers[0]?.terminated).toBe(true);
    const next = client.coreVersion();
    expect(workers).toHaveLength(2);
    workers[1]?.succeed('0.1.0');
    await expect(next).resolves.toMatchObject({ result: '0.1.0' });
  });

  it('delivers the result, then replaces a worker that asks to be recycled', async () => {
    const { client, workers } = setup();
    const big = client.simulateSphereRelease(PARAMS);
    const next = client.coreVersion();
    workers[0]?.succeed(RESULT, 40, true);
    await expect(big).resolves.toEqual({ result: RESULT, runtimeMs: 40 });
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]?.last.method).toBe('coreVersion');
    workers[1]?.succeed('0.1.0');
    await expect(next).resolves.toMatchObject({ result: '0.1.0' });
  });

  it('rejects the running request when the worker crashes, then recovers', async () => {
    const { client, workers } = setup();
    const running = client.coreVersion();
    const queued = client.coreVersion();
    workers[0]?.crash('failed to load script');
    await expect(running).rejects.toMatchObject({
      name: 'EngineError',
      kind: 'worker',
      message: expect.stringContaining('failed to load script'),
    });
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]?.succeed('ok');
    await expect(queued).resolves.toMatchObject({ result: 'ok' });
  });

  it('treats a mismatched answer as a worker failure', async () => {
    const { client, workers } = setup();
    const call = client.coreVersion();
    workers[0]?.reply({ id: 99, method: 'coreVersion', ok: true, result: 'x', runtimeMs: 0 });
    await expect(call).rejects.toMatchObject({ kind: 'worker' });
  });

  it('rejects at once for an already aborted signal, without starting a worker', async () => {
    const { client, workers } = setup();
    const controller = new AbortController();
    controller.abort();
    const error: unknown = await client
      .coreVersion({ signal: controller.signal })
      .catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(workers).toHaveLength(0);
  });

  it('drops an aborted request that is still queued', async () => {
    const { client, workers } = setup();
    const first = client.coreVersion();
    const controller = new AbortController();
    const second = client.coreVersion({ signal: controller.signal });
    controller.abort();
    expect(isAbortError(await second.catch((e: unknown) => e))).toBe(true);
    workers[0]?.succeed('first');
    await expect(first).resolves.toMatchObject({ result: 'first' });
    expect(workers[0]?.posted).toHaveLength(1);
  });

  it('terminates the worker of an aborted running request and moves on', async () => {
    const { client, workers } = setup();
    const controller = new AbortController();
    const running = client.simulateSphereRelease(PARAMS, { signal: controller.signal });
    const queued = client.coreVersion();
    const old = workers[0];
    controller.abort();
    expect(isAbortError(await running.catch((e: unknown) => e))).toBe(true);
    expect(old.terminated).toBe(true);
    expect(old.onmessage).toBeNull();
    expect(workers).toHaveLength(2);
    expect(workers[1]?.last.method).toBe('coreVersion');
    workers[1]?.succeed('fresh');
    await expect(queued).resolves.toMatchObject({ result: 'fresh' });
  });

  it('ignores aborts after the call has settled', async () => {
    const { client, workers } = setup();
    const controller = new AbortController();
    const call = client.coreVersion({ signal: controller.signal });
    workers[0]?.succeed('done');
    await expect(call).resolves.toMatchObject({ result: 'done' });
    controller.abort();
    await flush();
    expect(workers[0]?.terminated).toBe(false);
  });

  it('runs requests in parallel with a pool of workers', async () => {
    const { client, workers } = setup(2);
    const a = client.coreVersion();
    const b = client.coreVersion();
    const c = client.coreVersion();
    expect(workers).toHaveLength(2);
    expect(workers.map((w) => w.posted.length)).toEqual([1, 1]);
    workers[1]?.succeed('b');
    await expect(b).resolves.toMatchObject({ result: 'b' });
    expect(workers[1]?.posted).toHaveLength(2); // c went to the idle worker
    workers[0]?.succeed('a');
    workers[1]?.succeed('c');
    await expect(a).resolves.toMatchObject({ result: 'a' });
    await expect(c).resolves.toMatchObject({ result: 'c' });
  });

  it('rejects everything outstanding on terminate, and later calls too', async () => {
    const { client, workers } = setup();
    const running = client.coreVersion();
    const queued = client.coreVersion();
    client.terminate();
    await expect(running).rejects.toMatchObject({ kind: 'terminated' });
    await expect(queued).rejects.toMatchObject({ kind: 'terminated' });
    expect(workers[0]?.terminated).toBe(true);
    await expect(client.coreVersion()).rejects.toMatchObject({ kind: 'terminated' });
  });

  it('reports when workers are unavailable', async () => {
    const client = new EngineClient({
      createWorker: () => {
        throw new EngineError('unsupported', 'This browser cannot run Web Workers.');
      },
    });
    await expect(client.coreVersion()).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(client.coreVersion()).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('wraps other worker start-up errors', async () => {
    const client = new EngineClient({
      createWorker: () => {
        throw new TypeError('blocked by policy');
      },
    });
    await expect(client.coreVersion()).rejects.toMatchObject({
      kind: 'worker',
      message: expect.stringContaining('blocked by policy'),
    });
  });

  it('validates the pool size', () => {
    expect(() => new EngineClient({ size: 0 })).toThrow(RangeError);
    expect(() => new EngineClient({ size: 1.5 })).toThrow(RangeError);
  });
});

describe('isAbortError', () => {
  it('recognises abort rejections only', () => {
    expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true);
    expect(isAbortError(new EngineError('worker', 'x'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
