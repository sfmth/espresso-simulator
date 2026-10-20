// SPDX-License-Identifier: GPL-2.0-or-later
/** Complete the required first-visit flow through its real production controls. */
export async function completeInitialSetup(page, { onStep } = {}) {
  const dialog = page.getByRole('dialog', { name: 'Set up your equipment', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  await dialog
    .getByRole('combobox', { name: 'Your machine', exact: true })
    .selectOption('flat-9-bar');
  await dialog
    .getByRole('combobox', { name: 'Your grinder', exact: true })
    .selectOption('generic-flat-traditional-64');
  await dialog
    .getByRole('combobox', { name: 'Your basket', exact: true })
    .selectOption('58-precision-18g');
  await dialog
    .getByRole('combobox', { name: 'Your beans', exact: true })
    .selectOption('medium-washed-arabica');
  await dialog.getByRole('button', { name: 'Next: starting shot', exact: true }).click();
  await onStep?.(2);
  await dialog.getByLabel('Dose (g)', { exact: true }).fill('18');
  await dialog.getByLabel('Target beverage (g)', { exact: true }).fill('36');
  await dialog.getByLabel('Brew temperature (°C)', { exact: true }).fill('93');
  await dialog.getByLabel('Grinder setting', { exact: true }).fill('190');
  await dialog.getByRole('button', { name: 'Review setup', exact: true }).click();
  await onStep?.(3);
  await dialog.getByRole('button', { name: 'Start simulating', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
}
