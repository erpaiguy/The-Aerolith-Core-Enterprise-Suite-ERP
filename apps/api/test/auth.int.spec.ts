// Sign-in, MFA, sessions, staff resets and seats, end to end against real databases (control plane + a tenant
// database on the local provider). Needs TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { timeStep, totpCode } from '../src/auth/totp.js';
import { open } from '../src/crypto/secretbox.js';
import { migrate } from '../src/db/migrate.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { signInOperator } from './helpers/operator.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
const ADMIN_EMAIL = 'admin@sharma-builders.in';
const ADMIN_PASSWORD = 'Monsoon-Slab-Pour-7';

type Json = Record<string, unknown>;

describe.skipIf(!controlUrl || !adminUrl)('authentication (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let owner: Record<string, string> = {};
  let tenantId = '';
  let licenceId = '';
  let entitlement = '';
  let adminSecret = '';
  let adminStep = 0; // last TOTP step used by the admin
  let recoveryCodes: string[] = [];
  let admin: Record<string, string> = {};

  const post = (url: string, payload: object = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const login = (identifier: string, password: string, code?: string) =>
    post('/auth/login', {
      entitlementToken: entitlement,
      identifier,
      password,
      client: 'desktop',
      ...(code ? { code } : {}),
    });
  /** Next unused TOTP code for the admin. Valid only while it is within one step of the clock. */
  const nextAdminCode = () => {
    adminStep = Math.max(timeStep(new Date()) - 1, adminStep + 1);
    if (adminStep > timeStep(new Date()) + 1)
      throw new Error('no fresh TOTP step available; use a recovery code');
    return totpCode(adminSecret, adminStep);
  };
  const outboxLink = async (template: string) => {
    const [row] = await control<{ data: { link: string } }[]>`
      SELECT data FROM core.email_outbox WHERE template = ${template} ORDER BY created_at DESC LIMIT 1`;
    return new URL(open(row!.data.link, ENC)).searchParams.get('token')!;
  };

  beforeAll(async () => {
    control = postgres(controlUrl!, { onnotice: () => {} });
    server = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    for (const { datname } of await server<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname LIKE 'tenant\\_t%'`) {
      await server.unsafe(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
    await control`DROP SCHEMA IF EXISTS core CASCADE`;
    await control`DROP SCHEMA IF EXISTS aerolith_meta CASCADE`;
    await migrate(control);
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      RATE_LIMIT_SCALE: '5', // login is 10/min in production; this file signs in more often
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    owner = (await signInOperator(app)).headers;

    const trial = (
      await post('/owner/tenants', { email: ADMIN_EMAIL, tenantName: 'Sharma Builders' }, owner)
    ).json<Json>();
    tenantId = trial.tenantId as string;
    licenceId = trial.licenceId as string;
    await post(`/owner/tenants/${tenantId}/provision`, { provider: 'local_postgres' }, owner);
    expect(await app.get(ProvisioningService).runUntilSettled(tenantId)).toMatchObject({
      status: 'ready',
    });
    const activation = await post('/licences/activate', {
      key: trial.licenceKey,
      deviceId: randomUUID(),
      platform: 'browser',
    });
    entitlement = activation.json<{ token: string }>().token;
  });

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  describe('owner console', () => {
    it('rejects missing, forged and tenant tokens on owner routes', async () => {
      expect((await get(`/owner/licences/${licenceId}`)).statusCode).toBe(401);
      expect((await get(`/owner/licences/${licenceId}`, bearer('at1.e30.x'))).statusCode).toBe(401);
      expect((await get(`/owner/licences/${licenceId}`, owner)).statusCode).toBe(200);
    });

    it('blocks a new operator until they change the one-time password', async () => {
      const { OperatorAuthService } = await import('../src/auth/operator-auth.service.js');
      const email = 'support@aerolith.test';
      const { temporaryPassword } = await app
        .get(OperatorAuthService)
        .createOperator(email, 'Support', 'support');
      expect(
        (await post('/owner/auth/login', { email, password: 'wrong-password' })).statusCode,
      ).toBe(401);
      const first = (
        await post('/owner/auth/login', { email, password: temporaryPassword })
      ).json<Json>();
      expect(first.status).toBe('mfa_enrollment_required');
      const { secret } = (
        await post('/auth/mfa/enroll', { enrollmentToken: first.enrollmentToken })
      ).json<{ secret: string }>();
      const step = timeStep(new Date());
      const conf = await post('/auth/mfa/confirm', {
        enrollmentToken: first.enrollmentToken,
        code: totpCode(secret, step),
      });
      expect(conf.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);
      // Enrolment cannot be repeated with the same token once MFA is on.
      expect(
        (await post('/auth/mfa/enroll', { enrollmentToken: first.enrollmentToken })).json(),
      ).toMatchObject({ code: 'mfa_already_enabled' });

      expect(
        (await post('/owner/auth/login', { email, password: temporaryPassword })).json(),
      ).toEqual({ status: 'mfa_required' });
      // The code used for enrolment cannot be replayed.
      expect(
        (
          await post('/owner/auth/login', {
            email,
            password: temporaryPassword,
            code: totpCode(secret, step),
          })
        ).statusCode,
      ).toBe(401);
      const ok = (
        await post('/owner/auth/login', {
          email,
          password: temporaryPassword,
          code: totpCode(secret, step + 1),
        })
      ).json<Json>();
      expect(ok).toMatchObject({ status: 'ok', mustChangePassword: true });
      expect(
        (await get(`/owner/licences/${licenceId}`, bearer(ok.accessToken as string))).json(),
      ).toMatchObject({ code: 'password_change_required' });
      const changed = await post(
        '/owner/auth/change-password',
        { currentPassword: temporaryPassword, newPassword: 'Helpdesk-Ledger-Pass-26' },
        bearer(ok.accessToken as string),
      );
      const supportToken = changed.json<{ accessToken: string }>().accessToken;
      expect((await get(`/owner/licences/${licenceId}`, bearer(supportToken))).statusCode).toBe(
        200,
      );
      // Support may read but not change.
      expect(
        (
          await post(
            `/owner/licences/${licenceId}/revoke`,
            { reason: 'not allowed' },
            bearer(supportToken),
          )
        ).statusCode,
      ).toBe(403);
    });
  });

  describe('tenant admin', () => {
    it('sets a password from the setup link (single use, policy enforced)', async () => {
      const token = await outboxLink('admin_password_setup');
      expect(
        (await post('/auth/admin/set-password', { token, newPassword: 'short' })).json(),
      ).toMatchObject({ code: 'password_too_short' });
      expect(
        (
          await post('/auth/admin/set-password', { token, newPassword: 'admin-sharma-2026' })
        ).json(),
      ).toMatchObject({ code: 'password_contains_username' });
      expect(
        (await post('/auth/admin/set-password', { token, newPassword: ADMIN_PASSWORD })).statusCode,
      ).toBe(200);
      expect(
        (
          await post('/auth/admin/set-password', { token, newPassword: 'Another-Good-Pass-9' })
        ).json(),
      ).toMatchObject({ code: 'link_invalid' });
    });

    it('must enrol an authenticator, then signs in with email + password + code', async () => {
      const first = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).json<Json>();
      expect(first.status).toBe('mfa_enrollment_required');
      const { secret, otpauthUri } = (
        await post('/auth/mfa/enroll', { enrollmentToken: first.enrollmentToken })
      ).json<{ secret: string; otpauthUri: string }>();
      expect(otpauthUri).toContain('otpauth://totp/Aerolith%20Core');
      adminSecret = secret;
      adminStep = timeStep(new Date());
      const conf = await post('/auth/mfa/confirm', {
        enrollmentToken: first.enrollmentToken,
        code: totpCode(secret, adminStep),
      });
      recoveryCodes = conf.json<{ recoveryCodes: string[] }>().recoveryCodes;

      expect((await login(ADMIN_EMAIL, ADMIN_PASSWORD)).json()).toEqual({ status: 'mfa_required' });
      expect((await login(ADMIN_EMAIL, ADMIN_PASSWORD, '000000')).statusCode).toBe(401);
      const ok = (
        await login(ADMIN_EMAIL.toUpperCase(), ADMIN_PASSWORD, nextAdminCode())
      ).json<Json>();
      expect(ok).toMatchObject({
        status: 'ok',
        mustChangePassword: false,
        user: { role: 'admin' },
        licence: { state: 'active', featuresUnlocked: true },
      });
      admin = bearer(ok.accessToken as string);
      expect((await get('/auth/me', admin)).json()).toMatchObject({
        role: 'admin',
        username: ADMIN_EMAIL,
      });
    });

    it('accepts each recovery code once', async () => {
      const code = recoveryCodes[0]!;
      expect((await login(ADMIN_EMAIL, ADMIN_PASSWORD, code)).json()).toMatchObject({
        status: 'ok',
      });
      expect((await login(ADMIN_EMAIL, ADMIN_PASSWORD, code)).statusCode).toBe(401);
    });
  });

  describe('staff and seats', () => {
    let manager = { id: '', temporaryPassword: '' };
    let worker = { id: '', temporaryPassword: '' };

    it('enforces the trial mix: 1 admin, 1 manager, 1 worker', async () => {
      const m = await post(
        '/tenant/users',
        { username: 'ravi.k', displayName: 'Ravi Kumar', role: 'manager' },
        admin,
      );
      expect(m.statusCode).toBe(201);
      manager = m.json();
      expect(manager.temporaryPassword).toMatch(/^[a-zA-Z2-9]{12}$/);
      expect(
        (
          await post(
            '/tenant/users',
            { username: 'second.mgr', displayName: 'Second', role: 'manager' },
            admin,
          )
        ).json(),
      ).toMatchObject({ code: 'role_cap_reached', limit: 1 });
      const w = await post(
        '/tenant/users',
        { username: 'suresh', displayName: 'Suresh', role: 'worker' },
        admin,
      );
      worker = w.json();
      expect(
        (
          await post(
            '/tenant/users',
            { username: 'extra', displayName: 'Extra', role: 'worker' },
            admin,
          )
        ).json(),
      ).toMatchObject({ code: 'seat_cap_reached', limit: 3 });
      expect(
        (
          await post(
            '/tenant/users',
            { username: 'RAVI.K', displayName: 'Dup', role: 'worker' },
            admin,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post(
            '/tenant/users',
            { username: 'a@b', displayName: 'Email-like', role: 'worker' },
            admin,
          )
        ).statusCode,
      ).toBe(400);
      const users = (await get('/tenant/users', admin)).json<{ username: string }[]>();
      expect(users.map((u) => u.username)).toEqual([ADMIN_EMAIL, 'ravi.k', 'suresh']);
    });

    it('frees a seat immediately on deactivation and reclaims it on reactivation', async () => {
      expect((await post(`/tenant/users/${worker.id}/deactivate`, {}, admin)).statusCode).toBe(200);
      const temp = await post(
        '/tenant/users',
        { username: 'temp.worker', displayName: 'Temp', role: 'worker' },
        admin,
      );
      expect(temp.statusCode).toBe(201);
      expect((await post(`/tenant/users/${worker.id}/reactivate`, {}, admin)).json()).toMatchObject(
        { code: 'seat_cap_reached' },
      );
      await post(`/tenant/users/${temp.json<{ id: string }>().id}/deactivate`, {}, admin);
      expect((await post(`/tenant/users/${worker.id}/reactivate`, {}, admin)).json()).toEqual({
        id: worker.id,
        status: 'active',
      });
    });

    it('forces a password change after a temporary password', async () => {
      const res = (await login('Ravi.K', manager.temporaryPassword)).json<Json>();
      expect(res).toMatchObject({
        status: 'ok',
        mustChangePassword: true,
        user: { role: 'manager' },
      });
      const temp = bearer(res.accessToken as string);
      expect((await get('/tenant/inbox', temp)).json()).toMatchObject({
        code: 'password_change_required',
      });
      expect((await get('/auth/me', temp)).statusCode).toBe(200);
      expect(
        (
          await post(
            '/auth/change-password',
            { currentPassword: manager.temporaryPassword, newPassword: 'password123' },
            temp,
          )
        ).json(),
      ).toMatchObject({ code: 'password_too_common' });
      const changed = await post(
        '/auth/change-password',
        { currentPassword: manager.temporaryPassword, newPassword: 'Site-Office-Rain-42' },
        temp,
      );
      expect(
        (await get('/tenant/inbox', bearer(changed.json<{ accessToken: string }>().accessToken)))
          .statusCode,
      ).toBe(200);
      // Staff cannot use admin routes.
      expect(
        (await get('/tenant/users', bearer(changed.json<{ accessToken: string }>().accessToken)))
          .statusCode,
      ).toBe(403);
    });

    it('rotates refresh tokens and ends the session when an old one is reused', async () => {
      const first = (await login('ravi.k', 'Site-Office-Rain-42')).json<{ refreshToken: string }>();
      const second = (await post('/auth/refresh', { refreshToken: first.refreshToken })).json<{
        refreshToken: string;
        accessToken: string;
      }>();
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(
        (await post('/auth/refresh', { refreshToken: first.refreshToken })).json(),
      ).toMatchObject({ code: 'session_revoked' });
      expect(
        (await post('/auth/refresh', { refreshToken: second.refreshToken })).json(),
      ).toMatchObject({ code: 'session_revoked' });
    });

    it('locks an account after 5 wrong passwords', async () => {
      for (let i = 0; i < 5; i++)
        expect((await login('ravi.k', 'wrong-password-x')).statusCode).toBe(401);
      expect((await login('ravi.k', 'Site-Office-Rain-42')).json()).toMatchObject({
        code: 'invalid_credentials',
      });
    });

    it('lets staff ask the admin for a reset; the admin issues a one-time password', async () => {
      const workerSession = (await login('suresh', worker.temporaryPassword)).json<{
        refreshToken: string;
      }>();
      const req = { entitlementToken: entitlement, username: 'suresh', deviceLabel: 'Site tablet' };
      expect((await post('/auth/password-reset-request', req)).statusCode).toBe(202);
      expect((await post('/auth/password-reset-request', req)).statusCode).toBe(202); // collapses into one
      const unknown = await post('/auth/password-reset-request', { ...req, username: 'nobody' });
      expect(unknown.statusCode).toBe(202);
      expect(unknown.json()).toEqual(
        (await post('/auth/password-reset-request', { ...req, username: 'suresh' })).json(),
      );

      const pending = (await get('/tenant/password-resets', admin)).json<
        { id: string; username: string }[]
      >();
      expect(pending).toHaveLength(1);
      const inbox = (await get('/tenant/inbox', admin)).json<{
        items: { kind: string }[];
        pending: { passwordResets: number };
      }>();
      expect(inbox.items[0]?.kind).toBe('password_reset_request');
      expect(inbox.pending.passwordResets).toBe(1);

      const issued = (
        await post(`/tenant/password-resets/${pending[0]!.id}/issue`, {}, admin)
      ).json<{ temporaryPassword: string }>();
      expect(
        (await post('/auth/refresh', { refreshToken: workerSession.refreshToken })).statusCode,
      ).toBe(401);
      expect((await login('suresh', issued.temporaryPassword)).json()).toMatchObject({
        status: 'ok',
        mustChangePassword: true,
      });
      expect((await get('/tenant/password-resets', admin)).json()).toEqual([]);
    });
  });

  describe('admin recovery and licence state', () => {
    it('resets a forgotten admin password by email link and signs the admin out everywhere', async () => {
      // A second TOTP code inside the same 30 s window would be a replay, so use a recovery code here.
      const session = (await login(ADMIN_EMAIL, ADMIN_PASSWORD, recoveryCodes[4]!)).json<{
        refreshToken: string;
      }>();
      expect(
        (await post('/auth/admin/forgot-password', { email: 'nobody@example.in' })).statusCode,
      ).toBe(202);
      expect((await post('/auth/admin/forgot-password', { email: ADMIN_EMAIL })).statusCode).toBe(
        202,
      );
      const token = await outboxLink('admin_password_reset');
      expect(
        (await post('/auth/admin/set-password', { token, newPassword: 'Fresh-Cement-Bags-88' }))
          .statusCode,
      ).toBe(200);
      expect((await post('/auth/refresh', { refreshToken: session.refreshToken })).statusCode).toBe(
        401,
      );
      // A new password does not bypass MFA.
      expect((await login(ADMIN_EMAIL, 'Fresh-Cement-Bags-88')).json()).toEqual({
        status: 'mfa_required',
      });
      const ok = (await login(ADMIN_EMAIL, 'Fresh-Cement-Bags-88', recoveryCodes[1]!)).json<Json>();
      admin = bearer(ok.accessToken as string);
      expect(ok.status).toBe('ok');
    });

    it('blocks sign-in and refresh once the licence is revoked', async () => {
      const staff = (await login('suresh', 'nope-wrong-pass')).statusCode;
      expect(staff).toBe(401);
      const session = (await login(ADMIN_EMAIL, 'Fresh-Cement-Bags-88', recoveryCodes[2]!)).json<{
        refreshToken: string;
      }>();
      await post(`/owner/licences/${licenceId}/revoke`, { reason: 'Test revocation' }, owner);
      expect(
        (await login(ADMIN_EMAIL, 'Fresh-Cement-Bags-88', recoveryCodes[3]!)).json(),
      ).toMatchObject({ code: 'licence_revoked' });
      expect(
        (await post('/auth/refresh', { refreshToken: session.refreshToken })).json(),
      ).toMatchObject({ code: 'licence_revoked' });
    });

    it('rate-limits password reset requests', async () => {
      let limited = 0;
      for (let i = 0; i < 30; i++) {
        const res = await post('/auth/password-reset-request', {
          entitlementToken: entitlement,
          username: `u${i}`,
        });
        if (res.statusCode === 429) limited++;
      }
      expect(limited).toBeGreaterThan(0);
    });
  });
});
