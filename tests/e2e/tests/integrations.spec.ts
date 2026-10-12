// Wave 6 step 6 in a real browser: an admin makes an API key, a program reads the projects view with it, and once
// the key is revoked the same request is refused.
import { expect, test } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('an API key reads the report views until it is revoked', async ({ page }) => {
  test.setTimeout(180_000);
  await signInNewAdmin(
    page,
    `api-${Date.now()}@wankhede-constructions.in`,
    'Tie-Wire-Binding-Coil-41',
    'Wankhede Constructions',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Pump house, Risod');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await nav('Integrations');
  const form = page.getByRole('form', { name: 'New API key' });
  await form.getByLabel('Key name').fill('Power BI');
  await form.getByRole('button', { name: 'Make key' }).click();
  const key = await page.getByLabel('Secret').inputValue();
  expect(key).toMatch(/^aek1\./);

  const query = () =>
    page.request.post('/api/v1/views/projects/query', {
      headers: { authorization: `Bearer ${key}` },
      data: { fields: ['name'] },
    });
  const res = await query();
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { rows: { name: string }[] }).rows.map((r) => r.name)).toEqual([
    'Pump house, Risod',
  ]);
  await page.screenshot({ path: 'screenshots/integrations-01-key.png', fullPage: true });

  await page.getByRole('button', { name: 'Revoke Power BI' }).click();
  await expect(page.getByText('revoked')).toBeVisible();
  expect((await query()).status()).toBe(401);
});
