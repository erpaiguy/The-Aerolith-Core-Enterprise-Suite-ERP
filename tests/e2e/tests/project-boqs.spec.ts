// Wave 2a step 2 in a real browser: a priced, submitted and won tender becomes a project; its contract value is
// negotiated down; the project's contract BOQ is made at the quoted rates priced to that value, and its budget at the
// estimate rates; the planned margin shows by section; the contract BOQ opens as an ordinary BOQ of the project.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });
const grid = (page: Page) => page.getByRole('treegrid', { name: 'BOQ lines' });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });
const cell = (page: Page, text: string, col: string) =>
  grid(page).getByRole('row').filter({ hasText: text }).locator(`[data-col="${col}"]`);

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a won tender gives the project its contract BOQ and budget', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `project-boqs-${Date.now()}@wardha-infra.in`,
    'Shuttering-Plate-Oil-71',
    'Wardha Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // 1. A tender, its BOQ priced at the usual markups (×1.2155), submitted and won.
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Gram panchayat office, Seloo');
  await page.getByLabel('Estimated value (₹)').fill('7000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await expect(page.getByRole('heading', { name: 'Gram panchayat office, Seloo' })).toBeVisible();
  const tenderUrl = page.url();
  await page.getByRole('button', { name: 'New BOQ' }).click();
  await page.getByLabel('BOQ name').fill('Civil');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  await page.getByLabel('Edit description').fill('Masonry');
  await page.keyboard.press('Enter');
  await grid(page).press('Control+Enter');
  await page.getByLabel('Edit description').fill('Brickwork 230 mm in CM 1:6');
  await page.keyboard.press('Tab');
  await page.keyboard.type('cum');
  await page.keyboard.press('Tab');
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('5000');
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Brickwork', 'amount')).toHaveText('5,000.00');
  await page.getByRole('link', { name: 'Pricing' }).click();
  await page.getByLabel('Scenario name').fill('Standard');
  await expect(page.getByTestId('before-gst')).toHaveText('6,077.50');
  await page.getByRole('button', { name: 'Create scenario' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Standard' })).toContainText('bid');

  await page.goto(tenderUrl);
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await page.getByRole('button', { name: 'Record submission' }).click();
  await page.getByRole('button', { name: 'Mark won' }).click();
  const confirmWon = page.getByRole('button', { name: 'Mark won' });
  if ((await confirmWon.count()) > 0) await confirmWon.last().click();
  await expect(page.getByText('Won', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Make it a project' }).click();
  await expect(page.getByRole('heading', { name: 'Gram panchayat office, Seloo' })).toBeVisible();

  // 2. The tender's BOQ, submitted as version 1, quoted at ₹6,078. The contract value (here the client's estimate)
  // is above it, so the contract BOQ would not be priced to it.
  const copyCard = card(page, 'Contract BOQ and budget');
  await expect(copyCard).toContainText('1 (submitted)');
  await expect(copyCard).toContainText('₹6,078');
  await expect(copyCard).toContainText('does it include GST?');

  // 3. Negotiated down to ₹5,834.40 (96 % of the quoted total): priced to it.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Contract value (₹)').fill('5834.40');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(copyCard.getByRole('checkbox')).toBeChecked();
  await expect(copyCard).toContainText('at 96.00%');
  await page.screenshot(shot('project-boqs-01-copy'));
  await copyCard.getByRole('button', { name: 'Make the contract BOQ and budget' }).click();

  // 4. Two BOQs, and the planned margin by section.
  const boqs = card(page, 'BOQs (2)');
  await expect(boqs.getByRole('link', { name: 'Civil (contract)' })).toBeVisible();
  await expect(boqs.getByRole('link', { name: 'Civil (budget)' })).toBeVisible();
  await expect(boqs).toContainText('rates at 96.00% of quoted');
  await expect(copyCard).toBeHidden();
  const margin = page.getByRole('definition').filter({ hasText: '(14.30%)' });
  await expect(margin).toHaveText('₹834 (14.30%)');
  const sections = card(page, 'Budget against contract');
  await expect(sections.getByRole('row').filter({ hasText: 'Masonry' })).toContainText(
    '₹5,834₹5,000₹834',
  );
  await expect(page.getByRole('list', { name: 'Project activity' })).toContainText(
    'Contract BOQ and budget made from the tender, rates at 96.00% of quoted',
  );
  await page.screenshot(shot('project-boqs-02-margin'));

  // 5. The contract BOQ is an ordinary BOQ of the project: back to the project, no bid pricing.
  await boqs.getByRole('link', { name: 'Civil (contract)' }).click();
  await expect(cell(page, 'Brickwork', 'rate')).toContainText('5,834.40');
  await expect(page.getByText('Contract BOQ', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pricing' })).toHaveCount(0);
  await page.getByRole('link', { name: /PRJ\/.* · Gram panchayat office, Seloo/ }).click();
  await expect(page.getByRole('heading', { name: 'Gram panchayat office, Seloo' })).toBeVisible();
});
