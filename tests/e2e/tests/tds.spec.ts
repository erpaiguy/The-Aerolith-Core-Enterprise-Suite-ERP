// Wave 3 step 6b in a real browser: rent under 194I deducted on a landlord's bill; the TDS page for the quarter shows
// it to deposit; a challan recorded; the 26Q workbook for the return utility.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('TDS deducted on rent, deposited by challan, and the 26Q workbook', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `tds-${Date.now()}@nagpur-builders.in`,
    'Tax-Deducted-At-Source-6',
    'Nagpur Builders',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company's GSTIN and TAN; a bank ledger; the landlord, under 194I.
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('GSTIN').fill('27AAACN1234K1Z2');
  await company.getByLabel('TAN').fill('NGPA12345B');
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Companies' })).toContainText('NGPA12345B');
  await nav('Chart of accounts');
  await page.getByRole('button', { name: 'Add an account' }).click();
  const add = page.getByRole('form', { name: 'New account' });
  await add.getByLabel('Under').selectOption({ label: 'A40 Cash and bank' });
  await add.getByLabel('Code', { exact: true }).fill('A4002');
  await add.getByLabel('Name', { exact: true }).fill('SBI Current 7788');
  await add.getByLabel('Kind').selectOption({ label: 'Bank' });
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('rowgroup', { name: 'Chart of accounts' })).toContainText(
    'SBI Current 7788',
  );
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Patil Estates');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27AAAFP5678Q1Z1');
  await page.getByLabel('TDS section').selectOption('194I');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Patil Estates')).toBeVisible();

  // 2. The year's rent, ₹2,50,000 + 18%: over ₹2,40,000, so 10% TDS = ₹25,000.
  await nav('Payables');
  await page.getByRole('link', { name: 'Enter a bill' }).click();
  const bill = page.getByRole('form', { name: "Supplier's bill" });
  await bill.getByLabel('Supplier').selectOption({ label: 'Patil Estates' });
  await bill.getByLabel('Their bill no.').fill('PE/2026/01');
  await bill.getByLabel('Bill date').fill('2026-07-15');
  const line = bill.getByRole('group', { name: 'Bill line 1' });
  await line.getByLabel('Ledger').selectOption({ label: 'X7002 Rent' });
  await line.getByLabel('Description').fill('Site office rent, the year');
  await line.getByLabel('Rate').fill('250000');
  await bill.getByRole('button', { name: 'Enter the bill' }).click();
  await page.waitForURL(/\/accounts\/vendor-bills\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();

  // 3. July to September on the TDS page: to deposit; deposited by challan 0510308/00013.
  await nav('TDS');
  await page.getByLabel('Quarter').selectOption('2026-27-Q2');
  const rows = page.getByRole('rowgroup', { name: 'Deductions' });
  await expect(rows.getByRole('row').filter({ hasText: 'Patil Estates' })).toContainText(
    '₹25,000.00',
  );
  await expect(rows).toContainText('To deposit');
  await expect(page.getByRole('list', { name: '26Q problems' })).toContainText(
    '1 deduction is not yet in a challan.',
  );
  const challan = page.getByRole('form', { name: 'Challan' });
  await challan.getByLabel('Deposited on').fill('2026-08-07');
  await challan.getByLabel('BSR code').fill('0510308');
  await challan.getByLabel('Challan serial no.').fill('00013');
  await challan.getByRole('button', { name: 'Record the challan' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Challans' })).toContainText('₹25,000.00');
  await expect(rows).toContainText('0510308/00013');
  await expect(page.getByRole('list', { name: '26Q problems' })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '26Q for the return utility' }).click();
  expect((await download).suggestedFilename()).toBe('26Q-2026-27-Q2.xlsx');
  await shot(page, 'tds-01-deposited');
});
