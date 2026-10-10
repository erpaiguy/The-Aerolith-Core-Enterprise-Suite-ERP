// A project's macro plan in a real tenant database (docs/wave2a-plan.md step 5): two schedules rolled up through the
// WBS (spans, baseline slip, progress by working days, counts), the same by package, trade and zone, the milestones
// against their baseline dates, archived schedules left out, and the team only.
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

describe.skipIf(!controlUrl || !adminUrl)('macro plans (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-macro-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'macro-admin@example.in');
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
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
  let wbs: Record<string, { id: string }> = {};
  const schedule = async (
    name: string,
    startOn: string,
    rows: object[],
    links: [string, string][],
  ) => {
    let plan = await ok<Plan>(
      post(`/tenant/projects/${projectId}/schedules`, { name, startOn }, manager),
    );
    const ops: object[] = rows.map((r, i) => ({
      op: 'insert',
      tempId: `t${i}`,
      parentId: null,
      afterId: i ? `t${i - 1}` : null,
      ...r,
    }));
    plan = (
      await ok<{ plan: Plan }>(
        post(
          `/tenant/programmes/${plan.id}/changes`,
          { rowVersion: plan.rowVersion, ops },
          manager,
        ),
      )
    ).plan;
    const id = Object.fromEntries(plan.activities.map((a) => [a.code, a.id]));
    if (links.length)
      plan = (
        await ok<{ plan: Plan }>(
          post(
            `/tenant/programmes/${plan.id}/changes`,
            {
              rowVersion: plan.rowVersion,
              ops: links.map(([p, s]) => ({
                op: 'link',
                pred: id[p],
                succ: id[s],
                type: 'FS',
                lag: 0,
              })),
            },
            manager,
          ),
        )
      ).plan;
    return plan;
  };
  interface Row {
    activities: number;
    finished: number;
    inProgress: number;
    start: string | null;
    finish: string | null;
    baselineFinish: string | null;
    progressPct: number | null;
    slipDays: number | null;
  }
  interface Macro {
    project: Row;
    wbs: (Row & { code: string; depth: number })[];
    unassigned: Row | null;
    milestones: {
      code: string;
      date: string;
      baselineDate: string;
      slipDays: number;
      schedule: string;
      wbsCode: string;
    }[];
    byPackage: (Row & { key: string | null })[];
    byTrade: (Row & { key: string | null })[];
    byZone: (Row & { key: string | null })[];
  }
  let civil: Plan;
  let mep: Plan;

  it('rolls two schedules up through the WBS, with the slip against the baseline and progress by days', async () => {
    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tenderId}`;
    projectId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/project`, {}, manager)))
      .id;
    for (const [code, name, parent] of [
      ['1', 'Block A', null],
      ['1.1', 'Foundations', '1'],
      ['1.2', 'Frame', '1'],
      ['2', 'Services', null],
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
    const civilGroup = { package: ' Civil ', trade: 'Concrete', zone: 'Block A' };
    civil = await schedule(
      'Civil',
      '2026-11-02',
      [
        { code: 'F1', name: 'Footings', duration: 5, wbsId: wbs['1.1']!.id, ...civilGroup },
        { code: 'F2', name: 'Columns', duration: 3, wbsId: wbs['1.2']!.id, ...civilGroup },
        {
          code: 'M1',
          name: 'Frame done',
          duration: 0,
          wbsId: wbs['1.2']!.id,
          package: 'Civil',
          trade: '',
        },
      ],
      [
        ['F1', 'F2'],
        ['F2', 'M1'],
      ],
    );
    mep = await schedule(
      'MEP',
      '2026-11-09',
      [
        {
          code: 'E1',
          name: 'Conduits',
          duration: 4,
          wbsId: wbs['2']!.id,
          package: 'MEP',
          trade: 'Electrical',
          zone: 'Block A',
        },
        { code: 'X', name: 'Survey', duration: 2, package: 'MEP' },
      ],
      [],
    );
    // Baseline on Civil, then progress on Thursday the 4th: footings started on the 2nd, four days still to do.
    let p = await ok<Plan>(
      post(`/tenant/programmes/${civil.id}/baselines`, { name: 'Original' }, manager),
    );
    p = await ok<Plan>(
      post(
        `/tenant/programmes/${civil.id}`,
        { rowVersion: p.rowVersion, dataDate: '2026-11-04' },
        manager,
      ),
    );
    const f1 = p.activities.find((a) => a.code === 'F1')!.id;
    await ok(
      post(
        `/tenant/programmes/${civil.id}/changes`,
        {
          rowVersion: p.rowVersion,
          ops: [{ op: 'update', id: f1, progress: { actualStart: '2026-11-02', remaining: 4 } }],
        },
        manager,
      ),
    );

    const m = await ok<Macro>(get(`/tenant/projects/${projectId}/macro`, manager));
    const w = Object.fromEntries(m.wbs.map((r) => [r.code, r]));
    // Footings Mon 2 – Sat 7 (baseline Fri 6); columns Mon 9 – Wed 11 (baseline Tue 10); one day done of five.
    expect(w['1.1']).toMatchObject({
      activities: 1,
      inProgress: 1,
      start: '2026-11-02',
      finish: '2026-11-07',
      baselineFinish: '2026-11-06',
      progressPct: 20,
      slipDays: 1,
    });
    expect(w['1.2']).toMatchObject({
      activities: 2,
      start: '2026-11-09',
      finish: '2026-11-11',
      slipDays: 1,
      progressPct: 0,
    });
    // Block A: one day done of eight.
    expect(w['1']).toMatchObject({
      depth: 0,
      activities: 3,
      start: '2026-11-02',
      finish: '2026-11-11',
      baselineFinish: '2026-11-10',
      progressPct: 12.5,
      slipDays: 1,
    });
    // MEP has no baseline: no slip.
    expect(w['2']).toMatchObject({
      activities: 1,
      start: '2026-11-09',
      finish: '2026-11-12',
      slipDays: null,
    });
    expect(m.unassigned).toMatchObject({
      activities: 1,
      start: '2026-11-09',
      finish: '2026-11-10',
    });
    expect(m.project).toMatchObject({ activities: 5, progressPct: 7.1, finish: '2026-11-12' });
    expect(m.milestones).toMatchObject([
      {
        code: 'M1',
        schedule: 'Civil',
        wbsCode: '1.2',
        date: '2026-11-11',
        baselineDate: '2026-11-10',
        slipDays: 1,
      },
    ]);
  });

  it('sums up by package, trade and zone, and offers the values used', async () => {
    const m = await ok<Macro>(get(`/tenant/projects/${projectId}/macro`, manager));
    expect(m.byPackage.map((r) => [r.key, r.activities])).toEqual([
      ['Civil', 3],
      ['MEP', 2],
    ]);
    // Blank is not set; not set comes last.
    expect(m.byTrade.map((r) => [r.key, r.activities])).toEqual([
      ['Concrete', 2],
      ['Electrical', 1],
      [null, 2],
    ]);
    expect(m.byZone.map((r) => [r.key, r.activities])).toEqual([
      ['Block A', 3],
      [null, 2],
    ]);
    expect(m.byPackage[0]).toMatchObject({
      start: '2026-11-02',
      finish: '2026-11-11',
      slipDays: 1,
    });
    expect(await ok(get(`/tenant/projects/${projectId}/activity-groups`, manager))).toEqual({
      package: ['Civil', 'MEP'],
      trade: ['Concrete', 'Electrical'],
      zone: ['Block A'],
    });
  });

  it('leaves archived schedules out, keeps it to the team, and keeps groups off tender programmes', async () => {
    await ok(post(`/tenant/programmes/${mep.id}/archive`, { archived: true }, manager));
    const m = await ok<Macro>(get(`/tenant/projects/${projectId}/macro`, manager));
    expect(m.project.activities).toBe(3);
    expect(m.unassigned).toBeNull();
    expect((await get(`/tenant/projects/${projectId}/macro`, worker)).statusCode).toBe(404);
    const tp = await ok<Plan>(
      post(`/tenant/tenders/${tenderId}/programmes`, { name: 'Bid', startOn: '2026-11-02' }),
    );
    expect(
      (
        await post(`/tenant/programmes/${tp.id}/changes`, {
          rowVersion: tp.rowVersion,
          ops: [
            {
              op: 'insert',
              tempId: 't1',
              parentId: null,
              afterId: null,
              name: 'X',
              package: 'Civil',
            },
          ],
        })
      ).json(),
    ).toMatchObject({ code: 'not_for_tender_programme' });
  });
});
