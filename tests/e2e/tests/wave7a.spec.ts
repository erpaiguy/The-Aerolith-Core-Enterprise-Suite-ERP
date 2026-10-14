// Wave 7a in a real browser (docs/wave7-plan.md): the screens that were missing, and finding things.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('quality test criteria get a new version, and the payables tolerance is set', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `w7a-${Date.now()}@washim-builders.in`,
    'Missing-Screens-Washim-71',
    'Washim Builders',
  );
  const nav = page.getByRole('navigation', { name: 'Main' });

  // Quality, with no project chosen: the criteria in force, and a stricter slump tolerance from 1 October.
  await nav.getByRole('link', { name: 'Quality', exact: true }).click();
  const criteria = page.getByRole('rowgroup', { name: 'Test criteria' });
  await expect(criteria).toContainText('tolerance 25');
  const form = page.getByRole('form', { name: 'New criteria' });
  await form.getByLabel('Test').selectOption({ label: 'Slump' });
  await form.getByLabel('In force from').fill('2026-10-01');
  await form.getByLabel('tolerance').fill('20');
  await form.getByLabel('Note').fill('Client specification');
  await form.getByRole('button', { name: 'Save criteria' }).click();
  await expect(criteria.getByRole('row').filter({ hasText: '2026-10-01' })).toContainText(
    'tolerance 20',
  );

  // Payables: the admin sets the rate tolerance.
  await nav.getByRole('link', { name: 'Payables', exact: true }).click();
  const tol = page.getByRole('form', { name: 'Rate tolerance' });
  await tol.getByLabel('Bills may exceed the order rate by (%)').fill('2.5');
  await tol.getByRole('button', { name: 'Save' }).click();
  await page.reload();
  await expect(tol.getByLabel('Bills may exceed the order rate by (%)')).toHaveValue('2.5');
});
