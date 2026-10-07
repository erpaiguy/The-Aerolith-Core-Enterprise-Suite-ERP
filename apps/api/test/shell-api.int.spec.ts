// API behaviour the app shells depend on: browser refresh cookie + CSRF header, CORS for the desktop origin, and the
// basic inbox (notifications, reminders, pending counts).
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('app shell API (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: { token: string; password: string } = { token: '', password: '' };

  const post = (url: string, payload: object = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });

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
      RATE_LIMIT_SCALE: '20',
      CORS_ORIGINS: 'app://aerolith',
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'shell-admin@example.in');

    const created = (
      await post(
        '/tenant/users',
        { username: 'meena', displayName: 'Meena', role: 'worker' },
        t.admin,
      )
    ).json<{ temporaryPassword: string }>();
    const first = (
      await post('/auth/login', {
        entitlementToken: t.entitlement,
        identifier: 'meena',
        password: created.temporaryPassword,
        client: 'desktop',
      })
    ).json<{ accessToken: string }>();
    await post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: 'Tower-Crane-Lift-31' },
      { authorization: `Bearer ${first.accessToken}` },
    );
    worker = { token: '', password: 'Tower-Crane-Lift-31' };
  });

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  describe('browser refresh cookie', () => {
    it('sets an HttpOnly, Secure, SameSite=Strict cookie and leaves the token out of the body', async () => {
      const res = await post('/auth/login', {
        entitlementToken: t.entitlement,
        identifier: 'meena',
        password: worker.password,
        client: 'browser',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('refreshToken');
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/^aerolith_rt=rt1\./);
      for (const attr of ['Path=/api/auth', 'HttpOnly', 'SameSite=Strict', 'Secure'])
        expect(cookie).toContain(attr);
      worker.token = res.json<{ accessToken: string }>().accessToken;

      const value = cookie.split(';')[0]!;
      // Without the client header the cookie is not accepted (a cross-site form cannot add the header).
      expect((await post('/auth/refresh', {}, { cookie: value })).json()).toMatchObject({
        code: 'refresh_token_missing',
      });
      const refreshed = await post(
        '/auth/refresh',
        {},
        { cookie: value, 'x-aerolith-client': 'browser' },
      );
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).not.toHaveProperty('refreshToken');
      const rotated = String(refreshed.headers['set-cookie']).split(';')[0]!;
      expect(rotated).not.toBe(value);
      // The old cookie value is now a reused token: the session ends.
      expect(
        (await post('/auth/refresh', {}, { cookie: value, 'x-aerolith-client': 'browser' })).json(),
      ).toMatchObject({ code: 'session_revoked' });
    });

    it('clears the cookie on sign-out', async () => {
      const res = await post('/auth/login', {
        entitlementToken: t.entitlement,
        identifier: 'meena',
        password: worker.password,
        client: 'browser',
      });
      worker.token = res.json<{ accessToken: string }>().accessToken;
      const out = await post('/auth/logout', {}, { authorization: `Bearer ${worker.token}` });
      expect(out.statusCode).toBe(204);
      expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    });

    it('still returns the refresh token in the body for the desktop app', async () => {
      const res = await post('/auth/login', {
        entitlementToken: t.entitlement,
        identifier: 'meena',
        password: worker.password,
        client: 'desktop',
      });
      expect(res.json<{ refreshToken: string }>().refreshToken).toMatch(/^rt1\./);
      expect(res.headers['set-cookie']).toBeUndefined();
      worker.token = res.json<{ accessToken: string }>().accessToken;
    });
  });

  describe('CORS', () => {
    it('allows the desktop origin and nothing else', async () => {
      const preflight = (origin: string) =>
        app.inject({
          method: 'OPTIONS',
          url: '/api/auth/login',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
          },
        });
      const allowed = await preflight('app://aerolith');
      expect(allowed.headers['access-control-allow-origin']).toBe('app://aerolith');
      expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
      const denied = await preflight('https://evil.example');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('inbox', () => {
    const w = () => ({ authorization: `Bearer ${worker.token}` });

    it('shows reminders as upcoming until due, then in the inbox', async () => {
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();
      const later = (
        await post('/tenant/reminders', { title: 'EMD return follow-up', dueAt: soon }, w())
      ).json<{ id: string }>();
      const due = (
        await post(
          '/tenant/reminders',
          { title: 'Submit tender T-114', dueAt: past, link: '/tenders/114' },
          w(),
        )
      ).json<{ id: string }>();
      const inbox = (await get('/tenant/inbox', w())).json<{
        items: { id: string }[];
        upcoming: { id: string }[];
        unread: number;
      }>();
      expect(inbox.upcoming.map((i) => i.id)).toEqual([later.id]);
      expect(inbox.items.map((i) => i.id)).toContain(due.id);
      expect(inbox.unread).toBe(1);

      expect((await post(`/tenant/notifications/${due.id}/read`, {}, w())).statusCode).toBe(200);
      expect((await get('/tenant/inbox', w())).json<{ unread: number }>().unread).toBe(0);
      expect((await post(`/tenant/reminders/${later.id}/delete`, {}, w())).statusCode).toBe(200);
      expect((await get('/tenant/inbox', w())).json<{ upcoming: unknown[] }>().upcoming).toEqual(
        [],
      );
    });

    it("never touches another user's items", async () => {
      const mine = (
        await post(
          '/tenant/reminders',
          { title: 'Private', dueAt: new Date().toISOString() },
          t.admin,
        )
      ).json<{ id: string }>();
      expect((await post(`/tenant/notifications/${mine.id}/read`, {}, w())).statusCode).toBe(404);
      expect((await post(`/tenant/reminders/${mine.id}/delete`, {}, w())).statusCode).toBe(404);
      expect(
        (await get('/tenant/inbox', w()))
          .json<{ items: { id: string }[] }>()
          .items.map((i) => i.id),
      ).not.toContain(mine.id);
    });

    it('counts pending password resets for admins only', async () => {
      await post('/auth/password-reset-request', {
        entitlementToken: t.entitlement,
        username: 'meena',
      });
      expect((await get('/tenant/inbox', t.admin)).json()).toMatchObject({
        pending: { passwordResets: 1 },
      });
      expect((await get('/tenant/inbox', w())).json()).toMatchObject({
        pending: { passwordResets: 0 },
      });
    });
  });
});
