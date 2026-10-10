// Wave 2b step 1 in a real browser: the admin sets the approval rule for requisitions; a site engineer (in their own
// browser) raises one for the project from the rate library and a typed line, and submits it; the project's lead
// finds it waiting, rejects it with a reason; the engineer changes it and submits again; the lead approves.
import { expect, test, type Page } from '@playwright/test';
import { logPageOnFailure, signInNewAdmin, signInStaff } from './helpers.js';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const card = (page: Page, title: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: new RegExp(`^${name}( \\d+)?$`) })
    .click();

test.afterEach(async ({ page }, info) => logPageOnFailure(page, info));

test('a site engineer raises a requisition; the lead rejects it, then approves it changed', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const adminEmail = `approvals-${Date.now()}@risod-buildcon.in`;
  await signInNewAdmin(page, adminEmail, 'Purchase-Requisition-Level-41', 'Risod Buildcon');

  // 1. The admin adds the site engineer, cement to the rate library, and the rule: the project's lead approves.
  await nav(page, 'Users');
  await page.getByLabel('Username').fill('raju');
  await page.getByLabel('Full name').fill('Raju Shinde');
  await page.getByLabel('Role').selectOption('worker');
  await page.getByRole('button', { name: 'Add user' }).click();
  const oneTime = (await page.getByTestId('one-time-password').textContent())!.trim();

  await nav(page, 'Resources');
  await page.getByRole('button', { name: 'New resource' }).click();
  const form = card(page, 'New resource');
  await form.getByLabel('Code').fill('CEM-OPC53');
  await form.getByLabel('Name').fill('Cement OPC 53, 50 kg bag');
  await form.getByLabel('Type').selectOption('material');
  await form.getByLabel('Unit', { exact: true }).fill('bag');
  await form.getByLabel('Rate (₹)').fill('400');
  await page.getByRole('button', { name: 'Add resource' }).click();
  await expect(page.getByText('CEM-OPC53').first()).toBeVisible();

  await nav(page, 'Approval rules');
  const rules = page.getByRole('form', { name: 'Rules for purchase requisitions' });
  await expect(card(page, 'Purchase requisitions')).toContainText(
    'approved as soon as it is submitted',
  );
  await rules.getByRole('button', { name: 'Level' }).click();
  await rules.getByLabel('Name of the level').fill('Project manager');
  await rules.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByTestId('rules-summary-purchase_requisition')).toContainText(
    "Level 1 from ₹0: the project's lead",
  );
  await page.reload();
  await expect(rules.getByLabel('Name of the level')).toHaveValue('Project manager');

  // 2. The project, led by the admin, with Raju on its team.
  await nav(page, 'Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Girls hostel, Risod');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = page.url();
  await page.getByLabel('Add to the team').selectOption({ label: 'Raju Shinde' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Team' })).toContainText('Raju Shinde');

  // 3. Raju, in his own browser: 100 bags from the library at ₹400 and 25 kg of binding wire at ₹90.
  const raju = await (await browser.newContext()).newPage();
  await signInStaff(raju, adminEmail, 'raju', oneTime, 'Binding-Wire-Coil-25');
  await raju.goto(projectUrl);
  await card(raju, /^Requisitions/)
    .getByRole('button', { name: 'New requisition' })
    .click();
  await raju.getByLabel('What is it for?').fill('Cement and wire for the first slab');
  await raju.getByRole('button', { name: 'Create', exact: true }).click();
  await raju.waitForURL(/\/requisitions\/[0-9a-f-]{36}$/);
  const requisitionUrl = raju.url();
  await raju.getByLabel('Find in the rate library').fill('CEM');
  await raju.getByLabel('Resource', { exact: true }).selectOption({ index: 1 });
  await raju.getByRole('button', { name: 'Add', exact: true }).click();
  const line1 = raju.getByRole('group', { name: 'Line 1' });
  await expect(line1.getByLabel('What')).toHaveValue('Cement OPC 53, 50 kg bag');
  await line1.getByLabel('Quantity').fill('100');
  await raju.getByRole('button', { name: 'Line typed in' }).click();
  const line2 = raju.getByRole('group', { name: 'Line 2' });
  await line2.getByLabel('What').fill('Binding wire');
  await line2.getByLabel('Unit').fill('kg');
  await line2.getByLabel('Quantity').fill('25');
  await line2.getByLabel('Rate ₹').fill('90');
  await expect(raju.getByTestId('draft-total')).toContainText('₹42,250');
  await raju.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(raju.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await raju.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(raju.getByText('Waiting for approval')).toBeVisible();
  await expect(raju.getByTestId('level-1')).toContainText("Project manager · The project's lead");
  await shot(raju, 'approvals-01-submitted');

  // 4. The lead finds it waiting on them and rejects it with a reason.
  await page.reload();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Approvals/ }),
  ).toContainText('1');
  await nav(page, 'Approvals');
  await page
    .getByRole('rowgroup', { name: 'Waiting on me' })
    .getByRole('link', { name: /Cement and wire for the first slab/ })
    .click();
  await expect(page.getByRole('table')).toContainText('Binding wire');
  await expect(page.getByTestId('requisition-total')).toHaveText('₹42,250');
  await page.getByLabel(/^Note/).fill('Order 80 bags; 20 are in the store');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('list', { name: 'Approval history' })).toContainText(
    'Order 80 bags; 20 are in the store',
  );
  await shot(page, 'approvals-02-rejected');

  // 5. Raju changes it to 80 bags and submits again; the lead approves.
  await raju.goto(requisitionUrl);
  await expect(raju.getByText(/Rejected: Order 80 bags/)).toBeVisible();
  await raju.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('80');
  await expect(raju.getByTestId('draft-total')).toContainText('₹34,250');
  await raju.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(raju.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await raju.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(raju.getByText('Waiting for approval')).toBeVisible();

  await nav(page, 'Approvals');
  await page
    .getByRole('rowgroup', { name: 'Waiting on me' })
    .getByRole('link', { name: /Cement and wire for the first slab/ })
    .click();
  await expect(page.getByTestId('requisition-total')).toHaveText('₹34,250');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('level-1')).toContainText(`Approved by ${adminEmail}`);

  // 6. Raju sees it approved, and is told.
  await raju.goto(requisitionUrl);
  await expect(raju.getByText('Approved', { exact: true })).toBeVisible();
  await nav(raju, 'Home');
  await expect(raju.getByText(/Approved: PR\/\d{4}-\d{2}\/0001/)).toBeVisible();
  await raju.goto(requisitionUrl);
  await shot(raju, 'approvals-03-approved');
});
