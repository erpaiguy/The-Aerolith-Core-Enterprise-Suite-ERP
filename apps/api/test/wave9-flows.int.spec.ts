// Process flows in a real tenant database (docs/wave9-plan.md step 9a.7): one purchase followed from its requisition
// to the supplier's payment, the strip asked for from each of its documents along the way; what a person off the
// project, or without the accounts permission, is shown.
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
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

interface Step {
  key: string;
  state: 'done' | 'current' | 'todo' | 'na';
  here: boolean;
  docs: { id: string; number: string; href: string; done: boolean; here: boolean }[];
  hidden: number;
}

describe.skipIf(!controlUrl || !adminUrl)('wave 9: process flows (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
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
  const flow = async (kind: string, id: string, as: Record<string, string> = manager) =>
    (await ok<{ steps: Step[] }>(get(`/tenant/flows/purchase/${kind}/${id}`, as))).steps;
  /** Each stage as key:state, with a * on the page's own. */
  const states = (steps: Step[]) => steps.map((s) => `${s.key}:${s.state}${s.here ? '*' : ''}`);

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w9-flows-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'flows-admin@example.in');
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('follows one purchase from requisition to payment, from each of its documents', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    const entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Washim Builders Pvt Ltd',
        gstin: '27AAACW1234K1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    const siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    const vendor = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          isClient: false,
          isVendor: true,
          name: 'Vidarbha Cement Traders',
          gstin: '27AAACV1234F1Z5',
        }),
      )
    ).id;

    // 1. A requisition for 100 bags, approved when submitted (no approval rule): the order is what it waits on.
    const req = await ok<{ id: string; number: string; rowVersion: number }>(
      post(
        `/tenant/projects/${projectId}/requisitions`,
        {
          title: 'Cement for slab 1',
          siteId,
          lines: [{ description: 'Cement OPC 53', unit: 'bag', qty: '100', rate: '390' }],
        },
        manager,
      ),
    );
    await ok(
      post(`/tenant/requisitions/${req.id}/submit`, { rowVersion: req.rowVersion }, manager),
    );
    expect(states(await flow('requisition', req.id))).toEqual([
      'requisition:done*',
      'order:current',
      'receipt:todo',
      'bill:todo',
      'payment:todo',
    ]);

    // 2. Ordered from the supplier and issued: the requisition is linked back from the order.
    const draft = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders/from-requisitions`,
        { partyId: vendor, gstPct: '18', lines: [{ requisitionId: req.id, position: 1 }] },
        manager,
      ),
    );
    const po = await ok<{ id: string; number: string; inForce: { lines: { lineKey: string }[] } }>(
      post(
        `/tenant/order-revisions/${draft.open.id}/submit`,
        { rowVersion: draft.open.rowVersion },
        manager,
      ),
    );
    const key = po.inForce.lines[0]!.lineKey;
    let steps = await flow('order', po.id);
    expect(states(steps)).toEqual([
      'requisition:done',
      'order:done*',
      'receipt:current',
      'bill:todo',
      'payment:todo',
    ]);
    expect(steps[0]!.docs).toEqual([
      {
        id: req.id,
        number: req.number,
        href: `/requisitions/${req.id}`,
        done: true,
        here: false,
      },
    ]);
    expect(steps[1]!.docs[0]).toMatchObject({ id: po.id, href: `/orders/${po.id}`, here: true });
    expect(states(await flow('requisition', req.id))[1]).toBe('order:done');

    // 3. 60 bags come, then the other 40: receiving is done only when nothing more is owed.
    const receive = (challanNo: string, qty: string) =>
      ok<{ id: string; number: string }>(
        post(
          `/tenant/orders/${po.id}/receipts`,
          { receivedOn: '2026-08-02', challanNo, lines: [{ lineKey: key, qty }] },
          manager,
        ),
      );
    const g1 = await receive('DC-1', '60');
    steps = await flow('receipt', g1.id);
    expect(states(steps)).toEqual([
      'requisition:done',
      'order:done',
      'receipt:current*',
      'bill:todo',
      'payment:todo',
    ]);
    const g2 = await receive('DC-2', '40');
    steps = await flow('receipt', g2.id);
    expect(states(steps)[2]).toBe('receipt:done*');
    expect(steps[2]!.docs.map((d) => [d.number, d.here])).toEqual([
      [g1.number, false],
      [g2.number, true],
    ]);

    // 4. The supplier's bill for the 100 bags, matched and posted: payment is what it waits on.
    const bill = await ok<{ id: string; status: string }>(
      post(
        '/tenant/accounts/vendor-bills',
        {
          entityId,
          projectId: null,
          tdsSection: null,
          partyId: vendor,
          orderId: po.id,
          billNo: 'V/101',
          billDate: '2026-08-05',
          dueDate: '2026-09-04',
          lines: [{ lineKey: key, qty: '100', rate: '390' }],
        },
        manager,
      ),
    );
    expect(bill.status).toBe('posted');
    steps = await flow('bill', bill.id);
    expect(states(steps)).toEqual([
      'requisition:done',
      'order:done',
      'receipt:done',
      'bill:done*',
      'payment:current',
    ]);
    expect(steps[3]!.docs[0]).toMatchObject({
      number: 'V/101',
      href: `/accounts/vendor-bills/${bill.id}`,
    });

    // 5. Who sees what: off the project, nothing; on it without the accounts permission, the bills only counted.
    expect((await get(`/tenant/flows/purchase/requisition/${req.id}`, worker)).statusCode).toBe(
      404,
    );
    expect((await get(`/tenant/flows/purchase/bill/${bill.id}`, worker)).statusCode).toBe(403);
    expect((await get(`/tenant/flows/purchase/payment/${bill.id}`, manager)).statusCode).toBe(400);
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    steps = await flow('order', po.id, worker);
    expect(steps[3]).toMatchObject({ key: 'bill', state: 'done', docs: [], hidden: 1 });
    expect(steps[0]!.docs.map((d) => d.number)).toEqual([req.number]);

    // 6. Paid in a payment run: every stage done, none waiting.
    const chart = await ok<{ accounts: { id: string; systemKey: string | null; code: string }[] }>(
      get('/tenant/accounts/chart', manager),
    );
    const bank = (
      await ok<{ accounts: { id: string; code: string }[] }>(
        post('/tenant/accounts/chart', {
          parentId: chart.accounts.find((a) => a.systemKey === 'cash_and_bank')!.id,
          code: 'A4002',
          name: 'HDFC Bank 0012',
          kind: 'bank',
        }),
      )
    ).accounts.find((a) => a.code === 'A4002')!.id;
    const payable = (
      await ok<{ payable: string }>(get(`/tenant/accounts/vendor-bills/${bill.id}`, manager))
    ).payable;
    let run = await ok<{ id: string; number: string }>(
      post(
        '/tenant/accounts/payment-runs',
        {
          entityId,
          bankAccountId: bank,
          payOn: '2026-09-01',
          lines: [{ partyId: vendor, kind: 'bill', billId: bill.id, amount: payable }],
        },
        manager,
      ),
    );
    run = await ok(post(`/tenant/accounts/payment-runs/${run.id}/submit`, {}, manager));
    expect(states(await flow('bill', bill.id))[4]).toBe('payment:current');
    await ok(
      post(`/tenant/accounts/payment-runs/${run.id}/paid`, { paidOn: '2026-09-02' }, manager),
    );
    steps = await flow('requisition', req.id);
    expect(states(steps)).toEqual([
      'requisition:done*',
      'order:done',
      'receipt:done',
      'bill:done',
      'payment:done',
    ]);
    expect(steps[4]!.docs).toEqual([
      {
        id: run.id,
        number: run.number,
        href: `/accounts/payment-runs/${run.id}`,
        done: true,
        here: false,
      },
    ]);
  });

  it('marks what does not apply to a work order written directly', async () => {
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Pump house, Risod' }, manager))
    ).id;
    const party = (
      await ok<{ id: string }>(
        post('/tenant/parties', { isClient: false, isVendor: true, name: 'Kale Constructions' }),
      )
    ).id;
    const wo = await ok<{ id: string }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'work',
          partyId: party,
          lines: [{ description: 'Plaster', unit: 'sqm', qty: '100', rate: '120', gstPct: '18' }],
        },
        manager,
      ),
    );
    // A draft work order written directly: no requisition, and nothing to receive.
    expect(states(await flow('order', wo.id))).toEqual([
      'requisition:na',
      'order:current*',
      'receipt:na',
      'bill:todo',
      'payment:todo',
    ]);
    expect((await get(`/tenant/flows/purchase/order/${wo.id}`, worker)).statusCode).toBe(404);
  });
});
