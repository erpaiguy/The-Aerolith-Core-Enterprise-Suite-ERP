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
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export type NodeType = 'section' | 'item' | 'note';

export interface LineFields {
  code?: string | null | undefined;
  description?: string | undefined;
  notes?: string | undefined;
  unit?: string | null | undefined;
  qty?: string | null | undefined;
  rate?: string | null | undefined;
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
  | { op: 'move'; id: string; rowVersion: number; parentId: string | null; afterId: string | null };

export const MAX_DEPTH = 30;
const MAX_TOUCHED_ROWS = 1000;

const ROW = `n.id::text AS id, n.parent_id::text AS "parentId", n.sort_key AS "sortKey", n.depth,
  n.node_type AS type, n.code, t.description, t.notes, n.unit, n.qty::text AS qty, n.rate::text AS rate,
  n.amount::text AS amount, n.subtotal::text AS subtotal, n.child_count AS "childCount",
  n.row_version AS "rowVersion"`;

const HEADER = `b.id, b.tender_id AS "tenderId", b.name, b.version_no AS "versionNo", b.status, b.currency,
  b.node_count AS "nodeCount", b.item_count AS "itemCount", b.total::text AS total, b.notes,
  b.updated_at AS "updatedAt", b.row_version AS "rowVersion"`;

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
}

/** The root-most collapsed proper ancestor of `key`, if any. */
function hiddenBy(key: string, collapsed: Set<string>): string | null {
  for (const a of ancestorKeys(key)) if (collapsed.has(a)) return a;
  return null;
}

@Injectable()
export class BoqService {
  /** Time budget for the stop-early search plan before falling back (see `search`). Tests lower it. */
  searchBudgetMs = 300;
  /** How often the fallback plan ran (a sign that a tenant needs a search index). */
  searchFallbacks = 0;

