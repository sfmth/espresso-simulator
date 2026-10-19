// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import {
  compareBenchmarkQuality,
  createBenchmark,
  createGpuTimer,
  orbitPoseAt,
  readWebGLInfo,
  type BenchmarkEnvironment,
} from './benchmark';

function environment(): BenchmarkEnvironment {
  return {
    particleCount: 30000,
    renderPath: 'analytic-exact',
    sphereQuality: 'exact sphere silhouette and surface depth',
    networkVisible: false,
    cutFraction: 1,
    cssWidthPx: 1000,
    cssHeightPx: 500,
    drawingBufferWidthPx: 2000,
    drawingBufferHeightPx: 1000,
    devicePixelRatio: 3,
    rendererPixelRatio: 2,
    camera: {
      position: [13.5, 9, 16],
      target: [0, 0, 0],
      verticalFovDeg: 40,
      orbitRadiansPerSecond: 0.36,
    },
    webgl: {
      version: 'WebGL 2.0',
      vendor: 'vendor',
      renderer: 'masked',
      shadingLanguageVersion: 'WebGL GLSL ES 3.00',
      unmaskedVendor: 'NVIDIA',
      unmaskedRenderer: 'ANGLE (NVIDIA RTX laptop)',
      contextAttributes: { antialias: false, alpha: false },
      contextLost: false,
    },
    extraQuality: { modelSeed: 20261018, analyticCountAtStart: 30000 },
  };
}

