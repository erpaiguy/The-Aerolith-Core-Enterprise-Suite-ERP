// Financial statements in a real tenant database (docs/wave3-plan.md step 8a), every figure by hand: a year of books
// (capital, a term loan, plant bought and depreciated, a client billed and paid, a supplier billed and part paid, site
// overheads, interest); profit and loss, balance sheet and cash flow; two projects' P&L; the year closed with closing
// stock, the balance sheet still balancing, the months locked, the stock reversed in the new year.
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

describe.skipIf(!controlUrl || !adminUrl)('statements and year end (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-fs-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'fs-admin@example.in');
    // More people than a trial's one manager and one worker.
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
  const id = new Map<string, string>();
  let p1: string;
  let p2: string;
  let client: string;
  let supplier: string;
  const L = (account: string, debit: string, credit: string, projectId: string | null = null) => ({
    accountId: id.get(account) ?? account,
    debit,
    credit,
    projectId,
  });
  const P = (partyId: string, debit: string, credit: string) => ({ partyId, debit, credit });
  const voucher = (
    type: string,
    date: string,
    lines: object[],
    as: Record<string, string> = manager,
  ) => post('/tenant/accounts/vouchers', { entityId, type, date, narration: type, lines }, as);

  it('gives the profit and loss, the balance sheet and the cash flow for a year, and each project', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Yavatmal Constructions Pvt Ltd',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    let chart = await ok<{ accounts: { id: string; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    for (const a of chart.accounts) id.set(a.code, a.id);
    await ok(
      post('/tenant/accounts/chart', {
        parentId: id.get('A40')!,
        code: 'A4002',
        name: 'SBI Current',
        kind: 'bank',
      }),
    );
    chart = await ok(
      post('/tenant/accounts/chart', {
        parentId: id.get('L10')!,
        code: 'L1001',
        name: 'Term loan SBI',
      }),
    );
    for (const a of chart.accounts) id.set(a.code, a.id);
    p1 = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hospital, Yavatmal' }, manager))
    ).id;
    p2 = (await ok<{ id: string }>(post('/tenant/projects', { name: 'School, Wani' }, manager))).id;
    client = (
      await ok<{ id: string }>(post('/tenant/parties', { name: 'Zilla Parishad Yavatmal' }))
    ).id;
    supplier = (
      await ok<{ id: string }>(
        post('/tenant/parties', { name: 'Wani Cement', isClient: false, isVendor: true }),
      )
    ).id;

    // The year: capital ₹10,00,000 and a ₹5,00,000 loan into the bank; plant ₹6,00,000; the client billed ₹3,00,000
    // + 9% + 9% and paid; cement ₹1,00,000 + 9% + 9%, ₹70,000 of it paid; site overheads ₹20,000; depreciation ₹60,000
    // written off the plant; interest ₹30,000.
    await ok(
      voucher('receipt', '2026-04-01', [L('A4002', '1000000', '0'), L('E1001', '0', '1000000')]),
    );
    await ok(
      voucher('receipt', '2026-04-05', [L('A4002', '500000', '0'), L('L1001', '0', '500000')]),
    );
    await ok(
      voucher('payment', '2026-05-01', [L('A1001', '600000', '0'), L('A4002', '0', '600000')]),
    );
    await ok(
      voucher('sales', '2026-06-30', [
        P(client, '354000', '0'),
        L('I1001', '0', '300000', p1),
        L('L5001', '0', '27000'),
        L('L5002', '0', '27000'),
      ]),
    );
    await ok(
      voucher('receipt', '2026-07-15', [L('A4002', '354000', '0'), P(client, '0', '354000')]),
    );
    await ok(
      voucher('purchase', '2026-08-01', [
        L('X1001', '100000', '0', p1),
        L('A5006', '9000', '0'),
        L('A5007', '9000', '0'),
        P(supplier, '0', '118000'),
      ]),
    );
    await ok(
      voucher('payment', '2026-08-20', [P(supplier, '70000', '0'), L('A4002', '0', '70000')]),
    );
    await ok(
      voucher('payment', '2026-09-30', [L('X3004', '20000', '0', p2), L('A4002', '0', '20000')]),
    );
    await ok(
      voucher('journal', '2027-03-31', [L('X6001', '60000', '0'), L('A1001', '0', '60000')]),
    );
    await ok(
      voucher('payment', '2027-03-31', [L('X5001', '30000', '0'), L('A4002', '0', '30000')]),
    );

    // Profit: 3,00,000 − (1,00,000 + 20,000 + 60,000 + 30,000) = 90,000.
    const pl = await ok<{
      lines: { key: string; amount: string; previous: string }[];
      income: string;
      expenses: string;
      profit: string;
    }>(
      get(
        `/tenant/accounts/statements/profit-and-loss?entityId=${entityId}&from=2026-04-01&to=2027-03-31`,
        manager,
      ),
    );
    expect(Object.fromEntries(pl.lines.map((l) => [l.key, l.amount]))).toEqual({
      revenue: '300000.00',
      other_income: '0.00',
      materials: '100000.00',
      subcontract: '0.00',
      employee: '0.00',
      finance: '30000.00',
      depreciation: '60000.00',
      other_expenses: '20000.00',
    });
    expect([pl.income, pl.expenses, pl.profit, pl.lines[0]!.previous]).toEqual([
      '300000.00',
      '210000.00',
      '90000.00',
      '0.00',
    ]);

    // As at 31 March: bank 11,34,000, plant 5,40,000, input tax 18,000 = 16,92,000; capital 10,00,000, loan 5,00,000,
    // the supplier 48,000, output tax 54,000 and the year's 90,000 not yet closed = 16,92,000.
    const bs = await ok<{
      lines: { key: string; amount: string }[];
      profitNotClosed: string;
      equityAndLiabilities: string;
      assets: string;
      balanced: boolean;
    }>(
      get(
        `/tenant/accounts/statements/balance-sheet?entityId=${entityId}&asOf=2027-03-31`,
        manager,
      ),
    );
    expect(
      Object.fromEntries(bs.lines.filter((l) => l.amount !== '0.00').map((l) => [l.key, l.amount])),
    ).toEqual({
      share_capital: '1000000.00',
      other_equity: '90000.00',
      long_term_borrowings: '500000.00',
      trade_payables: '48000.00',
      other_current_liabilities: '54000.00',
      ppe: '540000.00',
      cash: '1134000.00',
      loans_and_advances: '18000.00',
    });
    expect([bs.profitNotClosed, bs.equityAndLiabilities, bs.assets, bs.balanced]).toEqual([
      '90000.00',
      '1692000.00',
      '1692000.00',
      true,
    ]);

    // Cash flow: 90,000 + 60,000 − 18,000 + 48,000 + 54,000 = 2,34,000 operating; −6,00,000 investing; 15,00,000
    // financing: 11,34,000, the bank's change.
    const cf = await ok<Record<string, unknown>>(
      get(
        `/tenant/accounts/statements/cash-flow?entityId=${entityId}&from=2026-04-01&to=2027-03-31`,
        manager,
      ),
    );
    expect([
      cf.operating,
      cf.investing,
      cf.financing,
      cf.netChange,
      cf.cashChange,
      cf.agrees,
    ]).toEqual(['234000.00', '-600000.00', '1500000.00', '1134000.00', '1134000.00', true]);

    const pp = await ok<{
      projects: {
        project: { name: string };
        revenue: string;
        costs: string;
        margin: string;
        marginPct: string | null;
        byLine: { label: string; amount: string }[];
      }[];
    }>(
      get(
        `/tenant/accounts/statements/projects?entityId=${entityId}&from=2026-04-01&to=2027-03-31`,
        manager,
      ),
    );
    expect(
      pp.projects.map((p) => [p.project.name, p.revenue, p.costs, p.margin, p.marginPct]),
    ).toEqual([
      ['Hospital, Yavatmal', '300000.00', '100000.00', '200000.00', '66.7'],
      ['School, Wani', '0.00', '20000.00', '-20000.00', null],
    ]);
    expect(pp.projects[0]!.byLine).toEqual([
      { label: 'Cost of materials consumed', amount: '100000.00' },
    ]);
  });

  it('closes the year with closing stock, locks it, and opens the next with the stock reversed', async () => {
    const close = (body: object, as: Record<string, string> = t.admin) =>
      post('/tenant/accounts/year-end', { entityId, fy: '2026-27', ...body }, as);
    expect((await close({ closingStock: '25000' }, manager)).statusCode).toBe(403);
    expect((await close({ closingStock: '25000' }, worker)).statusCode).toBe(403);
    // Stock of ₹25,000 at the year end makes the profit ₹1,15,000.
    const r = await ok<{ profit: string; vouchers: string[] }>(close({ closingStock: '25000' }));
    expect(r).toEqual({
      fy: '2026-27',
      profit: '115000.00',
      closingStock: '25000.00',
      vouchers: ['JV/2026-27/0002', 'JV/2027-28/0001', 'JV/2026-27/0003'],
    });
    expect((await close({})).json()).toMatchObject({ code: 'year_closed' });
    // The balance sheet: stock 25,000 more on each side; the profit now in the profit and loss account.
    const bs = await ok<{
      lines: { key: string; amount: string }[];
      profitNotClosed: string;
      assets: string;
      balanced: boolean;
    }>(
      get(
        `/tenant/accounts/statements/balance-sheet?entityId=${entityId}&asOf=2027-03-31`,
        manager,
      ),
    );
    expect([
      bs.lines.find((l) => l.key === 'inventories')!.amount,
      bs.lines.find((l) => l.key === 'other_equity')!.amount,
      bs.profitNotClosed,
      bs.assets,
      bs.balanced,
    ]).toEqual(['25000.00', '115000.00', '0.00', '1717000.00', true]);
    // The year's P&L still shows the year (the close left out).
    const pl = await ok<{ profit: string }>(
      get(
        `/tenant/accounts/statements/profit-and-loss?entityId=${entityId}&from=2026-04-01&to=2027-03-31`,
        manager,
      ),
    );
    expect(pl.profit).toBe('115000.00');
    // March is locked; April opens with the stock back in consumption.
    expect(
      (
        await voucher('payment', '2027-03-15', [L('X5002', '100', '0'), L('A4002', '0', '100')])
      ).json(),
    ).toMatchObject({ code: 'period_locked' });
    const april = await ok<{ lines: { key: string; amount: string }[]; profit: string }>(
      get(
        `/tenant/accounts/statements/profit-and-loss?entityId=${entityId}&from=2027-04-01&to=2027-04-30`,
        manager,
      ),
    );
    expect([april.lines.find((l) => l.key === 'materials')!.amount, april.profit]).toEqual([
      '25000.00',
      '-25000.00',
    ]);
    const ye = await ok<{ closed: { fy: string }[] }>(
      get(`/tenant/accounts/year-end?entityId=${entityId}`, manager),
    );
    expect(ye.closed.map((c) => c.fy)).toEqual(['2026-27']);
  });
});
