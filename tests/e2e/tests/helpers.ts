import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    { email: adminEmail, tenantName: 'Sharma Builders' },
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
