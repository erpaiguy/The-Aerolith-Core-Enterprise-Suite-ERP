// Wave 2b step 5 in a real browser: an issued purchase order received in part (bags burst at the gate, steel held for
// inspection), the steel inspected, the rejections returned to the supplier, then the rest received: the order closes
// itself; the receipt in the register.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('goods are received, inspected and returned, and the order closes when all has come', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `grn-${Date.now()}@risod-traders.in`,
    'Goods-Receipt-At-Site-5',
    'Risod Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A supplier, a project with a site, an issued order: 100 bags of cement and 1.235 t of steel.
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
  await page.getByLabel('Site name').fill('Risod sump');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');
  await card(page, /^Orders/)
    .getByRole('button', { name: 'New order' })
    .click();
  await page
    .getByLabel('Vendor')
    .selectOption({ label: 'Vidarbha Cement Traders · 27AAACV1234F1Z5' });
  await page.getByRole('button', { name: 'Write the order' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  for (const [i, [what, unit, qty, rate]] of [
    ['Cement OPC 53', 'bag', '100', '390'],
    ['TMT bars Fe 500D', 't', '1.235', '62000'],
  ].entries()) {
    await page.getByRole('button', { name: 'Line typed in' }).click();
    const line = page.getByRole('group', { name: `Line ${i + 1}` });
    await line.getByLabel('Description').fill(what!);
    await line.getByLabel('Unit').fill(unit!);
    await line.getByLabel('Quantity').fill(qty!);
    await line.getByLabel('Rate ₹').fill(rate!);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  const orderUrl = page.url();

  // 2. The first lorry: 60 bags, 2 burst at the gate; all the steel, held for a bend test.
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const form = page.getByRole('form', { name: 'Receive goods' });
  await form.getByLabel('Challan no.').fill('VCT/DC/441');
  await form.getByLabel('Vehicle no.').fill('MH37 T 1234');
  const cement = form.getByRole('group', { name: 'Cement OPC 53' });
  await cement.getByLabel('Came').fill('60');
  await cement.getByLabel('Rejected at the gate').fill('2');
  await cement.getByLabel('Why rejected').fill('Burst bags');
  const steel = form.getByRole('group', { name: 'TMT bars Fe 500D' });
  await steel.getByLabel('Came').fill('1.235');
  await steel.getByLabel('Hold for inspection').check();
  await form.getByRole('button', { name: 'Record the receipt' }).click();
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { name: /^Goods receipt GRN\/\d{4}-\d{2}\/0001$/ }),
  ).toBeVisible();
  const lines = page.getByRole('rowgroup', { name: 'Receipt lines' });
  await expect(lines.getByRole('row').filter({ hasText: 'Cement OPC 53' })).toContainText(
    'Burst bags',
  );
  await expect(lines.getByRole('row').filter({ hasText: 'TMT bars' })).toContainText(
    'Held for inspection',
  );
  await shot(page, 'receipt-01-held');

  // 3. The bend test: 1.2 t passes, 0.035 t is rejected.
  const inspect = page.getByRole('group', { name: 'Inspect TMT bars Fe 500D' });
  await inspect.getByLabel('Accepted', { exact: true }).fill('1.2');
  await inspect.getByLabel('Rejected', { exact: true }).fill('0.035');
  await inspect.getByLabel('Why rejected').fill('Bent bars');
  await page.getByRole('button', { name: 'Record the inspection' }).click();
  await expect(page.getByRole('form', { name: 'Inspection' })).toHaveCount(0);
  await expect(lines.getByRole('row').filter({ hasText: 'TMT bars' })).toContainText('Bent bars');

  // 4. The rejected bags and bars go back.
  const back = page.getByRole('form', { name: 'Return to supplier' });
  await back.getByLabel('Gate pass or debit note').fill('Gate pass 77');
  await back.getByLabel('Why it goes back').fill('Rejected on receipt');
  await back.getByRole('button', { name: 'Return to the supplier' }).click();
  await expect(page.getByRole('list', { name: 'Returns' })).toContainText(/RTV\/\d{4}-\d{2}\/0001/);
  await expect(back).toHaveCount(0);
  await shot(page, 'receipt-02-returned');

  // 5. On the order: still owed 42 bags (100 − 58 accepted) and 0.035 t.
  await page.goto(orderUrl);
  const progress = page.getByRole('rowgroup', { name: 'Received against the order' });
  await expect(progress.getByRole('row').filter({ hasText: 'Cement OPC 53' })).toContainText('42');
  await expect(progress.getByRole('row').filter({ hasText: 'TMT bars' })).toContainText('0.035');
  await expect(progress).toContainText('returned');

  // 6. The rest comes: the order closes itself.
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const rest = page.getByRole('form', { name: 'Receive goods' });
  await rest.getByLabel('Challan no.').fill('VCT/DC/458');
  await rest.getByRole('button', { name: 'Everything still owed' }).click();
  await expect(rest.getByRole('group', { name: 'Cement OPC 53' }).getByLabel('Came')).toHaveValue(
    '42',
  );
  await rest.getByRole('button', { name: 'Record the receipt' }).click();
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /\/0002$/ })).toBeVisible();
  await page.goto(orderUrl);
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await expect(page.getByText('Closed: Received in full')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Receive goods' })).toHaveCount(0);
  await shot(page, 'receipt-03-closed');

  // 7. In the register.
  await nav('Goods receipts');
  await expect(page.getByRole('rowgroup', { name: 'Goods receipts' }).getByRole('row')).toHaveCount(
    2,
  );
  await expect(page.getByRole('rowgroup', { name: 'Goods receipts' })).toContainText('VCT/DC/441');
});
