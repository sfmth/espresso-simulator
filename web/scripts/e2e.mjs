#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Browser smoke test of the production build (`npm run e2e` builds first).
//
// Serves web/dist with `vite preview` under a sub-path, as GitHub Pages does
// for a project site, opens it in the system Chrome through playwright-core
// (no browser download) and checks that:
// - the Lab opens on the shot lab, loads the presets from the engine worker and
//   shows a tier-0 preview; Run solves tier 1, and the result's numbers are
//   identical to the same recipe (exported from the page) run through the same
//   WebAssembly in Node; the cross-section draws and can be scrubbed and read
//   from the keyboard; a small sweep runs to the end; a pinned run overlays the
//   charts and its recipe differences are listed; recipe and result downloads work;
// - the M0 kernel verification (the Lab's second view) still runs through the
//   worker with a max error below 1e-3 identical to Node; large runs wait for Run,
//   warn about memory, come back thinned, and can be cancelled;
// - the tabs, validation, charts, hover read-out and footer links work, in
//   light and dark themes and at phone width;
// - the page and its workers make no request to any other origin and log no
//   errors (the build's Content-Security-Policy reports page violations as errors).
//
// Screenshots go to web/test-results/. Set CHROME_PATH to use another browser
// binary; by default Playwright's "chrome" channel finds Google Chrome.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const SUB_PATH = '/puckworks-e2e/';
/** The real solver gives 5.1e-4 on the defaults; accuracy proper is the core's tests' job. */
const MAX_ERROR = 1e-3;
const DEFAULTS = [150e-6, 1e-10, 64, 60, 2000, 'equal_volume', 'bdf2'];

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${message}`);
  if (!condition) failures.push(message);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`vite preview did not answer at ${url}`);
}

/** The same WASM module, run in Node, for reference results. */
async function loadEngine() {
  const pkg = await import(new URL('../src/engine/pkg/puckcore.js', import.meta.url).href);
  pkg.initSync({
    module: readFileSync(new URL('../src/engine/pkg/puckcore_bg.wasm', import.meta.url)),
  });
  return pkg;
}

function sphereReference(pkg) {
  const run = pkg.simulateSphereRelease(...DEFAULTS);
  const reference = { maxAbsError: run.maxAbsError, coreVersion: pkg.coreVersion() };
  run.free();
  return reference;
}

/** Text of a download started by `action`. */
async function downloadText(page, action) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: readFileSync(path, 'utf8') };
}

async function dialInChecks(page, shotPath) {
  await page.getByRole('tab', { name: 'Dial-in' }).click();
  const dial = page.locator('#panel-dial-in');
  await dial.getByRole('heading', { name: 'Dial-in', exact: true }).waitFor();
  await dial.getByText(/Journal saved on this device in IndexedDB/).waitFor();
  await dial.getByLabel('Bag and setup name').fill('Browser smoke bag');
  await dial.getByLabel('Shot name', { exact: true }).fill('Prospective browser shot');
  await dial.getByRole('button', { name: 'Predict and save before pulling' }).click();
  await dial.getByRole('button', { name: 'Save measurements' }).waitFor({ timeout: 60_000 });
  check(
    await dial.getByText('Waiting for measurements', { exact: true }).isVisible(),
    'Dial-in persists a prediction before receiving measurements',
  );
  await dial.getByLabel('Measured time (s)').fill('28');
  await dial.getByLabel('Final beverage (g)', { exact: true }).fill('36');
  await dial.getByLabel('TDS (%) · optional').fill('10');
  await dial.getByLabel('Your rating · optional').selectOption('4');
  await dial.getByRole('button', { name: 'Save measurements' }).click();
  await dial.getByText('Measured shot saved.', { exact: true }).waitFor();
  const backup = await downloadText(page, () =>
    dial.getByRole('button', { name: 'Export journal' }).click(),
  );
  const document = JSON.parse(backup.text);
  const entry = document.entries.find((e) => e.label === 'Prospective browser shot');
  check(
    entry?.prediction?.origin === 'app' &&
      entry.measurement?.timeS === 28 &&
      entry.measurement?.rating === 4 &&
      Date.parse(entry.prediction.recordedAt) < Date.parse(entry.measurement.recordedAt),
    'journal export retains the recipe, immutable forecast, later observation and personal rating',
  );
  await page.reload();
  await page.getByRole('tab', { name: 'Dial-in' }).click();
  await dial.getByLabel('Bag and setup name').fill('Browser smoke bag');
  await dial.getByRole('table', { name: 'Shot journal' }).waitFor({ timeout: 30_000 });
  check(
    await dial.getByRole('rowheader', { name: /Prospective browser shot/ }).isVisible(),
    'native IndexedDB transaction survives page reload',
  );
  await dial.getByLabel('Import journal or shot log').setInputFiles({
    name: 'journal.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backup.text),
  });
  await dial.getByText(/Import complete/).waitFor();
  check(
    (await dial.getByRole('table', { name: 'Shot journal' }).getByRole('row').count()) === 2,
    'reimporting an exported journal is idempotent',
  );
  await dial.getByLabel('Import journal or shot log').setInputFiles({
    name: 'shots.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'time_s,yield_g,dose_g,setting,tds_percent,rating,notes\n32,36,18,170,10,3,first\n28,36,18,190,10,4,second\n24,36,18,210,10,4,third\n',
    ),
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#panel-dial-in table[aria-label="Shot journal"] tbody tr')
        .length === 4,
  );
  check(
    await dial.getByText(/V9 remains open/).isVisible(),
    'imported and uncalibrated shots cannot establish prospective V9 accuracy',
  );
  const staleTab = await page.context().newPage();
  try {
    await staleTab.goto(page.url());
    await staleTab.getByRole('tab', { name: 'Dial-in' }).click();
    await staleTab.getByText(/Journal saved on this device in IndexedDB/).waitFor();
    await staleTab.getByLabel('Bag and setup name').fill('Browser smoke bag');
    await dial.getByRole('button', { name: 'Predict and save before pulling' }).click();
    await dial.getByRole('button', { name: 'Save measurements' }).waitFor({ timeout: 60_000 });
    await staleTab.getByRole('button', { name: 'Predict and save before pulling' }).click();
    await staleTab.getByText(/Journal changed in another tab/).waitFor({ timeout: 60_000 });
    check(true, 'a stale tab cannot overwrite a newer committed journal');
  } finally {
    await staleTab.close();
  }
  // Keep a native write transaction open so the app's save must wait. Cancelling
  // then aborts that queued transaction before it can modify the document.
  await dial.getByLabel('Shot name', { exact: true }).fill('Cancelled browser shot');
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const barrier = { release: false, queued: false, finished: false };
        window.__m4JournalBarrier = barrier;
        const request = indexedDB.open('puckworks-journal', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const hold = db.transaction('documents', 'readwrite');
          const store = hold.objectStore('documents');
          const original = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function (...args) {
            const transaction = original.apply(this, args);
            if (this.name === 'puckworks-journal' && args[1] === 'readwrite') barrier.queued = true;
            return transaction;
          };
          const finished = () => {
            IDBDatabase.prototype.transaction = original;
            db.close();
            barrier.finished = true;
          };
          hold.oncomplete = hold.onabort = finished;
          let started = false;
          const keepAlive = () => {
            if (barrier.release) return;
            const reading = store.get('journal');
            reading.onsuccess = () => {
              if (!started) {
                started = true;
                resolve();
              }
              keepAlive();
            };
            reading.onerror = () => reject(reading.error);
          };
          keepAlive();
        };
      }),
  );
  try {
    await dial.getByRole('button', { name: 'Predict and save before pulling' }).click();
    await page.waitForFunction(() => window.__m4JournalBarrier.queued, null, { timeout: 60_000 });
    await dial.getByRole('button', { name: 'Cancel dial-in task' }).click();
  } finally {
    await page.evaluate(() => {
      window.__m4JournalBarrier.release = true;
    });
  }
  await page.waitForFunction(() => window.__m4JournalBarrier.finished);
  const afterCancel = await downloadText(page, () =>
    dial.getByRole('button', { name: 'Export journal' }).click(),
  );
  check(
    !JSON.parse(afterCancel.text).entries.some(
      (entry) => entry.label === 'Cancelled browser shot',
    ) && (await dial.getByText('Cancelled.', { exact: true }).isVisible()),
    'cancelling an IndexedDB save queued behind another transaction preserves the journal and cancellation status',
  );
  await page.screenshot({ path: shotPath('e2e-dial-in'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, `Dial-in fits a 390 px viewport (overflow ${overflow} px)`);
  await page.screenshot({ path: shotPath('e2e-dial-in-phone'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function shotLabChecks(page, pkg, shot) {
  const lab = page.locator('#lab-panel-shot');
  const status = page.locator('#shot-status');
  const waitForStatus = (prefix, timeout = 30_000) =>
    page.waitForFunction(
      (expected) => document.getElementById('shot-status')?.textContent?.startsWith(expected),
      prefix,
      { timeout },
    );
  const tile = (name) => lab.locator(`[data-tile="${name}"] .tile-value`);
  const tileNumber = async (name) => Number(await tile(name).getAttribute('data-value'));

  await page.getByRole('heading', { name: 'Shot lab' }).waitFor({ timeout: 20_000 });
  await waitForStatus('Preview (tier 0)');
  check(true, 'the shot lab loads the presets from the worker and previews at tier 0');
  const previewMs = await tileNumber('runtime');
  check(Number.isFinite(previewMs), `tier-0 preview: ${previewMs.toFixed(1)} ms in the worker`);
  shot.tier0Ms = previewMs;
  check(
    (await lab.locator('.chart-grid .chart-canvas canvas').count()) >= 6,
    'the shot graph draws its small multiples',
  );

  // The recipe as the page sends it, exported through a real download (Blob URL).
  const exported = await downloadText(page, () =>
    lab.getByRole('button', { name: 'Export recipe', exact: true }).click(),
  );
  const recipe = JSON.parse(exported.text);
  check(
    recipe.schema === 'puckworks.recipe/1' && /^puckworks-recipe-.*\.json$/.test(exported.name),
    `the recipe downloads as ${exported.name}`,
  );

  // Tier 1, compared bit for bit with the same recipe in Node.
  await page.locator('#shot-run').click();
  await waitForStatus('Up to date: tier 1', 60_000);
  const referenceResult = JSON.parse(pkg.simulateRecipe(JSON.stringify(recipe))).result;
  const reference = referenceResult.summary;
  const shown = {
    ey: await tileNumber('ey'),
    tds: await tileNumber('tds'),
    shot_time_s: await tileNumber('shot-time'),
    beverage_mass_kg: await tileNumber('beverage'),
  };
  check(
    Object.entries(shown).every(([key, value]) => Object.is(value, reference[key])),
    `tier 1 in the browser equals Node exactly (EY ${reference.ey}, TDS ${reference.tds}, ` +
      `${reference.shot_time_s} s)`,
  );
  shot.tier1Ms = await tileNumber('runtime');
  shot.tier1ShotS = reference.shot_time_s;
  check(Number.isFinite(shot.tier1Ms), `tier-1 run: ${shot.tier1Ms.toFixed(0)} ms in the worker`);
  check(
    (await page.locator('.run-bar [role="status"]').textContent()).startsWith(
      'Run finished (tier 1)',
    ),
    'screen readers hear the run outcome',
  );

  // M2 catalogue: families stay folded until opened or searched. Separate gas
  // inventories are joined from chemistry, rather than mislabeled as solubles.
  await lab.getByRole('tab', { name: 'Compounds', exact: true }).click();
  const compoundSearch = lab.getByLabel('Search compounds', { exact: true });
  check(
    (await lab.locator('.compound-family').count()) > 4,
    'the M2 catalogue is grouped by family',
  );
  await compoundSearch.fill('caffeine');
  check(
    (await lab.locator('[data-species="caffeine"]').count()) === 1,
    'compound search reveals caffeine with its provenance',
  );
  await compoundSearch.fill('K6');
  check(
    (await lab.locator('[data-species="co2"]').count()) === 1,
    'K6 search includes the separate CO₂ phase inventory',
  );
  await compoundSearch.fill('');
  await lab.locator('.compound-table').screenshot({ path: shot.path('e2e-compounds') });

  await lab.getByRole('tab', { name: 'Cup chemistry', exact: true }).click();
  const chemistryPanel = lab.locator('.cup-chemistry');
  const ph = await chemistryPanel
    .locator('.tile')
    .filter({ hasText: 'Estimated cup pH' })
    .locator('.tile-value')
    .textContent();
  const referencePh = referenceResult.chemistry?.acidity.ph;
  check(
    ph === (typeof referencePh === 'number' ? referencePh.toFixed(2) : '—'),
    'estimated cup pH displays the WASM result with its reference conditions',
  );
  check(
    (await chemistryPanel.getByText('Crema volume proxy', { exact: true }).count()) === 1 &&
      (await chemistryPanel.getByText('True coffee TDS', { exact: true }).count()) === 1,
    'cup chemistry separates phase proxies and true coffee TDS from the refractometer estimate',
  );
  await chemistryPanel.screenshot({ path: shot.path('e2e-cup-chemistry') });

  // M3 runs independently of the central Tier 1 shot. The exported seeded
  // ensemble must equal the same shared Rust API called from Node.
  await lab.getByRole('tab', { name: 'Uncertainty', exact: true }).click();
  const uncertainty = lab.locator('.uncertainty-panel');
  await uncertainty.getByLabel('Scenario count', { exact: true }).selectOption('8');
  await uncertainty.getByLabel('Random seed', { exact: true }).fill('1729');
  await uncertainty.getByRole('button', { name: 'Run uncertainty (Tier 0)', exact: true }).click();
  await uncertainty
    .getByRole('status')
    .filter({ hasText: '8 of 8 scenarios completed' })
    .waitFor({ timeout: 60_000 });
  const scenarioDownload = await downloadText(page, () =>
    uncertainty
      .getByRole('button', { name: 'Download uncertainty report JSON', exact: true })
      .click(),
  );
  const scenarios = JSON.parse(scenarioDownload.text);
  const nativeScenarios = JSON.parse(
    pkg.simulateUncertainty(JSON.stringify(scenarios.recipe), JSON.stringify(scenarios.options)),
  );
  check(
    scenarios.result.schema === 'puckworks.uncertainty/1' &&
      JSON.stringify(scenarios.result) === JSON.stringify(nativeScenarios),
    'the browser exports seeded uncertainty identical to the shared WASM API in Node',
  );
  check(
    scenarios.result.bands['/summary/ey'].p05 <= scenarios.result.bands['/summary/ey'].p95 &&
      (await uncertainty.locator('[data-chart^="uncertainty-"] canvas').count()) >= 4,
    'scenario intervals and progress-normalized trajectories render',
  );
  check(
    (await uncertainty.textContent()).includes('model error excluded'),
    'scenario ranges explicitly exclude model error',
  );
  await uncertainty.screenshot({ path: shot.path('e2e-uncertainty') });

  await lab.getByRole('tab', { name: 'Taste estimates', exact: true }).click();
  const taste = lab.locator('.taste-panel');
  await taste.waitFor();
  check(
    /low trust/i.test((await taste.textContent()) ?? '') &&
      /bitterness/i.test((await taste.textContent()) ?? ''),
    'taste exposes its low-trust label and chemistry-based attributes',
  );
  await taste.screenshot({ path: shot.path('e2e-taste') });

  // Cross-section: cells on the basket, a scrubber, keyboard read-out.
  await lab.getByRole('tab', { name: 'Cross-section', exact: true }).click();
  const cells = await lab.locator('.section-cell').count();
  check(cells > 0, `the cross-section draws ${cells / 2} cells on the basket`);
  const slider = lab.getByLabel('Snapshot', { exact: true });
  await slider.focus();
  await page.keyboard.press('Home');
  check((await slider.inputValue()) === '0', 'the scrubber moves to the first snapshot');
  // The first snapshot catches the water on its way down: every cell not yet
  // fully wetted is hatched, and each column with a front gets a dashed line.
  const firstWetted = referenceResult.spatial.snapshots[0].wetted_fraction ?? [];
  const notWet = firstWetted.flat().filter((w) => w < 1).length;
  const hatched = await lab.locator('.section-hatch').count();
  const fronts = await lab.locator('.section-front').count();
  check(
    hatched === notWet && (notWet === 0) === (fronts === 0),
    `the first snapshot hatches the ${hatched} cells not yet wetted and marks ${fronts} wetting fronts`,
  );
  await page.keyboard.press('End');
  const figure = lab.getByRole('group', { name: /Cross-section cells/ });
  await figure.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check(
    /^Column 2 of \d+ \(radius/.test((await lab.locator('.section-readout').textContent()) ?? ''),
    'arrow keys read a cell of the cross-section',
  );
  await lab.locator('.cross-section').screenshot({ path: shot.path('e2e-cross-section') });
  await slider.focus();
  await page.keyboard.press('Home');
  await lab.locator('.cross-section').screenshot({ path: shot.path('e2e-cross-section-first') });

  // A small sweep at tier 0.
  await lab.getByRole('tab', { name: 'Sweep', exact: true }).click();
  await lab.locator('#sweep-points').fill('5');
  await lab.getByRole('button', { name: 'Run sweep', exact: true }).click();
  await page.waitForFunction(
    () =>
      /^Finished: 5 of 5/.test(document.querySelector('.sweep-progress label')?.textContent ?? ''),
    null,
    { timeout: 60_000 },
  );
  check(
    (await lab.locator('[data-chart^="sweep-"] canvas').count()) >= 3,
    'a 5-point dose sweep runs in the worker and draws its charts',
  );
  const sweepCsv = await downloadText(page, () =>
    lab.getByRole('button', { name: 'Export sweep CSV' }).click(),
  );
  check(
    sweepCsv.text.split('\n').filter(Boolean).length === 6 &&
      sweepCsv.text.startsWith('prep.dose_g (g),'),
    'the sweep downloads as CSV, one row per point',
  );

  // Pin, change the dose, compare.
  await lab.getByRole('tab', { name: 'Shot graph', exact: true }).click();
  await page.locator('#shot-pin').click();
  await page.locator('#section-prep > summary').click();
  await page.locator('#rf-prep-dose_g').fill('19');
  await waitForStatus('Preview (tier 0)');
  shot.tier0WarmMs = await tileNumber('runtime');
  check(
    Number.isFinite(shot.tier0WarmMs),
    `tier-0 preview after an edit: ${shot.tier0WarmMs.toFixed(1)} ms in the worker`,
  );
  const legend = await lab.locator('[data-chart="pressure"] .u-legend .u-label').allTextContents();
  check(
    legend.some((l) => l.startsWith('This run')) && legend.some((l) => l.startsWith('Run ')),
    `the pinned run overlays the shot graph (${legend.slice(1).join(', ')})`,
  );
  const diff = await lab.locator('.diff-table tbody th').allTextContents();
  check(diff.includes('Dose'), 'the recipe differences list the dose');
  // Unpinning by keyboard moves the focus to a neighbour, not to the page body.
  const unpin = lab.getByRole('button', { name: /^Unpin Run / });
  await unpin.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'shot-pin', null, {
    timeout: 5_000,
  });
  check(true, 'after Unpin the keyboard focus moves to “Pin this run”');

  // Result JSON and series CSV downloads.
  const result = await downloadText(page, () =>
    lab.getByRole('button', { name: 'Result JSON', exact: true }).click(),
  );
  const parsed = JSON.parse(result.text);
  check(
    parsed.schema === 'puckworks.shot-result/1' &&
      parsed.series.t_s.length === parsed.series.pressure_pa.length,
    'the result downloads as a puckworks.shot-result/1 document',
  );
  const series = await downloadText(page, () =>
    lab.getByRole('button', { name: 'Series CSV', exact: true }).click(),
  );
  check(series.text.startsWith('time_s,pressure_bar,'), 'the series download as CSV');

  // A builder error appears next to its field.
  await page.locator('#rf-prep-dose_g').fill('45');
  await page.waitForSelector('#lab-panel-shot [role="alert"]', { timeout: 20_000 });
  check(
    (await page.locator('#rf-prep-dose_g').getAttribute('aria-invalid')) === 'true' &&
      /^prep\.dose_g: 45 g makes a/.test(
        (await page.locator('#rf-prep-dose_g-error').textContent()) ?? '',
      ),
    'a recipe the builder rejects shows its message next to the dose',
  );
  // Back to the inputs of the tier-1 run: its result is shown again, without a new run.
  await page.locator('#rf-prep-dose_g').fill('18');
  await waitForStatus('Up to date: tier 1');
  check(
    Object.is(await tileNumber('ey'), reference.ey),
    'returning to earlier inputs shows their tier-1 result again',
  );
  check((await status.textContent()).startsWith('Up to date'), 'and the status says so');

  // A three-way valve vents the group at the stop: no drip, so the cup holds
  // the stop mass. The tier-0 preview is compared with the same recipe in Node.
  if ((await page.locator('#section-machine').getAttribute('open')) === null) {
    await page.locator('#section-machine > summary').click();
  }
  await lab.getByLabel('Vents the group after the shot (three-way valve)', { exact: true }).check();
  await waitForStatus('Preview (tier 0)');
  const ventedRecipe = JSON.parse(
    (
      await downloadText(page, () =>
        lab.getByRole('button', { name: 'Export recipe', exact: true }).click(),
      )
    ).text,
  );
  const vented = JSON.parse(
    pkg.simulateRecipe(
      JSON.stringify({ ...ventedRecipe, numerics: { ...ventedRecipe.numerics, tier: 0 } }),
    ),
  ).result.summary;
  const cup = await tileNumber('beverage');
  const stopKg = ventedRecipe.stop.beverage_g / 1000;
  check(
    ventedRecipe.machine.vent_headspace === true &&
      Object.is(cup, vented.beverage_mass_kg) &&
      vented.drip_mass_kg === 0 &&
      Math.abs(cup - stopKg) < 1e-6,
    `with the group vented the cup holds the stop mass: ${(cup * 1000).toFixed(4)} g of ` +
      `${ventedRecipe.stop.beverage_g} g, no drip (tier 0, as in Node)`,
  );

  await fromScratchChecks(page, pkg);
}

/** A recipe with no presets at all (PLAN §1.2 principle 7), as a file the page imports. */
const FROM_SCRATCH = {
  schema: 'puckworks.recipe/1',
  bean: { roast_level: 0.7, days_off_roast: 20, arabica_fraction: 0.85 },
  grinder: {
    psd: {
      diameter_um: [20, 50, 120, 250, 400, 700],
      volume_fraction: [5, 10, 15, 40, 25, 5],
      method: 'dry_laser',
    },
  },
  basket: {
    custom: {
      profile_mm: [
        [0, 44],
        [5, 50],
        [10, 50],
        [10.5, 56],
        [22, 57],
      ],
      perforated_diameter_mm: 40,
      open_area_fraction: 0.05,
      pressurised_orifice_mm: 0.5,
      discharge_coefficient: 0.7,
    },
  },
  prep: { dose_g: 15, distribution: 'none', puck_screen: true },
  machine: {
    profile: [
      { control: 'flow', target: 3, until_pressure_bar: 2, until_time_s: 10 },
      { control: 'pump' },
    ],
    pump: { type: 'vibratory', free_flow_ml_s: 7, stall_pressure_bar: 14, opv_bar: 11 },
    temperature_c: 90,
    headspace_ml: 8,
  },
  stop: { beverage_g: 30, time_s: 50 },
  numerics: { tier: 1 },
};

async function fromScratchChecks(page, pkg) {
  const lab = page.locator('#lab-panel-shot');
  await lab.locator('input[type="file"]').setInputFiles({
    name: 'scratch.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(FROM_SCRATCH)),
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('#lab-panel-shot .recipe-files [role="status"]')
        ?.textContent?.startsWith('Loaded scratch.json.'),
    null,
    { timeout: 10_000 },
  );
  const basket = (await lab.locator('#section-basket .section-summary').textContent()) ?? '';
  check(
    basket.includes('Custom basket') && basket.includes('pressurised'),
    `a recipe from scratch imports (basket: ${basket})`,
  );
  await page.waitForFunction(
    () => document.getElementById('shot-status')?.textContent?.startsWith('Preview (tier 0)'),
    null,
    { timeout: 30_000 },
  );
  await page.locator('#shot-run').click();
  await page.waitForFunction(
    () => document.getElementById('shot-status')?.textContent?.startsWith('Up to date: tier 1'),
    null,
    { timeout: 60_000 },
  );
  const reference = JSON.parse(pkg.simulateRecipe(JSON.stringify(FROM_SCRATCH))).result.summary;
  const ey = Number(await lab.locator('[data-tile="ey"] .tile-value').getAttribute('data-value'));
  const time = Number(
    await lab.locator('[data-tile="shot-time"] .tile-value').getAttribute('data-value'),
  );
  check(
    Object.is(ey, reference.ey) && Object.is(time, reference.shot_time_s),
    `the from-scratch recipe runs at tier 1 exactly as in Node (EY ${reference.ey}, ${reference.shot_time_s} s)`,
  );
  // Back to the default recipe for the rest of the test.
  await lab.getByRole('button', { name: 'Undo load', exact: true }).click();
}

async function verificationChecks(page, reference) {
  await page.getByRole('tab', { name: 'Kernel verification', exact: true }).click();
  const panel = page.locator('#lab-panel-verification');
  const status = page.locator('#sphere-status');
  const waitForStatus = (prefix, timeout = 20_000) =>
    page.waitForFunction(
      (expected) => document.getElementById('sphere-status')?.textContent?.startsWith(expected),
      prefix,
      { timeout },
    );

  const maxError = panel
    .locator('.tile', { hasText: 'Max abs error' })
    .locator('.tile-value[data-value]');
  await maxError.waitFor({ timeout: 20_000 });
  const shown = Number(await maxError.getAttribute('data-value'));
  check(Number.isFinite(shown) && shown < MAX_ERROR, `max abs error ${shown} < ${MAX_ERROR}`);
  check(
    Object.is(shown, reference.maxAbsError),
    `browser and Node give the identical max abs error (${reference.maxAbsError})`,
  );
  const runtime = Number(
    await panel
      .locator('.tile', { hasText: 'Runtime' })
      .locator('.tile-value')
      .getAttribute('data-value'),
  );
  check(Number.isFinite(runtime) && runtime >= 0, `runtime measured in the worker: ${runtime} ms`);
  const version = panel.locator('.tile', { hasText: 'Core version' }).locator('.tile-value');
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('#lab-panel-verification .tile-value')].some(
        (e) => e.textContent === expected,
      ),
    reference.coreVersion,
  );
  check(
    (await version.textContent()) === reference.coreVersion,
    `core version ${reference.coreVersion}`,
  );
  await waitForStatus('Up to date');
  check(true, 'status says the results are up to date');
  check(
    (await panel.getByRole('status').textContent()).startsWith('Run finished'),
    'screen readers hear the run outcome',
  );
  check((await panel.locator('.chart-canvas canvas').count()) >= 2, 'both charts are drawn');

  // Hover read-out: the live legend lists every series at the cursor's time.
  const firstChart = panel.locator('.chart').first();
  const plot = firstChart.locator('.u-over');
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  const values = await firstChart.locator('.u-legend .u-value').allTextContents();
  check(
    values.length === 3 && values.every((v) => v !== '—' && v !== '--' && v !== ''),
    `hovering shows time and both series values (${values.join(', ')})`,
  );
  await page.mouse.move(0, 0);

  // Validation: an invalid shell count is flagged and blocks Run.
  const shells = page.getByLabel('Shells');
  await shells.fill('1');
  check(
    await page.getByText(/whole number of shells/).isVisible(),
    'invalid input shows a message',
  );
  const run = panel.getByRole('button', { name: 'Run', exact: true });
  check(await run.isDisabled(), 'Run is disabled for invalid input');
  await shells.fill('128');
  await waitForStatus('Up to date');
  check(true, 'a new run follows a valid edit');

  // Little work but a large output (2 shells, 2 million steps): no automatic run, a memory
  // warning, and a result the worker thins before sending it.
  await page.getByLabel('Shells').fill('2');
  await page.getByLabel('Steps').fill('2000000');
  await page.waitForTimeout(600);
  check(
    (await status.textContent()).startsWith('Large run'),
    'a run with 2 million steps waits for the Run button',
  );
  check(
    await page.getByText('This run needs about 107 MB of memory.').isVisible(),
    'the memory estimate is shown before Run',
  );
  await run.click();
  await waitForStatus('Up to date', 60_000);
  const note = (await panel.locator('.note').first().textContent()) ?? '';
  const drawn = Number(/draw ([\d,]+) of 2,000,001/.exec(note)?.[1]?.replaceAll(',', ''));
  check(drawn > 0 && drawn <= 4096, `the worker sent ${drawn} of 2,000,001 points`);

  // A huge run (10^11 shell-steps) waits for Run; Cancel stops it at once by replacing the
  // busy worker, keeps the keyboard focus, and the next run is quick.
  await page.getByLabel('Shells').fill('100000');
  await page.getByLabel('Steps').fill('1000000');
  await run.click();
  check((await status.textContent()) === 'Running…', 'Run starts the huge run');
  const cancel = panel.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  check(
    (await status.textContent()) === 'Cancelled. Press Run to start it again.',
    'Cancel stops it and says so',
  );
  check(
    (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancel' &&
      (await cancel.getAttribute('aria-disabled')) === 'true',
    'focus stays on Cancel, which is now marked disabled',
  );
  const restart = Date.now();
  await panel.getByRole('button', { name: 'Defaults', exact: true }).click();
  await waitForStatus('Up to date', 10_000);
  const again = Number(await maxError.getAttribute('data-value'));
  check(
    Object.is(again, reference.maxAbsError),
    `a fresh worker reruns the defaults in ${Date.now() - restart} ms with the same result`,
  );
}

async function exploreChecks(page, shotPath) {
  const panel = page.locator('.explore');
  await panel.getByLabel('Teaching scenario').selectOption('reference');
  await panel.getByRole('button', { name: 'Load scenario', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.explore-section select')[1]?.options.length === 4,
  );
  await panel.getByLabel('Column', { exact: true }).selectOption('3');
  await panel.getByRole('button', { name: 'Run Explore', exact: true }).click();
  await panel.locator('.particle-inspector').waitFor({ timeout: 60_000 });
  await panel.getByText('Surface-pool content remaining:', { exact: false }).waitFor();
  check(
    Number(await panel.locator('.explore-metrics dd').nth(2).textContent()) < 1e-5,
    'micro-view weighted extraction agrees within 0.00001 percentage points',
  );
  check(
    (await panel.getByLabel('Depth cell', { exact: true }).getAttribute('max')) === '30',
    'standard Explore uses 30 depth cells',
  );
  check(
    (await panel.getByLabel('Column', { exact: true }).inputValue()) === '7',
    'Tier 0 edge selection maps to the Tier 1 edge annulus',
  );
  const slider = panel.getByLabel('Shot time', { exact: true });
  await slider.focus();
  await page.keyboard.press('Home');
  check(
    (await slider.inputValue()) === '0',
    'Explore timeline scrubs to the first actual stored snapshot',
  );
  await page.keyboard.press('End');
  const before = await panel.getByLabel('Depth cell', { exact: true }).inputValue();
  await panel.locator('.explore-section-svg').focus();
  await page.keyboard.press('ArrowDown');
  check(
    Number(await panel.getByLabel('Depth cell', { exact: true }).inputValue()) ===
      Number(before) + 1,
    'cross-section supports keyboard cell selection',
  );
  check(
    await panel.getByText('Select the cell exported by Run Explore', { exact: false }).isVisible(),
    'inspector withholds data when another cell is selected',
  );
  await page.keyboard.press('ArrowUp');
  const measurements = [];
  for (const count of ['30000', '150000', '5000', '25000']) {
    if (count === '5000') await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByLabel('Displayed particles').selectOption(count);
    const canvas = panel.locator('.puck-canvas');
    await canvas.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(
      (n) =>
        document
          .querySelector('.puck-canvas')
          ?.getAttribute('aria-label')
          ?.includes(Number(n).toLocaleString()),
      count,
    );
    await panel.getByRole('button', { name: 'Measure frame rate', exact: true }).click();
    await panel
      .getByRole('button', { name: 'Measure frame rate', exact: true })
      .waitFor({ timeout: 20_000 });
    const output = await panel.locator('.explore-render-status output').textContent();
    check(/\d+\.\d fps/.test(output ?? ''), `measured ${count} particles: ${output}`);
    measurements.push({
      count: Number(count),
      width: count === '5000' || count === '25000' ? 390 : 1280,
      result: output,
    });
    if (count === '30000' || count === '25000')
      await panel.locator('.explore-volume').screenshot({ path: shotPath(`e2e-explore-${count}`) });
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, `Explore fits a 390px viewport (overflow ${overflow}px)`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel.getByLabel('Simulation resolution').selectOption('high');
  await panel.getByLabel('Displayed particles').selectOption('5000');
  await panel.getByRole('button', { name: 'Run Explore', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.explore input[type="number"][max="150"]'),
    undefined,
    { timeout: 120_000 },
  );
  await panel
    .getByText('Surface-pool content remaining:', { exact: false })
    .waitFor({ timeout: 30_000 });
  check(
    (await panel.getByLabel('Depth cell', { exact: true }).getAttribute('max')) === '150',
    'high resolution computes 5× the standard depth cells',
  );
  check(
    Number(await panel.locator('.explore-metrics dd').nth(2).textContent()) < 0.5,
    'refined-grid micro extraction agrees within 0.5 percentage points',
  );
  await panel.getByLabel('Illustrative pore network').check();
  await panel.getByLabel('Cutaway plane').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await panel.locator('.explore-volume').screenshot({ path: shotPath('e2e-explore-refined') });
  writeFileSync(
    new URL('../test-results/explore-frame-rates.json', import.meta.url),
    JSON.stringify(
      {
        browser: page.context().browser().version(),
        renderer:
          'headless Chrome, ANGLE SwiftShader software rendering; not target-device validation',
        measurements,
      },
      null,
      2,
    ) + '\n',
  );
  // Loss of a WebGL context must leave the exact numeric inspection available.
  await panel
    .locator('.puck-canvas')
    .evaluate((canvas) =>
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })),
    );
  check(
    await panel
      .getByText('3D rendering is unavailable in this browser.', { exact: false })
      .isVisible(),
    'WebGL loss exposes the front-projection fallback',
  );
  check(
    await panel.getByText('Surface-pool content remaining:', { exact: false }).isVisible(),
    'exact particle inspection survives loss of WebGL',
  );
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === 'webgl2' ? null : original.call(this, type, ...args);
    };
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await panel.getByRole('button', { name: 'Run Explore', exact: true }).click();
  await panel.locator('.puck-fallback').waitFor({ timeout: 60_000 });
  check(
    await panel.getByText('Surface-pool content remaining:', { exact: false }).isVisible(),
    'startup without WebGL2 preserves exact cell and particle inspection',
  );
}

async function main() {
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    throw new Error(
      'web/dist is missing: run `npm run build` (or `npm run e2e`, which builds first).',
    );
  }
  const pkg = await loadEngine();
  const reference = sphereReference(pkg);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}${SUB_PATH}`;
  const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  const server = spawn(
    process.execPath,
    [
      vite,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
      '--base',
      SUB_PATH,
    ],
    { cwd: webDir, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const executablePath = process.env.CHROME_PATH;
  let browser;
  try {
    await waitForServer(url);
    browser = await chromium.launch({
      headless: true,
      // Without a GPU (containers, sandboxed shells) Chrome's GPU process can stall the
      // renderer. The charts draw on a 2D canvas, which software rendering handles.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      // Container locales such as en-US@posix are not valid BCP 47 tags.
      locale: 'en-US',
      acceptDownloads: true,
    });
    const requests = [];
    const errors = [];
    context.on('request', (request) => requests.push(request.url()));
    const page = await context.newPage();
    // Chromium reports a worker's own requests (the WebAssembly it fetches) on the page,
    // but not the worker script itself: record each worker's URL as well.
    const workers = [];
    page.on('worker', (worker) => {
      workers.push(worker.url());
      requests.push(worker.url());
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
        console.error(`browser console: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error(`browser page error: ${error.message}`);
    });
    page.on('requestfailed', (request) =>
      console.error(
        `browser request failed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
      ),
    );

    mkdirSync(new URL('../test-results/', import.meta.url), { recursive: true });
    const shotPath = (name) =>
      fileURLToPath(new URL(`../test-results/${name}.png`, import.meta.url));

    console.log(`e2e: ${url} in ${browser.browserType().name()} ${browser.version()}`);
    const initialResponse = await page.goto(url);
    if (process.env.E2E_DEBUG) {
      console.log(`initial response: ${initialResponse?.status()} ${page.url()}`);
      console.log(`initial body: ${(await page.locator('body').innerText()).slice(0, 2000)}`);
      await page.screenshot({ path: shotPath('e2e-initial-debug'), fullPage: true });
    }
    await page.getByRole('heading', { name: 'Puckworks' }).waitFor({ timeout: 20_000 });
    check((await page.title()) === 'Puckworks', 'page title is "Puckworks"');
    check(
      (await page.evaluate(() => document.compatMode)) === 'CSS1Compat',
      'the page renders in standards mode (the SPDX comment precedes the doctype)',
    );
    check(
      (await page.locator('meta[http-equiv="Content-Security-Policy"]').count()) === 1,
      'the build ships a Content-Security-Policy',
    );

    const shot = {
      path: shotPath,
      tier0Ms: Number.NaN,
      tier0WarmMs: Number.NaN,
      tier1Ms: Number.NaN,
      tier1ShotS: Number.NaN,
    };
    await shotLabChecks(page, pkg, shot);
    await page.screenshot({ path: shotPath('e2e-light'), fullPage: true });

    // Footer: the source link (or the local-build placeholder) and the licence notices.
    const { PUCKWORKS_SOURCE_URL, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
    const expectedSource =
      PUCKWORKS_SOURCE_URL ||
      (GITHUB_SERVER_URL && GITHUB_REPOSITORY ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}` : '');
    const modelStatus = page.locator('.model-status');
    if (expectedSource) {
      check(
        (await page.getByRole('link', { name: 'Source code' }).getAttribute('href')) ===
          expectedSource,
        `the footer links the source at ${expectedSource}`,
      );
      const report = `${expectedSource.replace(/\/+$/, '')}/blob/main/docs/validation/m1-validation.md`;
      check(
        (await modelStatus.getByRole('link', { name: 'Held-out tests' }).getAttribute('href')) ===
          report,
        'the model status links the held-out tests to the validation report',
      );
    } else {
      check(
        await page.getByText('Source code: not linked in this local build').isVisible(),
        'a local build says it has no source link',
      );
      check(
        (await modelStatus.isVisible()) &&
          ((await modelStatus.textContent()) ?? '').includes('docs/validation/m1-validation.md'),
        'the model status names the validation report',
      );
    }
    const licences = await page
      .getByRole('link', { name: 'Third-party licences' })
      .getAttribute('href');
    const notices = await fetch(new URL(licences, page.url()));
    const noticeText = notices.ok ? await notices.text() : '';
    check(
      [
        '## react - ',
        '## three - ',
        '## uplot - ',
        '# Rust crates in the WebAssembly engine',
        '## wasm-bindgen - ',
      ].every((part) => noticeText.includes(part)),
      'the footer links notices for the npm packages and the Rust crates',
    );

    await verificationChecks(page, reference);
    await page.screenshot({ path: shotPath('e2e-verification'), fullPage: true });

    // Tabs.
    await page.getByRole('tab', { name: 'Dial-in' }).click();
    check(
      await page.getByRole('heading', { name: 'Dial-in', exact: true }).isVisible(),
      'Dial-in opens its local journal and calibration workflow',
    );
    await page.keyboard.press('ArrowLeft');
    check(
      await page.getByRole('heading', { name: 'Explore', exact: true }).isVisible(),
      'arrow keys move to Explore (M5)',
    );
    await exploreChecks(page, shotPath);
    await dialInChecks(page, shotPath);
    await page.getByRole('tab', { name: 'Lab' }).click();
    await page.getByRole('tab', { name: 'Shot lab', exact: true }).click();

    // Dark theme and phone width, on the shot lab.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath('e2e-dark'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(overflow <= 0, `no horizontal scrolling at 390 px (overflow ${overflow} px)`);
    await page.screenshot({ path: shotPath('e2e-phone-dark'), fullPage: true });

    // Privacy: every request stayed on this origin. The audit sees the workers' own
    // requests too (the worker scripts and the WebAssembly they fetch).
    check(
      workers.length >= 1 &&
        workers.every((u) => /\/assets\/(?:engine|microstructure)\.worker-[^/]*\.js$/.test(u)) &&
        requests.some((u) => /\/assets\/puckcore_bg-[^/]*\.wasm$/.test(u)),
      `the audit includes the ${workers.length} engine/packing workers and the WebAssembly`,
    );
    const foreign = requests.filter((u) => !u.startsWith(`${origin}/`) && !u.startsWith('blob:'));
    check(
      requests.length > 0 && foreign.length === 0,
      `all ${requests.length} requests are same-origin`,
    );
    for (const u of foreign) console.log(`        foreign request: ${u}`);
    check(errors.length === 0, 'no console errors');
    for (const e of errors) console.log(`        console error: ${e}`);
    console.log(
      `\ne2e timings in the browser worker: tier 0 preview ${shot.tier0Ms.toFixed(1)} ms ` +
        `(first run), ${shot.tier0WarmMs.toFixed(1)} ms (after an edit); tier 1 ` +
        `${shot.tier1Ms.toFixed(0)} ms (default recipe, a shot of ${shot.tier1ShotS.toFixed(0)} s).`,
    );
  } finally {
    await browser?.close();
    server.kill();
  }
}

main().then(
  () => {
    if (failures.length > 0) {
      console.error(`\ne2e: ${failures.length} check(s) failed.`);
      process.exit(1);
    }
    console.log('\ne2e: all checks passed. Screenshots are in web/test-results/.');
  },
  (error) => {
    console.error(`e2e: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
