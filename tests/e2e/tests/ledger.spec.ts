// Wave 3 step 1 in a real browser: the company's details and the date its books start; a bank ledger added to the
// chart; opening balances from an Excel sheet; a receipt and a journal (a difference shown until the sides agree); a
// voucher reversed; the trial balance and a ledger's running balance; a locked month refusing a voucher.
import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

async function openingWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Opening');
  ws.addRow(['Ledger', 'Debit', 'Credit']);
  ws.addRow(['E1001', null, 500000]);
  ws.addRow(['A4002', 350000, null]);
  ws.addRow(['Plant and machinery', 150000, null]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('the books: a company, the chart, opening balances, vouchers, a reversal, the trial balance, a lock', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `books-${Date.now()}@risod-infra.in`,
    'Double-Entry-Books-1',
    'Risod Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company: its GSTIN (the PAN comes from it) and the date its books start.
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const form = page.getByRole('form', { name: 'Edit company' });
  await form.getByLabel('Name', { exact: true }).fill('Risod Infra Pvt Ltd');
  await form.getByLabel('GSTIN').fill('27AAACR5055K1Z7');
  await form.getByLabel('Books start on').fill('2026-04-01');
  await form.getByRole('button', { name: 'Save' }).click();
  const companies = page.getByRole('rowgroup', { name: 'Companies' });
  await expect(companies).toContainText('Risod Infra Pvt Ltd');
  await expect(companies).toContainText('AAACR5055K');

  // 2. A bank ledger in the chart.
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

  // 3. Opening balances from Excel: checked, then posted.
  await nav('Books setup');
  await page.getByLabel('Opening balances workbook').setInputFiles({
    name: 'opening.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await openingWorkbook(),
  });
  const checked = page.getByLabel('Checked opening balances');
  await expect(checked).toContainText('3 balances: debit ₹5,00,000.00, credit ₹5,00,000.00.');
  await page.getByRole('button', { name: 'Post the opening balances' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Post the opening balances' })
    .click();
  await expect(page.getByText('Opening balances posted.')).toBeVisible();
  await expect(page.getByRole('rowgroup', { name: 'Opening balances' })).toContainText(
    'SBI Current 1188',
  );

  // 4. A receipt into the bank; a journal that shows its difference until the sides agree.
  await nav('Vouchers');
  await page.getByRole('link', { name: 'New voucher' }).click();
  const voucher = page.getByRole('form', { name: 'Voucher' });
  await voucher.getByLabel('Type').selectOption({ label: 'Receipt' });
  await voucher.getByLabel('Date').fill('2026-10-05');
  await voucher.getByLabel('Narration').fill('Further capital from the partners');
  const line = (n: number) => voucher.getByRole('group', { name: `Line ${n}` });
  await line(1).getByLabel('Ledger').selectOption({ label: 'A4002 SBI Current 1188' });
  await line(1).getByLabel('Debit').fill('1,00,000');
  await line(2).getByLabel('Ledger').selectOption({ label: 'E1001 Capital account' });
  await line(2).getByLabel('Credit').fill('90000');
  await expect(voucher.getByLabel('Totals')).toContainText('Difference 10,000.00');
  await expect(voucher.getByRole('button', { name: 'Post the voucher' })).toBeDisabled();
  await line(2).getByLabel('Credit').fill('100000');
  await voucher.getByRole('button', { name: 'Post the voucher' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Post the voucher' }).click();
  await page.waitForURL(/\/accounts\/vouchers\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /^Receipt RV\/2026-27\/0001$/ })).toBeVisible();

  // 5. Reversed: a new voucher with the lines the other way round.
  await page.getByRole('button', { name: 'Reverse' }).click();
  const rev = page.getByRole('form', { name: 'Reverse' });
  await rev.getByLabel('Date of the reversal').fill('2026-10-06');
  await rev.getByLabel('Why').fill('Entered in the wrong year');
  await rev.getByRole('button', { name: 'Reverse' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reverse the voucher' }).click();
  await expect(page.getByRole('heading', { name: /^Receipt RV\/2026-27\/0002$/ })).toBeVisible();
  await expect(page.getByText('Reverses RV/2026-27/0001')).toBeVisible();
  await shot(page, 'ledger-01-reversal');

  // 6. The trial balance as at 31 March 2027: ₹5,00,000 a side (the receipt and its reversal cancel out); the bank's
  // ledger with its running balance.
  await nav('Trial balance');
  await page.getByLabel('As at').fill('2027-03-31');
  const tb = page.getByRole('rowgroup', { name: 'Trial balance' });
  await expect(tb.getByRole('row').last()).toContainText('5,00,000.00');
  await tb.getByRole('link', { name: /SBI Current 1188/ }).click();
  await page.waitForURL(/\/accounts\/ledgers\//);
  const ledger = page.getByRole('rowgroup', { name: 'Ledger' });
  await expect(ledger.getByRole('row')).toHaveCount(4); // the opening balance, the receipt, its reversal, closing
  await expect(ledger.getByRole('row').last()).toContainText('3,50,000.00 Dr');
  await shot(page, 'ledger-02-ledger');

  // 7. October locked: a voucher dated in it is refused.
  await nav('Books setup');
  await page.getByLabel('Financial year').selectOption('2026-27');
  await page.getByRole('button', { name: 'Lock October 2026' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Lock the month' }).click();
  await expect(page.getByRole('button', { name: 'Reopen October 2026' })).toBeVisible();
  await nav('Vouchers');
  await page.getByRole('link', { name: 'New voucher' }).click();
  await voucher.getByLabel('Date').fill('2026-10-20');
  await line(1).getByLabel('Ledger').selectOption({ label: 'X7002 Rent' });
  await line(1).getByLabel('Debit').fill('5000');
  await line(2).getByLabel('Ledger').selectOption({ label: 'E1001 Capital account' });
  await line(2).getByLabel('Credit').fill('5000');
  await voucher.getByRole('button', { name: 'Post the voucher' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Post the voucher' }).click();
  await expect(page.getByText(/2026-10 is locked for this company/)).toBeVisible();
});
