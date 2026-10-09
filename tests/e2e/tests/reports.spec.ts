// Wave 1 step 12 (part 1) in a real browser: a BOQ's cost summary and rate analysis report on paper, its unpriced
// Excel, and the bid pipeline filtered and downloaded.
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);
const workbook = async (page: Page, click: () => Promise<void>) => {
  const downloading = page.waitForEvent('download');
  await click();
  const download = await downloading;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await download.path())!)) as unknown as ArrayBuffer);
  return { wb, name: download.suggestedFilename() };
};

test('an estimator prints the cost summary, sends an unpriced BOQ and reviews the pipeline', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `reports-${Date.now()}@wardha-infra.in`,
    'Plumb-Bob-Level-61',
    'Wardha Infra',
  );

  // A tender with an estimate and a BOQ: two sections, three items, one not priced yet.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Staff quarters, Wardha');
  await page.getByLabel('Estimated value (₹)').fill('250000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Staff quarters, Wardha' })).toBeVisible();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  const item = async (description: string, unit: string, qty: string, rate: string | null) => {
    await grid(page).press('Control+Enter');
    await page.getByLabel('Edit description').fill(description);
    await page.keyboard.press('Tab');
    await page.keyboard.type(unit);
    await page.keyboard.press('Tab');
    await page.keyboard.type(qty);
    await page.keyboard.press('Tab');
    if (rate) await page.keyboard.type(rate);
    await page.keyboard.press('Enter');
  };
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Masonry');
  await page.keyboard.press('Enter');
  await item('Brickwork 230 mm in CM 1:6', 'cum', '30', '6000');
  await item('Plaster 12 mm', 'sqm', '200', null);
  await expect(cell(page, 'Brickwork', 'amount')).toHaveText('1,80,000.00');
  await expect(page.getByTestId('boq-total')).toHaveText('₹1,80,000');
  const boqUrl = page.url();

  // 1. The cost summary: by section, and what the value is made of (no rate analysis yet: all "not analysed").
  await page.getByRole('button', { name: 'Reports' }).click();
  await page.getByRole('menuitem', { name: 'Cost summary' }).click();
  await expect(page.getByRole('heading', { name: 'Cost summary' })).toBeVisible();
  await expect(page.getByTestId('boq-total')).toHaveText('1,80,000.00');
  await expect(page.getByRole('row').filter({ hasText: 'Masonry' })).toContainText('100.00 %');
  await expect(
    page
      .getByRole('table', { name: 'Cost breakdown' })
      .getByRole('row')
      .filter({ hasText: 'Not analysed' }),
  ).toContainText('1,80,000.00');
  await expect(page.getByText('1 not priced')).toBeVisible();
  await expect(page.getByText('No pricing scenario is selected')).toBeVisible();
  await page.screenshot(shot('reports-01-cost-summary'));
  const summary = await workbook(page, () => page.getByRole('button', { name: 'Excel' }).click());
  expect(summary.name).toMatch(/Civil - cost summary\.xlsx$/);
  const cs = summary.wb.getWorksheet('Cost summary')!;
  expect(cs.getCell('A1').value).toBe('Cost summary: Civil');
  // Print hides the toolbar.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  // 2. The rate analysis report says plainly when nothing is linked.
  await page.getByRole('link', { name: 'Back to the BOQ' }).click();
  await page.getByRole('button', { name: 'Reports' }).click();
  await page.getByRole('menuitem', { name: 'Rate analyses' }).click();
  await expect(page.getByText('No item of this BOQ is linked to a rate analysis.')).toBeVisible();

  // 3. The unpriced BOQ for subcontractors: quantities, no rates or amounts.
  await page.goto(boqUrl);
  await page.getByRole('button', { name: 'Export' }).click();
  const unpriced = await workbook(page, () =>
    page.getByRole('menuitem', { name: 'Without rates (.xlsx)' }).click(),
  );
  expect(unpriced.name).toContain('unpriced');
  const rows: unknown[][] = [];
  unpriced.wb.worksheets[0]!.eachRow((r) => rows.push((r.values as unknown[]).slice(1, 9)));
  const brick = rows.find((r) => r[3] === 'Brickwork 230 mm in CM 1:6')!;
  expect(brick[5]).toBe(30);
  expect(brick[6] ?? null).toBeNull();
  expect(brick[7] ?? null).toBeNull();

  // 4. The bid pipeline, from the Reports page.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Reports' })
    .click();
  await page.getByRole('link', { name: /Bid pipeline/ }).click();
  await expect(page.getByRole('heading', { name: 'Bid pipeline' })).toBeVisible();
  await expect(page.getByTestId('pipeline-value')).toHaveText('2,50,000.00');
  await expect(page.getByRole('table', { name: 'Tenders' })).toContainText(
    'Staff quarters, Wardha',
  );
  await page.getByLabel('Status').selectOption('won');
  await expect(page.getByText('No tenders match.')).toBeVisible();
  await page.getByLabel('Status').selectOption('open');
  await expect(page.getByRole('table', { name: 'Tenders' })).toContainText(
    'Staff quarters, Wardha',
  );
  await page.screenshot(shot('reports-02-pipeline'));
  const pipeline = await workbook(page, () => page.getByRole('button', { name: 'Excel' }).click());
  const ws = pipeline.wb.getWorksheet('Bid pipeline')!;
  expect(ws.getRow(5).values).toContain('Our bid (₹)');
  expect(ws.getRow(6).getCell(2).value).toBe('Staff quarters, Wardha');
  expect(ws.getRow(6).getCell(7).value).toBe(250000);
});
