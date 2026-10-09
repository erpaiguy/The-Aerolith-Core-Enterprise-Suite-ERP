// BOQ revisions in a real tenant database: freezing copies nothing, edits in a revision keep only what they change,
// any frozen version exports exactly as it was frozen (also after randomised edits over several revisions), compare
// finds added/removed/changed lines with the value delta, and submitting a tender freezes its BOQs.
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
import { DEFAULT_CRITERIA } from '../src/tender/tender-rules.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('BOQ revisions (integration)', () => {
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
    t = await readyTenant(app, control, ENC, 'revisions-admin@example.in');
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
  const changes = (boqId: string, ops: object[]) =>
    ok<{ rows: BoqRow[]; idMap: Record<string, string> }>(
      post(`/tenant/boqs/${boqId}/changes`, { ops }),
    );
  const csv = async (boqId: string, version?: number) => {
    const res = await get(
      `/tenant/boqs/${boqId}/export?format=csv${version ? `&version=${version}` : ''}`,
    );
    if (res.statusCode !== 200) throw new Error(`${res.statusCode} ${res.body}`);
    return res.body;
  };
  const histRows = async (boqId: string) =>
    (
      await db<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM est.boq_node_hist WHERE boq_id = ${boqId}`
    )[0]!.n;
  interface Compare {
    from: { version: number; total: string };
    to: { version: number; total: string };
    summary: { added: number; removed: number; changed: number; itemsDelta: string };
    rows: {
      change: string;
      type: string;
      moved: boolean;
      codeA: string | null;
      codeB: string | null;
      qtyA: string | null;
      qtyB: string | null;
      rateA: string | null;
      rateB: string | null;
      amountA: string | null;
      amountB: string | null;
      descriptionA: string | null;
      descriptionB: string | null;
      notesA: string | null;
      notesB: string | null;
    }[];
  }
  const compare = (boqId: string, from: number, to: number, extra = '') =>
    ok<Compare>(get(`/tenant/boqs/${boqId}/compare?from=${from}&to=${to}${extra}`));
  const byCode = (rows: BoqRow[], code: string) => rows.find((r) => r.code === code)!;

  describe('freeze, revise and compare', () => {
    let boqId: string;
    let v1: string;
    let v2: string;

    it('freezes a version without copying, with its bid, and refuses changes until a revision', async () => {
      boqId = await newBoq('Civil');
      await changes(boqId, [
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
          qty: '10',
          rate: '100',
        },
        {
          op: 'insert',
          tempId: 'ta2',
          parentId: 'tA',
          afterId: 'ta1',
          type: 'item',
          code: 'A.2',
          description: 'Old text',
          unit: 'cum',
          qty: '5',
          rate: '200',
        },
        {
          op: 'insert',
          tempId: 'tn',
          parentId: 'tA',
          afterId: 'ta2',
          type: 'note',
          description: 'Lead 50 m',
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
          tempId: 'tb1',
          parentId: 'tB',
          afterId: null,
          type: 'item',
          code: 'B.1',
          description: 'PCC',
          unit: 'cum',
          qty: '2',
          rate: '1000',
        },
      ]);
      await ok(
        post(`/tenant/boqs/${boqId}/scenarios`, {
          name: 'Bid',
          markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '10' }],
        }),
      );
      v1 = await csv(boqId);
      const frozen = await ok<{
        current: { versionNo: number; status: string };
        versions: Record<string, unknown>[];
      }>(
        post(`/tenant/boqs/${boqId}/freeze`, {
          kind: 'submitted',
          label: 'R0',
          note: 'First submission',
        }),
      );
      expect(frozen.current).toMatchObject({ versionNo: 1, status: 'submitted' });
      expect(frozen.versions).toEqual([
        expect.objectContaining({
          versionNo: 1,
          kind: 'submitted',
          label: 'R0',
          total: '4000.00',
          itemCount: 3,
          frozenBy: expect.any(String),
          scenario: expect.objectContaining({
            name: 'Bid',
            result: expect.objectContaining({ beforeGst: '4400.00' }),
          }),
        }),
      ]);
      expect(await histRows(boqId)).toBe(0); // nothing copied

      const rows = await allRows(boqId);
      const edit = await post(`/tenant/boqs/${boqId}/changes`, {
        ops: [
          {
            op: 'update',
            id: byCode(rows, 'A.1').id,
            rowVersion: byCode(rows, 'A.1').rowVersion,
            qty: '1',
          },
        ],
      });
      expect(edit.json()).toMatchObject({ code: 'boq_locked' });
      expect(
        (await post(`/tenant/boqs/${boqId}/scenarios`, { name: 'Later' })).json(),
      ).toMatchObject({ code: 'boq_locked' });
      expect(
        (await post(`/tenant/boqs/${boqId}/freeze`, { kind: 'internal' })).json(),
      ).toMatchObject({ code: 'already_frozen' });
      const h = await ok<{ rowVersion: number }>(get(`/tenant/boqs/${boqId}`));
      expect(
        (
          await post(`/tenant/boqs/${boqId}`, { rowVersion: h.rowVersion, rateDate: '2027-01-01' })
        ).json(),
      ).toMatchObject({ code: 'boq_locked' });
      expect(
        (await post(`/tenant/boqs/${boqId}/freeze`, { kind: 'internal' }, worker)).statusCode,
      ).toBe(403);

      const revised = await ok<{ current: { versionNo: number; status: string } }>(
        post(`/tenant/boqs/${boqId}/revise`, { note: 'Client asked for changes' }),
      );
      expect(revised.current).toMatchObject({ versionNo: 2, status: 'draft' });
      expect((await post(`/tenant/boqs/${boqId}/revise`)).json()).toMatchObject({
        code: 'not_frozen',
      });
    });

    it('keeps only what changes in a revision, and compares versions line by line', async () => {
      const rows = await allRows(boqId);
      const B = byCode(rows, 'B');
      await changes(boqId, [
        {
          op: 'update',
          id: byCode(rows, 'A.1').id,
          rowVersion: byCode(rows, 'A.1').rowVersion,
          qty: '12',
        },
        {
          op: 'update',
          id: byCode(rows, 'A.2').id,
          rowVersion: byCode(rows, 'A.2').rowVersion,
          description: 'Changed text',
        },
        { op: 'delete', id: byCode(rows, 'B.1').id, rowVersion: byCode(rows, 'B.1').rowVersion },
        {
          op: 'insert',
          tempId: 'tc',
          parentId: B.id,
          afterId: null,
          type: 'item',
          code: 'B.2',
          description: 'Shuttering',
          unit: 'sqm',
          qty: '3',
          rate: '50',
        },
      ]);
      const now = await allRows(boqId);
      await changes(boqId, [
        {
          op: 'move',
          id: byCode(now, 'A.2').id,
          rowVersion: byCode(now, 'A.2').rowVersion,
          parentId: B.id,
          afterId: byCode(now, 'B.2').id,
        },
      ]);
      // Only lines that changed are kept: A.1, A.2, B.1, and the sections whose subtotals moved.
      expect(await histRows(boqId)).toBeLessThanOrEqual(5);
      expect(await boqInvariants(db, boqId)).toEqual([]);

      const c = await compare(boqId, 1, 2);
      expect(c.from).toEqual({ version: 1, total: '4000.00' });
      expect(c.to).toEqual({ version: 2, total: '2350.00' });
      expect(c.summary).toEqual({ added: 1, removed: 1, changed: 2, itemsDelta: '-1650.00' });
      // B.2 took the place B.1 had (deleted, then inserted first in the same batch), so those two tie in position.
      const listed = c.rows.map((r) => [r.change, r.codeA ?? r.codeB, r.moved]);
      expect(listed[0]).toEqual(['changed', 'A.1', false]);
      expect(listed.slice(1, 3)).toEqual(
        expect.arrayContaining([
          ['removed', 'B.1', false],
          ['added', 'B.2', false],
        ]),
      );
      // A.2 now sits after B.2 (it was moved there): the list follows the newer version's order.
      expect(listed[3]).toEqual(['changed', 'A.2', true]);
      expect(c.rows[0]).toMatchObject({ qtyA: '10.0000', qtyB: '12.0000' });
      expect(c.rows[3]).toMatchObject({ descriptionA: 'Old text', descriptionB: 'Changed text' });
      expect(c.rows.find((r) => r.change === 'removed')).toMatchObject({
        descriptionA: 'PCC',
        descriptionB: null,
      });
      // The other way round, additions are removals.
      expect((await compare(boqId, 2, 1)).summary).toEqual({
        added: 1,
        removed: 1,
        changed: 2,
        itemsDelta: '1650.00',
      });
      expect((await compare(boqId, 1, 2, '&filter=removed')).rows.map((r) => r.codeA)).toEqual([
        'B.1',
      ]);
    });

    it('exports every frozen version exactly as it was frozen', async () => {
      v2 = await csv(boqId);
      await ok(post(`/tenant/boqs/${boqId}/freeze`, { kind: 'internal', label: 'Checked by QS' }));
      await ok(post(`/tenant/boqs/${boqId}/revise`));
      const rows = await allRows(boqId);
      const a1 = byCode(rows, 'A.1');
      // A quantity change first (kept without text), then a text change: the text must still be kept for version 2.
      const r1 = await changes(boqId, [
        { op: 'update', id: a1.id, rowVersion: a1.rowVersion, rate: '150' },
      ]);
      const v = r1.rows.find((x) => x.id === a1.id)!.rowVersion;
      await changes(boqId, [
        { op: 'update', id: a1.id, rowVersion: v, description: 'Excavation in hard soil' },
      ]);
      // B.2's text edited and edited back is no change; A.2's notes alone are one.
      const before = await allRows(boqId);
      const b2 = byCode(before, 'B.2');
      const a2 = byCode(before, 'A.2');
      const e1 = await changes(boqId, [
        { op: 'update', id: b2.id, rowVersion: b2.rowVersion, description: 'Shuttering, plywood' },
        { op: 'update', id: a2.id, rowVersion: a2.rowVersion, notes: 'Measured on site' },
      ]);
      await changes(boqId, [
        {
          op: 'update',
          id: b2.id,
          rowVersion: e1.rows.find((x) => x.id === b2.id)!.rowVersion,
          description: 'Shuttering',
        },
      ]);
      const sec = byCode(rows, 'A');
      await changes(boqId, [{ op: 'delete', id: sec.id, rowVersion: sec.rowVersion }]);
      expect(await boqInvariants(db, boqId)).toEqual([]);

      expect(await csv(boqId, 1)).toBe(v1);
      expect(await csv(boqId, 2)).toBe(v2);
      const res = await get(`/tenant/boqs/${boqId}/export?format=csv&version=1`);
      expect(res.headers['content-disposition']).toContain('version 1');
      expect((await get(`/tenant/boqs/${boqId}/export?format=csv&version=9`)).statusCode).toBe(400);

      const c13 = await compare(boqId, 1, 3);
      expect(c13.summary.itemsDelta).toBe(
        String((Number(c13.to.total) - Number(c13.from.total)).toFixed(2)),
      );
      const c23 = await compare(boqId, 2, 3);
      expect(c23.rows.find((r) => r.codeA === 'A.1')).toMatchObject({
        change: 'removed',
        descriptionA: 'Excavation',
      });
      expect(c23.rows.find((r) => r.codeA === 'A.2')).toMatchObject({
        change: 'changed',
        descriptionA: 'Changed text',
        descriptionB: 'Changed text',
        notesA: '',
        notesB: 'Measured on site',
      });
      expect(c23.rows.find((r) => r.codeA === 'B.2')).toBeUndefined();
      // The counts are exactly the lines listed.
      const count = (k: string) => c23.rows.filter((r) => r.change === k).length;
      expect(c23.summary).toMatchObject({
        added: count('added'),
        removed: count('removed'),
        changed: count('changed'),
      });
    });
  });

  describe('randomised edits over several revisions', () => {
    it('reproduces every frozen version byte for byte and keeps totals consistent', async () => {
      const boqId = await newBoq('Random');
      let seed = 20261009;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
      // A starting tree: 4 sections with 8 items each.
      const ops: object[] = [];
      for (let s = 0; s < 4; s++) {
        ops.push({
          op: 'insert',
          tempId: `ts${s}`,
          parentId: null,
          afterId: s ? `ts${s - 1}` : null,
          type: 'section',
          code: `S${s}`,
          description: `Section ${s}`,
        });
        for (let i = 0; i < 8; i++)
          ops.push({
            op: 'insert',
            tempId: `t${s}_${i}`,
            parentId: `ts${s}`,
            afterId: i ? `t${s}_${i - 1}` : null,
            type: 'item',
            code: `S${s}.${i}`,
            description: `Item ${s}.${i}`,
            unit: 'cum',
            qty: String(1 + i),
            rate: String(100 + 10 * s),
          });
      }
      await changes(boqId, ops);
      const saved: string[] = [];
      const totals: string[] = [];
      let serial = 0;
      for (let round = 1; round <= 4; round++) {
        for (let k = 0; k < 25; k++) {
          const rows = await allRows(boqId);
          const items = rows.filter((r) => r.type !== 'section');
          const sections = rows.filter((r) => r.type === 'section');
          const roll = rnd();
          const it = items.length ? pick(items) : null;
          let op: object;
          if (!it || roll < 0.2) {
            const parent = pick(sections);
            op = {
              op: 'insert',
              tempId: `tr${serial++}`,
              parentId: parent.id,
              afterId: null,
              type: rnd() < 0.85 ? 'item' : 'note',
              code: `N${serial}`,
              description: `New ${serial}`,
              ...(rnd() < 0.85 ? {} : {}),
            };
            if ((op as { type: string }).type === 'item')
              Object.assign(op, {
                unit: 'nos',
                qty: String(Math.floor(rnd() * 50) + 1),
                rate: String(Math.floor(rnd() * 900) + 10),
              });
          } else if (roll < 0.45 && it.type === 'item') {
            op = {
              op: 'update',
              id: it.id,
              rowVersion: it.rowVersion,
              qty: String((rnd() * 100).toFixed(3)),
            };
          } else if (roll < 0.6 && it.type === 'item') {
            op = {
              op: 'update',
              id: it.id,
              rowVersion: it.rowVersion,
              rate: String((rnd() * 1000).toFixed(2)),
            };
          } else if (roll < 0.75) {
            op = {
              op: 'update',
              id: it.id,
              rowVersion: it.rowVersion,
              ...(rnd() < 0.6
                ? { description: `Edited ${serial++}` }
                : { notes: rnd() < 0.5 ? '' : `Note ${serial++}` }),
            };
          } else if (roll < 0.88) {
            op = { op: 'delete', id: it.id, rowVersion: it.rowVersion };
          } else {
            op = {
              op: 'move',
              id: it.id,
              rowVersion: it.rowVersion,
              parentId: pick(sections).id,
              afterId: null,
            };
          }
          await changes(boqId, [op]);
        }
        expect(await boqInvariants(db, boqId)).toEqual([]);
        saved.push(await csv(boqId));
        totals.push((await ok<{ total: string }>(get(`/tenant/boqs/${boqId}`))).total);
        await ok(
          post(`/tenant/boqs/${boqId}/freeze`, { kind: 'internal', label: `Round ${round}` }),
        );
        await ok(post(`/tenant/boqs/${boqId}/revise`));
      }
      for (let v = 1; v <= 4; v++) expect(await csv(boqId, v)).toBe(saved[v - 1]);
      for (let v = 1; v < 4; v++) {
        const c = await compare(boqId, v, v + 1, '&limit=500');
        expect(c.summary.itemsDelta).toBe((Number(totals[v]) - Number(totals[v - 1])).toFixed(2));
        // Every line counted is listed, every line listed differs, and the listed amounts add up.
        expect(c.rows.length).toBeLessThan(500);
        const count = (k: string) => c.rows.filter((r) => r.change === k).length;
        expect(c.summary).toMatchObject({
          added: count('added'),
          removed: count('removed'),
          changed: count('changed'),
        });
        for (const r of c.rows.filter((x) => x.change === 'changed'))
          expect(
            r.moved ||
              r.codeA !== r.codeB ||
              r.qtyA !== r.qtyB ||
              r.rateA !== r.rateB ||
              r.amountA !== r.amountB ||
              r.descriptionA !== r.descriptionB ||
              r.notesA !== r.notesB,
            JSON.stringify(r),
          ).toBe(true);
        const delta = c.rows
          .filter((r) => r.type === 'item')
          .reduce(
            (t, r) => t + Math.round((Number(r.amountB ?? 0) - Number(r.amountA ?? 0)) * 100),
            0,
          );
        expect((delta / 100).toFixed(2)).toBe(c.summary.itemsDelta);
      }
      // The history holds changed lines only: far less than four full copies of the BOQ.
      const lines = (await allRows(boqId)).length;
      expect(await histRows(boqId)).toBeLessThan(lines * 4);
    });
  });

  describe('lock on submission', () => {
    it('freezes the draft BOQs of a tender when it is submitted', async () => {
      const tender = await ok<{ id: string }>(
        post('/tenant/tenders', { title: 'Hostel block, Akola' }),
      );
      const civil = await ok<{ id: string }>(
        post(`/tenant/tenders/${tender.id}/boqs`, { name: 'Civil' }),
      );
      const mep = await ok<{ id: string }>(
        post(`/tenant/tenders/${tender.id}/boqs`, { name: 'MEP' }),
      );
      await ok(post(`/tenant/boqs/${mep.id}/freeze`, { kind: 'internal' }));
      await ok(post(`/tenant/tenders/${tender.id}/status`, { to: 'evaluating' }));
      await ok(
        post(`/tenant/tenders/${tender.id}/decision`, {
          criteria: DEFAULT_CRITERIA.map((c) => ({ key: c.key, weight: c.weight, score: 4 })),
          decision: 'bid',
        }),
      );
      await ok(post(`/tenant/tenders/${tender.id}/status`, { to: 'submitted' }));
      const civilV = await ok<{
        current: { status: string };
        versions: { kind: string; label: string }[];
      }>(get(`/tenant/boqs/${civil.id}/versions`));
      expect(civilV.current.status).toBe('submitted');
      expect(civilV.versions).toEqual([
        expect.objectContaining({ kind: 'submitted', label: 'Submitted with the tender' }),
      ]);
      // Already frozen BOQs keep their version.
      const mepV = await ok<{ versions: { kind: string }[] }>(
        get(`/tenant/boqs/${mep.id}/versions`),
      );
      expect(mepV.versions.map((v) => v.kind)).toEqual(['internal']);
      const events = await db<{ kind: string }[]>`
        SELECT kind FROM tender.tender_event WHERE tender_id = ${tender.id} AND kind = 'boq_frozen'`;
      expect(events).toHaveLength(2);
    });

    it('archives a BOQ made by mistake: read only, out of the bid and of the freeze on submission', async () => {
      const tender = await ok<{ id: string }>(
        post('/tenant/tenders', { title: 'Hostel block, Wardha' }),
      );
      const item = (rate: string) => ({
        op: 'insert',
        tempId: 't1',
        parentId: null,
        afterId: null,
        type: 'item',
        code: '1',
        description: 'Excavation',
        unit: 'cum',
        qty: '10',
        rate,
      });
      const civil = await ok<{ id: string }>(
        post(`/tenant/tenders/${tender.id}/boqs`, { name: 'Civil' }),
      );
      const wrong = await ok<{ id: string }>(
        post(`/tenant/tenders/${tender.id}/boqs`, { name: 'Wrong file' }),
      );
      await changes(civil.id, [item('100')]);
      await changes(wrong.id, [item('900')]);
      for (const id of [civil.id, wrong.id])
        await ok(post(`/tenant/boqs/${id}/scenarios`, { name: 'Bid', markups: [], gstPct: '0' }));
      const bid = async () =>
        await ok<{ base: string; boqs: { name: string }[] }>(
          get(`/tenant/tenders/${tender.id}/bid-summary`),
        );
      expect((await bid()).base).toBe('10000.00');

      const archived = await ok<{ archivedAt: string | null }>(
        post(`/tenant/boqs/${wrong.id}/archive`, { archived: true }),
      );
      expect(archived.archivedAt).not.toBeNull();
      expect(await bid()).toMatchObject({ base: '1000.00', boqs: [{ name: 'Civil' }] });
      // Read only: lines, header, pricing, import, freeze.
      const refused = async (res: Promise<{ statusCode: number; body: string }>) => {
        const r = await res;
        expect(r.statusCode, r.body).toBe(409);
        expect(r.body).toContain('boq_archived');
      };
      await refused(post(`/tenant/boqs/${wrong.id}/changes`, { ops: [item('1')] }));
      await refused(post(`/tenant/boqs/${wrong.id}/freeze`, { kind: 'internal' }));
      await refused(
        post(`/tenant/boqs/${wrong.id}/scenarios`, { name: 'Other', markups: [], gstPct: '0' }),
      );
      // Still readable, and listed with the tender (marked archived).
      expect((await get(`/tenant/boqs/${wrong.id}/rows`)).statusCode).toBe(200);
      const listed = await ok<{ name: string; archivedAt: string | null }[]>(
        get(`/tenant/tenders/${tender.id}/boqs`),
      );
      expect(listed.map((b) => [b.name, b.archivedAt !== null])).toEqual([
        ['Civil', false],
        ['Wrong file', true],
      ]);
      // Workers cannot archive.
      expect(
        (await post(`/tenant/boqs/${civil.id}/archive`, { archived: true }, worker)).statusCode,
      ).toBe(403);

      // Submitting the tender freezes only the BOQs in the bid.
      await ok(post(`/tenant/tenders/${tender.id}/status`, { to: 'evaluating' }));
      await ok(
        post(`/tenant/tenders/${tender.id}/decision`, {
          criteria: DEFAULT_CRITERIA.map((c) => ({ key: c.key, weight: c.weight, score: 4 })),
          decision: 'bid',
        }),
      );
      await ok(post(`/tenant/tenders/${tender.id}/status`, { to: 'submitted' }));
      const status = async (id: string) =>
        (await ok<{ current: { status: string } }>(get(`/tenant/boqs/${id}/versions`))).current
          .status;
      expect(await status(civil.id)).toBe('submitted');
      expect(await status(wrong.id)).toBe('draft');
      // What went to the client stays on the record.
      const kept = await post(`/tenant/boqs/${civil.id}/archive`, { archived: true });
      expect(kept.statusCode).toBe(409);
      expect(kept.body).toContain('boq_submitted');

      // Restoring makes it editable again.
      await ok(post(`/tenant/boqs/${wrong.id}/archive`, { archived: false }));
      await changes(wrong.id, [{ ...item('950'), tempId: 't2', code: '2' }]);
      const events = await db<{ kind: string; name: string }[]>`
        SELECT kind, data->>'name' AS name FROM tender.tender_event
        WHERE tender_id = ${tender.id} AND kind IN ('boq_archived', 'boq_restored') ORDER BY id`;
      expect(events).toEqual([
        { kind: 'boq_archived', name: 'Wrong file' },
        { kind: 'boq_restored', name: 'Wrong file' },
      ]);
    });
  });
});
