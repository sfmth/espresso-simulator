// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineRelease, writeOfflineBuild } from '../scripts/offline-build.mjs';

const SCOPE = 'https://puckworks.test/project/';
const prefix = `puckworks-offline:v1:${SCOPE}:`;
const urlOf = (path) => new URL(path, SCOPE).href;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temporary = [];

function fixtureFiles() {
  return new Map([
    [
      'index.html',
      '<!doctype html>\n<html><head><title>Puckworks</title></head><body>App A</body></html>',
    ],
    ['assets/index-aaaaaaaa.js', 'entry module'],
    ['assets/Explore-bbbbbbbb.js', 'unvisited lazy Explore module'],
    ['assets/engine.worker-cccccccc.js', 'engine worker'],
    ['assets/microstructure.worker-dddddddd.js', 'packing worker'],
    ['assets/puckcore-eeeeeeee.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ['assets/index-ffffffff.css', 'body { color: black; }'],
    ['third-party-licenses.md', 'Third-party notices'],
    ['manifest.webmanifest', '{"name":"Puckworks"}'],
    ['icons/puckworks-192.png', 'fixture icon bytes'],
    ['privacy.html', 'Privacy information'],
  ]);
}

function memoryStorage() {
  const entries = new Map();
  const storage = {
    entries,
    failPut: null,
    keys: async () => [...entries.keys()],
    delete: async (name) => entries.delete(name),
    async open(name) {
      if (!entries.has(name)) {
        const responses = new Map();
        entries.set(name, {
          responses,
          async match(request) {
            return responses.get(typeof request === 'string' ? request : request.url)?.clone();
          },
          async put(request, response) {
            const url = typeof request === 'string' ? request : request.url;
            if (storage.failPut && url.endsWith(storage.failPut)) throw new Error('Quota exceeded');
            responses.set(url, response.clone());
          },
        });
      }
      return entries.get(name);
    },
  };
  return storage;
}

function worker(files = fixtureFiles(), options = {}) {
  const release = createOfflineRelease(files);
  const served = new Map(files);
  served.set('index.html', release.indexHtml);
  served.set('offline-release.json', release.report);
  const listeners = new Map();
  const storage = options.storage ?? memoryStorage();
  const failures = new Map();
  const scope = options.scope ?? SCOPE;
  const network = vi.fn(async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    const path = url.slice(scope.length);
    if (failures.has(path)) {
      const failure = failures.get(path);
      if (failure instanceof Error) throw failure;
      return failure.clone();
    }
    return new Response(served.get(path) ?? 'Network only', {
      status: served.has(path) ? 200 : 404,
    });
  });
  const self = {
    registration: { scope, active: options.active ? {} : null },
    caches: storage,
    fetch: network,
    crypto: webcrypto,
    Request,
    Response,
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => options.windows ?? [{}]),
    },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  new Script(options.transformWorker?.(release.worker) ?? release.worker).runInNewContext({
    self,
    URL,
  });
  async function dispatch(type, properties = {}) {
    const waits = [];
    let response;
    listeners.get(type)({
      ...properties,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => {
        response = promise;
      },
    });
    await Promise.all(waits);
    return response;
  }
  async function message(type = 'GET_STATUS', extra = {}) {
    const replies = [];
    await dispatch('message', {
      data: { type, requestId: 'request-1', ...extra },
      ports: [{ postMessage: (reply) => replies.push(reply) }],
    });
    return replies[0];
  }
  return { release, served, storage, network, failures, self, dispatch, message };
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('offline release build', () => {
  it('includes every final app/public asset and changes identity for any changed byte or path', () => {
    const files = fixtureFiles();
    const release = createOfflineRelease(files);
    expect(release.assets.map((asset) => asset.path).sort()).toEqual(
      [...files.keys(), 'offline-release.json'].sort(),
    );
    expect(release.indexHtml).toContain(
      `<meta name="puckworks-build-id" content="${release.buildId}"`,
    );
    expect(release.assets.find((asset) => asset.path === 'index.html').sha256).toBe(
      hash(release.indexHtml),
    );
    expect(release.assets.find((asset) => asset.path === 'offline-release.json').sha256).toBe(
      hash(release.report),
    );
    expect(JSON.parse(release.report)).toMatchObject({
      schema: 'puckworks.offline-release/1',
      buildId: release.buildId,
    });
    expect(createOfflineRelease(new Map([...files].reverse())).worker).toBe(release.worker);
    for (const [path, bytes] of files) {
      const changed = new Map(files);
      changed.set(path, Buffer.concat([Buffer.from(bytes), Buffer.from(' changed')]));
      expect(createOfflineRelease(changed).buildId, path).not.toBe(release.buildId);
    }
    const renamed = new Map(files);
    renamed.set('privacy-renamed.html', renamed.get('privacy.html'));
    renamed.delete('privacy.html');
    expect(createOfflineRelease(renamed).buildId).not.toBe(release.buildId);
  });

  it('finalizes a directory idempotently, excluding its own generated files from identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'puckworks-offline-'));
    temporary.push(directory);
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), '<html>\n  <head>\n  </head>\n</html>');
    writeFileSync(join(directory, 'assets/entry-aaaaaaaa.js'), 'entry');
    const first = writeOfflineBuild(directory);
    const second = writeOfflineBuild(directory);
    expect(second).toEqual(first);
    expect(readFileSync(join(directory, 'sw.js'), 'utf8')).toBe(first.worker);
    expect((second.indexHtml.match(/puckworks-build-id/g) ?? []).length).toBe(1);
    expect(() => createOfflineRelease(new Map([['../index.html', 'bad']]))).toThrow();
    expect(() =>
      createOfflineRelease(
        new Map([
          ['index.html', '<head></head>'],
          ['assets/x?query.js', 'bad'],
        ]),
      ),
    ).toThrow(/Unsafe/);
  });

  it('emits the same worker and identity through Vite’s bundled config and direct finalization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puckworks-offline-vite-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'index.html'), '<html><head></head></html>');
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    );
    const plugin = loaded.config.plugins
      .flat()
      .find((candidate) => candidate?.name === 'puckworks:offline-build');
    plugin.configResolved({ root: directory, build: { outDir: '.' } });
    await plugin.closeBundle.handler();
    const bundled = readFileSync(join(directory, 'sw.js'), 'utf8');
    // Vitest itself also instruments function source. Compare against Node's
    // native loader, matching the finalizer used outside the test runner.
    const native = createRequire(import.meta.url)('../scripts/offline-build.mjs');
    expect(native.writeOfflineBuild(directory).worker).toBe(bundled);
  });

  it('changes identity for generator-only changes outside the emitted worker function', () => {
    const directory = mkdtempSync(join(tmpdir(), 'puckworks-offline-generator-'));
    temporary.push(directory);
    const source = readFileSync(new URL('../scripts/offline-build.mjs', import.meta.url), 'utf8');
    const originalPath = join(directory, 'original.mjs');
    const changedPath = join(directory, 'changed.mjs');
    writeFileSync(originalPath, source);
    writeFileSync(changedPath, `${source}\n// Generator-only revision.\n`);
    const nativeRequire = createRequire(import.meta.url);
    const original = nativeRequire(originalPath).createOfflineRelease(fixtureFiles());
    const changed = nativeRequire(changedPath).createOfflineRelease(fixtureFiles());
    expect(original.worker.slice(0, original.worker.lastIndexOf(')(self,'))).toBe(
      changed.worker.slice(0, changed.worker.lastIndexOf(')(self,')),
    );
    expect(changed.buildId).not.toBe(original.buildId);
  });

  it('ships subpath-relative install metadata and PNGs matching their declared dimensions', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({
      id: './',
      start_url: './',
      scope: './',
      display: 'standalone',
    });
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('./icons/')).toBe(true);
      const bytes = readFileSync(new URL(`../public/${icon.src}`, import.meta.url));
      if (icon.type !== 'image/png') continue;
      expect(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
        true,
      );
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });
});

