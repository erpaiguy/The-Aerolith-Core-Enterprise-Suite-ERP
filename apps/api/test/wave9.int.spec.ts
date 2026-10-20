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
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
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

  it('asks each person to accept what applies to them, keeps who accepted which version, and the lawyer’s review (step 9b.3)', async () => {
    type State = {
      documents: {
        key: string;
        version: string;
        mustAccept: boolean;
        acceptedAt: string | null;
        reviewed: { by: string } | null;
      }[];
    };
    const must = (s: State) => s.documents.filter((d) => d.mustAccept).map((d) => d.key);
    expect(must((await get('/tenant/legal', worker)).json<State>())).toEqual([
      'terms-of-service',
      'privacy-policy',
    ]);
    expect(must((await get('/tenant/legal')).json<State>())).toHaveLength(4);
    // Staff accept for themselves only; the company's terms are for an admin.
    expect(
      (await post('/tenant/legal/accept', { documents: ['licence-terms'] }, worker)).statusCode,
    ).toBe(400);
    const after = (
      await post(
        '/tenant/legal/accept',
        { documents: ['terms-of-service', 'privacy-policy'] },
        worker,
      )
    ).json<State>();
    expect(must(after)).toEqual([]);
    expect(after.documents[0]!.acceptedAt).toBeTruthy();
    // Accepting again changes nothing; the record cannot be changed or removed by the app.
    await post('/tenant/legal/accept', { documents: ['terms-of-service'] }, worker);
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    await expect(db`UPDATE platform.legal_acceptance SET version = '2000-01-01'`).rejects.toThrow(
      /permission denied/,
    );
    await expect(db`DELETE FROM platform.legal_acceptance`).rejects.toThrow(/permission denied/);
    // Admins see who accepted which version; staff do not.
    expect((await get('/tenant/legal/acceptances', worker)).statusCode).toBe(403);
    const list = (await get('/tenant/legal/acceptances')).json<
      { username: string; document: string }[]
    >();
    expect(list.map((a) => `${a.username} ${a.document}`).sort()).toEqual([
      'raju privacy-policy',
      'raju terms-of-service',
    ]);
    // The lawyer reviewed the privacy policy: the page stops saying it is a draft; then taken back.
    const reviewed = (
      await post('/tenant/legal/review', { document: 'privacy-policy', reviewed: true })
    ).json<State>();
    expect(reviewed.documents.find((d) => d.key === 'privacy-policy')!.reviewed).toBeTruthy();
    expect(
      (await post('/tenant/legal/review', { document: 'privacy-policy', reviewed: true }, worker))
        .statusCode,
    ).toBe(403);
    const back = (
      await post('/tenant/legal/review', { document: 'privacy-policy', reviewed: false })
    ).json<State>();
    expect(back.documents.find((d) => d.key === 'privacy-policy')!.reviewed).toBeNull();
  });
});
