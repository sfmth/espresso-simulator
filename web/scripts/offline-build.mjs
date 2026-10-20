// SPDX-License-Identifier: GPL-2.0-or-later
/** Build-only offline app inventory. No dependency or runtime cache discovery. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKER_FILE = 'sw.js';
const REPORT_FILE = 'offline-release.json';
const sourceModuleUrl = import.meta.url;
const BUILD_META = /<meta name="puckworks-build-id" content="[a-f0-9]{64}"\s*\/?\s*>/g;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const generatorDigest = digest(readFileSync(new URL(sourceModuleUrl)));

/**
 * This function's source is emitted verbatim as a classic worker. Keeping all
 * dependencies on its `self` argument also permits real lifecycle tests in VM.
 */
function offlineWorker(self, release) {
  const scope = new URL(self.registration.scope);
  const prefix = `puckworks-offline:v1:${scope.href}:`;
  const cacheName = prefix + release.buildId;
  const markerUrl = new URL('.puckworks-offline-ready', scope).href;
  const indexUrl = new URL('index.html', scope).href;
  const assets = new Map(release.assets.map((asset) => [new URL(asset.path, scope).href, asset]));
  const immutablePath = (path) => /^assets\/[^?#]*-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(path);

  // The marker is written last, after all install writes succeeded.
  async function committed(name) {
    const cache = await self.caches.open(name);
    const marker = await cache.match(markerUrl);
    if (!marker) return null;
    let metadata;
    try {
      metadata = await marker.json();
    } catch {
      return null;
    }
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      metadata.schema !== 1 ||
      !/^[a-f0-9]{64}$/.test(metadata.buildId) ||
      name !== prefix + metadata.buildId ||
      !Array.isArray(metadata.assets) ||
      metadata.assets.length === 0
    ) {
      return null;
    }
    for (const asset of metadata.assets) {
      if (
        !asset ||
        typeof asset.path !== 'string' ||
        !asset.path ||
        asset.path.startsWith('/') ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 0
      )
        return null;
      const url = new URL(asset.path, scope);
      if (
        url.origin !== scope.origin ||
        !url.pathname.startsWith(scope.pathname) ||
        url.search ||
        url.hash
      ) {
        return null;
      }
    }
    return { cache, metadata };
  }

  // Membership is checked too: an evicted asset must not be reported ready
  // merely because its commit marker survived.
  async function complete(name) {
    const entry = await committed(name);
    if (!entry) return null;
    if (
      name === cacheName &&
      JSON.stringify(entry.metadata.assets) !== JSON.stringify(release.assets)
    )
      return null;
    for (const asset of entry.metadata.assets) {
      if (!(await entry.cache.match(new URL(asset.path, scope).href))) return null;
    }
    return entry;
  }

  async function hasPreviousCache() {
    return (await self.caches.keys()).some((name) => name.startsWith(prefix) && name !== cacheName);
  }

  async function previousComplete() {
    const previous = [];
    for (const name of await self.caches.keys()) {
      if (!name.startsWith(prefix) || name === cacheName) continue;
      const entry = await complete(name);
      if (entry) previous.push(entry);
    }
    return previous;
  }

  async function install() {
    // Never replace/delete an already complete same-build cache, including on
    // a retried install. There is no partially committed cache visible to an
    // incumbent worker: every distinct release has its own cache name.
    if (await complete(cacheName)) return;
    const existing = await committed(cacheName);
    if (existing && JSON.stringify(existing.metadata.assets) !== JSON.stringify(release.assets)) {
      throw new Error('Offline release identity conflicts with an existing committed cache');
    }
    const firstInstallClaim = !self.registration.active && !(await hasPreviousCache());
    await self.caches.delete(cacheName);
    const cache = await self.caches.open(cacheName);
    try {
      for (const [url, asset] of assets) {
        const response = await self.fetch(
          new self.Request(url, { cache: 'reload', credentials: 'same-origin', redirect: 'error' }),
        );
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== url)
        ) {
          throw new Error(`Offline install could not fetch ${asset.path}`);
        }
        const bytes = await response.clone().arrayBuffer();
        const hash = Array.from(new Uint8Array(await self.crypto.subtle.digest('SHA-256', bytes)))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (hash !== asset.sha256)
          throw new Error(`Offline install integrity mismatch: ${asset.path}`);
        await cache.put(url, response);
      }
      await cache.put(
        markerUrl,
        new self.Response(
          JSON.stringify({
            schema: 1,
            buildId: release.buildId,
            assets: release.assets,
            firstInstallClaim,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
    } catch (error) {
      // A concurrent/retried install that has already committed must survive.
      if (!(await complete(cacheName))) await self.caches.delete(cacheName);
      throw error;
    }
  }

  self.addEventListener('install', (event) => event.waitUntil(install()));
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const ready = await complete(cacheName);
        if (ready?.metadata.firstInstallClaim && !(await hasPreviousCache())) {
          await self.clients.claim();
        }
        // No open window can still need its prior worker/WASM/lazy chunks.
        // Otherwise retain all prior releases, with no age-based deletion.
        if (
          ready &&
          (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length === 0
        ) {
          for (const name of await self.caches.keys()) {
            if (name.startsWith(prefix) && name !== cacheName) await self.caches.delete(name);
          }
        }
      })(),
    );
  });

  function reply(event, message) {
    const response = {
      ...message,
      ...(event.data.requestId === undefined ? {} : { requestId: event.data.requestId }),
    };
    const target = event.ports?.[0] ?? event.source;
    try {
      target?.postMessage(response);
    } catch {
      // The requesting tab/port may have closed while storage was checked.
    }
  }
  self.addEventListener('message', (event) => {
    if (event.data?.type !== 'GET_STATUS' && event.data?.type !== 'ACTIVATE_UPDATE') return;
    event.waitUntil(
      (async () => {
        const ready = Boolean(await complete(cacheName));
        if (event.data.type === 'GET_STATUS') {
          reply(event, {
            type: 'OFFLINE_STATUS',
            buildId: release.buildId,
            cacheName,
            ready,
            assetCount: release.assets.length,
          });
        } else if (ready) {
          reply(event, { type: 'UPDATE_ACTIVATING', buildId: release.buildId });
          await self.skipWaiting();
        } else {
          reply(event, { type: 'UPDATE_REJECTED', buildId: release.buildId, ready: false });
        }
      })(),
    );
  });

  async function cachedAsset(request, url) {
    if (assets.has(url.href)) {
      const cache = await self.caches.open(cacheName);
      const response = await cache.match(url.href);
      if (response) return response;
    } else {
      // Explicit activation can leave older tabs using their original module
      // graph. Only their exact content-hashed assets may fall back to a prior
      // complete release; unhashed public assets and HTML never mix releases.
      const path = url.pathname.slice(scope.pathname.length);
      for (const { cache, metadata } of await previousComplete()) {
        if (!metadata.assets.some((asset) => asset.path === path && immutablePath(asset.path)))
          continue;
        const response = await cache.match(url.href);
        if (response) return response;
      }
    }
    // No runtime writes: unknown or missing assets remain ordinary network requests.
    return self.fetch(request);
  }
  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    url.hash = '';
    if (
      request.mode === 'navigate' &&
      (url.pathname === scope.pathname || url.pathname === new URL(indexUrl).pathname)
    ) {
      // Query/fragment variants still open the same app document. Use its
      // canonical cache key without storing the navigation URL or its query.
      event.respondWith(
        (async () =>
          (await (await self.caches.open(cacheName)).match(indexUrl)) ?? self.fetch(request))(),
      );
    } else if (
      !url.search &&
      (assets.has(url.href) || immutablePath(url.pathname.slice(scope.pathname.length)))
    ) {
      event.respondWith(cachedAsset(request, url));
    }
  });
}

