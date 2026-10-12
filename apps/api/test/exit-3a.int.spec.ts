// The exit check for Wave 3a (docs/wave3-plan.md step 8b), in a real tenant database: a project billed to a client,
// certified and paid with TDS; a supplier's bill and a subcontract bill paid in one run; the GST registers and GSTR-1,
// the TDS challan and 26Q; the bank statement matched and reconciled; the trial balance, P&L and balance sheet
// agreeing; the books exported to Tally as well-formed XML with every voucher, and refused when Tally keeps them.
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

describe.skipIf(!controlUrl || !adminUrl)('Wave 3a exit check (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-exit-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'exit-admin@example.in');
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

  /** Every tag opened is closed, in order; the amounts of each voucher add up to nothing. */
  function wellFormed(xml: string) {
    const stack: string[] = [];
    for (const m of xml
      .replace(/<\?xml[^>]*\?>/, '')
      .matchAll(/<(\/?)([A-Z.:a-z]+)[^>]*?(\/?)>/g)) {
      if (m[3]) continue;
      if (m[1]) {
        if (stack.pop() !== m[2]) return false;
      } else stack.push(m[2]!);
    }
    return stack.length === 0;
  }

  it('bills, pays, files, reconciles, states and exports a project', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    const entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Akola Infra Pvt Ltd',
        gstin: '27AAACA1234K1Z2',
        tan: 'NGPA12345B',
        address: 'Plot 12, MIDC',
        city: 'Akola',
        pincode: '444001',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const code = (c: string) => chart.accounts.find((a) => a.code === c)!.id;
    const bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: code('A40'),
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
    const vidarbha = await party({
      name: 'Vidarbha Cement',
      isClient: false,
      isVendor: true,
      gstin: '27AAACV1234F1Z5',
    });
    const kale = await party({
      name: 'Kale Constructions',
      isClient: false,
      isSubcontractor: true,
      gstin: '27ABCPK1234L1Z5',
      pan: 'ABCPK1234L',
    });

    // 1. The project, its contract BOQ (100 cum at ₹1,000), 50 measured; RA 1 certified on 5 August: 50,000 + 9% + 9%
    // = ₹59,000.
    const projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Akola', clientId: zp }, manager),
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
              qty: '100',
              rate: '1000',
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
    await ok(
      post(
        `/tenant/boqs/${boqId}/lines/${node}/progress`,
        { measuredOn: '2026-07-20', qty: '50' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/bill-terms`,
        { rowVersion: null, gstPct: '18', retentionPct: '0' },
        manager,
      ),
    );
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

    // 2. Paid on 20 August: ₹58,000 into the bank and ₹1,000 TDS.
    await ok(
      post(
        '/tenant/accounts/client-receipts',
        {
          entityId,
          partyId: zp,
          bankAccountId: bank,
          receivedOn: '2026-08-20',
          amount: '58000',
          tds: '1000',
          reference: 'UTR4411',
          allocations: [{ kind: 'bill', billId: ra.id, amount: '59000' }],
        },
        manager,
      ),
    );

    // 3. Cement: ₹20,000 + 9% + 9% = ₹23,600. The subcontractor: 100 cum at ₹400 = ₹40,000 + 18% = ₹47,200, TDS 1%
    // (₹400) on a bill over ₹30,000: ₹46,800.
    const v = await ok<{ id: string }>(
      post(
        '/tenant/accounts/vendor-bills',
        {
          entityId,
          partyId: vidarbha,
          orderId: null,
          projectId,
          billNo: 'VC/88',
          billDate: '2026-08-08',
          dueDate: '2026-09-07',
          tdsSection: null,
          lines: [
            {
              accountId: code('X1001'),
              projectId,
              description: 'Cement',
              qty: '1',
              rate: '20000',
              gstPct: '18',
            },
          ],
        },
        manager,
      ),
    );
    const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'work',
          partyId: kale,
          siteId: site,
          lines: [{ description: 'Formwork', unit: 'sqm', qty: '200', rate: '400', gstPct: '18' }],
        },
        manager,
      ),
    );
    const wo = await ok<{ id: string; inForce: { lines: { lineKey: string }[] } }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/work-orders/${wo.id}/measurements`,
        { lineKey: wo.inForce.lines[0]!.lineKey, measuredOn: '2026-08-10', qty: '100' },
        manager,
      ),
    );
    await ok(
      app.inject({
        method: 'PUT',
        url: `/api/tenant/work-orders/${wo.id}/subcontract-terms`,
        headers: manager,
        payload: {
          retentionPct: '0',
          advanceRecoveryPct: '0',
          labourCessPct: '0',
          tdsSection: '194C',
        },
      }),
    );
    const scb = await ok<{ id: string; rowVersion: number }>(
      post(`/tenant/work-orders/${wo.id}/subcontract-bills`, { upto: '2026-08-31' }, manager),
    );
    const certified = await ok<{
      status: string;
      certified: { net: string; tds: string };
      vendorBill: { id: string };
    }>(post(`/tenant/subcontract-bills/${scb.id}/submit`, { rowVersion: scb.rowVersion }, manager));
    expect([certified.status, certified.certified.tds, certified.certified.net]).toEqual([
      'certified',
      '400.00',
      '46800.00',
    ]);

    // 4. Both paid in one run on 5 September: ₹70,400.
    const run = await ok<{ id: string; total: string }>(
      post(
        '/tenant/accounts/payment-runs',
        {
          entityId,
          bankAccountId: bank,
          payOn: '2026-09-05',
          lines: [
            { partyId: vidarbha, kind: 'bill', billId: v.id, amount: '23600' },
            { partyId: kale, kind: 'bill', billId: certified.vendorBill.id, amount: '46800' },
          ],
        },
        manager,
      ),
    );
    expect(run.total).toBe('70400.00');
    await ok(post(`/tenant/accounts/payment-runs/${run.id}/submit`, {}, manager));
    await ok(
      post(`/tenant/accounts/payment-runs/${run.id}/paid`, { paidOn: '2026-09-05' }, manager),
    );

    // 5. GST for August: the invoice in GSTR-1's B2B; input tax ₹3,600 + ₹7,200. TDS: August's ₹400 deposited.
    const g1 = await ok<{ b2b: { number: string; value: string }[] }>(
      get(`/tenant/accounts/gst/gstr1?entityId=${entityId}&period=2026-08`, manager),
    );
    expect(g1.b2b.map((b) => [b.number, b.value])).toEqual([['INV/2026-27/0001', '59000.00']]);
    const g3 = await ok<{
      outward: { taxable: string; cgst: string };
      itcNet: { cgst: string; sgst: string };
    }>(get(`/tenant/accounts/gst/gstr3b?entityId=${entityId}&period=2026-08`, manager));
    expect([g3.outward.taxable, g3.outward.cgst, g3.itcNet.cgst, g3.itcNet.sgst]).toEqual([
      '50000.00',
      '4500.00',
      '5400.00',
      '5400.00',
    ]);
    await ok(
      post(
        '/tenant/accounts/tds/challans',
        {
          entityId,
          section: '194C',
          period: '2026-08',
          depositedOn: '2026-09-07',
          bsrCode: '0510308',
          challanNo: '00021',
          bankAccountId: bank,
        },
        manager,
      ),
    );
    const q26 = await ok<{ problems: string[]; total: string }>(
      get(`/tenant/accounts/tds/26q?entityId=${entityId}&quarter=2026-27-Q2`, manager),
    );
    expect([q26.problems, q26.total]).toEqual([[], '400.00']);

    // 6. The bank: the statement's five lines matched (the charges posted in one click); reconciled at −₹12,859.
    await ok(
      app.inject({
        method: 'PUT',
        url: `/api/tenant/accounts/bank/${bank}/mapping`,
        headers: manager,
        payload: {
          date: 'Date',
          narration: 'Narration',
          reference: 'Ref',
          amount: 'Amount',
          balance: 'Balance',
          dateFormat: 'DD/MM/YYYY',
        },
      }),
    );
    const csv =
      'Date,Narration,Ref,Amount,Balance\n' +
      '20/08/2026,NEFT ZP AKOLA UTR4411,UTR4411,58000,58000\n' +
      '05/09/2026,NEFT VIDARBHA CEMENT,,-23600,34400\n' +
      '05/09/2026,NEFT KALE CONSTRUCTIONS,,-46800,-12400\n' +
      '07/09/2026,TDS CHALLAN 00021,00021,-400,-12800\n' +
      '30/09/2026,SMS CHARGES,,-59,-12859\n';
    const boundary = '----exit' + Math.random().toString(16).slice(2);
    await ok(
      app.inject({
        method: 'POST',
        url: `/api/tenant/accounts/bank/${bank}/statements`,
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sbi.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
        ),
        headers: { ...manager, 'content-type': `multipart/form-data; boundary=${boundary}` },
      }),
    );
    const st = await ok<{
      lines: {
        id: string;
        narration: string;
        suggestions: { voucherId: string; position: number }[];
      }[];
    }>(
      get(
        `/tenant/accounts/bank/${bank}/statement?entityId=${entityId}&from=2026-08-01&to=2026-09-30`,
        manager,
      ),
    );
    for (const l of st.lines) {
      if (l.narration === 'SMS CHARGES')
        await ok(
          post(
            `/tenant/accounts/bank-lines/${l.id}/post`,
            { entityId, accountId: code('X5002'), narration: 'SMS charges' },
            manager,
          ),
        );
      else {
        expect(l.suggestions.length).toBeGreaterThan(0);
        const s = l.suggestions[0]!;
        await ok(
          post(
            `/tenant/accounts/bank-lines/${l.id}/match`,
            { entityId, lines: [{ voucherId: s.voucherId, position: s.position }] },
            manager,
          ),
        );
      }
    }
    const rec = await ok<{ books: string; perBank: string; difference: string }>(
      get(
        `/tenant/accounts/bank/${bank}/reconciliation?entityId=${entityId}&asOf=2026-09-30`,
        manager,
      ),
    );
    expect(rec).toMatchObject({ books: '-12859.00', perBank: '-12859.00', difference: '0.00' });

    // 7. The trial balance balances; the P&L (50,000 − 20,000 − 40,000 − 59 = −10,059) and the balance sheet agree.
    const tb = await ok<{ debit: string; credit: string }>(
      get(`/tenant/accounts/trial-balance?entityId=${entityId}&asOf=2026-09-30`, manager),
    );
    expect(tb.debit).toBe(tb.credit);
    const pl = await ok<{ profit: string }>(
      get(
        `/tenant/accounts/statements/profit-and-loss?entityId=${entityId}&from=2026-04-01&to=2026-09-30`,
        manager,
      ),
    );
    expect(pl.profit).toBe('-10059.00');
    const bs = await ok<{ balanced: boolean; profitNotClosed: string }>(
      get(
        `/tenant/accounts/statements/balance-sheet?entityId=${entityId}&asOf=2026-09-30`,
        manager,
      ),
    );
    expect([bs.balanced, bs.profitNotClosed]).toEqual([true, '-10059.00']);
    const pp = await ok<{
      projects: { revenue: string; costs: string; invoiced: string; received: string }[];
    }>(
      get(
        `/tenant/accounts/statements/projects?entityId=${entityId}&from=2026-04-01&to=2026-09-30`,
        manager,
      ),
    );
    expect(pp.projects.map((p) => [p.revenue, p.costs, p.invoiced, p.received])).toEqual([
      ['50000.00', '60000.00', '59000.00', '59000.00'],
    ]);

    // 8. Tally: refused until the mode includes it; then masters and every voucher, well formed and balanced.
    const xml = (path: string) =>
      app.inject({ method: 'GET', url: `/api/tenant/accounts/tally/${path}`, headers: manager });
    expect(
      (await xml(`vouchers?entityId=${entityId}&from=2026-04-01&to=2026-09-30`)).json(),
    ).toMatchObject({
      code: 'export_off',
    });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/tenant/accounts/mode',
          headers: manager,
          payload: { mode: 'native_tally' },
        })
      ).statusCode,
    ).toBe(403);
    await ok(
      app.inject({
        method: 'PUT',
        url: '/api/tenant/accounts/mode',
        headers: t.admin,
        payload: { mode: 'native_tally' },
      }),
    );
    const masters = (await xml(`masters?entityId=${entityId}&from=2026-04-01`)).body;
    expect(wellFormed(masters)).toBe(true);
    expect(masters).toContain('<LEDGER NAME="Kale Constructions" ACTION="Create">');
    expect(masters).toContain('<PARTYGSTIN>27ABCPK1234L1Z5</PARTYGSTIN>');
    expect(masters).toContain('<PARENT>Bank Accounts</PARENT>');
    const vouchers = (await xml(`vouchers?entityId=${entityId}&from=2026-04-01&to=2026-09-30`))
      .body;
    expect(wellFormed(vouchers)).toBe(true);
    const list = await ok<{ vouchers: unknown[] }>(
      get(`/tenant/accounts/vouchers?entityId=${entityId}&from=2026-04-01&to=2026-09-30`, manager),
    );
    const blocks = vouchers.split('<VOUCHER ').slice(1);
    expect(blocks.length).toBe(list.vouchers.length);
    expect(blocks.length).toBe(8);
    for (const b of blocks)
      expect(
        [...b.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].reduce(
          (s, m) => s + Math.round(Number(m[1]) * 100),
          0,
        ),
      ).toBe(0);
    expect(vouchers).toContain('<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>');
    const asWorker = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/tally/masters?entityId=${entityId}&from=2026-04-01`,
      headers: worker,
    });
    expect(asWorker.statusCode).toBe(403);

    // 9. With Tally keeping the books, a typed voucher is refused; bills still post.
    await ok(
      app.inject({
        method: 'PUT',
        url: '/api/tenant/accounts/mode',
        headers: t.admin,
        payload: { mode: 'tally' },
      }),
    );
    expect(
      (
        await post(
          '/tenant/accounts/vouchers',
          {
            entityId,
            type: 'payment',
            date: '2026-09-30',
            lines: [
              { accountId: code('X5002'), debit: '10', credit: '0' },
              { accountId: bank, debit: '0', credit: '10' },
            ],
          },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'tally_mode' });
  });
});
