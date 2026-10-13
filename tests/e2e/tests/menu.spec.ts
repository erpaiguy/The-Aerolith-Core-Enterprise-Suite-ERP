// The main menu: groups fold away, the one holding the current page opens by itself, a group someone opened stays
// open after a reload, and on a wide screen the menu stays in place and scrolls on its own while the page scrolls.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 640 } });
test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('menu groups fold, remember, and the menu scrolls on its own', async ({ page }) => {
  await signInNewAdmin(
    page,
    `menu-${Date.now()}@washim-builders.in`,
    'Folding-Menu-Washim-27',
    'Washim Builders',
  );
  const nav = page.getByRole('navigation', { name: 'Main' });
  const estimation = nav.getByRole('button', { name: 'Estimation', exact: true });
  await expect(estimation).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('link', { name: 'Rate analyses' })).toBeHidden();

  await estimation.click();
  await nav.getByRole('button', { name: 'Rates and resources' }).click();
  await nav.getByRole('link', { name: 'Rate analyses' }).click();
  await expect(page).toHaveURL(/\/rate-analyses$/);

  await page.reload();
  await expect(nav.getByRole('link', { name: 'Rate analyses' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Accounts' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Opening a page directly opens its group.
  await page.goto('/accounts/trial-balance');
  await expect(nav.getByRole('link', { name: 'Trial balance' })).toBeVisible();

  // Open every group so the menu is taller than the window, then scroll each part.
  const folded = nav.getByRole('button', { expanded: false });
  while (await folded.count()) await folded.first().click();
  const scrolls = await nav.evaluate((n) => n.scrollHeight > n.clientHeight);
  expect(scrolls).toBe(true);
  await page.evaluate(() => {
    const tall = document.createElement('div');
    tall.style.height = '4000px';
    document.querySelector('main')!.append(tall);
    window.scrollTo(0, 1500);
  });
  const box = await page.locator('aside').boundingBox();
  expect(box?.y).toBe(0);
  await nav.evaluate((n) => n.scrollTo(0, n.scrollHeight));
  await expect(nav.getByRole('link', { name: 'Integrations' })).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(1500);
});