describe('render benchmark cadence', () => {
  it('lets the caller cancel a clock failure while retaining only prior valid sample statistics', () => {
    const benchmark = createBenchmark({
      environment: environment(),
      targetFps: 60,
      warmupMs: 0,
      minWarmupFrames: 0,
    });
    benchmark.start(0);
    benchmark.recordFrame(10, 1);
    benchmark.recordFrame(20, 2);
    expect(() => benchmark.recordFrame(20, 999)).toThrow('"relation":"duplicate"');
    benchmark.cancel('clock-discontinuity');
    expect(benchmark.finish()).toMatchObject({
      status: 'cancelled',
      reason: 'clock-discontinuity',
      actualSampleMs: 10,
      sampleFrames: 2,
      intervalCount: 1,
      stats: {
        meanFps: 100,
        frameIntervalMs: { min: 10, max: 10, mean: 10, median: 10, p95: 10 },
        cpuRenderMs: { min: 1, max: 2, mean: 1.5, median: 1.5, p95: 1.95 },
      },
    });
    expect(benchmark.recordFrame(30).phase).toBe('cancelled');
    expect(benchmark.finish().sampleFrames).toBe(2);
  });

  it.each([
    { clock: 99, relation: 'before-start', previous: null, delta: null },
    { clock: 102, relation: 'duplicate', previous: 102, delta: 0 },
    { clock: 101, relation: 'regression', previous: 102, delta: -1 },
  ])(
    'retains numeric diagnostics for a $relation frame clock without changing statistics',
    ({ clock, relation, previous, delta }) => {
      const benchmark = createBenchmark({ environment: environment(), targetFps: 60 });
      benchmark.start(100);
      if (previous !== null) benchmark.recordFrame(previous, 1);
      let message = '';
      try {
        benchmark.recordFrame(clock, 999);
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        message = (error as Error).message;
      }
      expect(message).toContain(
        JSON.stringify({
          relation,
          nowMs: clock,
          startedAtMs: 100,
          previousFrameMs: previous,
          deltaFromStartMs: clock - 100,
          deltaFromPreviousMs: delta,
          phase: 'warmup',
          warmupFrames: previous === null ? 0 : 1,
          sampleFrames: 0,
        }),
      );
      expect(benchmark.progress().warmupFrames).toBe(previous === null ? 0 : 1);
      expect(benchmark.progress().sampleFrames).toBe(0);
    },
  );

  it('starts on the first RAF clock when that timestamp predates the setup task clock', () => {
    const config = {
      environment: environment(),
      targetFps: 60,
      warmupMs: 100,
      minWarmupFrames: 2,
      sampleMs: 30,
    };
    // RAF timestamps describe the browser frame, so performance.now() in the
    // setup task can already be later than the first callback's RAF clock.
    const setupTaskClock = 1005,
      firstRafClock = 1000;
    const mixedClocks = createBenchmark(config);
    mixedClocks.start(setupTaskClock);
    expect(() => mixedClocks.recordFrame(firstRafClock)).toThrow('follow the start clock');

    const benchmark = createBenchmark(config);
    const submit = (rafClock: number) => {
      if (benchmark.progress().phase === 'idle') benchmark.start(rafClock);
      benchmark.recordFrame(rafClock, 1);
    };
    submit(firstRafClock);
    submit(1040);
    expect(benchmark.willStartSample(1100)).toBe(true);
    submit(1100);
    submit(1110);
    submit(1130);
    expect(benchmark.finish()).toMatchObject({
      status: 'complete',
      warmupFrames: 2,
      warmupElapsedMs: 100,
      actualSampleMs: 30,
      sampleFrames: 3,
      intervalCount: 2,
    });
  });

  it('excludes warmup, counts intervals rather than callbacks, and reports R7 p95', () => {
    const bench = createBenchmark({
      environment: environment(),
      targetFps: 100,
      warmupMs: 100,
      minWarmupFrames: 2,
      sampleMs: 60,
      budgetToleranceMs: 0,
    });
    bench.start(1000);
    bench.recordFrame(1050, 500);
    bench.recordFrame(1100, 500);
    expect(bench.willStartSample(1110)).toBe(true);
    bench.recordFrame(1110, 1);
    bench.recordFrame(1120, 2);
    bench.recordFrame(1140, 3);
    expect(bench.recordFrame(1170, 4).phase).toBe('complete');
    const result = bench.finish();
    expect(result.warmupFrames).toBe(2);
    expect(result.warmupElapsedMs).toBe(110);
    expect(result.sampleFrames).toBe(4);
    expect(result.intervalCount).toBe(3);
    expect(result.actualSampleMs).toBe(60);
    expect(result.stats.meanFps).toBe(50);
    expect(result.stats.frameIntervalMs).toEqual({
      min: 10,
      max: 30,
      mean: 20,
      median: 20,
      p95: 29,
    });
    expect(result.stats.cpuRenderMs?.mean).toBe(2.5);
    expect(result.stats.overBudgetFrames).toBe(2);
    expect(result.stats.estimatedDroppedFrames).toBe(3);
    expect(result.stats.estimatedDropFraction).toBe(0.5);
  });

  it('requires both minimum shader warmup submissions and wall time on slow devices', () => {
    const bench = createBenchmark({ environment: environment(), targetFps: 60 });
    bench.start(0);
    for (let i = 1; i <= 30; i++) {
      expect(bench.willStartSample(i * 1000)).toBe(false);
      expect(bench.recordFrame(i * 1000).phase).toBe('warmup');
    }
    expect(bench.willStartSample(31000)).toBe(true);
    expect(bench.recordFrame(31000).phase).toBe('sample');
    bench.recordFrame(36000);
    expect(bench.finish()).toMatchObject({
      warmupElapsedMs: 31000,
      warmupFrames: 30,
      actualSampleMs: 5000,
      status: 'complete',
    });
  });

  it('permits timestamp rounding while exposing actual long-frame missed-slot estimates', () => {
    const bench = createBenchmark({
      environment: environment(),
      targetFps: 60,
      warmupMs: 0,
      minWarmupFrames: 0,
      sampleMs: 50,
    });
    bench.start(0);
    bench.recordFrame(0);
    bench.recordFrame(16.7);
    bench.recordFrame(50.1);
    const result = bench.finish();
    expect(result.stats.overBudgetFrames).toBe(1);
    expect(result.stats.estimatedDroppedFrames).toBe(1);
    expect(result.stats.targetFrameBudgetMs).toBeCloseTo(16.6666666667);
    expect(result.protocol.budgetToleranceMs).toBe(0.5);
  });

  it.each(['tab-hidden', 'context-lost', 'configuration-changed', 'disposed'] as const)(
    'cancels truthfully on %s without accumulating later callbacks',
    (reason) => {
      const bench = createBenchmark({
        environment: environment(),
        targetFps: 60,
        warmupMs: 0,
        minWarmupFrames: 0,
      });
      bench.start(0);
      bench.recordFrame(10);
      bench.recordFrame(20);
      bench.cancel(reason);
      bench.recordFrame(99999);
      const result = bench.finish();
      expect(result).toMatchObject({
        status: 'cancelled',
        reason,
        actualSampleMs: 10,
        sampleFrames: 2,
      });
      expect(result.measurementLimits.join(' ')).toContain('not GPU completion');
    },
  );

  it('reports incomplete and empty samples without inventing FPS', () => {
    const bench = createBenchmark({ environment: environment(), targetFps: 30 });
    bench.start(0);
    bench.recordFrame(100);
    expect(bench.finish()).toMatchObject({
      status: 'incomplete',
      reason: 'finish-before-sample-complete',
      intervalCount: 0,
      stats: { meanFps: null, frameIntervalMs: null },
    });
    expect(bench.recordFrame(10000).phase).toBe('incomplete');
  });

  it('freezes configuration and results so later camera changes cannot rewrite evidence', () => {
    const env = environment();
    const bench = createBenchmark({ environment: env, targetFps: 60 });
    env.particleCount = 5000;
    bench.start(0);
    bench.cancel('interrupted');
    const report = bench.finish();
    report.environment.particleCount = 2;
    expect(bench.finish().environment.particleCount).toBe(30000);
    expect(() => bench.start(1)).toThrow('only start once');
  });

  it('rejects impossible metadata and nonmonotonic clocks', () => {
    expect(() =>
      createBenchmark({
        environment: { ...environment(), drawingBufferWidthPx: 1.5 },
        targetFps: 60,
      }),
    ).toThrow('integer');
    expect(() => createBenchmark({ environment: environment(), targetFps: NaN })).toThrow(
      'Target FPS',
    );
    const bench = createBenchmark({ environment: environment(), targetFps: 60 });
    expect(() => bench.recordFrame(1)).toThrow('Start');
    bench.start(2);
    expect(() => bench.recordFrame(1)).toThrow('strictly increase');
    bench.recordFrame(3);
    expect(() => bench.recordFrame(3)).toThrow('strictly increase');
    expect(() => bench.recordFrame(4, Infinity)).toThrow('CPU');
  });

  it('separates disjoint and pending GPU queries from valid measured durations', () => {
    const bench = createBenchmark({ environment: environment(), targetFps: 60 });
    bench.start(0);
    bench.cancel('interrupted');
    const report = bench.finish({
      supported: true,
      disjoint: true,
      everyFrames: 4,
      samplesMs: [1, 2],
      pending: 3,
    });
    expect(report.gpuTiming).toEqual({
      supported: true,
      disjoint: true,
      queryEveryFrames: 4,
      validSampleCount: 0,
      discardedSampleCount: 2,
      pendingQueries: 3,
      elapsedMs: null,
    });
  });
});

