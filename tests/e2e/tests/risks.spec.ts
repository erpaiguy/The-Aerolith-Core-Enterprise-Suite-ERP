// Wave 4 step 6 in a real browser: a project's risk raised, scored and mapped, with a mitigation action; it occurs and
// contingency is drawn against it.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a risk scored and mapped, mitigated, occurred and drawn against', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `risk-${Date.now()}@akola-infra.in`,
    'Risk-Register-Heat-46',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Akola');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await nav('Risk register');
  await page.getByLabel('Whose').selectOption({ index: 2 });
  // Likely × major (16, high), ₹2,00,000 at 75%: ₹1,50,000 expected.
  const f = page.getByRole('form', { name: 'Raise a risk' });
  await f.getByLabel('Risk').fill('Columns of block B held up');
  await f.getByLabel('Category').selectOption('design');
  await f.getByLabel('Probability', { exact: true }).selectOption('4');
  await f.getByLabel('Impact', { exact: true }).selectOption('4');
  await f.getByLabel('Cost impact (₹)').fill('200000');
  await f.getByRole('button', { name: 'Raise' }).click();
  const row = page.getByRole('row', { name: 'R-001' });
  await expect(row).toContainText('16 high');
  await expect(row).toContainText('₹1,50,000');
  await expect(page.getByTestId('top-risks')).toContainText('R-001 Columns of block B held up');

  await row.getByLabel('New action, R-001').fill('Escalate the drawings to the engineer');
  await row.getByRole('button', { name: 'Add' }).click();
  await expect(row).toContainText('Escalate the drawings to the engineer');

  // Contingency ₹5,00,000; the risk occurs; ₹1,20,000 drawn.
  await page.getByLabel('Contingency held (₹)').fill('500000');
  await page.getByRole('main').getByRole('button', { name: 'Set' }).click();
  await expect(page.getByTestId('contingency')).toContainText('Contingency ₹5,00,000');
  await row.getByLabel('Status, R-001').selectOption('occurred');
  await row.getByLabel('Draw contingency, R-001').fill('120000');
  await row.getByRole('button', { name: 'Draw' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Draw the contingency' }).click();
  await expect(page.getByTestId('contingency')).toContainText('remaining ₹3,80,000');
  await shot(page, 'risks');
});
