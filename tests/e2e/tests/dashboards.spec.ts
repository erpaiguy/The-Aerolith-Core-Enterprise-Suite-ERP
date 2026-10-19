// Wave 1 step 12 (part 2) in a real browser: the tender dashboard's headline numbers and charts, a tile of one's own
// added and kept, a tile opening the report behind it, the estimation dashboard, and the Excel download.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { signInNewAdmin } from './helpers.js';

// The ECharts version the web app ships, so the notice check follows upgrades.
const echartsVersion = (
  createRequire(import.meta.url)('../../../apps/web/package.json') as {
    dependencies: Record<string, string>;
  }
).dependencies.echarts;

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const local = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T11:00`;

test('an estimator reads the dashboards, adds a tile and drills into the pipeline', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `dash-${Date.now()}@akola-projects.in`,
    'Tie-Wire-Spacer-27',
    'Akola Projects',
  );

  // Two tenders: one due in five days (₹2.5 lakh), one later (₹40 lakh).
  for (const [title, value, days] of [
    ['Gram panchayat office, Akot', '250000', 5],
    ['District hospital annexe, Akola', '4000000', 40],
  ] as const) {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Tenders' })
      .click();
    await page.getByRole('button', { name: 'New tender' }).click();
    await page.getByLabel('Tender title').fill(title);
    await page.getByLabel('Estimated value (₹)').fill(value);
    await page.getByLabel('Submission due').fill(local(new Date(Date.now() + days * 86_400_000)));
    await page.getByRole('button', { name: 'Create tender' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }

  // 1. The three headline numbers, as of now.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Bid dashboard' })
    .click();
  await expect(page.getByRole('heading', { name: 'Tenders and bids' })).toBeVisible();
  await expect(page.getByTestId('tile-deadlines')).toHaveText('1');
  await expect(page.getByTestId('tile-pipeline_value')).toHaveText('₹42.5 L');
  await expect(page.getByTestId('tile-security_expiries')).toHaveText('0');
  await expect(page.getByTestId('as-of')).toContainText('As of');
  await expect(page.getByRole('list', { name: 'Next 30 days' })).toContainText(
    'Gram panchayat office, Akot',
  );
  await expect(
    page.getByRole('img', { name: 'Tenders and their estimates by stage' }),
  ).toBeVisible();

  // 2. A tile of my own: open tenders. It stays after a reload.
  await page.getByRole('button', { name: 'Tiles' }).click();
  await page.getByLabel('Add a tile').selectOption({ label: 'Open tenders' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Add a tile').selectOption({ label: 'Bids being prepared' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Move Bids being prepared up' }).click();
  await page.getByRole('button', { name: 'Save tiles' }).click();
  await expect(page.getByTestId('tile-open_tenders')).toHaveText('2');
  await page.reload();
  const mine = page.getByRole('region', { name: 'My tiles' });
  await expect(mine.getByTestId('tile-open_tenders')).toHaveText('2');
  await expect(mine.locator('[data-testid^="tile-"]')).toHaveText(['0', '2']);
  await page.screenshot(shot('dashboards-01-tender'));

  // 3. Drill-down: the pipeline value opens the open tenders in the pipeline report.
  await page.getByTestId('tile-pipeline_value').click();
  await expect(page.getByRole('heading', { name: 'Bid pipeline' })).toBeVisible();
  await expect(page.getByLabel('Status')).toHaveValue('open');
  await expect(page.getByTestId('pipeline-value')).toHaveText('42,50,000.00');
  await page.goBack();

  // 4. The estimation dashboard: nothing estimated yet, said plainly.
  await page
    .getByRole('navigation', { name: 'Dashboards' })
    .getByRole('link', { name: 'Estimation' })
    .click();
  await expect(page.getByRole('heading', { name: 'Estimation', exact: true })).toBeVisible();
  await expect(page.getByTestId('tile-boqs_in_progress')).toHaveText('0');
  await expect(page.getByText('Nothing is priced yet.')).toBeVisible();
  await page.screenshot(shot('dashboards-02-estimation'));

  // 5. The figures as Excel.
  await page.getByRole('link', { name: 'Tenders and bids' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^Tender dashboard \d{4}-\d{2}\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await download.path())!)) as unknown as ArrayBuffer);
  expect(wb.getWorksheet('Summary')!.getRow(6).values).toEqual(
    expect.arrayContaining(['Pipeline value', 4250000]),
  );
  // The third-party licences travel with the app, ECharts' Apache NOTICE included.
  await page.getByRole('link', { name: 'Third-party licences' }).click();
  const licences = page.getByLabel('Third-party licences');
  await expect(licences).toContainText(`echarts ${echartsVersion}`);
  await expect(licences).toContainText(/Copyright 2017-\d{4} The Apache Software Foundation/);
  await page.goBack();
  // Printing leaves the menus off the paper.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
});
