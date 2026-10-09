// Tender register in a real tenant database: clients, numbering, status flow, bid/no-bid decisions, reminders, roles,
// optimistic concurrency and the append-only tables.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { DEFAULT_CRITERIA, financialYear } from '../src/tender/tender-rules.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
const DAY = 86_400_000;

interface TenderView {
  id: string;
  number: string;
  status: string;
  rowVersion: number;
  allowedMoves: string[];
  canDecide: boolean;
  client: { id: string; name: string } | null;
  owner: { id: string; displayName: string } | null;
  estimatedValue: string | null;
  decisions: { score: string; decision: string; criteria: { label: string }[] }[];
  events: { kind: string; data: Record<string, unknown> }[];
}

describe.skipIf(!controlUrl || !adminUrl)('tender register (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let tenantDb: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let clientId: string;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });

  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ temporaryPassword: string }>();
    const login = (password: string) =>
      post('/auth/login', {
        entitlementToken: t.entitlement,
        identifier: username,
        password,
        client: 'desktop',
      }).then((r) => r.json<{ accessToken: string }>().accessToken);
    const first = await login(created.temporaryPassword);
    await post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: 'Bar-Bending-Yard-44' },
      { authorization: `Bearer ${first}` },
    );
    return { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` };
  }

  const criteria = (score: number) =>
    DEFAULT_CRITERIA.map((c) => ({ key: c.key, weight: c.weight, score }));

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
      RATE_LIMIT_SCALE: '20',
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'tender-admin@example.in');
    manager = await staff('priya', 'manager');
    worker = await staff('ramesh', 'worker');
    tenantDb = await app.get(TenantConnections).forTenant(t.tenantId);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  describe('parties', () => {
    it('creates a client, validates GSTIN and PAN, and rejects duplicate names', async () => {
      const bad = await post(
        '/tenant/parties',
        { name: 'CPWD Division 4', gstin: '27ABC', pan: 'nope' },
        manager,
      );
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toEqual([
        'gstin',
        'pan',
      ]);
      const ok = await post(
        '/tenant/parties',
        { name: 'CPWD Division 4', gstin: '27aaacc1234f1z5', email: '' },
        manager,
      );
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ isClient: true, gstin: '27AAACC1234F1Z5', email: null });
      clientId = ok.json<{ id: string }>().id;
      const dup = await post('/tenant/parties', { name: 'cpwd division 4' }, manager);
      expect(dup.json()).toMatchObject({ code: 'party_name_taken' });
    });

    it('searches and filters by kind; workers can read but not add', async () => {
      await post(
        '/tenant/parties',
        { name: 'Shree Cement Traders', isClient: false, isVendor: true },
        manager,
      );
      const clients = (await get('/tenant/parties?kind=client', worker)).json<{ name: string }[]>();
      expect(clients.map((c) => c.name)).toEqual(['CPWD Division 4']);
      const search = (await get('/tenant/parties?q=cement', worker)).json<{ name: string }[]>();
      expect(search.map((c) => c.name)).toEqual(['Shree Cement Traders']);
      expect((await post('/tenant/parties', { name: 'Not Allowed' }, worker)).statusCode).toBe(403);
    });

    it('updates with a row version and reports a stale edit', async () => {
      const ok = await post(
        `/tenant/parties/${clientId}`,
        { rowVersion: 1, phone: '+91 22 2222 0000' },
        manager,
      );
      expect(ok.json()).toMatchObject({ phone: '+91 22 2222 0000', rowVersion: 2 });
      const stale = await post(
        `/tenant/parties/${clientId}`,
        { rowVersion: 1, phone: 'x' },
        manager,
      );
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'stale_row' });
    });
  });

  describe('tenders', () => {
    let tender: TenderView;

    it('creates a tender with the next number of the financial year and the creator as owner', async () => {
      const due = new Date(Date.now() + 10 * DAY).toISOString();
      const res = await post(
        '/tenant/tenders',
        {
          title: 'G+4 hostel block, Pune campus',
          clientId,
          clientRef: 'NIT/04/2026-27',
          source: 'public_portal',
          estimatedValue: '125000000.00',
          emdAmount: 2_500_000,
          submissionDueAt: due,
          prebidAt: new Date(Date.now() + 4 * DAY).toISOString(),
        },
        manager,
      );
      expect(res.statusCode).toBe(201);
      tender = res.json<TenderView>();
      const fy = financialYear(new Date());
      expect(tender.number).toBe(`TND/${fy}/0001`);
      expect(tender).toMatchObject({
        status: 'lead',
        client: { id: clientId, name: 'CPWD Division 4' },
        owner: { displayName: 'priya' },
        estimatedValue: '125000000.00',
        canDecide: true,
      });
      expect(tender.allowedMoves).toEqual(['evaluating', 'cancelled']);
      const second = (
        await post('/tenant/tenders', { title: 'Boundary wall' }, t.admin)
      ).json<TenderView>();
      expect(second.number).toBe(`TND/${fy}/0002`);
    });

    it('schedules deadline reminders for the owner and moves them when the date changes', async () => {
      const reminders = () =>
        tenantDb<{ title: string; due_at: Date }[]>`
          SELECT title, due_at FROM platform.notification WHERE source = ${`tender:${tender.id}`} ORDER BY due_at`;
      expect((await reminders()).map((r) => r.title)).toEqual([
        expect.stringContaining('Pre-bid meeting tomorrow'),
        expect.stringContaining('due in 3 days'),
        expect.stringContaining('due in 1 day'),
      ]);
      const newDue = new Date(Date.now() + 20 * DAY);
      const res = await post(
        `/tenant/tenders/${tender.id}`,
        { rowVersion: tender.rowVersion, submissionDueAt: newDue.toISOString(), prebidAt: null },
        manager,
      );
      expect(res.statusCode).toBe(200);
      tender = res.json<TenderView>();
      const after = await reminders();
      expect(after).toHaveLength(2);
      expect(after[1]!.due_at.getTime()).toBe(newDue.getTime() - DAY);
    });

    it('rejects a stale edit and invalid money', async () => {
      const stale = await post(
        `/tenant/tenders/${tender.id}`,
        { rowVersion: 1, title: 'Changed' },
        manager,
      );
      expect(stale.json()).toMatchObject({ code: 'stale_row' });
      const money = await post(
        `/tenant/tenders/${tender.id}`,
        { rowVersion: tender.rowVersion, emdAmount: '12.345' },
        manager,
      );
      expect(money.statusCode).toBe(400);
    });

    it('cannot skip to bidding without a decision', async () => {
      const res = await post(`/tenant/tenders/${tender.id}/status`, { to: 'bidding' }, manager);
      expect(res.json()).toMatchObject({
        code: 'invalid_status_change',
        from: 'lead',
        to: 'bidding',
      });
      const ok = await post(`/tenant/tenders/${tender.id}/status`, { to: 'evaluating' }, manager);
      expect(ok.json<TenderView>().status).toBe('evaluating');
    });

    it('records a no-bid with a reason, then reconsiders and bids', async () => {
      const noReason = await post(
        `/tenant/tenders/${tender.id}/decision`,
        { criteria: criteria(2), decision: 'no_bid' },
        manager,
      );
      expect(noReason.json()).toMatchObject({ code: 'reason_required' });
      const noBid = await post(
        `/tenant/tenders/${tender.id}/decision`,
        { criteria: criteria(2), decision: 'no_bid', reason: 'Client pays late' },
        manager,
      );
      expect(noBid.json<TenderView>()).toMatchObject({ status: 'no_bid' });
      // Closed: the future reminders are gone.
      const left = await tenantDb<{ n: number }[]>`
        SELECT count(*)::int AS n FROM platform.notification WHERE source = ${`tender:${tender.id}`}`;
      expect(left).toEqual([{ n: 0 }]);

      await post(`/tenant/tenders/${tender.id}/status`, { to: 'evaluating' }, manager);
      const bid = await post(
        `/tenant/tenders/${tender.id}/decision`,
        { criteria: criteria(4), decision: 'bid', reason: 'Payment terms improved' },
        t.admin,
      );
      tender = bid.json<TenderView>();
      expect(tender.status).toBe('bidding');
      expect(tender.decisions.map((d) => [d.decision, d.score])).toEqual([
        ['bid', '75.0'],
        ['no_bid', '25.0'],
      ]);
      expect(tender.decisions[0]!.criteria[0]!.label).toBe(DEFAULT_CRITERIA[0]!.label);
    });

    it('rejects unknown or duplicate criteria', async () => {
      const res = await post(
        `/tenant/tenders/${tender.id}/decision`,
        { criteria: [{ key: 'vibes', weight: 1, score: 5 }], decision: 'bid' },
        manager,
      );
      expect(res.json()).toMatchObject({ code: 'invalid_criteria' });
    });

    it('needs a reason for lost, then is final', async () => {
      await post(`/tenant/tenders/${tender.id}/status`, { to: 'submitted' }, manager);
      const noReason = await post(`/tenant/tenders/${tender.id}/status`, { to: 'lost' }, manager);
      expect(noReason.json()).toMatchObject({ code: 'reason_required' });
      const lost = await post(
        `/tenant/tenders/${tender.id}/status`,
        { to: 'lost', reason: 'L2 by 1.8%' },
        manager,
      );
      tender = lost.json<TenderView>();
      expect(tender).toMatchObject({ status: 'lost', allowedMoves: [], canDecide: false });
      expect(tender.events.map((e) => e.kind)).toEqual([
        'status_changed',
        'status_changed',
        'decision',
        'status_changed',
        'decision',
        'status_changed',
        'updated',
        'created',
      ]);
    });

    it('lists with counts, open/closed filters and search; workers can read but not change', async () => {
      const all = (await get('/tenant/tenders', worker)).json<{
        items: { number: string; status: string }[];
        counts: Record<string, number>;
      }>();
      expect(all.counts).toEqual({ lead: 1, lost: 1 });
      expect(all.items[0]!.status).toBe('lead'); // open tenders first
      const open = (await get('/tenant/tenders?status=open', worker)).json<{ items: unknown[] }>();
      expect(open.items).toHaveLength(1);
      const search = (await get('/tenant/tenders?q=cpwd', worker)).json<{
        items: { status: string }[];
      }>();
      expect(search.items.map((i) => i.status)).toEqual(['lost']);
      expect((await post('/tenant/tenders', { title: 'Nope nope' }, worker)).statusCode).toBe(403);
      expect(
        (await post(`/tenant/tenders/${tender.id}/status`, { to: 'won' }, worker)).statusCode,
      ).toBe(403);
    });

    it('keeps decisions and events append-only for the app role', async () => {
      await expect(tenantDb`UPDATE tender.bid_decision SET score = 100`).rejects.toThrow(
        /permission denied/,
      );
      await expect(tenantDb`DELETE FROM tender.tender_event`).rejects.toThrow(/permission denied/);
      await expect(tenantDb`DELETE FROM tender.tender`).rejects.toThrow(/permission denied/);
    });
  });

  describe('role permissions (admin-configurable)', () => {
    it('reports what each user may do', async () => {
      expect((await get('/tenant/permissions/mine', worker)).json()).toEqual([]);
      expect((await get('/tenant/permissions/mine', manager)).json()).toEqual([
        'tender.edit',
        'boq.edit',
        'rates.edit',
      ]);
      expect((await get('/tenant/permissions/mine', t.admin)).json()).toEqual([
        'tender.edit',
        'boq.edit',
        'rates.edit',
      ]);
      expect((await get('/tenant/permissions', worker)).statusCode).toBe(403);
      const all = (await get('/tenant/permissions', t.admin)).json<{
        grants: Record<string, Record<string, boolean>>;
      }>();
      expect(all.grants).toEqual({
        manager: { 'tender.edit': true, 'boq.edit': true, 'rates.edit': true },
        worker: { 'tender.edit': false, 'boq.edit': false, 'rates.edit': false },
      });
    });

    it('lets the admin allow workers to edit BOQs, and only that', async () => {
      const tenderId = (await get('/tenant/tenders', t.admin)).json<{ items: { id: string }[] }>()
        .items[0]!.id;
      expect(
        (await post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Worker BOQ' }, worker)).statusCode,
      ).toBe(403);
      const set = await post(
        '/tenant/permissions',
        { role: 'worker', permission: 'boq.edit', granted: true },
        t.admin,
      );
      expect(set.json()).toMatchObject({ grants: { worker: { 'boq.edit': true } } });
      expect((await get('/tenant/permissions/mine', worker)).json()).toEqual(['boq.edit']);
      expect(
        (await post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Worker BOQ' }, worker)).statusCode,
      ).toBe(201);
      expect(
        (await post('/tenant/tenders', { title: 'Still not allowed' }, worker)).statusCode,
      ).toBe(403);
    });

    it('lets the admin take a permission away from managers, with an audit record', async () => {
      await post(
        '/tenant/permissions',
        { role: 'manager', permission: 'tender.edit', granted: false },
        t.admin,
      );
      const denied = await post('/tenant/tenders', { title: 'Manager blocked' }, manager);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: 'forbidden', permission: 'tender.edit' });
      const [row] = await tenantDb<{ data: { permission: string; granted: boolean } }[]>`
        SELECT data FROM platform.audit_log WHERE action = 'permission.set' AND entity_id = 'manager'`;
      expect(row!.data).toEqual({ permission: 'tender.edit', granted: false });
      await post(
        '/tenant/permissions',
        { role: 'manager', permission: 'tender.edit', granted: true },
        t.admin,
      );
      expect((await post('/tenant/tenders', { title: 'Manager again' }, manager)).statusCode).toBe(
        201,
      );
    });

    it('rejects unknown permissions and non-admins', async () => {
      const bad = await post(
        '/tenant/permissions',
        { role: 'worker', permission: 'boq.delete_everything', granted: true },
        t.admin,
      );
      expect(bad.statusCode).toBe(400);
      expect(
        (
          await post(
            '/tenant/permissions',
            { role: 'worker', permission: 'tender.edit', granted: true },
            manager,
          )
        ).statusCode,
      ).toBe(403);
    });
  });
});
