// Wave 4 step 7 in a real browser: the MEP pack loaded (and a second time, nothing more); a project's equipment and a
// clash; the portfolio and the project's monthly review.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('the MEP pack, the portfolio and a monthly review', async ({ page }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `portfolio-${Date.now()}@akola-infra.in`,
    'Portfolio-Review-47',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Akola');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await nav('MEP');
  await page.getByRole('button', { name: 'Load the MEP pack' }).click();
  await expect(page.getByTestId('mep-loaded')).toHaveText(
    '5 BOQ templates and 5 checklists added.',
  );
  await page.getByRole('button', { name: 'Load the MEP pack' }).click();
  await expect(page.getByTestId('mep-loaded')).toHaveText(
    '0 BOQ templates and 0 checklists added.',
  );
  await page.getByLabel('Project').selectOption({ index: 1 });
  const eq = page.getByRole('form', { name: 'New equipment' });
  await eq.getByLabel('Tag').fill('AHU-01');
  await eq.getByLabel('Description').fill('Air handling unit');
  await eq.getByLabel('Capacity').fill('8000 cfm');
  await eq.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('row', { name: 'AHU-01' })).toContainText('Air handling unit');
  // Commissioning without a passed checklist is refused.
  await page
    .getByRole('row', { name: 'AHU-01' })
    .getByLabel('Status, AHU-01')
    .selectOption('commissioned');
  await expect(
    page.getByText('Commissioning needs its testing and commissioning checklist.'),
  ).toBeVisible();
  const clash = page.getByRole('form', { name: 'New clash' });
  await clash.getByLabel('Location').fill('Grid C4');
  await clash.getByLabel('Clash').fill('Supply duct against the cable tray');
  await clash.getByRole('button', { name: 'Raise' }).click();
  await expect(page.getByRole('listitem', { name: 'CI-001' })).toContainText('open');

  await nav('Portfolio');
  await expect(page.getByRole('row').filter({ hasText: 'Hostel, Akola' })).toBeVisible();
  await expect(page.getByTestId('portfolio-totals')).toContainText('Contracts');

  await nav('Monthly review');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await expect(page.getByTestId('review')).toContainText('Hostel, Akola');
  await expect(page.getByTestId('review-ev')).toContainText('BAC');
  await shot(page, 'monthly-review');
  // The directors' MIS pack (docs/wave7-plan.md step 7b.5).
  await nav('Portfolio');
  await page.getByRole('link', { name: 'MIS pack' }).click();
  await expect(page.getByRole('article', { name: /^MIS: / })).toContainText('Hostel, Akola');
});
