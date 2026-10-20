// Wave 3 step 15 in a real browser: a near miss reported and closed, a permit to work its requester may not issue,
// and a toolbox talk recorded.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a near miss closed, a permit held for someone else to issue, a toolbox talk', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `hse-${Date.now()}@amravati-roads.in`,
    'Toolbox-Talk-Permit-15',
    'Amravati Roads',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Washim');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await nav('Safety');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await expect(page.getByTestId('safety-stats')).toContainText('Man-hours');

  // 1. A near miss, reported and closed (no investigation needed for a near miss).
  const inc = page.getByRole('form', { name: 'Report an incident' });
  await inc.getByLabel('When').fill('2026-09-05T11:00');
  await inc.getByLabel('What happened').fill('A brick fell from the second floor');
  await inc.getByRole('button', { name: 'Report' }).click();
  const row = page.getByRole('row', { name: 'INC-001' });
  await expect(row).toContainText('near miss');
  await row.getByRole('button', { name: 'Investigate' }).click();
  await page.getByRole('button', { name: 'Close the incident' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close the incident' }).click();
  await expect(row).toContainText('closed');

  // 2. A permit for work at height tomorrow: its requester may not issue it.
  const p = page.getByRole('form', { name: 'Ask for a permit' });
  const t = new Date(Date.now() + 24 * 3_600_000);
  const at = (h: number) => {
    const d = new Date(t);
    d.setHours(h, 0, 0, 0);
    const z = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(h)}:00`;
  };
  await p.getByLabel('Location').fill('Block A, third floor slab edge');
  await p.getByLabel('Work', { exact: true }).fill('Fixing the edge formwork');
  await p.getByLabel('From').fill(at(9));
  await p.getByLabel('To').fill(at(13));
  await p.getByRole('button', { name: 'Ask' }).click();
  const permit = page.getByRole('group', { name: 'PTW-001' });
  await expect(permit).toContainText('requested');
  for (const box of await permit.getByRole('checkbox').all()) await box.check();
  await permit.getByRole('button', { name: 'Issue' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Issue the permit' }).click();
  await expect(page.getByText('Someone other than whoever asked issues a permit.')).toBeVisible();

  // 3. A toolbox talk.
  const talk = page.getByRole('form', { name: 'Toolbox talk' });
  await talk.getByLabel('Topic').fill('Working at height');
  await talk.getByLabel('Speaker').fill('Safety officer');
  await talk.getByLabel('Attended').fill('18');
  await talk.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Working at height (Safety officer) · 18 present')).toBeVisible();
  await shot(page, 'safety');
});
