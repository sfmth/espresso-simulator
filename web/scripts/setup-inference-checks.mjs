// SPDX-License-Identifier: GPL-2.0-or-later
/* global document */
/** Real browser inference from synthetic WASM observations; no claim of physical validation. */
import { readFile } from 'node:fs/promises';

const referenceRecipe = {
  schema: 'puckworks.recipe/1',
  bean: { preset: 'medium-washed-arabica' },
  grinder: { preset: 'generic-flat-traditional-64', setting: 190 },
  basket: { preset: '58-precision-18g' },
  prep: { dose_g: 18, distribution: 'wdt' },
  machine: { preset: 'flat-9-bar', vent_headspace: true },
  stop: { beverage_g: 36 },
  numerics: { tier: 1 },
};

async function setupExport(page, setup) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    setup.getByRole('button', { name: 'Export equipment setup', exact: true }).click(),
  ]);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

/** Check the entire setup lifecycle with the browser transport already offline. */
export async function exerciseOfflineEquipmentInference(page, { check }) {
  await page.getByRole('tab', { name: 'Lab', exact: true }).click();
  const [recipeDownload] = await Promise.all([
    page.waitForEvent('download'),
    page
      .locator('#lab-panel-shot')
      .getByRole('button', { name: 'Export recipe', exact: true })
      .click(),
  ]);
  const recipe = JSON.parse(await readFile(await recipeDownload.path(), 'utf8'));
  const core = await import(new URL('../src/engine/pkg/puckcore.js', import.meta.url).href);
  core.initSync({
    module: await readFile(new URL('../src/engine/pkg/puckcore_bg.wasm', import.meta.url)),
  });
  const time = 15;
  const measured = JSON.parse(
    core.simulateRecipe(
      JSON.stringify({ ...recipe, stop: { time_s: time }, numerics: { tier: 1 } }),
    ),
  ).result.summary;
  await page.getByRole('tab', { name: 'Set up equipment', exact: true }).click();
  const setup = page.locator('#panel-setup');
  await setup.getByLabel('Equipment setup name', { exact: true }).fill('Offline equipment');
  await setup
    .getByLabel('Observed shot name', { exact: true })
    .fill('Offline synthetic measurement');
  await setup.getByLabel('Observed time (s)', { exact: true }).fill(String(time));
  await setup
    .getByLabel('Observed cup weight (g)', { exact: true })
    .fill(String(measured.beverage_mass_kg * 1000));
  await setup
    .getByLabel('Measured TDS (%) · optional', { exact: true })
    .fill(String(measured.tds * 100));
  await setup.getByRole('button', { name: 'Add observed shot', exact: true }).click();
  // Keep all current settings as explicit assumptions: a single replay checks
  // worker availability and persistence without a large optimization run.
  await setup.getByRole('button', { name: 'Find setups that match my shots', exact: true }).click();
  await setup
    .getByRole('button', { name: 'Keep possible setup 1', exact: true })
    .waitFor({ timeout: 60000 });
  await setup.getByRole('button', { name: 'Keep possible setup 1', exact: true }).click();
  const saved = await setupExport(page, setup);
  const profile = saved.alternatives[0];
  check(
    saved.observations.length === 1 &&
      saved.constraints.length === 0 &&
      profile.source === 'inferred' &&
      profile.candidate.matches,
    'equipment inference verifies an observed shot using cached WASM and exports a retained setup offline',
  );
  await setup.getByRole('button', { name: `Use ${profile.name} in Dial in`, exact: true }).click();
  await page.getByRole('heading', { name: 'Dial in', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Dial in', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Set up equipment', exact: true }).click();
  await setup
    .getByRole('button', { name: `Use ${profile.name} in Dial in`, exact: true })
    .waitFor();
  const restored = await setupExport(page, setup);
  check(
    restored.activeId === profile.id &&
      restored.alternatives.length === 1 &&
      restored.observations.length === 1,
    'active equipment selection, verification and observations survive another offline reload',
  );
  await page.getByRole('tab', { name: 'Dial in', exact: true }).click();
  await page
    .locator('#panel-dial-in')
    .getByLabel('Bag and setup name', { exact: true })
    .fill('Offline test bag');
  await page
    .locator('#panel-dial-in')
    .getByRole('rowheader', { name: /Offline retained shot/ })
    .waitFor();
  check(true, 'offline equipment inference preserves the existing shot journal');
}

