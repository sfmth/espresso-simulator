#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
/** Production offline/update checks with genuine service workers and no HTTP cache. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { writeOfflineBuild } from './offline-build.mjs';
import { completeInitialSetup } from './setup-helper.mjs';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const report = [];
const check = (condition, message) => {
  assert(condition, message);
  console.log(`  ok   ${message}`);
  report.push(message);
};
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown',
};

/** Exercise native navigator state independently of the server's transport gate.
 * New Chromium exposes a dedicated command; Chrome 131 needs the legacy one.
 * No injected getters or synthetic online/offline events are used.
 */
async function browserHint(page, cdp, offline) {
  const conditions = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  let method = 'Network.overrideNetworkState';
  try {
    await cdp.send(method, conditions);
  } catch (error) {
    if (!/overrideNetworkState.*(?:wasn't found|not found)/.test(String(error))) throw error;
    method = 'Network.emulateNetworkConditions';
    await cdp.send(method, conditions);
  }
  try {
    await page.waitForFunction((expected) => navigator.onLine === !expected, offline, {
      timeout: 5000,
    });
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[aria-label="Offline availability"]')
          ?.textContent.includes('Offline.') === expected,
      offline,
      { timeout: 5000 },
    );
  } catch (error) {
    const observed = await page.evaluate(() => ({
      online: navigator.onLine,
      text: document.querySelector('[aria-label="Offline availability"]')?.textContent,
      events: window.__puckworksNetworkHints,
      controller: navigator.serviceWorker.controller?.scriptURL,
    }));
    throw new Error(`${method} offline=${offline}: ${JSON.stringify(observed)}`, { cause: error });
  }
  check(true, `native ${offline ? 'offline' : 'online'} hint reaches the UI via ${method}`);
}

async function currentWorker(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const worker = navigator.serviceWorker.controller;
        if (!worker) return reject(new Error('No controlling worker'));
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('Status timed out')), 10000);
        channel.port1.onmessage = ({ data }) => {
          clearTimeout(timer);
          channel.port1.close();
          resolve(data);
        };
        worker.postMessage({ type: 'GET_STATUS' }, [channel.port2]);
      }),
  );
}

async function waitReady(page) {
  await page
    .getByLabel('Offline availability')
    .getByText('Ready for offline use.', { exact: false })
    .waitFor({ timeout: 30000 });
  const status = await currentWorker(page);
  check(
    status.ready === true && status.assetCount > 8,
    'complete release is confirmed by the controlling worker',
  );
  return status;
}

async function waitPreview(page) {
  await page.waitForFunction(
    () => document.getElementById('shot-status')?.textContent?.startsWith('Preview (tier 0)'),
    undefined,
    { timeout: 30000 },
  );
}

async function update(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('No registration');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Update install timed out')), 45000);
      let observed;
      const settled = () => {
        if (observed?.state !== 'installed' && observed?.state !== 'redundant') return;
        clearTimeout(timeout);
        registration.removeEventListener('updatefound', found);
        observed.removeEventListener('statechange', settled);
        resolve(observed.state);
      };
      const found = () => {
        const worker = registration.installing ?? registration.waiting;
        if (!worker || worker === observed) return;
        observed?.removeEventListener('statechange', settled);
        observed = worker;
        observed.addEventListener('statechange', settled);
        settled();
      };
      registration.addEventListener('updatefound', found);
      found();
      if (observed) return;
      registration.update().catch(reject);
    });
  });
}

