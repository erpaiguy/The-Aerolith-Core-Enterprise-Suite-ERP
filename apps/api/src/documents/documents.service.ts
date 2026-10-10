// Tender documents (docs/04-features.md E10, docs/wave1-plan.md step 10): each tender's vault of folders and
// documents, every upload a version, the trash, ZIP downloads and search. Everyone reads; changes need
// `documents.edit`. Restricted folders (our prices, vendor quotes) and what is in them are visible only to roles
// with `pricing.edit`, the same people who see bid pricing; to everyone else they do not exist.
import type { LinkKind } from './links.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import archiver from 'archiver';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  FileMissingError,
  FileTooLargeError,
  LocalFileStore,
  cleanFileName,
  fileType,
  type FileStore,
  type StagedFile,
} from './file-store.js';
import { clamdScan, type ScanResult } from './scanner.js';

/** Folders deep enough for "Drawings / Structural / Revision 2"; deeper trees are usually a copied disk. */
export const MAX_DEPTH = 8;
const MAX_VAULT = 20_000;
const MAX_ZIP = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folders most Indian works tenders need; the commercial ones are restricted. */
export const STANDARD_FOLDERS: { name: string; restricted: boolean }[] = [
  { name: '01 Tender notice and documents', restricted: false },
  { name: '02 Drawings', restricted: false },
  { name: '03 Addenda and corrigenda', restricted: false },
  { name: '04 Pre-bid queries and replies', restricted: false },
  { name: '05 Our technical bid', restricted: false },
  { name: '06 Our financial bid', restricted: true },
  { name: '07 Vendor and subcontractor quotes', restricted: true },
  { name: '08 Correspondence', restricted: false },
  { name: '09 Site visit', restricted: false },
];

export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  restricted: boolean;
  rowVersion: number;
}

export interface DocumentRow {
  id: string;
  folderId: string | null;
  name: string;
  description: string;
  tags: string[];
  versionNo: number;
  rowVersion: number;
  size: number;
  mime: string;
  scanStatus: 'clean' | 'not_scanned';
  uploadedAt: string;
  uploadedBy: string | null;
  deletedAt: string | null;
}

export type UploadOutcome = 'created' | 'new_version' | 'unchanged';

const ZERO = '00000000-0000-0000-0000-000000000000';
const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

/** A folder or file name as typed: trimmed, no slashes, not "." or "..". */
function cleanName(raw: string, max: number, what: 'folder' | 'document'): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name) || name.length > max)
    throw new BadRequestException({
      code: 'bad_name',
      message: `A ${what} name needs 1 to ${max} characters and no slashes.`,
    });
  return name;
}

