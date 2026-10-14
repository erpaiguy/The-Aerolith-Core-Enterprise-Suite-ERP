// Wave 2a step 7 in a real browser: a won tender's project with a schedule (baseline, progress) whose activity
// carries out a contract BOQ item measured on site; the project's dashboard with the money, the three progress
// figures side by side (and their disagreement said in words), the S-curve, the look-ahead; the progress report as
// Excel.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const boqGrid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  boqGrid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);
const plan = (page: Page) => page.getByRole('treegrid', { name: 'Programme activities' });
async function type(page: Page, label: string, value: string, shown = value) {
  await plan(page).getByRole('gridcell', { name: label }).click();
  await page.getByRole('textbox', { name: label }).fill(value);
  await page.getByRole('textbox', { name: label }).press('Enter');
  await expect(plan(page).getByRole('gridcell', { name: label })).toHaveText(shown);
}
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the project dashboard puts money, progress three ways, the S-curve and the look-ahead together', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `dashboard-${Date.now()}@mangrulpir-infra.in`,
    'Earned-Value-Curve-62',
    'Mangrulpir Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A tender with one item E1 (100 cum at 100), won, made a project with its contract BOQ.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Pump house, Mangrulpir');
  await page.getByLabel('Estimated value (₹)').fill('10000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Pump house, Mangrulpir' })).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Earthwork');
  await page.keyboard.press('Enter');
  await boqGrid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('Excavation in hard soil');
  for (const v of ['cum', '100', '100']) {
    await page.keyboard.press('Tab');
    await page.keyboard.type(v);
  }
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Excavation', 'amount')).toHaveText('10,000.00');
  await cell(page, 'Excavation', 'code').dblclick();
  await page.getByLabel('Edit code').fill('E1');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Excavation', 'code')).toHaveText('E1');
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

  // 2. 40 cum of the 100 measured.
  await card(page, 'BOQs (2)').getByRole('link', { name: 'Civil (contract)' }).click();
  await cell(page, 'Excavation', 'description').click();
  await page.getByRole('button', { name: 'Work done', exact: true }).click();
  const book = page.getByRole('dialog', { name: 'Measurement book' });
  await book.getByRole('radio', { name: 'Quantity' }).click();
  await book.getByLabel(/^Quantity/).fill('40');
  await book.getByRole('button', { name: 'Record' }).click();
  await expect(book.getByTestId('book-summary')).toContainText('Done 40 of 100 cum (40%)');
  await book.getByRole('button', { name: 'Close' }).click();

  // 3. A schedule from Monday 7 September: excavation, ten days on the site calendar (7–17 Sep), carrying out E1.
  await page.goto(projectUrl);
  const schedules = card(page, 'Schedules');
  await schedules.getByRole('button', { name: 'New schedule' }).click();
  await schedules.getByLabel('Start').fill('2026-09-07');
  await schedules.getByLabel(/Lay it out on the project's WBS/).uncheck();
  await schedules.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Construction schedule' })).toBeVisible();
  const tools = page.getByRole('toolbar', { name: 'Programme tools' });
  await tools.getByRole('button', { name: 'Activity', exact: true }).click();
  const code = 'A1000';
  await type(page, `Name of ${code}`, 'Excavation');
  await type(page, `Duration of ${code}`, '10');
  await plan(page)
    .getByRole('gridcell', { name: `Name of ${code}` })
    .click();
  await page.getByLabel('Item or section code').fill('E1');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByTestId('activity-physical')).toHaveText('40% done');

  // 4. The baseline, then progress as of Monday the 14th: started on the 7th, six days left (to Sat 19th).
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Take a baseline').fill('Original');
  await page.getByRole('button', { name: 'Take baseline' }).click();
  await expect(page.getByTestId('baseline-variance')).toContainText('on time');
  await page.getByLabel('Data date').fill('2026-09-14');
  await page.getByRole('button', { name: 'Save and recalculate' }).click();
  await expect(page.getByTestId('programme-summary')).toContainText('data date 14 Sep');
  await plan(page)
    .getByRole('gridcell', { name: `Name of ${code}` })
    .click();
  const progress = page.getByRole('form', { name: 'Progress' });
  await progress.getByLabel('Actual start').fill('2026-09-07');
  await progress.getByLabel('Days left').fill('6');
  await progress.getByRole('button', { name: 'Save progress' }).click();
  await expect(page.getByTestId('baseline-variance')).toContainText('(+2 days)');

  // 5. The dashboard: planned 6 of 10 days (60%), scheduled 4 of 10 (40%), measured 40%; two days late.
  await page.goto(projectUrl);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('dash-contract')).toContainText('₹10,000');
  await expect(page.getByTestId('dash-done')).toContainText('₹4,000');
  await expect(page.getByTestId('dash-done')).toContainText('40% physical');
  await expect(page.getByTestId('dash-planned')).toHaveText('60%');
  await expect(page.getByTestId('dash-scheduled')).toHaveText('40%');
  await expect(page.getByTestId('dash-measured')).toHaveText('40%');
  await expect(page.getByRole('rowgroup', { name: 'Schedules' })).toContainText('+2 d');
  await expect(page.getByTestId('dash-disagreements')).toContainText(
    '40% done against 60% planned by the baseline',
  );
  await expect(page.getByRole('img', { name: /S-curve/ })).toBeVisible();
  await expect(page.getByTestId('dash-coverage')).toContainText('100% of');
  await expect(page.getByRole('rowgroup', { name: 'Look-ahead' })).toContainText('Excavation');
  await page.screenshot(shot('dashboard-01'));

  // 6. The progress report, downloaded as Excel.
  // The month's report for the client (docs/wave7-plan.md step 7b.5).
  await page.getByRole('link', { name: 'Client report' }).click();
  await expect(page.getByRole('article', { name: /^Monthly progress report/ })).toContainText(
    'Work done',
  );
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('link', { name: 'Progress report' }).click();
  await expect(page.getByTestId('physical')).toHaveText('40%');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  expect((await download).suggestedFilename()).toMatch(/progress to \d{4}-\d{2}-\d{2}\.xlsx$/);
});
