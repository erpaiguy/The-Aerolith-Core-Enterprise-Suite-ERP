// Client RA bills in a real tenant database (docs/wave3-plan.md step 2), every figure worked by hand: three bills in a
// row from the measurement book; escalation by the formula; GST on top, CGST and SGST then IGST; retention to its cap;
// the mobilisation advance recovered over the bills; a labour cess deducted; a certificate for less; the certified bill
// posted; a bill over the approval rule's amount waiting for it; who may bill.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import ExcelJS from 'exceljs';
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

describe.skipIf(!controlUrl || !adminUrl)('client bills (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-bill-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'bill-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  interface Figures {
    gross: string;
    escalationTotal: string;
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    invoiceTotal: string;
    retention: string;
    advanceRecovery: string;
    otherDeductions: string;
    net: string;
  }
  interface Bill {
    id: string;
    raNo: number;
    status: string;
    rowVersion: number;
    invoiceNo: string | null;
    voucherId: string | null;
    figures: Figures | null;
    submitted: Figures | null;
    certified: Figures | null;
    lines: {
      lineKey: string;
      code: string;
      prevQty: string;
      measuredQty: string;
      cumQty: string;
      certQty: string | null;
    }[];
    approval: { id: string; status: string } | null;
    mayEdit: boolean;
  }
  const pick = (f: Figures | null) =>
    f && [
      f.gross,
      f.escalationTotal,
      f.taxable,
      f.cgst,
      f.sgst,
      f.igst,
      f.invoiceTotal,
      f.retention,
      f.advanceRecovery,
      f.otherDeductions,
      f.net,
    ];

  let projectId: string;
  let boqId: string;
  let surat: string;
  let entityId: string;
  let overheads: string;
  const node = async (code: string) =>
    (
      await db<
        { id: string }[]
      >`SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND code = ${code}`
    )[0]!.id;
  const measure = async (code: string, measuredOn: string, qty: string) =>
    ok(
      post(
        `/tenant/boqs/${boqId}/lines/${await node(code)}/progress`,
        { measuredOn, qty },
        manager,
      ),
    );
  const bill = (id: string, as: Record<string, string> = manager) =>
    ok<Bill>(get(`/tenant/client-bills/${id}`, as));
  const qtys = (b: Bill) =>
    Object.fromEntries(b.lines.map((l) => [l.code, [l.prevQty, l.cumQty].map(Number)]));

  it('bills the measurement book: escalation, CGST and SGST, retention, the advance, a cess; certified for less, and posted', async () => {
    // The company, its project for the Zilla Parishad at Washim (Maharashtra), the contract BOQ.
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    const zp = (
      await ok<{ id: string }>(
        post('/tenant/parties', { name: 'Zilla Parishad Washim', isClient: true }),
      )
    ).id;
    projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Washim', clientId: null }, manager),
      )
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    const p = await ok<{ sites: { id: string; name: string }[] }>(
      post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
    );
    boqId = (
      await ok<{ id: string }>(
        post(`/tenant/projects/${projectId}/boqs`, { name: 'Contract', kind: 'contract' }, manager),
      )
    ).id;
    const item = (
      tempId: string,
      afterId: string | null,
      code: string,
      description: string,
      unit: string,
      qty: string,
      rate: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId: 'tA',
      afterId,
      type: 'item',
      code,
      description,
      unit,
      qty,
      rate,
    });
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
              description: 'Civil works',
            },
            item('t1', null, 'A.1', 'Excavation in ordinary soil', 'cum', '100', '350'),
            item('t2', 't1', 'A.2', 'PCC M15', 'cum', '20', '5600'),
            item('t3', 't2', 'A.3', 'Brick masonry in CM 1:6', 'cum', '50', '6200'),
          ],
        },
        manager,
      ),
    );
    await measure('A.1', '2026-07-20', '60');
    await measure('A.2', '2026-07-25', '5');

    // Refused until the project has a client and the company a GSTIN.
    expect(
      (
        await post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-07-31' }, manager)
      ).json(),
    ).toMatchObject({ code: 'no_client' });
    const proj = await ok<{ rowVersion: number; name: string }>(
      get(`/tenant/projects/${projectId}`, manager),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}`,
        { name: proj.name, clientId: zp, rowVersion: proj.rowVersion },
        manager,
      ),
    );
    expect(
      (
        await post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-07-31' }, manager)
      ).json(),
    ).toMatchObject({ code: 'no_gstin' });
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Washim Builders Pvt Ltd',
        gstin: '27AAACW1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );

    // Terms: GST 18%; retention 5% to ₹10,000; ₹50,000 advance recovered at 10% a bill; escalation on 85%:
    // materials 50% (base index 150), labour 30% (base 200).
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/bill-terms`,
          { rowVersion: null, gstPct: '18', retentionPct: '5' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    await ok(
      post(
        `/tenant/projects/${projectId}/bill-terms`,
        {
          rowVersion: null,
          gstPct: '18',
          retentionPct: '5',
          retentionCap: '10000',
          advanceAmount: '50000',
          advanceRecoveryPct: '10',
          escalation: {
            factor: '0.85',
            components: [
              { key: 'materials', name: 'Materials', sharePct: '50', baseIndex: '150' },
              { key: 'labour', name: 'Labour', sharePct: '30', baseIndex: '200' },
            ],
          },
        },
        manager,
      ),
    );

    // RA 1 to 31 July: excavation 60 × ₹350 = 21,000.00; PCC 5 × ₹5,600 = 28,000.00. Gross ₹49,000.00.
    let ra1 = await ok<Bill>(
      post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-07-31' }, manager),
    );
    expect(qtys(ra1)).toEqual({ 'A.1': [0, 60], 'A.2': [0, 5] });
    // Indices this period: materials 165 (+10%), labour 210 (+5%): 49,000 × 0.85 × 50% × 10% = 2,082.50 and
    // 49,000 × 0.85 × 30% × 5% = 624.75: ₹2,707.25. Taxable 51,707.25; CGST and SGST 9% each 4,653.65 (4,653.6525);
    // invoice 61,014.55. Retention 5% of 49,000 = 2,450; advance 10% = 4,900; labour cess 1% = 490.
    // Net 61,014.55 − 2,450 − 4,900 − 490 = ₹53,174.55.
    overheads = (
      await ok<{ accounts: { id: string; code: string }[] }>(get('/tenant/accounts/chart', manager))
    ).accounts.find((a) => a.code === 'X3004')!.id;
    ra1 = await ok<Bill>(
      post(
        `/tenant/client-bills/${ra1.id}`,
        {
          rowVersion: ra1.rowVersion,
          indices: { materials: '165', labour: '210' },
          deductions: [
            { description: 'Labour welfare cess 1%', amount: '490', accountId: overheads },
          ],
        },
        manager,
      ),
    );
    expect(pick(ra1.figures)).toEqual([
      '49000.00',
      '2707.25',
      '51707.25',
      '4653.65',
      '4653.65',
      '0.00',
      '61014.55',
      '2450.00',
      '4900.00',
      '490.00',
      '53174.55',
    ]);
    // No approval rule: submitted to the client at once. The next bill waits for this one's certificate.
    ra1 = await ok<Bill>(
      post(`/tenant/client-bills/${ra1.id}/submit`, { rowVersion: ra1.rowVersion }, manager),
    );
    expect(ra1).toMatchObject({ status: 'submitted', mayEdit: false });
    expect(
      (
        await post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-08-31' }, manager)
      ).json(),
    ).toMatchObject({ code: 'previous_open' });

    // Certified on 10 August with PCC at 4 cum, not 5: gross 21,000 + 22,400 = 43,400; escalation 1,844.50 + 553.35 =
    // 2,397.85; taxable 45,797.85; CGST and SGST 4,121.81 (4,121.8065); invoice 54,041.47; retention 2,170; advance 4,340;
    // the cess 490; net 47,041.47.
    const pcc = ra1.lines.find((l) => l.code === 'A.2')!.lineKey;
    ra1 = await ok<Bill>(
      post(
        `/tenant/client-bills/${ra1.id}/certify`,
        {
          rowVersion: ra1.rowVersion,
          certifiedOn: '2026-08-10',
          clientRef: 'EE/WSM/441',
          lines: [{ lineKey: pcc, certQty: '4' }],
        },
        manager,
      ),
    );
    expect(ra1).toMatchObject({ status: 'certified', invoiceNo: 'INV/2026-27/0001' });
    expect(pick(ra1.certified)).toEqual([
      '43400.00',
      '2397.85',
      '45797.85',
      '4121.81',
      '4121.81',
      '0.00',
      '54041.47',
      '2170.00',
      '4340.00',
      '490.00',
      '47041.47',
    ]);
    expect(pick(ra1.submitted)![10]).toBe('53174.55'); // what was asked stays on record
    // Posted as a sales voucher: each side ₹54,041.47.
    const v = await ok<{
      type: string;
      reference: string;
      total: string;
      lines: { account: { name: string }; debit: string; credit: string }[];
    }>(get(`/tenant/accounts/vouchers/${ra1.voucherId}`, manager));
    expect(v).toMatchObject({ type: 'sales', reference: 'INV/2026-27/0001', total: '54041.47' });
    expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([
      ['Zilla Parishad Washim', '47041.47', '0.00'],
      ['Retention receivable', '2170.00', '0.00'],
      ['Mobilisation advance received', '4340.00', '0.00'],
      ['Site overheads', '490.00', '0.00'],
      ['Contract revenue', '0.00', '45797.85'],
      ['Output CGST', '0.00', '4121.81'],
      ['Output SGST', '0.00', '4121.81'],
    ]);
    expect(
      (await post(`/tenant/client-bills/${ra1.id}/cancel`, { reason: 'wrong' }, manager)).json(),
    ).toMatchObject({ code: 'certified' });
    expect(
      (
        await post(
          `/tenant/accounts/vouchers/${ra1.voucherId}/reverse`,
          { date: '2026-08-11', reason: 'x y z' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'posted_by_document' });
    surat = (
      await ok<{ sites: { id: string; name: string }[] }>(
        post(
          `/tenant/projects/${projectId}/sites`,
          { name: 'Surat yard', stateCode: '24' },
          manager,
        ),
      )
    ).sites.find((s) => s.name === 'Surat yard')!.id;
    void p;
  });

  it('bills on from the certified quantities: retention reaches its cap, the advance runs on, IGST outside the state', async () => {
    await measure('A.1', '2026-08-15', '40');
    await measure('A.2', '2026-08-16', '10');
    await measure('A.3', '2026-08-20', '20');
    // The site is needed once the project has two.
    expect(
      (
        await post(`/tenant/projects/${projectId}/client-bills`, { upto: '2026-08-31' }, manager)
      ).json(),
    ).toMatchObject({ code: 'site_needed' });
    const washim = (
      await ok<{ sites: { id: string; name: string }[] }>(
        get(`/tenant/projects/${projectId}`, manager),
      )
    ).sites.find((s) => s.name === 'Washim')!.id;
    // RA 2 to 31 August, from what RA 1 certified (PCC 4): excavation 40 × 350 = 14,000; PCC 11 × 5,600 = 61,600;
    // brickwork 20 × 6,200 = 1,24,000. Gross ₹1,99,600; no indices this time, so no escalation. CGST and SGST 17,964
    // each; invoice 2,35,528. Retention 5% = 9,980, but only 10,000 − 2,170 = 7,830 is left under the cap; advance 10% =
    // 19,960 (45,660 left). Net 2,35,528 − 7,830 − 19,960 = ₹2,07,738.00.
    let ra2 = await ok<Bill>(
      post(
        `/tenant/projects/${projectId}/client-bills`,
        { upto: '2026-08-31', siteId: washim },
        manager,
      ),
    );
    expect(ra2.raNo).toBe(2);
    expect(qtys(ra2)).toEqual({ 'A.1': [60, 100], 'A.2': [4, 15], 'A.3': [0, 20] });
    expect(pick(ra2.figures)).toEqual([
      '199600.00',
      '0.00',
      '199600.00',
      '17964.00',
      '17964.00',
      '0.00',
      '235528.00',
      '7830.00',
      '19960.00',
      '0.00',
      '207738.00',
    ]);
    // The worker on the team has no billing right.
    expect(
      (await post(`/tenant/client-bills/${ra2.id}/submit`, { rowVersion: ra2.rowVersion }, worker))
        .statusCode,
    ).toBe(403);
    ra2 = await ok<Bill>(
      post(`/tenant/client-bills/${ra2.id}/submit`, { rowVersion: ra2.rowVersion }, manager),
    );
    ra2 = await ok<Bill>(
      post(
        `/tenant/client-bills/${ra2.id}/certify`,
        { rowVersion: ra2.rowVersion, certifiedOn: '2026-09-05' },
        manager,
      ),
    );
    expect(ra2.invoiceNo).toBe('INV/2026-27/0002');
    expect(pick(ra2.certified)![10]).toBe('207738.00');

    // RA 3 to 30 September, billed at the Surat yard (Gujarat): IGST. Excavation 10 more (110: beyond the BOQ's 100, still
    // billed); brickwork measured to 50 but billed to 45: 25 × 6,200 = 1,55,000. Gross 3,500 + 1,55,000 = ₹1,58,500;
    // IGST 28,530; invoice 1,87,030. Retention: the cap is reached, nothing. Advance 15,850. Net ₹1,71,180.00.
    await measure('A.1', '2026-09-10', '10');
    await measure('A.3', '2026-09-20', '30');
    let ra3 = await ok<Bill>(
      post(
        `/tenant/projects/${projectId}/client-bills`,
        { upto: '2026-09-30', siteId: surat },
        manager,
      ),
    );
    const brick = ra3.lines.find((l) => l.code === 'A.3')!;
    expect([brick.prevQty, brick.measuredQty].map(Number)).toEqual([20, 50]);
    ra3 = await ok<Bill>(
      post(
        `/tenant/client-bills/${ra3.id}`,
        { rowVersion: ra3.rowVersion, lines: [{ lineKey: brick.lineKey, cumQty: '45' }] },
        manager,
      ),
    );
    expect(pick(ra3.figures)).toEqual([
      '158500.00',
      '0.00',
      '158500.00',
      '0.00',
      '0.00',
      '28530.00',
      '187030.00',
      '0.00',
      '15850.00',
      '0.00',
      '171180.00',
    ]);

    // From ₹1 lakh a manager approves: the bill waits, and the admin (not the manager who submitted) approves it.
    await ok(
      post('/tenant/approval-rules/client_bill', {
        rules: [{ minAmount: '100000', approver: 'manager' }],
      }),
    );
    ra3 = await ok<Bill>(
      post(`/tenant/client-bills/${ra3.id}/submit`, { rowVersion: ra3.rowVersion }, manager),
    );
    expect(ra3).toMatchObject({
      status: 'pending',
      mayEdit: false,
      approval: { status: 'pending' },
    });
    await ok(post(`/tenant/approvals/${ra3.approval!.id}/approve`, {}));
    expect((await bill(ra3.id)).status).toBe('submitted');

    // The books: contract revenue 45,797.85 + 1,99,600 = ₹2,45,397.85 credit; the client owes 47,041.47 + 2,07,738.
    const tb = await ok<{ rows: { name: string; debit: string | null; credit: string | null }[] }>(
      get(
        `/tenant/accounts/trial-balance?entityId=${entityId}&asOf=2026-09-30&projectId=${projectId}`,
        manager,
      ),
    );
    const at = (n: string) => tb.rows.find((r) => r.name === n);
    expect([
      at('Contract revenue')?.credit,
      at('Zilla Parishad Washim')?.debit,
      at('Retention receivable')?.debit,
    ]).toEqual(['245397.85', '254779.47', '10000.00']);

    // The bill as Excel: the abstract ends with the net payable.
    const x = await app.inject({
      method: 'GET',
      url: `/api/tenant/client-bills/${ra2.id}/xlsx`,
      headers: manager,
    });
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const rows: unknown[][] = [];
    wb.getWorksheet('Abstract')!.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    expect(rows.at(-1)).toEqual(['Net payable', 207738]);
    expect(rows[0]).toEqual(['RA bill 2 (certified)']);
  });
  it('takes escalation indices from the index series averaged over the bill period', async () => {
    // docs/wave8-plan.md step 8d.1. RA 4 runs from the day after RA 3 (1 October) to 15 October: the WPI for October,
    // 160, stands as the materials index, unless one is typed on the bill. A month missing gives nothing.
    const series = await ok<{ key: string }[]>(get('/tenant/accounts/price-indices', manager));
    expect(series.map((x) => x.key)).toContain('wpi_all');
    const values = {
      values: [
        { month: '2026-09', value: '150' },
        { month: '2026-10', value: '160' },
      ],
    };
    expect(
      (await post('/tenant/accounts/price-indices/wpi_all/values', values, worker)).statusCode,
    ).toBe(403);
    await ok(post('/tenant/accounts/price-indices/wpi_all/values', values, manager));
    const p = await ok<{ terms: Record<string, unknown> & { rowVersion: number } }>(
      get(`/tenant/projects/${projectId}/client-bills`, manager),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/bill-terms`,
        {
          ...p.terms,
          escalation: {
            factor: '0.85',
            components: [
              {
                key: 'materials',
                name: 'Materials',
                sharePct: '50',
                baseIndex: '150',
                seriesKey: 'wpi_all',
              },
              { key: 'labour', name: 'Labour', sharePct: '30', baseIndex: '200' },
            ],
          },
        },
        manager,
      ),
    );
    await measure('A.1', '2026-10-10', '5');
    const [open] = await db<{ id: string }[]>`
      SELECT id FROM acc.client_bill WHERE project_id = ${projectId} AND ra_no = 3`;
    const ra3 = await bill(open!.id);
    await ok(
      post(
        `/tenant/client-bills/${ra3.id}/certify`,
        { rowVersion: ra3.rowVersion, certifiedOn: '2026-10-05' },
        manager,
      ),
    );
    const ra4 = await ok<Bill & { autoIndices: Record<string, string> }>(
      post(
        `/tenant/projects/${projectId}/client-bills`,
        { upto: '2026-10-15', siteId: surat },
        manager,
      ),
    );
    expect(ra4.autoIndices).toEqual({ materials: '160.0000' });
  });
});
