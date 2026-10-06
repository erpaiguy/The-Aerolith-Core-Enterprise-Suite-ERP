// The timed operations from docs/03-architecture.md §13, run against a real Postgres.
import type { Sql } from 'postgres';
import { computeCpm, type Relation, type RelationType } from './cpm.js';
import { rng } from './generate.js';
import { midpoint, splitKey, SUBTREE_END } from './sortkey.js';
import { one, sample, timeIt, type Timing } from './stats.js';

export const WINDOW = 200;

interface WindowRow {
  id: string;
  sort_key: string;
  node_type: string;
}

const windowAfter = (sql: Sql, boqId: string, afterKey: string | null, limit: number) => sql<
  WindowRow[]
>`
  SELECT n.id, n.sort_key, n.node_type, n.depth, n.code, n.unit, n.qty, n.rate, n.amount, n.subtotal, t.description
  FROM est.boq_node n
  JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
  WHERE n.boq_id = ${boqId}::uuid ${afterKey === null ? sql`` : sql`AND n.sort_key > ${afterKey}`}
  ORDER BY n.sort_key
  LIMIT ${limit}`;

export async function openFirstWindow(sql: Sql, boqId: string): Promise<Timing> {
  return sample(30, async () => {
    await sql`SELECT id, name, node_count, total FROM est.boq WHERE id = ${boqId}::uuid`;
    const rows = await windowAfter(sql, boqId, null, WINDOW);
    if (rows.length !== WINDOW) throw new Error('first window short');
  });
}

export async function randomItems(sql: Sql, boqId: string, n: number) {
  return sql<{ id: string; sort_key: string; path: string; parent_id: string }[]>`
    SELECT id, sort_key, path::text AS path, parent_id FROM est.boq_node
    WHERE boq_id = ${boqId}::uuid AND node_type = 'item' ORDER BY random() LIMIT ${n}`;
}

export async function scrollWindows(sql: Sql, boqId: string, starts: string[]): Promise<Timing> {
  return sample(starts.length, async (i) => {
    const rows = await windowAfter(sql, boqId, starts[i]!, WINDOW);
    if (rows.length === 0) throw new Error('empty window');
  });
}

/**
 * Window with collapsed sections. Instead of filtering hidden rows (which scans them), the server jumps over each
 * collapsed subtree using its sort-key range, so cost depends on rows shown, not rows hidden.
 */
export async function collapsedWindow(
  sql: Sql,
  boqId: string,
  start: string | null,
  collapsed: Set<string>,
) {
  const out: WindowRow[] = [];
  let cursor = start;
  let queries = 0;
  while (out.length < WINDOW) {
    const rows = await windowAfter(sql, boqId, cursor, WINDOW - out.length);
    queries++;
    if (rows.length === 0) break;
    let jumped = false;
    for (const row of rows) {
      out.push(row);
      cursor = row.sort_key;
      if (collapsed.has(row.sort_key)) {
        cursor = row.sort_key + SUBTREE_END;
        jumped = true;
        break;
      }
    }
    if (!jumped && rows.length < WINDOW) break;
  }
  return { rows: out.length, queries };
}

export async function collapsedWindows(
  sql: Sql,
  boqId: string,
  starts: string[],
): Promise<{ timing: Timing; collapsedCount: number; maxQueries: number }> {
  const sections = await sql<{ sort_key: string }[]>`
    SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId}::uuid AND node_type = 'section' AND depth IN (0, 2)
    ORDER BY random() LIMIT 60`;
  const collapsed = new Set(sections.map((s) => s.sort_key));
  let maxQueries = 0;
  const timing = await sample(starts.length, async (i) => {
    const r = await collapsedWindow(sql, boqId, i === 0 ? null : starts[i]!, collapsed);
    maxQueries = Math.max(maxQueries, r.queries);
  });
  return { timing, collapsedCount: collapsed.size, maxQueries };
}

export const SEARCH_TERMS = [
  'vitrified',
  'teak wood',
  'sprinkler',
  'gypsum',
  'cpvc',
  'tower b',
  'specification 4321',
  'ducting',
  'anti-termite',
  'granite flooring at podium',
];

