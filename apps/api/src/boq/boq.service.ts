// BOQ engine (docs/05-database.md §4, docs/wave1-plan.md step 2).
//
// - Rows are read in windows (keyset on the hierarchical sort key), never whole. Collapsed sections are jumped over by
//   their key range, so cost depends on rows shown, not rows hidden.
// - Every edit applies its amount delta to the ancestors' stored subtotals and the BOQ total in the same transaction.
//   Totals are never summed on read. Ancestors come from the sort key itself (prefixes), so no extension is needed.
// - A batch of edits is atomic and serialised per BOQ (the BOQ row is locked first), which also rules out deadlocks.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ancestorKeys, childKey, midpoint, splitKey, SUBTREE_END } from '@aerolith/shared';
import type { PendingQuery, Row, Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { measuredQty, sumQty, type MeasurementInput } from '../pricing/pricing.js';
import { dec, fmt, mul } from '../rates/decimal.js';
import { RatesService } from '../rates/rates.service.js';
import { refuseArchived } from './archived.js';
import { counted, type ItemKind } from './kinds.js';
export { counted, ITEM_KINDS, type ItemKind } from './kinds.js';
import type { FieldChange } from './import/revise.js';
import { importRunning } from './import/jobs.js';
import { loadUnitMap, sameUnit } from './units.js';

export type NodeType = 'section' | 'item' | 'note';

export type BulkAction =
  | { kind: 'unit'; unit: string | null }
  | { kind: 'item_kind'; itemKind: ItemKind }
  | { kind: 'rate'; rate: string }
  | { kind: 'scale'; pct: string }
  | { kind: 'clear_rates' };
const MAX_BULK_ITEMS = 100_000;

export interface LineFields {
  /** Take the rate (and an empty unit or description) from this rate analysis; null unlinks, keeping the rate. */
  rateAnalysisId?: string | null | undefined;
  code?: string | null | undefined;
  description?: string | undefined;
  notes?: string | undefined;
  unit?: string | null | undefined;
  qty?: string | null | undefined;
  rate?: string | null | undefined;
  /** Items only. */
  kind?: ItemKind | undefined;
  /** A rate in another currency (with `currency`); the rupee rate follows the BOQ's exchange rate. */
  foreignRate?: string | null | undefined;
  currency?: string | null | undefined;
}

export type Op =
  | ({
      op: 'insert';
      tempId: string;
      parentId: string | null;
      afterId: string | null;
      type: NodeType;
    } & LineFields)
  | ({ op: 'update'; id: string; rowVersion: number } & LineFields)
  | { op: 'delete'; id: string; rowVersion: number }
  | { op: 'move'; id: string; rowVersion: number; parentId: string | null; afterId: string | null }
  | { op: 'shift'; id: string; rowVersion: number; direction: ShiftDirection };

/** Relative moves the server resolves, because the client may not have far-away siblings or parents loaded. */
export type ShiftDirection = 'up' | 'down' | 'in' | 'out';

export const MAX_DEPTH = 30;
const MAX_TOUCHED_ROWS = 1000;

const ROW = `n.id::text AS id, n.parent_id::text AS "parentId", n.sort_key AS "sortKey", n.depth,
  n.node_type AS type, n.code, t.description, t.notes, n.unit, n.qty::text AS qty, n.rate::text AS rate,
  n.amount::text AS amount, n.subtotal::text AS subtotal, n.child_count AS "childCount",
  n.row_version AS "rowVersion", n.rate_analysis_id AS "rateAnalysisId", n.measured, n.item_kind AS kind,
  n.foreign_currency AS currency, n.foreign_rate::text AS "foreignRate"`;

const HEADER = `b.id, b.tender_id AS "tenderId", b.name, b.version_no AS "versionNo", b.status, b.currency,
  b.node_count AS "nodeCount", b.item_count AS "itemCount", b.total::text AS total, b.notes,
  b.updated_at AS "updatedAt", b.row_version AS "rowVersion", b.rate_date::text AS "rateDate",
  b.archived_at AS "archivedAt"`;

export interface BoqRow {
  id: string;
  parentId: string | null;
  sortKey: string;
  depth: number;
  type: NodeType;
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  amount: string | null;
  subtotal: string;
  childCount: number;
  rowVersion: number;
  rateAnalysisId: string | null;
  /** The quantity is the total of the item's measurement sheet. */
  measured: boolean;
  kind: ItemKind;
  /** Priced in another currency: the rate in it; `rate` is that at the BOQ's exchange rate. */
  currency: string | null;
  foreignRate: string | null;
}

interface NodeRef {
  id: string;
  parent_id: string | null;
  sort_key: string;
  depth: number;
  node_type: NodeType;
  code: string | null;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  amount: string | null;
  subtotal: string;
  row_version: number;
  item_kind: ItemKind;
  foreign_currency?: string | null;
  /** Only read by lockNode. */
  measured?: boolean;
}

/** The root-most collapsed proper ancestor of `key`, if any. */
function hiddenBy(key: string, collapsed: Set<string>): string | null {
  for (const a of ancestorKeys(key)) if (collapsed.has(a)) return a;
  return null;
}

@Injectable()
export class BoqService {
  /** Time budget for the tree-order search strategy before falling back (see `search`). Tests lower it. */
  searchBudgetMs = 150;
  /** Lines read per chunk by the tree-order strategy. Tests lower it. */
  searchChunk = 4000;
  /** How often the fallback plan ran (a sign that a tenant needs a search index). */
  searchFallbacks = 0;

  constructor(
    private readonly tenants: TenantConnections,
    private readonly rates: RatesService,
  ) {}

  // --- BOQ headers ---

  async listForTender(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT ${db.unsafe(HEADER)} FROM est.boq b WHERE b.tender_id = ${tenderId} ORDER BY b.created_at`;
  }

  async header(claims: TenantClaims, boqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db`
      SELECT ${db.unsafe(HEADER)}, json_build_object('id', t.id, 'number', t.number, 'title', t.title) AS tender
      FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id WHERE b.id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    return b;
  }

  async create(claims: TenantClaims, tenderId: string, input: { name: string; notes: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db.begin(async (tx) => {
      const [t] = await tx`SELECT 1 FROM tender.tender WHERE id = ${tenderId}`;
      if (!t) throw new NotFoundException({ code: 'tender_not_found' });
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO est.boq (tender_id, name, notes, created_by, updated_by)
        VALUES (${tenderId}, ${input.name}, ${input.notes}, ${claims.sub}, ${claims.sub}) RETURNING id`;
      await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
        VALUES (${tenderId}, 'boq_created', ${tx.json({ boqId: b!.id, name: input.name })}, ${claims.sub})`;
      await audit(tx, claims.sub, 'boq.create', b!.id, { tenderId, name: input.name });
      return b!.id;
    });
    return this.header(claims, id);
  }

  async updateHeader(
    claims: TenantClaims,
    boqId: string,
    rowVersion: number,
    input: {
      name?: string | undefined;
      notes?: string | undefined;
      /** Rates from analyses are taken as on this date (applied and refreshed). */
      rateDate?: string | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [b] = await tx<{ status: string; archived: boolean }[]>`
        SELECT status, archived_at IS NOT NULL AS archived FROM est.boq WHERE id = ${boqId}`;
      if (b) refuseArchived(b);
      if (input.rateDate !== undefined && b && b.status !== 'draft')
        throw new ConflictException({
          code: 'boq_locked',
          message: 'This version is frozen. Start a new revision to change its rate date.',
        });
      const fields = Object.fromEntries(
        Object.entries({ name: input.name, notes: input.notes, rate_date: input.rateDate }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      if (Object.keys(fields).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      const [row] =
        await tx`UPDATE est.boq SET ${tx(fields)}, updated_by = ${claims.sub}, updated_at = now(),
          row_version = row_version + 1
        WHERE id = ${boqId} AND row_version = ${rowVersion} RETURNING id`;
      if (!row) {
        const [exists] = await tx`SELECT 1 FROM est.boq WHERE id = ${boqId}`;
        if (!exists) throw new NotFoundException({ code: 'boq_not_found' });
        throw new ConflictException({ code: 'stale_row' });
      }
      await audit(tx, claims.sub, 'boq.update', boqId, { fields: Object.keys(fields) });
    });
    return this.header(claims, boqId);
  }

  // --- reading ---

  /**
   * One window of rows in tree order. `after`/`before` are sort keys of the last/first row the client already has
   * (exclusive); `end` reads the last window. `collapsed` are section ids whose descendants are hidden.
   */
  async window(
    claims: TenantClaims,
    boqId: string,
    opts: {
      after?: string | undefined;
      /** Like `after`, but including the row at this key (open the grid at a line). */
      from?: string | undefined;
      before?: string | undefined;
      end?: boolean | undefined;
      limit: number;
      collapsed: string[];
    },
  ): Promise<{ rows: BoqRow[]; hasMore: boolean }> {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustExist(db, boqId);
    const collapsed = new Set(
      opts.collapsed.length === 0
        ? []
        : (
            await db<{ sort_key: string }[]>`
              SELECT sort_key FROM est.boq_node
              WHERE boq_id = ${boqId} AND id = ANY(${opts.collapsed}::bigint[]) AND node_type = 'section'`
          ).map((r) => r.sort_key),
    );
    const backward = opts.before !== undefined || opts.end === true;
    const out: BoqRow[] = [];
    let cursor: string | null = backward
      ? (opts.before ?? null)
      : (opts.from ?? opts.after ?? null);
    let inclusive = !backward && opts.from !== undefined;
    // A collapsed section the client stopped on (`after`): continue after its hidden rows. With `from` the section
    // itself is the first row to show, so the jump happens when it is read.
    if (!backward && !inclusive && cursor !== null && collapsed.has(cursor)) cursor += SUBTREE_END;
    let exhausted = false;
    for (let guard = 0; out.length < opts.limit && guard < opts.limit * 2 + 10; guard++) {
      const want = opts.limit - out.length + 1; // one extra row tells us whether more exist
      const rows = await db<BoqRow[]>`
        SELECT ${db.unsafe(ROW)}
        FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE n.boq_id = ${boqId}
          ${
            cursor === null
              ? db``
              : backward
                ? db`AND n.sort_key < ${cursor}`
                : inclusive
                  ? db`AND n.sort_key >= ${cursor}`
                  : db`AND n.sort_key > ${cursor}`
          }
        ORDER BY n.sort_key ${backward ? db`DESC` : db`ASC`}
        LIMIT ${want}`;
      inclusive = false;
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      let jumped = false;
      for (const row of rows) {
        const hider = hiddenBy(row.sortKey, collapsed);
        if (hider !== null) {
          // Forward: skip the rest of the hidden subtree. Backward: the next row is the collapsed section itself.
          cursor = backward ? hider + '!' : hider + SUBTREE_END;
          jumped = true;
          break;
        }
        if (out.length === opts.limit)
          return { rows: backward ? out.reverse() : out, hasMore: true };
        out.push(row);
        cursor = row.sortKey;
        if (!backward && collapsed.has(row.sortKey)) {
          cursor = row.sortKey + SUBTREE_END;
          jumped = true;
          break;
        }
      }
      if (!jumped && rows.length < want) {
        exhausted = true;
        break;
      }
    }
    return { rows: backward ? out.reverse() : out, hasMore: !exhausted };
  }

  /** Sections down to `maxDepth`, for the outline/navigation panel. */
  async outline(claims: TenantClaims, boqId: string, maxDepth: number) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustExist(db, boqId);
    return db<BoqRow[]>`
      SELECT ${db.unsafe(ROW)}
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boqId} AND n.node_type = 'section' AND n.depth <= ${maxDepth}
      ORDER BY n.sort_key LIMIT 5000`;
  }

  /**
   * Lines whose code or description contains `q`, in tree order, paged by `after`. Two strategies, because neither
   * wins everywhere (measured on 1M lines):
   *
   * 1. Walk the BOQ in tree order in fixed chunks and keep the matches, stopping at a full page. Instant for common
   *    words, but reads everything when the term is rare. It gets a short time budget.
   * 2. When the budget runs out: filter with the trigram indexes (migration 0006), then order the matches. Fast for
   *    rare and absent terms, slow when almost everything matches. It continues from where (1) stopped.
   *
   * Why chunks instead of one query: tables have row-level security, and Postgres then refuses to use column
   * statistics to estimate LIKE filters (estimates could leak data). It guesses ~0.5% matches for every term and
   * picks a bad plan for common words (measured: 13 s). Each chunk query has one obvious plan whatever the estimate.
   */
  async search(
    claims: TenantClaims,
    boqId: string,
    q: string,
    opts: { after?: string | undefined; limit: number },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustExist(db, boqId);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const want = opts.limit + 1; // one extra row tells us whether more exist
    const found: BoqRow[] = [];
    let cursor = opts.after ?? null;
    let done = false;
    const deadline = performance.now() + this.searchBudgetMs;

    while (!done && found.length < want && performance.now() < deadline) {
      const [end] = await db<{ sort_key: string }[]>`
        SELECT sort_key FROM est.boq_node
        WHERE boq_id = ${boqId} ${cursor === null ? db`` : db`AND sort_key > ${cursor}`}
        ORDER BY sort_key OFFSET ${this.searchChunk - 1} LIMIT 1`;
      const upTo = end?.sort_key ?? null;
      const matches = await db<BoqRow[]>`
        WITH c AS MATERIALIZED (
          SELECT id FROM est.boq_node
          WHERE boq_id = ${boqId} ${cursor === null ? db`` : db`AND sort_key > ${cursor}`}
            ${upTo === null ? db`` : db`AND sort_key <= ${upTo}`}
        )
        SELECT ${db.unsafe(ROW)}
        FROM c JOIN est.boq_node n ON n.boq_id = ${boqId} AND n.id = c.id
        JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE t.description ILIKE ${pattern} OR n.code ILIKE ${pattern}
        ORDER BY n.sort_key LIMIT ${want - found.length}`;
      found.push(...matches);
      if (upTo === null) done = true;
      cursor = upTo;
    }

    if (!done && found.length < want) {
      this.searchFallbacks++;
      const rest = await db<BoqRow[]>`
        WITH m AS MATERIALIZED (
          SELECT node_id AS id FROM est.boq_node_text WHERE boq_id = ${boqId} AND description ILIKE ${pattern}
          UNION
          SELECT id FROM est.boq_node WHERE boq_id = ${boqId} AND code ILIKE ${pattern}
        )
        SELECT ${db.unsafe(ROW)}
        FROM m JOIN est.boq_node n ON n.boq_id = ${boqId} AND n.id = m.id
        JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE true ${cursor === null ? db`` : db`AND n.sort_key > ${cursor}`}
        ORDER BY n.sort_key LIMIT ${want - found.length}`;
      found.push(...rest);
    }
    return { rows: found.slice(0, opts.limit), hasMore: found.length > opts.limit };
  }

  // --- editing ---

  /**
   * Applies a batch of edits atomically. `parentId`/`afterId` may name a `tempId` inserted earlier in the same batch.
   * Returns the fresh state of every touched row; `reload` means the change was structural (moved or deleted
   * subtrees), so the client should re-read its window.
   */
  async apply(claims: TenantClaims, boqId: string, ops: Op[]) {
    const db = await this.tenants.forTenant(claims.ten);
    // Checked before taking the lock: a running import holds it until it commits.
    if (await importRunning(db, boqId))
      throw new ConflictException({
        code: 'boq_importing',
        message: 'A file is being imported into this BOQ. Try again when it has finished.',
      });
    return db.begin(async (tx) => {
      const [boq] = await tx<
        { status: string; archived: boolean; rate_date: string; version_no: number }[]
      >`
        SELECT status, archived_at IS NOT NULL AS archived, rate_date::text, version_no FROM est.boq
        WHERE id = ${boqId} FOR UPDATE`;
      if (!boq) throw new NotFoundException({ code: 'boq_not_found' });
      refuseArchived(boq);
      if (boq.status !== 'draft') throw new ConflictException({ code: 'boq_locked' });

      const ctx: BatchContext = {
        tx,
        boqId,
        rateDate: boq.rate_date,
        version: boq.version_no,
        units: null,
        idMap: new Map(),
        touched: new Set(),
        deleted: new Set(),
        reload: false,
      };
      for (const [index, op] of ops.entries()) {
        try {
          if (op.op === 'insert') await this.insert(ctx, op);
          else if (op.op === 'update') await this.update(ctx, op);
          else if (op.op === 'delete') await this.remove(ctx, op);
          else if (op.op === 'move') await this.move(ctx, op);
          else await this.shift(ctx, op);
        } catch (err) {
          // Tell the client which op failed; the whole batch rolls back.
          const r = (err as { response?: Record<string, unknown> }).response;
          if (r && typeof r === 'object') Object.assign(r, { opIndex: index });
          throw err;
        }
      }
      await tx`UPDATE est.boq SET updated_at = now(), updated_by = ${claims.sub} WHERE id = ${boqId}`;
      const counts = ops.reduce<Record<string, number>>(
        (a, o) => ({ ...a, [o.op]: (a[o.op] ?? 0) + 1 }),
        {},
      );
      await audit(tx, claims.sub, 'boq.changes', boqId, counts);

      const live = [...ctx.touched].filter((id) => !ctx.deleted.has(id));
      if (live.length > MAX_TOUCHED_ROWS) ctx.reload = true;
      const rows =
        ctx.reload && live.length > MAX_TOUCHED_ROWS
          ? []
          : await tx<BoqRow[]>`
            SELECT ${tx.unsafe(ROW)}
            FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
            WHERE n.boq_id = ${boqId} AND n.id = ANY(${live}::bigint[]) ORDER BY n.sort_key`;
      const [header] = await tx`SELECT ${tx.unsafe(HEADER)} FROM est.boq b WHERE b.id = ${boqId}`;
      return {
        header,
        rows,
        deletedIds: [...ctx.deleted],
        idMap: Object.fromEntries(ctx.idMap),
        reload: ctx.reload,
      };
    });
  }

  /**
   * Turns a draft into a revised BOQ file (import, step 8). The planned inserts, moves and deletes go through the same
   * steps as edits in the grid (keys, pre-images, counts); field changes go in one statement per chunk; subtotals
   * and the total are worked out once at the end. Runs in the import's transaction with the BOQ row locked.
   */
  async applyRevision(
    tx: TransactionSql,
    boq: { id: string; version: number; rateDate: string },
    plan: { ops: Op[]; fields: FieldChange[] },
    progress: (done: number, of: number) => Promise<void>,
  ) {
    const ctx: BatchContext = {
      tx,
      boqId: boq.id,
      rateDate: boq.rateDate,
      version: boq.version,
      units: null,
      idMap: new Map(),
      touched: new Set(),
      deleted: new Set(),
      reload: true,
      importing: true,
    };
    const steps = plan.ops.length + plan.fields.length;
    for (const [i, op] of plan.ops.entries()) {
      if (op.op === 'insert') await this.insert(ctx, op);
      else if (op.op === 'move') await this.move(ctx, op);
      else if (op.op === 'delete') await this.remove(ctx, op);
      if (i % 25 === 0) await progress(i, steps);
    }
    const rev = { tx, boqId: boq.id, version: boq.version };
    for (let i = 0; i < plan.fields.length; i += 5000) {
      const chunk = plan.fields.slice(i, i + 5000);
      const text = chunk.filter((f) => f.textChanged).map((f) => f.id);
      if (text.length) await preImage(rev, tx`n.id = ANY(${text}::bigint[])`, true);
      await preImage(rev, tx`n.id = ANY(${chunk.map((f) => f.id)}::bigint[])`);
      // A rate from the file unlinks the analysis; no rate keeps both.
      await tx`
        WITH x AS (
          SELECT * FROM jsonb_to_recordset(${tx.json(
            chunk.map((f) => ({
              id: f.id,
              code: f.code,
              unit: f.unit,
              qty: f.qty,
              rate: f.rate,
              kind: f.kind,
              unmeasure: f.unmeasure,
            })),
          )}) AS x(id bigint, code text, unit text, qty numeric, rate numeric, kind text, unmeasure boolean)
        )
        UPDATE est.boq_node n SET code = x.code, unit = x.unit, qty = x.qty, rate = coalesce(x.rate, n.rate),
          rate_analysis_id = CASE WHEN x.rate IS NULL THEN n.rate_analysis_id END,
          foreign_currency = CASE WHEN x.rate IS NULL THEN n.foreign_currency END,
          foreign_rate = CASE WHEN x.rate IS NULL THEN n.foreign_rate END,
          item_kind = CASE WHEN n.node_type = 'item' THEN x.kind ELSE n.item_kind END,
          amount = CASE WHEN n.node_type = 'item' AND x.kind IN ('normal', 'provisional')
            THEN round(x.qty * coalesce(x.rate, n.rate), 2) END,
          measured = n.measured AND NOT x.unmeasure, row_version = n.row_version + 1
        FROM x WHERE n.boq_id = ${boq.id} AND n.id = x.id`;
      const texts = chunk.filter((f) => f.textChanged);
      if (texts.length)
        await tx`
          UPDATE est.boq_node_text t SET description = x.description, notes = x.notes
          FROM jsonb_to_recordset(${tx.json(
            texts.map((f) => ({ id: f.id, description: f.description, notes: f.notes })),
          )}) AS x(id bigint, description text, notes text)
          WHERE t.boq_id = ${boq.id} AND t.node_id = x.id`;
      await progress(plan.ops.length + i, steps);
    }
    await preImage(rev, tx`n.node_type = 'section'`);
    await recomputeTotals(tx, boq.id);
  }

  private async insert(ctx: BatchContext, op: Extract<Op, { op: 'insert' }>) {
    const { tx, boqId } = ctx;
    if (ctx.idMap.has(op.tempId)) throw new BadRequestException({ code: 'duplicate_temp_id' });
    if (
      op.type !== 'item' &&
      (op.qty != null ||
        op.rate != null ||
        op.rateAnalysisId != null ||
        (op.kind ?? 'normal') !== 'normal')
    )
      throw new BadRequestException({ code: 'qty_rate_on_non_item' });
    const kind: ItemKind = op.kind ?? 'normal';
    const link = op.rateAnalysisId
      ? await this.fromAnalysis(ctx, op.rateAnalysisId, op.unit ?? null)
      : null;
    const unit = op.unit ?? link?.unit ?? null;
    const foreign = link ? null : await this.foreignRate(ctx, op);
    const rate = link ? link.rate : foreign ? foreign.rate : (op.rate ?? null);
    const description = op.description || link?.description || '';
    const parent = await this.parentNode(ctx, op.parentId);
    const key = await this.keyFor(ctx, parent, op.afterId, null);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_DEPTH) throw new BadRequestException({ code: 'too_deep' });

    const [row] = await tx<{ id: string; value: string }[]>`
      INSERT INTO est.boq_node (boq_id, parent_id, sort_key, depth, node_type, code, unit, qty, rate, amount,
        rate_analysis_id, created_version, item_kind, foreign_currency, foreign_rate)
      VALUES (${boqId}, ${parent?.id ?? null}, ${key}, ${depth}, ${op.type}, ${op.code ?? null}, ${unit},
              ${op.qty ?? null}::numeric, ${rate}::numeric,
              ${counted(kind) ? tx`round(${op.qty ?? null}::numeric * ${rate}::numeric, 2)` : tx`NULL`},
              ${op.rateAnalysisId ?? null}, ${ctx.version}, ${kind}, ${foreign?.currency ?? null},
              ${foreign?.foreignRate ?? null}::numeric)
      RETURNING id::text, coalesce(amount, 0)::text AS value`;
    await tx`INSERT INTO est.boq_node_text (boq_id, node_id, description, notes)
      VALUES (${boqId}, ${row!.id}, ${description}, ${op.notes ?? ''})`;
    ctx.idMap.set(op.tempId, row!.id);
    ctx.touched.add(row!.id);
    if (parent) {
      await preImage(ctx, tx`n.id = ${parent.id}`);
      await tx`UPDATE est.boq_node SET child_count = child_count + 1
        WHERE boq_id = ${boqId} AND id = ${parent.id}`;
      ctx.touched.add(parent.id);
    }
    await this.propagate(ctx, key, row!.value);
    await tx`UPDATE est.boq SET node_count = node_count + 1,
        item_count = item_count + ${op.type === 'item' ? 1 : 0} WHERE id = ${boqId}`;
  }

  private async update(ctx: BatchContext, op: Extract<Op, { op: 'update' }>) {
    const { tx, boqId } = ctx;
    const node = await this.lockNode(ctx, op.id, op.rowVersion);
    if (
      node.node_type !== 'item' &&
      (op.qty !== undefined ||
        op.rate !== undefined ||
        op.rateAnalysisId != null ||
        (op.kind ?? 'normal') !== 'normal')
    )
      throw new BadRequestException({ code: 'qty_rate_on_non_item' });
    const kind: ItemKind = op.kind ?? node.item_kind;
    if (op.qty !== undefined && node.measured && !ctx.measuring)
      throw new ConflictException({
        code: 'qty_from_measurements',
        id: op.id,
        message:
          'This quantity comes from its measurement sheet. Change the sheet, or clear it to type a quantity.',
      });
    // Absent fields keep their value; null clears. Amount follows qty × rate for items.
    const next = (field: 'code' | 'unit' | 'qty' | 'rate') =>
      op[field] !== undefined ? op[field] : node[field];
    // The analysis link: applying one sets the rate; typing a rate by hand unlinks; otherwise it stays.
    let unit = next('unit');
    let rate = next('rate');
    let link = tx`rate_analysis_id`;
    // A foreign rate sets the rupee rate; a rupee rate typed (or an analysis applied) ends the foreign pricing.
    let foreignSet = tx`foreign_currency = foreign_currency, foreign_rate = foreign_rate`;
    const foreign = await this.foreignRate(ctx, op);
    if (foreign) {
      rate = foreign.rate;
      foreignSet = tx`foreign_currency = ${foreign.currency}, foreign_rate = ${foreign.foreignRate}::numeric`;
    } else if (op.rate !== undefined || op.rateAnalysisId || op.currency === null)
      foreignSet = tx`foreign_currency = NULL, foreign_rate = NULL`;
    if (op.rateAnalysisId) {
      const l = await this.fromAnalysis(ctx, op.rateAnalysisId, unit);
      rate = l.rate;
      unit ??= l.unit;
      link = tx`${op.rateAnalysisId}::uuid`;
    } else if (op.rateAnalysisId === null || op.rate !== undefined) link = tx`NULL`;
    const textChanges = op.description !== undefined || op.notes !== undefined;
    await preImage(ctx, tx`n.id = ${node.id}`, textChanges);
    const [row] = await tx<{ delta: string }[]>`
      UPDATE est.boq_node SET code = ${next('code')}, unit = ${unit},
        qty = ${next('qty')}::numeric, rate = ${rate}::numeric,
        amount = CASE WHEN node_type = 'item' AND ${counted(kind)}
          THEN round(${next('qty')}::numeric * ${rate}::numeric, 2) END,
        rate_analysis_id = ${foreign ? tx`NULL` : link}, item_kind = ${kind}, ${foreignSet},
        row_version = row_version + 1
      WHERE boq_id = ${boqId} AND id = ${node.id}
      RETURNING (coalesce(amount, 0) - ${node.amount ?? '0'}::numeric)::text AS delta`;
    if (op.description !== undefined || op.notes !== undefined) {
      const text = Object.fromEntries(
        Object.entries({ description: op.description, notes: op.notes }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      await tx`UPDATE est.boq_node_text SET ${tx(text)} WHERE boq_id = ${boqId} AND node_id = ${node.id}`;
    }
    ctx.touched.add(node.id);
    await this.propagate(ctx, node.sort_key, row!.delta);
  }

  private async remove(ctx: BatchContext, op: Extract<Op, { op: 'delete' }>) {
    const { tx, boqId } = ctx;
    const node = await this.lockNode(ctx, op.id, op.rowVersion);
    const value = nodeValue(node);
    await preImage(
      ctx,
      tx`n.sort_key >= ${node.sort_key} AND n.sort_key < ${node.sort_key + SUBTREE_END}`,
      true,
    );
    const removed = await tx<{ id: string; node_type: NodeType }[]>`
      DELETE FROM est.boq_node
      WHERE boq_id = ${boqId} AND sort_key >= ${node.sort_key} AND sort_key < ${node.sort_key + SUBTREE_END}
      RETURNING id::text, node_type`;
    for (const r of removed) ctx.deleted.add(r.id);
    if (removed.length > 1) ctx.reload = true;
    if (node.parent_id) {
      await preImage(ctx, tx`n.id = ${node.parent_id}`);
      await tx`UPDATE est.boq_node SET child_count = child_count - 1
        WHERE boq_id = ${boqId} AND id = ${node.parent_id}`;
      ctx.touched.add(node.parent_id);
    }
    await this.propagate(ctx, node.sort_key, value, -1);
    await tx`UPDATE est.boq SET node_count = node_count - ${removed.length},
        item_count = item_count - ${removed.filter((r) => r.node_type === 'item').length} WHERE id = ${boqId}`;
  }

  private async move(ctx: BatchContext, op: Extract<Op, { op: 'move' }>) {
    const node = await this.lockNode(ctx, op.id, op.rowVersion);
    const parent = await this.parentNode(ctx, op.parentId);
    await this.relocate(ctx, node, parent, op.afterId);
  }

  private async shift(ctx: BatchContext, op: Extract<Op, { op: 'shift' }>) {
    const node = await this.lockNode(ctx, op.id, op.rowVersion);
    const parentKey = splitKey(node.sort_key).parent;
    const parent = parentKey ? await this.nodeByKey(ctx, parentKey) : null;
    const cannot = () => new BadRequestException({ code: 'cannot_shift', direction: op.direction });
    if (op.direction === 'up') {
      const prev = await this.siblingKey(ctx, node.sort_key, 'prev');
      if (!prev) throw cannot();
      const before = await this.siblingKey(ctx, prev, 'prev');
      const after = before ? (await this.nodeByKey(ctx, before)).id : null;
      await this.relocate(ctx, node, parent, after);
    } else if (op.direction === 'down') {
      const next = await this.siblingKey(ctx, node.sort_key, 'next');
      if (!next) throw cannot();
      await this.relocate(ctx, node, parent, (await this.nodeByKey(ctx, next)).id);
    } else if (op.direction === 'in') {
      const prev = await this.siblingKey(ctx, node.sort_key, 'prev');
      const target = prev ? await this.nodeByKey(ctx, prev) : null;
      if (!target || target.node_type !== 'section') throw cannot();
      await this.relocate(ctx, node, target, 'last');
    } else {
      if (!parent) throw cannot();
      const grandKey = splitKey(parent.sort_key).parent;
      const grand = grandKey ? await this.nodeByKey(ctx, grandKey) : null;
      await this.relocate(ctx, node, grand, parent.id);
    }
  }

  /** Moves `node` (and its subtree) under `parent`, after sibling `afterId` (null = first, 'last' = last). */
  private async relocate(
    ctx: BatchContext,
    node: NodeRef,
    parent: NodeRef | null,
    afterId: string | null | 'last',
  ) {
    const { tx, boqId } = ctx;
    if (
      parent &&
      (parent.sort_key === node.sort_key || parent.sort_key.startsWith(node.sort_key + '!'))
    )
      throw new BadRequestException({ code: 'move_into_self' });
    const newKey = await this.keyFor(ctx, parent, afterId, node.id);
    const newDepth = parent ? parent.depth + 1 : 0;
    const shift = newDepth - node.depth;
    const [sub] = await tx<{ deepest: number }[]>`
      SELECT max(depth)::int AS deepest FROM est.boq_node
      WHERE boq_id = ${boqId} AND sort_key >= ${node.sort_key} AND sort_key < ${node.sort_key + SUBTREE_END}`;
    const deepest = sub?.deepest ?? node.depth;
    if (deepest + shift > MAX_DEPTH) throw new BadRequestException({ code: 'too_deep' });

    const value = nodeValue(node);
    await this.propagate(ctx, node.sort_key, value, -1);
    if (node.parent_id) {
      await preImage(ctx, tx`n.id = ${node.parent_id}`);
      await tx`UPDATE est.boq_node SET child_count = child_count - 1
        WHERE boq_id = ${boqId} AND id = ${node.parent_id}`;
      ctx.touched.add(node.parent_id);
    }
    await preImage(
      ctx,
      tx`n.sort_key >= ${node.sort_key} AND n.sort_key < ${node.sort_key + SUBTREE_END}`,
    );
    // The new key is fresh and its range empty, so rewriting the subtree's prefix can never collide.
    await tx`UPDATE est.boq_node
      SET sort_key = ${newKey} || substr(sort_key, ${node.sort_key.length + 1}), depth = depth + ${shift}
      WHERE boq_id = ${boqId} AND sort_key >= ${node.sort_key} AND sort_key < ${node.sort_key + SUBTREE_END}`;
    await tx`UPDATE est.boq_node SET parent_id = ${parent?.id ?? null}, row_version = row_version + 1
      WHERE boq_id = ${boqId} AND id = ${node.id}`;
    if (parent) {
      await preImage(ctx, tx`n.id = ${parent.id}`);
      await tx`UPDATE est.boq_node SET child_count = child_count + 1
        WHERE boq_id = ${boqId} AND id = ${parent.id}`;
      ctx.touched.add(parent.id);
    }
    await this.propagate(ctx, newKey, value);
    ctx.touched.add(node.id);
    ctx.reload = true;
  }

  // --- helpers ---

  /** Adds `sign × delta` to every ancestor's subtotal and to the BOQ total. */
  private async propagate(ctx: BatchContext, key: string, delta: string, sign: 1 | -1 = 1) {
    if (ctx.importing || /^-?0+(\.0+)?$/.test(delta)) return;
    if (sign === -1) delta = delta.startsWith('-') ? delta.slice(1) : `-${delta}`;
    const { tx, boqId } = ctx;
    const ancestors = ancestorKeys(key);
    if (ancestors.length) {
      await preImage(ctx, tx`n.sort_key = ANY(${ancestors})`);
      const ids = await tx<{ id: string }[]>`
        UPDATE est.boq_node SET subtotal = subtotal + ${delta}::numeric
        WHERE boq_id = ${boqId} AND sort_key = ANY(${ancestors}) RETURNING id::text`;
      for (const r of ids) ctx.touched.add(r.id);
    }
    await tx`UPDATE est.boq SET total = total + ${delta}::numeric WHERE id = ${boqId}`;
  }

  /** The rupee rate of a foreign rate in an op (`foreignRate` with `currency`), or null when the op has none. */
  private async foreignRate(ctx: BatchContext, op: LineFields) {
    if (op.foreignRate == null || !op.currency) return null;
    if (!ctx.fx)
      ctx.fx = new Map(
        (
          await ctx.tx<{ code: string; rate: string }[]>`
            SELECT code, rate::text FROM est.boq_currency WHERE boq_id = ${ctx.boqId}`
        ).map((r) => [r.code, r.rate]),
      );
    const fx = ctx.fx.get(op.currency);
    if (!fx)
      throw new BadRequestException({
        code: 'no_exchange_rate',
        message: `Set the exchange rate for ${op.currency} first (Currencies, on the BOQ).`,
      });
    return {
      currency: op.currency,
      foreignRate: op.foreignRate,
      rate: fmt(mul(dec(op.foreignRate), dec(fx)), 2),
    };
  }

  private resolve(ctx: BatchContext, id: string): string {
    return ctx.idMap.get(id) ?? id;
  }

  private async lockNode(ctx: BatchContext, rawId: string, rowVersion: number): Promise<NodeRef> {
    const id = this.resolve(ctx, rawId);
    const [n] = await ctx.tx<NodeRef[]>`
      SELECT id::text, parent_id::text, sort_key, depth, node_type, code, unit, qty::text, rate::text,
        amount::text, subtotal::text, row_version, measured, item_kind, foreign_currency
      FROM est.boq_node WHERE boq_id = ${ctx.boqId} AND id = ${id} FOR UPDATE`;
    if (!n) throw new NotFoundException({ code: 'line_not_found', id: rawId });
    // Rows inserted earlier in this batch have no version on the client yet.
    if (!ctx.importing && !ctx.idMap.has(rawId) && n.row_version !== rowVersion)
      throw new ConflictException({
        code: 'stale_row',
        id: rawId,
        message: 'Someone else changed this line. Reload to see their changes.',
      });
    return n;
  }

  private async parentNode(ctx: BatchContext, rawId: string | null): Promise<NodeRef | null> {
    if (rawId === null) return null;
    const id = this.resolve(ctx, rawId);
    const [p] = await ctx.tx<NodeRef[]>`
      SELECT id::text, parent_id::text, sort_key, depth, node_type, code, unit, qty::text, rate::text,
        amount::text, subtotal::text, row_version, item_kind
      FROM est.boq_node WHERE boq_id = ${ctx.boqId} AND id = ${id}`;
    if (!p) throw new NotFoundException({ code: 'line_not_found', id: rawId });
    if (p.node_type !== 'section') throw new BadRequestException({ code: 'parent_not_section' });
    return p;
  }

  /**
   * A fresh key under `parent`, directly after sibling `afterId` (or first when null). `moving` is excluded as a
   * neighbour so a line can be moved next to its own old position.
   */
  private async keyFor(
    ctx: BatchContext,
    parent: NodeRef | null,
    rawAfterId: string | null | 'last',
    moving: string | null,
  ): Promise<string> {
    const { tx, boqId } = ctx;
    const parentKey = parent?.sort_key ?? '';
    const notMoving = moving
      ? tx`AND NOT (sort_key >= (SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId} AND id = ${moving})
             AND sort_key < (SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId} AND id = ${moving}) || ${SUBTREE_END})`
      : tx``;
    if (rawAfterId === 'last') {
      // The last key in the parent's range belongs to its last child (or that child's last descendant).
      const [last] = await tx<{ sort_key: string }[]>`
        SELECT sort_key FROM est.boq_node
        WHERE boq_id = ${boqId} ${parent ? tx`AND sort_key > ${parentKey + '!'} AND sort_key < ${parentKey + SUBTREE_END}` : tx``}
          ${notMoving}
        ORDER BY sort_key DESC LIMIT 1`;
      const rest = last
        ? parent
          ? last.sort_key.slice(parentKey.length + 1)
          : last.sort_key
        : null;
      return childKey(parentKey, midpoint(rest ? rest.split('!')[0]! : '', null));
    }
    let lower = '';
    let from: string; // the next row after this key is the candidate upper neighbour
    if (rawAfterId !== null) {
      const afterId = this.resolve(ctx, rawAfterId);
      if (afterId === moving) throw new BadRequestException({ code: 'invalid_position' });
      const [after] = await tx<{ sort_key: string; parent_id: string | null }[]>`
        SELECT sort_key, parent_id::text FROM est.boq_node WHERE boq_id = ${boqId} AND id = ${afterId}`;
      if (!after) throw new NotFoundException({ code: 'line_not_found', id: rawAfterId });
      if ((after.parent_id ?? null) !== (parent?.id ?? null))
        throw new BadRequestException({ code: 'after_not_sibling' });
      lower = splitKey(after.sort_key).segment;
      from = after.sort_key + SUBTREE_END;
    } else {
      from = parent ? parentKey + '!' : '';
    }
    const neighbours = await tx<{ sort_key: string; id: string }[]>`
      SELECT sort_key, id::text FROM est.boq_node
      WHERE boq_id = ${boqId} AND sort_key > ${from} ${notMoving}
      ORDER BY sort_key LIMIT 1`;
    const next = neighbours[0] ? splitKey(neighbours[0].sort_key) : null;
    const upper = next && next.parent === parentKey ? next.segment : null;
    return childKey(parentKey, midpoint(lower, upper));
  }

  private async nodeByKey(ctx: BatchContext, key: string): Promise<NodeRef> {
    const [n] = await ctx.tx<NodeRef[]>`
      SELECT id::text, parent_id::text, sort_key, depth, node_type, code, unit, qty::text, rate::text,
        amount::text, subtotal::text, row_version, item_kind
      FROM est.boq_node WHERE boq_id = ${ctx.boqId} AND sort_key = ${key}`;
    if (!n) throw new NotFoundException({ code: 'line_not_found' });
    return n;
  }

  /** Key of the previous or next sibling of the line at `key`, if any. */
  private async siblingKey(
    ctx: BatchContext,
    key: string,
    which: 'prev' | 'next',
  ): Promise<string | null> {
    const { tx, boqId } = ctx;
    const parentKey = splitKey(key).parent;
    const depth = key.split('!').length;
    if (which === 'prev') {
      // The row just before this one, within the parent, is the previous sibling or its last descendant.
      const [r] = await tx<{ sort_key: string }[]>`
        SELECT sort_key FROM est.boq_node
        WHERE boq_id = ${boqId} AND sort_key < ${key} ${parentKey ? tx`AND sort_key > ${parentKey + '!'}` : tx``}
        ORDER BY sort_key DESC LIMIT 1`;
      return r ? r.sort_key.split('!').slice(0, depth).join('!') : null;
    }
    // The first row after this line's subtree, within the parent, is the next sibling itself.
    const [r] = await tx<{ sort_key: string }[]>`
      SELECT sort_key FROM est.boq_node
      WHERE boq_id = ${boqId} AND sort_key > ${key + SUBTREE_END}
        ${parentKey ? tx`AND sort_key < ${parentKey + SUBTREE_END}` : tx``}
      ORDER BY sort_key LIMIT 1`;
    return r ? r.sort_key : null;
  }

  // --- measurement sheets ---

  async measurements(claims: TenantClaims, boqId: string, nodeId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [n] = await db`SELECT 1 FROM est.boq_node WHERE boq_id = ${boqId} AND id = ${nodeId}`;
    if (!n) throw new NotFoundException({ code: 'line_not_found' });
    return db`
      SELECT seq, description, nos::text, length::text, breadth::text, height::text, deduct, qty::text
      FROM est.measurement WHERE boq_id = ${boqId} AND node_id = ${nodeId} ORDER BY seq`;
  }

  /**
   * Replaces an item's measurement sheet. The item's quantity becomes the rows' total (amount and every subtotal
   * follow, as for any edit); no rows clears the sheet and leaves the quantity as it was, to be typed again.
   */
  async setMeasurements(
    claims: TenantClaims,
    boqId: string,
    nodeId: string,
    rowVersion: number,
    rows: MeasurementInput[],
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (await importRunning(db, boqId))
      throw new ConflictException({
        code: 'boq_importing',
        message: 'A file is being imported into this BOQ. Try again when it has finished.',
      });
    return db.begin(async (tx) => {
      const [boq] = await tx<
        { status: string; archived: boolean; rate_date: string; version_no: number }[]
      >`
        SELECT status, archived_at IS NOT NULL AS archived, rate_date::text, version_no FROM est.boq
        WHERE id = ${boqId} FOR UPDATE`;
      if (!boq) throw new NotFoundException({ code: 'boq_not_found' });
      refuseArchived(boq);
      if (boq.status !== 'draft') throw new ConflictException({ code: 'boq_locked' });
      const ctx: BatchContext = {
        tx,
        boqId,
        rateDate: boq.rate_date,
        version: boq.version_no,
        units: null,
        idMap: new Map(),
        touched: new Set(),
        deleted: new Set(),
        reload: false,
        measuring: true,
      };
      const node = await this.lockNode(ctx, nodeId, rowVersion);
      if (node.node_type !== 'item')
        throw new BadRequestException({
          code: 'not_an_item',
          message: 'Only items have measurements.',
        });
      const measured = rows.map((r, i) => ({ ...r, seq: i + 1, qty: measuredQty(r) }));
      await tx`DELETE FROM est.measurement WHERE boq_id = ${boqId} AND node_id = ${node.id}`;
      if (measured.length > 0) {
        await tx`
          INSERT INTO est.measurement (boq_id, node_id, seq, description, nos, length, breadth, height, deduct, qty)
          SELECT ${boqId}, ${node.id}, x.seq, x.description, x.nos, x.length, x.breadth, x.height, x.deduct, x.qty
          FROM jsonb_to_recordset(${tx.json(measured)}) AS x(seq int, description text, nos numeric,
            length numeric, breadth numeric, height numeric, deduct boolean, qty numeric)`;
        await this.update(ctx, {
          op: 'update',
          id: node.id,
          rowVersion,
          qty: sumQty(measured.map((m) => m.qty)),
        });
      } else if (node.measured) {
        await preImage(ctx, tx`n.id = ${node.id}`);
        await tx`UPDATE est.boq_node SET row_version = row_version + 1
          WHERE boq_id = ${boqId} AND id = ${node.id}`;
      }
      await tx`UPDATE est.boq_node SET measured = ${measured.length > 0}
        WHERE boq_id = ${boqId} AND id = ${node.id}`;
      await tx`UPDATE est.boq SET updated_at = now(), updated_by = ${claims.sub} WHERE id = ${boqId}`;
      await audit(tx, claims.sub, 'boq.measurements', boqId, {
        line: node.id,
        rows: measured.length,
      });
      const live = [...ctx.touched, node.id];
      const changed = await tx<BoqRow[]>`
        SELECT ${tx.unsafe(ROW)}
        FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE n.boq_id = ${boqId} AND n.id = ANY(${live}::bigint[]) ORDER BY n.sort_key`;
      const [header] = await tx`SELECT ${tx.unsafe(HEADER)} FROM est.boq b WHERE b.id = ${boqId}`;
      return {
        header,
        rows: changed,
        measurements: measured.map(
          ({ seq, description, nos, length, breadth, height, deduct, qty }) => ({
            seq,
            description,
            nos,
            length,
            breadth,
            height,
            deduct,
            qty,
          }),
        ),
      };
    });
  }

  /** The rate an analysis gives on the BOQ's rate date, refusing a unit that does not match the item's. */
  private async fromAnalysis(ctx: BatchContext, analysisId: string, itemUnit: string | null) {
    const a = await this.rates.boqRate(ctx.tx, analysisId, ctx.rateDate);
    ctx.units ??= await loadUnitMap(ctx.tx);
    if (itemUnit && !sameUnit(ctx.units, itemUnit, a.unit))
      throw new ConflictException({
        code: 'unit_mismatch',
        message: `The analysis is priced per ${a.unit}; this item is measured in ${itemUnit}.`,
      });
    return { rate: a.boqRate, unit: a.unit, description: a.description };
  }

  // --- currencies (migration 0018) ---

  /** The BOQ's exchange rates, with how many items are priced in each and their value. */
  async currencies(claims: TenantClaims, boqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT c.code, c.rate::text AS rate, c.updated_at AS "updatedAt",
        (SELECT count(*)::int FROM est.boq_node n WHERE n.boq_id = c.boq_id AND n.foreign_currency = c.code) AS items
      FROM est.boq_currency c WHERE c.boq_id = ${boqId} ORDER BY c.code`;
  }

  /**
   * Sets (or adds) an exchange rate and re-prices every item priced in that currency at it, with the totals.
   */
  async setCurrency(claims: TenantClaims, boqId: string, code: string, rate: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const changed = await db.begin(async (tx) => {
      const boq = await this.draftForChange(tx, boqId);
      await tx`
        INSERT INTO est.boq_currency (boq_id, code, rate, updated_by) VALUES (${boqId}, ${code}, ${rate}, ${claims.sub})
        ON CONFLICT (boq_id, code) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now(),
          updated_by = EXCLUDED.updated_by`;
      const these = tx`n.foreign_currency = ${code}`;
      const rev = { tx, boqId, version: boq.version_no };
      await preImage(rev, these);
      const [r] = await tx<{ changed: number }[]>`
        WITH upd AS (
          UPDATE est.boq_node n SET rate = round(n.foreign_rate * ${rate}::numeric, 2),
            amount = CASE WHEN n.item_kind IN ('normal', 'provisional')
              THEN round(n.qty * round(n.foreign_rate * ${rate}::numeric, 2), 2) END,
            row_version = n.row_version + 1
          WHERE n.boq_id = ${boqId} AND ${these} AND n.rate IS DISTINCT FROM round(n.foreign_rate * ${rate}::numeric, 2)
          RETURNING 1
        ) SELECT count(*)::int AS changed FROM upd`;
      if (r!.changed > 0) {
        await preImage(rev, tx`n.node_type = 'section'`);
        await recomputeTotals(tx, boqId);
      }
      await tx`UPDATE est.boq SET updated_at = now(), updated_by = ${claims.sub} WHERE id = ${boqId}`;
      await audit(tx, claims.sub, 'boq.currency', boqId, { code, rate, changed: r!.changed });
      return r!.changed;
    });
    const [h] = await db<{ total: string }[]>`SELECT total::text FROM est.boq WHERE id = ${boqId}`;
    return { changed, total: h!.total, currencies: await this.currencies(claims, boqId) };
  }

  /** Removes an exchange rate no item is priced in. */
  async removeCurrency(claims: TenantClaims, boqId: string, code: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.draftForChange(tx, boqId);
      const [used] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM est.boq_node WHERE boq_id = ${boqId} AND foreign_currency = ${code}`;
      if (used!.n > 0)
        throw new ConflictException({
          code: 'currency_in_use',
          message: `${used!.n} item${used!.n === 1 ? ' is' : 's are'} priced in ${code}. Price them in rupees first.`,
        });
      await tx`DELETE FROM est.boq_currency WHERE boq_id = ${boqId} AND code = ${code}`;
    });
    return this.currencies(claims, boqId);
  }

  /** Locks a draft BOQ for a set-based change (refused while archived, frozen or importing). */
  private async draftForChange(tx: TransactionSql, boqId: string) {
    const [boq] = await tx<{ status: string; archived: boolean; version_no: number }[]>`
      SELECT status, archived_at IS NOT NULL AS archived, version_no FROM est.boq WHERE id = ${boqId} FOR UPDATE`;
    if (!boq) throw new NotFoundException({ code: 'boq_not_found' });
    refuseArchived(boq);
    if (boq.status !== 'draft') throw new ConflictException({ code: 'boq_locked' });
    if (await importRunning(tx, boqId))
      throw new ConflictException({
        code: 'boq_importing',
        message: 'A file is being imported into this BOQ. Try again when it has finished.',
      });
    return boq;
  }

  /**
   * One change to every item in a range of lines (by sort key, sections' contents included): a unit, a kind, a rate,
   * rates raised or lowered by a percentage, or rates cleared. Set-based, so a selection of 50,000 items is one
   * statement; totals are then recomputed. A rate set here unlinks the item's rate analysis, as typing it would.
   */
  async bulk(
    claims: TenantClaims,
    boqId: string,
    range: { from: string; to: string },
    action: BulkAction,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (await importRunning(db, boqId))
      throw new ConflictException({
        code: 'boq_importing',
        message: 'A file is being imported into this BOQ. Try again when it has finished.',
      });
    const [from, to] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from];
    return db.begin(async (tx) => {
      const [boq] = await tx<{ status: string; archived: boolean; version_no: number }[]>`
        SELECT status, archived_at IS NOT NULL AS archived, version_no FROM est.boq WHERE id = ${boqId} FOR UPDATE`;
      if (!boq) throw new NotFoundException({ code: 'boq_not_found' });
      refuseArchived(boq);
      if (boq.status !== 'draft') throw new ConflictException({ code: 'boq_locked' });
      // Everything from `from` to the end of `to`'s subtree.
      const inRange = tx`n.node_type = 'item' AND n.sort_key >= ${from} AND n.sort_key < ${to + SUBTREE_END}`;
      const set =
        action.kind === 'unit'
          ? tx`unit = ${action.unit}`
          : action.kind === 'item_kind'
            ? tx`item_kind = ${action.itemKind}`
            : action.kind === 'rate'
              ? tx`rate = ${action.rate}::numeric, rate_analysis_id = NULL, foreign_currency = NULL,
                  foreign_rate = NULL`
              : action.kind === 'scale'
                ? // A foreign-currency item: its foreign rate changes, and the rupee rate follows the exchange rate.
                  tx`foreign_rate = round(n.foreign_rate * (1 + ${action.pct}::numeric / 100), 4),
                    rate = CASE WHEN n.foreign_currency IS NULL
                      THEN round(n.rate * (1 + ${action.pct}::numeric / 100), 2)
                      ELSE round(round(n.foreign_rate * (1 + ${action.pct}::numeric / 100), 4)
                        * (SELECT c.rate FROM est.boq_currency c
                           WHERE c.boq_id = n.boq_id AND c.code = n.foreign_currency), 2) END,
                    rate_analysis_id = NULL`
                : tx`rate = NULL, rate_analysis_id = NULL, foreign_currency = NULL, foreign_rate = NULL`;
      const only = action.kind === 'scale' ? tx`AND n.rate IS NOT NULL` : tx``;
      const rev = { tx, boqId, version: boq.version_no };
      await preImage(rev, tx`${inRange} ${only}`);
      const [r] = await tx<{ changed: number }[]>`
        WITH upd AS (
          UPDATE est.boq_node n SET ${set}, row_version = n.row_version + 1
          WHERE n.boq_id = ${boqId} AND ${inRange} ${only}
          RETURNING n.id
        )
        SELECT count(*)::int AS changed FROM upd`;
      // A second statement, so it sees the new rates and kinds (one statement cannot update a row twice).
      await tx`
        UPDATE est.boq_node n SET amount = CASE WHEN n.item_kind IN ('normal', 'provisional')
          THEN round(n.qty * n.rate, 2) END
        WHERE n.boq_id = ${boqId} AND ${inRange}
          AND n.amount IS DISTINCT FROM CASE WHEN n.item_kind IN ('normal', 'provisional')
            THEN round(n.qty * n.rate, 2) END`;
      if (r!.changed > MAX_BULK_ITEMS)
        throw new BadRequestException({
          code: 'too_many_lines',
          message: `A bulk change covers up to ${MAX_BULK_ITEMS.toLocaleString('en-IN')} items at a time.`,
        });
      if (r!.changed > 0) {
        await preImage(rev, tx`n.node_type = 'section'`);
        await recomputeTotals(tx, boqId);
      }
      await tx`UPDATE est.boq SET updated_at = now(), updated_by = ${claims.sub} WHERE id = ${boqId}`;
      await audit(tx, claims.sub, 'boq.bulk', boqId, { from, to, action, changed: r!.changed });
      const [h] = await tx<
        { total: string }[]
      >`SELECT total::text FROM est.boq WHERE id = ${boqId}`;
      return { changed: r!.changed, total: h!.total };
    });
  }

  /**
   * Re-prices every item linked to an analysis, as on the BOQ's rate date, then recomputes all subtotals and the
   * total in a few set-based statements. Refused when any linked analysis has a resource without a rate on that date.
   */
  async refreshRates(claims: TenantClaims, boqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    if (await importRunning(db, boqId))
      throw new ConflictException({
        code: 'boq_importing',
        message: 'A file is being imported into this BOQ. Try again when it has finished.',
      });
    return db.begin(async (tx) => {
      const [boq] = await tx<
        { status: string; archived: boolean; rate_date: string; version_no: number }[]
      >`
        SELECT status, archived_at IS NOT NULL AS archived, rate_date::text, version_no FROM est.boq
        WHERE id = ${boqId} FOR UPDATE`;
      if (!boq) throw new NotFoundException({ code: 'boq_not_found' });
      refuseArchived(boq);
      if (boq.status !== 'draft') throw new ConflictException({ code: 'boq_locked' });
      const used = await tx<{ id: string; items: number }[]>`
        SELECT rate_analysis_id::text AS id, count(*)::int AS items FROM est.boq_node
        WHERE boq_id = ${boqId} AND rate_analysis_id IS NOT NULL GROUP BY rate_analysis_id`;
      const engine = await this.rates.engineFor(
        tx,
        used.map((u) => u.id),
        boq.rate_date,
      );
      const priced = used.map((u) => ({ ...u, ...engine.cost(u.id) }));
      const missing = priced.filter((p) => p.missing.length > 0);
      if (missing.length > 0) {
        const codes = [...new Set(missing.flatMap((m) => m.missing.map((r) => r.code)))];
        throw new ConflictException({
          code: 'missing_rates',
          missing: missing.flatMap((m) => m.missing),
          message: `No rate on ${boq.rate_date} for ${codes.slice(0, 10).join(', ')}${codes.length > 10 ? ' and more' : ''}.`,
        });
      }
      const rev = { tx, boqId, version: boq.version_no };
      const prev = boq.version_no - 1;
      // One pass over the lines: keep pre-images (in a revision) and re-price, from the same snapshot. Separate
      // statements would rewrite every changed line twice.
      const [{ changed }] =
        priced.length === 0
          ? [{ changed: 0 }]
          : ((await tx<{ changed: number }[]>`
            WITH x AS (
              SELECT * FROM jsonb_to_recordset(${tx.json(priced.map((p) => ({ id: p.id, rate: p.boqRate })))})
                AS x(id uuid, rate numeric)
            ),
            kept AS (
              INSERT INTO est.boq_node_hist (boq_id, line_key, frozen_version, id, parent_id, sort_key, depth,
                node_type, code, unit, qty, rate, amount, subtotal, child_count, rate_analysis_id, measured,
                created_version, item_kind, foreign_currency, foreign_rate)
              SELECT n.boq_id, n.line_key, ${prev}, n.id, n.parent_id, n.sort_key, n.depth, n.node_type, n.code,
                n.unit, n.qty, n.rate, n.amount, n.subtotal, n.child_count, n.rate_analysis_id, n.measured,
                n.created_version, n.item_kind, n.foreign_currency, n.foreign_rate
              FROM est.boq_node n JOIN x ON n.rate_analysis_id = x.id
              WHERE ${prev} > 0 AND n.boq_id = ${boqId} AND n.rate IS DISTINCT FROM x.rate
                AND n.created_version <= ${prev} AND n.hist_version < ${prev}
            ),
            upd AS (
              UPDATE est.boq_node n SET rate = x.rate,
                amount = CASE WHEN n.item_kind IN ('normal', 'provisional') THEN round(n.qty * x.rate, 2) END,
                row_version = n.row_version + 1,
                hist_version = CASE WHEN ${prev} > 0 AND n.created_version <= ${prev}
                  THEN greatest(n.hist_version, ${prev}) ELSE n.hist_version END
              FROM x
              WHERE n.boq_id = ${boqId} AND n.rate_analysis_id = x.id AND n.rate IS DISTINCT FROM x.rate
              RETURNING 1
            )
            SELECT count(*)::int AS changed FROM upd`) as unknown as [{ changed: number }]);
      if (changed > 0) {
        await preImage(rev, tx`n.node_type = 'section'`);
        await recomputeTotals(tx, boqId);
      }
      await tx`UPDATE est.boq SET updated_at = now(), updated_by = ${claims.sub} WHERE id = ${boqId}`;
      await audit(tx, claims.sub, 'boq.refresh_rates', boqId, {
        rateDate: boq.rate_date,
        linked: priced.reduce((n, p) => n + p.items, 0),
        changed,
      });
      const [header] = await tx`SELECT ${tx.unsafe(HEADER)} FROM est.boq b WHERE b.id = ${boqId}`;
      return {
        header,
        linked: priced.reduce((n, p) => n + p.items, 0),
        analyses: priced.length,
        changed,
      };
    });
  }

  private async mustExist(db: Sql, boqId: string) {
    const [b] = await db`SELECT 1 FROM est.boq WHERE id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
  }
}

interface BatchContext {
  tx: TransactionSql;
  boqId: string;
  /** The BOQ's rate date: analyses are costed as on it. */
  rateDate: string;
  /** The version being edited; above 1, lines keep their previous state before they first change. */
  version: number;
  /** Units master, loaded on first use. */
  units: Map<string, string> | null;
  /** tempId -> real id for lines inserted in this batch. */
  idMap: Map<string, string>;
  touched: Set<string>;
  deleted: Set<string>;
  reload: boolean;
  /** Exchange rates of the BOQ, loaded on first use. */
  fx?: Map<string, string>;
  /** Set by setMeasurements: the one place allowed to change a measured item's quantity. */
  measuring?: boolean;
  /**
   * Set by a revised-BOQ import: the BOQ is locked for the whole import, so row versions need no checking, and
   * totals are worked out once at the end instead of per line.
   */
  importing?: boolean;
}

/** What a line contributes to its ancestors' subtotals. */
const nodeValue = (n: NodeRef): string =>
  n.node_type === 'item' ? (n.amount ?? '0') : n.node_type === 'section' ? n.subtotal : '0';

/**
 * Copy-on-write revisions (docs/wave1-plan.md step 7). Before lines first change in revision V, keeps their state as
 * frozen in V-1 (once per line and revision; lines added in this revision have nothing to keep). `where` selects lines
 * of est.boq_node as `n`. Text is kept when it is about to change or the line is deleted; otherwise it is left NULL,
 * meaning "as in the next state". Version 1 (never frozen) costs nothing.
 */
async function preImage(
  ctx: { tx: TransactionSql; boqId: string; version: number },
  where: PendingQuery<Row[]>,
  withText = false,
) {
  if (ctx.version <= 1) return;
  const { tx, boqId } = ctx;
  const prev = ctx.version - 1;
  await tx`
    WITH saved AS (
      UPDATE est.boq_node n SET hist_version = ${prev}
      WHERE n.boq_id = ${boqId} AND (${where}) AND n.created_version <= ${prev} AND n.hist_version < ${prev}
      RETURNING n.boq_id, n.line_key, n.id, n.parent_id, n.sort_key, n.depth, n.node_type, n.code, n.unit, n.qty,
        n.rate, n.amount, n.subtotal, n.child_count, n.rate_analysis_id, n.measured, n.created_version, n.item_kind,
        n.foreign_currency, n.foreign_rate
    )
    INSERT INTO est.boq_node_hist (boq_id, line_key, frozen_version, id, parent_id, sort_key, depth, node_type, code,
      unit, qty, rate, amount, subtotal, child_count, rate_analysis_id, measured, created_version, item_kind,
      foreign_currency, foreign_rate, description, notes)
    SELECT s.boq_id, s.line_key, ${prev}, s.id, s.parent_id, s.sort_key, s.depth, s.node_type, s.code, s.unit, s.qty,
      s.rate, s.amount, s.subtotal, s.child_count, s.rate_analysis_id, s.measured, s.created_version, s.item_kind,
      s.foreign_currency, s.foreign_rate,
      ${withText ? tx`t.description, t.notes` : tx`NULL, NULL`}
    FROM saved s
    ${withText ? tx`JOIN est.boq_node_text t ON t.boq_id = s.boq_id AND t.node_id = s.id` : tx``}`;
  if (withText)
    // A pre-image kept earlier in this revision without text (say, for a quantity change) gets it now.
    await tx`
      UPDATE est.boq_node_hist h SET description = t.description, notes = t.notes
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE h.boq_id = ${boqId} AND h.frozen_version = ${prev} AND h.description IS NULL
        AND n.boq_id = ${boqId} AND (${where}) AND h.line_key = n.line_key`;
}

/**
 * Section subtotals and the BOQ total from scratch, deepest level first: one grouped UPDATE per level. Used after
 * bulk re-pricing, where per-line deltas would mean one statement per line.
 */
async function recomputeTotals(tx: TransactionSql, boqId: string) {
  const [deepest] = await tx<{ max: number }[]>`
    SELECT coalesce(max(depth), 0)::int AS max FROM est.boq_node WHERE boq_id = ${boqId}`;
  const max = deepest?.max ?? 0;
  for (let d = max - 1; d >= 0; d--)
    await tx`
      UPDATE est.boq_node p SET subtotal = c.v
      FROM (
        SELECT parent_id, sum(CASE node_type WHEN 'item' THEN coalesce(amount, 0) WHEN 'section' THEN subtotal
          ELSE 0 END) AS v
        FROM est.boq_node WHERE boq_id = ${boqId} AND depth = ${d + 1} GROUP BY parent_id
      ) c
      WHERE p.boq_id = ${boqId} AND p.id = c.parent_id AND p.subtotal IS DISTINCT FROM c.v`;
  await tx`UPDATE est.boq SET total = (
      SELECT coalesce(sum(CASE node_type WHEN 'item' THEN coalesce(amount, 0) WHEN 'section' THEN subtotal
        ELSE 0 END), 0)
      FROM est.boq_node WHERE boq_id = ${boqId} AND depth = 0)
    WHERE id = ${boqId}`;
}

async function audit(
  tx: TransactionSql,
  actorId: string,
  action: string,
  boqId: string,
  data: Record<string, unknown>,
) {
  await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
    VALUES (${actorId}, ${action}, 'boq', ${boqId}, ${tx.json(JSON.parse(JSON.stringify(data)))})`;
}
