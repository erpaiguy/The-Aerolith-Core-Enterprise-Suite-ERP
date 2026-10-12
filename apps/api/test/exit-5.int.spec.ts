// The Wave 5 exit check (docs/01-mvp.md: signed and approved documents end to end; docs/wave5-plan.md as the owner
// changed it): a drawing reviewed in three stages and returned, revised and approved; signed with drawn signatures;
// issued on a transmittal; and acknowledged by the recipient through the expiring link, with no account.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('Wave 5 exit check (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-exit5-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'exit5-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    manager = m.headers;
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

  const multipart = (
    url: string,
    name: string,
    body: Buffer,
    query: Record<string, string> = {},
    headers: Record<string, string> = manager,
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
      url: `/api${url}${qs ? `?${qs}` : ''}`,
      payload,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  /** A real PDF of `pages` pages, each with a line of text. */
  async function pdf(text: string, pages = 1) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++)
      doc
        .addPage([842, 595])
        .drawText(`${text}, sheet ${i + 1}`, { x: 60, y: 500, size: 18, font });
    return Buffer.from(await doc.save());
  }
  /** A small drawn signature: a PNG with a few strokes. */
  function png(seed = 1) {
    const w = 240;
    const h = 80;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0;
      for (let x = 0; x < w; x++) {
        const ink = Math.abs(y - (h / 2 + Math.sin((x + seed * 7) / 12) * 20)) < 2;
        raw.writeUInt32BE(ink ? 0x1a237eff : 0x00000000, y * (w * 4 + 1) + 1 + x * 4);
      }
    }
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
  }
  /** Whether a PDF's page content shows `text` (pdf-lib writes text as hex inside compressed streams). */
  function pdfShows(bytes: Buffer, text: string) {
    const hex = Buffer.from(text, 'latin1').toString('hex');
    const raw = bytes.toString('latin1');
    for (const m of raw.matchAll(/stream\r?\n/g)) {
      const start = m.index + m[0].length;
      const end = raw.indexOf('endstream', start);
      let body: string;
      try {
        body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
      } catch {
        body = raw.slice(start, end);
      }
      if (body.toLowerCase().includes(hex) || body.includes(text)) return true;
    }
    return false;
  }
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
  type Drawing = {
    id: string;
    revisions: { id: string; revision: string; receipts: number; acknowledged: number }[];
    next: { preliminary: string | null; construction: string | null } | null;
  };
  const revise = async (drawingId: string, revision: string, purpose: string, body: Buffer) =>
    multipart(`/tenant/drawings/${drawingId}/revisions`, `S-101 ${revision}.pdf`, body, {
      revision,
      purpose,
      receivedFrom: 'Desai Structural',
      receivedOn: '2026-10-01',
    });

  it('reviews, revises, signs, issues and has a drawing acknowledged', async () => {
    const projectId = await project('Collectorate annexe, Buldhana');
    await ok(
      post(
        `/tenant/projects/${projectId}/team`,
        { userId: people.iyer!.id, role: 'member' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/revision-rule`,
        { enabled: true, construction: 'numbers' },
        manager,
      ),
    );
    const d = await ok<Drawing>(
      post(
        `/tenant/projects/${projectId}/drawings`,
        { number: 'S-201', title: 'Raft foundation', discipline: 'structural' },
        manager,
      ),
    );
    const documentOf = async () =>
      (await ok<{ documentId: string }>(get(`/tenant/drawings/${d.id}`, manager))).documentId;
    await ok(revise(d.id, 'P1', 'approval', await pdf('S-201 P1')));
    const documentId = await documentOf();

    // 1. Three stages: design (Priya), the project's lead (suresh), the client (Rao or Iyer).
    const wf = await ok<{ id: string }>(
      post(
        '/tenant/review-workflows',
        {
          projectId,
          name: 'Structural drawings',
          stages: [
            { name: 'Design', reviewers: [{ kind: 'user', id: people.priya!.id }] },
            { name: 'Project manager', reviewers: [{ kind: 'lead' }] },
            {
              name: 'Client',
              mode: 'any',
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
      withComments: boolean;
      tasks: { id: string; stage: number; reviewer: string }[];
    };
    const respond = async (r: Review, stage: number, who: string, code: string, comment = '') =>
      ok<Review>(
        post(
          `/tenant/review-tasks/${r.tasks.find((x) => x.stage === stage && x.reviewer === who)!.id}/respond`,
          { code, comment },
          who === 'suresh' ? manager : people[who]!.headers,
        ),
      );
    let r1 = await ok<Review>(
      post(
        `/tenant/projects/${projectId}/reviews`,
        { documentId, workflowId: wf.id, title: 'Raft foundation' },
        manager,
      ),
    );
    r1 = await respond(r1, 0, 'priya', 'A');
    // A mark-up from the lead with the C.
    await ok(
      post(
        `/tenant/documents/${documentId}/versions/1/markups`,
        {
          reviewId: r1.id,
          page: 1,
          box: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
          body: 'Raft 600 thick, not 450',
        },
        manager,
      ),
    );
    r1 = await respond(r1, 1, 'suresh', 'C', 'Raft thickness; see mark-up 1');
    expect(r1.status).toBe('returned');

    // 2. Revised: P2, resubmitted and approved with comments.
    await ok(revise(d.id, 'P2', 'approval', await pdf('S-201 P2')));
    const resubmitted = await ok<Review & { document: { versionNo: number } }>(
      post(`/tenant/reviews/${r1.id}/resubmit`, {}, manager),
    );
    expect([resubmitted.number, resubmitted.document.versionNo]).toEqual(['RV-002', 2]);
    let r2: Review = resubmitted;
    r2 = await respond(r2, 0, 'priya', 'A');
    r2 = await respond(r2, 1, 'suresh', 'A');
    r2 = await respond(r2, 2, 'iyer', 'B', 'Show the sump pit');
    expect([r2.status, r2.withComments]).toEqual(['approved', true]);

    // 3. Signed with drawn signatures, Priya then the lead, on the approved version.
    type S = { id: string; status: string; signedVersionNo: number | null };
    const lead = (
      await ok<{ team: { userId: string; displayName: string }[] }>(
        get(`/tenant/projects/${projectId}`, manager),
      )
    ).team.find((m) => m.displayName === 'suresh')!.userId;
    let so = await ok<S>(
      post(
        `/tenant/projects/${projectId}/sign-offs`,
        {
          title: 'S-201 for construction',
          documentId,
          versionNo: 2,
          reviewId: r2.id,
          signers: [
            { userId: people.priya!.id, page: 1, box: { x: 0.55, y: 0.85, w: 0.18, h: 0.1 } },
            { userId: lead, page: 1, box: { x: 0.78, y: 0.85, w: 0.18, h: 0.1 } },
          ],
        },
        manager,
      ),
    );
    so = await ok<S>(
      post(`/tenant/sign-offs/${so.id}/sign`, { png: png(5) }, people.priya!.headers),
    );
    so = await ok<S>(post(`/tenant/sign-offs/${so.id}/sign`, { png: png(6) }, manager));
    expect([so.status, so.signedVersionNo]).toEqual(['signed', 3]);
    expect(await ok(get(`/tenant/sign-offs/${so.id}/verify`, manager))).toMatchObject({
      intact: true,
    });

    // 4. Issued on a transmittal: the signed version, for construction.
    let tr = await ok<{ id: string; status: string; items: { versionNo: number }[] }>(
      post(
        `/tenant/projects/${projectId}/transmittals`,
        {
          subject: 'S-201 Raft foundation for construction',
          recipient: 'Patil Constructions',
          purpose: 'construction',
          items: [{ documentId, versionNo: 3 }],
        },
        manager,
      ),
    );
    tr = await ok(post(`/tenant/transmittals/${tr.id}/issue`, {}, manager));
    expect([tr.status, tr.items[0]!.versionNo]).toEqual(['issued', 3]);
    const { token } = await ok<{ token: string }>(
      post(`/tenant/transmittals/${tr.id}/link`, {}, manager),
    );

    // 5. Acknowledged through the link, no account.
    const ack = await app.inject({
      method: 'POST',
      url: `/api/share/${t.tenantId}/${token}/acknowledge`,
      payload: { name: 'R. Patil' },
    });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json()).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'R. Patil' });
    const signedFile = await app.inject({
      method: 'GET',
      url: `/api/share/${t.tenantId}/${token}/items/${ack.json<{ items: { id: string }[] }>().items[0]!.id}`,
    });
    expect(pdfShows(signedFile.rawPayload, 'Sign-off certificate')).toBe(true);
  });
});
