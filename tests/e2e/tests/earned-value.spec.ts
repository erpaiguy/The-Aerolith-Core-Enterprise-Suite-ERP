// Wave 4 step 3 in a real browser: a project's earned value read before it has a baseline, and the method its
// forecast uses changed.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('earned value without a baseline, and the forecast method chosen', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `ev-${Date.now()}@akola-infra.in`,
    'Earned-Value-Curve-43',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Akola');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await nav('Earned value');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await expect(page.getByText('The schedule has no baseline')).toBeVisible();
  await expect(page.getByTestId('ev-figures')).toContainText('SPI—');
  await expect(page.getByRole('row', { name: 'BAC ÷ CPI (performance continues)' })).toContainText(
    'the forecast',
  );
  await page
    .getByLabel("The project's forecast uses")
    .selectOption({ label: 'AC + (BAC − EV) (the rest at budget)' });
  await expect(
    page.getByRole('row', { name: 'AC + (BAC − EV) (the rest at budget)' }),
  ).toContainText('the forecast');
  await shot(page, 'earned-value');
});
