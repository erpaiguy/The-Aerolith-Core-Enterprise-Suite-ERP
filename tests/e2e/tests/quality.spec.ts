// Wave 3 step 14 in a real browser: a checklist template, a checklist failed on the site, cubes failing (an NCR
// raised) and a snag fixed and closed.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a checklist, a failed cube test raising an NCR, and a snag closed', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `qa-${Date.now()}@amravati-roads.in`,
    'Cube-Test-Snag-14',
    'Amravati Roads',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Washim');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  // 1. The company's checklist: two yes/no items and a number within limits.
  await nav('Quality');
  const t = page.getByRole('form', { name: 'New checklist template' });
  await t.getByLabel('Name').fill('Before concreting');
  await t
    .getByRole('textbox', { name: /Items, one a line/ })
    .fill('Cover blocks placed?\nShuttering oiled?\nCover # 40-50');
  await t.getByRole('button', { name: 'Add the template' }).click();
  await expect(
    page.getByText('Before concreting: Cover blocks placed; Shuttering oiled; Cover'),
  ).toBeVisible();

  // 2. On the project: the cover is 35 mm, so the checklist fails.
  await page.getByLabel('Project').selectOption({ index: 1 });
  const ck = page.getByRole('form', { name: 'Fill a checklist' });
  await ck.getByLabel('Checklist').selectOption({ label: 'Before concreting' });
  await ck.getByLabel('Location').fill('Footing F3');
  await ck.getByLabel('Cover blocks placed').selectOption('yes');
  await ck.getByLabel('Shuttering oiled').selectOption('yes');
  await ck.getByLabel('Cover', { exact: true }).fill('35');
  await ck.getByRole('button', { name: 'Save the checklist' }).click();
  await expect(page.getByText('Checklist failed: Cover: 35 outside 40–50.')).toBeVisible();

  // 3. M25 cubes at 28 days: 21, 21.5 and 22 average 21.5, under 22: failed, NCR-001 raised.
  const tf = page.getByRole('form', { name: 'Record a test' });
  await tf.getByLabel('Sample').fill('C-12');
  await tf.getByLabel('Three cubes (N/mm²)').fill('21, 21.5, 22');
  await tf.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('QT-001: failed; NCR-001 raised.')).toBeVisible();
  await expect(page.getByTestId('ncr-NCR-001')).toContainText('open');

  // 4. A snag found, fixed and closed.
  const sn = page.getByRole('form', { name: 'New snag' });
  await sn.getByLabel('Area').fill('Room 101');
  await sn.getByLabel('Snag').fill('Skirting tile chipped');
  await sn.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Fixed' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Room 101: Skirting tile chipped')).toContainText('closed');
  await shot(page, 'quality');
});
