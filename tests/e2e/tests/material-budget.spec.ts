// Wave 2b step 2 in a real browser: a tender item priced from a rate analysis is won; the project's material budget
// is made from the analysis and put in force; a requisition takes the materials for part of the item and shows where
// it goes past the budget; the budget is revised.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

const PRICE_BOOK =
  'Code,Description,Type,Unit,Rate,W.e.f.\n' +
  'CEM,Cement OPC 43 grade,Material,bag,400,01-04-2026\n' +
  'SAND,Coarse sand,Material,cum,1800,01-04-2026\n' +
  'MASON,Mason,Labour,day,900,01-04-2026\n';

async function addResourceLine(page: Page, code: string, qty: string, wastage?: string) {
  await page.getByRole('button', { name: 'Resource', exact: true }).click();
  await page.getByLabel('Find resource').fill(code);
  await page.getByRole('option', { name: new RegExp(`^${code}\\b`) }).click();
  await page.getByLabel('Quantity').last().fill(qty);
  if (wastage) await page.getByLabel('Wastage %').last().fill(wastage);
}

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the material budget comes from the tender, measures requisitions and is revised', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `budget-${Date.now()}@malegaon-buildwell.in`,
    'Cement-Bag-Count-3468',
    'Malegaon Buildwell',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. Cement, sand and a mason in the library; PCC per cum: 3.4 bags + 2 %, 0.47 cum sand, 0.1 mason-day.
  await nav('Resources');
  await page.getByRole('button', { name: 'Import price book' }).click();
  await page.getByLabel('Price book file').setInputFiles({
    name: 'price-list.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(PRICE_BOOK),
  });
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('price-book-result')).toContainText('Imported: 3 new');
  await nav('Rate analyses');
  await page.getByRole('button', { name: 'New analysis' }).click();
  await page.getByLabel('Code', { exact: true }).fill('PCC-148');
  await page.getByLabel('Description', { exact: true }).fill('PCC 1:4:8');
  await page.getByLabel('Unit', { exact: true }).fill('cum');
  await addResourceLine(page, 'CEM', '3.4', '2');
  await addResourceLine(page, 'SAND', '0.47');
  await addResourceLine(page, 'MASON', '0.1');
  await page.getByRole('button', { name: 'Create analysis' }).click();
  await expect(page.getByRole('heading', { name: /PCC-148/ })).toBeVisible();

  // 2. A tender: 10 cum of PCC (item C1) priced from the analysis, submitted and won; the project's BOQs.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Ramp and plinth, Malegaon');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Ramp and plinth, Malegaon' })).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Concrete');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('PCC in plinth');
  await page.keyboard.press('Enter');
  await cell(page, 'PCC in plinth', 'description').click();
  await page.getByRole('button', { name: 'Rate from analysis' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a rate analysis' });
  await dialog.getByLabel('Search rate analyses').fill('PCC');
  await dialog.getByRole('button', { name: /PCC-148/ }).click();
  await cell(page, 'PCC in plinth', 'qty').click();
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await cell(page, 'PCC in plinth', 'code').dblclick();
  await page.getByLabel('Edit code').fill('C1');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'PCC in plinth', 'code')).toHaveText('C1');
  await expect(page.getByText('All changes saved')).toBeVisible();
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
  await expect(card(page, 'BOQs (2)')).toBeVisible();

  // 3. The material budget from the tender: 34.68 bags, 4.7 cum sand, 1 mason-day: ₹23,232. In force.
  await card(page, 'Material budget')
    .getByRole('button', { name: 'Make it from the tender' })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Make it from the tender' })
    .click();
  await page.waitForURL(/\/material-budgets\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Material budget, revision 0' })).toBeVisible();
  await expect(page.getByLabel('Quantity of CEM')).toHaveValue('34.68');
  await expect(page.getByLabel('Rate of CEM')).toHaveValue('400');
  await expect(page.getByLabel('Quantity of SAND')).toHaveValue('4.7');
  await expect(page.getByRole('rowgroup', { name: 'Budget: Labour' })).toContainText('MASON');
  await expect(page.getByTestId('budget-total')).toHaveText('₹23,232');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('In force', { exact: true })).toBeVisible();
  await shot(page, 'budget-01-in-force');

  // 4. A requisition for 5 cum of C1: 17.34 bags, 2.35 cum sand, 0.5 mason-day; then 40 bags, past the budget.
  await page.goto(projectUrl);
  await expect(page.getByTestId('budget-in-force')).toContainText('revision 0');
  await card(page, /^Requisitions/)
    .getByRole('button', { name: 'New requisition' })
    .click();
  await page.getByLabel('What is it for?').fill('PCC for the ramp');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/requisitions\/[0-9a-f-]{36}$/);
  await page.getByLabel('BOQ item', { exact: true }).last().fill('C1');
  await page.getByLabel('Work quantity').fill('5');
  await page.getByRole('button', { name: 'Materials for it' }).click();
  const line1 = page.getByRole('group', { name: 'Line 1' });
  await expect(line1.getByLabel('What')).toHaveValue('Cement OPC 43 grade');
  await expect(line1.getByLabel('Quantity')).toHaveValue('17.34');
  await expect(page.getByRole('group', { name: 'Line 2' }).getByLabel('Quantity')).toHaveValue(
    '2.35',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(line1.getByTestId('budget-hint')).toContainText('Budget 34.68 bag: 34.68 left');
  await line1.getByLabel('Quantity').fill('40');
  await expect(line1.getByTestId('budget-hint')).toContainText('this goes 5.32 over');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByTestId('budget-1')).toContainText('5.32 over');
  await shot(page, 'budget-02-requisition');

  // 5. The budget revised: 45 bags now. Revision 1 is in force; revision 0 is kept, replaced.
  await page.goto(projectUrl);
  await card(page, 'Material budget').getByRole('button', { name: 'Start a revision' }).click();
  await page.getByLabel('Why revise it?').fill('Extra PCC under the ramp');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Material budget, revision 1' })).toBeVisible();
  await page.getByLabel('Quantity of CEM').fill('45');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('budget-total')).toHaveText('₹27,360');
  await expect(page.getByTestId('requisitioned-CEM')).toHaveText('40 bag');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('In force', { exact: true })).toBeVisible();
  await page.goto(projectUrl);
  await expect(page.getByTestId('budget-in-force')).toContainText('revision 1');
  await card(page, 'Material budget').getByText('All revisions (2)').click();
  await expect(page.getByRole('list', { name: 'Budget revisions' })).toContainText('Replaced');
  await shot(page, 'budget-03-revised');
});
