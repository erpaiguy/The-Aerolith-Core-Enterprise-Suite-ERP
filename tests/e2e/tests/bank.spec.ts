// Wave 3 step 7 in a real browser: a bank ledger's column mapping saved; a September statement imported (and refused
// the second time); its charges and interest made vouchers in one click; the reconciliation agreeing.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a statement imported, its lines posted and matched, the bank reconciled', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `bank-${Date.now()}@amravati-infra.in`,
    'Bank-Reconciliation-7',
    'Amravati Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
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

  // 1. SBI's columns, then September's statement: ₹59 charges and ₹412 interest.
  await nav('Bank');
  await page.getByLabel('From').fill('2026-09-01');
  await page.getByLabel('To').fill('2026-09-30');
  await page.getByRole('button', { name: 'Column mapping' }).click();
  await page
    .getByRole('form', { name: 'Column mapping' })
    .getByRole('button', { name: 'Save the mapping' })
    .click();
  await expect(page.getByRole('form', { name: 'Column mapping' })).toHaveCount(0);
  const file = {
    name: 'sbi-sept.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Txn Date,Description,Ref No,Debit,Credit,Balance\r\n' +
        '01/09/2026,OPENING,,,,"0.00"\r\n' +
        '30/09/2026,SMS CHARGES,,59.00,,-59.00\r\n' +
        '30/09/2026,INTEREST CREDIT,,,412.00,353.00\r\n',
    ),
  };
  await page.getByLabel('Statement file').setInputFiles(file);
  await expect(page.getByLabel('Import result')).toHaveText('2 lines imported.');
  await page.getByLabel('Statement file').setInputFiles(file);
  await expect(page.getByText('Every line of this statement was imported before.')).toBeVisible();

  // 2. Each made a voucher and matched.
  const lines = page.getByRole('rowgroup', { name: 'Statement lines' });
  for (const [what, ledger, narration] of [
    ['SMS CHARGES', 'X5002 Bank charges', 'SMS charges'],
    ['INTEREST CREDIT', 'I2001 Interest income', 'Interest on balance'],
  ] as const) {
    const g = page.getByRole('group', { name: `Match ${what}` });
    await g.getByRole('button', { name: 'Make a voucher' }).click();
    const form = g.getByRole('form', { name: 'Make a voucher' });
    await form.getByLabel('Ledger').selectOption({ label: ledger });
    await form.getByLabel('Narration').fill(narration);
    await form.getByRole('button', { name: 'Post and match' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Post and match' }).click();
    await expect(lines.getByRole('row').filter({ hasText: what })).toContainText(
      /(PV|RV)\/\d{4}-\d{2}\/0001/,
    );
  }

  // 3. The books and the statement agree at ₹353.
  const rec = page.getByRole('rowgroup', { name: 'Reconciliation' });
  await expect(rec.getByRole('row').filter({ hasText: 'Balance as per the books' })).toContainText(
    '₹353.00',
  );
  await expect(page.getByText('The books and the statement agree.')).toBeVisible();
  await shot(page, 'bank-01-reconciled');
});
