// Wave 7a in a real browser (docs/wave7-plan.md): the screens that were missing, and finding things.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('quality test criteria get a new version, and the payables tolerance is set', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `w7a-${Date.now()}@washim-builders.in`,
    'Missing-Screens-Washim-71',
    'Washim Builders',
  );
  const nav = page.getByRole('navigation', { name: 'Main' });

  // Quality, with no project chosen: the criteria in force, and a stricter slump tolerance from 1 October.
  await nav.getByRole('link', { name: 'Quality', exact: true }).click();
  const criteria = page.getByRole('rowgroup', { name: 'Test criteria' });
  await expect(criteria).toContainText('tolerance 25');
  const form = page.getByRole('form', { name: 'New criteria' });
  await form.getByLabel('Test').selectOption({ label: 'Slump' });
  await form.getByLabel('In force from').fill('2026-10-01');
  await form.getByLabel('tolerance').fill('20');
  await form.getByLabel('Note').fill('Client specification');
  await form.getByRole('button', { name: 'Save criteria' }).click();
  await expect(criteria.getByRole('row').filter({ hasText: '2026-10-01' })).toContainText(
    'tolerance 20',
  );

  // Payables: the admin sets the rate tolerance.
  await nav.getByRole('link', { name: 'Payables', exact: true }).click();
  const tol = page.getByRole('form', { name: 'Rate tolerance' });
  await tol.getByLabel('Bills may exceed the order rate by (%)').fill('2.5');
  await tol.getByRole('button', { name: 'Save' }).click();
  await page.reload();
  await expect(tol.getByLabel('Bills may exceed the order rate by (%)')).toHaveValue('2.5');
});

test('parties by kind from the menu, and every enquiry in one list', async ({ page }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `w7a2-${Date.now()}@karanja-infra.in`,
    'Parties-Enquiries-Karanja-72',
    'Karanja Infra',
  );
  const nav = page.getByRole('navigation', { name: 'Main' });
  // A supplier made under Parties shows when Suppliers is opened from Procurement.
  await nav.getByRole('link', { name: 'Parties', exact: true }).click();
  await page.getByRole('button', { name: 'New party' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Vidarbha Cement Traders');
  await page.getByLabel('Client').uncheck();
  await page.getByLabel('Vendor').check();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Vidarbha Cement Traders' })).toBeVisible();
  await nav.getByRole('link', { name: 'Suppliers', exact: true }).click();
  await expect(page).toHaveURL(/\/clients\?kind=vendor$/);
  await expect(page.getByRole('button', { name: 'Suppliers' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('cell', { name: 'Vidarbha Cement Traders' })).toBeVisible();
  await page
    .getByRole('group', { name: 'Kind of party' })
    .getByRole('button', { name: 'Clients' })
    .click();
  await expect(page.getByRole('cell', { name: 'Vidarbha Cement Traders' })).toHaveCount(0);

  // Enquiries: none yet, from either side of the menu.
  await nav.getByRole('link', { name: 'Enquiries (RFQs)' }).first().click();
  await expect(page.getByRole('heading', { name: 'Enquiries (RFQs)' })).toBeVisible();
  await expect(page.getByText('No enquiries here.')).toBeVisible();
});

test('every company-wide register opens from the menu', async ({ page }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `w7a3-${Date.now()}@malegaon-civil.in`,
    'Registers-Malegaon-73',
    'Malegaon Civil',
  );
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [link, heading] of [
    ['Daily reports', 'Daily reports'],
    ['Inspections', 'Inspections'],
    ['NCRs', 'NCRs'],
    ['Drawings', 'Drawings'],
    ['RFIs', 'RFIs'],
    ['Stock issues', 'Stock issues'],
    ['Stock transfers', 'Stock transfers'],
    ['Client bills', 'Client bills'],
    ['Subcontract bills', 'Subcontract bills'],
  ] as const) {
    await nav.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText('Nothing here.')).toBeVisible();
  }
});

test("a project's pages lead the menu with its sections and a picker", async ({ page }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `w7a4-${Date.now()}@shegaon-builders.in`,
    'Workspace-Shegaon-74',
    'Shegaon Builders',
  );
  const main = page.getByRole('navigation', { name: 'Main' });
  const work = page.getByRole('navigation', { name: 'Project' });
  for (const name of ['Hostel, Washim', 'School, Akola']) {
    await main.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  }
  // On School, Akola: its workspace; the WBS of it, then the same page of the other project.
  await expect(work.getByLabel('Current project')).toHaveValue(/[0-9a-f-]{36}/);
  await expect(work.getByLabel('Current project').locator('option:checked')).toContainText(
    'School, Akola',
  );
  const akola = page.url();
  await work.getByRole('link', { name: 'WBS', exact: true }).click();
  await expect(page).toHaveURL(`${akola}/wbs`);
  const picker = work.getByLabel('Current project');
  const washim = await picker
    .locator('option', { hasText: 'Hostel, Washim' })
    .getAttribute('value');
  await picker.selectOption(washim!);
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/wbs$/);
  expect(page.url()).not.toContain(akola);
  await expect(work.getByLabel('Current project').locator('option:checked')).toContainText(
    'Hostel, Washim',
  );
  // A section on the overview, and a company screen opened on the project.
  await work.getByRole('link', { name: 'Client bills', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}#client-bills$/);
  await work.getByRole('link', { name: 'Quality', exact: true }).click();
  await expect(page).toHaveURL(/\/quality\?project=/);
  await expect(page.getByRole('main').getByLabel('Project')).toHaveValue(/[0-9a-f-]{36}/);
  await expect(work).toBeVisible();
  // Off the project, the workspace goes.
  await main.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(work).toHaveCount(0);
});
