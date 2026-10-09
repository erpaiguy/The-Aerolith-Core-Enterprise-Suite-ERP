// Wave 1 step 6 in a real browser: a quantity from a measurement sheet, two pricing scenarios against the client's
// estimate, the bid scenario chosen, item rates loaded for an item-rate submission, and the tender's bid summary.
import { expect, test, type Page } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);

test('an estimator measures quantities and prices the bid against the estimate', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `bid-${Date.now()}@nagpur-builders.in`,
    'Scaffold-Tower-53',
    'Nagpur Builders',
  );

  // A tender with the client's estimate, and a BOQ with one item.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Anganwadi building, Hingna');
  await page.getByLabel('Estimated value (₹)').fill('90000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Anganwadi building, Hingna' })).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Masonry');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('Brickwork 230 mm in CM 1:6');
  await page.keyboard.press('Tab');
  await page.keyboard.type('cum');
  await page.keyboard.press('Tab');
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('5000');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Brickwork', 'amount')).toHaveText('5,000.00');

  // 1. The quantity from a measurement sheet: two walls less a door.
  await cell(page, 'Brickwork', 'description').click();
  await page.getByRole('button', { name: 'Measurement sheet' }).click();
  const sheet = page.getByRole('dialog', { name: 'Measurement sheet' });
  await sheet.getByLabel('Row 1 description').fill('Wall A, both faces');
  await sheet.getByLabel('Row 1 nos').fill('2');
  await sheet.getByLabel('Row 1 length').fill('10.5');
  await sheet.getByLabel('Row 1 breadth').fill('0.23');
  await sheet.getByLabel('Row 1 height / depth').fill('=1.5*2');
  await sheet.getByRole('button', { name: 'Row', exact: true }).click();
  await sheet.getByLabel('Row 2 description').fill('Door D1');
  await sheet.getByLabel('Row 2 nos').fill('1');
  await sheet.getByLabel('Row 2 length').fill('1.0');
  await sheet.getByLabel('Row 2 breadth').fill('0.23');
  await sheet.getByLabel('Row 2 height / depth').fill('2.1');
  await sheet.getByLabel('Row 2 deduct').check();
  await expect(sheet.getByTestId('measurement-total')).toHaveText('14.007 cum');
  await page.screenshot(shot('pricing-01-measurement'));
  await sheet.getByRole('button', { name: 'Save and use total' }).click();
  await expect(sheet).toBeHidden();
  await expect(cell(page, 'Brickwork', 'qty')).toContainText('14.007');
  await expect(cell(page, 'Brickwork', 'amount')).toHaveText('70,035.00');
  await expect(page.getByTestId('boq-total')).toHaveText('₹70,035');
  // A measured quantity opens its sheet instead of being typed over.
  await cell(page, 'Brickwork', 'qty').dblclick();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Row 2 deduct')).toBeChecked();
  await sheet.getByRole('button', { name: 'Close' }).click();

  // 2. A scenario from the usual markups: overheads 7.5 %, contingency 3 %, profit 10 % on the running total, GST 18 %.
  await page.getByRole('link', { name: 'Pricing' }).click();
  await expect(page.getByRole('heading', { name: 'Pricing · Civil' })).toBeVisible();
  await page.getByLabel('Scenario name').fill('Standard');
  await expect(page.getByTestId('before-gst')).toHaveText('85,127.55');
  await page.getByRole('button', { name: 'Create scenario' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Standard' })).toContainText('bid');
  await expect(page.getByTestId('bid-value')).toHaveText('₹1,00,451');
  await expect(page.getByTestId('pricing-breakdown')).toContainText('5.41 % below the estimate');
  await page.screenshot(shot('pricing-02-standard'));

  // 3. A sharper scenario, then chosen as the bid.
  await page.getByRole('button', { name: 'New scenario' }).click();
  await page.getByLabel('Scenario name').fill('Aggressive');
  await page.getByLabel('Percent').nth(2).fill('5');
  await expect(page.getByTestId('before-gst')).toHaveText('81,258.11');
  await page.getByRole('button', { name: 'Create scenario' }).click();
  await page.getByRole('button', { name: 'Use as the bid' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Aggressive' })).toContainText('bid');
  await expect(page.getByRole('row').filter({ hasText: 'Standard' })).not.toContainText('bid');
  await expect(page.getByTestId('quoted')).toContainText('81,258');

  // 4. Item rates loaded with the bid's markups, for an item-rate submission.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export BOQ with quoted rates (Excel)' }).click();
  expect((await downloading).suggestedFilename()).toContain('quoted (Aggressive)');

  // 5. The tender page sums the bid.
  await page.goto(tenderUrl);
  await expect(page.getByTestId('tender-bid')).toHaveText('₹95,885');
  await page.screenshot(shot('pricing-03-tender'));
});
