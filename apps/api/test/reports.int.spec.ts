// Reports in a real tenant database (docs/wave1-plan.md step 12): the cost summary of a BOQ split by resource kind
// through its rate analyses, the rate analysis report, the unpriced BOQ export, and the bid pipeline, with bid values
// hidden from users without the pricing permission. Figures are worked by hand in the comments.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import ExcelJS from 'exceljs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import type { AnalysisReport, CostSummary, Pipeline } from '../src/reports/reports.service.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('reports (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: Record<string, string>;
  let tenderId: string;
  let boqId: string;
  const ids: Record<string, string> = {};

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  const sheet = async (url: string, headers: Record<string, string> = t.admin) => {
    const res = await get(url, headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const rows: unknown[][] = [];
    wb.worksheets[0]!.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    return { wb, rows };
  };

  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ temporaryPassword: string }>();
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
    return { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` };
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
      RATE_LIMIT_SCALE: '200',
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'reports-admin@example.in');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    worker = await staff('ramesh', 'worker');

    // Resources on 1 April 2026: cement ₹400/bag, mason ₹1,000/day, mixer ₹200/hour.
    for (const [code, kind, unit, rate] of [
      ['CEM', 'material', 'bag', '400'],
      ['MASON', 'labour', 'day', '1000'],
      ['MIXER', 'equipment', 'hour', '200'],
    ] as const)
      ids[code] = (
        await ok<{ id: string }>(
          post('/tenant/resources', {
            code,
            name: code,
            kind,
            unit,
            rate,
            effectiveFrom: '2026-04-01',
          }),
        )
      ).id;
    // Mortar, per cum: 2 bags (800 material) + 0.5 day (500 labour) = 1,300; +10 % = 1,430.
    ids.MORTAR = (
      await ok<{ id: string }>(
        post('/tenant/rate-analyses', {
          code: 'MORTAR',
          description: 'Cement mortar 1:6',
          unit: 'cum',
          outputQty: '1',
          additions: [{ label: 'Overheads', pct: '10' }],
          lines: [
            { kind: 'resource', resourceId: ids.CEM, qty: '2' },
            { kind: 'resource', resourceId: ids.MASON, qty: '0.5' },
          ],
        }),
      )
    ).id;
    // Wall, for 10 sqm: mortar 1 cum (1,430) + mixer 5 hours (1,000) + lump sum 70 = 2,500; +20 % = 3,000;
    // ₹300 per sqm = material 80 + labour 50 + equipment 100 + other 7 + additions (130 + 500) / 10 = 63.
    ids.WALL = (
      await ok<{ id: string }>(
        post('/tenant/rate-analyses', {
          code: 'WALL',
          description: 'Brick wall 230 mm',
          unit: 'sqm',
          outputQty: '10',
          additions: [{ label: 'Profit and overheads', pct: '20' }],
          lines: [
            { kind: 'analysis', subAnalysisId: ids.MORTAR, qty: '1' },
            { kind: 'resource', resourceId: ids.MIXER, qty: '5' },
            { kind: 'lump_sum', description: 'Scaffolding', amount: '70' },
          ],
        }),
      )
    ).id;

    tenderId = (
      await ok<{ id: string }>(
        post('/tenant/tenders', { title: 'Staff quarters, Wardha', estimatedValue: '3500' }),
      )
    ).id;
    boqId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Civil' })))
      .id;
    const h = await ok<{ rowVersion: number }>(get(`/tenant/boqs/${boqId}`));
    await ok(post(`/tenant/boqs/${boqId}`, { rowVersion: h.rowVersion, rateDate: '2026-05-01' }));
    // Masonry: 10 sqm of wall at 300 = 3,000. Finishes: painting 5 sqm at 100 = 500. A loose item with no rate.
    await ok(
      post(`/tenant/boqs/${boqId}/changes`, {
        ops: [
          {
            op: 'insert',
            tempId: 'ts1',
            parentId: null,
            afterId: null,
            type: 'section',
            code: 'A',
            description: 'Masonry',
          },
          {
            op: 'insert',
            tempId: 'ti1',
            parentId: 'ts1',
            afterId: null,
            type: 'item',
            qty: '10',
            rateAnalysisId: ids.WALL,
          },
          {
            op: 'insert',
            tempId: 'ts2',
            parentId: null,
            afterId: 'ts1',
            type: 'section',
            code: 'B',
            description: 'Finishes',
          },
          {
            op: 'insert',
            tempId: 'ti2',
            parentId: 'ts2',
            afterId: null,
            type: 'item',
            description: 'Painting',
            unit: 'sqm',
            qty: '5',
            rate: '100',
          },
          {
            op: 'insert',
            tempId: 'ti3',
            parentId: null,
            afterId: 'ts2',
            type: 'item',
            description: 'Watch and ward',
            unit: 'month',
            qty: '2',
          },
        ],
      }),
    );
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  describe('cost summary', () => {
    it('splits the BOQ by section and by resource kind through the rate analyses', async () => {
      const s = await ok<CostSummary>(get(`/tenant/boqs/${boqId}/cost-summary`));
      expect(s.boq).toMatchObject({ total: '3500.00', rateDate: '2026-05-01', versionNo: 1 });
      expect(s.counts).toEqual({ items: 3, priced: 2, unpriced: 1, noQty: 0, analysed: 1 });
      expect(s.sections).toEqual([
        { code: 'A', description: 'Masonry', amount: '3000.00', pct: '85.71' },
        { code: 'B', description: 'Finishes', amount: '500.00', pct: '14.29' },
      ]);
      expect(s.unsectioned).toEqual({ amount: '0.00', items: 1 });
      expect(Object.fromEntries(s.breakdown.parts.map((p) => [p.part, p.amount]))).toEqual({
        material: '800.00',
        labour: '500.00',
        equipment: '1000.00',
        subcontract: '0.00',
        other: '70.00',
        additions: '630.00',
        not_analysed: '500.00',
      });
      expect(s.breakdown.total).toBe('3500.00');
      expect(s.incomplete).toEqual([]);
      expect(s.bid).toBeNull();
      expect(s.pricingHidden).toBe(false);
      expect(Date.parse(s.asOf)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('shows the selected bid to pricing users only', async () => {
      await ok(
        post(`/tenant/boqs/${boqId}/scenarios`, {
          name: 'Ten per cent',
          markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '10' }],
          gstPct: '18',
          gstMode: 'add',
        }),
      );
      // 3,500 + 350 = 3,850 before GST (10 % above the 3,500 estimate); GST 693; bid 4,543.
      const s = await ok<CostSummary>(get(`/tenant/boqs/${boqId}/cost-summary`));
      expect(s.bid).toMatchObject({
        scenario: 'Ten per cent',
        base: '3500.00',
        markupTotal: '350.00',
        beforeGst: '3850.00',
        gst: '693.00',
        bid: '4543.00',
        vsEstimatePct: '10.00',
      });
      const w = await ok<CostSummary>(get(`/tenant/boqs/${boqId}/cost-summary`, worker));
      expect(w.bid).toBeNull();
      expect(w.pricingHidden).toBe(true);
      expect(w.breakdown.total).toBe('3500.00');

      const { rows } = await sheet(`/tenant/boqs/${boqId}/cost-summary/export`);
      expect(rows[0]![0]).toBe('Cost summary: Civil');
      expect(rows).toContainEqual(['', 'Equipment', 1000, 28.57]);
      expect(rows).toContainEqual(['', 'Bid', 4543]);
      const ws = await sheet(`/tenant/boqs/${boqId}/cost-summary/export`, worker);
      expect(ws.rows.flat()).not.toContain('Bid');
    });

    it('lists analyses with resources missing a rate on the rate date', async () => {
      // Before April no resource has a rate.
      const h = await ok<{ rowVersion: number }>(get(`/tenant/boqs/${boqId}`));
      await ok(post(`/tenant/boqs/${boqId}`, { rowVersion: h.rowVersion, rateDate: '2026-03-01' }));
      const s = await ok<CostSummary>(get(`/tenant/boqs/${boqId}/cost-summary`));
      expect(s.incomplete).toEqual([
        { code: 'WALL', description: 'Brick wall 230 mm', missing: ['CEM', 'MASON', 'MIXER'] },
      ]);
      // Only the lump sum is costed: 70 + 20 % = 84 for 10 sqm, so 7 of every 8.40 is "other": 2,500 of the 3,000.
      expect(Object.fromEntries(s.breakdown.parts.map((p) => [p.part, p.amount]))).toMatchObject({
        other: '2500.00',
        additions: '500.00',
        material: '0.00',
        not_analysed: '500.00',
      });
      const h2 = await ok<{ rowVersion: number }>(get(`/tenant/boqs/${boqId}`));
      await ok(
        post(`/tenant/boqs/${boqId}`, { rowVersion: h2.rowVersion, rateDate: '2026-05-01' }),
      );
    });

    it('is not found for another id', async () => {
      const r = await get('/tenant/boqs/00000000-0000-4000-8000-000000000000/cost-summary');
      expect(r.statusCode).toBe(404);
    });
  });

  describe('rate analysis report', () => {
    it('lists the analyses behind the BOQ, sub-analyses after, costed on the rate date', async () => {
      const r = await ok<AnalysisReport>(get(`/tenant/boqs/${boqId}/analysis-report`, worker));
      expect(r.analyses.map((a) => [a.code, a.direct, a.items])).toEqual([
        ['WALL', true, 1],
        ['MORTAR', false, 0],
      ]);
      const wall = r.analyses[0]!;
      expect(wall).toMatchObject({
        qty: '10.0000',
        subtotal: '2500.00',
        total: '3000.00',
        unitRate: '300.0000',
        boqRate: '300.00',
        additions: [{ label: 'Profit and overheads', pct: '20', amount: '500.00' }],
        missing: [],
        error: null,
      });
      expect(wall.lines.map((l) => [l.kind, l.code, l.description, l.unitCost, l.cost])).toEqual([
        ['analysis', 'MORTAR', 'Cement mortar 1:6', '1430.0000', '1430.00'],
        ['resource', 'MIXER', 'MIXER', '200.0000', '1000.00'],
        ['lump_sum', null, 'Scaffolding', null, '70.00'],
      ]);
      const { rows } = await sheet(`/tenant/boqs/${boqId}/analysis-report/export`);
      expect(rows).toContainEqual(['', '', 'Rate per sqm', '', '', '', 300, 300]);
      expect(rows).toContainEqual([1, 'MORTAR', 'Cement mortar 1:6', 'cum', 1, 0, 1430, 1430]);
    });
  });

  describe('unpriced BOQ export', () => {
    it('leaves every rate and amount blank and keeps the quantities', async () => {
      const r = await get(`/tenant/boqs/${boqId}/export?format=csv&unpriced=true`);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-disposition']).toContain('unpriced');
      const lines = r.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toBe('Level,Type,Code,Description,Unit,Qty,Rate,Amount,Notes');
      expect(lines.slice(1)).toEqual([
        '0,section,A,Masonry,,,,,',
        '1,item,,Brick wall 230 mm,sqm,10,,,',
        '0,section,B,Finishes,,,,,',
        '1,item,,Painting,sqm,5,,,',
        '0,item,,Watch and ward,month,2,,,',
      ]);
      const priced = await get(`/tenant/boqs/${boqId}/export?format=csv`);
      expect(priced.body).toContain('Painting,sqm,5,100,500');
    });

    it('refuses quoted rates on an unpriced file', async () => {
      const [s] = await db<
        { id: string }[]
      >`SELECT id FROM est.pricing_scenario WHERE boq_id = ${boqId}`;
      const r = await get(`/tenant/boqs/${boqId}/export?scenario=${s!.id}&unpriced=true`);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code: 'unpriced_quoted' });
    });
  });

  describe('bid pipeline', () => {
    beforeAll(async () => {
      const [me] = await db<{ id: string }[]>`
        SELECT id FROM platform."user" WHERE role = 'admin' ORDER BY created_at LIMIT 1`;
      const tender = async (title: string, estimatedValue: string) =>
        (await ok<{ id: string }>(post('/tenant/tenders', { title, estimatedValue }))).id;
      const b = await tender('Hostel block, Akola', '10000');
      const c = await tender('Clinic interiors, Pune', '6000');
      const [winner] = await db<{ id: string }[]>`
        INSERT INTO platform.party (name, is_competitor) VALUES ('Shree Builders', true) RETURNING id`;
      // FY 2026-27: the first tender (lead) and B (submitted at ₹9,800). FY 2025-26: C, won at ₹5,000.
      await db`UPDATE tender.tender SET submission_due_at = '2026-09-30T06:30:00Z', owner_id = NULL
        WHERE id = ${tenderId}`;
      await db`UPDATE tender.tender SET status = 'submitted', owner_id = ${me!.id},
        submission_due_at = '2026-06-15T06:30:00Z', vertical = 'buildings' WHERE id = ${b}`;
      await db`INSERT INTO tender.submission (tender_id, submitted_at, mode, bid_value)
        VALUES (${b}, '2026-06-14T10:00:00Z', 'portal', 9800)`;
      await db`UPDATE tender.tender SET status = 'won', vertical = 'interiors',
        submission_due_at = '2025-06-01T06:30:00Z', result_on = '2025-08-01', awarded_value = 5000,
        awarded_to = ${winner!.id}, owner_id = NULL WHERE id = ${c}`;
      ids.owner = me!.id;
    });

    it('lists tenders by stage with the pipeline and bid values', async () => {
      const p = await ok<Pipeline>(get('/tenant/reports/pipeline'));
      expect(p.years).toEqual(['2026-27', '2025-26']);
      expect(p.rows.map((r) => [r.title, r.status, r.fy, r.ourBid])).toEqual([
        ['Staff quarters, Wardha', 'lead', '2026-27', null],
        ['Hostel block, Akola', 'submitted', '2026-27', '9800.00'],
        ['Clinic interiors, Pune', 'won', '2025-26', null],
      ]);
      expect(p.rows[2]).toMatchObject({
        awardedValue: '5000.00',
        awardedTo: 'Shree Builders',
        resultOn: '2025-08-01',
      });
      expect(p.stages.filter((s) => s.count > 0)).toEqual([
        { status: 'lead', count: 1, estimatedValue: '3500.00' },
        { status: 'submitted', count: 1, estimatedValue: '10000.00' },
        { status: 'won', count: 1, estimatedValue: '6000.00' },
      ]);
      expect(p.totals).toEqual({
        tenders: 3,
        open: 2,
        pipelineValue: '13500.00',
        submittedValue: '9800.00',
        won: 1,
        wonValue: '5000.00',
      });
      expect(p.owners).toEqual([{ id: ids.owner, name: expect.any(String) }]);
    });

    it('filters by financial year, status, vertical and owner', async () => {
      const titles = async (qs: string) =>
        (await ok<Pipeline>(get(`/tenant/reports/pipeline?${qs}`))).rows.map((r) => r.title);
      expect(await titles('fy=2025-26')).toEqual(['Clinic interiors, Pune']);
      expect(await titles('fy=2026-27&status=open')).toEqual([
        'Staff quarters, Wardha',
        'Hostel block, Akola',
      ]);
      expect(await titles('status=won')).toEqual(['Clinic interiors, Pune']);
      expect(await titles('vertical=interiors')).toEqual(['Clinic interiors, Pune']);
      expect(await titles(`owner=${ids.owner}`)).toEqual(['Hostel block, Akola']);
      expect((await get('/tenant/reports/pipeline?fy=2026')).statusCode).toBe(400);
    });

    it('hides our bid values from users without the pricing permission', async () => {
      const p = await ok<Pipeline>(get('/tenant/reports/pipeline', worker));
      expect(p.pricingHidden).toBe(true);
      expect(p.rows.every((r) => r.ourBid === null)).toBe(true);
      expect(p.totals.submittedValue).toBeNull();
      expect(p.totals.pipelineValue).toBe('13500.00');
      const head = (wb: ExcelJS.Workbook) => wb.worksheets[0]!.getRow(5).values as unknown[];
      const { wb } = await sheet('/tenant/reports/pipeline/export', worker);
      expect(head(wb)).not.toContain('Our bid (₹)');
      const admin = await sheet('/tenant/reports/pipeline/export?fy=2026-27');
      expect(head(admin.wb)).toContain('Our bid (₹)');
      expect(admin.wb.worksheets[0]!.rowCount).toBe(7);
      expect(admin.wb.worksheets[0]!.getRow(7).getCell(9).value).toBe(9800);
      expect(admin.wb.getWorksheet('By stage')!.getRow(5).values).toEqual([
        undefined,
        'Submitted',
        1,
        10000,
      ]);
    });
  });
});
