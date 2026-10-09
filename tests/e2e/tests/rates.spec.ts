// Wave 1 step 5 in a real browser: import a price book, build a rate analysis with live costing, price a BOQ item
// from it, then move the BOQ's rate date and refresh the rate when cement gets dearer.
import { expect, test, type Page } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);

const PRICE_BOOK =
  'Code,Description,Type,Unit,Rate,W.e.f.\n' +
  'CEM,Cement OPC 43 grade,Material,bag,400,01-04-2026\n' +
  'AGG40,Stone aggregate 40 mm,Material,cum,1500,01-04-2026\n' +
  'SAND,Coarse sand,Material,cum,1800,01-04-2026\n' +
  'MASON,Mason,Labour,day,900,01-04-2026\n' +
  'BELDAR,Beldar,Labour,day,650,01-04-2026\n' +
  'MIXER,Concrete mixer 0.4 cum,Equipment,day,1200,01-04-2026\n';

async function addResourceLine(page: Page, code: string, qty: string, wastage?: string) {
  await page.getByRole('button', { name: 'Resource', exact: true }).click();
  await page.getByLabel('Find resource').fill(code);
  await page.getByRole('option', { name: new RegExp(`^${code}\\b`) }).click();
  await page.getByLabel('Quantity').last().fill(qty);
  if (wastage) await page.getByLabel('Wastage %').last().fill(wastage);
}

test('an estimator builds a rate analysis and prices a BOQ item from it', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `rates-${Date.now()}@vidarbha-infra.in`,
    'Curing-Compound-27',
    'Vidarbha Infra',
  );
  const nav = page.getByRole('navigation', { name: 'Main' });

  // 1. The company's own price book: checked first, then applied.
  await nav.getByRole('link', { name: 'Resources' }).click();
  await page.getByRole('button', { name: 'Import price book' }).click();
  await page.getByLabel('Price book file').setInputFiles({
    name: 'price-list.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(PRICE_BOOK),
  });
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByTestId('price-book-result')).toContainText('Ready to import: 6 new');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('price-book-result')).toContainText('Imported: 6 new');
  await expect(page.getByRole('row').filter({ hasText: 'Cement OPC 43 grade' })).toContainText(
    '400.00',
  );
  await page.screenshot(shot('rates-01-resources'));

  // 2. A rate analysis, costed live as lines are added.
  await nav.getByRole('link', { name: 'Rate analyses' }).click();
  await page.getByRole('button', { name: 'New analysis' }).click();
  await page.getByLabel('Code', { exact: true }).fill('PCC-148');
  await page
    .getByLabel('Description', { exact: true })
    .fill('PCC 1:4:8 with 40 mm graded stone aggregate');
  await page.getByLabel('Unit', { exact: true }).fill('cum');
  await addResourceLine(page, 'CEM', '3.4', '2');
  await addResourceLine(page, 'AGG40', '0.94');
  await addResourceLine(page, 'SAND', '0.47');
  await addResourceLine(page, 'MASON', '0.1');
  await addResourceLine(page, 'BELDAR', '1.63');
  await addResourceLine(page, 'MIXER', '0.07');
  await page.getByRole('button', { name: 'Lump sum' }).click();
  await page.getByLabel('Lump sum description').fill('Sundries');
  await page.getByLabel('Lump sum amount').fill('20');
  await expect(page.getByTestId('analysis-rate')).toHaveText('₹4,896.70');
  await page.getByRole('button', { name: 'Water 1 % + profit and overheads 15 %' }).click();
  await expect(page.getByTestId('analysis-rate')).toHaveText('₹5,687.52');
  await expect(page.getByTestId('analysis-totals')).toContainText('Material');
  await page.getByRole('button', { name: 'Create analysis' }).click();
  await expect(page.getByRole('heading', { name: /PCC-148 · PCC 1:4:8/ })).toBeVisible();
  await page.screenshot(shot('rates-02-analysis'));

  // 3. A BOQ item takes its rate from the analysis.
  await nav.getByRole('link', { name: 'Tenders' }).click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Water treatment plant, Wardha');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil works');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Civil works' })).toBeVisible();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Concrete');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('PCC 1:4:8 in foundations');
  await page.keyboard.press('Enter');
  await cell(page, 'PCC 1:4:8 in foundations', 'description').click();
  await page.getByRole('button', { name: 'Rate from analysis' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a rate analysis' });
  await dialog.getByLabel('Search rate analyses').fill('PCC');
  await dialog.getByRole('button', { name: /PCC-148/ }).click();
  await expect(cell(page, 'PCC 1:4:8 in foundations', 'rate')).toContainText('5,687.52');
  await expect(cell(page, 'PCC 1:4:8 in foundations', 'unit')).toHaveText('cum');
  await cell(page, 'PCC 1:4:8 in foundations', 'qty').click();
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'PCC 1:4:8 in foundations', 'amount')).toHaveText('56,875.20');
  await expect(page.getByText('All changes saved')).toBeVisible();
  const boqUrl = page.url();

  // 4. Cement gets dearer from 2030; the BOQ priced as on 2030 takes the new rate on refresh.
  await nav.getByRole('link', { name: 'Resources' }).click();
  await page.getByRole('button', { name: 'CEM', exact: true }).click();
  await page.getByLabel('From', { exact: true }).fill('2030-01-01');
  await page.getByLabel('New rate (₹)').fill('420');
  await page.getByRole('button', { name: 'Add rate' }).click();
  await expect(page.getByRole('table', { name: 'Rate history' })).toContainText('420.00');

  await page.goto(boqUrl);
  await page.getByLabel('BOQ rates as on').fill('2030-01-01');
  await expect(page.getByLabel('BOQ rates as on')).toHaveValue('2030-01-01');
  await page.getByRole('button', { name: 'Refresh rates' }).click();
  await expect(page.getByText('1 of 1 linked items re-priced.')).toBeVisible();
  // 3.468 bags × ₹20 more, plus 16.15 %: 5,768.08 per cum.
  await expect(cell(page, 'PCC 1:4:8 in foundations', 'rate')).toContainText('5,768.08');
  await expect(page.getByTestId('boq-total')).toHaveText('₹57,681');
  await page.screenshot(shot('rates-03-boq'));

  // Typing a rate by hand unlinks the item from the analysis.
  await cell(page, 'PCC 1:4:8 in foundations', 'rate').click();
  await page.keyboard.type('6000');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'PCC 1:4:8 in foundations', 'amount')).toHaveText('60,000.00');
  await page.getByRole('button', { name: 'Refresh rates' }).click();
  await expect(page.getByText('No items take their rate from an analysis yet.')).toBeVisible();
});
