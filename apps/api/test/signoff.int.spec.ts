// Controlled revisions and sign-off (docs/wave5-plan.md steps 4 and 5) in a real tenant database: a project's revision
// series enforced on the drawings register, the distribution matrix (receipts inside, a draft transmittal outside), the
// stamped controlled copy and the QR's check; drawn signatures in order, the signed version with its certificate page,
// verified, and a transmittal held until its document is signed.
import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('controlled revisions and sign-off (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-signoff-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'signoff-admin@example.in');
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

  it('enforces the revision series, distributes by the matrix, stamps controlled copies and checks them', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const projectId = await project('Hospital, Akola');
    const d = await ok<Drawing>(
      post(
        `/tenant/projects/${projectId}/drawings`,
        { number: 'S-101', title: 'Footing layout', discipline: 'structural' },
        manager,
      ),
    );
    // The series: off until set; only the lead or an editor sets it.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/revision-rule`,
          { enabled: true, construction: 'numbers' },
          people.rao!.headers,
        )
      ).statusCode,
    ).toBe(403);
    await ok(
      post(
        `/tenant/projects/${projectId}/revision-rule`,
        { enabled: true, construction: 'numbers' },
        manager,
      ),
    );
    // The matrix: Priya inside for structural, the consultant outside for everything; Iyer is not on the project.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/distribution`,
          { discipline: 'structural', userId: people.iyer!.id },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_on_project' });
    await ok(
      post(
        `/tenant/projects/${projectId}/distribution`,
        { discipline: 'structural', userId: people.priya!.id },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/distribution`,
        { userId: people.rao!.id, discipline: 'architectural' },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/distribution`,
        { name: 'Desai Structural', email: 'site@desai.in' },
        manager,
      ),
    );

    // P1 for approval; P3 refused; P2; 0 for construction; P3 refused after; 2 refused; 1.
    const p1 = await revise(d.id, 'p1', 'approval', await pdf('S-101 P1'));
    expect(p1.statusCode, p1.body).toBe(200);
    expect(p1.json<Drawing>().revisions[0]!.revision).toBe('P1');
    expect(p1.json<Drawing>().next).toEqual({ preliminary: 'P2', construction: '0' });
    expect((await revise(d.id, 'P3', 'approval', await pdf('S-101 P3'))).json()).toMatchObject({
      code: 'not_next',
      message: 'The next revision is P2 or 0, not P3.',
    });
    expect((await revise(d.id, 'P2', 'construction', await pdf('S-101 P2'))).json()).toMatchObject({
      code: 'construction_label',
    });
    await ok(revise(d.id, 'P2', 'approval', await pdf('S-101 P2')));
    let dr = await ok<Drawing>(revise(d.id, '0', 'construction', await pdf('S-101 R0', 2)));
    expect((await revise(d.id, 'P3', 'approval', await pdf('S-101 P3'))).json()).toMatchObject({
      code: 'no_going_back',
    });

    // Construction revision 0: Priya's receipt (not Rao's, he takes architectural), a draft transmittal outside.
    expect(dr.revisions[0]).toMatchObject({ revision: '0', receipts: 1, acknowledged: 0 });
    const receipts = await ok<
      { id: string; number: string; revision: string; supersedes: string }[]
    >(get('/tenant/drawing-receipts', people.priya!.headers));
    expect(receipts.map((r) => [r.number, r.revision, r.supersedes])).toEqual([
      ['S-101', '0', 'P2'],
    ]);
    expect(await ok(get('/tenant/drawing-receipts', people.rao!.headers))).toEqual([]);
    const [note] = await db<{ title: string }[]>`
      SELECT title FROM platform.notification WHERE user_id = ${people.priya!.id} AND kind = 'drawing_issue'`;
    expect(note!.title).toBe(
      'S-101 rev 0 for construction: rev P2 is superseded; withdraw old prints',
    );
    const drafts = await ok<
      { number: string; recipient: string; status: string; purpose: string }[]
    >(get(`/tenant/projects/${projectId}/transmittals`, manager));
    expect(drafts.map((x) => [x.number, x.recipient, x.status, x.purpose])).toEqual([
      ['TR-001', 'Desai Structural', 'draft', 'construction'],
    ]);
    await ok(
      post(`/tenant/drawing-receipts/${receipts[0]!.id}/acknowledge`, {}, people.priya!.headers),
    );
    dr = await ok<Drawing>(get(`/tenant/drawings/${d.id}`, manager));
    expect(dr.revisions[0]).toMatchObject({ receipts: 1, acknowledged: 1 });

    // The controlled copy: both pages stamped; the QR's check says current.
    const r0 = dr.revisions[0]!.id;
    const printed = await get(`/tenant/drawing-revisions/${r0}/print`, people.priya!.headers);
    expect(printed.statusCode, printed.body).toBe(200);
    expect(printed.headers['content-disposition']).toContain('S-101 rev 0 controlled copy.pdf');
    const copy = await PDFDocument.load(printed.rawPayload);
    expect(copy.getPageCount()).toBe(2);
    expect(pdfShows(printed.rawPayload, 'S-101 rev 0')).toBe(true);
    const [code] = await db<{ check_code: string }[]>`
      SELECT check_code FROM proj.drawing_revision WHERE id = ${r0}`;
    const check = () =>
      app.inject({ method: 'GET', url: `/api/check/${t.tenantId}/${code!.check_code}` });
    expect((await check()).json()).toMatchObject({ number: 'S-101', revision: '0', current: true });
    await ok(revise(d.id, '1', 'construction', await pdf('S-101 R1')));
    expect((await check()).json()).toMatchObject({
      current: false,
      latest: { revision: '1', purpose: 'construction' },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/check/${t.tenantId}/${randomUUID()}`,
        })
      ).statusCode,
    ).toBe(404);
    // Someone off the project cannot print.
    expect((await get(`/tenant/drawing-revisions/${r0}/print`, worker)).statusCode).toBe(404);
  });

  it('signs a PDF in order with drawn signatures, verifies it, and holds its transmittal until signed', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const projectId = await project('Clinic, Washim');
    const up = (
      await multipart(
        `/tenant/projects/${projectId}/documents/upload`,
        'A-101 Plan.pdf',
        await pdf('A-101 rev 0', 2),
      )
    ).json<{ document: { id: string; versionNo: number } }>().document;
    type S = {
      id: string;
      number: string;
      status: string;
      myTurn: boolean;
      signedVersionNo: number | null;
      signers: { name: string; status: string }[];
    };
    const body = {
      title: 'Ground floor plan for construction',
      documentId: up.id,
      signers: [
        { userId: people.priya!.id, page: 1, box: { x: 0.6, y: 0.8, w: 0.15, h: 0.1 } },
        { userId: people.rao!.id, page: 1, box: { x: 0.8, y: 0.8, w: 0.15, h: 0.1 } },
      ],
    };
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/sign-offs`,
          { ...body, signers: [{ ...body.signers[0], page: 3 }] },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'no_such_page' });
    let so = await ok<S>(post(`/tenant/projects/${projectId}/sign-offs`, body, manager));
    expect([so.number, so.status, so.myTurn]).toEqual(['SO-001', 'open', false]);

    // A transmittal of the document waits for the signatures.
    const tr = await ok<{ id: string }>(
      post(
        `/tenant/projects/${projectId}/transmittals`,
        {
          subject: 'Plans',
          recipient: 'Kale Architects',
          purpose: 'construction',
          items: [{ documentId: up.id, versionNo: 1 }],
        },
        manager,
      ),
    );
    expect((await post(`/tenant/transmittals/${tr.id}/issue`, {}, manager)).json()).toMatchObject({
      code: 'awaiting_signatures',
    });

    // Rao cannot sign before Priya; bad pictures are refused; Priya saves hers and signs with it.
    expect(
      (await post(`/tenant/sign-offs/${so.id}/sign`, { png: png(2) }, people.rao!.headers)).json(),
    ).toMatchObject({ code: 'not_your_turn' });
    expect(
      (
        await post(
          `/tenant/my-signature`,
          {
            png: Buffer.from(
              'not a picture at all, just text that is long enough to pass the length check of the schema here',
            ).toString('base64'),
          },
          people.priya!.headers,
        )
      ).json(),
    ).toMatchObject({ code: 'bad_signature' });
    expect(
      (await post(`/tenant/sign-offs/${so.id}/sign`, { png: null }, people.priya!.headers)).json(),
    ).toMatchObject({
      code: 'no_signature',
    });
    await ok(post(`/tenant/my-signature`, { png: png(1) }, people.priya!.headers));
    so = await ok<S>(post(`/tenant/sign-offs/${so.id}/sign`, { png: null }, people.priya!.headers));
    expect(so.signers.map((g) => g.status)).toEqual(['signed', 'waiting']);
    expect(
      await ok<{ number: string }[]>(get('/tenant/sign-offs/mine', people.rao!.headers)),
    ).toEqual([expect.objectContaining({ number: 'SO-001' })]);
    so = await ok<S>(
      post(
        `/tenant/sign-offs/${so.id}/sign`,
        { png: png(3) },
        { ...people.rao!.headers, 'user-agent': 'SiteTablet/1.0' },
      ),
    );
    expect([so.status, so.signedVersionNo]).toEqual(['signed', 2]);

    // The signed version: the document's version 2, a page more (the certificate), and it verifies.
    const file = await get(`/tenant/documents/${up.id}/file?version=2`, manager);
    const signed = await PDFDocument.load(file.rawPayload);
    expect(signed.getPageCount()).toBe(3);
    expect(pdfShows(file.rawPayload, 'Sign-off certificate')).toBe(true);
    expect(await ok(get(`/tenant/sign-offs/${so.id}/verify`, manager))).toMatchObject({
      intact: true,
    });
    const [signer] = await db<{ user_agent: string; session_id: string }[]>`
      SELECT user_agent, session_id FROM dms.signoff_signer WHERE user_id = ${people.rao!.id}`;
    expect(signer!.user_agent).toBe('SiteTablet/1.0');
    expect(signer!.session_id).toBeTruthy();
    // Version 1 is unchanged, and the transmittal of version 1 can go now (the sign-off is closed).
    const v1 = await get(`/tenant/documents/${up.id}/file?version=1`, manager);
    expect(createHash('sha256').update(v1.rawPayload).digest('hex')).toBe(
      (await ok<{ sourceSha256: string }>(get(`/tenant/sign-offs/${so.id}`, manager))).sourceSha256,
    );
    await ok(post(`/tenant/transmittals/${tr.id}/issue`, {}, manager));

    // Altered behind the app's back, verify says so.
    await db`UPDATE dms.signoff SET signed_sha256 = ${Buffer.alloc(32)} WHERE id = ${so.id}`;
    expect(await ok(get(`/tenant/sign-offs/${so.id}/verify`, manager))).toMatchObject({
      intact: false,
    });

    // A decline ends a sign-off.
    let so2 = await ok<S>(
      post(
        `/tenant/projects/${projectId}/sign-offs`,
        { ...body, title: 'Again', signers: [body.signers[1]] },
        manager,
      ),
    );
    so2 = await ok<S>(
      post(`/tenant/sign-offs/${so2.id}/decline`, { reason: 'Wrong sheet' }, people.rao!.headers),
    );
    expect(so2.status).toBe('declined');
    expect(
      (await post(`/tenant/sign-offs/${so2.id}/sign`, { png: png(4) }, people.rao!.headers)).json(),
    ).toMatchObject({
      code: 'closed',
    });
  });
});
