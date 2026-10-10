// BOQ engine in a real tenant database: structure edits, totals by delta, windows with collapsed sections, search,
// conflicts, roles, and a randomised run that checks every invariant after hundreds of mixed edits.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { segmentFor } from '@aerolith/shared';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { BoqService, type BoqRow } from '../src/boq/boq.service.js';
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

interface Changes {
  header: { total: string; nodeCount: number; itemCount: number };
  rows: BoqRow[];
  deletedIds: string[];
  idMap: Record<string, string>;
  reload: boolean;
}

describe.skipIf(!controlUrl || !adminUrl)('BOQ engine (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let tenderId: string;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });

  const newBoq = async (name: string) =>
    (await post(`/tenant/tenders/${tenderId}/boqs`, { name })).json<{ id: string }>().id;
  const change = async (boqId: string, ops: object[]) => {
    const res = await post(`/tenant/boqs/${boqId}/changes`, { ops });
    if (res.statusCode !== 200) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<Changes>();
  };
  /** Every row, read through the public window API 200 at a time. */
  const allRows = async (boqId: string, collapsed: string[] = []) => {
    const out: BoqRow[] = [];
    let after: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ limit: '200' });
      if (after) qs.set('after', after);
      if (collapsed.length) qs.set('collapsed', collapsed.join(','));
      const page = (await get(`/tenant/boqs/${boqId}/rows?${qs}`)).json<{
        rows: BoqRow[];
        hasMore: boolean;
      }>();
      out.push(...page.rows);
      if (!page.hasMore || page.rows.length === 0) return out;
      after = page.rows.at(-1)!.sortKey;
    }
  };

  const invariants = (boqId: string) => boqInvariants(db, boqId);

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
      RATE_LIMIT_SCALE: '200',
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'boq-admin@example.in');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (await post('/tenant/tenders', { title: 'Hospital block, Nashik' })).json<{
      id: string;
    }>().id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  describe('structure and totals', () => {
    let boqId: string;
    let ids: Record<string, string>;

    it('builds a tree in one batch, with temp ids, and keeps section subtotals', async () => {
      boqId = await newBoq('Civil works');
      const r = await change(boqId, [
        {
          op: 'insert',
          tempId: 'tA',
          parentId: null,
          afterId: null,
          type: 'section',
          code: 'A',
          description: 'Earthwork',
        },
        {
          op: 'insert',
          tempId: 'ta1',
          parentId: 'tA',
          afterId: null,
          type: 'item',
          code: 'A.1',
          description: 'Excavation',
          unit: 'cum',
          qty: '120.5',
          rate: '350',
        },
        {
          op: 'insert',
          tempId: 'ta2',
          parentId: 'tA',
          afterId: 'ta1',
          type: 'item',
          code: 'A.2',
          description: 'Backfilling',
          unit: 'cum',
          qty: '80',
          rate: '210.25',
        },
        {
          op: 'insert',
          tempId: 'tA1',
          parentId: 'tA',
          afterId: 'ta2',
          type: 'section',
          code: 'A.3',
          description: 'Anti-termite',
        },
        {
          op: 'insert',
          tempId: 'tx',
          parentId: 'tA1',
          afterId: null,
          type: 'item',
          code: 'A.3.1',
          description: 'Treatment',
          unit: 'sqm',
          qty: '500',
          rate: '42.5',
        },
        {
          op: 'insert',
          tempId: 'tB',
          parentId: null,
          afterId: 'tA',
          type: 'section',
          code: 'B',
          description: 'Concrete',
        },
        {
          op: 'insert',
          tempId: 'tn',
          parentId: 'tB',
          afterId: null,
          type: 'note',
          description: 'All concrete M25 unless noted',
        },
      ]);
      ids = Object.fromEntries(Object.entries(r.idMap).map(([k, v]) => [k.slice(1), v]));
      // 120.5×350 = 42175; 80×210.25 = 16820; 500×42.5 = 21250
      expect(r.header).toMatchObject({ total: '80245.00', nodeCount: 7, itemCount: 3 });
      const rows = await allRows(boqId);
      expect(rows.map((x) => [x.code ?? 'note', x.depth, x.subtotal])).toEqual([
        ['A', 0, '80245.00'],
        ['A.1', 1, '0.00'],
        ['A.2', 1, '0.00'],
        ['A.3', 1, '21250.00'],
        ['A.3.1', 2, '0.00'],
        ['B', 0, '0.00'],
        ['note', 1, '0.00'],
      ]);
      expect(rows.find((x) => x.code === 'A.1')!.amount).toBe('42175.00');
      expect(rows.find((x) => x.code === 'A')!.childCount).toBe(3);
      expect(await invariants(boqId)).toEqual([]);
    });

    it('updates a quantity and returns the line, its ancestors and the new total', async () => {
      const row = (await allRows(boqId)).find((x) => x.code === 'A.3.1')!;
      const r = await change(boqId, [
        { op: 'update', id: row.id, rowVersion: row.rowVersion, qty: '600' },
      ]);
      expect(r.header.total).toBe('84495.00');
      expect(r.rows.map((x) => [x.code, x.amount ?? x.subtotal])).toEqual([
        ['A', '84495.00'],
        ['A.3', '25500.00'],
        ['A.3.1', '25500.00'],
      ]);
      expect(r.reload).toBe(false);
      // Clearing the rate clears the amount and takes it out of every total.
      const fresh = r.rows.find((x) => x.code === 'A.3.1')!;
      const cleared = await change(boqId, [
        {
          op: 'update',
          id: fresh.id,
          rowVersion: fresh.rowVersion,
          rate: null,
          description: 'Treatment (rate TBC)',
        },
      ]);
      expect(cleared.header.total).toBe('58995.00');
      expect(cleared.rows.find((x) => x.code === 'A.3.1')).toMatchObject({
        amount: null,
        description: 'Treatment (rate TBC)',
      });
      expect(await invariants(boqId)).toEqual([]);
    });

    it('inserts between two lines without renumbering anything', async () => {
      const before = await allRows(boqId);
      const r = await change(boqId, [
        {
          op: 'insert',
          tempId: 'tmid',
          parentId: ids.A,
          afterId: ids.a1,
          type: 'item',
          code: 'A.1a',
          qty: '1',
          rate: '5',
        },
      ]);
      const after = await allRows(boqId);
      expect(after.map((x) => x.code)).toEqual([
        'A',
        'A.1',
        'A.1a',
        'A.2',
        'A.3',
        'A.3.1',
        'B',
        null,
      ]);
      // Every pre-existing key is unchanged.
      for (const b of before) expect(after.find((x) => x.id === b.id)!.sortKey).toBe(b.sortKey);
      expect(r.idMap.tmid).toBeDefined();
    });

    it('moves a section with its children, carrying the subtotal across', async () => {
      const rows = await allRows(boqId);
      const a3 = rows.find((x) => x.code === 'A.3')!;
      const r = await change(boqId, [
        { op: 'move', id: a3.id, rowVersion: a3.rowVersion, parentId: ids.B, afterId: ids.n },
      ]);
      expect(r.reload).toBe(true);
      const after = await allRows(boqId);
      expect(after.map((x) => [x.code, x.depth])).toEqual([
        ['A', 0],
        ['A.1', 1],
        ['A.1a', 1],
        ['A.2', 1],
        ['B', 0],
        [null, 1],
        ['A.3', 1],
        ['A.3.1', 2],
      ]);
      // 58995.00 + the 1 × 5 item inserted above
      expect(after.find((x) => x.code === 'A')!.subtotal).toBe('59000.00');
      expect(await invariants(boqId)).toEqual([]);
    });

    it('rejects impossible structure changes with the failing op index', async () => {
      const rows = await allRows(boqId);
      const b = rows.find((x) => x.code === 'B')!;
      const a3 = rows.find((x) => x.code === 'A.3')!;
      const a1 = rows.find((x) => x.code === 'A.1')!;
      const cases: [object, string][] = [
        [
          { op: 'move', id: b.id, rowVersion: b.rowVersion, parentId: a3.id, afterId: null },
          'move_into_self',
        ],
        [
          { op: 'insert', tempId: 'tz', parentId: a1.id, afterId: null, type: 'item' },
          'parent_not_section',
        ],
        [
          { op: 'insert', tempId: 'tz', parentId: ids.A, afterId: ids.n, type: 'item' },
          'after_not_sibling',
        ],
        [
          { op: 'insert', tempId: 'tz', parentId: null, afterId: null, type: 'section', qty: '1' },
          'qty_rate_on_non_item',
        ],
      ];
      for (const [op, code] of cases) {
        const res = await post(`/tenant/boqs/${boqId}/changes`, {
          ops: [{ op: 'insert', tempId: 'tok', parentId: null, afterId: null, type: 'note' }, op],
        });
        expect(res.json(), code).toMatchObject({ code, opIndex: 1 });
      }
      // The valid first op of each failed batch was rolled back too.
      expect((await allRows(boqId)).length).toBe(8);
    });

    it('reports a stale edit and applies nothing from the batch', async () => {
      const a2 = (await allRows(boqId)).find((x) => x.code === 'A.2')!;
      await change(boqId, [{ op: 'update', id: a2.id, rowVersion: a2.rowVersion, qty: '81' }]);
      const res = await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [
          { op: 'insert', tempId: 'tq', parentId: null, afterId: null, type: 'note' },
          { op: 'update', id: a2.id, rowVersion: a2.rowVersion, qty: '99' },
        ],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'stale_row', id: a2.id, opIndex: 1 });
      expect((await allRows(boqId)).length).toBe(8);
    });

    it('deletes a section with everything under it', async () => {
      const b = (await allRows(boqId)).find((x) => x.code === 'B')!;
      const r = await change(boqId, [{ op: 'delete', id: b.id, rowVersion: b.rowVersion }]);
      expect(r.deletedIds).toHaveLength(4);
      expect(r.header).toMatchObject({ nodeCount: 4, itemCount: 3 });
      expect(await invariants(boqId)).toEqual([]);
    });

    it('lets workers read but not edit, and refuses edits to a locked BOQ', async () => {
      const created = (
        await post('/tenant/users', { username: 'kiran', displayName: 'Kiran', role: 'worker' })
      ).json<{ temporaryPassword: string }>();
      const login = async (password: string) =>
        (
          await post(
            '/auth/login',
            { entitlementToken: t.entitlement, identifier: 'kiran', password, client: 'desktop' },
            {},
          )
        ).json<{ accessToken: string }>().accessToken;
      const first = await login(created.temporaryPassword);
      await post(
        '/auth/change-password',
        { currentPassword: created.temporaryPassword, newPassword: 'Scaffold-Tube-Clamp-9' },
        { authorization: `Bearer ${first}` },
      );
      const worker = { authorization: `Bearer ${await login('Scaffold-Tube-Clamp-9')}` };
      expect((await get(`/tenant/boqs/${boqId}/rows`, worker)).statusCode).toBe(200);
      const denied = await post(
        `/tenant/boqs/${boqId}/changes`,
        { ops: [{ op: 'insert', tempId: 'tw', parentId: null, afterId: null, type: 'note' }] },
        worker,
      );
      expect(denied.statusCode).toBe(403);
      await db`UPDATE est.boq SET status = 'locked' WHERE id = ${boqId}`;
      const locked = await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [{ op: 'insert', tempId: 'tl', parentId: null, afterId: null, type: 'note' }],
      });
      expect(locked.json()).toMatchObject({ code: 'boq_locked' });
      await db`UPDATE est.boq SET status = 'draft' WHERE id = ${boqId}`;
    });

    it('cannot delete a BOQ through the app role', async () => {
      await expect(db`DELETE FROM est.boq WHERE id = ${boqId}`).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('relative shifts and opening at a line', () => {
    let boqId: string;
    const codes = async () => (await allRows(boqId)).map((r) => `${'  '.repeat(r.depth)}${r.code}`);
    const shift = async (code: string, direction: string) => {
      const row = (await allRows(boqId)).find((r) => r.code === code)!;
      return post(`/tenant/boqs/${boqId}/changes`, {
        ops: [{ op: 'shift', id: row.id, rowVersion: row.rowVersion, direction }],
      });
    };

    beforeAll(async () => {
      boqId = await newBoq('Shifts');
      await change(boqId, [
        { op: 'insert', tempId: 'tX', parentId: null, afterId: null, type: 'section', code: 'X' },
        {
          op: 'insert',
          tempId: 'tx1',
          parentId: 'tX',
          afterId: null,
          type: 'item',
          code: 'x1',
          qty: '1',
          rate: '100',
        },
        {
          op: 'insert',
          tempId: 'tx2',
          parentId: 'tX',
          afterId: 'tx1',
          type: 'section',
          code: 'x2',
        },
        {
          op: 'insert',
          tempId: 'tx2a',
          parentId: 'tx2',
          afterId: null,
          type: 'item',
          code: 'x2a',
          qty: '1',
          rate: '10',
        },
        {
          op: 'insert',
          tempId: 'tx3',
          parentId: 'tX',
          afterId: 'tx2',
          type: 'item',
          code: 'x3',
          qty: '1',
          rate: '1',
        },
        { op: 'insert', tempId: 'tY', parentId: null, afterId: 'tX', type: 'section', code: 'Y' },
      ]);
    });

    it('moves a line up and down among its siblings, with its subtree', async () => {
      expect((await shift('x2', 'up')).statusCode).toBe(200);
      expect(await codes()).toEqual(['X', '  x2', '    x2a', '  x1', '  x3', 'Y']);
      expect((await shift('x2', 'down')).statusCode).toBe(200);
      expect(await codes()).toEqual(['X', '  x1', '  x2', '    x2a', '  x3', 'Y']);
      expect(await invariants(boqId)).toEqual([]);
    });

    it('indents into the previous section as its last child, and outdents back after it', async () => {
      expect((await shift('x3', 'in')).statusCode).toBe(200);
      expect(await codes()).toEqual(['X', '  x1', '  x2', '    x2a', '    x3', 'Y']);
      const x2 = (await allRows(boqId)).find((r) => r.code === 'x2')!;
      expect(x2.subtotal).toBe('11.00');
      expect((await shift('x3', 'out')).statusCode).toBe(200);
      expect(await codes()).toEqual(['X', '  x1', '  x2', '    x2a', '  x3', 'Y']);
      expect(await invariants(boqId)).toEqual([]);
    });

    it('refuses shifts with nowhere to go', async () => {
      for (const [code, direction] of [
        ['x1', 'up'],
        ['x1', 'in'],
        ['Y', 'down'],
        ['X', 'out'],
        ['x2', 'in'],
        ['x2a', 'down'],
      ] as const) {
        expect((await shift(code, direction)).json(), `${code} ${direction}`).toMatchObject({
          code: 'cannot_shift',
          direction,
        });
      }
    });

    it('opens a window at a line, including that line', async () => {
      const all = await allRows(boqId);
      const x2 = all.find((r) => r.code === 'x2')!;
      const page = (
        await get(`/tenant/boqs/${boqId}/rows?limit=3&from=${encodeURIComponent(x2.sortKey)}`)
      ).json<{ rows: BoqRow[]; hasMore: boolean }>();
      expect(page.rows.map((r) => r.code)).toEqual(['x2', 'x2a', 'x3']);
      expect(page.hasMore).toBe(true);
      // Opening at a collapsed section shows the section, then what follows its hidden lines.
      const folded = (
        await get(
          `/tenant/boqs/${boqId}/rows?limit=3&from=${encodeURIComponent(x2.sortKey)}&collapsed=${x2.id}`,
        )
      ).json<{ rows: BoqRow[] }>();
      expect(folded.rows.map((r) => r.code)).toEqual(['x2', 'x3', 'Y']);
    });
  });

  describe('windows over a larger BOQ', { timeout: 30_000 }, () => {
    let boqId: string;
    const SECTIONS = 20;
    const PER_SECTION = 150; // 20 sections × (1 sub-section + 150 items) = 3,040 rows

    beforeAll(async () => {
      boqId = await newBoq('Seeded');
      // Seed directly, like the bulk import will (step 4): keys from segmentFor, totals computed once.
      const rows: (string | number | null)[][] = [];
      // Ids come from the real sequence (the app role may draw from it, not reset it).
      const total = SECTIONS * (PER_SECTION + 2);
      const fresh = (
        await db<
          { id: string }[]
        >`SELECT nextval('est.boq_node_id_seq')::text AS id FROM generate_series(1, ${total})`
      ).map((r) => Number(r.id));
      let next = 0;
      const nextId = () => fresh[next++]!;
      for (let s = 0; s < SECTIONS; s++) {
        const sKey = segmentFor(s);
        const sId = nextId();
        const subKey = `${sKey}!${segmentFor(0)}`;
        const subId = nextId();
        rows.push([sId, null, sKey, 0, 'section', `S${s}`, null, null, null, `Section ${s}`]);
        rows.push([subId, sId, subKey, 1, 'section', `S${s}.0`, null, null, null, `Sub ${s}`]);
        for (let i = 0; i < PER_SECTION; i++) {
          rows.push([
            nextId(),
            subId,
            `${subKey}!${segmentFor(i)}`,
            2,
            'item',
            `S${s}.0.${i}`,
            '2',
            '10',
            '20.00',
            i % 50 === 0 ? `Vitrified tile ${s}-${i}` : `Line ${s}-${i}`,
          ]);
        }
      }
      const col = (i: number) => rows.map((r) => r[i] ?? null) as string[];
      await db`
        INSERT INTO est.boq_node (boq_id, id, parent_id, sort_key, depth, node_type, code, qty, rate, amount)
        SELECT ${boqId}, * FROM unnest(${col(0)}::bigint[], ${col(1)}::bigint[], ${col(2)}::text[],
          ${col(3)}::smallint[], ${col(4)}::text[], ${col(5)}::text[], ${col(6)}::numeric[], ${col(7)}::numeric[],
          ${col(8)}::numeric[])`;
      await db`INSERT INTO est.boq_node_text (boq_id, node_id, description)
        SELECT ${boqId}, * FROM unnest(${col(0)}::bigint[], ${col(9)}::text[])`;
      await db`UPDATE est.boq_node n SET child_count = c.n FROM (
          SELECT parent_id, count(*)::int AS n FROM est.boq_node WHERE boq_id = ${boqId} GROUP BY parent_id) c
        WHERE n.boq_id = ${boqId} AND n.id = c.parent_id`;
      await db`UPDATE est.boq_node SET subtotal = ${PER_SECTION * 20}
        WHERE boq_id = ${boqId} AND node_type = 'section'`;
      await db`UPDATE est.boq SET node_count = ${rows.length}, item_count = ${SECTIONS * PER_SECTION},
        total = ${SECTIONS * PER_SECTION * 20} WHERE id = ${boqId}`;
      expect(await invariants(boqId)).toEqual([]);
    }, 60_000);

    it('finds the line at any number, and the number of any line, counting collapsed lines too', async () => {
      type Pos = { line: number; sortKey: string; total: number };
      const pos = async (q: string) =>
        (await get(`/tenant/boqs/${boqId}/position?${q}`)).json<Pos>();
      const rows = await allRows(boqId);
      const total = SECTIONS * (PER_SECTION + 2);
      expect(await pos('line=1')).toEqual({ line: 1, sortKey: rows[0]!.sortKey, total });
      expect(await pos('line=2000')).toEqual({ line: 2000, sortKey: rows[1999]!.sortKey, total });
      // Past the end: the last line.
      expect(await pos('line=99999')).toEqual({
        line: total,
        sortKey: rows.at(-1)!.sortKey,
        total,
      });
      // Back again: the number of a line from its key.
      const k = rows[1234]!.sortKey;
      expect(await pos(`key=${encodeURIComponent(k)}`)).toEqual({ line: 1235, sortKey: k, total });
      // Collapsing a section in the grid does not renumber the lines below it.
      const section = rows.find((r) => r.type === 'section')!;
      const window = (
        await get(
          `/tenant/boqs/${boqId}/rows?from=${encodeURIComponent(k)}&collapsed=${section.id}&limit=1`,
        )
      ).json<{ rows: { sortKey: string }[] }>();
      expect((await pos(`key=${encodeURIComponent(window.rows[0]!.sortKey)}`)).line).toBe(1235);
      // One of line or key; an empty BOQ has no lines.
      expect((await get(`/tenant/boqs/${boqId}/position?line=1&key=${k}`)).statusCode).toBe(400);
      expect((await get(`/tenant/boqs/${boqId}/position`)).statusCode).toBe(400);
      const empty = await newBoq('Empty');
      expect((await get(`/tenant/boqs/${empty}/position?line=1`)).json()).toMatchObject({
        code: 'boq_empty',
      });
    });

    it('pages forward through every row exactly once, in tree order', async () => {
      const rows = await allRows(boqId);
      expect(rows).toHaveLength(SECTIONS * (PER_SECTION + 2));
      const keys = rows.map((r) => r.sortKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys].sort()).toEqual(keys);
    });

    it('pages backward to the same rows', async () => {
      const forward = await allRows(boqId);
      const back: BoqRow[] = [];
      let before: string | null = null;
      for (;;) {
        const cursor: string =
          before === null ? 'end=true' : `before=${encodeURIComponent(before)}`;
        const res = await get(`/tenant/boqs/${boqId}/rows?limit=500&${cursor}`);
        const page: { rows: BoqRow[]; hasMore: boolean } = res.json();
        back.unshift(...page.rows);
        if (!page.hasMore || page.rows.length === 0) break;
        before = page.rows[0]!.sortKey;
      }
      expect(back.map((r) => r.id)).toEqual(forward.map((r) => r.id));
    });

    it('skips collapsed sections in both directions, without reading what they hide', async () => {
      const all = await allRows(boqId);
      const s3 = all.find((r) => r.code === 'S3')!;
      const s7sub = all.find((r) => r.code === 'S7.0')!;
      const visible = all.filter(
        (r) =>
          !r.sortKey.startsWith(s3.sortKey + '!') && !r.sortKey.startsWith(s7sub.sortKey + '!'),
      );
      const forward = await allRows(boqId, [s3.id, s7sub.id]);
      expect(forward.map((r) => r.id)).toEqual(visible.map((r) => r.id));
      // Backward from the end of the BOQ with the same sections collapsed.
      const back: BoqRow[] = [];
      let before: string | null = null;
      for (;;) {
        const qs = new URLSearchParams({ limit: '200', collapsed: `${s3.id},${s7sub.id}` });
        if (before === null) qs.set('end', 'true');
        else qs.set('before', before);
        const page = (await get(`/tenant/boqs/${boqId}/rows?${qs}`)).json<{
          rows: BoqRow[];
          hasMore: boolean;
        }>();
        back.unshift(...page.rows);
        if (!page.hasMore || page.rows.length === 0) break;
        before = page.rows[0]!.sortKey;
      }
      expect(back.map((r) => r.id)).toEqual(visible.map((r) => r.id));
    });

    it('searches descriptions and codes in tree order, and lists the outline', async () => {
      const found = (await get(`/tenant/boqs/${boqId}/search?q=vitrified`)).json<{
        rows: BoqRow[];
      }>();
      expect(found.rows).toHaveLength(SECTIONS * 3);
      expect(found.rows[0]!.description).toBe('Vitrified tile 0-0');
      const byCode = (await get(`/tenant/boqs/${boqId}/search?q=S19.0.149`)).json<{
        rows: BoqRow[];
      }>();
      expect(byCode.rows.map((r) => r.code)).toEqual(['S19.0.149']);
      const outline = (await get(`/tenant/boqs/${boqId}/outline?maxDepth=0`)).json<BoqRow[]>();
      expect(outline.map((r) => r.code)).toEqual(
        Array.from({ length: SECTIONS }, (_, i) => `S${i}`),
      );
    });

    it('falls back to the filter-first plan with identical results when the fast plan runs out of time', async () => {
      const service = app.get(BoqService);
      const ask = async (q: string, after?: string) =>
        (
          await get(`/tenant/boqs/${boqId}/search?limit=7&q=${q}${after ? `&after=${after}` : ''}`)
        ).json<{ rows: BoqRow[]; hasMore: boolean }>();
      const fast = [await ask('vitrified'), await ask('tile 1'), await ask('nothing-here')];
      service.searchBudgetMs = 1; // the tree-order walk stops after its first chunk
      service.searchChunk = 50;
      const before = service.searchFallbacks;
      try {
        const slow = [await ask('vitrified'), await ask('tile 1'), await ask('nothing-here')];
        expect(service.searchFallbacks - before).toBeGreaterThan(0);
        expect(slow).toEqual(fast);
        const page2 = await ask('vitrified', fast[0]!.rows.at(-1)!.sortKey);
        expect(page2.rows[0]!.sortKey > fast[0]!.rows.at(-1)!.sortKey).toBe(true);
      } finally {
        service.searchBudgetMs = 150;
        service.searchChunk = 4000;
      }
    });

    it('edits deep in the BOQ in well under a second', async () => {
      const row = (await get(`/tenant/boqs/${boqId}/search?q=S12.0.77`)).json<{ rows: BoqRow[] }>()
        .rows[0]!;
      const start = performance.now();
      const r = await change(boqId, [
        { op: 'update', id: row.id, rowVersion: row.rowVersion, qty: '3' },
      ]);
      const ms = performance.now() - start;
      expect(r.header.total).toBe(String(SECTIONS * PER_SECTION * 20 + 10) + '.00');
      expect(ms).toBeLessThan(1000);
      expect(await invariants(boqId)).toEqual([]);
    });
  });

  it('keeps every invariant through hundreds of random edits', async () => {
    const boqId = await newBoq('Random');
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const money = () => (Math.floor(rand() * 100_000) / 100).toFixed(2);
    let temp = 0;
    const seen: Record<string, number> = {};

    for (let round = 0; round < 60; round++) {
      const rows = await allRows(boqId);
      const sections = rows.filter((r) => r.type === 'section');
      const ops: object[] = [];
      const batch = 1 + Math.floor(rand() * 5);
      const used = new Set<string>();
      for (let k = 0; k < batch; k++) {
        const kind = rows.length < 10 ? 0 : rand();
        const target = rows.length ? pick(rows) : null;
        if (kind < 0.45 || !target || used.has(target.id)) {
          const parent = sections.length && rand() < 0.8 ? pick(sections) : null;
          const siblings = rows.filter(
            (r) => r.parentId === (parent?.id ?? null) && !used.has(r.id),
          );
          const after = siblings.length && rand() < 0.7 ? pick(siblings) : null;
          const type = rand() < 0.3 ? 'section' : rand() < 0.9 ? 'item' : 'note';
          ops.push({
            op: 'insert',
            tempId: `t${++temp}`,
            parentId: parent?.id ?? null,
            afterId: after?.id ?? null,
            type,
            ...(type === 'item' ? { qty: money(), rate: money() } : {}),
          });
        } else if (kind < 0.7) {
          used.add(target.id);
          ops.push(
            target.type === 'item'
              ? {
                  op: 'update',
                  id: target.id,
                  rowVersion: target.rowVersion,
                  qty: rand() < 0.1 ? null : money(),
                }
              : {
                  op: 'update',
                  id: target.id,
                  rowVersion: target.rowVersion,
                  description: `d${round}`,
                },
          );
        } else if (kind < 0.85) {
          used.add(target.id);
          ops.push({ op: 'delete', id: target.id, rowVersion: target.rowVersion });
          break; // later ops might reference rows this deleted
        } else {
          const parent =
            rand() < 0.8
              ? (pick(
                  sections
                    .filter(
                      (s) => s.id !== target.id && !s.sortKey.startsWith(target.sortKey + '!'),
                    )
                    .concat([]) as BoqRow[],
                ) ?? null)
              : null;
          const siblings = rows.filter(
            (r) => r.parentId === (parent?.id ?? null) && r.id !== target.id,
          );
          used.add(target.id);
          ops.push({
            op: 'move',
            id: target.id,
            rowVersion: target.rowVersion,
            parentId: parent?.id ?? null,
            afterId: siblings.length && rand() < 0.7 ? pick(siblings).id : null,
          });
          break; // a move changes keys and versions under it
        }
      }
      for (const o of ops as { op: string }[]) seen[o.op] = (seen[o.op] ?? 0) + 1;
      await change(boqId, ops);
      const problems = await invariants(boqId);
      expect(problems, `after round ${round}: ${JSON.stringify(ops)}`).toEqual([]);

      // A relative shift on its own; "nothing to shift into" is a valid refusal.
      const now = await allRows(boqId);
      if (now.length) {
        const target = pick(now);
        const direction = pick(['up', 'down', 'in', 'out']);
        const res = await post(`/tenant/boqs/${boqId}/changes`, {
          ops: [{ op: 'shift', id: target.id, rowVersion: target.rowVersion, direction }],
        });
        if (res.statusCode === 200) seen.shift = (seen.shift ?? 0) + 1;
        else expect(res.json(), `shift ${direction}`).toMatchObject({ code: 'cannot_shift' });
        expect(await invariants(boqId), `after shift ${direction} in round ${round}`).toEqual([]);
      }
    }
    // Every kind of edit was exercised, many times.
    for (const kind of ['insert', 'update', 'delete', 'move', 'shift'])
      expect(seen[kind] ?? 0).toBeGreaterThan(5);
  }, 120_000);
});
