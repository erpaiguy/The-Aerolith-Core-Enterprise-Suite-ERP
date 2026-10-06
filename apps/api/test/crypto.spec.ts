import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, seal } from '../src/crypto/secretbox.js';
import {
  signEntitlement,
  verifyEntitlement,
  type Entitlement,
} from '../src/licensing/entitlement.js';

describe('secretbox', () => {
  const key = randomBytes(32);
  it('round-trips and never repeats ciphertext', () => {
    const a = seal('AERO-ABCDE', key);
    expect(open(a, key)).toBe('AERO-ABCDE');
    expect(seal('AERO-ABCDE', key)).not.toBe(a);
  });
  it('detects tampering and wrong keys', () => {
    const sealed = seal('secret', key);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => open(parts.join('.'), key)).toThrow();
    expect(() => open(sealed, randomBytes(32))).toThrow();
  });
});

describe('entitlement tokens', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload: Entitlement = {
    v: 1,
    lic: 'l',
    ten: 't',
    tier: 'trial',
    seats: 3,
    state: 'active',
    ends: '2027-01-01T00:00:00.000Z',
    dev: 'd',
    iat: 100,
    exp: 200,
  };

  it('verifies a genuine token and reports expiry', () => {
    const token = signEntitlement(payload, privateKey);
    expect(verifyEntitlement(token, publicKey, 150)).toEqual({ ok: true, payload, expired: false });
    expect(verifyEntitlement(token, publicKey, 250)).toMatchObject({ ok: true, expired: true });
  });

  it('rejects edited payloads and foreign keys', () => {
    const token = signEntitlement(payload, privateKey);
    const [p, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, seats: 500 })).toString('base64url');
    expect(verifyEntitlement(`${p}.${forged}.${sig}`, publicKey, 150)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const other = generateKeyPairSync('ed25519').publicKey;
    expect(verifyEntitlement(token, other, 150)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyEntitlement('garbage', publicKey, 150)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
