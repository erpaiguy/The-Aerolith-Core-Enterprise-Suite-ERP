// Wave 9a step 5 in a real browser: the orders list as a data grid shaped by the person — a column hidden, one frozen,
// compact rows — the same after a reload (kept in their settings on the server); the layout saved as a view; and the
// rows exported to Excel with the columns as shown.
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the orders grid keeps its layout, saves a view and exports to Excel', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `grids-${Date.now()}@washim-infra.in`,
    'Grid-Columns-Frozen-9',
    'Washim Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. One order on the list: a supplier, a project, a draft order of 10 bags at ₹400 + 18% GST.
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Karanja Cement Depot');
  await page.getByLabel('Client', { exact: true }).uncheck();
  await page.getByLabel('Vendor', { exact: true }).check();
  await page.getByLabel('GSTIN').fill('27AAACK7788F1Z5');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Karanja Cement Depot')).toBeVisible();

  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Water tank, Washim');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('Site name').fill('Tank site');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  await card(page, /^Orders/)
    .getByRole('button', { name: 'New order' })
    .click();
  await page.getByLabel('Vendor').selectOption({ label: 'Karanja Cement Depot · 27AAACK7788F1Z5' });
  await page.getByRole('button', { name: 'Write the order' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Line typed in' }).click();
  const line1 = page.getByRole('group', { name: 'Line 1' });
  await line1.getByLabel('Description').fill('Cement OPC 53');
  await line1.getByLabel('HSN/SAC').fill('2523');
  await line1.getByLabel('Unit').fill('bag');
  await line1.getByLabel('Quantity').fill('10');
  await line1.getByLabel('Rate ₹').fill('400');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  // 2. On the orders list: hide "Deliver by", freeze the first column, compact rows.
  await nav('Orders');
  const table = page.getByRole('table', { name: 'Orders' });
  await expect(page.getByRole('rowgroup', { name: 'Orders' })).toContainText('₹4,720.00');
  await expect(table.getByRole('columnheader', { name: 'Deliver by' })).toBeVisible();
  const columns = page.getByRole('button', { name: 'Columns' });
  await columns.click();
  await expect(columns).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('group', { name: 'Columns and layout' });
  await menu.getByRole('checkbox', { name: 'Deliver by' }).uncheck();
  await menu.getByLabel('Freeze columns').selectOption('1');
  const saved = page.waitForResponse(
    (r) => r.url().includes('/me/prefs/grid.orders') && r.request().method() === 'POST',
  );
  await menu.getByRole('radio', { name: 'Compact' }).check();
  await saved;
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(table.getByRole('columnheader', { name: 'Deliver by' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('rowgroup', { name: 'Orders' })).toContainText('₹4,720.00');
  await expect(table.getByRole('columnheader', { name: 'Deliver by' })).toHaveCount(0);
  await expect(table).toHaveAttribute('data-density', 'compact');
  await expect(table.getByRole('columnheader').first()).toHaveCSS('position', 'sticky');

  // 3. The layout saved as a view; Reset brings the default back; the view brings the layout back.
  await columns.click();
  await menu.getByLabel('View name').fill('Short list');
  await menu.getByRole('button', { name: 'Save view' }).click();
  await menu.getByRole('button', { name: 'Reset' }).click();
  await page.keyboard.press('Escape');
  await expect(table.getByRole('columnheader', { name: 'Deliver by' })).toBeVisible();
  await expect(table).toHaveAttribute('data-density', 'comfortable');
  await page.getByLabel('Saved view').selectOption('Short list');
  await expect(table.getByRole('columnheader', { name: 'Deliver by' })).toHaveCount(0);
  await expect(table).toHaveAttribute('data-density', 'compact');

  // 4. Sorted by amount, exported: the visible columns in the shown order, numbers as numbers.
  await table.getByRole('columnheader', { name: 'With GST' }).getByRole('button').click();
  await expect(table.getByRole('columnheader', { name: 'With GST' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export to Excel' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Orders.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await download.path())!)) as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0]!;
  expect(sheet.getRow(1).values).toEqual([undefined, 'Order', 'Project', 'With GST', 'Status']);
  const row = sheet.getRow(2);
  expect(String(row.getCell(1).value)).toMatch(/^PO\/\d{4}-\d{2}\/0001$/);
  expect(String(row.getCell(2).value)).toContain('Water tank, Washim');
  expect(row.getCell(3).value).toBe(4720);
  expect(row.getCell(4).value).toBe('Draft');
});
