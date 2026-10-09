// Wave 1 step 11 in a real browser: a tender programme typed in the grid, dates worked out on the site calendar
// (Mon–Sat), a loop of links refused, rows indented under a summary, the bar chart, and the print view.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

const grid = (page: Page) => page.getByRole('treegrid', { name: 'Programme activities' });

/** Types into a grid cell: click it, type, Enter, then wait for the recalculated value. */
async function type(page: Page, label: string, value: string, shown = value) {
  await grid(page).getByRole('gridcell', { name: label }).click();
  await page.getByRole('textbox', { name: label }).fill(value);
  await page.getByRole('textbox', { name: label }).press('Enter');
  await expect(grid(page).getByRole('gridcell', { name: label })).toHaveText(shown);
}
const row = (page: Page, name: RegExp) => grid(page).getByRole('row', { name });

test('an estimator builds the tender programme, sees the critical path and prints it', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `plan-${Date.now()}@gaikwad-projects.in`,
    'Bar-Chart-Float-Link-63',
    'Gaikwad Projects',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Tahsil office building, Daryapur');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page
    .getByRole('tablist', { name: 'Tender sections' })
    .getByRole('tab', { name: 'Programme' })
    .click();
  await page.getByRole('button', { name: 'New programme' }).click();
  await page.getByLabel('Starts on').fill('2026-11-02'); // a Monday
  await page.getByRole('button', { name: 'Create programme' }).click();
  await expect(page.getByRole('heading', { name: 'Submission programme' })).toBeVisible();

  // 1. Three activities typed in the grid: IDs come as A1000, A1010, A1020.
  const tools = page.getByRole('toolbar', { name: 'Programme tools' });
  await tools.getByRole('button', { name: 'Activity', exact: true }).click();
  await type(page, 'Name of A1000', 'Excavation');
  await type(page, 'Duration of A1000', '5');
  await tools.getByRole('button', { name: 'Activity', exact: true }).click();
  await type(page, 'Name of A1010', 'Footings');
  await type(page, 'Duration of A1010', '4');
  await type(page, 'Predecessors of A1010', 'a1000', 'A1000');
  await tools.getByRole('button', { name: 'Milestone' }).click();
  await type(page, 'Name of A1020', 'Plinth complete');
  await type(page, 'Predecessors of A1020', 'A1010');

  // Mon 2–Fri 6, then Sat 7, Mon 9, Tue 10, Wed 11 (no work on Sunday).
  await expect(row(page, /Excavation/)).toContainText('2 Nov 26');
  await expect(row(page, /Excavation/)).toContainText('6 Nov 26');
  await expect(row(page, /Footings/)).toContainText('7 Nov 26');
  await expect(row(page, /Footings/)).toContainText('11 Nov 26');
  await expect(page.getByTestId('programme-summary')).toContainText(
    '2 Nov 26 to 11 Nov 26 · 9 working days',
  );

  // 2. A loop of links is refused and nothing changes.
  await grid(page).getByRole('gridcell', { name: 'Predecessors of A1000' }).click();
  await page.getByRole('textbox', { name: 'Predecessors of A1000' }).fill('A1020');
  await page.getByRole('textbox', { name: 'Predecessors of A1000' }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('follow each other in a loop');
  await expect(grid(page).getByRole('gridcell', { name: 'Predecessors of A1000' })).toHaveText(' ');

  // 3. A summary row at the top, with the three activities indented under it.
  await row(page, /Plinth complete/).click();
  await tools.getByRole('button', { name: 'Activity', exact: true }).click();
  await type(page, 'Name of A1030', 'Civil works');
  for (let i = 0; i < 3; i++) await tools.getByRole('button', { name: 'Move up' }).click();
  await expect(grid(page).getByRole('row').nth(1)).toContainText('Civil works');
  for (const name of [/Excavation/, /Footings/, /Plinth complete/]) {
    await row(page, name).click();
    await tools.getByRole('button', { name: 'Indent', exact: true }).click();
    await expect(row(page, name)).toHaveAttribute('aria-level', '2');
  }
  await expect(row(page, /Civil works/)).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, /Civil works/)).toContainText('11 Nov 26');
  await expect(page.getByTestId('gantt')).toBeVisible();
  await page.getByLabel('Zoom').selectOption('day');
  await page.screenshot(shot('programme-01-gantt'));

  // 4. The print view: one A3 page with the title block.
  const opening = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Print / PDF' }).click();
  const print = await opening;
  await expect(print.getByRole('img', { name: 'Programme page 1' })).toBeVisible();
  await expect(print.getByText('Page 1 of 1')).toBeVisible();
  await expect(print.getByText('Tahsil office building, Daryapur')).toBeVisible();
  await print.screenshot({ path: 'screenshots/programme-02-print.png' });
  await print.close();

  // 5. Out to MS Project and Primavera, and each file back in as a new programme with the same dates.
  for (const [button, ext, from] of [
    ['MS Project', 'xml', 'MS Project'],
    ['Primavera', 'xer', 'Primavera P6'],
  ] as const) {
    const downloading = page.waitForEvent('download');
    await page.getByRole('group', { name: 'Export' }).getByRole('button', { name: button }).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(new RegExp(`Submission programme\\.${ext}$`));
    const path = await file.path();
    await page.getByRole('link', { name: /Tahsil office building, Daryapur/ }).click();
    await page
      .getByRole('tablist', { name: 'Tender sections' })
      .getByRole('tab', { name: 'Programme' })
      .click();
    await page.getByLabel('Programme file to import').setInputFiles(path);
    const result = page.getByRole('status').filter({ hasText: 'Imported' });
    await expect(result).toContainText(`from ${from}: 4 activities, 2 links`);
    await expect(result).toContainText('It finishes 11 Nov 26, as the file said.');
    await result.getByRole('link').click();
    await expect(page.getByTestId('programme-summary')).toContainText(
      '2 Nov 26 to 11 Nov 26 · 9 working days',
    );
  }
});
