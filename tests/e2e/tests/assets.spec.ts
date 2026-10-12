// Wave 3 step 9 in a real browser: a jeep brought in with the opening balances, a year's depreciation run, the jeep
// sold.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('an asset registered, depreciated for a year and sold', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `fa-${Date.now()}@wardha-earth.in`,
    'Fixed-Assets-Register-9',
    'Wardha Earth',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();

  // 1. The jeep: ₹10,00,000, ₹2,00,000 already depreciated.
  await nav('Fixed assets');
  await page.getByRole('button', { name: 'Register an asset' }).click();
  const form = page.getByRole('form', { name: 'New asset' });
  await form.getByLabel('Name').fill('Site jeep');
  await form.getByLabel('Class').selectOption({ label: 'Motor vehicles (WDV, 8 years)' });
  await form.getByLabel('Came from').selectOption('opening');
  await form.getByLabel('Depreciation to date ₹').fill('200000');
  await form.getByLabel('Cost ₹').fill('1000000');
  await form.getByLabel('Bought on').fill('2024-04-01');
  await form.getByLabel('Put to use on').fill('2024-04-01');
  await form.getByRole('button', { name: 'Register' }).click();
  const assets = page.getByRole('rowgroup', { name: 'Assets' });
  await expect(assets).toContainText('Site jeep');
  await expect(assets.getByRole('row').first()).toContainText(/8,00,000\.00/);

  // 2. 2026-27: 8,00,000 × 31.23% = 2,49,840.
  const run = page.getByRole('form', { name: 'Depreciation run' });
  await run.getByLabel('Up to').fill('2027-03-31');
  await run.getByRole('button', { name: 'Run depreciation' }).click();
  await expect(page.getByLabel('Run result')).toContainText(
    /2,49,840\.00 depreciation posted \(JV\/2026-27\/0001\)/,
  );
  await expect(assets.getByRole('row').first()).toContainText(/5,50,160\.00/);

  // 3. Sold on 1 April for ₹5,60,000 in cash.
  await assets.getByRole('button', { name: 'Move or sell' }).click();
  const sell = page.getByRole('form', { name: 'Dispose' });
  await sell.getByLabel('Sold on').fill('2027-04-01');
  await sell.getByLabel('For ₹').fill('560000');
  page.once('dialog', (d) => void d.accept());
  await sell.getByRole('button', { name: 'Dispose' }).click();
  await expect(assets).toContainText('Disposed');
  await shot(page, 'assets-01-sold');
});
