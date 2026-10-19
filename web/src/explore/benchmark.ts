// SPDX-License-Identifier: GPL-2.0-or-later
/** Reproducible frame-cadence measurements. No GPU synchronization or physics changes. */
export type BenchmarkVector = readonly [number, number, number];
export interface BenchmarkCamera {
  position: BenchmarkVector;
  target: BenchmarkVector;
  verticalFovDeg: number;
  orbitRadiansPerSecond: number;
}
export type BenchmarkQualityValue = string | number | boolean | null;
export interface WebGLInfo {
  version: string | null;
  vendor: string | null;
  renderer: string | null;
  shadingLanguageVersion: string | null;
  unmaskedVendor: string | null;
  unmaskedRenderer: string | null;
  contextAttributes: Record<string, BenchmarkQualityValue> | null;
  contextLost: boolean;
}
export interface BenchmarkEnvironment {
  particleCount: number;
  renderPath: string;
  sphereQuality: string;
  networkVisible: boolean;
  cutFraction: number;
  cssWidthPx: number;
  cssHeightPx: number;
  drawingBufferWidthPx: number;
  drawingBufferHeightPx: number;
  /** Screen/window DPR and the renderer's capped DPR are recorded separately. */
  devicePixelRatio: number;
  rendererPixelRatio: number;
  camera: BenchmarkCamera;
  webgl: WebGLInfo;
  extraQuality?: Record<string, BenchmarkQualityValue>;
}
export interface BenchmarkProtocol {
  targetFps: number;
  warmupMs: number;
  sampleMs: number;
  minWarmupFrames: number;
  /** Allows normal timestamp rounding around a refresh boundary. Always reported. */
  budgetToleranceMs: number;
}
export interface BenchmarkConfig extends Partial<Omit<BenchmarkProtocol, 'targetFps'>> {
  environment: BenchmarkEnvironment;
  targetFps: number;
}
export type BenchmarkCancelReason =
  | 'tab-hidden'
  | 'context-lost'
  | 'configuration-changed'
  | 'clock-discontinuity'
  | 'interrupted'
  | 'disposed';
