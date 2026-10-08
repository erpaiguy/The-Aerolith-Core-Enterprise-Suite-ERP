import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

describe('loadConfig', () => {
  it('refuses to start in production without secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/must be set in production/);
  });
  it('generates throwaway secrets outside production and says so', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.ephemeralSecrets).toEqual(
      expect.arrayContaining([
        'SESSION_SIGNING_KEY',
        'LICENCE_KEY_PEPPER',
        'CONTROL_PLANE_ENC_KEY',
        'ENTITLEMENT_PRIVATE_KEY_PEM',
      ]),
    );
    expect(config.trialDays).toBe(120);
  });

  it('treats empty values from a copied .env.example as not set', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      SMTP_HOST: '',
      SUPPORT_EMAIL: '',
      EMAIL_FROM: '  ',
      TRIAL_DAYS: '',
    });
    expect(config.email).toMatchObject({ transport: 'file', supportEmail: null, smtp: null });
    expect(config.trialDays).toBe(120);
  });
});
