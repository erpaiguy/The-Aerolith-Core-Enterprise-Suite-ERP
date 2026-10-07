import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  hashPassword,
  temporaryPassword,
  verifyPassword,
} from '../src/auth/password.js';
import {
  hmacSecret,
  newRefreshToken,
  parseRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from '../src/auth/tokens.js';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  timeStep,
  totpCode,
  verifyTotp,
} from '../src/auth/totp.js';

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 6238 SHA-1 test vectors (last 6 digits)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpCode(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('hello aerolith');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('accepts one step of clock drift and rejects replays', () => {
    const secret = newTotpSecret();
    const now = new Date('2026-10-07T10:00:00Z');
    const step = timeStep(now);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull(); // already used
    expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
  });

  it('issues ten distinct recovery codes and hashes them case-insensitively', () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(looksLikeRecoveryCode(c)).toBe(true);
    expect(hashRecoveryCode(codes[0]!.toLowerCase())).toBe(hashes[0]);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });
});

describe('passwords', () => {
  it('enforces the policy', () => {
    expect(checkPasswordPolicy('short', 'ravi')).toEqual({ ok: false, reason: 'too_short' });
    expect(checkPasswordPolicy('password123', 'ravi')).toEqual({ ok: false, reason: 'too_common' });
    expect(checkPasswordPolicy('aaaaaaaaaaaa', 'ravi')).toEqual({
      ok: false,
      reason: 'too_common',
    });
    expect(checkPasswordPolicy('ravi-site-2026', 'Ravi')).toEqual({
      ok: false,
      reason: 'contains_username',
    });
    expect(checkPasswordPolicy('admin-sharma-2026', 'sharma@builders.in')).toEqual({
      ok: false,
      reason: 'contains_username',
    });
    expect(checkPasswordPolicy('Monsoon-Slab-Pour-7', 'ravi')).toEqual({ ok: true });
  });

  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('Monsoon-Slab-Pour-7');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'Monsoon-Slab-Pour-7')).toBe(true);
    expect(await verifyPassword(hash, 'monsoon-slab-pour-7')).toBe(false);
    expect(await verifyPassword(null, 'anything')).toBe(false);
  });

  it('makes readable temporary passwords', () => {
    expect(temporaryPassword()).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{12}$/);
  });
});

describe('tokens', () => {
  const key = Buffer.from('k'.repeat(32));
  const claims: AccessClaims = {
    v: 1,
    kind: 'tenant',
    ten: 't',
    sub: 'u',
    role: 'worker',
    sid: 's',
    mcp: false,
    lic: 'active',
    iat: 100,
    exp: 200,
  };

  it('verifies, expires and rejects tampering', () => {
    const token = signAccessToken(claims, key);
    expect(verifyAccessToken(token, key, 150)).toEqual(claims);
    expect(verifyAccessToken(token, key, 200)).toBeNull();
    const [p, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url');
    expect(verifyAccessToken(`${p}.${forged}.${sig}`, key, 150)).toBeNull();
    expect(verifyAccessToken(token, Buffer.from('x'.repeat(32)), 150)).toBeNull();
  });

  it('formats and parses refresh tokens', () => {
    const tenant = '3f9a1c2b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const session = '11111111-2222-4333-8444-555555555555';
    const { token, secret } = newRefreshToken(tenant, session);
    expect(parseRefreshToken(token)).toEqual({ scope: tenant, sessionId: session, secret });
    expect(parseRefreshToken(newRefreshToken('op', session).token)?.scope).toBe('op');
    expect(parseRefreshToken('rt1.not-a-uuid.x.y')).toBeNull();
    expect(hmacSecret(secret, key)).toBe(hmacSecret(secret, key));
  });
});
