// Wave 9a step 7 in a real browser (docs/wave9-plan.md): one purchase walked from its requisition to the supplier's
// bill, the strip on each page saying where it stands — the stage it waits on marked as the current step, in words —
// and linking to the documents before and after.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });
const strip = (page: Page) => page.getByRole('list', { name: 'Where this stands' });
const stage = (page: Page, label: string) =>
  strip(page)
    .locator(':scope > li')
    .filter({ hasText: new RegExp(`^${label}`) });
/** The stages' words, in order, e.g. "Order Done · this page". */
const expectStages = async (page: Page, want: [string, string][]) => {
  for (const [label, words] of want) await expect(stage(page, label)).toContainText(words);
};

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the strip follows a purchase from requisition to bill', async ({ page }) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `flow-${Date.now()}@risod-traders.in`,
    'Flow-Strip-Risod-97',
    'Risod Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A supplier in Maharashtra, and a project with one site there.
  await nav('Parties');
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

  // 2. A requisition for 100 bags, approved when submitted: the order is what it waits on.
  await card(page, /^Requisitions/)
    .getByRole('button', { name: 'New requisition' })
    .click();
  await page.getByLabel('What is it for?').fill('Cement for the sump walls');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/requisitions\/[0-9a-f-]{36}$/);
  const requisitionUrl = page.url();
  await page.getByLabel('Site', { exact: true }).selectOption({ label: 'Risod sump' });
  await page.getByRole('button', { name: 'Line typed in' }).click();
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByLabel('What').fill('Cement OPC 53');
  await line.getByLabel('Unit').fill('bag');
  await line.getByLabel('Quantity').fill('100');
  await line.getByLabel('Rate ₹').fill('390');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await expect(strip(page).locator(':scope > li')).toHaveCount(5);
  await expectStages(page, [
    ['Requisition', 'Done · this page'],
    ['Order', 'Now'],
    ['Goods receipt', 'Not yet'],
    ['Supplier bill', 'Not yet'],
    ['Payment', 'Not yet'],
  ]);
  await expect(strip(page).locator(':scope > li[aria-current="step"]')).toHaveText(/^Order/);
  await shot(page, 'flows-01-requisition');

  // 3. The order, drafted from the requisition line and issued: the strip links back to the requisition.
  await page.goto(projectUrl);
  await card(page, /^Orders/)
    .getByRole('button', { name: 'From requisitions' })
    .click();
  const form = page.getByRole('form', { name: 'Order from requisitions' });
  await form.getByRole('checkbox').first().check();
  await form.getByLabel('Supplier').selectOption({ label: 'Vidarbha Cement Traders' });
  await form.getByRole('button', { name: 'Draft the order' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = page.url();
  await expectStages(page, [
    ['Requisition', 'Done'],
    ['Order', 'Now · this page'],
  ]);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  await expectStages(page, [
    ['Requisition', 'Done'],
    ['Order', 'Done · this page'],
    ['Goods receipt', 'Now'],
    ['Supplier bill', 'Not yet'],
  ]);
  const requisitionLink = stage(page, 'Requisition').getByRole('link', { name: /^PR\// });
  await expect(requisitionLink).toBeVisible();
  await shot(page, 'flows-02-order');

  // 4. 60 bags come: receiving is under way, one receipt.
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const receive = page.getByRole('form', { name: 'Receive goods' });
  await receive.getByLabel('Challan no.').fill('VCT/DC/441');
  await receive.getByRole('group', { name: 'Cement OPC 53' }).getByLabel('Came').fill('60');
  await receive.getByRole('button', { name: 'Record the receipt' }).click();
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/);
  await expectStages(page, [
    ['Order', 'Done'],
    ['Goods receipt', 'Now · this page'],
  ]);
  await expect(strip(page).locator(':scope > li[aria-current="step"]')).toHaveText(
    /^Goods receipt/,
  );
  await expect(stage(page, 'Order').getByRole('link', { name: /^PO\// })).toBeVisible();

  // 5. The other 40: received in full, the bill is what it waits on; both receipts listed.
  await page.goto(orderUrl);
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const rest = page.getByRole('form', { name: 'Receive goods' });
  await rest.getByLabel('Challan no.').fill('VCT/DC/458');
  await rest.getByRole('button', { name: 'Everything still owed' }).click();
  await rest.getByRole('button', { name: 'Record the receipt' }).click();
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /\/0002$/ })).toBeVisible();
  await expectStages(page, [
    ['Goods receipt', 'Done · this page · 2 receipts'],
    ['Supplier bill', 'Now'],
  ]);
  await expect(stage(page, 'Goods receipt').getByRole('link', { name: /^GRN\// })).toHaveCount(1);
  await shot(page, 'flows-03-receipt');

  // 6. The supplier's bill against the order, matched to what came and posted: payment is what it waits on.
  await nav('Payables');
  await page.getByRole('link', { name: 'Enter a bill' }).click();
  const bill = page.getByRole('form', { name: "Supplier's bill" });
  await bill.getByLabel('Supplier').selectOption({ label: 'Vidarbha Cement Traders' });
  await bill.getByLabel('Against an order').selectOption({ index: 1 });
  await bill.getByLabel('Their bill no.').fill('V/101');
  await bill.getByLabel('Bill date').fill('2026-10-01');
  await bill.getByRole('button', { name: 'Enter the bill' }).click();
  await page.waitForURL(/\/accounts\/vendor-bills\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();
  await expectStages(page, [
    ['Requisition', 'Done'],
    ['Order', 'Done'],
    ['Goods receipt', 'Done'],
    ['Supplier bill', 'Done · this page'],
    ['Payment', 'Now'],
  ]);
  await shot(page, 'flows-04-bill');

  // 7. Back along the chain: from the bill to the requisition, which now shows the whole way to the bill.
  await stage(page, 'Requisition').getByRole('link', { name: /^PR\// }).click();
  await page.waitForURL(requisitionUrl);
  await expectStages(page, [
    ['Requisition', 'Done · this page'],
    ['Order', 'Done'],
    ['Goods receipt', 'Done'],
    ['Supplier bill', 'Done'],
    ['Payment', 'Now'],
  ]);
  await expect(stage(page, 'Supplier bill').getByRole('link', { name: 'V/101' })).toBeVisible();
});
