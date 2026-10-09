// Dashboards in a real tenant database (docs/wave1-plan.md step 12 part 2): the tender and estimation dashboards'
// headline tiles, charts and filters, each user's own tiles with pricing tiles kept from those without the permission,
// and the Excel export. Dates are set relative to now, so the "next 14 days" tiles have something to count.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import ExcelJS from 'exceljs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import type { EstimationDashboard, TenderDashboard } from '../src/dashboard/dashboard.service.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { financialYear } from '../src/tender/tender-rules.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
const DAY = 86_400_000;
const now = Date.now();
const at = (days: number) => new Date(now + days * DAY);
const date = (days: number) => at(days).toISOString().slice(0, 10);
// Results and submissions ten days ago: their financial year is the one asked for.
const FY = financialYear(at(-10));

describe.skipIf(!controlUrl || !adminUrl)('dashboards (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: Record<string, string>;
  let adminId: string;
  const tenders: Record<string, string> = {};

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  const tile = (d: { fixed: { key: string }[]; tiles: { key: string }[] }, key: string) =>
    [...d.fixed, ...d.tiles].find((x) => x.key === key) as
      { value: string; detail?: string; tone?: string; link?: string } | undefined;

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
    t = await readyTenant(app, control, ENC, 'dashboard-admin@example.in');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    worker = await staff('kavita', 'worker');
    adminId = (await db<{ id: string }[]>`SELECT id FROM platform."user" WHERE role = 'admin'`)[0]!
      .id;

    // Five tenders. Open: lead (₹1,000, due in 5 days, pre-bid in 3), bidding (₹2,000, due in 20), submitted
    // (₹3,000, bid ₹2,900). Decided ten days ago: won (awarded ₹5,000, bid ₹4,800) and lost (bid ₹1,000).
    const tender = async (key: string, title: string, est: string) => {
      tenders[key] = (
        await ok<{ id: string }>(post('/tenant/tenders', { title, estimatedValue: est }))
      ).id;
      return tenders[key];
    };
    const lead = await tender('lead', 'Library, Amravati', '1000');
    const bidding = await tender('bidding', 'Hotel interiors, Nashik', '2000');
    const submitted = await tender('submitted', 'Bus depot, Akola', '3000');
    const won = await tender('won', 'School block, Wardha', '6000');
    const lost = await tender('lost', 'Hospital wing, Yavatmal', '4000');
    await db`UPDATE tender.tender SET owner_id = NULL`;
    await db`UPDATE tender.tender SET owner_id = ${adminId}, vertical = 'buildings',
      submission_due_at = ${at(5)}, prebid_at = ${at(3)} WHERE id = ${lead}`;
    await db`UPDATE tender.tender SET status = 'bidding', vertical = 'interiors', submission_due_at = ${at(20)}
      WHERE id = ${bidding}`;
    await db`UPDATE tender.tender SET status = 'submitted', vertical = 'buildings' WHERE id = ${submitted}`;
    await db`UPDATE tender.tender SET status = 'won', vertical = 'buildings', owner_id = ${adminId},
      result_on = ${date(-10)}, awarded_value = 5000 WHERE id = ${won}`;
    await db`UPDATE tender.tender SET status = 'lost', vertical = 'mep', result_on = ${date(-10)} WHERE id = ${lost}`;
    for (const [id, value] of [
      [submitted, 2900],
      [won, 4800],
      [lost, 1000],
    ] as const)
      await db`INSERT INTO tender.submission (tender_id, submitted_at, mode, bid_value)
        VALUES (${id}, ${at(-10)}, 'portal', ${value})`;
    // A bank guarantee expiring in 10 days, and an EMD still with the client of the tender we lost.
    await db`INSERT INTO tender.security_instrument (tender_id, form, amount, valid_until, status)
      VALUES (${lead}, 'bank_guarantee', 100, ${date(10)}, 'submitted'),
             (${lost}, 'demand_draft', 50, NULL, 'submitted')`;
    // An enquiry out to two vendors, one of whom has quoted.
    const parties = await db<{ id: string }[]>`
      INSERT INTO platform.party (name, is_vendor) VALUES ('Aqua Seal', true), ('Shree Tiles', true) RETURNING id`;
    const [rfq] = await db<{ id: string }[]>`
      INSERT INTO tender.rfq (tender_id, number, title, kind, status, due_on)
      VALUES (${bidding}, 'RFQ/T/0001', 'Waterproofing', 'work', 'sent', ${date(4)}) RETURNING id`;
    await db`INSERT INTO tender.rfq_vendor (rfq_id, party_id, status)
      VALUES (${rfq!.id}, ${parties[0]!.id}, 'quoted'), (${rfq!.id}, ${parties[1]!.id}, 'sent')`;
    await db`INSERT INTO tender.rfq_quote (rfq_id, party_id, received_on, source)
      VALUES (${rfq!.id}, ${parties[0]!.id}, ${date(-1)}, 'typed')`;

    // Estimation: a draft BOQ on the lead tender. Labour analysis: 1 day of mason at ₹1,000 + 10 % = ₹1,100.
    // Items: 2 days from the analysis (2,200), a typed rate (300), one not priced. A BOQ of the won tender is not
    // in progress.
    const res = await ok<{ id: string }>(
      post('/tenant/resources', {
        code: 'MASON',
        name: 'Mason',
        kind: 'labour',
        unit: 'day',
        rate: '1000',
        effectiveFrom: '2020-01-01',
      }),
    );
    const analysis = await ok<{ id: string }>(
      post('/tenant/rate-analyses', {
        code: 'LAB',
        description: 'Mason labour',
        unit: 'day',
        outputQty: '1',
        additions: [{ label: 'Overheads', pct: '10' }],
        lines: [{ kind: 'resource', resourceId: res.id, qty: '1' }],
      }),
    );
    const boq = await ok<{ id: string }>(post(`/tenant/tenders/${lead}/boqs`, { name: 'Civil' }));
    tenders.boq = boq.id;
    await ok(
      post(`/tenant/boqs/${boq.id}/changes`, {
        ops: [
          {
            op: 'insert',
            tempId: 'ta',
            parentId: null,
            afterId: null,
            type: 'item',
            qty: '2',
            rateAnalysisId: analysis.id,
          },
          {
            op: 'insert',
            tempId: 'tb',
            parentId: null,
            afterId: 'ta',
            type: 'item',
            description: 'Curing',
            unit: 'job',
            qty: '1',
            rate: '300',
          },
          {
            op: 'insert',
            tempId: 'tc',
            parentId: null,
            afterId: 'tb',
            type: 'item',
            description: 'Watch and ward',
            unit: 'month',
            qty: '5',
          },
        ],
      }),
    );
    // Frozen once at ₹2,000: the BOQ has grown 25 % since.
    await db`INSERT INTO est.boq_version (boq_id, version_no, kind, total, node_count, item_count, rate_date)
      VALUES (${boq.id}, 1, 'internal', 2000, 3, 3, ${date(0)})`;
    const other = await ok<{ id: string }>(
      post(`/tenant/tenders/${won}/boqs`, { name: 'Won BOQ' }),
    );
    await ok(
      post(`/tenant/boqs/${other.id}/changes`, {
        ops: [
          {
            op: 'insert',
            tempId: 'ta',
            parentId: null,
            afterId: null,
            type: 'item',
            description: 'X',
            unit: 'no',
            qty: '1',
            rate: '999',
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

  describe('tender and bid', () => {
    it('shows the three headline numbers and the charts', async () => {
      const d = await ok<TenderDashboard>(get(`/tenant/dashboards/tender?fy=${FY}`));
      expect(d.fixed.map((x) => x.key)).toEqual([
        'deadlines',
        'pipeline_value',
        'security_expiries',
      ]);
      expect(tile(d, 'deadlines')).toMatchObject({
        value: '1',
        detail: `next on ${at(5).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`,
      });
      expect(tile(d, 'pipeline_value')).toMatchObject({
        value: '6000.00',
        detail: '3 open tenders',
      });
      expect(tile(d, 'security_expiries')).toMatchObject({
        value: '1',
        detail: '₹100',
        tone: 'warning',
      });
      expect(d.tiles).toEqual([]);
      expect(d.filter.fy).toBe(FY);
      expect(Date.parse(d.asOf)).toBeGreaterThan(now - 60_000);

      const stage = (s: string) => d.charts.stages.find((x) => x.status === s);
      expect(stage('lead')).toEqual({ status: 'lead', count: 1, estimatedValue: '1000.00' });
      expect(stage('won')).toMatchObject({ count: 1 });
      expect(stage('no_bid')).toEqual({ status: 'no_bid', count: 0, estimatedValue: '0.00' });
      const sum = (k: 'submitted' | 'won' | 'lost') =>
        d.charts.quarters.reduce((a, q) => a + q[k], 0);
      expect([sum('submitted'), sum('won'), sum('lost')]).toEqual([3, 1, 1]);
      expect(d.charts.quarters.find((q) => q.won === 1)!.wonValue).toBe('5000.00');
      expect(d.charts.verticals).toEqual([
        { vertical: 'buildings', open: 2, won: 1, lost: 0 },
        { vertical: 'interiors', open: 1, won: 0, lost: 0 },
        { vertical: 'mep', open: 0, won: 0, lost: 1 },
      ]);
      expect(d.charts.upcoming.map((u) => [u.kind, u.tender.title])).toEqual([
        ['prebid', 'Library, Amravati'],
        ['submission', 'Library, Amravati'],
        ['security', 'Library, Amravati'],
        ['submission', 'Hotel interiors, Nashik'],
      ]);
      expect(d.charts.rfqs).toEqual([
        expect.objectContaining({ number: 'RFQ/T/0001', vendors: 2, quoted: 1, dueOn: date(4) }),
      ]);
      expect(d.years).toContain(FY);
      expect(d.owners).toEqual([{ id: adminId, name: expect.any(String) }]);
    });

    it('filters by vertical and owner', async () => {
      const v = await ok<TenderDashboard>(
        get(`/tenant/dashboards/tender?fy=${FY}&vertical=interiors`),
      );
      expect(tile(v, 'pipeline_value')!.value).toBe('2000.00');
      expect(tile(v, 'deadlines')!.value).toBe('0');
      const o = await ok<TenderDashboard>(
        get(`/tenant/dashboards/tender?fy=${FY}&owner=${adminId}`),
      );
      expect(tile(o, 'pipeline_value')!.value).toBe('1000.00');
      expect(o.charts.verticals).toEqual([{ vertical: 'buildings', open: 1, won: 1, lost: 0 }]);
      expect((await get('/tenant/dashboards/tender?fy=26-27')).statusCode).toBe(400);
      expect((await get('/tenant/dashboards/sales')).statusCode).toBe(400);
    });

    it("keeps each user's own tiles, and pricing tiles from users without the permission", async () => {
      const admin = await ok<TenderDashboard>(get('/tenant/dashboards/tender'));
      expect(admin.catalogue.map((c) => c.key)).toContain('bid_value_fy');
      const w = await ok<TenderDashboard>(get('/tenant/dashboards/tender', worker));
      expect(w.catalogue.map((c) => c.key)).not.toContain('bid_value_fy');
      expect(w.catalogue.map((c) => c.key)).not.toContain('deadlines');

      await ok(
        post('/tenant/dashboards/tender/tiles', {
          tiles: ['win_rate_fy', 'bid_value_fy', 'securities_to_return', 'rfqs_open'],
        }),
      );
      const d = await ok<TenderDashboard>(get(`/tenant/dashboards/tender?fy=${FY}`));
      expect(d.tiles.map((x) => x.key)).toEqual([
        'win_rate_fy',
        'bid_value_fy',
        'securities_to_return',
        'rfqs_open',
      ]);
      expect(tile(d, 'win_rate_fy')).toMatchObject({ value: '50.0', detail: '1 won of 2' });
      // 2,900 + 4,800 + 1,000
      expect(tile(d, 'bid_value_fy')!.value).toBe('8700.00');
      expect(tile(d, 'securities_to_return')).toMatchObject({ value: '1', detail: '₹50' });
      expect(tile(d, 'rfqs_open')).toMatchObject({ value: '1', detail: '1 of 2 vendors quoted' });
      // Another user's layout is their own.
      expect((await ok<TenderDashboard>(get('/tenant/dashboards/tender', worker))).tiles).toEqual(
        [],
      );

      for (const [tiles, code] of [
        [['bid_value_fy'], 'unknown_tile'],
        [['deadlines'], 'unknown_tile'],
        [['boqs_in_progress'], 'unknown_tile'],
        [['rfqs_open', 'rfqs_open'], 'duplicate_tile'],
      ] as const) {
        const r = await post('/tenant/dashboards/tender/tiles', { tiles }, worker);
        expect(r.statusCode).toBe(400);
        expect(r.json()).toMatchObject({ code });
      }
      await ok(post('/tenant/dashboards/tender/tiles', { tiles: ['open_tenders'] }, worker));
      expect(
        (await ok<TenderDashboard>(get('/tenant/dashboards/tender', worker))).tiles.map(
          (x) => x.key,
        ),
      ).toEqual(['open_tenders']);
    });

    it('downloads as Excel', async () => {
      const r = await get(`/tenant/dashboards/tender/export?fy=${FY}`);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-disposition']).toContain(`Tender dashboard ${FY}.xlsx`);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
      expect(wb.worksheets.map((w) => w.name)).toEqual([
        'Summary',
        'By stage',
        'By quarter',
        'By vertical',
        'Next 30 days',
        'Open RFQs',
      ]);
      expect(wb.getWorksheet('Summary')!.getRow(6).values).toEqual(
        expect.arrayContaining(['Pipeline value', 6000]),
      );
    });
  });

  describe('estimation', () => {
    it('shows BOQs in progress, by estimator, the cost breakdown, revisions and rate changes', async () => {
      const d = await ok<EstimationDashboard>(get('/tenant/dashboards/estimation'));
      expect(d.fixed.map((x) => [x.key, x.value])).toEqual([
        ['boqs_in_progress', '1'],
        ['estimate_value', '2500.00'],
        ['items_unpriced', '1'],
      ]);
      expect(d.charts.estimators).toEqual([
        { id: adminId, name: expect.any(String), boqs: 1, value: '2500.00', unpriced: 1 },
      ]);
      expect(d.charts.topBoqs.map((b) => [b.name, b.total])).toEqual([['Civil', '2500.00']]);
      expect(d.charts.revisions).toEqual([
        expect.objectContaining({
          name: 'Civil',
          versions: 1,
          first: '2000.00',
          current: '2500.00',
          changePct: '25.00',
        }),
      ]);
      expect(
        Object.fromEntries(d.charts.breakdown.parts.map((p) => [p.part, p.amount])),
      ).toMatchObject({
        labour: '2000.00',
        additions: '200.00',
        not_analysed: '300.00',
      });
      expect(d.charts.rateChanges).toEqual([
        expect.objectContaining({
          code: 'MASON',
          rate: '1000.0000',
          previous: null,
          changePct: null,
        }),
      ]);
      const other = await ok<EstimationDashboard>(
        get('/tenant/dashboards/estimation?vertical=mep'),
      );
      expect(other.fixed.map((x) => x.value)).toEqual(['0', '0.00', '0']);
      expect(other.charts.breakdown.total).toBe('0.00');
    });

    it('keeps the cost mix of each BOQ and recomputes it when the BOQ changes', async () => {
      const [cached] = await db<{ stamp: string }[]>`
        SELECT stamp FROM est.boq_cost_mix WHERE boq_id = ${tenders.boq!}`;
      expect(cached).toBeDefined();
      // A cached row that no longer matches its BOQ is never used: say it held a wrong mix.
      await db`UPDATE est.boq_cost_mix SET mix = '[{"a": null, "v": "99999"}]' WHERE boq_id = ${tenders.boq!}`;
      const still = await ok<EstimationDashboard>(get('/tenant/dashboards/estimation'));
      expect(still.charts.breakdown.total).toBe('99999.00'); // the stamp matches, so the (tampered) row is used
      await ok(
        post(`/tenant/boqs/${tenders.boq!}/changes`, {
          ops: [
            {
              op: 'insert',
              tempId: 'td',
              parentId: null,
              afterId: null,
              type: 'item',
              description: 'Signage',
              unit: 'no',
              qty: '1',
              rate: '100',
            },
          ],
        }),
      );
      const d = await ok<EstimationDashboard>(get('/tenant/dashboards/estimation'));
      expect(
        Object.fromEntries(d.charts.breakdown.parts.map((p) => [p.part, p.amount])),
      ).toMatchObject({
        labour: '2000.00',
        additions: '200.00',
        not_analysed: '400.00',
      });
      expect(d.fixed.find((x) => x.key === 'estimate_value')!.value).toBe('2600.00');
    });

    it('adds catalogue tiles of its own dashboard only', async () => {
      await ok(
        post('/tenant/dashboards/estimation/tiles', {
          tiles: [
            'rate_changes_30d',
            'resources_without_rate',
            'versions_frozen_30d',
            'quotes_received_30d',
            'analyses_changed_30d',
          ],
        }),
      );
      const d = await ok<EstimationDashboard>(get('/tenant/dashboards/estimation'));
      expect(d.tiles.map((x) => [x.key, x.value])).toEqual([
        ['rate_changes_30d', '1'],
        ['resources_without_rate', '0'],
        ['versions_frozen_30d', '1'],
        ['quotes_received_30d', '1'],
        ['analyses_changed_30d', '1'],
      ]);
      // The tender dashboard's layout is untouched.
      expect((await ok<TenderDashboard>(get('/tenant/dashboards/tender'))).tiles).toHaveLength(4);
      const r = await post('/tenant/dashboards/estimation/tiles', { tiles: ['win_rate_fy'] });
      expect(r.json()).toMatchObject({ code: 'unknown_tile' });
    });

    it('stays inside the 300 ms rule on this data', async () => {
      const d = await ok<EstimationDashboard>(get('/tenant/dashboards/estimation'));
      const tdash = await ok<TenderDashboard>(get('/tenant/dashboards/tender'));
      expect(d.tookMs).toBeLessThan(300);
      expect(tdash.tookMs).toBeLessThan(300);
    });
  });
});
