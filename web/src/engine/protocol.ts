// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Message protocol between the main thread (engine.ts) and an engine worker
 * (engine.worker.ts). Everything here is plain functions and data, so it is
 * unit-tested without a real Worker.
 *
 * - The main thread posts an `EngineRequest`; the client keeps at most one
 *   request in flight per worker.
 * - The worker answers with an `EngineResponse` carrying the same `id`.
 *   A `simulateSphereRelease` result is thinned to at most a few thousand
 *   points per time series (decimate.ts) and its Float64Arrays move to the
 *   main thread as transferables (no copy).
 * - `recycle: true` on a response asks the client to replace the worker,
 *   because its WebAssembly memory grew past `RECYCLE_MEMORY_BYTES` and will
 *   never shrink.
 * - Errors never escape as exceptions: they come back as `EngineFailure`
 *   messages. `runtimeMs` is the time the worker spent on the request: the
 *   solve, reading the result out of WebAssembly memory and thinning it.
 * - Shot calls (M1) send plain recipe and spec objects; the worker writes them
 *   as JSON for the core and parses the core's JSON answer. `catalog` returns
 *   the presets and the parameter registry once per page. Shot results come
 *   back with Float64Array series, transferred (shotData.ts); `sweepPoint`
 *   returns only a run's scalar outputs, for sweeps of many runs.
 */
import { thinSphereResult } from './decimate';
import { RECYCLE_MEMORY_BYTES } from './memory';
import type { TasteEstimate, UncertaintyOptions, UncertaintyResult } from './m3Types';
import {
  shotTransferables,
  toShotRunData,
  type RecipeRunData,
  type ShotRunData,
  type SweepPointData,
} from './shotData';
import type { BuiltSpec, Catalog, Recipe, ShotSpec } from './shotTypes';
import {
  checkSphereParams,
  type PuckcoreModule,
  type SphereReleaseData,
  type SphereReleaseParams,
  type SphereRunData,
} from './types';

/** The engine's methods, with their parameters and results. */
export interface EngineMethods {
  coreVersion: { params: null; result: string };
  simulateSphereRelease: { params: SphereReleaseParams; result: SphereRunData };
  /** Presets, registry and core version (M1). */
  catalog: { params: null; result: Catalog };
  /** Recipe → `{spec, derived}`. */
  buildShotSpec: { params: { recipe: Recipe }; result: BuiltSpec };
  /** Recipe → build and result. */
  simulateRecipe: { params: { recipe: Recipe }; result: RecipeRunData };
  /** ShotSpec → result. */
  simulateShot: { params: { spec: ShotSpec }; result: ShotRunData };
  /** Recipe → the result's summary and diagnostics only (one point of a sweep). */
  sweepPoint: { params: { recipe: Recipe }; result: SweepPointData };
  /** Input-scenario ensemble, always Tier 0; independent of the central shot. */
  simulateUncertainty: {
    params: { recipe: Recipe; options: UncertaintyOptions };
    result: UncertaintyResult;
  };
}

export type EngineMethod = keyof EngineMethods;

export const ENGINE_METHODS: readonly EngineMethod[] = [
  'coreVersion',
  'simulateSphereRelease',
  'catalog',
  'buildShotSpec',
  'simulateRecipe',
  'simulateShot',
  'sweepPoint',
  'simulateUncertainty',
];

/** Methods whose params carry a recipe object. */
const RECIPE_METHODS: readonly EngineMethod[] = ['buildShotSpec', 'simulateRecipe', 'sweepPoint'];

/**
 * The core returned something that is not the JSON document the contract
 * promises. That is a bug in the core, reported as a `runtime` failure.
 */
export class CoreOutputError extends Error {
  override name = 'CoreOutputError';
}

