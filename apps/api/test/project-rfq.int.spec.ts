// A project's enquiries to vendors in a real tenant database (docs/wave2b-plan.md step 3): an RFQ owned by the project,
// filled from its approved requisitions (a material asked for twice is one line, quantities added up), the vendors'
// quotes and the comparative statement as in Wave 1, the choice; kept to the project's team, never put into an
// estimate; a tender's RFQs unchanged.
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

describe.skipIf(!controlUrl || !adminUrl)('project enquiries (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let lata: { id: string; headers: Record<string, string> };
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-penq-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'penq-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
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

  interface Rfq {
    id: string;
    number: string;
    projectId: string | null;
    project: { number: string } | null;
    tender: unknown;
    lines: {
      id: string;
      seq: number;
      code: string | null;
      description: string;
      qty: string | null;
      requisitions: { number: string; qty: string }[];
      selected: { partyId: string } | null;
    }[];
    vendors: { partyId: string; name: string }[];
    cs: { totals: { selected: string } };
  }
  let cement: string;
  let first: { id: string; number: string };
  let second: { id: string; number: string };
  let rfq: Rfq;

  it("starts an enquiry from a project's approved requisitions", async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    cement = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code: 'CEM',
          name: 'Cement OPC 53',
          kind: 'material',
          unit: 'bag',
          rate: '400',
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;
    // Two approved requisitions (no approval rules): 100 bags and wire; 60 more bags and sand typed in.
    const raise = async (title: string, lines: object[]) => {
      const r = await ok<{ id: string; number: string; rowVersion: number }>(
        post(`/tenant/projects/${projectId}/requisitions`, { title, lines }, worker),
      );
      await ok(post(`/tenant/requisitions/${r.id}/submit`, { rowVersion: r.rowVersion }, worker));
      return r;
    };
    first = await raise('Slab 1', [
      { resourceId: cement, qty: '100' },
      { description: 'Binding wire', unit: 'kg', qty: '25', rate: '90' },
    ]);
    second = await raise('Slab 2', [
      { resourceId: cement, qty: '60' },
      { description: 'River sand', unit: 'cum', qty: '12', rate: '1800' },
    ]);
    const draft = await ok<{ id: string }>(
      post(
        `/tenant/projects/${projectId}/requisitions`,
        { title: 'Not yet', lines: [{ resourceId: cement, qty: '5' }] },
        worker,
      ),
    );

    // Workers cannot send enquiries by default (rfq.edit); the manager, who leads the project, can.
    expect(
      (await post(`/tenant/projects/${projectId}/rfqs`, { title: 'Cement' }, worker)).statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/rfqs`,
          { title: 'Cement', requisitionIds: [draft.id] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'requisition_not_approved' });
    rfq = await ok<Rfq>(
      post(
        `/tenant/projects/${projectId}/rfqs`,
        {
          title: 'Cement and sand for slabs 1-2',
          dueOn: '2026-11-10',
          requisitionIds: [first.id, second.id],
        },
        manager,
      ),
    );
    expect(rfq).toMatchObject({
      number: expect.stringMatching(/^RFQ\//),
      projectId,
      tender: null,
      project: { number: expect.stringMatching(/^PRJ\//) },
    });
    // Cement once, 160 bags, for both; wire and sand as asked.
    expect(
      rfq.lines.map((l) => [
        l.code,
        l.description,
        l.qty,
        l.requisitions.map((q) => [q.number, q.qty]),
      ]),
    ).toEqual([
      [
        'CEM',
        'Cement OPC 53',
        '160.0000',
        [
          [first.number, '100.0000'],
          [second.number, '60.0000'],
        ],
      ],
      [null, 'Binding wire', '25.0000', [[first.number, '25.0000']]],
      [null, 'River sand', '12.0000', [[second.number, '12.0000']]],
    ]);
    // Asked again: nothing new.
    const again = await ok<{ added: number }>(
      post(`/tenant/rfqs/${rfq.id}/lines`, { requisitionIds: [first.id] }, manager),
    );
    expect(again.added).toBe(0);
    // The requisition shows the enquiry asking for it.
    expect(
      (
        await ok<{ enquiries: { number: string; lines: number }[] }>(
          get(`/tenant/requisitions/${first.id}`, worker),
        )
      ).enquiries,
    ).toEqual([expect.objectContaining({ number: rfq.number, lines: 2 })]);
    expect(
      await ok<{ number: string }[]>(get(`/tenant/projects/${projectId}/rfqs`, worker)),
    ).toEqual([expect.objectContaining({ number: rfq.number, lines: 3 })]);
  });

  it('takes quotes and a choice as in Wave 1, never into an estimate, and only for the team', async () => {
    rfq = await ok<Rfq>(
      post(`/tenant/rfqs/${rfq.id}/vendors`, { name: 'Vidarbha Cement Traders' }, manager),
    );
    rfq = await ok<Rfq>(
      post(`/tenant/rfqs/${rfq.id}/vendors`, { name: 'Washim Building Materials' }, manager),
    );
    const [a, b] = rfq.vendors;
    const quote = (partyId: string, rates: string[]) =>
      ok<Rfq>(
        post(
          `/tenant/rfqs/${rfq.id}/vendors/${partyId}/quote`,
          {
            receivedOn: '2026-11-08',
            gstMode: 'extra',
            gstPct: '18',
            lines: rfq.lines.map((l, i) => ({ lineId: l.id, rate: rates[i] })),
          },
          manager,
        ),
      );
    await quote(a!.partyId, ['390', '88', '1750']);
    rfq = await quote(b!.partyId, ['395', '85', '1700']);
    rfq = (await ok<{ rfq: Rfq }>(post(`/tenant/rfqs/${rfq.id}/select`, { lowest: true }, manager)))
      .rfq;
    // Lowest per line: cement 160 × 390 = 62,400; wire 25 × 85 = 2,125; sand 12 × 1,700 = 20,400: ₹84,925.
    expect(rfq.lines.map((l) => l.selected?.partyId)).toEqual([a!.partyId, b!.partyId, b!.partyId]);
    expect(rfq.cs.totals.selected).toBe('84925.00');
    expect((await post(`/tenant/rfqs/${rfq.id}/apply`, {}, manager)).json()).toMatchObject({
      code: 'not_for_project',
    });

    // Someone not on the team does not see it; a viewer reads but does not change it.
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'viewer' }, manager),
    );
    expect((await get(`/tenant/rfqs/${rfq.id}`, worker)).statusCode).toBe(200);
    await db`DELETE FROM proj.member WHERE project_id = ${projectId} AND user_id = ${workerId}`;
    expect((await get(`/tenant/rfqs/${rfq.id}`, worker)).statusCode).toBe(404);
    expect((await get(`/tenant/rfqs/${rfq.id}`, lata.headers)).statusCode).toBe(404);
    expect((await get(`/tenant/projects/${projectId}/rfqs`, worker)).statusCode).toBe(404);
    // The manager leads it.
    expect((await get(`/tenant/rfqs/${rfq.id}`, manager)).statusCode).toBe(200);
    // The project's activity says what happened.
    const ev = await db<
      { kind: string }[]
    >`SELECT kind FROM proj.project_event WHERE project_id = ${projectId}
      AND kind LIKE 'rfq%' ORDER BY id`;
    expect(ev.map((e) => e.kind)).toEqual(['rfq_created', 'rfq_quote', 'rfq_quote']);
  });
});
