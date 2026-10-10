// Progress measurement in a real tenant database (docs/wave2a-plan.md step 6): the measurement book of contract BOQ
// items (dimensions with a deduction, figures, an excess, a wrong entry reversed), the progress report (value done at
// contract rates, physical progress within BOQ quantities, the period, the budget value of the work) by BOQ section
// and WBS element, schedule activities' physical progress through their items, and who may record.
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

describe.skipIf(!controlUrl || !adminUrl)('progress measurement (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-progress-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'progress-admin@example.in');
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

  let tender: string;
  let contractId: string;
  const line = async (boqId: string, code: string) =>
    (
      await db<
        { id: string }[]
      >`SELECT id::text FROM est.boq_node WHERE boq_id = ${boqId} AND code = ${code}`
    )[0]!.id;
  const measure = (code: string, body: object, as = manager) =>
    line(contractId, code).then((id) =>
      post(`/tenant/boqs/${contractId}/lines/${id}/progress`, body, as),
    );

  it('records work done in the contract BOQ: dimensions with a deduction, figures, a reversal', async () => {
    tender = tenderId;
    const civil = (
      await ok<{ id: string }>(post(`/tenant/tenders/${tender}/boqs`, { name: 'Civil' }))
    ).id;
    const item = (
      tempId: string,
      parentId: string,
      afterId: string | null,
      code: string,
      unit: string,
      qty: string,
      rate: string,
      kind?: string,
    ) => ({
      op: 'insert',
      tempId,
      parentId,
      afterId,
      type: 'item',
      code,
      description: `Item ${code}`,
      unit,
      qty,
      rate,
      ...(kind ? { kind } : {}),
    });
    await ok(
      post(`/tenant/boqs/${civil}/changes`, {
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
          item('ta1', 'tA', null, 'A.1', 'cum', '100', '100'),
          item('ta2', 'tA', 'ta1', 'A.2', 'cum', '50', '200'),
          {
            op: 'insert',
            tempId: 'tB',
            parentId: null,
            afterId: 'tA',
            type: 'section',
            code: 'B',
            description: 'Concrete',
          },
          item('tb1', 'tB', null, 'B.1', 'cum', '20', '1000'),
          item('tb2', 'tB', 'tb1', 'B.2', 'LS', '1', '5000', 'provisional'),
        ],
      }),
    );
    await ok(
      post(`/tenant/boqs/${civil}/scenarios`, {
        name: 'Bid',
        markups: [{ kind: 'profit', label: 'Profit', basis: 'base', pct: '10' }],
      }),
    );
    await ok(post(`/tenant/boqs/${civil}/freeze`, { kind: 'submitted' }));
    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tender}`;
    projectId = (await ok<{ id: string }>(post(`/tenant/tenders/${tender}/project`, {}, manager)))
      .id;
    await ok(post(`/tenant/projects/${projectId}/boqs/from-tender`, {}, manager));
    for (let i = 0; i < 200; i++) {
      const p = await ok<{ copied: boolean }>(
        get(`/tenant/projects/${projectId}/boqs/from-tender`, manager),
      );
      if (p.copied) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const boqs = await ok<{ id: string; kind: string }[]>(
      get(`/tenant/projects/${projectId}/boqs`, manager),
    );
    contractId = boqs.find((b) => b.kind === 'contract')!.id;
    await ok(
      post(`/tenant/projects/${projectId}/wbs/from-boq`, { boqId: contractId, depth: 1 }, manager),
    );

    // A.1: 2 × 10 × 5 × 0.5 = 50, less a pit 1 × 2 × 2 × 0.5 = 2: 48 cum on 5 October; 30 more on the 8th.
    let book = await ok<{ done: string; pct: number; entries: unknown[] }>(
      measure('A.1', {
        measuredOn: '2026-10-05',
        description: 'Grid 1–3',
        dims: [
          { description: 'Trench', nos: 2, length: 10, breadth: 5, height: 0.5 },
          { description: 'Pit', nos: 1, length: 2, breadth: 2, height: 0.5, deduct: true },
        ],
      }),
    );
    expect(book).toMatchObject({ done: '48.0000', pct: 48 });
    book = await ok(measure('A.1', { measuredOn: '2026-10-08', qty: '30' }));
    expect(book).toMatchObject({ done: '78.0000', pct: 78 });
    // A.2: more than the BOQ quantity (a deviation).
    expect(await ok(measure('A.2', { measuredOn: '2026-10-06', qty: '60' }))).toMatchObject({
      pct: 120,
    });
    // B.1: 5 on the 6th; 50 by mistake on the 7th, reversed.
    await ok(measure('B.1', { measuredOn: '2026-10-06', qty: '5' }));
    const wrong = await ok<{ entries: { id: string; qty: string }[] }>(
      measure('B.1', { measuredOn: '2026-10-07', qty: '50' }),
    );
    const bad = wrong.entries.find((e) => e.qty === '50.0000')!.id;
    const fixed = await ok<{
      done: string;
      entries: { reverses: string | null; reversedBy: string | null }[];
    }>(
      post(
        `/tenant/boqs/${contractId}/progress/${bad}/reverse`,
        { reason: 'typed 50 for 5' },
        manager,
      ),
    );
    expect(fixed.done).toBe('5.0000');
    expect(fixed.entries.filter((e) => e.reverses === bad)).toHaveLength(1);
    expect(
      (
        await post(
          `/tenant/boqs/${contractId}/progress/${bad}/reverse`,
          { reason: 'again' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'already_reversed' });
    // The grid shows what is done.
    const rows = await ok<{ rows: { code: string; done: string | null }[] }>(
      get(`/tenant/boqs/${contractId}/rows?limit=50`, manager),
    );
    expect(rows.rows.find((r) => r.code === 'A.1')!.done).toBe('78.0000');
  });

  it('refuses the future, sections, tender BOQs, and viewers; the book is never changed', async () => {
    expect((await measure('A.1', { measuredOn: '2099-01-15', qty: '1' })).json()).toMatchObject({
      code: 'measured_in_future',
    });
    expect((await measure('A', { measuredOn: '2026-10-05', qty: '1' })).json()).toMatchObject({
      code: 'not_an_item',
    });
    const [civil] = await db<{ id: string }[]>`SELECT id FROM est.boq WHERE tender_id = ${tender}`;
    const estimateLine = await line(civil!.id, 'A.1');
    expect(
      (
        await post(`/tenant/boqs/${civil!.id}/lines/${estimateLine}/progress`, {
          measuredOn: '2026-10-05',
          qty: '1',
        })
      ).json(),
    ).toMatchObject({ code: 'not_a_contract_boq' });
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect((await measure('A.1', { measuredOn: '2026-10-05', qty: '1' }, worker)).statusCode).toBe(
      403,
    );
    // A site engineer on the team records, without any BOQ rights.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    expect((await measure('A.1', { measuredOn: '2026-10-09', qty: '0' }, worker)).statusCode).toBe(
      400,
    );
    await expect(db`UPDATE proj.measurement SET qty = 1`).rejects.toThrow(/permission denied/);
    await expect(db`DELETE FROM proj.measurement`).rejects.toThrow(/permission denied/);
  });

  it('reports value done at contract rates and physical progress, by section and by WBS element', async () => {
    const r = await ok<{
      total: Record<string, unknown>;
      boqs: { sections: { code: string; pct: number; value: string; done: string }[] }[];
      wbs: { code: string; pct: number; done: string }[];
    }>(get(`/tenant/projects/${projectId}/progress?from=2026-10-07&to=2026-12-31`, manager));
    // Contract rates at 110%: A.1 110, A.2 220, B.1 1,100, the provisional sum 5,000: 49,000 in all.
    // Done: 78 × 110 + 60 × 220 + 5 × 1,100 = 27,280; within BOQ quantities 8,580 + 11,000 + 5,500 = 25,080 (51.2%).
    expect(r.total).toEqual({
      value: '49000.00',
      done: '27280.00',
      period: '3300.00',
      budgetDone: '24800.00',
      pct: 51.2,
      items: 4,
      itemsStarted: 3,
      itemsOver: 1,
    });
    expect(r.boqs[0]!.sections.map((s) => [s.code, s.value, s.done, s.pct])).toEqual([
      ['A', '22000.00', '21780.00', 89],
      ['B', '27000.00', '5500.00', 20.4],
    ]);
    expect(r.wbs.map((w) => [w.code, w.done, w.pct])).toEqual([
      ['1', '21780.00', 89],
      ['2', '5500.00', 20.4],
    ]);
  });

  it('gives a schedule activity the physical progress of the items it carries out', async () => {
    const plan = await ok<{ id: string; activities: { id: string; code: string }[] }>(
      post(
        `/tenant/projects/${projectId}/schedules`,
        { name: 'Works', startOn: '2026-10-01', fromWbs: true },
        manager,
      ),
    );
    const act = plan.activities.find((a) => a.code === '1')!.id;
    const url = `/tenant/programmes/${plan.id}/activities/${act}/lines`;
    // The Earthwork section brings both its items: 19,580 of 22,000 within quantities.
    const linked = await ok<{
      added: number;
      physicalPct: number;
      lines: { code: string; lineKey: string }[];
    }>(post(url, { boqId: contractId, code: 'a' }, worker));
    expect(linked).toMatchObject({ added: 2, physicalPct: 89, value: '22000.00' });
    const a2 = linked.lines.find((l) => l.code === 'A.2')!.lineKey;
    expect(await ok(post(`${url}/remove`, { lineKey: a2 }, worker))).toMatchObject({
      physicalPct: 78,
    });
    expect((await post(url, { boqId: contractId, code: 'Z.9' }, worker)).json()).toMatchObject({
      code: 'code_not_found',
    });
    expect(await ok(get(url, manager))).toMatchObject({
      lines: [{ code: 'A.1', done: '78.0000' }],
    });
  });
});