export type BenchmarkPhase = 'idle' | 'warmup' | 'sample' | 'complete' | 'cancelled' | 'incomplete';
export interface BenchmarkProgress {
  phase: BenchmarkPhase;
  elapsedMs: number;
  warmupElapsedMs: number;
  sampleElapsedMs: number;
  warmupFrames: number;
  sampleFrames: number;
}
export interface SampleDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
}
export interface BenchmarkResult {
  schema: 'puckworks.render-benchmark/1';
  status: 'complete' | 'cancelled' | 'incomplete';
  reason: BenchmarkCancelReason | 'sample-complete' | 'finish-before-sample-complete';
  environment: BenchmarkEnvironment;
  protocol: BenchmarkProtocol;
  warmupElapsedMs: number;
  warmupFrames: number;
  actualSampleMs: number;
  sampleFrames: number;
  intervalCount: number;
  stats: {
    meanFps: number | null;
    frameIntervalMs: SampleDistribution | null;
    cpuRenderMs: SampleDistribution | null;
    targetFrameBudgetMs: number;
    overBudgetFrames: number;
    overBudgetFraction: number | null;
    /** Estimated missed target-budget slots, not observed dropped presentations. */
    estimatedDroppedFrames: number;
    estimatedDropFraction: number | null;
  };
  gpuTiming: {
    supported: boolean;
    disjoint: boolean;
    queryEveryFrames: number | null;
    validSampleCount: number;
    discardedSampleCount: number;
    pendingQueries: number;
    elapsedMs: SampleDistribution | null;
  };
  quantileMethod: 'linear_interpolation_n_minus_1';
  measurementLimits: string[];
}
export interface BenchmarkAccumulator {
  start(nowMs: number): void;
  /** Inspect before rendering so the sample anchor uses the fixed initial camera pose. */
  willStartSample(rafTimestampMs: number): boolean;
  /** Call after a successful CPU render submission, using that callback's RAF clock. */
  recordFrame(rafTimestampMs: number, cpuRenderMs?: number): BenchmarkProgress;
  cancel(reason: BenchmarkCancelReason): void;
  /** Finalizes once. Ending an unfinished sample produces an explicitly incomplete result. */
  finish(gpu?: BenchmarkGpuSummary): BenchmarkResult;
  progress(): BenchmarkProgress;
}
export interface BenchmarkGpuSummary {
  supported: boolean;
  disjoint: boolean;
  everyFrames: number;
  samplesMs: readonly number[];
  pending: number;
}
export const DEFAULT_BENCHMARK_PROTOCOL = {
  warmupMs: 1500,
  sampleMs: 5000,
  minWarmupFrames: 30,
  budgetToleranceMs: 0.5,
} as const;
const LIMITS = [
  'Frame intervals measure requestAnimationFrame scheduling between successful CPU render submissions, not GPU completion or compositor presentation.',
  'Browser command queues can outlive a render call. No per-frame gl.finish or readback is used; this is a cadence proxy, not a GPU-completed-frame count.',
  'Estimated dropped frames count missed target-budget slots with the reported tolerance, not directly observed display refreshes or dropped presentations.',
  'WebGL renderer strings can be masked. Hardware class and laptop/phone G5 eligibility require separate evidence; this result alone does not establish G5.',
  'Optional available, non-disjoint GPU timer queries measure execution of sampled render commands. They do not measure compositor presentation, and unresolved queries are reported.',
];
function bounded(value: number, label: string, min = 0, max = Number.MAX_VALUE): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${label} must be finite in [${min}, ${max}].`);
  return value;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function validateCamera(camera: BenchmarkCamera): void {
  if (camera.position.length !== 3 || camera.target.length !== 3)
    throw new RangeError('Camera vectors need three coordinates.');
  [...camera.position, ...camera.target].forEach((value) =>
    bounded(value, 'Camera coordinate', -Number.MAX_VALUE),
  );
  bounded(camera.verticalFovDeg, 'Camera FOV', 0.001, 179);
  bounded(camera.orbitRadiansPerSecond, 'Camera speed', -100, 100);
}
function validateEnvironment(environment: BenchmarkEnvironment): void {
  if (!Number.isSafeInteger(environment.particleCount) || environment.particleCount < 1)
    throw new RangeError('Particle count must be a positive safe integer.');
  for (const key of [
    'cssWidthPx',
    'cssHeightPx',
    'drawingBufferWidthPx',
    'drawingBufferHeightPx',
    'devicePixelRatio',
    'rendererPixelRatio',
  ] as const)
    bounded(environment[key], key, Number.MIN_VALUE);
  for (const key of ['drawingBufferWidthPx', 'drawingBufferHeightPx'] as const)
    if (!Number.isSafeInteger(environment[key])) throw new RangeError(`${key} must be an integer.`);
  bounded(environment.cutFraction, 'Cut fraction', 0, 1);
  if (!environment.renderPath.trim() || !environment.sphereQuality.trim())
    throw new RangeError('Render path and sphere quality must be explicit.');
  for (const value of Object.values(environment.extraQuality ?? {}))
    if (typeof value === 'number') bounded(value, 'Extra quality value', -Number.MAX_VALUE);
  validateCamera(environment.camera);
}
/** R7 sample quantile, with the exact method retained in exported reports. */
function distribution(values: readonly number[]): SampleDistribution | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => {
    const at = (sorted.length - 1) * p,
      low = Math.floor(at),
      high = Math.ceil(at);
    return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
  };
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    median: quantile(0.5),
    p95: quantile(0.95),
  };
}
export function createBenchmark(config: BenchmarkConfig): BenchmarkAccumulator {
  validateEnvironment(config.environment);
  const environment = clone(config.environment);
  const protocol: BenchmarkProtocol = {
    targetFps: config.targetFps,
    warmupMs: config.warmupMs ?? DEFAULT_BENCHMARK_PROTOCOL.warmupMs,
    sampleMs: config.sampleMs ?? DEFAULT_BENCHMARK_PROTOCOL.sampleMs,
    minWarmupFrames: config.minWarmupFrames ?? DEFAULT_BENCHMARK_PROTOCOL.minWarmupFrames,
    budgetToleranceMs: config.budgetToleranceMs ?? DEFAULT_BENCHMARK_PROTOCOL.budgetToleranceMs,
  };
  bounded(protocol.targetFps, 'Target FPS', 1, 1000);
  bounded(protocol.warmupMs, 'Warmup duration', 0, 60000);
  bounded(protocol.sampleMs, 'Sample duration', Number.MIN_VALUE, 60000);
  bounded(protocol.budgetToleranceMs, 'Budget tolerance', 0, 1000 / protocol.targetFps / 2);
  if (
    !Number.isInteger(protocol.minWarmupFrames) ||
    protocol.minWarmupFrames < 0 ||
    protocol.minWarmupFrames > 10000
  )
    throw new RangeError('Warmup frames must be an integer from zero to 10000.');
  let phase: BenchmarkPhase = 'idle',
    startedAt: number | null = null,
    lastAt: number | null = null,
    sampleStart: number | null = null;
  let warmupFrames = 0,
    cancellation: BenchmarkCancelReason | null = null,
    result: BenchmarkResult | null = null;
  const times: number[] = [],
    cpuTimes: number[] = [];
  const terminal = () => phase === 'complete' || phase === 'cancelled' || phase === 'incomplete';
  const progress = (): BenchmarkProgress => ({
    phase,
    elapsedMs: startedAt === null || lastAt === null ? 0 : lastAt - startedAt,
    warmupElapsedMs: startedAt === null ? 0 : (sampleStart ?? lastAt ?? startedAt) - startedAt,
    sampleElapsedMs: sampleStart === null || lastAt === null ? 0 : lastAt - sampleStart,
    warmupFrames,
    sampleFrames: times.length,
  });
  return {
    start(nowMs) {
      if (phase !== 'idle') throw new Error('A benchmark can only start once.');
      startedAt = bounded(nowMs, 'Start clock');
      phase = 'warmup';
      if (environment.webgl.contextLost) {
        phase = 'cancelled';
        cancellation = 'context-lost';
      }
    },
    willStartSample(nowMs) {
      bounded(nowMs, 'Frame clock');
      return (
        phase === 'warmup' &&
        startedAt !== null &&
        nowMs - startedAt >= protocol.warmupMs &&
        warmupFrames >= protocol.minWarmupFrames
      );
    },
    recordFrame(nowMs, cpuRenderMs) {
      if (terminal()) return progress();
      if (startedAt === null) throw new Error('Start the benchmark before recording frames.');
      bounded(nowMs, 'Frame clock');
      if (nowMs < startedAt || (lastAt !== null && nowMs <= lastAt)) {
        const diagnostic = {
          relation:
            nowMs < startedAt ? 'before-start' : nowMs === lastAt ? 'duplicate' : 'regression',
          nowMs,
          startedAtMs: startedAt,
          previousFrameMs: lastAt,
          deltaFromStartMs: nowMs - startedAt,
          deltaFromPreviousMs: lastAt === null ? null : nowMs - lastAt,
          phase,
          warmupFrames,
          sampleFrames: times.length,
        };
        throw new RangeError(
          `Frame clocks must strictly increase and follow the start clock. ${JSON.stringify(diagnostic)}`,
        );
      }
      if (cpuRenderMs !== undefined) bounded(cpuRenderMs, 'CPU render duration');
      lastAt = nowMs;
      if (sampleStart === null) {
        if (nowMs - startedAt >= protocol.warmupMs && warmupFrames >= protocol.minWarmupFrames) {
          sampleStart = nowMs;
          phase = 'sample';
        } else {
          warmupFrames++;
          return progress();
        }
      }
      if (times.length >= 100000)
        throw new RangeError('Benchmark sample exceeds 100000 frame submissions.');
      times.push(nowMs);
      if (cpuRenderMs !== undefined) cpuTimes.push(cpuRenderMs);
      if (nowMs - sampleStart >= protocol.sampleMs) phase = 'complete';
      return progress();
    },
    cancel(reason) {
      if (!terminal()) {
        phase = 'cancelled';
        cancellation = reason;
      }
    },
    progress,
    finish(gpu) {
      if (result) return clone(result);
      if (phase !== 'complete' && phase !== 'cancelled') phase = 'incomplete';
      const intervals = times.slice(1).map((time, i) => time - times[i]);
      const actualSampleMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
      const budget = 1000 / protocol.targetFps;
      const overBudgetFrames = intervals.filter(
        (dt) => dt > budget + protocol.budgetToleranceMs,
      ).length;
      const dropped = intervals.reduce(
        (sum, dt) => sum + Math.max(0, Math.ceil((dt - protocol.budgetToleranceMs) / budget) - 1),
        0,
      );
      const p = progress();
      if (
        gpu &&
        (!Number.isSafeInteger(gpu.everyFrames) ||
          gpu.everyFrames < 1 ||
          !Number.isSafeInteger(gpu.pending) ||
          gpu.pending < 0)
      )
        throw new RangeError(
          'GPU cadence and pending-query count must be nonnegative safe integers, with positive cadence.',
        );
      gpu?.samplesMs.forEach((value) => bounded(value, 'GPU render duration'));
      const gpuValues = gpu?.supported && !gpu.disjoint ? [...gpu.samplesMs] : [];
      gpuValues.forEach((value) => bounded(value, 'GPU render duration'));
      result = {
        schema: 'puckworks.render-benchmark/1',
        status: phase,
        reason:
          cancellation ??
          (phase === 'complete' ? 'sample-complete' : 'finish-before-sample-complete'),
        environment,
        protocol,
        warmupElapsedMs: p.warmupElapsedMs,
        warmupFrames,
        actualSampleMs,
        sampleFrames: times.length,
        intervalCount: intervals.length,
        stats: {
          meanFps: actualSampleMs > 0 ? (intervals.length * 1000) / actualSampleMs : null,
          frameIntervalMs: distribution(intervals),
          cpuRenderMs: distribution(cpuTimes),
          targetFrameBudgetMs: budget,
          overBudgetFrames,
          overBudgetFraction: intervals.length ? overBudgetFrames / intervals.length : null,
          estimatedDroppedFrames: dropped,
          estimatedDropFraction:
            intervals.length + dropped ? dropped / (intervals.length + dropped) : null,
        },
        gpuTiming: {
          supported: gpu?.supported ?? false,
          disjoint: gpu?.disjoint ?? false,
          queryEveryFrames: gpu?.everyFrames ?? null,
          validSampleCount: gpuValues.length,
          discardedSampleCount: gpu?.disjoint ? gpu.samplesMs.length : 0,
          pendingQueries: gpu?.pending ?? 0,
          elapsedMs: distribution(gpuValues),
        },
        quantileMethod: 'linear_interpolation_n_minus_1',
        measurementLimits: [...LIMITS],
      };
      return clone(result);
    },
  };
}

/** Fixed initial pose + elapsed clock, so slower devices take the same camera path. */
export function orbitPoseAt(
  initialPosition: BenchmarkVector,
  target: BenchmarkVector,
  elapsedMs: number,
  radiansPerSecond = 0.36,
): [number, number, number] {
  [...initialPosition, ...target].forEach((value) =>
    bounded(value, 'Camera coordinate', -Number.MAX_VALUE),
  );
  bounded(elapsedMs, 'Camera elapsed time');
  bounded(radiansPerSecond, 'Camera speed', -100, 100);
  const angle = (elapsedMs * radiansPerSecond) / 1000,
    x = initialPosition[0] - target[0],
    z = initialPosition[2] - target[2];
  return [
    target[0] + x * Math.cos(angle) + z * Math.sin(angle),
    initialPosition[1],
    target[2] + z * Math.cos(angle) - x * Math.sin(angle),
  ];
}
interface GLProbe {
  getParameter(parameter: number): unknown;
  getExtension(name: string): unknown;
  getContextAttributes(): WebGLContextAttributes | null;
  isContextLost(): boolean;
}
interface DebugRendererExtension {
  UNMASKED_VENDOR_WEBGL?: unknown;
  UNMASKED_RENDERER_WEBGL?: unknown;
}
/** Read once before warmup; no GPU readback, finish, guessed backend or user-agent inference. */
export function readWebGLInfo(gl: GLProbe): WebGLInfo {
  const string = (parameter: number): string | null => {
    try {
      const v = gl.getParameter(parameter);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  let extension: DebugRendererExtension | null = null;
  try {
    extension = gl.getExtension('WEBGL_debug_renderer_info') as DebugRendererExtension | null;
  } catch {
    /* privacy/security restriction */
  }
  let contextAttributes: WebGLInfo['contextAttributes'] = null;
  try {
    const a = gl.getContextAttributes();
    if (a)
      contextAttributes = Object.fromEntries(
        Object.entries(a).filter(
          ([, v]) =>
            typeof v === 'boolean' ||
            typeof v === 'string' ||
            (typeof v === 'number' && Number.isFinite(v)),
        ),
      );
  } catch {
    /* lost context */
  }
  let contextLost: boolean;
  try {
    contextLost = gl.isContextLost();
  } catch {
    contextLost = true;
  }
  return {
    version: string(0x1f02),
    vendor: string(0x1f00),
    renderer: string(0x1f01),
    shadingLanguageVersion: string(0x8b8c),
    unmaskedVendor:
      typeof extension?.UNMASKED_VENDOR_WEBGL === 'number'
        ? string(extension.UNMASKED_VENDOR_WEBGL)
        : null,
    unmaskedRenderer:
      typeof extension?.UNMASKED_RENDERER_WEBGL === 'number'
        ? string(extension.UNMASKED_RENDERER_WEBGL)
        : null,
    contextAttributes,
    contextLost,
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Backend/hardware strings differ across devices; all visual/workload fields must match. */
export function compareBenchmarkQuality(
  a: BenchmarkEnvironment,
  b: BenchmarkEnvironment,
): { comparable: boolean; differences: string[] } {
  const fields: (keyof BenchmarkEnvironment)[] = [
    'particleCount',
    'renderPath',
    'sphereQuality',
    'networkVisible',
    'cutFraction',
    'cssWidthPx',
    'cssHeightPx',
    'drawingBufferWidthPx',
    'drawingBufferHeightPx',
    'devicePixelRatio',
    'rendererPixelRatio',
    'camera',
    'extraQuality',
  ];
  const differences = fields.filter((key) => canonical(a[key]) !== canonical(b[key])).map(String);
  if (canonical(a.webgl.contextAttributes) !== canonical(b.webgl.contextAttributes))
    differences.push('webgl.contextAttributes');
  return { comparable: differences.length === 0, differences };
}

export interface GpuTimerSample {
  frameId: number;
  elapsedMs: number;
}
export interface GpuTimerPoll {
  samples: GpuTimerSample[];
  disjoint: boolean;
  pending: number;
}
export interface GpuTimer {
  supported: boolean;
  everyFrames: number;
  begin(frameId: number): boolean;
  end(): void;
  poll(): GpuTimerPoll;
  dispose(): void;
}
/** Optional asynchronous query instrumentation. Never waits for a query or forces GPU completion. */
export function createGpuTimer(
  gl: WebGL2RenderingContext,
  {
    everyFrames = 4,
    maxPendingQueries = 64,
  }: { everyFrames?: number; maxPendingQueries?: number } = {},
): GpuTimer {
  if (!Number.isInteger(everyFrames) || everyFrames < 1 || everyFrames > 1000)
    throw new RangeError('GPU timer cadence must be an integer from one to 1000.');
  if (!Number.isInteger(maxPendingQueries) || maxPendingQueries < 1 || maxPendingQueries > 1000)
    throw new RangeError('GPU pending-query limit must be an integer from one to 1000.');
  let extension: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  try {
    const candidate: unknown = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (
      candidate &&
      typeof candidate === 'object' &&
      'TIME_ELAPSED_EXT' in candidate &&
      'GPU_DISJOINT_EXT' in candidate &&
      typeof candidate.TIME_ELAPSED_EXT === 'number' &&
      typeof candidate.GPU_DISJOINT_EXT === 'number'
    )
      extension = {
        TIME_ELAPSED_EXT: candidate.TIME_ELAPSED_EXT,
        GPU_DISJOINT_EXT: candidate.GPU_DISJOINT_EXT,
      };
  } catch {
    /* unavailable under browser privacy/security settings */
  }
  const ext = extension;
  let active: { query: WebGLQuery; frameId: number } | null = null,
    disposed = false,
    disjointSeen = false;
  const pending: { query: WebGLQuery; frameId: number }[] = [];
  const remove = (query: WebGLQuery) => {
    try {
      gl.deleteQuery(query);
    } catch {
      /* lost context */
    }
  };
  const clear = () => {
    if (active && ext) {
      try {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
      } catch {
        /* lost context */
      }
      remove(active.query);
      active = null;
    }
    for (const item of pending.splice(0)) remove(item.query);
  };
  return {
    supported: ext !== null,
    everyFrames,
    begin(frameId) {
      if (!Number.isSafeInteger(frameId) || frameId < 0)
        throw new RangeError('GPU frame id must be a nonnegative safe integer.');
      if (
        !ext ||
        disposed ||
        disjointSeen ||
        active ||
        frameId % everyFrames !== 0 ||
        pending.length >= maxPendingQueries
      )
        return false;
      try {
        if (gl.isContextLost() || gl.getQuery(ext.TIME_ELAPSED_EXT, 0x8865) !== null) return false;
        const query = gl.createQuery();
        if (!query) return false;
        try {
          gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        } catch {
          remove(query);
          return false;
        }
        active = { query, frameId };
        return true;
      } catch {
        return false;
      }
    },
    end() {
      if (!ext || !active) return;
      const item = active;
      active = null;
      try {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push(item);
      } catch {
        remove(item.query);
      }
    },
    poll() {
      const samples: GpuTimerSample[] = [];
      if (!ext || disposed) return { samples, disjoint: disjointSeen, pending: pending.length };
      try {
        if (gl.isContextLost() || gl.getParameter(ext.GPU_DISJOINT_EXT) === true) {
          disjointSeen = true;
          clear();
        }
        if (!disjointSeen) {
          for (let i = 0; i < pending.length;) {
            const item = pending[i];
            if (gl.getQueryParameter(item.query, 0x8867) !== true) {
              i++;
              continue;
            }
            const nanos: unknown = gl.getQueryParameter(item.query, 0x8866);
            if (typeof nanos === 'number' && Number.isFinite(nanos) && nanos >= 0)
              samples.push({ frameId: item.frameId, elapsedMs: nanos / 1e6 });
            remove(item.query);
            pending.splice(i, 1);
          }
        }
      } catch {
        disjointSeen = true;
        clear();
      }
      return { samples, disjoint: disjointSeen, pending: pending.length + (active ? 1 : 0) };
    },
    dispose() {
      if (!disposed) {
        clear();
        disposed = true;
      }
    },
  };
}
