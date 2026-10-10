// Wave 2a step 5 in a real browser: a project schedule on the WBS with a package on an activity and a milestone, a
// baseline taken, and the macro plan: the WBS roll-up with its dates, the milestones, and the roll-up by package.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'Programme activities' });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the macro plan rolls a schedule up through the WBS, by package, with its milestones', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `macro-${Date.now()}@washim-infra.in`,
    'Plinth-Protection-Coat-58',
    'Washim Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A won tender made a project, with one WBS element.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Library, Risod');
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
  await page.getByLabel('WBS code').fill('1');
  await page.getByLabel('WBS name').fill('Reading hall');
  await page.getByRole('button', { name: 'Add element' }).click();
  await expect(page.getByRole('rowgroup', { name: 'WBS' })).toContainText('Reading hall');

  // 2. A schedule on the WBS: the activity in the Civil package, a milestone, a baseline.
  await page.goto(projectUrl);
  const schedules = card(page, 'Schedules');
  await schedules.getByRole('button', { name: 'New schedule' }).click();
  await schedules.getByLabel('Start').fill('2026-11-02'); // a Monday
  await schedules.getByRole('button', { name: 'Create schedule' }).click();
  await expect(grid(page)).toContainText('Reading hall');
  await grid(page).getByRole('gridcell', { name: 'Name of 1' }).click();
  const groups = page.getByRole('form', { name: 'Groups' });
  await groups.getByLabel('Package').fill('Civil');
  await groups.getByLabel('Trade').fill('Masonry');
  await groups.getByRole('button', { name: 'Save groups' }).click();
  await expect(groups.getByRole('button', { name: 'Save groups' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Milestone' }).click();
  await expect(grid(page)).toContainText('New milestone');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Take a baseline').fill('Original');
  await page.getByRole('button', { name: 'Take baseline' }).click();
  await expect(page.getByTestId('baseline-variance')).toContainText('on time');

  // 3. The macro plan: the reading hall Mon 2 – Fri 6 November (site calendar), on its baseline.
  await page.goto(projectUrl);
  await page.getByRole('link', { name: 'Macro plan' }).click();
  await expect(page.getByRole('heading', { name: 'Macro plan' })).toBeVisible();
  const byWbs = page.getByRole('rowgroup', { name: 'Macro plan by WBS' });
  const hall = byWbs.getByRole('row').filter({ hasText: 'Reading hall' });
  await expect(hall).toContainText('2 Nov 26');
  await expect(hall).toContainText('6 Nov 26');
  await expect(hall).toContainText('on time');
  await expect(page.getByTestId('project-progress')).toHaveText('0%');
  await page.screenshot(shot('macro-01-wbs'));
  await page.getByRole('tab', { name: 'Milestones' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Milestones' })).toContainText('New milestone');
  await page.getByRole('tab', { name: 'By package' }).click();
  const byPackage = page.getByRole('rowgroup', { name: 'Macro plan by package' });
  await expect(byPackage.getByRole('row').filter({ hasText: 'Civil' })).toContainText('0/1');
  await expect(byPackage.getByRole('row').filter({ hasText: 'Not set' })).toContainText('0/1');
  await page.getByRole('tab', { name: 'By trade' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Macro plan by trade' })).toContainText(
    'Masonry',
  );
});
