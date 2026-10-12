// Wave 3 step 13 in a real browser: a supplier made a labour contractor, a worker added, a minimum wage entered, a
// day's muster at the site, and September's wage sheet refused for paying below the minimum wage.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a contractor’s worker mustered and the wage sheet held below the minimum wage', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `lab-${Date.now()}@amravati-roads.in`,
    'Muster-Wage-Sheet-13',
    'Amravati Roads',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Clients');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Shree Labour Supply');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Shree Labour Supply')).toBeVisible();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Ring road, Amravati');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('Site name').fill('Ring road');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  // 1. The contractor, a helper at ₹450 a day, and Maharashtra's unskilled minimum of ₹500 (the test's figure).
  await nav('Contract labour');
  const c = page.getByRole('form', { name: 'Contractor' });
  await c.getByLabel('Supplier').selectOption({ label: 'Shree Labour Supply' });
  await c.getByLabel('CLRA licence').fill('CLRA/27/1234');
  await c.getByRole('button', { name: 'Save the contractor' }).click();
  await page.getByRole('button', { name: 'Open' }).click();
  const w = page.getByRole('form', { name: 'New worker' });
  await w.getByLabel('Name').fill('Sunita Jadhav');
  await w.getByLabel('Trade').fill('Helper');
  await w.getByLabel('Daily wage ₹').fill('450');
  await w.getByLabel('Joined').fill('2026-08-01');
  await w.getByRole('button', { name: 'Add worker' }).click();
  await expect(page.getByRole('cell', { name: 'Sunita Jadhav' })).toBeVisible();
  const mw = page.getByRole('form', { name: 'New minimum wage' });
  await mw.getByLabel('From').fill('2026-04-01');
  await mw.getByLabel('₹ a day').fill('500');
  await mw.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('cell', { name: '₹500.00' })).toBeVisible();

  // 2. Present on 1 September.
  await nav('Labour muster');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByLabel('Site').selectOption({ label: 'Ring road' });
  await page.getByLabel('Contractor').selectOption({ label: 'Shree Labour Supply' });
  await page.getByLabel('Day').fill('2026-09-01');
  await page
    .getByRole('row', { name: 'Sunita Jadhav' })
    .getByLabel('Mark')
    .selectOption({ label: 'Present' });
  await page.getByRole('button', { name: 'Save the muster' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // 3. September's sheet: a day at ₹450, ₹50 below the minimum; passing it is refused.
  await nav('Contract labour');
  await page.getByRole('button', { name: 'Open' }).click();
  const s = page.getByRole('form', { name: 'New wage sheet' });
  await s.getByLabel('Project').selectOption({ index: 1 });
  await s.getByLabel('Site').selectOption({ label: 'Ring road' });
  await s.getByLabel('Month').fill('2026-09');
  await s.getByRole('button', { name: 'Work the wage sheet' }).click();
  await page.getByRole('link', { name: /2026-09/ }).click();
  await page.waitForURL(/\/labour\/wage-sheets\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('sheet-Sunita Jadhav')).toContainText('short ₹50.00');
  await page.getByRole('button', { name: 'Pass' }).click();
  await expect(
    page.getByText(/below the minimum wage\. The contractor must make it up first/),
  ).toBeVisible();
  await shot(page, 'labour-wage-sheet');
});
