// A project's material budget in a real tenant database (docs/wave2b-plan.md step 2), every figure worked by hand:
// made from the won tender's rate analyses (a mortar inside brickwork, wastage, an analysis changed after the bid), the
// estimate closed, revisions approved and kept, requisitions against the budget, and materials for a BOQ item and for
// the look-ahead.
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

describe.skipIf(!controlUrl || !adminUrl)('material budget (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let projectId: string;
  let tenderId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-budget-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'budget-admin@example.in');
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (
      await ok<{ id: string }>(
        post('/tenant/tenders', { title: 'Hostel, Washim', estimatedValue: '5000000' }),
      )
    ).id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  const ids: Record<string, string> = {};
  const resource = async (code: string, kind: string, unit: string, rate: string) => {
    ids[code] = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code,
          name: code,
          kind,
          unit,
          rate,
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;
  };
  const R = (code: string, qty: string, wastagePct = '0') => ({
    kind: 'resource',
    resourceId: ids[code],
    qty,
    wastagePct,
  });
  interface Line {
    code: string;
    qty: string;
    rate: string | null;
    amount: string | null;
    prevQty: string | null;
    requisitioned: string;
  }
  interface Budget {
    id: string;
    revision: number;
    status: string;
    total: string;
    rowVersion: number;
    basis: { items?: number; changedItems?: number };
    lines: Line[];
    approval: { id: string; status: string } | null;
  }
  const byCode = (b: Budget) => Object.fromEntries(b.lines.map((l) => [l.code, l]));
  let tenderBoq: string;
  let contractId: string;
  let rcc: { id: string; rowVersion: number };

  it("makes the budget from the tender's rate analyses, and closes the estimate", async () => {
    // Cement ₹400 a bag (₹420 from September), sand ₹1,500 a cum, steel ₹70 a kg, a mason ₹900 a day.
    await resource('CEM', 'material', 'bag', '400');
    await ok(
      post(`/tenant/resources/${ids.CEM}/rates`, { effectiveFrom: '2026-09-01', rate: '420' }),
    );
    await resource('SAND', 'material', 'cum', '1500');
    await resource('STL', 'material', 'kg', '70');
    await resource('MASON', 'labour', 'day', '900');
    await resource('WIRE', 'material', 'kg', '90');
    // Mortar 1:4, per cum: 8 bags, 1.1 cum sand. Brickwork, per 10 cum: 2.5 cum mortar + 4%, 12 mason-days, ₹100.
    // RCC, per cum: 8 bags + 2%, 80 kg steel + 5%, 0.45 cum sand.
    const mortar = await ok<{ id: string }>(
      post('/tenant/rate-analyses', {
        code: 'MORTAR-14',
        description: 'Cement mortar 1:4',
        unit: 'cum',
        outputQty: '1',
        additions: [],
        lines: [R('CEM', '8'), R('SAND', '1.1')],
      }),
    );
    const brick = await ok<{ id: string }>(
      post('/tenant/rate-analyses', {
        code: 'BRICK',
        description: 'Brick masonry in CM 1:4',
        unit: 'cum',
        outputQty: '10',
        additions: [],
        lines: [
          { kind: 'analysis', subAnalysisId: mortar.id, qty: '2.5', wastagePct: '4' },
          R('MASON', '12'),
          { kind: 'lump_sum', description: 'Scaffolding', amount: '100' },
        ],
      }),
    );
    rcc = await ok<{ id: string; rowVersion: number }>(
      post('/tenant/rate-analyses', {
        code: 'RCC-M25',
        description: 'RCC M25',
        unit: 'cum',
        outputQty: '1',
        additions: [{ label: 'Profit and overheads', pct: '15' }],
        lines: [R('CEM', '8', '2'), R('STL', '80', '5'), R('SAND', '0.45')],
      }),
    );

    // The tender: brickwork 50 cum, RCC 20 cum, waterproofing 100 sqm with no analysis; rates as on 15 August.
    tenderBoq = (
      await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Civil' }))
    ).id;
    const h = await ok<{ rowVersion: number }>(get(`/tenant/boqs/${tenderBoq}`));
    await ok(
      post(`/tenant/boqs/${tenderBoq}`, { rowVersion: h.rowVersion, rateDate: '2026-08-15' }),
    );
    await ok(
      post(`/tenant/boqs/${tenderBoq}/changes`, {
        ops: [
          {
            op: 'insert',
            tempId: 'tA',
            parentId: null,
            afterId: null,
            type: 'section',
            code: 'A',
            description: 'Building',
          },
          {
            op: 'insert',
            tempId: 'ta1',
            parentId: 'tA',
            afterId: null,
            type: 'item',
            code: 'A.1',
            qty: '50',
            rateAnalysisId: brick.id,
          },
          {
            op: 'insert',
            tempId: 'ta2',
            parentId: 'tA',
            afterId: 'ta1',
            type: 'item',
            code: 'A.2',
            qty: '20',
            rateAnalysisId: rcc.id,
          },
          {
            op: 'insert',
            tempId: 'ta3',
            parentId: 'tA',
            afterId: 'ta2',
            type: 'item',
            code: 'A.3',
            description: 'Waterproofing',
            unit: 'sqm',
            qty: '100',
            rate: '50',
          },
        ],
      }),
    );
    await ok(post(`/tenant/boqs/${tenderBoq}/freeze`, { kind: 'submitted' }));
    // After the bid, someone raises RCC's steel to 85 kg: the budget will take it, and say so.
    const detail = await ok<{ rowVersion: number; lines: object[] }>(
      get(`/tenant/rate-analyses/${rcc.id}`),
    );
    await ok(
      post(`/tenant/rate-analyses/${rcc.id}`, {
        rowVersion: detail.rowVersion,
        code: 'RCC-M25',
        description: 'RCC M25',
        unit: 'cum',
        outputQty: '1',
        additions: [{ label: 'Profit and overheads', pct: '15' }],
        active: true,
        lines: [R('CEM', '8', '2'), R('STL', '85', '5'), R('SAND', '0.45')],
      }),
    );

    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tenderId}`;
    projectId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/project`, {}, manager)))
      .id;
    expect(
      (await post(`/tenant/projects/${projectId}/material-budget/from-tender`, {}, manager)).json(),
    ).toMatchObject({ code: 'no_contract_boq' });
    await ok(post(`/tenant/projects/${projectId}/boqs/from-tender`, {}, manager));
    for (let i = 0; i < 200; i++) {
      const p = await ok<{ copied: boolean }>(
        get(`/tenant/projects/${projectId}/boqs/from-tender`, manager),
      );
      if (p.copied) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    contractId = (
      await ok<{ id: string; kind: string }[]>(get(`/tenant/projects/${projectId}/boqs`, manager))
    ).find((b) => b.kind === 'contract')!.id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    expect(
      (await post(`/tenant/projects/${projectId}/material-budget/from-tender`, {}, worker))
        .statusCode,
    ).toBe(403);

    const b = await ok<Budget>(
      post(`/tenant/projects/${projectId}/material-budget/from-tender`, {}, manager),
    );
    // Per cum of brickwork: 0.26 cum mortar = 2.08 bags and 0.286 cum sand; 1.2 mason-days. Per cum of RCC: 8.16
    // bags, 89.25 kg steel, 0.45 cum sand. Cement 50 × 2.08 + 20 × 8.16 = 267.2 bags; sand 14.3 + 9 = 23.3 cum;
    // steel 1,785 kg; masons 60 days. Rates on 15 August (cement ₹400): ₹3,20,780 in all.
    expect(b).toMatchObject({
      revision: 0,
      status: 'draft',
      total: '320780.00',
      basis: { items: 2, changedItems: 1 },
    });
    expect(byCode(b)).toMatchObject({
      CEM: { qty: '267.2000', rate: '400.0000', amount: '106880.00' },
      SAND: { qty: '23.3000', amount: '34950.00' },
      STL: { qty: '1785.0000', amount: '124950.00' },
      MASON: { qty: '60.0000', amount: '54000.00' },
    });
    const norms = await db<{ code: string; per_unit: string; analysis_changed: boolean }[]>`
      SELECT r.code, n.per_unit::text, n.analysis_changed FROM proj.material_norm n
      JOIN est.resource r ON r.id = n.resource_id WHERE n.project_id = ${projectId} ORDER BY r.code, n.per_unit`;
    expect(norms.map((n) => [n.code, Number(n.per_unit), n.analysis_changed])).toEqual([
      ['CEM', 2.08, false],
      ['CEM', 8.16, true],
      ['MASON', 1.2, false],
      ['SAND', 0.286, false],
      ['SAND', 0.45, true],
      ['STL', 89.25, true],
    ]);
    // Made once; the estimate is closed: kept as it was, never revised again.
    expect(
      (await post(`/tenant/projects/${projectId}/material-budget/from-tender`, {}, manager)).json(),
    ).toMatchObject({ code: 'budget_exists' });
    expect(
      (await post(`/tenant/boqs/${tenderBoq}/revise`, { note: 'one more change' })).json(),
    ).toMatchObject({
      code: 'boq_closed',
      message: expect.stringContaining('Won: the budget of project PRJ/'),
    });
    // With no approval rule for budgets, submitting puts it in force.
    const inForce = await ok<Budget>(
      post(`/tenant/material-budgets/${b.id}/submit`, { rowVersion: b.rowVersion }, manager),
    );
    expect(inForce).toMatchObject({ status: 'approved', approval: { status: 'approved' } });
  });

  it('measures requisitions against the budget, and revises it under approval', async () => {
    // 100 bags approved already; a new requisition for 200 more goes past the 267.2 in the budget.
    const raise = async (qty: string) =>
      ok<{ id: string; rowVersion: number }>(
        post(
          `/tenant/projects/${projectId}/requisitions`,
          { title: `Cement ${qty}`, lines: [{ resourceId: ids.CEM, qty }] },
          worker,
        ),
      );
    const first = await raise('100');
    await ok(
      post(`/tenant/requisitions/${first.id}/submit`, { rowVersion: first.rowVersion }, worker),
    );
    const second = await ok<{
      lines: { budgetQty: string; budgetUsedElsewhere: string; hasBudget: boolean }[];
    }>(get(`/tenant/requisitions/${(await raise('200')).id}`, worker));
    expect(second.lines[0]).toMatchObject({
      budgetQty: '267.2000',
      budgetUsedElsewhere: '100.0000',
      hasBudget: true,
    });
    const ov = await ok<{ inForce: { revision: number }; revisions: unknown[] }>(
      get(`/tenant/projects/${projectId}/material-budget`, worker),
    );
    expect(ov).toMatchObject({ inForce: { revision: 0 } });
    let cur = await ok<Budget>(
      get(`/tenant/material-budgets/${(ov.inForce as unknown as { id: string }).id}`, worker),
    );
    expect(byCode(cur).CEM).toMatchObject({ requisitioned: '100.0000' });
    expect(
      (
        await post(
          `/tenant/material-budgets/${cur.id}`,
          { rowVersion: cur.rowVersion, lines: [] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_editable' });

    // Revision 1: the slab thickened. Cement to 330 bags at today's ₹420, binding wire added, the mason dropped.
    await ok(
      post('/tenant/approval-rules/material_budget', {
        rules: [{ minAmount: '0', approver: 'manager', label: 'Planning' }],
      }),
    );
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/material-budget/revise`,
          { reason: 'Slab' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    let r1 = await ok<Budget>(
      post(
        `/tenant/projects/${projectId}/material-budget/revise`,
        { reason: 'Slab thickened to 150 mm' },
        manager,
      ),
    );
    expect(r1).toMatchObject({ revision: 1, status: 'draft', total: '320780.00' });
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/material-budget/revise`,
          { reason: 'Again' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'revision_open' });
    r1 = await ok<Budget>(
      post(
        `/tenant/material-budgets/${r1.id}`,
        {
          rowVersion: r1.rowVersion,
          reason: 'Slab thickened to 150 mm',
          lines: [
            { resourceId: ids.CEM, qty: '330', rate: '420' },
            { resourceId: ids.SAND, qty: '23.3', rate: '1500' },
            { resourceId: ids.STL, qty: '1785', rate: '70' },
            { resourceId: ids.WIRE, qty: '20', rate: '90' },
          ],
        },
        manager,
      ),
    );
    // 1,38,600 + 34,950 + 1,24,950 + 1,800 = ₹3,00,300; the mason shows as removed (qty 0, was 60).
    expect(r1.total).toBe('300300.00');
    expect(byCode(r1)).toMatchObject({
      CEM: { qty: '330.0000', prevQty: '267.2000' },
      WIRE: { qty: '20.0000', prevQty: null },
      MASON: { qty: '0', amount: null, prevQty: '60.0000' },
    });
    // It takes away overall, but a revision is still approved (for ₹0) when a rule applies from ₹0.
    r1 = await ok<Budget>(
      post(`/tenant/material-budgets/${r1.id}/submit`, { rowVersion: r1.rowVersion }, manager),
    );
    expect(r1).toMatchObject({ status: 'submitted', approval: { status: 'pending' } });
    const req = await ok<{ amount: string; mayAct: boolean }>(
      get(`/tenant/approvals/${r1.approval!.id}`),
    );
    expect(req).toMatchObject({ amount: '0.00', mayAct: true });
    await ok(post(`/tenant/approvals/${r1.approval!.id}/approve`, {}));
    cur = await ok<Budget>(get(`/tenant/material-budgets/${r1.id}`, worker));
    expect(cur.status).toBe('approved');
    const all = await ok<{
      inForce: { revision: number };
      revisions: { revision: number; status: string }[];
    }>(get(`/tenant/projects/${projectId}/material-budget`, worker));
    expect(all.inForce.revision).toBe(1);
    expect(all.revisions.map((x) => [x.revision, x.status])).toEqual([
      [1, 'approved'],
      [0, 'superseded'],
    ]);

    // A revision started and thrown away leaves nothing; one rejected after submission is kept, discarded.
    const r2 = await ok<Budget>(
      post(`/tenant/projects/${projectId}/material-budget/revise`, { reason: 'Try' }, manager),
    );
    await ok(post(`/tenant/material-budgets/${r2.id}/discard`, {}, manager));
    expect((await get(`/tenant/material-budgets/${r2.id}`, manager)).statusCode).toBe(404);
    const r3 = await ok<Budget>(
      post(
        `/tenant/projects/${projectId}/material-budget/revise`,
        { reason: 'More steel' },
        manager,
      ),
    );
    const s3 = await ok<Budget>(
      post(`/tenant/material-budgets/${r3.id}/submit`, { rowVersion: r3.rowVersion }, manager),
    );
    await ok(post(`/tenant/approvals/${s3.approval!.id}/reject`, { comment: 'Not yet' }));
    await ok(post(`/tenant/material-budgets/${r3.id}/discard`, {}, manager));
    expect((await ok<Budget>(get(`/tenant/material-budgets/${r3.id}`, manager))).status).toBe(
      'discarded',
    );
    expect(
      (
        await ok<{ revisions: { revision: number; status: string }[] }>(
          get(`/tenant/projects/${projectId}/material-budget`, manager),
        )
      ).revisions.map((x) => x.status),
    ).toEqual(['discarded', 'approved', 'superseded']);
  });

  it('works out materials for a BOQ item and for the look-ahead', async () => {
    // 10 cum of brickwork: 20.8 bags, 2.86 cum sand, 12 mason-days.
    const item = await ok<{ lines: { code: string; qty: string; budgetQty: string | null }[] }>(
      get(`/tenant/projects/${projectId}/material-demand/item?code=a.1&qty=10`, worker),
    );
    expect(item.lines.map((l) => [l.code, l.qty, l.budgetQty])).toEqual([
      ['CEM', '20.8000', '330.0000'],
      ['SAND', '2.8600', '23.3000'],
      ['MASON', '12.0000', null],
    ]);
    // A schedule whose first activity carries out the RCC; 5 of its 20 cum measured: 15 cum still to do.
    const plan = await ok<{ id: string; rowVersion: number }>(
      post(
        `/tenant/projects/${projectId}/schedules`,
        { name: 'Civil', startOn: '2026-11-02' },
        manager,
      ),
    );
    const withAct = await ok<{ plan: { activities: { id: string; code: string }[] } }>(
      post(
        `/tenant/programmes/${plan.id}/changes`,
        {
          rowVersion: plan.rowVersion,
          ops: [
            {
              op: 'insert',
              tempId: 't0',
              parentId: null,
              afterId: null,
              code: 'C1',
              name: 'Slab',
              duration: 5,
            },
          ],
        },
        manager,
      ),
    );
    const act = withAct.plan.activities.find((a) => a.code === 'C1')!.id;
    await ok(
      post(
        `/tenant/programmes/${plan.id}/activities/${act}/lines`,
        { boqId: contractId, code: 'A.2' },
        manager,
      ),
    );
    const a2 = (
      await db<{ id: string }[]>`SELECT id::text FROM est.boq_node WHERE boq_id = ${contractId}
      AND code = 'A.2'`
    )[0]!.id;
    await ok(
      post(
        `/tenant/boqs/${contractId}/lines/${a2}/progress`,
        { measuredOn: '2026-10-01', qty: '5' },
        manager,
      ),
    );
    const look = await ok<{ items: number; lines: { code: string; qty: string }[] }>(
      get(`/tenant/projects/${projectId}/material-demand/lookahead?weeks=2`, worker),
    );
    // 15 × 8.16 = 122.4 bags, 15 × 89.25 = 1,338.75 kg, 15 × 0.45 = 6.75 cum.
    expect(look.items).toBe(1);
    expect(look.lines.map((l) => [l.code, l.qty])).toEqual([
      ['CEM', '122.4000'],
      ['SAND', '6.7500'],
      ['STL', '1338.7500'],
    ]);
    // A project with no tender starts an empty budget.
    const direct = await ok<{ id: string }>(
      post('/tenant/projects', { name: 'Godown, Karanja' }, manager),
    );
    expect(
      (await post(`/tenant/projects/${direct.id}/material-budget/from-tender`, {}, manager)).json(),
    ).toMatchObject({ code: 'no_tender' });
    expect(
      await ok<Budget>(post(`/tenant/projects/${direct.id}/material-budget/blank`, {}, manager)),
    ).toMatchObject({ revision: 0, total: '0.00', lines: [] });
    // The norms cannot be changed in the database.
    await expect(db`UPDATE proj.material_norm SET per_unit = 1`).rejects.toThrow(
      /permission denied/,
    );
  });
});
