// Inventory in a real tenant database (docs/wave2b-plan.md step 6), every value worked by hand: receipts into the
// site's store at the order rate; issues to WBS elements at the weighted average; a return from site at its issue
// value; a cancelled receipt taken out at what it brought in; a transfer through transit; a stock take approved and
// posted; reorder levels and a requisition for the shortfall; the project's consumption; the ledger equal to the
// balance; and FIFO on a second tenant that chose it before anything moved.
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

describe.skipIf(!controlUrl || !adminUrl)('inventory (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const put = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'PUT', url: `/api${url}`, payload, headers });
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-inv-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'inv-admin@example.in');
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

  interface Store {
    id: string;
    name: string;
    valuation: string;
    stock: {
      code: string;
      qty: string;
      value: string;
      rate: string | null;
      reorderLevel: string | null;
      below: boolean;
    }[];
    transfers: { id: string; number: string; incoming: boolean }[];
    mayIssue: boolean;
    mayManage: boolean;
  }
  type Headers = Record<string, string>;

  const balance = async (storeId: string, as: Headers = manager) => {
    const s = await ok<Store>(get(`/tenant/stores/${storeId}`, as));
    return Object.fromEntries(s.stock.map((x) => [x.code, [Number(x.qty), Number(x.value)]]));
  };
  /** A project with a site in Maharashtra, WBS elements SUB and SUP, cement in the library and a supplier. */
  async function setup(as: Headers, name: string) {
    const project = (await ok<{ id: string }>(post('/tenant/projects', { name }, as))).id;
    const p = await ok<{ sites: { id: string }[] }>(
      post(`/tenant/projects/${project}/sites`, { name: 'Washim', stateCode: '27' }, as),
    );
    for (const [code, n] of [
      ['SUB', 'Substructure'],
      ['SUP', 'Superstructure'],
    ])
      await ok(post(`/tenant/projects/${project}/wbs`, { code, name: n }, as));
    const cement = (
      await ok<{ id: string }>(
        post(
          '/tenant/resources',
          {
            code: 'CEM',
            name: 'Cement OPC 53',
            kind: 'material',
            unit: 'bag',
            rate: '400',
            effectiveFrom: '2026-01-01',
          },
          as,
        ),
      )
    ).id;
    const vendor = (
      await ok<{ id: string }>(
        post(
          '/tenant/parties',
          {
            name: 'Vidarbha Cement Traders',
            isClient: false,
            isVendor: true,
            gstin: '27AAACV1234F1Z5',
          },
          as,
        ),
      )
    ).id;
    return { project, site: p.sites[0]!.id, cement, vendor };
  }
  /** An issued order (no approval rules) for the lines, received in full: the receipt. */
  async function buyAndReceive(
    as: Headers,
    s: { project: string; site: string; vendor: string },
    lines: object[],
    receivedOn: string,
  ) {
    const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${s.project}/orders`,
        { kind: 'purchase', partyId: s.vendor, siteId: s.site, lines },
        as,
      ),
    );
    const po = await ok<{ id: string; progress: { lineKey: string; outstanding: string }[] }>(
      post(`/tenant/order-revisions/${o.open.id}/submit`, { rowVersion: o.open.rowVersion }, as),
    );
    return ok<{
      id: string;
      number: string;
      store: { id: string; name: string } | null;
      lines: { stocked: boolean }[];
    }>(
      post(
        `/tenant/orders/${po.id}/receipts`,
        {
          receivedOn,
          challanNo: `DC-${receivedOn}`,
          lines: po.progress.map((l) => ({ lineKey: l.lineKey, qty: l.outstanding })),
        },
        as,
      ),
    );
  }
  const cementLine = (cement: string, qty: string, rate: string) => ({
    resourceId: cement,
    description: 'Cement OPC 53',
    unit: 'bag',
    qty,
    rate,
    gstPct: '28',
  });

  let s: Awaited<ReturnType<typeof setup>>;
  let washim: string;
  let yard: string;
  let r3: string;
  let issue2: { id: string; lines: { position: number }[] };

  it('receives into the site store and issues at the weighted average', async () => {
    s = await setup(manager, 'Hostel, Washim');
    await ok(
      post(`/tenant/projects/${s.project}/team`, { userId: workerId, role: 'member' }, manager),
    );
    // 100 bags at ₹390 and a typed-in line (not stocked): the site's store is made for it.
    const r1 = await buyAndReceive(
      manager,
      s,
      [
        cementLine(s.cement, '100', '390'),
        { description: 'Shuttering oil', unit: 'l', qty: '20', rate: '95', gstPct: '18' },
      ],
      '2026-10-01',
    );
    expect(r1.store).toMatchObject({ name: 'Washim store' });
    expect(r1.lines.map((l) => l.stocked)).toEqual([true, false]);
    washim = r1.store!.id;
    // The valuation method is fixed once anything has moved.
    expect((await post('/tenant/stock/valuation', { method: 'fifo' })).json()).toMatchObject({
      code: 'stock_has_moved',
    });
    // 50 more at ₹402: 150 bags, 39,000 + 20,100 = ₹59,100 (₹394 a bag).
    await buyAndReceive(manager, s, [cementLine(s.cement, '50', '402')], '2026-10-02');
    expect(await balance(washim)).toEqual({ CEM: [150, 59100] });

    // The worker on the team issues 60 bags to the substructure: 59,100 × 60 / 150 = ₹23,640.
    const issue = (qty: string, wbsCode: string, as: Headers = worker) =>
      post(
        `/tenant/stores/${washim}/issues`,
        {
          issuedOn: '2026-10-03',
          wbsCode,
          issuedTo: 'Ramesh (mason gang)',
          lines: [{ resourceId: s.cement, qty }],
        },
        as,
      );
    const i1 = await ok<{ number: string; lines: { value: string }[] }>(issue('60', 'SUB'));
    expect(i1).toMatchObject({
      number: expect.stringMatching(/^ISS\/\d{4}-\d{2}\/0001$/),
      lines: [{ value: '23640.00' }],
    });
    expect((await issue('10', 'NOPE')).json()).toMatchObject({ code: 'wbs_not_found' });
    expect((await issue('91', 'SUB')).json()).toMatchObject({
      code: 'not_in_stock',
      message: expect.stringContaining('90 bag in the store, not 91'),
    });

    // 30 more at ₹410.50 (₹12,315): 120 bags, ₹47,775. 45 to the superstructure: 47,775 × 45 / 120 = 17,915.625,
    // ₹17,915.63.
    r3 = (await buyAndReceive(manager, s, [cementLine(s.cement, '30', '410.50')], '2026-10-04')).id;
    issue2 = await ok(issue('45', 'SUP'));
    expect(await balance(washim)).toEqual({ CEM: [75, 29859.37] });

    // 5 bags come back unused, at what they went out at: 17,915.63 × 5 / 45 = 1,990.6255, ₹1,990.63.
    const back = await ok<{ lines: { returned: string }[] }>(
      post(
        `/tenant/issues/${issue2.id}/returns`,
        { returnedOn: '2026-10-05', lines: [{ position: 1, qty: '5' }] },
        worker,
      ),
    );
    expect(back.lines[0]!.returned).toBe('5.0000');
    expect(
      (
        await post(
          `/tenant/issues/${issue2.id}/returns`,
          { returnedOn: '2026-10-05', lines: [{ position: 1, qty: '41' }] },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'over_issued' });
    expect(await balance(washim)).toEqual({ CEM: [80, 31850] });
  });

  it('takes a cancelled receipt out at what it brought in, and moves stock through transit', async () => {
    // The ₹410.50 receipt was entered against the wrong order: 80 − 30 = 50 bags, 31,850 − 12,315 = ₹19,535.
    await ok(post(`/tenant/receipts/${r3}/cancel`, { reason: 'Wrong order' }, manager));
    expect(await balance(washim)).toEqual({ CEM: [50, 19535] });

    // A second store; the worker cannot set one up or send stock out.
    expect(
      (
        await post(
          `/tenant/projects/${s.project}/stores`,
          { siteId: s.site, name: 'Steel yard' },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'permission_denied', permission: 'stores.manage' });
    yard = (
      await ok<{ id: string }>(
        post(
          `/tenant/projects/${s.project}/stores`,
          { siteId: s.site, name: 'Steel yard' },
          manager,
        ),
      )
    ).id;
    const send = (qty: string) =>
      ok<{ id: string; number: string; status: string; lines: { value: string }[] }>(
        post(
          `/tenant/stores/${washim}/transfers`,
          { toStoreId: yard, sentOn: '2026-10-06', lines: [{ resourceId: s.cement, qty }] },
          manager,
        ),
      );
    // 20 bags: 19,535 × 20 / 50 = ₹7,814, out of Washim and nowhere until received.
    const t1 = await send('20');
    expect(t1).toMatchObject({
      number: expect.stringMatching(/^TRN\//),
      status: 'in_transit',
      lines: [{ value: '7814.00' }],
    });
    expect(await balance(washim)).toEqual({ CEM: [30, 11721] });
    expect(await balance(yard)).toEqual({});
    await ok(post(`/tenant/transfers/${t1.id}/receive`, { receivedOn: '2026-10-07' }, worker));
    expect(await balance(yard)).toEqual({ CEM: [20, 7814] });
    expect(
      (
        await post(`/tenant/transfers/${t1.id}/receive`, { receivedOn: '2026-10-07' }, worker)
      ).json(),
    ).toMatchObject({
      code: 'not_in_transit',
    });
    // Sent and turned back: Washim as it was.
    const t2 = await send('10');
    await ok(post(`/tenant/transfers/${t2.id}/cancel`, {}, manager));
    expect(await balance(washim)).toEqual({ CEM: [30, 11721] });
  });

  it('posts a stock take once approved, and raises a requisition for what is below its reorder level', async () => {
    await ok(
      post('/tenant/approval-rules/stock_adjustment', {
        rules: [{ minAmount: '500', approver: 'manager', label: 'Stores' }],
      }),
    );
    // Counted 28 of the 30 on the book; at ₹390.70 a bag (11,721 / 30) the loss is ₹781.40.
    let c = await ok<{
      id: string;
      number: string;
      rowVersion: number;
      lines: { bookQty: string; difference: string; value: string }[];
    }>(
      post(
        `/tenant/stores/${washim}/counts`,
        {
          countedOn: '2026-10-08',
          lines: [{ resourceId: s.cement, counted: '28', reason: 'Wet bags' }],
        },
        manager,
      ),
    );
    expect(c.lines).toEqual([
      expect.objectContaining({ bookQty: '30.0000', difference: '-2.0000', value: '-781.40' }),
    ]);
    expect(
      (
        await post(
          `/tenant/stores/${washim}/counts`,
          { countedOn: '2026-10-08', lines: [] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'count_open' });
    c = await ok(
      post(`/tenant/stock-counts/${c.id}/submit`, { rowVersion: c.rowVersion }, manager),
    );
    const pending = await ok<{ status: string; approval: { id: string; status: string } }>(
      get(`/tenant/stock-counts/${c.id}`, manager),
    );
    expect(pending).toMatchObject({ status: 'submitted', approval: { status: 'pending' } });
    expect(await balance(washim)).toEqual({ CEM: [30, 11721] });
    expect(
      (await ok<{ amount: string }>(get(`/tenant/approvals/${pending.approval.id}`))).amount,
    ).toBe('781.40');
    await ok(post(`/tenant/approvals/${pending.approval.id}/approve`, {}));
    expect(
      (await ok<{ status: string }>(get(`/tenant/stock-counts/${c.id}`, manager))).status,
    ).toBe('posted');
    // 11,721 × 2 / 30 = ₹781.40 out: 28 bags, ₹10,939.60.
    expect(await balance(washim)).toEqual({ CEM: [28, 10939.6] });

    // Reorder at 40: 12 bags short, and a draft requisition for them at the store's site.
    const st = await ok<Store>(
      post(`/tenant/stores/${washim}/reorder`, { resourceId: s.cement, level: '40' }, manager),
    );
    expect(st.stock[0]).toMatchObject({ reorderLevel: '40.0000', below: true });
    const req = await ok<{ status: string; lines: { qty: string; resourceId: string }[] }>(
      post(`/tenant/stores/${washim}/reorder-requisition`, {}, manager),
    );
    expect(req).toMatchObject({
      status: 'draft',
      lines: [{ resourceId: s.cement, qty: '12.0000' }],
    });
  });

  it("reports the project's consumption, and the ledger adds up to the balance", async () => {
    const c = await ok<{
      resources: {
        code: string;
        received: string;
        issued: string;
        issuedValue: string;
        inStock: string;
        stockValue: string;
      }[];
      byWbs: { wbsCode: string; qty: string; value: string }[];
    }>(get(`/tenant/projects/${s.project}/consumption`, worker));
    // Received 100 + 50 + 30 − 30 = 150; issued 60 + 45 − 5 = 100 (₹23,640 + 17,915.63 − 1,990.63 = ₹39,565);
    // in the two stores 28 + 20 = 48 (₹10,939.60 + 7,814). Received value 59,100 = 39,565 + 781.40 lost + 18,753.60.
    expect(c.resources).toEqual([
      expect.objectContaining({
        code: 'CEM',
        received: '150.0000',
        issued: '100.0000',
        issuedValue: '39565.00',
        inStock: '48.0000',
        stockValue: '18753.60',
      }),
    ]);
    expect(c.byWbs.map((w) => [w.wbsCode, w.qty, w.value])).toEqual([
      ['SUB', '60.0000', '23640.00'],
      ['SUP', '40.0000', '15925.00'],
    ]);
    const l = await ok<{ moves: { kind: string; balanceQty: string; balanceValue: string }[] }>(
      get(`/tenant/stores/${washim}/ledger/${s.cement}`, worker),
    );
    expect(l.moves.map((m) => m.kind)).toEqual([
      'receipt',
      'receipt',
      'issue',
      'receipt',
      'issue',
      'issue_return',
      'receipt_cancelled',
      'transfer_out',
      'transfer_out',
      'transfer_back',
      'adjustment',
    ]);
    expect(l.moves.at(-1)).toMatchObject({ balanceQty: '28.0000', balanceValue: '10939.60' });
    const [mismatch] = await db`
      SELECT b.store_id FROM proc.stock_balance b
      JOIN (SELECT store_id, resource_id, sum(qty) AS q, sum(value) AS v FROM proc.stock_move GROUP BY 1, 2) m
        USING (store_id, resource_id)
      WHERE b.qty <> m.q OR b.value <> m.v`;
    expect(mismatch).toBeUndefined();
    // Off the team: nothing.
    await db`DELETE FROM proj.member WHERE project_id = ${s.project} AND user_id = ${workerId}`;
    expect((await get(`/tenant/stores/${washim}`, worker)).statusCode).toBe(404);
  });

  it('values by FIFO lots on a tenant that chose FIFO before anything moved', async () => {
    const t2 = await readyTenant(app, control, ENC, 'fifo-admin@example.in');
    const as = t2.admin;
    expect(await ok(post('/tenant/stock/valuation', { method: 'fifo' }, as))).toEqual({
      method: 'fifo',
      changeable: true,
    });
    const f = await setup(as, 'Godown, Akola');
    const r1 = await buyAndReceive(as, f, [cementLine(f.cement, '100', '390')], '2026-10-01');
    const store = r1.store!.id;
    const r2 = await buyAndReceive(as, f, [cementLine(f.cement, '50', '402')], '2026-10-02');
    const issue = (qty: string) =>
      ok<{ id: string; lines: { value: string }[] }>(
        post(
          `/tenant/stores/${store}/issues`,
          {
            issuedOn: '2026-10-03',
            wbsCode: 'SUB',
            issuedTo: 'Gang 1',
            lines: [{ resourceId: f.cement, qty }],
          },
          as,
        ),
      );
    // 120 bags: all 100 at ₹390 and 20 of the ₹402 lot: 39,000 + 8,040 = ₹47,040.
    expect((await issue('120')).lines[0]!.value).toBe('47040.00');
    expect(await balance(store, as)).toEqual({ CEM: [30, 12060] });
    // The second receipt's lot is partly used: it cannot be cancelled.
    expect(
      (await post(`/tenant/receipts/${r2.id}/cancel`, { reason: 'Wrong' }, as)).json(),
    ).toMatchObject({
      code: 'stock_used',
    });
    // 30 more at ₹410.50; 40 out: the last 30 at ₹402 (12,060) and 10 at ₹410.50 (4,105): ₹16,165.
    await buyAndReceive(as, f, [cementLine(f.cement, '30', '410.50')], '2026-10-04');
    const i2 = await issue('40');
    expect(i2.lines[0]!.value).toBe('16165.00');
    expect(await balance(store, as)).toEqual({ CEM: [20, 8210] });
  });

  it('recovers cement issued to a subcontractor beyond what the certified work allows', async () => {
    // docs/wave8-plan.md step 8a.3. 100 bags into the site's store; a plastering work order of 100 sqm measured.
    const store = washim;
    const po = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${s.project}/orders`,
        {
          kind: 'purchase',
          partyId: s.vendor,
          siteId: s.site,
          lines: [cementLine(s.cement, '100', '400')],
        },
        manager,
      ),
    );
    const bought = await ok<{ id: string; progress: { lineKey: string }[] }>(
      post(
        `/tenant/order-revisions/${po.open.id}/submit`,
        { rowVersion: po.open.rowVersion },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/orders/${bought.id}/receipts`,
        {
          receivedOn: '2026-10-01',
          challanNo: 'DC-FI',
          storeId: store,
          lines: [{ lineKey: bought.progress[0]!.lineKey, qty: '100' }],
        },
        manager,
      ),
    );
    const wo = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${s.project}/orders`,
        {
          kind: 'work',
          partyId: s.vendor,
          siteId: s.site,
          lines: [
            { description: 'Plaster 12 mm', unit: 'sqm', qty: '500', rate: '120', gstPct: '18' },
          ],
        },
        manager,
      ),
    );
    const issued = await ok<{ id: string; inForce: { lines: { lineKey: string }[] } }>(
      post(
        `/tenant/order-revisions/${wo.open.id}/submit`,
        { rowVersion: wo.open.rowVersion },
        manager,
      ),
    );
    const lineKey = issued.inForce.lines[0]!.lineKey;
    await ok(
      post(
        `/tenant/work-orders/${issued.id}/measurements`,
        { lineKey, measuredOn: '2026-10-08', qty: '100' },
        manager,
      ),
    );
    // Half a bag a square metre, 2% wastage allowed, ₹450 a bag beyond that.
    await ok(
      put(
        `/tenant/work-orders/${issued.id}/free-issue`,
        {
          items: [
            { lineKey, resourceId: s.cement, perUnit: '0.5', wastagePct: '2', penalRate: '450' },
          ],
        },
        manager,
      ),
    );
    // 60 bags go to the plasterer: 51 allowed for 100 sqm, 9 beyond.
    expect(
      (
        await post(
          `/tenant/stores/${store}/issues`,
          {
            issuedOn: '2026-10-09',
            wbsCode: 'SUP',
            issuedTo: 'Plasterer',
            orderId: s.vendor,
            lines: [{ resourceId: s.cement, qty: '60' }],
          },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_a_work_order' });
    await ok(
      post(
        `/tenant/stores/${store}/issues`,
        {
          issuedOn: '2026-10-09',
          wbsCode: 'SUP',
          issuedTo: 'Plasterer',
          orderId: issued.id,
          lines: [{ resourceId: s.cement, qty: '60' }],
        },
        manager,
      ),
    );
    const bill = await ok<{ id: string }>(
      post(`/tenant/work-orders/${issued.id}/subcontract-bills`, { upto: '2026-10-10' }, manager),
    );
    interface Free {
      rows: {
        theoretical: string;
        allowed: string;
        excess: string;
        toRecover: string;
        amount: string;
        recoveredHere: string | null;
      }[];
    }
    const view = await ok<Free>(get(`/tenant/subcontract-bills/${bill.id}/free-issue`, manager));
    expect(view.rows[0]).toMatchObject({
      theoretical: '50.0000',
      allowed: '51.0000',
      excess: '9.0000',
      toRecover: '9.0000',
      amount: '4050.00',
      recoveredHere: null,
    });
    const after = await ok<Free>(
      post(`/tenant/subcontract-bills/${bill.id}/free-issue/recover`, {}, manager),
    );
    expect(after.rows[0]).toMatchObject({ recoveredHere: '4050.00' });
    const sb = await ok<{ backcharges: { description: string; amount: string }[] }>(
      get(`/tenant/subcontract-bills/${bill.id}`, manager),
    );
    expect(sb.backcharges).toEqual([
      expect.objectContaining({ amount: '4050.00', description: expect.stringContaining('9 bag') }),
    ]);
    expect(
      (await post(`/tenant/subcontract-bills/${bill.id}/free-issue/recover`, {}, manager)).json(),
    ).toMatchObject({ code: 'nothing_to_recover' });
  });
});
