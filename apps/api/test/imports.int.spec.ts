// Bulk imports in a real tenant database (docs/wave7-plan.md step 7c.8): a sheet checked row by row before anything
// is saved; the good rows saved through the usual services, the others reported with the reason; admin only.
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
import ExcelJS from 'exceljs';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('bulk imports (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-imp-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'imp-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    manager = m.headers;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  const book = async (rows: (string | number)[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Import');
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const upload = (url: string, file: Buffer, headers: Record<string, string> = t.admin) => {
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="import.xlsx"\r\n` +
          'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: `/api${url}`,
      payload,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  interface Result {
    rows: { rowNo: number; problem: string | null; saved?: boolean }[];
    saved: number;
    failed: number;
    applied: boolean;
  }

  it('checks a sheet of resources, then saves the good rows and reports the rest', async () => {
    const file = await book([
      ['Code', 'Name', 'Type', 'Unit', 'Rate'],
      ['CEM-OPC53', 'Cement OPC 53', 'Material', 'bag', 400],
      ['MASON', 'Mason', 'labour', 'day', '900'],
      ['X1', 'Something', 'magic', 'nos', ''],
    ]);
    expect((await upload('/tenant/imports/resources', file, manager)).statusCode).toBe(403);
    const check = await ok<Result>(upload('/tenant/imports/resources', file));
    expect(check).toMatchObject({ applied: false, saved: 0, failed: 1 });
    expect(check.rows.map((r) => [r.rowNo, r.problem === null])).toEqual([
      [2, true],
      [3, true],
      [4, false],
    ]);
    const done = await ok<Result>(upload('/tenant/imports/resources?apply=true', file));
    expect(done).toMatchObject({ applied: true, saved: 2, failed: 1 });
    // Again: the codes are taken now, so each good row fails with the service's reason.
    const again = await ok<Result>(upload('/tenant/imports/resources?apply=true', file));
    expect(again.saved).toBe(0);
    expect(again.rows[0]!.problem).toBeTruthy();
    // A sheet without the needed columns is refused outright.
    expect(
      (await upload('/tenant/imports/resources', await book([['Name'], ['x']]))).json(),
    ).toMatchObject({
      code: 'missing_columns',
    });
  });

  it('imports parties by kind, and employees into a company', async () => {
    const parties = await ok<Result>(
      upload(
        '/tenant/imports/parties?apply=true',
        await book([
          ['Party name', 'Kind', 'City', 'Phone'],
          ['Vidarbha Cement Traders', 'Vendor', 'Akola', '0724 2430101'],
          ['PWD Division, Washim', 'Client', 'Washim', ''],
        ]),
      ),
    );
    expect(parties).toMatchObject({ saved: 2, failed: 0 });
    const vendors = await ok<{ name: string }[]>(get('/tenant/parties?kind=vendor'));
    expect(vendors.map((p) => p.name)).toContain('Vidarbha Cement Traders');

    const { companies } = await ok<{ companies: { id: string }[] }>(get('/tenant/companies'));
    const staff = await book([
      ['Employee code', 'Name', 'Date of joining', 'Department'],
      ['E001', 'Meena Kale', '01/04/2026', 'Accounts'],
      ['E002', 'Raju Shinde', '2026-05-15', 'Site'],
      ['E003', 'X', 'yesterday', ''],
    ]);
    expect((await upload('/tenant/imports/employees?apply=true', staff)).json()).toMatchObject({
      code: 'no_company',
    });
    const done = await ok<Result>(
      upload(`/tenant/imports/employees?apply=true&entityId=${companies[0]!.id}`, staff),
    );
    expect(done).toMatchObject({ saved: 2, failed: 1 });
    const list = await ok<{ code: string; name: string }[]>(
      get(`/tenant/hr/employees?entityId=${companies[0]!.id}`),
    );
    expect(list.map((e) => e.code).sort()).toEqual(['E001', 'E002']);
  });
});
