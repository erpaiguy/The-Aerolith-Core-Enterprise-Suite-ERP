// Wave 6 step 2 in a real browser: a tower and a flat, the payment plan, the flat booked (its booking demand raised),
// the collection and designated accounts set, a receipt recorded and its 70% shown as due to the RERA account.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a flat booked on a payment plan, paid for, and the RERA share due', async ({ page }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `sales-${Date.now()}@baner-homes.in`,
    'Flat-Booking-Baner-52',
    'Baner Homes',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // Two bank ledgers: collections and the RERA designated account.
  await nav('Chart of accounts');
  for (const [code, name] of [
    ['A4002', 'HDFC Collection'],
    ['A4003', 'HDFC RERA Designated'],
  ]) {
    await page.getByRole('button', { name: 'Add an account' }).click();
    const add = page.getByRole('form', { name: 'New account' });
    await add.getByLabel('Under').selectOption({ label: 'A40 Cash and bank' });
    await add.getByLabel('Code', { exact: true }).fill(code!);
    await add.getByLabel('Name', { exact: true }).fill(name!);
    await add.getByLabel('Kind').selectOption({ label: 'Bank' });
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('rowgroup', { name: 'Chart of accounts' })).toContainText(name!);
  }
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Shanti Heights, Baner');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await nav('Sales and RERA');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByRole('tab', { name: 'Setup' }).click();
  const s = page.getByRole('form', { name: 'Sales setup' });
  await s.getByLabel('RERA registration').fill('P52100012345');
  await s.getByLabel('Collection account').selectOption({ label: 'A4002 HDFC Collection' });
  await s
    .getByLabel('Designated (RERA) account')
    .selectOption({ label: 'A4003 HDFC RERA Designated' });
  await s.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('tab', { name: 'Payment plan' }).click();
  await page
    .getByRole('form', { name: 'Plan stages' })
    .getByRole('button', { name: 'Save the plan' })
    .click();
  await expect(page.getByRole('list', { name: 'Plan' })).toContainText(
    'On booking: 10.00% on booking',
  );

  await page.getByRole('tab', { name: 'Inventory' }).click();
  const t = page.getByRole('form', { name: 'Add a tower' });
  await t.getByLabel('Tower name').fill('A');
  await t.getByLabel('Floors').fill('12');
  await t.getByRole('button', { name: 'Add tower' }).click();
  const u = page.getByRole('form', { name: 'New unit' });
  await u.getByLabel('Tower').selectOption({ label: 'A' });
  await u.getByLabel('Floor').fill('12');
  await u.getByLabel('Unit number').fill('1201');
  await u.getByLabel('Carpet m²').fill('65.5');
  await u.getByLabel('Rate per m² (₹)').fill('120000');
  await u.getByLabel('Parking (₹)').fill('300000');
  await u.getByRole('button', { name: 'Add unit' }).click();
  await page.getByRole('button', { name: 'Unit A-1201' }).click();
  await expect(page.getByTestId('unit-detail')).toContainText('₹81,60,000');

  const book = page.getByRole('form', { name: 'Book' });
  await book.getByLabel('Buyer').fill('Anil Kulkarni');
  await book.getByLabel('PAN').fill('ABCPK1234F');
  await book.getByRole('button', { name: 'Book' }).click();

  // The booking: 10% (₹8,16,000) plus 5% GST demanded at once.
  await page.getByRole('tab', { name: 'Bookings' }).click();
  await page.getByRole('row', { name: 'BK-001' }).getByRole('button', { name: 'BK-001' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Demands' })).toContainText('₹8,56,800');
  const r = page.getByRole('form', { name: 'Receipt' });
  await r.getByLabel('Amount (₹)').fill('856800');
  await r.getByLabel('UTR or cheque').fill('UTR0001');
  await r.getByRole('button', { name: 'Record receipt' }).click();
  await expect(page.getByTestId('booking-totals')).toContainText('received ₹8,56,800');
  // The cost sheet and the booking's demand letter (docs/wave7-plan.md step 7b.5).
  await page.getByRole('link', { name: 'Cost sheet' }).click();
  const sheet = page.getByRole('article', { name: 'Cost sheet' });
  await expect(sheet).toContainText('Anil Kulkarni');
  await expect(sheet).toContainText('₹81,60,000');
  await expect(sheet).toContainText('Payment plan');
  // Back on the screen, the project and the booking are chosen again.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByRole('tab', { name: 'Bookings' }).click();
  await page.getByRole('row', { name: 'BK-001' }).getByRole('button', { name: 'BK-001' }).click();
  await page
    .getByRole('rowgroup', { name: 'Demands' })
    .getByRole('link', { name: 'Letter' })
    .first()
    .click();
  await expect(page.getByRole('article', { name: 'Demand letter' })).toContainText('₹8,56,800');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByLabel('Project').selectOption({ index: 1 });

  // 70% of the ₹8,16,000 that is not GST is due to the designated account.
  await page.getByRole('tab', { name: 'RERA account' }).click();
  await expect(page.getByTestId('rera-figures')).toContainText('₹5,71,200');
  await shot(page, 'sales');
});
