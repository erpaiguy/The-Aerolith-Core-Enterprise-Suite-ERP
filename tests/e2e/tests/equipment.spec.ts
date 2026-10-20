// Wave 3 step 10 in a real browser: an own excavator on the register, sent to a project's site, a day's log sheet, and
// September costed (its hours charged to the project).
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a machine allocated, logged and its month costed', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `eq-${Date.now()}@amravati-roads.in`,
    'Equipment-Log-Sheets-10',
    'Amravati Roads',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Ring road, Amravati');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('Site name').fill('Ring road');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  // 1. The excavator, ₹1,500 an hour.
  await nav('Equipment');
  await page.getByRole('button', { name: 'Add a machine' }).click();
  const add = page.getByRole('form', { name: 'New machine' });
  await add.getByLabel('Code').fill('EX-01');
  await add.getByLabel('Name').fill('Excavator 20 t');
  await add.getByLabel('Internal rate ₹ an hour').fill('1500');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  const list = page.getByRole('rowgroup', { name: 'Equipment' });
  await expect(list).toContainText('Excavator 20 t');
  await list.getByRole('button', { name: 'Open' }).click();

  // 2. On the ring road from 1 September; 8 hours that day.
  const alloc = page.getByRole('form', { name: 'Allocate' });
  await alloc.getByLabel('From').fill('2026-09-01');
  await alloc.getByLabel('Project').selectOption({ index: 1 });
  await alloc.getByLabel('Site').selectOption({ label: 'Ring road' });
  await alloc.getByRole('button', { name: 'Allocate' }).click();
  await expect(page.getByRole('list', { name: 'Allocations' })).toContainText('Ring road');
  const log = page.getByRole('form', { name: 'Log sheet' });
  await log.getByLabel('Date').fill('2026-09-01');
  await log.getByLabel('Opening reading').fill('1000');
  await log.getByLabel('Closing reading').fill('1008');
  await log.getByRole('button', { name: 'Save the log' }).click();
  await expect(page.getByText('Log sheet saved.')).toBeVisible();

  // 3. September: 8 × 1,500 = ₹12,000 charged to the project.
  await page.getByRole('main').getByLabel('Month').first().fill('2026-09');
  const costing = page.getByLabel('Costing');
  await expect(costing).toContainText('₹12,000.00');
  await costing.getByRole('button', { name: 'Post the month' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Post the month' }).click();
  await expect(costing).toContainText('Costed: JV/2026-27/0001');
  await shot(page, 'equipment-01-costed');
});
