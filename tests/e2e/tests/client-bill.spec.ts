// Wave 3 step 2 in a real browser: a won tender's contract BOQ measured; the company's GSTIN and the project's client
// and site; the contract terms; RA 1 made from the measurement book, submitted, certified for less by the client, and
// posted to the books.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('an RA bill from the measurement book, certified for less and posted', async ({ page }) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `ra-${Date.now()}@manora-works.in`,
    'Running-Account-Bill-2',
    'Manora Works',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. The company's GSTIN, and the client.
  await nav('Companies');
  await page.getByRole('button', { name: 'Edit Main entity' }).click();
  const company = page.getByRole('form', { name: 'Edit company' });
  await company.getByLabel('GSTIN').fill('27AAACM7766P1Z3');
  await company.getByLabel('Books start on').fill('2026-04-01');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Companies' })).toContainText('27AAACM7766P1Z3');
  await nav('Parties');
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Public Works Division, Washim');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Public Works Division, Washim')).toBeVisible();

  // 2. A tender with one item, won, made a project with its contract BOQ.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Culvert, Manora');
  await page.getByLabel('Estimated value (₹)').fill('10000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Culvert, Manora' })).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Earthwork');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('Excavation in hard soil');
  for (const v of ['cum', '100', '100']) {
    await page.keyboard.press('Tab');
    await page.keyboard.type(v);
  }
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Excavation', 'amount')).toHaveText('10,000.00');
  await page.goto(tenderUrl);
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await page.getByRole('button', { name: 'Record submission' }).click();
  await page.getByRole('button', { name: 'Mark won' }).click();
  const confirmWon = page.getByRole('button', { name: 'Mark won' });
  if ((await confirmWon.count()) > 0) await confirmWon.last().click();
  await page.getByRole('button', { name: 'Make it a project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  await page.getByRole('button', { name: 'Make the contract BOQ and budget' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Client').selectOption({ label: 'Public Works Division, Washim' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByLabel('Site name').fill('Manora');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');

  // 3. 50 cum measured.
  await card(page, /^BOQs/).getByRole('link', { name: 'Civil (contract)' }).click();
  await cell(page, 'Excavation', 'description').click();
  await page.getByRole('button', { name: 'Work done', exact: true }).click();
  const book = page.getByRole('dialog', { name: 'Measurement book' });
  await book.getByRole('radio', { name: 'Quantity' }).click();
  await book.getByLabel(/^Quantity/).fill('50');
  await book.getByRole('button', { name: 'Record' }).click();
  await expect(book.getByTestId('book-summary')).toContainText('Done 50 of 100 cum (50%)');
  await book.getByRole('button', { name: 'Close' }).click();

  // 4. The terms (GST 18%, retention 5%) and RA 1: 50 × ₹100 = ₹5,000; CGST and SGST ₹450 each; ₹5,900; retention
  // ₹250; net ₹5,650.
  await page.goto(projectUrl);
  const bills = card(page, 'Client bills');
  await bills.getByRole('button', { name: 'Contract terms' }).click();
  const terms = page.getByRole('form', { name: 'Contract terms' });
  await terms.getByLabel('Retention %').fill('5');
  await terms.getByRole('button', { name: 'Save the terms' }).click();
  await expect(bills).toContainText('GST 18% on top; retention 5%');
  await bills.getByRole('button', { name: 'New RA bill' }).click();
  await page
    .getByRole('form', { name: 'New RA bill' })
    .getByRole('button', { name: 'Make the bill' })
    .click();
  await page.waitForURL(/\/client-bills\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'RA bill 1' })).toBeVisible();
  const abstract = page.getByRole('rowgroup', { name: 'Abstract' });
  await expect(abstract.getByRole('row').filter({ hasText: 'Invoice total' })).toContainText(
    '₹5,900.00',
  );
  await expect(abstract.getByRole('row').filter({ hasText: 'Net payable' })).toContainText(
    '₹5,650.00',
  );
  await page.getByRole('button', { name: 'Submit the bill' }).click();
  await expect(page.getByText('With the client', { exact: true })).toBeVisible();

  // 5. The client certifies 40 cum: ₹4,000; ₹4,720 with GST; retention ₹200; net ₹4,520. A tax invoice, posted.
  await page.getByLabel('Certified Excavation in hard soil').fill('40');
  await page.getByLabel('Certificate no.').fill('EE/MNR/12');
  await page.getByRole('button', { name: 'Record the certificate' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Record and post' }).click();
  await expect(page.getByText('Certified', { exact: true })).toBeVisible();
  await expect(page.getByText(/Tax invoice INV\/\d{4}-\d{2}\/0001/)).toBeVisible();
  await expect(abstract.getByRole('row').filter({ hasText: 'Net payable' })).toContainText(
    '₹4,520.00',
  );
  await expect(
    page.getByText('Submitted for ₹5,650.00 net; certified ₹4,520.00: ₹1,130.00 less.'),
  ).toBeVisible();
  await shot(page, 'client-bill-01-certified');
  // The tax invoice with its abstract, on the letterhead (docs/wave7-plan.md step 7b.3).
  await page.getByRole('link', { name: 'Print', exact: true }).click();
  const invoice = page.getByRole('article', { name: /^Tax invoice · RA bill 1$/ });
  await expect(invoice).toContainText('Abstract');
  await expect(invoice).toContainText('₹4,720.00');
  await page.getByRole('button', { name: 'Back' }).click();
  const billUrl = page.url();
  await page.getByRole('link', { name: 'The voucher in the books' }).click();
  const lines = page.getByRole('rowgroup', { name: 'Voucher lines' });
  await expect(
    lines.getByRole('row').filter({ hasText: 'Public Works Division, Washim' }),
  ).toContainText('4,520.00');
  await expect(lines.getByRole('row').filter({ hasText: 'Contract revenue' })).toContainText(
    '4,000.00',
  );

  // 5b. A credit note of ₹100 + 9% + 9% = ₹118 against the invoice; the e-invoice JSON wants the company's address.
  await page.goto(billUrl);
  const creditNote = page.getByRole('form', { name: 'Credit note' });
  await creditNote.getByLabel('Why').fill('Rate revised');
  await creditNote.getByLabel('Value before GST').fill('100');
  await creditNote.getByRole('button', { name: 'Raise a credit note' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Raise the credit note' })
    .click();
  await expect(page.getByRole('list', { name: 'Credit notes' })).toContainText(
    /CN\/\d{4}-\d{2}\/0001.*total ₹118\.00/,
  );
  await card(page, /^e-invoice$/)
    .getByRole('button', { name: 'e-invoice JSON' })
    .click();
  await expect(page.getByText(/^Add the company's address/)).toBeVisible();

  // 6. The client pays ₹4,322 into cash and deducts ₹80 TDS: ₹4,402 settled, the bill (less the credit note) in full.
  await nav('Receivables');
  await expect(page.getByRole('rowgroup', { name: 'Bills outstanding' })).toContainText(
    '₹4,402.00',
  );
  await page.getByRole('link', { name: 'Record a receipt' }).click();
  const receipt = page.getByRole('form', { name: 'Receipt' });
  await receipt.getByLabel('Client').selectOption({ label: 'Public Works Division, Washim' });
  await receipt.getByLabel('Into').selectOption({ label: 'A4001 Cash in hand' });
  await receipt.getByLabel('Amount received ₹').fill('4322');
  await receipt.getByLabel('TDS deducted ₹').fill('80');
  await receipt.getByRole('button', { name: 'Oldest bills first' }).click();
  await expect(receipt.getByLabel('Allocation')).toContainText(
    'Settles ₹4,402.00; allocated ₹4,402.00',
  );
  await receipt.getByRole('button', { name: 'Record the receipt' }).click();
  await page.waitForURL(/\/accounts\/client-receipts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('rowgroup', { name: 'Allocations' })).toContainText('₹4,402.00');
  await page.getByRole('link', { name: 'Print the receipt' }).click();
  await expect(page.getByRole('article', { name: 'Receipt' })).toContainText(
    'Received with thanks',
  );
  await page.getByRole('button', { name: 'Back' }).click();
  await nav('Receivables');
  // Nothing outstanding on the bill; the ₹200 retention is still held.
  await expect(page.getByRole('rowgroup', { name: 'Bills outstanding' })).toHaveCount(0);
  await expect(
    page.getByRole('rowgroup', { name: 'Receivables by client' }).getByRole('row').first(),
  ).toContainText('₹200.00');
  await shot(page, 'client-bill-02-received');
});
