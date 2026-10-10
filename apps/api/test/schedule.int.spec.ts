// Project schedules in a real tenant database (docs/wave2a-plan.md step 4): a schedule laid out on the project's WBS,
// edited and recalculated as tender programmes are, a baseline taken, progress reported as of a data date (a started
// activity carried on by its remaining days, a finished one on its actual dates, nothing after the data date), the
// look-ahead, resources on activities and the resources needed week by week, and who may see and change schedules.
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

describe.skipIf(!controlUrl || !adminUrl)('project schedules (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-schedule-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'schedule-admin@example.in');
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

  interface Activity {
    id: string;
    code: string;
    kind: string;
    wbsCode: string | null;
    earlyStart: string | null;
    earlyFinish: string | null;
    status: string;
    remainingLeft: number | null;
    baselineStart: string | null;
    baselineFinish: string | null;
    critical: boolean;
  }
  interface Plan {
    id: string;
    kind: string;
    rowVersion: number;
    finishOn: string;
    dataDate: string | null;
    baselineId: string | null;
    owner: { kind: string; number: string };
    baselines: { id: string; name: string; finishOn: string }[];
    activities: Activity[];
  }
  const byCode = (p: Plan) => Object.fromEntries(p.activities.map((a) => [a.code, a]));
  const change = (plan: Plan, ops: object[], as = manager) =>
    post(`/tenant/programmes/${plan.id}/changes`, { rowVersion: plan.rowVersion, ops }, as);
  let plan: Plan;
  let wbs: Record<string, { id: string }>;

  it('lays a new schedule out on the project WBS, for the team only', async () => {
    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tenderId}`;
    projectId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/project`, {}, manager)))
      .id;
    for (const [code, name, parent] of [
      ['1', 'Substructure', null],
      ['1.1', 'Excavation', '1'],
      ['2', 'Superstructure', null],
    ] as const) {
      const nodes = await ok<{ id: string; code: string }[]>(
        post(
          `/tenant/projects/${projectId}/wbs`,
          { code, name, parentId: parent ? wbs[parent]!.id : null },
          manager,
        ),
      );
      wbs = Object.fromEntries(nodes.map((n) => [n.code, n]));
    }
    // A worker (no programme rights) on the team as a member may not plan; nobody off the team sees anything.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/schedules`,
          { name: 'x', startOn: '2026-11-02' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    plan = await ok<Plan>(
      post(
        `/tenant/projects/${projectId}/schedules`,
        { name: 'Construction schedule', startOn: '2026-11-02', fromWbs: true },
        manager,
      ),
    );
    expect(plan).toMatchObject({ kind: 'project_schedule', owner: { kind: 'project' } });
    expect(plan.activities.map((a) => [a.code, a.kind, a.wbsCode])).toEqual([
      ['1', 'summary', '1'],
      ['1.1', 'task', '1.1'],
      ['2', 'task', '2'],
    ]);
    expect(
      await ok<unknown[]>(get(`/tenant/projects/${projectId}/schedules`, worker)),
    ).toHaveLength(1);
    await ok(post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: null }, manager));
    expect((await get(`/tenant/programmes/${plan.id}`, worker)).statusCode).toBe(404);
    expect((await get(`/tenant/projects/${projectId}/schedules`, worker)).statusCode).toBe(404);
  });

  it('schedules like a tender programme, and takes a baseline', async () => {
    const a = byCode(plan);
    plan = (
      await ok<{ plan: Plan }>(
        change(plan, [
          { op: 'update', id: a['2']!.id, duration: 4 },
          { op: 'link', pred: a['1.1']!.id, succ: a['2']!.id, type: 'FS', lag: 0 },
        ]),
      )
    ).plan;
    // Site calendar, Mon–Sat: excavation Mon 2 – Fri 6, superstructure Sat 7, Mon 9 – Wed 11.
    expect(byCode(plan)['2']).toMatchObject({
      earlyStart: '2026-11-07',
      earlyFinish: '2026-11-11',
    });
    plan = await ok<Plan>(
      post(`/tenant/programmes/${plan.id}/baselines`, { name: 'Original' }, manager),
    );
    expect(plan.baselines).toMatchObject([{ name: 'Original', finishOn: '2026-11-11' }]);
    expect(plan.baselineId).toBe(plan.baselines[0]!.id);
    expect(byCode(plan)['2']).toMatchObject({
      baselineStart: '2026-11-07',
      baselineFinish: '2026-11-11',
    });
    expect(
      (await post(`/tenant/programmes/${plan.id}/baselines`, { name: 'original' }, manager))
        .statusCode,
    ).toBe(409);
  });

  it('reports progress as of a data date: carried on by remaining days, nothing done after it', async () => {
    plan = await ok<Plan>(
      post(
        `/tenant/programmes/${plan.id}`,
        { rowVersion: plan.rowVersion, dataDate: '2026-11-05' },
        manager,
      ),
    );
    let a = byCode(plan);
    // Started on the 2nd, four days still to do from Thursday the 5th: Thu, Fri, Sat, Mon 9.
    plan = (
      await ok<{ plan: Plan }>(
        change(plan, [
          { op: 'update', id: a['1.1']!.id, progress: { actualStart: '2026-11-02', remaining: 4 } },
        ]),
      )
    ).plan;
    a = byCode(plan);
    expect(a['1.1']).toMatchObject({
      earlyStart: '2026-11-02',
      earlyFinish: '2026-11-09',
      status: 'in_progress',
      remainingLeft: 4,
    });
    // Superstructure slips two days past its baseline.
    expect(a['2']).toMatchObject({
      earlyStart: '2026-11-10',
      earlyFinish: '2026-11-13',
      baselineFinish: '2026-11-11',
    });
    expect(a['1']).toMatchObject({ status: 'in_progress' });
    expect(plan.finishOn).toBe('2026-11-13');
    // Nothing can be done after the data date.
    const late = await change(plan, [
      {
        op: 'update',
        id: a['1.1']!.id,
        progress: { actualStart: '2026-11-02', actualFinish: '2026-11-06' },
      },
    ]);
    expect(late.json()).toMatchObject({ code: 'actual_after_data_date', activities: ['1.1'] });
    // Finished on the 5th: superstructure from Friday the 6th.
    plan = (
      await ok<{ plan: Plan }>(
        change(plan, [
          {
            op: 'update',
            id: a['1.1']!.id,
            progress: { actualStart: '2026-11-02', actualFinish: '2026-11-05' },
          },
        ]),
      )
    ).plan;
    a = byCode(plan);
    expect(a['1.1']).toMatchObject({
      status: 'finished',
      earlyFinish: '2026-11-05',
      remainingLeft: 0,
    });
    expect(a['2']).toMatchObject({ earlyStart: '2026-11-06', earlyFinish: '2026-11-10' });
    // A tender's programme has no progress.
    const tp = await ok<Plan>(
      post(`/tenant/tenders/${tenderId}/programmes`, { name: 'Bid', startOn: '2026-11-02' }),
    );
    const added = (
      await ok<{ plan: Plan }>(
        change(tp, [{ op: 'insert', tempId: 't1', parentId: null, afterId: null, name: 'X' }]),
      )
    ).plan;
    expect(
      (
        await change(added, [
          { op: 'update', id: added.activities[0]!.id, progress: { actualStart: '2026-11-02' } },
        ])
      ).json(),
    ).toMatchObject({ code: 'not_for_tender_programme' });
    expect(
      (
        await post(`/tenant/programmes/${tp.id}`, {
          rowVersion: added.rowVersion,
          dataDate: '2026-11-05',
        })
      ).json(),
    ).toMatchObject({ code: 'not_for_tender_programme' });
  });

  it('shows the look-ahead from the data date', async () => {
    const la = await ok<{
      from: string;
      to: string;
      activities: { code: string; status: string }[];
    }>(get(`/tenant/programmes/${plan.id}/lookahead?weeks=1`, manager));
    expect(la).toMatchObject({ from: '2026-11-05', to: '2026-11-11' });
    // Excavation is finished; superstructure is coming.
    expect(la.activities.map((x) => [x.code, x.status])).toEqual([['2', 'not_started']]);
  });

  it('puts resources on activities and adds up what is needed week by week', async () => {
    const mason = await ok<{ id: string }>(
      post('/tenant/resources', { code: 'L-MASON', name: 'Mason', kind: 'labour', unit: 'day' }),
    );
    const a = byCode(plan);
    expect(
      await ok(
        post(
          `/tenant/programmes/${plan.id}/assignments`,
          { activityId: a['2']!.id, resourceId: mason.id, unitsPerDay: '3' },
          manager,
        ),
      ),
    ).toMatchObject([{ code: 'L-MASON', unitsPerDay: '3.0000' }]);
    expect(
      (
        await post(
          `/tenant/programmes/${plan.id}/assignments`,
          { activityId: a['1']!.id, resourceId: mason.id, unitsPerDay: '2' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_a_task' });
    // Superstructure Fri 6, Sat 7, Mon 9, Tue 10: 2 days in the week of the 2nd, 2 in the week of the 9th.
    const load = await ok<{
      from: string;
      weeks: string[];
      resources: { code: string; byWeek: number[]; total: number }[];
    }>(get(`/tenant/programmes/${plan.id}/resources?weeks=3`, manager));
    expect(load).toMatchObject({
      from: '2026-11-02',
      weeks: ['2026-11-02', '2026-11-09', '2026-11-16'],
    });
    expect(load.resources).toMatchObject([{ code: 'L-MASON', byWeek: [6, 6, 0], total: 12 }]);
    await ok(
      post(
        `/tenant/programmes/${plan.id}/assignments`,
        { activityId: a['2']!.id, resourceId: mason.id, unitsPerDay: null },
        manager,
      ),
    );
    expect(
      await ok(get(`/tenant/programmes/${plan.id}/activities/${a['2']!.id}/resources`, manager)),
    ).toEqual([]);
  });

  it('keeps a WBS element with activities on it', async () => {
    expect((await post(`/tenant/wbs/${wbs['2']!.id}/delete`, {}, manager)).json()).toMatchObject({
      code: 'wbs_in_use',
    });
  });
});
