// A project's contract BOQ and budget in a real tenant database (docs/wave2a-plan.md step 2): copied from the won
// tender's submitted version (not its later draft), the contract at quoted rates (provisional sums untouched, rate-only
// items quoted) and scaled to a negotiated contract value, the budget at estimate rates; once only; budget against
// contract; and project BOQs kept to the project's team on every BOQ route, with bid pricing refused on them.
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

describe.skipIf(!controlUrl || !adminUrl)('project BOQs (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-project-boq-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'project-boq-admin@example.in');
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

  interface Line {
    line_key: string;
    code: string | null;
    node_type: string;
    item_kind: string;
    rate: string | null;
    amount: string | null;
    subtotal: string;
    child_count: number;
    description: string;
  }
  const lines = (boqId: string) =>
    db<Line[]>`
      SELECT n.line_key, n.code, n.node_type, n.item_kind, n.rate::text, n.amount::text, n.subtotal::text,
        n.child_count, t.description
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boqId} ORDER BY n.sort_key`;
  const byCode = (ls: Line[]) => Object.fromEntries(ls.map((l) => [l.code ?? l.description, l]));
  /** Waits for the background copy to finish. */
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
  let civilId: string;
  let contractId: string;
  let budgetId: string;

  it('prepares a won tender: a BOQ submitted at a 10% markup, then revised in a draft', async () => {
    civilId = (
      await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Civil' }))
    ).id;
    const item = (tempId: string, parentId: string, afterId: string | null, rest: object) => ({
      op: 'insert',
      tempId,
      parentId,
      afterId,
      type: 'item',
      unit: 'cum',
      ...rest,
    });
    await ok(
      post(`/tenant/boqs/${civilId}/changes`, {
        ops: [
          {
            op: 'insert',
            tempId: 'tA',
            parentId: null,
            afterId: null,
            type: 'section',
            code: 'A',
            description: 'Earthwork',
          },
          item('ta1', 'tA', null, {
            code: 'A.1',
            description: 'Excavation',
            qty: '10',
            rate: '100',
          }),
          item('ta2', 'tA', 'ta1', { code: 'A.2', description: 'Old text', qty: '5', rate: '200' }),
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
          item('tb1', 'tB', null, { code: 'B.1', description: 'PCC', qty: '2', rate: '1000' }),
          item('tb2', 'tB', 'tb1', {
            code: 'B.2',
            description: 'Lift (provisional)',
            unit: 'LS',
            qty: '1',
            rate: '5000',
            kind: 'provisional',
          }),
          item('tb3', 'tB', 'tb2', {
            code: 'B.3',
            description: 'Extra lead',
            unit: 'cum/km',
            rate: '50',
            kind: 'rate_only',
          }),
        ],
      }),
    );
    await ok(
      post(`/tenant/boqs/${civilId}/scenarios`, {
        name: 'Bid',
        markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '10' }],
      }),
    );
    await ok(post(`/tenant/boqs/${civilId}/freeze`, { kind: 'submitted', label: 'R0' }));
    // After submission the estimate moves on: the project must not see it.
    await ok(post(`/tenant/boqs/${civilId}/revise`, {}));
    const [a1] = await db<{ id: string; row_version: number }[]>`
      SELECT id::text, row_version FROM est.boq_node WHERE boq_id = ${civilId} AND code = 'A.1'`;
    const [a2] = await db<{ id: string; row_version: number }[]>`
      SELECT id::text, row_version FROM est.boq_node WHERE boq_id = ${civilId} AND code = 'A.2'`;
    await ok(
      post(`/tenant/boqs/${civilId}/changes`, {
        ops: [
          { op: 'update', id: a1!.id, rowVersion: a1!.row_version, rate: '150' },
          { op: 'update', id: a2!.id, rowVersion: a2!.row_version, description: 'New text' },
        ],
      }),
    );
    // A BOQ archived as a mistake stays behind.
    const wrong = await ok<{ id: string }>(
      post(`/tenant/tenders/${tenderId}/boqs`, { name: 'Wrong' }),
    );
    await ok(post(`/tenant/boqs/${wrong.id}/archive`, { archived: true }));

    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tenderId}`;
    await db`INSERT INTO tender.competitor_bid (tender_id, party_id, quoted_value, qualified)
      VALUES (${tenderId}, NULL, 9400, true)`;
    projectId = (await ok<{ id: string }>(post(`/tenant/tenders/${tenderId}/project`, {}, manager)))
      .id;
  });

  it('previews the copy: the submitted version, its factor, quoted against contract value', async () => {
    expect(await ok(get(`/tenant/projects/${projectId}/boqs/from-tender`, manager))).toEqual({
      tenderId,
      copied: false,
      copy: null,
      sources: [
        expect.objectContaining({
          id: civilId,
          name: 'Civil',
          version: 1,
          submitted: true,
          factor: '1.100000',
          quotedTotal: '9400.00',
          estimateTotal: '9000.00',
        }),
      ],
      contractValue: '9400.00',
      quotedTotal: '9400.00',
      estimateTotal: '9000.00',
      scale: '1.00000000',
    });
  });

  it('copies the contract at quoted rates scaled to a negotiated value, and the budget at estimate rates', async () => {
    const project = await ok<{ rowVersion: number }>(get(`/tenant/projects/${projectId}`, manager));
    // A contract value including GST (or a typo) is not scaled to.
    await ok(
      post(
        `/tenant/projects/${projectId}`,
        { rowVersion: project.rowVersion, contractValue: '11092' },
        manager,
      ),
    );
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/boqs/from-tender`,
          { matchContractValue: true },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'scale_out_of_range' });
    // Negotiated down by 220 on the quoted 4400 of normal items: their rates × 0.95.
    await ok(
      post(
        `/tenant/projects/${projectId}`,
        { rowVersion: project.rowVersion + 1, contractValue: '9180' },
        manager,
      ),
    );
    const started = await ok<{ copy: { status: string } }>(
      post(`/tenant/projects/${projectId}/boqs/from-tender`, { matchContractValue: true }, manager),
    );
    expect(started.copy.status).toMatch(/copying|done/);
    const copy = await copied();
    expect(copy).toMatchObject({
      status: 'done',
      result: {
        scale: '0.95000000',
        contractTotal: '9180.00',
        budgetTotal: '9000.00',
        residual: '0.00',
      },
    });
    const res = {
      boqs: await ok<
        {
          id: string;
          kind: string;
          name: string;
          total: string;
          sourceVersionNo: number;
          rateBasis: object;
        }[]
      >(get(`/tenant/projects/${projectId}/boqs`, manager)),
    };
    const contract = res.boqs.find((b) => b.kind === 'contract')!;
    const budget = res.boqs.find((b) => b.kind === 'budget')!;
    [contractId, budgetId] = [contract.id, budget.id];
    expect(contract).toMatchObject({
      name: 'Civil (contract)',
      total: '9180.00',
      sourceVersionNo: 1,
      rateBasis: { factor: '1.100000', scale: '0.95000000', residual: '0.00' },
    });
    expect(budget).toMatchObject({ name: 'Civil (budget)', total: '9000.00', sourceVersionNo: 1 });

    const c = byCode(await lines(contractId));
    expect(c['A']).toMatchObject({ node_type: 'section', subtotal: '2090.00', child_count: 3 });
    // 100 × 1.1 × 0.95, from version 1 (the draft's 150 and new text are not the contract).
    expect(c['A.1']).toMatchObject({ rate: '104.5000', amount: '1045.00' });
    expect(c['A.2']).toMatchObject({
      rate: '209.0000',
      amount: '1045.00',
      description: 'Old text',
    });
    expect(c['Lead 50 m']).toMatchObject({ node_type: 'note' });
    expect(c['B.1']).toMatchObject({ rate: '1045.0000', amount: '2090.00' });
    expect(c['B.2']).toMatchObject({
      item_kind: 'provisional',
      rate: '5000.0000',
      amount: '5000.00',
    });
    expect(c['B.3']).toMatchObject({ item_kind: 'rate_only', rate: '52.2500', amount: null });
    const b = byCode(await lines(budgetId));
    expect(b['A.1']).toMatchObject({ rate: '100.0000', amount: '1000.00' });
    expect(b['B.3']).toMatchObject({ rate: '50.0000', amount: null });
    // One line, one identity: tender, contract and budget lines share their line key.
    const src = byCode(await lines(civilId));
    expect(c['B.1']!.line_key).toBe(src['B.1']!.line_key);
    expect(b['B.1']!.line_key).toBe(src['B.1']!.line_key);
    const [counts] = await db<{ node_count: number; item_count: number; status: string }[]>`
      SELECT node_count, item_count, status FROM est.boq WHERE id = ${contractId}`;
    expect(counts).toEqual({ node_count: 8, item_count: 5, status: 'draft' });

    // Once only.
    expect(
      (await post(`/tenant/projects/${projectId}/boqs/from-tender`, {}, manager)).json(),
    ).toMatchObject({ code: 'boqs_copied' });
    const events = await db<{ kind: string }[]>`
      SELECT kind FROM proj.project_event WHERE project_id = ${projectId} ORDER BY id DESC LIMIT 1`;
    expect(events[0]!.kind).toBe('boqs_from_tender');
    // The tender's own BOQ list is unchanged; the BOQ says whose it is.
    const tenderBoqs = await ok<{ id: string }[]>(get(`/tenant/tenders/${tenderId}/boqs`));
    expect(tenderBoqs.map((x) => x.id)).not.toContain(contractId);
    expect(await ok(get(`/tenant/boqs/${contractId}`, manager))).toMatchObject({
      kind: 'contract',
      tender: null,
      project: { id: projectId },
    });
  });

  it('sets the budget against the contract: totals, planned margin, and top-level lines side by side', async () => {
    expect(await ok(get(`/tenant/projects/${projectId}/boq-summary`, manager))).toMatchObject({
      contractValue: '9180.00',
      contract: '9180.00',
      budget: '9000.00',
      margin: '180.00',
      marginPct: '1.96',
      boqs: [
        {
          contractId,
          budgetId,
          margin: '180.00',
          lines: [
            {
              code: 'A',
              description: 'Earthwork',
              contract: '2090.00',
              budget: '2000.00',
              margin: '90.00',
            },
            {
              code: 'B',
              description: 'Concrete',
              contract: '7090.00',
              budget: '7000.00',
              margin: '90.00',
            },
          ],
        },
      ],
    });
    // An empty BOQ for later work joins the list.
    const extra = await ok<{ kind: string; total: string }>(
      post(
        `/tenant/projects/${projectId}/boqs`,
        { name: 'Extra items', kind: 'contract' },
        manager,
      ),
    );
    expect(extra).toMatchObject({ kind: 'contract', total: '0.00' });
    expect(await ok<unknown[]>(get(`/tenant/projects/${projectId}/boqs`, manager))).toHaveLength(3);
  });

  it("keeps project BOQs to the project's team on every BOQ route, and bid pricing to tenders", async () => {
    // Workers may edit BOQs in this company; this one is not on the project.
    await ok(
      post('/tenant/permissions', { role: 'worker', permission: 'boq.edit', granted: true }),
    );
    for (const url of [
      `/tenant/boqs/${contractId}`,
      `/tenant/boqs/${contractId}/rows`,
      `/tenant/projects/${projectId}/boqs`,
    ])
      expect((await get(url, worker)).statusCode).toBe(404);
    // The tender's estimate stays open to them, as before.
    expect((await get(`/tenant/boqs/${civilId}`, worker)).statusCode).toBe(200);
    // A viewer reads, and changes nothing.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect((await get(`/tenant/boqs/${contractId}/rows`, worker)).statusCode).toBe(200);
    const [a1] = await db<{ id: string; row_version: number }[]>`
      SELECT id::text, row_version FROM est.boq_node WHERE boq_id = ${contractId} AND code = 'A.1'`;
    const edit = { ops: [{ op: 'update', id: a1!.id, rowVersion: a1!.row_version, qty: '12' }] };
    expect((await post(`/tenant/boqs/${contractId}/changes`, edit, worker)).json()).toMatchObject({
      code: 'forbidden',
    });
    // A member works on it.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    await ok(post(`/tenant/boqs/${contractId}/changes`, edit, worker));
    expect((await ok<{ total: string }>(get(`/tenant/boqs/${contractId}`, worker))).total).toBe(
      '9389.00',
    );
    // Bid pricing is the tender's.
    expect((await get(`/tenant/boqs/${contractId}/pricing`, manager)).json()).toMatchObject({
      code: 'not_for_project_boq',
    });
    expect(
      (await post(`/tenant/boqs/${contractId}/scenarios`, { name: 'x' }, manager)).statusCode,
    ).toBe(409);
    // Freezing the contract BOQ records it in the project's log; its report and export work.
    await ok(
      post(`/tenant/boqs/${contractId}/freeze`, { kind: 'internal', label: 'Agreed' }, manager),
    );
    const [ev] = await db<{ kind: string }[]>`
      SELECT kind FROM proj.project_event WHERE project_id = ${projectId} ORDER BY id DESC LIMIT 1`;
    expect(ev!.kind).toBe('boq_frozen');
    expect((await get(`/tenant/boqs/${contractId}/cost-summary`, manager)).statusCode).toBe(200);
    const csv = await get(`/tenant/boqs/${contractId}/export?format=csv`, manager);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-disposition']).toContain('PRJ');
  });

  it('refuses a project without a tender, and fails a copy that died with its server', async () => {
    const direct = await ok<{ id: string }>(
      post('/tenant/projects', { name: 'Godown, Karanja' }, manager),
    );
    expect(
      (await post(`/tenant/projects/${direct.id}/boqs/from-tender`, {}, manager)).json(),
    ).toMatchObject({
      code: 'no_tender',
    });
    // Marked as copying two minutes ago, and nobody holds its lock.
    await db`INSERT INTO proj.boq_copy (project_id, status, match_contract_value, started_at)
      VALUES (${direct.id}, 'copying', false, now() - interval '2 minutes')`;
    expect(
      (await ok<{ copy: object }>(get(`/tenant/projects/${direct.id}/boqs/from-tender`, manager)))
        .copy,
    ).toMatchObject({ status: 'failed', error: expect.stringContaining('restarted') });
  });
});
