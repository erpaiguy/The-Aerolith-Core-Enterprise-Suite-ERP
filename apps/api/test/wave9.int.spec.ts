// Wave 9 in a real tenant database (docs/wave9-plan.md): what the interface keeps on the server for each person.
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
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('wave 9: interface and readiness (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: Record<string, string>;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w9-test-')),
      BACKUP_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w9-backups-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'w9-admin@example.in');
    worker = (await staff('raju', 'worker')).headers;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('keeps each person’s own interface settings, apart from everyone else’s (step 9a.5)', async () => {
    const grid = { columns: ['number', 'vendor', 'total'], frozen: 1, density: 'compact' };
    expect((await post('/tenant/me/prefs/grid.orders', { value: grid })).statusCode).toBe(204);
    expect((await post('/tenant/me/prefs/nav.favourites', { value: ['/orders'] })).statusCode).toBe(
      204,
    );
    expect((await get('/tenant/me/prefs')).json()).toEqual({
      'grid.orders': grid,
      'nav.favourites': ['/orders'],
    });
    // Another person sees none of it, and keeps their own.
    expect((await get('/tenant/me/prefs', worker)).json()).toEqual({});
    await post('/tenant/me/prefs/nav.favourites', { value: ['/my-attendance'] }, worker);
    expect((await get('/tenant/me/prefs')).json()).toMatchObject({ 'nav.favourites': ['/orders'] });
    // Changed, then cleared.
    await post('/tenant/me/prefs/grid.orders', { value: { ...grid, density: 'comfortable' } });
    await post('/tenant/me/prefs/nav.favourites', { value: null });
    expect((await get('/tenant/me/prefs')).json()).toEqual({
      'grid.orders': { ...grid, density: 'comfortable' },
    });
    // Bad names and oversized values are refused.
    expect((await post('/tenant/me/prefs/Bad Key', { value: 1 })).statusCode).toBe(400);
    expect(
      (await post('/tenant/me/prefs/grid.big', { value: 'x'.repeat(70_000) })).statusCode,
    ).toBe(400);
  });
});