export async function searchDescriptions(sql: Sql, boqId: string): Promise<Timing> {
  return sample(SEARCH_TERMS.length * 2, async (i) => {
    const term = SEARCH_TERMS[i % SEARCH_TERMS.length]!;
    await sql`
      SELECT n.id, n.sort_key, n.code, n.qty, n.rate, n.amount, t.description
      FROM est.boq_node_text t
      JOIN est.boq_node n ON n.boq_id = t.boq_id AND n.id = t.node_id
      WHERE t.boq_id = ${boqId}::uuid AND t.description ILIKE ${'%' + term + '%'}
      ORDER BY n.sort_key
      LIMIT ${WINDOW}`;
  });
}

export async function sortByAmount(sql: Sql, boqId: string): Promise<Timing> {
  return sample(20, async () => {
    await sql`
      SELECT n.id, n.code, n.amount, t.description
      FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE n.boq_id = ${boqId}::uuid AND n.amount IS NOT NULL
      ORDER BY n.amount DESC NULLS LAST
      LIMIT ${WINDOW}`;
  });
}

const ancestorIds = (path: string): string[] =>
  path
    .split('.')
    .slice(0, -1)
    .map((label) => label.slice(1));

/** Edit one quantity, then push the amount delta to every ancestor subtotal and the BOQ total, in one transaction. */
export async function editQuantities(
  sql: Sql,
  boqId: string,
  items: { id: string; path: string }[],
): Promise<Timing> {
  const rand = rng(7);
  return sample(items.length, async (i) => {
    const item = items[i]!;
    const qty = (Math.round(rand() * 100000) / 100).toFixed(2);
    await sql.begin(async (tx) => {
      const [row] = await tx<{ delta: string }[]>`
        WITH old AS (
          SELECT amount FROM est.boq_node WHERE boq_id = ${boqId}::uuid AND id = ${item.id} FOR UPDATE
        )
        UPDATE est.boq_node n
        SET qty = ${qty}::numeric, amount = round(${qty}::numeric * n.rate, 2), row_version = n.row_version + 1
        FROM old
        WHERE n.boq_id = ${boqId}::uuid AND n.id = ${item.id}
        RETURNING (n.amount - old.amount)::text AS delta`;
      if (!row) throw new Error('edit target missing');
      await tx`UPDATE est.boq_node SET subtotal = subtotal + ${row.delta}::numeric
        WHERE boq_id = ${boqId}::uuid AND id = ANY(${ancestorIds(item.path)}::bigint[])`;
      await tx`UPDATE est.boq SET total = total + ${row.delta}::numeric, row_version = row_version + 1
        WHERE id = ${boqId}::uuid`;
    });
  });
}

/** Insert a new item directly after an existing one: a key between two siblings, no renumbering. */
export async function insertBetween(
  sql: Sql,
  boqId: string,
  items: { id: string; sort_key: string; path: string; parent_id: string }[],
): Promise<Timing> {
  return sample(items.length, async (i) => {
    const item = items[i]!;
    await sql.begin(async (tx) => {
      const [next] = await tx<{ sort_key: string }[]>`
        SELECT sort_key FROM est.boq_node WHERE boq_id = ${boqId}::uuid AND sort_key > ${item.sort_key}
        ORDER BY sort_key LIMIT 1`;
      const own = splitKey(item.sort_key);
      const sibling = next ? splitKey(next.sort_key) : null;
      const segment = midpoint(
        own.segment,
        sibling && sibling.parent === own.parent ? sibling.segment : null,
      );
      const key = own.parent + '!' + segment;
      const { id } = one(
        await tx<{ id: string }[]>`SELECT nextval('est.boq_node_id_seq')::text AS id`,
      );
      const parentPath = item.path.slice(0, item.path.lastIndexOf('.'));
      await tx`INSERT INTO est.boq_node (boq_id, id, line_key, parent_id, path, sort_key, depth, node_type, code, unit, qty, rate, amount)
        VALUES (${boqId}::uuid, ${id}, gen_random_uuid(), ${item.parent_id}, ${parentPath + '.n' + id}::ltree, ${key}, 3, 'item',
                'NEW', 'sqm', 10, 250, 2500)`;
      await tx`INSERT INTO est.boq_node_text (boq_id, node_id, description) VALUES (${boqId}::uuid, ${id}, 'Inserted item')`;
      await tx`UPDATE est.boq_node SET subtotal = subtotal + 2500
        WHERE boq_id = ${boqId}::uuid AND id = ANY(${ancestorIds(item.path)}::bigint[])`;
      await tx`UPDATE est.boq SET total = total + 2500, node_count = node_count + 1 WHERE id = ${boqId}::uuid`;
    });
  });
}

