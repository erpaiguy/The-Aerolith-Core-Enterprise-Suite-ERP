import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateLicenceKey,
  licenceKeyHmac,
  parseLicenceKey,
} from '../src/licensing/licence-key.js';

describe('licence keys', () => {
  it('generates well-formed, unique, self-validating keys', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const key = generateLicenceKey();
      expect(key).toMatch(/^AERO-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
      expect(parseLicenceKey(key)).toMatchObject({ ok: true, formatted: key });
      keys.add(key);
    }
    expect(keys.size).toBe(2000);
  });

  it('accepts the way people type keys', () => {
    const key = generateLicenceKey();
    const body = key.slice(5).replace(/-/g, '');
    for (const typed of [
      key.toLowerCase(),
      body,
      ` ${body.slice(0, 10)} ${body.slice(10)} `,
      key.replace(/0/g, 'O').replace(/1/g, 'l'),
    ]) {
      expect(parseLicenceKey(typed)).toMatchObject({ ok: true, formatted: key });
    }
  });

  it('catches every single-character typo', () => {
    const key = generateLicenceKey();
    const body = key.slice(5).replace(/-/g, '');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let i = 0; i < body.length; i++) {
      for (const c of alphabet) {
        if (c === body[i]) continue;
        const typo = body.slice(0, i) + c + body.slice(i + 1);
        expect(parseLicenceKey(typo)).toEqual({ ok: false, reason: 'checksum' });
      }
    }
  });

  it('rejects things that are not keys', () => {
    for (const s of ['', 'hello', 'AERO-12345', 'U'.repeat(20)]) {
      expect(parseLicenceKey(s)).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('derives a stable HMAC that depends on the pepper', () => {
    const body = 'ABCDEFGHJKMNPQRSTVW0';
    const pepper = randomBytes(32);
    expect(licenceKeyHmac(body, pepper)).toBe(licenceKeyHmac(body, pepper));
    expect(licenceKeyHmac(body, pepper)).not.toBe(licenceKeyHmac(body, randomBytes(32)));
  });
});
