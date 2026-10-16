// Wave 7c in a real browser (docs/wave7-plan.md): an order drafted from an approved requisition line, keeping the link;
// and the project's month-end and material pages that close the loop between site, stores and the estimate.
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('an order from a requisition line; the month-end and material pages', async ({ page }) => {
  test.setTimeout(200_000);
  await signInNewAdmin(
    page,
    `w7c-${Date.now()}@mehkar-builders.in`,
    'Loops-Mehkar-91',
    'Mehkar Builders',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // A supplier, and a project with an approved requisition for sand.
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mehkar Sand Suppliers');
  await page.getByLabel('Client').uncheck();
  await page.getByLabel('Vendor').check();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Mehkar Sand Suppliers' })).toBeVisible();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Mehkar');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  await card(page, /^Requisitions/)
    .getByRole('button', { name: 'New requisition' })
    .click();
  await page.getByLabel('What is it for?').fill('Sand for the footings');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/requisitions\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Line typed in' }).click();
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByLabel('What').fill('River sand');
  await line.getByLabel('Unit').fill('cum');
  await line.getByLabel('Quantity').fill('12');
  await line.getByLabel('Rate ₹').fill('1800');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();

  // The order, drafted from the line on the project's page (docs/wave7-plan.md step 7c.4).
  await page.goto(projectUrl);
  await card(page, /^Orders/)
    .getByRole('button', { name: 'From requisitions' })
    .click();
  const form = page.getByRole('form', { name: 'Order from requisitions' });
  await form.getByRole('checkbox').first().check();
  await form.getByLabel('Supplier').selectOption({ label: 'Mehkar Sand Suppliers' });
  await form.getByRole('button', { name: 'Draft the order' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('group', { name: 'Line 1' }).getByRole('textbox', { name: 'Description' }),
  ).toHaveValue('River sand');
  // Once ordered, the line is not offered again.
  await page.goto(projectUrl);
  await card(page, /^Orders/)
    .getByRole('button', { name: 'From requisitions' })
    .click();
  await expect(
    page.getByText('No approved requisition line is waiting to be ordered.'),
  ).toBeVisible();

  // Month-end from the daily reports (7c.1), and the material reconciliation and estimate against actual (7c.2-3).
  await page.goto(`${projectUrl}/progress`);
  await expect(card(page, 'From the daily reports')).toContainText(
    'No submitted daily report this month gives a quantity against a BOQ item.',
  );
  await page.goto(`${projectUrl}/consumption`);
  await expect(card(page, 'Reconciliation with measured work')).toContainText(
    'No material measured or issued in this period.',
  );
  await expect(card(page, 'Estimate against actual')).toContainText(
    'No measured item has a rate analysis yet.',
  );
});

test('a rate contract agreed with a supplier', async ({ page }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(page, `w7c5-${Date.now()}@lonar-infra.in`, 'Rates-Lonar-95', 'Lonar Infra');
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Resources');
  await page.getByRole('button', { name: 'New resource' }).click();
  const res = card(page, 'New resource');
  await res.getByLabel('Code').fill('CEM-OPC53');
  await res.getByLabel('Name').fill('Cement OPC 53');
  await res.getByLabel('Type').selectOption('material');
  await res.getByLabel('Unit', { exact: true }).fill('bag');
  await res.getByLabel('Rate (₹)').fill('400');
  await page.getByRole('button', { name: 'Add resource' }).click();
  await expect(page.getByText('CEM-OPC53').first()).toBeVisible();
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lonar Cement Depot');
  await page.getByLabel('Client').uncheck();
  await page.getByLabel('Vendor').check();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Lonar Cement Depot' })).toBeVisible();

  await nav('Rate contracts');
  await page.getByRole('button', { name: 'New rate contract' }).click();
  const form = page.getByRole('form', { name: 'New rate contract' });
  await form.getByLabel('Supplier').selectOption({ label: 'Lonar Cement Depot' });
  await form.getByLabel('Reference').fill('RC/26/01');
  const rate = form.getByRole('group', { name: 'Rate 1' });
  await rate.getByLabel('Material').selectOption({ index: 1 });
  await rate.getByLabel('Rate ₹ (before GST)').fill('385');
  await rate.getByLabel('GST %').selectOption('28');
  await rate.getByLabel('Up to (quantity)').fill('500');
  await form.getByRole('button', { name: 'Save the contract' }).click();
  const rows = page.getByRole('rowgroup', { name: 'Rates from Lonar Cement Depot' });
  await expect(rows).toContainText('Cement OPC 53');
  await expect(rows).toContainText('₹385');
  await expect(rows).toContainText('28%');
  await expect(rows).toContainText('500');
});

test("a month's close worked out from the books, then locked", async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `w7c6-${Date.now()}@chikhli-works.in`,
    'Close-Chikhli-96',
    'Chikhli Works',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Month-end close' })
    .click();
  await page.getByLabel('Month').fill('2026-09');
  const steps = page.getByRole('list', { name: 'Close steps' });
  await expect(steps.getByRole('listitem')).toHaveCount(7);
  await expect(steps).toContainText('None held.');
  await expect(steps).toContainText('No staff on the rolls.');
  await page.getByRole('button', { name: 'Lock the month' }).click();
  await expect(page.getByText('Locked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock the month' })).toHaveCount(0);
});

test('resources imported from an Excel sheet, checked first', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `w7c8-${Date.now()}@buldhana-civil.in`,
    'Imports-Buldhana-98',
    'Buldhana Civil',
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Resources');
  ws.addRow(['Code', 'Name', 'Type', 'Unit', 'Rate']);
  ws.addRow(['CEM-OPC53', 'Cement OPC 53', 'material', 'bag', 400]);
  ws.addRow(['SAND', 'River sand', 'material', 'cum', 1800]);
  ws.addRow(['X1', 'Something', 'magic', 'nos', '']);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Imports', exact: true })
    .click();
  const form = page.getByRole('form', { name: 'Import' });
  await form.getByLabel('What').selectOption('resources');
  await form.getByLabel('Excel workbook (.xlsx)').setInputFiles({
    name: 'resources.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  await form.getByRole('button', { name: 'Check the sheet' }).click();
  await expect(page.getByText('2 ready; 1 with problems')).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('Saved 2; 1 not saved')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Resources', exact: true })
    .click();
  await expect(page.getByText('River sand')).toBeVisible();
});