describe('benchmark camera and workload', () => {
  it('has an FPS-independent orbit from the captured initial position and fixed target', () => {
    const start = [3, 4, 2] as const,
      target = [1, 1, 2] as const;
    expect(orbitPoseAt(start, target, 0)).toEqual([3, 4, 2]);
    const pose = orbitPoseAt(start, target, 1000, Math.PI / 2);
    expect(pose[0]).toBeCloseTo(1);
    expect(pose[1]).toBe(4);
    expect(pose[2]).toBeCloseTo(0);
    // The result at a wall-clock time does not depend on how many preceding frames ran.
    for (let t = 0; t < 1000; t += 7) orbitPoseAt(start, target, t, Math.PI / 2);
    expect(orbitPoseAt(start, target, 1000, Math.PI / 2)).toEqual(pose);
  });

  it('rejects reduced pixel workload, hidden networks, mesh fidelity, and changed camera as equal-quality evidence', () => {
    const baseline = environment(),
      hardware = environment();
    hardware.webgl.unmaskedRenderer = 'Other GPU';
    expect(compareBenchmarkQuality(baseline, hardware).comparable).toBe(true);
    const altered = environment();
    altered.drawingBufferWidthPx /= 2;
    altered.networkVisible = true;
    altered.sphereQuality = 'mesh error <= .25px';
    altered.camera.position = [13.5, 9, 17];
    expect(compareBenchmarkQuality(baseline, altered)).toEqual({
      comparable: false,
      differences: ['sphereQuality', 'networkVisible', 'drawingBufferWidthPx', 'camera'],
    });
  });

  it('records real GL strings and privacy restrictions without guessing hardware', () => {
    const values = new Map<number, unknown>([
      [0x1f02, 'WebGL 2.0'],
      [42, 'RTX laptop'],
    ]);
    const gl = {
      getParameter: (key: number) => values.get(key),
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 42 }),
      getContextAttributes: () => ({ antialias: false }),
      isContextLost: () => false,
    };
    expect(readWebGLInfo(gl)).toMatchObject({
      version: 'WebGL 2.0',
      unmaskedRenderer: 'RTX laptop',
      renderer: null,
      contextAttributes: { antialias: false },
    });
    gl.getExtension = () => {
      throw new Error('SecurityError');
    };
    expect(readWebGLInfo(gl).unmaskedRenderer).toBeNull();
  });
});

