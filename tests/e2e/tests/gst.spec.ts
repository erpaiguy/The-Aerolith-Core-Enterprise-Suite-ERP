// Wave 3 step 6a in a real browser: a ledger whose input tax is blocked; a supplier's bill to it (its GST a cost);
// the GST page for the month: the inward register, GSTR-3B with the blocked tax reversed, and the supplier-filed
// GSTR-2B uploaded and matched against the purchase book.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test("input tax blocked by ledger, the month's GST and the 2B matched", async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `gst-${Date.now()}@akola-infra.in`,
    'Goods-Services-Tax-6',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company's GSTIN; a "Staff food" ledger with its input tax blocked; the hotel that feeds the site.
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('GSTIN').fill('27AAACA1234K1Z2');
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Companies' })).toContainText('27AAACA1234K1Z2');
  await nav('Chart of accounts');
  await page.getByRole('button', { name: 'Add an account' }).click();
  const add = page.getByRole('form', { name: 'New account' });
  await add.getByLabel('Under').selectOption({ label: 'X70 Other expenses' });
  await add.getByLabel('Code', { exact: true }).fill('X7010');
  await add.getByLabel('Name', { exact: true }).fill('Staff food');
  await add.getByLabel(/Input tax blocked/).check();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('rowgroup', { name: 'Chart of accounts' })).toContainText(
    'Staff food',
  );
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Hotel Sai');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27AAAFH3333C1Z9');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Hotel Sai')).toBeVisible();

  // 2. September's meals: ₹10,000 + CGST and SGST 9% = ₹11,800, all of it a cost.
  await nav('Payables');
  await page.getByRole('link', { name: 'Enter a bill' }).click();
  const bill = page.getByRole('form', { name: "Supplier's bill" });
  await bill.getByLabel('Supplier').selectOption({ label: 'Hotel Sai' });
  await bill.getByLabel('Their bill no.').fill('H-45');
  await bill.getByLabel('Bill date').fill('2026-09-16');
  const line = bill.getByRole('group', { name: 'Bill line 1' });
  await line.getByLabel('Ledger').selectOption({ label: 'X7010 Staff food' });
  await line.getByLabel('Description').fill('Site canteen, September');
  await line.getByLabel('Rate').fill('10000');
  await bill.getByRole('button', { name: 'Enter the bill' }).click();
  await page.waitForURL(/\/accounts\/vendor-bills\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();

  // 3. September on the GST page: the bill in the inward register with ₹1,800 blocked; GSTR-3B reverses it.
  await nav('GST');
  await page.getByLabel('Month').fill('2026-09');
  const inward = page.getByRole('rowgroup', { name: 'Inward register' });
  await expect(inward.getByRole('row').filter({ hasText: 'H-45' })).toContainText('₹1,800.00');
  const b3 = page.getByRole('rowgroup', { name: 'GSTR-3B' });
  await expect(b3.getByRole('row').filter({ hasText: '4(B)(1)' })).toContainText('₹900.00');
  await expect(b3.getByRole('row').filter({ hasText: '4(C)' })).toContainText('₹0.00');

  // 4. The 2B from the portal: the hotel's bill (written H45) matches; a transporter's is not in the books.
  await page.getByLabel('GSTR-2B file').setInputFiles({
    name: 'GSTR2B-092026.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        data: {
          rtnprd: '092026',
          docdata: {
            b2b: [
              {
                ctin: '27AAAFH3333C1Z9',
                trdnm: 'Hotel Sai',
                inv: [
                  { inum: 'H45', dt: '16-09-2026', val: 11800, txval: 10000, cgst: 900, sgst: 900 },
                ],
              },
              {
                ctin: '27AAAFX5555E1Z1',
                trdnm: 'Xpress Transport',
                inv: [
                  { inum: 'XT-7', dt: '20-09-2026', val: 5900, txval: 5000, cgst: 450, sgst: 450 },
                ],
              },
            ],
          },
        },
      }),
    ),
  });
  await expect(page.getByLabel('2B counts')).toContainText(
    '1 matched, 0 differ, 1 in 2B only, 0 not filed by the supplier.',
  );
  const recon = page.getByRole('rowgroup', { name: '2B reconciliation' });
  await expect(recon.getByRole('row').filter({ hasText: 'Xpress Transport' })).toContainText(
    'In 2B only',
  );
  await shot(page, 'gst-01-month');
});
