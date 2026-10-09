// Measurement sheets and bid pricing in a real tenant database: item quantities from measurements (with totals and
// invariants), pricing scenarios, quoted rates, and the tender bid summary against the client's estimate.
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
import type { BoqRow } from '../src/boq/boq.service.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { boqInvariants } from './helpers/boq.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('measurement and pricing (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let importDir: string;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let tenderId: string;
  let worker: Record<string, string>;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const newBoq = async (name: string) =>
    (await post(`/tenant/tenders/${tenderId}/boqs`, { name })).json<{ id: string }>().id;

  const allRows = async (boqId: string) => {
    const out: BoqRow[] = [];
    let after: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ limit: '500' });
      if (after) qs.set('after', after);
      const page = (await get(`/tenant/boqs/${boqId}/rows?${qs}`)).json<{
        rows: BoqRow[];
        hasMore: boolean;
      }>();
      out.push(...page.rows);
      if (!page.hasMore || page.rows.length === 0) return out;
      after = page.rows.at(-1)!.sortKey;
    }
  };
  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ temporaryPassword: string }>();
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
    return { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` };
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
    importDir = await mkdtemp(join(tmpdir(), 'aerolith-import-test-'));
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      RATE_LIMIT_SCALE: '200',
      PUBLIC_API_URL: 'https://api.example.in',
      IMPORT_DIR: importDir,
      IMPORT_MAX_MB: '2',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'pricing-admin@example.in');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (await post('/tenant/tenders', { title: 'Community hall, Nagpur' })).json<{
      id: string;
    }>().id;
    worker = await staff('suresh', 'worker');
  }, 90_000);

  afterAll(async () => {
    delete process.env.IMPORT_DIR;
    delete process.env.IMPORT_MAX_MB;
    await app?.close();
    await control?.end();
    await server?.end();
  });

  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  type Row = BoqRow & { measured: boolean };
  const changes = (boqId: string, ops: object[]) =>
    ok<{ rows: Row[]; idMap: Record<string, string> }>(
      post(`/tenant/boqs/${boqId}/changes`, { ops }),
    );

  describe('measurement sheets', () => {
    let boqId: string;
    let itemId: string;
    let rowVersion: number;
    const WALL = {
      description: 'Wall A, ground floor',
      nos: '2',
      length: '10.5',
      breadth: '0.23',
      height: '3',
    };
    const DOOR = {
      description: 'Door D1',
      nos: '1',
      length: '1.0',
      breadth: '0.23',
      height: '2.1',
      deduct: true,
    };

    it('sets an item quantity from its rows, with amount and totals following', async () => {
      boqId = await newBoq('Masonry');
      const r = await changes(boqId, [
        {
          op: 'insert',
          tempId: 'ts',
          parentId: null,
          afterId: null,
          type: 'section',
          description: 'Masonry',
        },
        {
          op: 'insert',
          tempId: 'ti',
          parentId: 'ts',
          afterId: null,
          type: 'item',
          description: 'Brickwork 230 mm',
          unit: 'cum',
          qty: '1',
          rate: '5000',
        },
      ]);
      itemId = r.idMap.ti!;
      rowVersion = r.rows.find((x) => x.id === itemId)!.rowVersion;
      const m = await ok<{
        rows: Row[];
        header: { total: string };
        measurements: { qty: string }[];
      }>(
        post(`/tenant/boqs/${boqId}/lines/${itemId}/measurements`, {
          rowVersion,
          rows: [WALL, DOOR],
        }),
      );
      expect(m.measurements.map((x) => x.qty)).toEqual(['14.4900', '-0.4830']);
      const item = m.rows.find((x) => x.id === itemId)!;
      expect(item).toMatchObject({ qty: '14.0070', amount: '70035.00', measured: true });
      expect(m.rows.find((x) => x.id === r.idMap.ts)!.subtotal).toBe('70035.00');
      expect(m.header.total).toBe('70035.00');
      rowVersion = item.rowVersion;
      expect(await boqInvariants(db, boqId)).toEqual([]);
      const rows = await ok<{ description: string; deduct: boolean; qty: string }[]>(
        get(`/tenant/boqs/${boqId}/lines/${itemId}/measurements`, worker),
      );
      expect(rows.map((x) => [x.description, x.deduct, x.qty])).toEqual([
        ['Wall A, ground floor', false, '14.4900'],
        ['Door D1', true, '-0.4830'],
      ]);
    });

    it('refuses a typed quantity on a measured item, and accepts it again once the sheet is cleared', async () => {
      const typed = await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [{ op: 'update', id: itemId, rowVersion, qty: '20' }],
      });
      expect(typed.statusCode).toBe(409);
      expect(typed.json()).toMatchObject({ code: 'qty_from_measurements' });
      // Rate edits are fine.
      const rated = await changes(boqId, [{ op: 'update', id: itemId, rowVersion, rate: '5200' }]);
      rowVersion = rated.rows.find((x) => x.id === itemId)!.rowVersion;
      const cleared = await ok<{ rows: Row[] }>(
        post(`/tenant/boqs/${boqId}/lines/${itemId}/measurements`, { rowVersion, rows: [] }),
      );
      const item = cleared.rows.find((x) => x.id === itemId)!;
      expect(item).toMatchObject({ qty: '14.0070', measured: false });
      const again = await changes(boqId, [
        { op: 'update', id: itemId, rowVersion: item.rowVersion, qty: '15' },
      ]);
      expect(again.rows.find((x) => x.id === itemId)).toMatchObject({
        qty: '15.0000',
        amount: '78000.00',
      });
      expect(await boqInvariants(db, boqId)).toEqual([]);
    });

    it('validates rows, checks versions and permissions, and drops the sheet with its item', async () => {
      const [row] = (await allRows(boqId)).filter((x) => x.id === itemId);
      const bad = await post(`/tenant/boqs/${boqId}/lines/${itemId}/measurements`, {
        rowVersion: row!.rowVersion,
        rows: [{ description: 'Nothing measured' }],
      });
      expect(bad.statusCode).toBe(400);
      const stale = await post(`/tenant/boqs/${boqId}/lines/${itemId}/measurements`, {
        rowVersion: row!.rowVersion - 1,
        rows: [WALL],
      });
      expect(stale.statusCode).toBe(409);
      expect(
        (
          await post(
            `/tenant/boqs/${boqId}/lines/${itemId}/measurements`,
            { rowVersion: row!.rowVersion, rows: [WALL] },
            worker,
          )
        ).statusCode,
      ).toBe(403);
      const m = await ok<{ rows: Row[] }>(
        post(`/tenant/boqs/${boqId}/lines/${itemId}/measurements`, {
          rowVersion: row!.rowVersion,
          rows: [WALL],
        }),
      );
      const v = m.rows.find((x) => x.id === itemId)!.rowVersion;
      await changes(boqId, [{ op: 'delete', id: itemId, rowVersion: v }]);
      const [left] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM est.measurement WHERE boq_id = ${boqId}`;
      expect(left!.n).toBe(0);
    });
  });

  describe('pricing', () => {
    let pricedTender: string;
    let boqId: string;
    const MARKUPS = [
      { kind: 'overhead', label: 'Site overheads', basis: 'base', pct: '7.5' },
      { kind: 'contingency', label: 'Contingency', basis: 'base', pct: '3' },
      { kind: 'profit', label: 'Profit', basis: 'running', pct: '10' },
      { kind: 'discount', label: 'Strategic discount', basis: 'running', pct: '2' },
      { kind: 'other', label: 'Insurance', basis: 'base', amount: '25000' },
    ];
    interface Summary {
      boq: { base: string };
      counts: { items: number; unpriced: number; noQty: number };
      sections: { description: string; subtotal: string }[];
      scenarios: {
        id: string;
        name: string;
        selected: boolean;
        rowVersion: number;
        result: Record<string, unknown>;
      }[];
      quoted: { factor: string; total: string; difference: string } | null;
    }

    it('prices a BOQ of exactly ₹10,00,000 under a scenario, against the estimate', async () => {
      pricedTender = (
        await ok<{ id: string }>(
          post('/tenant/tenders', { title: 'Primary school, Amravati', estimatedValue: '1150000' }),
        )
      ).id;
      boqId = (
        await ok<{ id: string }>(post(`/tenant/tenders/${pricedTender}/boqs`, { name: 'Civil' }))
      ).id;
      await changes(boqId, [
        {
          op: 'insert',
          tempId: 'ts',
          parentId: null,
          afterId: null,
          type: 'section',
          code: 'A',
          description: 'Structure',
        },
        {
          op: 'insert',
          tempId: 'ta',
          parentId: 'ts',
          afterId: null,
          type: 'item',
          description: 'RCC',
          unit: 'cum',
          qty: '100',
          rate: '9000',
        },
        {
          op: 'insert',
          tempId: 'tb',
          parentId: 'ts',
          afterId: 'ta',
          type: 'item',
          description: 'Steel',
          unit: 'MT',
          qty: '3',
          rate: '33333.3333',
        },
        {
          op: 'insert',
          tempId: 'tc',
          parentId: 'ts',
          afterId: 'tb',
          type: 'item',
          description: 'Provisional, rate later',
          unit: 'LS',
          qty: '1',
        },
        {
          op: 'insert',
          tempId: 'td',
          parentId: 'ts',
          afterId: 'tc',
          type: 'item',
          description: 'Quantity later',
          unit: 'nos',
          rate: '10',
        },
      ]);
      expect((await get(`/tenant/boqs/${boqId}/pricing`, worker)).statusCode).toBe(403);
      const s = await ok<Summary>(
        post(`/tenant/boqs/${boqId}/scenarios`, {
          name: 'Standard',
          markups: MARKUPS,
          gstPct: '18',
          gstMode: 'add',
        }),
      );
      expect(s.boq.base).toBe('1000000.00');
      expect(s.counts).toMatchObject({ items: 4, unpriced: 1, noQty: 1 });
      expect(s.sections).toEqual([
        expect.objectContaining({ description: 'Structure', subtotal: '1000000.00' }),
      ]);
      expect(s.scenarios).toHaveLength(1);
      expect(s.scenarios[0]).toMatchObject({ name: 'Standard', selected: true });
      expect(s.scenarios[0]!.result).toMatchObject({
        beforeGst: '1216190.00',
        gst: '218914.20',
        bid: '1435104.20',
        factor: '1.216190',
        vsEstimatePct: '5.76',
      });
      // Loaded rates: 9,000 × 1.21619 = 10,945.71; 33,333.3333 × 1.21619 = 40,539.67 (rounded up a little).
      expect(s.quoted).toEqual({ factor: '1.216190', total: '1216190.01', difference: '0.01' });
    });

    it('previews an unsaved scenario', async () => {
      const p = await ok<Record<string, string>>(
        post(`/tenant/boqs/${boqId}/pricing/preview`, {
          name: 'x',
          markups: MARKUPS,
          gstMode: 'exempt',
        }),
      );
      expect(p).toMatchObject({ beforeGst: '1216190.00', gst: '0.00', bid: '1216190.00' });
      expect(
        (await post(`/tenant/boqs/${boqId}/pricing/preview`, { name: 'x' }, worker)).statusCode,
      ).toBe(403);
    });

    it('keeps several scenarios, one of them the bid', async () => {
      const s = await ok<Summary>(
        post(`/tenant/boqs/${boqId}/scenarios`, {
          name: 'Aggressive',
          markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '4' }],
          gstMode: 'add',
        }),
      );
      const aggressive = s.scenarios.find((x) => x.name === 'Aggressive')!;
      expect(aggressive).toMatchObject({
        selected: false,
        result: { beforeGst: '1040000.00', vsEstimatePct: '-9.57' },
      });
      const sel = await ok<Summary>(post(`/tenant/scenarios/${aggressive.id}/select`));
      expect(sel.scenarios.map((x) => [x.name, x.selected])).toEqual([
        ['Standard', false],
        ['Aggressive', true],
      ]);
      expect(
        (await post(`/tenant/boqs/${boqId}/scenarios`, { name: 'aggressive' })).statusCode,
      ).toBe(409);
      const copied = await ok<Summary>(
        post(`/tenant/scenarios/${aggressive.id}/copy`, { name: 'Aggressive 2' }),
      );
      const copy = copied.scenarios.find((x) => x.name === 'Aggressive 2')!;
      expect(copy.selected).toBe(false);
      const upd = await ok<Summary>(
        post(`/tenant/scenarios/${copy.id}`, {
          rowVersion: copy.rowVersion,
          name: 'Aggressive 2',
          markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '5' }],
          gstMode: 'included',
        }),
      );
      expect(upd.scenarios.find((x) => x.id === copy.id)!.result).toMatchObject({
        bid: '1050000.00',
        gst: '0.00',
      });
      const del = await ok<Summary>(post(`/tenant/scenarios/${copy.id}/delete`));
      expect(del.scenarios).toHaveLength(2);
      const standard = del.scenarios.find((x) => x.name === 'Standard')!;
      await ok(post(`/tenant/scenarios/${standard.id}/select`));
    });

    it('exports item rates loaded with the scenario, for pricing roles only', async () => {
      const s = await ok<Summary>(get(`/tenant/boqs/${boqId}/pricing`));
      const standard = s.scenarios.find((x) => x.name === 'Standard')!;
      const res = await get(`/tenant/boqs/${boqId}/export?format=csv&scenario=${standard.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('quoted (Standard)');
      const lines = res.body.split('\r\n');
      expect(lines[0]).toBe(
        '\uFEFFLevel,Type,Code,Description,Unit,Qty,Rate,Amount,Notes,Quoted rate,Quoted amount',
      );
      expect(lines[2]).toBe('1,item,,RCC,cum,100,9000,900000,,10945.71,1094571');
      expect(lines[3]).toBe('1,item,,Steel,MT,3,33333.3333,100000,,40539.67,121619.01');
      expect(
        (await get(`/tenant/boqs/${boqId}/export?format=csv&scenario=${standard.id}`, worker))
          .statusCode,
      ).toBe(403);
      expect((await get(`/tenant/boqs/${boqId}/export?format=csv`, worker)).statusCode).toBe(200);
    });

    it('sums the tender bid over its BOQs and flags BOQs without a scenario', async () => {
      await ok(post(`/tenant/tenders/${pricedTender}/boqs`, { name: 'MEP' }));
      const t = await ok<
        Record<string, unknown> & { boqs: { name: string; scenario: unknown; unpriced: number }[] }
      >(get(`/tenant/tenders/${pricedTender}/bid-summary`));
      expect(t).toMatchObject({
        estimatedValue: '1150000.00',
        base: '1000000.00',
        beforeGst: '1216190.00',
        gst: '218914.20',
        bid: '1435104.20',
        vsEstimatePct: '5.76',
        complete: false,
      });
      expect(t.boqs.map((b) => [b.name, b.scenario === null, b.unpriced])).toEqual([
        ['Civil', false, 1],
        ['MEP', true, 0],
      ]);
      // An admin can let workers see pricing.
      await ok(
        post('/tenant/permissions', { role: 'worker', permission: 'pricing.edit', granted: true }),
      );
      expect((await get(`/tenant/tenders/${pricedTender}/bid-summary`, worker)).statusCode).toBe(
        200,
      );
      await ok(
        post('/tenant/permissions', { role: 'worker', permission: 'pricing.edit', granted: false }),
      );
    });
  });
});
