// Wave 2a step 4 in a real browser: a project's schedule laid out on its WBS, linked and recalculated, a baseline
// taken, progress reported as of a data date (the finish slips past the baseline), a resource put on an activity and
// added up week by week, and the look-ahead.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'Programme activities' });
async function type(page: Page, label: string, value: string, shown = value) {
  await grid(page).getByRole('gridcell', { name: label }).click();
  await page.getByRole('textbox', { name: label }).fill(value);
  await page.getByRole('textbox', { name: label }).press('Enter');
  await expect(grid(page).getByRole('gridcell', { name: label })).toHaveText(shown);
}
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a project schedule on the WBS, with a baseline, progress, resources and the look-ahead', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `schedule-${Date.now()}@akola-constructions.in`,
    'Shuttering-Cycle-Days-47',
    'Akola Constructions',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // A mason in the rate library.
  await nav('Resources');
  await page.getByRole('button', { name: 'New resource' }).click();
  const form = card(page, 'New resource');
  await form.getByLabel('Code').fill('L-MASON');
  await form.getByLabel('Name').fill('Mason');
  await form.getByLabel('Type').selectOption('labour');
  await form.getByLabel('Unit', { exact: true }).fill('day');
  await page.getByRole('button', { name: 'Add resource' }).click();
  await expect(page.getByText('L-MASON').first()).toBeVisible();

  // 1. A won tender made a project, with a two-element WBS.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Water tank, Murtizapur');
  await page.getByRole('button', { name: 'Create tender' }).click();
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
  await page.goto(`${projectUrl}/wbs`);
  for (const [code, name] of [
    ['1', 'Substructure'],
    ['2', 'Superstructure'],
  ] as const) {
    await page.getByLabel('WBS code').fill(code);
    await page.getByLabel('WBS name').fill(name);
    await page.getByRole('button', { name: 'Add element' }).click();
    await expect(page.getByRole('rowgroup', { name: 'WBS' })).toContainText(name);
  }

  // 2. A schedule laid out on the WBS; superstructure 4 days after substructure.
  await page.goto(projectUrl);
  const schedules = card(page, 'Schedules');
  await schedules.getByRole('button', { name: 'New schedule' }).click();
  await schedules.getByLabel('Start').fill('2026-11-02'); // a Monday
  await schedules.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Construction schedule' })).toBeVisible();
  await expect(grid(page)).toContainText('Substructure');
  await type(page, 'Duration of 2', '4');
  await type(page, 'Predecessors of 2', '1');
  // Site calendar: substructure Mon 2 – Fri 6, superstructure Sat 7 – Wed 11.
  await expect(page.getByTestId('programme-summary')).toContainText('11 Nov');

  // 3. A baseline, then progress as of Thursday the 5th: four days still to do on substructure.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Take a baseline').fill('Original');
  await page.getByRole('button', { name: 'Take baseline' }).click();
  await expect(page.getByTestId('baseline-variance')).toContainText('against Original');
  await expect(page.getByTestId('baseline-variance')).toContainText('on time');
  // The settings stay open after a baseline.
  await page.getByLabel('Data date').fill('2026-11-05');
  await page.getByRole('button', { name: 'Save and recalculate' }).click();
  await expect(page.getByTestId('programme-summary')).toContainText('data date 5 Nov');

  await grid(page).getByRole('gridcell', { name: 'Name of 1' }).click();
  const progress = page.getByRole('form', { name: 'Progress' });
  await progress.getByLabel('Actual start').fill('2026-11-02');
  await progress.getByLabel('Days left').fill('4');
  await progress.getByRole('button', { name: 'Save progress' }).click();
  await expect(page.getByTestId('status-1')).toHaveText('◐');
  // Superstructure now finishes Fri 13 Nov, two days past the baseline.
  await expect(page.getByTestId('baseline-variance')).toContainText('(+2 days)');
  await expect(grid(page).getByRole('row').filter({ hasText: 'Superstructure' })).toContainText(
    '+2',
  );

  // 4. Three masons a day on superstructure, Tue 10 – Fri 13: 12 mason-days, all in the week of the 9th.
  await grid(page).getByRole('gridcell', { name: 'Name of 2' }).click();
  await page.getByLabel('Find a resource').fill('MASON');
  await page
    .getByLabel('Resource', { exact: true })
    .selectOption({ label: 'L-MASON · Mason (day)' });
  await page.getByLabel('Units a day').fill('3');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Activity resources' })).toContainText('3 day');
  await page.getByRole('main').getByRole('button', { name: 'Resources' }).click();
  const load = page.getByRole('rowgroup', { name: 'Resources by week' });
  await expect(load.getByRole('row').filter({ hasText: 'Mason' })).toContainText('12');
  await page.screenshot(shot('schedule-01-progress'));

  // 5. The look-ahead from the data date.
  await page.getByRole('link', { name: 'Look-ahead' }).click();
  await expect(page.getByTestId('lookahead-range')).toContainText('5 Nov');
  const la = page.getByRole('table', { name: 'Look-ahead' });
  await expect(la).toContainText('Substructure');
  await expect(la).toContainText('In progress');
  await expect(la).toContainText('Superstructure');
  await page.screenshot(shot('schedule-02-lookahead'));
});
