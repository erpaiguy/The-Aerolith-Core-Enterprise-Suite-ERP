// Wave 2b steps 8 and 9 in a real browser: a delivery challan attached to a goods receipt (kept in the project's
// documents); the drawings register, a drawing's first revision superseded by the next; the project's vault keeping
// both; and the procurement reports: what the supplier still owes, as Excel, and company-wide.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

/** A small, valid one-page PDF with a line of text. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const file = (name: string, text: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: pdf(text),
});

test("a receipt's challan, the drawings register and the procurement reports", async ({ page }) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `drg-${Date.now()}@malegaon-infra.in`,
    'Drawings-And-Reports-8',
    'Malegaon Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A supplier, a project with a site, an issued order for 100 bags at ₹390.
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
  await page.getByLabel('Project name').fill('School, Malegaon');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  await page.getByLabel('Site name').fill('Malegaon');
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
  await page.getByRole('button', { name: 'Line typed in' }).click();
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByLabel('Description').fill('Cement OPC 53');
  await line.getByLabel('Unit').fill('bag');
  await line.getByLabel('Quantity').fill('100');
  await line.getByLabel('Rate ₹').fill('390');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();

  // 2. 60 bags come; the challan is attached to the receipt.
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const form = page.getByRole('form', { name: 'Receive goods' });
  await form.getByLabel('Challan no.').fill('VCT/DC/512');
  await form.getByRole('group', { name: 'Cement OPC 53' }).getByLabel('Came').fill('60');
  await form.getByRole('button', { name: 'Record the receipt' }).click();
  await page.waitForURL(/\/receipts\/[0-9a-f-]{36}$/);
  const grn = (await page.getByRole('heading', { name: /^Goods receipt / }).textContent())!.replace(
    'Goods receipt ',
    '',
  );
  await page
    .getByLabel(`Files for Goods receipt ${grn}`)
    .setInputFiles([file('Challan VCT-DC-512.pdf', 'Challan 512')]);
  await expect(page.getByRole('list', { name: `Documents of Goods receipt ${grn}` })).toContainText(
    'Challan VCT-DC-512.pdf',
  );
  await shot(page, 'project-docs-01-challan');

  // 3. The drawings register: A-101, its first revision for approval, then R1 good for construction.
  await page.goto(projectUrl);
  await page.getByRole('link', { name: 'Documents and drawings' }).click();
  await page.waitForURL(/\/documents$/);
  await page.getByRole('button', { name: 'Add a drawing' }).click();
  await page.getByLabel('Drawing number').fill('A-101');
  await page.getByLabel('Title').fill('Ground floor plan');
  await page.getByRole('button', { name: 'Add drawing', exact: true }).click();
  const drawings = page.getByRole('rowgroup', { name: 'Drawings' });
  await expect(drawings).toContainText('A-101');
  await expect(drawings).toContainText('None yet');
  const revise = async (rev: string, purpose: string, text: string) => {
    await page.getByLabel('Revision', { exact: true }).fill(rev);
    await page.getByLabel('Purpose').selectOption({ label: purpose });
    await page.getByLabel('Received from').fill('Kale Architects');
    await page.getByLabel('Drawing file').setInputFiles([file(`A-101 ${rev}.pdf`, text)]);
    await page.getByRole('button', { name: 'Add revision' }).click();
    await expect(page.getByRole('rowgroup', { name: 'Revisions' })).toContainText(rev);
  };
  await revise('R0', 'For approval', 'Ground floor R0');
  await revise('R1', 'Good for construction', 'Ground floor R1');
  const revisions = page.getByRole('rowgroup', { name: 'Revisions' }).getByRole('row');
  await expect(revisions).toHaveCount(2);
  await expect(revisions.nth(0)).toContainText('Current');
  await expect(revisions.nth(1)).toContainText('Superseded');
  await expect(drawings.getByRole('row').first()).toContainText('Good for construction');
  await expect(drawings.getByRole('row').first()).toContainText('2');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download revision R0' }).click();
  expect((await downloading).suggestedFilename()).toMatch(/A-101 Ground floor plan.*\.pdf$/);
  await shot(page, 'project-docs-02-drawings');

  // 4. The vault keeps both: the drawing under Drawings/Architectural, the challan under Receipts.
  await page.getByRole('tab', { name: 'All documents' }).click();
  const folders = page.getByRole('navigation', { name: 'Document folders' });
  await expect(folders).toContainText('Drawings');
  await expect(folders).toContainText('Receipts');
  await folders.getByRole('button', { name: /^Receipts/ }).click();
  await folders.getByRole('button', { name: new RegExp(`^${grn.replaceAll('/', '-')}`) }).click();
  await expect(page.getByRole('rowgroup', { name: 'Documents' })).toContainText(
    'Challan VCT-DC-512.pdf',
  );

  // 5. Procurement reports: 40 bags still owed, 40 × ₹390 = ₹15,600.00; as Excel.
  await page.goto(projectUrl);
  await page.getByRole('main').getByRole('link', { name: 'Procurement reports' }).click();
  await page.waitForURL(/\/procurement-reports$/);
  const owed = page.getByRole('rowgroup', { name: 'Open order lines' });
  await expect(owed.getByRole('row')).toHaveCount(1);
  await expect(owed).toContainText('Cement OPC 53');
  await expect(owed).toContainText('₹15,600.00');
  await expect(page.getByRole('rowgroup', { name: 'Suppliers' })).toContainText(
    'Vidarbha Cement Traders',
  );
  const excel = page.waitForEvent('download');
  await card(page, 'Open orders').getByRole('button', { name: 'Excel' }).click();
  expect((await excel).suggestedFilename()).toBe('Open orders.xlsx');
  await shot(page, 'procurement-reports-01-project');

  // 6. Company-wide, from the menu.
  await nav('Procurement reports');
  await expect(page.getByRole('rowgroup', { name: 'Open order lines' })).toContainText(
    'School, Malegaon',
  );
  await expect(page.getByRole('rowgroup', { name: 'Owed by supplier' })).toContainText(
    '₹15,600.00',
  );
});
