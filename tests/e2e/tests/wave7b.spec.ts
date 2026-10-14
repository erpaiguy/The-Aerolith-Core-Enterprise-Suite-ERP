// Wave 7b in a real browser (docs/wave7-plan.md): the company's letterhead, set once and on every printed page. The
// documents themselves are printed in the tests that make them (orders, receipts, bills, letters, reports).
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('the letterhead: contact lines, signatory, footer and logo on a sample page', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `w7b1-${Date.now()}@akola-builders.in`,
    'Letterhead-Akola-81',
    'Akola Builders',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Companies' })
    .click();
  await page
    .getByRole('button', { name: /^Letterhead of / })
    .first()
    .click();
  const form = page.getByRole('form', { name: 'Letterhead' });
  await form.getByLabel('Phone').fill('+91 724 243 0101');
  await form.getByLabel('Email').fill('office@akola-builders.in');
  await form.getByLabel('Signs for the company').fill('R. K. Deshmukh');
  await form.getByLabel("Signatory's title").fill('Director');
  await form.getByLabel('Footer').fill('Regd. office: Civil Lines, Akola 444001');
  await form.getByRole('button', { name: 'Save letterhead' }).click();
  await expect(form.getByText('Letterhead saved.')).toBeVisible();
  await form
    .getByLabel('Logo (PNG or JPEG, up to 300 KB)')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(form.getByRole('img', { name: 'Logo' })).toBeVisible();

  await page.getByRole('link', { name: 'See a sample page' }).click();
  const sheet = page.getByRole('article', { name: 'Sample' });
  const head = sheet.getByLabel('Letterhead');
  await expect(head).toContainText('+91 724 243 0101');
  await expect(head.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(sheet).toContainText('R. K. Deshmukh');
  await expect(sheet).toContainText('Director');
  await expect(sheet).toContainText('Regd. office: Civil Lines, Akola 444001');
});