/** New revision = one INSERT ... SELECT per table, keeping line_key so versions can be compared. */
export async function copyRevision(
  sql: Sql,
  boqId: string,
): Promise<{ ms: number; newBoqId: string }> {
  const { ms, value } = await timeIt(() =>
    sql.begin(async (tx) => {
      const [boq] = await tx<{ id: string }[]>`
        INSERT INTO est.boq (name, version_no, node_count, total)
        SELECT name || ' rev', version_no + 1, node_count, total FROM est.boq WHERE id = ${boqId}::uuid RETURNING id`;
      const newId = boq!.id;
      await tx`INSERT INTO est.boq_node
        (boq_id, id, line_key, parent_id, path, sort_key, depth, node_type, code, unit, qty, rate, amount, subtotal)
        SELECT ${newId}::uuid, id, line_key, parent_id, path, sort_key, depth, node_type, code, unit, qty, rate, amount, subtotal
        FROM est.boq_node WHERE boq_id = ${boqId}::uuid`;
      await tx`INSERT INTO est.boq_node_text (boq_id, node_id, description)
        SELECT ${newId}::uuid, node_id, description FROM est.boq_node_text WHERE boq_id = ${boqId}::uuid`;
      return newId;
    }),
  );
  return { ms, newBoqId: value };
}

export interface CpmTiming {
  loadMs: number;
  computeMs: number;
  writeMs: number;
  totalMs: number;
  activities: number;
  relations: number;
  projectFinish: number;
}

export async function recalculateSchedule(sql: Sql, planId: string): Promise<CpmTiming> {
  const started = performance.now();
  const acts = await sql<{ id: number; duration: number }[]>`
    SELECT id, duration FROM sched.activity WHERE plan_id = ${planId}::uuid ORDER BY id`;
  const rels = await sql<{ pred_id: number; succ_id: number; type: RelationType; lag: number }[]>`
    SELECT pred_id, succ_id, type, lag FROM sched.relation WHERE plan_id = ${planId}::uuid`;
  const loaded = performance.now();

  // Activity ids are 0..n-1 in the benchmark; a real plan maps ids to dense indexes first.
  const durations = Int32Array.from(acts, (a) => a.duration);
  const relations: Relation[] = rels.map((r) => ({
    pred: r.pred_id,
    succ: r.succ_id,
    type: r.type,
    lag: r.lag,
  }));
  const result = computeCpm(durations, relations);
  const computed = performance.now();

  await sql`
    UPDATE sched.activity a
    SET early_start = v.es, early_finish = v.ef, late_start = v.ls, late_finish = v.lf, total_float = v.tf
    FROM unnest(${acts.map((a) => a.id)}::int[], ${Array.from(result.es)}::int[], ${Array.from(result.ef)}::int[],
                ${Array.from(result.ls)}::int[], ${Array.from(result.lf)}::int[], ${Array.from(result.totalFloat)}::int[])
      AS v(id, es, ef, ls, lf, tf)
    WHERE a.plan_id = ${planId}::uuid AND a.id = v.id`;
  const written = performance.now();
  return {
    loadMs: loaded - started,
    computeMs: computed - loaded,
    writeMs: written - computed,
    totalMs: written - started,
    activities: acts.length,
    relations: rels.length,
    projectFinish: result.projectFinish,
  };
}
