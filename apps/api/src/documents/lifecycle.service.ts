// Documents deleted for good (docs/wave1-plan.md step 13 part 6). Until now nothing left the trash; the admin may now
// delete a document in the trash for good, empty a tender's trash, or set how many days the trash keeps documents.
// The database deletes only through doc.purge_document (migration 0020), which takes nothing but a trashed document
// and records what went. Files are removed afterwards, hourly, once no version in the tenant uses them, and never
// within an hour of being kept or reused (an upload of the same bytes may be about to point at them). The same hourly
// round reads PDFs whose text is still waiting (text.service.ts).
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  KEY,
  TRASH_DAYS,
  folderTemplate,
  normaliseTemplate,
  trashDays,
  type FolderTemplate,
} from './document-settings.js';
import { DocumentsService } from './documents.service.js';
import { DocumentText } from './text.service.js';

const HOUR = 3600_000;
const BATCH = 100;

@Injectable()
export class DocumentLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Documents');
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly tenants: TenantConnections,
    private readonly docs: DocumentsService,
    private readonly text: DocumentText,
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.documents.janitor) return;
    this.timer = setInterval(() => void this.janitor(), HOUR);
    this.timer.unref();
    // Soon after a start too: PDFs uploaded just before a restart, or before text search existed, get read.
    this.first = setTimeout(() => void this.janitor(), 60_000);
    this.first.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    clearTimeout(this.first);
  }

  // --- settings (admin) ---

  async settings(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const { folders, customised } = await folderTemplate(db);
    return { folders, foldersCustomised: customised, trashDays: await trashDays(db) };
  }

  /** The company's standard folders; null goes back to the built-in ones. */
  async setFolders(claims: TenantClaims, folders: FolderTemplate[] | null) {
    const value = folders === null ? null : normaliseTemplate(folders);
    if (value?.length === 0)
      throw new BadRequestException({ code: 'bad_folder_template', message: 'Add a folder.' });
    await this.save(claims, KEY.folders, value);
    return this.settings(claims);
  }

  /** How many days the trash keeps a document; null: for ever. */
  async setTrashDays(claims: TenantClaims, days: number | null) {
    if (days !== null && !(TRASH_DAYS as readonly number[]).includes(days))
      throw new BadRequestException({ code: 'bad_trash_days' });
    await this.save(claims, KEY.trashDays, days);
    return this.settings(claims);
  }

  private async save(claims: TenantClaims, key: string, value: unknown) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      if (value === null) await tx`DELETE FROM platform.setting WHERE key = ${key}`;
      else
        await tx`INSERT INTO platform.setting (key, value) VALUES (${key}, ${tx.json(value as never)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      await audit(tx, claims.sub, 'setting.set', 'setting', key, { reset: value === null });
    });
  }

  // --- deleting for good (admin) ---

  async purge(claims: TenantClaims, documentId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [d] = await tx<{ deleted: boolean; tender_id: string; name: string }[]>`
        SELECT deleted_at IS NOT NULL AS deleted, tender_id, name FROM doc.document WHERE id = ${documentId}`;
      if (!d) throw new NotFoundException({ code: 'document_not_found' });
      if (!d.deleted)
        throw new ConflictException({
          code: 'not_in_trash',
          message: 'Only a document in the trash can be deleted for good.',
        });
      await tx`SELECT doc.purge_document(${documentId}, ${claims.sub}, 'manual')`;
      await audit(tx, claims.sub, 'document.purge', 'document', documentId, {
        tenderId: d.tender_id,
        name: d.name,
      });
    });
    return { purged: 1 };
  }

  /** Deletes for good everything in a tender's trash. */
  async emptyTrash(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const purged = await db.begin(async (tx) => {
      const ids = await tx<{ id: string }[]>`
        SELECT id FROM doc.document WHERE tender_id = ${tenderId} AND deleted_at IS NOT NULL`;
      for (const { id } of ids) await tx`SELECT doc.purge_document(${id}, ${claims.sub}, 'manual')`;
      await audit(tx, claims.sub, 'document.empty_trash', 'tender', tenderId, {
        documents: ids.length,
      });
      return ids.length;
    });
    return { purged };
  }

  // --- housekeeping ---

  /**
   * One tenant's housekeeping: documents in the trash longer than the company keeps them are deleted for good, and
   * files of documents deleted for good over an hour ago are removed when nothing else uses them.
   */
  async housekeeping(tenantId: string, now = new Date()) {
    const db = await this.tenants.forTenant(tenantId);
    let purged = 0;
    const days = await trashDays(db);
    if (days !== null) {
      const cutoff = new Date(now.getTime() - days * 24 * HOUR);
      for (;;) {
        const n = await db.begin(async (tx) => {
          const ids = await tx<{ id: string }[]>`
            SELECT id FROM doc.document WHERE deleted_at < ${cutoff} ORDER BY deleted_at LIMIT ${BATCH}`;
          for (const { id } of ids) await tx`SELECT doc.purge_document(${id}, NULL, 'retention')`;
          return ids.length;
        });
        purged += n;
        if (n < BATCH) break;
      }
    }
    let filesRemoved = 0;
    const done = await db<{ id: string; storage_keys: string[] }[]>`
      SELECT id, storage_keys FROM doc.purged_document
      WHERE files_checked_at IS NULL AND purged_at < ${new Date(now.getTime() - HOUR)}
      ORDER BY purged_at LIMIT 1000`;
    if (done.length) {
      const store = await this.docs.store(tenantId);
      const keys = [...new Set(done.flatMap((d) => d.storage_keys))];
      const used = new Set(
        (
          await db<{ storage_key: string }[]>`
            SELECT DISTINCT storage_key FROM doc.document_version WHERE storage_key = ANY(${keys})
            UNION SELECT storage_key FROM proj.dr_photo WHERE storage_key = ANY(${keys})`
        ).map((r) => r.storage_key),
      );
      for (const k of keys.filter((k) => !used.has(k)))
        if (await store.remove(k, HOUR, now.getTime())) filesRemoved++;
      await db`UPDATE doc.purged_document SET files_checked_at = ${now} WHERE id = ANY(${done.map((d) => d.id)})`;
    }
    return { purged, filesRemoved };
  }

  private async janitor() {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.control<{ tenant_id: string }[]>`
        SELECT tenant_id FROM core.tenant_db
        WHERE status = 'ready' AND provider IN ('local_postgres', 'byo_postgres')`;
      for (const { tenant_id } of tenants) {
        try {
          const r = await this.housekeeping(tenant_id);
          this.text.kick(tenant_id);
          if (r.purged || r.filesRemoved)
            this.log.log(
              `tenant ${tenant_id}: ${r.purged} document(s) deleted for good by the trash rule, ${r.filesRemoved} file(s) removed`,
            );
        } catch (err) {
          this.log.warn(`Document housekeeping failed for ${tenant_id}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.log.warn(`Document housekeeping failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
