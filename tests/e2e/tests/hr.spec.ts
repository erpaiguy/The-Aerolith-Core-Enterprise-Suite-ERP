// Wave 3 step 11 in a real browser: a site calendar and a leave type set up, an employee added and deployed to a
// site, a day marked on the site's register, a day's casual leave, and September's days worked out.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('an employee deployed, marked present, on leave and counted for the month', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `hr-${Date.now()}@amravati-roads.in`,
    'Muster-Roll-Site-11',
    'Amravati Roads',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Ring road, Amravati');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('Site name').fill('Ring road');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  // 1. The admin has no employee record of their own.
  await nav('My attendance');
  await expect(page.getByText('You have no employee record.')).toBeVisible();

  // 2. Setup: a Monday-to-Saturday calendar as the default, casual leave of 12 days.
  await nav('Employees');
  const tab = (name: string) => page.getByRole('tab', { name }).click();
  await tab('Setup');
  const cal = page.getByRole('form', { name: 'New calendar' });
  await cal.getByLabel('Calendar').fill('Sites');
  await cal.getByLabel("The company's default").check();
  await cal.getByRole('button', { name: 'Add calendar' }).click();
  await expect(page.getByRole('group', { name: 'Calendar Sites' })).toContainText(
    'Mon, Tue, Wed, Thu, Fri, Sat',
  );
  const lt = page.getByRole('form', { name: 'New leave type' });
  await lt.getByLabel('Code').fill('CL');
  await lt.getByLabel('Name').fill('Casual leave');
  await lt.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('cell', { name: 'Casual leave' })).toBeVisible();

  // 3. Meena joins in January and goes to the ring road on 1 September.
  await tab('Employees');
  await page.getByRole('button', { name: 'Add an employee' }).click();
  const add = page.getByRole('form', { name: 'New employee' });
  await add.getByLabel('Code').fill('E001');
  await add.getByLabel('Name').fill('Meena Kale');
  await add.getByLabel('Joined on').fill('2026-01-01');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('link', { name: 'E001' }).click();
  await page.waitForURL(/\/hr\/employees\/[0-9a-f-]{36}$/);
  const deploy = page.getByRole('form', { name: 'Deploy' });
  await deploy.getByLabel('From').fill('2026-09-01');
  await deploy.getByLabel('Project').selectOption({ index: 1 });
  await deploy.getByLabel('Site').selectOption({ label: 'Ring road' });
  await deploy.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByRole('cell', { name: 'Ring road', exact: true })).toBeVisible();
  // Her experience certificate, with a reference typed before printing (docs/wave7-plan.md step 7b.4).
  await page.getByRole('link', { name: 'Experience certificate' }).click();
  await page
    .getByRole('form', { name: 'Letter details' })
    .getByLabel('Reference')
    .fill('HR/2026/014');
  const letter = page.getByRole('article', { name: 'Experience certificate' });
  await expect(letter).toContainText('To whom it may concern');
  await expect(letter).toContainText('Meena Kale');
  await expect(letter).toContainText('HR/2026/014');
  await page.getByRole('button', { name: 'Back' }).click();

  // 4. A day's casual leave on Monday 14 September, approved at once (no approval rules for leave).
  await page.getByLabel('Leave year').selectOption('2026');
  const leave = page.getByRole('form', { name: 'Apply for leave' });
  await leave.getByLabel('Leave').selectOption({ label: 'Casual leave' });
  await leave.getByLabel('From').fill('2026-09-14');
  await leave.getByLabel('To').fill('2026-09-14');
  await leave.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('cell', { name: 'approved' })).toBeVisible();
  await expect(page.getByTestId('balance-CL')).toContainText('11.0');
  // Two days carried from before the books, entered as the year's opening balance (Wave 7a step 1).
  const opening = page.getByRole('form', { name: 'Opening balance' });
  await opening.getByLabel('Opening for 2026').selectOption({ label: 'Casual leave' });
  await opening.getByLabel('Days').fill('2');
  await opening.getByRole('button', { name: 'Set opening' }).click();
  await expect(page.getByTestId('balance-CL')).toContainText('13.0');

  // 5. Present on Monday 7 September, on the site's register.
  await nav('Site attendance');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByLabel('Site').selectOption({ label: 'Ring road' });
  await page.getByLabel('Day').fill('2026-09-07');
  const row = page.getByRole('row', { name: 'Meena Kale' });
  await row.getByLabel('Mark').selectOption({ label: 'Present' });
  await row.getByLabel('In').fill('09:00');
  await row.getByLabel('Out').fill('18:00');
  await page.getByRole('button', { name: 'Save the register' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // 6. September: a day present, a day's leave, four Sundays: six payable, 24 absent.
  await nav('Employees');
  await tab('Month');
  await page.getByLabel('Month').fill('2026-09');
  const month = page.getByTestId('month-E001');
  await expect(month).toContainText('Meena Kale');
  await expect(month.getByRole('cell').nth(1)).toHaveText('1');
  await expect(month.getByRole('cell').nth(3)).toHaveText('1.0');
  await expect(month.getByRole('cell').nth(6)).toHaveText('4');
  await expect(month.getByRole('cell').nth(7)).toHaveText('24.0');
  await expect(month.getByRole('cell').nth(8)).toHaveText('6.0');
  await shot(page, 'hr-month');
});
