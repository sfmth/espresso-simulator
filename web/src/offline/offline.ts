// SPDX-License-Identifier: GPL-2.0-or-later
/** Page-lifetime offline installation state; updates require an explicit local action. */
export interface OfflineSnapshot {
  phase: 'disabled' | 'checking' | 'installing' | 'ready' | 'unavailable';
  online: boolean;
  saved: boolean;
  action: 'enable' | 'update' | null;
  updating: boolean;
  error: string | null;
}
export interface OfflineClient {
  getSnapshot: () => OfflineSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  reloadToUseSavedCopy: () => void;
  dispose: () => void;
}
interface WorkerStatus {
  type: 'OFFLINE_STATUS';
  buildId: string;
  ready: boolean;
  assetCount: number;
}
export interface OfflineEnvironment {
  enabled: boolean;
  pageUrl: string;
  baseUrl: string;
  expectedBuildId: string | null;
  serviceWorker: ServiceWorkerContainer | null;
  events: EventTarget;
  isOnline(): boolean;
  reload(): void;
  createChannel?(): MessageChannel;
  statusTimeoutMs?: number;
  activationTimeoutMs?: number;
}

/** Resolving the build base against the document works at /, /app/, index.html and hashes. */
export function offlineUrls(pageUrl: string, baseUrl: string) {
  const page = new URL(pageUrl);
  const base = new URL(baseUrl, page);
  if (base.origin !== page.origin || !['http:', 'https:'].includes(base.protocol))
    throw new Error('Offline installation requires a same-origin web address.');
  base.hash = '';
  base.search = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return { script: new URL('sw.js', base).href, scope: base.href };
}

function validStatus(value: unknown): value is WorkerStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WorkerStatus>;
  return (
    v.type === 'OFFLINE_STATUS' &&
    typeof v.buildId === 'string' &&
    v.buildId.length > 0 &&
    v.buildId.length <= 256 &&
    typeof v.ready === 'boolean' &&
    Number.isSafeInteger(v.assetCount) &&
    (v.assetCount ?? -1) >= 0 &&
    (!v.ready || (v.assetCount ?? 0) > 0)
  );
}

