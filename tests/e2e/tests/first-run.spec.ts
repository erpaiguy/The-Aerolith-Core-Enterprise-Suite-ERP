// The first-run journey of a new tenant, in a real browser against the real API and databases.
import { expect, test } from '@playwright/test';
import { createTenant, licenceKeyIn, linkIn, timeStep, totp, waitForEmail } from './helpers.js';

const ADMIN = 'admin@sharma-builders.in';
const ADMIN_PASSWORD = 'Monsoon-Slab-Pour-7';
const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

test('admin activates, secures the account, adds a worker; the worker sets a password and adds a reminder', async ({
  page,
}) => {
  await createTenant(ADMIN);
  // The licence key arrives by email, sent by the email worker.
  const licenceKey = licenceKeyIn(await waitForEmail(ADMIN, 'Your Aerolith Core licence key'));

  // 1. First launch: the device needs the licence key. A typo is caught before the server is asked.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Activate this device' })).toBeVisible();
  await page
    .getByLabel('Licence key')
    .fill(`${licenceKey.slice(0, -1)}${licenceKey.at(-1) === 'A' ? 'B' : 'A'}`);
  await expect(page.getByRole('alert')).toContainText('typo');
  await page.getByLabel('Licence key').fill(licenceKey.toLowerCase().replace(/-/g, ' '));
  await expect(page.getByText('Key format looks right.')).toBeVisible();
  await page.screenshot(shot('01-activate'));
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // 2. The admin sets a password from the emailed setup link.
  const setupLink = new URL(
    linkIn(await waitForEmail(ADMIN, 'Set your Aerolith Core admin password')),
  );
  await page.goto(`${setupLink.pathname}${setupLink.search}`);
  await page.getByLabel('New password', { exact: true }).fill('short');
  await page.getByLabel('Repeat new password').fill('short');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 10 characters');
  await page.getByLabel('New password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel('Repeat new password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText('Password saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Go to sign in' }).click();

  // 3. First admin sign-in requires authenticator enrolment.
  await page.getByLabel('Username or admin email').fill(ADMIN);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
  await expect(page.getByAltText('Authenticator QR code')).toBeVisible();
  await page.screenshot(shot('02-authenticator'));
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  const step = timeStep();
  await page.getByLabel('6-digit code').fill(totp(secret, step));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  await page.screenshot(shot('03-recovery-codes'));
  await page.getByRole('button', { name: /continue to sign in/ }).click();
  await page.getByLabel('Authenticator code').fill(totp(secret, step + 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|day), admin$/ })).toBeVisible();
  await expect(page.getByText('Trial ends')).toBeVisible();
  await page.screenshot(shot('04-admin-home'));

  // 4. The admin adds a worker and sees the one-time password once.
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page.getByText('1 of 3 seats in use')).toBeVisible();
  await page.getByLabel('Username').fill('suresh');
  await page.getByLabel('Full name').fill('Suresh Patil');
  await page.getByLabel('Role').selectOption('worker');
  await page.getByRole('button', { name: 'Add user' }).click();
  const oneTime = (await page.getByTestId('one-time-password').textContent())!.trim();
  await expect(page.getByText('2 of 3 seats in use')).toBeVisible();
  await page.screenshot(shot('05-users'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // 5. The worker signs in with the one-time password and must choose their own.
  await page.getByLabel('Username or admin email').fill('suresh');
  await page.getByLabel('Password').fill(oneTime);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
  await page.getByLabel('One-time password').fill(oneTime);
  await page.getByLabel('New password', { exact: true }).fill('Tower-Crane-Lift-31');
  await page.getByLabel('Repeat new password').fill('Tower-Crane-Lift-31');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|day), Suresh/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);

  // 6. The session survives a reload (refresh token in the HttpOnly cookie, never readable by the page).
  expect(await page.evaluate(() => document.cookie)).not.toContain('aerolith_rt');
  await page.reload();
  await expect(page.getByRole('heading', { name: /Good (morning|day), Suresh/ })).toBeVisible();

  // 7. A reminder in the past is due now and lands in the inbox.
  await page.getByLabel('Remind me to').fill('Submit tender T-114 documents');
  const due = new Date(Date.now() - 60_000);
  const local = new Date(due.getTime() - due.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  await page.getByLabel('When').fill(local);
  await page.getByRole('button', { name: 'Add reminder' }).click();
  await expect(
    page.locator('section', { hasText: 'Inbox' }).getByText('Submit tender T-114 documents'),
  ).toBeVisible();
  await page.screenshot(shot('06-worker-home'));
});
