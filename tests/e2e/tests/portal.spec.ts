// Wave 6 step 5 in a real browser: a subcontractor on an RFQ is invited to the portal, sets a password from the link,
// quotes online; the estimator accepts the quote, which then sits in the RFQ like a typed one.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

const BOQ =
  'Code,Description,Unit,Qty,Rate\r\n' +
  '1,Waterproofing,,,\r\n' +
  '1.1,Waterproofing of terrace with APP membrane,sqm,100,340\r\n' +
  '1.2,Waterproofing of toilets with polymer coating,sqm,40,230\r\n';

test('a subcontractor invited to the portal quotes online and the quote is accepted into the RFQ', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `portal-${Date.now()}@wankhede-constructions.in`,
    'Tie-Wire-Binding-Coil-41',
    'Wankhede Constructions',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A tender, its BOQ, and a work RFQ sent to Aqua Seal Systems.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Boys hostel, Yavatmal');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByLabel('BOQ file').setInputFiles({
    name: 'civil.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(BOQ),
  });
  await page.getByRole('button', { name: 'Check file' }).click();
  await page.getByRole('button', { name: 'Import 3 lines' }).click();
  await expect(page.getByTestId('boq-total')).toHaveText('₹43,200', { timeout: 30_000 });
  await page.getByRole('link', { name: /Boys hostel, Yavatmal/ }).click();
  await page
    .getByRole('tablist', { name: 'Tender sections' })
    .getByRole('tab', { name: 'RFQs' })
    .click();
  await page.getByRole('button', { name: 'New RFQ' }).click();
  await page.getByLabel('RFQ title').fill('Waterproofing package');
  await page.getByRole('button', { name: 'Create RFQ' }).click();
  await expect(page.getByRole('heading', { name: 'Waterproofing package' })).toBeVisible();
  const rfqUrl = page.url();
  await page.getByRole('button', { name: 'From the BOQ' }).click();
  await page
    .getByRole('list', { name: 'BOQ lines to ask for' })
    .getByRole('checkbox', { name: /Waterproofing/ })
    .check();
  await page.getByRole('button', { name: 'Add 1 to the RFQ' }).click();
  await expect(page.getByText('Added 2 lines.')).toBeVisible();
  await page.getByLabel('Subcontractor').fill('Aqua Seal Systems');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const aqua = page.getByRole('listitem', { name: 'Aqua Seal Systems' });
  await aqua.getByRole('button', { name: 'Mark sent' }).click();
  await expect(aqua.getByText(/^Sent/)).toBeVisible();

  // 2. Aqua Seal invited to the subcontractor portal; the link is shown once.
  await nav('Portal users');
  const invite = page.getByRole('form', { name: 'Invite to a portal' });
  await invite.getByLabel('Portal').selectOption('subcontractor');
  await invite.getByLabel('Party').selectOption({ label: 'Aqua Seal Systems' });
  await invite.getByLabel("Person's name").fill('Ravi Deshmukh');
  await invite.getByLabel('Email').fill('ravi@aquaseal.in');
  await invite.getByRole('button', { name: 'Invite' }).click();
  const link = await page.getByLabel('Invitation link').inputValue();
  expect(link).toMatch(/\/portal\/[0-9a-f-]{36}\/accept#[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText('subcontractors 1')).toBeVisible();

  // 3. On his own browser: a password from the link, straight into the portal, and a quote.
  const outside = await browser.newContext();
  const ravi = await outside.newPage();
  await ravi.goto(link);
  await expect(ravi.getByText('ravi@aquaseal.in')).toBeVisible();
  await ravi.getByLabel('New password').fill('Membrane-Roll-2026');
  await ravi.getByLabel('Repeat the password').fill('Membrane-Roll-2026');
  await ravi.getByRole('button', { name: 'Set password and open the portal' }).click();
  await expect(ravi.getByText('Aqua Seal Systems')).toBeVisible();
  await ravi.getByRole('button', { name: /Waterproofing package/ }).click();
  const quote = ravi.getByRole('form', { name: 'Quote' });
  await quote.getByLabel('Rate for Waterproofing of terrace with APP membrane').fill('335');
  await quote.getByLabel('Rate for Waterproofing of toilets with polymer coating').fill('215');
  await quote.getByLabel('Your reference').fill('ASS/P/9');
  await quote.getByRole('button', { name: 'Send quote' }).click();
  await expect(ravi.getByTestId('quote-sent')).toContainText(/PS-\d{6}/);
  await shot(ravi, 'portal-01-quote');

  // 4. The estimator accepts it; it sits in the RFQ as Aqua Seal's quote.
  await nav('Portal submissions');
  const sub = page.getByRole('list', { name: 'Submissions' }).getByRole('listitem').first();
  await expect(sub).toContainText('quote from Aqua Seal Systems');
  await expect(sub).toContainText('2 rates');
  await sub.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Nothing waiting.')).toBeVisible();
  await page.goto(rfqUrl);
  await expect(aqua.getByText(/Quote ASS\/P\/9, received/)).toBeVisible();
  const cs = page.getByRole('rowgroup', { name: 'Comparative statement' });
  await expect(cs).toContainText('335.00');
  await shot(page, 'portal-02-accepted');

  // 5. Ravi sees it accepted.
  await ravi.getByRole('tab', { name: 'What I sent' }).click();
  await expect(ravi.getByRole('list', { name: 'Sent from this portal' })).toContainText('accepted');
  await outside.close();
});
