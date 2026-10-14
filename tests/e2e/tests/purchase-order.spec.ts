// Wave 2b step 4 in a real browser: a purchase order to a supplier registered in the site's state, its rates before
// GST and CGST + SGST added on top; in force when submitted (no approval rule), acknowledged by the supplier, then
// amended (the amendment in force, the supplier to acknowledge it anew); in the orders register.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a purchase order with GST on top is issued, acknowledged and amended', async ({ page }) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `po-${Date.now()}@risod-traders.in`,
    'Purchase-Order-Gst-On-Top-4',
    'Risod Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A supplier registered in Maharashtra (GSTIN 27…).
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Vidarbha Cement Traders');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27AAACV1234F1Z5');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Vidarbha Cement Traders')).toBeVisible();

  // 2. A project with one site, in Maharashtra (GST state 27).
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Pump house, Risod');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('Site name').fill('Risod sump');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  // 3. A new purchase order to that supplier.
  await card(page, /^Orders/)
    .getByRole('button', { name: 'New order' })
    .click();
  await page
    .getByLabel('Vendor')
    .selectOption({ label: 'Vidarbha Cement Traders · 27AAACV1234F1Z5' });
  await page.getByRole('button', { name: 'Write the order' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { name: /^Purchase order PO\/\d{4}-\d{2}\/0001$/ }),
  ).toBeVisible();
  await expect(page.getByTestId('vendor-gstin')).toHaveText('GSTIN 27AAACV1234F1Z5');
  // The only site is filled in; same state as the supplier: CGST + SGST.
  await expect(page.getByTestId('draft-supply')).toHaveText('Within the state: CGST + SGST');

  // 4. 100 bags at ₹390.50 before GST, 18%: 39,050.00 + CGST 3,514.50 + SGST 3,514.50 = 46,079.00.
  await page.getByRole('button', { name: 'Line typed in' }).click();
  const line1 = page.getByRole('group', { name: 'Line 1' });
  await line1.getByLabel('Description').fill('Cement OPC 53');
  await line1.getByLabel('HSN/SAC').fill('2523');
  await line1.getByLabel('Unit').fill('bag');
  await line1.getByLabel('Quantity').fill('100');
  await line1.getByLabel('Rate ₹').fill('390.50');
  await expect(line1.getByLabel('GST %')).toHaveValue('18');
  await page.getByLabel('Payment terms').fill('30 days from receipt at site');
  const draft = page.getByTestId('draft-totals');
  await expect(draft).toContainText('₹39,050.00');
  await expect(draft).toContainText('₹3,514.50');
  await expect(draft).toContainText('₹46,079.00');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await shot(page, 'purchase-order-01-draft');

  // 5. Submitted: no approval rule applies, so it is in force and issued at once.
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  const totals = page.getByTestId('order-totals');
  await expect(totals.getByRole('row', { name: /^CGST/ })).toContainText('₹3,514.50');
  await expect(totals.getByRole('row', { name: /^SGST/ })).toContainText('₹3,514.50');
  await expect(totals.getByRole('row', { name: /^Total with GST/ })).toContainText('₹46,079.00');
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();

  // 6. The supplier accepts it.
  await page.getByLabel('Their reference').fill('VCT/26/118');
  await page.getByRole('button', { name: 'Acknowledged', exact: true }).click();
  await expect(page.getByTestId('acknowledged')).toContainText('(VCT/26/118)');
  await shot(page, 'purchase-order-02-issued');

  // 7. Amended to 120 bags: 46,860.00 + 18% = 55,294.80. In force at once; to be acknowledged again.
  page.once('dialog', (d) => void d.accept('20 bags more for the sump walls'));
  await page.getByRole('button', { name: 'Amend' }).click();
  await expect(page.getByRole('heading', { name: 'Amendment 1' })).toBeVisible();
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('120');
  await expect(page.getByTestId('draft-totals')).toContainText('₹55,294.80');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  await expect(
    page.getByTestId('order-totals').getByRole('row', { name: /^Total with GST/ }),
  ).toContainText('₹55,294.80');
  await expect(page.getByTestId('acknowledged')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Order revisions' })).toContainText('Superseded');

  // 8. In the orders register.
  await nav('Orders');
  await expect(page.getByRole('rowgroup', { name: 'Orders' })).toContainText('₹55,294.80');
  await expect(page.getByRole('rowgroup', { name: 'Orders' })).toContainText('Pump house, Risod');
  await shot(page, 'purchase-order-03-register');
});
