// Wave 2a step 3 in a real browser: the company loads the standard cost codes; a won tender's project gets its
// contract BOQ, a WBS made from the BOQ's sections (items mapped with it), an element added and removed by hand, a
// section of the contract BOQ mapped to a cost code from the grid, and the contract broken down by WBS and cost code.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a project gets its WBS and cost codes, mapped from its BOQ', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `wbs-${Date.now()}@karanja-builders.in`,
    'Plinth-Beam-Level-29',
    'Karanja Builders',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company's cost codes, from the standard list.
  await nav('Cost codes');
  await page.getByRole('button', { name: 'Load the standard list' }).click();
  const codes = page.getByRole('rowgroup', { name: 'Cost codes' });
  await expect(codes).toContainText('MAT.CEM');
  await expect(codes.getByRole('row')).toHaveCount(23);

  // 2. A tender with a two-section BOQ, submitted and won, made a project with its contract BOQ.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Community hall, Karanja');
  await page.getByLabel('Estimated value (₹)').fill('3000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Community hall, Karanja' })).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  const type = async (description: string, unit: string, qty: string, rate: string) => {
    await page.getByLabel('Edit description').fill(description);
    for (const v of [unit, qty, rate]) {
      await page.keyboard.press('Tab');
      await page.keyboard.type(v);
    }
    await page.keyboard.press('Enter');
  };
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Earthwork');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter');
  await type('Excavation', 'cum', '10', '100');
  await expect(cell(page, 'Excavation', 'amount')).toHaveText('1,000.00');
  // A second section, out to the top level.
  await grid(page).press('Control+Shift+Enter');
  await page.getByLabel('Edit description').fill('Concrete');
  await page.keyboard.press('Enter');
  await grid(page).press('Alt+Shift+ArrowLeft');
  await expect(grid(page).getByRole('row').filter({ hasText: 'Concrete' })).toHaveAttribute(
    'aria-level',
    '1',
  );
  await grid(page).press('Control+Enter');
  await type('PCC 1:4:8', 'cum', '2', '1000');
  await expect(page.getByTestId('boq-total')).toHaveText('₹3,000');

  await page.goto(tenderUrl);
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await page.getByRole('button', { name: 'Record submission' }).click();
  await page.getByRole('button', { name: 'Mark won' }).click();
  const confirmWon = page.getByRole('button', { name: 'Mark won' });
  if ((await confirmWon.count()) > 0) await confirmWon.last().click();
  await page.getByRole('button', { name: 'Make it a project' }).click();
  await page.getByRole('button', { name: 'Make the contract BOQ and budget' }).click();
  await expect(card(page, 'BOQs (2)')).toBeVisible();
  const projectUrl = page.url();

  // 3. The WBS, made from the contract BOQ's sections: each item goes with its section.
  await expect(card(page, 'WBS and cost codes')).toContainText('No WBS yet.');
  await page.getByRole('link', { name: 'Open the WBS' }).click();
  await expect(page.getByRole('heading', { name: 'WBS and cost codes' })).toBeVisible();
  await page.getByRole('button', { name: 'Make the WBS' }).click();
  const wbs = page.getByRole('rowgroup', { name: 'WBS' });
  await expect(wbs.getByRole('row').filter({ hasText: 'Earthwork' })).toContainText('₹1,000');
  await expect(wbs.getByRole('row').filter({ hasText: 'Concrete' })).toContainText('₹2,000');
  await expect(page.getByTestId('coverage')).toContainText(
    'Of 2 contract items, 0 have no WBS element and 2 no cost code',
  );

  // 4. An element added by hand, then removed (nothing is under it).
  await page.getByLabel('WBS code').fill('3');
  await page.getByLabel('WBS name').fill('Finishes');
  await page.getByRole('button', { name: 'Add element' }).click();
  await expect(wbs.getByRole('row').filter({ hasText: 'Finishes' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove 3' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove the element' }).click();
  await expect(wbs.getByRole('row').filter({ hasText: 'Finishes' })).toHaveCount(0);

  // 5. In the contract BOQ: the WBS beside each item; the Concrete section mapped to a cost code.
  await page.goto(projectUrl);
  await card(page, 'BOQs (2)').getByRole('link', { name: 'Civil (contract)' }).click();
  await expect(cell(page, 'Excavation', 'wbs')).toHaveText('1');
  await cell(page, 'Concrete', 'description').click();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Map to WBS and cost code' });
  await dialog.getByLabel('Cost code').selectOption({ label: '  MAT.CEM · Cement' });
  await dialog.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(dialog).toContainText('1 item mapped.');
  await page.screenshot(shot('wbs-01-map'));
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(cell(page, 'PCC', 'costCode')).toHaveText('MAT.CEM');
  await expect(cell(page, 'PCC', 'wbs')).toHaveText('2');

  // 6. The contract by cost code.
  await page.goto(projectUrl);
  await page.getByRole('link', { name: 'Open the WBS' }).click();
  const byCost = page.getByRole('rowgroup', { name: 'Cost breakdown' });
  await expect(byCost.getByRole('row').filter({ hasText: 'MAT.CEM' })).toContainText('₹2,000');
  await expect(byCost.getByRole('row').filter({ hasText: 'Not mapped' })).toContainText('₹1,000');
  await page.screenshot(shot('wbs-02-breakdown'));
});
