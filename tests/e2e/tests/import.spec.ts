// Wave 1 step 4 in a real browser: import a messy CSV through the wizard (detected columns, errors, skipping them),
// export the BOQ to Excel, and import that file into a second BOQ with the same lines and total.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });

const CSV =
  '﻿Name of work: Primary school, Wardha\r\n' +
  'Sl. No.;Description of item;Unit;Qty.;Rate (Rs.);Amount (Rs.)\r\n' +
  '1;EARTHWORK;;;;\r\n' +
  '1.1;"Excavation in ordinary soil,\nincluding disposal up to 50 m";Cu.M;120.5;350;42175\r\n' +
  '1.2;Backfilling;m3;80;210.25;16820\r\n' +
  '2;CONCRETE;;;;\r\n' +
  '2.1;PCC 1:4:8;cum;12.5;5200;65000\r\n' +
  '2.2;RCC M25;cum;"1.200,5";7850;\r\n' +
  '2.3;Reinforcement;MT;4.25;72000;306000\r\n';

async function newBoq(page: Page, name: string) {
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('an estimator imports a BOQ from a spreadsheet and exports it back', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `import-${Date.now()}@wardha-builders.in`,
    'Shuttering-Plate-38',
    'Wardha Builders',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Primary school, Wardha');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await newBoq(page, 'From the department');

  // 1. Upload: the header row (below a title row), columns and numbering are detected.
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByLabel('BOQ file').setInputFiles({
    name: 'schedule-b.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
  await expect(page.getByText('schedule-b.csv')).toBeVisible();
  await expect(page.getByLabel('Header row')).toHaveValue('2');
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Quantity')).toHaveValue('3');
  await expect(page.getByLabel('Sections')).toHaveValue('numbering');
  await expect(page.getByRole('table', { name: 'File preview' })).toContainText('Excavation');
  await page.screenshot(shot('import-01-mapping'));

  // 2. Check: one bad quantity (a European decimal comma) is an error; import is blocked until it is skipped.
  await page.getByRole('button', { name: 'Check file' }).click();
  const summary = page.getByTestId('import-summary');
  await expect(summary).toContainText('Lines to import');
  await expect(summary).toContainText('6');
  await expect(page.getByRole('table', { name: 'Issues' })).toContainText(
    'Quantity "1.200,5" is not a number',
  );
  const importButton = page.getByRole('button', { name: /^Import \d+ lines$/ });
  await expect(importButton).toBeDisabled();
  await page.getByLabel('Import without the rows that have errors').check();
  await page.screenshot(shot('import-02-checked'));
  await importButton.click();

  // 3. The grid shows the imported tree; units were normalised; the total is exact.
  await expect(grid(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('boq-total')).toHaveText('₹4,29,995');
  await expect(grid(page).getByRole('row').filter({ hasText: 'Backfilling' })).toContainText('cum');
  await expect(grid(page).getByRole('row').filter({ hasText: 'RCC M25' })).toHaveCount(0);
  // With lines in it, the BOQ takes a revised BOQ instead (step 8).
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import revised BOQ' })).toBeVisible();
  await page.screenshot(shot('import-03-imported'));

  // 4. Export to Excel and import that file into a second BOQ: same lines, same total.
  await page.getByRole('button', { name: 'Export' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/From the department\.xlsx$/);
  const file = await readFile((await download.path())!);

  await page
    .getByRole('link', { name: /Primary school, Wardha/ })
    .first()
    .click();
  await newBoq(page, 'Round trip');
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByLabel('BOQ file').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: file,
  });
  await expect(page.getByLabel('Sections')).toHaveValue('level');
  await page.getByRole('button', { name: 'Check file' }).click();
  await page.getByRole('button', { name: 'Import 6 lines' }).click();
  await expect(page.getByTestId('boq-total')).toHaveText('₹4,29,995', { timeout: 30_000 });
  await expect(
    grid(page).getByRole('row').filter({ hasText: 'Excavation in ordinary soil' }),
  ).toHaveCount(1);
});
