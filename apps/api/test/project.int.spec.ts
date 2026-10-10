// Projects in a real tenant database (docs/wave2a-plan.md step 1): the register and numbering, a project made from a
// won tender (once, and only when won), status moves with reasons, sites, the team and its lead, and who sees and
// changes what: a worker sees only projects they are on; a manager edits; a lead edits their own project.
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
import { financialYear } from '../src/tender/tender-rules.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

interface Project {
  id: string;
  number: string;
  name: string;
  status: string;
  contractValue: string | null;
  rowVersion: number;
  client: { id: string; name: string } | null;
  lead: { id: string; displayName: string } | null;
  tender: { id: string; number: string } | null;
  sites: {
    id: string;
    name: string;
    stateCode: string | null;
    active: boolean;
    rowVersion: number;
  }[];
  team: { userId: string; displayName: string; role: string }[];
  events: { kind: string }[];
  myRole: string | null;
  canEdit: boolean;
  allowedMoves: string[];
}

describe.skipIf(!controlUrl || !adminUrl)('projects (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let managerId: string;
  let workerId: string;
  let tenderId: string;
  let project: Project;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-project-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'project-admin@example.in');
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, managerId, worker, workerId] = [m.headers, m.id, w.headers, w.id];
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

  it('makes a project only from a won tender, once, at our bid value, numbered in the series', async () => {
    expect((await post(`/tenant/tenders/${tenderId}/project`, {})).json()).toMatchObject({
      code: 'tender_not_won',
    });
    // Won, with our bid read out at the opening.
    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${tenderId}`;
    await db`INSERT INTO tender.competitor_bid (tender_id, party_id, quoted_value, qualified)
      VALUES (${tenderId}, NULL, 23150000, true)`;
    expect((await post(`/tenant/tenders/${tenderId}/project`, {}, worker)).statusCode).toBe(403);
    project = await ok<Project>(
      post(`/tenant/tenders/${tenderId}/project`, { startOn: '2026-11-01' }, manager),
    );
    expect(project).toMatchObject({
      number: `PRJ/${financialYear(new Date())}/0001`,
      name: 'Primary school, Malegaon',
      status: 'planned',
      contractValue: '23150000.00',
      client: { name: 'Zilla Parishad Washim' },
      lead: { id: managerId },
      tender: { id: tenderId },
      myRole: 'lead',
      canEdit: true,
    });
    // The tender's estimator (the admin who made it) joins the team as a member.
    expect(project.team.map((m) => m.role).sort()).toEqual(['lead', 'member']);
    expect((await post(`/tenant/tenders/${tenderId}/project`, {}, manager)).json()).toMatchObject({
      code: 'project_exists',
      projectId: project.id,
    });
    const events = await db<{ kind: string }[]>`
      SELECT kind FROM tender.tender_event WHERE tender_id = ${tenderId} ORDER BY id DESC LIMIT 1`;
    expect(events[0]!.kind).toBe('project_created');
    expect(await ok(get(`/tenant/tenders/${tenderId}/project`))).toMatchObject({
      project: { id: project.id, number: project.number },
    });
  });

  it('shows a worker only the projects they are on, and lets only leads and editors change them', async () => {
    const other = await ok<Project>(post('/tenant/projects', { name: 'Godown, Karanja' }, manager));
    // Not on either team: the worker sees neither, not even by its address.
    expect((await ok<{ items: unknown[] }>(get('/tenant/projects', worker))).items).toHaveLength(0);
    expect((await get(`/tenant/projects/${project.id}`, worker)).statusCode).toBe(404);
    expect(await ok(get(`/tenant/tenders/${tenderId}/project`, worker))).toMatchObject({
      project: { id: null, number: project.number },
    });
    // On the team as a member: sees it, cannot change it.
    project = await ok<Project>(
      post(`/tenant/projects/${project.id}/team`, { userId: workerId, role: 'member' }, manager),
    );
    const seen = await ok<{ items: { id: string }[] }>(get('/tenant/projects', worker));
    expect(seen.items.map((p) => p.id)).toEqual([project.id]);
    const mine = await ok<Project>(get(`/tenant/projects/${project.id}`, worker));
    expect(mine).toMatchObject({ myRole: 'member', canEdit: false });
    expect(
      (
        await post(
          `/tenant/projects/${project.id}`,
          { rowVersion: project.rowVersion, location: 'x' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    // Made lead: changes their own project, though workers may not edit projects in general.
    project = await ok<Project>(
      post(`/tenant/projects/${project.id}/team`, { userId: workerId, role: 'lead' }, manager),
    );
    project = await ok<Project>(
      post(
        `/tenant/projects/${project.id}`,
        {
          rowVersion: project.rowVersion,
          clientRef: 'WO/ZPW/2026/118',
          plannedFinishOn: '2027-10-31',
        },
        worker,
      ),
    );
    expect(project).toMatchObject({ rowVersion: 2 });
    expect(
      (await post(`/tenant/projects/${other.id}/sites`, { name: 'Yard' }, worker)).statusCode,
    ).toBe(404);
    // The admin and managers (who see every project) see both.
    const all = await ok<{ items: unknown[]; counts: Record<string, number> }>(
      get('/tenant/projects'),
    );
    expect(all.items).toHaveLength(2);
    expect(all.counts).toEqual({ planned: 2 });
    // A finish before the start is refused; a stale write is refused.
    expect(
      (
        await post(`/tenant/projects/${project.id}`, {
          rowVersion: project.rowVersion,
          plannedFinishOn: '2026-01-01',
        })
      ).json(),
    ).toMatchObject({ code: 'bad_dates' });
    expect(
      (await post(`/tenant/projects/${project.id}`, { rowVersion: 1, location: 'y' })).json(),
    ).toMatchObject({ code: 'stale_row' });
  });

  it('keeps a lead on every project', async () => {
    const leads = () =>
      project.team
        .filter((m) => m.role === 'lead')
        .map((m) => m.userId)
        .sort();
    expect(leads()).toEqual([managerId, workerId].sort());
    project = await ok<Project>(
      post(`/tenant/projects/${project.id}/team`, { userId: managerId, role: null }),
    );
    expect(leads()).toEqual([workerId]);
    expect(
      (
        await post(`/tenant/projects/${project.id}/team`, { userId: workerId, role: 'viewer' })
      ).json(),
    ).toMatchObject({ code: 'last_lead' });
  });

  it('moves a project through its statuses, asking why it stops', async () => {
    const move = (status: string, reason: string | null = null) =>
      post(`/tenant/projects/${project.id}/status`, {
        rowVersion: project.rowVersion,
        status,
        reason,
      });
    expect((await move('completed')).json()).toMatchObject({ code: 'bad_move' });
    project = await ok<Project>(move('active'));
    expect((await move('on_hold')).json()).toMatchObject({ code: 'reason_required' });
    project = await ok<Project>(move('on_hold', 'Site handed over late by the client'));
    expect(project.allowedMoves).toEqual(['active', 'cancelled']);
    project = await ok<Project>(move('active'));
    // It cannot finish today if it starts next month.
    expect((await move('completed')).json()).toMatchObject({ code: 'bad_dates' });
    project = await ok<Project>(
      post(`/tenant/projects/${project.id}`, {
        rowVersion: project.rowVersion,
        startOn: '2026-04-01',
      }),
    );
    project = await ok<Project>(move('completed'));
    const [row] = await db<{ actual_finish_on: string | null }[]>`
      SELECT actual_finish_on::text FROM proj.project WHERE id = ${project.id}`;
    expect(row!.actual_finish_on).not.toBeNull();
    expect(project.events.map((e) => e.kind).slice(0, 5)).toEqual([
      'status',
      'updated',
      'status',
      'status',
      'status',
    ]);
  });

  it('keeps sites with their GST state, unique by name within the project', async () => {
    project = await ok<Project>(
      post(`/tenant/projects/${project.id}/sites`, {
        name: 'Main school block',
        address: 'Survey no. 42, Malegaon',
        stateCode: '27',
      }),
    );
    expect(
      (await post(`/tenant/projects/${project.id}/sites`, { name: 'MAIN SCHOOL BLOCK' })).json(),
    ).toMatchObject({ code: 'site_exists' });
    expect(
      (await post(`/tenant/projects/${project.id}/sites`, { name: 'Hostel', stateCode: 'MH' }))
        .statusCode,
    ).toBe(400);
    const site = project.sites[0]!;
    project = await ok<Project>(
      post(`/tenant/sites/${site.id}`, { rowVersion: site.rowVersion, active: false }),
    );
    expect(project.sites[0]).toMatchObject({
      name: 'Main school block',
      stateCode: '27',
      active: false,
    });
    // The activity log is append-only.
    await expect(db`DELETE FROM proj.project_event`).rejects.toThrow(/permission denied/);
  });
});
