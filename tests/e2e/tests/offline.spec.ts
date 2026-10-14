// Wave 6 step 4 in a real browser, in a poor-signal area: the browser goes offline, a goods receipt is saved on the
// phone, the page is reloaded with no signal (the app from its cache, the person still signed in), the signal returns,
// the receipt is sent once and the outbox empties.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a receipt saved with no signal is sent once when the signal returns', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `offline-${Date.now()}@risod-traders.in`,
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

  // 2. The app is kept on the phone before the signal goes.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();

  // 3. No signal: the receipt is saved on the phone.
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const form = page.getByRole('form', { name: 'Receive goods' });
  await form.getByLabel('Challan no.').fill('VCT/DC/552');
  await form.getByRole('group', { name: 'Cement OPC 53' }).getByLabel('Came').fill('40');
  await form.getByRole('button', { name: 'Record the receipt' }).click();
  await expect(page.getByTestId('receipt-queued')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Outbox, 1 waiting' })).toBeVisible();

  // 4. Reloaded with no signal: the app opens from its cache, still signed in, the receipt still waiting.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Outbox, 1 waiting' })).toBeVisible();
  await page.getByRole('link', { name: 'Outbox, 1 waiting' }).click();
  await expect(page.getByRole('list', { name: 'Waiting to be sent' })).toContainText(
    'challan VCT/DC/552',
  );
  await shot(page, 'offline-01-outbox');

  // 5. The signal returns: sent once, the outbox empty, one receipt against the order.
  await context.setOffline(false);
  await expect(page.getByRole('link', { name: /^Outbox/ })).toHaveCount(0, { timeout: 45_000 });
  await page.goto(orderUrl);
  const progress = page.getByRole('rowgroup', { name: 'Received against the order' });
  await expect(progress.getByRole('row').filter({ hasText: 'Cement OPC 53' })).toContainText('60');
  await expect(card(page, 'Receipts')).toContainText(/GRN\/\d{4}-\d{2}\/0001/);
  await expect(card(page, 'Receipts')).not.toContainText(/GRN\/\d{4}-\d{2}\/0002/);
  await shot(page, 'offline-02-sent');
});