function fakeGL() {
  let available = false,
    disjoint = false,
    id = 0;
  const gl = {
    getExtension: vi.fn((): unknown => ({ TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 })),
    isContextLost: vi.fn(() => false),
    getQuery: vi.fn(() => null),
    createQuery: vi.fn(() => ({ id: ++id })),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    deleteQuery: vi.fn(),
    getParameter: vi.fn(() => disjoint),
    getQueryParameter: vi.fn((_q: unknown, parameter: number) =>
      parameter === 0x8867 ? available : 2500000,
    ),
  };
  return {
    gl,
    context: gl as unknown as WebGL2RenderingContext,
    available: () => {
      available = true;
    },
    disjoint: () => {
      disjoint = true;
    },
  };
}

describe('nonblocking GPU timer', () => {
  it('samples every fourth submission and only reads results when available', () => {
    const f = fakeGL(),
      timer = createGpuTimer(f.context);
    expect(timer.begin(1)).toBe(false);
    expect(timer.begin(0)).toBe(true);
    timer.end();
    expect(timer.poll()).toEqual({ samples: [], disjoint: false, pending: 1 });
    expect(f.gl.getQueryParameter).not.toHaveBeenCalledWith(expect.anything(), 0x8866);
    f.available();
    expect(timer.poll()).toEqual({
      samples: [{ frameId: 0, elapsedMs: 2.5 }],
      disjoint: false,
      pending: 0,
    });
    expect(f.gl.deleteQuery).toHaveBeenCalledOnce();
    timer.dispose();
    expect(timer.begin(4)).toBe(false);
  });

  it('bounds pending work and discards all disjoint results without synchronization', () => {
    const f = fakeGL(),
      timer = createGpuTimer(f.context, { maxPendingQueries: 1 });
    expect(timer.begin(0)).toBe(true);
    timer.end();
    expect(timer.begin(4)).toBe(false);
    f.available();
    f.disjoint();
    expect(timer.poll()).toEqual({ samples: [], disjoint: true, pending: 0 });
    expect(f.gl.getQueryParameter).not.toHaveBeenCalled();
    expect(timer.begin(8)).toBe(false);
  });

  it.each(['absent', 'security-blocked'])('gracefully handles %s extensions', (state) => {
    const f = fakeGL();
    f.gl.getExtension.mockImplementation(() => {
      if (state === 'security-blocked') throw new Error('SecurityError');
      return null;
    });
    const timer = createGpuTimer(f.context);
    expect(timer.supported).toBe(false);
    expect(timer.begin(0)).toBe(false);
    expect(timer.poll()).toEqual({ samples: [], disjoint: false, pending: 0 });
    timer.dispose();
  });
});
