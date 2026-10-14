// A project's dashboard in a real tenant database (docs/wave2a-plan.md step 7), every figure worked by hand: a
// schedule with a baseline and progress, its activities linked to contract BOQ items that are measured; the money,
// the three progress figures side by side (planned, scheduled, measured), the S-curve (planned, forecast, earned)
// month by month, the look-ahead and the milestones; the progress report as Excel; the team only.
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
import ExcelJS from 'exceljs';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('project dashboard (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let tenderId: string;
  let projectId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-dashboard-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'dashboard-admin@example.in');
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    const client = await ok<{ id: string }>(
      post('/tenant/parties', { name: 'Zilla Parishad Washim', isClient: true }),
    );
    tenderId = (
      await ok<{ id: string }>(
        post('/tenant/tenders', {
          title: 'Primary school, Malegaon',
          clientId: client.id,
          location: 'Malegaon, Washim',
          estimatedValue: '24000000',
        }),
      )
    ).id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  interface Plan {
    id: string;
    rowVersion: number;
    activities: { id: string; code: string }[];
  }
  const line = async (boqId: string, code: string) =>
    (
      await db<
        { id: string }[]
      >`SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND code = ${code}`
    )[0]!.id;

  it('shows the money, progress three ways, the S-curve, the look-ahead and the milestones', async () => {
    // The step 6 contract: A.1 100 cum at 110, A.2 50 cum at 220, B.1 20 cum at 1,100, B.2 a provisional 5,000
    // (estimate rates and a 10% profit): contract 49,000, budget 45,000.
    const civil = (
      await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Civil' }))
    ).id;
    const item = (
      tempId: string,
      parentId: string,
      afterId: string | null,
      code: string,
      qty: string,
      rate: string,
      kind?: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId,
      afterId,
      type: 'item',
      code,
      description: `Item ${code}`,
      unit: kind ? 'LS' : 'cum',
      qty,
      rate,
      ...(kind ? { kind } : {}),
    });
    const section = (
      tempId: string,
      afterId: string | null,
      code: string,
      description: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId: null,
      afterId,
      type: 'section',
      code,
      description,
    });
    await ok(
      post(`/tenant/boqs/${civil}/changes`, {
        ops: [
          section('tA', null, 'A', 'Earthwork'),
          item('ta1', 'tA', null, 'A.1', '100', '100'),
          item('ta2', 'tA', 'ta1', 'A.2', '50', '200'),
          section('tB', 'tA', 'B', 'Concrete'),
          item('tb1', 'tB', null, 'B.1', '20', '1000'),
          item('tb2', 'tB', 'tb1', 'B.2', '1', '5000', 'provisional'),
        ],
      }),
    );
    await ok(
      post(`/tenant/boqs/${civil}/scenarios`, {
        name: 'Bid',
        markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '10' }],
      }),
    );
    await ok(post(`/tenant/boqs/${civil}/freeze`, { kind: 'submitted' }));
    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tenderId}`;
    projectId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/project`, {}, manager)))
      .id;

    // Nothing yet: no BOQs, no schedules, no curve.
    const empty = await ok<{ curve: unknown; schedules: unknown[]; money: { contract: string } }>(
      get(`/tenant/projects/${projectId}/dashboard`, manager),
    );
    expect(empty).toMatchObject({ curve: null, schedules: [], money: { contract: '0' } });

    await ok(post(`/tenant/projects/${projectId}/boqs/from-tender`, {}, manager));
    for (let i = 0; i < 200; i++) {
      const p = await ok<{ copied: boolean }>(
        get(`/tenant/projects/${projectId}/boqs/from-tender`, manager),
      );
      if (p.copied) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const boqs = await ok<{ id: string; kind: string }[]>(
      get(`/tenant/projects/${projectId}/boqs`, manager),
    );
    const contractId = boqs.find((b) => b.kind === 'contract')!.id;

    // A schedule on the site calendar (Mon–Sat, Gandhi Jayanti on Friday 2 October a holiday) from Monday 21
    // September: earthwork, six days (21–26 Sep), then concrete, six days (28, 29, 30 Sep, 1, 3, 5 Oct), then the
    // slab milestone (5 Oct).
    let plan = await ok<Plan>(
      post(
        `/tenant/projects/${projectId}/schedules`,
        { name: 'Civil', startOn: '2026-09-21' },
        manager,
      ),
    );
    plan = (
      await ok<{ plan: Plan }>(
        post(
          `/tenant/programmes/${plan.id}/changes`,
          {
            rowVersion: plan.rowVersion,
            ops: [
              { code: 'E', name: 'Earthwork', duration: 6 },
              { code: 'C', name: 'Concrete', duration: 6 },
              { code: 'M', name: 'Slab cast', duration: 0 },
            ].map((r, i) => ({
              op: 'insert',
              tempId: `t${i}`,
              parentId: null,
              afterId: i ? `t${i - 1}` : null,
              ...r,
            })),
          },
          manager,
        ),
      )
    ).plan;
    const act = Object.fromEntries(plan.activities.map((a) => [a.code, a.id]));
    plan = (
      await ok<{ plan: Plan }>(
        post(
          `/tenant/programmes/${plan.id}/changes`,
          {
            rowVersion: plan.rowVersion,
            ops: [
              ['E', 'C'],
              ['C', 'M'],
            ].map(([p, s]) => ({ op: 'link', pred: act[p!], succ: act[s!], type: 'FS', lag: 0 })),
          },
          manager,
        ),
      )
    ).plan;
    // Earthwork carries out section A (22,000); concrete carries out B.1 (22,000). B.2 is on no activity.
    await ok(
      post(
        `/tenant/programmes/${plan.id}/activities/${act.E}/lines`,
        { boqId: contractId, code: 'A' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/programmes/${plan.id}/activities/${act.C}/lines`,
        { boqId: contractId, code: 'B.1' },
        manager,
      ),
    );
    // The baseline, then progress as of Thursday 1 October: earthwork done 21–26 Sep; concrete started on the 28th
    // with four days left (1, 3, 5, 6 Oct), so it and the milestone finish a day late.
    plan = await ok<Plan>(
      post(`/tenant/programmes/${plan.id}/baselines`, { name: 'Original' }, manager),
    );
    plan = await ok<Plan>(
      post(
        `/tenant/programmes/${plan.id}`,
        { rowVersion: plan.rowVersion, dataDate: '2026-10-01' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/programmes/${plan.id}/changes`,
        {
          rowVersion: plan.rowVersion,
          ops: [
            {
              op: 'update',
              id: act.E,
              progress: { actualStart: '2026-09-21', actualFinish: '2026-09-26' },
            },
            { op: 'update', id: act.C, progress: { actualStart: '2026-09-28', remaining: 4 } },
          ],
        },
        manager,
      ),
    );

    // Measured: A.1 40 on 31 Aug (4,400) and 60 on 24 Sep (6,600); A.2 60 on 26 Sep (13,200, 10 beyond its 50);
    // B.1 5 on 1 Oct (5,500). Value done 29,700.
    for (const [code, measuredOn, qty] of [
      ['A.1', '2026-08-31', '40'],
      ['A.1', '2026-09-24', '60'],
      ['A.2', '2026-09-26', '60'],
      ['B.1', '2026-10-01', '5'],
    ] as const) {
      const id = await line(contractId, code);
      await ok(
        post(`/tenant/boqs/${contractId}/lines/${id}/progress`, { measuredOn, qty }, manager),
      );
    }

    interface Dash {
      asOf: string;
      money: { contract: string; budget: string; margin: string; marginPct: string };
      progress: { total: { done: string; period: string; pct: number; itemsOver: number } };
      schedules: Record<string, unknown>[];
      curve: {
        months: string[];
        planned: number[];
        forecast: number[];
        earned: (number | null)[];
        linkedValue: string;
      };
      lookahead: { days: number; activities: { code: string; status: string }[]; more: boolean };
      milestones: { code: string; date: string; baselineDate: string; slipDays: number }[];
    }
    const d = await ok<Dash>(get(`/tenant/projects/${projectId}/dashboard`, manager));
    expect(d.money).toMatchObject({
      contract: '49000.00',
      budget: '45000.00',
      margin: '4000.00',
      marginPct: '8.16',
    });
    // Physical: 11,000 + 11,000 (A.2 capped at its 50) + 5,500 = 27,500 of 49,000 = 56.1%.
    expect(d.progress.total).toMatchObject({ done: '29700.00', pct: 56.1, itemsOver: 1 });
    expect(d.progress.total.period).toBe(d.asOf.slice(0, 7) === '2026-10' ? '5500.00' : '0.00');

    // Planned at 1 Oct: earthwork all of its 6 days, concrete 3 of its 6 working days: 9 of 12 = 75% (counting
    // calendar days would give 68.8%: the holiday is inside concrete's span).
    // Scheduled: 6 + (6 − 4 left) = 8 of 12 = 66.7%. Measured on the linked items: 27,500 of 44,000 = 62.5%.
    expect(d.schedules).toEqual([
      expect.objectContaining({
        name: 'Civil',
        dataDate: '2026-10-01',
        finish: '2026-10-06',
        baselineName: 'Original',
        baselineFinish: '2026-10-05',
        slipDays: 1,
        activities: 3,
        finished: 1,
        inProgress: 1,
        lateToBaseline: 0,
        plannedPct: 75,
        scheduledPct: 66.7,
        measuredPct: 62.5,
        linkedValue: '44000.00',
      }),
    ]);

    // The S-curve from August (the first measurement) to this month, by working days. Planned: earthwork's 22,000
    // in September, concrete's 22,000 over its six baseline days, three in each month. Forecast: concrete over seven
    // days now (28 Sep – 6 Oct), three in September (9,428.57). Earned: 4,400 in August, 24,200 by September,
    // 29,700 by October.
    const months = d.curve.months;
    expect(months.slice(0, 3)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(months.at(-1)).toBe(d.asOf.slice(0, 7) > '2026-10' ? d.asOf.slice(0, 7) : '2026-10');
    expect(d.curve.linkedValue).toBe('44000.00');
    expect(d.curve.planned.slice(0, 3)).toEqual([0, 33000, 44000]);
    expect(d.curve.forecast.slice(0, 3)).toEqual([0, 31428.57, 44000]);
    expect(d.curve.earned.slice(0, 3)).toEqual([4400, 24200, 29700]);
    expect(d.curve.earned.at(-1)).toBe(29700);

    // The next two weeks from the data date: concrete going and the milestone; earthwork is done.
    expect(d.lookahead.activities.map((a) => a.code)).toEqual(['C', 'M']);
    expect(d.milestones).toEqual([
      expect.objectContaining({
        code: 'M',
        date: '2026-10-06',
        baselineDate: '2026-10-05',
        slipDays: 1,
      }),
    ]);
  });

  it('exports the progress report as Excel, and keeps the dashboard to the team', async () => {
    const res = await get(
      `/tenant/projects/${projectId}/progress/export?from=2026-09-01&to=2026-09-30`,
      manager,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('progress to 2026-09-30');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('By BOQ section')!;
    const rows: unknown[][] = [];
    ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    // To 30 September: A.1 100 (11,000), A.2 60 (13,200): section A 24,200, all of it this period but August's 4,400.
    const earthwork = rows.find((r) => r[1] === 'Earthwork')!;
    expect(earthwork.slice(2, 6)).toEqual([22000, 24200, 100, 19800]);
    const total = rows.find((r) => r[1] === 'Project total')!;
    expect(total.slice(2, 4)).toEqual([49000, 24200]);

    // A worker not on the team does not see the project; nor its dashboard or report.
    expect((await get(`/tenant/projects/${projectId}/dashboard`, worker)).statusCode).toBe(404);
    expect((await get(`/tenant/projects/${projectId}/progress/export`, worker)).statusCode).toBe(
      404,
    );
    // A viewer on the team sees both.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect((await get(`/tenant/projects/${projectId}/dashboard`, worker)).statusCode).toBe(200);
  });

  it("proposes a month's quantities from the daily reports, accepted into the book as reviewed", async () => {
    // docs/wave7-plan.md step 7c.1: two July reports with A.1 done (7 + 5 cum) and one line of no BOQ item.
    const siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Akola', stateCode: '27' }, manager),
      )
    ).sites.at(-1)!.id;
    interface Report {
      id: string;
      rowVersion: number;
    }
    const day = async (reportDate: string, work: object[]) => {
      let r = await ok<Report>(
        post(`/tenant/projects/${projectId}/daily-reports`, { siteId, reportDate }, manager),
      );
      r = await ok<Report>(
        post(`/tenant/daily-reports/${r.id}`, { rowVersion: r.rowVersion, work }, manager),
      );
      return ok<Report>(
        post(`/tenant/daily-reports/${r.id}/submit`, { rowVersion: r.rowVersion }, manager),
      );
    };
    await day('2026-07-10', [
      { description: 'Excavation, grid A', qty: '7', unit: 'cum', boqCode: 'A.1' },
      { description: 'Site cleaning', qty: '1', unit: 'job' },
    ]);
    await day('2026-07-11', [
      { description: 'Excavation, grid B', qty: '5', unit: 'cum', boqCode: 'A.1' },
    ]);
    // A draft does not count.
    await ok(
      post(
        `/tenant/projects/${projectId}/daily-reports`,
        { siteId, reportDate: '2026-07-12' },
        manager,
      ),
    );

    interface Proposal {
      bookOn: string;
      lines: {
        boqId: string;
        lineKey: string;
        code: string;
        reported: string;
        measured: string;
        proposed: string;
        reports: number;
      }[];
      mayAccept: boolean;
    }
    const proposal = () =>
      ok<Proposal>(get(`/tenant/projects/${projectId}/mb-proposal?month=2026-07`, manager));
    let p = await proposal();
    expect(p.bookOn).toBe('2026-07-31');
    expect(p.lines.map((l) => [l.code, l.reported, l.measured, l.proposed, l.reports])).toEqual([
      ['A.1', '12.0000', '0', '12.0000', 2],
    ]);
    expect(
      (await get(`/tenant/projects/${projectId}/mb-proposal?month=2099-01`, manager)).statusCode,
    ).toBe(400);

    // Reviewed down to 10: the book has 10 on 31 July, and 2 are still proposed.
    const line = p.lines[0]!;
    p = await ok<Proposal>(
      post(
        `/tenant/projects/${projectId}/mb-proposal`,
        { month: '2026-07', lines: [{ boqId: line.boqId, lineKey: line.lineKey, qty: '10' }] },
        manager,
      ),
    );
    expect(p.lines.map((l) => [l.code, l.measured, l.proposed])).toEqual([
      ['A.1', '10.0000', '2.0000'],
    ]);
    const [m] = await db<{ measured_on: string; qty: string; description: string }[]>`
      SELECT to_char(measured_on, 'YYYY-MM-DD') AS measured_on, qty::text, description FROM proj.measurement
      WHERE project_id = ${projectId} AND description LIKE 'From the daily reports%'`;
    expect(m).toEqual({
      measured_on: '2026-07-31',
      qty: '10.0000',
      description: 'From the daily reports of 2026-07',
    });
    // A viewer may look, not accept.
    expect(
      (await get(`/tenant/projects/${projectId}/mb-proposal?month=2026-07`, worker)).statusCode,
    ).toBe(200);
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/mb-proposal`,
          { month: '2026-07', lines: [{ boqId: line.boqId, lineKey: line.lineKey, qty: '2' }] },
          worker,
        )
      ).statusCode,
    ).toBe(403);
  });
});
