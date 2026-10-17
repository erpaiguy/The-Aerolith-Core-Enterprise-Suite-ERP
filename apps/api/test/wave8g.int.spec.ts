// Wave 8g in a real tenant database (docs/wave8-plan.md): the platform — two-factor sign-in for staff, backups and
// the audit export, the daily reminder digest, finer permissions.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { timeStep, totpCode } from '../src/auth/totp.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('wave 8g: platform (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };

  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ id: string; temporaryPassword: string }>();
    const login = (password: string) =>
      post(
        '/auth/login',
        { entitlementToken: t.entitlement, identifier: username, password, client: 'desktop' },
        {},
      ).then((r) => r.json<{ accessToken: string }>().accessToken);
    const first = await login(created.temporaryPassword);
    await post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: 'Bar-Bending-Yard-44' },
      { authorization: `Bearer ${first}` },
    );
    return {
      id: created.id,
      headers: { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` },
    };
  }

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
      RATE_LIMIT_SCALE: '50',
      PUBLIC_API_URL: 'https://api.example.in',
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w8g-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'w8g-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  const signIn = (identifier: string, password: string, code?: string) =>
    post(
      '/auth/login',
      {
        entitlementToken: t.entitlement,
        identifier,
        password,
        client: 'desktop',
        ...(code ? { code } : {}),
      },
      {},
    );
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('lets staff set up an authenticator, asks for it at sign-in, and makes it compulsory when the company says', async () => {
    // suresh (a manager, who posts to the books) sets it up.
    const start = await ok<{ secret: string; otpauthUri: string }>(
      post('/auth/two-factor/start', {}, manager),
    );
    expect(start.otpauthUri).toMatch(/^otpauth:\/\/totp\/.*suresh/);
    expect(
      (await post('/auth/two-factor/confirm', { code: '000000' }, manager)).json(),
    ).toMatchObject({
      code: 'invalid_code',
    });
    const step = timeStep(new Date());
    const { recoveryCodes } = await ok<{ recoveryCodes: string[] }>(
      post('/auth/two-factor/confirm', { code: totpCode(start.secret, step) }, manager),
    );
    expect(recoveryCodes).toHaveLength(10);

    // Signing in now asks for a code; the one just used is not taken twice; a recovery code works once.
    expect((await signIn('suresh', 'Bar-Bending-Yard-44')).json()).toEqual({
      status: 'mfa_required',
    });
    expect(
      (await signIn('suresh', 'Bar-Bending-Yard-44', totpCode(start.secret, step))).statusCode,
    ).toBe(401);
    const viaRecovery = await signIn('suresh', 'Bar-Bending-Yard-44', recoveryCodes[0]);
    expect(viaRecovery.json()).toMatchObject({ status: 'ok', mustSetUpMfa: false });
    expect((await signIn('suresh', 'Bar-Bending-Yard-44', recoveryCodes[0])).statusCode).toBe(401);
    expect(
      await ok<{ enabled: boolean; recoveryCodesLeft: number }>(get('/auth/two-factor', manager)),
    ).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 9,
    });

    // The company requires it: a second manager must set it up before anything else; the worker need not.
    expect((await post('/auth/two-factor/policy', { requireMfa: true }, manager)).statusCode).toBe(
      403,
    );
    expect((await post('/auth/two-factor/policy', { requireMfa: true }, worker)).statusCode).toBe(
      403,
    );
    await ok(post('/auth/two-factor/policy', { requireMfa: true }));
    const created = await ok<{ id: string; temporaryPassword: string }>(
      post('/tenant/users', { username: 'meena', displayName: 'Meena', role: 'manager' }),
    );
    const first = (await ok<{ accessToken: string }>(signIn('meena', created.temporaryPassword)))
      .accessToken;
    await ok(
      post(
        '/auth/change-password',
        { currentPassword: created.temporaryPassword, newPassword: 'Shuttering-Plate-19' },
        bearer(first),
      ),
    );
    const meena = await ok<{ accessToken: string; mustSetUpMfa: boolean }>(
      signIn('meena', 'Shuttering-Plate-19'),
    );
    expect(meena.mustSetUpMfa).toBe(true);
    expect((await get('/tenant/projects', bearer(meena.accessToken))).json()).toMatchObject({
      code: 'mfa_setup_required',
    });
    expect(
      (await ok<{ requiredNow: boolean }>(get('/auth/two-factor', bearer(meena.accessToken))))
        .requiredNow,
    ).toBe(true);
    const w = await ok<{ mustSetUpMfa: boolean; accessToken: string }>(
      signIn('raju', 'Bar-Bending-Yard-44'),
    );
    expect(w.mustSetUpMfa).toBe(false);
    expect((await get('/tenant/projects', bearer(w.accessToken))).statusCode).toBe(200);

    // suresh may not turn his off while the company requires it.
    expect(
      (await post('/auth/two-factor/disable', { code: recoveryCodes[1] }, manager)).json(),
    ).toMatchObject({ code: 'mfa_required_by_company' });
    const users = await ok<{ username: string; enabled: boolean }[]>(get('/auth/two-factor/users'));
    expect(users.filter((u) => u.enabled).map((u) => u.username)).toEqual(['suresh']);
    await ok(post('/auth/two-factor/policy', { requireMfa: false }));
  });
});
