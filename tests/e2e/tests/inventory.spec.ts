// Wave 2b step 6 in a real browser: cement received into the site's store at the order rate, issued to a WBS element,
// part of it back from site, a reorder level and a requisition for the shortfall, a stock take posted, and the
// project's consumption.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('received cement is stocked, issued to work, returned, reordered and counted', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `inv-${Date.now()}@risod-traders.in`,
    'Stores-Ledger-Average-6',
    'Risod Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. Cement in the library, a supplier, a project with a site and a WBS element.
  await nav('Resources');
  await page.getByRole('button', { name: 'New resource' }).click();
  const form = card(page, 'New resource');
  await form.getByLabel('Code').fill('CEM-OPC53');
  await form.getByLabel('Name').fill('Cement OPC 53');
  await form.getByLabel('Type').selectOption('material');
  await form.getByLabel('Unit', { exact: true }).fill('bag');
  await form.getByLabel('Rate (₹)').fill('400');
  await page.getByRole('button', { name: 'Add resource' }).click();
  await expect(page.getByText('CEM-OPC53').first()).toBeVisible();
  await nav('Clients');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Vidarbha Cement Traders');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27AAACV1234F1Z5');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Vidarbha Cement Traders')).toBeVisible();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Pump house, Risod');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  await page.getByLabel('Site name').fill('Risod sump');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');
  await page.goto(`${projectUrl}/wbs`);
  await page.getByLabel('WBS code').fill('SUB');
  await page.getByLabel('WBS name').fill('Substructure');
  await page.getByRole('button', { name: 'Add element' }).click();
  await expect(page.getByRole('rowgroup', { name: 'WBS' })).toContainText('Substructure');

  // 2. An order for 100 bags at ₹390 from the library, issued and received in full.
  await page.goto(projectUrl);
  await card(page, /^Orders/)
    .getByRole('button', { name: 'New order' })
    .click();
  await page
    .getByLabel('Vendor')
    .selectOption({ label: 'Vidarbha Cement Traders · 27AAACV1234F1Z5' });
  await page.getByRole('button', { name: 'Write the order' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await page.getByLabel('Find in the rate library').fill('CEM');
  await page.getByLabel('Resource', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByLabel('Quantity').fill('100');
  await line.getByLabel('Rate ₹').fill('390');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const receive = page.getByRole('form', { name: 'Receive goods' });
  await receive.getByLabel('Challan no.').fill('VCT/DC/441');
  await receive.getByRole('button', { name: 'Everything still owed' }).click();
  await receive.getByRole('button', { name: 'Record the receipt' }).click();
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('link', { name: 'Risod sump store' })).toBeVisible();

  // 3. In the store: 100 bags, ₹39,000.
  await page.getByRole('link', { name: 'Risod sump store' }).click();
  await page.waitForURL(/\/stores\/[0-9a-f-]{36}$/);
  const storeUrl = page.url();
  const stock = page.getByRole('rowgroup', { name: 'Stock' });
  await expect(stock).toContainText('100 bag');
  await expect(stock).toContainText('₹39,000.00');

  // 4. 40 bags to the substructure: ₹15,600.
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  const issue = page.getByRole('form', { name: 'Issue' });
  await issue.getByLabel('For (WBS element)').selectOption({ label: 'SUB Substructure' });
  await issue.getByLabel('Taken by').fill('Ramesh (mason gang)');
  await issue.getByRole('group', { name: 'Issue Cement OPC 53' }).getByLabel('Quantity').fill('40');
  await issue.getByRole('button', { name: 'Issue', exact: true }).click();
  await page.waitForURL(/\/issues\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { name: /^Issue slip ISS\/\d{4}-\d{2}\/0001$/ }),
  ).toBeVisible();
  await expect(page.getByRole('rowgroup', { name: 'Issued' })).toContainText('₹15,600.00');

  // 5. 5 bags back unused: 65 bags, ₹25,350.
  await page.getByLabel('Back: Cement OPC 53').fill('5');
  await page.getByRole('button', { name: 'Back into the store' }).click();
  await expect(
    page.getByRole('rowgroup', { name: 'Issued' }).getByRole('row').first(),
  ).toContainText(/5$/);
  await shot(page, 'inventory-01-issue');
  await page.goto(storeUrl);
  await expect(stock).toContainText('65 bag');
  await expect(stock).toContainText('₹25,350.00');

  // 6. Reorder at 80: below, and a draft requisition for the 15 bags short.
  await page.getByLabel('Reorder level of Cement OPC 53').fill('80');
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  await expect(stock).toContainText('Below');
  await page.getByRole('button', { name: 'Requisition for what is short' }).click();
  await page.waitForURL(/\/requisitions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity')).toHaveValue(
    '15',
  );

  // 7. A stock take finds 63: two bags written off (no approval rule), 63 left.
  await page.goto(storeUrl);
  await page.getByRole('button', { name: 'Stock take' }).click();
  await page.waitForURL(/\/stock-counts\/[0-9a-f-]{36}$/);
  await page.getByLabel('Counted Cement OPC 53').fill('63');
  await page.getByLabel('Why Cement OPC 53').fill('Wet bags');
  await page.getByRole('button', { name: 'Save counts' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Count' })).toContainText('-₹780.00');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();
  await page.goto(storeUrl);
  await expect(stock).toContainText('63 bag');
  await expect(stock).toContainText('₹24,570.00');
  await page.getByRole('button', { name: 'Ledger' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Ledger' }).getByRole('row')).toHaveCount(4);
  await shot(page, 'inventory-02-store');

  // 8. The project's consumption: received 100, issued 35 (₹13,650), 63 in the store.
  await page.goto(`${projectUrl}/consumption`);
  const row = page.getByRole('rowgroup', { name: 'Consumption' }).getByRole('row').first();
  await expect(row).toContainText('₹13,650.00');
  await expect(row).toContainText('63');
  await expect(page.getByRole('rowgroup', { name: 'By WBS' })).toContainText('Substructure');
  await shot(page, 'inventory-03-consumption');
});
