// Rate library and rate analysis (docs/wave1-plan.md step 5): resources with dated rates, the tenant's own price
// books, and analyses that build an item rate from resources, sub-analyses and lump sums.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { readRows, sniffType } from '../boq/import/reader.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec } from './decimal.js';
import {
  CostingEngine,
  CycleError,
  TooDeepError,
  type AnalysisDef,
  type Addition,
  type Costing,
  type LineDef,
  type ResourceInfo,
  type ResourceKind,
} from './engine.js';
import { detectPriceBook, readPriceRow, type PriceEntry, type PriceIssue } from './price-book.js';

type Db = Sql | TransactionSql;

export const MAX_PRICE_BOOK_ROWS = 50_000;

export interface ResourceInput {
  code: string;
  name: string;
  kind: ResourceKind;
  unit: string;
  notes?: string | undefined;
  active?: boolean | undefined;
}

export interface AnalysisInput {
  code: string;
  description: string;
  unit: string;
  outputQty: string;
  additions: Addition[];
  notes: string;
  active: boolean;
  lines: Omit<LineDef, 'lineNo'>[];
}

const RESOURCE = `r.id, r.code, r.name, r.kind, r.unit, r.notes, r.active, r.updated_at AS "updatedAt",
  r.row_version AS "rowVersion"`;
const ANALYSIS = `a.id, a.code, a.description, a.unit, a.output_qty::text AS "outputQty", a.additions, a.notes,
  a.active, a.updated_at AS "updatedAt", a.row_version AS "rowVersion"`;

/** The rate in force on a date: the latest version that starts on or before it. Joins as `cur`. */
const rateOn = (db: Db, asOf: string) => db`LEFT JOIN LATERAL (
    SELECT rr.rate::text AS rate, rr.effective_from::text AS "rateFrom" FROM est.resource_rate rr
    WHERE rr.resource_id = r.id AND rr.effective_from <= ${asOf}::date
    ORDER BY rr.effective_from DESC LIMIT 1) cur ON true`;

const today = () => new Date().toISOString().slice(0, 10);

/** Postgres errors the user can act on. */
function friendly(err: unknown): never {
  const e = err as { code?: string; constraint_name?: string };
  if (e.code === '23505')
    throw new ConflictException({ code: 'code_taken', message: 'That code is already used.' });
  if (e.code === '23503')
    throw new BadRequestException({
      code: 'unknown_reference',
      message: 'A resource or sub-analysis in the lines does not exist.',
    });
  throw err;
}

