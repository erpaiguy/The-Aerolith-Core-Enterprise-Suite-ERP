// Wave 2b step 3 in a real browser: an approved requisition goes to vendors as the project's enquiry; two suppliers
// quote, the lowest is chosen per line; the enquiry is on the project's page and the requisition's, and changes no
// estimate.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test("a project's approved requisition goes to vendors and the lowest is chosen", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `penq-${Date.now()}@risod-traders.in`,
    'Supplier-Quote-Lowest-2',
    'Risod Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. Cement in the library; a project.
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
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Pump house, Risod');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();

  // 2. A requisition: 100 bags and 12 cum of sand; with no approval rule, approved when submitted.
  await card(page, /^Requisitions/)
    .getByRole('button', { name: 'New requisition' })
    .click();
  await page.getByLabel('What is it for?').fill('Cement and sand for the sump');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/requisitions\/[0-9a-f-]{36}$/);
  const requisitionUrl = page.url();
  await page.getByLabel('Find in the rate library').fill('CEM');
  await page.getByLabel('Resource', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('100');
  await page.getByRole('button', { name: 'Line typed in' }).click();
  const line2 = page.getByRole('group', { name: 'Line 2' });
  await line2.getByLabel('What').fill('River sand');
  await line2.getByLabel('Unit').fill('cum');
  await line2.getByLabel('Quantity').fill('12');
  await line2.getByLabel('Rate ₹').fill('1800');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();

  // 3. Ask vendors: the project's enquiry, its lines the requisition's.
  await page.getByRole('button', { name: 'Ask vendors' }).click();
  await page.waitForURL(/\/rfqs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('link', { name: /Pump house, Risod/ })).toBeVisible();
  const lines = page.getByRole('rowgroup', { name: 'RFQ lines' });
  await expect(lines.getByRole('row').filter({ hasText: 'Cement OPC 53' })).toContainText('100');
  await expect(page.getByTestId('line-requisitions-1')).toContainText(/PR\/\d{4}-\d{2}\/0001/);
  await expect(page.getByRole('button', { name: 'From requisitions' })).toBeVisible();

  // 4. Two suppliers quote; the lowest on each line is chosen.
  for (const name of ['Vidarbha Cement Traders', 'Washim Building Materials'])
    await (async () => {
      await page.getByLabel('Supplier').fill(name);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('listitem', { name })).toBeVisible();
    })();
  for (const [name, rates] of [
    ['Vidarbha Cement Traders', ['390', '1750']],
    ['Washim Building Materials', ['395', '1700']],
  ] as const) {
    await page
      .getByRole('listitem', { name })
      .getByRole('button', { name: `Type the quote of ${name}` })
      .click();
    const quote = page.getByRole('form', { name: `Quote of ${name}` });
    await quote.getByLabel('Rate for line 1').fill(rates[0]);
    await quote.getByLabel('Rate for line 2').fill(rates[1]);
    await quote.getByRole('button', { name: /Save quote \(2 of 2 lines\)/ }).click();
    await expect(quote).toBeHidden();
  }
  await page.getByRole('button', { name: 'Choose the lowest on every line' }).click();
  await expect(page.getByText('Chosen (2 of 2 lines)')).toBeVisible();
  // 100 × 390 + 12 × 1,700 = ₹59,400 before GST; no estimate is changed.
  await expect(page.getByText('₹59,400').first()).toBeVisible();
  await expect(page.getByTestId('rfq-next')).toContainText('changes no estimate');
  await expect(
    page.getByRole('button', { name: 'Put the chosen rates into the estimate' }),
  ).toHaveCount(0);
  await shot(page, 'project-rfq-01-comparative');

  // 5. On the project's page and the requisition's.
  await page.goto(projectUrl);
  await expect(card(page, /^Enquiries/).getByRole('rowgroup', { name: 'Enquiries' })).toContainText(
    '2 chosen',
  );
  await page.goto(requisitionUrl);
  await expect(page.getByRole('list', { name: 'Enquiries for it' })).toContainText(
    '2 of its lines',
  );
});
