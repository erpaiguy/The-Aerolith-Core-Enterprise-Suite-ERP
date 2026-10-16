// Wave 8a in a real tenant database (docs/wave8-plan.md): revenue on work done, posted and reversed; the company
// dashboard's margin on it.
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

describe.skipIf(!controlUrl || !adminUrl)('wave 8a: money (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let projectId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w8a-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'w8a-admin@example.in');
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

  let entityId: string;
  const acct: Record<string, string> = {};
  const L = (lakh: number) => (lakh * 100000).toFixed(2);

  it('earns revenue on work done, posts it at the month end and reverses it the next day', async () => {
    entityId = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies'))).companies[0]!
      .id;
    const chart = await ok<{ accounts: { id: string; systemKey: string | null }[] }>(
      get('/tenant/accounts/chart'),
    );
    for (const a of chart.accounts) if (a.systemKey) acct[a.systemKey] = a.id;
    projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Washim', contractValue: '10000000' }, manager),
      )
    ).id;
    const voucher = (type: string, date: string, lines: object[]) =>
      ok(post('/tenant/accounts/vouchers', { entityId, type, date, narration: 'Test', lines }));
    // ₹20 lakh spent on the site, ₹15 lakh billed; ₹60 lakh still to spend: a quarter done.
    await voucher('payment', '2026-08-10', [
      { accountId: acct.site_overheads, debit: L(20), projectId },
      { accountId: acct.cash, credit: L(20) },
    ]);
    await voucher('journal', '2026-08-20', [
      { accountId: acct.retention_receivable, debit: L(15), projectId },
      { accountId: acct.contract_revenue, credit: L(15), projectId },
    ]);
    await ok(
      post(`/tenant/projects/${projectId}/cost-control/ctc`, { key: '|', amount: L(60) }, manager),
    );
    interface Month {
      rows: {
        project: { id: string };
        method: string;
        pctComplete: number;
        recognised: string;
        billed: string;
        adjustment: string;
        posted: { voucher: string | null; reversal: string | null } | null;
      }[];
    }
    const url = `/tenant/accounts/revenue-recognition?entityId=${entityId}&month=2026-08`;
    expect((await get(url, worker)).statusCode).toBe(403);
    const aug = await ok<Month>(get(url));
    expect(aug.rows.find((r) => r.project.id === projectId)).toMatchObject({
      method: 'cost',
      pctComplete: 0.25,
      recognised: L(25),
      billed: L(15),
      adjustment: L(10),
      posted: null,
    });
    // Posted once: a journal on 31 August and its reversal on 1 September.
    const body = { entityId, month: '2026-08' };
    expect((await post('/tenant/accounts/revenue-recognition', body, worker)).statusCode).toBe(403);
    const posted = await ok<Month>(post('/tenant/accounts/revenue-recognition', body));
    const row = posted.rows.find((r) => r.project.id === projectId)!;
    expect(row.posted?.voucher).toMatch(/^JV/);
    expect(row.posted?.reversal).toMatch(/^JV/);
    expect((await post('/tenant/accounts/revenue-recognition', body)).json()).toMatchObject({
      code: 'already_posted',
    });
    // September sees the bills' revenue only: August's journal and its reversal are left out.
    const sep = await ok<Month>(
      get(`/tenant/accounts/revenue-recognition?entityId=${entityId}&month=2026-09`),
    );
    expect(sep.rows.find((r) => r.project.id === projectId)).toMatchObject({
      billed: L(15),
      adjustment: L(10),
      posted: null,
    });
    // The company dashboard's margin is on revenue earned, not on what was billed.
    const d = await ok<{
      margin: {
        project: { id: string };
        revenue: string;
        billed: string;
        cost: string;
        basis: string;
      }[];
    }>(get(`/tenant/company-dashboard?entityId=${entityId}&asOf=2026-08-31`));
    expect(d.margin.find((m) => m.project.id === projectId)).toMatchObject({
      revenue: L(25),
      billed: L(15),
      cost: L(20),
      basis: '25.0% complete by cost',
    });
  });
});
