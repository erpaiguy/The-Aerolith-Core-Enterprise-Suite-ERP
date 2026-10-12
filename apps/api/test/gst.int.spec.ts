// GST in a real tenant database (docs/wave3-plan.md step 6a), every figure by hand: four tax invoices (in the state,
// another state, two to unregistered clients, one over the B2CL limit) and a credit note; the outward register and the
// GSTR-1 sheets; purchases with input tax blocked by ledger and a debit note; GSTR-3B; the e-invoice JSON and its IRN;
// a GSTR-2B file matched against the purchase book.
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
import ExcelJS from 'exceljs';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('GST (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-gst-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'gst-admin@example.in');
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
  const vbill = (body: object) =>
    post(
      '/tenant/accounts/vendor-bills',
      { entityId, orderId: null, tdsSection: null, ...body },
      manager,
    );
  const party = async (body: object) =>
    (await ok<{ id: string }>(post('/tenant/parties', body))).id;

  /** A project for the client with a site in the state, one BOQ item measured, GST 18%; certified on the date. */
  async function invoice(
    clientId: string,
    name: string,
    state: string,
    qty: string,
    rate: string,
    on: string,
  ) {
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name, clientId }, manager))
    ).id;
    await ok(post(`/tenant/projects/${projectId}/sites`, { name, stateCode: state }, manager));
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
              description: 'Work done',
              unit: 'cum',
              qty: '1000',
              rate,
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
        { measuredOn: '2026-07-25', qty },
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
    const b = await ok<{ id: string; rowVersion: number }>(
      post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-07-31' }, manager),
    );
    const s = await ok<{ rowVersion: number }>(
      post(`/tenant/client-bills/${b.id}/submit`, { rowVersion: b.rowVersion }, manager),
    );
    await ok(
      post(
        `/tenant/client-bills/${b.id}/certify`,
        { rowVersion: s.rowVersion, certifiedOn: on },
        manager,
      ),
    );
    return { projectId, billId: b.id };
  }

  let alpha: string;
  let inv1: { projectId: string; billId: string };
  let inv2: { projectId: string; billId: string };
  let inv3: { projectId: string; billId: string };
  let cn1: string;

  it('raises a credit note and keeps the outward register and GSTR-1', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Akola Infra Pvt Ltd',
        gstin: '27AAACA1234K1Z2',
        address: 'Plot 12, MIDC Phase 2',
        city: 'Akola',
        pincode: '444001',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    alpha = await party({
      name: 'Pune Metro',
      legalName: 'Maharashtra Metro Rail Corporation Ltd',
      gstin: '27AAACP1111A1Z5',
      address: 'Metro Bhavan',
      city: 'Pune',
      pincode: '411005',
    });
    const beta = await party({ name: 'Bengaluru Housing Board', gstin: '29AAACB2222B1Z3' });
    const gamma = await party({ name: 'Shri Patil' });
    const delta = await party({ name: 'Goa Resorts' });
    // 35,000 + 9% + 9% = 41,300 (Maharashtra); 1,00,000 + 18% IGST = 1,18,000 (Karnataka); 10,000 + 900 + 900 =
    // 11,800 to an unregistered client in the state; 1,20,000 + 21,600 IGST = 1,41,600 to one in Goa (B2CL: over
    // ₹1 lakh).
    inv1 = await invoice(alpha, 'Metro depot, Pune', '27', '100', '350', '2026-08-05');
    inv2 = await invoice(beta, 'Housing, Bengaluru', '29', '200', '500', '2026-08-10');
    inv3 = await invoice(gamma, 'Bungalow, Akola', '27', '10', '1000', '2026-08-12');
    await invoice(delta, 'Resort, Goa', '30', '120', '1000', '2026-08-14');

    // A credit note of ₹5,000 + 9% + 9% against INV 1: ₹5,900. More than is outstanding is refused.
    const credit = (taxable: string, as = manager) =>
      post(
        `/tenant/client-bills/${inv1.billId}/credit-notes`,
        { date: '2026-08-20', reason: 'Rate revised', taxable },
        as,
      );
    expect((await credit('5000', worker)).statusCode).toBe(403);
    expect((await credit('40000')).json()).toMatchObject({ code: 'over_outstanding' });
    const cn = await ok<{
      id: string;
      number: string;
      total: string;
      cgst: string;
      voucherId: string;
    }>(credit('5000'));
    cn1 = cn.id;
    expect([cn.number, cn.cgst, cn.total]).toEqual(['CN/2026-27/0001', '450.00', '5900.00']);
    const v = await ok<{ lines: { account: { name: string }; debit: string; credit: string }[] }>(
      get(`/tenant/accounts/vouchers/${cn.voucherId}`, manager),
    );
    expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['Contract revenue', '5000.00', '0.00'],
      ['Output CGST', '450.00', '0.00'],
      ['Output SGST', '450.00', '0.00'],
      ['Pune Metro', '0.00', '5900.00'],
    ]);
    // What the client owes on INV 1 falls by the credit note.
    const open = await ok<{ bills: { outstanding: string }[] }>(
      get(`/tenant/accounts/open-items?entityId=${entityId}&partyId=${alpha}`, manager),
    );
    expect(open.bills[0]!.outstanding).toBe('35400.00');

    const r = await ok<{
      outward: { kind: string; number: string; gstin: string | null; pos: string; total: string }[];
      outwardTotals: Record<string, string>;
    }>(
      get(
        `/tenant/accounts/gst/registers?entityId=${entityId}&from=2026-08-01&to=2026-08-31`,
        manager,
      ),
    );
    expect(r.outward.map((o) => [o.number, o.pos, o.total])).toEqual([
      ['INV/2026-27/0001', '27', '41300.00'],
      ['INV/2026-27/0002', '29', '118000.00'],
      ['INV/2026-27/0003', '27', '11800.00'],
      ['INV/2026-27/0004', '30', '141600.00'],
      ['CN/2026-27/0001', '27', '5900.00'],
    ]);
    expect(r.outwardTotals).toEqual({
      taxable: '260000.00',
      cgst: '3600.00',
      sgst: '3600.00',
      igst: '39600.00',
      total: '306800.00',
    });

    const g = await ok<{
      b2b: {
        gstin: string;
        number: string;
        date: string;
        value: string;
        pos: string;
        taxable: string;
      }[];
      b2cl: { number: string; pos: string; value: string }[];
      b2cs: { pos: string; rate: string; taxable: string }[];
      cdnr: { number: string; value: string; taxable: string; noteType: string }[];
      hsnB2b: { hsn: string; value: string; taxable: string; igst: string; cgst: string }[];
      hsnB2c: { hsn: string; value: string; taxable: string; igst: string; cgst: string }[];
      docs: { nature: string; from: string; to: string; total: number }[];
    }>(get(`/tenant/accounts/gst/gstr1?entityId=${entityId}&period=2026-08`, manager));
    expect(g.b2b.map((x) => [x.gstin, x.number, x.date, x.value, x.pos, x.taxable])).toEqual([
      [
        '27AAACP1111A1Z5',
        'INV/2026-27/0001',
        '05-Aug-26',
        '41300.00',
        '27-Maharashtra',
        '35000.00',
      ],
      [
        '29AAACB2222B1Z3',
        'INV/2026-27/0002',
        '10-Aug-26',
        '118000.00',
        '29-Karnataka',
        '100000.00',
      ],
    ]);
    expect(g.b2cl.map((x) => [x.number, x.pos, x.value])).toEqual([
      ['INV/2026-27/0004', '30-Goa', '141600.00'],
    ]);
    expect(g.b2cs.map((x) => [x.pos, x.rate, x.taxable])).toEqual([
      ['27-Maharashtra', '18', '10000.00'],
    ]);
    expect(g.cdnr.map((x) => [x.number, x.noteType, x.value, x.taxable])).toEqual([
      ['CN/2026-27/0001', 'C', '5900.00', '5000.00'],
    ]);
    // HSN, registered: 41,300 + 1,18,000 − 5,900; unregistered: 11,800 + 1,41,600.
    expect(g.hsnB2b.map((x) => [x.hsn, x.value, x.taxable, x.igst, x.cgst])).toEqual([
      ['9954', '153400.00', '130000.00', '18000.00', '2700.00'],
    ]);
    expect(g.hsnB2c.map((x) => [x.hsn, x.value, x.taxable, x.igst, x.cgst])).toEqual([
      ['9954', '153400.00', '130000.00', '21600.00', '900.00'],
    ]);
    expect(g.docs).toEqual([
      {
        nature: 'Invoices for outward supply',
        from: 'INV/2026-27/0001',
        to: 'INV/2026-27/0004',
        total: 4,
        cancelled: 0,
      },
      {
        nature: 'Credit Note',
        from: 'CN/2026-27/0001',
        to: 'CN/2026-27/0001',
        total: 1,
        cancelled: 0,
      },
    ]);
    const xlsx = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/gst/gstr1?entityId=${entityId}&period=2026-08&format=xlsx`,
      headers: manager,
    });
    expect(xlsx.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'b2b',
      'b2cl',
      'b2cs',
      'cdnr',
      'hsn(b2b)',
      'hsn(b2c)',
      'docs',
    ]);
    expect(wb.getWorksheet('b2b')!.getRow(2).values).toEqual([
      undefined,
      '27AAACP1111A1Z5',
      'Maharashtra Metro Rail Corporation Ltd',
      'INV/2026-27/0001',
      '05-Aug-26',
      41300,
      '27-Maharashtra',
      'N',
      '',
      'Regular B2B',
      '',
      18,
      35000,
      0,
    ]);
  });

  it('blocks input tax by ledger and sums the inward register and GSTR-3B', async () => {
    const chart = await ok<{ accounts: { id: string; code: string; parentId: string | null }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const materials = chart.accounts.find((a) => a.code === 'X1001')!.id;
    const food = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.code === 'X7001')!.parentId,
          code: 'X7010',
          name: 'Staff food',
          itcBlocked: true,
        }),
      )
    ).accounts.find((a) => a.code === 'X7010')!.id;
    const vendor = (name: string, gstin: string) =>
      party({ name, isClient: false, isVendor: true, gstin });
    const vidarbha = await vendor('Vidarbha Cement Traders', '27AAACV1234F1Z5');
    const hotel = await vendor('Hotel Sai', '27AAAFH3333C1Z9');
    const steel = await vendor('Karnataka Steel', '29AAACK4444D1Z2');
    const line = (accountId: string, projectId: string | null, rate: string, gstPct: string) => ({
      accountId,
      projectId,
      description: 'Supply',
      qty: '1',
      rate,
      gstPct,
    });
    // 50,000 + 14% + 14% = 64,000; food 10,000 + 2.5% + 2.5% = 10,500, its ₹500 blocked; 1,00,000 + 18% IGST.
    const v201 = await ok<{ id: string }>(
      vbill({
        partyId: vidarbha,
        projectId: inv1.projectId,
        billNo: 'V/201',
        billDate: '2026-08-08',
        dueDate: '2026-09-07',
        lines: [line(materials, inv1.projectId, '50000', '28')],
      }),
    );
    const h45 = await ok<{ id: string; itcBlocked: string; voucher: { id: string } }>(
      vbill({
        partyId: hotel,
        billNo: 'H-45',
        billDate: '2026-08-16',
        dueDate: '2026-08-16',
        lines: [line(food, null, '10000', '5')],
      }),
    );
    expect(h45.itcBlocked).toBe('500.00');
    const hv = await ok<{ lines: { account: { name: string }; debit: string; credit: string }[] }>(
      get(`/tenant/accounts/vouchers/${h45.voucher.id}`, manager),
    );
    expect(hv.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['Staff food', '10500.00', '0.00'],
      ['Hotel Sai', '0.00', '10500.00'],
    ]);
    await ok(
      vbill({
        partyId: steel,
        projectId: inv2.projectId,
        billNo: 'KS/0099',
        billDate: '2026-08-18',
        dueDate: '2026-09-17',
        lines: [line(materials, inv2.projectId, '100000', '18')],
      }),
    );
    // A debit note on V/201: 2,000 + 280 + 280 = 2,560.
    await ok(
      post(
        `/tenant/accounts/vendor-bills/${v201.id}/debit-notes`,
        { date: '2026-08-25', reason: 'Short supply', taxable: '2000', gstPct: '28' },
        manager,
      ),
    );
    const r = await ok<{
      inward: { kind: string; billNo: string }[];
      inwardTotals: Record<string, string>;
    }>(
      get(
        `/tenant/accounts/gst/registers?entityId=${entityId}&from=2026-08-01&to=2026-08-31`,
        manager,
      ),
    );
    expect(r.inward.map((x) => [x.kind, x.billNo])).toEqual([
      ['bill', 'V/201'],
      ['bill', 'H-45'],
      ['bill', 'KS/0099'],
      ['debit_note', 'V/201'],
    ]);
    expect(r.inwardTotals).toEqual({
      taxable: '158000.00',
      cgst: '6970.00',
      sgst: '6970.00',
      igst: '18000.00',
      total: '189940.00',
      blocked: '500.00',
    });
    const b = await ok<Record<string, Record<string, string>>>(
      get(`/tenant/accounts/gst/gstr3b?entityId=${entityId}&period=2026-08`, manager),
    );
    expect(b.outward).toEqual({
      taxable: '260000.00',
      igst: '39600.00',
      cgst: '3600.00',
      sgst: '3600.00',
      cess: '0.00',
    });
    expect(b.itcAll).toEqual({ igst: '18000.00', cgst: '6970.00', sgst: '6970.00', cess: '0.00' });
    expect(b.itcBlocked).toEqual({ igst: '0.00', cgst: '250.00', sgst: '250.00', cess: '0.00' });
    expect(b.itcNet).toEqual({ igst: '18000.00', cgst: '6720.00', sgst: '6720.00', cess: '0.00' });
  });

  it('writes the e-invoice JSON and keeps the IRN it comes back with', async () => {
    const file = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/e-invoices/invoice/${inv1.billId}/json`,
      headers: manager,
    });
    expect(file.statusCode).toBe(200);
    expect(JSON.parse(file.body)).toEqual([
      {
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
        DocDtls: { Typ: 'INV', No: 'INV/2026-27/0001', Dt: '05/08/2026' },
        SellerDtls: {
          Gstin: '27AAACA1234K1Z2',
          LglNm: 'Akola Infra Pvt Ltd',
          Addr1: 'Plot 12, MIDC Phase 2',
          Loc: 'Akola',
          Pin: 444001,
          Stcd: '27',
        },
        BuyerDtls: {
          Gstin: '27AAACP1111A1Z5',
          LglNm: 'Maharashtra Metro Rail Corporation Ltd',
          Pos: '27',
          Addr1: 'Metro Bhavan',
          Loc: 'Pune',
          Pin: 411005,
          Stcd: '27',
        },
        ItemList: [
          {
            SlNo: '1',
            PrdDesc: 'Works contract: Metro depot, Pune, RA bill 1',
            IsServc: 'Y',
            HsnCd: '9954',
            UnitPrice: 35000,
            TotAmt: 35000,
            AssAmt: 35000,
            GstRt: 18,
            IgstAmt: 0,
            CgstAmt: 3150,
            SgstAmt: 3150,
            TotItemVal: 41300,
          },
        ],
        ValDtls: { AssVal: 35000, CgstVal: 3150, SgstVal: 3150, IgstVal: 0, TotInvVal: 41300 },
      },
    ]);
    const crn = await app.inject({
      method: 'GET',
      url: `/api/tenant/accounts/e-invoices/credit_note/${cn1}/json`,
      headers: manager,
    });
    expect((JSON.parse(crn.body) as object[])[0]).toMatchObject({
      DocDtls: { Typ: 'CRN', No: 'CN/2026-27/0001', Dt: '20/08/2026' },
      ValDtls: { AssVal: 5000, CgstVal: 450, SgstVal: 450, IgstVal: 0, TotInvVal: 5900 },
      RefDtls: { PrecDocDtls: [{ InvNo: 'INV/2026-27/0001', InvDt: '05/08/2026' }] },
    });
    // An unregistered client gets none; nor does a client without an address.
    expect(
      (await get(`/tenant/accounts/e-invoices/invoice/${inv3.billId}/json`, manager)).json(),
    ).toMatchObject({ code: 'e_invoice_details_missing' });
    expect(
      (await get(`/tenant/accounts/e-invoices/invoice/${inv2.billId}/json`, manager)).json(),
    ).toMatchObject({
      message: "Add the client's address, the client's city, the client's PIN code.",
    });
    const irn = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
    await ok(
      post(
        `/tenant/accounts/e-invoices/invoice/${inv1.billId}`,
        {
          irn,
          ackNo: '112610012345678',
          ackDate: '2026-08-05 14:30',
          signedQr: 'eyJhbGciOiJSUzI1NiJ9.signed',
        },
        manager,
      ),
    );
    const gst = await ok<{
      eInvoice: { irn: string; ackDate: string };
      creditNotes: { number: string }[];
    }>(get(`/tenant/client-bills/${inv1.billId}/gst`, manager));
    expect([gst.eInvoice.irn, gst.eInvoice.ackDate, gst.creditNotes.map((n) => n.number)]).toEqual([
      irn,
      '2026-08-05 14:30',
      ['CN/2026-27/0001'],
    ]);
  });

  it('matches the supplier-filed GSTR-2B against the purchase book', async () => {
    const twoB = {
      data: {
        gstin: '27AAACA1234K1Z2',
        rtnprd: '082026',
        docdata: {
          b2b: [
            {
              ctin: '27AAACV1234F1Z5',
              trdnm: 'Vidarbha Cement Traders',
              inv: [
                {
                  inum: 'V-201',
                  dt: '08-08-2026',
                  val: 64000,
                  txval: 50000,
                  igst: 0,
                  cgst: 7000,
                  sgst: 7000,
                  itcavl: 'Y',
                },
              ],
            },
            {
              ctin: '29AAACK4444D1Z2',
              trdnm: 'Karnataka Steel',
              inv: [
                {
                  inum: 'KS/0099',
                  dt: '18-08-2026',
                  val: 118100,
                  txval: 100000,
                  igst: 18100,
                  cgst: 0,
                  sgst: 0,
                },
              ],
            },
            {
              ctin: '27AAAFX5555E1Z1',
              trdnm: 'Xpress Transport',
              inv: [
                { inum: 'XT-7', dt: '20-08-2026', val: 5900, txval: 5000, cgst: 450, sgst: 450 },
              ],
            },
          ],
        },
      },
    };
    const upload = (content: string) => {
      const boundary = '----gst' + Math.random().toString(16).slice(2);
      return app.inject({
        method: 'POST',
        url: `/api/tenant/accounts/gst/2b?entityId=${entityId}&period=2026-08`,
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="2B.json"\r\n` +
            `Content-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`,
        ),
        headers: { ...manager, 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
    };
    expect((await upload('{"data":{}}')).json()).toMatchObject({ code: 'not_2b' });
    const r = await ok<{
      rows: { status: string; number: string; party: string }[];
      counts: Record<string, number>;
    }>(upload(JSON.stringify(twoB)));
    expect(r.rows.map((x) => [x.status, x.number, x.party])).toEqual([
      ['matched', 'V-201', 'Vidarbha Cement Traders'],
      ['differs', 'KS/0099', 'Karnataka Steel'],
      ['in_2b_only', 'XT-7', 'Xpress Transport'],
      ['in_books_only', 'H-45', 'Hotel Sai'],
    ]);
    expect(r.counts).toEqual({ matched: 1, differs: 1, in2bOnly: 1, inBooksOnly: 1 });
  });
});
