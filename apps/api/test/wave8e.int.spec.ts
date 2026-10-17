// Wave 8e in a real tenant database (docs/wave8-plan.md): purchase and stores — the vendor master, delivery
// follow-up, receipts and transfers as they happen, buying with history, scrap and tools.
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

describe.skipIf(!controlUrl || !adminUrl)('wave 8e: purchase and stores (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w8e-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'w8e-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
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

  let site: string;
  const party = async (name: string, kind: 'isVendor' | 'isSubcontractor' = 'isVendor') =>
    (await ok<{ id: string }>(post('/tenant/parties', { name, [kind]: true }))).id;

  it('keeps the vendor master and offers enquiries and orders only to vendors allowed', async () => {
    projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Washim', contractValue: '10000000' }, manager),
      )
    ).id;
    site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    const [ultra, shree, kaka] = [
      await party('UltraTech dealer, Akola'),
      await party('Shree Cement Traders'),
      await party('Kaka Steel'),
    ];

    // Categories and status: a hold or a blacklisting needs a reason; the worker may not change either.
    expect(
      (await post(`/tenant/vendors/${ultra}/categories`, { categories: ['cement'] }, worker))
        .statusCode,
    ).toBe(403);
    await ok(post(`/tenant/vendors/${ultra}/categories`, { categories: ['cement'] }, manager));
    await ok(
      post(`/tenant/vendors/${ultra}/status`, { status: 'approved', reason: 'Visited' }, manager),
    );
    expect(
      (await post(`/tenant/vendors/${kaka}/status`, { status: 'blacklisted' }, manager)).json(),
    ).toMatchObject({ code: 'reason_required' });
    await ok(
      post(
        `/tenant/vendors/${kaka}/status`,
        { status: 'blacklisted', reason: 'Short-weight steel twice' },
        manager,
      ),
    );
    const cement = await ok<{ id: string; status: string; categories: string[] }[]>(
      get('/tenant/vendors?category=cement', manager),
    );
    expect(cement.map((v) => [v.id, v.status, v.categories])).toEqual([
      [ultra, 'approved', ['cement']],
    ]);

    // KYC: a GST certificate with its scan and expiry; the expiry is reminded 30 and 7 days before.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(512)]);
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const withScan = await app.inject({
      method: 'POST',
      url: `/api/tenant/vendors/${ultra}/documents?kind=gst_certificate&number=27ABCDE1234F1Z5&validUntil=2027-03-31`,
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="gst.pdf"\r\n` +
            'Content-Type: application/pdf\r\n\r\n',
        ),
        pdf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { ...manager, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(withScan.statusCode).toBe(200);
    const v = await ok<{
      documents: { id: string; kind: string; validUntil: string; mime: string }[];
    }>(
      post(
        `/tenant/vendors/${ultra}/documents`,
        { kind: 'cancelled_cheque', number: '004512' },
        manager,
      ),
    );
    expect(v.documents.map((d) => [d.kind, d.validUntil, d.mime])).toEqual([
      ['cancelled_cheque', null, null],
      ['gst_certificate', '2027-03-31', 'application/pdf'],
    ]);
    const file = await get(`/tenant/vendor-documents/${v.documents[1]!.id}/file`, manager);
    expect(Buffer.compare(file.rawPayload, pdf)).toBe(0);
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const [n] = await db<{ count: number }[]>`
      SELECT count(*)::int FROM platform.notification WHERE source = ${`vendor-document:${v.documents[1]!.id}`}`;
    expect(n!.count).toBe(2);

    // An enquiry in cement: the blacklisted vendor is refused; with "approved only" on, so is the unvetted one.
    const rfq = await ok<{ id: string }>(
      post(`/tenant/projects/${projectId}/rfqs`, { title: 'Cement for the raft' }, manager),
    );
    await ok(post(`/tenant/rfqs/${rfq.id}/category`, { category: 'cement' }, manager));
    expect(
      (await post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: kaka }, manager)).json(),
    ).toMatchObject({ code: 'vendor_not_allowed', message: /blacklisted: Short-weight/ });
    await ok(post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: shree }, manager));
    await ok(post('/tenant/vendor-policy', { approvedOnly: true }, manager));
    const refused = await ok<{ vendors: { party: { id: string } }[] }>(
      get(`/tenant/rfqs/${rfq.id}`, manager),
    );
    expect(refused.vendors).toHaveLength(1);
    await ok(post(`/tenant/vendors/${shree}/status`, { status: 'approved', reason: '' }, manager));
    // Approved, but not in cement.
    expect(
      (await post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: shree }, manager)).json(),
    ).toMatchObject({ code: 'vendor_not_allowed', message: /trade category/ });
    await ok(post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: ultra }, manager));

    // Orders: never to the blacklisted vendor.
    const line = { description: 'OPC 53', unit: 'bag', qty: '100', rate: '380', gstPct: '28' };
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/orders`,
          { kind: 'purchase', partyId: kaka, siteId: site, lines: [line] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'vendor_not_allowed' });
    const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        { kind: 'purchase', partyId: ultra, siteId: site, lines: [line] },
        manager,
      ),
    );
    const issued = await ok<{ id: string; inForce: { lines: { lineKey: string }[] } }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    cementOrder = { id: issued.id, key: issued.inForce.lines[0]!.lineKey };
    await ok(post('/tenant/vendor-policy', { approvedOnly: false }, manager));
  });

  let cementOrder: { id: string; key: string };
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  it('follows up staggered deliveries, notes the chasing, and reports the lead time', async () => {
    // 100 bags in three instalments; 40 come today: the first is in, the second overdue by 20, the third due.
    const slots = [
      { dueOn: '2026-10-01', qty: '30' },
      { dueOn: '2026-10-10', qty: '30' },
      { dueOn: '2099-12-01', qty: '30' },
    ];
    expect(
      (
        await post(
          `/tenant/orders/${cementOrder.id}/schedule`,
          { lineKey: cementOrder.key, slots: [...slots, { dueOn: '2099-12-02', qty: '11' }] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'over_ordered' });
    await ok(
      post(
        `/tenant/orders/${cementOrder.id}/schedule`,
        { lineKey: cementOrder.key, slots },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/orders/${cementOrder.id}/receipts`,
        { receivedOn: today, challanNo: 'DC-11', lines: [{ lineKey: cementOrder.key, qty: '40' }] },
        manager,
      ),
    );
    const f = await ok<{
      lines: { schedule: { dueOn: string; came: string; short: string; state: string }[] }[];
    }>(
      post(
        `/tenant/orders/${cementOrder.id}/expedite`,
        { note: 'Dealer says the rake is late', promisedOn: '2099-11-25' },
        manager,
      ),
    );
    expect(f.lines[0]!.schedule.map((s) => [s.dueOn, s.came, s.short, s.state])).toEqual([
      ['2026-10-01', '30.0000', '0.0000', 'received'],
      ['2026-10-10', '10.0000', '20.0000', 'overdue'],
      ['2099-12-01', '0.0000', '30.0000', 'due'],
    ]);
    expect(
      (await post(`/tenant/orders/${cementOrder.id}/expedite`, { note: 'x' }, worker)).statusCode,
    ).toBe(400);

    const late = await ok<
      { number: string; promisedOn: string; late: { dueOn: string; short: string }[] }[]
    >(get(`/tenant/procurement/overdue-deliveries?projectId=${projectId}`, manager));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      promisedOn: '2099-11-25',
      late: [{ description: 'OPC 53', dueOn: '2026-10-10', short: '20.0000' }],
    });

    const lt = await ok<{ orders: { toDeliver: number; total: number }[]; average: object }>(
      get(`/tenant/procurement/lead-times?from=2026-04-01&to=2099-03-31`, manager),
    );
    expect(lt.orders).toHaveLength(1);
    expect(lt.orders[0]).toMatchObject({ toDeliver: 0, total: 0 });
  });

  let sandId: string;

  it('takes a weighbridge load within tolerance, and moves sand to a central store with a transit loss', async () => {
    const entityId = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies')))
      .companies[0]!.id;
    const sand = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code: 'SAND',
          name: 'River sand',
          kind: 'material',
          unit: 'cum',
          rate: '1800',
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;
    sandId = sand;
    const ultra = (
      await ok<{ id: string; name: string }[]>(get('/tenant/vendors?status=approved'))
    ).find((v) => v.name.startsWith('UltraTech'))!.id;
    const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: ultra,
          siteId: site,
          lines: [
            {
              resourceId: sand,
              description: 'River sand',
              unit: 'cum',
              qty: '100',
              rate: '1800',
              gstPct: '5',
            },
          ],
        },
        manager,
      ),
    );
    const po = await ok<{ id: string; inForce: { lines: { lineKey: string }[] } }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    const key = po.inForce.lines[0]!.lineKey;

    // 5% tolerance: after 90 cum, a load of 16 would make 106 and is refused; 14 (104 in all) is taken.
    expect(
      (await post(`/tenant/orders/${po.id}/receipt-tolerance`, { pct: '5' }, worker)).statusCode,
    ).toBe(404); // the worker is not on the project's team
    await ok(post(`/tenant/orders/${po.id}/receipt-tolerance`, { pct: '5' }, manager));
    const grn = (qty: string, challanNo: string) =>
      post(
        `/tenant/orders/${po.id}/receipts`,
        {
          receivedOn: today,
          challanNo,
          vehicleNo: 'MH37 T 4410',
          transporter: 'Akola Roadlines',
          ewayBillNo: '271234567890',
          lines: [{ lineKey: key, qty }],
        },
        manager,
      );
    await ok(grn('90', 'WB-1'));
    expect((await grn('16', 'WB-2')).json()).toMatchObject({ code: 'over_order' });
    await ok(grn('14', 'WB-2'));

    // The company's central store at the Akola yard: not a project in the register, but a store everyone works.
    const central = await ok<{ id: string; central: boolean }>(
      post(
        '/tenant/stores/central',
        { entityId, name: 'Akola central store', yard: 'Akola yard', stateCode: '27' },
        manager,
      ),
    );
    expect(central.central).toBe(true);
    const projects = await ok<{ items: { name: string }[] }>(get('/tenant/projects', manager));
    expect(projects.items.map((p) => p.name)).not.toContain('Central stores');
    // The worker is on no project's team, yet sees the central store.
    const theirs = await ok<{ id: string; central: boolean }[]>(get('/tenant/stores', worker));
    expect(theirs.map((x) => [x.id, x.central])).toEqual([[central.id, true]]);
    const stores = await ok<{ id: string; central: boolean }[]>(get('/tenant/stores', manager));
    const siteStore = stores.find((x) => !x.central)!.id;

    // 50 cum sent with its papers; 48 arrive, 2 lost on the road at their share of the value.
    const t = await ok<{ id: string; vehicleNo: string; ewayBillNo: string }>(
      post(
        `/tenant/stores/${siteStore}/transfers`,
        {
          toStoreId: central.id,
          sentOn: today,
          vehicleNo: 'MH30 AB 1201',
          transporter: 'Own tipper',
          ewayBillNo: '271234567891',
          lines: [{ resourceId: sand, qty: '50' }],
        },
        manager,
      ),
    );
    expect([t.vehicleNo, t.ewayBillNo]).toEqual(['MH30 AB 1201', '271234567891']);
    expect(
      (
        await post(
          `/tenant/transfers/${t.id}/receive`,
          { receivedOn: today, short: [{ position: 1, receivedQty: '48' }] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'reason_needed' });
    const got = await ok<{
      status: string;
      lines: { receivedQty: string; lostQty: string; lostValue: string; lossReason: string }[];
    }>(
      post(
        `/tenant/transfers/${t.id}/receive`,
        {
          receivedOn: today,
          short: [{ position: 1, receivedQty: '48', reason: 'Spilt on the ghat road' }],
        },
        manager,
      ),
    );
    expect(got.status).toBe('received');
    expect(got.lines[0]).toMatchObject({
      receivedQty: '48.0000',
      lostQty: '2.0000',
      lostValue: '3600.00',
      lossReason: 'Spilt on the ghat road',
    });
    const c = await ok<{ stock: { code: string; qty: string; value: string }[] }>(
      get(`/tenant/stores/${central.id}`, worker),
    );
    expect(c.stock.map((x) => [x.code, x.qty, x.value])).toEqual([['SAND', '48.0000', '86400.00']]);
  });

  it('shows the last rate and its change, fills a store up to its maximum, and ages the stock', async () => {
    const ultra = (
      await ok<{ id: string; name: string }[]>(get('/tenant/vendors?status=approved'))
    ).find((v) => v.name.startsWith('UltraTech'))!.id;
    const o = await ok<{ id: string; open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: ultra,
          siteId: site,
          lines: [
            {
              resourceId: sandId,
              description: 'River sand',
              unit: 'cum',
              qty: '20',
              rate: '1890',
              gstPct: '5',
            },
          ],
        },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    expect(
      (await get(`/tenant/procurement/purchase-history?resourceIds=${sandId}`, worker)).statusCode,
    ).toBe(403);
    const [h] = await ok<
      {
        last: { rate: string; party: string };
        previousRate: string;
        changePct: number;
        trend: object[];
      }[]
    >(get(`/tenant/procurement/purchase-history?resourceIds=${sandId}`, manager));
    expect(h).toMatchObject({
      last: { rate: '1890.0000', party: 'UltraTech dealer, Akola' },
      previousRate: '1800.0000',
      changePct: 5,
    });
    expect(h!.trend).toHaveLength(1);

    // The site store holds 54 cum: below a minimum of 60, so a reorder fills it up to the maximum of 120.
    const stores = await ok<{ id: string; central: boolean }[]>(get('/tenant/stores', manager));
    const siteStore = stores.find((x) => !x.central)!.id;
    expect(
      (
        await post(
          `/tenant/stores/${siteStore}/reorder`,
          { resourceId: sandId, level: '60', max: '50' },
          manager,
        )
      ).statusCode,
    ).toBe(400);
    const store = await ok<{
      stock: { code: string; qty: string; maxLevel: string; below: boolean }[];
    }>(
      post(
        `/tenant/stores/${siteStore}/reorder`,
        { resourceId: sandId, level: '60', max: '120' },
        manager,
      ),
    );
    expect(store.stock.find((x) => x.code === 'SAND')).toMatchObject({
      qty: '54.0000',
      maxLevel: '120.0000',
      below: true,
    });
    const req = await ok<{ lines: { qty: string }[] }>(
      post(`/tenant/stores/${siteStore}/reorder-requisition`, {}, manager),
    );
    expect(req.lines.map((l) => l.qty)).toEqual(['66.0000']);

    // Ageing: all of it came in today, none issued yet, so nothing is slow.
    const age = await ok<{
      rows: {
        store: string;
        code: string;
        qty: string;
        buckets: Record<string, string>;
        slow: boolean;
      }[];
      totals: Record<string, string>;
    }>(get('/tenant/procurement/stock-ageing', manager));
    expect(age.rows.map((r) => [r.code, r.qty, r.buckets['0-30'], r.slow])).toEqual([
      ['SAND', '48.0000', '86400.00', false],
      ['SAND', '54.0000', '97200.00', false],
    ]);
    expect(age.totals['0-30']).toBe('183600.00');
  });
});
