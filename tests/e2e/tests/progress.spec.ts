// Wave 2a step 6 in a real browser: a won tender's contract BOQ measured on site: an entry from dimensions, a wrong
// entry reversed, the quantity done in the grid, and the project's progress report.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('work done is measured in the contract BOQ and reported against it', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `progress-${Date.now()}@karanja-works.in`,
    'Measurement-Book-Entry-36',
    'Karanja Works',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A tender with one item, submitted, won, made a project with its contract BOQ.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Culvert, Manora');
  await page.getByLabel('Estimated value (₹)').fill('10000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Culvert, Manora' })).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Earthwork');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('Excavation in hard soil');
  for (const v of ['cum', '100', '100']) {
    await page.keyboard.press('Tab');
    await page.keyboard.type(v);
  }
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Excavation', 'amount')).toHaveText('10,000.00');
  await page.goto(tenderUrl);
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await page.getByRole('button', { name: 'Record submission' }).click();
  await page.getByRole('button', { name: 'Mark won' }).click();
  const confirmWon = page.getByRole('button', { name: 'Mark won' });
  if ((await confirmWon.count()) > 0) await confirmWon.last().click();
  await page.getByRole('button', { name: 'Make it a project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  await page.getByRole('button', { name: 'Make the contract BOQ and budget' }).click();
  await card(page, 'BOQs (2)').getByRole('link', { name: 'Civil (contract)' }).click();

  // 2. Measured: two trenches 10 × 5 × 0.5 = 50 cum on the item.
  await cell(page, 'Excavation', 'description').click();
  await page.getByRole('button', { name: 'Work done', exact: true }).click();
  const book = page.getByRole('dialog', { name: 'Measurement book' });
  await book.getByLabel('Row 1 description').fill('Trenches T1, T2');
  await book.getByLabel('Row 1 nos').fill('2');
  await book.getByLabel('Row 1 length').fill('10');
  await book.getByLabel('Row 1 breadth').fill('5');
  await book.getByLabel('Row 1 height').fill('0.5');
  await expect(book.getByTestId('entry-total')).toContainText('50');
  await book.getByRole('button', { name: 'Record' }).click();
  await expect(book.getByTestId('book-summary')).toContainText('Done 50 of 100 cum (50%)');

  // 3. A wrong figure, reversed with a reason: it stays on the record, crossed out.
  await book.getByRole('radio', { name: 'Quantity' }).click();
  await book.getByLabel(/^Quantity/).fill('500');
  await book.getByRole('button', { name: 'Record' }).click();
  await expect(book.getByTestId('book-summary')).toContainText('Done 550');
  page.once('dialog', (d) => void d.accept('typed 500 for 50'));
  await book
    .getByRole('button', { name: /Reverse the entry/ })
    .first()
    .click();
  await expect(book.getByTestId('book-summary')).toContainText('Done 50 of 100 cum (50%)');
  await expect(book.getByRole('table', { name: 'Entries' }).getByRole('row')).toHaveCount(4);
  await page.screenshot(shot('progress-01-book'));
  await book.getByRole('button', { name: 'Close' }).click();
  await expect(cell(page, 'Excavation', 'done')).toHaveText('50 · 50%');

  // 4. The project's progress: half the contract value done.
  await page.goto(projectUrl);
  await expect(page.getByTestId('progress-summary')).toContainText('50% done');
  await page.getByRole('link', { name: 'Open progress' }).click();
  await expect(page.getByTestId('physical')).toHaveText('50%');
  await expect(page.getByTestId('value-done')).toContainText('₹5,000');
  await expect(
    page
      .getByRole('rowgroup', { name: 'Progress of Civil (contract)' })
      .getByRole('row')
      .filter({ hasText: 'Earthwork' }),
  ).toContainText('50%');
  await page.screenshot(shot('progress-02-report'));
});
