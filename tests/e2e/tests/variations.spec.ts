// Wave 4 step 4 in a real browser: a variation raised with a new item, submitted (no approval rules, so straight to
// the client), and approved by the client at a lower rate.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a variation raised, submitted and approved by the client for less', async ({ page }) => {
  test.setTimeout(150_000);
  await signInNewAdmin(
    page,
    `vo-${Date.now()}@akola-infra.in`,
    'Variation-Order-44',
    'Akola Infra',
  );
  const nav = (name: string) =>
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
  await nav('Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Hostel, Akola');
  const auth = page.waitForRequest(
    (r) => r.url().includes('/api/tenant/') && !!r.headers().authorization,
  );
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/([0-9a-f-]{36})$/);
  const projectId = /\/projects\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  const headers = { authorization: (await auth).headers().authorization! };

  // The contract BOQ, seeded through the API (its grid is covered by the BOQ tests): plaster 400 sqm at ₹300.
  const api = page.url().replace(/\/projects\/.*$/, '');
  const boq = await (
    await page.request.post(`${api}/api/tenant/projects/${projectId}/boqs`, {
      headers,
      data: { name: 'Contract', kind: 'contract' },
    })
  ).json();
  const changed = await page.request.post(`${api}/api/tenant/boqs/${boq.id}/changes`, {
    headers,
    data: {
      ops: [
        {
          op: 'insert',
          tempId: 'tS',
          parentId: null,
          afterId: null,
          type: 'section',
          code: 'A',
          description: 'Works',
        },
        {
          op: 'insert',
          tempId: 't1',
          parentId: 'tS',
          afterId: null,
          type: 'item',
          code: 'A.2',
          description: 'Plaster',
          unit: 'sqm',
          qty: '400',
          rate: '300',
        },
      ],
    },
  });
  expect(changed.ok()).toBe(true);

  // A railing, 20 m at ₹1,000 (cost ₹800): ₹20,000.
  await nav('Variations');
  await page.getByLabel('Project').selectOption({ index: 1 });
  const form = page.getByRole('form', { name: 'Raise a variation' });
  await form.getByLabel('What').fill('Terrace railing');
  await form.getByLabel('Instruction ref.').fill('EE/AKL/112');
  const line = form.getByRole('group', { name: 'Variation line 1' });
  await line.getByLabel('Code').fill('V.1');
  await line.getByLabel('Description').fill('MS railing');
  await line.getByLabel('Unit').fill('m');
  await line.getByLabel('Quantity').fill('20');
  await line.getByLabel('Cost rate').fill('800');
  await line.getByLabel('Rate', { exact: true }).fill('1000');
  await form.getByRole('button', { name: 'Raise' }).click();
  await expect(page.getByRole('row', { name: 'VO-001' })).toContainText('draft');
  await expect(page.getByText('Value ₹20,000, cost ₹16,000')).toBeVisible();

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('row', { name: 'VO-001' })).toContainText('submitted');
  // The client allows ₹900 a metre: ₹18,000.
  await page.getByLabel('Allowed rate, V.1').fill('900');
  const decision = page.getByRole('form', { name: "The client's decision" });
  await decision.getByLabel("Client's reference").fill('EE/AKL/140');
  await decision.getByRole('button', { name: 'Approved by the client' }).click();
  await expect(page.getByRole('row', { name: 'VO-001' })).toContainText('approved');
  await expect(page.getByText('approved ₹18,000 (EE/AKL/140)')).toBeVisible();
  await shot(page, 'variations');
});