describe('generated classic worker lifecycle', () => {
  it('verifies the complete population before ready, claims only a fresh first install, and never skips waiting automatically', async () => {
    const app = worker();
    expect(await app.message()).toMatchObject({ type: 'OFFLINE_STATUS', ready: false });
    await app.dispatch('install');
    expect(app.network).toHaveBeenCalledTimes(app.release.assets.length);
    for (const [request] of app.network.mock.calls) {
      expect(request.cache).toBe('reload');
      expect(request.redirect).toBe('error');
      expect(request.credentials).toBe('same-origin');
    }
    expect(await app.message()).toMatchObject({
      type: 'OFFLINE_STATUS',
      ready: true,
      buildId: app.release.buildId,
      assetCount: app.release.assets.length,
      requestId: 'request-1',
    });
    await app.dispatch('activate');
    expect(app.self.clients.claim).toHaveBeenCalledOnce();
    expect(app.self.skipWaiting).not.toHaveBeenCalled();
    const repeated = worker(fixtureFiles(), { storage: app.storage, active: true });
    repeated.network.mockRejectedValue(new Error('Offline'));
    await repeated.dispatch('install');
    expect(repeated.network).not.toHaveBeenCalled();
    expect(await repeated.message()).toMatchObject({ ready: true });
  });

  it.each(['network', 'http', 'integrity', 'quota'])(
    'failed %s update preserves the complete incumbent release',
    async (failure) => {
      const old = worker();
      await old.dispatch('install');
      const files = fixtureFiles();
      files.set('index.html', '<head></head><body>App B</body>');
      const next = worker(files, { storage: old.storage, active: true });
      if (failure === 'network') next.failures.set('index.html', new Error('Offline'));
      if (failure === 'http')
        next.failures.set('index.html', new Response('Not found', { status: 404 }));
      if (failure === 'integrity')
        next.failures.set('index.html', new Response('Mixed deployment bytes'));
      if (failure === 'quota') next.storage.failPut = 'index.html';
      await expect(next.dispatch('install')).rejects.toThrow();
      expect(await next.storage.keys()).not.toContain(prefix + next.release.buildId);
      expect(await old.message()).toMatchObject({ ready: true, buildId: old.release.buildId });
      expect(next.self.clients.claim).not.toHaveBeenCalled();
      expect(next.self.skipWaiting).not.toHaveBeenCalled();
      expect(await next.message('ACTIVATE_UPDATE')).toMatchObject({
        type: 'UPDATE_REJECTED',
        ready: false,
      });
    },
  );

  it('requires the ready-gated update message and preserves prior caches while any window remains', async () => {
    const old = worker();
    await old.dispatch('install');
    const files = fixtureFiles();
    files.set('index.html', '<head></head><body>App B</body>');
    const next = worker(files, { storage: old.storage, active: true, windows: [{}, {}] });
    await next.dispatch('install');
    expect(next.self.skipWaiting).not.toHaveBeenCalled();
    expect(await next.message('ACTIVATE_UPDATE')).toMatchObject({
      type: 'UPDATE_ACTIVATING',
      buildId: next.release.buildId,
    });
    expect(next.self.skipWaiting).toHaveBeenCalledOnce();
    await next.dispatch('activate');
    expect(next.self.clients.claim).not.toHaveBeenCalled();
    expect(await next.storage.keys()).toContain(prefix + old.release.buildId);
    expect(await next.message('UNKNOWN')).toBeUndefined();
  });

  it('rejects a conflicting same-ID descriptor without deleting or modifying the incumbent cache', async () => {
    const old = worker();
    await old.dispatch('install');
    const next = worker(fixtureFiles(), {
      storage: old.storage,
      active: true,
      // Simulate a generator/ID collision: payload changed but ID did not.
      transformWorker: (source) =>
        source.replace(/"sha256":"[a-f0-9]{64}"/, `"sha256":"${'0'.repeat(64)}"`),
    });
    const keys = await old.storage.keys();
    await expect(next.dispatch('install')).rejects.toThrow(/identity conflicts/);
    expect(next.network).not.toHaveBeenCalled();
    expect(await old.storage.keys()).toEqual(keys);
    expect(await old.message()).toMatchObject({ ready: true });
    const cache = await old.storage.open(prefix + old.release.buildId);
    expect(await (await cache.match(urlOf('index.html'))).text()).toBe(old.release.indexHtml);
  });

  it.each(['install', 'activate'])(
    'does not first-claim when any prior scoped cache exists at %s time',
    async (time) => {
      const app = worker();
      if (time === 'install') await app.storage.open(prefix + '0'.repeat(64));
      await app.dispatch('install');
      if (time === 'activate') await app.storage.open(prefix + '0'.repeat(64));
      await app.dispatch('activate');
      expect(app.self.clients.claim).not.toHaveBeenCalled();
    },
  );

  it('does not claim a first-registration page when a prior complete release remains', async () => {
    const old = worker();
    await old.dispatch('install');
    const files = fixtureFiles();
    files.set('privacy.html', 'Updated privacy information');
    const next = worker(files, { storage: old.storage });
    await next.dispatch('install');
    await next.dispatch('activate');
    expect(next.self.clients.claim).not.toHaveBeenCalled();
  });

  it('cleans only its own older scoped caches when activation finds no windows', async () => {
    const old = worker();
    await old.dispatch('install');
    await old.storage.open('another-app-cache');
    await old.storage.open('puckworks-offline:v1:https://puckworks.test/other/:old');
    const files = fixtureFiles();
    files.set('privacy.html', 'New privacy');
    const next = worker(files, { storage: old.storage, active: true, windows: [] });
    await next.dispatch('install');
    await next.dispatch('activate');
    expect(await next.storage.keys()).toEqual(
      expect.arrayContaining([
        prefix + next.release.buildId,
        'another-app-cache',
        'puckworks-offline:v1:https://puckworks.test/other/:old',
      ]),
    );
    expect(await next.storage.keys()).not.toContain(prefix + old.release.buildId);
  });
});

