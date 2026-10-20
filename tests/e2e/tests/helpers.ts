import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { simpleParser } from 'mailparser';
import {
  CONTROL_URL,
  INBOX_DIR,
  OPERATOR_CMD,
  OPERATOR_CWD,
  OWNER_API,
  PUBLIC_API,
} from '../env.js';

// --- TOTP (RFC 6238), same algorithm as the API ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export const timeStep = () => Math.floor(Date.now() / 30_000);
export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', b32decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// --- the inbox: the API writes every email as a .eml file (EMAIL_TRANSPORT=file) ---
export interface Email {
  subject: string;
  text: string;
}

/** Waits for the email worker (10 s poll) to deliver a message with this subject to this address. */
export async function waitForEmail(
  to: string,
  subject: string,
  timeoutMs = 40_000,
): Promise<Email> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(INBOX_DIR)) {
      for (const file of readdirSync(INBOX_DIR).sort().reverse()) {
        if (!file.endsWith(`-${to.toLowerCase()}.eml`)) continue;
        const mail = await simpleParser(readFileSync(join(INBOX_DIR, file)));
        if (mail.subject === subject) return { subject, text: mail.text ?? '' };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email "${subject}" to ${to} within ${timeoutMs} ms`);
}

export const linkIn = (email: Email): string => {
  const m = /https?:\/\/\S+token=[\w-]+/.exec(email.text);
  if (!m) throw new Error(`no link in "${email.subject}"`);
  return m[0];
};

export const licenceKeyIn = (email: Email): string => {
  const m = /AERO(?:-[0-9A-Z]{5}){4}/.exec(email.text);
  if (!m) throw new Error('no licence key in the email');
  return m[0];
};

async function call<T>(path: string, body?: unknown, token?: string): Promise<T> {
  // Owner-console routes (and operator MFA) go to the owner listener; everything else to the public site.
  const base =
    path.startsWith('/owner') || (path.startsWith('/auth/mfa') && !token) ? OWNER_API : PUBLIC_API;
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Creates an owner-console operator with the real CLI (inside the API container when testing the Docker stack). */
export function createOperator(): { email: string; tempPassword: string } {
  const email = `owner-${Date.now()}@aerolith.test`;
  const args = ['--email', email, '--name', 'E2E Owner'];
  const out = (
    OPERATOR_CMD
      ? execFileSync(OPERATOR_CMD[0]!, [...OPERATOR_CMD.slice(1), ...args], { cwd: OPERATOR_CWD })
      : execFileSync('node', ['../../apps/api/dist/cli/create-operator.js', ...args], {
          env: { ...process.env, CONTROL_DATABASE_URL: CONTROL_URL },
        })
  ).toString();
  return { email, tempPassword: /One-time password: (\S+)/.exec(out)![1]! };
}

/**
 * Owner-console setup through the real flows: create an operator with the CLI, enrol MFA, change the one-time
 * password, create a trial tenant, provision its database locally and wait until it is ready.
 */
export async function createTenant(
  adminEmail: string,
  tenantName = 'Sharma Builders',
): Promise<{ licenceKey: string; tenantId: string }> {
  const { email: operatorEmail, tempPassword } = createOperator();

  const first = await call<{ enrollmentToken: string }>('/owner/auth/login', {
    email: operatorEmail,
    password: tempPassword,
  });
  const { secret } = await call<{ secret: string }>('/auth/mfa/enroll', {
    enrollmentToken: first.enrollmentToken,
  });
  const step = timeStep();
  await call('/auth/mfa/confirm', {
    enrollmentToken: first.enrollmentToken,
    code: totp(secret, step),
  });
  const login = await call<{ accessToken: string }>('/owner/auth/login', {
    email: operatorEmail,
    password: tempPassword,
    code: totp(secret, step + 1),
  });
  const { accessToken } = await call<{ accessToken: string }>(
    '/owner/auth/change-password',
    { currentPassword: tempPassword, newPassword: 'E2E-Owner-Console-26' },
    login.accessToken,
  );

  const trial = await call<{ tenantId: string; licenceKey: string }>(
    '/owner/tenants',
    { email: adminEmail, tenantName },
    accessToken,
  );
  await call(
    `/owner/tenants/${trial.tenantId}/provision`,
    { provider: 'local_postgres' },
    accessToken,
  );
  for (let i = 0; i < 60; i++) {
    const db = await call<{ status: string; lastError: string | null }>(
      `/owner/tenants/${trial.tenantId}/database`,
      undefined,
      accessToken,
    );
    if (db.status === 'ready') return trial;
    if (db.status === 'failed') throw new Error(`provisioning failed: ${db.lastError}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('provisioning timed out');
}

/**
 * A brand-new tenant admin, signed in on `page`: trial + database via the owner API, password from the emailed setup
 * link, device activated with the emailed key, authenticator enrolled in the UI.
 */
export async function signInNewAdmin(
  page: Page,
  adminEmail: string,
  password: string,
  tenantName: string,
): Promise<void> {
  await createTenant(adminEmail, tenantName);
  const key = licenceKeyIn(await waitForEmail(adminEmail, 'Your Aerolith Core licence key'));
  const link = new URL(
    linkIn(await waitForEmail(adminEmail, 'Set your Aerolith Core admin password')),
  );
  await call('/auth/admin/set-password', {
    token: link.searchParams.get('token'),
    newPassword: password,
  });

  await page.goto('/');
  await page.getByLabel('Licence key').fill(key);
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByLabel('Username or admin email').fill(adminEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  const step = timeStep();
  await page.getByLabel('6-digit code').fill(totp(secret, step));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('button', { name: /continue to sign in/ }).click();
  await page.getByLabel('Authenticator code').fill(totp(secret, step + 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await acceptTerms(page);
  await page.getByRole('link', { name: 'Home' }).waitFor();
}

/**
 * A staff member the admin added, signing in on a fresh browser context (`page`): the device is activated with the
 * tenant's licence key (from the admin's email), then the one-time password is changed for their own.
 */
export async function signInStaff(
  page: Page,
  adminEmail: string,
  username: string,
  oneTimePassword: string,
  newPassword: string,
): Promise<void> {
  const key = licenceKeyIn(await waitForEmail(adminEmail, 'Your Aerolith Core licence key'));
  await page.goto('/');
  await page.getByLabel('Licence key').fill(key);
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByLabel('Username or admin email').fill(username);
  await page.getByLabel('Password').fill(oneTimePassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('One-time password').fill(oneTimePassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Repeat new password').fill(newPassword);
  await page.getByRole('button', { name: 'Save password' }).click();
  await acceptTerms(page);
  await page.getByRole('link', { name: 'Home' }).waitFor();
}

/**
 * The legal documents asked at a person's first sign-in (docs/wave9-plan.md step 9b.3): ticks each one and accepts.
 * Returns how many there were (none when this person accepted them before).
 */
export async function acceptTerms(page: Page): Promise<number> {
  const home = page.getByRole('link', { name: 'Home' });
  const ask = page.getByRole('heading', { name: 'Before you start' });
  await home.or(ask).first().waitFor({ timeout: 30_000 });
  if (!(await ask.isVisible())) return 0;
  const boxes = await page.getByRole('checkbox').all();
  for (const box of boxes) await box.check();
  await page.getByRole('button', { name: 'Accept and continue' }).click();
  await home.waitFor();
  return boxes.length;
}

/**
 * On failure, prints where the page was and what it showed. CI keeps traces as artifacts, but this puts the essentials
 * in the job log itself, readable where artifacts cannot be downloaded.
 */
export async function logPageOnFailure(
  page: Page,
  info: { status?: string | undefined; expectedStatus: string; title: string },
) {
  if (info.status === info.expectedStatus) return;
  const snapshot = await page
    .locator('body')
    .ariaSnapshot({ timeout: 2000 })
    .catch(() => '(no snapshot)');
  console.error(`--- "${info.title}" failed at ${page.url()}\n${snapshot.slice(0, 4000)}\n---`);
}
