// Builds a ready tenant for integration tests through the real flows: operator sign-in, trial creation, local
// provisioning, licence activation, admin password via the setup link, MFA enrolment and admin sign-in.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { timeStep, totpCode } from '../../src/auth/totp.js';
import { open } from '../../src/crypto/secretbox.js';
import { ProvisioningService } from '../../src/provisioning/provisioning.service.js';
import { signInOperator } from './operator.js';

export const ADMIN_PASSWORD = 'Monsoon-Slab-Pour-7';

export async function readyTenant(
  app: NestFastifyApplication,
  control: Sql,
  encKey: Buffer,
  adminEmail: string,
) {
  const post = (url: string, payload: object = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const owner = (await signInOperator(app)).headers;
  const trial = (
    await post('/owner/tenants', { email: adminEmail, tenantName: 'Test Builders' }, owner)
  ).json<{
    tenantId: string;
    licenceId: string;
    licenceKey: string;
  }>();
  await post(`/owner/tenants/${trial.tenantId}/provision`, { provider: 'local_postgres' }, owner);
  const status = await app.get(ProvisioningService).runUntilSettled(trial.tenantId);
  if (status.status !== 'ready') throw new Error(`provisioning failed: ${JSON.stringify(status)}`);
  const entitlement = (
    await post('/licences/activate', {
      key: trial.licenceKey,
      deviceId: randomUUID(),
      platform: 'browser',
    })
  ).json<{
    token: string;
  }>().token;

  const [row] = await control<{ data: { link: string } }[]>`
    SELECT e.data FROM core.email_outbox e WHERE e.template = 'admin_password_setup' AND lower(e.to_email) = lower(${adminEmail})
    ORDER BY e.created_at DESC LIMIT 1`;
  const setupToken = new URL(open(row!.data.link, encKey)).searchParams.get('token')!;
  await post('/auth/admin/set-password', { token: setupToken, newPassword: ADMIN_PASSWORD });

  const login = (code?: string) =>
    post('/auth/login', {
      entitlementToken: entitlement,
      identifier: adminEmail,
      password: ADMIN_PASSWORD,
      client: 'desktop',
      ...(code ? { code } : {}),
    });
  const first = (await login()).json<{ enrollmentToken: string }>();
  const { secret } = (
    await post('/auth/mfa/enroll', { enrollmentToken: first.enrollmentToken })
  ).json<{ secret: string }>();
  const step = timeStep(new Date());
  const { recoveryCodes } = (
    await post('/auth/mfa/confirm', {
      enrollmentToken: first.enrollmentToken,
      code: totpCode(secret, step),
    })
  ).json<{
    recoveryCodes: string[];
  }>();
  const signedIn = (await login(totpCode(secret, step + 1))).json<{
    accessToken: string;
    refreshToken: string;
  }>();
  return {
    ...trial,
    owner,
    entitlement,
    adminEmail,
    totpSecret: secret,
    recoveryCodes,
    admin: { authorization: `Bearer ${signedIn.accessToken}` },
    adminRefreshToken: signedIn.refreshToken,
  };
}
