// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureRun } from '../../test/fixtures/shotFixture';
import { DEFAULT_RECIPE } from '../shot/recipeForm';
import { buildMicrostructure, type MicroOutcome, type Microstructure } from './microstructure';
import { useMicrostructure } from './useMicrostructure';

interface WorkerReply {
  model?: Microstructure;
  runtimeMs?: number;
  error?: string;
}
class TestWorker {
  static instances: TestWorker[] = [];
  static constructorError: Error | null = null;
  static postError: Error | null = null;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((_message: unknown) => {
    if (TestWorker.postError) throw TestWorker.postError;
  });
  constructor(_url: unknown, _options: unknown) {
    if (TestWorker.constructorError) throw TestWorker.constructorError;
    TestWorker.instances.push(this);
  }
  reply(data: WorkerReply) {
    this.onmessage?.({ data } as MessageEvent<WorkerReply>);
  }
}
function shot(): MicroOutcome {
  return fixtureRun(DEFAULT_RECIPE);
}
function packed(outcome: MicroOutcome, count = 80, seed = 1) {
  return buildMicrostructure(outcome, { count, seed, packingIterations: 0, networkResolution: 4 });
}
beforeEach(() => {
  TestWorker.instances = [];
  TestWorker.constructorError = null;
  TestWorker.postError = null;
  vi.stubGlobal('Worker', TestWorker);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('particle worker lifecycle', () => {
  it('ignores stale replies after either the outcome or displayed count changes', () => {
    const first = shot(),
      second = shot();
    const firstModel = packed(first),
      secondModel = packed(second, 80, 2),
      largerModel = packed(second, 100, 3);
    const { result, rerender } = renderHook(
      ({ outcome, count }) => useMicrostructure(outcome, count, true),
      { initialProps: { outcome: first, count: 80 } },
    );
    expect(TestWorker.instances[0].postMessage).toHaveBeenCalledWith({
      outcome: { build: first.build, result: first.result },
      options: { seed: 20261018, count: 80 },
    });
    rerender({ outcome: second, count: 80 });
    expect(TestWorker.instances[0].terminate).toHaveBeenCalled();
    act(() => TestWorker.instances[0].reply({ model: firstModel, runtimeMs: 100 }));
    expect(result.current.model).toBeNull();
    expect(TestWorker.instances).toHaveLength(2);
    act(() => TestWorker.instances[1].reply({ model: secondModel, runtimeMs: 7 }));
    expect(result.current.model).toBe(secondModel);
    expect(result.current.runtimeMs).toBe(7);
    rerender({ outcome: second, count: 100 });
    act(() => TestWorker.instances[1].reply({ error: 'Late failure from old count' }));
    expect(result.current.model).toBeNull();
    expect(result.current.error).toBeNull();
    act(() => TestWorker.instances[2].reply({ model: largerModel, runtimeMs: 9 }));
    expect(result.current.model).toBe(largerModel);
    expect(result.current.runtimeMs).toBe(9);
    expect(TestWorker.instances).toHaveLength(3);
  });
  it('cancels hidden work, ignores its late response and reuses completed packing after another mode switch', () => {
    const outcome = shot(),
      model = packed(outcome);
    const { result, rerender } = renderHook(
      ({ active }) => useMicrostructure(outcome, 80, active),
      { initialProps: { active: true } },
    );
    const cancelled = TestWorker.instances[0];
    rerender({ active: false });
    expect(cancelled.terminate).toHaveBeenCalled();
    act(() => cancelled.reply({ model }));
    expect(result.current.model).toBeNull();
    rerender({ active: true });
    expect(TestWorker.instances).toHaveLength(2);
    act(() => TestWorker.instances[1].reply({ model, runtimeMs: 4 }));
    expect(result.current.model).toBe(model);
    rerender({ active: false });
    rerender({ active: true });
    expect(TestWorker.instances).toHaveLength(2);
    expect(result.current.model).toBe(model);
    expect(result.current.loading).toBe(false);
  });
  it('does not construct workers for an empty or hidden view and ignores replies after unmount', () => {
    const outcome = shot(),
      model = packed(outcome);
    const { result, rerender, unmount } = renderHook<
      ReturnType<typeof useMicrostructure>,
      { outcome: MicroOutcome | null; active: boolean }
    >(({ outcome, active }) => useMicrostructure(outcome, 80, active), {
      initialProps: { outcome: null, active: true },
    });
    expect(result.current.loading).toBe(false);
    expect(TestWorker.instances).toHaveLength(0);
    rerender({ outcome, active: false });
    expect(TestWorker.instances).toHaveLength(0);
    rerender({ outcome, active: true });
    const worker = TestWorker.instances[0];
    unmount();
    expect(worker.terminate).toHaveBeenCalled();
    expect(() => worker.reply({ model })).not.toThrow();
    expect(TestWorker.instances).toHaveLength(1);
  });
  it('reports unsupported Worker without starting work or leaving a loading state', () => {
    vi.stubGlobal('Worker', undefined);
    const { result } = renderHook(() => useMicrostructure(shot(), 80, true));
    expect(result.current.error).toMatch(/workers are unavailable/i);
    expect(result.current.loading).toBe(false);
    expect(result.current.model).toBeNull();
    expect(TestWorker.instances).toHaveLength(0);
  });
  it('falls back when security policy blocks Worker construction', () => {
    TestWorker.constructorError = new DOMException('Blocked by security policy', 'SecurityError');
    const outcome = shot();
    const { result } = renderHook(() => useMicrostructure(outcome, 80, true));
    expect(result.current.error).toMatch(/worker could not start/i);
    expect(result.current.loading).toBe(false);
    expect(result.current.model).toBeNull();
    expect(TestWorker.instances).toHaveLength(0);
  });
  it('terminates and falls back if posting data throws, without accepting a later reply', () => {
    TestWorker.postError = new DOMException('Could not clone the worker payload', 'DataCloneError');
    const outcome = shot();
    const { result } = renderHook(() => useMicrostructure(outcome, 80, true));
    expect(result.current.error).toMatch(/worker|data|clone|start/i);
    expect(result.current.loading).toBe(false);
    const worker = TestWorker.instances[0];
    expect(worker.terminate).toHaveBeenCalled();
    act(() => worker.reply({ model: packed(outcome) }));
    expect(result.current.model).toBeNull();
    expect(result.current.loading).toBe(false);
  });
  it('keeps a worker-reported generation failure visible without retrying in a loop', () => {
    const outcome = shot();
    const { result, rerender } = renderHook(() => useMicrostructure(outcome, 80, true));
    act(() => TestWorker.instances[0].reply({ error: 'Packing input rejected' }));
    expect(result.current.error).toBe('Packing input rejected');
    expect(result.current.loading).toBe(false);
    rerender();
    expect(TestWorker.instances).toHaveLength(1);
    expect(TestWorker.instances[0].terminate).toHaveBeenCalled();
  });
});