async function exerciseOffline(page, context, url, origin, requests, network, cdp) {
  await waitPreview(page);
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestData = await page.evaluate(async (href) => (await fetch(href)).json(), manifest);
  check(
    manifestData.scope === './' && manifestData.start_url === './' && manifestData.id === './',
    'install metadata stays within the current app subpath',
  );
  check(
    manifestData.icons.some((icon) => icon.sizes === '192x192') &&
      manifestData.icons.some((icon) => icon.sizes === '512x512'),
    'install metadata includes both required icon sizes',
  );

  await page.getByRole('tab', { name: 'Dial-in', exact: true }).click();
  const dial = page.locator('#panel-dial-in');
  await dial.getByText(/Journal saved on this device in IndexedDB/).waitFor();
  await dial.getByLabel('Bag and setup name').fill('Offline test bag');
  await dial.getByLabel('Shot name', { exact: true }).fill('Offline retained shot');
  await dial.getByRole('button', { name: 'Predict and save before pulling' }).click();
  await dial.getByRole('button', { name: 'Save measurements' }).waitFor({ timeout: 60000 });

  network.blocked = true;
  await context.setOffline(true);
  const before = requests.length;
  await page.goto(`${url}index.html?offline-check=1#offline-check`);
  await waitReady(page);
  await waitPreview(page);
  await page.locator('#shot-run').click();
  await page.waitForFunction(
    () => document.getElementById('shot-status')?.textContent?.startsWith('Up to date: tier 1'),
    undefined,
    { timeout: 60000 },
  );
  check(true, 'fresh offline navigation initializes the WASM worker and solves a full Tier 1 shot');

  // Explore was never opened online; its lazy module and packing worker must come from the saved build.
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  const explore = page.locator('.explore');
  await explore.getByLabel('Displayed particles').selectOption('5000');
  await explore.getByRole('button', { name: 'Run Explore', exact: true }).click();
  await explore
    .getByText('Surface-pool content remaining:', { exact: false })
    .waitFor({ timeout: 60000 });
  await explore.locator('.puck-canvas').waitFor({ timeout: 30000 });
  check(true, 'previously unopened Explore loads its lazy renderer and particle worker offline');
  await page.getByRole('tab', { name: 'Dial-in', exact: true }).click();
  await dial.getByLabel('Bag and setup name').fill('Offline test bag');
  await dial.getByRole('rowheader', { name: /Offline retained shot/ }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dial.getByRole('button', { name: 'Export journal' }).click(),
  ]);
  const saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  check(
    saved.entries.some((entry) => entry.label === 'Offline retained shot'),
    'saved journal survives offline reload and exports locally',
  );
  await dial.getByLabel('Import journal or shot log').setInputFiles({
    name: 'offline-journal.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await dial.getByText(/Import complete/).waitFor();
  check(true, 'journal import also works without a connection');

  await page.getByRole('link', { name: 'Privacy and browser storage' }).click();
  await page.getByRole('heading', { name: 'Privacy and browser storage', exact: true }).waitFor();
  check(
    (await page.textContent('main')).includes('GitHub Pages'),
    'privacy and storage information is available offline',
  );
  await page.goto(url);
  await waitReady(page);
  check(
    requests.slice(before).every((path) => new URL(path, origin).pathname.endsWith('/sw.js')),
    `offline app uses only cached files; ${requests.length - before} browser worker-update requests were refused`,
  );
  const rejected = await page.evaluate(async (base) => {
    const denied = ['privacy.css?not-cached=1', 'not-a-build-file.json'];
    return Promise.all(
      denied.map(async (path) => {
        try {
          await fetch(new URL(path, base));
          return false;
        } catch {
          return true;
        }
      }),
    );
  }, url);
  check(
    rejected.every(Boolean),
    'unlisted URLs and query variants are not served from the app cache',
  );
  console.log(
    '  navigator after offline navigation:',
    await page.evaluate(() => ({
      online: navigator.onLine,
      text: document.querySelector('[aria-label="Offline availability"]')?.textContent,
      events: window.__puckworksNetworkHints,
    })),
  );
  // Transport failure is proven above. navigator.onLine is a separate advisory
  // signal; exercise both native transitions on this final document explicitly.
  await browserHint(page, cdp, false);
  await browserHint(page, cdp, true);
  await page.screenshot({ path: join(webDir, 'test-results/e2e-offline.png'), fullPage: true });
  await page.screenshot({ path: join(webDir, 'test-results/e2e-offline-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, {
    timeout: 5000,
  });
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'offline status fits a phone viewport',
  );
  await page.screenshot({ path: join(webDir, 'test-results/e2e-offline-phone.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  network.blocked = false;
  await context.setOffline(false);
  await browserHint(page, cdp, false);
  check(new URL(url).origin === origin, 'offline test origin remains local');
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), 'puckworks-offline-e2e-'));
  const aDir = join(temporary, 'a'),
    bDir = join(temporary, 'b');
  let browser, server;
  try {
    await cp(join(webDir, 'dist'), aDir, { recursive: true });
    await cp(join(webDir, 'dist'), bDir, { recursive: true });
    const probe = (label) => {
      const content = `export default ${JSON.stringify(label)};\n`;
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      return { path: `assets/offline-probe-${hash}.js`, content };
    };
    const aProbe = probe('retained release A'),
      bProbe = probe('release B');
    await writeFile(join(aDir, aProbe.path), aProbe.content);
    await writeFile(join(bDir, bProbe.path), bProbe.content);
    await writeOfflineBuild(aDir);
    await writeOfflineBuild(bDir);
    const releaseA = JSON.parse(await readFile(join(aDir, 'offline-release.json'), 'utf8'));
    const releaseB = JSON.parse(await readFile(join(bDir, 'offline-release.json'), 'utf8'));
    assert.notEqual(releaseA.buildId, releaseB.buildId);
    let current = aDir,
      broken = false;
    const requests = [];
    const network = { blocked: false };
    server = createServer(async (request, response) => {
      requests.push(request.url);
      if (network.blocked) {
        response.writeHead(503).end();
        return;
      }
      const pathname = new URL(request.url, 'http://local.test').pathname;
      const scope = pathname.startsWith('/puckworks-offline/') ? '/puckworks-offline/' : '/';
      const relative = pathname.slice(scope.length) || 'index.html';
      const path = resolve(current, relative);
      if (!path.startsWith(`${current}/`) || (broken && relative === 'privacy.css')) {
        response.writeHead(404).end();
        return;
      }
      try {
        const bytes = await readFile(path);
        response.writeHead(200, {
          'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        response.end(bytes);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: 'chrome' }),
    });
    console.log(`offline e2e: Chromium ${browser.version()}`);
    // The substantive flow runs under the same repository subpath as GitHub Pages.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      acceptDownloads: true,
    });
    await context.addInitScript(() => {
      const events = [{ event: 'initial', online: navigator.onLine }];
      window.__puckworksNetworkHints = events;
      for (const event of ['online', 'offline', 'pageshow']) {
        addEventListener(event, () => events.push({ event, online: navigator.onLine }));
      }
    });
    const foreign = [],
      errors = [];
    const audit = (surface) => {
      surface.on('request', (request) => {
        if (!request.url().startsWith(`${origin}/`) && !request.url().startsWith('blob:'))
          foreign.push(request.url());
      });
      surface.on('page', (opened) => opened.on('pageerror', (error) => errors.push(error.message)));
    };
    audit(context);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const url = `${origin}/puckworks-offline/`;
    await page.goto(url);
    await completeInitialSetup(page);
    const a = await waitReady(page);
    check(a.buildId === releaseA.buildId, 'page and saved release agree on content identity');
    check(
      (await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope)) ===
        url,
      'registration cannot control sibling repository paths',
    );
    await exerciseOffline(page, context, url, origin, requests, network, cdp);

    // A failed install must leave the previously complete release operational.
    current = bDir;
    broken = true;
    check((await update(page)) === 'redundant', 'an incomplete new release fails installation');
    const afterFailure = await currentWorker(page);
    check(
      afterFailure.ready && afterFailure.buildId === releaseA.buildId,
      'failed update preserves the previously complete offline release',
    );
    network.blocked = true;
    await context.setOffline(true);
    await page.reload();
    check(
      (await waitReady(page)).buildId === releaseA.buildId,
      'the previous release still reloads after a failed update',
    );
    network.blocked = false;
    await context.setOffline(false);
    broken = false;

    const other = await context.newPage();
    await other.goto(url);
    await waitReady(other);
    await page.evaluate(() => {
      window.__offlineTabSentinel = 'preserve session';
    });
    await other.evaluate(() => {
      window.__offlineTabSentinel = 'preserve other tab';
    });
    check(
      (await update(page)) === 'installed',
      'a complete new release waits for explicit activation',
    );
    await page
      .getByRole('button', { name: 'Reload to update', exact: true })
      .waitFor({ timeout: 30000 });
    await page.screenshot({ path: join(webDir, 'test-results/e2e-update-available.png') });
    check(
      (await currentWorker(page)).buildId === releaseA.buildId &&
        (await page.evaluate(() => window.__offlineTabSentinel === 'preserve session')),
      'an available update does not replace a running session',
    );
    await Promise.all([
      page.waitForFunction(
        (id) => document.querySelector('meta[name="puckworks-build-id"]')?.content === id,
        releaseB.buildId,
        { timeout: 30000 },
      ),
      page.getByRole('button', { name: 'Reload to update', exact: true }).click(),
    ]);
    check(
      (await waitReady(page)).buildId === releaseB.buildId,
      'explicit reload opens the complete new release',
    );
    check(
      await other.evaluate(() => window.__offlineTabSentinel === 'preserve other tab'),
      'activating an update does not reload another open tab',
    );
    await other
      .getByRole('button', { name: 'Reload to update', exact: true })
      .waitFor({ timeout: 30000 });
    network.blocked = true;
    await context.setOffline(true);
    const legacy = await other.evaluate(async (path) => (await fetch(path)).text(), aProbe.path);
    check(
      legacy === aProbe.content,
      'older tab can still load its old content-hashed assets offline after activation',
    );
    await page.reload();
    await waitReady(page);
    await page.getByRole('tab', { name: 'Dial-in', exact: true }).click();
    await page.getByLabel('Bag and setup name').fill('Offline test bag');
    await page.getByRole('rowheader', { name: /Offline retained shot/ }).waitFor();
    check(true, 'journal survives a release update and fresh offline restart');
    network.blocked = false;
    await context.setOffline(false);
    await context.close();

    // A separate root deployment must register and cache within / too.
    const rootContext = await browser.newContext({ locale: 'en-US' });
    audit(rootContext);
    const rootPage = await rootContext.newPage();
    await rootPage.goto(`${origin}/`);
    await completeInitialSetup(rootPage);
    check(
      (await waitReady(rootPage)).buildId === releaseB.buildId,
      'root deployment also installs correctly',
    );
    network.blocked = true;
    await rootContext.setOffline(true);
    await rootPage.goto(`${origin}/?offline-root=1#offline-check`);
    await waitReady(rootPage);
    await waitPreview(rootPage);
    check(true, 'root deployment reloads with its engine offline');
    await rootContext.close();
    check(foreign.length === 0, 'offline and update flows request no third-party origins');
    check(errors.length === 0, `offline app flow has no page errors: ${errors.join('; ')}`);
    await writeFile(
      join(webDir, 'test-results/offline-checks.json'),
      JSON.stringify(
        {
          schema: 'puckworks.offline-checks/1',
          browser: browser.version(),
          buildA: releaseA.buildId,
          buildB: releaseB.buildId,
          checks: report,
          httpRequests: requests.length,
          foreignRequests: foreign,
          pageErrors: errors,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('offline e2e: all checks passed.');
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`offline e2e: ${error.stack ?? error}`);
  process.exitCode = 1;
});
