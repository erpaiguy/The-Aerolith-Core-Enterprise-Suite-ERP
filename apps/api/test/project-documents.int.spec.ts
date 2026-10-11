// Project documents in a real tenant database (docs/wave2b-plan.md step 8): a project's own vault (folders, uploads,
// versions, search) kept to its team; the drawings register, each revision a version of one document in the vault and
// the one before superseded; challans linked to goods receipts and quotes to a project's enquiry; a tender's vault
// unchanged; a project document purged for good.
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

describe.skipIf(!controlUrl || !adminUrl)('project documents (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let projectId: string;
  let lata: { id: string; headers: Record<string, string> };

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-pdoc-test-')),
      DOCUMENT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-pdoc-files-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'pdoc-admin@example.in');
    // More people than a trial's one manager and one worker.
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

  type Headers = Record<string, string>;
  interface Vault {
    folders: { id: string; name: string; parentId: string | null }[];
    documents: { id: string; name: string; folderId: string | null; versionNo: number }[];
  }
  let other: string;
  let tender: string;

  const upload = (
    path: string,
    name: string,
    body: Buffer,
    query: Record<string, string> = {},
    as: Headers = worker,
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
      url: `/api/tenant/${path}${qs ? `?${qs}` : ''}`,
      payload,
      headers: { ...as, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);

  it("keeps a project's own vault to its team", async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: lata.id, role: 'viewer' }, manager),
    );
    other = (await ok<{ id: string }>(post('/tenant/projects', { name: 'Godown, Akola' }, manager)))
      .id;
    tender = (await ok<{ id: string }>(post('/tenant/tenders', { title: 'Hostel at Washim' }))).id;

    // The team's member makes folders and uploads; a second upload of the same name is a new version.
    let v = await ok<Vault>(
      post(`/tenant/projects/${projectId}/folders`, { name: 'Correspondence' }, worker),
    );
    const folder = v.folders.find((f) => f.name === 'Correspondence')!.id;
    const first = await ok<{ outcome: string; document: { id: string } }>(
      upload(`projects/${projectId}/documents/upload`, 'Client letter.pdf', pdf('letter one'), {
        folderId: folder,
      }),
    );
    expect(first.outcome).toBe('created');
    expect(
      (
        await ok<{ outcome: string }>(
          upload(`projects/${projectId}/documents/upload`, 'Client letter.pdf', pdf('letter two'), {
            folderId: folder,
          }),
        )
      ).outcome,
    ).toBe('new_version');
    v = await ok<Vault>(get(`/tenant/projects/${projectId}/documents`, worker));
    expect(v.documents).toEqual([
      expect.objectContaining({ name: 'Client letter.pdf', folderId: folder, versionNo: 2 }),
    ]);
    // A viewer reads it but does not upload; someone off the team sees nothing.
    expect((await get(`/tenant/projects/${projectId}/documents`, lata.headers)).statusCode).toBe(
      200,
    );
    expect(
      (
        await upload(`projects/${projectId}/documents/upload`, 'x.pdf', pdf('x'), {}, lata.headers)
      ).json(),
    ).toMatchObject({ code: 'forbidden' });
    expect((await get(`/tenant/projects/${other}/documents`, worker)).statusCode).toBe(404);
    await db`DELETE FROM proj.member WHERE project_id = ${projectId} AND user_id = ${lata.id}`;
    expect((await get(`/tenant/documents/${first.document.id}`, lata.headers)).statusCode).toBe(
      404,
    );
    expect(
      (await get(`/tenant/documents/${first.document.id}/file`, lata.headers)).statusCode,
    ).toBe(404);
    expect((await get(`/tenant/projects/${projectId}/documents`, lata.headers)).statusCode).toBe(
      404,
    );
    // Search finds it for the team only; a tender's vault is as before.
    const found = await ok<{ items: { name: string; project: { name: string } | null }[] }>(
      get('/tenant/documents?q=Client', worker),
    );
    expect(found.items).toEqual([
      expect.objectContaining({
        name: 'Client letter.pdf',
        project: expect.objectContaining({ name: 'Hostel, Washim' }),
      }),
    ]);
    expect(
      (await ok<{ items: unknown[] }>(get('/tenant/documents?q=Client', lata.headers))).items,
    ).toEqual([]);
    await ok(upload(`tenders/${tender}/documents/upload`, 'NIT.pdf', pdf('notice'), {}, t.admin));
    expect(
      (await ok<Vault>(get(`/tenant/tenders/${tender}/documents`, lata.headers))).documents,
    ).toHaveLength(1);
  });

  it('keeps the drawings register, each revision a version of one drawing in the vault', async () => {
    const add = (body: object, as: Headers = worker) =>
      post(`/tenant/projects/${projectId}/drawings`, body, as);
    const d = await ok<{ id: string; documentId: string | null }>(
      add({ number: 'S-101', title: 'Footing layout', discipline: 'structural' }),
    );
    expect(d.documentId).toBeNull();
    expect(
      (await add({ number: 's-101', title: 'Again', discipline: 'structural' })).json(),
    ).toMatchObject({
      code: 'drawing_exists',
    });
    const revise = (rev: string, purpose: string, bytes: Buffer, receivedOn = '2026-10-02') =>
      upload(`drawings/${d.id}/revisions`, 'S101.pdf', bytes, {
        revision: rev,
        purpose,
        receivedOn,
        receivedFrom: 'Kulkarni Consultants',
      });
    let r = await ok<{
      documentId: string;
      revisions: {
        revision: string;
        purpose: string;
        versionNo: number;
        supersededAt: string | null;
      }[];
    }>(revise('P1', 'information', pdf('footing P1')));
    // P1 is the drawing's file, under Drawings / Structural.
    const v = await ok<Vault>(get(`/tenant/projects/${projectId}/documents`, worker));
    const doc = v.documents.find((x) => x.id === r.documentId)!;
    expect(doc.name).toBe('S-101 Footing layout.pdf');
    const path = (id: string | null): string[] => {
      const f = v.folders.find((x) => x.id === id);
      return f ? [...path(f.parentId), f.name] : [];
    };
    expect(path(doc.folderId)).toEqual(['Drawings', 'Structural']);
    // R0 for construction supersedes it; the same label or the same file again is refused.
    r = await ok(revise('R0', 'construction', pdf('footing R0'), '2026-10-09'));
    expect(r.revisions.map((x) => [x.revision, x.purpose, x.versionNo, !!x.supersededAt])).toEqual([
      ['R0', 'construction', 2, false],
      ['P1', 'information', 1, true],
    ]);
    expect((await revise('r0', 'construction', pdf('other'))).json()).toMatchObject({
      code: 'revision_exists',
    });
    expect((await revise('R1', 'construction', pdf('footing R0'))).json()).toMatchObject({
      code: 'same_file',
    });
    expect((await revise('R1', 'construction', pdf('x'), '2099-01-01')).json()).toMatchObject({
      code: 'in_future',
    });
    // The register shows the current revision; P1 stays readable as version 1.
    const reg = await ok<{
      drawings: { number: string; current: { revision: string; purpose: string } }[];
    }>(get(`/tenant/projects/${projectId}/drawings`, worker));
    expect(reg.drawings).toEqual([
      expect.objectContaining({
        number: 'S-101',
        current: expect.objectContaining({ revision: 'R0', purpose: 'construction' }),
      }),
    ]);
    const old = await get(`/tenant/documents/${r.documentId}/file?version=1`, worker);
    expect(old.body).toContain('footing P1');
    expect((await get(`/tenant/projects/${projectId}/drawings`, lata.headers)).statusCode).toBe(
      404,
    );
  });

  it("links challans to goods receipts and quotes to the project's enquiry, never across", async () => {
    const vendor = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Vidarbha Cement Traders',
          isClient: false,
          isVendor: true,
          gstin: '27AAACV1234F1Z5',
        }),
      )
    ).id;
    const site = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    const o = await ok<{ open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: vendor,
          siteId: site,
          lines: [{ description: 'River sand', unit: 'cum', qty: '10', rate: '1800', gstPct: '5' }],
        },
        manager,
      ),
    );
    const po = await ok<{ id: string; progress: { lineKey: string }[] }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    const grn = await ok<{ id: string; number: string }>(
      post(
        `/tenant/orders/${po.id}/receipts`,
        {
          receivedOn: '2026-10-05',
          challanNo: 'VCT/441',
          lines: [{ lineKey: po.progress[0]!.lineKey, qty: '10' }],
        },
        worker,
      ),
    );
    const challan = await ok<{ document: { id: string } }>(
      upload(`projects/${projectId}/documents/upload`, 'Challan VCT-441.pdf', pdf('challan'), {
        path: `Receipts/${grn.number.replaceAll('/', '-')}`,
      }),
    );
    await ok(
      post(
        `/tenant/documents/${challan.document.id}/links`,
        { kind: 'goods_receipt', targetId: grn.id },
        worker,
      ),
    );
    expect(
      (await ok<{ documents: { name: string }[] }>(get(`/tenant/receipts/${grn.id}`, worker)))
        .documents,
    ).toEqual([expect.objectContaining({ name: 'Challan VCT-441.pdf' })]);
    // A tender's document cannot be linked to a project's receipt.
    const nit = (await ok<Vault>(get(`/tenant/tenders/${tender}/documents`))).documents[0]!.id;
    expect(
      (
        await post(`/tenant/documents/${nit}/links`, { kind: 'goods_receipt', targetId: grn.id })
      ).json(),
    ).toMatchObject({
      code: 'link_target_not_found',
    });
    // A quote on the project's enquiry is filed in the project's vault and linked to the vendor.
    const rfq = await ok<{ id: string; vendors: { partyId: string }[] }>(
      post(`/tenant/projects/${projectId}/rfqs`, { title: 'Sand' }, manager),
    );
    const withVendor = await ok<{ vendors: { partyId: string }[] }>(
      post(`/tenant/rfqs/${rfq.id}/vendors`, { partyId: vendor }, manager),
    );
    const quote = await ok<{ document: { id: string } }>(
      upload(`projects/${projectId}/documents/upload`, 'VCT quote.pdf', pdf('quote'), {}, manager),
    );
    const target = `${rfq.id}/${withVendor.vendors[0]!.partyId}`;
    await ok(
      post(
        `/tenant/documents/${quote.document.id}/links`,
        { kind: 'rfq_vendor', targetId: target },
        manager,
      ),
    );
    expect(
      (
        await ok<{ vendors: { documents: { name: string }[] }[] }>(
          get(`/tenant/rfqs/${rfq.id}`, manager),
        )
      ).vendors[0]!.documents,
    ).toEqual([expect.objectContaining({ name: 'VCT quote.pdf' })]);
    expect(
      (
        await post(`/tenant/documents/${nit}/links`, { kind: 'rfq_vendor', targetId: target })
      ).json(),
    ).toMatchObject({
      code: 'link_target_not_found',
    });
  });

  it('purges a project document from the trash for good', async () => {
    const v = await ok<Vault>(get(`/tenant/projects/${projectId}/documents`, worker));
    const letter = v.documents.find((d) => d.name === 'Client letter.pdf')!.id;
    await ok(post(`/tenant/documents/${letter}/delete`, {}, worker));
    expect(
      await ok<unknown[]>(get(`/tenant/projects/${projectId}/documents/trash`, worker)),
    ).toHaveLength(1);
    await ok(post(`/tenant/documents/${letter}/purge`, {}));
    const [p] = await db<{ project_id: string; tender_id: string | null; versions: number }[]>`
      SELECT project_id, tender_id, versions FROM doc.purged_document WHERE id = ${letter}`;
    expect(p).toEqual({ project_id: projectId, tender_id: null, versions: 2 });
  });
});
