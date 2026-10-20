// Wave 6 step 1 in a real browser: a lead from a referral, a meeting logged with a follow-up, qualified and made a
// tender, and the pipeline showing it at the tender stage.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a lead logged, followed up, made a tender and seen in the pipeline', async ({ page }) => {
  test.setTimeout(120_000);
  await signInNewAdmin(
    page,
    `crm-${Date.now()}@amravati-infra.in`,
    'Lead-Pipeline-Amravati-61',
    'Amravati Infra',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'CRM', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Leads' }).click();
  const f = page.getByRole('form', { name: 'New lead' });
  await f.getByLabel('What').fill('Hostel block for the engineering college');
  await f.getByLabel('Organisation').fill('Shivaji Shikshan Sanstha');
  await f.getByLabel('Location').fill('Amravati');
  await f.getByLabel('Value (₹)').fill('42000000');
  await f.getByRole('button', { name: 'Add lead' }).click();
  await expect(page.getByTestId('lead-status')).toContainText('new');
  await expect(page.getByTestId('lead-status')).toContainText('at 10%');

  const log = page.getByRole('form', { name: 'Log an interaction' });
  await log.getByLabel('Kind').selectOption('meeting');
  await log.getByLabel('What happened').fill('Met the secretary; 400 beds, G+4');
  await log.getByLabel('Next step').fill('Send the company profile');
  await log
    .getByLabel('Follow up on')
    .fill(new Date(Date.now() + 2 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10));
  await log.getByRole('button', { name: 'Log' }).click();
  await expect(page.getByRole('list', { name: 'Interactions' })).toContainText(
    'Send the company profile',
  );

  await page.getByRole('button', { name: 'Move to qualified' }).click();
  await expect(page.getByTestId('lead-status')).toContainText('qualified');
  await page.getByRole('button', { name: 'Make it a tender' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Make it a tender' }).click();
  await expect(page.getByTestId('lead-status')).toContainText('tender TND/');

  await page.getByRole('tab', { name: 'Pipeline' }).click();
  await expect(page.getByTestId('pipeline-totals')).toContainText('1 open');
  await expect(page.getByLabel('tender', { exact: true })).toContainText('1 · ₹4,20,00,000');
  await expect(page.getByRole('list', { name: 'Follow-ups' })).toContainText(
    'Send the company profile',
  );
  await shot(page, 'crm');
});
