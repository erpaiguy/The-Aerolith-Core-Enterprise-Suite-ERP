// Receivables in a real tenant database (docs/wave3-plan.md step 3), every figure worked by hand: a mobilisation
// advance received; two certified bills settled by one payment with TDS (one in full, one in part); an over-allocation
// and an unallocated rupee refused; retention released, but not more than is held; what is owed aged as at two dates;
// a receipt cancelled, its voucher reversed and the bills open again.
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

describe.skipIf(!controlUrl || !adminUrl)('receivables (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-recv-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'recv-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  let entityId: string;
  let projectId: string;
  let zp: string;
  let bank: string;
  let ra1: string;
  let ra2: string;
  let receipt2: string;
  const certifiedBill = async (upto: string, certifiedOn: string) => {
    const b = await ok<{ id: string; rowVersion: number }>(
      post(`/tenant/projects/${projectId}/client-bills`, { upto }, manager),
    );
    const s = await ok<{ rowVersion: number }>(
      post(`/tenant/client-bills/${b.id}/submit`, { rowVersion: b.rowVersion }, manager),
    );
    await ok(
      post(
        `/tenant/client-bills/${b.id}/certify`,
        { rowVersion: s.rowVersion, certifiedOn },
        manager,
      ),
    );
    return b.id;
  };
  const record = (body: object, as: Record<string, string> = manager) =>
    post(
      '/tenant/accounts/client-receipts',
      { entityId, partyId: zp, bankAccountId: bank, ...body },
      as,
    );
  const owed = (asOf: string) =>
    ok<{
      clients: {
        party: { name: string };
        buckets: string[];
        outstanding: string;
        retentionHeld: string;
        advanceUnrecovered: string;
      }[];
      bills: { raNo: number; outstanding: string; ageDays: number; bucket: string }[];
    }>(get(`/tenant/accounts/receivables?entityId=${entityId}&asOf=${asOf}`, manager));

  it('receives an advance, then two bills in one payment with TDS, in full and in part', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Washim Builders Pvt Ltd',
        gstin: '27AAACW1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    zp = (
      await ok<{ id: string }>(
        post('/tenant/parties', { name: 'Zilla Parishad Washim', isClient: true }),
      )
    ).id;
    projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Washim', clientId: zp }, manager),
      )
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
    );
    const boqId = (
      await ok<{ id: string }>(
        post(`/tenant/projects/${projectId}/boqs`, { name: 'Contract', kind: 'contract' }, manager),
      )
    ).id;
    await ok(
      post(
        `/tenant/boqs/${boqId}/changes`,
        {
          ops: [
            {
              op: 'insert',
              tempId: 'tA',
              parentId: null,
              afterId: null,
              type: 'section',
              code: 'A',
              description: 'Earthwork',
            },
            {
              op: 'insert',
              tempId: 't1',
              parentId: 'tA',
              afterId: null,
              type: 'item',
              code: 'A.1',
              description: 'Excavation',
              unit: 'cum',
              qty: '100',
              rate: '350',
            },
          ],
        },
        manager,
      ),
    );
    const node = (
      await db<
        { id: string }[]
      >`SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND code = 'A.1'`
    )[0]!.id;
    const measure = (measuredOn: string, qty: string) =>
      ok(post(`/tenant/boqs/${boqId}/lines/${node}/progress`, { measuredOn, qty }, manager));
    // GST 18%; retention 5%; ₹20,000 advance recovered at 10% a bill.
    await ok(
      post(
        `/tenant/projects/${projectId}/bill-terms`,
        {
          rowVersion: null,
          gstPct: '18',
          retentionPct: '5',
          advanceAmount: '20000',
          advanceRecoveryPct: '10',
        },
        manager,
      ),
    );
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id,
          code: 'A4002',
          name: 'HDFC Bank 0012',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;

    // 1 June: the ₹20,000 advance.
    const adv = await ok<{ voucher: { number: string } }>(
      record({
        receivedOn: '2026-06-01',
        amount: '20000',
        reference: 'UTR 4411',
        allocations: [{ kind: 'advance', projectId, amount: '20000' }],
      }),
    );
    expect(adv.voucher.number).toBe('RV/2026-27/0001');

    // RA 1: 40 cum × 350 = 14,000; GST 2,520; 16,520; retention 700; advance 1,400: net 14,420 (5 July).
    // RA 2: 60 cum more = 21,000; GST 3,780; 24,780; retention 1,050; advance 2,100: net 21,630 (10 August).
    await measure('2026-06-20', '40');
    ra1 = await certifiedBill('2026-06-30', '2026-07-05');
    await measure('2026-07-20', '60');
    ra2 = await certifiedBill('2026-07-31', '2026-08-10');
    const items = await ok<{
      bills: { raNo: number; outstanding: string }[];
      projects: { retentionOpen: string }[];
    }>(get(`/tenant/accounts/open-items?entityId=${entityId}&partyId=${zp}`, manager));
    expect(items.bills.map((b) => [b.raNo, b.outstanding])).toEqual([
      [1, '14420.00'],
      [2, '21630.00'],
    ]);
    expect(items.projects[0]!.retentionOpen).toBe('1750.00');

    // 20 August: ₹30,000 into the bank and ₹700 TDS settle ₹30,700: RA 1 in full (14,420), RA 2 in part (16,280).
    expect(
      (
        await record({
          receivedOn: '2026-08-20',
          amount: '30000',
          tds: '700',
          allocations: [{ kind: 'bill', billId: ra1, amount: '30700' }],
        })
      ).json(),
    ).toMatchObject({
      code: 'over_allocated',
      message: 'RA 1: ₹14420.00 is outstanding, not ₹30700.00.',
    });
    expect(
      (
        await record({
          receivedOn: '2026-08-20',
          amount: '30000',
          tds: '700',
          allocations: [{ kind: 'bill', billId: ra1, amount: '14420' }],
        })
      ).json(),
    ).toMatchObject({ code: 'not_allocated' });
    expect(
      (
        await record(
          {
            receivedOn: '2026-08-20',
            amount: '30000',
            allocations: [{ kind: 'bill', billId: ra1, amount: '30000' }],
          },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    const r2 = await ok<{ id: string; voucher: { id: string; number: string } }>(
      record({
        receivedOn: '2026-08-20',
        amount: '30000',
        tds: '700',
        reference: 'UTR 5120',
        allocations: [
          { kind: 'bill', billId: ra1, amount: '14420' },
          { kind: 'bill', billId: ra2, amount: '16280' },
        ],
      }),
    );
    receipt2 = r2.id;
    const v = await ok<{ lines: { account: { name: string }; debit: string; credit: string }[] }>(
      get(`/tenant/accounts/vouchers/${r2.voucher.id}`, manager),
    );
    expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['HDFC Bank 0012', '30000.00', '0.00'],
      ['TDS receivable', '700.00', '0.00'],
      ['Zilla Parishad Washim', '0.00', '14420.00'],
      ['Zilla Parishad Washim', '0.00', '16280.00'],
    ]);
    // The bill shows what it received.
    expect(
      (
        await ok<{ receipts: { amount: string }[] }>(get(`/tenant/client-bills/${ra2}`, manager))
      ).receipts.map((r) => r.amount),
    ).toEqual(['16280.00']);
  });

  it('releases retention up to what is held, ages what is owed, and cancels a receipt', async () => {
    // Retention held 700 + 1,050 = 1,750: 2,000 is too much; 1,000 released on 10 September.
    expect(
      (
        await record({
          receivedOn: '2026-09-10',
          amount: '2000',
          allocations: [{ kind: 'retention', projectId, amount: '2000' }],
        })
      ).json(),
    ).toMatchObject({ code: 'over_allocated' });
    await ok(
      record({
        receivedOn: '2026-09-10',
        amount: '1000',
        allocations: [{ kind: 'retention', projectId, amount: '1000' }],
      }),
    );

    // As at 30 September: RA 2 owes 21,630 − 16,280 = 5,350, 51 days after its invoice; retention 750 held; advance
    // 20,000 − 1,400 − 2,100 = 16,500 not yet recovered.
    let r = await owed('2026-09-30');
    expect(r.bills.map((b) => [b.raNo, b.outstanding, b.ageDays, b.bucket])).toEqual([
      [2, '5350.00', 51, '31-60'],
    ]);
    expect(r.clients).toEqual([
      {
        party: expect.objectContaining({ name: 'Zilla Parishad Washim' }),
        buckets: ['0.00', '5350.00', '0.00', '0.00'],
        outstanding: '5350.00',
        retentionHeld: '750.00',
        advanceUnrecovered: '16500.00',
      },
    ]);
    // As at 15 August, before the payment: RA 1 (41 days) and RA 2 (5 days), ₹36,050; all ₹1,750 of retention held.
    r = await owed('2026-08-15');
    expect(r.bills.map((b) => [b.raNo, b.outstanding, b.bucket])).toEqual([
      [1, '14420.00', '31-60'],
      [2, '21630.00', '0-30'],
    ]);
    expect(r.clients[0]).toMatchObject({ outstanding: '36050.00', retentionHeld: '1750.00' });

    // The books for the project: the client 5,350 Dr; retention 750 Dr; the advance 16,500 Cr.
    const tb = await ok<{ rows: { name: string; debit: string | null; credit: string | null }[] }>(
      get(
        `/tenant/accounts/trial-balance?entityId=${entityId}&asOf=2026-09-30&projectId=${projectId}`,
        manager,
      ),
    );
    const at = (n: string) => tb.rows.find((x) => x.name === n);
    expect([
      at('Zilla Parishad Washim')?.debit,
      at('Retention receivable')?.debit,
      at('Mobilisation advance received')?.credit,
    ]).toEqual(['5350.00', '750.00', '16500.00']);

    // The 20 August payment was the wrong client's: cancelled on 15 September. Both bills are owed again.
    const c = await ok<{ status: string; cancelVoucher: { number: string }; mayCancel: boolean }>(
      post(
        `/tenant/accounts/client-receipts/${receipt2}/cancel`,
        { date: '2026-09-15', reason: 'Credited to the wrong client' },
        manager,
      ),
    );
    expect(c).toMatchObject({
      status: 'cancelled',
      mayCancel: false,
      cancelVoucher: { number: 'RV/2026-27/0004' },
    });
    expect(
      (
        await post(
          `/tenant/accounts/client-receipts/${receipt2}/cancel`,
          { date: '2026-09-15', reason: 'again' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'cancelled' });
    r = await owed('2026-09-30');
    expect(r.bills.map((b) => [b.raNo, b.outstanding, b.bucket])).toEqual([
      [1, '14420.00', '61-90'],
      [2, '21630.00', '31-60'],
    ]);
    const list = await ok<{ status: string }[]>(
      get(`/tenant/accounts/client-receipts?entityId=${entityId}`, manager),
    );
    expect(list.map((x) => x.status)).toEqual(['posted', 'cancelled', 'posted']);
  });
  it('keeps GST TDS by a government client apart, matches it to GSTR-7A and takes it into the cash ledger', async () => {
    // docs/wave8-plan.md step 8b.2. RA 1 (₹14,420) paid on 5 October less 2% GST TDS of ₹240.
    await ok(
      record({
        receivedOn: '2026-10-05',
        amount: '14180',
        gstTds: '240',
        allocations: [{ kind: 'bill', billId: ra1, amount: '14420' }],
      }),
    );
    interface View {
      rows: {
        party: string;
        month: string;
        books: string;
        state: string;
        credit: { amount: string } | null;
      }[];
      totals: { books: string; credited: string };
    }
    const url = `/tenant/accounts/gst-tds?entityId=${entityId}&from=2026-10-01&to=2026-10-31`;
    expect((await get(url, worker)).statusCode).toBe(403);
    expect((await ok<View>(get(url, manager))).rows).toEqual([
      expect.objectContaining({
        party: 'Zilla Parishad Washim',
        month: '2026-10',
        books: '240.00',
        state: 'awaiting',
      }),
    ]);
    const credit = {
      entityId,
      partyId: zp,
      month: '2026-10',
      deductorGstin: '27AAAGZ0001A1DA',
      amount: '240',
      acceptedOn: '2026-11-12',
    };
    const after = await ok<View>(post('/tenant/accounts/gst-tds/credits', credit, manager));
    expect(after.rows.map((r) => [r.state, r.credit?.amount])).toEqual([['matched', '240.00']]);
    expect((await post('/tenant/accounts/gst-tds/credits', credit, manager)).json()).toMatchObject({
      code: 'already_accepted',
    });
    // The receivable is cleared into the cash ledger.
    const tb = await ok<{ rows: { name: string; debit: string | null; credit: string | null }[] }>(
      get(`/tenant/accounts/trial-balance?entityId=${entityId}&asOf=2026-11-30`, manager),
    );
    const at = (n: string) => tb.rows.find((x) => x.name === n);
    expect([
      at('GST electronic cash ledger')?.debit,
      at('GST TDS deducted by clients (section 51)'),
    ]).toEqual(['240.00', undefined]);
  });
});
