// Wave 8a and 8b in a real browser (docs/wave8-plan.md): the new accounts pages open for a fresh company; a supplier
// marked for reverse charge and as a micro enterprise; a lower-deduction certificate entered on the TDS page.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the money and tax pages of Wave 8', async ({ page }) => {
  test.setTimeout(200_000);
  await signInNewAdmin(
    page,
    `w8-${Date.now()}@karanja-builders.in`,
    'Gaps-Karanja-82',
    'Karanja Builders',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // A transporter under reverse charge, a micro enterprise on Udyam.
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Karanja Roadlines');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GST reverse charge').selectOption({ label: 'Goods transport agency' });
  await page.getByLabel('MSME (Udyam)').selectOption({ label: 'Micro' });
  await page.getByLabel('Udyam number').fill('UDYAM-MH-12-0012345');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Karanja Roadlines' })).toBeVisible();

  // The pages of 8a.
  await page.goto('/accounts/revenue-recognition');
  await expect(page.getByRole('heading', { name: 'Revenue on work done' })).toBeVisible();
  await page.goto('/accounts/month-end-accruals');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/accounts/debit-note-proposals');
  await expect(page.getByRole('heading', { name: 'Debit notes to raise' })).toBeVisible();
  await expect(page.getByText('Nothing to debit: the bills match the orders.')).toBeVisible();

  // 8b: GSTR-3B with reverse charge and Rule 37; MSME in payables; certificates on the TDS page.
  await page.goto('/accounts/gst');
  await expect(page.getByRole('rowgroup', { name: 'GSTR-3B' })).toContainText(
    '3.1(d) Inward supplies under reverse charge',
  );
  await expect(card(page, /Rule 37/)).toContainText('No bill has gone 180 days unpaid.');
  await page.goto('/accounts/payables');
  await expect(card(page, 'MSME suppliers: the 45 days')).toBeVisible();
  await page.goto('/accounts/tds');
  const certs = card(page, 'Lower-deduction certificates (section 197)');
  await certs.getByRole('button', { name: 'Add a certificate' }).click();
  const form = page.getByRole('form', { name: 'Lower-deduction certificate' });
  await form.getByLabel('Supplier').selectOption({ label: 'Karanja Roadlines' });
  await form.getByLabel('Certificate no.').fill('LDC/2026/9001');
  await form.getByLabel('Rate %').fill('0.5');
  await form.getByLabel('Up to ₹').fill('500000');
  await form.getByLabel('To', { exact: true }).fill('2027-03-31');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Certificates' })).toContainText('LDC/2026/9001');
  await expect(card(page, 'Return files and certificates')).toBeVisible();
});
