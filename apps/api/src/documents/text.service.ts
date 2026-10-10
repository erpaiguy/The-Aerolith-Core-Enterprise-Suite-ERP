// The PDF text reader's queue (docs/wave1-plan.md step 13 part 7). Each PDF version uploaded is a row in
// doc.version_text, read in the background: straight after the upload in this process, and by the hourly
// housekeeping for anything left (a restart, another API process's upload, PDFs from before this feature). One file
// at a time per process, so reading never crowds out requests. A row is claimed with SKIP LOCKED, so two processes
// never read the same file; one claimed by a process that died is taken again after ten minutes, three times at most.
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Sql } from 'postgres';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { DocumentsService } from './documents.service.js';
import { PdfTextError, readPdfText } from './pdf-text.js';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

@Injectable()
export class DocumentText implements OnModuleDestroy {
  private readonly log = new Logger('Documents');
  /** Tenants with PDFs waiting, read one after another. */
  private readonly queued = new Set<string>();
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly tenants: TenantConnections,
    private readonly docs: DocumentsService,
  ) {
    docs.onPdfUploaded = (tenantId) => this.kick(tenantId);
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.draining;
  }

  /** Reads the tenant's waiting PDFs soon, in this process. */
  kick(tenantId: string) {
    this.queued.add(tenantId);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /** Waits until everything kicked so far is read (tests). */
  async idle() {
    while (this.draining) await this.draining;
  }

  private async drain() {
    while (!this.stopped) {
      const [tenantId] = this.queued;
      if (!tenantId) return;
      this.queued.delete(tenantId);
      try {
        await this.readAll(tenantId);
      } catch (err) {
        this.log.warn(`Reading PDFs failed for ${tenantId}: ${(err as Error).message}`);
      }
    }
  }

  /** Reads every waiting PDF of a tenant; returns how many were read (done, skipped or failed). */
  async readAll(tenantId: string): Promise<number> {
    const db = await this.tenants.forTenant(tenantId);
    let n = 0;
    while (!this.stopped && (await this.readOne(tenantId, db))) n++;
    return n;
  }

  private async readOne(tenantId: string, db: Sql): Promise<boolean> {
    const [job] = await db<
      {
        document_id: string;
        version_no: number;
        attempts: number;
        storage_key: string;
        size_bytes: string;
      }[]
    >`
      WITH next AS (
        SELECT document_id, version_no FROM doc.version_text
        WHERE status = 'pending' OR (status = 'working' AND claimed_at < now() - interval '10 minutes')
        ORDER BY status DESC, document_id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE doc.version_text t SET status = 'working', claimed_at = now(), attempts = t.attempts + 1
      FROM next, doc.document_version v
      WHERE t.document_id = next.document_id AND t.version_no = next.version_no
        AND v.document_id = t.document_id AND v.version_no = t.version_no
      RETURNING t.document_id, t.version_no, t.attempts, v.storage_key, v.size_bytes::text`;
    if (!job) return false;
    const finish = (
      status: 'done' | 'failed' | 'skipped',
      fields: { pages?: number; text?: string; note?: string },
    ) =>
      db`UPDATE doc.version_text SET status = ${status}, pages = ${fields.pages ?? null},
        text = ${fields.text ?? null}, note = ${fields.note ?? null}, extracted_at = now()
        WHERE document_id = ${job.document_id} AND version_no = ${job.version_no}`;
    if (job.attempts > MAX_ATTEMPTS) {
      await finish('failed', { note: 'gave up after three tries' });
      return true;
    }
    if (Number(job.size_bytes) > MAX_BYTES) {
      await finish('skipped', { note: 'larger than 100 MB' });
      return true;
    }
    const path = await (await this.docs.store(tenantId)).localPath(job.storage_key);
    if (!path) {
      await finish('failed', { note: 'file not found' });
      return true;
    }
    try {
      const { pages, text } = await readPdfText(path);
      await finish('done', { pages, text });
    } catch (err) {
      const e = err as Error;
      if (e instanceof PdfTextError && !e.final && job.attempts < MAX_ATTEMPTS)
        await db`UPDATE doc.version_text SET status = 'pending', note = ${e.message}
          WHERE document_id = ${job.document_id} AND version_no = ${job.version_no}`;
      else await finish('failed', { note: e.message.slice(0, 300) });
    }
    return true;
  }
}
