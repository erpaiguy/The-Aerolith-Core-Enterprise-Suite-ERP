// Procurement reports in a real tenant database (docs/wave2b-plan.md step 9), every figure worked by hand: two
// requisitions sharing one enquiry line, what was ordered and received shared among them first come first served; what
// suppliers still owe and how late; material by material from requisition to stock, and wastage against the norms over
// what was measured; supplier performance: on time, rejected, above the lowest quote (a GST-included quote divided
// out); the same as Excel; kept to the projects the user sees.
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

describe.skipIf(!controlUrl || !adminUrl)('procurement reports (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-prep-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'prep-admin@example.in');
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

  const daysTo = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  const xlsxRows = async (url: string) => {
    const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: manager });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const rows: unknown[][] = [];
    wb.worksheets[0]!.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    return rows;
  };

  let projectId: string;
  let otherProject: string;

  it('follows requisitions to orders and receipts, owed orders, materials and suppliers, by hand', async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    const p = await ok<{ sites: { id: string }[] }>(
      post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
    );
    const site = p.sites[0]!.id;
    await ok(
      post(`/tenant/projects/${projectId}/wbs`, { code: 'SUB', name: 'Substructure' }, manager),
    );
    const resource = async (code: string, name: string, unit: string, rate: string) =>
      (
        await ok<{ id: string }>(
          post(
            '/tenant/resources',
            { code, name, kind: 'material', unit, rate, effectiveFrom: '2026-01-01' },
            manager,
          ),
        )
      ).id;
    const cement = await resource('CEM', 'Cement OPC 53', 'bag', '400');
    const sand = await resource('SND', 'River sand', 'cum', '1800');
    const party = async (name: string, gstin: string) =>
      (
        await ok<{ id: string }>(
          post('/tenant/parties', { name, isClient: false, isVendor: true, gstin }, manager),
        )
      ).id;
    const local = await party('Vidarbha Cement Traders', '27AAACV1234F1Z5');
    const surat = await party('Surat Building Supplies', '24AAACS5678K1Z2');
    const akola = await party('Akola Traders', '27AAACA4321B1Z9');

    // Raft: 200 bags needed by 1 October (past), 10 cum of sand. Columns: 100 bags more.
    const requisition = async (title: string, lines: object[], neededBy: string | null = null) => {
      const r = await ok<{ id: string; rowVersion: number }>(
        post(
          `/tenant/projects/${projectId}/requisitions`,
          { title, siteId: site, neededBy, lines },
          manager,
        ),
      );
      await ok(post(`/tenant/requisitions/${r.id}/submit`, { rowVersion: r.rowVersion }, manager));
      return r.id;
    };
    const raft = await requisition(
      'Raft',
      [
        { resourceId: cement, qty: '200' },
        { resourceId: sand, qty: '10' },
      ],
      '2026-10-01',
    );
    const columns = await requisition('Columns', [{ resourceId: cement, qty: '100' }]);
    let rfq = await ok<{ id: string; lines: { id: string; description: string; qty: string }[] }>(
      post(
        `/tenant/projects/${projectId}/rfqs`,
        { title: 'Raft and columns', requisitionIds: [raft, columns] },
        manager,
      ),
    );
    // One enquiry line asks for both requisitions' cement.
    expect(rfq.lines.map((l) => [l.description, l.qty])).toEqual([
      ['Cement OPC 53', '300.0000'],
      ['River sand', '10.0000'],
    ]);
    const [cementLine, sandLine] = rfq.lines.map((l) => l.id) as [string, string];
    for (const v of [local, surat, akola])
      rfq = await ok(post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: v }, manager));
    const quote = (partyId: string, gstMode: string, gstPct: string, rates: [string, string]) =>
      ok(
        post(
          `/tenant/rfqs/${rfq.id}/vendors/${partyId}/quote`,
          {
            receivedOn: '2026-09-25',
            gstMode,
            gstPct,
            lines: [
              { lineId: cementLine, rate: rates[0] },
              { lineId: sandLine, rate: rates[1] },
            ],
          },
          manager,
        ),
      );
    await quote(local, 'extra', '28', ['385', '1900']);
    await quote(surat, 'extra', '5', ['395', '1700']);
    // Akola quotes with 18% in the rate: cement 448.40 / 1.18 = ₹380 before GST, the lowest; sand 2,124 / 1.18 = 1,800.
    await quote(akola, 'included', '18', ['448.40', '2124']);

    // Cement from the local supplier anyway (Akola could not deliver in time), by 3 October; sand from Surat by the 4th.
    const order = async (partyId: string, deliverBy: string, line: object) => {
      const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
        post(
          `/tenant/projects/${projectId}/orders`,
          { kind: 'purchase', partyId, siteId: site, deliverBy, lines: [line] },
          manager,
        ),
      );
      return ok<{ id: string; number: string; progress: { lineKey: string }[] }>(
        post(
          `/tenant/order-revisions/${o.open.id}/submit`,
          { rowVersion: o.open.rowVersion },
          manager,
        ),
      );
    };
    const poCement = await order(local, '2026-10-03', {
      resourceId: cement,
      rfqLineId: cementLine,
      description: 'Cement OPC 53',
      unit: 'bag',
      qty: '300',
      rate: '385',
      gstPct: '28',
    });
    const poSand = await order(surat, '2026-10-04', {
      resourceId: sand,
      rfqLineId: sandLine,
      description: 'River sand',
      unit: 'cum',
      qty: '10',
      rate: '1700',
      gstPct: '5',
    });
    const receive = (po: typeof poCement, receivedOn: string, line: object) =>
      ok<{ store: { id: string } | null }>(
        post(
          `/tenant/orders/${po.id}/receipts`,
          {
            receivedOn,
            challanNo: `DC-${receivedOn}`,
            lines: [{ lineKey: po.progress[0]!.lineKey, ...line }],
          },
          manager,
        ),
      );
    // Cement: 100 on the 2nd (on time), 5 burst; 50 on the 5th (late). Sand: all 10 on the 4th (on time).
    const store = (
      await receive(poCement, '2026-10-02', { qty: '100', rejected: '5', reason: 'Burst bags' })
    ).store!.id;
    await receive(poCement, '2026-10-05', { qty: '50' });
    await receive(poSand, '2026-10-04', { qty: '10' });
    // 120 bags to the substructure, 10 back: 110 issued, 145 − 110 = 35 in the store.
    const issued = await ok<{ id: string }>(
      post(
        `/tenant/stores/${store}/issues`,
        {
          issuedOn: '2026-10-06',
          wbsCode: 'SUB',
          issuedTo: 'Mason gang',
          lines: [{ resourceId: cement, qty: '120' }],
        },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/issues/${issued.id}/returns`,
        { returnedOn: '2026-10-07', lines: [{ position: 1, qty: '10' }] },
        manager,
      ),
    );

    // Requisitions. The enquiry's cement line got 300 ordered and 95 + 50 = 145 accepted: Raft (first) takes 200
    // ordered and all 145 received; Columns takes the other 100 ordered and nothing received.
    const req = await ok<{
      today: string;
      lines: {
        number: string;
        description: string;
        asked: string;
        ordered: string;
        received: string;
        outstanding: string;
        stage: string;
        orders: string[];
        enquiries: string[];
        ageDays: number | null;
        late: boolean;
      }[];
    }>(get(`/tenant/projects/${projectId}/reports/requisitions`, manager));
    const today = req.today;
    expect(
      req.lines.map((l) => [
        l.description,
        l.asked,
        l.ordered,
        l.received,
        l.outstanding,
        l.stage,
        l.late,
      ]),
    ).toEqual([
      ['Cement OPC 53', '200.0000', '200.0000', '145.0000', '55.0000', 'part_received', true],
      ['River sand', '10.0000', '10.0000', '10.0000', '0.0000', 'received', false],
      ['Cement OPC 53', '100.0000', '100.0000', '0.0000', '100.0000', 'ordered', false],
    ]);
    expect(req.lines[0]!.orders).toEqual([poCement.number]);
    expect(req.lines[0]!.enquiries).toEqual([expect.stringMatching(/^RFQ\//)]);
    expect(req.lines.map((l) => l.ageDays)).toEqual([0, null, 0]); // approved today; the sand has all come

    // Open orders: only the cement is owed (the sand order closed when it all came): 300 − 145 = 155 bags,
    // 155 × 385 = ₹59,675.00, late since 3 October.
    const open = await ok<{
      lines: { number: string; outstanding: string; value: string; daysLate: number }[];
      suppliers: { vendor: string; lines: number; late: number; value: string }[];
    }>(get(`/tenant/reports/open-orders?projectId=${projectId}`, manager));
    expect(open.lines).toEqual([
      expect.objectContaining({
        number: poCement.number,
        outstanding: '155.0000',
        value: '59675.00',
        daysLate: daysTo('2026-10-03', today),
      }),
    ]);
    expect(open.suppliers).toEqual([
      { vendor: 'Vidarbha Cement Traders', lines: 1, late: 1, value: '59675.00' },
    ]);

    // Materials. The measured work: line K1 60 − 10 = 50 at 1.8 bags = 90; line K2 20 at 0.5 = 10: 100 bags it should
    // have taken. 110 issued: 10 wasted, 10.0%. No approved budget yet.
    const contract = (
      await ok<{ id: string }>(
        post(`/tenant/projects/${projectId}/boqs`, { name: 'Contract', kind: 'contract' }, manager),
      )
    ).id;
    const [k1, k2] = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [key, qty] of [
      [k1, '60'],
      [k1, '-10'],
      [k2, '20'],
    ] as const)
      await db`INSERT INTO proj.measurement (project_id, boq_id, line_key, measured_on, qty)
        VALUES (${projectId}, ${contract}, ${key}, '2026-10-08', ${qty})`;
    for (const [key, per] of [
      [k1, '1.8'],
      [k2, '0.5'],
    ] as const)
      await db`INSERT INTO proj.material_norm (project_id, line_key, resource_id, per_unit, analysis_code)
        VALUES (${projectId}, ${key}, ${cement}, ${per}, 'RA-1')`;
    const mat = await ok<{
      lines: {
        code: string;
        budget: string | null;
        requisitioned: string;
        ordered: string;
        received: string;
        issued: string;
        inStock: string;
        theoretical: string | null;
        wastage: string | null;
        wastagePct: string | null;
      }[];
    }>(get(`/tenant/projects/${projectId}/reports/materials`, manager));
    expect(
      mat.lines.map((l) => [
        l.code,
        l.budget,
        ...[l.requisitioned, l.ordered, l.received, l.issued, l.inStock].map(Number),
        l.theoretical === null ? null : Number(l.theoretical),
        l.wastage,
        l.wastagePct,
      ]),
    ).toEqual([
      ['CEM', null, 300, 300, 145, 110, 35, 100, '10.0000', '10.0'],
      ['SND', null, 10, 10, 10, 0, 10, null, null, null],
    ]);

    // Suppliers. Vidarbha: ₹1,15,500 + 28% = ₹1,47,840.00 ordered; one of two receipts on time; 5 of 150 bags
    // rejected, 1,925 / 57,750 = 3.3%; paid 1,15,500 against 300 × 380 = 1,14,000 at the lowest quote: 1.3% above.
    // Surat: ₹17,000 + 5% = ₹17,850.00, on time, nothing rejected, at the lowest. Akola got no order.
    const sup = await ok<{
      suppliers: {
        vendor: string;
        orders: number;
        orderedValue: string;
        receiptLines: number;
        onTimePct: string | null;
        rejectedPct: string | null;
        overL1Pct: string | null;
      }[];
    }>(get(`/tenant/reports/suppliers?projectId=${projectId}`, manager));
    expect(
      sup.suppliers.map((s) => [
        s.vendor,
        s.orders,
        s.orderedValue,
        s.receiptLines,
        s.onTimePct,
        s.rejectedPct,
        s.overL1Pct,
      ]),
    ).toEqual([
      ['Vidarbha Cement Traders', 1, '147840.00', 2, '50.0', '3.3', '1.3'],
      ['Surat Building Supplies', 1, '17850.00', 1, '100.0', '0.0', '0.0'],
    ]);

    // The same as Excel: numbers as numbers, after the title, the date and a blank row.
    const rows = await xlsxRows(`/tenant/projects/${projectId}/reports/materials?format=xlsx`);
    expect(rows[0]).toEqual(['Material reconciliation and wastage']);
    expect(rows[2]?.slice(0, 3)).toEqual(['Code', 'Material', 'Unit']);
    expect(rows[3]).toEqual([
      'CEM',
      'Cement OPC 53',
      'bag',
      undefined,
      300,
      300,
      145,
      110,
      35,
      100,
      10,
      10,
    ]);
    for (const url of [
      `/tenant/projects/${projectId}/reports/requisitions?format=xlsx`,
      `/tenant/reports/open-orders?format=xlsx`,
      `/tenant/reports/suppliers?format=xlsx`,
    ])
      expect((await xlsxRows(url)).length).toBeGreaterThan(3);
  });

  it('keeps the reports to the projects the user sees', async () => {
    // The worker is on no project: project reports are not found, company-wide ones are empty.
    expect((await get(`/tenant/projects/${projectId}/reports/materials`, worker)).statusCode).toBe(
      404,
    );
    expect(
      (await get(`/tenant/projects/${projectId}/reports/requisitions`, worker)).statusCode,
    ).toBe(404);
    expect(
      (await get(`/tenant/reports/open-orders?projectId=${projectId}`, worker)).statusCode,
    ).toBe(404);
    expect(
      await ok<{ lines: unknown[] }>(get('/tenant/reports/open-orders', worker)),
    ).toMatchObject({
      lines: [],
    });
    expect(await ok<{ suppliers: unknown[] }>(get('/tenant/reports/suppliers', worker))).toEqual({
      suppliers: [],
    });
    // On the team, they see it; the admin sees every project's.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect(
      (await ok<{ lines: { number: string }[] }>(get('/tenant/reports/open-orders', worker))).lines,
    ).toHaveLength(1);
    otherProject = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Depot, Akola' }, manager))
    ).id;
    expect(
      (
        await ok<{ suppliers: unknown[] }>(
          get(`/tenant/reports/suppliers?projectId=${otherProject}`),
        )
      ).suppliers,
    ).toEqual([]);
    expect(
      (
        await ok<{ suppliers: { vendor: string }[] }>(get('/tenant/reports/suppliers'))
      ).suppliers.map((s) => s.vendor),
    ).toEqual(['Vidarbha Cement Traders', 'Surat Building Supplies']);
  });
});
