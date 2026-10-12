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

describe.skipIf(!controlUrl || !adminUrl)('subcontract bills (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-sc-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'sc-admin@example.in');
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

  interface Figures {
    gross: string;
    cgst: string;
    sgst: string;
    total: string;
    retention: string;
    advance: string;
    backcharges: string;
    cess: string;
    tdsBase: string;
    tds: string;
    payable: string;
    net: string;
  }
  interface ScBill {
    id: string;
    raNo: number;
    status: string;
    rowVersion: number;
    figures: Figures | null;
    certified: Figures | null;
    problem: string | null;
    lines: { lineKey: string; prevQty: string; measuredQty: string; cumQty: string }[];
    approval: { id: string } | null;
    vendorBill: { id: string; billNo: string; voucher: string } | null;
  }
  interface Wo {
    lines: { lineKey: string; description: string; measured: string; certified: string }[];
    book: { id: string; qty: string; reversed: boolean }[];
    retention: { held: string; released: string; left: string };
  }
  const pick = (f: Figures) => [
    f.gross,
    f.cgst,
    f.sgst,
    f.total,
    f.retention,
    f.backcharges,
    f.cess,
    f.tdsBase,
    f.tds,
    f.payable,
    f.advance,
    f.net,
  ];
  let entityId: string;
  let projectId: string;
  let kale: string;
  let hdfc: string;
  let cement: string;
  let woId: string;
  let brick: string;
  let plaster: string;
  const vbills: string[] = [];

  it('keeps a measurement book and certifies the first bill under the approval rules', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Akola Infra Pvt Ltd',
        gstin: '27AAACA1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'School, Akola' }, manager))
    ).id;
    const site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Akola', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    // An individual registered in Maharashtra: 1% under 194C, CGST and SGST.
    kale = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Kale Constructions',
          isClient: false,
          isVendor: true,
          gstin: '27ABCPK1234L1Z5',
          pan: 'ABCPK1234L',
        }),
      )
    ).id;
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    cement = chart.accounts.find((a) => a.systemKey === 'material_consumption')!.id;
    hdfc = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id,
          code: 'A4002',
          name: 'HDFC Bank 0012',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;

    // The work order: brickwork 100 cum at ₹4,500 and plaster 1,000 sqm at ₹250, GST 18%.
    const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'work',
          partyId: kale,
          siteId: site,
          lines: [
            {
              description: 'Brickwork 230 mm',
              unit: 'cum',
              qty: '100',
              rate: '4500',
              gstPct: '18',
            },
            { description: 'Plaster 12 mm', unit: 'sqm', qty: '1000', rate: '250', gstPct: '18' },
          ],
        },
        manager,
      ),
    );
    const issued = await ok<{
      id: string;
      inForce: { lines: { lineKey: string; description: string }[] };
    }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    woId = issued.id;
    brick = issued.inForce.lines.find((l) => l.description === 'Brickwork 230 mm')!.lineKey;
    plaster = issued.inForce.lines.find((l) => l.description === 'Plaster 12 mm')!.lineKey;

    // Retention 5% capped at ₹22,000; 10% of each bill recovers the advance; cess 1%; 194C.
    await ok(
      app.inject({
        method: 'PUT',
        url: `/api/tenant/work-orders/${woId}/subcontract-terms`,
        headers: manager,
        payload: {
          retentionPct: '5',
          retentionCap: '22000',
          advanceRecoveryPct: '10',
          labourCessPct: '1',
          tdsSection: '194C',
        },
      }),
    );
    // A ₹50,000 mobilisation advance, paid in a run (no rules: approved on submission).
    const run = await ok<{ id: string }>(
      post(
        '/tenant/accounts/payment-runs',
        {
          entityId,
          bankAccountId: hdfc,
          payOn: '2026-05-10',
          lines: [{ partyId: kale, kind: 'advance', projectId, amount: '50000' }],
        },
        manager,
      ),
    );
    await ok(post(`/tenant/accounts/payment-runs/${run.id}/submit`, {}, manager));
    await ok(
      post(`/tenant/accounts/payment-runs/${run.id}/paid`, { paidOn: '2026-05-10' }, manager),
    );

    // The book: 4 cum, 40 sqm; 5 cum entered by mistake and reversed. A worker off the project does not see it.
    const measure = (lineKey: string, measuredOn: string, qty: string, as = manager) =>
      post(`/tenant/work-orders/${woId}/measurements`, { lineKey, measuredOn, qty }, as);
    expect((await measure(brick, '2026-05-20', '4', worker)).statusCode).toBe(404);
    await ok(measure(brick, '2026-05-20', '4'));
    await ok(measure(plaster, '2026-05-25', '40'));
    let wo = await ok<Wo>(measure(brick, '2026-05-26', '5'));
    const mistake = wo.book.find((e) => e.qty === '5.0000')!.id;
    wo = await ok<Wo>(
      post(
        `/tenant/wo-measurements/${mistake}/reverse`,
        { date: '2026-05-27', reason: 'Wrong wing' },
        manager,
      ),
    );
    expect(
      (
        await post(
          `/tenant/wo-measurements/${mistake}/reverse`,
          { date: '2026-05-27', reason: 'again' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'already_reversed' });
    expect(wo.lines.map((l) => [l.description, l.measured])).toEqual([
      ['Brickwork 230 mm', '4.0000'],
      ['Plaster 12 mm', '40.0000'],
    ]);

    // RA 1 to 31 May with ₹2,000 of cement issued from stores. Gross 18,000 + 10,000 = 28,000; GST 2,520 + 2,520 =
    // 33,040. Retention 1,400; back-charge 2,000; cess 280; TDS nil (under ₹30,000 a bill and ₹1 lakh a year). The bill
    // carries 29,360; the advance recovers 2,800; 26,560 to pay.
    let b = await ok<ScBill>(
      post(`/tenant/work-orders/${woId}/subcontract-bills`, { upto: '2026-05-31' }, manager),
    );
    expect(
      (
        await post(`/tenant/work-orders/${woId}/subcontract-bills`, { upto: '2026-05-31' }, manager)
      ).json(),
    ).toMatchObject({ code: 'open_bill' });
    b = await ok<ScBill>(
      app.inject({
        method: 'PUT',
        url: `/api/tenant/subcontract-bills/${b.id}`,
        headers: manager,
        payload: {
          rowVersion: b.rowVersion,
          lines: [],
          backcharges: [
            { description: 'Cement issued, 5 bags', amount: '2000', accountId: cement },
          ],
        },
      }),
    );
    expect(pick(b.figures!)).toEqual([
      '28000.00',
      '2520.00',
      '2520.00',
      '33040.00',
      '1400.00',
      '2000.00',
      '280.00',
      '0.00',
      '0.00',
      '29360.00',
      '2800.00',
      '26560.00',
    ]);
    // ₹33,040 is over the ₹30,000 rule: it waits for the admin.
    await ok(
      post('/tenant/approval-rules/subcontract_bill', {
        rules: [{ minAmount: '30000', approver: 'manager' }],
      }),
    );
    b = await ok<ScBill>(
      post(`/tenant/subcontract-bills/${b.id}/submit`, { rowVersion: b.rowVersion }, manager),
    );
    expect(b.status).toBe('pending');
    await ok(post(`/tenant/approvals/${b.approval!.id}/approve`, {}));
    b = await ok<ScBill>(get(`/tenant/subcontract-bills/${b.id}`, manager));
    expect(b.status).toBe('certified');
    expect(b.vendorBill!.billNo).toMatch(/^WO\/\d{4}-\d{2}\/\d{4}\/RA-1$/);
    vbills.push(b.vendorBill!.id);
    const vb = await ok<{
      id: string;
      status: string;
      payable: string;
      outstanding: string;
      voucher: { id: string };
    }>(get(`/tenant/accounts/vendor-bills/${b.vendorBill!.id}`, manager));
    expect([vb.status, vb.payable, vb.outstanding]).toEqual(['posted', '29360.00', '26560.00']);
    const v = await ok<{ lines: { account: { name: string }; debit: string; credit: string }[] }>(
      get(`/tenant/accounts/vouchers/${vb.voucher.id}`, manager),
    );
    expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['Subcontract cost', '18000.00', '0.00'],
      ['Subcontract cost', '10000.00', '0.00'],
      ['Input CGST', '2520.00', '0.00'],
      ['Input SGST', '2520.00', '0.00'],
      ['Kale Constructions', '0.00', '29360.00'],
      ['Retention payable', '0.00', '1400.00'],
      ['Material consumption', '0.00', '2000.00'],
      ['Labour cess payable', '0.00', '280.00'],
      ['Kale Constructions', '2800.00', '0.00'],
      ['Advances to suppliers', '0.00', '2800.00'],
    ]);
    // It is cancelled at its source, not in payables.
    expect(
      (
        await post(
          `/tenant/accounts/vendor-bills/${vb.id}/cancel`,
          { date: '2026-06-01', reason: 'wrong' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'from_subcontract' });
  });

  it('bills twice more: TDS catches up, the retention cap bites, and the book stays within the order', async () => {
    await ok(
      post(
        `/tenant/work-orders/${woId}/measurements`,
        { lineKey: brick, measuredOn: '2026-06-20', qty: '36' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/work-orders/${woId}/measurements`,
        { lineKey: plaster, measuredOn: '2026-06-20', qty: '960' },
        manager,
      ),
    );
    // RA 2 to 30 June: brickwork certified at 35 of the 40 measured.
    let b = await ok<ScBill>(
      post(`/tenant/work-orders/${woId}/subcontract-bills`, { upto: '2026-06-30' }, manager),
    );
    expect(b.lines.map((l) => [l.prevQty, l.measuredQty, l.cumQty])).toEqual([
      ['4.0000', '40.0000', '40.0000'],
      ['40.0000', '1000.0000', '1000.0000'],
    ]);
    const edit = (cumQty: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/tenant/subcontract-bills/${b.id}`,
        headers: manager,
        payload: { rowVersion: b.rowVersion, lines: [{ lineKey: brick, cumQty }], backcharges: [] },
      });
    expect((await edit('41')).json()).toMatchObject({ code: 'beyond_measured' });
    b = await ok<ScBill>(edit('35'));
    // Gross 31 × 4,500 + 960 × 250 = 139,500 + 240,000 = 379,500; GST 34,155 + 34,155 = 447,810. Retention 5% =
    // 18,975 (within the cap's 20,600 left). Cess 3,795. TDS: the year's 407,500 is past ₹1 lakh, so 1% on all of it,
    // RA 1 included: 4,075. Carries 420,965; advance 37,950; 383,015 to pay.
    expect(pick(b.figures!)).toEqual([
      '379500.00',
      '34155.00',
      '34155.00',
      '447810.00',
      '18975.00',
      '0.00',
      '3795.00',
      '407500.00',
      '4075.00',
      '420965.00',
      '37950.00',
      '383015.00',
    ]);
    // Under a ₹5 lakh rule now: certified on submission.
    await ok(
      post('/tenant/approval-rules/subcontract_bill', {
        rules: [{ minAmount: '500000', approver: 'manager' }],
      }),
    );
    b = await ok<ScBill>(
      post(`/tenant/subcontract-bills/${b.id}/submit`, { rowVersion: b.rowVersion }, manager),
    );
    expect(b.status).toBe('certified');
    vbills.push(b.vendorBill!.id);

    // The book will not pass the order; 5 more cum.
    expect(
      (
        await post(
          `/tenant/work-orders/${woId}/measurements`,
          { lineKey: brick, measuredOn: '2026-07-10', qty: '61' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'beyond_order' });
    await ok(
      post(
        `/tenant/work-orders/${woId}/measurements`,
        { lineKey: brick, measuredOn: '2026-07-10', qty: '5' },
        manager,
      ),
    );
    // RA 3 to 31 July: 10 cum (35 → 45) = 45,000; GST 4,050 + 4,050 = 53,100. Retention only the 1,625 left under the
    // cap. Cess 450; TDS 450 on this bill alone. Carries 50,575; advance 4,500; 46,075.
    b = await ok<ScBill>(
      post(`/tenant/work-orders/${woId}/subcontract-bills`, { upto: '2026-07-31' }, manager),
    );
    expect(pick(b.figures!)).toEqual([
      '45000.00',
      '4050.00',
      '4050.00',
      '53100.00',
      '1625.00',
      '0.00',
      '450.00',
      '45000.00',
      '450.00',
      '50575.00',
      '4500.00',
      '46075.00',
    ]);
    b = await ok<ScBill>(
      post(`/tenant/subcontract-bills/${b.id}/submit`, { rowVersion: b.rowVersion }, manager),
    );
    expect(b.status).toBe('certified');
    vbills.push(b.vendorBill!.id);
    const wo = await ok<Wo>(get(`/tenant/work-orders/${woId}/subcontract`, manager));
    expect(wo.lines.map((l) => [l.measured, l.certified])).toEqual([
      ['45.0000', '45.0000'],
      ['1000.0000', '1000.0000'],
    ]);
    expect(wo.retention).toEqual({ held: '22000.00', released: '0.00', left: '22000.00' });
  });

  it('releases the retention and pays it with the first bill in a run', async () => {
    expect(
      (
        await post(
          `/tenant/work-orders/${woId}/retention-release`,
          { date: '2026-08-15', amount: '22000' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          `/tenant/work-orders/${woId}/retention-release`,
          { date: '2026-08-15', amount: '22000.01' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'over_retention' });
    const wo = await ok<Wo & { releases: { id: string; billNo: string; amount: string }[] }>(
      post(
        `/tenant/work-orders/${woId}/retention-release`,
        { date: '2026-08-15', amount: '22000' },
        manager,
      ),
    );
    expect(wo.retention.left).toBe('0.00');
    expect(wo.releases[0]!.billNo).toMatch(/\/RR-1$/);
    // 26,560 + 22,000 = 48,560 in one run.
    const run = await ok<{ id: string; total: string }>(
      post(
        '/tenant/accounts/payment-runs',
        {
          entityId,
          bankAccountId: hdfc,
          payOn: '2026-08-20',
          lines: [
            { partyId: kale, kind: 'bill', billId: vbills[0], amount: '26560' },
            { partyId: kale, kind: 'bill', billId: wo.releases[0]!.id, amount: '22000' },
          ],
        },
        manager,
      ),
    );
    expect(run.total).toBe('48560.00');
    await ok(post(`/tenant/accounts/payment-runs/${run.id}/submit`, {}, manager));
    await ok(
      post(`/tenant/accounts/payment-runs/${run.id}/paid`, { paidOn: '2026-08-20' }, manager),
    );
    for (const id of [vbills[0], wo.releases[0]!.id])
      expect(
        (await ok<{ outstanding: string }>(get(`/tenant/accounts/vendor-bills/${id}`, manager)))
          .outstanding,
      ).toBe('0.00');
    // Retention payable is back to nothing; the advance has 4,750 left to recover.
    const tb = await ok<{ rows: { code: string; debit: string; credit: string }[] }>(
      get(`/tenant/accounts/trial-balance?entityId=${entityId}&asOf=2026-08-31`, manager),
    );
    const row = (code: string) => tb.rows.find((r) => r.code === code);
    expect(row('L4001')).toBeUndefined();
    expect([row('A5001')?.debit, row('L5004')?.credit, row('L5006')?.credit]).toEqual([
      '4750.00',
      '4525.00',
      '4525.00',
    ]);
  });
});
