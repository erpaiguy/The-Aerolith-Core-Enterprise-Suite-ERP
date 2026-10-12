// Wave 4 step 1 in a real browser: a labour bill booked to a project with nothing saying where it belongs, placed on a
// cost code from the cost control screen; cost to complete entered for it; the month closed and compared.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a cost placed, its cost to complete entered, the month closed', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `cost-${Date.now()}@akola-infra.in`,
    'Cost-To-Complete-41',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company's GSTIN, the standard cost codes, a project and a labour supplier.
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('GSTIN').fill('27AAACA4455M1Z9');
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Companies' })).toContainText('27AAACA4455M1Z9');
  await nav('Cost codes');
  await page.getByRole('button', { name: 'Load the standard list' }).click();
  await expect(page.getByText('LAB.CIV', { exact: true })).toBeVisible();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Akola');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await nav('Clients');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Shinde Labour Supply');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27ABCPS1234K1Z5');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Shinde Labour Supply')).toBeVisible();

  // 2. Brickwork labour, ₹40,000, booked to the project without an order.
  await nav('Payables');
  await page.getByRole('link', { name: 'Enter a bill' }).click();
  const bill = page.getByRole('form', { name: "Supplier's bill" });
  await bill.getByLabel('Supplier').selectOption({ label: 'Shinde Labour Supply' });
  await bill.getByLabel('Their bill no.').fill('SLS/9');
  await bill.getByLabel('Bill date').fill('2026-10-01');
  const line = bill.getByRole('group', { name: 'Bill line 1' });
  await line.getByLabel('Ledger').selectOption({ label: 'X2002 Labour contractor charges' });
  await line.getByLabel('Description').fill('Brickwork labour');
  await line.getByLabel('Project').selectOption({ index: 1 });
  await line.getByLabel('Rate').fill('40000');
  await bill.getByRole('button', { name: 'Enter the bill' }).click();
  await page.waitForURL(/\/accounts\/vendor-bills\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();

  // 3. Cost control: the bill is not placed; placed on civil labour.
  await nav('Cost control');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await expect(page.getByTestId('cost-totals')).toContainText('Actual₹40,000');
  await expect(page.getByTestId('cost-alerts')).toContainText('1 ledger lines and 0 order lines');
  const place = page.getByRole('form', { name: 'Place this cost' });
  await place.getByLabel('Cost code').selectOption({ label: 'LAB.CIV Civil labour' });
  await place.getByRole('button', { name: 'Place' }).click();
  const row = page.getByRole('row', { name: 'LAB.CIV Civil labour · No WBS' });
  await expect(row).toContainText('₹40,000');
  await expect(page.getByRole('form', { name: 'Place this cost' })).toHaveCount(0);

  // 4. ₹15,000 more to come: forecast ₹55,000.
  const ctc = row.getByLabel('Cost to complete, LAB.CIV Civil labour · No WBS');
  await ctc.fill('15000');
  await ctc.press('Enter');
  await expect(page.getByTestId('cost-totals')).toContainText('Forecast₹55,000');

  // 5. The month closed; compared with now.
  await page.getByRole('button', { name: 'Close the month' }).click();
  const month = await page.getByLabel('Month').inputValue();
  await page.getByLabel('Compare with').selectOption(month);
  await expect(page.getByRole('columnheader', { name: `Forecast ${month}` })).toBeVisible();
  await row.getByRole('button', { name: 'LAB.CIV Civil labour' }).click();
  await expect(page.getByTestId('cost-documents')).toContainText('allocated');
  await shot(page, 'cost-control');
});
