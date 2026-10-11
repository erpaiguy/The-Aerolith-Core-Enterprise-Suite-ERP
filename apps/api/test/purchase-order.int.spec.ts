// Purchase and work orders in a real tenant database (docs/wave2b-plan.md step 4): rates before GST and GST added on
// top, worked out by hand here (CGST + SGST within the state, IGST across, none from a supplier without a GSTIN);
// approval of revision 0 for its total and of an amendment for what it adds; the supplier's acknowledgement; drafts
// made from the vendors chosen in a project's enquiry; cancelling and closing; kept to the project's team.
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

describe.skipIf(!controlUrl || !adminUrl)('purchase and work orders (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-po-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'po-admin@example.in');
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

  interface Revision {
    id: string;
    revision: number;
    status: string;
    supply: string | null;
    subtotal: string;
    cgst: string;
    sgst: string;
    igst: string;
    total: string;
    rowVersion: number;
    lines: {
      description: string;
      rfqLineId: string | null;
      qty: string;
      rate: string;
      gstPct: string;
      amount: string;
      cgst: string;
      sgst: string;
      igst: string;
    }[];
  }
  interface Order {
    id: string;
    kind: string;
    number: string;
    status: string;
    acknowledgedOn: string | null;
    vendor: { name: string };
    rfq: { number: string } | null;
    inForce: Revision | null;
    open: Revision | null;
    revisions: { id: string; revision: number; status: string }[];
    approval: { id: string; status: string } | null;
    mayEdit: boolean;
    mayAmend: boolean;
  }

  let washim: string; // a site in Maharashtra (27)
  let noState: string; // a site with no GST state code
  let local: string; // a supplier registered in Maharashtra
  let gujarat: string; // one registered in Gujarat (24)
  let unregistered: string;
  let cement: string;
  let po: Order;

  const party = async (name: string, gstin: string | null) =>
    (
      await ok<{ id: string }>(
        post('/tenant/parties', { name, isClient: false, isVendor: true, gstin }),
      )
    ).id;
  const lines = (...l: [string, string, string, string, string][]) =>
    l.map(([description, unit, qty, rate, gstPct]) => ({ description, unit, qty, rate, gstPct }));
  const terms = (siteId: string | null, l: object[]) => ({
    siteId,
    deliverBy: '2026-11-20',
    paymentTerms: '30 days from receipt',
    lines: l,
  });

  it('writes a purchase order with CGST and SGST on top of the rates, approved for its total', async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    const sites = await ok<{ sites: { id: string; name: string }[] }>(
      post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
    ).then(() =>
      ok<{ sites: { id: string; name: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Camp office' }, manager),
      ),
    );
    washim = sites.sites.find((s) => s.name === 'Washim')!.id;
    noState = sites.sites.find((s) => s.name === 'Camp office')!.id;
    local = await party('Vidarbha Cement Traders', '27AAACV1234F1Z5');
    gujarat = await party('Surat Waterproofing Works', '24AAACS5678K1Z2');
    unregistered = await party('Ramesh Hardware', null);
    cement = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code: 'CEM',
          name: 'Cement OPC 53',
          kind: 'material',
          unit: 'bag',
          rate: '400',
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;

    // A worker has no purchase.edit by default.
    const order = {
      kind: 'purchase',
      partyId: local,
      ...terms(null, [
        {
          resourceId: cement,
          description: 'Cement OPC 53',
          unit: 'bag',
          qty: '100',
          rate: '390.50',
          gstPct: '18',
        },
        ...lines(['TMT bars Fe 500D', 't', '1.235', '62000', '18']),
      ]),
    };
    expect(
      (await post(`/tenant/projects/${projectId}/orders`, order, worker)).json(),
    ).toMatchObject({
      code: 'permission_denied',
    });
    po = await ok<Order>(post(`/tenant/projects/${projectId}/orders`, order, manager));
    expect(po).toMatchObject({
      kind: 'purchase',
      number: expect.stringMatching(/^PO\/\d{4}-\d{2}\/0001$/),
      status: 'draft',
      inForce: null,
      mayEdit: true,
      open: { revision: 0, status: 'draft', supply: null },
    });
    // No site yet: GST cannot be worked out, so it cannot go out.
    expect(
      (
        await post(
          `/tenant/order-revisions/${po.open!.id}/submit`,
          { rowVersion: po.open!.rowVersion },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'no_place_of_supply' });
    // A site without a GST state code: still not.
    po = await ok<Order>(
      post(
        `/tenant/order-revisions/${po.open!.id}`,
        { ...order, siteId: noState, rowVersion: po.open!.rowVersion },
        manager,
      ),
    );
    expect(
      (
        await post(
          `/tenant/order-revisions/${po.open!.id}/submit`,
          { rowVersion: po.open!.rowVersion },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'no_place_of_supply' });
    po = await ok<Order>(
      post(
        `/tenant/order-revisions/${po.open!.id}`,
        { ...order, siteId: washim, rowVersion: po.open!.rowVersion },
        manager,
      ),
    );
    // Same state (27 and 27): CGST 9% + SGST 9%.
    //   Cement 100 × 390.50 = 39,050.00; CGST 3,514.50; SGST 3,514.50.
    //   Steel 1.235 × 62,000 = 76,570.00; CGST 6,891.30; SGST 6,891.30.
    //   Subtotal 1,15,620.00 + CGST 10,405.80 + SGST 10,405.80 = 1,36,431.60.
    expect(po.open).toMatchObject({
      supply: 'intra',
      subtotal: '115620.00',
      cgst: '10405.80',
      sgst: '10405.80',
      igst: '0.00',
      total: '136431.60',
    });
    expect(po.open!.lines.map((l) => [l.amount, l.cgst, l.sgst, l.igst])).toEqual([
      ['39050.00', '3514.50', '3514.50', '0.00'],
      ['76570.00', '6891.30', '6891.30', '0.00'],
    ]);

    // A rule from ₹1 lakh: this needs approval, for its total with GST.
    await ok(
      post('/tenant/approval-rules/purchase_order', {
        rules: [{ minAmount: '100000', approver: 'manager', label: 'Purchase' }],
      }),
    );
    po = await ok<Order>(
      post(
        `/tenant/order-revisions/${po.open!.id}/submit`,
        { rowVersion: po.open!.rowVersion },
        manager,
      ),
    );
    expect(po).toMatchObject({
      status: 'draft',
      open: { status: 'submitted' },
      approval: { status: 'pending' },
      mayEdit: false,
    });
    const req = await ok<{ amount: string; link: string }>(
      get(`/tenant/approvals/${po.approval!.id}`),
    );
    expect(req).toMatchObject({ amount: '136431.60', link: `/orders/revision/${po.open!.id}` });
    await ok(post(`/tenant/approvals/${po.approval!.id}/approve`, {}));
    po = await ok<Order>(get(`/tenant/orders/${po.id}`, worker));
    expect(po).toMatchObject({
      status: 'issued',
      open: null,
      inForce: { revision: 0, status: 'approved', total: '136431.60' },
      mayAmend: false, // the worker reads it but does not change it
    });
    // The approval's link finds it by revision.
    expect(
      (await ok<Order>(get(`/tenant/order-revisions/${po.inForce!.id}`, manager))).number,
    ).toBe(po.number);
  });

  it('records the acknowledgement; an amendment is approved for what it adds and needs a new one', async () => {
    const tomorrow = new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);
    expect(
      (
        await post(`/tenant/orders/${po.id}/acknowledge`, { on: tomorrow, reference: 'x' }, manager)
      ).json(),
    ).toMatchObject({ code: 'in_future' });
    po = await ok<Order>(
      post(
        `/tenant/orders/${po.id}/acknowledge`,
        { on: '2026-10-01', reference: 'VCT/26/118' },
        manager,
      ),
    );
    expect(po).toMatchObject({ status: 'acknowledged', acknowledgedOn: '2026-10-01' });

    po = await ok<Order>(
      post(`/tenant/orders/${po.id}/amend`, { reason: '20 bags more' }, manager),
    );
    expect(po.open).toMatchObject({ revision: 1, status: 'draft', total: '136431.60' });
    expect(
      (await post(`/tenant/orders/${po.id}/amend`, { reason: 'Again' }, manager)).json(),
    ).toMatchObject({
      code: 'revision_open',
    });
    // Cement to 120 bags: 46,860.00, CGST and SGST 4,217.40 each. Subtotal 1,23,430.00; CGST and SGST 11,108.70;
    // total 1,45,647.40, which adds 9,215.80: under the ₹1 lakh rule, so in force at once.
    po = await ok<Order>(
      post(
        `/tenant/order-revisions/${po.open!.id}`,
        {
          ...terms(washim, [
            {
              resourceId: cement,
              description: 'Cement OPC 53',
              unit: 'bag',
              qty: '120',
              rate: '390.50',
              gstPct: '18',
            },
            ...lines(['TMT bars Fe 500D', 't', '1.235', '62000', '18']),
          ]),
          reason: '20 bags more',
          rowVersion: po.open!.rowVersion,
        },
        manager,
      ),
    );
    expect(po.open).toMatchObject({ subtotal: '123430.00', cgst: '11108.70', total: '145647.40' });
    po = await ok<Order>(
      post(
        `/tenant/order-revisions/${po.open!.id}/submit`,
        { rowVersion: po.open!.rowVersion },
        manager,
      ),
    );
    expect(po).toMatchObject({
      status: 'issued', // the supplier acknowledges the amendment anew
      acknowledgedOn: null,
      open: null,
      inForce: { revision: 1, total: '145647.40' },
    });
    expect(po.revisions.map((r) => [r.revision, r.status])).toEqual([
      [1, 'approved'],
      [0, 'superseded'],
    ]);
    // An amendment started and thrown away; revision 0 is never discarded (the order is cancelled instead).
    po = await ok<Order>(post(`/tenant/orders/${po.id}/amend`, { reason: 'Try' }, manager));
    const tried = po.open!.id;
    po = await ok<Order>(post(`/tenant/order-revisions/${tried}/discard`, {}, manager));
    expect(po.open).toBeNull();
    expect(
      (
        await post(`/tenant/order-revisions/${po.revisions.at(-1)!.id}/discard`, {}, manager)
      ).json(),
    ).toMatchObject({ code: 'not_discardable' });
    // Closed when done.
    po = await ok<Order>(
      post(`/tenant/orders/${po.id}/close`, { reason: 'All received' }, manager),
    );
    expect(po).toMatchObject({ status: 'closed', mayAmend: false });
  });

  it('charges IGST across states, and none from a supplier without a GSTIN', async () => {
    // Gujarat (24) to a site in Maharashtra (27): IGST 18%. 250 sqm × 180 = 45,000.00; IGST 8,100.00; 53,100.00.
    // A work order has its own series.
    let wo = await ok<Order>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'work',
          partyId: gujarat,
          ...terms(washim, lines(['Terrace waterproofing', 'sqm', '250', '180', '18'])),
        },
        manager,
      ),
    );
    expect(wo).toMatchObject({
      number: expect.stringMatching(/^WO\/\d{4}-\d{2}\/0001$/),
      open: {
        supply: 'inter',
        subtotal: '45000.00',
        cgst: '0.00',
        sgst: '0.00',
        igst: '8100.00',
        total: '53100.00',
      },
    });
    // Half a percent of 99.99 is rounded to the paisa on each side: 3 × 33.33 at 5% is CGST 2.50 + SGST 2.50.
    const small = await ok<Order>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: local,
          ...terms(washim, lines(['Nails', 'kg', '3', '33.33', '5'])),
        },
        manager,
      ),
    );
    expect(small.open).toMatchObject({
      subtotal: '99.99',
      cgst: '2.50',
      sgst: '2.50',
      total: '104.99',
    });
    // No GSTIN: no GST, whatever rate was typed.
    const cash = await ok<Order>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: unregistered,
          ...terms(null, lines(['Tarpaulin', 'nos', '4', '850', '18'])),
        },
        manager,
      ),
    );
    expect(cash.open).toMatchObject({
      supply: 'unregistered',
      subtotal: '3400.00',
      total: '3400.00',
    });
    expect(cash.open!.lines[0]!.gstPct).toBe('0.00');
    // Cancelled with a reason; a pending approval goes with it.
    wo = await ok<Order>(
      post(
        `/tenant/order-revisions/${wo.open!.id}/submit`,
        { rowVersion: wo.open!.rowVersion },
        manager,
      ),
    );
    // Under the ₹1 lakh rule: in force at once, recorded as needing no approval.
    expect(wo).toMatchObject({ status: 'issued', approval: { status: 'approved' } });
    const c = await ok<Order>(
      post(`/tenant/orders/${cash.id}/cancel`, { reason: 'Bought for cash' }, manager),
    );
    expect(c).toMatchObject({
      status: 'cancelled',
      open: null,
      revisions: [{ status: 'discarded' }],
    });
    const list = await ok<{ number: string; status: string; total: string }[]>(
      get(`/tenant/orders?projectId=${projectId}&status=open`, worker),
    );
    expect(list.map((o) => [o.number, o.status])).toEqual([
      [small.number, 'draft'],
      [wo.number, 'issued'],
    ]);
  });

  it("drafts orders from the vendors chosen in the project's enquiry", async () => {
    const r = await ok<{ id: string; rowVersion: number }>(
      post(
        `/tenant/projects/${projectId}/requisitions`,
        {
          title: 'Slab 2',
          siteId: washim,
          lines: [
            { resourceId: cement, qty: '200' },
            { description: 'River sand', unit: 'cum', qty: '10', rate: '1800' },
          ],
        },
        worker,
      ),
    );
    await ok(post(`/tenant/requisitions/${r.id}/submit`, { rowVersion: r.rowVersion }, worker));
    let rfq = await ok<{
      id: string;
      lines: { id: string }[];
      vendors: { partyId: string }[];
    }>(
      post(
        `/tenant/projects/${projectId}/rfqs`,
        { title: 'Slab 2', requisitionIds: [r.id] },
        manager,
      ),
    );
    await ok(post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: local }, manager));
    rfq = await ok(post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: gujarat }, manager));
    const quote = (partyId: string, rates: string[]) =>
      ok(
        post(
          `/tenant/rfqs/${rfq.id}/vendors/${partyId}/quote`,
          {
            receivedOn: '2026-10-08',
            gstMode: 'extra',
            gstPct: partyId === local ? '28' : '5',
            lines: rfq.lines.map((l, i) => ({ lineId: l.id, rate: rates[i] })),
          },
          manager,
        ),
      );
    expect((await post(`/tenant/rfqs/${rfq.id}/orders`, {}, manager)).json()).toMatchObject({
      code: 'nothing_to_order',
    });
    await quote(local, ['385', '1900']);
    await quote(gujarat, ['395', '1700']);
    await ok(post(`/tenant/rfqs/${rfq.id}/select`, { lowest: true }, manager));
    const made = await ok<{ orders: Order[] }>(post(`/tenant/rfqs/${rfq.id}/orders`, {}, manager));
    // Cement from the local supplier at 28%: 200 × 385 = 77,000.00, CGST and SGST 10,780.00 each.
    // Sand from Gujarat at 5%: 10 × 1,700 = 17,000.00, IGST 850.00. Both to the requisition's site; vendors in name order.
    expect(
      made.orders.map((o) => [
        o.vendor.name,
        o.rfq?.number,
        o.open!.supply,
        o.open!.lines.map((l) => [l.description, l.qty, l.rate, l.gstPct, l.amount]),
        o.open!.total,
      ]),
    ).toEqual([
      [
        'Surat Waterproofing Works',
        expect.stringMatching(/^RFQ\//),
        'inter',
        [['River sand', '10.0000', '1700.0000', '5.00', '17000.00']],
        '17850.00',
      ],
      [
        'Vidarbha Cement Traders',
        expect.stringMatching(/^RFQ\//),
        'intra',
        [['Cement OPC 53', '200.0000', '385.0000', '28.00', '77000.00']],
        '98560.00',
      ],
    ]);
    expect(made.orders.every((o) => o.open!.lines[0]!.rfqLineId)).toBe(true);
    // Lines already on an order are not ordered twice; once one is cancelled they can be.
    expect((await post(`/tenant/rfqs/${rfq.id}/orders`, {}, manager)).json()).toMatchObject({
      code: 'nothing_to_order',
    });
    await ok(
      post(
        `/tenant/orders/${made.orders[0]!.id}/cancel`,
        { reason: 'Sand from the quarry' },
        manager,
      ),
    );
    const again = await ok<{ orders: Order[] }>(post(`/tenant/rfqs/${rfq.id}/orders`, {}, manager));
    expect(again.orders.map((o) => o.vendor.name)).toEqual(['Surat Waterproofing Works']);
  });

  it("keeps orders to the project's team", async () => {
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect((await get(`/tenant/orders/${po.id}`, worker)).statusCode).toBe(200);
    await db`DELETE FROM proj.member WHERE project_id = ${projectId} AND user_id = ${workerId}`;
    expect((await get(`/tenant/orders/${po.id}`, worker)).statusCode).toBe(404);
    expect(await ok<unknown[]>(get('/tenant/orders', worker))).toEqual([]);
    const ev = await db<{ kind: string }[]>`SELECT kind FROM proj.project_event
      WHERE project_id = ${projectId} AND kind LIKE 'order%' ORDER BY id`;
    expect(ev.slice(0, 3).map((e) => e.kind)).toEqual([
      'order_created',
      'order_issued',
      'order_issued',
    ]);
  });
});
