// Help in a real browser (docs/wave9-plan.md step 9b.2): "?" on Orders opens the panel with the Orders help, the
// search finds Goods receipts, the Help centre lists the keyboard shortcuts and what is new, and Get support shows
// the diagnostics with a request reference — and no sign-in token.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('help for the page, the help centre and a support request', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `help-${Date.now()}@shegaon-builders.in`,
    'Help-Shegaon-Builders-91',
    'Shegaon Builders',
  );

  // "?" on Orders: the panel shows the Orders help.
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  const panel = page.getByRole('dialog', { name: 'Help' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('article', { name: 'Help: Orders' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Orders' })).toBeVisible();

  // Search "receipt": Goods receipts is found and opens with the keyboard.
  await panel.getByLabel('Search help').fill('receipt');
  const found = panel.getByRole('list', { name: 'Help topics found' });
  await expect(found.getByRole('button', { name: /Goods receipts/ })).toBeVisible();
  await found.getByRole('button', { name: /Goods receipts/ }).click();
  await expect(panel.getByRole('article', { name: 'Help: Goods receipts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // F1 opens it too; "?" typed in a field does not.
  await page.keyboard.press('F1');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Language' }).focus();
  await page.keyboard.press('?');
  await expect(panel).toBeHidden();

  // The Help menu leads to the Help centre's sections.
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const menu = page.getByRole('list', { name: 'Help' });
  await expect(menu.getByRole('button', { name: 'Help for this page' })).toBeVisible();
  await menu.getByRole('link', { name: 'Keyboard shortcuts' }).click();
  await expect(page).toHaveURL(/\/help\?section=shortcuts/);
  await expect(page.getByRole('heading', { name: 'Help centre', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Keyboard shortcuts' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Ctrl+K', { exact: true })).toBeVisible();
  await expect(page.getByText('F1', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'What’s new' }).click();
  await expect(page.getByRole('heading', { name: /^Version 0\.9\.0/ })).toBeVisible();

  await page.getByRole('tab', { name: 'Help topics' }).click();
  await page.getByLabel('Search help topics').fill('trial balance');
  await expect(
    page
      .getByRole('region', { name: 'Topics found' })
      .getByText('Trial balance', { exact: true })
      .first(),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Terms and privacy' }).click();
  await expect(page.getByRole('link', { name: 'Privacy policy' })).toBeVisible();

  // Get support from the Orders page: the diagnostics name the page and carry a request reference.
  await page.goto('/orders');
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.getByRole('list', { name: 'Help' }).getByRole('link', { name: 'Get support' }).click();
  await expect(page).toHaveURL(/section=support/);
  await page.getByLabel('Subject').fill('Cannot find an order');
  await page.getByLabel('What happened').fill('The list is empty.');
  const diagnostics = page.getByLabel('Diagnostics');
  await expect(diagnostics).toContainText('App version:');
  await expect(diagnostics).toContainText('Page: /orders (Orders)');
  await expect(diagnostics).toContainText(/ref [A-Z0-9]{10}/);
  await expect(diagnostics).not.toContainText('Bearer');
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  const mail = page.getByRole('link', { name: 'Email to support' });
  await expect(mail).toHaveAttribute('href', /^mailto:.*subject=Cannot%20find%20an%20order/);
});
