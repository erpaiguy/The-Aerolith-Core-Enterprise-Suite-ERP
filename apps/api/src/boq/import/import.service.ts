// BOQ import from Excel/CSV (docs/wave1-plan.md step 4).
//
// Upload -> scan (sheets, row counts, a preview and suggested settings) -> the user confirms sheet, header, columns and
// structure -> dry run -> import. Every heavy step runs in the background and reports progress on the job row; the
// client polls. The uploaded file waits on the API server's disk (IMPORT_DIR), never in the tenant database: COPY is
// refused on tables with row-level security, and staging a large file in the database would double its size.
//
// The import is one transaction: it either lands whole or not at all. Sort keys, ids, subtotals and child counts are
// computed here while streaming, so the database only receives plain multi-row INSERTs and one UPDATE per section
// batch, and the stored totals obey the same invariants as interactive edits (boq.service.ts).
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { childKey, segmentFor } from '@aerolith/shared';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../../auth/auth.service.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { TenantConnections } from '../../provisioning/tenant-connections.js';
import { refuseArchived } from '../archived.js';
import { BoqService } from '../boq.service.js';
import { STALE_MINUTES } from './jobs.js';
import { planRevision, type Existing, type Mapped, type RevisionSummary } from './revise.js';
import {
  LineBuilder,
  detectSettings,
  paiseToString,
  type Issue,
  type Line,
  type Mapping,
  type Settings,
  type Structure,
} from './builder.js';
import { loadUnitMap } from '../units.js';
import { readRows, sniffType } from './reader.js';

export const MAX_LINES = 2_000_000;
const MAX_SHEETS = 50;
const PREVIEW_ROWS = 50;
const PREVIEW_SHEETS = 10;
const PREVIEW_CELL = 120;
const ISSUES_KEPT = 500;
/** A revised BOQ is matched in memory: up to this many lines in the BOQ it revises. */
const MAX_REVISE_LINES = 200_000;
const FILE_TTL_MS = 24 * 3600_000;
const INSERT_ROWS = 2000;
const INSERT_BYTES = 4 * 1024 * 1024;

export type JobStatus =
  | 'scanning'
  | 'uploaded'
  | 'validating'
  | 'validated'
  | 'importing'
  | 'imported'
  | 'failed'
  | 'cancelled';
const RUNNING: JobStatus[] = ['scanning', 'validating', 'importing'];
const UNSUPPORTED = {
  xls: 'This is an old Excel file (.xls). Open it in Excel or LibreOffice, save it as .xlsx, and upload that.',
  pdf: 'PDF files cannot be imported. Ask for the BOQ as an Excel file, or copy it into one.',
  binary: 'This is not an Excel (.xlsx) or CSV file. CSV files must be saved as UTF-8 text.',
};
const FAILED: Partial<Record<JobStatus, string>> = {
  scanning: 'The file could not be read',
  validating: 'The check failed',
  importing: 'The import failed',
};

export interface SheetInfo {
  name: string;
  rows: number;
  columns: number;
  preview: { rowNo: number; cells: string[] }[];
  detected: { headerRow: number | null; mapping: Mapping; structure: Structure };
}

