// Transmittals, RFIs and submittals (docs/wave5-plan.md step 3) in a real tenant database: drawings issued for review
// and answered through the expiring link with no account (acknowledged, a code and a file kept in the vault), the
// link refused once expired or withdrawn; an RFI answered and tied to a revised drawing; a material submittal approved
// through its review with the material approval following.
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

describe.skipIf(!controlUrl || !adminUrl)('transmittals, RFIs and submittals (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-transmittal-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'transmittal-admin@example.in');
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

  const pub = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url: `/api/share/${t.tenantId}/${url}`, ...(payload ? { payload } : {}) });
  const form = (fields: Record<string, string>, file?: { name: string; body: Buffer }) => {
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const parts: Buffer[] = Object.entries(fields).map(([k, v]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
    if (file)
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n',
        ),
        file.body,
        Buffer.from('\r\n'),
      );
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return {
      payload: Buffer.concat(parts),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  };

  async function project(name: string) {
    const projectId = (await ok<{ id: string }>(post('/tenant/projects', { name }, manager))).id;
    for (const who of ['priya', 'rao'] as const)
      await ok(
        post(
          `/tenant/projects/${projectId}/team`,
          { userId: people[who]!.id, role: 'member' },
          manager,
        ),
      );
    return projectId;
  }
  const docId = async (
    projectId: string,
    name: string,
    text: string,
    query: Record<string, string> = {},
  ) =>
    (await upload(projectId, name, pdf(text), query)).json<{
      document: { id: string; versionNo: number };
    }>().document;

  it('issues drawings for review and takes the answer through the expiring link', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const projectId = await project('Bank branch, Latur');
    const a101 = await docId(projectId, 'A-101 Plan.pdf', 'plan');
    const a201 = await docId(projectId, 'A-201 Elevation.pdf', 'elevation');
    type T = {
      id: string;
      number: string;
      status: string;
      dueOn: string | null;
      items: { id: string; name: string; versionNo: number }[];
      links: { live: boolean }[];
      events: { kind: string; detail: string }[];
      responseCode: string | null;
      responseDocument: string | null;
      respondedBy: string | null;
    };
    const body = {
      subject: 'Architectural drawings for approval',
      recipient: 'Kale Architects',
      email: 'office@kale-architects.in',
      purpose: 'review',
      responseDays: 7,
      items: [
        { documentId: a101.id, copies: 2 },
        { documentId: a201.id, remark: 'Front only' },
      ],
    };
    // Someone off the project cannot; review without days cannot.
    expect(
      (await post(`/tenant/projects/${projectId}/transmittals`, body, worker)).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/transmittals`,
          { ...body, responseDays: null },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'response_days' });
    let tr = await ok<T>(post(`/tenant/projects/${projectId}/transmittals`, body, manager));
    expect([tr.number, tr.status, tr.items.map((i) => i.name)]).toEqual([
      'TR-001',
      'draft',
      ['A-101 Plan.pdf', 'A-201 Elevation.pdf'],
    ]);
    // A draft has no link.
    expect((await post(`/tenant/transmittals/${tr.id}/link`, {}, manager)).json()).toMatchObject({
      code: 'not_issued',
    });
    tr = await ok<T>(post(`/tenant/transmittals/${tr.id}/issue`, {}, manager));
    expect(tr.status).toBe('issued');
    expect(tr.dueOn).not.toBeNull();
    expect(
      (await post(`/tenant/projects/${projectId}/transmittals/${tr.id}`, body, manager)).json(),
    ).toMatchObject({ code: 'issued' });

    const first = await ok<{ token: string; path: string }>(
      post(`/tenant/transmittals/${tr.id}/link`, { days: 14 }, manager),
    );
    expect(first.path).toBe(`/share/${t.tenantId}/${first.token}`);
    // Only the hash is kept.
    const [kept] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM dms.share_link WHERE encode(token_hash, 'escape') LIKE ${`%${first.token}%`}`;
    expect(kept!.n).toBe(0);
    // A new link withdraws the first.
    const { token } = await ok<{ token: string }>(
      post(`/tenant/transmittals/${tr.id}/link`, {}, manager),
    );
    expect((await pub('GET', first.token)).statusCode).toBe(410);
    expect((await pub('GET', 'x'.repeat(43))).statusCode).toBe(404);
    expect((await pub('GET', 'short')).statusCode).toBe(400);

    // The outsider, no headers at all: sees it, downloads an item, acknowledges, answers B with a file.
    const view = (await pub('GET', token)).json<{
      number: string;
      items: { id: string; name: string }[];
      codes: { code: string }[];
    }>();
    expect([view.number, view.items.length, view.codes.map((c) => c.code)]).toEqual([
      'TR-001',
      2,
      ['A', 'B', 'C', 'D'],
    ]);
    const dl = await pub('GET', `${token}/items/${view.items[0]!.id}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain('plan');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    expect(
      (await pub('POST', `${token}/acknowledge`, { name: 'Anita Kale' })).json(),
    ).toMatchObject({
      status: 'acknowledged',
    });
    const f = form(
      { name: 'Anita Kale', response: 'Approved; show the ramp on A-101', code: 'B' },
      { name: 'Kale comments.pdf', body: pdf('comments') },
    );
    const answered = await app.inject({
      method: 'POST',
      url: `/api/share/${t.tenantId}/${token}/respond`,
      payload: f.payload,
      headers: f.headers,
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toMatchObject({
      status: 'responded',
      responseCode: 'B',
      respondedBy: 'Anita Kale',
    });
    // Only once.
    const again = form({ name: 'Anita Kale', response: 'again' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/share/${t.tenantId}/${token}/respond`,
          payload: again.payload,
          headers: again.headers,
        })
      ).json(),
    ).toMatchObject({ code: 'responded' });

    tr = await ok<T>(get(`/tenant/transmittals/${tr.id}`, manager));
    expect([tr.responseCode, tr.responseDocument]).toEqual(['B', 'Kale comments.pdf']);
    expect(tr.events.map((e) => e.kind)).toEqual([
      'open',
      'download',
      'acknowledge',
      'open',
      'respond',
      'open',
    ]);
    const [kept2] = await db<{ path: string }[]>`
      SELECT f.name AS path FROM doc.document d JOIN doc.folder f ON f.id = d.folder_id WHERE d.name = 'Kale comments.pdf'`;
    expect(kept2!.path).toBe('TR-001 response');
    const [note] = await db<{ title: string }[]>`
      SELECT title FROM platform.notification WHERE kind = 'transmittal' ORDER BY created_at DESC LIMIT 1`;
    expect(note!.title).toBe(
      'TR-001 Architectural drawings for approval: Anita Kale responded (B)',
    );

    // Expired, and closed, links stop working.
    await db`UPDATE dms.share_link SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL`;
    expect((await pub('GET', token)).statusCode).toBe(410);
    const { token: third } = await ok<{ token: string }>(
      post(`/tenant/transmittals/${tr.id}/link`, {}, manager),
    );
    expect((await pub('GET', third)).statusCode).toBe(200);
    await ok(post(`/tenant/transmittals/${tr.id}/close`, {}, manager));
    expect((await pub('GET', third)).statusCode).toBe(410);
    const list = await ok<{ number: string; status: string; overdue: boolean }[]>(
      get(`/tenant/projects/${projectId}/transmittals`, manager),
    );
    expect(list).toEqual([
      expect.objectContaining({ number: 'TR-001', status: 'closed', overdue: false }),
    ]);
  });

  it('answers an RFI with a revised drawing, and approves a material submittal through its review', async () => {
    const projectId = await project('Warehouse, Jalgaon');
    const s101 = await docId(projectId, 'S-101 Columns.pdf', 'columns');
    type Rfi = {
      id: string;
      number: string;
      status: string;
      outcome: string;
      revisedVersionNo: number | null;
      overdue: boolean;
    };
    // Assigned only to someone on the project.
    const bad = {
      subject: 'Column C4 size',
      question: 'C4 is 300 on plan, 350 in schedule?',
      assignedTo: people.iyer!.id,
    };
    expect((await post(`/tenant/projects/${projectId}/rfis`, bad, manager)).json()).toMatchObject({
      code: 'not_on_project',
    });
    let rfi = await ok<Rfi>(
      post(
        `/tenant/projects/${projectId}/rfis`,
        {
          ...bad,
          assignedTo: people.priya!.id,
          documentId: s101.id,
          location: 'Grid C/4',
          dueDays: 3,
        },
        manager,
      ),
    );
    expect([rfi.number, rfi.status]).toEqual(['RFI-001', 'open']);
    expect(
      (await post(`/tenant/rfis/${rfi.id}/answer`, { answer: 'x' }, people.rao!.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(`/tenant/rfis/${rfi.id}/outcome`, { outcome: 'none', close: true }, manager)
      ).json(),
    ).toMatchObject({ code: 'not_answered' });
    rfi = await ok<Rfi>(
      post(
        `/tenant/rfis/${rfi.id}/answer`,
        { answer: '350 square; drawing revised' },
        people.priya!.headers,
      ),
    );
    expect(rfi.status).toBe('answered');
    await docId(projectId, 'S-101 Columns.pdf', 'columns rev 1', { documentId: s101.id });
    rfi = await ok<Rfi>(
      post(
        `/tenant/rfis/${rfi.id}/outcome`,
        { outcome: 'revision', documentId: s101.id, close: true },
        manager,
      ),
    );
    expect([rfi.status, rfi.outcome, rfi.revisedVersionNo]).toEqual(['closed', 'revision', 2]);

    // A material submittal: its review approves it, and the material approval follows.
    const cement = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code: 'WPC-01',
          name: 'Waterproofing compound',
          kind: 'material',
          unit: 'kg',
          rate: '180',
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;
    const ma = await ok<{ id: string }>(
      post(
        `/tenant/projects/${projectId}/material-approvals`,
        { resourceId: cement, make: 'Dr. Fixit LW+', sampleRef: 'S-07' },
        manager,
      ),
    );
    const datasheet = await docId(projectId, 'LW+ datasheet.pdf', 'datasheet');
    const wf = await ok<{ id: string }>(
      post(
        '/tenant/review-workflows',
        {
          projectId,
          name: 'Material',
          stages: [{ name: 'Engineer', reviewers: [{ kind: 'user', id: people.priya!.id }] }],
        },
        manager,
      ),
    );
    const sub = {
      kind: 'material',
      title: 'Waterproofing compound',
      documentId: datasheet.id,
      workflowId: wf.id,
      materialApprovalId: ma.id,
    };
    expect(
      (
        await post(`/tenant/projects/${projectId}/submittals`, { ...sub, kind: 'sample' }, manager)
      ).json(),
    ).toMatchObject({ code: 'not_material' });
    const s = await ok<{ number: string; reviewId: string; status: string }>(
      post(`/tenant/projects/${projectId}/submittals`, sub, manager),
    );
    expect([s.number, s.status]).toEqual(['SUB-001', 'in_review']);
    const review = await ok<{ tasks: { id: string }[] }>(
      get(`/tenant/reviews/${s.reviewId}`, manager),
    );
    await ok(
      post(
        `/tenant/review-tasks/${review.tasks[0]!.id}/respond`,
        { code: 'A' },
        people.priya!.headers,
      ),
    );
    const subs = await ok<{ status: string; materialStatus: string }[]>(
      get(`/tenant/projects/${projectId}/submittals`, manager),
    );
    expect(subs.map((x) => [x.status, x.materialStatus])).toEqual([['approved', 'approved']]);
  });
});
