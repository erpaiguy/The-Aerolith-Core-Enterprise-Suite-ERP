// Wave 1 step 7 in a real browser: freeze a BOQ as submitted (read-only from then on), start revision 2, change it,
// compare the two versions line by line, export version 1 as it was submitted, and archive a BOQ made by mistake.
import { expect, test, type Page } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);

async function addItem(page: Page, description: string, unit: string, qty: string, rate: string) {
  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill(description);
  await page.keyboard.press('Tab');
  await page.keyboard.type(unit);
  await page.keyboard.press('Tab');
  await page.keyboard.type(qty);
  await page.keyboard.press('Tab');
  await page.keyboard.type(rate);
  await page.keyboard.press('Enter');
  await expect(cell(page, description, 'rate')).not.toHaveText('');
}

test('an estimator freezes the submitted BOQ, revises it and compares the versions', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `rev-${Date.now()}@wardha-infra.in`,
    'Plumb-Bob-Level-71',
    'Wardha Infra',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Gram panchayat office, Seloo');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Earthwork');
  await page.keyboard.press('Enter');
  await addItem(page, 'Excavation in ordinary soil', 'cum', '100', '350');
  await addItem(page, 'Backfilling in layers', 'cum', '40', '210');
  await expect(page.getByTestId('boq-total')).toHaveText('₹43,400');
  await expect(page.getByText('All changes saved')).toBeVisible();

  // 1. Freeze as submitted: the BOQ becomes read-only.
  await page.getByRole('button', { name: 'Freeze' }).click();
  const dialog = page.getByRole('dialog', { name: 'Freeze version 1' });
  await dialog.getByLabel('Label').fill('R0');
  await dialog.getByRole('button', { name: 'Freeze version 1' }).click();
  await expect(page.getByText('Version 1 · submitted')).toBeVisible();
  await expect(page.getByText('Read only')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'BOQ editing' })).toHaveCount(0);

  // 2. Start revision 2 and change it: one quantity, one new item.
  await page.getByRole('link', { name: 'Versions' }).click();
  await expect(page.getByRole('heading', { name: 'Versions · Civil' })).toBeVisible();
  await page.getByRole('button', { name: 'Start revision 2' }).click();
  await expect(page.getByRole('button', { name: 'Freeze version 2' })).toBeVisible();
  await page
    .getByRole('link', { name: /Civil$/ })
    .first()
    .click();
  await expect(page.getByText('Version 2 · draft')).toBeVisible();
  await cell(page, 'Excavation', 'qty').click();
  await page.keyboard.type('120');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Excavation', 'amount')).toHaveText('42,000.00');
  await cell(page, 'Backfilling', 'description').click();
  await addItem(page, 'Anti-termite treatment', 'sqm', '200', '45');
  await expect(page.getByTestId('boq-total')).toHaveText('₹59,400');
  await expect(page.getByText('All changes saved')).toBeVisible();

  // 3. Compare version 1 (as submitted) with the working draft.
  await page.getByText('Version 2 · draft').click();
  const compare = page.getByTestId('compare');
  await expect(compare).toContainText('Added');
  await expect(
    compare.getByRole('row').filter({ hasText: 'Anti-termite treatment' }),
  ).toContainText('added');
  const changed = compare.getByRole('row').filter({ hasText: 'Excavation' });
  await expect(changed).toContainText('changed');
  await expect(changed).toContainText('+7,000.00');
  await expect(compare).toContainText('+₹16,000');
  await page.screenshot(shot('revisions-01-compare'));

  // 4. Version 1 exports as it was submitted.
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('row')
    .filter({ hasText: 'R0' })
    .getByRole('button', { name: 'Excel' })
    .click();
  expect((await downloading).suggestedFilename()).toContain('version 1');

  // 5. A BOQ made by mistake is archived: read only, marked on the tender, and it can be restored.
  await page
    .getByRole('link', { name: /Civil$/ })
    .first()
    .click();
  await page.getByRole('link', { name: /Gram panchayat office, Seloo/ }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil copy');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('This BOQ is archived')).toBeVisible();
  await expect(page.getByText('Read only', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Gram panchayat office, Seloo/ }).click();
  const copy = page.getByRole('link', { name: 'Civil copy' });
  await expect(page.getByRole('listitem').filter({ has: copy })).toContainText('archived');
  await expect(page.getByText('BOQ Civil copy archived')).toBeVisible();
  await copy.click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
});
