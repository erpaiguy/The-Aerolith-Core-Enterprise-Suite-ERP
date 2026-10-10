// Wave 1 step 8 in a real browser: pre-bid queries, an addendum that moves the due date, the EMD bank guarantee,
// the standard checklist, submission, the bids at the opening, the loss, the agenda and the win/loss analysis.
import { expect, test, type Page } from '@playwright/test';
import { signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

function localInput(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T15:00`;
}
const localDate = (days: number) => localInput(days).slice(0, 10);
const tab = (page: Page, name: RegExp) =>
  page.getByRole('tablist', { name: 'Tender sections' }).getByRole('tab', { name }).click();

test('an estimator runs a tender from queries and addenda through the EMD, checklist and opening to the result', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `bids-${Date.now()}@deshmukh-infra.in`,
    'Rebar-Chair-Spacer-12',
    'Deshmukh Infra',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Taluka court building, Morshi');
  await page.getByLabel('EMD (₹)').fill('350000');
  await page.getByLabel('Submission due').fill(localInput(12));
  await page.getByLabel('Last day for queries').fill(localInput(5));
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Taluka court building, Morshi' })).toBeVisible();
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await expect(page.getByRole('button', { name: 'Mark submitted' })).toBeVisible();

  // 1. A pre-bid query, sent and answered; an addendum that moves the submission date by a week.
  await tab(page, /^Queries & addenda/);
  await page.getByLabel('Reference').fill('Clause 12.3');
  await page
    .getByLabel('Question')
    .fill('Is the mobilisation advance available against a bank guarantee?');
  await page.getByRole('button', { name: 'Add query' }).click();
  const queries = page.getByRole('list', { name: 'Queries' });
  await queries.getByRole('button', { name: 'Mark sent' }).click();
  await queries.getByRole('button', { name: 'Record answer' }).click();
  await page.getByLabel("Client's answer to Q1").fill('Yes, 10 % against an unconditional BG.');
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(queries).toContainText('answered');
  await page.getByRole('button', { name: 'Addendum', exact: true }).click();
  await page.getByLabel('Number').fill('Corrigendum 1');
  await page
    .getByLabel('What it changes')
    .fill('Submission extended by a week; lift schedule revised.');
  await page.getByLabel('New submission date').fill(localInput(19));
  await page.getByLabel('Changes the BOQ').check();
  await page.getByRole('button', { name: 'Add addendum' }).click();
  const addenda = page.getByRole('list', { name: 'Addenda' });
  await expect(addenda).toContainText('Submission moved');
  await addenda.getByLabel('Acknowledged in the bid').click();
  await expect(addenda.getByLabel('Acknowledged in the bid')).toBeChecked();
  // The corrigendum itself, kept with the addendum (and in the tender's documents).
  const attaching = page.waitForEvent('filechooser');
  await addenda.getByRole('button', { name: 'Attach documents to Corrigendum 1' }).click();
  await (
    await attaching
  ).setFiles({
    name: 'Corrigendum 1.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 corrigendum'),
  });
  await expect(addenda.getByRole('list', { name: 'Documents of Corrigendum 1' })).toContainText(
    'Corrigendum 1.pdf',
  );
  await page.screenshot(shot('tender-mgmt-01-queries'));

  // 2. The EMD as a bank guarantee, handed to the client.
  await tab(page, /^EMD & guarantees/);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Amount (₹)')).toHaveValue('350000.00');
  await page.getByLabel('Bank').fill('Bank of Maharashtra, Amravati');
  await page.getByLabel('Number', { exact: true }).fill('BG/2026/118');
  await page.getByLabel('Status', { exact: true }).selectOption('submitted');
  await page.getByLabel('Valid until').fill(localDate(150));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: /Bank of Maharashtra/ })).toBeVisible();

  // 3. The standard checklist; PAN ready.
  await tab(page, /^Checklist/);
  await page.getByRole('button', { name: 'Add the standard documents' }).click();
  const progress = page.getByTestId('checklist-progress');
  await expect(progress).toHaveText(/^0 of \d+ required documents ready$/);
  await page.getByLabel('Status of PAN card').selectOption('ready');
  await expect(progress).toHaveText(/^1 of \d+ required documents ready$/);

  // 4. The agenda shows the moved submission date.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('button', { name: 'Agenda' }).click();
  await expect(page.getByRole('list', { name: 'Agenda' })).toContainText('Last day for queries');
  await page.getByRole('combobox', { name: 'How far ahead' }).selectOption('30');
  await expect(page.getByRole('list', { name: 'Agenda' })).toContainText('Submission due');
  await page
    .getByRole('list', { name: 'Agenda' })
    .getByRole('link', { name: /Taluka court building/ })
    .first()
    .click();

  // 5. Submit: the form lists what is still missing, then records the bid.
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  const form = page.getByRole('form', { name: 'Record the submission' });
  await expect(form).toContainText(/required documents? not ready/);
  await form.getByLabel('Acknowledgement or receipt number').fill('MAHATENDERS/ACK/55120');
  await form.getByLabel('Bid value (₹)').fill('28450000');
  await form.getByRole('button', { name: 'Record submission' }).click();
  await expect(page.getByRole('button', { name: 'Mark lost' })).toBeVisible();

  // 6. The opening: we were second.
  await tab(page, /^Submission & result/);
  await page.getByRole('button', { name: 'Record bids' }).click();
  await expect(page.getByLabel('Our quoted value')).toHaveValue('28450000.00');
  await page.getByLabel('Bidder 1', { exact: true }).fill('Vidarbha Infracon');
  await page.getByLabel('Bidder 1 quoted value').fill('27900000');
  await page.getByRole('button', { name: 'Bidder', exact: true }).click();
  await page.getByLabel('Bidder 2', { exact: true }).fill('Satpuda Builders');
  await page.getByLabel('Bidder 2 quoted value').fill('29300000');
  await page.getByRole('button', { name: 'Save bids' }).click();
  await expect(page.getByTestId('our-position')).toHaveText(
    'We were L2 of 3 bidders, 1.97 % above L1.',
  );

  // 7. Lost to L1, on price.
  await page.getByRole('button', { name: 'Mark lost' }).click();
  await page.getByLabel(/Reason \(lost\)/).fill('L2, 1.97 % above L1');
  await page.getByRole('button', { name: 'Mark lost' }).last().click();
  await expect(page.getByText('Won by')).toBeVisible();
  // No figure typed: the winning bid is L1's value at the opening.
  await expect(page.getByText('Winning bid')).toBeVisible();
  await expect(page.getByText('Vidarbha Infracon').first()).toBeVisible();
  await page.screenshot(shot('tender-mgmt-02-result'));

  // 8. Win/loss.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Tenders' })
    .click();
  await page.getByRole('link', { name: 'Win / loss' }).click();
  const totals = page.getByTestId('win-loss-totals');
  await expect(totals).toContainText('Lost');
  await expect(page.getByRole('row').filter({ hasText: 'Vidarbha Infracon' })).toContainText('1');
  await page.screenshot(shot('tender-mgmt-03-win-loss'));
});
