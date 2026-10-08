// Shared checks for BOQ integration tests.
import type { Sql } from 'postgres';

/** Checks every stored invariant directly in SQL. Returns a list of problems (empty = consistent). */
export async function boqInvariants(db: Sql, boqId: string): Promise<string[]> {
  const problems: string[] = [];
  const bad = await db<{ id: string; what: string }[]>`
    WITH kids AS (
      SELECT parent_id, count(*) AS n,
        sum(CASE node_type WHEN 'item' THEN coalesce(amount, 0) WHEN 'section' THEN subtotal ELSE 0 END) AS value
      FROM est.boq_node WHERE boq_id = ${boqId} AND parent_id IS NOT NULL GROUP BY parent_id
    )
    SELECT p.id::text, 'subtotal' AS what FROM est.boq_node p LEFT JOIN kids k ON k.parent_id = p.id
    WHERE p.boq_id = ${boqId} AND p.node_type = 'section' AND p.subtotal <> coalesce(k.value, 0)
    UNION ALL
    SELECT p.id::text, 'child_count' FROM est.boq_node p LEFT JOIN kids k ON k.parent_id = p.id
    WHERE p.boq_id = ${boqId} AND p.child_count <> coalesce(k.n, 0)
    UNION ALL
    SELECT c.id::text, 'parent_key' FROM est.boq_node c
    LEFT JOIN est.boq_node p ON p.boq_id = c.boq_id AND p.id = c.parent_id
    WHERE c.boq_id = ${boqId} AND (
      (c.parent_id IS NULL AND position('!' in c.sort_key) > 0) OR
      (c.parent_id IS NOT NULL AND (p.id IS NULL OR p.node_type <> 'section'
        OR left(c.sort_key, length(p.sort_key) + 1) <> p.sort_key || '!'
        OR position('!' in substr(c.sort_key, length(p.sort_key) + 2)) > 0)))
    UNION ALL
    SELECT id::text, 'depth' FROM est.boq_node
    WHERE boq_id = ${boqId} AND depth <> length(sort_key) - length(replace(sort_key, '!', ''))
    UNION ALL
    SELECT id::text, 'amount' FROM est.boq_node
    WHERE boq_id = ${boqId} AND node_type = 'item' AND amount IS DISTINCT FROM round(qty * rate, 2)
    UNION ALL
    SELECT b.id::text, 'boq_totals' FROM est.boq b WHERE b.id = ${boqId} AND (
      b.total <> coalesce((SELECT sum(CASE node_type WHEN 'item' THEN coalesce(amount, 0)
                                     WHEN 'section' THEN subtotal ELSE 0 END)
                           FROM est.boq_node WHERE boq_id = ${boqId} AND parent_id IS NULL), 0)
      OR b.node_count <> (SELECT count(*) FROM est.boq_node WHERE boq_id = ${boqId})
      OR b.item_count <> (SELECT count(*) FROM est.boq_node WHERE boq_id = ${boqId} AND node_type = 'item'))
    UNION ALL
    SELECT node_id::text, 'missing_node' FROM est.boq_node_text t WHERE t.boq_id = ${boqId}
      AND NOT EXISTS (SELECT 1 FROM est.boq_node n WHERE n.boq_id = t.boq_id AND n.id = t.node_id)`;
  for (const b of bad) problems.push(`${b.what}:${b.id}`);
  return problems;
}