  constructor(private readonly tenants: TenantConnections) {}

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
    input: { name?: string | undefined; notes?: string | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
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
    let cursor: string | null = backward ? (opts.before ?? null) : (opts.after ?? null);
    // A collapsed section the client stopped on: continue after its hidden rows.
    if (!backward && cursor !== null && collapsed.has(cursor)) cursor += SUBTREE_END;
    let exhausted = false;
    for (let guard = 0; out.length < opts.limit && guard < opts.limit * 2 + 10; guard++) {
      const want = opts.limit - out.length + 1; // one extra row tells us whether more exist
      const rows = await db<BoqRow[]>`
        SELECT ${db.unsafe(ROW)}
        FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE n.boq_id = ${boqId}
          ${cursor === null ? db`` : backward ? db`AND n.sort_key < ${cursor}` : db`AND n.sort_key > ${cursor}`}
        ORDER BY n.sort_key ${backward ? db`DESC` : db`ASC`}
        LIMIT ${want}`;
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
   * Lines whose code or description contains `q`, in tree order, paged by `after`.
   *
   * Two plans, because neither wins everywhere (measured on 1M lines):
   * - walking lines in tree order and stopping at the first page of matches is instant for common words, but reads
   *   every line when the term is rare or absent (3.4 s);
   * - filtering text first, then ordering the matches, costs ~0.6 s whatever the term, but is slow when almost
   *   everything matches.
   * So the first plan gets a short time budget and the second runs only when it runs out.
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
    const after = opts.after ? db`AND n.sort_key > ${opts.after}` : db``;
    let rows: BoqRow[];
    try {
      rows = await db.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(this.searchBudgetMs))}`,
        );
        return tx<BoqRow[]>`
          SELECT ${tx.unsafe(ROW)}
          FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
          WHERE n.boq_id = ${boqId} AND (t.description ILIKE ${pattern} OR n.code ILIKE ${pattern})
            ${opts.after ? tx`AND n.sort_key > ${opts.after}` : tx``}
          ORDER BY n.sort_key LIMIT ${opts.limit + 1}`;
      });
    } catch (err) {
      if ((err as { code?: string }).code !== '57014') throw err; // query_canceled: the budget ran out
      this.searchFallbacks++;
      rows = await db<BoqRow[]>`
        WITH m AS MATERIALIZED (
          SELECT node_id AS id FROM est.boq_node_text WHERE boq_id = ${boqId} AND description ILIKE ${pattern}
          UNION
          SELECT id FROM est.boq_node WHERE boq_id = ${boqId} AND code ILIKE ${pattern}
        )
        SELECT ${db.unsafe(ROW)}
        FROM m JOIN est.boq_node n ON n.boq_id = ${boqId} AND n.id = m.id
        JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE true ${after}
        ORDER BY n.sort_key LIMIT ${opts.limit + 1}`;
    }
    return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
  }

  // --- editing ---

  /**
   * Applies a batch of edits atomically. `parentId`/`afterId` may name a `tempId` inserted earlier in the same batch.
   * Returns the fresh state of every touched row; `reload` means the change was structural (moved or deleted
   * subtrees), so the client should re-read its window.
   */
  async apply(claims: TenantClaims, boqId: string, ops: Op[]) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [boq] = await tx<{ status: string }[]>`
        SELECT status FROM est.boq WHERE id = ${boqId} FOR UPDATE`;
      if (!boq) throw new NotFoundException({ code: 'boq_not_found' });
      if (boq.status !== 'draft') throw new ConflictException({ code: 'boq_locked' });

      const ctx: BatchContext = {
        tx,
        boqId,
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
          else await this.move(ctx, op);
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

  private async insert(ctx: BatchContext, op: Extract<Op, { op: 'insert' }>) {
    const { tx, boqId } = ctx;
    if (ctx.idMap.has(op.tempId)) throw new BadRequestException({ code: 'duplicate_temp_id' });
    if (op.type !== 'item' && (op.qty != null || op.rate != null))
      throw new BadRequestException({ code: 'qty_rate_on_non_item' });
    const parent = await this.parentNode(ctx, op.parentId);
    const key = await this.keyFor(ctx, parent, op.afterId, null);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_DEPTH) throw new BadRequestException({ code: 'too_deep' });

    const [row] = await tx<{ id: string; value: string }[]>`
      INSERT INTO est.boq_node (boq_id, parent_id, sort_key, depth, node_type, code, unit, qty, rate, amount)
      VALUES (${boqId}, ${parent?.id ?? null}, ${key}, ${depth}, ${op.type}, ${op.code ?? null}, ${op.unit ?? null},
              ${op.qty ?? null}::numeric, ${op.rate ?? null}::numeric,
              round(${op.qty ?? null}::numeric * ${op.rate ?? null}::numeric, 2))
      RETURNING id::text, coalesce(amount, 0)::text AS value`;
    await tx`INSERT INTO est.boq_node_text (boq_id, node_id, description, notes)
      VALUES (${boqId}, ${row!.id}, ${op.description ?? ''}, ${op.notes ?? ''})`;
    ctx.idMap.set(op.tempId, row!.id);
    ctx.touched.add(row!.id);
    if (parent) {
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
    if (node.node_type !== 'item' && (op.qty !== undefined || op.rate !== undefined))
      throw new BadRequestException({ code: 'qty_rate_on_non_item' });
    // Absent fields keep their value; null clears. Amount follows qty × rate for items.
    const next = (field: 'code' | 'unit' | 'qty' | 'rate') =>
      op[field] !== undefined ? op[field] : node[field];
    const [row] = await tx<{ delta: string }[]>`
      UPDATE est.boq_node SET code = ${next('code')}, unit = ${next('unit')},
        qty = ${next('qty')}::numeric, rate = ${next('rate')}::numeric,
        amount = CASE WHEN node_type = 'item' THEN round(${next('qty')}::numeric * ${next('rate')}::numeric, 2) END,
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
    const removed = await tx<{ id: string; node_type: NodeType }[]>`
      DELETE FROM est.boq_node
      WHERE boq_id = ${boqId} AND sort_key >= ${node.sort_key} AND sort_key < ${node.sort_key + SUBTREE_END}
      RETURNING id::text, node_type`;
    for (const r of removed) ctx.deleted.add(r.id);
    if (removed.length > 1) ctx.reload = true;
    if (node.parent_id) {
      await tx`UPDATE est.boq_node SET child_count = child_count - 1
        WHERE boq_id = ${boqId} AND id = ${node.parent_id}`;
      ctx.touched.add(node.parent_id);
    }
    await this.propagate(ctx, node.sort_key, value, -1);
    await tx`UPDATE est.boq SET node_count = node_count - ${removed.length},
        item_count = item_count - ${removed.filter((r) => r.node_type === 'item').length} WHERE id = ${boqId}`;
  }

