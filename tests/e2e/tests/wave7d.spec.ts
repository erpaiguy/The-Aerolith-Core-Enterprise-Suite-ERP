// Wave 7d in a real browser (docs/wave7-plan.md): the new project registers.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('minutes with an action, and letters in and out', async ({ page }) => {
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
});
