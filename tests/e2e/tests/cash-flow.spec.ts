// Wave 4 step 2 in a real browser: a project's cost to complete forecast as cash, moved by its cash terms; the
// company's overheads in its cash flow.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test("a project's forecast moved by its cash terms; the company's overheads", async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `cash-${Date.now()}@akola-infra.in`,
    'Cash-Flow-Terms-42',
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

  // 3. Planning expects ₹50,000 more on the project.
  await nav('Cost control');
  await page.getByLabel('Project').selectOption({ index: 1 });
  const ctc = page.getByLabel('Cost to complete, No cost code · No WBS');
  await ctc.fill('50000');
  await ctc.press('Enter');
  await expect(page.getByTestId('cost-totals')).toContainText('To complete₹50,000');

  // 4. The project's cash flow: the supplier's bill due, and the cost not yet ordered (₹50,000) paid 30 days after
  // this month ends; with 0 days, at the month's end.
  const ist = new Date(Date.now() + 330 * 60_000);
  const end = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  await nav('Cash flow');
  await page.getByLabel('Whose').selectOption({ index: 1 });
  await expect(page.getByTestId('cash-table')).toContainText('Supplier bills due');
  const made = page.getByRole('row').filter({ hasText: 'Cost not yet ordered: Cost in' });
  await expect(made).toContainText(iso(new Date(end.getTime() + 30 * 86_400_000)));
  const terms = page.getByRole('form', { name: 'Cash terms' });
  await terms.getByLabel('Other cost paid after (days)').fill('0');
  await terms.getByRole('button', { name: 'Save terms' }).click();
  await expect(page.getByText('Cash terms', { exact: true })).toBeVisible();
  await expect(made).toContainText(iso(end));

  // 5. The company: ₹20,000 a month of overheads.
  await page.getByLabel('Whose').selectOption('company');
  const oh = page.getByRole('form', { name: 'Company overheads' });
  await oh.getByLabel('Per month, not booked to projects').fill('20000');
  await oh.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: 'Company overheads' })).toContainText('₹20,000');
  await shot(page, 'cash-flow');
});
