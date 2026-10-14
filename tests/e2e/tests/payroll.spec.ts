// Wave 3 step 12a in a real browser: an employee's salary set, September's punches imported, the month worked
// (PF, ESI and professional tax by the rules), approved, posted, and the payslip printed.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test("an employee's September worked, posted and paid out on a payslip", async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `pay-${Date.now()}@amravati-roads.in`,
    'Salary-Slip-Sept-12',
    'Amravati Roads',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  const tab = (name: string) => page.getByRole('tab', { name }).click();
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Ring road, Amravati');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('Site name').fill('Ring road');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  // 1. A Monday-to-Saturday calendar; Raju joins, goes to the ring road, ₹20,000 basic.
  await nav('Employees');
  await tab('Setup');
  const cal = page.getByRole('form', { name: 'New calendar' });
  await cal.getByLabel('Calendar').fill('Sites');
  await cal.getByLabel("The company's default").check();
  await cal.getByRole('button', { name: 'Add calendar' }).click();
  await expect(page.getByRole('group', { name: 'Calendar Sites' })).toBeVisible();
  await tab('Employees');
  await page.getByRole('button', { name: 'Add an employee' }).click();
  const add = page.getByRole('form', { name: 'New employee' });
  await add.getByLabel('Code').fill('E001');
  await add.getByLabel('Name').fill('Raju Shinde');
  await add.getByLabel('Joined on').fill('2026-04-01');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('link', { name: 'E001' }).click();
  await page.waitForURL(/\/hr\/employees\/[0-9a-f-]{36}$/);
  const deploy = page.getByRole('form', { name: 'Deploy' });
  await deploy.getByLabel('From').fill('2026-09-01');
  await deploy.getByLabel('Project').selectOption({ index: 1 });
  await deploy.getByLabel('Site').selectOption({ label: 'Ring road' });
  await deploy.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByRole('cell', { name: 'Ring road', exact: true })).toBeVisible();
  const salary = page.getByRole('form', { name: 'New salary' });
  await salary.getByLabel('From').fill('2026-04-01');
  await salary.getByLabel('Basic ₹ a month').fill('20000');
  await salary.getByRole('button', { name: 'Save the salary' }).click();
  await expect(page.getByText('From 2026-04-01: BASIC')).toBeVisible();

  // 2. Every working day of September from the device.
  const rows = ['Emp Code,Date,Time'];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-09-${String(d).padStart(2, '0')}`;
    if (new Date(`${day}T00:00:00Z`).getUTCDay() !== 0)
      rows.push(`E001,${day},09:00`, `E001,${day},18:00`);
  }
  await nav('Employees');
  await tab('Import');
  await page.getByLabel('File').setInputFiles({
    name: 'punches.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n')),
  });
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByTestId('import-result')).toContainText('26 days imported');

  // 3. September worked: ₹20,000; PF 12% ₹2,400; ESI (within ₹21,000) ₹150; professional tax ₹200: ₹17,250.
  await nav('Payroll');
  await page.getByLabel('Month').fill('2026-09');
  await page.getByRole('button', { name: 'Work the month' }).click();
  await page.getByRole('link', { name: '2026-09' }).click();
  await page.waitForURL(/\/payroll\/runs\/[0-9a-f-]{36}$/);
  const line = page.getByTestId('run-E001');
  await expect(line).toContainText('30.0/30.0');
  await expect(line).toContainText('17,250.00');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByText(/posted JV\//)).toBeVisible();
  await shot(page, 'payroll-run');

  // 4. The payslip.
  await page.getByRole('link', { name: 'Payslip' }).click();
  await expect(page.getByTestId('payslip-net')).toHaveText('Net pay ₹17,250.00');
  await page.getByRole('link', { name: 'Print or save as PDF' }).click();
  await expect(page.getByRole('article', { name: 'Payslip' })).toContainText('Net pay ₹17,250.00');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('cell', { name: 'Provident fund' })).toBeVisible();
});
