// Payables in a real tenant database (docs/wave3-plan.md step 4), every figure worked by hand: a supplier's bill matched
// to an order and its receipt; one held (quantity and rate) and passed; a contractor's bills under 194C (the single-bill
// limit, then the year's, with catch-up); rent under 194I without an order; a debit note; a payment run over the
// approval limit, its bank file, paid; an advance applied; what is owed aged from the due dates.
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

describe.skipIf(!controlUrl || !adminUrl)('payables (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-pay-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'pay-admin@example.in');
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

  interface Bill {
    id: string;
    status: string;
    heldReasons: string[];
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    total: string;
    tds: string;
    tdsBase: string;
    payable: string;
    outstanding: string;
    voucher: { id: string; number: string } | null;
  }
  let entityId: string;
  let projectId: string;
  let site: string;
  let vidarbha: string;
  let ramesh: string;
  let patil: string;
  let hdfc: string;
  let po: { id: string; key: string };
  let wo: { id: string; key: string };
  const bills: Record<string, string> = {};
  const vbill = (body: object, as: Record<string, string> = manager) =>
    post(
      '/tenant/accounts/vendor-bills',
      { entityId, projectId: null, tdsSection: null, ...body },
      as,
    );
  const figures = (b: Bill) => [
    b.status,
    b.taxable,
    b.cgst,
    b.sgst,
    b.igst,
    b.total,
    b.tds,
    b.payable,
  ];
  const order = async (kind: 'purchase' | 'work', partyId: string, line: object) => {
    const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        { kind, partyId, siteId: site, lines: [line] },
        manager,
      ),
    );
    const issued = await ok<{ id: string; inForce: { lines: { lineKey: string }[] } }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    return { id: issued.id, key: issued.inForce.lines[0]!.lineKey };
  };

  it('matches bills to the order and receipt; holds one that does not match, and passes it', async () => {
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
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    const party = async (body: object) =>
      (
        await ok<{ id: string }>(
          post('/tenant/parties', { isClient: false, isVendor: true, ...body }),
        )
      ).id;
    vidarbha = await party({ name: 'Vidarbha Cement Traders', gstin: '27AAACV1234F1Z5' });
    ramesh = await party({ name: 'Ramesh Shinde', pan: 'ABCPS1234K', tdsSection: '194C' });
    patil = await party({ name: 'Patil Estates', gstin: '27AAAFP5678Q1Z1', tdsSection: '194I' });
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
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

    // 100 bags at ₹390 + 28% ordered; 60 accepted on receipt.
    po = await order('purchase', vidarbha, {
      description: 'Cement OPC 53',
      unit: 'bag',
      qty: '100',
      rate: '390',
      gstPct: '28',
    });
    await ok(
      post(
        `/tenant/orders/${po.id}/receipts`,
        { receivedOn: '2026-08-02', challanNo: 'DC-1', lines: [{ lineKey: po.key, qty: '60' }] },
        manager,
      ),
    );

    // V/101: the 60 bags. 23,400 + CGST and SGST 14% (3,276 each) = 29,952. Matched: posted at once.
    const v101 = await ok<Bill>(
      vbill({
        partyId: vidarbha,
        orderId: po.id,
        billNo: 'V/101',
        billDate: '2026-08-05',
        dueDate: '2026-09-04',
        lines: [{ lineKey: po.key, qty: '60', rate: '390' }],
      }),
    );
    expect(figures(v101)).toEqual([
      'posted',
      '23400.00',
      '3276.00',
      '3276.00',
      '0.00',
      '29952.00',
      '0.00',
      '29952.00',
    ]);
    bills.v101 = v101.id;
    const v = await ok<{
      type: string;
      lines: { account: { name: string }; debit: string; credit: string }[];
    }>(get(`/tenant/accounts/vouchers/${v101.voucher!.id}`, manager));
    expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['Material consumption', '23400.00', '0.00'],
      ['Input CGST', '3276.00', '0.00'],
      ['Input SGST', '3276.00', '0.00'],
      ['Vidarbha Cement Traders', '0.00', '29952.00'],
    ]);
    expect(
      (
        await vbill({
          partyId: vidarbha,
          orderId: po.id,
          billNo: 'v/101',
          billDate: '2026-08-05',
          dueDate: '2026-09-04',
          lines: [{ lineKey: po.key, qty: '1', rate: '390' }],
        })
      ).json(),
    ).toMatchObject({ code: 'bill_exists' });
    expect(
      (
        await vbill(
          {
            partyId: vidarbha,
            orderId: po.id,
            billNo: 'V/9',
            billDate: '2026-08-05',
            dueDate: '2026-09-04',
            lines: [{ lineKey: po.key, qty: '1', rate: '390' }],
          },
          worker,
        )
      ).statusCode,
    ).toBe(403);

    // V/102: 30 more bags at ₹395 — none are received unbilled, and the rate is above the order's: held for both.
    let v102 = await ok<Bill & { mayPass: boolean }>(
      vbill({
        partyId: vidarbha,
        orderId: po.id,
        billNo: 'V/102',
        billDate: '2026-08-05',
        dueDate: '2026-09-04',
        lines: [{ lineKey: po.key, qty: '30', rate: '395' }],
      }),
    );
    expect(v102).toMatchObject({ status: 'held', voucher: null, mayPass: true });
    expect(v102.heldReasons).toEqual([
      'Cement OPC 53: 30 bag billed, accepted on receipt and not yet billed 0.',
      'Cement OPC 53: billed at ₹395, ordered at ₹390.',
    ]);
    // Passed: 11,850 + 1,659 + 1,659 = 15,168.
    v102 = await ok(
      post(
        `/tenant/accounts/vendor-bills/${v102.id}/pass`,
        { reason: 'Rate agreed on the phone; the challan is to come' },
        manager,
      ),
    );
    expect(figures(v102)).toEqual([
      'posted',
      '11850.00',
      '1659.00',
      '1659.00',
      '0.00',
      '15168.00',
      '0.00',
      '15168.00',
    ]);
    bills.v102 = v102.id;
  });

  it('deducts 194C on a contractor once a bill or the year passes its limit, and 194I on rent', async () => {
    // Shuttering labour, 1,000 sqm at ₹120, from an unregistered individual (1%).
    wo = await order('work', ramesh, {
      description: 'Shuttering labour',
      unit: 'sqm',
      qty: '1000',
      rate: '120',
      gstPct: '18',
    });
    const sb = (no: string, billDate: string, dueDate: string, qty: string) =>
      ok<Bill>(
        vbill({
          partyId: ramesh,
          orderId: wo.id,
          billNo: no,
          billDate,
          dueDate,
          lines: [{ lineKey: wo.key, qty, rate: '120' }],
        }),
      );
    // S/1 24,000: under ₹30,000 and the year under ₹1 lakh: no TDS, no GST (unregistered).
    const s1 = await sb('S/1', '2026-07-10', '2026-08-09', '200');
    expect(figures(s1)).toEqual([
      'posted',
      '24000.00',
      '0.00',
      '0.00',
      '0.00',
      '24000.00',
      '0.00',
      '24000.00',
    ]);
    // S/2 36,000: over ₹30,000 on its own: 1% = ₹360.
    const s2 = await sb('S/2', '2026-08-10', '2026-09-09', '300');
    expect([s2.tdsBase, s2.tds, s2.payable]).toEqual(['36000.00', '360.00', '35640.00']);
    // S/3 48,000: the year reaches 1,08,000, over ₹1 lakh: TDS on all of it not yet taxed, 1,08,000 − 36,000 = 72,000: ₹720.
    const s3 = await sb('S/3', '2026-09-10', '2026-10-10', '400');
    expect([s3.tdsBase, s3.tds, s3.payable]).toEqual(['72000.00', '720.00', '47280.00']);
    const v = await ok<{ lines: { account: { name: string }; debit: string; credit: string }[] }>(
      get(`/tenant/accounts/vouchers/${s3.voucher!.id}`, manager),
    );
    expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['Subcontract cost', '48000.00', '0.00'],
      ['Ramesh Shinde', '0.00', '47280.00'],
      ['TDS payable 194C', '0.00', '720.00'],
    ]);
    // S/4: 200 more would make 1,100 of the 1,000 ordered: held.
    const s4 = await sb('S/4', '2026-09-12', '2026-10-12', '200');
    expect(s4.heldReasons).toEqual([
      'Shuttering labour: 200 sqm billed, ordered and not yet billed 100.',
    ]);
    await ok(
      post(
        `/tenant/accounts/vendor-bills/${s4.id}/cancel`,
        { date: '2026-09-12', reason: 'Billed twice' },
        manager,
      ),
    );
    Object.assign(bills, { s1: s1.id, s2: s2.id, s3: s3.id });

    // Rent of the site office for the quarter, ₹2,50,000 + 18%, without an order: over ₹2,40,000 in the year under 194I
    // at 10% (a firm): ₹25,000. 2,50,000 + 22,500 + 22,500 = 2,95,000; payable 2,70,000.
    const rent = (
      await ok<{ accounts: { id: string; code: string }[] }>(get('/tenant/accounts/chart', manager))
    ).accounts.find((a) => a.code === 'X7002')!.id;
    const r = await ok<Bill>(
      vbill({
        partyId: patil,
        billNo: 'PE/Q2',
        billDate: '2026-09-01',
        dueDate: '2026-10-01',
        lines: [
          {
            accountId: rent,
            description: 'Site office rent, July to September',
            qty: '1',
            rate: '250000',
            gstPct: '18',
          },
        ],
      }),
    );
    expect(figures(r)).toEqual([
      'posted',
      '250000.00',
      '22500.00',
      '22500.00',
      '0.00',
      '295000.00',
      '25000.00',
      '270000.00',
    ]);
    bills.rent = r.id;
  });

  it('takes a debit note, pays a run after approval with its bank file, and applies an advance', async () => {
    // 5 bags back: 1,950 + 273 + 273 = ₹2,496 off V/101 (29,952 → 27,456).
    const dn = await ok<Bill & { debitNotes: { total: string }[] }>(
      post(
        `/tenant/accounts/vendor-bills/${bills.v101}/debit-notes`,
        { date: '2026-08-20', reason: '5 bags returned, set hard', taxable: '1950', gstPct: '28' },
        manager,
      ),
    );
    expect([dn.debitNotes[0]!.total, dn.outstanding]).toEqual(['2496.00', '27456.00']);

    // A run on 20 September: V/101 in full, S/2 in full, ₹10,000 advance to Ramesh for the project. ₹73,096 is over the
    // ₹50,000 rule: it waits for a manager other than the one who made it (the admin).
    await ok(
      post('/tenant/approval-rules/payment_run', {
        rules: [{ minAmount: '50000', approver: 'manager' }],
      }),
    );
    expect(
      (
        await post(
          '/tenant/accounts/payment-runs',
          {
            entityId,
            bankAccountId: hdfc,
            payOn: '2026-09-20',
            lines: [{ partyId: vidarbha, kind: 'bill', billId: bills.v101, amount: '30000' }],
          },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'over_outstanding' });
    let run = await ok<{
      id: string;
      number: string;
      total: string;
      status: string;
      approval: { id: string } | null;
    }>(
      post(
        '/tenant/accounts/payment-runs',
        {
          entityId,
          bankAccountId: hdfc,
          payOn: '2026-09-20',
          lines: [
            { partyId: vidarbha, kind: 'bill', billId: bills.v101, amount: '27456' },
            { partyId: ramesh, kind: 'bill', billId: bills.s2, amount: '35640' },
            { partyId: ramesh, kind: 'advance', projectId, amount: '10000' },
          ],
        },
        manager,
      ),
    );
    expect(run).toMatchObject({ number: 'PR/2026-27/0001', total: '73096.00', status: 'draft' });
    run = await ok(post(`/tenant/accounts/payment-runs/${run.id}/submit`, {}, manager));
    expect(run.status).toBe('pending');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/tenant/accounts/payment-runs/${run.id}/bank-file`,
          headers: manager,
        })
      ).json(),
    ).toMatchObject({ code: 'not_approved' });
    await ok(post(`/tenant/approvals/${run.approval!.id}/approve`, {}));
    // The bank file needs every supplier's account.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/tenant/accounts/payment-runs/${run.id}/bank-file`,
          headers: manager,
        })
      ).json(),
    ).toMatchObject({
      code: 'bank_details_missing',
      message: 'Add the bank account of Vidarbha Cement Traders, Ramesh Shinde.',
    });
    for (const [id, no, ifsc] of [
      [vidarbha, '50200012345678', 'HDFC0000123'],
      [ramesh, '30112233445', 'SBIN0001234'],
    ] as const) {
      const p = await ok<{ rowVersion: number }[]>(get('/tenant/parties'));
      const row = (p as unknown as { id: string; rowVersion: number }[]).find((x) => x.id === id)!;
      await ok(
        post(`/tenant/parties/${id}`, {
          bankAccountNo: no,
          bankIfsc: ifsc,
          rowVersion: row.rowVersion,
        }),
      );
    }
    const file = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/payment-runs/${run.id}/bank-file`,
      headers: manager,
    });
    expect(file.body).toBe(
      'Beneficiary name,Account number,IFSC,Amount,Payment date,Reference\r\n' +
        'Vidarbha Cement Traders,50200012345678,HDFC0000123,27456.00,2026-09-20,PR/2026-27/0001\r\n' +
        'Ramesh Shinde,30112233445,SBIN0001234,45640.00,2026-09-20,PR/2026-27/0001\r\n',
    );
    // Paid on the 21st: a payment voucher for each supplier.
    const paid = await ok<{ status: string; lines: { voucher: { number: string } }[] }>(
      post(`/tenant/accounts/payment-runs/${run.id}/paid`, { paidOn: '2026-09-21' }, manager),
    );
    expect(paid.status).toBe('paid');
    expect([...new Set(paid.lines.map((l) => l.voucher.number))]).toEqual([
      'PV/2026-27/0001',
      'PV/2026-27/0002',
    ]);
    expect(
      (await ok<Bill>(get(`/tenant/accounts/vendor-bills/${bills.v101}`, manager))).outstanding,
    ).toBe('0.00');

    // The advance goes against S/3 (47,280 → 37,280); there is nothing left for more.
    const s3 = await ok<Bill>(
      post(
        `/tenant/accounts/vendor-bills/${bills.s3}/apply-advance`,
        { date: '2026-09-25', amount: '10000' },
        manager,
      ),
    );
    expect(s3.outstanding).toBe('37280.00');
    expect(
      (
        await post(
          `/tenant/accounts/vendor-bills/${bills.s3}/apply-advance`,
          { date: '2026-09-25', amount: '1' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'over_advance' });
    // A paid bill is not cancelled.
    expect(
      (
        await post(
          `/tenant/accounts/vendor-bills/${bills.v101}/cancel`,
          { date: '2026-09-25', reason: 'wrong' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'bill_in_use' });
  });

  it('ages what is owed from the due dates', async () => {
    // As at 30 September: V/102 15,168 (26 days overdue); S/1 24,000 (52 days); S/3 37,280 (not due); the rent 2,70,000
    // (not due). ₹3,46,448.
    const r = await ok<{
      suppliers: {
        party: { name: string };
        buckets: string[];
        outstanding: string;
        advance: string;
      }[];
      bills: { billNo: string; outstanding: string; overdueDays: number; bucket: string }[];
      total: string;
    }>(get(`/tenant/accounts/payables?entityId=${entityId}&asOf=2026-09-30`, manager));
    expect(r.bills.map((b) => [b.billNo, b.outstanding, b.overdueDays, b.bucket])).toEqual([
      ['PE/Q2', '270000.00', 0, 'not due'],
      ['S/1', '24000.00', 52, '31-60'],
      ['S/3', '37280.00', 0, 'not due'],
      ['V/102', '15168.00', 26, '1-30'],
    ]);
    expect(r.suppliers.map((s) => [s.party.name, s.outstanding, s.buckets.join(' ')])).toEqual([
      ['Patil Estates', '270000.00', '270000.00 0.00 0.00 0.00 0.00'],
      ['Ramesh Shinde', '61280.00', '37280.00 0.00 24000.00 0.00 0.00'],
      ['Vidarbha Cement Traders', '15168.00', '0.00 15168.00 0.00 0.00 0.00'],
    ]);
    expect(r.total).toBe('346448.00');
    // The supplier's ledger agrees: Vidarbha 29,952 + 15,168 − 2,496 − 27,456 = 15,168 Cr.
    const tb = await ok<{ rows: { name: string; credit: string | null }[] }>(
      get(`/tenant/accounts/trial-balance?entityId=${entityId}&asOf=2026-09-30`, manager),
    );
    expect(tb.rows.find((x) => x.name === 'Vidarbha Cement Traders')?.credit).toBe('15168.00');
    expect(tb.rows.find((x) => x.name === 'TDS payable 194C')?.credit).toBe('1080.00');
  });
});
