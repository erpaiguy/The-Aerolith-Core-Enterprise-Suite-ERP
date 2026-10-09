// BOQ revisions (docs/04-features.md E6, docs/wave1-plan.md step 7): freeze a version (submitted to the client, or
// locked for internal review), start the next revision, list versions, compare two versions, and read any version.
//
// Copy-on-write: freezing and revising copy nothing. Lines keep their previous state in est.boq_node_hist the first
// time they change in a revision (boq.service.ts, preImage). The state of any version N is, for each line, its
// pre-image with the smallest frozen_version >= N if there is one, otherwise its current row; lines created after N
// are left out. The current version's state is simply the current rows.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PendingQuery, Row, Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { priceBid, type GstMode, type Markup } from '../pricing/pricing.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { refuseArchived } from './archived.js';
import { importRunning } from './import/jobs.js';

type Db = Sql | TransactionSql;
export type FreezeKind = 'submitted' | 'internal';
export type ChangeFilter = 'all' | 'added' | 'removed' | 'changed';
/** Up to this many changed lines, compare looks lines up by key; beyond, it joins whole sets. */
const KEY_LOOKUP_MAX = 20_000;

export interface VersionRow {
  sort_key: string;
  depth: number;
  node_type: 'section' | 'item' | 'note';
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  amount: string | null;
  subtotal: string;
}

/**
 * The lines of version `v` among `restrict` (a condition on an alias's line_key, or every line), as rows of: line_key, id, parent_id,
 * sort_key, depth, node_type, code, unit, qty, rate, amount, subtotal, created_version, fv (the pre-image's
 * frozen_version, NULL for a current row) and, with `withText`, description and notes resolved through the history.
 */
function stateAt(
  db: Db,
  boqId: string,
  v: number,
  restrict: ((alias: string) => PendingQuery<Row[]>) | null,
  withText: boolean,
) {
  const inRestrict = (alias: string) => (restrict ? db`AND ${restrict(alias)}` : db``);
  return db`
    WITH p AS (
      SELECT DISTINCT ON (h.line_key) h.* FROM est.boq_node_hist h
      WHERE h.boq_id = ${boqId} AND h.frozen_version >= ${v} ${inRestrict('h')}
      ORDER BY h.line_key, h.frozen_version
    )
    SELECT p.line_key, p.id, p.parent_id, p.sort_key, p.depth, p.node_type, p.code, p.unit, p.qty, p.rate, p.amount,
      p.subtotal, p.created_version, p.frozen_version AS fv
      ${
        withText
          ? db`, coalesce(p.description, nx.description, cu.description, '') AS description,
              coalesce(p.notes, nx.notes, cu.notes, '') AS notes`
          : db``
      }
    FROM p
    ${
      withText
        ? db`
      LEFT JOIN LATERAL (
        SELECT h2.description, h2.notes FROM est.boq_node_hist h2
        WHERE h2.boq_id = p.boq_id AND h2.line_key = p.line_key AND h2.frozen_version > p.frozen_version
          AND h2.description IS NOT NULL
        ORDER BY h2.frozen_version LIMIT 1
      ) nx ON p.description IS NULL
      LEFT JOIN LATERAL (
        SELECT t.description, t.notes FROM est.boq_node n2
        JOIN est.boq_node_text t ON t.boq_id = n2.boq_id AND t.node_id = n2.id
        WHERE n2.boq_id = p.boq_id AND n2.line_key = p.line_key
      ) cu ON p.description IS NULL AND nx.description IS NULL`
        : db``
    }
    WHERE p.created_version <= ${v}
    UNION ALL
    SELECT n.line_key, n.id, n.parent_id, n.sort_key, n.depth, n.node_type, n.code, n.unit, n.qty, n.rate, n.amount,
      n.subtotal, n.created_version, NULL::int AS fv
      ${withText ? db`, t.description, t.notes` : db``}
    FROM est.boq_node n
    ${withText ? db`JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id` : db``}
    WHERE n.boq_id = ${boqId} AND n.created_version <= ${v} ${inRestrict('n')}
      AND NOT EXISTS (SELECT 1 FROM p WHERE p.line_key = n.line_key)`;
}