export async function exerciseSetupInference(
  page,
  { check, audit = async () => {}, capture = async () => {} },
) {
  const core = await import(new URL('../src/engine/pkg/puckcore.js', import.meta.url).href);
  core.initSync({
    module: await readFile(new URL('../src/engine/pkg/puckcore_bg.wasm', import.meta.url)),
  });
  const observations = [15, 17].map((time) => {
    const result = JSON.parse(
      core.simulateRecipe(JSON.stringify({ ...referenceRecipe, stop: { time_s: time } })),
    );
    return {
      time,
      mass: result.result.summary.beverage_mass_kg * 1000,
      tds: result.result.summary.tds * 100,
    };
  });
  const welcome = page.getByRole('dialog', { name: 'Welcome to Puckworks', exact: true });
  await welcome.getByRole('button', { name: 'Set up equipment', exact: true }).click();
  const setup = page.locator('#panel-setup');
  await setup.locator('.equipment-diagram').waitFor({ timeout: 30000 });
  check(
    (await setup.locator('[data-equipment-callout]').count()) === 6,
    'setup reuses all six illustrated equipment callouts',
  );
  check(
    (await setup.locator('.equipment-art').boundingBox()).width > 200,
    'illustrated setup reserves visible width for the machine and grinder drawing',
  );
  await setup.getByLabel('Equipment setup name', { exact: true }).fill('Browser inferred setup');
  await setup.getByRole('combobox', { name: /^Known heating system/ }).selectOption('boiler');
  await setup.getByLabel('Machine display / set temperature (°C)', { exact: true }).fill('95');
  const find = setup.getByLabel('Find an equipment parameter', { exact: true });
  for (const [path, label] of [
    ['prep.dose_g', 'Dose'],
    ['prep.distribution', 'Distribution'],
    ['grinder.family', 'Burr family'],
    ['machine.temperature_c', 'Brew temperature'],
  ]) {
    await find.fill(path);
    await setup.getByLabel(`What is known about ${label}?`, { exact: true }).selectOption('locked');
  }
  await find.fill('grinder.setting');
  await setup
    .getByLabel('What is known about Grinder setting?', { exact: true })
    .selectOption('range');
  await setup.getByLabel('Minimum Grinder setting', { exact: true }).fill('185');
  await setup.getByLabel('Maximum Grinder setting', { exact: true }).fill('195');
  await setup.getByLabel('Step for Grinder setting (optional)', { exact: true }).fill('1');
  for (const [index, observation] of observations.entries()) {
    await setup
      .getByLabel('Observed shot name', { exact: true })
      .fill(`Synthetic observed shot ${index + 1}`);
    await setup.getByLabel('Observed time (s)', { exact: true }).fill(String(observation.time));
    await setup
      .getByLabel('Observed cup weight (g)', { exact: true })
      .fill(String(observation.mass));
    await setup
      .getByLabel('Measured TDS (%) · optional', { exact: true })
      .fill(String(observation.tds));
    await setup.getByRole('button', { name: 'Add observed shot', exact: true }).click();
  }
  check(
    (await setup.locator('.setup-observed-shot').count()) === 2,
    'setup records multiple measured shots directly without a prospective journal entry',
  );
  await audit(page, 'Equipment locks, bounded grind and two observations');
  await page.setViewportSize({ width: 320, height: 760 });
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  check(true, 'equipment constraints and observed shots fit a 320px viewport');
  const exportBounds = await setup
    .getByRole('button', { name: 'Export equipment setup', exact: true })
    .boundingBox();
  const importBounds = await setup.locator('label.setup-file').boundingBox();
  check(
    exportBounds &&
      importBounds &&
      (exportBounds.x + exportBounds.width <= importBounds.x ||
        importBounds.x + importBounds.width <= exportBounds.x ||
        exportBounds.y + exportBounds.height <= importBounds.y ||
        importBounds.y + importBounds.height <= exportBounds.y),
    'equipment backup actions do not overlap at 320px',
  );
  check(
    (await setup.locator('.equipment-art').boundingBox()).width > 180,
    'equipment illustration stays visible at 320px',
  );
  await audit(page, 'Equipment inference controls · phone');
  await capture(page, 'setup-inference-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  const search = setup.getByRole('button', {
    name: 'Find setups that match my shots',
    exact: true,
  });
  await search.click();
  await setup.getByRole('button', { name: 'Cancel setup search', exact: true }).click();
  await setup
    .getByText('Search cancelled. Your recorded shots and saved setups are kept.', { exact: true })
    .waitFor();
  check(
    (await setup.locator('.setup-observed-shot').count()) === 2,
    'cancelling inference retains both observations',
  );
  await search.click();
  await setup
    .getByRole('button', { name: 'Keep possible setup 1', exact: true })
    .waitFor({ timeout: 180000 });
  await audit(page, 'Verified equipment candidates');
  await capture(page, 'setup-inference-candidates');
  await setup.getByRole('button', { name: 'Keep possible setup 1', exact: true }).click();
  const second = setup.getByRole('button', { name: 'Keep possible setup 2', exact: true });
  if (await second.count()) await second.click();
  const saved = await setupExport(page, setup);
  const profile = saved.alternatives[0];
  check(
    saved.schema === 'puckworks.setup-inference/1' &&
      saved.observations.length === 2 &&
      saved.constraints.length === 5 &&
      profile.source === 'inferred' &&
      profile.candidate.matches &&
      profile.candidate.checks.length === 2 &&
      profile.candidate.checks.every((item) => item.matches && item.timeIsReplayCondition),
    'export retains constraints, both observations and full-simulation verification for a matching setup',
  );
  check(
    profile.recipe.prep.dose_g === 18 &&
      profile.recipe.prep.distribution === 'wdt' &&
      profile.recipe.grinder.family === 'flat-traditional' &&
      profile.recipe.grinder.setting >= 185 &&
      profile.recipe.grinder.setting <= 195 &&
      profile.recipe.machine.temperature_c === 93 &&
      profile.facts.displayedTemperatureC === 95 &&
      profile.facts.heater === 'boiler',
    'verified setup preserves locked dose, WDT and burr family, bounds grind, and keeps the 95°C display separate from 93°C brew water',
  );
  await setup.getByRole('button', { name: `Use ${profile.name} in Dial in`, exact: true }).click();
  await page.getByRole('heading', { name: 'Dial in', exact: true }).waitFor();
  check(
    (await page
      .getByRole('tab', { name: 'Dial in', exact: true })
      .getAttribute('aria-selected')) === 'true',
    'an inferred setup activates and opens Dial in',
  );
  if (saved.alternatives.length > 1) {
    const dial = page.locator('#panel-dial-in');
    await dial.getByLabel('Dose (g)', { exact: true }).fill('19');
    await dial
      .getByRole('button', { name: 'Compare next shot across saved setups', exact: true })
      .click();
    const comparison = dial.getByRole('table', {
      name: 'Predictions from retained equipment alternatives',
      exact: true,
    });
    try {
      const failure = dial.locator('.setup-comparison [role="alert"]');
      await Promise.race([
        comparison.waitFor({ timeout: 60000 }),
        failure.waitFor({ timeout: 60000 }).then(async () => {
          throw new Error(await failure.innerText());
        }),
      ]);
    } catch (error) {
      const feedback = await dial.locator('.setup-comparison').innerText();
      await page.getByRole('tab', { name: 'Lab', exact: true }).click();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page
          .locator('#lab-panel-shot')
          .getByRole('button', { name: 'Export recipe', exact: true })
          .click(),
      ]);
      const current = JSON.parse(await readFile(await download.path(), 'utf8'));
      console.error(
        'Equipment comparison diagnostic:',
        JSON.stringify({ reference: profile.recipe, current, feedback }),
      );
      throw error;
    }
    check(
      (await comparison.locator('tbody tr').count()) === saved.alternatives.length &&
        (await comparison.locator('td').count()) === saved.alternatives.length * 4,
      'Dial in predicts the adjusted next recipe across every retained equipment alternative',
    );
    await audit(page, 'Next-shot predictions across equipment alternatives');
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Dial in', exact: true }).waitFor();
  check(
    !(await page.getByRole('dialog').count()),
    'active inferred equipment restores without reopening the welcome dialog',
  );
  await page.getByRole('tab', { name: 'Set up equipment', exact: true }).click();
  await setup
    .getByRole('button', { name: `Use ${profile.name} in Dial in`, exact: true })
    .waitFor();
  const restored = await setupExport(page, setup);
  check(
    restored.activeId === profile.id &&
      restored.alternatives.length === saved.alternatives.length &&
      restored.observations.length === 2,
    'active selection, saved alternatives and observed shots survive reload',
  );
  await setup.getByLabel('Import equipment setup', { exact: true }).setInputFiles({
    name: 'retained-equipment.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(restored)),
  });
  await setup
    .getByText('Equipment setup imported. Choose an alternative to load its recipe.', {
      exact: true,
    })
    .waitFor();
  const imported = await setupExport(page, setup);
  check(
    imported.activeId === null &&
      imported.alternatives.length === restored.alternatives.length &&
      imported.observations.length === 2,
    'import preserves possible setups and observations but waits for explicit activation',
  );
  await setup.locator('#section-prep > summary').click();
  await setup.locator('#rf-prep-dose_g').waitFor();
  check(
    (await page.locator('[id="rf-prep-dose_g"]').count()) === 1,
    'only the active full editor owns recipe field IDs in equipment setup',
  );
  await audit(page, 'Restored saved equipment alternatives');
  await page.getByRole('tab', { name: 'Lab', exact: true }).click();
  await page.locator('#lab-panel-shot #section-prep > summary').click();
  await page.locator('#lab-panel-shot #rf-prep-dose_g').waitFor();
  check(
    (await page.locator('[id="rf-prep-dose_g"]').count()) === 1,
    'switching to Lab keeps recipe field IDs unique',
  );
}