export function createOfflineClient(env: OfflineEnvironment): OfflineClient {
  let state: OfflineSnapshot = {
    phase: env.enabled ? 'checking' : 'disabled',
    online: env.isOnline(),
    saved: false,
    action: null,
    updating: false,
    error: null,
  };
  const subscribers = new Set<() => void>();
  const workerListeners = new Map<ServiceWorker, () => void>();
  const pendingQueries = new Set<() => void>();
  let started = false,
    disposed = false,
    registering = false,
    generation = 0;
  let registration: ServiceWorkerRegistration | null = null;
  let actionWorker: { worker: ServiceWorker; buildId: string } | null = null;
  let requestedBuildId: string | null = null,
    reloaded = false;
  let activationTimer: ReturnType<typeof setTimeout> | null = null;
  const sw = env.serviceWorker;
  const set = (patch: Partial<OfflineSnapshot>) => {
    if (disposed) return;
    const next = { ...state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    subscribers.forEach((listener) => listener());
  };
  const clearActivationTimer = () => {
    if (activationTimer !== null) clearTimeout(activationTimer);
    activationTimer = null;
  };
  const reload = () => {
    if (disposed || reloaded) return;
    reloaded = true;
    clearActivationTimer();
    env.reload();
  };
  const query = (worker: ServiceWorker): Promise<WorkerStatus> =>
    new Promise((resolve, reject) => {
      let channel: MessageChannel;
      try {
        channel = (env.createChannel ?? (() => new MessageChannel()))();
      } catch {
        reject(new Error('Offline status messaging is unavailable.'));
        return;
      }
      let finished = false;
      const close = () => {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        pendingQueries.delete(cancel);
      };
      const fail = () => {
        if (finished) return;
        finished = true;
        close();
        reject(new Error('The offline copy could not be confirmed.'));
      };
      const cancel = () => fail();
      const timer = setTimeout(fail, env.statusTimeoutMs ?? 5000);
      pendingQueries.add(cancel);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        if (finished) return;
        if (!validStatus(event.data)) {
          fail();
          return;
        }
        finished = true;
        close();
        resolve(event.data);
      };
      try {
        worker.postMessage({ type: 'GET_STATUS' }, [channel.port2]);
      } catch {
        fail();
      }
    });
  const refresh = async () => {
    if (disposed || !started || !sw) return;
    const revision = ++generation;
    const controller = sw.controller,
      active = registration?.active ?? null;
    const waiting = registration?.waiting ?? null;
    for (const worker of [active, waiting, registration?.installing]) if (worker) watch(worker);
    const unique = [
      ...new Set([controller, active, waiting].filter((v): v is ServiceWorker => v !== null)),
    ];
    const responses = await Promise.all(
      unique.map(async (worker) => {
        try {
          return { worker, status: await query(worker) };
        } catch {
          return { worker, status: null };
        }
      }),
    );
    if (disposed || revision !== generation) return;
    if (
      controller !== sw.controller ||
      active !== (registration?.active ?? null) ||
      waiting !== (registration?.waiting ?? null)
    ) {
      void refresh();
      return;
    }
    const statusFor = (worker: ServiceWorker | null) =>
      responses.find((r) => r.worker === worker)?.status;
    const controllerStatus = statusFor(controller),
      activeStatus = statusFor(active);
    const waitingStatus = statusFor(waiting);
    const ready =
      controllerStatus?.ready === true && controllerStatus.buildId === env.expectedBuildId;
    const saved =
      ready ||
      (!controller && activeStatus?.ready === true && activeStatus.buildId === env.expectedBuildId);
    actionWorker =
      waiting && waitingStatus?.ready
        ? { worker: waiting, buildId: waitingStatus.buildId }
        : controller && controllerStatus?.ready && controllerStatus.buildId !== env.expectedBuildId
          ? { worker: controller, buildId: controllerStatus.buildId }
          : !controller &&
              active &&
              activeStatus?.ready &&
              activeStatus.buildId === env.expectedBuildId
            ? { worker: active, buildId: activeStatus.buildId }
            : null;
    if (
      requestedBuildId &&
      ((controllerStatus?.ready && controllerStatus.buildId === requestedBuildId) ||
        (active?.state === 'activated' &&
          activeStatus?.ready &&
          activeStatus.buildId === requestedBuildId))
    ) {
      reload();
      return;
    }
    const installing = registration?.installing && registration.installing.state !== 'redundant';
    set({
      phase: ready ? 'ready' : installing ? 'installing' : 'unavailable',
      saved,
      action: actionWorker ? (saved && !controller && !waiting ? 'enable' : 'update') : null,
      error: responses.some((r) => r.status === null)
        ? 'The offline copy could not be confirmed. You can keep using the app while connected.'
        : ready || saved || actionWorker
          ? null
          : state.error,
    });
  };
  const watch = (worker: ServiceWorker) => {
    if (workerListeners.has(worker)) return;
    const listener = () => {
      if (worker.state === 'redundant')
        set({ error: 'Offline saving failed. You can keep using the app while connected.' });
      void refresh();
    };
    workerListeners.set(worker, listener);
    worker.addEventListener('statechange', listener);
  };
  const updateFound = () => {
    const installing = registration?.installing;
    if (installing) {
      watch(installing);
      if (state.phase !== 'ready') set({ phase: 'installing' });
    }
    void refresh();
  };
  const register = async () => {
    if (disposed || registering || registration || !sw || !env.expectedBuildId) return;
    registering = true;
    try {
      const urls = offlineUrls(env.pageUrl, env.baseUrl);
      const registered = await sw.register(urls.script, {
        scope: urls.scope,
        updateViaCache: 'none',
      });
      if (disposed) return;
      registration = registered;
      registration.addEventListener('updatefound', updateFound);
      updateFound();
    } catch {
      set({
        phase: state.phase === 'ready' ? 'ready' : 'unavailable',
        error: 'Offline saving failed. You can keep using the app while connected.',
      });
    } finally {
      registering = false;
    }
  };
  const connection = () => {
    set({ online: env.isOnline() });
    if (!registration && env.isOnline()) void register();
    void refresh();
  };
  const controllerChanged = () => {
    void refresh();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    start() {
      if (started || disposed) return;
      started = true;
      if (!env.enabled) return;
      env.events.addEventListener('online', connection);
      env.events.addEventListener('offline', connection);
      if (!sw || !env.expectedBuildId) {
        set({
          phase: 'unavailable',
          error: 'Offline use is unavailable in this browser or app build.',
        });
        return;
      }
      sw.addEventListener('controllerchange', controllerChanged);
      void register();
    },
    reloadToUseSavedCopy() {
      if (disposed || state.updating || !actionWorker) return;
      const target = actionWorker;
      if (target.worker.state === 'activated') {
        reload();
        return;
      }
      requestedBuildId = target.buildId;
      set({ updating: true, error: null });
      clearActivationTimer();
      activationTimer = setTimeout(() => {
        requestedBuildId = null;
        set({
          updating: false,
          error: 'The update could not be loaded. Your current session can continue.',
        });
      }, env.activationTimeoutMs ?? 20000);
      try {
        target.worker.postMessage({ type: 'ACTIVATE_UPDATE' });
      } catch {
        clearActivationTimer();
        requestedBuildId = null;
        set({
          updating: false,
          error: 'The update could not be loaded. Your current session can continue.',
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearActivationTimer();
      env.events.removeEventListener('online', connection);
      env.events.removeEventListener('offline', connection);
      sw?.removeEventListener('controllerchange', controllerChanged);
      registration?.removeEventListener('updatefound', updateFound);
      workerListeners.forEach((listener, worker) =>
        worker.removeEventListener('statechange', listener),
      );
      workerListeners.clear();
      pendingQueries.forEach((cancel) => cancel());
      subscribers.clear();
    },
  };
}

let browserClient: OfflineClient | undefined;
export function getOfflineClient(): OfflineClient {
  if (browserClient) return browserClient;
  let serviceWorker: ServiceWorkerContainer | null = null;
  try {
    serviceWorker = navigator.serviceWorker ?? null;
  } catch {
    /* restricted browser */
  }
  browserClient = createOfflineClient({
    enabled: import.meta.env.PROD,
    pageUrl: location.href,
    baseUrl: import.meta.env.BASE_URL,
    expectedBuildId:
      document.querySelector<HTMLMetaElement>('meta[name="puckworks-build-id"]')?.content ?? null,
    serviceWorker,
    events: window,
    isOnline: () => navigator.onLine,
    reload: () => location.reload(),
  });
  return browserClient;
}
