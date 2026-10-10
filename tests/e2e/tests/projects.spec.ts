// Wave 2a step 1 in a real browser: a tender is won and becomes a project (name, client and bid value carry over),
// the lead adds a site and a teammate, and the project moves from planned to active, then on hold with a reason.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a won tender becomes a project with its site, team and status', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `projects-${Date.now()}@deshmukh-constructions.in`,
    'Column-Footing-Pour-63',
    'Deshmukh Constructions',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

  // A teammate to add later.
  await nav('Users');
  await page.getByLabel('Username').fill('vinod');
  await page.getByLabel('Full name').fill('Vinod Patil');
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByTestId('one-time-password')).toBeVisible();

  // 1. A tender, bid and won.
  await nav('Projects');
  await expect(page.getByText('No live projects you can see.')).toBeVisible();
  await nav('Tenders');
  await page.getByRole('button', { name: 'New tender' }).click();
  await page.getByLabel('Tender title').fill('Taluka hospital, Mangrulpir');
  await page.getByRole('button', { name: '+ New client' }).click();
  await page.getByLabel('Client name').fill('PWD Washim Division');
  await page.getByRole('button', { name: 'Add client' }).click();
  await expect(page.getByLabel('Client', { exact: true })).toHaveValue(/.+/);
  await page.getByLabel('Estimated value (₹)').fill('8,40,00,000');
  await page.getByRole('button', { name: 'Create tender' }).click();
  await page.getByRole('button', { name: 'Start evaluating' }).click();
  await page.getByRole('button', { name: 'Decide: bid' }).click();
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await page.getByRole('button', { name: 'Record submission' }).click();
  await page.getByRole('button', { name: 'Mark won' }).click();
  const confirmWon = page.getByRole('button', { name: 'Mark won' });
  if ((await confirmWon.count()) > 0) await confirmWon.last().click();
  await expect(page.getByText('Won', { exact: true }).first()).toBeVisible();

  // 2. Made a project from the tender's page.
  await page.getByRole('button', { name: 'Make it a project' }).click();
  await expect(page.getByRole('heading', { name: 'Taluka hospital, Mangrulpir' })).toBeVisible();
  await expect(page.getByText(/^PRJ\/\d{4}-\d{2}\/0001$/)).toBeVisible();
  await expect(page.getByText('PWD Washim Division').first()).toBeVisible();
  await expect(page.getByText('₹8,40,00,000')).toBeVisible();

  // 3. A site, and a teammate as member.
  await page.getByLabel('Site name').fill('Hospital block');
  await page.getByLabel('Address').fill('Near bus stand, Mangrulpir');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('GST state 27');
  await page.getByLabel('Add to the team').selectOption({ label: 'Vinod Patil' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Team' })).toContainText('Vinod Patil');

  // 4. Started, then put on hold with a reason.
  await page.getByRole('button', { name: 'Start work' }).click();
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Put on hold' }).click();
  await page.getByLabel('Why?').fill('Drawings awaited from PWD');
  await page.getByRole('button', { name: 'Put on hold' }).last().click();
  await expect(
    page.getByRole('status').filter({ hasText: 'On hold: Drawings awaited from PWD' }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Project activity' })).toContainText(
    'Active → On hold: Drawings awaited from PWD',
  );
  await page.screenshot(shot('project-01-page'));

  // 5. In the register, and the tender points at it.
  await nav('Projects');
  await expect(page.getByRole('rowgroup', { name: 'Projects' })).toContainText(
    'Taluka hospital, Mangrulpir',
  );
  await nav('Tenders');
  await page.getByRole('button', { name: /^Won/ }).click();
  await page.getByRole('link', { name: 'Taluka hospital, Mangrulpir' }).click();
  await expect(page.getByText(/This tender is now PRJ\//)).toBeVisible();
});
