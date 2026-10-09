// Wave 1 step 8 in a real browser: the client's corrigendum comes with a revised BOQ (no rates). It is imported into
// revision 2 of the priced BOQ: the check lists what changes, the rates stay, and compare shows the revision.
import { expect, test, type Page } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });

const V1 =
  'Code,Description,Unit,Qty,Rate\r\n' +
  '1,Earthwork,,,\r\n' +
  '1.1,Excavation in ordinary soil,cum,100,350\r\n' +
  '1.2,Backfilling in layers,cum,40,210\r\n' +
  '2,Concrete,,,\r\n' +
  '2.1,PCC 1:4:8 below footings,cum,12,5200\r\n';
const V2 =
  'Code,Description,Unit,Qty\r\n' +
  '1,Earthwork,,\r\n' +
  '1.1,Excavation in ordinary soil,cum,120\r\n' +
  '1.3,Anti-termite treatment,sqm,200\r\n' +
  '2,Concrete,,\r\n' +
  '2.1,PCC 1:4:8 below footings,cum,12\r\n';

async function importFile(page: Page, name: string, content: string) {
  await page.getByLabel('BOQ file').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(content),
  });
  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole('button', { name: 'Check file' }).click();
}

test("the client's revised BOQ goes into a revision, keeping the rates", async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `addenda-${Date.now()}@paithankar-builders.in`,
    'Kerb-Stone-Paver-52',
    'Paithankar Builders',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Anganwadi centres, Hinganghat');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();

  // 1. The priced BOQ, frozen as submitted; then revision 2.
  await page.getByRole('button', { name: 'Import' }).click();
  await importFile(page, 'priced.csv', V1);
  await page.getByRole('button', { name: 'Import 5 lines' }).click();
  await expect(page.getByTestId('boq-total')).toHaveText('₹1,05,800', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Freeze' }).click();
  const dialog = page.getByRole('dialog', { name: 'Freeze version 1' });
  await dialog.getByLabel('Label').fill('R0');
  await dialog.getByRole('button', { name: 'Freeze version 1' }).click();
  await page.getByRole('link', { name: 'Versions' }).click();
  await page.getByRole('button', { name: 'Start revision 2' }).click();
  await page
    .getByRole('link', { name: /Civil$/ })
    .first()
    .click();
  await expect(page.getByText('Version 2 · draft')).toBeVisible();

  // 2. The client's revised BOQ, without rates: the check lists every change before anything is saved.
  await page.getByRole('button', { name: 'Import revised BOQ' }).click();
  await expect(page.getByText("The file is the client's revised BOQ")).toBeVisible();
  await importFile(page, 'corrigendum-1.csv', V2);
  const r = page.getByTestId('revision-summary');
  await expect(r).toContainText('Changed');
  await expect(r).toContainText('₹1,04,400');
  await expect(r).toContainText("2 items have no rate in the file and keep this BOQ's rate");
  const changes = page.getByRole('table', { name: 'Changes' });
  await expect(
    changes.getByRole('row').filter({ hasText: 'Anti-termite treatment' }),
  ).toContainText('added');
  await expect(changes.getByRole('row').filter({ hasText: 'Backfilling in layers' })).toContainText(
    'removed',
  );
  await expect(changes.getByRole('row').filter({ hasText: 'Excavation' })).toContainText(
    'qty 100.0000 → 120',
  );
  await page.screenshot(shot('revised-boq-01-check'));
  await page.getByRole('button', { name: 'Apply the revision' }).click();

  // 3. The grid: quantities from the file, rates kept, the new item awaiting a rate.
  await expect(page.getByTestId('boq-total')).toHaveText('₹1,04,400', { timeout: 30_000 });
  const excavation = grid(page).getByRole('row').filter({ hasText: 'Excavation' });
  await expect(excavation.locator('[data-col="rate"]')).toHaveText('350.00');
  await expect(grid(page).getByRole('row').filter({ hasText: 'Backfilling' })).toHaveCount(0);

  // 4. Compare reads as a revision of the submitted version.
  await page.getByText('Version 2 · draft').click();
  const compare = page.getByTestId('compare');
  await expect(
    compare.getByRole('row').filter({ hasText: 'Anti-termite treatment' }),
  ).toContainText('added');
  await expect(compare.getByRole('row').filter({ hasText: 'Excavation' })).toContainText('changed');
  await expect(compare).toContainText('-₹1,400');
  await page.screenshot(shot('revised-boq-02-compare'));
});
