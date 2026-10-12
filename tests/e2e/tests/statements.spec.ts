// Wave 3 step 8a in a real browser: three vouchers; the profit and loss and the balance sheet in Schedule III's
// lines; the cash flow; the year closed by the admin.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the statements for a year, and the year closed', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `fs-${Date.now()}@yavatmal-works.in`,
    'Financial-Statements-8',
    'Yavatmal Works',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();

  // Capital ₹50,000 in cash; rent ₹12,000; scrap sold for ₹20,000: a profit of ₹8,000, cash ₹58,000.
  for (const [type, date, dr, cr, amount] of [
    ['Receipt', '2026-04-10', 'A4001 Cash in hand', 'E1001 Capital account', '50000'],
    ['Payment', '2026-05-01', 'X7002 Rent', 'A4001 Cash in hand', '12000'],
    ['Receipt', '2026-06-01', 'A4001 Cash in hand', 'I2002 Scrap sales', '20000'],
  ] as const) {
    await nav('Vouchers');
    await page.getByRole('link', { name: 'New voucher' }).click();
    const voucher = page.getByRole('form', { name: 'Voucher' });
    await voucher.getByLabel('Type').selectOption({ label: type });
    await voucher.getByLabel('Date').fill(date);
    const line = (n: number) => voucher.getByRole('group', { name: `Line ${n}` });
    await line(1).getByLabel('Ledger').selectOption({ label: dr });
    await line(1).getByLabel('Debit').fill(amount);
    await line(2).getByLabel('Ledger').selectOption({ label: cr });
    await line(2).getByLabel('Credit').fill(amount);
    await voucher.getByRole('button', { name: 'Post the voucher' }).click();
    await page.waitForURL(/\/accounts\/vouchers\/[0-9a-f-]{36}$/);
  }

  await nav('Statements');
  await page.getByLabel('From').fill('2026-04-01');
  await page.getByLabel('To').fill('2027-03-31');
  const pl = page.getByRole('rowgroup', { name: 'Profit and loss' });
  await expect(pl.getByRole('row').filter({ hasText: 'Other income' })).toContainText('₹20,000.00');
  await expect(pl.getByRole('row').filter({ hasText: 'Profit for the period' })).toContainText(
    '₹8,000.00',
  );
  await page.getByRole('tab', { name: 'Balance sheet' }).click();
  const bs = page.getByRole('rowgroup', { name: 'Balance sheet' });
  await expect(bs.getByRole('row').filter({ hasText: 'Total assets' })).toContainText('₹58,000.00');
  await expect(bs.getByRole('row').filter({ hasText: 'Other equity' })).toContainText('₹8,000.00');
  await page.getByRole('tab', { name: 'Cash flow' }).click();
  await expect(
    page
      .getByRole('rowgroup', { name: 'Cash flow' })
      .getByRole('row')
      .filter({ hasText: 'Cash and bank at the end' }),
  ).toContainText('₹58,000.00');
  await shot(page, 'statements-01-cash-flow');

  // The admin closes 2026-27.
  await page.getByRole('tab', { name: 'Year end' }).click();
  const close = page.getByRole('form', { name: 'Close a year' });
  await close.getByLabel('Financial year').fill('2026-27');
  page.once('dialog', (d) => void d.accept());
  await close.getByRole('button', { name: 'Close the year' }).click();
  await expect(page.getByText('2026-27 closed: profit ₹8,000.00.')).toBeVisible();
});