@Injectable()
export class RevisionService {
  constructor(private readonly tenants: TenantConnections) {}

  async versions(claims: TenantClaims, boqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<
      { versionNo: number; status: string; total: string; nodeCount: number; itemCount: number }[]
    >`
      SELECT version_no AS "versionNo", status, total::text AS total, node_count AS "nodeCount",
        item_count AS "itemCount"
      FROM est.boq WHERE id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    const versions = await db`
      SELECT v.version_no AS "versionNo", v.kind, v.label, v.note, v.frozen_at AS "frozenAt",
        u.display_name AS "frozenBy", v.total::text AS total, v.node_count AS "nodeCount",
        v.item_count AS "itemCount", v.rate_date::text AS "rateDate", v.scenario
      FROM est.boq_version v LEFT JOIN platform."user" u ON u.id = v.frozen_by
      WHERE v.boq_id = ${boqId} ORDER BY v.version_no DESC`;
    return { current: b, versions };
  }

  async freeze(
    claims: TenantClaims,
    boqId: string,
    input: { kind: FreezeKind; label: string; note: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (await importRunning(db, boqId))
      throw new ConflictException({
        code: 'boq_importing',
        message: 'A file is being imported into this BOQ. Try again when it has finished.',
      });
    await db.begin((tx) => this.freezeInTx(tx, claims.sub, boqId, input));
    return this.versions(claims, boqId);
  }

  /**
   * Freezes the BOQ's current version: nothing is copied; the version is recorded with its totals and the pricing
   * scenario chosen as the bid (priced, so the record keeps what was submitted even if markups change later).
   */
  async freezeInTx(
    tx: TransactionSql,
    actorId: string,
    boqId: string,
    input: { kind: FreezeKind; label: string; note: string },
  ) {
    const [b] = await tx<
      {
        name: string;
        status: string;
        archived: boolean;
        version_no: number;
        total: string;
        node_count: number;
        item_count: number;
        rate_date: string;
        tender_id: string;
        estimate: string | null;
      }[]
    >`
      SELECT b.name, b.status, b.archived_at IS NOT NULL AS archived, b.version_no, b.total::text AS total, b.node_count,
        b.item_count, b.rate_date::text, b.tender_id, t.estimated_value::text AS estimate
      FROM est.boq b JOIN tender.tender t ON t.id = b.tender_id WHERE b.id = ${boqId} FOR UPDATE OF b`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    refuseArchived(b);
    if (b.status !== 'draft')
      throw new ConflictException({
        code: 'already_frozen',
        message: `Version ${b.version_no} is already frozen. Start a new revision to change it.`,
      });
    const [s] = await tx<{ name: string; markups: Markup[]; gstPct: string; gstMode: GstMode }[]>`
      SELECT name, markups, gst_pct::text AS "gstPct", gst_mode AS "gstMode" FROM est.pricing_scenario
      WHERE boq_id = ${boqId} AND selected`;
    const scenario = s ? { ...s, result: priceBid(b.total, s, b.estimate) } : null;
    await tx`
      INSERT INTO est.boq_version (boq_id, version_no, kind, label, note, frozen_by, total, node_count, item_count,
        rate_date, scenario)
      VALUES (${boqId}, ${b.version_no}, ${input.kind}, ${input.label}, ${input.note}, ${actorId}, ${b.total},
        ${b.node_count}, ${b.item_count}, ${b.rate_date}, ${scenario ? tx.json(JSON.parse(JSON.stringify(scenario))) : null})`;
    await tx`UPDATE est.boq SET status = ${input.kind === 'submitted' ? 'submitted' : 'locked'},
        updated_at = now(), updated_by = ${actorId}, row_version = row_version + 1
      WHERE id = ${boqId}`;
    const data = { boqId, name: b.name, version: b.version_no, kind: input.kind, total: b.total };
    await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
      VALUES (${b.tender_id}, 'boq_frozen', ${tx.json(data)}, ${actorId})`;
    await audit(tx, actorId, 'boq.freeze', boqId, data);
  }

