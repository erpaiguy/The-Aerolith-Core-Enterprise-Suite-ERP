// Backups, the restore check and the audit export (docs/wave8-plan.md step 8g.2). A company's admin sets the nightly
// hour and how many to keep; an hourly loop takes each company's backup once a day after that hour, then proves it
// by restoring it into a scratch database (when this server runs its own Postgres), and drops the oldest past the
// count kept. Files live on the server's backup volume, one folder per tenant; the records are in the tenant's own
// database. The audit export is a ZIP of CSVs of the books and their supporting records, with a trial balance.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import archiver from 'archiver';
import postgres, { type Sql } from 'postgres';
import { LedgerService } from '../accounts/ledger.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { migrate, quoteIdent, TENANT_MIGRATIONS } from '../db/migrate.js';
import { OWNER_GROUP } from '../provisioning/bootstrap.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { dumpDatabase, qname, restoreDatabase } from './dump.js';
import { exclusively, LOOP_LOCK } from '../common/loop-lock.js';

const HOUR = 3_600_000;
/** A backup still "running" after this long died with its process. */
const STALE_MS = 6 * HOUR;

/** The IST date and hour of an instant. */
export function istClock(at: Date) {
  const ist = new Date(at.getTime() + 330 * 60_000);
  return { day: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

/** Whether the nightly backup is due: on, past its hour today (IST), and none taken since that hour. */
export function backupDue(
  s: { enabled: boolean; hour: number },
  lastStarted: Date | null,
  now: Date,
): boolean {
  if (!s.enabled) return false;
  const { day, hour } = istClock(now);
  if (hour < s.hour) return false;
  const since = new Date(`${day}T${String(s.hour).padStart(2, '0')}:00:00+05:30`);
  return !lastStarted || lastStarted < since;
}

// What auditors get: the books, their documents, payroll, assets and the audit trail; never secrets (sessions,
// password hashes, keys, webhook secrets) or stored files. Binary columns are left out.
const AUDIT_SCHEMAS = ['acc', 'pay', 'hr', 're', 'proc', 'proj', 'est', 'tender'];
const AUDIT_PLATFORM = [
  'entity',
  'party',
  'party_trade',
  'audit_log',
  'approval_request',
  'approval_event',
  'unit',
];
const USERS_SQL = `SELECT id, username, display_name, role, status, mfa_enabled_at IS NOT NULL AS two_factor, last_login_at, created_at FROM platform."user" ORDER BY username`;

export type Settings = { enabled: boolean; hour: number; keep: number };
export interface BackupRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  trigger: 'schedule' | 'manual';
  takenBy: string | null;
  fileName: string | null;
  bytes: string | null;
  tables: number | null;
  rows: string | null;
  error: string | null;
  checkedAt: string | null;
  checkOk: boolean | null;
  checkNote: string | null;
}

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Backups');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly tenants: TenantConnections,
    private readonly ledger: LedgerService,
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.backup.worker) return;
    this.timer = setInterval(() => void this.tick(), HOUR);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private admin(claims: TenantClaims) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only an admin can see or take backups.',
      });
  }

  /** Whether this server can prove a backup by restoring it (it runs the tenants' Postgres itself). */
  get canCheck() {
    return this.config.localPgAdminUrl !== null;
  }

  private async settingsOf(db: Sql): Promise<Settings> {
    const [s] = await db<Settings[]>`SELECT enabled, hour, keep FROM platform.backup_setting`;
    return s ?? { enabled: true, hour: 2, keep: 14 };
  }

  // --- the screen ---

  async overview(claims: TenantClaims) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const backups = await db<BackupRow[]>`
      SELECT b.id, b.started_at AS "startedAt", b.finished_at AS "finishedAt", b.status, b.trigger,
        u.display_name AS "takenBy", b.file_name AS "fileName", b.bytes::text, b.tables,
        b.row_count::text AS rows, b.error, b.checked_at AS "checkedAt", b.check_ok AS "checkOk",
        b.check_note AS "checkNote"
      FROM platform.backup b LEFT JOIN platform."user" u ON u.id = b.taken_by
      WHERE b.deleted_at IS NULL ORDER BY b.started_at DESC LIMIT 100`;
    return { settings: await this.settingsOf(db), canCheck: this.canCheck, backups };
  }

  async setSettings(claims: TenantClaims, s: Settings) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO platform.backup_setting (id, enabled, hour, keep, updated_at, updated_by)
        VALUES (true, ${s.enabled}, ${s.hour}, ${s.keep}, now(), ${claims.sub})
        ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, hour = EXCLUDED.hour, keep = EXCLUDED.keep,
          updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'backup.settings', 'backup_setting', claims.ten, { ...s });
    });
    return this.overview(claims);
  }

  /** Takes a backup now and, where possible, proves it. */
  async takeNow(claims: TenantClaims) {
    this.admin(claims);
    const id = await this.take(claims.ten, 'manual', claims.sub);
    if (this.canCheck) await this.check(claims.ten, id);
    return this.overview(claims);
  }

  async checkNow(claims: TenantClaims, id: string) {
    this.admin(claims);
    if (!this.canCheck)
      throw new ConflictException({
        code: 'check_unavailable',
        message:
          'This server cannot restore a backup to check it; your database host keeps its own backups.',
      });
    await this.check(claims.ten, id);
    return this.overview(claims);
  }

  async download(claims: TenantClaims, id: string) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<{ file_name: string | null }[]>`
      SELECT file_name FROM platform.backup WHERE id = ${id} AND status = 'done' AND deleted_at IS NULL`;
    if (!b?.file_name)
      throw new NotFoundException({ code: 'not_found', message: 'No such backup.' });
    await db.begin((tx) => audit(tx, claims.sub, 'backup.download', 'backup', id, {}));
    return { stream: createReadStream(this.path(claims.ten, b.file_name)), fileName: b.file_name };
  }

  // --- taking and checking ---

  private dir(tenantId: string) {
    return join(this.config.backup.dir, tenantId);
  }

  private path(tenantId: string, fileName: string) {
    if (!/^[\w.-]+$/.test(fileName)) throw new Error('bad backup file name');
    return join(this.dir(tenantId), fileName);
  }

  /** Takes one backup of a tenant; returns its id. A failure is recorded on the row, then thrown. */
  async take(tenantId: string, trigger: 'schedule' | 'manual', by: string | null): Promise<string> {
    const db = await this.tenants.forTenant(tenantId);
    const now = new Date();
    const [row] = await db<{ id: string }[]>`
      INSERT INTO platform.backup (trigger, taken_by) VALUES (${trigger}, ${by}) RETURNING id`;
    const id = row!.id;
    const fileName = `aerolith-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${id.slice(0, 8)}.aeb.gz`;
    const file = this.path(tenantId, fileName);
    try {
      await mkdir(this.dir(tenantId), { recursive: true });
      const gzip = createGzip({ level: 6 });
      const written = pipeline(gzip, createWriteStream(file, { mode: 0o600 }));
      const result = await this.tenants.withOwner(tenantId, (sql) =>
        dumpDatabase(sql, gzip, { tenantId, createdAt: now.toISOString() }),
      );
      await written;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
      await db`
        UPDATE platform.backup SET status = 'done', finished_at = now(), file_name = ${fileName},
          bytes = ${(await stat(file)).size}, sha256 = ${hash.digest('hex')}, tables = ${result.tables.length},
          row_count = ${result.rows}
        WHERE id = ${id}`;
      return id;
    } catch (err) {
      await unlink(file).catch(() => {});
      await db`
        UPDATE platform.backup SET status = 'failed', finished_at = now(), error = ${(err as Error).message.slice(0, 1000)}
        WHERE id = ${id}`;
      throw err;
    }
  }

  /**
   * Restores a backup into a scratch database on this server, migrated from scratch, and records whether every
   * table came back whole. The scratch database is dropped afterwards.
   */
  async check(tenantId: string, id: string) {
    const db = await this.tenants.forTenant(tenantId);
    const [b] = await db<{ file_name: string | null; sha256: string | null }[]>`
      SELECT file_name, sha256 FROM platform.backup WHERE id = ${id} AND status = 'done' AND deleted_at IS NULL`;
    if (!b?.file_name)
      throw new NotFoundException({ code: 'not_found', message: 'No such backup.' });
    const file = this.path(tenantId, b.file_name);
    let ok = false;
    let note: string;
    try {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
      if (hash.digest('hex') !== b.sha256)
        throw new Error('The file on disk has changed since it was taken.');
      const r = await withScratchDatabase(this.config.localPgAdminUrl!, (sql) =>
        restoreDatabase(sql, createReadStream(file).pipe(createGunzip())),
      );
      ok = r.problems.length === 0;
      note = ok
        ? `Restored ${r.tables} tables and ${r.rows} rows; every table matched.`
        : r.problems.slice(0, 20).join(' ');
    } catch (err) {
      note = (err as Error).message;
    }
    await db`
      UPDATE platform.backup SET checked_at = now(), check_ok = ${ok}, check_note = ${note.slice(0, 2000)}
      WHERE id = ${id}`;
    return { ok, note };
  }

  /** Removes the oldest finished backups past the count kept (their files and rows), and failed ones' rows. */
  async prune(tenantId: string) {
    const db = await this.tenants.forTenant(tenantId);
    const { keep } = await this.settingsOf(db);
    const old = await db<{ id: string; file_name: string }[]>`
      SELECT id, file_name FROM platform.backup WHERE status = 'done' AND deleted_at IS NULL
      ORDER BY started_at DESC OFFSET ${keep}`;
    for (const o of old) {
      await unlink(this.path(tenantId, o.file_name)).catch(() => {});
      await db`UPDATE platform.backup SET deleted_at = now() WHERE id = ${o.id}`;
    }
    await db`
      UPDATE platform.backup SET status = 'failed', finished_at = now(), error = 'The server stopped while it ran.'
      WHERE status = 'running' AND started_at < ${new Date(Date.now() - STALE_MS)}`;
    return old.length;
  }

  /** One tenant's nightly round: backup when due, check, prune. */
  async runDue(tenantId: string, now: Date) {
    const db = await this.tenants.forTenant(tenantId);
    const s = await this.settingsOf(db);
    const [last] = await db<{ started_at: Date }[]>`
      SELECT started_at FROM platform.backup WHERE trigger = 'schedule' AND status <> 'failed'
      ORDER BY started_at DESC LIMIT 1`;
    if (!backupDue(s, last?.started_at ?? null, now)) return false;
    const id = await this.take(tenantId, 'schedule', null);
    if (this.canCheck) await this.check(tenantId, id);
    await this.prune(tenantId);
    return true;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await exclusively(this.control, LOOP_LOCK.backups, async () => {
        const tenants = await this.control<{ tenant_id: string }[]>`
          SELECT tenant_id FROM core.tenant_db WHERE status = 'ready'`;
        for (const { tenant_id } of tenants)
          await this.runDue(tenant_id, new Date()).catch((err: unknown) =>
            this.log.warn(`Backup failed for ${tenant_id}: ${(err as Error).message}`),
          );
      });
    } finally {
      this.running = false;
    }
  }

  // --- the audit export ---

  /** A ZIP of CSVs for the company's auditors, read in one snapshot, with a trial balance per company. */
  async auditExport(claims: TenantClaims, asOf: string) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const dir = await mkdtemp(join(tmpdir(), 'aerolith-audit-'));
    const files: { name: string; path: string }[] = [];
    try {
      const entities = await db.begin('isolation level repeatable read read only', async (tx) => {
        const tables = await tx<{ name: string; cols: string[] }[]>`
          SELECT n.nspname || '.' || c.relname AS name,
            array(SELECT a.attname::text FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid <> 'bytea'::regtype
              ORDER BY a.attnum) AS cols
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND (n.nspname = ANY(${AUDIT_SCHEMAS})
            OR (n.nspname = 'platform' AND c.relname = ANY(${AUDIT_PLATFORM})))
            AND has_table_privilege(c.oid, 'SELECT')
          ORDER BY 1`;
        const copy = async (name: string, query: string) => {
          const path = join(dir, `${files.length}.csv`);
          await pipeline(
            await tx.unsafe(`COPY (${query}) TO STDOUT (FORMAT csv, HEADER)`).readable(),
            createWriteStream(path),
          );
          files.push({ name, path });
        };
        for (const t of tables)
          await copy(
            `${t.name.replace('.', '/')}.csv`,
            `SELECT ${t.cols.map(qname).join(', ')} FROM ${qname(t.name)}`,
          );
        await copy('platform/users.csv', USERS_SQL);
        return tx<
          { id: string; name: string }[]
        >`SELECT id, name FROM platform.entity ORDER BY name`;
      });
      for (const e of entities) {
        const tb = await this.ledger.trialBalance(claims, { entityId: e.id, asOf });
        const csv = ['code,name,debit,credit']
          .concat(
            tb.rows.map((r) =>
              [r.code, r.name, r.debit ?? '', r.credit ?? ''].map(csvCell).join(','),
            ),
          )
          .concat([['', 'Total', tb.debit, tb.credit].map(csvCell).join(',')])
          .join('\r\n');
        const path = join(dir, `${files.length}.csv`);
        await pipeline(Readable.from([csv]), createWriteStream(path));
        files.push({ name: `trial-balance/${safeName(e.name)}-${asOf}.csv`, path });
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.append(
      Buffer.from(
        `Aerolith Core audit export, as of ${asOf}, made ${new Date().toISOString()}.\r\n` +
          `Each CSV is one table, read in one consistent snapshot. Stored files (bills, photos, drawings) are not ` +
          `included; download them from Documents. Passwords, sessions and keys are never exported.\r\n`,
      ),
      { name: 'README.txt' },
    );
    for (const f of files) archive.append(createReadStream(f.path), { name: f.name });
    void archive.finalize();
    archive.on('end', () => void rm(dir, { recursive: true, force: true }));
    archive.on('error', () => void rm(dir, { recursive: true, force: true }));
    await db.begin((tx) =>
      audit(tx, claims.sub, 'audit.export', 'entity', claims.ten, { asOf, files: files.length }),
    );
    return { stream: archive as unknown as Readable, fileName: `audit-export-${asOf}.zip` };
  }
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const safeName = (s: string) => s.replace(/[^\w.-]+/g, '-').slice(0, 60);

/**
 * Runs `fn` against a new, freshly migrated database on the server named by `adminUrl` (a superuser), dropping it
 * afterwards whatever happens.
 */
export async function withScratchDatabase<T>(
  adminUrl: string,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const name = `restore_check_${randomBytes(6).toString('hex')}`;
  const server = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await server.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {}, prepare: false });
    try {
      await sql.unsafe(
        `GRANT CREATE ON DATABASE ${quoteIdent(name)} TO ${quoteIdent(OWNER_GROUP)}`,
      );
      await migrate(sql, TENANT_MIGRATIONS, { asRole: OWNER_GROUP });
      return await fn(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await server.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`).catch(() => {});
    await server.end({ timeout: 5 });
  }
}