/** Tags as typed, trimmed, without repeats (ignoring case), at most 20 of 40 characters each. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  if (out.length > 20) throw new BadRequestException({ code: 'too_many_tags' });
  return out;
}

/** "Drawing.pdf" version 2 → "Drawing (v2).pdf": older versions downloaded side by side keep apart. */
export function versionedName(name: string, version: number, latest: number): string {
  if (version === latest) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${name.slice(0, dot)} (v${version})${name.slice(dot)}`
    : `${name} (v${version})`;
}

@Injectable()
export class DocumentsService implements OnApplicationBootstrap {
  private readonly log = new Logger('Documents');
  private readonly providers = new Map<string, string>();

  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get maxBytes() {
    return this.config.documents.maxBytes;
  }

  /** Clears temporary files of uploads cut off by a restart. */
  async onApplicationBootstrap() {
    const dirs = await readdir(this.config.documents.dir).catch(() => [] as string[]);
    for (const d of dirs.filter((x) => UUID.test(x)))
      await new LocalFileStore(join(this.config.documents.dir, d)).sweep(6 * 3600_000);
  }

  /**
   * Where a tenant's files are kept. Tenants on our Postgres (and their own Postgres) keep them in a folder on this
   * server. A tenant whose database is in their own Supabase project is meant to keep them in that project's
   * Storage, which cannot be built and verified until the Supabase connection itself is (docs/tenant-provisioning.md,
   * known gap 1); until then documents are refused for them rather than kept somewhere they did not choose.
   */
  async store(tenantId: string): Promise<FileStore> {
    if (!UUID.test(tenantId)) throw new Error('invalid tenant id');
    let provider = this.providers.get(tenantId);
    if (!provider) {
      const [row] = await this.control<{ provider: string }[]>`
        SELECT provider FROM core.tenant_db WHERE tenant_id = ${tenantId}`;
      provider = row?.provider ?? 'unknown';
      this.providers.set(tenantId, provider);
    }
    if (provider === 'local_postgres' || provider === 'byo_postgres')
      return new LocalFileStore(join(this.config.documents.dir, tenantId));
    throw new ServiceUnavailableException({
      code: 'storage_not_available',
      message:
        'Document storage in your own Supabase project is not switched on yet. Your other data is unaffected.',
    });
  }

  async scan(path: string): Promise<ScanResult> {
    const clamd = this.config.documents.clamd;
    if (!clamd) return { status: 'not_scanned', reason: 'no scanner configured' };
    return clamdScan(path, { ...clamd, timeoutMs: 60_000 });
  }

  private async mayLink(claims: TenantClaims, kind: LinkKind) {
    if (kind === 'rfq_vendor' && !(await this.permissions.can(claims, 'rfq.edit')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'rfq.edit',
        message: 'Linking documents to vendor quotes needs the RFQ permission.',
      });
  }

  private seesRestricted(claims: TenantClaims) {
    return this.permissions.can(claims, 'pricing.edit');
  }

  private async mustHaveTender(db: Sql | TransactionSql, tenderId: string) {
    const [t] = await db<{ number: string; title: string }[]>`
      SELECT number, title FROM tender.tender WHERE id = ${tenderId}`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    return t;
  }

  /** A folder of this tender the user may see (restricted ones do not exist for others), optionally locked. */
  private async folder(
    db: Sql | TransactionSql,
    tenderId: string | null,
    folderId: string,
    see: boolean,
    lock = false,
  ) {
    const [f] = await db<
      {
        id: string;
        tender_id: string;
        parent_id: string | null;
        name: string;
        restricted: boolean;
        row_version: number;
      }[]
    >`
      SELECT id, tender_id, parent_id, name, restricted, row_version FROM doc.folder
      WHERE id = ${folderId} ${tenderId ? db`AND tender_id = ${tenderId}` : db``}
      ${lock ? db`FOR UPDATE` : db``}`;
    if (!f || (f.restricted && !see)) throw new NotFoundException({ code: 'folder_not_found' });
    return f;
  }

  /** How many folders deep a folder is (a top-level folder is 1). */
  private async depth(db: Sql | TransactionSql, folderId: string) {
    const [r] = await db<{ depth: number }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, 1 AS depth FROM doc.folder WHERE id = ${folderId}
        UNION ALL SELECT f.id, f.parent_id, up.depth + 1 FROM doc.folder f JOIN up ON f.id = up.parent_id
      ) SELECT max(depth)::int AS depth FROM up`;
    return r?.depth ?? 0;
  }

  // --- reading ---

  /** The vault of a tender: its folders and live documents (with their latest version), as the user may see them. */
  async vault(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustHaveTender(db, tenderId);
    const see = await this.seesRestricted(claims);
    const [folders, documents, [trash]] = await Promise.all([
      db<FolderRow[]>`
        SELECT id, parent_id AS "parentId", name, restricted, row_version AS "rowVersion" FROM doc.folder
        WHERE tender_id = ${tenderId} ${see ? db`` : db`AND NOT restricted`}
        ORDER BY lower(name)`,
      this.documents(db, tenderId, see, false),
      db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM doc.document d LEFT JOIN doc.folder f ON f.id = d.folder_id
        WHERE d.tender_id = ${tenderId} AND d.deleted_at IS NOT NULL
          ${see ? db`` : db`AND (f.id IS NULL OR NOT f.restricted)`}`,
    ]);
    if (documents.length > MAX_VAULT)
      throw new ConflictException({
        code: 'vault_too_large',
        message: 'This vault is too large to list.',
      });
    return {
      folders,
      documents,
      trashCount: trash!.n,
      canSeeRestricted: see,
      maxBytes: this.config.documents.maxBytes,
    };
  }

  private documents(db: Sql, tenderId: string, see: boolean, deleted: boolean) {
    return db<DocumentRow[]>`
      SELECT d.id, d.folder_id AS "folderId", d.name, d.description, d.tags, d.version_no AS "versionNo",
        d.row_version AS "rowVersion", v.size_bytes::float8 AS size, v.mime, v.scan_status AS "scanStatus",
        v.uploaded_at AS "uploadedAt", u.display_name AS "uploadedBy", d.deleted_at AS "deletedAt"
      FROM doc.document d
      JOIN doc.document_version v ON v.document_id = d.id AND v.version_no = d.version_no
      LEFT JOIN doc.folder f ON f.id = d.folder_id
      LEFT JOIN platform."user" u ON u.id = v.uploaded_by
      WHERE d.tender_id = ${tenderId} AND d.deleted_at IS ${deleted ? db`NOT NULL` : db`NULL`}
        ${see ? db`` : db`AND (f.id IS NULL OR NOT f.restricted)`}
      ORDER BY ${deleted ? db`d.deleted_at DESC` : db`lower(d.name)`} LIMIT ${MAX_VAULT + 1}`;
  }

  async trash(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustHaveTender(db, tenderId);
    return this.documents(db, tenderId, await this.seesRestricted(claims), true);
  }

  /** One document with every version, and the folder path it is in. */
  async get(claims: TenantClaims, documentId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    const d = await this.visibleDocument(db, documentId, see);
    const [versions, path] = await Promise.all([
      db<
        {
          versionNo: number;
          size: number;
          mime: string;
          originalName: string;
          note: string;
          scanStatus: string;
          uploadedAt: string;
          uploadedBy: string | null;
          sha256: string;
        }[]
      >`
        SELECT v.version_no AS "versionNo", v.size_bytes::float8 AS size, v.mime, v.original_name AS "originalName",
          v.note, v.scan_status AS "scanStatus", v.uploaded_at AS "uploadedAt", u.display_name AS "uploadedBy",
          v.storage_key AS sha256
        FROM doc.document_version v LEFT JOIN platform."user" u ON u.id = v.uploaded_by
        WHERE v.document_id = ${documentId} ORDER BY v.version_no DESC`,
      d.folderId
        ? this.folderPath(db, d.folderId)
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    return { ...d, versions, path };
  }

  private async folderPath(db: Sql, folderId: string) {
    return db<{ id: string; name: string }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, name, 1 AS n FROM doc.folder WHERE id = ${folderId}
        UNION ALL SELECT f.id, f.parent_id, f.name, up.n + 1 FROM doc.folder f JOIN up ON f.id = up.parent_id
      ) SELECT id, name FROM up ORDER BY n DESC`;
  }

  private async visibleDocument(
    db: Sql | TransactionSql,
    documentId: string,
    see: boolean,
    lock = false,
  ) {
    const [d] = await db<
      {
        id: string;
        tenderId: string;
        tender: { number: string; title: string };
        folderId: string | null;
        name: string;
        description: string;
        tags: string[];
        versionNo: number;
        rowVersion: number;
        deletedAt: string | null;
        restricted: boolean;
      }[]
    >`
      SELECT d.id, d.tender_id AS "tenderId", json_build_object('number', t.number, 'title', t.title) AS tender,
        d.folder_id AS "folderId", d.name, d.description, d.tags, d.version_no AS "versionNo",
        d.row_version AS "rowVersion", d.deleted_at AS "deletedAt", coalesce(f.restricted, false) AS restricted
      FROM doc.document d JOIN tender.tender t ON t.id = d.tender_id LEFT JOIN doc.folder f ON f.id = d.folder_id
      WHERE d.id = ${documentId} ${lock ? db`FOR UPDATE OF d` : db``}`;
    if (!d || (d.restricted && !see)) throw new NotFoundException({ code: 'document_not_found' });
    return d;
  }

  /**
   * Links a document to what it belongs to, in the same tender: a vendor on an RFQ ("<rfq id>/<party id>"), a
   * checklist item or an addendum. A vendor's quote is part of the enquiry, so it also takes `rfq.edit`.
   */
  async link(claims: TenantClaims, documentId: string, kind: LinkKind, targetId: string) {
    await this.mayLink(claims, kind);
    const db = await this.tenants.forTenant(claims.ten);
    const d = await this.visibleDocument(db, documentId, await this.seesRestricted(claims));
    if (d.deletedAt) throw new ConflictException({ code: 'document_deleted' });
    let tenderOk = false;
    if (kind === 'rfq_vendor') {
      const [rfqId, partyId] = targetId.split('/');
      const [r] =
        /^[0-9a-f-]{36}$/.test(rfqId ?? '') && /^[0-9a-f-]{36}$/.test(partyId ?? '')
          ? await db<{ tender_id: string }[]>`
            SELECT r.tender_id FROM tender.rfq r JOIN tender.rfq_vendor v ON v.rfq_id = r.id
            WHERE r.id = ${rfqId!} AND v.party_id = ${partyId!}`
          : [];
      tenderOk = r?.tender_id === d.tenderId;
    } else if (/^[0-9a-f-]{36}$/.test(targetId)) {
      const [r] = await db<{ tender_id: string }[]>`
        SELECT tender_id FROM ${db(kind === 'checklist_item' ? 'tender.checklist_item' : 'tender.addendum')}
        WHERE id = ${targetId}`;
      tenderOk = r?.tender_id === d.tenderId;
    }
    if (!tenderOk)
      throw new NotFoundException({
        code: 'link_target_not_found',
        message: 'That is not in the same tender as the document.',
      });
    await db.begin(async (tx) => {
      await tx`INSERT INTO doc.document_link (document_id, target_kind, target_id, tender_id, created_by)
        VALUES (${documentId}, ${kind}, ${targetId}, ${d.tenderId}, ${claims.sub}) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'document.link', 'document', ${documentId}, ${tx.json({ kind, targetId })})`;
    });
    return { documentId, kind, targetId };
  }

  async unlink(claims: TenantClaims, documentId: string, kind: LinkKind, targetId: string) {
    await this.mayLink(claims, kind);
    const db = await this.tenants.forTenant(claims.ten);
    await this.visibleDocument(db, documentId, await this.seesRestricted(claims));
    await db.begin(async (tx) => {
      await tx`DELETE FROM doc.document_link
        WHERE document_id = ${documentId} AND target_kind = ${kind} AND target_id = ${targetId}`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'document.unlink', 'document', ${documentId}, ${tx.json({ kind, targetId })})`;
    });
    return { documentId, kind, targetId };
  }

  /** The bytes of one version (the latest by default), named as the document is now. */
  async file(claims: TenantClaims, documentId: string, version: number | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const d = await this.visibleDocument(db, documentId, await this.seesRestricted(claims));
    const no = version ?? d.versionNo;
    const [v] = await db<{ storage_key: string; size: number; mime: string }[]>`
      SELECT storage_key, size_bytes::float8 AS size, mime FROM doc.document_version
      WHERE document_id = ${documentId} AND version_no = ${no}`;
    if (!v) throw new NotFoundException({ code: 'version_not_found' });
    const store = await this.store(claims.ten);
    let stream: Readable;
    try {
      stream = await store.open(v.storage_key);
    } catch (err) {
      if (err instanceof FileMissingError) {
        this.log.error(
          `tenant ${claims.ten}: file ${v.storage_key} of document ${documentId} is missing`,
        );
        throw new NotFoundException({
          code: 'file_missing',
          message: 'The file of this version is missing from storage. Restore it from a backup.',
        });
      }
      throw err;
    }
    return { stream, size: v.size, mime: v.mime, fileName: versionedName(d.name, no, d.versionNo) };
  }

  /** Documents by name, description or tag, across every tender (or one), newest first. */
  async search(
    claims: TenantClaims,
    opts: { q: string | null; tag: string | null; tenderId: string | null; limit: number },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    const pattern = opts.q ? `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await db<
      (DocumentRow & {
        tenderId: string;
        tender: { number: string; title: string };
        folder: string | null;
      })[]
    >`
      SELECT d.id, d.folder_id AS "folderId", f.name AS folder, d.name, d.description, d.tags,
        d.version_no AS "versionNo", d.row_version AS "rowVersion", v.size_bytes::float8 AS size, v.mime,
        v.scan_status AS "scanStatus", v.uploaded_at AS "uploadedAt", u.display_name AS "uploadedBy",
        d.deleted_at AS "deletedAt", d.tender_id AS "tenderId",
        json_build_object('number', t.number, 'title', t.title) AS tender
      FROM doc.document d
      JOIN tender.tender t ON t.id = d.tender_id
      JOIN doc.document_version v ON v.document_id = d.id AND v.version_no = d.version_no
      LEFT JOIN doc.folder f ON f.id = d.folder_id
      LEFT JOIN platform."user" u ON u.id = v.uploaded_by
      WHERE d.deleted_at IS NULL ${see ? db`` : db`AND (f.id IS NULL OR NOT f.restricted)`}
        ${opts.tenderId ? db`AND d.tender_id = ${opts.tenderId}` : db``}
        ${
          pattern
            ? db`AND (d.name ILIKE ${pattern} OR d.description ILIKE ${pattern}
                OR EXISTS (SELECT 1 FROM unnest(d.tags) x WHERE x ILIKE ${pattern}))`
            : db``
        }
        ${opts.tag ? db`AND EXISTS (SELECT 1 FROM unnest(d.tags) x WHERE lower(x) = lower(${opts.tag}))` : db``}
      ORDER BY v.uploaded_at DESC LIMIT ${opts.limit + 1}`;
    return { items: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
  }

  /** Every tag in use, for suggestions. */
  async tags(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<{ tag: string }[]>`
      SELECT DISTINCT ON (lower(tag)) tag FROM doc.document, unnest(tags) tag
      WHERE deleted_at IS NULL ORDER BY lower(tag) LIMIT 500`;
    return rows.map((r) => r.tag);
  }

  // --- folders ---

  async createFolder(
    claims: TenantClaims,
    tenderId: string,
    input: { parentId: string | null; name: string; restricted: boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    if (input.restricted && !see) throw restrictedNeedsPricing();
    const name = cleanName(input.name, 120, 'folder');
    await db.begin(async (tx) => {
      await this.mustHaveTender(tx, tenderId);
      let restricted = input.restricted;
      if (input.parentId) {
        const parent = await this.folder(tx, tenderId, input.parentId, see);
        if ((await this.depth(tx, parent.id)) >= MAX_DEPTH) throw tooDeep();
        restricted ||= parent.restricted;
      }
      try {
        const [f] = await tx<{ id: string }[]>`
          INSERT INTO doc.folder (tender_id, parent_id, name, restricted, created_by, updated_by)
          VALUES (${tenderId}, ${input.parentId}, ${name}, ${restricted}, ${claims.sub}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'folder.create', 'folder', f!.id, {
          tenderId,
          name,
          restricted,
        });
      } catch (err) {
        if (isUnique(err)) throw folderExists();
        throw err;
      }
    });
    return this.vault(claims, tenderId);
  }

  /** Adds the standard folders a tender does not have yet. */
  async standardFolders(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.mustHaveTender(tx, tenderId);
      for (const f of STANDARD_FOLDERS)
        await tx`
          INSERT INTO doc.folder (tender_id, parent_id, name, restricted, created_by, updated_by)
          VALUES (${tenderId}, NULL, ${f.name}, ${f.restricted}, ${claims.sub}, ${claims.sub})
          ON CONFLICT DO NOTHING`;
      await audit(tx, claims.sub, 'folder.standard', 'tender', tenderId, {});
    });
    return this.vault(claims, tenderId);
  }

  /**
   * Renames a folder, or restricts it (with everything under it) or lifts the restriction. Only roles that see
   * restricted folders may change the restriction; a folder inside a restricted one stays restricted.
   */
  async updateFolder(
    claims: TenantClaims,
    folderId: string,
    input: { rowVersion: number; name?: string | undefined; restricted?: boolean | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    if (input.restricted !== undefined && !see) throw restrictedNeedsPricing();
    const tenderId = await db.begin(async (tx) => {
      const f = await this.folder(tx, null, folderId, see, true);
      if (f.row_version !== input.rowVersion) throw stale();
      if (input.name !== undefined) {
        const name = cleanName(input.name, 120, 'folder');
        try {
          await tx`UPDATE doc.folder SET name = ${name} WHERE id = ${folderId}`;
        } catch (err) {
          if (isUnique(err)) throw folderExists();
          throw err;
        }
      }
      if (input.restricted !== undefined && input.restricted !== f.restricted) {
        if (!input.restricted && f.parent_id) {
          const [p] = await tx<{ restricted: boolean }[]>`
            SELECT restricted FROM doc.folder WHERE id = ${f.parent_id}`;
          if (p?.restricted)
            throw new ConflictException({
              code: 'parent_restricted',
              message: 'The folder it is in is restricted; lift that one instead.',
            });
        }
        await tx`
          WITH RECURSIVE down AS (
            SELECT id FROM doc.folder WHERE id = ${folderId}
            UNION ALL SELECT c.id FROM doc.folder c JOIN down ON c.parent_id = down.id
          ) UPDATE doc.folder SET restricted = ${input.restricted} WHERE id IN (SELECT id FROM down)`;
      }
      await tx`UPDATE doc.folder SET updated_at = now(), updated_by = ${claims.sub},
        row_version = row_version + 1 WHERE id = ${folderId}`;
      await audit(tx, claims.sub, 'folder.update', 'folder', folderId, {
        from: { name: f.name, restricted: f.restricted },
        name: input.name,
        restricted: input.restricted,
      });
      return f.tender_id;
    });
    return this.vault(claims, tenderId);
  }

  /** Removes an empty folder. Documents in the trash that were in it go back to the top level when restored. */
  async deleteFolder(claims: TenantClaims, folderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    const tenderId = await db.begin(async (tx) => {
      const f = await this.folder(tx, null, folderId, see, true);
      const [busy] = await tx`
        SELECT 1 FROM doc.folder WHERE parent_id = ${folderId}
        UNION ALL SELECT 1 FROM doc.document WHERE folder_id = ${folderId} AND deleted_at IS NULL LIMIT 1`;
      if (busy)
        throw new ConflictException({
          code: 'folder_not_empty',
          message: 'Move or remove what is in the folder first.',
        });
      await tx`UPDATE doc.document SET folder_id = NULL WHERE folder_id = ${folderId}`;
      await tx`DELETE FROM doc.folder WHERE id = ${folderId}`;
      await audit(tx, claims.sub, 'folder.delete', 'folder', folderId, { name: f.name });
      return f.tender_id;
    });
    return this.vault(claims, tenderId);
  }

  // --- documents ---

  /**
   * Uploads one file into a folder (or the top level), optionally under sub-folders given by `path` (an uploaded
   * folder's own structure, created as needed). A file with the name of a live document in that folder is a new
   * version of it; the same content again changes nothing.
   */
  async upload(
    claims: TenantClaims,
    tenderId: string,
    input: {
      folderId: string | null;
      path: string | null;
      note: string;
      documentId?: string | null;
    },
    file: { name: string; stream: Readable; truncated: () => boolean },
  ): Promise<{
    outcome: UploadOutcome;
    document: { id: string; name: string; folderId: string | null; versionNo: number };
  }> {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    const name = cleanFileName(file.name);
    if (!name)
      throw new BadRequestException({ code: 'bad_name', message: 'The file has no name.' });
    const segments = (input.path ?? '')
      .split(/[/\\]/)
      .map((s) => s.trim())
      .filter((s) => s && s !== '.');
    if (segments.some((s) => s === '..'))
      throw new BadRequestException({
        code: 'bad_path',
        message: 'A folder path cannot go up ("..").',
      });
    const folders = segments.map((s) => cleanName(s, 120, 'folder'));
    await this.mustHaveTender(db, tenderId);
    // A new version of a chosen document, whatever the new file is called ("GA plan rev C.pdf").
    const target = input.documentId ? await this.visibleDocument(db, input.documentId, see) : null;
    if (target && (target.tenderId !== tenderId || target.deletedAt))
      throw new NotFoundException({ code: 'document_not_found' });
    if (target && folders.length)
      throw new BadRequestException({
        code: 'bad_path',
        message: 'A new version has no folder path.',
      });
    if (input.folderId) {
      const f = await this.folder(db, tenderId, input.folderId, see);
      if ((await this.depth(db, f.id)) + folders.length > MAX_DEPTH) throw tooDeep();
    } else if (folders.length > MAX_DEPTH) throw tooDeep();

    const store = await this.store(claims.ten);
    let staged: StagedFile;
    try {
      staged = await store.stage(file.stream, this.config.documents.maxBytes);
    } catch (err) {
      if (err instanceof FileTooLargeError) throw tooLarge(this.config.documents.maxBytes);
      throw err;
    }
    if (file.truncated()) {
      await store.discard(staged);
      throw tooLarge(this.config.documents.maxBytes);
    }
    const scan = await this.scan(staged.path);
    if (scan.status === 'infected') {
      await store.discard(staged);
      await db.begin((tx) =>
        audit(tx, claims.sub, 'document.infected', 'tender', tenderId, {
          name,
          signature: scan.signature,
        }),
      );
      throw new UnprocessableEntityException({
        code: 'file_infected',
        message: `The virus scanner found ${scan.signature} in this file; it was not kept.`,
      });
    }
    if (scan.status === 'not_scanned' && this.config.documents.clamd)
      this.log.warn(`tenant ${claims.ten}: ${name} kept without a scan: ${scan.reason}`);
    const mime = fileType(staged.head, name);
    // Kept before its row is written: a row never points at a missing file. A failed write leaves an unused file,
    // which is harmless (named by content).
    const key = await store.commit(staged);
    const write = () =>
      db.begin(async (tx) => {
        let folderId = target ? target.folderId : input.folderId;
        let restricted = false;
        if (folderId) restricted = (await this.folder(tx, tenderId, folderId, see)).restricted;
        for (const segment of folders) {
          await tx`
            INSERT INTO doc.folder (tender_id, parent_id, name, restricted, created_by, updated_by)
            VALUES (${tenderId}, ${folderId}, ${segment}, ${restricted}, ${claims.sub}, ${claims.sub})
            ON CONFLICT DO NOTHING`;
          const [f] = await tx<{ id: string; restricted: boolean }[]>`
            SELECT id, restricted FROM doc.folder WHERE tender_id = ${tenderId}
              AND coalesce(parent_id, ${ZERO}::uuid) = coalesce(${folderId}::uuid, ${ZERO}::uuid)
              AND lower(name) = lower(${segment})`;
          if (!f || (f.restricted && !see))
            throw new NotFoundException({ code: 'folder_not_found' });
          folderId = f.id;
          restricted = f.restricted;
        }
        const [existing] = await tx<
          { id: string; name: string; version_no: number; storage_key: string }[]
        >`
          SELECT d.id, d.name, d.version_no, v.storage_key FROM doc.document d
          JOIN doc.document_version v ON v.document_id = d.id AND v.version_no = d.version_no
          WHERE d.tender_id = ${tenderId} AND d.deleted_at IS NULL
            ${
              target
                ? tx`AND d.id = ${target.id}`
                : tx`AND coalesce(d.folder_id, ${ZERO}::uuid) = coalesce(${folderId}::uuid, ${ZERO}::uuid)
                  AND lower(d.name) = lower(${name})`
            }
          FOR UPDATE OF d`;
        if (target && !existing) throw new NotFoundException({ code: 'document_not_found' });
        const version = {
          storage_key: key,
          size_bytes: staged.size,
          mime,
          original_name: name,
          note: input.note,
          scan_status: scan.status === 'clean' ? 'clean' : 'not_scanned',
          uploaded_by: claims.sub,
        };
        if (existing?.storage_key === key)
          return {
            outcome: 'unchanged' as const,
            document: {
              id: existing.id,
              name: existing.name,
              folderId,
              versionNo: existing.version_no,
            },
          };
        if (existing) {
          const no = existing.version_no + 1;
          await tx`INSERT INTO doc.document_version ${tx({ ...version, document_id: existing.id, version_no: no })}`;
          await tx`UPDATE doc.document SET version_no = ${no}, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1 WHERE id = ${existing.id}`;
          await audit(tx, claims.sub, 'document.version', 'document', existing.id, {
            name: existing.name,
            version: no,
            size: staged.size,
          });
          return {
            outcome: 'new_version' as const,
            document: { id: existing.id, name: existing.name, folderId, versionNo: no },
          };
        }
        const [d] = await tx<{ id: string }[]>`
          INSERT INTO doc.document (tender_id, folder_id, name, created_by, updated_by)
          VALUES (${tenderId}, ${folderId}, ${name}, ${claims.sub}, ${claims.sub}) RETURNING id`;
        await tx`INSERT INTO doc.document_version ${tx({ ...version, document_id: d!.id, version_no: 1 })}`;
        await audit(tx, claims.sub, 'document.upload', 'document', d!.id, {
          tenderId,
          name,
          size: staged.size,
          restricted,
        });
        return {
          outcome: 'created' as const,
          document: { id: d!.id, name, folderId, versionNo: 1 },
        };
      });
    try {
      return await write();
    } catch (err) {
      // Two uploads of the same new name at once: the second becomes a version of the first.
      if (isUnique(err)) return write();
      throw err;
    }
  }

  async update(
    claims: TenantClaims,
    documentId: string,
    input: {
      rowVersion: number;
      name?: string | undefined;
      description?: string | undefined;
      tags?: string[] | undefined;
      folderId?: string | null | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    await db.begin(async (tx) => {
      const d = await this.visibleDocument(tx, documentId, see, true);
      if (d.rowVersion !== input.rowVersion) throw stale();
      if (d.deletedAt) throw inTrash();
      if (input.folderId) await this.folder(tx, d.tenderId, input.folderId, see);
      const cols = Object.fromEntries(
        Object.entries({
          name: input.name === undefined ? undefined : cleanName(input.name, 255, 'document'),
          description: input.description,
          tags: input.tags === undefined ? undefined : cleanTags(input.tags),
          folder_id: input.folderId,
        }).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      try {
        await tx`UPDATE doc.document SET ${tx(cols)}, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1 WHERE id = ${documentId}`;
      } catch (err) {
        if (isUnique(err)) throw documentExists();
        throw err;
      }
      await audit(tx, claims.sub, 'document.update', 'document', documentId, {
        from: { name: d.name, folderId: d.folderId },
        ...cols,
      });
    });
    return this.get(claims, documentId);
  }

  /** Moves a document to the trash (kept, with every version; restorable). */
  async remove(claims: TenantClaims, documentId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    await db.begin(async (tx) => {
      const d = await this.visibleDocument(tx, documentId, see, true);
      if (d.deletedAt) return;
      await tx`UPDATE doc.document SET deleted_at = now(), deleted_by = ${claims.sub}, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${documentId}`;
      await audit(tx, claims.sub, 'document.delete', 'document', documentId, { name: d.name });
    });
    return this.get(claims, documentId);
  }

  async restore(claims: TenantClaims, documentId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const see = await this.seesRestricted(claims);
    await db.begin(async (tx) => {
      const d = await this.visibleDocument(tx, documentId, see, true);
      if (!d.deletedAt) return;
      try {
        await tx`UPDATE doc.document SET deleted_at = NULL, deleted_by = NULL, updated_at = now(),
          updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${documentId}`;
      } catch (err) {
        if (isUnique(err))
          throw new ConflictException({
            code: 'document_exists',
            message:
              'A document with this name is in that folder now. Rename or move that one first.',
          });
        throw err;
      }
      await audit(tx, claims.sub, 'document.restore', 'document', documentId, { name: d.name });
    });
    return this.get(claims, documentId);
  }

  /**
   * A ZIP of the latest versions: a folder with everything under it, chosen documents, or the whole vault. Paths in
   * the ZIP follow the folders. Entries are added one at a time, so only one file is open however many there are.
   */
  async zip(
    claims: TenantClaims,
    tenderId: string,
    input: { folderId: string | null; documentIds: string[] | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const tender = await this.mustHaveTender(db, tenderId);
    const vault = await this.vault(claims, tenderId);
    const byId = new Map(vault.folders.map((f) => [f.id, f]));
    const pathOf = (folderId: string | null, stopAt: string | null): string[] => {
      const parts: string[] = [];
      for (let id = folderId; id && id !== stopAt; id = byId.get(id)?.parentId ?? null)
        parts.unshift(byId.get(id)?.name ?? '');
      return parts;
    };
    let docs: DocumentRow[] = [...vault.documents];
    let base: string | null = null;
    let zipName = `${tender.number} documents`;
    if (input.folderId) {
      const root = byId.get(input.folderId);
      if (!root) throw new NotFoundException({ code: 'folder_not_found' });
      const inside = (id: string | null): boolean =>
        id === root.id || (id !== null && inside(byId.get(id)?.parentId ?? null));
      docs = docs.filter((d) => inside(d.folderId));
      base = root.parentId;
      zipName = `${tender.number} ${root.name}`;
    } else if (input.documentIds) {
      const wanted = new Set(input.documentIds);
      docs = docs.filter((d) => wanted.has(d.id));
    }
    if (docs.length === 0)
      throw new BadRequestException({
        code: 'nothing_to_zip',
        message: 'There is nothing to download.',
      });
    if (docs.length > MAX_ZIP)
      throw new BadRequestException({
        code: 'too_many_files',
        message: `Download at most ${MAX_ZIP} files at once; choose a folder.`,
      });
    const keys = new Map(
      (
        await db<{ document_id: string; storage_key: string }[]>`
          SELECT v.document_id, v.storage_key FROM doc.document_version v JOIN doc.document d
            ON d.id = v.document_id AND d.version_no = v.version_no
          WHERE v.document_id = ANY(${docs.map((d) => d.id)}::uuid[])`
      ).map((r) => [r.document_id, r.storage_key]),
    );
    const store = await this.store(claims.ten);
    const items = docs.map((d) => ({
      key: keys.get(d.id)!,
      name: [...pathOf(d.folderId, base), d.name].join('/'),
      date: new Date(d.uploadedAt),
    }));
    const archive = archiver('zip', { zlib: { level: 1 } });
    let next = 0;
    const addNext = async () => {
      const item = items[next++];
      if (!item) return void archive.finalize();
      archive.append(await store.open(item.key), { name: item.name, date: item.date });
    };
    archive.on('entry', () => void addNext().catch((err: Error) => archive.emit('error', err)));
    void addNext().catch((err: Error) => archive.emit('error', err));
    await db.begin((tx) =>
      audit(tx, claims.sub, 'document.zip', 'tender', tenderId, {
        files: items.length,
        folderId: input.folderId,
      }),
    );
    return { stream: archive as unknown as Readable, fileName: `${zipName}.zip` };
  }
}

const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this. Reload to see their changes.',
  });
const tooDeep = () =>
  new BadRequestException({
    code: 'too_deep',
    message: `Folders go at most ${MAX_DEPTH} levels deep.`,
  });
const folderExists = () =>
  new ConflictException({
    code: 'folder_exists',
    message: 'A folder with this name is already there.',
  });
const documentExists = () =>
  new ConflictException({
    code: 'document_exists',
    message: 'A document with this name is already in that folder.',
  });
const inTrash = () =>
  new ConflictException({
    code: 'document_deleted',
    message: 'This document is in the trash. Restore it first.',
  });
const restrictedNeedsPricing = () =>
  new ForbiddenException({
    code: 'forbidden',
    permission: 'pricing.edit',
    message: 'Only roles that see bid pricing can restrict folders.',
  });
const tooLarge = (max: number) =>
  new PayloadTooLargeException({
    code: 'file_too_large',
    message: `A document can be at most ${Math.round(max / 1024 / 1024)} MB.`,
  });
