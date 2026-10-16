// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Promise-based client for the engine worker(s).
 *
 * Shape of the client:
 * - Requests wait in one FIFO queue. Each worker ("slot") takes the next request
 *   when it is idle and holds at most one request at a time.
 * - The app uses two workers (`getEngine`), so a long run (a Tier 1 shot or a
 *   sweep point) never holds up the live preview. Each worker loads its own
 *   WebAssembly instance, once.
 * - No SharedArrayBuffer: GitHub Pages cannot send the COOP/COEP headers it
 *   needs (docs/PLAN.md D14). Results move between threads as transferables.
 *
 * Cancellation: aborting a queued request drops it. Aborting a request that a
 * worker is running terminates that worker, because WebAssembly cannot be
 * interrupted; the next request starts a fresh worker. A worker is also
 * replaced when it reports `recycle` (its memory grew large) or a trap or a
 * failed load.
 */
import type {
  EngineErrorKind,
  EngineMethod,
  EngineMethods,
  EngineRequest,
  EngineResponse,
} from './protocol';
import type { RecipeRunData, ShotRunData, SweepPointData } from './shotData';
import type { BuiltSpec, Catalog, Recipe, ShotSpec } from './shotTypes';
import type { SphereReleaseParams, SphereRunData } from './types';

/** A result and the time the worker spent producing it, in milliseconds. */
export interface Timed<T> {
  result: T;
  runtimeMs: number;
}

export interface CallOptions {
  /** Aborting rejects the call with the signal's reason (an AbortError by default). */
  signal?: AbortSignal;
}

/** What the UI needs from the engine. Implemented by `EngineClient`; tests use fakes. */
export interface Engine {
  coreVersion(options?: CallOptions): Promise<Timed<string>>;
  /**
   * Runs the sphere case. Long time series come back thinned (`SphereRunData`).
   * Rejects with an `EngineError` of kind `invalid-params` for parameters outside the contract.
   */
  simulateSphereRelease(
    params: SphereReleaseParams,
    options?: CallOptions,
  ): Promise<Timed<SphereRunData>>;
  /** The presets, the parameter registry and the core version (M1). */
  catalog(options?: CallOptions): Promise<Timed<Catalog>>;
  /**
   * Builds the physical spec of a recipe. Rejects with an `EngineError` of kind
   * `invalid-params` carrying the builder's message for a recipe it cannot build.
   */
  buildShotSpec(recipe: Recipe, options?: CallOptions): Promise<Timed<BuiltSpec>>;
  /** Builds and simulates a recipe; errors as for `buildShotSpec`. */
  simulateRecipe(recipe: Recipe, options?: CallOptions): Promise<Timed<RecipeRunData>>;
  /** Simulates a physical spec. */
  simulateShot(spec: ShotSpec, options?: CallOptions): Promise<Timed<ShotRunData>>;
  /** Builds and simulates a recipe, returning only its scalar outputs (sweeps). */
  sweepPoint(recipe: Recipe, options?: CallOptions): Promise<Timed<SweepPointData>>;
  /** Stops every worker and rejects all outstanding calls. */
  terminate(): void;
}

/** Why a call failed: a kind reported by the worker, or a failure on the client side. */
export type EngineErrorKindOrClient = EngineErrorKind | 'worker' | 'terminated' | 'unsupported';

export class EngineError extends Error {
  override name = 'EngineError';
  readonly kind: EngineErrorKindOrClient;
  /** For a trap: the core's panic message, for bug reports. */
  readonly detail?: string;

  constructor(
    kind: EngineErrorKindOrClient,
    message: string,
    options?: ErrorOptions & { detail?: string },
  ) {
    super(message, options);
    this.kind = kind;
    if (options?.detail) this.detail = options.detail;
  }
}

/** True for the rejection of an aborted call. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** The parts of a `Worker` the client uses. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: EngineRequest): void;
  terminate(): void;
}

export interface EngineClientOptions {
  /** Number of workers. Default 1. */
  size?: number;
  /** Creates a worker; tests pass a fake. */
  createWorker?: () => WorkerLike;
}

/** Starts the real engine worker (bundled by Vite as an ES-module worker). */
export function createEngineWorker(): WorkerLike {
  if (typeof Worker === 'undefined') {
    throw new EngineError('unsupported', 'This browser cannot run Web Workers.');
  }
  return new Worker(new URL('./engine.worker.ts', import.meta.url), {
    type: 'module',
    name: 'puckworks-engine',
  });
}

interface Job {
  request: EngineRequest;
  resolve: (value: Timed<unknown>) => void;
  reject: (reason: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface Slot {
  worker: WorkerLike | null;
  job: Job | null;
}

export class EngineClient implements Engine {
  readonly #createWorker: () => WorkerLike;
  readonly #slots: Slot[];
  readonly #queue: Job[] = [];
  #nextId = 1;
  #terminated = false;

  constructor({ size = 1, createWorker = createEngineWorker }: EngineClientOptions = {}) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError('size must be a positive integer');
    }
    this.#createWorker = createWorker;
    this.#slots = Array.from({ length: size }, () => ({ worker: null, job: null }));
  }

  coreVersion(options?: CallOptions): Promise<Timed<string>> {
    return this.#call('coreVersion', null, options);
  }

  simulateSphereRelease(
    params: SphereReleaseParams,
    options?: CallOptions,
  ): Promise<Timed<SphereRunData>> {
    return this.#call('simulateSphereRelease', params, options);
  }

  catalog(options?: CallOptions): Promise<Timed<Catalog>> {
    return this.#call('catalog', null, options);
  }

