#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
/** Repeatable production-view measurement. Viewport emulation is not phone hardware evidence. */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, platform, arch } from 'node:os';
import { chromium } from 'playwright-core';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} needs a value.`);
  return args[at + 1];
}
if (args.includes('--help')) {
  console.log(`Render benchmark: node scripts/render-benchmark.mjs [options]
  --dist PATH          Production directory (default web/dist)
  --url URL            Use an already-running local server
  --output PATH        Result JSON (default test-results/render-benchmark.json)
  --backend auto|software   Auto browser backend (default) or explicit SwiftShader
  --quality exact|current   Require exact spheres, or record current quality (default current)
  --counts 30000,150000,5000,25000   Counts to measure
  --trials N           Independent fresh-page trials, default 3
  --dpr N              Browser device scale factor, default 1
  --label TEXT         Explicit run label, default local
Each count keeps its full particle population and fixed pixel dimensions. The
JSON records actual WebGL backend, quality and protocol. Cadence does not prove
compositor presentation or the physical laptop/phone G5 hardware requirement.`);
  process.exit(0);
}
const output = resolve(webRoot, option('--output', 'test-results/render-benchmark.json'));
if (!output.endsWith('.json')) throw new Error('The result path must end in .json.');
const dist = resolve(webRoot, option('--dist', 'dist'));
const backend = option('--backend', 'auto');
const quality = option('--quality', 'current');
const counts = option('--counts', '30000,150000,5000,25000').split(',').map(Number);
const trials = Number(option('--trials', '3'));
const dpr = Number(option('--dpr', '1'));
if (!['auto', 'software'].includes(backend) || !['exact', 'current'].includes(quality))
  throw new Error('Unsupported backend or rendering quality.');
if (
  !Number.isInteger(trials) ||
  trials < 1 ||
  trials > 10 ||
  !Number.isFinite(dpr) ||
  dpr < 1 ||
  dpr > 3 ||
  counts.some((n) => ![5000, 25000, 30000, 150000].includes(n))
)
  throw new Error('Use 1–10 trials, DPR 1–3, and particle counts 5000,25000,30000,150000.');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
let server;
let browser;
const records = [];
const failures = [];
const requests = new Set();
const startedAt = new Date().toISOString();
async function localServer() {
  await stat(resolve(dist, 'index.html'));
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      const filename = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(dist + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = await readFile(filename);
      res.writeHead(200, {
        'Content-Type': mime[extname(filename)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}/`;
}
async function save() {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        schema: 'puckworks.render-benchmark-suite/1',
        startedAt,
        finishedAt: new Date().toISOString(),
        label: option('--label', 'local'),
        browser: browser?.version() ?? null,
        host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null },
        requested: { backend, quality, counts, trials, dpr },
        hardwareGate:
          'unverified: viewport emulation is not actual phone hardware; device class and presentation require separate evidence',
        records,
        failures,
        requests: [...requests],
      },
      null,
      2,
    ) + '\n',
  );
}
try {
  await mkdir(dirname(output), { recursive: true });
  const url = option('--url', null) ?? (await localServer());
  const origin = new URL(url).origin;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Use a local benchmark server.');
  browser = await chromium.launch({
    headless: true,
    args:
      backend === 'software'
        ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : [],
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: 'chrome' }),
  });
  for (let trial = 1; trial <= trials; trial++) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: dpr,
      locale: 'en-US',
    });
    const page = await context.newPage();
    const errors = [];
    context.on('request', (req) => {
      requests.add(req.url());
      if (!req.url().startsWith(origin + '/') && !req.url().startsWith('blob:'))
        errors.push(`Unexpected request: ${req.url()}`);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('tab', { name: 'Explore', exact: true }).click();
    const panel = page.locator('.explore');
    await panel.getByLabel('Teaching scenario').selectOption('reference');
    await panel.getByRole('button', { name: 'Load scenario', exact: true }).click();
    await panel.getByRole('button', { name: 'Run Explore', exact: true }).click();
    await panel
      .getByText('Surface-pool content remaining:', { exact: false })
      .waitFor({ timeout: 60000 });
    for (const count of counts) {
      const mobile = count <= 25000;
      await page.setViewportSize({ width: mobile ? 390 : 1280, height: mobile ? 844 : 900 });
      await panel.getByLabel('Displayed particles').selectOption(String(count));
      await page.waitForFunction(
        (n) =>
          document
            .querySelector('.puck-canvas')
            ?.getAttribute('aria-label')
            ?.includes(`with ${Number(n).toLocaleString()} particles.`),
        count,
        { timeout: 60000 },
      );
      await panel.locator('.puck-canvas').scrollIntoViewIfNeeded();
      await panel.getByRole('button', { name: 'Measure frame rate', exact: true }).click();
      await panel
        .getByRole('button', { name: 'Measure frame rate', exact: true })
        .waitFor({ timeout: 180000 });
      const result = await panel.locator('.puck-view').getAttribute('data-render-benchmark');
      if (!result)
        throw new Error(
          'Structured benchmark missing. Normalize the frozen baseline using normalize-render-baseline.mjs first.',
        );
      const parsed = JSON.parse(result);
      if (parsed.status !== 'complete' || parsed.environment.particleCount !== count)
        throw new Error(`Incomplete or mismatched benchmark: ${parsed.status}`);
      if (quality === 'exact' && parsed.environment.renderPath !== 'analytic-exact')
        throw new Error('This build does not render exact spheres.');
      const consistency = Number(await panel.locator('.explore-metrics dd').nth(2).textContent());
      if (!Number.isFinite(consistency) || Math.abs(consistency) > 0.5)
        throw new Error('Particle/continuum extraction consistency failed.');
      records.push({
        trial,
        viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 },
        consistencyErrorPoints: consistency,
        result: parsed,
      });
      console.log(
        `${trial}/${trials} · ${count} · ${parsed.environment.renderPath} · ${parsed.stats.meanFps?.toFixed(1)}fps · p95 ${parsed.stats.frameIntervalMs?.p95.toFixed(2)}ms · ${parsed.environment.webgl.unmaskedRenderer ?? parsed.environment.webgl.renderer}`,
      );
      if (trial === 1)
        await panel
          .locator('.puck-volume, .explore-volume')
          .screenshot({ path: output.replace(/\.json$/, `-${quality}-${count}.png`) });
      await save();
    }
    if (errors.length) {
      failures.push(...errors);
      throw new Error(errors.join('\n'));
    }
    await context.close();
  }
  console.log(`Saved ${output}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  console.error(failures.at(-1));
} finally {
  await save();
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
