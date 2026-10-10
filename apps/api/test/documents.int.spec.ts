// Tender documents in a real tenant database (docs/wave1-plan.md step 10): the standard folders, uploads and their
// versions, folder uploads, restricted folders hidden from roles without pricing, downloads, ZIPs, the trash,
// search, the size limit, virus scanning (a fake clamd) and what the database itself refuses.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { DocumentLifecycle } from '../src/documents/lifecycle.service.js';
import { DocumentText } from '../src/documents/text.service.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { textPdf } from './helpers/pdf.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
const MB = 1024 * 1024;
const pdf = (text: string, pad = 0) =>
  Buffer.concat([Buffer.from(`%PDF-1.7\n${text}\n`), Buffer.alloc(pad, 32)]);

interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  restricted: boolean;
  rowVersion: number;
}
interface Doc {
  id: string;
  folderId: string | null;
  name: string;
  tags: string[];
  versionNo: number;
  rowVersion: number;
  size: number;
  mime: string;
  scanStatus: string;
  hasThumbnail: boolean;
}
interface Vault {
  folders: Folder[];
  documents: Doc[];
  trashCount: number;
  trashDays: number | null;
  canSeeRestricted: boolean;
}

/** Entry names and contents of a ZIP, read from its central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + skip;
  }
  return out;
}

describe.skipIf(!controlUrl || !adminUrl)('tender documents (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let clamd: Server;
  let docDir: string;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: Record<string, string>;
  let tenderId: string;
  let otherTenderId: string;
  let vault: Vault;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  const upload = (
    tender: string,
    name: string,
    body: Buffer,
    query: Record<string, string> = {},
    headers: Record<string, string> = t.admin,
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
      url: `/api/tenant/tenders/${tender}/documents/upload${qs ? `?${qs}` : ''}`,
      payload,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  const uploaded = async (...args: Parameters<typeof upload>) =>
    ok<{ outcome: string; document: { id: string; folderId: string | null; versionNo: number } }>(
      upload(...args),
    );
  const folderNamed = (name: string, v: Vault = vault) => v.folders.find((f) => f.name === name)!;

  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ temporaryPassword: string }>();
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
    return { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` };
  }

  beforeAll(async () => {
    // A stand-in for ClamAV's daemon: anything containing the EICAR test string is "infected".
    clamd = createServer((socket) => {
      const parts: Buffer[] = [];
      socket.on('data', (d) => {
        parts.push(d);
        const all = Buffer.concat(parts);
        if (all.length >= 14 && all.subarray(-4).equals(Buffer.alloc(4)))
          socket.end(
            all.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
              ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0'
              : 'stream: OK\0',
          );
      });
    });
    await new Promise<void>((r) => clamd.listen(0, '127.0.0.1', r));
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
    docDir = await mkdtemp(join(tmpdir(), 'aerolith-documents-test-'));
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      RATE_LIMIT_SCALE: '50',
      PUBLIC_API_URL: 'https://api.example.in',
      DOCUMENT_DIR: docDir,
      DOCUMENT_MAX_MB: '2',
      // Smaller than the document limit: the upload route sets its own limit.
      IMPORT_MAX_MB: '1',
      CLAMD_HOST: '127.0.0.1',
      CLAMD_PORT: String((clamd.address() as { port: number }).port),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'docs-admin@example.in');
    worker = await staff('ganesh', 'worker');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (
      await ok<{ id: string }>(post('/tenant/tenders', { title: 'District hospital, Washim' }))
    ).id;
    otherTenderId = (
      await ok<{ id: string }>(post('/tenant/tenders', { title: 'ITI workshop, Akola' }))
    ).id;
  }, 90_000);

  afterAll(async () => {
    for (const k of [
      'DOCUMENT_DIR',
      'DOCUMENT_MAX_MB',
      'IMPORT_MAX_MB',
      'CLAMD_HOST',
      'CLAMD_PORT',
    ])
      delete process.env[k];
    await app?.close();
    await control?.end();
    await server?.end();
    await new Promise<void>((r) => clamd?.close(() => r()));
  });

  it('adds the standard folders; sub-folders inherit a restriction; workers never see restricted ones', async () => {
    vault = await ok<Vault>(post(`/tenant/tenders/${tenderId}/folders/standard`));
    expect(vault.folders.map((f) => f.name)).toHaveLength(9);
    expect(folderNamed('06 Our financial bid').restricted).toBe(true);
    // Twice changes nothing.
    vault = await ok<Vault>(post(`/tenant/tenders/${tenderId}/folders/standard`));
    expect(vault.folders).toHaveLength(9);

    vault = await ok<Vault>(
      post(`/tenant/tenders/${tenderId}/folders`, {
        parentId: folderNamed('06 Our financial bid').id,
        name: 'Price bid workings',
      }),
    );
    expect(folderNamed('Price bid workings').restricted).toBe(true);
    const dup = await post(`/tenant/tenders/${tenderId}/folders`, { name: '02 drawings' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'folder_exists' });
    expect(
      (await post(`/tenant/tenders/${tenderId}/folders`, { name: '../x' })).json(),
    ).toMatchObject({ code: 'bad_name' });

    const seen = await ok<Vault>(get(`/tenant/tenders/${tenderId}/documents`, worker));
    expect(seen.canSeeRestricted).toBe(false);
    expect(seen.folders.map((f) => f.name)).not.toContain('06 Our financial bid');
    expect(seen.folders.map((f) => f.name)).not.toContain('Price bid workings');
    expect(seen.folders).toHaveLength(7);
    const restrictIt = await post(
      `/tenant/folders/${folderNamed('08 Correspondence').id}`,
      { rowVersion: 1, restricted: true },
      worker,
    );
    expect(restrictIt.statusCode).toBe(403);
    // Lifting the restriction of a folder inside a restricted one is refused.
    const lift = await post(`/tenant/folders/${folderNamed('Price bid workings').id}`, {
      rowVersion: 1,
      restricted: false,
    });
    expect(lift.json()).toMatchObject({ code: 'parent_restricted' });
  });

  it('keeps uploads as versions: same name is a new version, same content changes nothing', async () => {
    const drawings = folderNamed('02 Drawings').id;
    const v1 = await uploaded(tenderId, 'GA plan.pdf', pdf('rev A'), { folderId: drawings });
    expect(v1).toMatchObject({
      outcome: 'created',
      document: { folderId: drawings, versionNo: 1 },
    });
    const v2 = await uploaded(tenderId, 'ga PLAN.pdf', pdf('rev B'), {
      folderId: drawings,
      note: 'Rev B',
    });
    expect(v2).toMatchObject({
      outcome: 'new_version',
      document: { id: v1.document.id, versionNo: 2 },
    });
    const same = await uploaded(tenderId, 'GA plan.pdf', pdf('rev B'), { folderId: drawings });
    expect(same).toMatchObject({ outcome: 'unchanged', document: { versionNo: 2 } });
    // The same file at the top level is another document; its bytes are kept once.
    await uploaded(tenderId, 'GA plan.pdf', pdf('rev B'));

    const doc = await ok<{
      name: string;
      path: { name: string }[];
      versions: {
        versionNo: number;
        note: string;
        scanStatus: string;
        mime: string;
        uploadedBy: string;
      }[];
    }>(get(`/tenant/documents/${v1.document.id}`));
    expect(doc.name).toBe('GA plan.pdf');
    expect(doc.path.map((p) => p.name)).toEqual(['02 Drawings']);
    expect(doc.versions).toEqual([
      expect.objectContaining({
        versionNo: 2,
        note: 'Rev B',
        scanStatus: 'clean',
        mime: 'application/pdf',
      }),
      expect.objectContaining({ versionNo: 1, note: '' }),
    ]);
    const files = (await readdir(join(docDir, t.tenantId), { recursive: true })).filter((f) =>
      /[0-9a-f]{64}$/.test(f),
    );
    expect(files).toHaveLength(2);
  });

  it('downloads any version as a file the browser will not render on our origin', async () => {
    const id = vault.documents.length
      ? vault.documents[0]!.id
      : (await ok<Vault>(get(`/tenant/tenders/${tenderId}/documents`))).documents.find(
          (d) => d.folderId !== null,
        )!.id;
    const latest = await get(`/tenant/documents/${id}/file`);
    expect(latest.statusCode).toBe(200);
    expect(latest.rawPayload.equals(pdf('rev B'))).toBe(true);
    expect(latest.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
    });
    expect(latest.headers['content-disposition']).toContain('attachment; filename="GA plan.pdf"');
    const first = await get(`/tenant/documents/${id}/file?version=1`, worker);
    expect(first.rawPayload.equals(pdf('rev A'))).toBe(true);
    expect(first.headers['content-disposition']).toContain('GA plan (v1).pdf');
    expect((await get(`/tenant/documents/${id}/file?version=9`)).statusCode).toBe(404);
  });

  it('uploads a folder with its sub-folders; restricted documents stay hidden everywhere', async () => {
    const tech = folderNamed('05 Our technical bid').id;
    const cert = await uploaded(tenderId, 'Turnover CA certificate.pdf', pdf('ca'), {
      folderId: tech,
      path: 'Qualification/Financial',
    });
    vault = await ok<Vault>(get(`/tenant/tenders/${tenderId}/documents`));
    const financial = folderNamed('Financial');
    expect(folderNamed('Qualification').parentId).toBe(tech);
    expect(financial.parentId).toBe(folderNamed('Qualification').id);
    expect(cert.document.folderId).toBe(financial.id);
    expect((await upload(tenderId, 'x.pdf', pdf('x'), { path: 'a/../b' })).json()).toMatchObject({
      code: 'bad_path',
    });

    // Workers may upload (documents.edit is theirs by default), but not into a folder they cannot see.
    const price = folderNamed('Price bid workings').id;
    const secret = await uploaded(tenderId, 'Rate build-up.pdf', pdf('margins'), {
      folderId: price,
    });
    expect(
      (await upload(tenderId, 'x.pdf', pdf('x'), { folderId: price }, worker)).statusCode,
    ).toBe(404);
    await uploaded(
      tenderId,
      'Site photo.jpg',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
      {},
      worker,
    );
    expect((await get(`/tenant/documents/${secret.document.id}`, worker)).statusCode).toBe(404);
    expect((await get(`/tenant/documents/${secret.document.id}/file`, worker)).statusCode).toBe(
      404,
    );
    const workerView = await ok<Vault>(get(`/tenant/tenders/${tenderId}/documents`, worker));
    expect(workerView.documents.map((d) => d.name)).not.toContain('Rate build-up.pdf');
    expect(
      (await ok<{ items: Doc[] }>(get('/tenant/documents?q=rate', worker))).items,
    ).toHaveLength(0);
    expect((await ok<{ items: Doc[] }>(get('/tenant/documents?q=rate'))).items).toHaveLength(1);
  });

  it('refuses a file over the limit and an infected file, keeping neither', async () => {
    const before = await readdir(join(docDir, t.tenantId), { recursive: true });
    // Over IMPORT_MAX_MB, under DOCUMENT_MAX_MB: accepted.
    const big = await upload(tenderId, 'Tender drawings set.pdf', pdf('big', Math.round(1.5 * MB)));
    expect(big.statusCode).toBe(200);
    const huge = await upload(tenderId, 'Too big.pdf', pdf('huge', 2 * MB + 10));
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ code: 'file_too_large' });
    const bad = await upload(
      tenderId,
      'invoice.pdf',
      Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
    );
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: 'file_infected' });
    const after = await readdir(join(docDir, t.tenantId), { recursive: true });
    expect(after.filter((f) => !before.includes(f) && /[0-9a-f]{64}$/.test(f))).toHaveLength(1);
    expect(await readdir(join(docDir, t.tenantId, '.tmp'))).toEqual([]);
    const [audit] = await db<{ data: { signature: string } }[]>`
      SELECT data FROM platform.audit_log WHERE action = 'document.infected'`;
    expect(audit!.data.signature).toBe('Win.Test.EICAR_HDB-1');
  });

  it('renames, tags, moves, and puts documents in the trash and back', async () => {
    vault = await ok<Vault>(get(`/tenant/tenders/${tenderId}/documents`));
    const top = vault.documents.find((d) => d.name === 'GA plan.pdf' && d.folderId === null)!;
    const clash = await post(`/tenant/documents/${top.id}`, {
      rowVersion: top.rowVersion,
      folderId: folderNamed('02 Drawings').id,
    });
    expect(clash.json()).toMatchObject({ code: 'document_exists' });
    const moved = await ok<{
      name: string;
      tags: string[];
      rowVersion: number;
      path: { name: string }[];
    }>(
      post(`/tenant/documents/${top.id}`, {
        rowVersion: top.rowVersion,
        name: 'GA plan (client copy).pdf',
        tags: ['Architectural', ' architectural ', 'Rev B'],
        folderId: folderNamed('02 Drawings').id,
      }),
    );
    expect(moved).toMatchObject({
      name: 'GA plan (client copy).pdf',
      tags: ['Architectural', 'Rev B'],
    });
    expect(moved.path.map((p) => p.name)).toEqual(['02 Drawings']);
    expect(
      (
        await post(`/tenant/documents/${top.id}`, { rowVersion: top.rowVersion, description: 'x' })
      ).json(),
    ).toMatchObject({ code: 'stale_row' });

    await ok(post(`/tenant/documents/${top.id}/delete`, {}, worker));
    const afterDelete = await ok<Vault>(get(`/tenant/tenders/${tenderId}/documents`));
    expect(afterDelete.documents.map((d) => d.id)).not.toContain(top.id);
    expect(afterDelete.trashCount).toBe(1);
    const trash = await ok<Doc[]>(get(`/tenant/tenders/${tenderId}/documents/trash`));
    expect(trash.map((d) => d.name)).toEqual(['GA plan (client copy).pdf']);
    // A new document takes the name meanwhile; restoring the old one is refused until one is renamed.
    await uploaded(tenderId, 'GA plan (client copy).pdf', pdf('newer'), {
      folderId: folderNamed('02 Drawings').id,
    });
    expect((await post(`/tenant/documents/${top.id}/restore`)).json()).toMatchObject({
      code: 'document_exists',
    });

    // An empty folder can go; one with documents cannot.
    expect(
      (await post(`/tenant/folders/${folderNamed('02 Drawings').id}/delete`)).json(),
    ).toMatchObject({
      code: 'folder_not_empty',
    });
    vault = await ok<Vault>(post(`/tenant/folders/${folderNamed('09 Site visit').id}/delete`));
    expect(vault.folders.map((f) => f.name)).not.toContain('09 Site visit');
  });

  it('zips a folder with its sub-folders, or the vault, leaving out what the user cannot see', async () => {
    const res = await post(`/tenant/tenders/${tenderId}/documents/zip`, {
      folderId: folderNamed('05 Our technical bid').id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const entries = unzip(res.rawPayload);
    expect([...entries.keys()]).toEqual([
      '05 Our technical bid/Qualification/Financial/Turnover CA certificate.pdf',
    ]);
    expect(entries.values().next().value!.equals(pdf('ca'))).toBe(true);

    const all = unzip((await post(`/tenant/tenders/${tenderId}/documents/zip`)).rawPayload);
    expect([...all.keys()]).toContain('06 Our financial bid/Price bid workings/Rate build-up.pdf');
    expect([...all.keys()]).toContain('02 Drawings/GA plan.pdf');
    const theirs = unzip(
      (await post(`/tenant/tenders/${tenderId}/documents/zip`, {}, worker)).rawPayload,
    );
    expect([...theirs.keys()].some((k) => k.startsWith('06 '))).toBe(false);
    expect(theirs.size).toBe(all.size - 1);
    expect((await post(`/tenant/tenders/${otherTenderId}/documents/zip`)).json()).toMatchObject({
      code: 'nothing_to_zip',
    });
  });

  it('searches across tenders by name, description or tag', async () => {
    await uploaded(otherTenderId, 'Workshop GA plan.pdf', pdf('iti'));
    const hits = await ok<{ items: { name: string; tender: { title: string } }[] }>(
      get('/tenant/documents?q=ga%20plan'),
    );
    expect(hits.items.map((h) => h.tender.title)).toEqual(
      expect.arrayContaining(['District hospital, Washim', 'ITI workshop, Akola']),
    );
    const one = await ok<{ items: { name: string }[] }>(
      get(`/tenant/documents?q=ga%20plan&tenderId=${otherTenderId}`),
    );
    expect(one.items.map((h) => h.name)).toEqual(['Workshop GA plan.pdf']);
    const tagged = await ok<{ items: { name: string }[] }>(get('/tenant/documents?tag=rev%20b'));
    expect(tagged.items).toHaveLength(0); // the tagged document is in the trash
    expect(await ok<string[]>(get('/tenant/document-tags'))).toEqual([]);
  });

  it('takes a new version of a chosen document whatever the new file is called', async () => {
    vault = await ok<Vault>(get(`/tenant/tenders/${tenderId}/documents`));
    const ga = vault.documents.find(
      (d) => d.name === 'GA plan.pdf' && d.folderId === folderNamed('02 Drawings').id,
    )!;
    const res = await uploaded(tenderId, 'GA plan rev C.pdf', pdf('rev C'), { documentId: ga.id });
    expect(res).toMatchObject({
      outcome: 'new_version',
      document: { id: ga.id, name: 'GA plan.pdf', versionNo: 3 },
    });
    const doc = await ok<{ versions: { versionNo: number; originalName: string }[] }>(
      get(`/tenant/documents/${ga.id}`),
    );
    expect(doc.versions[0]).toMatchObject({ versionNo: 3, originalName: 'GA plan rev C.pdf' });
    expect((await upload(otherTenderId, 'x.pdf', pdf('x'), { documentId: ga.id })).statusCode).toBe(
      404,
    );
  });

  it('enforces the documents permission, and the database refuses deletes', async () => {
    await ok(
      post('/tenant/permissions', { role: 'worker', permission: 'documents.edit', granted: false }),
    );
    const res = await upload(tenderId, 'note.txt', Buffer.from('hello'), {}, worker);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ permission: 'documents.edit' });
    // Reading stays open.
    expect((await get(`/tenant/tenders/${tenderId}/documents`, worker)).statusCode).toBe(200);
    await expect(db`DELETE FROM doc.document`).rejects.toThrow(/permission denied/);
    await expect(db`UPDATE doc.document_version SET note = 'x'`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('refuses storage for a tenant whose database is in their own Supabase project', async () => {
    const svc = app.get(DocumentsService);
    await control`UPDATE core.tenant_db SET provider = 'supabase' WHERE tenant_id = ${t.tenantId}`;
    (svc as unknown as { providers: Map<string, string> }).providers.clear();
    try {
      const res = await upload(tenderId, 'x.pdf', pdf('x'));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'storage_not_available' });
    } finally {
      await control`UPDATE core.tenant_db SET provider = 'local_postgres' WHERE tenant_id = ${t.tenantId}`;
      (svc as unknown as { providers: Map<string, string> }).providers.clear();
    }
  });

  describe('step 13: folders moved, company folders, deleting for good, links', () => {
    let tid: string;
    const folders = async (tender = tid, headers = t.admin) =>
      (await ok<Vault>(get(`/tenant/tenders/${tender}/documents`, headers))).folders;
    const mk = async (name: string, parentId: string | null = null, restricted = false) =>
      (
        await ok<Vault>(post(`/tenant/tenders/${tid}/folders`, { name, parentId, restricted }))
      ).folders.find((f) => f.name === name && f.parentId === parentId)!;
    const move = (f: Folder, parentId: string | null) =>
      post(`/tenant/folders/${f.id}`, { rowVersion: f.rowVersion, parentId });
    const fresh = async (f: Folder) => (await folders()).find((x) => x.id === f.id)!;

    beforeAll(async () => {
      tid = (await ok<{ id: string }>(post('/tenant/tenders', { title: 'Court building, Risod' })))
        .id;
    });

    it('moves a folder with everything in it; into a restricted one it becomes restricted', async () => {
      const structure = await mk('Structure');
      const columns = await mk('Columns', structure.id);
      const archive = await mk('Archive');
      const col = await uploaded(tid, 'C1 schedule.pdf', pdf('c1'), { folderId: columns.id });
      await ok(move(structure, archive.id));
      expect((await fresh(structure)).parentId).toBe(archive.id);
      expect((await fresh(columns)).parentId).toBe(structure.id);
      // Not into itself or below itself.
      expect((await move(await fresh(archive), columns.id)).json()).toMatchObject({
        code: 'folder_into_itself',
      });
      expect((await move(await fresh(structure), structure.id)).json()).toMatchObject({
        code: 'folder_into_itself',
      });
      // A name already there is refused.
      await mk('Structure');
      expect((await move(await fresh(structure), null)).json()).toMatchObject({
        code: 'folder_exists',
      });
      // Into a restricted folder: restricted with what is in it, hidden from the worker.
      const money = await mk('Money', null, true);
      await ok(move(await fresh(structure), money.id));
      expect((await fresh(columns)).restricted).toBe(true);
      const seen = await ok<Vault>(get(`/tenant/tenders/${tid}/documents`, worker));
      expect(seen.folders.map((f) => f.name)).not.toContain('Columns');
      expect(seen.documents.map((d) => d.id)).not.toContain(col.document.id);
      // Too deep: a chain 7 deep cannot take a folder with a sub-folder (7 + 2 > 8).
      let parent: Folder | null = null;
      for (let i = 1; i <= 7; i++) parent = await mk(`Level ${i}`, parent?.id ?? null);
      const pair = await mk('Pair');
      await mk('Pair child', pair.id);
      expect((await move(pair, parent!.id)).json()).toMatchObject({ code: 'too_deep' });
      // Workers move folders they see (documents.edit), not into a restricted one they cannot see.
      await ok(
        post('/tenant/permissions', {
          role: 'worker',
          permission: 'documents.edit',
          granted: true,
        }),
      );
      expect((await move(await fresh(pair), money.id)).statusCode).toBe(200);
      expect(
        (
          await post(
            `/tenant/folders/${archive.id}`,
            { rowVersion: (await fresh(archive)).rowVersion, parentId: money.id },
            worker,
          )
        ).json(),
      ).toMatchObject({ code: 'folder_not_found' });
    });

    it("adds the company's own standard folders, nested and restricted; only the admin sets them", async () => {
      const body = {
        folders: [
          { path: 'Tender / Notice', restricted: false },
          { path: 'Tender/Drawings/Structural', restricted: false },
          { path: 'Money', restricted: true },
          { path: 'money/EMD', restricted: false },
        ],
      };
      expect((await post('/tenant/document-settings/folders', body, worker)).statusCode).toBe(403);
      const s = await ok<{
        folders: { path: string; restricted: boolean }[];
        foldersCustomised: boolean;
      }>(post('/tenant/document-settings/folders', body));
      expect(s.foldersCustomised).toBe(true);
      expect(s.folders).toEqual([
        { path: 'Tender', restricted: false },
        { path: 'Tender/Notice', restricted: false },
        { path: 'Tender/Drawings', restricted: false },
        { path: 'Tender/Drawings/Structural', restricted: false },
        { path: 'Money', restricted: true },
        { path: 'Money/EMD', restricted: true },
      ]);
      const other = (
        await ok<{ id: string }>(post('/tenant/tenders', { title: 'Bus stand, Mehkar' }))
      ).id;
      const v = await ok<Vault>(post(`/tenant/tenders/${other}/folders/standard`));
      const byName = new Map(v.folders.map((f) => [f.name, f]));
      expect(byName.get('Structural')!.parentId).toBe(byName.get('Drawings')!.id);
      expect(byName.get('Drawings')!.parentId).toBe(byName.get('Tender')!.id);
      expect(byName.get('EMD')).toMatchObject({
        restricted: true,
        parentId: byName.get('Money')!.id,
      });
      // Again: nothing added twice.
      expect(
        (await ok<Vault>(post(`/tenant/tenders/${other}/folders/standard`))).folders,
      ).toHaveLength(6);
      const deep = { folders: [{ path: 'a/b/c/d/e/f/g/h/i', restricted: false }] };
      expect((await post('/tenant/document-settings/folders', deep)).json()).toMatchObject({
        code: 'bad_folder_template',
      });
      const reset = await ok<{ foldersCustomised: boolean; folders: unknown[] }>(
        post('/tenant/document-settings/folders', { folders: null }),
      );
      expect(reset).toMatchObject({ foldersCustomised: false });
      expect(reset.folders).toHaveLength(9);
    });

    it('deletes for good only from the trash, by the admin or the trash rule; files go when nothing uses them', async () => {
      const life = app.get(DocumentLifecycle);
      const same = pdf('the same bytes in two documents');
      const a = (await uploaded(tid, 'Copy A.pdf', same)).document;
      const b = (await uploaded(tid, 'Copy B.pdf', same)).document;
      const [version] = await db<{ storage_key: string }[]>`
        SELECT storage_key FROM doc.document_version WHERE document_id = ${a.id}`;
      const key = version!.storage_key;
      const file = join(docDir, t.tenantId, key.slice(0, 2), key);

      expect((await post(`/tenant/documents/${a.id}/purge`)).json()).toMatchObject({
        code: 'not_in_trash',
      });
      await ok(post(`/tenant/documents/${a.id}/delete`));
      expect((await post(`/tenant/documents/${a.id}/purge`, {}, worker)).statusCode).toBe(403);
      await ok(post(`/tenant/documents/${a.id}/purge`));
      expect(await db`SELECT 1 FROM doc.document WHERE id = ${a.id}`).toHaveLength(0);
      expect(await db`SELECT 1 FROM doc.document_version WHERE document_id = ${a.id}`).toHaveLength(
        0,
      );
      const [tomb] = await db<{ name: string; reason: string; versions: number }[]>`
        SELECT name, reason, versions FROM doc.purged_document WHERE id = ${a.id}`;
      expect(tomb).toEqual({ name: 'Copy A.pdf', reason: 'manual', versions: 1 });
      // The database function takes nothing that is not in the trash.
      const [live] = await db<
        { ok: boolean }[]
      >`SELECT doc.purge_document(${b.id}, NULL, 'manual') AS ok`;
      expect(live!.ok).toBe(false);

      // Within the hour, files stay; later, the file stays while Copy B still uses it.
      const now = Date.now();
      expect(await life.housekeeping(t.tenantId, new Date(now))).toEqual({
        purged: 0,
        filesRemoved: 0,
      });
      expect(await life.housekeeping(t.tenantId, new Date(now + 2 * 3600_000))).toEqual({
        purged: 0,
        filesRemoved: 0,
      });
      expect(await stat(file)).toBeTruthy();

      // The trash rule: 30 days. Copy B goes to the trash; 31 days later it is gone, and so is the file.
      expect((await post('/tenant/document-settings/trash', { days: 45 })).statusCode).toBe(400);
      await ok(post('/tenant/document-settings/trash', { days: 30 }));
      expect((await ok<Vault>(get(`/tenant/tenders/${tid}/documents`))).trashDays).toBe(30);
      await ok(post(`/tenant/documents/${b.id}/delete`));
      const later = await life.housekeeping(t.tenantId, new Date(now + 31 * 24 * 3600_000));
      expect(later.purged).toBeGreaterThanOrEqual(1);
      expect(later.filesRemoved).toBeGreaterThanOrEqual(1);
      await expect(stat(file)).rejects.toThrow();
      const [rule] = await db<{ reason: string; purged_by: string | null }[]>`
        SELECT reason, purged_by FROM doc.purged_document WHERE id = ${b.id}`;
      expect(rule).toEqual({ reason: 'retention', purged_by: null });
      await ok(post('/tenant/document-settings/trash', { days: null }));

      // Emptying a tender's trash.
      const c = (await uploaded(tid, 'Old draft.pdf', pdf('old draft'))).document;
      await ok(post(`/tenant/documents/${c.id}/delete`));
      expect(
        (await ok<{ purged: number }>(post(`/tenant/tenders/${tid}/documents/trash/empty`))).purged,
      ).toBe(1);
      expect((await ok<Vault>(get(`/tenant/tenders/${tid}/documents`))).trashCount).toBe(0);
    });

    it('links documents to an addendum and a checklist item; the tender shows them', async () => {
      await ok(
        post(`/tenant/tenders/${tid}/addenda`, {
          ref: 'Corrigendum 1',
          issuedOn: '2026-10-01',
          summary: 'Revised drawings for the court hall.',
        }),
      );
      await ok(post(`/tenant/tenders/${tid}/checklist`, { title: 'Solvency certificate' }));
      let work = await ok<{
        addenda: { id: string; documents: { name: string }[] }[];
        checklist: { id: string; title: string; documents: { name: string }[] }[];
      }>(get(`/tenant/tenders/${tid}/work`));
      const corr = (await uploaded(tid, 'Corrigendum 1.pdf', pdf('corrigendum'))).document;
      const solv = (await uploaded(tid, 'Solvency.pdf', pdf('solvency'))).document;
      await ok(
        post(`/tenant/documents/${corr.id}/links`, {
          kind: 'addendum',
          targetId: work.addenda[0]!.id,
        }),
      );
      const item = work.checklist.find((c) => c.title === 'Solvency certificate')!;
      await ok(
        post(`/tenant/documents/${solv.id}/links`, { kind: 'checklist_item', targetId: item.id }),
      );
      work = await ok(get(`/tenant/tenders/${tid}/work`));
      expect(work.addenda[0]!.documents.map((d) => d.name)).toEqual(['Corrigendum 1.pdf']);
      expect(work.checklist.find((c) => c.id === item.id)!.documents.map((d) => d.name)).toEqual([
        'Solvency.pdf',
      ]);
      // A checklist item of another tender is refused.
      expect(
        (
          await post(`/tenant/documents/${solv.id}/links`, {
            kind: 'checklist_item',
            targetId: randomUUID(),
          })
        ).json(),
      ).toMatchObject({ code: 'link_target_not_found' });
    });
    it('finds PDFs by the words inside them, never restricted ones for those who may not see them', async () => {
      const reader = app.get(DocumentText);
      const vault0 = await ok<Vault>(
        post(`/tenant/tenders/${tid}/folders`, { name: 'Price workings', restricted: true }),
      );
      const prices = vault0.folders.find((f) => f.name === 'Price workings')!;
      const spec = (
        await uploaded(
          tid,
          'Technical specifications.pdf',
          textPdf('Section 4: concrete', 'Cement shall be OPC 53 grade conforming to IS 269.'),
        )
      ).document;
      await uploaded(tid, 'Our cement rates.pdf', textPdf('OPC 53 grade at 410 per bag'), {
        folderId: prices.id,
      });
      await reader.idle();
      const detail = await ok<{ versions: { text: { status: string; pages: number } | null }[] }>(
        get(`/tenant/documents/${spec.id}`),
      );
      expect(detail.versions[0]!.text).toMatchObject({ status: 'done', pages: 2 });

      type Found = { items: { id: string; name: string; snippet: string | null }[] };
      const found = await ok<Found>(get('/tenant/documents?q=IS%20269'));
      expect(found.items.map((d) => d.name)).toEqual(['Technical specifications.pdf']);
      expect(found.items[0]!.snippet).toContain('\u0002IS\u0003 \u0002269\u0003');
      // Words, not substrings of words; any order; quoted phrases.
      expect((await ok<Found>(get('/tenant/documents?q=grade%20opc'))).items).toHaveLength(2);
      expect((await ok<Found>(get('/tenant/documents?q=%22grade%20opc%22'))).items).toHaveLength(0);
      // The worker does not find what is in a restricted folder, by name or by text.
      expect(
        (await ok<Found>(get('/tenant/documents?q=grade%20opc', worker))).items.map((d) => d.name),
      ).toEqual(['Technical specifications.pdf']);
      // A name match comes before a text match.
      await uploaded(tid, 'Cement test certificate.pdf', textPdf('Lab report'));
      await reader.idle();
      const both = await ok<Found>(get('/tenant/documents?q=cement'));
      expect(both.items[0]!.name).toBe('Cement test certificate.pdf');
      expect(both.items[0]!.snippet).toBeNull();
      // A file that is not a readable PDF is marked so, and found by its name only.
      const broken = (await uploaded(tid, 'Scanned letter.pdf', pdf('just bytes'))).document;
      await reader.idle();
      const b = await ok<{ versions: { text: { status: string; note: string } | null }[] }>(
        get(`/tenant/documents/${broken.id}`),
      );
      expect(b.versions[0]!.text).toMatchObject({
        status: 'failed',
        note: 'not a PDF that can be read',
      });
    });

    it('keeps a thumbnail made by the browser, only a small picture, served back as that picture', async () => {
      const doc = (await uploaded(tid, 'Site photo.pdf', textPdf('site'))).document;
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64, 1),
      ]);
      const send = (body: Buffer, name = 'thumb.png', headers = t.admin) => {
        const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
        return app.inject({
          method: 'POST',
          url: `/api/tenant/documents/${doc.id}/versions/1/thumbnail`,
          payload: Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
                'Content-Type: application/octet-stream\r\n\r\n',
            ),
            body,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
          headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
      };
      expect((await get(`/tenant/documents/${doc.id}/thumbnail`)).statusCode).toBe(404);
      expect((await send(Buffer.from('<svg onload="alert(1)"/>'), 'x.svg')).json()).toMatchObject({
        code: 'bad_thumbnail',
      });
      expect((await send(Buffer.concat([png, Buffer.alloc(210 * 1024)]))).json()).toMatchObject({
        code: 'bad_thumbnail',
      });
      await ok(send(png));
      const res = await get(`/tenant/documents/${doc.id}/thumbnail`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.rawPayload.equals(png)).toBe(true);
      const v = await ok<Vault>(get(`/tenant/tenders/${tid}/documents`));
      expect(v.documents.find((d) => d.id === doc.id)).toMatchObject({ hasThumbnail: true });
      // A new version has none until a browser makes it.
      await uploaded(tid, 'x.pdf', textPdf('site, again'), { documentId: doc.id });
      expect((await get(`/tenant/documents/${doc.id}/thumbnail`)).statusCode).toBe(404);
    });
  });
});