interface JobRow {
  id: string;
  target_id: string;
  file_name: string;
  file_type: 'xlsx' | 'csv';
  file_size: string;
  status: JobStatus;
  sheets: SheetInfo[];
  settings: Settings | null;
  summary: Summary | null;
  progress: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface Summary {
  counts: LineBuilder['counts'];
  lines: number;
  total: string;
  issues: Issue[];
  /** Issues beyond those listed (all of them are in the issues report). */
  moreIssues: number;
  unknownUnits: { unit: string; rows: number }[];
  /** Importing into a BOQ that has lines: what the revised file changes (see revise.ts). */
  revision?: RevisionSummary & {
    /** The BOQ as checked; the import refuses to run if it changed since. */
    boqUpdatedAt: string;
  };
  result?: {
    nodeCount: number;
    itemCount: number;
    total: string;
    seconds: number;
    analyzed: boolean;
  };
}

const view = (j: JobRow) => ({
  id: j.id,
  boqId: j.target_id,
  fileName: j.file_name,
  fileType: j.file_type,
  fileSize: Number(j.file_size),
  status: j.status,
  sheets: j.sheets,
  settings: j.settings,
  summary: j.summary,
  progress: j.progress,
  error: j.error,
  createdAt: j.created_at,
  updatedAt: j.updated_at,
  finishedAt: j.finished_at,
});
export type ImportJob = ReturnType<typeof view>;

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** A failure whose message is meant for the user. */
class ImportProblem extends Error {}

@Injectable()
export class ImportService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ImportService.name);
  /** Background work in this process, by job id. */
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private janitor: NodeJS.Timeout | undefined;

  constructor(
    private readonly tenants: TenantConnections,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly boqs: BoqService,
  ) {}

  onModuleInit() {
    this.janitor = setInterval(() => void this.sweepFiles(), 3600_000);
    this.janitor.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.janitor);
    for (const r of this.running.values()) r.abort.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  /** Resolves when background work on the job (if any, in this process) has finished. For tests. */
  async settled(jobId: string): Promise<void> {
    await this.running.get(jobId)?.done;
  }

  // --- units ---

  async units(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT code, name, aliases, active FROM platform.unit ORDER BY active DESC, code`;
  }

  async addUnit(claims: TenantClaims, input: { code: string; name: string; aliases: string[] }) {
    const db = await this.tenants.forTenant(claims.ten);
    const taken = await loadUnitMap(db, false);
    for (const a of [input.code, ...input.aliases]) {
      const owner = taken.get(a.toLowerCase());
      if (owner) throw new ConflictException({ code: 'unit_exists', unit: owner, alias: a });
    }
    const aliases = [...new Set(input.aliases.map((a) => a.toLowerCase()))];
    await db.begin(async (tx) => {
      await tx`INSERT INTO platform.unit (code, name, aliases, created_by)
        VALUES (${input.code}, ${input.name}, ${aliases}, ${claims.sub})`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'unit.create', 'unit', ${input.code}, ${tx.json({ name: input.name, aliases })})`;
    });
    return this.units(claims);
  }

  // --- jobs ---

  async upload(
    claims: TenantClaims,
    boqId: string,
    file: { filename: string; stream: Readable; truncated: () => boolean },
  ): Promise<ImportJob> {
    const db = await this.tenants.forTenant(claims.ten);
    try {
      await this.importableBoq(db, boqId);
    } catch (err) {
      file.stream.resume(); // discard the upload
      throw err;
    }
    const id = randomUUID();
    const dir = join(this.config.importDir, claims.ten);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, id);
    try {
      await pipeline(file.stream, createWriteStream(path, { mode: 0o600 }));
    } catch (err) {
      await rm(path, { force: true });
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw this.tooLarge();
      throw err;
    }
    if (file.truncated()) {
      await rm(path, { force: true });
      throw this.tooLarge();
    }
    const size = (await stat(path)).size;
    if (size === 0) {
      await rm(path, { force: true });
      throw new BadRequestException({ code: 'empty_file', message: 'The file is empty.' });
    }
    const type = await sniffType(path);
    if (type !== 'xlsx' && type !== 'csv') {
      await rm(path, { force: true });
      throw new UnsupportedMediaTypeException({
        code: 'unsupported_file',
        type,
        message: UNSUPPORTED[type],
      });
    }
    const name = file.filename.replace(/[\\/\0]/g, '_').slice(-200) || `upload.${type}`;
    await db`INSERT INTO platform.import_job (id, kind, target_id, file_name, file_type, file_size, created_by)
      VALUES (${id}, 'boq', ${boqId}, ${name}, ${type}, ${size}, ${claims.sub})`;
    this.background(claims.ten, db, id, 'scanning', (tick) =>
      this.scan(db, id, path, type, size, tick),
    );
    return this.get(claims, id);
  }

  async get(claims: TenantClaims, jobId: string): Promise<ImportJob> {
    const db = await this.tenants.forTenant(claims.ten);
    return view(await this.job(db, jobId));
  }

  /** The newest job for a BOQ, so the wizard can resume after the window was closed. */
  async latest(claims: TenantClaims, boqId: string): Promise<ImportJob | null> {
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db<{ id: string }[]>`
      SELECT id FROM platform.import_job WHERE kind = 'boq' AND target_id = ${boqId}
      ORDER BY created_at DESC LIMIT 1`;
    return r ? view(await this.job(db, r.id)) : null;
  }

  /** Saves the user's settings and starts the dry run. */
  async validate(claims: TenantClaims, jobId: string, settings: Settings): Promise<ImportJob> {
    const db = await this.tenants.forTenant(claims.ten);
    const job = await this.job(db, jobId);
    if (!['uploaded', 'validated', 'failed'].includes(job.status))
      throw new ConflictException({ code: 'job_busy', status: job.status });
    const sheet = job.sheets[settings.sheet];
    if (!sheet) throw new BadRequestException({ code: 'no_such_sheet' });
    if (settings.mapping.description === undefined && settings.mapping.code === undefined)
      throw new BadRequestException({
        code: 'mapping_incomplete',
        message: 'Choose the column that holds the description (or at least the item code).',
      });
    if (settings.structure === 'level' && settings.mapping.level === undefined)
      throw new BadRequestException({
        code: 'mapping_incomplete',
        message: 'The level structure needs a Level column.',
      });
    const path = await this.filePath(claims.ten, job);
    const [moved] = await db`UPDATE platform.import_job
      SET status = 'validating', settings = ${db.json(JSON.parse(JSON.stringify(settings)))}, summary = NULL,
        progress = 0, error = NULL, updated_at = now()
      WHERE id = ${jobId} AND status = ${job.status} RETURNING 1`;
    if (!moved) throw new ConflictException({ code: 'job_busy' });
    this.background(claims.ten, db, jobId, 'validating', (tick) =>
      this.dryRun(db, jobId, path, job, settings, tick),
    );
    return this.get(claims, jobId);
  }

  /** Every issue of the dry run as CSV (the job summary keeps only the first ones). */
  async issuesReport(claims: TenantClaims, jobId: string): Promise<Readable> {
    const db = await this.tenants.forTenant(claims.ten);
    const job = await this.job(db, jobId);
    if (!job.settings) throw new ConflictException({ code: 'not_validated' });
    const path = await this.filePath(claims.ten, job);
    const units = await loadUnitMap(db);
    const settings = job.settings;
    async function* lines() {
      yield '﻿Row,Severity,Column,Message\r\n';
      const b = new LineBuilder(settings, units);
      for await (const r of readRows(path, job.file_type)) {
        if (r.sheet !== settings.sheet) continue;
        for (const i of b.push(r.rowNo, r.cells).issues)
          yield [i.rowNo, i.severity, i.field ?? '', i.message].map(csvCell).join(',') + '\r\n';
      }
    }
    return Readable.from(lines());
  }

  async start(claims: TenantClaims, jobId: string, skipErrors: boolean): Promise<ImportJob> {
    const db = await this.tenants.forTenant(claims.ten);
    const job = await this.job(db, jobId);
    if (job.status !== 'validated' || !job.settings || !job.summary)
      throw new ConflictException({
        code: 'not_validated',
        message: 'Run the check again before importing.',
      });
    if (job.summary.counts.errors > 0 && !skipErrors)
      throw new ConflictException({
        code: 'has_errors',
        message: `${job.summary.counts.errors} errors were found. Fix the file, or import without the rows that have them.`,
      });
    if (job.summary.lines === 0)
      throw new ConflictException({ code: 'nothing_to_import', message: 'No lines to import.' });
    await this.importableBoq(db, job.target_id);
    const path = await this.filePath(claims.ten, job);
    const settings = job.settings;
    const [moved] = await db`UPDATE platform.import_job
      SET status = 'importing', progress = 0, error = NULL, updated_at = now()
      WHERE id = ${jobId} AND status = 'validated'
        AND NOT EXISTS (SELECT 1 FROM platform.import_job o WHERE o.kind = 'boq' AND o.target_id = ${job.target_id}
          AND o.status = 'importing' AND o.updated_at > now() - make_interval(mins => ${STALE_MINUTES}))
      RETURNING 1`;
    if (!moved)
      throw new ConflictException({
        code: 'job_busy',
        message: 'Another import into this BOQ is running.',
      });
    this.background(claims.ten, db, jobId, 'importing', (tick) =>
      this.run(claims, db, job, path, settings, tick),
    );
    return this.get(claims, jobId);
  }

  async cancel(claims: TenantClaims, jobId: string): Promise<ImportJob> {
    const db = await this.tenants.forTenant(claims.ten);
    const job = await this.job(db, jobId);
    if (job.status === 'imported' || job.status === 'cancelled') return view(job);
    const [done] = await db`UPDATE platform.import_job
      SET status = 'cancelled', finished_at = now(), updated_at = now()
      WHERE id = ${jobId} AND status = ${job.status} RETURNING 1`;
    if (!done) throw new ConflictException({ code: 'job_busy' });
    // Background work notices on its next progress report; an import rolls back.
    const r = this.running.get(jobId);
    if (r) {
      r.abort.abort();
      await r.done;
    }
    await rm(join(this.config.importDir, claims.ten, jobId), { force: true });
    return this.get(claims, jobId);
  }

  // --- background steps ---

  private async scan(
    db: Sql,
    jobId: string,
    path: string,
    type: 'xlsx' | 'csv',
    size: number,
    tick: Tick,
  ) {
    const sheets: SheetInfo[] = [];
    let bytes = 0;
    const rows = readRows(path, type, (b) => (bytes = b));
    const next = async () => {
      try {
        return await rows.next();
      } catch (err) {
        if (type !== 'xlsx') throw err;
        throw new ImportProblem(
          `This file could not be read as an Excel workbook (${(err as Error).message}). Open it in Excel, save it ` +
            'as .xlsx, and upload it again.',
        );
      }
    };
    for (let n = await next(); !n.done; n = await next()) {
      const r = n.value;
      if (r.sheet >= MAX_SHEETS) break;
      const s = (sheets[r.sheet] ??= {
        name: r.sheetName,
        rows: 0,
        columns: 0,
        preview: [],
        detected: { headerRow: null, mapping: {}, structure: 'headings' },
      });
      s.rows++;
      s.columns = Math.max(s.columns, r.cells.length);
      if (s.preview.length < PREVIEW_ROWS && r.sheet < PREVIEW_SHEETS)
        s.preview.push({ rowNo: r.rowNo, cells: r.cells.map((c) => c.slice(0, PREVIEW_CELL)) });
      await tick(Math.min(99, Math.floor((bytes / size) * 100)));
    }
    await rows.return(undefined); // closes the file when we stopped early
    for (let i = 0; i < sheets.length; i++) {
      sheets[i] ??= {
        name: `Sheet ${i + 1}`,
        rows: 0,
        columns: 0,
        preview: [],
        detected: { headerRow: null, mapping: {}, structure: 'headings' },
      };
      sheets[i]!.detected = detectSettings(sheets[i]!.preview);
    }
    if (!sheets.some((s) => s.rows > 0))
      throw new ImportProblem(
        type === 'csv'
          ? 'No rows found. Is this an Excel (.xlsx) or CSV file?'
          : 'The workbook has no rows.',
      );
    // Start on the sheet with the most rows; most BOQ workbooks have a cover or abstract sheet first.
    const sheet = sheets.reduce((best, s, i) => (s.rows > sheets[best]!.rows ? i : best), 0);
    const d = sheets[sheet]!.detected;
    const settings: Settings = {
      sheet,
      headerRow: d.headerRow,
      mapping: d.mapping,
      structure: d.structure,
      normaliseUnits: true,
    };
    await db`UPDATE platform.import_job SET status = 'uploaded', progress = 100,
        sheets = ${db.json(JSON.parse(JSON.stringify(sheets)))},
        settings = ${db.json(JSON.parse(JSON.stringify(settings)))}, updated_at = now()
      WHERE id = ${jobId} AND status = 'scanning'`;
  }

  private async dryRun(
    db: Sql,
    jobId: string,
    path: string,
    job: JobRow,
    settings: Settings,
    tick: Tick,
  ) {
    const sheet = job.sheets[settings.sheet]!;
    if (sheet.rows > MAX_LINES)
      throw new ImportProblem(
        `The sheet has ${sheet.rows.toLocaleString('en-IN')} rows; one import takes up to ${MAX_LINES.toLocaleString('en-IN')}.`,
      );
    const b = new LineBuilder(settings, await loadUnitMap(db));
    const issues: Issue[] = [];
    let total = 0;
    let lines = 0;
    let seen = 0;
    for await (const r of readRows(path, job.file_type)) {
      if (r.sheet < settings.sheet) continue;
      if (r.sheet > settings.sheet) break;
      const out = b.push(r.rowNo, r.cells);
      if (out.line) lines++;
      for (const i of out.issues) {
        total++;
        if (issues.length < ISSUES_KEPT) issues.push(i);
      }
      await tick(Math.min(99, Math.floor((++seen / Math.max(1, sheet.rows)) * 100)));
    }
    const summary: Summary = {
      counts: b.counts,
      lines,
      total: paiseToString(b.totalPaise),
      issues,
      moreIssues: total - issues.length,
      unknownUnits: [...b.unknownUnits]
        .sort((a, c) => c[1] - a[1])
        .slice(0, 50)
        .map(([unit, rows]) => ({ unit, rows })),
    };
    // Into a BOQ that has lines: the file is a revised BOQ; work out what it changes.
    const [boq] = await db<{ node_count: number; updated_at: Date }[]>`
      SELECT node_count, updated_at FROM est.boq WHERE id = ${job.target_id}`;
    if (boq && boq.node_count > 0) {
      const plan = await this.revisionPlan(db, job.target_id, path, job, settings);
      summary.revision = { ...plan.summary, boqUpdatedAt: boq.updated_at.toISOString() };
    }
    await db`UPDATE platform.import_job SET status = 'validated', progress = 100,
        summary = ${db.json(JSON.parse(JSON.stringify(summary)))}, updated_at = now()
      WHERE id = ${jobId} AND status = 'validating'`;
  }

  private async run(
    claims: TenantClaims,
    db: Sql,
    job: JobRow,
    path: string,
    settings: Settings,
    tick: Tick,
  ) {
    if (job.summary?.revision) return this.runRevision(claims, db, job, path, settings, tick);
    const started = Date.now();
    const boqId = job.target_id;
    const expected = job.summary!.lines;
    // Fixed-width segments sort correctly as plain strings; wide enough for the largest possible sibling count.
    const width = expected < 36 ** 3 ? 3 : expected < 36 ** 4 ? 4 : 5;
    const units = await loadUnitMap(db);

    const result = await db.begin(async (tx) => {
      const [boq] = await tx<
        {
          status: string;
          archived: boolean;
          node_count: number;
          tender_id: string;
          version_no: number;
        }[]
      >`
        SELECT status, archived_at IS NOT NULL AS archived, node_count, tender_id, version_no FROM est.boq
        WHERE id = ${boqId} FOR UPDATE`;
      if (!boq) throw new ImportProblem('The BOQ no longer exists.');
      if (boq.archived) throw new ImportProblem('The BOQ was archived meanwhile.');
      if (boq.status !== 'draft') throw new ImportProblem('The BOQ is no longer a draft.');
      if (boq.node_count > 0) throw new ImportProblem('Lines were added to the BOQ meanwhile.');

      const b = new LineBuilder(settings, units);
      const stack: { id: string; key: string; next: number }[] = [];
      const sections = new Map<string, { subtotal: bigint; children: number }>();
      let topNext = 0;
      let ids: string[] = [];
      let batch: Record<string, string | number | null>[] = [];
      let batchBytes = 0;
      let lines = 0;
      let items = 0;

      const takeId = async () => {
        if (ids.length === 0)
          ids = (
            await tx<{ id: string }[]>`
              SELECT nextval('est.boq_node_id_seq')::text AS id FROM generate_series(1, ${INSERT_ROWS})`
          ).map((r) => r.id);
        return ids.pop()!;
      };
      const flush = async () => {
        if (batch.length === 0) return;
        // The text rows reference the line rows; foreign keys are checked at the end of the statement.
        await tx`
          WITH r AS (
            SELECT * FROM jsonb_to_recordset(${tx.json(batch)}) AS r(
              id bigint, parent_id bigint, sort_key text, depth smallint, node_type text, code text, unit text,
              qty numeric, rate numeric, description text, notes text, item_kind text)
          ), n AS (
            INSERT INTO est.boq_node (boq_id, id, parent_id, sort_key, depth, node_type, code, unit, qty, rate, amount,
              created_version, item_kind)
            SELECT ${boqId}, id, parent_id, sort_key, depth, node_type, code, unit, qty, rate,
              CASE WHEN item_kind IN ('normal', 'provisional') THEN round(qty * rate, 2) END, ${boq.version_no},
              item_kind
            FROM r
          )
          INSERT INTO est.boq_node_text (boq_id, node_id, description, notes)
          SELECT ${boqId}, id, description, notes FROM r`;
        batch = [];
        batchBytes = 0;
      };
      const add = async (line: Line) => {
        stack.length = line.depth;
        const parent = line.depth > 0 ? stack[line.depth - 1]! : null;
        const id = await takeId();
        const key = childKey(
          parent?.key ?? '',
          segmentFor(parent ? parent.next++ : topNext++, width),
        );
        if (parent) sections.get(parent.id)!.children++;
        if (line.amountPaise !== null && line.amountPaise !== 0n)
          for (const s of stack) sections.get(s.id)!.subtotal += line.amountPaise;
        batch.push({
          id,
          parent_id: parent?.id ?? null,
          sort_key: key,
          depth: line.depth,
          node_type: line.type,
          code: line.code,
          unit: line.unit,
          qty: line.qty,
          rate: line.rate,
          description: line.description,
          notes: line.notes,
          item_kind: line.kind,
        });
        batchBytes += 200 + line.description.length + line.notes.length;
        if (line.type === 'section') {
          stack.push({ id, key, next: 0 });
          sections.set(id, { subtotal: 0n, children: 0 });
        }
        lines++;
        if (line.type === 'item') items++;
        if (batch.length >= INSERT_ROWS || batchBytes >= INSERT_BYTES) await flush();
      };

      let seen = 0;
      const rows = job.sheets[settings.sheet]!.rows;
      for await (const r of readRows(path, job.file_type)) {
        if (r.sheet < settings.sheet) continue;
        if (r.sheet > settings.sheet) break;
        const { line } = b.push(r.rowNo, r.cells);
        if (line) await add(line);
        await tick(Math.min(90, Math.floor((++seen / Math.max(1, rows)) * 90)));
      }
      await flush();
      if (lines !== expected)
        throw new ImportProblem('The file changed since it was checked. Run the check again.');

      // Sections: subtotals and child counts in batches.
      const pending = [...sections].filter(([, s]) => s.children > 0);
      for (let i = 0; i < pending.length; i += 5000) {
        const chunk = pending
          .slice(i, i + 5000)
          .map(([id, s]) => ({ id, subtotal: paiseToString(s.subtotal), children: s.children }));
        await tx`
          UPDATE est.boq_node n SET subtotal = r.subtotal, child_count = r.children
          FROM jsonb_to_recordset(${tx.json(chunk)}) AS r(id bigint, subtotal numeric, children int)
          WHERE n.boq_id = ${boqId} AND n.id = r.id`;
        await tick(90 + Math.floor((i / pending.length) * 8));
      }
      const total = paiseToString(b.totalPaise);
      await tx`UPDATE est.boq SET node_count = ${lines}, item_count = ${items}, total = ${total}::numeric,
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${boqId}`;
      const data = { boqId, jobId: job.id, file: job.file_name, lines, total };
      await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
        VALUES (${boq.tender_id}, 'boq_imported', ${tx.json(data)}, ${claims.sub})`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'boq.import', 'boq', ${boqId}, ${tx.json(data)})`;
      await tick(99, true);
      return { nodeCount: lines, itemCount: items, total };
    });

    // A large load leaves the planner's statistics stale until autovacuum notices; refresh them now if we can.
    let analyzed = false;
    try {
      analyzed = await this.tenants.analyze(claims.ten, ['est.boq_node', 'est.boq_node_text']);
    } catch (err) {
      this.log.warn(`ANALYZE after import ${job.id} failed: ${(err as Error).message}`);
    }
    const summary: Summary = {
      ...job.summary!,
      result: { ...result, seconds: Math.round((Date.now() - started) / 100) / 10, analyzed },
    };
    await db`UPDATE platform.import_job SET status = 'imported', progress = 100, finished_at = now(),
        updated_at = now(), summary = ${db.json(JSON.parse(JSON.stringify(summary)))}
      WHERE id = ${job.id}`;
    await rm(path, { force: true });
  }

  // --- revised BOQ (step 8) ---

  /** The BOQ's lines and the file's, matched and planned (revise.ts). Reads the whole BOQ into memory. */
  private async revisionPlan(
    db: Sql | TransactionSql,
    boqId: string,
    path: string,
    job: JobRow,
    settings: Settings,
  ) {
    const existing = await db<Existing[]>`
      SELECT n.id::text, n.parent_id::text AS "parentId", n.sort_key AS "sortKey", n.node_type AS type, n.code,
        t.description, t.notes, n.unit, n.qty::text AS qty, n.rate::text AS rate, n.measured, n.item_kind AS kind
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boqId} ORDER BY n.sort_key LIMIT ${MAX_REVISE_LINES + 1}`;
    if (existing.length > MAX_REVISE_LINES)
      throw new ImportProblem(
        `A revised BOQ can be imported into a BOQ of up to ${MAX_REVISE_LINES.toLocaleString('en-IN')} lines. ` +
          'Import it as a new BOQ instead, and compare the two by exporting them.',
      );
    const b = new LineBuilder(settings, await loadUnitMap(db));
    const lines: Line[] = [];
    for await (const r of readRows(path, job.file_type)) {
      if (r.sheet < settings.sheet) continue;
      if (r.sheet > settings.sheet) break;
      const { line } = b.push(r.rowNo, r.cells);
      if (line) lines.push(line);
    }
    const m = settings.mapping;
    const mapped: Mapped = {
      code: m.code !== undefined,
      description: m.description !== undefined,
      notes: m.notes !== undefined,
      unit: m.unit !== undefined,
      qty: m.qty !== undefined,
      rate: m.rate !== undefined,
      kind: m.type !== undefined,
    };
    return planRevision([...existing], lines, mapped);
  }

  /**
   * Applies a revised BOQ to a draft that has lines, as checked: if the BOQ changed since the check, nothing happens.
   * Copy-on-write keeps the frozen version intact (step 7), so compare shows exactly what the revision changed.
   */
  private async runRevision(
    claims: TenantClaims,
    db: Sql,
    job: JobRow,
    path: string,
    settings: Settings,
    tick: Tick,
  ) {
    const started = Date.now();
    const boqId = job.target_id;
    const checked = job.summary!.revision!;
    const result = await db.begin(async (tx) => {
      const [boq] = await tx<
        {
          status: string;
          archived: boolean;
          tender_id: string;
          version_no: number;
          rate_date: string;
          updated_at: Date;
        }[]
      >`
        SELECT status, archived_at IS NOT NULL AS archived, tender_id, version_no, rate_date::text, updated_at
        FROM est.boq WHERE id = ${boqId} FOR UPDATE`;
      if (!boq) throw new ImportProblem('The BOQ no longer exists.');
      if (boq.archived) throw new ImportProblem('The BOQ was archived meanwhile.');
      if (boq.status !== 'draft') throw new ImportProblem('The BOQ is no longer a draft.');
      if (boq.updated_at.toISOString() !== checked.boqUpdatedAt)
        throw new ImportProblem('The BOQ was changed since the check. Run the check again.');
      const plan = await this.revisionPlan(tx, boqId, path, job, settings);
      const s = plan.summary;
      if (
        s.added !== checked.added ||
        s.removed !== checked.removed ||
        s.changed !== checked.changed ||
        s.moved !== checked.moved
      )
        throw new ImportProblem(
          'The file or the BOQ changed since the check. Run the check again.',
        );
      await tick(5, true);
      await this.boqs.applyRevision(
        tx,
        { id: boqId, version: boq.version_no, rateDate: boq.rate_date },
        plan,
        (done, of) => tick(5 + Math.floor((done / Math.max(1, of)) * 90)),
      );
      const [after] = await tx<{ node_count: number; item_count: number; total: string }[]>`
        UPDATE est.boq SET updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${boqId} RETURNING node_count, item_count, total::text`;
      const data = {
        boqId,
        jobId: job.id,
        file: job.file_name,
        mode: 'revision',
        version: boq.version_no,
        added: s.added,
        removed: s.removed,
        changed: s.changed,
        moved: s.moved,
        total: after!.total,
      };
      await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
        VALUES (${boq.tender_id}, 'boq_imported', ${tx.json(data)}, ${claims.sub})`;
      await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
        VALUES (${claims.sub}, 'boq.import_revision', 'boq', ${boqId}, ${tx.json(data)})`;
      await tick(99, true);
      return { nodeCount: after!.node_count, itemCount: after!.item_count, total: after!.total };
    });
    const summary: Summary = {
      ...job.summary!,
      result: {
        ...result,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        analyzed: false,
      },
    };
    await db`UPDATE platform.import_job SET status = 'imported', progress = 100, finished_at = now(),
        updated_at = now(), summary = ${db.json(JSON.parse(JSON.stringify(summary)))}
      WHERE id = ${job.id}`;
    await rm(path, { force: true });
  }

  // --- plumbing ---

  /**
   * Runs a step in the background. `tick(progress)` records progress at most once a second and throws Cancelled
   * when the job was cancelled; a failure marks the job failed with a message for the user.
   */
  private background(
    tenantId: string,
    db: Sql,
    jobId: string,
    status: JobStatus,
    step: (tick: Tick) => Promise<void>,
  ) {
    const abort = new AbortController();
    let last = Date.now();
    const tick: Tick = async (progress, force = false) => {
      if (abort.signal.aborted) throw new Cancelled();
      if (!force && Date.now() - last < 1000) return;
      last = Date.now();
      const [still] =
        await db`UPDATE platform.import_job SET progress = ${progress}, updated_at = now()
        WHERE id = ${jobId} AND status = ${status} RETURNING 1`;
      if (!still) throw new Cancelled();
    };
    const done = (async () => {
      try {
        await step(tick);
      } catch (err) {
        if (err instanceof Cancelled) return;
        const message =
          err instanceof ImportProblem
            ? err.message
            : `${FAILED[status]}: ${(err as Error).message ?? String(err)}`;
        // A file we cannot parse is the user's problem, not ours: a warning, not an error with a stack.
        if (status === 'scanning') this.log.warn(`Import job ${jobId} (${tenantId}): ${message}`);
        else if (!(err instanceof ImportProblem))
          this.log.error(
            `Import job ${jobId} (${tenantId}) ${status}: ${(err as Error).stack ?? err}`,
          );
        await db`UPDATE platform.import_job SET status = 'failed', error = ${message.slice(0, 2000)},
            finished_at = now(), updated_at = now()
          WHERE id = ${jobId} AND status = ${status}`.catch(() => {});
      } finally {
        this.running.delete(jobId);
      }
    })();
    this.running.set(jobId, { abort, done });
  }

  private async job(db: Sql, jobId: string): Promise<JobRow> {
    // A job whose worker stopped reporting (server restart) is failed, so the user can start again.
    await db`UPDATE platform.import_job SET status = 'failed', finished_at = now(), updated_at = now(),
        error = 'Interrupted: the server restarted while this was running. Start again.'
      WHERE id = ${jobId} AND status IN ${db(RUNNING)}
        AND updated_at < now() - make_interval(mins => ${STALE_MINUTES})`;
    const [j] = await db<JobRow[]>`
      SELECT id, target_id, file_name, file_type, file_size::text AS file_size, status, sheets, settings, summary,
        progress, error, created_at, updated_at, finished_at
      FROM platform.import_job WHERE id = ${jobId}`;
    if (!j) throw new NotFoundException({ code: 'import_not_found' });
    return j;
  }

  private async filePath(tenantId: string, job: JobRow): Promise<string> {
    const path = join(this.config.importDir, tenantId, job.id);
    try {
      await stat(path);
    } catch {
      throw new GoneException({
        code: 'file_expired',
        message: 'The uploaded file is no longer available. Upload it again.',
      });
    }
    return path;
  }

  /** Imports go into a draft: an empty one (a new BOQ), or one with lines (a revised BOQ, step 8). */
  private async importableBoq(db: Sql, boqId: string) {
    const [b] = await db<{ status: string; archived: boolean; node_count: number }[]>`
      SELECT status, archived_at IS NOT NULL AS archived, node_count FROM est.boq WHERE id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    refuseArchived(b);
    if (b.status !== 'draft') throw new ConflictException({ code: 'boq_locked' });
  }

  private tooLarge() {
    return new PayloadTooLargeException({
      code: 'file_too_large',
      message: `Files up to ${Math.round(this.config.importMaxBytes / 1024 / 1024)} MB can be imported.`,
    });
  }

  /** Deletes uploads older than a day (abandoned wizards). */
  private async sweepFiles() {
    const cutoff = Date.now() - FILE_TTL_MS;
    try {
      for (const tenant of await readdir(this.config.importDir)) {
        const dir = join(this.config.importDir, tenant);
        for (const f of await readdir(dir)) {
          const p = join(dir, f);
          if (this.running.has(f)) continue;
          if ((await stat(p)).mtimeMs < cutoff) await rm(p, { force: true });
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT')
        this.log.warn(`Import file sweep failed: ${(err as Error).message}`);
    }
  }
}

type Tick = (progress: number, force?: boolean) => Promise<void>;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Text a spreadsheet would run as a formula gets a leading apostrophe (OWASP CSV injection); our import removes it.
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