describe('generated worker fetch boundaries', () => {
  it('serves root/index and exact assets offline, preserves fragments, and leaves unrelated requests alone', async () => {
    const app = worker();
    await app.dispatch('install');
    app.network.mockRejectedValue(new Error('Offline'));
    for (const path of [
      '',
      'index.html',
      '#explore',
      '?query=1#explore',
      'index.html?offline-check=1#explore',
    ]) {
      const response = await app.dispatch('fetch', {
        request: { method: 'GET', mode: 'navigate', url: urlOf(path) },
      });
      expect(await response.text()).toBe(app.release.indexHtml);
    }
    const cache = await app.storage.open(prefix + app.release.buildId);
    expect([...cache.responses.keys()].some((url) => Boolean(new URL(url).search))).toBe(false);
    for (const asset of app.release.assets) {
      const response = await app.dispatch('fetch', { request: new Request(urlOf(asset.path)) });
      expect(hash(Buffer.from(await response.arrayBuffer()))).toBe(asset.sha256);
    }
    for (const request of [
      { method: 'GET', mode: 'navigate', url: urlOf('unknown/deep/path') },
      { method: 'GET', mode: 'navigate', url: urlOf('unknown/deep/path?query=1') },
      new Request(urlOf('assets/index-aaaaaaaa.js?query=1')),
      new Request('https://foreign.test/project/assets/index-aaaaaaaa.js'),
      new Request('https://puckworks.test/outside/assets/index-aaaaaaaa.js'),
      new Request(urlOf('not-allowlisted.json')),
      new Request(urlOf('privacy.html'), { method: 'POST', body: 'no' }),
    ]) {
      expect(await app.dispatch('fetch', { request })).toBeUndefined();
    }
    expect(app.network).toHaveBeenCalledTimes(app.release.assets.length);
  });

  it('retains older exact hashed lazy assets after activation without mixing unhashed files or writing runtime caches', async () => {
    const files = fixtureFiles();
    files.set('assets/old-lazy-12345678.js', 'Original tab module');
    files.set('old-public.txt', 'Old public file');
    const old = worker(files);
    await old.dispatch('install');
    const nextFiles = fixtureFiles();
    nextFiles.set('privacy.html', 'New release public page');
    const next = worker(nextFiles, { storage: old.storage, active: true });
    await next.dispatch('install');
    await next.dispatch('activate');
    const keysBefore = (await next.storage.keys()).map((key) => [
      key,
      [...next.storage.entries.get(key).responses.keys()],
    ]);
    next.network.mockRejectedValue(new Error('Offline'));
    const response = await next.dispatch('fetch', {
      request: new Request(urlOf('assets/old-lazy-12345678.js')),
    });
    expect(await response.text()).toBe('Original tab module');
    const privacy = await next.dispatch('fetch', { request: new Request(urlOf('privacy.html')) });
    expect(await privacy.text()).toBe('New release public page');
    expect(
      await next.dispatch('fetch', { request: new Request(urlOf('old-public.txt')) }),
    ).toBeUndefined();
    await expect(
      next.dispatch('fetch', { request: new Request(urlOf('assets/unknown-87654321.js')) }),
    ).rejects.toThrow('Offline');
    expect(
      (await next.storage.keys()).map((key) => [
        key,
        [...next.storage.entries.get(key).responses.keys()],
      ]),
    ).toEqual(keysBefore);
  });

  it('reports loss of any cached asset and forwards a miss without silently recaching it', async () => {
    const app = worker();
    await app.dispatch('install');
    const cache = await app.storage.open(prefix + app.release.buildId);
    cache.responses.delete(urlOf('assets/Explore-bbbbbbbb.js'));
    expect(await app.message()).toMatchObject({ ready: false });
    const response = await app.dispatch('fetch', {
      request: new Request(urlOf('assets/Explore-bbbbbbbb.js')),
    });
    expect(await response.text()).toBe('unvisited lazy Explore module');
    expect(cache.responses.has(urlOf('assets/Explore-bbbbbbbb.js'))).toBe(false);
    expect(await app.message('ACTIVATE_UPDATE')).toMatchObject({ type: 'UPDATE_REJECTED' });
    expect(app.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('reports malformed commit metadata as not ready and can repair it on a retried install', async () => {
    const app = worker();
    await app.dispatch('install');
    const cache = await app.storage.open(prefix + app.release.buildId);
    await cache.put(urlOf('.puckworks-offline-ready'), new Response('null'));
    expect(await app.message()).toMatchObject({ ready: false });
    expect(await app.message('ACTIVATE_UPDATE')).toMatchObject({ type: 'UPDATE_REJECTED' });
    await app.dispatch('install');
    expect(await app.message()).toMatchObject({ ready: true });
  });
});
