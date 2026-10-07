import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHmac } from 'node:crypto';
import postgres from 'postgres';
import { API_PORT, CONTROL_URL, ENC_KEY } from '../env.js';

const API = `http://127.0.0.1:${API_PORT}/api`;

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

// --- sealed values in the control plane (AES-256-GCM, see apps/api/src/crypto/secretbox.ts) ---
function unseal(sealed: string): string {
  const [, iv, tag, ct] = sealed.split('.');
  const d = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(ENC_KEY, 'base64'),
    Buffer.from(iv!, 'base64url'),
  );
  d.setAuthTag(Buffer.from(tag!, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct!, 'base64url')), d.final()]).toString('utf8');
}

/** The newest emailed link of a template for an address (stands in for reading the inbox). */
export async function emailedLink(template: string, to: string): Promise<string> {
  const sql = postgres(CONTROL_URL, { max: 1 });
  try {
    const [row] = await sql<{ data: { link: string } }[]>`
      SELECT data FROM core.email_outbox WHERE template = ${template} AND lower(to_email) = lower(${to})
      ORDER BY created_at DESC LIMIT 1`;
    return unseal(row!.data.link);
  } finally {
    await sql.end();
  }
}

async function call<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
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

/**
 * Owner-console setup through the real flows: create an operator with the CLI, enrol MFA, change the one-time
 * password, create a trial tenant, provision its database locally and wait until it is ready.
 */
export async function createTenant(
  adminEmail: string,
): Promise<{ licenceKey: string; tenantId: string }> {
  const env = { ...process.env, CONTROL_DATABASE_URL: CONTROL_URL };
  const operatorEmail = `owner-${Date.now()}@aerolith.test`;
  const out = execFileSync(
    'node',
    ['../../apps/api/dist/cli/create-operator.js', '--email', operatorEmail, '--name', 'E2E Owner'],
    { env },
  ).toString();
  const tempPassword = /One-time password: (\S+)/.exec(out)![1]!;

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
