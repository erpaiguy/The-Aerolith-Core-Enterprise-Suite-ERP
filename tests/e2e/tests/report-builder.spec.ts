// Wave 6 step 3 in a real browser: a report built from the CRM's leads (grouped by source, value totalled), shown as
// a bar chart, saved and exported to Excel.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a report built, charted, saved and exported', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `bi-${Date.now()}@akola-infra.in`,
    'Report-Builder-Akola-74',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // Three leads from two sources.
  await nav('CRM');
  await page.getByRole('tab', { name: 'Leads' }).click();
  for (const [what, org, source, value] of [
    ['Hostel block', 'Shikshan Sanstha', 'referral', '4000000'],
    ['School wing', 'Vidya Trust', 'referral', '2500000'],
    ['Showroom', 'Auto Plaza', 'website', '1500000'],
  ]) {
    const f = page.getByRole('form', { name: 'New lead' });
    await f.getByLabel('What').fill(what!);
    await f.getByLabel('Organisation').fill(org!);
    await f.getByLabel('Source').selectOption(source!);
    await f.getByLabel('Value (₹)').fill(value!);
    await f.getByRole('button', { name: 'Add lead' }).click();
    await expect(page.getByTestId('lead-status')).toContainText(org!);
  }

  await nav('Report builder');
  await page.getByLabel('View').selectOption({ label: 'CRM leads' });
  await page.getByLabel('Group by').getByRole('button', { name: 'Source' }).click();
  await page.getByLabel('Totals').getByRole('button', { name: 'Total value' }).click();
  await page.getByLabel('Totals').getByRole('button', { name: 'Count' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const rows = page.getByRole('rowgroup', { name: 'Report rows' });
  await expect(rows).toContainText('referral');
  await expect(rows).toContainText('₹65,00,000');
  await expect(rows).toContainText('website');

  await page.getByLabel('Show as').selectOption('bar');
  await expect(page.getByRole('img', { name: 'The report as a chart' })).toBeVisible();
  const save = page.getByRole('form', { name: 'Save the report' });
  await save.getByLabel('Report name').fill('Leads by source');
  await save.getByLabel('Share with').selectOption('managers');
  await save.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('list', { name: 'Saved reports' })).toContainText('Leads by source');

  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  expect((await dl).suggestedFilename()).toBe('Leads by source.xlsx');
  await shot(page, 'report-builder');
});
