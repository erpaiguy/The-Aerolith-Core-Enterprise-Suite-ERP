// Wave 2b step 7 in a real browser, at a phone's size: today's report for a site built up section by section and
// saved as it goes (through a dropped signal), a photo, submitted, acknowledged, corrected with a reason and
// submitted again; the menu folded behind a button on the phone; the project's reports and weekly figures.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });
// A 2 × 2 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a site writes its daily report on a phone, through a dropped signal, and the lead acknowledges it', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await signInNewAdmin(
    page,
    `dsr-${Date.now()}@risod-traders.in`,
    'Daily-Site-Report-Phone-7',
    'Risod Infra',
  );

  // 1. A project with a site (on a desk).
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Pump house, Risod');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  await page.getByLabel('Site name').fill('Risod sump');
  await page.getByLabel('GST state code').fill('27');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('list', { name: 'Sites' })).toContainText('Risod sump');

  // 2. On a phone: the menu is folded behind a button.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();

  // 3. Today's report at the site, section by section; it saves itself.
  await card(page, 'Daily site reports')
    .getByRole('button', { name: 'Today at Risod sump' })
    .click();
  await page.waitForURL(/\/daily-reports\/[0-9a-f-]{36}$/);
  const reportUrl = page.url();
  const saved = page.getByTestId('save-state');
  await page.getByLabel('Morning').selectOption('clear');
  await page.getByRole('button', { name: 'Trade', exact: true }).click();
  const mason = page.getByRole('group', { name: 'Manpower 1' });
  await mason.getByLabel('Trade').fill('Mason');
  await mason.getByLabel('Number').fill('6');
  await page.getByRole('button', { name: 'Equipment', exact: true }).click();
  const mixer = page.getByRole('group', { name: 'Equipment 1' });
  await mixer.getByLabel('Equipment', { exact: true }).fill('Concrete mixer');
  await mixer.getByLabel('Hours worked').fill('7');
  await mixer.getByLabel('Hours idle').fill('1');
  await mixer.getByLabel('Why idle').fill('No power');
  await page.getByRole('button', { name: 'Hindrance', exact: true }).click();
  const cut = page.getByRole('group', { name: 'Hindrance 1' });
  await cut.getByLabel('Cause').selectOption('power_water');
  await cut.getByLabel('What happened').fill('MSEB shutdown');
  await cut.getByLabel('Hours lost').fill('1');
  await expect(saved).toHaveText('Saved', { timeout: 15_000 });

  // 4. The signal drops while typing: kept on the phone, saved when it comes back.
  await context.setOffline(true);
  await page.getByLabel('Notes').fill('Plinth beam grid A-C concreted');
  await expect(saved).toContainText('No signal', { timeout: 15_000 });
  await context.setOffline(false);
  await expect(saved).toHaveText('Saved', { timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole('group', { name: 'Manpower 1' }).getByLabel('Number')).toHaveValue(
    '6',
  );
  await expect(page.getByLabel('Notes')).toHaveValue('Plinth beam grid A-C concreted');

  // 5. A photo from the camera.
  await page.getByLabel('Caption').fill('Plinth beam, grid B');
  await page
    .getByLabel('Photo file')
    .setInputFiles({ name: 'site.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('list', { name: 'Photos' }).getByRole('img')).toHaveCount(1);
  await shot(page, 'daily-report-01-phone');

  // 6. Submitted; the lead (the admin here) acknowledges it.
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Submitted', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('report-summary')).toContainText('Mason 6');
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Acknowledged', { exact: true }).first()).toBeVisible();

  // 7. The mixer was idle 2 hours, not 1: corrected with a reason and submitted again.
  page.once('dialog', (d) => void d.accept('Mixer idle 2 h, not 1'));
  await page.getByRole('button', { name: 'Correct' }).click();
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  await page.getByRole('group', { name: 'Equipment 1' }).getByLabel('Hours idle').fill('2');
  await expect(saved).toHaveText('Saved', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Submitted', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'History' })).toContainText('Mixer idle 2 h, not 1');
  await expect(page.getByTestId('report-summary')).toContainText('2 h idle (No power)');

  // 8. The project's reports and weekly figures (back on a desk).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${projectUrl}/daily-reports`);
  await expect(page.getByRole('rowgroup', { name: 'Daily reports' })).toContainText('Submitted');
  await expect(page.getByTestId('missing-reports')).toHaveCount(0);
  await expect(page.getByRole('rowgroup', { name: 'Hindrances by cause' })).toContainText(
    'Power or water',
  );
  await shot(page, 'daily-report-02-weekly');
  await page.goto(reportUrl);
  await expect(page.getByRole('list', { name: 'Photos' }).getByRole('img')).toHaveCount(1);
});