  /** Starts the next revision of a frozen BOQ: a version number and a status, nothing copied. */
  async revise(claims: TenantClaims, boqId: string, note: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [b] = await tx<
        { name: string; status: string; archived: boolean; version_no: number; tender_id: string }[]
      >`
        SELECT name, status, archived_at IS NOT NULL AS archived, version_no, tender_id FROM est.boq
        WHERE id = ${boqId} FOR UPDATE`;
      if (!b) throw new NotFoundException({ code: 'boq_not_found' });
      refuseArchived(b);
      if (b.status === 'draft')
        throw new ConflictException({
          code: 'not_frozen',
          message: `Version ${b.version_no} is still a draft: freeze it before starting a revision.`,
        });
      await tx`UPDATE est.boq SET status = 'draft', version_no = version_no + 1, updated_at = now(),
          updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${boqId}`;
      const data = { boqId, name: b.name, version: b.version_no + 1, note };
      await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
        VALUES (${b.tender_id}, 'boq_revision_started', ${tx.json(data)}, ${claims.sub})`;
      await audit(tx, claims.sub, 'boq.revise', boqId, data);
    });
    return this.versions(claims, boqId);
  }

  /**
   * Archives a BOQ made by mistake (BOQs are never deleted), or restores it. An archived BOQ is read only and left
   * out of the tender's bid summary and of the freeze on submission. A BOQ with a version submitted to the client
   * stays on the tender's record.
   */
  async archive(claims: TenantClaims, boqId: string, archived: boolean) {
    const db = await this.tenants.forTenant(claims.ten);
    if (archived && (await importRunning(db, boqId)))
      throw new ConflictException({
        code: 'boq_importing',
        message: 'A file is being imported into this BOQ. Try again when it has finished.',
      });
    await db.begin(async (tx) => {
      const [b] = await tx<
        { name: string; tender_id: string; archived: boolean; submitted: boolean }[]
      >`
        SELECT name, tender_id, archived_at IS NOT NULL AS archived,
          EXISTS (SELECT 1 FROM est.boq_version v WHERE v.boq_id = b.id AND v.kind = 'submitted') AS submitted
        FROM est.boq b WHERE id = ${boqId} FOR UPDATE`;
      if (!b) throw new NotFoundException({ code: 'boq_not_found' });
      if (b.archived === archived) return;
      if (archived && b.submitted)
        throw new ConflictException({
          code: 'boq_submitted',
          message: 'A version of this BOQ was submitted to the client, so it stays on the tender.',
        });
      await tx`UPDATE est.boq SET archived_at = ${archived ? tx`now()` : null},
          archived_by = ${archived ? claims.sub : null}, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1
        WHERE id = ${boqId}`;
      const kind = archived ? 'boq_archived' : 'boq_restored';
      await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
        VALUES (${b.tender_id}, ${kind}, ${tx.json({ boqId, name: b.name })}, ${claims.sub})`;
      await audit(tx, claims.sub, archived ? 'boq.archive' : 'boq.restore', boqId, {});
    });
  }

  /**
   * What changed from version `from` to version `to` (either may be the current version, in either order): lines
   * added, removed and changed (figures, code, unit, text, position), with value deltas. Only lines that changed in
   * some revision since the earlier of the two are examined.
   */
  async compare(
    claims: TenantClaims,
    boqId: string,
    from: number,
    to: number,
    opts: { filter: ChangeFilter; limit: number; offset: number },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db<{ version_no: number; total: string }[]>`
      SELECT version_no, total::text AS total FROM est.boq WHERE id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    for (const v of [from, to])
      if (v < 1 || v > b.version_no)
        throw new BadRequestException({
          code: 'no_such_version',
          message: `This BOQ has versions 1 to ${b.version_no}.`,
        });
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const totals = await db<{ v: number; total: string }[]>`
      SELECT version_no AS v, total::text AS total FROM est.boq_version
      WHERE boq_id = ${boqId} AND version_no IN (${from}, ${to})`;
    const totalOf = (v: number) =>
      v === b.version_no ? b.total : (totals.find((x) => x.v === v)?.total ?? null);

    // Only lines kept in the history since `lo`, or added after it, can differ ("created_version > 1" lets the
    // partial index boq_node_added answer the second half).
    const cand = db`
      SELECT line_key FROM est.boq_node_hist WHERE boq_id = ${boqId} AND frozen_version >= ${lo}
      UNION
      SELECT line_key FROM est.boq_node
      WHERE boq_id = ${boqId} AND created_version > ${lo} AND created_version > 1`;
    // Few changed lines (the usual case): look them up by key through the index instead of scanning the BOQ.
    const few = (
      await db<
        { k: string }[]
      >`SELECT line_key::text AS k FROM (${cand}) c LIMIT ${KEY_LOOKUP_MAX + 1}`
    ).map((r) => r.k);
    const keys = few.length <= KEY_LOOKUP_MAX ? few : null;
    const restrict = (alias: string) =>
      keys
        ? db`${db.unsafe(alias)}.line_key = ANY(${keys}::uuid[])`
        : db`${db.unsafe(alias)}.line_key IN (${cand})`;
    // Lines whose text may differ: text is kept in the history only when it changed (or the line was deleted).
    const diff = db`
      WITH a AS (${stateAt(db, boqId, from, restrict, false)}),
      b AS (${stateAt(db, boqId, to, restrict, false)}),
      tt AS (
        SELECT DISTINCT h.line_key FROM est.boq_node_hist h
        WHERE h.boq_id = ${boqId} AND h.frozen_version >= ${lo} AND h.frozen_version < ${hi}
          AND h.description IS NOT NULL ${keys ? db`AND ${restrict('h')}` : db``}
      ),
      d AS (
        SELECT coalesce(a.line_key, b.line_key) AS line_key,
          CASE WHEN a.line_key IS NULL THEN 'added' WHEN b.line_key IS NULL THEN 'removed' ELSE 'changed' END AS change,
          coalesce(b.node_type, a.node_type) AS type,
          coalesce(b.sort_key, a.sort_key) AS ord,
          a.code AS code_a, b.code AS code_b, a.unit AS unit_a, b.unit AS unit_b,
          a.qty AS qty_a, b.qty AS qty_b, a.rate AS rate_a, b.rate AS rate_b,
          a.amount AS amount_a, b.amount AS amount_b,
          (a.line_key IS NOT NULL AND b.line_key IS NOT NULL
            AND (a.parent_id IS DISTINCT FROM b.parent_id OR a.sort_key <> b.sort_key)) AS moved,
          (a.line_key IS NOT NULL AND b.line_key IS NOT NULL AND tt.line_key IS NOT NULL) AS text_touched
        FROM a FULL JOIN b ON a.line_key = b.line_key
        LEFT JOIN tt ON tt.line_key = coalesce(a.line_key, b.line_key)
      )
      SELECT * FROM d
      WHERE change <> 'changed' OR moved
        OR code_a IS DISTINCT FROM code_b OR unit_a IS DISTINCT FROM unit_b
        OR qty_a IS DISTINCT FROM qty_b OR rate_a IS DISTINCT FROM rate_b OR amount_a IS DISTINCT FROM amount_b
        -- Text kept in between may still have ended up the same (edited, then edited back).
        OR (text_touched AND (SELECT ROW(t.description, t.notes) FROM (${this.textAt(db, boqId, from, 'd')}) t)
          IS DISTINCT FROM (SELECT ROW(t.description, t.notes) FROM (${this.textAt(db, boqId, to, 'd')}) t))`;

    // One pass: the differences are worked out once, then counted and paged.
    const [res] = await db<
      {
        summary: { added: number; removed: number; changed: number; itemsDelta: string };
        rows: (Record<string, unknown> & { change: string; moved: boolean })[] | null;
      }[]
    >`
      WITH x AS MATERIALIZED (${diff}),
      pick AS (
        SELECT * FROM x ${opts.filter === 'all' ? db`` : db`WHERE change = ${opts.filter}`}
        ORDER BY ord, line_key LIMIT ${opts.limit} OFFSET ${opts.offset}
      )
      SELECT
        (SELECT json_build_object(
            'added', count(*) FILTER (WHERE change = 'added'),
            'removed', count(*) FILTER (WHERE change = 'removed'),
            'changed', count(*) FILTER (WHERE change = 'changed'),
            'itemsDelta', round(coalesce(sum(CASE WHEN type = 'item'
              THEN coalesce(amount_b, 0) - coalesce(amount_a, 0) END), 0), 2)::text)
          FROM x) AS summary,
        (SELECT json_agg(r ORDER BY r.ord, r."lineKey") FROM (
          SELECT pick.ord, pick.line_key AS "lineKey", pick.change, pick.type, pick.moved,
            pick.code_a AS "codeA", pick.code_b AS "codeB", pick.unit_a AS "unitA", pick.unit_b AS "unitB",
            pick.qty_a::text AS "qtyA", pick.qty_b::text AS "qtyB", pick.rate_a::text AS "rateA",
            pick.rate_b::text AS "rateB", pick.amount_a::text AS "amountA", pick.amount_b::text AS "amountB",
            ta.description AS "descriptionA", tb.description AS "descriptionB",
            ta.notes AS "notesA", tb.notes AS "notesB"
          FROM pick
          LEFT JOIN LATERAL (${this.textAt(db, boqId, from, 'pick')}) ta ON pick.change <> 'added'
          LEFT JOIN LATERAL (${this.textAt(db, boqId, to, 'pick')}) tb ON pick.change <> 'removed'
        ) r) AS rows`;
    const rows = (res!.rows ?? []).map(({ ord: _ord, ...r }) => r);
    return {
      from: { version: from, total: totalOf(from) },
      to: { version: to, total: totalOf(to) },
      summary: res!.summary,
      rows,
      hasMore: rows.length === opts.limit,
    };
  }

  /**
   * Description and notes of `alias`.line_key in version v (a correlated subquery): the earliest text kept from v on
   * (a kept state without text means "as in the next state"), otherwise the current text.
   */
  private textAt(db: Db, boqId: string, v: number, alias: string) {
    const key = db`${db.unsafe(alias)}.line_key`;
    return db`
      SELECT x.description, x.notes FROM (
        (SELECT 0 AS o, h.description, h.notes FROM est.boq_node_hist h
          WHERE h.boq_id = ${boqId} AND h.line_key = ${key} AND h.frozen_version >= ${v}
            AND h.description IS NOT NULL
          ORDER BY h.frozen_version LIMIT 1)
        UNION ALL
        (SELECT 1, t.description, t.notes FROM est.boq_node n
          JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
          WHERE n.boq_id = ${boqId} AND n.line_key = ${key})
      ) x ORDER BY x.o LIMIT 1`;
  }

  /** Every line of version v in tree order, streamed (for exporting an old version). */
  async *versionRows(db: Sql, boqId: string, v: number): AsyncGenerator<VersionRow> {
    const query = db<VersionRow[]>`
      SELECT s.sort_key, s.depth, s.node_type, s.code, s.description, s.notes, s.unit, s.qty::text AS qty,
        s.rate::text AS rate, s.amount::text AS amount, s.subtotal::text AS subtotal
      FROM (${stateAt(db, boqId, v, null, true)}) s
      ORDER BY s.sort_key`;
    for await (const rows of query.cursor(2000)) yield* rows;
  }

  /** The version number an export asks for, checked; null for the current version. */
  async exportVersion(db: Sql, boqId: string, v: number | undefined): Promise<number | null> {
    if (v === undefined) return null;
    const [b] = await db<
      { version_no: number }[]
    >`SELECT version_no FROM est.boq WHERE id = ${boqId}`;
    if (!b) throw new NotFoundException({ code: 'boq_not_found' });
    if (v < 1 || v > b.version_no)
      throw new BadRequestException({
        code: 'no_such_version',
        message: `This BOQ has versions 1 to ${b.version_no}.`,
      });
    return v === b.version_no ? null : v;
  }
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
