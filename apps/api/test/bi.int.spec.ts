// The report builder (docs/wave6-plan.md step 3) in a real tenant database: leads grouped by source and summed,
// checked against the leads made; projects scoped to a worker's own; a view refused without its permission; a report
// saved, shared and opened by another; a schedule run by the runner with a clock, its file downloaded, and an inactive
// owner's schedule skipped.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { BiService } from '../src/bi/bi.service.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('report builder (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let people: Record<string, { id: string; headers: Record<string, string> }>;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-bi-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'bi-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
    people = {
      priya: await staff('priya', 'manager'),
      rao: await staff('rao', 'worker'),
      iyer: await staff('iyer', 'worker'),
    };
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('builds, scopes, saves, shares and schedules reports', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    // Three leads from two sources.
    for (const [title, source, value] of [
      ['Hostel', 'referral', '4000000'],
      ['School', 'referral', '2500000'],
      ['Showroom', 'website', '1500000'],
    ] as const)
      await ok(
        post(
          '/tenant/crm/leads',
          { title, organisation: `${title} Trust`, source, value },
          manager,
        ),
      );
    type Run = {
      columns: { name: string; label: string }[];
      rows: Record<string, unknown>[];
      truncated: boolean;
    };
    const bySource = {
      view: 'leads',
      groupBy: ['source'],
      aggregates: [
        { field: 'value', fn: 'sum' },
        { field: 'value', fn: 'count' },
      ],
      sort: { field: 'sum_value', dir: 'desc' },
    };
    const r = await ok<Run>(post('/tenant/reports/run', bySource, worker));
    expect(r.columns.map((c) => c.label)).toEqual(['Source', 'Total value', 'Count']);
    expect(r.rows).toEqual([
      { source: 'referral', sum_value: '6500000.00', count: 2 },
      { source: 'website', sum_value: '1500000.00', count: 1 },
    ]);
    // Refusals: an unknown field, a field name trying to be SQL, the ledger without accounts.view.
    expect(
      (await post('/tenant/reports/run', { view: 'leads', fields: ['secret'] }, worker)).json(),
    ).toMatchObject({
      code: 'no_such_field',
    });
    expect(
      (await post('/tenant/reports/run', { view: 'leads', fields: ['a; drop'] }, worker))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/tenant/reports/run', { view: 'ledger_lines', fields: ['account'] }, worker))
        .statusCode,
    ).toBe(403);
    expect(
      (await ok<{ name: string }[]>(get('/tenant/reports/views', worker))).map((v) => v.name),
    ).not.toContain('ledger_lines');

    // Two projects; the worker is on one and sees only it.
    const p1 = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Akola' }, manager))
    ).id;
    await ok(post('/tenant/projects', { name: 'School, Washim' }, manager));
    const [w] = await db<{ id: string }[]>`SELECT id FROM platform."user" WHERE username = 'raju'`;
    await ok(post(`/tenant/projects/${p1}/team`, { userId: w!.id, role: 'member' }, manager));
    const projects = { view: 'projects', fields: ['name'], sort: { field: 'name', dir: 'asc' } };
    expect((await ok<Run>(post('/tenant/reports/run', projects, worker))).rows).toEqual([
      { name: 'Hostel, Akola' },
    ]);
    expect(
      (await ok<Run>(post('/tenant/reports/run', projects, manager))).rows.length,
    ).toBeGreaterThanOrEqual(1);

    // Saved by the manager, shared with everyone: the worker opens it.
    const saved = await ok<{ id: string }>(
      post(
        '/tenant/reports/saved',
        {
          name: 'Leads by source',
          spec: bySource,
          chart: { kind: 'bar', label: 'source', value: 'sum_value' },
          sharedWith: 'nobody',
        },
        manager,
      ),
    );
    expect((await get(`/tenant/reports/saved/${saved.id}`, worker)).statusCode).toBe(404);
    expect(
      (
        await post(
          '/tenant/reports/saved',
          {
            name: 'Bad chart',
            spec: bySource,
            chart: { kind: 'bar', label: 'source', value: 'nope' },
          },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'bad_chart' });
    await ok(
      post(
        `/tenant/reports/saved/${saved.id}`,
        {
          name: 'Leads by source',
          spec: bySource,
          chart: { kind: 'bar', label: 'source', value: 'sum_value' },
          sharedWith: 'everyone',
        },
        manager,
      ),
    );
    const opened = await ok<{ name: string; result: Run }>(
      get(`/tenant/reports/saved/${saved.id}`, worker),
    );
    expect(opened.result.rows).toHaveLength(2);
    expect((await post(`/tenant/reports/saved/${saved.id}/delete`, {}, worker)).statusCode).toBe(
      403,
    );

    // Excel.
    const x = await post(
      '/tenant/reports/run.xlsx',
      { spec: bySource, title: 'Leads by source' },
      manager,
    );
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(String(ws.getCell(1, 1).value)).toBe('Leads by source');
    const row = (n: number) => [1, 2, 3].map((c) => ws.getCell(n, c).value);
    expect(row(5)).toEqual(['Source', 'Total value', 'Count']);
    expect(row(6)).toEqual(['referral', 6500000, 2]);

    // A daily schedule to the worker: workers cannot schedule; the runner makes the file at 07:00 IST.
    const sched = { cadence: 'daily', recipients: [w!.id] };
    expect(
      (await post(`/tenant/reports/saved/${saved.id}/schedules`, sched, worker)).statusCode,
    ).toBe(403);
    await ok(post(`/tenant/reports/saved/${saved.id}/schedules`, sched, manager));
    const runner = app.get(BiService);
    const [s] = await db<{ next_run_at: Date }[]>`SELECT next_run_at FROM bi.schedule`;
    expect(await runner.runDue(t.tenantId, new Date(s!.next_run_at.getTime() - 1000))).toBe(0);
    expect(await runner.runDue(t.tenantId, s!.next_run_at)).toBe(1);
    const [n] = await db<{ link: string }[]>`
      SELECT link FROM platform.notification WHERE user_id = ${w!.id} AND kind = 'report'`;
    const exportId = n!.link.split('export=')[1]!;
    const file = await get(`/tenant/reports/exports/${exportId}`, worker);
    expect(file.statusCode).toBe(200);
    expect(
      (await get(`/tenant/reports/exports/${exportId}`, people.priya!.headers)).statusCode,
    ).toBe(404);
    // Moved on a day; once the owner is deactivated, the next run is skipped with a reason.
    const [after] = await db<{ next_run_at: Date }[]>`SELECT next_run_at FROM bi.schedule`;
    expect(after!.next_run_at.getTime() - s!.next_run_at.getTime()).toBe(86_400_000);
    const [m] = await db<
      { id: string }[]
    >`SELECT id FROM platform."user" WHERE username = 'suresh'`;
    await ok(post(`/tenant/users/${m!.id}/deactivate`, {}, t.admin));
    expect(await runner.runDue(t.tenantId, after!.next_run_at)).toBe(0);
    const [skipped] = await db<{ last_error: string }[]>`SELECT last_error FROM bi.schedule`;
    expect(skipped!.last_error).toBe('The owner is no longer active.');
  });
});
