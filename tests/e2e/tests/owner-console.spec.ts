// The owner console in a real browser: first sign-in with the CLI's one-time password, authenticator enrolment,
// a new trial, a local test database, resending the key, and the audit trail.
import { expect, test } from '@playwright/test';
import { OWNER_UI } from '../env.js';
import { createOperator, licenceKeyIn, timeStep, totp, waitForEmail } from './helpers.js';

const shot = (name: string) => ({ path: `screenshots/${name}.png`, fullPage: true });

test('owner signs in, creates a trial, sets up its database and resends the key', async ({
  page,
}) => {
  const operator = createOperator();
  const tenantAdmin = `accounts-${Date.now()}@verma-interiors.in`;

  // 1. First sign-in: one-time password, then the authenticator (mandatory), then a new password.
  await page.goto(OWNER_UI);
  await expect(page.getByRole('heading', { name: 'Owner console' })).toBeVisible();
  await page.getByLabel('Email').fill(operator.email);
  await page.getByLabel('Password').fill(operator.tempPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  const step = timeStep();
  await page.getByLabel('6-digit code').fill(totp(secret, step));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  await page.getByRole('button', { name: /I have saved them/ }).click();
  await page.getByLabel('Authenticator code').fill(totp(secret, step + 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
  await page.getByLabel('One-time password').fill(operator.tempPassword);
  await page.getByLabel('New password', { exact: true }).fill('Owner-Console-Pass-2026');
  await page.getByLabel('Repeat new password').fill('Owner-Console-Pass-2026');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.screenshot(shot('owner-01-overview'));

  // 2. A reload keeps the session (refresh cookie), without asking for the code again.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // 3. New trial: the tenant admin gets the key and the password link by email.
  await page.getByRole('link', { name: 'Tenants' }).click();
  await page.getByRole('button', { name: 'New trial' }).click();
  await page.getByLabel('Admin email').fill(tenantAdmin);
  await page.getByLabel('Company name').fill('Verma Interiors');
  await page.getByRole('button', { name: 'Create trial and email key' }).click();
  await expect(page.getByRole('heading', { name: 'Verma Interiors' })).toBeVisible();
  await expect(page.getByText('trial · active')).toBeVisible();
  const firstKey = licenceKeyIn(await waitForEmail(tenantAdmin, 'Your Aerolith Core licence key'));

  // 4. The local test database (stage 0 stand-in for the tenant's Supabase project) becomes ready.
  await page.getByRole('button', { name: 'Use a local test database' }).click();
  await expect(page.getByText('ready', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^\d{4}_[\w-]+\.sql$/)).toBeVisible();
  await page.screenshot(shot('owner-02-tenant'));

  // 5. Resend the key: it arrives again by email and never appears on screen.
  await page.getByRole('button', { name: 'Email the key again' }).click();
  await expect(page.getByText(`Licence key emailed to ${tenantAdmin}.`)).toBeVisible();
  await expect(page.getByText(firstKey)).toHaveCount(0);

  // 6. The audit log records what happened, and the tenant shows up in search.
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByText('Emailed licence key').first()).toBeVisible();
  await expect(page.getByText('Created trial').first()).toBeVisible();
  await page.getByRole('link', { name: 'Tenants' }).click();
  await page.getByLabel('Search tenants').fill('verma');
  await expect(page.getByRole('link', { name: 'Verma Interiors' })).toBeVisible();
  await page.getByLabel('Search tenants').fill('no-such-company');
  await expect(page.getByText('No tenant matches that search.')).toBeVisible();

  // 7. Sign out ends the session; a reload stays signed out.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Owner console' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Owner console' })).toBeVisible();
});