/**
 * @param {Map<string, Uint8Array | string>} input final Vite + public files
 * @returns {{ buildId: string, indexHtml: string, worker: string, report: string, assets: {path: string, sha256: string, bytes: number}[] }}
 */
export function createOfflineRelease(input) {
  const files = new Map(input);
  files.delete(WORKER_FILE);
  files.delete(REPORT_FILE);
  if (!files.has('index.html')) throw new Error('Offline build requires index.html');
  for (const path of files.keys()) {
    if (
      !path ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\?#]/.test(path)
    ) {
      throw new Error(`Unsafe offline asset path: ${path}`);
    }
  }
  const canonicalIndex = Buffer.from(files.get('index.html'))
    .toString('utf8')
    .replace(BUILD_META, '');
  if (!canonicalIndex.includes('</head>')) throw new Error('Offline build requires an HTML head');
  files.set('index.html', canonicalIndex);
  const inventory = () =>
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => ({ path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) }));
  // The derived build meta is omitted from the identity to avoid hashing its
  // own value. Its final bytes ARE checked by the install integrity digest.
  const buildId = digest(
    JSON.stringify({
      schema: 1,
      assets: inventory(),
      generatorDigest,
      worker: offlineWorker.toString(),
    }),
  );
  const indexHtml = canonicalIndex.replace(
    '</head>',
    `<meta name="puckworks-build-id" content="${buildId}" /></head>`,
  );
  files.set('index.html', indexHtml);
  const report = `${JSON.stringify({ schema: 'puckworks.offline-release/1', buildId, assets: inventory() }, null, 2)}\n`;
  files.set(REPORT_FILE, report);
  const assets = inventory();
  const worker = `// SPDX-License-Identifier: GPL-2.0-or-later\n// Generated from final build assets; do not edit.\n(${offlineWorker.toString()})(self, ${JSON.stringify({ buildId, assets })});\n`;
  return { buildId, indexHtml, worker, report, assets };
}

/** @param {string} directory final output directory */
export function writeOfflineBuild(directory) {
  const files = new Map();
  function collect(relative = '') {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.set(path, readFileSync(join(directory, path)));
      else throw new Error(`Unsupported offline asset: ${path}`);
    }
  }
  collect();
  const release = createOfflineRelease(files);
  writeFileSync(join(directory, 'index.html'), release.indexHtml);
  writeFileSync(join(directory, REPORT_FILE), release.report);
  writeFileSync(join(directory, WORKER_FILE), release.worker);
  return release;
}

/** @returns {import('vite').Plugin} */
export function offlineBuild() {
  let directory;
  return {
    name: 'puckworks:offline-build',
    apply: 'build',
    configResolved(config) {
      directory = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      async handler() {
        // Vite bundles its config, rewriting function source formatting. Emit
        // from the original module so its worker template and build identity
        // are identical to a direct finalizer invocation (including tests).
        const original = await import(sourceModuleUrl);
        original.writeOfflineBuild(directory);
      },
    },
  };
}
