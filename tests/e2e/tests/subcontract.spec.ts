// Wave 3 step 5 in a real browser: a work order to a subcontractor with 5% retention; its measurement book (an entry
// made by mistake and reversed); an RA bill with a back-charge, certified with no approval rules and so straight into
// payables as a supplier's bill.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a subcontractor measured, billed with deductions and certified into payables', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `sc-${Date.now()}@akola-infra.in`,
    'Subcontract-RA-Bill-5',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company's GSTIN and books; the subcontractor; a project with its site.
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('GSTIN').fill('27AAACA1234K1Z2');
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Companies' })).toContainText('27AAACA1234K1Z2');
  await nav('Clients');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kale Constructions');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Subcontractor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27ABCPK1234L1Z5');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Kale Constructions')).toBeVisible();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('School, Akola');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('Site name').fill('Akola');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  // 2. The work order: brickwork, 10 cum at ₹4,500 + 18% GST; issued.
  await card(page, /^Orders/)
    .getByRole('button', { name: 'New order' })
    .click();
  await page.getByLabel('Kind').selectOption('work');
  await page
    .getByLabel('Subcontractor')
    .selectOption({ label: 'Kale Constructions · 27ABCPK1234L1Z5' });
  await page.getByRole('button', { name: 'Write the order' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Line typed in' }).click();
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByLabel('Description').fill('Brickwork 230 mm');
  await line.getByLabel('Unit').fill('cum');
  await line.getByLabel('Quantity').fill('10');
  await line.getByLabel('Rate ₹').fill('4500');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();

  // 3. Terms: 5% retention. The book: 6 cum, and 1 by mistake, reversed.
  const terms = page.getByRole('form', { name: 'Subcontract terms' });
  await terms.getByLabel('Retention %').fill('5');
  await terms.getByRole('button', { name: 'Save terms' }).click();
  await expect(terms.getByRole('button', { name: 'Save terms' })).toBeEnabled();
  const measure = page.getByRole('form', { name: 'Measure' });
  const quantities = page.getByRole('rowgroup', { name: 'Work order quantities' });
  await measure.getByLabel('Quantity').fill('6');
  await measure.getByLabel('Where, what').fill('Ground floor walls');
  await measure.getByRole('button', { name: 'Record' }).click();
  await expect(quantities).toContainText('6');
  await measure.getByLabel('Quantity').fill('1');
  await measure.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByRole('list', { name: 'Book entries' }).getByRole('listitem')).toHaveCount(
    2,
  );
  page.once('dialog', (d) => void d.accept('Wrong wing'));
  await page
    .getByRole('button', { name: /^Reverse the entry/ })
    .nth(1)
    .click();
  await expect(page.getByRole('list', { name: 'Book entries' })).toContainText(
    'Reversed: Wrong wing',
  );
  await expect(quantities.getByRole('cell').nth(2)).toHaveText('6');
  await shot(page, 'subcontract-01-book');

  // 4. RA 1: 6 × 4,500 = 27,000 + CGST and SGST 2,430 each = 31,860; less retention 1,350, debris clearance 500 and
  // labour cess 1% 270 (no TDS: under ₹30,000): ₹29,740 to pay.
  await page
    .getByRole('form', { name: 'New subcontract bill' })
    .getByRole('button', { name: 'New RA bill' })
    .click();
  await page.waitForURL(/\/subcontract-bills\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Add a back-charge' }).click();
  const charge = page.getByRole('group', { name: 'Back-charge 1' });
  await charge.getByLabel('What').fill('Debris clearance');
  await charge.getByLabel('Amount').fill('500');
  await charge.getByLabel('Ledger').selectOption({ label: 'X3004 Site overheads' });
  await page.getByRole('button', { name: 'Save and work out' }).click();
  const abstract = page.getByRole('rowgroup', { name: 'Abstract' });
  await expect(abstract.getByRole('row').filter({ hasText: 'Net to pay' })).toContainText(
    '₹29,740.00',
  );
  await expect(abstract.getByRole('row').filter({ hasText: 'Bill total' })).toContainText(
    '₹31,860.00',
  );
  await page.getByRole('button', { name: 'Submit for certification' }).click();
  await expect(page.getByText('Certified', { exact: true })).toBeVisible();
  await shot(page, 'subcontract-02-certified');

  // 5. In payables: posted, ₹29,740 outstanding.
  await page.getByRole('link', { name: /\/RA-1$/ }).click();
  await page.waitForURL(/\/accounts\/vendor-bills\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();
  await expect(page.getByText('₹29,740.00').first()).toBeVisible();
});
