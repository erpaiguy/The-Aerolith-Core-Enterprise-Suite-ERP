// Wave 3 step 4 in a real browser: a supplier with their bank account; their rent bill entered without an order (GST
// on top, posted at once); a payment run for it, approved with no rules, its bank file, marked paid; nothing owed.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test("a supplier's bill entered, paid in an approved run with a bank file", async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `pay-${Date.now()}@karanja-infra.in`,
    'Supplier-Payment-Run-4',
    'Karanja Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company's GSTIN, a bank ledger, the landlord with their bank account.
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('GSTIN').fill('27AAACK4455M1Z9');
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Companies' })).toContainText('27AAACK4455M1Z9');
  await nav('Chart of accounts');
  await page.getByRole('button', { name: 'Add an account' }).click();
  const add = page.getByRole('form', { name: 'New account' });
  await add.getByLabel('Under').selectOption({ label: 'A40 Cash and bank' });
  await add.getByLabel('Code', { exact: true }).fill('A4002');
  await add.getByLabel('Name', { exact: true }).fill('SBI Current 1188');
  await add.getByLabel('Kind').selectOption({ label: 'Bank' });
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('rowgroup', { name: 'Chart of accounts' })).toContainText(
    'SBI Current 1188',
  );
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Patil Estates');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27AAAFP5678Q1Z1');
  await page.getByLabel('Account number').fill('50200012345678');
  await page.getByLabel('IFSC').fill('HDFC0000123');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Patil Estates')).toBeVisible();

  // 2. The site office rent: ₹50,000 + CGST and SGST 9% (₹4,500 each) = ₹59,000, posted at once.
  await nav('Payables');
  await page.getByRole('link', { name: 'Enter a bill' }).click();
  const bill = page.getByRole('form', { name: "Supplier's bill" });
  await bill.getByLabel('Supplier').selectOption({ label: 'Patil Estates' });
  await bill.getByLabel('Their bill no.').fill('PE/2026/07');
  await bill.getByLabel('Bill date').fill('2026-10-01');
  const line = bill.getByRole('group', { name: 'Bill line 1' });
  await line.getByLabel('Ledger').selectOption({ label: 'X7002 Rent' });
  await line.getByLabel('Description').fill('Site office rent, October');
  await line.getByLabel('Rate').fill('50000');
  await bill.getByRole('button', { name: 'Enter the bill' }).click();
  await page.waitForURL(/\/accounts\/vendor-bills\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Bill totals')).toContainText('Total ₹59,000.00');

  // 3. A run paying it in full: no approval rules, so approved on submission; the bank's file; paid.
  await nav('Payables');
  await page.getByRole('link', { name: 'New payment run' }).click();
  const run = page.getByRole('form', { name: 'Payment run' });
  await run.getByLabel('Pay from').selectOption({ label: 'A4002 SBI Current 1188' });
  await run
    .getByRole('rowgroup', { name: 'Bills to pay' })
    .getByRole('button', { name: 'All' })
    .click();
  await expect(run.getByLabel('Run total')).toHaveText('₹59,000.00');
  await run.getByRole('button', { name: 'Make the run' }).click();
  await page.waitForURL(/\/accounts\/payment-runs\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('approved', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Bank file' }).click();
  expect((await download).suggestedFilename()).toMatch(/^PR-\d{4}-\d{2}-0001\.csv$/);
  await page
    .getByRole('form', { name: 'Mark paid' })
    .getByRole('button', { name: 'Mark paid' })
    .click();
  await expect(page.getByText('paid', { exact: true })).toBeVisible();
  await expect(page.getByRole('rowgroup', { name: 'Paid to Patil Estates' })).toContainText(
    '₹59,000.00',
  );
  await shot(page, 'payables-01-paid');
  await nav('Payables');
  await expect(page.getByText('Nothing is owed.')).toBeVisible();
});
