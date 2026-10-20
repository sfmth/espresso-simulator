// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineClient, offlineUrls, type OfflineClient } from './offline';

class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer!: Port;
  closed = false;
  close() {
    this.closed = true;
  }
  postMessage(data: unknown) {
    queueMicrotask(() => this.peer.onmessage?.({ data }));
  }
}
function channel() {
  const a = new Port(),
    b = new Port();
  a.peer = b;
  b.peer = a;
  return { port1: a, port2: b } as unknown as MessageChannel;
}
class Worker extends EventTarget {
  state: ServiceWorkerState = 'activated';
  response: unknown;
  silent = false;
  failActivation = false;
  failStatus = false;
  ports: Port[] = [];
  messages: unknown[] = [];
  constructor(buildId = 'current', ready = true) {
    super();
    this.response = { type: 'OFFLINE_STATUS', buildId, ready, assetCount: ready ? 8 : 0 };
  }
  postMessage(message: unknown, ports?: Port[]) {
    this.messages.push(message);
    if ((message as { type: string }).type === 'ACTIVATE_UPDATE' && this.failActivation)
      throw new DOMException('blocked', 'SecurityError');
    if ((message as { type: string }).type === 'GET_STATUS' && this.failStatus)
      throw new DOMException('blocked', 'SecurityError');
    this.ports.push(...(ports ?? []));
    if ((message as { type: string }).type === 'GET_STATUS' && !this.silent)
      ports?.[0].postMessage(this.response);
  }
  change(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}
class Registration extends EventTarget {
  active: Worker | null = null;
  waiting: Worker | null = null;
  installing: Worker | null = null;
}
class Container extends EventTarget {
  controller: Worker | null = null;
  registration = new Registration();
  register = vi.fn(() =>
    Promise.resolve(this.registration as unknown as ServiceWorkerRegistration),
  );
  control(worker: Worker) {
    this.controller = worker;
    this.dispatchEvent(new Event('controllerchange'));
  }
}
const clients: OfflineClient[] = [];
function setup(
  overrides: { enabled?: boolean; supported?: boolean; buildId?: string | null } = {},
) {
  const sw = new Container(),
    events = new EventTarget(),
    reload = vi.fn();
  let online = true;
  const client = createOfflineClient({
    enabled: overrides.enabled ?? true,
    pageUrl: 'https://example.com/app/index.html?x=1#main',
    baseUrl: './',
    expectedBuildId: overrides.buildId === undefined ? 'current' : overrides.buildId,
    serviceWorker: overrides.supported === false ? null : (sw as unknown as ServiceWorkerContainer),
    events,
    isOnline: () => online,
    reload,
    createChannel: channel,
    statusTimeoutMs: 50,
    activationTimeoutMs: 100,
  });
  clients.push(client);
  return {
    client,
    sw,
    events,
    reload,
    connect(value: boolean) {
      online = value;
      events.dispatchEvent(new Event(value ? 'online' : 'offline'));
    },
  };
}
async function settle() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.useRealTimers();
});

