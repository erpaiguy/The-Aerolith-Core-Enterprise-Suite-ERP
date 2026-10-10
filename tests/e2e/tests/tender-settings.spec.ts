// Wave 1 step 13 (tenders) in a real browser: the admin names themselves, sets the company's bid/no-bid criteria and
// document checklist, a tender is scored on them, and its dates show in the month calendar.
import { expect, test } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
function localInput(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T15:00`;
}

test("the admin sets the company's tender criteria and checklist; a tender is scored on them", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = `settings-${Date.now()}@washim-builders.in`;
  await signInNewAdmin(page, email, 'Formwork-Shutter-71', 'Washim Builders');
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The admin's name is their email until they change it.
  await expect(page.getByRole('banner')).toContainText(email);
  await page.getByRole('link', { name: 'Account' }).click();
  await page.getByRole('form', { name: 'Your name' }).getByLabel('Name').fill('Anil Deshmukh');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('banner')).toContainText('Anil Deshmukh');

  // 2. Two criteria only: strategic fit (weight 3) and a new one, repeat client (weight 2).
  await nav('Tender settings');
  const criteria = page.getByRole('list', { name: 'Criteria' });
  while ((await criteria.getByRole('listitem').count()) > 1)
    await page.getByRole('button', { name: 'Remove criterion 2' }).click();
  await page.getByLabel('Criterion 1', { exact: true }).fill('Strategic fit for us');
  await page.getByRole('button', { name: 'Add criterion' }).click();
  await page.getByLabel('Criterion 2', { exact: true }).fill('Repeat client');
  await page.getByLabel('Weight of criterion 2').selectOption('2');
  await page.getByRole('button', { name: 'Save criteria' }).click();
  await expect(page.getByText('Saved. New decisions use these criteria.')).toBeVisible();
  // The checklist: one item of our own added to the built-in list.
  const items = page.getByRole('list', { name: 'Checklist items' });
  const before = await items.getByRole('listitem').count();
  await page.getByRole('button', { name: 'Add item' }).click();
  await page
    .getByLabel(`Checklist item ${before + 1}`, { exact: true })
    .fill('ISO 9001 certificate');
  await page.getByRole('button', { name: 'Save checklist' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await page.screenshot(shot('settings-01-criteria'));

  // 3. A tender due tomorrow, scored on the two criteria: strategic fit 5, repeat client 3 → (3 + 2 × 0.5) ÷ 5 = 80.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Taluka office, Risod');
  await page.getByLabel('Submission due').fill(localInput(1));
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Taluka office, Risod' })).toBeVisible();
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await page.getByRole('radio', { name: 'Strategic fit for us: 5' }).click();
  await page.getByRole('radio', { name: 'Repeat client: 3' }).click();
  await expect(page.getByTestId('bid-score')).toHaveText('80.0');
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await expect(page.getByText('Bidding', { exact: true }).first()).toBeVisible();

  // 4. The month calendar shows the submission (next month's page if tomorrow is in it).
  await nav('Tenders');
  await page.getByRole('button', { name: 'Agenda' }).click();
  await page
    .getByRole('group', { name: 'Agenda view' })
    .getByRole('button', { name: 'Month' })
    .click();
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (tomorrow.getMonth() !== new Date().getMonth())
    await page.getByRole('button', { name: 'Next month' }).click();
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = page.getByRole('gridcell', {
    name: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`,
  });
  await expect(day).toContainText('Submission');
  await page.screenshot(shot('settings-02-calendar'));
});
