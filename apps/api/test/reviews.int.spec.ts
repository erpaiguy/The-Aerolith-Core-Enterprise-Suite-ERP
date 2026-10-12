// Document reviews (docs/wave5-plan.md step 1) in a real tenant database: a three-stage workflow (a named design
// engineer; the project's lead; the client's two representatives, anyone of them), a drawing returned with C at the
// second stage, a revised version resubmitted and approved with comments; reminders, "waiting on me", and who may act.
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

describe.skipIf(!controlUrl || !adminUrl)('document reviews (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let people: Record<string, { id: string; headers: Record<string, string> }>;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-review-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'review-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
    people = {
      priya: await staff('priya', 'manager'),
      rao: await staff('rao', 'worker'),
      iyer: await staff('iyer', 'worker'),
    };
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  const upload = (
    projectId: string,
    name: string,
    body: Buffer,
    query: Record<string, string> = {},
  ) => {
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const qs = new URLSearchParams(query).toString();
    return app.inject({
      method: 'POST',
      url: `/api/tenant/projects/${projectId}/documents/upload${qs ? `?${qs}` : ''}`,
      payload,
      headers: { ...manager, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);

  it('reviews a drawing in three stages, returned once and then approved', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Akola' }, manager))
    ).id;
    for (const [who, role] of [
      ['priya', 'member'],
      ['rao', 'member'],
      ['iyer', 'member'],
    ] as const)
      await ok(
        post(`/tenant/projects/${projectId}/team`, { userId: people[who]!.id, role }, manager),
      );
    const up = (await upload(projectId, 'A-101 Ground floor plan.pdf', pdf('rev 0'))).json<{
      document: { id: string };
    }>();
    const documentId = up.document.id;

    // The workflow: design (Priya, 3 days), the project's lead (2 days), the client (Rao or Iyer, 5 days).
    expect(
      (
        await post(
          '/tenant/review-workflows',
          { name: 'Nope', stages: [{ name: 'x', reviewers: [{ kind: 'lead' }] }] },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    const wf = await ok<{ id: string }>(
      post(
        '/tenant/review-workflows',
        {
          name: 'Drawing review',
          stages: [
            {
              name: 'Design',
              mode: 'all',
              dueDays: 3,
              reviewers: [{ kind: 'user', id: people.priya!.id }],
            },
            { name: 'Project manager', mode: 'all', dueDays: 2, reviewers: [{ kind: 'lead' }] },
            {
              name: 'Client',
              mode: 'any',
              dueDays: 5,
              reviewers: [
                { kind: 'user', id: people.rao!.id },
                { kind: 'user', id: people.iyer!.id },
              ],
            },
          ],
        },
        manager,
      ),
    );
    type Review = {
      id: string;
      number: string;
      status: string;
      stage: number;
      withComments: boolean;
      tasks: { id: string; stage: number; reviewer: string; status: string; code: string | null }[];
    };
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/reviews`,
          { documentId, workflowId: wf.id, title: 'Ground floor plan' },
          worker,
        )
      ).statusCode,
    ).toBe(404);
    let r = await ok<Review>(
      post(
        `/tenant/projects/${projectId}/reviews`,
        { documentId, workflowId: wf.id, title: 'Ground floor plan' },
        manager,
      ),
    );
    expect([r.number, r.status, r.stage]).toEqual(['RV-001', 'in_review', 0]);
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/reviews`,
          { documentId, workflowId: wf.id, title: 'Again' },
          manager,
        )
      ).json(),
    ).toMatchObject({
      code: 'in_review',
    });
    // Priya is notified now and reminded the day before and on the day; her inbox counts the review.
    const notes = await db<{ kind: string }[]>`
      SELECT kind FROM platform.notification WHERE user_id = ${people.priya!.id} AND source LIKE 'review-task:%' ORDER BY due_at NULLS FIRST`;
    expect(notes.map((n) => n.kind)).toEqual(['review', 'review_due', 'review_due']);
    expect(
      (await ok<{ pending: { reviews: number } }>(get('/tenant/inbox', people.priya!.headers)))
        .pending.reviews,
    ).toBe(1);
    const task = (rv: Review, stage: number, who: string) =>
      rv.tasks.find((x) => x.stage === stage && x.reviewer === who)!.id;
    // Only the named reviewer answers.
    expect(
      (
        await post(
          `/tenant/review-tasks/${task(r, 0, 'priya')}/respond`,
          { code: 'A' },
          people.rao!.headers,
        )
      ).json(),
    ).toMatchObject({
      code: 'not_yours',
    });
    r = await ok<Review>(
      post(
        `/tenant/review-tasks/${task(r, 0, 'priya')}/respond`,
        { code: 'A' },
        people.priya!.headers,
      ),
    );
    expect([
      r.stage,
      (await ok<{ pending: { reviews: number } }>(get('/tenant/inbox', people.priya!.headers)))
        .pending.reviews,
    ]).toEqual([1, 0]);
    expect(
      (
        await post(
          `/tenant/review-tasks/${task(r, 0, 'priya')}/respond`,
          { code: 'B', comment: 'x' },
          people.priya!.headers,
        )
      ).json(),
    ).toMatchObject({
      code: 'answered',
    });
    // The lead returns it: C needs a reason.
    expect(
      (
        await post(`/tenant/review-tasks/${task(r, 1, 'suresh')}/respond`, { code: 'C' }, manager)
      ).json(),
    ).toMatchObject({
      code: 'comment_needed',
    });
    r = await ok<Review>(
      post(
        `/tenant/review-tasks/${task(r, 1, 'suresh')}/respond`,
        { code: 'C', comment: 'Stair width under 1.5 m; revise' },
        manager,
      ),
    );
    expect(r.status).toBe('returned');
    expect((await post(`/tenant/reviews/${r.id}/resubmit`, {}, manager)).json()).toMatchObject({
      code: 'same_version',
    });

    // Revision 1 uploaded and resubmitted: a new review of it.
    await upload(projectId, 'A-101 Ground floor plan.pdf', pdf('rev 1'), { documentId });
    let r2 = await ok<Review & { document: { versionNo: number } }>(
      post(`/tenant/reviews/${r.id}/resubmit`, {}, manager),
    );
    expect([r2.number, r2.document.versionNo, r2.status]).toEqual(['RV-002', 2, 'in_review']);
    r2 = await ok(
      post(
        `/tenant/review-tasks/${task(r2, 0, 'priya')}/respond`,
        { code: 'B', comment: 'Note the fire exit sign' },
        people.priya!.headers,
      ),
    );
    r2 = await ok(
      post(`/tenant/review-tasks/${task(r2, 1, 'suresh')}/respond`, { code: 'A' }, manager),
    );
    // The client: either representative will do; Iyer answers first, Rao's task closes.
    r2 = await ok(
      post(
        `/tenant/review-tasks/${task(r2, 2, 'iyer')}/respond`,
        { code: 'A' },
        people.iyer!.headers,
      ),
    );
    expect([r2.status, r2.withComments]).toEqual(['approved', true]);
    expect(
      r2.tasks.filter((x) => x.stage === 2).map((x) => [x.reviewer, x.status, x.code]),
    ).toEqual([
      ['iyer', 'done', 'A'],
      ['rao', 'skipped', null],
    ]);
    const list = await ok<{ number: string; status: string }[]>(
      get(`/tenant/projects/${projectId}/reviews`, manager),
    );
    expect(list.map((x) => [x.number, x.status])).toEqual([
      ['RV-002', 'approved'],
      ['RV-001', 'returned'],
    ]);
    expect(await ok(get('/tenant/reviews/mine', people.rao!.headers))).toEqual([]);
  });
});