  buildShotSpec(recipe: Recipe, options?: CallOptions): Promise<Timed<BuiltSpec>> {
    return this.#call('buildShotSpec', { recipe }, options);
  }

  simulateRecipe(recipe: Recipe, options?: CallOptions): Promise<Timed<RecipeRunData>> {
    return this.#call('simulateRecipe', { recipe }, options);
  }

  simulateShot(spec: ShotSpec, options?: CallOptions): Promise<Timed<ShotRunData>> {
    return this.#call('simulateShot', { spec }, options);
  }

  sweepPoint(recipe: Recipe, options?: CallOptions): Promise<Timed<SweepPointData>> {
    return this.#call('sweepPoint', { recipe }, options);
  }

  terminate(): void {
    this.#terminated = true;
    const error = new EngineError('terminated', 'The engine was shut down.');
    for (const slot of this.#slots) {
      const job = slot.job;
      slot.job = null;
      this.#stopWorker(slot);
      if (job) this.#reject(job, error);
    }
    for (const job of this.#queue.splice(0)) this.#reject(job, error);
  }

  #call<M extends EngineMethod>(
    method: M,
    params: EngineMethods[M]['params'],
    { signal }: CallOptions = {},
  ): Promise<Timed<EngineMethods[M]['result']>> {
    if (this.#terminated) {
      return Promise.reject(new EngineError('terminated', 'The engine was shut down.'));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<Timed<EngineMethods[M]['result']>>((resolve, reject) => {
      const job: Job = {
        request: { id: this.#nextId++, method, params } as EngineRequest,
        resolve: resolve as Job['resolve'],
        reject,
        signal,
        onAbort: undefined,
      };
      if (signal) {
        job.onAbort = () => this.#abort(job);
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.#queue.push(job);
      this.#pump();
    });
  }

  /** Hands queued requests to idle workers. */
  #pump(): void {
    while (this.#queue.length > 0) {
      const slot = this.#slots.find((s) => s.job === null);
      if (!slot) return;
      const job = this.#queue.shift() as Job;
      try {
        const worker = this.#ensureWorker(slot);
        slot.job = job;
        worker.postMessage(job.request);
      } catch (error) {
        slot.job = null;
        this.#reject(
          job,
          error instanceof EngineError
            ? error
            : new EngineError('worker', `Could not start the engine: ${messageOf(error)}`, {
                cause: error,
              }),
        );
      }
    }
  }

  #ensureWorker(slot: Slot): WorkerLike {
    if (slot.worker) return slot.worker;
    const worker = this.#createWorker();
    worker.onmessage = (event) => this.#onMessage(slot, worker, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.#onWorkerFailure(
        slot,
        worker,
        `The engine worker failed: ${event.message || 'unknown error'}`,
      );
    };
    worker.onmessageerror = () =>
      this.#onWorkerFailure(slot, worker, 'A message from the engine worker could not be read.');
    slot.worker = worker;
    return worker;
  }

  #onMessage(slot: Slot, worker: WorkerLike, data: unknown): void {
    if (slot.worker !== worker) return; // from a worker that has been replaced
    const job = slot.job;
    if (!job) return;
    if (!isResponse(data) || data.id !== job.request.id) {
      this.#onWorkerFailure(slot, worker, 'The engine worker sent an unexpected message.');
      return;
    }
    slot.job = null;
    if (data.ok) {
      // WebAssembly memory never shrinks: replace a worker that grew large.
      if (data.recycle) this.#stopWorker(slot);
      this.#finish(job);
      job.resolve({ result: data.result, runtimeMs: data.runtimeMs });
    } else {
      // After a trap or a failed load the instance cannot be trusted: replace it.
      if (data.error.kind === 'runtime' || data.error.kind === 'init') this.#stopWorker(slot);
      this.#reject(
        job,
        new EngineError(data.error.kind, data.error.message, { detail: data.error.panic }),
      );
    }
    this.#pump();
  }

  #onWorkerFailure(slot: Slot, worker: WorkerLike, message: string): void {
    if (slot.worker !== worker) return;
    this.#stopWorker(slot);
    const job = slot.job;
    slot.job = null;
    if (job) this.#reject(job, new EngineError('worker', message));
    this.#pump();
  }

  #abort(job: Job): void {
    const reason = abortReason(job.signal);
    const queued = this.#queue.indexOf(job);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      this.#reject(job, reason);
      return;
    }
    const slot = this.#slots.find((s) => s.job === job);
    if (!slot) return; // already settled
    this.#stopWorker(slot);
    slot.job = null;
    this.#reject(job, reason);
    this.#pump();
  }

  #stopWorker(slot: Slot): void {
    const worker = slot.worker;
    if (!worker) return;
    slot.worker = null;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  #reject(job: Job, reason: Error): void {
    this.#finish(job);
    job.reject(reason);
  }

  #finish(job: Job): void {
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
  }
}

let shared: Engine | null = null;

/** Workers of the app-wide engine: one can run a long shot or sweep while the other previews. */
export const APP_ENGINE_WORKERS = 2;

/** The app-wide engine. Workers start on the first call, not here. */
export function getEngine(): Engine {
  shared ??= new EngineClient({ size: APP_ENGINE_WORKERS });
  return shared;
}

/** The signal's reason if it is an Error (by default an AbortError), else a new AbortError. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function isResponse(data: unknown): data is EngineResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { id?: unknown }).id === 'number' &&
    typeof (data as { ok?: unknown }).ok === 'boolean'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
