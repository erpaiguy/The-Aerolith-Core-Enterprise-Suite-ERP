// Wave 1 step 1 in a real browser: a tender from lead to a scored bid decision, submission and a recorded loss.
import { expect, test } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

/** `YYYY-MM-DDTHH:mm` in the browser's (and this process's) time zone, `days` from now at 15:00. */
function localInput(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T15:00`;
}

test('a tender goes from lead through a scored bid decision to a recorded loss', async ({
  page,
}) => {
  const admin = `estimates-${Date.now()}@kulkarni-infra.in`;
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
  await signInNewAdmin(page, admin, 'Shuttering-Plate-88', 'Kulkarni Infra');

  // 1. Empty register, then a new tender with an inline new client.
  await nav('Tenders');
  await expect(page.getByText('No open tenders.')).toBeVisible();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('G+4 hostel block, Pune campus');
  await page.getByRole('button', { name: '+ New client' }).click();
  await page.getByLabel('Client name').fill('CPWD Pune Division');
  await page.getByLabel('GSTIN (optional)').fill('27AAACC1234F1Z5');
  await page.getByRole('button', { name: 'Add client' }).click();
  await expect(page.getByLabel('Client', { exact: true })).toHaveValue(/.+/);
  await page.getByLabel("Client's tender number").fill('NIT/04/2026-27');
  await page.getByLabel('Estimated value (₹)').fill('12,50,00,000');
  await page.getByLabel('EMD (₹)').fill('2500000');
  await page.getByLabel('Submission due').fill(localInput(10));
  await page.getByLabel('Pre-bid meeting').fill(localInput(4));
  await page.getByRole('button', { name: 'Create tender' }).click();

  await expect(page.getByRole('heading', { name: 'G+4 hostel block, Pune campus' })).toBeVisible();
  await expect(page.getByText(/^TND\/\d{4}-\d{2}\/0001$/)).toBeVisible();
  await expect(page.getByText('₹12,50,00,000')).toBeVisible();
  await expect(page.getByText('in 10 d')).toBeVisible();

  // 2. Deadline reminders were scheduled for the owner.
  await nav('Home');
  await expect(page.getByText(/due in 3 days: G\+4 hostel block/)).toBeVisible();
  await nav('Tenders');
  await page.getByRole('link', { name: 'G+4 hostel block, Pune campus' }).click();

  // 3. Evaluate and decide. The score updates as the criteria are scored.
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await expect(page.getByTestId('bid-score')).toHaveText('50.0');
  await page.getByRole('radio', { name: 'Margin potential: 5' }).click();
  await page.getByRole('radio', { name: 'Client payment record: 4' }).click();
  await expect(page.getByTestId('bid-score')).toHaveText('63.2');
  await expect(page.getByText('Favourable')).toBeVisible();
  await page.screenshot(shot('tender-01-decision'));
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await expect(page.getByText('Bidding', { exact: true }).first()).toBeVisible();

  // 4. Submit, then lose with a reason. Lost is final.
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await page.getByRole('button', { name: 'Mark lost' }).click();
  await page.getByLabel(/Reason \(lost\)/).fill('L2 by 1.8%');
  await page.getByRole('button', { name: 'Mark lost' }).last().click();
  await expect(page.getByRole('status').filter({ hasText: 'L2 by 1.8%' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark won' })).toHaveCount(0);
  await expect(page.getByText('Submitted → Lost: L2 by 1.8%')).toBeVisible();
  await page.screenshot(shot('tender-02-lost'));

  // 5. The register filters by status and searches by client.
  await nav('Tenders');
  await expect(page.getByText('No open tenders.')).toBeVisible();
  await page.getByRole('button', { name: /^Lost/ }).click();
  await expect(page.getByRole('link', { name: 'G+4 hostel block, Pune campus' })).toBeVisible();
  await page.getByRole('button', { name: /^All \d/ }).click();
  await page.getByLabel('Search tenders').fill('cpwd');
  await expect(page.getByRole('link', { name: 'G+4 hostel block, Pune campus' })).toBeVisible();
  await page.screenshot(shot('tender-03-register'));

  // 6. The admin lets workers edit BOQs; the setting is saved.
  await nav('Users');
  const workerBoq = page.getByRole('checkbox', {
    name: 'Worker: Create BOQs and edit their lines',
  });
  await expect(workerBoq).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Admin: Create BOQs/ })).toBeDisabled();
  await workerBoq.check();
  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'Worker: Create BOQs and edit their lines' }),
  ).toBeChecked();
});
