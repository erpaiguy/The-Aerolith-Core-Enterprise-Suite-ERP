// The demo guide's "things worth trying" (docs/demo.md), done by the demo people on the seeded data, in order: the
// vendor quotes and acknowledges, the subcontractor sends an invoice, the manager accepts what came from the portals,
// the client answers the transmittal, the sales manager raises a milestone. Run after crawl.spec.ts: it changes data.
import { readFileSync } from 'node:fs';
import { expect, test, type Browser } from '@playwright/test';

interface Demo {
  licenceKey: string;
  tenantId: string;
  staff: { username: string; password: string }[];
  portal: { email: string; password: string; kind: string }[];
}
const demo = JSON.parse(
  readFileSync(process.env.DEMO_JSON ?? '../../demo-credentials.json', 'utf8'),
) as Demo;
const portalUser = (kind: string) => demo.portal.find((p) => p.kind === kind)!;
const staffUser = (name: string) => demo.staff.find((s) => s.username === name)!;

async function portal(browser: Browser, kind: string) {
  const u = portalUser(kind);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/portal/${demo.tenantId}`);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('tablist').waitFor();
  return page;
}

async function staff(browser: Browser, name: string) {
  const u = staffUser(name);
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByLabel('Licence key').fill(demo.licenceKey);
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByLabel('Username or admin email').fill(u.username);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Home' }).waitFor();
  return page;
}

test.describe.configure({ mode: 'serial' });

test('Shinde quotes the steel RFQ and acknowledges the steel order on the vendor portal', async ({
  browser,
}) => {
  const page = await portal(browser, 'vendor');
  await page.getByRole('button', { name: /Reinforcement steel/ }).click();
  const quote = page.getByRole('form', { name: 'Quote' });
  await quote.getByLabel(/Rate for TMT bars/).fill('61200');
  await quote.getByLabel('Rate for Binding wire').fill('78');
  await quote.getByLabel('Your reference').fill('SST/Q/2026/88');
  await quote.getByRole('button', { name: 'Send quote' }).click();
  await expect(page.getByTestId('quote-sent')).toContainText(/PS-\d{6}/);
  await page.getByRole('tab', { name: 'Orders' }).click();
  await page.getByRole('button', { name: /^PO\// }).first().click();
  await page.getByRole('button', { name: 'Acknowledge the order' }).click();
  await expect(page.getByTestId('portal-notice')).toHaveText('Order acknowledged.');
});

test('Kale sends an invoice for the work order on the subcontractor portal', async ({
  browser,
}) => {
  const page = await portal(browser, 'subcontractor');
  await page.getByRole('tab', { name: 'Work orders' }).click();
  await page.getByRole('button', { name: /^WO\// }).first().click();
  const form = page.getByRole('form', { name: 'Invoice' });
  await form.getByLabel('Invoice no.').fill('KC/2026/14');
  await form.getByLabel('Amount ₹').fill('191250');
  await form.getByLabel('Invoice file (PDF or photo)').setInputFiles({
    name: 'KC-2026-14.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% invoice KC/2026/14\n%%EOF\n'),
  });
  await form.getByRole('button', { name: 'Send invoice' }).click();
  await expect(page.getByTestId('portal-notice')).toHaveText('Invoice sent for checking.');
});

test('Suresh accepts what came from the portals; the quote is in the RFQ', async ({ browser }) => {
  const page = await staff(browser, 'suresh');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Portal submissions' })
    .click();
  const list = page.getByRole('list', { name: 'Submissions' });
  await expect(list.getByRole('listitem')).toHaveCount(3); // Kale's measurement and invoice, Shinde's quote
  for (const kind of ['measurement', 'quote', 'invoice']) {
    await list
      .getByRole('listitem')
      .filter({ hasText: `${kind} from` })
      .getByRole('button', { name: 'Accept' })
      .click();
    await expect(list.getByRole('listitem').filter({ hasText: `${kind} from` })).toHaveCount(0);
  }
  await expect(page.getByText('Nothing waiting.')).toBeVisible();
});

test('ZP answers the transmittal and sees the RA bill on the client portal', async ({
  browser,
}) => {
  const page = await portal(browser, 'client');
  await page.getByRole('button', { name: 'Zilla Parishad School, Washim' }).click();
  await expect(page.getByText('RA 1')).toBeVisible();
  await page.getByRole('tab', { name: 'Transmittals' }).click();
  await page.getByRole('button', { name: /TR-001/ }).click();
  await page.getByRole('button', { name: 'Acknowledge receipt' }).click();
  await expect(page.getByText(/Acknowledged by Executive Engineer \(portal\)/)).toBeVisible();
  await page.getByLabel('Comments').fill('Footing details approved; revise A-101 door widths.');
  await page.getByRole('button', { name: 'Send response' }).click();
  await expect(page.getByText(/Response recorded/)).toBeVisible();
});

test('Priya raises the Plinth milestone and the demand appears', async ({ browser }) => {
  const page = await staff(browser, 'priya');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Sales and RERA' })
    .click();
  const select = page.getByLabel('Project');
  const value = await select.locator('option', { hasText: 'Sai Residency' }).getAttribute('value');
  await select.selectOption(value!);
  await page.getByRole('tab', { name: /plan/i }).click();
  const plan = page.getByRole('list', { name: 'Plan' });
  await plan
    .getByRole('listitem')
    .filter({ hasText: 'Plinth' })
    .getByRole('button', { name: /Reached on/ })
    .click();
  await expect(plan.getByRole('listitem').filter({ hasText: 'Plinth' })).toContainText('reached');
});
