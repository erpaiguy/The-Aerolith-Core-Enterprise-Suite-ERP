// Wave 7d in a real browser (docs/wave7-plan.md): the new registers, the site imprest, recurring entries and the
// company dashboard. Joining checklists are in hr.spec.ts.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('project registers, a site imprest, a recurring voucher and the company dashboard', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `w7d-${Date.now()}@malkapur-infra.in`,
    'Registers-Malkapur-71',
    'Malkapur Infra',
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Malkapur');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const work = page.getByRole('navigation', { name: 'Project' });

  // 7d.1: a meeting with an action for the lead, closed.
  await work.getByRole('link', { name: 'Meetings', exact: true }).click();
  await page.getByRole('button', { name: 'Record a meeting' }).click();
  const form = page.getByRole('form', { name: 'Record a meeting' });
  await form.getByLabel('Title').fill('Site progress review');
  await form.getByLabel('Attendees').fill('PM, site engineer, client EE');
  await form.getByLabel('Decisions').fill('Night shift for slab 2.');
  await form.getByRole('button', { name: 'Add an action' }).click();
  await form
    .getByRole('group', { name: 'Action 1' })
    .getByLabel('Action')
    .fill('Arrange lights for night work');
  await form.getByRole('button', { name: 'Save the minutes' }).click();
  const actions = page.getByRole('list', { name: 'Actions' });
  await expect(actions).toContainText('Arrange lights for night work');
  await expect(page.getByRole('rowgroup', { name: 'Meetings' })).toContainText('MOM-001');
  await actions.getByRole('button', { name: 'Done' }).click();
  await expect(actions).toContainText('done');

  // 7d.2: a letter received, answered.
  await work.getByRole('link', { name: 'Correspondence', exact: true }).click();
  await page.getByRole('button', { name: 'Enter a letter' }).click();
  const letter = page.getByRole('form', { name: 'Letter' });
  await letter.getByLabel('From').fill('Executive Engineer, PWD');
  await letter.getByLabel('Their reference').fill('EE/411');
  await letter.getByLabel('Subject').fill('Slow progress on slab 2');
  await letter.getByRole('button', { name: 'Save the letter' }).click();
  const rows = page.getByRole('rowgroup', { name: 'Correspondence' });
  await expect(rows).toContainText('IN-001');
  await rows.getByRole('button', { name: 'Answer' }).click();
  await page
    .getByRole('form', { name: 'Letter' })
    .getByRole('button', { name: 'Save the letter' })
    .click();
  await expect(rows).toContainText('OUT-001');
  await expect(rows.getByRole('row').filter({ hasText: 'Ref EE/411' })).toContainText(
    'answered by OUT-001',
  );

  // 7d.3: the master document list; one long overdue, then received.
  await work.getByRole('link', { name: 'Document list', exact: true }).click();
  await page.getByRole('button', { name: 'Expect documents' }).click();
  const expected = page.getByRole('form', { name: 'Expected document' });
  await expected.getByLabel('Code', { exact: true }).fill('STR-101');
  await expected.getByLabel('Title', { exact: true }).fill('Footing layout');
  await expected.getByLabel('Due by').fill('2026-01-10');
  await expected.getByLabel('From', { exact: true }).fill('Structural consultant');
  await expected.getByRole('button', { name: 'Add to the list' }).click();
  const docs = page.getByRole('rowgroup', { name: 'Expected documents' });
  await expect(docs).toContainText('STR-101');
  await expect(docs).toContainText('late by');
  await docs.getByRole('button', { name: 'Received' }).click();
  await page
    .getByRole('form', { name: 'Received' })
    .getByRole('button', { name: 'Mark received' })
    .click();
  await expect(docs).toContainText('days late');
  await expect(page.getByLabel('Totals')).toContainText('1 received');

  // 7d.4: an inspection and test plan line, with its test.
  await work.getByRole('link', { name: 'Inspection and test plan', exact: true }).click();
  await page.getByRole('button', { name: 'Add an activity' }).click();
  const itp = page.getByRole('form', { name: 'ITP line' });
  await itp.getByLabel('Activity').fill('Slab concreting');
  await itp.getByLabel('Test').selectOption('cube');
  await itp.getByLabel('How often').fill('Each pour');
  await itp.getByLabel(/Hold point/).check();
  await itp.getByRole('button', { name: 'Add to the plan' }).click();
  const plan = page.getByRole('rowgroup', { name: 'ITP' });
  await expect(plan).toContainText('Slab concreting');
  await expect(plan).toContainText('hold point');
  await expect(plan).toContainText('0 tests');

  // 7d.5: a site walk with a finding, closed by its owner.
  await work.getByRole('link', { name: 'Safety inspections', exact: true }).click();
  await page.getByRole('button', { name: 'Record a site walk' }).click();
  const walk = page.getByRole('form', { name: 'Record a site walk' });
  await walk.getByLabel('Area walked').fill('Slab 2 and scaffolds');
  await walk.getByRole('button', { name: 'Add a finding' }).click();
  const finding = walk.getByRole('group', { name: 'Finding 1' });
  await finding.getByLabel('Seen').fill('Edge protection missing');
  await finding.getByLabel('Severity').selectOption('high');
  await walk.getByRole('button', { name: 'Save the walk' }).click();
  await expect(page.getByRole('rowgroup', { name: 'Site walks' })).toContainText('SW-001');
  const found = page.getByRole('list', { name: 'Findings' });
  await expect(found).toContainText('Edge protection missing');
  await found.getByRole('button', { name: 'Close' }).click();
  await page
    .getByRole('form', { name: 'Close the finding' })
    .getByLabel('What was done')
    .fill('Rails fixed');
  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  await expect(found).toContainText('Rails fixed');

  // 7d.6: a site imprest, advanced, spent against, settled into the books.
  await work.getByRole('link', { name: 'Site imprest', exact: true }).click();
  await page.getByRole('button', { name: 'Open an imprest' }).click();
  const opening = page.getByRole('form', { name: 'Open an imprest' });
  await opening.getByLabel('For', { exact: true }).fill('Site petty cash');
  await opening.getByRole('button', { name: 'Open it' }).click();
  await page.getByRole('button', { name: 'Pay an advance' }).click();
  const advance = page.getByRole('form', { name: 'Advance' });
  await advance.getByLabel('Amount (₹)').fill('5000');
  await advance.getByLabel('Paid from').selectOption({ label: 'Cash in hand' });
  await advance.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Enter a spend' }).click();
  const spend = page.getByRole('form', { name: 'Spend' });
  await spend.getByLabel('Amount (₹)').fill('1200');
  await spend.getByLabel('Expense', { exact: true }).selectOption({ label: 'Site overheads' });
  await spend.getByLabel('What for').fill('Tea and water');
  await spend.getByRole('button', { name: 'Save' }).click();
  const entries = page.getByRole('rowgroup', { name: 'Imprest entries' });
  await expect(entries).toContainText('to settle');
  await page.getByRole('button', { name: 'Settle the spends' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Settle the spends' }).click();
  await expect(entries).not.toContainText('to settle');
  await expect(entries).toContainText('JV');
  await expect(page.getByLabel('Imprest totals')).toContainText('3,800');

  // 7d.7: a monthly voucher from the first of last month: two drafts due; one posted.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Recurring entries' })
    .click();
  await page.getByRole('button', { name: 'Set up an entry' }).click();
  const rec = page.getByRole('form', { name: 'Recurring entry' });
  const d = new Date();
  const lastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
  await rec.getByLabel('Name', { exact: true }).fill('Site security');
  await rec.getByLabel('From', { exact: true }).fill(lastMonth);
  await rec.getByLabel('Amount (₹)').fill('18000');
  await rec.getByLabel('Debit').selectOption({ label: 'X3004 Site overheads' });
  await rec.getByLabel('Credit').selectOption({ label: 'A4001 Cash in hand' });
  await rec.getByLabel('Project').selectOption({ label: 'Hostel, Malkapur' });
  await rec.getByRole('button', { name: 'Save' }).click();
  const dueRows = page.getByRole('rowgroup', { name: 'Due entries' });
  await expect(dueRows.getByRole('row')).toHaveCount(2);
  await dueRows.getByRole('button', { name: 'Post' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Post it' }).click();
  await expect(dueRows.getByRole('row')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Recent entries' })).toContainText('PV');

  // 7d.9: the company dashboard shows the project's costs from the imprest and the recurring voucher.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Company dashboard' })
    .click();
  await expect(page.getByLabel('Headline figures')).toContainText('Order book');
  await expect(page.getByRole('rowgroup', { name: 'Margin by project' })).toContainText(
    'Hostel, Malkapur',
  );
  await expect(page.getByRole('list', { name: 'Cash and bank' })).toContainText('Cash in hand');
});
