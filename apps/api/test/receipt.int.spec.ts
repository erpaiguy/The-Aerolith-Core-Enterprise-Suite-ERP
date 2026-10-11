// Goods receipts in a real tenant database (docs/wave2b-plan.md step 5): part of a purchase order received, some
// rejected at the gate and some held for inspection; what is still owed, worked by hand; nothing beyond it; the held
// steel inspected, rejections returned to the supplier; an amendment cannot go below what came; the order closed when
// everything has come, and reopened when a receipt is cancelled; kept to the project's team.
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

describe.skipIf(!controlUrl || !adminUrl)('goods receipts (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let projectId: string;
  let lata: { id: string; headers: Record<string, string> };

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-grn-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'grn-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    lata = await staff('lata', 'worker');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  interface Progress {
    lineKey: string;
    description: string;
    ordered: string;
    accepted: string;
    onHold: string;
    rejected: string;
    returned: string;
    outstanding: string;
  }
  interface Order {
    id: string;
    number: string;
    status: string;
    statusReason: string | null;
    inForce: { lines: { lineKey: string; description: string }[] } | null;
    open: { id: string; rowVersion: number } | null;
    progress: Progress[];
    receipts: { number: string; status: string; held: number }[];
    mayReceive: boolean;
    mayCancel: boolean;
  }
  interface Receipt {
    id: string;
    number: string;
    status: string;
    site: { name: string } | null;
    lines: {
      position: number;
      description: string;
      qty: string;
      inspection: string;
      accepted: string;
      rejected: string;
      returned: string;
    }[];
    returns: { number: string; lines: { position: number; qty: string }[] }[];
    mayInspect: boolean;
    mayReturn: boolean;
    mayCancel: boolean;
  }

  let po: Order;
  let cementKey: string;
  let steelKey: string;
  let first: Receipt;
  let yard: string;
  let washim: string;

  const progress = async (as: Record<string, string> = manager) => {
    po = await ok<Order>(get(`/tenant/orders/${po.id}`, as));
    return Object.fromEntries(
      po.progress.map((l) => [
        l.description,
        [l.accepted, l.onHold, l.rejected, l.returned, l.outstanding].map((v) => Number(v)),
      ]),
    );
  };
  const issue = async (
    kind: 'purchase' | 'work',
    partyId: string,
    siteId: string,
    lines: object[],
  ) => {
    const o = await ok<Order>(
      post(`/tenant/projects/${projectId}/orders`, { kind, partyId, siteId, lines }, manager),
    );
    return ok<Order>(
      post(
        `/tenant/order-revisions/${o.open!.id}/submit`,
        { rowVersion: o.open!.rowVersion },
        manager,
      ),
    );
  };

  it('receives part of an order: rejected at the gate, held for inspection, and what is still owed', async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    await ok(
      post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
    );
    const p = await ok<{ sites: { id: string; name: string }[] }>(
      post(`/tenant/projects/${projectId}/sites`, { name: 'Store yard', stateCode: '27' }, manager),
    );
    washim = p.sites.find((s) => s.name === 'Washim')!.id;
    yard = p.sites.find((s) => s.name === 'Store yard')!.id;
    const vendor = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Vidarbha Cement Traders',
          isClient: false,
          isVendor: true,
          gstin: '27AAACV1234F1Z5',
        }),
      )
    ).id;
    // No approval rule: in force and issued when submitted.
    po = await issue('purchase', vendor, washim, [
      { description: 'Cement OPC 53', unit: 'bag', qty: '100', rate: '390', gstPct: '28' },
      { description: 'TMT bars Fe 500D', unit: 't', qty: '1.235', rate: '62000', gstPct: '18' },
    ]);
    expect(po).toMatchObject({ status: 'issued', mayReceive: true, receipts: [] });
    [cementKey, steelKey] = po.inForce!.lines.map((l) => l.lineKey) as [string, string];
    const wo = await issue('work', vendor, washim, [
      { description: 'Shuttering labour', unit: 'sqm', qty: '200', rate: '120', gstPct: '18' },
    ]);
    expect(wo.mayReceive).toBe(false);

    const receipt = (lines: object[], extra: object = {}) => ({
      receivedOn: '2026-10-05',
      challanNo: 'VCT/DC/441',
      vehicleNo: 'MH37 T 1234',
      lines,
      ...extra,
    });
    // The worker on the team receives (stores.receive is theirs by default); someone off it does not see the order.
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          receipt([{ lineKey: cementKey, qty: '1' }]),
          lata.headers,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/tenant/orders/${wo.id}/receipts`,
          receipt([{ lineKey: wo.inForce!.lines[0]!.lineKey, qty: '10' }]),
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'work_order' });
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          receipt([{ lineKey: cementKey, qty: '60', rejected: '2' }]),
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'reason_needed' });
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          receipt([
            { lineKey: cementKey, qty: '6' },
            { lineKey: cementKey, qty: '4' },
          ]),
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'duplicate_line' });
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          receipt([{ lineKey: cementKey, qty: '101' }]),
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'over_order' });
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          receipt([{ lineKey: cementKey, qty: '1' }], { receivedOn: '2099-01-01' }),
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'in_future' });

    // 60 bags, 2 burst at the gate; 0.5 t of steel held for a bend test.
    first = await ok<Receipt>(
      post(
        `/tenant/orders/${po.id}/receipts`,
        receipt([
          { lineKey: cementKey, qty: '60', rejected: '2', reason: 'Burst bags' },
          { lineKey: steelKey, qty: '0.5', hold: true },
        ]),
        worker,
      ),
    );
    expect(first).toMatchObject({
      number: expect.stringMatching(/^GRN\/\d{4}-\d{2}\/0001$/),
      status: 'posted',
      site: { name: 'Washim' }, // the order's
      mayInspect: true,
      mayReturn: true,
      mayCancel: true,
    });
    expect(
      first.lines.map((l) => [l.description, l.qty, l.inspection, l.accepted, l.rejected]),
    ).toEqual([
      ['Cement OPC 53', '60.0000', 'gate', '58.0000', '2.0000'],
      ['TMT bars Fe 500D', '0.5000', 'hold', '0.0000', '0.0000'],
    ]);
    // Accepted, on hold, rejected, returned, still owed. Cement: 100 − 58 = 42 (the burst bags are still owed).
    // Steel: 1.235 − 0.5 on hold = 0.735.
    expect(await progress(worker)).toEqual({
      'Cement OPC 53': [58, 0, 2, 0, 42],
      'TMT bars Fe 500D': [0, 0.5, 0, 0, 0.735],
    });
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          receipt([{ lineKey: cementKey, qty: '43' }]),
          worker,
        )
      ).json(),
    ).toMatchObject({
      code: 'over_order',
      message: expect.stringContaining('42 bag is still owed'),
    });
    expect(po.receipts).toEqual([expect.objectContaining({ number: first.number, held: 1 })]);
  });

  it('inspects what was held and returns rejections; the order keeps what came', async () => {
    expect(
      (
        await post(
          `/tenant/receipts/${first.id}/inspect`,
          { lines: [{ position: 2, accepted: '0.45', rejected: '0.04', reason: 'Bent bars' }] },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'does_not_add_up' });
    expect(
      (
        await post(
          `/tenant/receipts/${first.id}/inspect`,
          { lines: [{ position: 1, accepted: '60' }] },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'not_on_hold' });
    first = await ok<Receipt>(
      post(
        `/tenant/receipts/${first.id}/inspect`,
        { lines: [{ position: 2, accepted: '0.45', rejected: '0.05', reason: 'Bent bars' }] },
        worker,
      ),
    );
    expect(first.mayInspect).toBe(false);
    // Steel: 1.235 − 0.45 accepted = 0.785 owed.
    expect(await progress()).toEqual({
      'Cement OPC 53': [58, 0, 2, 0, 42],
      'TMT bars Fe 500D': [0.45, 0, 0.05, 0, 0.785],
    });

    // The rejected goods go back: not more than was rejected.
    const back = (lines: object[]) => ({
      returnedOn: '2026-10-06',
      reference: 'Gate pass 77',
      reason: 'Rejected on receipt',
      lines,
    });
    expect(
      (
        await post(
          `/tenant/receipts/${first.id}/returns`,
          back([{ position: 1, qty: '3' }]),
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'over_rejected' });
    first = await ok<Receipt>(
      post(
        `/tenant/receipts/${first.id}/returns`,
        back([
          { position: 1, qty: '2' },
          { position: 2, qty: '0.05' },
        ]),
        worker,
      ),
    );
    expect(first.returns).toEqual([
      expect.objectContaining({
        number: expect.stringMatching(/^RTV\/\d{4}-\d{2}\/0001$/),
        lines: [
          { position: 1, qty: '2.0000' },
          { position: 2, qty: '0.0500' },
        ],
      }),
    ]);
    expect(first).toMatchObject({ mayReturn: false, mayCancel: false });
    expect(
      (await post(`/tenant/receipts/${first.id}/cancel`, { reason: 'Mistake' }, worker)).json(),
    ).toMatchObject({
      code: 'has_returns',
    });
    expect((await progress())['Cement OPC 53']).toEqual([58, 0, 2, 2, 42]);

    // An amendment cannot ask for less than came (58 bags), nor drop the steel; the order cannot be cancelled.
    po = await ok<Order>(post(`/tenant/orders/${po.id}/amend`, { reason: 'Fewer bags' }, manager));
    const amend = async (lines: object[]) => {
      po = await ok<Order>(
        post(
          `/tenant/order-revisions/${po.open!.id}`,
          { rowVersion: po.open!.rowVersion, siteId: washim, lines },
          manager,
        ),
      );
      return (
        await post(
          `/tenant/order-revisions/${po.open!.id}/submit`,
          { rowVersion: po.open!.rowVersion },
          manager,
        )
      ).json();
    };
    const cement = {
      lineKey: cementKey,
      description: 'Cement OPC 53',
      unit: 'bag',
      rate: '390',
      gstPct: '28',
    };
    const steel = {
      lineKey: steelKey,
      description: 'TMT bars Fe 500D',
      unit: 't',
      rate: '62000',
      gstPct: '18',
    };
    expect(
      await amend([
        { ...cement, qty: '50' },
        { ...steel, qty: '1.235' },
      ]),
    ).toMatchObject({
      code: 'below_received',
      message: expect.stringContaining('Cement OPC 53: 58 already came'),
    });
    expect(await amend([{ ...cement, qty: '100' }])).toMatchObject({ code: 'below_received' });
    po = await ok<Order>(post(`/tenant/order-revisions/${po.open!.id}/discard`, {}, manager));
    expect(po.mayCancel).toBe(false);
    expect(
      (await post(`/tenant/orders/${po.id}/cancel`, { reason: 'Not needed' }, manager)).json(),
    ).toMatchObject({
      code: 'has_receipts',
    });
  });

  it('closes the order when everything has come, and reopens it when a receipt is cancelled', async () => {
    const last = await ok<Receipt>(
      post(
        `/tenant/orders/${po.id}/receipts`,
        {
          receivedOn: '2026-10-08',
          siteId: yard,
          challanNo: 'VCT/DC/458',
          lines: [
            { lineKey: cementKey, qty: '42' },
            { lineKey: steelKey, qty: '0.785' },
          ],
        },
        worker,
      ),
    );
    expect(last).toMatchObject({
      number: expect.stringMatching(/\/0002$/),
      site: { name: 'Store yard' },
    });
    expect(await progress()).toEqual({
      'Cement OPC 53': [100, 0, 2, 2, 0],
      'TMT bars Fe 500D': [1.235, 0, 0.05, 0.05, 0],
    });
    expect(po).toMatchObject({
      status: 'closed',
      statusReason: 'Received in full',
      mayReceive: false,
    });
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          { receivedOn: '2026-10-08', challanNo: 'X', lines: [{ lineKey: cementKey, qty: '1' }] },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'not_receivable' });
    // Entered against the wrong order: cancelled, the goods are owed again and the order is open.
    const c = await ok<Receipt>(
      post(
        `/tenant/receipts/${last.id}/cancel`,
        { reason: 'Entered against the wrong order' },
        worker,
      ),
    );
    expect(c).toMatchObject({ status: 'cancelled', mayCancel: false });
    expect((await progress())['Cement OPC 53']).toEqual([58, 0, 2, 2, 42]);
    expect(po).toMatchObject({ status: 'issued', statusReason: null, mayReceive: true });
    const ev = await db<
      { kind: string }[]
    >`SELECT kind FROM proj.project_event WHERE project_id = ${projectId}
      AND kind IN ('goods_received', 'goods_returned', 'order_closed', 'receipt_cancelled') ORDER BY id`;
    expect(ev.map((e) => e.kind)).toEqual([
      'goods_received',
      'goods_returned',
      'goods_received',
      'order_closed',
      'receipt_cancelled',
    ]);
  });

  it("keeps receipts to the project's team", async () => {
    expect(
      (await ok<{ number: string }[]>(get(`/tenant/receipts?projectId=${projectId}`, worker))).map(
        (r) => r.number,
      ),
    ).toEqual([expect.stringMatching(/\/0002$/), first.number]);
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect((await get(`/tenant/receipts/${first.id}`, worker)).statusCode).toBe(200);
    expect(
      (
        await post(
          `/tenant/orders/${po.id}/receipts`,
          { receivedOn: '2026-10-08', challanNo: 'X', lines: [{ lineKey: cementKey, qty: '1' }] },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'forbidden' });
    expect((await get(`/tenant/receipts/${first.id}`, lata.headers)).statusCode).toBe(404);
    expect(await ok<unknown[]>(get('/tenant/receipts', lata.headers))).toEqual([]);
  });
});
