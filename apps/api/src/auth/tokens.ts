// Access tokens: short-lived (15 min), HMAC-SHA256 signed, stateless. Refresh tokens: opaque, single-use, rotated on
// every refresh, stored only as an HMAC (docs/09-security.md §3.3).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LicenceState } from '../licensing/licence-rules.js';

export const ACCESS_TTL_SECONDS = 15 * 60;

export type AccessClaims =
  | {
      v: 1;
      kind: 'tenant';
      ten: string;
      sub: string;
      role: 'admin' | 'manager' | 'worker';
      sid: string;
      /** Must change password before doing anything else. */
      mcp: boolean;
      lic: LicenceState;
      iat: number;
      exp: number;
    }
  | {
      v: 1;
      kind: 'operator';
      sub: string;
      role: 'owner' | 'support' | 'read_only';
      sid: string;
      mcp: boolean;
      iat: number;
      exp: number;
    }
  | {
      v: 1;
      kind: 'enroll';
      who: 'admin' | 'operator';
      sub: string;
      ten?: string;
      iat: number;
      exp: number;
    };

const sign = (key: Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest('base64url');

export function signAccessToken(claims: AccessClaims, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `at1.${body}.${sign(key, `at1.${body}`)}`;
}

export function verifyAccessToken(
  token: string,
  key: Buffer,
  nowSeconds: number,
): AccessClaims | null {
  const [prefix, body, sig] = token.split('.');
  if (prefix !== 'at1' || !body || !sig) return null;
  const expected = Buffer.from(sign(key, `at1.${body}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessClaims;
    return claims.v === 1 && claims.exp > nowSeconds ? claims : null;
  } catch {
    return null;
  }
}

/** Refresh token: `rt1.<scope>.<sessionId>.<secret>`. Scope is the tenant id, or `op` for operators. */
export function newRefreshToken(
  scope: string,
  sessionId: string,
): { token: string; secret: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `rt1.${scope}.${sessionId}.${secret}`, secret };
}

export function parseRefreshToken(
  token: string,
): { scope: string; sessionId: string; secret: string } | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'rt1') return null;
  const [, scope, sessionId, secret] = parts as [string, string, string, string];
  if (
    !/^[0-9a-f-]{36}$|^op$/.test(scope) ||
    !/^[0-9a-f-]{36}$/.test(sessionId) ||
    secret.length < 40
  )
    return null;
  return { scope, sessionId, secret };
}

export const hmacSecret = (secret: string, key: Buffer): string =>
  createHmac('sha256', key).update(secret).digest('hex');
