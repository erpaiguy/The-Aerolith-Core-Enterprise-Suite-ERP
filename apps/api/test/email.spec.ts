import { describe, expect, it } from 'vitest';
import { classifyDeliveryError } from '../src/email/adapter.js';
import { renderEmail, UnknownTemplateError } from '../src/email/templates.js';

const ctx = {
  productName: 'Aerolith Core',
  websiteUrl: 'https://aerolith.example.in',
  supportEmail: 'help@aerolith.example.in',
};

describe('email templates', () => {
  it('puts the licence key and trial end date in the licence email', () => {
    const e = renderEmail(
      {
        template: 'licence_key',
        data: { tenantName: 'Sharma Builders', endsAt: '2027-02-04T00:00:00Z' },
        licenceKey: 'AERO-ABCDE-FGHJK-MNPQR-STVWX',
      },
      ctx,
    );
    expect(e.subject).toBe('Your Aerolith Core licence key');
    expect(e.text).toContain('AERO-ABCDE-FGHJK-MNPQR-STVWX');
    expect(e.text).toContain('4 February 2027');
    expect(e.html).toContain('AERO-ABCDE-FGHJK-MNPQR-STVWX');
    expect(e.text).toContain('help@aerolith.example.in');
    expect(e.text).toContain('open it in your browser at https://aerolith.example.in');
  });

  it('includes the link as a button and as plain text', () => {
    const link = 'https://aerolith.example.in/account/set-password?token=abc&x=1';
    const e = renderEmail({ template: 'admin_password_setup', data: {}, link }, ctx);
    expect(e.text).toContain(link);
    expect(e.html).toContain(
      'href="https://aerolith.example.in/account/set-password?token=abc&amp;x=1"',
    );
  });

  it('escapes values in HTML', () => {
    const e = renderEmail(
      {
        template: 'licence_key',
        data: { tenantName: '<script>alert(1)</script>', endsAt: '2027-01-01' },
        licenceKey: 'K',
      },
      ctx,
    );
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
  });

  it('rejects unknown templates', () => {
    expect(() => renderEmail({ template: 'nope', data: {} }, ctx)).toThrow(UnknownTemplateError);
  });
});

describe('classifyDeliveryError', () => {
  it('treats a rejected recipient as a hard bounce, a rejected message as final, everything else as retryable', () => {
    expect(classifyDeliveryError({ responseCode: 550, command: 'RCPT TO' })).toBe(
      'permanent_bad_recipient',
    );
    expect(classifyDeliveryError({ responseCode: 554, command: 'DATA' })).toBe('permanent');
    expect(classifyDeliveryError({ responseCode: 451, command: 'DATA' })).toBe('retry');
    expect(classifyDeliveryError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(
      'retry',
    );
    // Configuration problems must not throw away queued customer emails.
    expect(classifyDeliveryError({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' })).toBe(
      'retry',
    );
    expect(classifyDeliveryError({ responseCode: 550, command: 'MAIL FROM' })).toBe('retry');
  });
});
