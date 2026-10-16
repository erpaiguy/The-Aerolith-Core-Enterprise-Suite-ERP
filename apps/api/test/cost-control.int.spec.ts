// Cost control (docs/wave4-plan.md step 1), worked by hand in a real tenant database: a budget mapped to three cost
// codes and two WBS elements, the original budget taken and a line added after; cement ordered from a requisition and
// part-billed (moving cost from committed to actual) with a debit note; a work order charged by the company default
// then placed on a WBS element; a labour bill without an order unallocated, then allocated; payroll on its default; a
// manual journal with its cost code; cost to complete entered; the month closed and compared; both alerts; and the
// actual agreeing with the project P&L.
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
import type { TenantClaims } from '../src/auth/auth.service.js';
import { LedgerService } from '../src/accounts/ledger.service.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('cost control (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let managerId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-cost-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'cost-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
    managerId = m.id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('works budget, committed, actual and forecast by cost code and WBS element, by hand', async () => {
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
    for (const [code, name, kind] of [
      ['MAT', 'Materials', 'material'],
      ['LAB', 'Labour', 'labour'],
      ['SUBC', 'Subcontracts', 'subcontract'],
      ['STF', 'Site staff', 'overhead'],
    ])
      await ok(post('/tenant/cost-codes', { code, name, kind }, manager));
    const cc = Object.fromEntries(
      (await ok<{ id: string; code: string }[]>(get('/tenant/cost-codes'))).map((c) => [
        c.code,
        c.id,
      ]),
    );
    const vendor = async (body: object) =>
      (
        await ok<{ id: string }>(
          post('/tenant/parties', { isClient: false, isVendor: true, ...body }),
        )
      ).id;
    const vidarbha = await vendor({ name: 'Vidarbha Cement', gstin: '27AAACV1234F1Z5' });
    const kale = await vendor({ name: 'Kale Waterproofing', gstin: '27ABCPK1234L1Z5' });
    const shinde = await vendor({ name: 'Shinde Labour Supply', pan: 'ABCPS1234K' });

    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Akola' }, manager))
    ).id;
    const site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Akola', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    for (const [code, name] of [
      ['SUB', 'Substructure'],
      ['SUP', 'Superstructure'],
    ])
      await ok(post(`/tenant/projects/${projectId}/wbs`, { code, name }, manager));
    const wbs = Object.fromEntries(
      (
        await db<
          { id: string; code: string }[]
        >`SELECT id, code FROM proj.wbs WHERE project_id = ${projectId}`
      ).map((w) => [w.code, w.id]),
    );
    const boq = async (
      name: string,
      kind: 'contract' | 'budget',
      items: [string, string, string, string, string][],
    ) => {
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
              ...items.map(([code, description, unit, qty, rate], i) => ({
                op: 'insert',
                tempId: `t${i}`,
                parentId: 'tS',
                afterId: i ? `t${i - 1}` : null,
                type: 'item',
                code,
                description,
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
    const map = async (boqId: string, code: string, wbsId: string | null, costCodeId: string) => {
      const [n] = await db<{ sort_key: string }[]>`
        SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId} AND code = ${code}`;
      await ok(
        post(
          `/tenant/boqs/${boqId}/mapping`,
          { from: n!.sort_key, to: n!.sort_key, wbsId, costCodeId },
          manager,
        ),
      );
    };
    // The contract's RCC is substructure materials, so a requisition for it is too.
    const contract = await boq('Contract', 'contract', [['A.1', 'RCC M25', 'cum', '100', '4000']]);
    await map(contract, 'A.1', wbs.SUB!, cc.MAT!);
    // Budget 3,00,000 + 1,00,000 + 50,000 + 60,000 = 5,10,000.
    const budget = await boq('Budget', 'budget', [
      ['B.1', 'Concrete materials', 'cum', '100', '3000'],
      ['B.2', 'Brickwork labour', 'sqm', '200', '500'],
      ['B.3', 'Waterproofing', 'job', '1', '50000'],
      ['B.4', 'Site staff', 'LS', '1', '60000'],
    ]);
    await map(budget, 'B.1', wbs.SUB!, cc.MAT!);
    await map(budget, 'B.2', wbs.SUP!, cc.LAB!);
    await map(budget, 'B.3', wbs.SUB!, cc.SUBC!);
    await map(budget, 'B.4', null, cc.STF!);
    const original = await ok<{ totals: { original: string; budget: string } }>(
      post(`/tenant/projects/${projectId}/cost-control/baseline`, {}, manager),
    );
    expect(original.totals).toMatchObject({ original: '510000.00', budget: '510000.00' });
    expect(
      (await post(`/tenant/projects/${projectId}/cost-control/baseline`, {}, manager)).json(),
    ).toMatchObject({ code: 'baselined' });
    // Then ₹10,000 more waterproofing: an approved change on substructure subcontracts.
    const [last] = await db<{ id: string }[]>`
      SELECT id::text FROM est.boq_node WHERE boq_id = ${budget} AND code = 'B.4'`;
    const [section] = await db<{ id: string }[]>`
      SELECT id::text FROM est.boq_node WHERE boq_id = ${budget} AND code = 'S'`;
    await ok(
      post(
        `/tenant/boqs/${budget}/changes`,
        {
          ops: [
            {
              op: 'insert',
              tempId: 'tX',
              parentId: section!.id,
              afterId: last!.id,
              type: 'item',
              code: 'B.5',
              description: 'Extra waterproofing',
              unit: 'job',
              qty: '1',
              rate: '10000',
            },
          ],
        },
        manager,
      ),
    );
    await map(budget, 'B.5', wbs.SUB!, cc.SUBC!);

    // Cement: 500 bags at ₹380 ordered (1,90,000) from a requisition for the RCC; the material budget has it at ₹370.
    const cement = (
      await ok<{ id: string }>(
        post(
          '/tenant/resources',
          {
            code: 'CEM',
            name: 'Cement OPC 53',
            kind: 'material',
            unit: 'bag',
            rate: '370',
            effectiveFrom: '2026-01-01',
          },
          manager,
        ),
      )
    ).id;
    const [mb] = await db<{ id: string }[]>`
      INSERT INTO proj.material_budget (project_id, revision, status, source, total, approved_at)
      VALUES (${projectId}, 0, 'approved', 'blank', 185000, now()) RETURNING id`;
    await db`INSERT INTO proj.material_budget_line (budget_id, resource_id, code, name, kind, unit, qty, rate, amount)
      VALUES (${mb!.id}, ${cement}, 'CEM', 'Cement OPC 53', 'material', 'bag', 500, 370, 185000)`;
    const req = await ok<{ id: string; rowVersion: number }>(
      post(
        `/tenant/projects/${projectId}/requisitions`,
        {
          title: 'Raft cement',
          siteId: site,
          lines: [{ resourceId: cement, qty: '500', boqCode: 'A.1' }],
        },
        manager,
      ),
    );
    await ok(
      post(`/tenant/requisitions/${req.id}/submit`, { rowVersion: req.rowVersion }, manager),
    );
    const rfq = await ok<{ lines: { id: string }[] }>(
      post(
        `/tenant/projects/${projectId}/rfqs`,
        { title: 'Raft cement', requisitionIds: [req.id] },
        manager,
      ),
    );
    const order = async (kind: 'purchase' | 'work', partyId: string, line: object) => {
      const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
        post(
          `/tenant/projects/${projectId}/orders`,
          { kind, partyId, siteId: site, lines: [line] },
          manager,
        ),
      );
      const issued = await ok<{
        id: string;
        number: string;
        inForce: { lines: { lineKey: string }[] };
      }>(
        post(
          `/tenant/order-revisions/${o.open.id}/submit`,
          // The cement is quoted above the estimate's rate (docs/wave8-plan.md step 8a.4).
          { rowVersion: o.open.rowVersion, overBudgetReason: 'Quoted above the estimate rate' },
          manager,
        ),
      );
      return { id: issued.id, number: issued.number, key: issued.inForce.lines[0]!.lineKey };
    };
    const po = await order('purchase', vidarbha, {
      resourceId: cement,
      rfqLineId: rfq.lines[0]!.id,
      description: 'Cement OPC 53',
      unit: 'bag',
      qty: '500',
      rate: '380',
      gstPct: '28',
    });
    // Waterproofing of the raft, ₹65,000: a work order with no requisition, so charged by the company's default.
    const wo = await order('work', kale, {
      description: 'Waterproofing of the raft',
      unit: 'job',
      qty: '1',
      rate: '65000',
      gstPct: '18',
    });
    await ok(post('/tenant/cost-control/defaults/subcontract', { costCodeId: cc.SUBC }, manager));
    await ok(post('/tenant/cost-control/defaults/payroll', { costCodeId: cc.STF }, manager));
    expect(
      (await post('/tenant/cost-control/defaults/payroll', { costCodeId: cc.STF }, worker))
        .statusCode,
    ).toBe(403);

    // 300 bags received and billed: 1,14,000 moves from committed to actual (76,000 left on order); 10 bags back on a
    // debit note, ₹3,800 off actual.
    await ok(
      post(
        `/tenant/orders/${po.id}/receipts`,
        { receivedOn: '2026-09-02', challanNo: 'DC-1', lines: [{ lineKey: po.key, qty: '300' }] },
        manager,
      ),
    );
    const vbill = (body: object) =>
      ok<{ id: string; status: string }>(
        post(
          '/tenant/accounts/vendor-bills',
          { entityId, projectId: null, tdsSection: null, ...body },
          manager,
        ),
      );
    const bill = await vbill({
      partyId: vidarbha,
      orderId: po.id,
      billNo: 'VC/88',
      billDate: '2026-09-05',
      dueDate: '2026-10-05',
      lines: [{ lineKey: po.key, qty: '300', rate: '380' }],
    });
    expect(bill.status).toBe('posted');
    await ok(
      post(
        `/tenant/accounts/vendor-bills/${bill.id}/debit-notes`,
        { date: '2026-09-10', reason: '10 bags set hard', taxable: '3800', gstPct: '28' },
        manager,
      ),
    );
    // Brickwork labour without an order, ₹40,000: nothing says where it belongs.
    const labour = await vbill({
      partyId: shinde,
      projectId,
      billNo: 'SLS/9',
      billDate: '2026-09-15',
      dueDate: '2026-10-15',
      lines: [
        {
          accountId: acct('X2002'),
          description: 'Brickwork labour, September',
          qty: '1',
          rate: '40000',
          gstPct: '0',
        },
      ],
    });
    expect(labour.status).toBe('posted');
    // A journal of ₹5,000 for labour, typed with its cost code; payroll's ₹25,000 for the project, on its default.
    await ok(
      post(
        '/tenant/accounts/vouchers',
        {
          entityId,
          type: 'journal',
          date: '2026-09-20',
          narration: 'Gang overtime',
          lines: [
            { accountId: acct('X2002'), debit: '5000', projectId, costCodeId: cc.LAB },
            { accountId: acct('L4004'), credit: '5000' },
          ],
        },
        manager,
      ),
    );
    const ledger = app.get(LedgerService);
    await db.begin((tx) =>
      ledger.post(
        tx,
        { sub: managerId } as TenantClaims,
        {
          entityId,
          type: 'journal',
          date: '2026-09-30',
          narration: 'Salaries, September',
          reference: '',
          lines: [
            {
              accountId: acct('X4001'),
              partyId: null,
              debit: '25000',
              credit: '0',
              projectId,
              siteId: null,
              costCodeId: null,
              note: '',
            },
            {
              accountId: acct('L4006'),
              partyId: null,
              debit: '0',
              credit: '25000',
              projectId: null,
              siteId: null,
              costCodeId: null,
              note: '',
            },
          ],
        },
        { kind: 'payroll_run', id: projectId },
      ),
    );

    type Report = {
      rows: Record<string, unknown>[] & { key: string; forecast: string }[];
      totals: Record<string, string>;
      unallocated: { orderLines: number; ledgerLines: number };
      alerts: { overBudget: { costCode: { code: string }; over: string }[]; rates: unknown[] };
      months: string[];
      compared: { month: string; rows: Record<string, { forecast: string }> } | null;
      mayForecast: boolean;
    };
    const report = (q = '') =>
      ok<Report>(get(`/tenant/projects/${projectId}/cost-control${q}`, manager));
    const k = (w: string | null, c: string) => `${w ? wbs[w] : ''}|${cc[c]}`;
    const before = await report();
    expect(before.unallocated).toEqual({ orderLines: 0, ledgerLines: 1 });
    const loose = await ok<{
      ledgerLines: { voucherId: string; position: number; amount: string }[];
    }>(get(`/tenant/projects/${projectId}/cost-control/documents?unallocated=true`, manager));
    expect(loose.ledgerLines.map((l) => l.amount)).toEqual(['40000.00']);
    await ok(
      post(
        `/tenant/projects/${projectId}/cost-control/allocations`,
        {
          target: {
            voucherId: loose.ledgerLines[0]!.voucherId,
            position: loose.ledgerLines[0]!.position,
          },
          wbsId: wbs.SUP,
          costCodeId: cc.LAB,
          note: 'Brickwork, first floor',
        },
        manager,
      ),
    );
    // The work order is the raft's: placed on the substructure, its cost code still the default.
    await ok(
      post(
        `/tenant/projects/${projectId}/cost-control/allocations`,
        { target: { poId: wo.id, lineKey: wo.key }, wbsId: wbs.SUB },
        manager,
      ),
    );
    // Planning: ₹2,00,000 more on substructure materials.
    await ok(
      post(
        `/tenant/projects/${projectId}/cost-control/ctc`,
        { key: k('SUB', 'MAT'), amount: '200000', note: 'Raft and plinth beams still to pour' },
        manager,
      ),
    );

    const r = await report();
    const pick = (x: Record<string, unknown>) => [
      x.original,
      x.budget,
      x.changes,
      x.committed,
      x.actual,
      x.ctc,
      x.ctcComputed,
      x.forecast,
      x.variance,
    ];
    expect(Object.fromEntries(r.rows.map((x) => [x.key, pick(x)]))).toEqual({
      // Labour: 40,000 spent of 1,00,000; 60,000 left (computed); on budget.
      [k('SUP', 'LAB')]: [
        '100000.00',
        '100000.00',
        '0.00',
        '0.00',
        '40000.00',
        '60000.00',
        true,
        '100000.00',
        '0.00',
      ],
      // The journal's 5,000, with no budget: 5,000 over.
      [k(null, 'LAB')]: [
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '5000.00',
        '0.00',
        true,
        '5000.00',
        '-5000.00',
      ],
      // Materials: 1,14,000 − 3,800 = 1,10,200 spent, 76,000 still on order, 2,00,000 entered: 3,10,200, 10,200 over.
      [k('SUB', 'MAT')]: [
        '300000.00',
        '300000.00',
        '0.00',
        '76000.00',
        '110200.00',
        '200000.00',
        false,
        '310200.00',
        '-10200.00',
      ],
      // Staff: 25,000 of 60,000.
      [k(null, 'STF')]: [
        '60000.00',
        '60000.00',
        '0.00',
        '0.00',
        '25000.00',
        '35000.00',
        true,
        '60000.00',
        '0.00',
      ],
      // Waterproofing: 50,000 + 10,000 changed = 60,000; 65,000 ordered, more than what is left: 5,000 over.
      [k('SUB', 'SUBC')]: [
        '50000.00',
        '60000.00',
        '10000.00',
        '65000.00',
        '0.00',
        '65000.00',
        true,
        '65000.00',
        '-5000.00',
      ],
    });
    expect(r.rows.map((x) => x.key)).toEqual([
      k('SUP', 'LAB'),
      k(null, 'LAB'),
      k('SUB', 'MAT'),
      k(null, 'STF'),
      k('SUB', 'SUBC'),
    ]);
    expect(r.totals).toEqual({
      original: '510000.00',
      budget: '520000.00',
      changes: '10000.00',
      committed: '141000.00',
      actual: '180200.00',
      ctc: '360000.00',
      forecast: '540200.00',
      variance: '-20200.00',
    });
    expect(r.unallocated).toEqual({ orderLines: 0, ledgerLines: 0 });
    // Subcontracts: 65,000 committed against 60,000. Cement billed at ₹380 against ₹370.
    expect(r.alerts.overBudget.map((a) => [a.costCode.code, a.over])).toEqual([
      ['SUBC', '5000.00'],
    ]);
    expect(r.alerts.rates).toEqual([
      {
        resource: 'CEM Cement OPC 53',
        unit: 'bag',
        budgetRate: '370.00',
        billedRate: '380.00',
        qty: '300.0000',
      },
    ]);
    expect(r.mayForecast).toBe(true);

    // Behind substructure materials: the order's open 76,000, the bill and the debit note, both through the requisition.
    const docs = await ok<{
      orderLines: { number: string; committed: string; how: string }[];
      ledgerLines: { amount: string; how: string; billNo: string }[];
    }>(
      get(
        `/tenant/projects/${projectId}/cost-control/documents?key=${encodeURIComponent(k('SUB', 'MAT'))}`,
        manager,
      ),
    );
    expect(docs.orderLines.map((o) => [o.number, o.committed, o.how])).toEqual([
      [po.number, '76000.00', 'requisition'],
    ]);
    expect(docs.ledgerLines.map((l) => [l.billNo, l.amount, l.how])).toEqual([
      ['VC/88', '114000.00', 'requisition'],
      ['VC/88', '-3800.00', 'requisition'],
    ]);

    // The actual is the ledger's: it agrees with the project P&L.
    const pl = await ok<{ projects: { project: { id: string }; costs: string }[] }>(
      get(
        `/tenant/accounts/statements/projects?entityId=${entityId}&from=2026-04-01&to=2027-03-31`,
        manager,
      ),
    );
    expect(pl.projects.find((p) => p.project.id === projectId)!.costs).toBe(r.totals.actual);

    // September closed; then planning raises materials to 2,20,000, and the month shows what changed.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/cost-control/ctc`,
          { key: k('SUB', 'MAT'), amount: '1' },
          worker,
        )
      ).statusCode,
    ).toBe(404);
    await ok(post(`/tenant/projects/${projectId}/cost-control/months/2026-09/close`, {}, manager));
    expect(
      (
        await post(`/tenant/projects/${projectId}/cost-control/months/2026-09/close`, {}, manager)
      ).json(),
    ).toMatchObject({ code: 'month_closed' });
    expect(
      (
        await post(`/tenant/projects/${projectId}/cost-control/months/2099-01/close`, {}, manager)
      ).json(),
    ).toMatchObject({ code: 'future_month' });
    await ok(
      post(
        `/tenant/projects/${projectId}/cost-control/ctc`,
        { key: k('SUB', 'MAT'), amount: '220000' },
        manager,
      ),
    );
    const cmp = await report('?compare=2026-09');
    expect(cmp.months).toEqual(['2026-09']);
    expect(cmp.compared!.rows[k('SUB', 'MAT')]!.forecast).toBe('310200.00');
    expect(cmp.rows.find((x) => x.key === k('SUB', 'MAT'))!.forecast).toBe('330200.00');
    // Cleared, the computed figure applies again: 3,00,000 − 1,10,200 = 1,89,800.
    const cleared = await ok<Report>(
      post(
        `/tenant/projects/${projectId}/cost-control/ctc`,
        { key: k('SUB', 'MAT'), amount: null },
        manager,
      ),
    );
    expect(cleared.rows.find((x) => x.key === k('SUB', 'MAT'))).toMatchObject({
      ctc: '189800.00',
      ctcComputed: true,
    });
    const xlsx = await app.inject({
      method: 'GET',
      url: `/api/tenant/projects/${projectId}/cost-control?format=xlsx`,
      headers: manager,
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});