describe('offline runtime', () => {
  it('rejects foreign bases without registering another origin', () => {
    expect(() => offlineUrls('https://example.com/app/', 'https://other.com/')).toThrow(
      'same-origin',
    );
  });

  it('ignores late status from a superseded controller', async () => {
    const f = setup(),
      old = new Worker(),
      next = new Worker('next');
    old.silent = true;
    f.sw.controller = old;
    f.sw.registration.active = old;
    f.client.start();
    await settle();
    f.sw.registration.active = next;
    f.sw.control(next);
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({ phase: 'unavailable', action: 'update' });
    old.ports.forEach((port) => port.postMessage(old.response));
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({ phase: 'unavailable', action: 'update' });
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('does not reload a requested update for an unrelated controller change', async () => {
    const f = setup(),
      old = new Worker(),
      next = new Worker('next'),
      other = new Worker('other');
    next.state = 'installed';
    f.sw.controller = old;
    f.sw.registration.active = old;
    f.sw.registration.waiting = next;
    f.client.start();
    await settle();
    f.client.reloadToUseSavedCopy();
    f.sw.registration.active = other;
    f.sw.control(other);
    await settle();
    expect(f.reload).not.toHaveBeenCalled();
    f.sw.registration.waiting = null;
    f.sw.registration.active = next;
    next.change('activated');
    await settle();
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it('keeps the session usable when worker messaging or activation is blocked', async () => {
    const f = setup(),
      old = new Worker(),
      next = new Worker('next');
    old.failStatus = true;
    f.sw.controller = old;
    f.sw.registration.active = old;
    f.client.start();
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({ phase: 'unavailable', saved: false });
    old.failStatus = false;
    next.state = 'installed';
    next.failActivation = true;
    f.sw.registration.waiting = next;
    f.sw.registration.dispatchEvent(new Event('updatefound'));
    await settle();
    f.client.reloadToUseSavedCopy();
    expect(f.client.getSnapshot()).toMatchObject({ updating: false, action: 'update' });
    expect(f.client.getSnapshot().error).toContain('could not be loaded');
    expect(f.reload).not.toHaveBeenCalled();
  });

  it.each([
    ['https://example.com/', './', 'https://example.com/'],
    ['https://example.com/app/', './', 'https://example.com/app/'],
    ['https://example.com/app/index.html?q=1#main', './', 'https://example.com/app/'],
    ['https://example.com/route#main', '/app/', 'https://example.com/app/'],
  ])('registers against the build base for %s', (page, base, scope) => {
    expect(offlineUrls(page, base)).toEqual({ script: `${scope}sw.js`, scope });
  });

  it('registers once with an uncached update script and does nothing in development', async () => {
    const dev = setup({ enabled: false });
    dev.client.start();
    expect(dev.sw.register).not.toHaveBeenCalled();
    expect(dev.client.getSnapshot().phase).toBe('disabled');
    const f = setup();
    f.client.start();
    f.client.start();
    await settle();
    expect(f.sw.register).toHaveBeenCalledExactlyOnceWith('https://example.com/app/sw.js', {
      scope: 'https://example.com/app/',
      updateViaCache: 'none',
    });
  });

  it('waits for complete install and the matching controlling release', async () => {
    const f = setup(),
      worker = new Worker('current', false);
    worker.state = 'installing';
    f.sw.registration.installing = worker;
    f.client.start();
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({ phase: 'installing', saved: false });
    worker.response = { type: 'OFFLINE_STATUS', buildId: 'current', ready: true, assetCount: 8 };
    f.sw.registration.installing = null;
    f.sw.registration.active = worker;
    worker.change('activated');
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      saved: true,
      action: 'enable',
    });
    expect(f.reload).not.toHaveBeenCalled();
    f.sw.control(worker);
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({ phase: 'ready', saved: true, action: null });
    expect(f.reload).not.toHaveBeenCalled();
    f.connect(false);
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({ phase: 'ready', online: false });
  });

  it('can explicitly reload an already activated copy when first-install claiming is unavailable', async () => {
    const f = setup();
    f.sw.registration.active = new Worker();
    f.client.start();
    await settle();
    f.client.reloadToUseSavedCopy();
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it('keeps a waiting update idle and reloads only after this page explicitly requests activation', async () => {
    const f = setup(),
      old = new Worker(),
      next = new Worker('next');
    next.state = 'installed';
    f.sw.controller = old;
    f.sw.registration.active = old;
    f.sw.registration.waiting = next;
    f.client.start();
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({
      phase: 'ready',
      action: 'update',
      updating: false,
    });
    expect(next.messages).not.toContainEqual({ type: 'ACTIVATE_UPDATE' });
    f.client.reloadToUseSavedCopy();
    expect(next.messages).toContainEqual({ type: 'ACTIVATE_UPDATE' });
    expect(f.reload).not.toHaveBeenCalled();
    f.sw.registration.waiting = null;
    f.sw.registration.active = next;
    next.change('activated');
    f.sw.control(next);
    await settle();
    expect(f.reload).toHaveBeenCalledOnce();
    f.sw.control(next);
    await settle();
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it('shows an update after another tab activates it, without reloading this page', async () => {
    const f = setup(),
      old = new Worker(),
      next = new Worker('next');
    f.sw.controller = old;
    f.sw.registration.active = old;
    f.client.start();
    await settle();
    f.sw.registration.active = next;
    f.sw.control(next);
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      saved: false,
      action: 'update',
    });
    expect(f.reload).not.toHaveBeenCalled();
    f.client.reloadToUseSavedCopy();
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it('does not claim ready for a different release or an incomplete/malformed cache response', async () => {
    const f = setup(),
      worker = new Worker('other');
    f.sw.controller = worker;
    f.sw.registration.active = worker;
    f.client.start();
    await settle();
    expect(f.client.getSnapshot().phase).toBe('unavailable');
    worker.response = { type: 'OFFLINE_STATUS', buildId: 'current', ready: true, assetCount: 0 };
    f.sw.control(worker);
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      saved: false,
      action: null,
    });
    expect(f.client.getSnapshot().error).toContain('could not be confirmed');
  });

  it('handles unsupported browsers, missing build metadata and quota/install failures without reload', async () => {
    for (const options of [{ supported: false }, { buildId: null }]) {
      const f = setup(options);
      f.client.start();
      expect(f.client.getSnapshot().phase).toBe('unavailable');
      f.connect(false);
      expect(f.client.getSnapshot().online).toBe(false);
    }
    const f = setup();
    f.sw.register.mockRejectedValueOnce(new DOMException('quota full', 'QuotaExceededError'));
    f.client.start();
    await settle();
    expect(f.client.getSnapshot().error).toContain('Offline saving failed');
    expect(f.reload).not.toHaveBeenCalled();
    f.connect(false);
    f.connect(true);
    await settle();
    expect(f.sw.register).toHaveBeenCalledTimes(2);
    const worker = new Worker();
    worker.state = 'installing';
    f.sw.registration.installing = worker;
    f.sw.registration.dispatchEvent(new Event('updatefound'));
    await settle();
    worker.change('redundant');
    await settle();
    expect(f.client.getSnapshot()).toMatchObject({ phase: 'unavailable', saved: false });
    expect(f.client.getSnapshot().error).toContain('Offline saving failed');
  });

  it('times out unavailable status and activation without hanging or fabricating readiness', async () => {
    vi.useFakeTimers();
    const f = setup(),
      old = new Worker(),
      next = new Worker('next');
    old.silent = true;
    f.sw.controller = old;
    f.sw.registration.active = old;
    f.client.start();
    await settle();
    await vi.advanceTimersByTimeAsync(51);
    expect(f.client.getSnapshot().phase).toBe('unavailable');
    old.silent = false;
    next.state = 'installed';
    f.sw.registration.waiting = next;
    f.sw.registration.dispatchEvent(new Event('updatefound'));
    await settle();
    f.client.reloadToUseSavedCopy();
    await vi.advanceTimersByTimeAsync(101);
    expect(f.client.getSnapshot()).toMatchObject({ updating: false, action: 'update' });
    expect(f.client.getSnapshot().error).toContain('could not be loaded');
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('disposes subscriptions/listeners/queries and ignores late registration completion', async () => {
    const f = setup(),
      changed = vi.fn();
    f.client.subscribe(changed);
    let resolve!: (registration: ServiceWorkerRegistration) => void;
    f.sw.register.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.client.start();
    f.client.dispose();
    resolve(f.sw.registration as unknown as ServiceWorkerRegistration);
    await settle();
    f.connect(false);
    f.sw.control(new Worker());
    await settle();
    expect(changed).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    const live = setup(),
      worker = new Worker();
    worker.silent = true;
    live.sw.registration.active = worker;
    live.client.start();
    await settle();
    live.client.dispose();
    await settle();
    expect(worker.ports.length).toBeGreaterThan(0);
    expect(worker.ports.every((port) => port.closed && port.peer.closed)).toBe(true);
    expect(live.reload).not.toHaveBeenCalled();
  });
});
