// SPDX-License-Identifier: GPL-2.0-or-later
/** Explicitly choose the production defaults, then open Lab for existing model checks. */
export async function completeInitialSetup(page) {
  const dialog = page.getByRole('dialog', { name: 'Welcome to Puckworks', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  await dialog.getByRole('button', { name: 'Skip setup with defaults', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await page.getByRole('tab', { name: 'Dial in', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Lab', exact: true }).click();
}