/** Parses a JSON document returned by the core. */
export function parseCoreOutput<T>(text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CoreOutputError(`${what} returned invalid JSON: ${errorMessage(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CoreOutputError(`${what} did not return a JSON object`);
  }
  return value as T;
}

export type EngineRequest = {
  [M in EngineMethod]: { id: number; method: M; params: EngineMethods[M]['params'] };
}[EngineMethod];

export type EngineSuccess = {
  [M in EngineMethod]: {
    id: number;
    method: M;
    ok: true;
    result: EngineMethods[M]['result'];
    runtimeMs: number;
    /** The worker should be replaced after this response (its memory is large). */
    recycle?: boolean;
  };
}[EngineMethod];

/**
 * Where a failure came from:
 * - `invalid-request`: the message does not follow this protocol;
 * - `invalid-params`: the parameters break the binding contract (checked here
 *   or rejected by the core);
 * - `init`: loading or instantiating the WebAssembly module failed;
 * - `runtime`: the core trapped. That is a bug, and the client replaces the worker.
 */
export type EngineErrorKind = 'invalid-request' | 'invalid-params' | 'init' | 'runtime';

export interface EngineErrorInfo {
  kind: EngineErrorKind;
  name: string;
  message: string;
  /** For a trap: the Rust panic message the core recorded, for bug reports. */
  panic?: string;
}

export interface EngineFailure {
  /** The request's id, or -1 if it had none. */
  id: number;
  method: string;
  ok: false;
  error: EngineErrorInfo;
  runtimeMs: number;
}

export type EngineResponse = EngineSuccess | EngineFailure;

/** A response and the buffers to transfer with it. */
export interface HandledRequest {
  response: EngineResponse;
  transfer: Transferable[];
}

export interface HandlerOptions {
  /** Clock in milliseconds (default `performance.now`). */
  now?: () => number;
  /** Current size of the WebAssembly memory in bytes (default: unknown, never recycle). */
  memoryBytes?: () => number;
}

const defaultNow = () => performance.now();

/** Handles one request against an initialised core. Never throws. */
export function handleRequest(
  core: PuckcoreModule,
  message: unknown,
  { now = defaultNow, memoryBytes = () => 0 }: HandlerOptions = {},
): HandledRequest {
  const start = now();
  const fail = (id: number, method: string, kind: EngineErrorKind, error: unknown) =>
    failure(id, method, kind, errorName(error), errorMessage(error), now() - start);

  const parsed = parseRequest(message);
  if (!parsed.ok) {
    return failure(
      parsed.id,
      parsed.method,
      'invalid-request',
      'ProtocolError',
      parsed.message,
      now() - start,
    );
  }
  const request = parsed.request;
  try {
    switch (request.method) {
      case 'coreVersion': {
        const response: EngineSuccess = {
          id: request.id,
          method: request.method,
          ok: true,
          result: core.coreVersion(),
          runtimeMs: now() - start,
        };
        return { response, transfer: [] };
      }
      case 'simulateSphereRelease': {
        const p = request.params;
        const problem = checkSphereParams(p);
        if (problem !== null) {
          return failure(
            request.id,
            request.method,
            'invalid-params',
            'RangeError',
            problem,
            now() - start,
          );
        }
        const handle = core.simulateSphereRelease(
          p.radiusM,
          p.diffusivityM2S,
          p.nShells,
          p.tEndS,
          p.nSteps,
          p.grid,
          p.scheme,
        );
        let full: SphereReleaseData;
        try {
          // Each getter returns a fresh copy out of WebAssembly memory.
          full = {
            times: handle.times,
            releasedFraction: handle.releasedFraction,
            analyticFraction: handle.analyticFraction,
            shellOuterRadii: handle.shellOuterRadii,
            finalProfile: handle.finalProfile,
            maxAbsError: handle.maxAbsError,
            massBalanceError: handle.massBalanceError,
          };
        } finally {
          handle.free();
        }
        const result = thinSphereResult(full);
        const response: EngineSuccess = {
          id: request.id,
          method: request.method,
          ok: true,
          result,
          runtimeMs: now() - start,
          ...(memoryBytes() > RECYCLE_MEMORY_BYTES ? { recycle: true } : {}),
        };
        return { response, transfer: transferablesOf(result) };
      }
      case 'catalog': {
        const result: Catalog = {
          coreVersion: core.coreVersion(),
          presets: parseCoreOutput(core.presets(), 'presets()'),
          registry: parseCoreOutput(core.registry(), 'registry()'),
        };
        return success(request.id, request.method, result, []);
      }
      case 'buildShotSpec': {
        const text = core.buildShotSpec(JSON.stringify(request.params.recipe));
        const result = parseCoreOutput<BuiltSpec>(text, 'buildShotSpec');
        return success(request.id, request.method, result, []);
      }
      case 'simulateRecipe': {
        const json = JSON.stringify(request.params.recipe);
        const coreStart = now();
        const text = core.simulateRecipe(json);
        const coreMs = now() - coreStart;
        const run = parseCoreOutput<{ build: BuiltSpec; result: unknown; taste?: TasteEstimate }>(
          text,
          'simulateRecipe',
        );
        const data = toShotRunData(run.result, coreMs);
        const result: RecipeRunData = { build: run.build, ...data, taste: run.taste };
        return success(request.id, request.method, result, shotTransferables(data.result));
      }
      case 'simulateShot': {
        const json = JSON.stringify(request.params.spec);
        const coreStart = now();
        const text = core.simulateShot(json);
        const coreMs = now() - coreStart;
        const result = toShotRunData(parseCoreOutput(text, 'simulateShot'), coreMs);
        return success(request.id, request.method, result, shotTransferables(result.result));
      }
      case 'sweepPoint': {
        const json = JSON.stringify(request.params.recipe);
        const coreStart = now();
        const text = core.simulateRecipe(json);
        const coreMs = now() - coreStart;
        const run = parseCoreOutput<{ result: SweepPointData }>(text, 'simulateRecipe');
        const result: SweepPointData = {
          summary: run.result.summary,
          diagnostics: run.result.diagnostics,
          coreMs,
        };
        return success(request.id, request.method, result, []);
      }
      case 'simulateUncertainty': {
        const text = core.simulateUncertainty(
          JSON.stringify(request.params.recipe),
          JSON.stringify(request.params.options),
        );
        const result = parseCoreOutput<UncertaintyResult>(text, 'simulateUncertainty');
        return success(request.id, request.method, result, []);
      }
    }
  } catch (error) {
    // The core throws an Error for invalid input; a trap is a WebAssembly.RuntimeError,
    // and output that breaks the contract is a CoreOutputError: both are bugs.
    if (error instanceof WebAssembly.RuntimeError) {
      const handled = fail(request.id, request.method, 'runtime', error);
      const panic = readPanic(core);
      if (panic && !handled.response.ok) handled.response.error.panic = panic;
      return handled;
    }
    const kind = error instanceof CoreOutputError ? 'runtime' : 'invalid-params';
    return fail(request.id, request.method, kind, error);
  }

  function success<M extends EngineMethod>(
    id: number,
    method: M,
    result: EngineMethods[M]['result'],
    transfer: Transferable[],
  ): HandledRequest {
    const response = {
      id,
      method,
      ok: true,
      result,
      runtimeMs: now() - start,
      ...(memoryBytes() > RECYCLE_MEMORY_BYTES ? { recycle: true } : {}),
    } as EngineSuccess;
    return { response, transfer };
  }
}

/** The core's last panic message after a trap, if the core records one. */
function readPanic(core: PuckcoreModule): string | undefined {
  try {
    const message = core.lastPanic?.();
    return message ? message : undefined;
  } catch {
    return undefined; // the instance may be too broken even for that
  }
}

/** A failure response for a request that could not be handled at all (e.g. init failed). */
export function failureFor(
  message: unknown,
  kind: EngineErrorKind,
  error: unknown,
  runtimeMs = 0,
): EngineFailure {
  const { id, method } = peekIdAndMethod(message);
  return {
    id,
    method,
    ok: false,
    error: { kind, name: errorName(error), message: errorMessage(error) },
    runtimeMs,
  };
}

/** The distinct, non-shared buffers behind a result's arrays. */
export function transferablesOf(result: SphereReleaseData): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const array of [
    result.times,
    result.releasedFraction,
    result.analyticFraction,
    result.shellOuterRadii,
    result.finalProfile,
  ]) {
    if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
  }
  return [...buffers];
}

type ParsedRequest =
  { ok: true; request: EngineRequest } | { ok: false; id: number; method: string; message: string };

/** Validates the shape of an incoming message (types only; ranges are checked later). */
export function parseRequest(message: unknown): ParsedRequest {
  const { id, method } = peekIdAndMethod(message);
  const bad = (why: string): ParsedRequest => ({ ok: false, id, method, message: why });
  if (!isRecord(message)) return bad('request must be an object');
  if (id < 0) return bad('request id must be a non-negative integer');
  if (!(ENGINE_METHODS as readonly string[]).includes(method)) {
    return bad(`unknown method "${method}"`);
  }
  if (method === 'coreVersion' || method === 'catalog') {
    return { ok: true, request: { id, method, params: null } };
  }
  const params = message.params;
  if (method === 'simulateUncertainty') {
    if (
      !isRecord(params) ||
      !isRecord(params.recipe) ||
      Array.isArray(params.recipe) ||
      !isRecord(params.options) ||
      Array.isArray(params.options)
    ) {
      return bad('simulateUncertainty needs params.recipe and params.options objects');
    }
    return {
      ok: true,
      request: {
        id,
        method,
        params: params as unknown as EngineMethods['simulateUncertainty']['params'],
      },
    };
  }
  if ((RECIPE_METHODS as readonly string[]).includes(method)) {
    if (!isRecord(params) || !isRecord(params.recipe) || Array.isArray(params.recipe)) {
      return bad(`${method} needs params.recipe, a recipe object`);
    }
    return {
      ok: true,
      request: {
        id,
        method,
        params: { recipe: params.recipe as unknown as Recipe },
      } as EngineRequest,
    };
  }
  if (method === 'simulateShot') {
    if (!isRecord(params) || !isRecord(params.spec) || Array.isArray(params.spec)) {
      return bad('simulateShot needs params.spec, a shot spec object');
    }
    return {
      ok: true,
      request: { id, method, params: { spec: params.spec as unknown as ShotSpec } },
    };
  }
  if (!isRecord(params)) return bad('simulateSphereRelease needs a params object');
  for (const key of ['radiusM', 'diffusivityM2S', 'nShells', 'tEndS', 'nSteps'] as const) {
    if (typeof params[key] !== 'number') return bad(`params.${key} must be a number`);
  }
  for (const key of ['grid', 'scheme'] as const) {
    if (typeof params[key] !== 'string') return bad(`params.${key} must be a string`);
  }
  return {
    ok: true,
    request: {
      id,
      method: 'simulateSphereRelease',
      params: params as unknown as SphereReleaseParams,
    },
  };
}

function peekIdAndMethod(message: unknown): { id: number; method: string } {
  if (!isRecord(message)) return { id: -1, method: 'unknown' };
  const id =
    Number.isSafeInteger(message.id) && (message.id as number) >= 0 ? (message.id as number) : -1;
  const method = typeof message.method === 'string' ? message.method : 'unknown';
  return { id, method };
}

function failure(
  id: number,
  method: string,
  kind: EngineErrorKind,
  name: string,
  message: string,
  runtimeMs: number,
): HandledRequest {
  const response: EngineFailure = {
    id,
    method,
    ok: false,
    error: { kind, name, message },
    runtimeMs,
  };
  return { response, transfer: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}
