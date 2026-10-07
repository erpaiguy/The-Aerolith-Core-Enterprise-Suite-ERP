// Signs in a fresh owner-console operator through the real flow: one-time password -> authenticator enrolment ->
// TOTP sign-in -> mandatory password change. Returns an access token for the owner routes.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { OperatorAuthService } from '../../src/auth/operator-auth.service.js';
import { timeStep, totpCode } from '../../src/auth/totp.js';

export async function signInOperator(
  app: NestFastifyApplication,
  email = `owner-${randomUUID().slice(0, 8)}@aerolith.test`,
) {
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const { temporaryPassword } = await app
    .get(OperatorAuthService)
    .createOperator(email, 'Owner', 'owner');

  const first = (await post('/owner/auth/login', { email, password: temporaryPassword })).json<{
    enrollmentToken: string;
  }>();
  const { secret } = (
    await post('/auth/mfa/enroll', { enrollmentToken: first.enrollmentToken })
  ).json<{ secret: string }>();
  const step = timeStep(new Date());
  const confirmed = await post('/auth/mfa/confirm', {
    enrollmentToken: first.enrollmentToken,
    code: totpCode(secret, step),
  });
  if (confirmed.statusCode !== 200) throw new Error(`MFA confirm failed: ${confirmed.body}`);
  const login = (
    await post('/owner/auth/login', {
      email,
      password: temporaryPassword,
      code: totpCode(secret, step + 1),
    })
  ).json<{
    accessToken: string;
    refreshToken: string;
  }>();
  const changed = await post(
    '/owner/auth/change-password',
    { currentPassword: temporaryPassword, newPassword: 'Owner-Console-Pass-2026' },
    { authorization: `Bearer ${login.accessToken}` },
  );
  if (changed.statusCode !== 200) throw new Error(`password change failed: ${changed.body}`);
  const { accessToken } = changed.json<{ accessToken: string }>();
  return {
    email,
    secret,
    accessToken,
    refreshToken: login.refreshToken,
    headers: { authorization: `Bearer ${accessToken}` },
  };
}