  private async move(ctx: BatchContext, op: Extract<Op, { op: 'move' }>) {
    const { tx, boqId } = ctx;
    const node = await this.lockNode(ctx, op.id, op.rowVersion);
    const parent = await this.parentNode(ctx, op.parentId);
    if (
      parent &&
      (parent.sort_key === node.sort_key || parent.sort_key.startsWith(node.sort_key + '!'))
    )
      throw new BadRequestException({ code: 'move_into_self' });
    const newKey = await this.keyFor(ctx, parent, op.afterId, node.id);
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
      await tx`UPDATE est.boq_node SET child_count = child_count - 1
        WHERE boq_id = ${boqId} AND id = ${node.parent_id}`;
      ctx.touched.add(node.parent_id);
    }
    // The new key is fresh and its range empty, so rewriting the subtree's prefix can never collide.
    await tx`UPDATE est.boq_node
      SET sort_key = ${newKey} || substr(sort_key, ${node.sort_key.length + 1}), depth = depth + ${shift}
      WHERE boq_id = ${boqId} AND sort_key >= ${node.sort_key} AND sort_key < ${node.sort_key + SUBTREE_END}`;
    await tx`UPDATE est.boq_node SET parent_id = ${parent?.id ?? null}, row_version = row_version + 1
      WHERE boq_id = ${boqId} AND id = ${node.id}`;
    if (parent) {
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
    if (/^-?0+(\.0+)?$/.test(delta)) return;
    if (sign === -1) delta = delta.startsWith('-') ? delta.slice(1) : `-${delta}`;
    const { tx, boqId } = ctx;
    const ancestors = ancestorKeys(key);
    if (ancestors.length) {
      const ids = await tx<{ id: string }[]>`
        UPDATE est.boq_node SET subtotal = subtotal + ${delta}::numeric
        WHERE boq_id = ${boqId} AND sort_key = ANY(${ancestors}) RETURNING id::text`;
      for (const r of ids) ctx.touched.add(r.id);
    }
    await tx`UPDATE est.boq SET total = total + ${delta}::numeric WHERE id = ${boqId}`;
  }

  private resolve(ctx: BatchContext, id: string): string {
    return ctx.idMap.get(id) ?? id;
  }

  private async lockNode(ctx: BatchContext, rawId: string, rowVersion: number): Promise<NodeRef> {
    const id = this.resolve(ctx, rawId);
    const [n] = await ctx.tx<NodeRef[]>`
      SELECT id::text, parent_id::text, sort_key, depth, node_type, code, unit, qty::text, rate::text,
        amount::text, subtotal::text, row_version
      FROM est.boq_node WHERE boq_id = ${ctx.boqId} AND id = ${id} FOR UPDATE`;
    if (!n) throw new NotFoundException({ code: 'line_not_found', id: rawId });
    // Rows inserted earlier in this batch have no version on the client yet.
    if (!ctx.idMap.has(rawId) && n.row_version !== rowVersion)
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
        amount::text, subtotal::text, row_version
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
    rawAfterId: string | null,
    moving: string | null,
  ): Promise<string> {
    const { tx, boqId } = ctx;
    const parentKey = parent?.sort_key ?? '';
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
      WHERE boq_id = ${boqId} AND sort_key > ${from}
        ${
          moving
            ? tx`AND NOT (sort_key >= (SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId} AND id = ${moving})
                       AND sort_key < (SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId} AND id = ${moving}) || ${SUBTREE_END})`
            : tx``
        }
      ORDER BY sort_key LIMIT 1`;
    const next = neighbours[0] ? splitKey(neighbours[0].sort_key) : null;
    const upper = next && next.parent === parentKey ? next.segment : null;
    return childKey(parentKey, midpoint(lower, upper));
  }

  private async mustExist(db: Sql, boqId: string) {
    const [b] = await db`SELECT 1 FROM est.boq WHERE id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
  }
}

interface BatchContext {
  tx: TransactionSql;
  boqId: string;
  /** tempId -> real id for lines inserted in this batch. */
  idMap: Map<string, string>;
  touched: Set<string>;
  deleted: Set<string>;
  reload: boolean;
}

/** What a line contributes to its ancestors' subtotals. */
const nodeValue = (n: NodeRef): string =>
  n.node_type === 'item' ? (n.amount ?? '0') : n.node_type === 'section' ? n.subtotal : '0';

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