@Injectable()
export class RatesService {
  constructor(
    private readonly tenants: TenantConnections,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // --- resources ---

  async listResources(
    claims: TenantClaims,
    q: {
      q?: string | undefined;
      kind?: ResourceKind | undefined;
      active: 'true' | 'false' | 'all';
      asOf: string;
      limit: number;
      offset: number;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const pattern = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = db`
      WHERE true
      ${pattern ? db`AND (r.code ILIKE ${pattern} OR r.name ILIKE ${pattern})` : db``}
      ${q.kind ? db`AND r.kind = ${q.kind}` : db``}
      ${q.active === 'all' ? db`` : db`AND r.active = ${q.active === 'true'}`}`;
    const [rows, [count]] = await Promise.all([
      db`SELECT ${db.unsafe(RESOURCE)}, cur.rate, cur."rateFrom"
        FROM est.resource r ${rateOn(db, q.asOf)}
        ${where} ORDER BY lower(r.code) LIMIT ${q.limit} OFFSET ${q.offset}`,
      db<{ n: number }[]>`SELECT count(*)::int AS n FROM est.resource r ${where}`,
    ]);
    return { items: rows, total: count!.n };
  }

  async getResource(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return this.resourceDetail(db, id);
  }

  private async resourceDetail(db: Db, id: string) {
    const [r] = await db`SELECT ${db.unsafe(RESOURCE)}, cur.rate, cur."rateFrom"
      FROM est.resource r ${rateOn(db, today())} WHERE r.id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'resource_not_found' });
    const rates = await db`
      SELECT effective_from::text AS "effectiveFrom", rate::text AS rate, source, created_at AS "createdAt"
      FROM est.resource_rate WHERE resource_id = ${id} ORDER BY effective_from DESC`;
    const usedIn = await db`
      SELECT DISTINCT a.id, a.code, a.description FROM est.rate_analysis_line l
      JOIN est.rate_analysis a ON a.id = l.analysis_id WHERE l.resource_id = ${id} ORDER BY a.code LIMIT 100`;
    return { ...r, rates, usedIn };
  }

  async createResource(
    claims: TenantClaims,
    input: ResourceInput & {
      rate?: string | undefined;
      effectiveFrom?: string | undefined;
      source?: string | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        const [r] = await tx<{ id: string }[]>`
          INSERT INTO est.resource (code, name, kind, unit, notes, created_by, updated_by)
          VALUES (${input.code}, ${input.name}, ${input.kind}, ${input.unit}, ${input.notes ?? ''}, ${claims.sub},
            ${claims.sub}) RETURNING id`;
        if (input.rate !== undefined)
          await tx`INSERT INTO est.resource_rate (resource_id, effective_from, rate, source, created_by)
            VALUES (${r!.id}, ${input.effectiveFrom ?? today()}, ${input.rate}, ${input.source ?? ''}, ${claims.sub})`;
        await audit(tx, claims.sub, 'resource.create', 'resource', r!.id, { code: input.code });
        return r!.id;
      })
      .catch(friendly);
    return this.resourceDetail(db, id);
  }

  async updateResource(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: { [K in keyof ResourceInput]?: ResourceInput[K] | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (Object.keys(fields).length === 0)
      throw new BadRequestException({ code: 'nothing_to_update' });
    await db
      .begin(async (tx) => {
        const [row] = await tx`UPDATE est.resource SET ${tx(fields)}, updated_at = now(),
            updated_by = ${claims.sub}, row_version = row_version + 1
          WHERE id = ${id} AND row_version = ${rowVersion} RETURNING id`;
        if (!row) await stale(tx, 'est.resource', id, 'resource_not_found');
        await audit(tx, claims.sub, 'resource.update', 'resource', id, {
          fields: Object.keys(fields),
        });
      })
      .catch(friendly);
    return this.resourceDetail(db, id);
  }

  /** Adds a rate version, or replaces the one starting on the same date. */
  async setRate(
    claims: TenantClaims,
    id: string,
    input: { effectiveFrom: string; rate: string; source: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [r] = await tx`SELECT 1 FROM est.resource WHERE id = ${id} FOR UPDATE`;
      if (!r) throw new NotFoundException({ code: 'resource_not_found' });
      await tx`INSERT INTO est.resource_rate (resource_id, effective_from, rate, source, created_by)
        VALUES (${id}, ${input.effectiveFrom}, ${input.rate}, ${input.source}, ${claims.sub})
        ON CONFLICT (resource_id, effective_from) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source,
          created_at = now(), created_by = EXCLUDED.created_by`;
      await tx`UPDATE est.resource SET updated_at = now(), updated_by = ${claims.sub} WHERE id = ${id}`;
      await audit(tx, claims.sub, 'resource.rate', 'resource', id, input);
    });
    return this.resourceDetail(db, id);
  }

  async deleteRate(claims: TenantClaims, id: string, effectiveFrom: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [gone] = await tx`DELETE FROM est.resource_rate
        WHERE resource_id = ${id} AND effective_from = ${effectiveFrom} RETURNING rate::text`;
      if (!gone) throw new NotFoundException({ code: 'rate_not_found' });
      await audit(tx, claims.sub, 'resource.rate_delete', 'resource', id, {
        effectiveFrom,
        rate: gone.rate as string,
      });
    });
    return this.resourceDetail(db, id);
  }

  // --- price books ---

  /**
   * Reads a price book (xlsx or csv) and, unless `dryRun`, applies it in one transaction: new codes become
   * resources, known codes get their name/type/unit updated and a rate version on the row's date (or `effectiveFrom`).
   * A rate equal to the one already in force on that date is left alone.
   */
  async importPriceBook(
    claims: TenantClaims,
    file: { filename: string; stream: Readable; truncated: () => boolean },
    opts: { dryRun: boolean; effectiveFrom: string; defaultKind: ResourceKind },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const dir = join(this.config.importDir, claims.ten);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `pricebook-${randomUUID()}`);
    try {
      try {
        await pipeline(file.stream, createWriteStream(path, { mode: 0o600 }));
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw this.tooLarge();
        throw err;
      }
      if (file.truncated()) throw this.tooLarge();
      const type = await sniffType(path);
      if (type !== 'xlsx' && type !== 'csv')
        throw new UnsupportedMediaTypeException({
          code: 'unsupported_file',
          type,
          message: 'Upload the price book as an Excel (.xlsx) or CSV file.',
        });

      // The first sheet that has a recognisable header.
      const head: { sheet: number; rowNo: number; cells: string[] }[] = [];
      let found: {
        sheet: number;
        headerRow: number;
        mapping: ReturnType<typeof detectPriceBook>;
      } | null = null;
      const entries: PriceEntry[] = [];
      const issues: PriceIssue[] = [];
      let errors = 0;
      const seen = new Map<string, number>();
      for await (const r of readRows(path, type)) {
        if (!found) {
          head.push(r);
          const d = detectPriceBook(head.filter((h) => h.sheet === r.sheet));
          if (d) found = { sheet: r.sheet, headerRow: d.headerRow, mapping: d };
          continue;
        }
        if (r.sheet !== found.sheet) break;
        const { entry, issue } = readPriceRow(r.rowNo, r.cells, found.mapping!.mapping, {
          kind: opts.defaultKind,
          effectiveFrom: opts.effectiveFrom,
        });
        const problem = (message: string) => {
          errors++;
          if (issues.length < 500) issues.push({ rowNo: r.rowNo, message });
        };
        if (issue) problem(issue.message);
        else if (entry) {
          const key = entry.code.toLowerCase();
          if (seen.has(key)) problem(`${entry.code}: also on row ${seen.get(key)}`);
          else {
            seen.set(key, r.rowNo);
            entries.push(entry);
          }
        }
        if (entries.length + errors > MAX_PRICE_BOOK_ROWS)
          throw new BadRequestException({
            code: 'too_many_rows',
            message: `A price book can have up to ${MAX_PRICE_BOOK_ROWS.toLocaleString('en-IN')} rows.`,
          });
      }
      if (!found)
        throw new BadRequestException({
          code: 'no_header',
          message:
            'No header row found. The sheet needs columns named Code, Name (or Description) and Rate; Unit, ' +
            'Type and Effective from are read when present.',
        });

      const plan = await this.planPriceBook(db, entries);
      const summary = {
        dryRun: opts.dryRun,
        headerRow: found.headerRow,
        columns: found.mapping!.mapping,
        rows: entries.length + errors,
        created: plan.created.length,
        updated: plan.updated.length,
        rates: plan.rates.length,
        unchanged: plan.unchanged,
        errors,
        issues,
        unitChanged: plan.unitChanged.slice(0, 50),
      };
      if (!opts.dryRun && (plan.created.length || plan.updated.length || plan.rates.length))
        await this.applyPriceBook(claims, db, plan, file.filename);
      return summary;
    } finally {
      await rm(path, { force: true });
    }
  }

  private async planPriceBook(db: Sql, entries: PriceEntry[]) {
    const existing = await db<
      { id: string; key: string; name: string; kind: string; unit: string; used: boolean }[]
    >`SELECT r.id, lower(r.code) AS key, r.name, r.kind, r.unit,
        EXISTS (SELECT 1 FROM est.rate_analysis_line l WHERE l.resource_id = r.id) AS used
      FROM est.resource r`;
    const byKey = new Map(existing.map((e) => [e.key, e]));
    const history = new Map<string, { from: string; rate: string }[]>();
    for (const h of await db<{ id: string; from: string; rate: string }[]>`
        SELECT resource_id AS id, effective_from::text AS from, rate::text AS rate FROM est.resource_rate
        ORDER BY effective_from DESC`) {
      const list = history.get(h.id) ?? [];
      list.push(h);
      history.set(h.id, list);
    }
    const created: PriceEntry[] = [];
    const updated: (PriceEntry & { id: string })[] = [];
    const rates: { id: string | null; code: string; effectiveFrom: string; rate: string }[] = [];
    const unitChanged: { code: string; from: string; to: string }[] = [];
    let unchanged = 0;
    for (const e of entries) {
      const cur = byKey.get(e.code.toLowerCase());
      if (!cur) {
        created.push(e);
        rates.push({ id: null, code: e.code, effectiveFrom: e.effectiveFrom, rate: e.rate });
        continue;
      }
      let changed = false;
      if (cur.name !== e.name || cur.kind !== e.kind || cur.unit !== e.unit) {
        updated.push({ ...e, id: cur.id });
        changed = true;
        if (cur.unit !== e.unit && cur.used)
          unitChanged.push({ code: e.code, from: cur.unit, to: e.unit });
      }
      const inForce = (history.get(cur.id) ?? []).find((h) => h.from <= e.effectiveFrom);
      if (!inForce || dec(inForce.rate) !== dec(e.rate)) {
        rates.push({ id: cur.id, code: e.code, effectiveFrom: e.effectiveFrom, rate: e.rate });
        changed = true;
      }
      if (!changed) unchanged++;
    }
    return { created, updated, rates, unchanged, unitChanged };
  }

  private async applyPriceBook(
    claims: TenantClaims,
    db: Sql,
    plan: Awaited<ReturnType<RatesService['planPriceBook']>>,
    fileName: string,
  ) {
    const chunks = <T>(xs: T[], n = 2000) =>
      Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
    await db
      .begin(async (tx) => {
        const ids = new Map<string, string>();
        for (const c of chunks(plan.created)) {
          const rows = await tx<{ id: string; key: string }[]>`
          INSERT INTO est.resource (code, name, kind, unit, created_by, updated_by)
          SELECT code, name, kind, unit, ${claims.sub}, ${claims.sub}
          FROM jsonb_to_recordset(${tx.json(c.map((e) => ({ code: e.code, name: e.name, kind: e.kind, unit: e.unit })))})
            AS x(code text, name text, kind text, unit text)
          RETURNING id, lower(code) AS key`;
          for (const r of rows) ids.set(r.key, r.id);
        }
        for (const c of chunks(plan.updated))
          await tx`
          UPDATE est.resource r SET name = x.name, kind = x.kind, unit = x.unit, updated_at = now(),
            updated_by = ${claims.sub}, row_version = r.row_version + 1
          FROM jsonb_to_recordset(${tx.json(c.map((e) => ({ id: e.id, name: e.name, kind: e.kind, unit: e.unit })))})
            AS x(id uuid, name text, kind text, unit text)
          WHERE r.id = x.id`;
        const source = `Price book ${fileName}`.slice(0, 200);
        for (const c of chunks(plan.rates))
          await tx`
          INSERT INTO est.resource_rate (resource_id, effective_from, rate, source, created_by)
          SELECT x.id, x.effective_from, x.rate, ${source}, ${claims.sub}
          FROM jsonb_to_recordset(${tx.json(
            c.map((r) => ({
              id: r.id ?? ids.get(r.code.toLowerCase())!,
              effective_from: r.effectiveFrom,
              rate: r.rate,
            })),
          )}) AS x(id uuid, effective_from date, rate numeric)
          ON CONFLICT (resource_id, effective_from) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source,
            created_at = now(), created_by = EXCLUDED.created_by`;
        await audit(tx, claims.sub, 'resource.price_book', 'resource', null, {
          file: fileName,
          created: plan.created.length,
          updated: plan.updated.length,
          rates: plan.rates.length,
        });
      })
      .catch(friendly); // e.g. a code added by someone else since the check
  }

  private tooLarge() {
    return new PayloadTooLargeException({
      code: 'file_too_large',
      message: `Files up to ${Math.round(this.config.importMaxBytes / 1024 / 1024)} MB can be imported.`,
    });
  }

  // --- analyses ---

  async listAnalyses(
    claims: TenantClaims,
    q: {
      q?: string | undefined;
      active: 'true' | 'false' | 'all';
      asOf: string;
      limit: number;
      offset: number;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const pattern = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = db`
      WHERE true
      ${pattern ? db`AND (a.code ILIKE ${pattern} OR a.description ILIKE ${pattern})` : db``}
      ${q.active === 'all' ? db`` : db`AND a.active = ${q.active === 'true'}`}`;
    const [rows, [count]] = await Promise.all([
      db<{ id: string }[]>`SELECT ${db.unsafe(ANALYSIS)} FROM est.rate_analysis a ${where}
        ORDER BY lower(a.code) LIMIT ${q.limit} OFFSET ${q.offset}`,
      db<{ n: number }[]>`SELECT count(*)::int AS n FROM est.rate_analysis a ${where}`,
    ]);
    const engine = await this.engineFor(
      db,
      rows.map((r) => r.id),
      q.asOf,
    );
    const items = rows.map((r) => {
      const c = engine.cost(r.id);
      return { ...r, unitRate: c.unitRate, boqRate: c.boqRate, missing: c.missing.length };
    });
    return { items, total: count!.n };
  }

  async getAnalysis(claims: TenantClaims, id: string, asOf: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return this.analysisDetail(db, id, asOf);
  }

  private async analysisDetail(db: Db, id: string, asOf: string) {
    const [a] = await db`SELECT ${db.unsafe(ANALYSIS)} FROM est.rate_analysis a WHERE a.id = ${id}`;
    if (!a) throw new NotFoundException({ code: 'analysis_not_found' });
    const lines = await db`
      SELECT l.line_no AS "lineNo", l.kind, l.resource_id AS "resourceId", l.sub_analysis_id AS "subAnalysisId",
        l.description, l.qty::text AS qty, l.wastage_pct::text AS "wastagePct", l.amount::text AS amount,
        CASE WHEN r.id IS NOT NULL THEN json_build_object('code', r.code, 'name', r.name, 'kind', r.kind,
          'unit', r.unit, 'active', r.active) END AS resource,
        CASE WHEN s.id IS NOT NULL THEN json_build_object('code', s.code, 'description', s.description,
          'unit', s.unit, 'active', s.active) END AS "subAnalysis"
      FROM est.rate_analysis_line l
      LEFT JOIN est.resource r ON r.id = l.resource_id
      LEFT JOIN est.rate_analysis s ON s.id = l.sub_analysis_id
      WHERE l.analysis_id = ${id} ORDER BY l.line_no`;
    const costing = (await this.engineFor(db, [id], asOf)).cost(id);
    const usedBy = await db`
      SELECT DISTINCT a.id, a.code, a.description FROM est.rate_analysis_line l
      JOIN est.rate_analysis a ON a.id = l.analysis_id WHERE l.sub_analysis_id = ${id} ORDER BY a.code LIMIT 100`;
    const boqs = await db`
      SELECT b.id, b.name, t.number AS "tenderNumber", count(*)::int AS items
      FROM est.boq_node n JOIN est.boq b ON b.id = n.boq_id JOIN tender.tender t ON t.id = b.tender_id
      WHERE n.rate_analysis_id = ${id} GROUP BY b.id, b.name, t.number ORDER BY t.number, b.name LIMIT 100`;
    return { ...a, asOf, lines, costing, usedBy, boqs };
  }

  async createAnalysis(claims: TenantClaims, input: AnalysisInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        const [a] = await tx<{ id: string }[]>`
          INSERT INTO est.rate_analysis (code, description, unit, output_qty, additions, notes, active,
            created_by, updated_by)
          VALUES (${input.code}, ${input.description}, ${input.unit}, ${input.outputQty},
            ${tx.json(input.additions as unknown as Parameters<typeof tx.json>[0])}, ${input.notes},
            ${input.active}, ${claims.sub}, ${claims.sub})
          RETURNING id`;
        await this.writeLines(tx, a!.id, input.lines);
        await audit(tx, claims.sub, 'analysis.create', 'rate_analysis', a!.id, {
          code: input.code,
        });
        return a!.id;
      })
      .catch(friendly);
    return this.analysisDetail(db, id, today());
  }

  async updateAnalysis(claims: TenantClaims, id: string, rowVersion: number, input: AnalysisInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [row] = await tx`UPDATE est.rate_analysis SET code = ${input.code},
            description = ${input.description}, unit = ${input.unit}, output_qty = ${input.outputQty},
            additions = ${tx.json(input.additions as unknown as Parameters<typeof tx.json>[0])},
            notes = ${input.notes}, active = ${input.active}, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1
          WHERE id = ${id} AND row_version = ${rowVersion} RETURNING id`;
        if (!row) await stale(tx, 'est.rate_analysis', id, 'analysis_not_found');
        await tx`DELETE FROM est.rate_analysis_line WHERE analysis_id = ${id}`;
        await this.writeLines(tx, id, input.lines);
        await audit(tx, claims.sub, 'analysis.update', 'rate_analysis', id, { code: input.code });
      })
      .catch(friendly);
    return this.analysisDetail(db, id, today());
  }

  async copyAnalysis(claims: TenantClaims, id: string, code: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const newId = await db
      .begin(async (tx) => {
        const [a] = await tx<{ id: string }[]>`
          INSERT INTO est.rate_analysis (code, description, unit, output_qty, additions, notes, created_by,
            updated_by)
          SELECT ${code}, description, unit, output_qty, additions, notes, ${claims.sub}, ${claims.sub}
          FROM est.rate_analysis WHERE id = ${id} RETURNING id`;
        if (!a) throw new NotFoundException({ code: 'analysis_not_found' });
        await tx`INSERT INTO est.rate_analysis_line (analysis_id, line_no, kind, resource_id, sub_analysis_id,
            description, qty, wastage_pct, amount)
          SELECT ${a.id}, line_no, kind, resource_id, sub_analysis_id, description, qty, wastage_pct, amount
          FROM est.rate_analysis_line WHERE analysis_id = ${id}`;
        await audit(tx, claims.sub, 'analysis.copy', 'rate_analysis', a.id, { from: id, code });
        return a.id;
      })
      .catch(friendly);
    return this.analysisDetail(db, newId, today());
  }

  /** Replaces the lines, then costs the analysis once so cycles and over-deep nesting are refused before commit. */
  private async writeLines(tx: TransactionSql, id: string, lines: AnalysisInput['lines']) {
    if (lines.length > 0)
      await tx`
        INSERT INTO est.rate_analysis_line (analysis_id, line_no, kind, resource_id, sub_analysis_id, description,
          qty, wastage_pct, amount)
        SELECT ${id}, x.line_no, x.kind, x.resource_id, x.sub_analysis_id, x.description, x.qty, x.wastage_pct,
          x.amount
        FROM jsonb_to_recordset(${tx.json(
          lines.map((l, i) => ({
            line_no: i + 1,
            kind: l.kind,
            resource_id: l.kind === 'resource' ? l.resourceId : null,
            sub_analysis_id: l.kind === 'analysis' ? l.subAnalysisId : null,
            description: l.description,
            qty: l.kind === 'lump_sum' ? '0' : l.qty,
            wastage_pct: l.kind === 'lump_sum' ? '0' : l.wastagePct,
            amount: l.kind === 'lump_sum' ? l.amount : null,
          })),
        )}) AS x(line_no int, kind text, resource_id uuid, sub_analysis_id uuid, description text, qty numeric,
          wastage_pct numeric, amount numeric)`;
    try {
      (await this.engineFor(tx, [id], today())).cost(id);
    } catch (err) {
      throw costingConflict(err);
    }
  }

  // --- costing ---

  /**
   * Loads the analyses (with every sub-analysis below them) and the resource rates on `asOf`. A `draft` (an unsaved
   * edit) replaces the stored analysis with the same id, so a cycle through it is caught before saving.
   */
  async engineFor(
    db: Db,
    rootIds: string[],
    asOf: string,
    draft?: AnalysisDef,
  ): Promise<CostingEngine> {
    const ids = draft
      ? [...new Set(draft.lines.map((l) => l.subAnalysisId).filter((x): x is string => !!x))]
      : rootIds;
    // UNION (not UNION ALL) stops at analyses already seen, so even a cycle in the data terminates.
    const defs =
      ids.length === 0
        ? []
        : await db<
            (Omit<AnalysisDef, 'lines'> & { lines: (LineDef & { qty: string })[] | null })[]
          >`
      WITH RECURSIVE tree(id) AS (
        SELECT unnest(${ids}::uuid[])
        UNION
        SELECT l.sub_analysis_id FROM est.rate_analysis_line l JOIN tree t ON l.analysis_id = t.id
        WHERE l.sub_analysis_id IS NOT NULL
      )
      SELECT a.id, a.code, a.description, a.unit, a.output_qty::text AS "outputQty", a.additions,
        (SELECT json_agg(json_build_object('lineNo', l.line_no, 'kind', l.kind, 'resourceId', l.resource_id,
            'subAnalysisId', l.sub_analysis_id, 'description', l.description, 'qty', l.qty::text,
            'wastagePct', l.wastage_pct::text, 'amount', l.amount::text) ORDER BY l.line_no)
          FROM est.rate_analysis_line l WHERE l.analysis_id = a.id) AS lines
      FROM est.rate_analysis a JOIN tree ON tree.id = a.id`;
    const analyses = new Map<string, AnalysisDef>(
      defs.map((d) => [d.id, { ...d, lines: d.lines ?? [] }]),
    );
    if (draft) analyses.set(draft.id, draft);
    const resourceIds = [
      ...new Set(
        [...analyses.values()].flatMap((d) =>
          d.lines.map((l) => l.resourceId).filter((x): x is string => !!x),
        ),
      ),
    ];
    const resources =
      resourceIds.length === 0
        ? []
        : await db<ResourceInfo[]>`
          SELECT r.id, r.code, r.name, r.kind, r.unit, cur.rate
          FROM est.resource r ${rateOn(db, asOf)}
          WHERE r.id = ANY(${resourceIds}::uuid[])`;
    return new CostingEngine(analyses, new Map(resources.map((r) => [r.id, r])));
  }

  /** Costs an unsaved analysis (the editor's live totals). `id` is the analysis being edited, if any. */
  async previewAnalysis(
    claims: TenantClaims,
    id: string | null,
    input: AnalysisInput,
    asOf: string,
  ): Promise<Costing> {
    const db = await this.tenants.forTenant(claims.ten);
    const draft: AnalysisDef = {
      id: id ?? '00000000-0000-0000-0000-000000000000',
      code: input.code || 'this analysis',
      description: input.description,
      unit: input.unit,
      outputQty: input.outputQty,
      additions: input.additions,
      lines: input.lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
    };
    const engine = await this.engineFor(db, [], asOf, draft);
    const dangling = draft.lines.find(
      (l) =>
        (l.kind === 'resource' && !engine.hasResource(l.resourceId!)) ||
        (l.kind === 'analysis' && !engine.hasAnalysis(l.subAnalysisId!)),
    );
    if (dangling)
      throw new BadRequestException({
        code: 'unknown_reference',
        line: dangling.lineNo,
        message: 'A resource or sub-analysis in the lines does not exist.',
      });
    try {
      return engine.cost(draft.id);
    } catch (err) {
      throw costingConflict(err);
    }
  }

  /** The rate an analysis gives on a date, for a BOQ item. Refuses when resources have no rate on that date. */
  async boqRate(
    db: Db,
    id: string,
    asOf: string,
  ): Promise<Costing & { unit: string; description: string }> {
    const engine = await this.engineFor(db, [id], asOf);
    const [a] = await db<{ unit: string; description: string; active: boolean }[]>`
      SELECT unit, description, active FROM est.rate_analysis WHERE id = ${id}`;
    if (!a) throw new NotFoundException({ code: 'analysis_not_found' });
    const c = engine.cost(id);
    if (c.missing.length > 0)
      throw new ConflictException({
        code: 'missing_rates',
        missing: c.missing,
        message: `No rate on ${asOf} for ${c.missing.map((m) => m.code).join(', ')}.`,
      });
    return { ...c, unit: a.unit, description: a.description };
  }
}

/** Cycles and over-deep nesting as 409s the editor can show; anything else unchanged. */
function costingConflict(err: unknown): unknown {
  if (err instanceof CycleError)
    return new ConflictException({
      code: 'analysis_cycle',
      path: err.path,
      message: `These analyses would refer to each other: ${err.path.join(' → ')}`,
    });
  if (err instanceof TooDeepError)
    return new ConflictException({
      code: 'analysis_too_deep',
      path: err.path,
      message: err.message,
    });
  return err;
}

async function stale(
  tx: TransactionSql,
  table: string,
  id: string,
  notFound: string,
): Promise<never> {
  const [exists] = await tx`SELECT 1 FROM ${tx.unsafe(table)} WHERE id = ${id}`; // table: a constant
  if (!exists) throw new NotFoundException({ code: notFound });
  throw new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this. Reload and try again.',
  });
}

async function audit(
  tx: TransactionSql,
  actorId: string,
  action: string,
  entity: string,
  entityId: string | null,
  data: Record<string, unknown>,
) {
  await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
    VALUES (${actorId}, ${action}, ${entity}, ${entityId}, ${tx.json(JSON.parse(JSON.stringify(data)))})`;
}
