// Letterhead in a real tenant database (docs/wave7-plan.md step 7b.1): each company's contact lines, footer,
// signatory and logo; read by anyone, set by the admin; a logo is a PNG or JPEG by its bytes, 300 KB at most.
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

describe.skipIf(!controlUrl || !adminUrl)('letterhead (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-lh-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'lh-admin@example.in');
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

  // A 1×1 PNG, and the same bytes claimed to be a JPEG; a GIF is refused.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it("keeps each company's letterhead and logo; everyone reads it, the admin sets it", async () => {
    const { companies } = await ok<{ companies: { id: string; name: string }[] }>(
      get('/tenant/companies'),
    );
    const id = companies[0]!.id;
    const url = `/tenant/companies/${id}/letterhead`;
    expect(await ok(get(url, worker))).toMatchObject({
      logo: null,
      signatoryName: '',
      mayEdit: false,
    });

    const body = {
      phone: '+91 712 255 0101',
      email: 'accounts@washim-builders.in',
      website: 'washim-builders.in',
      footer: 'Regd. office: Civil Lines, Nagpur 440001',
      signatoryName: 'R. K. Deshmukh',
      signatoryTitle: 'Director',
    };
    expect((await post(url, body, manager)).statusCode).toBe(403);
    expect((await post(url, { ...body, email: 'not an email' })).statusCode).toBe(400);
    expect(await ok(post(url, body))).toMatchObject({ ...body, mayEdit: true });

    const logo = `/tenant/companies/${id}/logo`;
    expect(
      (await post(logo, { dataUrl: `data:image/png;base64,${PNG}` }, manager)).statusCode,
    ).toBe(403);
    expect(
      (await post(logo, { dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })).json(),
    ).toMatchObject({
      code: 'bad_logo',
    });
    // The type comes from the bytes: a PNG called a JPEG is kept as a PNG.
    const set = await ok<{ logo: string }>(
      post(logo, { dataUrl: `data:image/jpeg;base64,${PNG}` }),
    );
    expect(set.logo).toBe(`data:image/png;base64,${PNG}`);
    expect((await ok<{ logo: string; footer: string }>(get(url, worker))).footer).toBe(body.footer);
    expect(
      (await post(logo, { dataUrl: `data:image/png;base64,${'A'.repeat(420_000)}` })).statusCode,
    ).toBe(400);
    expect(
      await ok(app.inject({ method: 'DELETE', url: `/api${logo}`, headers: t.admin })),
    ).toMatchObject({
      logo: null,
    });
  });
});
