#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
/** Audit rendered production states, then exercise actual browser keyboard behavior.
 * axe is a local development tool: injected by Playwright, never shipped in dist.
 * Automated rules do not establish WCAG conformance or replace assistive technology tests.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { chromium } from 'playwright-core';
import { completeInitialSetup } from './setup-helper.mjs';
import { exerciseSetupInference } from './setup-inference-checks.mjs';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(webDir, 'dist');
const output = resolve(webDir, 'test-results');
const prefix = '/puckworks-accessibility/';
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const report = { axeVersion: axe.version, tags, states: [], keyboardChecks: [] };
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    assert(path.startsWith(prefix));
    const relative = path.slice(prefix.length) || 'index.html';
    const file = resolve(dist, relative);
    assert(file.startsWith(dist + sep));
    const bytes = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

function check(value, message) {
  assert(value, message);
  report.keyboardChecks.push(message);
  console.log(`  ok   ${message}`);
}
async function activate(locator) {
  await locator.focus();
  await locator.press('Enter');
}
async function focused(locator) {
  return locator.evaluate((element) => document.activeElement === element);
}
async function audit(page, name) {
  // DevTools evaluation avoids relaxing the production CSP or adding any app script.
  await page.evaluate(axe.source);
  const result = await page.evaluate(
    async (values) =>
      window.axe.run(document, {
        runOnly: { type: 'tag', values },
      }),
    tags,
  );
  const state = {
    name,
    viewport: page.viewportSize(),
    violations: result.violations,
    incomplete: result.incomplete,
    passes: result.passes.map(({ id }) => id),
  };
  report.states.push(state);
  console.log(
    `  audit ${name}: ${state.violations.length} violations, ${state.incomplete.length} rules need review`,
  );
  for (const violation of state.violations) {
    console.error(
      `        ${violation.id}: ${violation.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
  }
}
async function noOverflow(page, label) {
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    undefined,
    { timeout: 5000 },
  );
  check(true, `${label} fits the viewport without page-wide horizontal scrolling`);
}

await mkdir(output, { recursive: true });
check(
  !(await readFile(resolve(dist, 'third-party-licenses.md'), 'utf8')).includes('axe-core'),
  'the development-only audit engine is absent from production dependency notices',
);
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: 'chrome' }),
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  report.browser = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    colorScheme: 'light',
    // Offline lifecycle is tested independently; each audit sees this exact build.
    serviceWorkers: 'block',
  });
  const errors = [];
  const foreign = [];
  context.on('request', (req) => {
    if (!req.url().startsWith(origin + '/') && !req.url().startsWith('blob:'))
      foreign.push(req.url());
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + prefix);
  await audit(page, 'Equipment welcome · light');
  await page.setViewportSize({ width: 320, height: 760 });
  await noOverflow(page, 'Equipment welcome at 320px');
  await audit(page, 'Equipment welcome · phone');
  await page.screenshot({ path: resolve(output, 'equipment-setup-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await completeInitialSetup(page);
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById('shot-status')?.textContent?.startsWith('Preview'),
    undefined,
    { timeout: 30000 },
  );
  await page.keyboard.press('Tab');
  check(
    await focused(page.getByRole('link', { name: 'Skip to content' })),
    'the first Tab reaches Skip to content',
  );
  await page.keyboard.press('Enter');
  check(await focused(page.locator('#main')), 'Skip to content moves keyboard focus to main');
  await activate(page.getByRole('tab', { name: 'Lab', exact: true }));
  await audit(page, 'Lab preview · light');
  for (const part of ['bean', 'grinder', 'machine', 'basket', 'prep', 'stop']) {
    await activate(page.locator(`[data-equipment-callout="${part}"]`));
    await audit(page, `Expanded equipment ${part} · light`);
  }
  await page.keyboard.press('Escape');

  for (const [part, name] of [
    ['machine', 'Open machine · parts and settings'],
    ['grinder', 'Open grinder · burrs and settings'],
    ['basket', 'Open portafilter · layers and baskets'],
  ]) {
    await activate(page.locator(`[data-equipment-callout="${part}"]`));
    await activate(page.getByRole('button', { name, exact: true }));
    await page.waitForFunction((id) => document.activeElement?.id === id, `${part}-internals`);
    check(
      await focused(page.locator(`#${part}-internals`)),
      `Open ${part} reveals its cutaway and moves keyboard focus`,
    );
    await activate(page.locator(`#section-${part} > summary`));
  }
  for (const id of [
    'bean',
    'water',
    'chemistry',
    'grinder',
    'basket',
    'prep',
    'machine',
    'stop',
    'overrides',
  ]) {
    await activate(page.locator(`#section-${id} > summary`));
  }
  const machineParts = page.locator('.machine-internals');
  await audit(page, 'Detailed machine · boiler layout');
  await activate(machineParts.getByRole('button', { name: 'Thermoblock illustration' }));
  await audit(page, 'Detailed machine · thermoblock layout');
  await machineParts.screenshot({ path: resolve(output, 'parts-machine-desktop.png') });
  await activate(machineParts.locator('[data-machine-internal-callout="pump"]'));
  await machineParts.getByLabel('Internal pump model', { exact: true }).selectOption('vibratory');
  await audit(page, 'Detailed machine · vibratory pump');
  await machineParts.getByLabel('Internal pump model', { exact: true }).selectOption('preset');
  await activate(machineParts.locator('[data-machine-internal-callout="group"]'));
  await machineParts
    .getByLabel('Internal Group thermal mass (water-equivalent g)', { exact: true })
    .fill('70');
  await audit(page, 'Detailed machine · thermal assembly');
  await activate(machineParts.getByRole('button', { name: 'Use existing group defaults' }));
  await activate(machineParts.getByRole('button', { name: 'Undo group assembly change' }));
  check(
    (await machineParts
      .getByLabel('Internal Group thermal mass (water-equivalent g)', { exact: true })
      .inputValue()) === '70',
    'Undo restores custom group assumptions after a reset',
  );
  await activate(machineParts.getByRole('button', { name: 'Use existing group defaults' }));
  const burrParts = page.locator('.grinder-internals');
  for (const family of ['flat-unimodal', 'flat-traditional', 'conical']) {
    await activate(burrParts.locator(`[data-burr-family="${family}"]`));
    await audit(page, `Detailed burr family · ${family}`);
    if (family === 'conical')
      await burrParts.screenshot({ path: resolve(output, 'parts-grinder-desktop.png') });
    await activate(burrParts.getByRole('button', { name: 'Undo burr swap' }));
  }
  const filterParts = page.locator('.portafilter-internals');
  for (const layer of ['puck_screen', 'paper_top', 'paper_bottom'])
    await activate(filterParts.locator(`[data-prep-part-choice="${layer}"]`));
  await audit(page, 'Detailed portafilter · installed layers');
  await activate(filterParts.getByRole('button', { name: 'Dual wall', exact: true }));
  await audit(page, 'Detailed portafilter · dual-wall basket');
  await filterParts.screenshot({ path: resolve(output, 'parts-portafilter-desktop.png') });
  await activate(filterParts.getByRole('button', { name: 'Undo basket part change' }));
  for (const layer of ['puck_screen', 'paper_top', 'paper_bottom'])
    await activate(filterParts.locator(`[data-prep-part-choice="${layer}"]`));
  await page.setViewportSize({ width: 320, height: 760 });
  await noOverflow(page, 'Detailed equipment at 320px');
  const calloutLayout = await machineParts.evaluate((element) => {
    const rect = (selector) => element.querySelector(selector).getBoundingClientRect();
    const art = rect('.machine-internal-art');
    const panel = rect('.machine-internal-panel');
    return {
      artTop: art.top,
      panelTop: panel.top,
      heatingBottom: rect('.mi-callout-heating').bottom,
      pumpBottom: rect('.mi-callout-pump').bottom,
      groupBottom: rect('.mi-callout-group').bottom,
    };
  });
  check(
    calloutLayout.heatingBottom <= calloutLayout.artTop + 1 &&
      [calloutLayout.pumpBottom, calloutLayout.groupBottom].every(
        (bottom) => bottom <= calloutLayout.panelTop + 1,
      ),
    `Phone machine callouts clear the cutaway and its controls (${JSON.stringify(calloutLayout)})`,
  );
  await audit(page, 'Detailed equipment · phone');
  await machineParts.screenshot({ path: resolve(output, 'parts-machine-phone.png') });
  await burrParts.screenshot({ path: resolve(output, 'parts-grinder-phone.png') });
  await filterParts.screenshot({ path: resolve(output, 'parts-portafilter-phone.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  const help = page.getByRole('button', { name: 'What is Roast level?', exact: true });
  await activate(help);
  check(
    (await help.getAttribute('aria-expanded')) === 'true' && (await focused(help)),
    'field help opens from the keyboard and retains focus',
  );
  await audit(page, 'Expanded recipe and help · light');

  await activate(page.getByRole('button', { name: 'Pin this run', exact: true }));
  await page.locator('#rf-prep-dose_g').fill('19');
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[data-chart="pressure"] .u-legend .u-label')).some(
      (element) => element.textContent?.startsWith('Run '),
    ),
  );
  const chart = page.locator('[data-chart="pressure"]');
  await activate(chart.locator('.chart-readout > summary'));
  const sample = chart.getByRole('slider', { name: 'Time (s) sample' });
  await sample.focus();
  await sample.press('Home');
  const first = await sample.getAttribute('aria-valuetext');
  await sample.press('ArrowRight');
  const selected = await sample.getAttribute('aria-valuetext');
  check(
    first !== selected && /sample 2 of/.test(selected),
    'native chart sample control reads an intermediate time with arrow keys',
  );
  const textValues = await chart.locator('.chart-readout dl').innerText();
  const pinnedLabel = await chart
    .locator('.u-legend .u-label')
    .filter({ hasText: /^Run / })
    .first()
    .innerText();
  check(
    textValues.includes(pinnedLabel) && (await chart.locator('.chart-readout dd').count()) >= 2,
    'chart text readout includes the current and pinned runs',
  );
  await audit(page, 'Chart sample and pinned overlay · light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await audit(page, 'Expanded Lab and chart readout · dark');
  await activate(page.locator('[data-equipment-callout="machine"]'));
  await audit(page, 'Expanded equipment machine · dark');
  await page.keyboard.press('Escape');

  const labTab = page.getByRole('tab', { name: 'Lab', exact: true });
  await labTab.focus();
  await labTab.press('End');
  check(
    await focused(page.getByRole('tab', { name: 'Explore', exact: true })),
    'End selects and focuses the last mode tab',
  );
  await page.keyboard.press('Home');
  check(
    await focused(page.getByRole('tab', { name: 'Set up equipment', exact: true })),
    'Home selects and focuses the first equipment setup tab',
  );
  await audit(page, 'Set up equipment · dark');
  await page.keyboard.press('ArrowRight');
  check(
    await focused(page.getByRole('tab', { name: 'Dial in', exact: true })),
    'Right arrow moves from equipment setup to Dial in',
  );
  const dial = page.locator('#panel-dial-in');
  await dial.getByText(/Journal saved on this device in IndexedDB/).waitFor();
  await audit(page, 'Dial-in · dark');
  await dial.getByLabel('Bag and setup name').fill('Keyboard bag');
  await dial.getByLabel('Shot name', { exact: true }).fill('Keyboard shot');
  await activate(dial.getByRole('button', { name: 'Predict and save before pulling' }));
  await dial.getByRole('button', { name: 'Save measurements' }).waitFor({ timeout: 60000 });
  const record = dial.getByRole('button', { name: /Record shot.*Keyboard shot/ });
  await activate(record); // close the initially selected prediction
  await activate(record); // explicitly reopen from its journal row
  const timeId = await dial.getByLabel('Measured time (s)').getAttribute('id');
  await page.waitForFunction((id) => document.activeElement?.id === id, timeId);
  check(
    (await record.getAttribute('aria-expanded')) === 'true' &&
      (await focused(dial.getByLabel('Measured time (s)'))),
    'Record shot identifies its expanded form and moves focus to its first field',
  );
  await audit(page, 'Journal with measurement form · dark');
  await dial.getByLabel('Measured time (s)').fill('28');
  await dial.getByLabel('Final beverage (g)', { exact: true }).fill('36');
  await activate(dial.getByRole('button', { name: 'Save measurements' }));
  await dial.getByText('Measured shot saved.', { exact: true }).waitFor();
  const useRecipe = dial.getByRole('button', { name: /Use recipe.*Keyboard shot/ });
  await page.waitForFunction(() => document.activeElement?.textContent === 'Use recipe');
  check(await focused(useRecipe), 'saving measurements returns focus to that journal row');
  await activate(dial.getByRole('button', { name: 'Edit full recipe in Lab' }));
  await page.waitForFunction(() => document.activeElement?.id === 'tab-lab');
  check(
    await focused(labTab),
    'Edit full recipe in Lab moves focus to the visible destination tab',
  );

  await activate(page.getByRole('tab', { name: 'Explore', exact: true }));
  const explore = page.locator('.explore');
  await explore.getByLabel('Displayed particles').selectOption('5000');
  await activate(explore.getByRole('button', { name: 'Run Explore', exact: true }));
  await explore
    .getByText('Surface-pool content remaining:', { exact: false })
    .waitFor({ timeout: 60000 });
  await explore.locator('.puck-canvas').waitFor({ timeout: 30000 });
  const timeline = explore.getByRole('slider', { name: 'Shot time', exact: true });
  await timeline.focus();
  await timeline.press('End');
  check(
    /s.*snapshot/i.test(await timeline.getAttribute('aria-valuetext')),
    'Explore time announces actual seconds and snapshot ordinal',
  );
  const section = explore.locator('.explore-section-svg');
  const coupledDepthCell = await explore.getByLabel('Depth cell', { exact: true }).inputValue();
  await section.focus();
  await section.press('ArrowDown');
  const readoutId = (await section.getAttribute('aria-describedby')).split(/\s+/).at(-1);
  const cell = explore.locator(`[id="${readoutId}"]`);
  check(
    (await cell.getAttribute('aria-live')) === 'polite' && /wetted/i.test(await cell.innerText()),
    'cross-section keyboard selection has a live text readout',
  );
  await explore.getByLabel('Cross-section field').selectOption('liquid_conc_kg_m3');
  check(
    /Liquid solubles.*kg\/m³/.test(await cell.innerText()),
    'selected-cell text follows the chosen liquid-solubles field and units',
  );
  await explore.getByLabel('Depth cell', { exact: true }).fill(coupledDepthCell);
  await explore.getByRole('spinbutton', { name: 'Particle number', exact: true }).fill('2');
  check(
    await explore.getByText(/Particle 2 extraction yield:.*%/).isVisible(),
    'particle selection exposes the actual extraction yield in text',
  );
  const camera = explore.getByRole('group', { name: '3D representative volume camera' });
  const volume = explore.locator('.puck-view');
  const homePosition = await volume.getAttribute('data-camera-position');
  const homeTarget = await volume.getAttribute('data-camera-target');
  await camera.focus();
  await camera.press('ArrowRight');
  check(
    (await focused(camera)) && (await volume.getAttribute('data-camera-position')) !== homePosition,
    'camera orbit changes the actual camera pose and retains keyboard focus',
  );
  await camera.press('Home');
  const resetPosition = JSON.parse(await volume.getAttribute('data-camera-position'));
  check(
    resetPosition.every((v, i) => Math.abs(v - JSON.parse(homePosition)[i]) < 1e-8) &&
      (await volume.getAttribute('data-camera-target')) === homeTarget,
    'Home restores the camera pose and target',
  );
  await activate(explore.getByRole('button', { name: 'Zoom in', exact: true }));
  await activate(explore.getByRole('button', { name: 'Reset camera', exact: true }));
  await activate(explore.getByRole('button', { name: 'Measure frame rate', exact: true }));
  const cancel = explore.getByRole('button', { name: 'Cancel measurement', exact: true });
  await cancel.waitFor();
  await activate(cancel);
  await explore.getByRole('button', { name: 'Measure frame rate', exact: true }).waitFor();
  check(true, 'frame-rate measurement can be cancelled from the keyboard');
  // Small size classes legitimately have no intact kernel. Choose a displayed
  // particle with one before opening the exact shell table for the audit.
  const shellTable = explore.getByText('Shell data table', { exact: true });
  for (let i = 1; i <= 100 && !(await shellTable.count()); i++) {
    await explore.getByRole('spinbutton', { name: 'Particle number', exact: true }).fill(String(i));
  }
  check(
    (await shellTable.count()) === 1,
    'an intact-kernel particle exposes its exact shell table',
  );
  await activate(shellTable);
  await audit(page, 'Coupled Explore, inspector and shell table · dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await audit(page, 'Coupled Explore · light');

  await explore.getByLabel('Simulation resolution').selectOption('high');
  await explore.getByLabel('Displayed particles').selectOption('5000');
  await activate(explore.getByRole('button', { name: 'Run Explore', exact: true }));
  await explore
    .locator('.explore-section-grid-size')
    .filter({ hasText: '150 depth cells' })
    .waitFor({ timeout: 60000 });
  await explore.locator('.puck-canvas').waitFor();
  await section.focus();
  for (let i = 0; i < 120; i++) await section.press('ArrowDown');
  const viewport = explore.locator('.explore-section-viewport');
  check(
    await viewport.evaluate(
      (el) =>
        el.scrollTop > 0 &&
        getComputedStyle(el).outlineStyle === 'solid' &&
        parseFloat(getComputedStyle(el).outlineWidth) >= 3,
    ),
    'refined cell selection scrolls locally and keeps an unclipped viewport focus ring',
  );
  await audit(page, 'Refined Explore with keyboard cell selection · light');

  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page, 'Explore at 390px');
  await audit(page, 'Coupled Explore · phone');
  await camera.focus();
  await page.screenshot({ path: resolve(output, 'a11y-explore-phone.png') });
  await activate(labTab);
  await noOverflow(page, 'Lab at 390px');
  await audit(page, 'Expanded Lab · phone');
  await page.screenshot({ path: resolve(output, 'a11y-lab-phone.png') });
  await activate(page.getByRole('tab', { name: 'Kernel verification', exact: true }));
  await page.getByRole('heading', { name: 'Particle kernel verification' }).waitFor();
  await audit(page, 'Kernel verification · phone');
  await activate(page.getByRole('tab', { name: 'Dial in', exact: true }));
  await noOverflow(page, 'Journal at 390px');
  await audit(page, 'Journal · phone');
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow(page, 'Journal at 320px');
  await activate(labTab);
  await activate(page.getByRole('tab', { name: 'Shot lab', exact: true }));
  await noOverflow(page, 'Lab at 320px');
  await activate(page.locator('[data-equipment-callout="grinder"]'));
  await noOverflow(page, 'Expanded equipment settings at 320px');
  await audit(page, 'Expanded equipment grinder · phone');
  await page
    .locator('.equipment-diagram')
    .screenshot({ path: resolve(output, 'equipment-phone.png') });
  await page.keyboard.press('Escape');
  await activate(page.getByRole('tab', { name: 'Explore', exact: true }));
  await noOverflow(page, 'Explore at 320px');

  await activate(page.getByRole('tab', { name: 'Dial in', exact: true }));
  await activate(dial.getByRole('button', { name: /Delete shot.*Keyboard shot/ }));
  await page.waitForFunction(() => document.activeElement?.id === 'dial-journal-title');
  check(
    await focused(dial.locator('#dial-journal-title')),
    'deleting the final journal row restores focus to the journal heading',
  );

  const setupContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    colorScheme: 'light',
    serviceWorkers: 'block',
    acceptDownloads: true,
  });
  try {
    setupContext.on('request', (req) => {
      if (!req.url().startsWith(origin + '/') && !req.url().startsWith('blob:'))
        foreign.push(req.url());
    });
    const setupPage = await setupContext.newPage();
    setupPage.on('pageerror', (error) => errors.push(error.message));
    await setupPage.goto(origin + prefix);
    await exerciseSetupInference(setupPage, {
      check,
      audit,
      capture: (surface, name) =>
        surface.screenshot({ path: resolve(output, `${name}.png`), fullPage: true }),
    });
  } finally {
    await setupContext.close();
  }

  await page.goto(origin + prefix + 'privacy.html');
  await audit(page, 'Privacy · phone');
  check(errors.length === 0, `no browser script errors (${errors.join('; ')})`);
  check(foreign.length === 0, 'all accessibility checks and workers stay on the local app origin');
  check(
    report.states.every((state) => state.violations.length === 0),
    'all audited states have zero detected rule violations',
  );
} finally {
  await writeFile(
    resolve(output, 'accessibility-checks.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await browser?.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `Accessibility checks passed: ${report.states.length} states, ${report.keyboardChecks.length} workflow checks. Review incomplete results in test-results/accessibility-checks.json.`,
);
