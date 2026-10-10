// Wave 1 step 13 in a real browser: provisional sums and alternates in the grid, a bulk change to a selection of
// lines, and a BOQ saved as a template and used for the next tender's BOQ.
import { expect, test, type Page } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const row = (page: Page, text: string) => grid(page).getByRole('row').filter({ hasText: text });
const cell = (page: Page, text: string, col: string) =>
  row(page, text).locator(`[data-col="${col}"]`);

test('an estimator marks provisional sums and alternates, edits rates in bulk and saves a template', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `kinds-${Date.now()}@amravati-civil.in`,
    'Plinth-Beam-Stirrup-38',
    'Amravati Civil',
  );

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Primary health centre, Achalpur');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(
    page.getByRole('heading', { name: 'Primary health centre, Achalpur' }),
  ).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();

  // Masonry 10 × 1,000; lift: 1 × 2,00,000; granite flooring 50 × 400 as an alternate.
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Building works');
  await page.keyboard.press('Enter');
  for (const [description, unit, qty, rate] of [
    ['Brick masonry', 'cum', '10', '1000'],
    ['Passenger lift', 'job', '1', '200000'],
    ['Granite flooring instead of vitrified', 'sqm', '50', '400'],
  ]) {
    await grid(page).press('Control+Enter');
    await page.getByLabel('Edit description').fill(description!);
    await page.keyboard.press('Tab');
    await page.keyboard.type(unit!);
    await page.keyboard.press('Tab');
    await page.keyboard.type(qty!);
    await page.keyboard.press('Tab');
    await page.keyboard.type(rate!);
    await page.keyboard.press('Enter');
  }
  await expect(page.getByTestId('boq-total')).toHaveText('₹2,30,000');

  // 1. The lift is a provisional sum (still in the total); the granite an alternate (out of it, its value shown).
  await cell(page, 'Passenger lift', 'description').click();
  await page.getByLabel('Kind of item').selectOption('provisional');
  await expect(row(page, 'Passenger lift').getByTestId('kind-badge')).toHaveText('PS');
  await cell(page, 'Granite flooring', 'description').click();
  await page.getByLabel('Kind of item').selectOption('alternate');
  await expect(row(page, 'Granite flooring').getByTestId('kind-badge')).toHaveText('Alt.');
  await expect(cell(page, 'Granite flooring', 'amount')).toHaveText('(20,000.00)');
  await expect(page.getByTestId('boq-total')).toHaveText('₹2,10,000');
  await page.screenshot(shot('kinds-01-grid'));

  // 2. Bulk: select from the section to the last line, raise every rate by 10 %.
  await cell(page, 'Building works', 'description').click();
  await cell(page, 'Granite flooring', 'description').click({ modifiers: ['Shift'] });
  await expect(grid(page).locator('[role="row"][aria-selected="true"]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Bulk edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bulk edit' });
  await dialog.getByLabel('Percentage').fill('10');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog.getByText('3 items changed.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  // 11,000 + 2,20,000 (the provisional sum's rate raised too: it was in the selection).
  await expect(page.getByTestId('boq-total')).toHaveText('₹2,31,000');
  await expect(cell(page, 'Brick masonry', 'rate')).toContainText('1,100');

  // 3. Saved as a template, structure only, and used for a new BOQ.
  await page.getByRole('button', { name: 'Save as template' }).click();
  const save = page.getByRole('dialog', { name: 'Save as template' });
  await save.getByLabel('Template name').fill('PHC building (civil)');
  await save.getByRole('button', { name: 'Save template' }).click();
  await expect(
    save.getByText('Saved “PHC building (civil)”: 4 lines.', { exact: false }),
  ).toBeVisible();
  await save.getByRole('button', { name: 'Done' }).click();

  await page.goto(tenderUrl);
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil, block B');
  await page
    .getByLabel('Start from')
    .selectOption({ label: 'PHC building (civil) (Buildings, 4 lines)' });
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Civil, block B' })).toBeVisible();
  await expect(row(page, 'Passenger lift').getByTestId('kind-badge')).toHaveText('PS');
  await expect(cell(page, 'Brick masonry', 'rate')).toHaveText('');
  await expect(page.getByTestId('boq-total')).toHaveText('₹0');
  await page.screenshot(shot('kinds-02-from-template'));

  // 4. An imported item priced in dollars: USD at ₹83.50, then ₹84.
  await page.getByRole('button', { name: 'Currencies' }).click();
  const fx = page.getByRole('dialog', { name: 'Currencies' });
  await fx.getByLabel('Currency').fill('USD');
  await fx.getByLabel('Rupees for one').fill('83.5');
  await fx.getByRole('button', { name: 'Save rate' }).click();
  await expect(fx.getByRole('list', { name: 'Exchange rates' })).toContainText('₹83.5');
  await fx.getByRole('button', { name: 'Close' }).click();
  await cell(page, 'Passenger lift', 'qty').dblclick();
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('USD 2500');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Passenger lift').getByTestId('foreign-rate')).toHaveText('USD 2,500.00');
  await expect(cell(page, 'Passenger lift', 'amount')).toHaveText('2,08,750.00');
  await page.getByRole('button', { name: 'Currencies' }).click();
  await fx.getByRole('button', { name: 'Change' }).click();
  await fx.getByLabel('Rupees for one').fill('84');
  await fx.getByRole('button', { name: 'Save rate' }).click();
  await expect(fx.getByText('1 item re-priced at the new rate.')).toBeVisible();
  await fx.getByRole('button', { name: 'Close' }).click();
  await expect(cell(page, 'Passenger lift', 'amount')).toHaveText('2,10,000.00');

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'BOQ templates' })
    .click();
  await expect(page.getByRole('list', { name: 'Templates' })).toContainText('PHC building (civil)');
});
