// Wave 4 step 5 in a real browser: the client contract, its performance guarantee and an obligation on the
// calendar; the guarantee returned.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a contract, its guarantee and an obligation on the calendar', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `contracts-${Date.now()}@akola-infra.in`,
    'Contract-Calendar-45',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Akola');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await nav('Contracts and claims');
  await page.getByLabel('Project').selectOption({ index: 1 });
  const c = page.getByRole('form', { name: 'New contract' });
  await c.getByLabel('Reference').fill('ZP/AKL/2026/14');
  await c.getByLabel('Title').fill('Construction of a 100-bed hostel');
  await c.getByLabel('Value (₹)').fill('1000000');
  await c.getByLabel('Completion').fill('2027-03-31');
  await c.getByRole('button', { name: 'Add the contract' }).click();
  await expect(page.getByRole('row', { name: 'ZP/AKL/2026/14' })).toContainText('₹10,00,000');

  const s = page.getByRole('form', { name: 'New security' });
  await s.getByLabel('Issuer').fill('SBI Akola');
  await s.getByLabel('Number').fill('BG/0042');
  await s.getByLabel('Amount (₹)').fill('50000');
  await s.getByLabel('Valid until').fill('2027-06-30');
  await s.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('row', { name: 'performance BG/0042' })).toContainText('held');

  const o = page.getByRole('form', { name: 'New obligation' });
  await o.getByLabel('Obligation').fill('Submit the monthly progress report');
  await o.getByLabel('Clause').fill('GCC 12');
  await o.getByLabel('Due').fill('2026-11-05');
  await o.getByRole('button', { name: 'Add' }).click();
  const cal = page.getByTestId('contract-calendar');
  await expect(cal).toContainText(
    '2026-11-05 · Submit the monthly progress report (ZP/AKL/2026/14)',
  );
  await expect(cal).toContainText('2027-06-30 · Performance guarantee BG/0042 expires');
  await expect(cal).toContainText('2028-03-31 · Defects liability period ends');

  await page
    .getByRole('row', { name: 'performance BG/0042' })
    .getByRole('button', { name: 'Returned' })
    .click();
  await expect(page.getByRole('row', { name: 'performance BG/0042' })).toContainText('returned');
  await expect(cal).not.toContainText('BG/0042 expires');
  await shot(page, 'contracts');
});
