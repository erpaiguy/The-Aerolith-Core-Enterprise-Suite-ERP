// Owner console API: read models (tenants, overview, audit, rollouts), resend key, roles, and the browser session
// (refresh token in an HttpOnly cookie scoped to /api/owner/auth).
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { OperatorAuthService } from '../src/auth/operator-auth.service.js';
import { timeStep, totpCode } from '../src/auth/totp.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { signInOperator } from './helpers/operator.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('owner console API (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let owner: Record<string, string>;

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
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'console-admin@example.in');
    owner = (await signInOperator(app)).headers;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('describes the signed-in operator', async () => {
    const me = (await get('/owner/me', owner)).json();
    expect(me).toMatchObject({ role: 'owner', mfaEnabled: true, recoveryCodesLeft: 10 });
  });

  it('lists tenants with licence state, devices and database status', async () => {
    const list = (await get('/owner/tenants', owner)).json<
      {
        id: string;
        ownerEmail: string;
        licence: { state: string; activeDevices: number; keyLast4: string };
        database: { status: string };
      }[]
    >();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: t.tenantId,
      ownerEmail: 'console-admin@example.in',
      licence: { state: 'active', activeDevices: 1 },
      database: { status: 'ready' },
    });
    expect(list[0]!.licence.keyLast4).toHaveLength(4);
    expect(JSON.stringify(list)).not.toContain(t.licenceKey);
  });

  it('searches by name or email and treats % and _ literally', async () => {
    expect((await get('/owner/tenants?q=CONSOLE-admin', owner)).json()).toHaveLength(1);
    expect((await get('/owner/tenants?q=test%20builders', owner)).json()).toHaveLength(1);
    expect((await get('/owner/tenants?q=%25', owner)).json()).toHaveLength(0);
    expect((await get('/owner/tenants?q=_', owner)).json()).toHaveLength(0);
  });

  it('shows one tenant with its licence history', async () => {
    const detail = (await get(`/owner/tenants/${t.tenantId}`, owner)).json<{
      licences: { id: string }[];
    }>();
    expect(detail.licences.map((l) => l.id)).toEqual([t.licenceId]);
    const missing = await get(`/owner/tenants/${crypto.randomUUID()}`, owner);
    expect(missing.statusCode).toBe(404);
  });

  it('summarises tenants, databases and email for the overview', async () => {
    const o = (await get('/owner/overview', owner)).json();
    expect(o).toMatchObject({
      tenants: 1,
      licenceStates: { active: 1 },
      databases: { ready: 1 },
      trialsEndingSoon: [],
    });
  });

  it('lists a trial ending within 14 days', async () => {
    // Shortening through the API needs 14 days' notice, so move the end date directly.
    await control`UPDATE core.licence SET ends_at = now() + interval '5 days' WHERE id = ${t.licenceId}`;
    const o = (await get('/owner/overview', owner)).json<{ trialsEndingSoon: { id: string }[] }>();
    expect(o.trialsEndingSoon.map((x) => x.id)).toEqual([t.tenantId]);
  });

  it('resends the key by email without returning it', async () => {
    const res = await post(`/owner/licences/${t.licenceId}/resend-key`, {}, owner);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ licenceId: t.licenceId, sentTo: 'console-admin@example.in' });
    expect(res.body).not.toContain(t.licenceKey);
    const queued = await control`SELECT 1 FROM core.email_outbox
      WHERE template = 'licence_key' AND to_email = 'console-admin@example.in' AND status = 'queued'`;
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const audit = (await get('/owner/audit?limit=5', owner)).json<
      { action: string; id: string }[]
    >();
    expect(audit[0]!.action).toBe('licence.resend_key');
    const older = (await get(`/owner/audit?before=${audit[0]!.id}`, owner)).json<
      { id: string }[]
    >();
    expect(older.every((r) => Number(r.id) < Number(audit[0]!.id))).toBe(true);
  });

  it('records migration rollouts with result counts', async () => {
    await post('/owner/migrations/rollout', {}, owner);
    const runs = (await get('/owner/migrations/runs', owner)).json<
      { status: string; results: Record<string, number> }[]
    >();
    expect(runs[0]).toMatchObject({ status: 'completed', results: { up_to_date: 1 } });
  });

  it('lets a read-only operator look but not change anything', async () => {
    const viewer = (await signInOperator(app, undefined, 'read_only')).headers;
    expect((await get('/owner/tenants', viewer)).statusCode).toBe(200);
    const res = await post(`/owner/licences/${t.licenceId}/resend-key`, {}, viewer);
    expect(res.statusCode).toBe(403);
  });

  it('break-glass reset clears MFA, signs out every session and forces enrolment again', async () => {
    const op = await signInOperator(app, 'console-reset@aerolith.test');
    const { temporaryPassword } = await app
      .get(OperatorAuthService)
      .resetOperator('Console-Reset@aerolith.test');
    expect((await get('/owner/tenants', op.headers)).statusCode).toBe(200); // access tokens live 15 min
    const refresh = await post('/owner/auth/refresh', { refreshToken: op.refreshToken });
    expect(refresh.statusCode).toBe(401);
    const login = await post('/owner/auth/login', {
      email: 'console-reset@aerolith.test',
      password: temporaryPassword,
    });
    expect(login.json()).toMatchObject({ status: 'mfa_enrollment_required' });
    const audit = (await get('/owner/audit?limit=1', owner)).json<{ action: string }[]>();
    expect(audit[0]!.action).toBe('operator.reset');
    await expect(
      app.get(OperatorAuthService).resetOperator('nobody@aerolith.test'),
    ).rejects.toMatchObject({ response: { code: 'operator_not_found' } });
  });

  it('keeps the browser refresh token in an HttpOnly cookie for the owner console', async () => {
    const email = 'console-browser@aerolith.test';
    const { temporaryPassword } = await app
      .get(OperatorAuthService)
      .createOperator(email, 'Browser Owner', 'owner');
    const first = (
      await post('/owner/auth/login', { email, password: temporaryPassword, client: 'browser' })
    ).json<{ enrollmentToken: string }>();
    const { secret } = (
      await post('/auth/mfa/enroll', { enrollmentToken: first.enrollmentToken })
    ).json<{ secret: string }>();
    const step = timeStep(new Date());
    await post('/auth/mfa/confirm', {
      enrollmentToken: first.enrollmentToken,
      code: totpCode(secret, step),
    });
    const login = await post('/owner/auth/login', {
      email,
      password: temporaryPassword,
      code: totpCode(secret, step + 1),
      client: 'browser',
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).not.toHaveProperty('refreshToken');
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/^aerolith_ort=rt1\./);
    expect(cookie).toContain('Path=/api/owner/auth');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // Loopback-only listener: never Secure, even when the public site is https.
    expect(cookie).not.toContain('Secure');
    const sent = cookie.split(';')[0]!;

    expect((await post('/owner/auth/refresh', {}, { cookie: sent })).statusCode).toBe(400);
    const refreshed = await post(
      '/owner/auth/refresh',
      {},
      { cookie: sent, 'x-aerolith-client': 'browser' },
    );
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ mustChangePassword: true });
    expect(refreshed.json()).not.toHaveProperty('refreshToken');
    const rotated = String(refreshed.headers['set-cookie']).split(';')[0]!;
    expect(rotated).not.toBe(sent);

    // Replaying the old cookie revokes the session.
    const replay = await post(
      '/owner/auth/refresh',
      {},
      { cookie: sent, 'x-aerolith-client': 'browser' },
    );
    expect(replay.statusCode).toBe(401);

    const out = await post(
      '/owner/auth/logout',
      {},
      { authorization: `Bearer ${refreshed.json<{ accessToken: string }>().accessToken}` },
    );
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('aerolith_ort=;');
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
  });
});
