// Feedback and leaving (docs/wave9-plan.md steps 9a.3 and 9a.4): the welcome after signing in, a warning before
// leaving a form that is not saved (stay keeps what was typed; leave goes), and the notice after signing out.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.use({ storageState: { cookies: [], origins: [] } });
test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a form not saved asks before leaving, and signing in and out says so', async ({ page }) => {
  await signInNewAdmin(
    page,
    `leave-${Date.now()}@washim-builders.in`,
    'Leaving-Gently-Washim-27',
    'Washim Builders',
  );
  await expect(page.getByText(/^Welcome, /)).toBeVisible();

  await page.goto('/tenders/new');
  await page.getByLabel('Tender title').fill('Washim water supply, phase 2');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home/ }).click();
  const ask = page.getByRole('alertdialog', { name: 'Leave without saving?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Stay on this page' }).click();
  await expect(page).toHaveURL(/\/tenders\/new$/);
  await expect(page.getByLabel('Tender title')).toHaveValue('Washim water supply, phase 2');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home/ }).click();
  await page
    .getByRole('alertdialog', { name: 'Leave without saving?' })
    .getByRole('button', { name: 'Leave without saving' })
    .click();
  await expect(page).not.toHaveURL(/\/tenders\/new$/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out', { exact: true })).toBeVisible();
});
