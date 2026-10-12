// Cash flow (docs/wave4-plan.md step 2), a project worked by hand for six months each way in a real tenant database,
// as of 1 October 2026 with cash terms of 10 days to certify and 10 to pay (so a month's work arrives the next month):
// a certified bill part-received, measured work not yet billed, the rest of the contract spread evenly to the planned
// finish, a supplier bill due, an open order, cost not yet ordered; actual receipts and payments; and the company's
// view with its bank balance, overheads and GST to the government.
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

describe.skipIf(!controlUrl || !adminUrl)('cash flow (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-cash-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'cash-admin@example.in');
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

  it("works a project's and the company's cash flow by hand", async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    const entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Akola Infra Pvt Ltd',
        gstin: '27AAACA1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const chart = await ok<{ accounts: { id: string; code: string; systemKey: string | null }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const acct = (c: string) => chart.accounts.find((a) => a.code === c)!.id;
    const bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id,
          code: 'A4002',
          name: 'SBI Current',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;
    const party = async (body: object) =>
      (await ok<{ id: string }>(post('/tenant/parties', body))).id;
    const zp = await party({
      name: 'Zilla Parishad Akola',
      gstin: '27AAALZ1234P1Z5',
      address: 'Civil Lines',
      city: 'Akola',
      pincode: '444001',
    });
    const vendor = (body: object) => party({ isClient: false, isVendor: true, ...body });
    const shinde = await vendor({ name: 'Shinde Labour Supply' });
    const vidarbha = await vendor({ name: 'Vidarbha Cement', gstin: '27AAACV1234F1Z5' });

    // The project: 1,100 cum at ₹1,000 (₹11,00,000), to finish by 31 March 2027; 18% GST and 5% retention.
    const projectId = (
      await ok<{ id: string }>(
        post(
          '/tenant/projects',
          {
            name: 'Hostel, Akola',
            clientId: zp,
            startOn: '2026-04-01',
            plannedFinishOn: '2027-03-31',
          },
          manager,
        ),
      )
    ).id;
    const site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Akola', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
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
              description: 'Works',
            },
            {
              op: 'insert',
              tempId: 't1',
              parentId: 'tA',
              afterId: null,
              type: 'item',
              code: 'A.1',
              description: 'RCC',
              unit: 'cum',
              qty: '1100',
              rate: '1000',
            },
          ],
        },
        manager,
      ),
    );
    const [node] = await db<{ id: string }[]>`
      SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND code = 'A.1'`;
    const measure = (measuredOn: string, qty: string) =>
      ok(post(`/tenant/boqs/${boqId}/lines/${node!.id}/progress`, { measuredOn, qty }, manager));
    await ok(
      post(
        `/tenant/projects/${projectId}/bill-terms`,
        { rowVersion: null, gstPct: '18', retentionPct: '5' },
        manager,
      ),
    );

    // RA 1: 300 cum to 31 July, certified on 5 August: 3,00,000 + 54,000 GST − 15,000 retention = 3,39,000. Received
    // on 10 September: ₹1,94,000 and ₹6,000 TDS against ₹2,00,000 of it; ₹1,39,000 still owed, due long since.
    await measure('2026-07-20', '300');
    const ra = await ok<{ id: string; rowVersion: number }>(
      post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-07-31' }, manager),
    );
    const sub = await ok<{ rowVersion: number }>(
      post(`/tenant/client-bills/${ra.id}/submit`, { rowVersion: ra.rowVersion }, manager),
    );
    await ok(
      post(
        `/tenant/client-bills/${ra.id}/certify`,
        { rowVersion: sub.rowVersion, certifiedOn: '2026-08-05' },
        manager,
      ),
    );
    await ok(
      post(
        '/tenant/accounts/client-receipts',
        {
          entityId,
          partyId: zp,
          bankAccountId: bank,
          receivedOn: '2026-09-10',
          amount: '194000',
          tds: '6000',
          reference: 'UTR4411',
          allocations: [{ kind: 'bill', billId: ra.id, amount: '200000' }],
        },
        manager,
      ),
    );
    // 200 cum more by 25 September: ₹2,00,000 measured, not yet billed.
    await measure('2026-09-25', '200');

    // Paid: ₹30,000 of labour billed on 10 August, paid on 25 August; ₹5,000 of site expenses paid on 15 July.
    const vbill = (body: object) =>
      ok<{ id: string; status: string }>(
        post(
          '/tenant/accounts/vendor-bills',
          { entityId, projectId, orderId: null, tdsSection: null, ...body },
          manager,
        ),
      );
    const labour = (billNo: string, billDate: string, dueDate: string, rate: string) =>
      vbill({
        partyId: shinde,
        billNo,
        billDate,
        dueDate,
        lines: [
          {
            accountId: acct('X2002'),
            projectId,
            description: 'Labour',
            qty: '1',
            rate,
            gstPct: '0',
          },
        ],
      });
    const aug = await labour('SLS/8', '2026-08-10', '2026-08-25', '30000');
    let run = await ok<{ id: string; status: string }>(
      post(
        '/tenant/accounts/payment-runs',
        {
          entityId,
          bankAccountId: bank,
          payOn: '2026-08-25',
          lines: [{ partyId: shinde, kind: 'bill', billId: aug.id, amount: '30000' }],
        },
        manager,
      ),
    );
    run = await ok(post(`/tenant/accounts/payment-runs/${run.id}/submit`, {}, manager));
    expect(run.status).toBe('approved');
    await ok(
      post(`/tenant/accounts/payment-runs/${run.id}/paid`, { paidOn: '2026-08-25' }, manager),
    );
    await ok(
      post(
        '/tenant/accounts/vouchers',
        {
          entityId,
          type: 'payment',
          date: '2026-07-15',
          narration: 'Site expenses',
          lines: [
            { accountId: acct('X3004'), debit: '5000', projectId },
            { accountId: bank, credit: '5000' },
          ],
        },
        manager,
      ),
    );
    // Owed: ₹50,000 of labour due on 20 October. Ordered: 400 bags at ₹400 + 28% (₹2,04,800), to come by 15 October.
    await labour('SLS/9', '2026-09-20', '2026-10-20', '50000');
    const o = await ok<{ open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: vidarbha,
          siteId: site,
          deliverBy: '2026-10-15',
          lines: [
            { description: 'Cement OPC 53', unit: 'bag', qty: '400', rate: '400', gstPct: '28' },
          ],
        },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    // Planning expects ₹7,60,000 more cost: ₹1,60,000 of it ordered, ₹6,00,000 not yet.
    await ok(
      post(
        `/tenant/projects/${projectId}/cost-control/ctc`,
        { key: '|', amount: '760000' },
        manager,
      ),
    );

    // Cash terms: 10 days to certify, 10 to pay, 2% TDS, suppliers and cost paid 10 days on.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/cash-terms`,
          {
            certifyDays: 10,
            clientPayDays: 10,
            clientTdsPct: '2',
            supplierDays: 10,
            costDays: 10,
            rowVersion: null,
          },
          worker,
        )
      ).statusCode,
    ).toBe(404);
    await ok(
      post(
        `/tenant/projects/${projectId}/cash-terms`,
        {
          certifyDays: 10,
          clientPayDays: 10,
          clientTdsPct: '2',
          supplierDays: 10,
          costDays: 10,
          rowVersion: null,
        },
        manager,
      ),
    );

    type Table = {
      periods: { key: string; label: string; actual: boolean }[];
      lines: { kind: string; values: Record<string, string> }[];
      totals: {
        in: Record<string, string>;
        out: Record<string, string>;
        net: Record<string, string>;
      };
      position: Record<string, string>;
      notes: string[];
    };
    const p = await ok<Table>(
      get(`/tenant/projects/${projectId}/cash-flow?asOf=2026-10-01`, manager),
    );
    expect(p.periods.map((x) => x.key)).toEqual([
      'a2026-04',
      'a2026-05',
      'a2026-06',
      'a2026-07',
      'a2026-08',
      'a2026-09',
      'f2026-10',
      'f2026-11',
      'f2026-12',
      'f2027-01',
      'f2027-02',
      'f2027-03',
      'f2027-04',
      'f2027-05',
      'f2027-06',
      'f2027-07',
      'f2027-08',
      'f2027-09',
      'later',
    ]);
    const nz = (v: Record<string, string>) =>
      Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '0.00'));
    expect(Object.fromEntries(p.lines.map((l) => [l.kind, nz(l.values)]))).toEqual({
      received: { 'a2026-09': '194000.00' },
      // Owed since 15 August: due now.
      certified: { 'f2026-10': '139000.00' },
      // 2,00,000 billed on 31 October, certified on 10 November, paid on the 20th: + 36,000 − 10,000 − 4,000.
      unbilled: { 'f2026-11': '222000.00' },
      // The other ₹6,00,000, ₹1,00,000 a month from October to March, each arriving the next month: ₹1,11,000.
      work: {
        'f2026-11': '111000.00',
        'f2026-12': '111000.00',
        'f2027-01': '111000.00',
        'f2027-02': '111000.00',
        'f2027-03': '111000.00',
        'f2027-04': '111000.00',
      },
      paid: { 'a2026-08': '30000.00' },
      other_paid: { 'a2026-07': '5000.00' },
      bills: { 'f2026-10': '50000.00' },
      // Delivered on 15 October, paid on the 25th.
      orders: { 'f2026-10': '204800.00' },
      // ₹6,00,000 spread like the work and paid 10 days after each month.
      uncommitted: {
        'f2026-11': '100000.00',
        'f2026-12': '100000.00',
        'f2027-01': '100000.00',
        'f2027-02': '100000.00',
        'f2027-03': '100000.00',
        'f2027-04': '100000.00',
      },
    });
    expect(nz(p.totals.net)).toEqual({
      'a2026-07': '-5000.00',
      'a2026-08': '-30000.00',
      'a2026-09': '194000.00',
      'f2026-10': '-115800.00',
      'f2026-11': '233000.00',
      'f2026-12': '11000.00',
      'f2027-01': '11000.00',
      'f2027-02': '11000.00',
      'f2027-03': '11000.00',
      'f2027-04': '11000.00',
    });
    expect([
      p.position['a2026-09'],
      p.position['f2026-10'],
      p.position['f2026-11'],
      p.position['later'],
    ]).toEqual(['159000.00', '43200.00', '276200.00', '331200.00']);
    expect(p.notes).toEqual([
      'No schedule is linked to the contract BOQ: the work still to do is spread evenly to the planned finish.',
    ]);
    // By week: the order's ₹2,04,800 falls in the week of 19 October (paid on Sunday the 25th).
    const w = await ok<Table>(
      get(`/tenant/projects/${projectId}/cash-flow?asOf=2026-10-01&by=week`, manager),
    );
    expect(nz(w.lines.find((l) => l.kind === 'orders')!.values)).toEqual({
      'f2026-10-19': '204800.00',
    });

    // The company: the bank (1,94,000 in, 35,000 out: 1,59,000 now), ₹20,000 a month of overheads, and GST. October:
    // ₹44,800 of input tax on the cement, carried; November: 18,000 + 36,000 of output tax less it, ₹9,200 on 20
    // December; then ₹18,000 a month.
    await ok(
      post(`/tenant/accounts/cash-flow/${entityId}/overheads`, { amount: '20000' }, manager),
    );
    expect((await get(`/tenant/accounts/cash-flow?entityId=${entityId}`, worker)).statusCode).toBe(
      403,
    );
    const c = await ok<Table & { cashNow: string; opening: string; projects: { net: string }[] }>(
      get(`/tenant/accounts/cash-flow?entityId=${entityId}&asOf=2026-10-01`, manager),
    );
    expect([c.opening, c.cashNow]).toEqual(['0.00', '159000.00']);
    const line = (k: string) => nz(c.lines.find((l) => l.kind === k)!.values);
    expect(line('bank_in')).toEqual({ 'a2026-09': '194000.00' });
    expect(line('bank_out')).toEqual({ 'a2026-07': '5000.00', 'a2026-08': '30000.00' });
    expect(line('gst')).toEqual({
      'f2026-12': '9200.00',
      'f2027-01': '18000.00',
      'f2027-02': '18000.00',
      'f2027-03': '18000.00',
      'f2027-04': '18000.00',
      'f2027-05': '18000.00',
    });
    expect(line('overheads')['f2026-10']).toBe('20000.00');
    // October: 1,39,000 in; 2,54,800 to suppliers and 20,000 of overheads out: 1,59,000 − 1,35,800 = 23,200.
    expect(c.position['f2026-10']).toBe('23200.00');
    expect(c.projects.map((x) => x.net)).toEqual(['172200.00']);
  });
});
