// SPDX-License-Identifier: GPL-2.0-or-later
/* global document */
/** Production browser regressions for coffee facts, user blends and arbitrary grinder numbers. */
import { readFile } from 'node:fs/promises';

async function downloadJson(page, action) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}
async function openDetails(locator) {
  // An open boolean attribute has an empty value, so test its presence.
  if ((await locator.getAttribute('open')) === null)
    await locator.locator(':scope > summary').click();
}
async function exportedRecipe(page) {
  await page.getByRole('tab', { name: 'Lab', exact: true }).click();
  const recipe = await downloadJson(page, () =>
    page
      .locator('#lab-panel-shot')
      .getByRole('button', { name: 'Export recipe', exact: true })
      .click(),
  );
  await page.getByRole('tab', { name: 'Set up equipment', exact: true }).click();
  return recipe;
}

export async function exercisePracticalControls(
  page,
  { check, audit = async () => {}, capture = async () => {} },
) {
  const core = await import(new URL('../src/engine/pkg/puckcore.js', import.meta.url).href);
  core.initSync({
    module: await readFile(new URL('../src/engine/pkg/puckcore_bg.wasm', import.meta.url)),
  });
  const nativeBuild = (recipe) => JSON.parse(core.buildShotSpec(JSON.stringify(recipe)));
  const welcome = page.getByRole('dialog', { name: 'Welcome to Puckworks', exact: true });
  await welcome.getByRole('button', { name: 'Set up equipment', exact: true }).click();
  const setup = page.locator('#panel-setup');
  await setup.locator('.equipment-diagram').waitFor({ timeout: 30000 });

  // Inline help in a drawing remains associated with its own input.
  await setup.locator('[data-equipment-callout="prep"]').click();
  const diagramDose = setup
    .locator('.equipment-field')
    .filter({ has: page.locator('#equipment-prep-dose_g') });
  const doseHelp = diagramDose.getByRole('button', { name: /^What is / });
  await doseHelp.click();
  check(
    await diagramDose.locator('.field-help-panel').isVisible(),
    'diagram dose has an adjacent expandable explanation',
  );
  check(
    (await diagramDose.innerText()).includes('How to find it'),
    'diagram help explains meaning, simulation effect and measurement',
  );
  await audit(page, 'Practical diagram measurement help');
  await doseHelp.click();
  await page.keyboard.press('Escape');

  await openDetails(setup.locator('#section-bean'));
  const coffee = setup.locator('#section-bean');
  const picker = coffee.getByRole('combobox', { name: 'Coffee', exact: true });
  const options = await picker
    .locator('option')
    .evaluateAll((entries) =>
      entries.map((entry) => ({ value: entry.value, label: entry.textContent })),
    );
  const nativePresets = JSON.parse(core.presets()).beans;
  const legacyIds = nativePresets
    .filter((bean) => bean.arabica_fraction > 0 && bean.arabica_fraction < 1)
    .map((bean) => `preset:${bean.id}`);
  check(
    options.filter((option) => option.value.startsWith('coffee:')).length === 13,
    'normal coffee picker lists all 13 sourced single-origin catalog records',
  );
  check(
    options.every((option) => !legacyIds.includes(option.value)),
    'normal picker excludes old canned Arabica/Robusta mixtures',
  );
  await picker.selectOption('coffee:onyx-las-lajas-natural-2026');
  check(
    (await coffee.getByLabel('Measured roast color', { exact: true }).inputValue()) === '128',
    'selecting the Onyx coffee retains its published ground Agtron 128',
  );
  check(
    (
      await coffee.getByRole('link', { name: 'Roaster’s source', exact: true }).getAttribute('href')
    ).includes('onyxcoffeelab.com'),
    'selected coffee shows its primary roaster source',
  );
  const selected = await exportedRecipe(page);
  check(
    selected.bean.coffee.roast_color.value === 128 &&
      selected.bean.coffee.roast_color.sample === 'ground' &&
      selected.bean.roast_level === 0.25,
    'recipe export keeps measured color separate from the estimated roast index',
  );

  await openDetails(coffee);
  await coffee
    .getByRole('button', { name: 'Create a blend with this coffee', exact: true })
    .click();
  const first = coffee.locator('.coffee-component').nth(0);
  const second = coffee.locator('.coffee-component').nth(1);
  await openDetails(first);
  await first.getByLabel('Coffee 1 parts by mass', { exact: true }).fill('70');
  await openDetails(second);
  await second
    .getByRole('combobox', { name: 'Coffee', exact: true })
    .selectOption('coffee:counter-culture-idido-2026');
  await second.getByLabel('Coffee 2 parts by mass', { exact: true }).fill('30');
  await second.getByLabel('Roast description', { exact: true }).selectOption('0.8');
  check(
    (await coffee.locator('.coffee-blend-bar').getAttribute('aria-label')).includes('70.0 percent'),
    'blend proportions have a readable 70/30 mass-share description',
  );
  await audit(page, 'Two sourced coffees with independent roast and proportions');
  const mixed = await exportedRecipe(page);
  check(
    mixed.bean.components.length === 2 &&
      mixed.bean.components[0].weight === 70 &&
      mixed.bean.components[1].weight === 30 &&
      !mixed.bean.preset,
    'blend export contains two leaf coffees and relative weights',
  );
  const mixBuild = nativeBuild(mixed);
  const leaves = mixed.bean.components.map((component) =>
    nativeBuild({ ...mixed, bean: component.bean }),
  );
  const weightedCo2 =
    0.7 * leaves[0].derived.bean.co2_puck_mg_g + 0.3 * leaves[1].derived.bean.co2_puck_mg_g;
  check(
    Math.abs(mixBuild.derived.bean.co2_puck_mg_g - weightedCo2) < 1e-12,
    'exported browser blend conserves each leaf’s native CO2 inventory by dry mass',
  );

  await openDetails(setup.locator('#section-grinder'));
  const grinder = setup.locator('#section-grinder');
  await grinder.getByLabel('My current grinder number', { exact: true }).fill('-12.5');
  await grinder.getByLabel('Larger numbers make my grind', { exact: true }).selectOption('finer');
  await grinder.getByRole('button', { name: 'Use these grinder numbers', exact: true }).click();
  const mapped = await exportedRecipe(page);
  const mappedBuild = nativeBuild(mapped);
  check(
    mapped.grinder.setting === -12.5 &&
      mapped.grinder.setting_ref === -12.5 &&
      mapped.grinder.gap_per_unit_um < 0 &&
      !mapped.grinder.preset,
    'an arbitrary negative grinder number gets an explicit reference and reverse scale',
  );
  check(
    JSON.stringify(mappedBuild.spec) === JSON.stringify(mixBuild.spec),
    'assigning the user’s grinder number preserves every native physical input',
  );
  const finer = nativeBuild({ ...mapped, grinder: { ...mapped.grinder, setting: -11.5 } });
  check(
    finer.derived.psd.gap_um < mappedBuild.derived.psd.gap_um,
    'larger reverse dial numbers actually produce finer native grind',
  );
  await openDetails(grinder);
  await grinder
    .getByRole('button', { name: 'Estimate dial calibration from my shots', exact: true })
    .click();
  const setupDoc = await downloadJson(page, () =>
    setup.getByRole('button', { name: 'Export equipment setup', exact: true }).click(),
  );
  const known = setupDoc.constraints.find((c) => c.path === 'grinder.setting');
  const slope = setupDoc.constraints.find((c) => c.path === 'grinder.gap_per_unit_um');
  const gap = setupDoc.constraints.find((c) => c.path === 'grinder.gap_at_ref_um');
  check(
    known.mode === 'locked' &&
      known.value === -12.5 &&
      slope.mode === 'range' &&
      slope.min < slope.max &&
      slope.max < 0 &&
      gap.mode === 'range',
    'shot-based calibration locks the known dial number while fineness and reverse sensitivity remain uncertain',
  );

  const observedHelp = setup.getByRole('button', {
    name: 'Help for Observed time (s)',
    exact: true,
  });
  await observedHelp.focus();
  await observedHelp.press('Enter');
  const observedDialog = page.getByRole('dialog', { name: 'Observed time (s) help', exact: true });
  await observedDialog.waitFor();
  check(
    (await observedDialog.innerText()).includes('How to find it'),
    'observed-shot input offers measurement guidance',
  );
  await audit(page, 'Observed timing help dialog');
  await observedDialog.press('Escape');
  check(
    await observedHelp.evaluate((element) => document.activeElement === element),
    'Escape closes measurement help and restores keyboard focus',
  );
  const tools = setup.locator('details').filter({ has: page.locator('.measurement-tools') });
  await openDetails(tools);
  check(
    (await tools.locator('article.help-instrument').count()) === 6 &&
      (await tools.innerText()).includes('$0 extra'),
    'inexpensive measurement guide includes six options and the existing phone timer',
  );
  check(
    (await tools.innerText()).includes('before tax and shipping'),
    'instrument estimates retain dated price and cost boundaries',
  );
  await audit(page, 'Practical setup and measuring tools');
  await page.setViewportSize({ width: 320, height: 760 });
  await openDetails(coffee);
  await openDetails(coffee.locator('.coffee-component').nth(1));
  await openDetails(grinder);
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  check(true, 'coffee blend, custom dial and measurement tools fit a 320px viewport');
  await audit(page, 'Practical controls at 320px');
  await capture(page, 'practical-controls-phone');
  await capture(coffee.locator('.coffee-component').first(), 'practical-coffee-phone');
  await capture(
    grinder.locator('section[aria-labelledby="custom-grinder-dial-title"]'),
    'practical-grinder-phone',
  );
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('tab', { name: 'Lab', exact: true }).click();
  await page.locator('#shot-run').click();
  await page.waitForFunction(
    () => document.getElementById('shot-status')?.textContent?.startsWith('Up to date: tier 1'),
    undefined,
    { timeout: 60000 },
  );
  const result = await downloadJson(page, () =>
    page
      .locator('#lab-panel-shot')
      .getByRole('button', { name: 'Result JSON', exact: true })
      .click(),
  );
  const native = JSON.parse(
    core.simulateRecipe(JSON.stringify({ ...mapped, numerics: { ...mapped.numerics, tier: 1 } })),
  ).result;
  check(
    Math.abs(result.summary.beverage_mass_kg - native.summary.beverage_mass_kg) < 1e-12 &&
      Math.abs(result.summary.tds - native.summary.tds) < 1e-12,
    'the browser worker’s two-coffee shot agrees with the same exported recipe in native WASM',
  );
  const outputHelp = page
    .locator('[data-tile="beverage"]')
    .getByRole('button', { name: 'Help for Beverage', exact: true });
  await outputHelp.click();
  await page.getByRole('dialog', { name: 'Beverage help', exact: true }).waitFor();
  await audit(page, 'Shot output measurement help');
  await page.getByRole('dialog', { name: 'Beverage help', exact: true }).press('Escape');
  check(
    await outputHelp.evaluate((element) => document.activeElement === element),
    'output metric help is keyboard operable and restores focus',
  );
}
