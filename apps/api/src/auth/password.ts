// Passwords (docs/09-security.md §3.3): Argon2id, minimum length, a built-in list of the most common passwords, and
// no passwords that contain the username. A remote breached-password check can be added behind an adapter later; it
// is left out so self-hosted tenants work offline.
import { hash, verify, type Options } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 10;

// Argon2id at roughly OWASP's minimum (19 MiB, 2 passes). Tune upwards on the production server.
// algorithm 2 = Argon2id (the package exports it as a const enum, which isolated modules can't reference).
const ARGON2: Options = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

const COMMON = new Set([
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'password12',
  'password123',
  'password1234',
  'iloveyou123',
  '1q2w3e4r5t',
  'qwerty1234',
  'qwerty12345',
  'abc1234567',
  'welcome123',
  'admin12345',
  'administrator',
  'letmein123',
  'sunshine123',
  '0987654321',
  '1111111111',
  '0000000000',
  'india12345',
  'india@123',
  'passw0rd123',
  'changeme123',
  'football123',
  'princess123',
  'monkey12345',
  'dragon12345',
  'master12345',
  'superman123',
  'aerolith123',
  'construction',
]);

export type PolicyResult =
  { ok: true } | { ok: false; reason: 'too_short' | 'too_common' | 'contains_username' };

export function checkPasswordPolicy(password: string, username: string): PolicyResult {
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return { ok: false, reason: 'too_common' };
  const name = username.toLowerCase().split('@')[0] ?? '';
  if (name.length >= 3 && lower.includes(name)) return { ok: false, reason: 'contains_username' };
  return { ok: true };
}

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2);

/** Constant-time verification. A missing hash still costs one Argon2 run so timing doesn't reveal unknown users. */
export async function verifyPassword(
  storedHash: string | null,
  password: string,
): Promise<boolean> {
  if (!storedHash) {
    await hash(password, ARGON2);
    return false;
  }
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** One-time passwords handed out by an admin: 12 characters, no look-alikes, easy to read aloud or type. */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
