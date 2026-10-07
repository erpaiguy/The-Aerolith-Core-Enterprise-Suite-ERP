import { describe, expect, it } from 'vitest';
import { decodeEntitlement } from './session';

describe('decodeEntitlement', () => {
  it('reads the payload for display and rejects garbage', () => {
    const payload = {
      lic: 'l',
      ten: 't',
      tier: 'trial',
      seats: 3,
      state: 'active',
      ends: '2027-02-04T00:00:00.000Z',
      exp: 1,
    };
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeEntitlement(`ent1.${body}.sig`)).toEqual(payload);
    expect(decodeEntitlement('nonsense')).toBeNull();
  });
});
