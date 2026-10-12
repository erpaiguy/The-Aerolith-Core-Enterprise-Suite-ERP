// Earned value (docs/wave4-plan.md step 3), worked by hand in a real tenant database: a contract BOQ of two items with
// budget lines sharing their keys; a schedule whose two activities carry them, baselined; measurements and costs; PV,
// EV and AC at a date, the indices and the four estimates at completion; the project re-baselined and PV moving;
// the method chosen.
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

describe.skipIf(!controlUrl || !adminUrl)('earned value (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-ev-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'ev-admin@example.in');
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

  type EvReport = {
    baseline: string | null;
    project: Record<string, unknown> & {
      pv: string | null;
      ev: string;
      ac: string;
      spi: string | null;
    };
    byWbs: { name: string; bac: string; pv: string; ev: string; ac: string }[];
    curve: unknown;
  };
  it('works PV, EV and AC, the indices and the estimates, by hand', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    const entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Akola Infra Pvt Ltd',
        gstin: '27AAACA1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const chart = await ok<{ accounts: { id: string; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const acct = (c: string) => chart.accounts.find((a) => a.code === c)!.id;
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Akola' }, manager))
    ).id;
    const boq = async (name: string, kind: string, items: [string, string, string, string][]) => {
      const id = (
        await ok<{ id: string }>(
          post(`/tenant/projects/${projectId}/boqs`, { name, kind }, manager),
        )
      ).id;
      await ok(
        post(
          `/tenant/boqs/${id}/changes`,
          {
            ops: [
              {
                op: 'insert',
                tempId: 'tS',
                parentId: null,
                afterId: null,
                type: 'section',
                code: 'S',
                description: 'Works',
              },
              ...items.map(([code, unit, qty, rate], i) => ({
                op: 'insert',
                tempId: `t${i}`,
                parentId: 'tS',
                afterId: i ? `t${i - 1}` : null,
                type: 'item',
                code,
                description: code,
                unit,
                qty,
                rate,
              })),
            ],
          },
          manager,
        ),
      );
      return id;
    };
    // Contract: A.1 100 cum at ₹1,200, A.2 50 cum at ₹2,000. Budget (the same lines): ₹1,000 and ₹1,500, BAC
    // 1,00,000 + 75,000 = ₹1,75,000.
    const contract = await boq('Contract', 'contract', [
      ['A.1', 'cum', '100', '1200'],
      ['A.2', 'cum', '50', '2000'],
    ]);
    const budget = await boq('Budget', 'budget', [
      ['A.1', 'cum', '100', '1000'],
      ['A.2', 'cum', '50', '1500'],
    ]);
    // As a project made from a tender has them: each budget line shares its contract line's key.
    await db`UPDATE est.boq_node b SET line_key = c.line_key FROM est.boq_node c
      WHERE b.boq_id = ${budget} AND c.boq_id = ${contract} AND c.code = b.code AND b.node_type = 'item'`;

    // The schedule: A.1 on one activity, A.2 on the next, baselined.
    type Plan = { id: string; rowVersion: number; activities: { id: string; code: string }[] };
    let plan = await ok<Plan>(
      post(
        `/tenant/projects/${projectId}/schedules`,
        { name: 'Civil', startOn: '2026-09-01' },
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
              { code: 'E', name: 'Footings', duration: 10 },
              { code: 'C', name: 'Columns', duration: 10 },
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
            ops: [{ op: 'link', pred: act.E, succ: act.C, type: 'FS', lag: 0 }],
          },
          manager,
        ),
      )
    ).plan;
    for (const [a, code] of [
      ['E', 'A.1'],
      ['C', 'A.2'],
    ] as const)
      await ok(
        post(
          `/tenant/programmes/${plan.id}/activities/${act[a]}/lines`,
          { boqId: contract, code },
          manager,
        ),
      );
    const ev = (q = '') =>
      ok<EvReport>(get(`/tenant/projects/${projectId}/earned-value${q}`, manager));
    // Before a baseline: no PV, no SPI.
    expect((await ev('?asOf=2026-09-10')).project).toMatchObject({
      pv: null,
      spi: null,
      bac: '175000.00',
    });
    plan = await ok<Plan>(
      post(`/tenant/programmes/${plan.id}/baselines`, { name: 'Original' }, manager),
    );
    const spans = async () =>
      db<{ code: string; start: string; finish: string }[]>`
        SELECT a.code, to_char(b.start_on, 'YYYY-MM-DD') AS start, to_char(b.finish_on, 'YYYY-MM-DD') AS finish
        FROM sched.plan p JOIN sched.baseline_activity b ON b.plan_id = p.id AND b.baseline_id = p.baseline_id
        JOIN sched.activity a ON a.plan_id = b.plan_id AND a.id = b.activity_id
        WHERE p.id = ${plan.id} ORDER BY a.code DESC`;
    // Monday to Saturday: footings 1–11 September (11 days), columns 12–23 September (12 days).
    expect(await spans()).toEqual([
      { code: 'E', start: '2026-09-01', finish: '2026-09-11' },
      { code: 'C', start: '2026-09-12', finish: '2026-09-23' },
    ]);
    // Footings are the foundations' WBS element.
    await ok(
      post(`/tenant/projects/${projectId}/wbs`, { code: 'F', name: 'Foundations' }, manager),
    );
    const [f] = await db<
      { id: string }[]
    >`SELECT id FROM proj.wbs WHERE project_id = ${projectId} AND code = 'F'`;
    const [a1] = await db<{ sort_key: string }[]>`
      SELECT sort_key FROM est.boq_node WHERE boq_id = ${contract} AND code = 'A.1'`;
    await ok(
      post(
        `/tenant/boqs/${contract}/mapping`,
        { from: a1!.sort_key, to: a1!.sort_key, wbsId: f!.id },
        manager,
      ),
    );

    // Measured: 80 cum of A.1 by the 10th, 10 cum of A.2 on the 15th. Spent: ₹50,000 on the 5th, ₹55,000 on the
    // 14th, ₹10,000 on the 20th.
    const [l1, l2] = (
      await db<{ id: string; code: string }[]>`
        SELECT id::text, code FROM est.boq_node WHERE boq_id = ${contract} AND node_type = 'item' ORDER BY code`
    ).map((x) => x.id);
    await ok(
      post(
        `/tenant/boqs/${contract}/lines/${l1}/progress`,
        { measuredOn: '2026-09-10', qty: '80' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/boqs/${contract}/lines/${l2}/progress`,
        { measuredOn: '2026-09-15', qty: '10' },
        manager,
      ),
    );
    for (const [date, amount] of [
      ['2026-09-05', '50000'],
      ['2026-09-14', '55000'],
      ['2026-09-20', '10000'],
    ])
      await ok(
        post(
          '/tenant/accounts/vouchers',
          {
            entityId,
            type: 'journal',
            date,
            lines: [
              { accountId: acct('X2002'), debit: amount, projectId },
              { accountId: acct('L4004'), credit: amount },
            ],
          },
          manager,
        ),
      );

    // At 16 September. PV: footings all 1,00,000; columns 5 of 12 days of 75,000 = 31,250; 1,31,250. EV: 80 × 1,000
    // + 10 × 1,500 = 95,000. AC: 1,05,000. SPI 95,000 ÷ 1,31,250 = 0.7238; CPI 95,000 ÷ 1,05,000 = 0.9048.
    const r = await ev('?asOf=2026-09-16');
    expect(r.baseline).toBe('Original');
    expect(r.project).toEqual({
      bac: '175000.00',
      pv: '131250.00',
      ev: '95000.00',
      ac: '105000.00',
      sv: '-36250.00',
      cv: '-10000.00',
      spi: '0.7238',
      cpi: '0.9048',
      eac: {
        // 1,75,000 ÷ 0.9048
        cpi: '193412.91',
        // 1,05,000 + 80,000
        budget_rate: '185000.00',
        // 1,05,000 + 80,000 ÷ (0.7238 × 0.9048 = 0.6549)
        cpi_spi: '227156.05',
        // Cost control now: foundations' 1,00,000 still to spend (nothing booked to them), and the rest's 1,15,000
        // spent against 75,000 of budget, nothing more to come.
        bottom_up: '215000.00',
      },
      etc: '88412.91',
      vac: '-18412.91',
      pctPlanned: '75.0',
      pctDone: '54.3',
      pctSpent: '60.0',
    });
    // By WBS: foundations earned 80,000 of 1,00,000 planned and have no cost on them; the rest is off the WBS.
    expect(r.byWbs.map((w) => [w.name, w.bac, w.pv, w.ev, w.ac])).toEqual([
      ['Foundations', '100000.00', '100000.00', '80000.00', '0.00'],
      ['Not on a WBS element', '75000.00', '31250.00', '15000.00', '105000.00'],
    ]);
    expect(r.curve).toEqual({
      months: ['2026-09'],
      pv: ['175000.00'],
      ev: ['95000.00'],
      ac: ['105000.00'],
    });

    // Re-baselined with columns cut to five working days (12–17 September): PV at the 16th is 1,00,000 + 5 of 6 days
    // of 75,000 = 1,62,500; EV and AC do not move.
    plan = (
      await ok<{ plan: Plan }>(
        post(
          `/tenant/programmes/${plan.id}/changes`,
          { rowVersion: plan.rowVersion, ops: [{ op: 'update', id: act.C, duration: 5 }] },
          manager,
        ),
      )
    ).plan;
    plan = await ok<Plan>(
      post(`/tenant/programmes/${plan.id}/baselines`, { name: 'Revised' }, manager),
    );
    const [revised] = await db<{ id: string }[]>`
      SELECT id FROM sched.baseline WHERE plan_id = ${plan.id} AND name = 'Revised'`;
    plan = await ok<Plan>(
      post(
        `/tenant/programmes/${plan.id}`,
        { rowVersion: plan.rowVersion, baselineId: revised!.id },
        manager,
      ),
    );
    expect((await spans())[1]).toEqual({ code: 'C', start: '2026-09-12', finish: '2026-09-17' });
    const again = await ev('?asOf=2026-09-16');
    expect(again.baseline).toBe('Revised');
    expect([again.project.pv, again.project.ev, again.project.ac, again.project.spi]).toEqual([
      '162500.00',
      '95000.00',
      '105000.00',
      '0.5846',
    ]);

    // The method: the worker may not choose; the manager chooses remaining at budget.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/earned-value/method`,
          { method: 'budget_rate' },
          worker,
        )
      ).statusCode,
    ).toBe(404);
    const chosen = await ok<{ method: string; project: { etc: string; vac: string } }>(
      post(`/tenant/projects/${projectId}/earned-value/method`, { method: 'budget_rate' }, manager),
    );
    expect(chosen.method).toBe('budget_rate');
  });
});
