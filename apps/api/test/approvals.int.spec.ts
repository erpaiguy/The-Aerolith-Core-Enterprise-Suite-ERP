// The approval engine and purchase requisitions in a real tenant database (docs/wave2b-plan.md step 1): no rules (approved
// at once), levels by amount (the project's lead, a manager, a named person), nobody approving their own request nor
// two levels of the same one, a level going to the admins, rejection and resubmission, withdrawal, standing in while
// away, comments, "waiting on me", and who sees what.
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

describe.skipIf(!controlUrl || !adminUrl)('approvals and requisitions (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let lata: { id: string; headers: Record<string, string> };
  let mohan: { id: string; headers: Record<string, string> };
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-approvals-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'approvals-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    lata = await staff('lata', 'worker');
    mohan = await staff('mohan', 'worker');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  interface Approval {
    id: string;
    status: string;
    level: number | null;
    steps: {
      level: number;
      approver: string;
      approverName: string;
      status: string;
      actedBy: string | null;
      onBehalfOf: string | null;
      toAdmins: boolean;
    }[];
    events: {
      kind: string;
      actor: string | null;
      onBehalfOf: string | null;
      comment: string | null;
    }[];
    mayAct: boolean;
    actingFor: string | null;
    mayWithdraw: boolean;
  }
  interface Requisition {
    id: string;
    number: string;
    status: string;
    statusReason: string | null;
    amount: string;
    rowVersion: number;
    lines: {
      description: string;
      unit: string;
      qty: string;
      rate: string | null;
      amount: string | null;
      boqCode: string | null;
      wbsCode: string | null;
      resourceCode: string | null;
    }[];
    approval: Approval | null;
    mayEdit: boolean;
    maySubmit: boolean;
  }
  let cement: string;
  const cementLine = (qty: string) => ({ resourceId: cement, qty, boqCode: 'A.1', wbsCode: '1' });
  const raise = (title: string, lines: object[], as = worker) =>
    ok<Requisition>(post(`/tenant/projects/${projectId}/requisitions`, { title, lines }, as));
  const submit = (r: Requisition, as = worker) =>
    ok<Requisition>(post(`/tenant/requisitions/${r.id}/submit`, { rowVersion: r.rowVersion }, as));
  const approval = (id: string, as: Record<string, string>) =>
    ok<Approval>(get(`/tenant/approvals/${id}`, as));
  const waiting = (as: Record<string, string>) =>
    ok<{ id: string; title: string }[]>(get('/tenant/approvals?view=waiting', as));

  it('raises a requisition and, with no rules, approves it on submission', async () => {
    // A project led by the manager, with the site engineer on its team, a contract BOQ item and a WBS element.
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: mohan.id, role: 'viewer' }, manager),
    );
    const boq = await ok<{ id: string }>(
      post(`/tenant/projects/${projectId}/boqs`, { name: 'Civil', kind: 'contract' }, manager),
    );
    await ok(
      post(
        `/tenant/boqs/${boq.id}/changes`,
        {
          ops: [
            {
              op: 'insert',
              tempId: 'tA',
              parentId: null,
              afterId: null,
              type: 'section',
              code: 'A',
              description: 'Concrete',
            },
            {
              op: 'insert',
              tempId: 'ta1',
              parentId: 'tA',
              afterId: null,
              type: 'item',
              code: 'A.1',
              description: 'RCC M25 in slabs',
              unit: 'cum',
              qty: '100',
              rate: '7000',
            },
          ],
        },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/wbs`,
        { code: '1', name: 'Block A', parentId: null },
        manager,
      ),
    );
    cement = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code: 'CEM-OPC53',
          name: 'Cement OPC 53, 50 kg bag',
          kind: 'material',
          unit: 'bag',
          rate: '400',
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;

    // 100 bags at the library's ₹400 and 25 kg of binding wire typed in at ₹90: ₹42,250.
    const r = await raise('Cement and wire for the first slab', [
      cementLine('100'),
      { description: 'Binding wire', unit: 'kg', qty: '25', rate: '90' },
    ]);
    expect(r).toMatchObject({
      number: expect.stringMatching(/^PR\/\d{4}-\d{2}\/0001$/),
      status: 'draft',
      amount: '42250.00',
      mayEdit: true,
      maySubmit: true,
      approval: null,
    });
    expect(r.lines[0]).toMatchObject({
      description: 'Cement OPC 53, 50 kg bag',
      unit: 'bag',
      rate: '400.0000',
      amount: '40000.00',
      boqCode: 'A.1',
      wbsCode: '1',
      resourceCode: 'CEM-OPC53',
    });
    // Viewers read but do not raise; others do not see the project.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/requisitions`,
          { title: 'Sand', lines: [] },
          mohan.headers,
        )
      ).statusCode,
    ).toBe(403);
    expect((await get(`/tenant/requisitions/${r.id}`, lata.headers)).statusCode).toBe(404);
    expect(
      (
        await post(`/tenant/projects/${projectId}/requisitions`, {
          title: 'Wrong item',
          lines: [{ ...cementLine('1'), boqCode: 'Z.9' }],
        })
      ).json(),
    ).toMatchObject({ code: 'boq_item_not_found' });

    const done = await submit(r);
    expect(done).toMatchObject({
      status: 'approved',
      mayEdit: false,
      approval: { status: 'approved', steps: [] },
    });
    expect(done.approval!.events.map((e) => e.kind)).toEqual(['submitted', 'no_approval_needed']);
  });

  it('takes a requisition through the levels its amount needs, each by someone else', async () => {
    // Up to ₹50,000 the project's lead; from ₹50,000 a manager too; from ₹2 lakh also Lata by name.
    expect(
      (
        await post('/tenant/approval-rules/purchase_requisition', {
          rules: [
            { minAmount: '50000', approver: 'manager' },
            { minAmount: '0', approver: 'project_lead' },
          ],
        })
      ).json(),
    ).toMatchObject({ code: 'amounts_out_of_order' });
    expect(
      (
        await post(
          '/tenant/approval-rules/purchase_requisition',
          { rules: [{ minAmount: '0', approver: 'project_lead' }] },
          manager,
        )
      ).statusCode,
    ).toBe(403);
    await ok(
      post('/tenant/approval-rules/purchase_requisition', {
        rules: [
          { minAmount: '0', approver: 'project_lead', label: 'Project manager' },
          { minAmount: '50000', approver: 'manager', label: 'Purchase' },
          { minAmount: '200000', approver: 'user', userId: lata.id, label: 'Director' },
        ],
      }),
    );

    // ₹60,000 (150 bags): the lead, then a manager who is not the lead (so the admin).
    const r = await submit(await raise('Cement for the second slab', [cementLine('150')]));
    expect(r).toMatchObject({
      status: 'submitted',
      mayEdit: false,
      approval: { status: 'pending', level: 1, mayWithdraw: true },
    });
    expect(r.approval!.steps.map((s) => [s.level, s.approverName])).toEqual([
      [1, "The project's lead"],
      [2, 'Any manager (or admin)'],
    ]);
    const id = r.approval!.id;
    expect((await waiting(manager)).map((w) => w.id)).toEqual([id]);
    expect(await waiting(t.admin)).toEqual([]);
    expect(
      (await ok<{ pending: { approvals: number } }>(get('/tenant/inbox', manager))).pending
        .approvals,
    ).toBe(1);
    // The site engineer submitted it, so cannot approve it.
    expect((await post(`/tenant/approvals/${id}/approve`, {}, worker)).json()).toMatchObject({
      code: 'not_your_approval',
    });

    await ok(post(`/tenant/approvals/${id}/approve`, { comment: 'Slab 2 is due' }, manager));
    // The manager approved level 1, so level 2 waits on the other manager-or-admin: the admin.
    expect(await waiting(manager)).toEqual([]);
    expect((await waiting(t.admin)).map((w) => w.id)).toEqual([id]);
    expect((await post(`/tenant/approvals/${id}/approve`, {}, manager)).statusCode).toBe(403);
    // Rejected with a reason: the requisition goes back to the team, who change it and submit again.
    expect((await post(`/tenant/approvals/${id}/reject`, { comment: '' })).statusCode).toBe(400);
    await ok(
      post(`/tenant/approvals/${id}/reject`, { comment: 'Order 120 bags; 30 are in the store' }),
    );
    let back = await ok<Requisition>(get(`/tenant/requisitions/${r.id}`, worker));
    expect(back).toMatchObject({
      status: 'rejected',
      statusReason: 'Order 120 bags; 30 are in the store',
      mayEdit: true,
      approval: { status: 'rejected' },
    });
    const told = await ok<{ items: { kind: string; title: string }[] }>(
      get('/tenant/inbox', worker),
    );
    expect(told.items[0]).toMatchObject({
      kind: 'approval_decided',
      title: expect.stringMatching(/^Rejected/),
    });

    back = await ok<Requisition>(
      post(
        `/tenant/requisitions/${r.id}`,
        {
          rowVersion: back.rowVersion,
          title: 'Cement for the second slab',
          lines: [cementLine('120')],
        },
        worker,
      ),
    );
    expect(back).toMatchObject({ status: 'draft', amount: '48000.00' });
    // ₹48,000 now needs only the lead.
    back = await submit(back);
    expect(back.approval!.steps).toHaveLength(1);
    await ok(post(`/tenant/approvals/${back.approval!.id}/approve`, {}, manager));
    expect(await ok<Requisition>(get(`/tenant/requisitions/${r.id}`, worker))).toMatchObject({
      status: 'approved',
    });
  });

  it('sends a level only its submitter could approve to the admins, and lets the submitter withdraw', async () => {
    // The lead raises one: level 1 (the lead) would be themselves, so it goes to the admins.
    const r = await submit(
      await raise(
        'Shuttering plywood',
        [{ description: 'Shuttering plywood 12 mm', unit: 'sheet', qty: '20', rate: '1500' }],
        manager,
      ),
      manager,
    );
    expect(r.approval!.steps[0]).toMatchObject({ toAdmins: true, approverName: 'Any admin' });
    expect(r.approval!.events.map((e) => e.kind)).toEqual(['submitted', 'to_admins']);
    expect((await waiting(t.admin)).map((w) => w.id)).toEqual([r.approval!.id]);
    expect(await waiting(manager)).toEqual([]);

    // Withdrawn by whoever submitted it: back to draft, and no longer waiting on anyone.
    expect(
      (await post(`/tenant/approvals/${r.approval!.id}/withdraw`, {}, t.admin)).statusCode,
    ).toBe(403);
    expect(
      (await post(`/tenant/requisitions/${r.id}/cancel`, { reason: 'not needed' }, manager)).json(),
    ).toMatchObject({ code: 'withdraw_first' });
    await ok(post(`/tenant/approvals/${r.approval!.id}/withdraw`, {}, manager));
    expect(await ok<Requisition>(get(`/tenant/requisitions/${r.id}`, manager))).toMatchObject({
      status: 'draft',
    });
    expect(await waiting(t.admin)).toEqual([]);
    const cancelled = await ok<Requisition>(
      post(`/tenant/requisitions/${r.id}/cancel`, { reason: 'Hired instead' }, manager),
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', mayEdit: false, maySubmit: false });
  });

  it('lets someone stand in for an approver while away, and keeps the record', async () => {
    // ₹3,20,000: the lead, a manager (the admin), then Lata by name, who is away; Mohan stands in for her.
    const r = await submit(await raise('Cement for the raft', [cementLine('800')]));
    const id = r.approval!.id;
    expect(r.approval!.steps).toHaveLength(3);
    await ok(post(`/tenant/approvals/${id}/approve`, {}, manager));
    await ok(post(`/tenant/approvals/${id}/approve`, {}, t.admin));
    expect((await waiting(lata.headers)).map((w) => w.id)).toEqual([id]);
    // Lata is not on the project, but sees what she is asked to approve.
    const seen = await ok<Approval & { document: { lines: unknown[] } }>(
      get(`/tenant/approvals/${id}`, lata.headers),
    );
    expect(seen).toMatchObject({
      mayAct: true,
      actingFor: null,
      document: { lines: [expect.anything()] },
    });

    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    expect(
      (
        await post(
          '/tenant/approval-delegations',
          { fromUserId: lata.id, toUserId: mohan.id, startsOn: today, endsOn: '2099-12-31' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    // Not to the submitter: nobody approves their own request, even standing in.
    await ok(
      post(
        '/tenant/approval-delegations',
        { toUserId: workerId, startsOn: today, endsOn: '2099-12-31', reason: 'Leave' },
        lata.headers,
      ),
    );
    expect(await waiting(worker)).toEqual([]);
    const ds = await ok<{ id: string; toName: string; active: boolean }[]>(
      post(
        '/tenant/approval-delegations',
        { toUserId: mohan.id, startsOn: today, endsOn: '2099-12-31', reason: 'Leave' },
        lata.headers,
      ),
    );
    expect(ds.filter((d) => d.active)).toHaveLength(2);
    expect((await waiting(mohan.headers)).map((w) => w.id)).toEqual([id]);
    expect(await approval(id, mohan.headers)).toMatchObject({ mayAct: true, actingFor: 'lata' });

    await ok(
      post(
        `/tenant/approvals/${id}/comments`,
        { comment: 'Checked with the store: none in stock' },
        mohan.headers,
      ),
    );
    const done = await ok<Approval>(post(`/tenant/approvals/${id}/approve`, {}, mohan.headers));
    expect(done.status).toBe('approved');
    expect(done.steps[2]).toMatchObject({
      status: 'approved',
      actedBy: 'mohan',
      onBehalfOf: 'lata',
    });
    expect(done.events.map((e) => e.kind)).toEqual([
      'submitted',
      'approved',
      'approved',
      'commented',
      'approved',
    ]);
    // Lata's return: cancelling her stand-ins.
    for (const d of ds)
      await ok(post(`/tenant/approval-delegations/${d.id}/cancel`, {}, lata.headers));
    expect(await ok<unknown[]>(get('/tenant/approval-delegations', lata.headers))).toEqual([]);

    // The register: the project's requisitions, and only the team's.
    const all = await ok<{ number: string; status: string }[]>(
      get(`/tenant/requisitions?projectId=${projectId}`, worker),
    );
    expect(all.map((x) => x.status)).toEqual(['approved', 'cancelled', 'approved', 'approved']);
    expect(await ok<unknown[]>(get('/tenant/requisitions', lata.headers))).toEqual([]);
    // Requests the site engineer submitted, and those Mohan decided.
    expect((await ok<unknown[]>(get('/tenant/approvals?view=mine', worker))).length).toBe(4);
    expect((await ok<unknown[]>(get('/tenant/approvals?view=decided', mohan.headers))).length).toBe(
      1,
    );
    // The decision trail cannot be changed.
    await expect(db`UPDATE platform.approval_event SET comment = 'x'`).rejects.toThrow(
      /permission denied/,
    );
  });
});
