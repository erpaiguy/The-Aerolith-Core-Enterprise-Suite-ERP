// WBS and cost codes in a real tenant database (docs/wave2a-plan.md step 3): the company's cost codes (a standard list,
// unique codes, retired codes), a project's WBS made from its contract BOQ's sections with the items mapped, a range
// of lines mapped to a cost code and a line to a WBS element (contract and budget together, across revisions), the
// contract and budget broken down by both, the WBS edited by hand, and who may do what.
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

describe.skipIf(!controlUrl || !adminUrl)('WBS and cost codes (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let tenderId: string;
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-wbs-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'wbs-admin@example.in');
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    const client = await ok<{ id: string }>(
      post('/tenant/parties', { name: 'Zilla Parishad Washim', isClient: true }),
    );
    tenderId = (
      await ok<{ id: string }>(
        post('/tenant/tenders', {
          title: 'Primary school, Malegaon',
          clientId: client.id,
          location: 'Malegaon, Washim',
          estimatedValue: '24000000',
        }),
      )
    ).id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  const copied = async () => {
    for (let i = 0; i < 200; i++) {
      const p = await ok<{ copy: { status: string } | null }>(
        get(`/tenant/projects/${projectId}/boqs/from-tender`, manager),
      );
      if (p.copy && p.copy.status !== 'copying') return p.copy;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the copy did not finish');
  };
  const key = async (boqId: string, code: string) =>
    (
      await db<{ sort_key: string }[]>`
        SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId} AND code = ${code}`
    )[0]!.sort_key;
  interface Row {
    code: string | null;
    type: string;
    map: { wbs: string | null; costCode: string | null } | null;
  }
  const rows = async (boqId: string) =>
    Object.fromEntries(
      (await ok<{ rows: Row[] }>(get(`/tenant/boqs/${boqId}/rows?limit=100`, manager))).rows.map(
        (r) => [r.code, r],
      ),
    );
  interface Node {
    id: string;
    parentId: string | null;
    code: string;
    name: string;
    depth: number;
    lines: number;
    rowVersion: number;
  }
  const byCode = <T extends { code: string }>(list: T[]) =>
    Object.fromEntries(list.map((n) => [n.code, n]));
  let civilId: string;
  let contractId: string;
  let budgetId: string;
  let codes: Record<string, { id: string; rowVersion: number; active: boolean }>;
  let wbs: Record<string, Node>;

  it('prepares a won tender priced at 10%, made a project with its contract BOQ and budget', async () => {
    civilId = (
      await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Civil' }))
    ).id;
    const section = (
      tempId: string,
      parentId: string | null,
      afterId: string | null,
      code: string,
      description: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId,
      afterId,
      type: 'section',
      code,
      description,
    });
    const item = (
      tempId: string,
      parentId: string | null,
      afterId: string | null,
      code: string,
      qty: string,
      rate: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId,
      afterId,
      type: 'item',
      code,
      description: `Item ${code}`,
      unit: 'cum',
      qty,
      rate,
    });
    await ok(
      post(`/tenant/boqs/${civilId}/changes`, {
        ops: [
          section('tA', null, null, 'A', 'Earthwork'),
          section('tA1', 'tA', null, 'A1', 'Excavation'),
          item('ta11', 'tA1', null, 'A.1.1', '10', '100'),
          item('ta12', 'tA1', 'ta11', 'A.1.2', '5', '200'),
          section('tA2', 'tA', 'tA1', 'A2', 'Filling'),
          item('ta21', 'tA2', null, 'A.2.1', '1', '500'),
          section('tB', null, 'tA', 'B', 'Concrete'),
          item('tb1', 'tB', null, 'B.1', '2', '1000'),
          item('tb2', 'tB', 'tb1', 'B.2', '1', '300'),
          item('tx', null, 'tB', 'X', '1', '100'),
        ],
      }),
    );
    await ok(
      post(`/tenant/boqs/${civilId}/scenarios`, {
        name: 'Bid',
        markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '10' }],
      }),
    );
    await ok(post(`/tenant/boqs/${civilId}/freeze`, { kind: 'submitted' }));
    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tenderId}`;
    projectId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/project`, {}, manager)))
      .id;
    await ok(post(`/tenant/projects/${projectId}/boqs/from-tender`, {}, manager));
    expect((await copied()).status).toBe('done');
    const boqs = await ok<{ id: string; kind: string }[]>(
      get(`/tenant/projects/${projectId}/boqs`, manager),
    );
    contractId = boqs.find((b) => b.kind === 'contract')!.id;
    budgetId = boqs.find((b) => b.kind === 'budget')!.id;
  });

  it("keeps the company's cost codes: a standard list, unique codes, retired codes", async () => {
    expect(await ok(get('/tenant/cost-codes', worker))).toEqual([]);
    expect((await post('/tenant/cost-codes/standard', {}, worker)).statusCode).toBe(403);
    const list = await ok<{ code: string; depth: number; kind: string }[]>(
      post('/tenant/cost-codes/standard', {}, manager),
    );
    expect(list).toHaveLength(23);
    expect(list.slice(0, 3)).toMatchObject([
      { code: 'LAB', depth: 0, kind: 'labour' },
      { code: 'LAB.CIV', depth: 1 },
      { code: 'LAB.FIN', depth: 1 },
    ]);
    expect((await post('/tenant/cost-codes/standard', {}, manager)).json()).toMatchObject({
      code: 'cost_codes_exist',
    });
    const mat = list.find((c) => c.code === 'MAT') as unknown as { id: string };
    await ok(
      post(
        '/tenant/cost-codes',
        { parentId: mat.id, code: 'MAT.WTP', name: 'Waterproofing', kind: 'material' },
        manager,
      ),
    );
    expect(
      (await post('/tenant/cost-codes', { code: 'mat.wtp', name: 'Again' }, manager)).json(),
    ).toMatchObject({ code: 'code_taken' });
    expect(
      (await post('/tenant/cost-codes', { code: 'bad code', name: 'Spaces' }, manager)).statusCode,
    ).toBe(400);
    codes = byCode(
      await ok<{ code: string; id: string; rowVersion: number; active: boolean }[]>(
        get('/tenant/cost-codes'),
      ),
    );
    // Retired: kept, but no longer offered for mapping.
    await ok(
      post(
        `/tenant/cost-codes/${codes['OVH.INS']!.id}`,
        { rowVersion: codes['OVH.INS']!.rowVersion, active: false },
        manager,
      ),
    );
    // A code cannot go under its own child.
    expect(
      (
        await post(
          `/tenant/cost-codes/${codes['MAT']!.id}`,
          { rowVersion: codes['MAT']!.rowVersion, parentId: codes['MAT.CEM']!.id },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'parent_cycle' });
  });

  it("makes the WBS from the contract BOQ's sections, mapping every item under them", async () => {
    // Only the lead or someone who edits projects: a member may not.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/wbs/from-boq`,
          { boqId: contractId, depth: 2 },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    // Not a BOQ of this project.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/wbs/from-boq`,
          { boqId: civilId, depth: 2 },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'boq_not_found' });
    const made = await ok<{ elements: number; lines: number; nodes: Node[] }>(
      post(`/tenant/projects/${projectId}/wbs/from-boq`, { boqId: contractId, depth: 2 }, manager),
    );
    expect(made).toMatchObject({ elements: 4, lines: 5 });
    expect(made.nodes.map((n) => [n.code, n.name, n.depth, n.lines])).toEqual([
      ['1', 'Earthwork', 0, 0],
      ['1.1', 'Excavation', 1, 2],
      ['1.2', 'Filling', 1, 1],
      ['2', 'Concrete', 0, 2],
    ]);
    wbs = byCode(made.nodes);
    expect(
      (
        await post(`/tenant/projects/${projectId}/wbs/from-boq`, { boqId: contractId }, manager)
      ).json(),
    ).toMatchObject({ code: 'wbs_not_empty' });
    // The grid shows the mapping, on the contract and on its budget (one line, one key).
    const c = await rows(contractId);
    expect(c['A.1.1']!.map).toEqual({ wbs: '1.1', costCode: null });
    expect(c['X']!.map).toBeNull();
    expect(c['A']!.map).toBeNull();
    expect((await rows(budgetId))['B.2']!.map).toEqual({ wbs: '2', costCode: null });
  });

  it('maps a range of lines to a cost code and one line to a WBS element, and clears them', async () => {
    const b = await key(contractId, 'B');
    // The section brings its items.
    expect(
      await ok(
        post(
          `/tenant/boqs/${contractId}/mapping`,
          { from: b, to: b, costCodeId: codes['MAT.CEM']!.id },
          worker,
        ),
      ),
    ).toEqual({ changed: 2 });
    const x = await key(contractId, 'X');
    await ok(
      post(`/tenant/boqs/${contractId}/mapping`, { from: x, to: x, wbsId: wbs['2']!.id }, worker),
    );
    let c = await rows(contractId);
    expect(c['B.1']!.map).toEqual({ wbs: '2', costCode: 'MAT.CEM' });
    expect(c['X']!.map).toEqual({ wbs: '2', costCode: null });
    // Cleared: a line with nothing mapped has no mapping left.
    await ok(post(`/tenant/boqs/${contractId}/mapping`, { from: x, to: x, wbsId: null }, worker));
    c = await rows(contractId);
    expect(c['X']!.map).toBeNull();
    const [lk] = await db<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM proj.boq_line_map WHERE project_id = ${projectId}`;
    expect(lk!.n).toBe(5);
    // Refused: a retired code, nothing to map, a tender's BOQ, and a viewer.
    expect(
      (
        await post(
          `/tenant/boqs/${contractId}/mapping`,
          { from: x, to: x, costCodeId: codes['OVH.INS']!.id },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'cost_code_inactive' });
    expect(
      (await post(`/tenant/boqs/${contractId}/mapping`, { from: x, to: x }, worker)).json(),
    ).toMatchObject({
      code: 'nothing_to_map',
    });
    const tx = await key(civilId, 'X');
    expect(
      (
        await post(
          `/tenant/boqs/${civilId}/mapping`,
          { from: tx, to: tx, wbsId: wbs['2']!.id },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_a_project_boq' });
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect(
      (
        await post(
          `/tenant/boqs/${contractId}/mapping`,
          { from: x, to: x, wbsId: wbs['2']!.id },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    // A frozen and revised contract keeps its mapping, and can still be mapped.
    await ok(
      post(`/tenant/boqs/${contractId}/freeze`, { kind: 'internal', label: 'Agreed' }, manager),
    );
    await ok(
      post(`/tenant/boqs/${contractId}/mapping`, { from: x, to: x, wbsId: wbs['2']!.id }, manager),
    );
    await ok(post(`/tenant/boqs/${contractId}/revise`, {}, manager));
    c = await rows(contractId);
    expect(c['A.2.1']!.map).toEqual({ wbs: '1.2', costCode: null });
    expect(c['X']!.map).toEqual({ wbs: '2', costCode: null });
  });

  it('breaks the contract and budget down by WBS and by cost code', async () => {
    const d = await ok<{
      totals: Record<string, { lines: number; amount: string }>;
      unmapped: Record<string, Record<string, { lines: number; amount: string }>>;
      wbs: {
        code: string;
        contract: string;
        budget: string;
        margin: string;
        contractLines: number;
      }[];
      costCodes: { code: string; contract: string; budget: string }[];
    }>(get(`/tenant/projects/${projectId}/breakdown`, worker));
    expect(d.totals).toEqual({
      contract: { lines: 6, amount: '5390.00' },
      budget: { lines: 6, amount: '4900.00' },
    });
    expect(d.wbs.map((n) => [n.code, n.contract, n.budget, n.margin, n.contractLines])).toEqual([
      ['1', '2750.00', '2500.00', '250.00', 3],
      ['1.1', '2200.00', '2000.00', '200.00', 2],
      ['1.2', '550.00', '500.00', '50.00', 1],
      ['2', '2640.00', '2400.00', '240.00', 3],
    ]);
    expect(d.unmapped.wbs).toEqual({
      contract: { lines: 0, amount: '0.00' },
      budget: { lines: 0, amount: '0.00' },
    });
    expect(d.unmapped.costCode!.contract).toEqual({ lines: 4, amount: '2860.00' });
    const cc = byCode(d.costCodes);
    expect(cc['MAT']).toMatchObject({ contract: '2530.00', budget: '2300.00' });
    expect(cc['MAT.CEM']).toMatchObject({ contract: '2530.00', budget: '2300.00' });
    expect(cc['LAB']).toMatchObject({ contract: '0.00' });
    // Retired and never used: left out.
    expect(cc['OVH.INS']).toBeUndefined();
  });

  it('edits the WBS by hand: add, rename, reorder, move, and remove only what is empty', async () => {
    const list = () => ok<Node[]>(get(`/tenant/projects/${projectId}/wbs`, manager));
    let nodes = await ok<Node[]>(
      post(`/tenant/projects/${projectId}/wbs`, { code: '3', name: 'Finishes' }, manager),
    );
    expect(nodes.map((n) => n.code)).toEqual(['1', '1.1', '1.2', '2', '3']);
    expect(
      (
        await post(`/tenant/projects/${projectId}/wbs`, { code: '3', name: 'Twice' }, manager)
      ).json(),
    ).toMatchObject({ code: 'code_taken' });
    let w = byCode(nodes);
    nodes = await ok<Node[]>(post(`/tenant/wbs/${w['3']!.id}/move`, { direction: 'up' }, manager));
    expect(nodes.filter((n) => n.depth === 0).map((n) => n.code)).toEqual(['1', '3', '2']);
    // Filling moves under Concrete; Earthwork cannot go under its own child.
    nodes = await ok<Node[]>(
      post(
        `/tenant/wbs/${w['1.2']!.id}`,
        { rowVersion: w['1.2']!.rowVersion, parentId: w['2']!.id, name: 'Filling and compaction' },
        manager,
      ),
    );
    expect(nodes.map((n) => [n.code, n.depth])).toEqual([
      ['1', 0],
      ['1.1', 1],
      ['3', 0],
      ['2', 0],
      ['1.2', 1],
    ]);
    w = byCode(nodes);
    expect(
      (
        await post(
          `/tenant/wbs/${w['1']!.id}`,
          { rowVersion: w['1']!.rowVersion, parentId: w['1.1']!.id },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'parent_cycle' });
    // In use: refused. Empty: removed.
    expect((await post(`/tenant/wbs/${w['1']!.id}/delete`, {}, manager)).json()).toMatchObject({
      code: 'wbs_in_use',
    });
    expect((await post(`/tenant/wbs/${w['3']!.id}/delete`, {}, manager)).statusCode).toBe(200);
    expect((await list()).map((n) => n.code)).toEqual(['1', '1.1', '2', '1.2']);
    // A worker not on the team sees no WBS at all.
    await ok(post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: null }, manager));
    expect((await get(`/tenant/projects/${projectId}/wbs`, worker)).statusCode).toBe(404);
  });
});
