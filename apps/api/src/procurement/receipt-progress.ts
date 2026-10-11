// What has come against each line of a purchase order (docs/wave2b-plan.md step 5), from its receipts not cancelled.
// Used by orders (an amendment cannot go below what came) and receipts (nothing beyond what is still owed).
import type { Sql, TransactionSql } from 'postgres';
import { dec, fmt } from '../rates/decimal.js';

type Db = Sql | TransactionSql;

export interface LineReceived {
  /** Accepted (at the gate or on inspection). */
  accepted: string;
  /** Held for inspection, not yet accepted or rejected. */
  onHold: string;
  rejected: string;
  /** Of the rejected, sent back to the supplier. */
  returned: string;
  /** Accepted and on hold: what the supplier no longer owes, unless rejected. */
  counted: string;
}

/** By order line key. Rejected goods are still owed: they do not count against the order. */
export async function receivedByLine(db: Db, orderId: string): Promise<Map<string, LineReceived>> {
  const rows = await db<({ key: string } & LineReceived)[]>`
    SELECT g.line_key AS key,
      sum(g.accepted_qty)::text AS accepted,
      sum(CASE WHEN g.inspection = 'hold' THEN g.qty ELSE 0 END)::text AS "onHold",
      sum(g.rejected_qty)::text AS rejected,
      coalesce(sum((SELECT sum(x.qty) FROM proc.goods_return_line x WHERE x.position = g.position
        AND x.return_id IN (SELECT id FROM proc.goods_return WHERE receipt_id = g.receipt_id))), 0)::text AS returned,
      sum(g.accepted_qty + CASE WHEN g.inspection = 'hold' THEN g.qty ELSE 0 END)::text AS counted
    FROM proc.grn_line g JOIN proc.goods_receipt r ON r.id = g.receipt_id
    WHERE r.po_id = ${orderId} AND r.status = 'posted'
    GROUP BY g.line_key`;
  return new Map(rows.map(({ key, ...v }) => [key, v]));
}

/** The order in force line by line, against what came: what is still owed. */
export async function orderProgress(db: Db, orderId: string) {
  const lines = await db<
    {
      lineKey: string;
      position: number;
      resourceId: string | null;
      description: string;
      unit: string;
      ordered: string;
    }[]
  >`
    SELECT l.line_key AS "lineKey", l.position, l.resource_id AS "resourceId", l.description, l.unit,
      l.qty::text AS ordered
    FROM proc.po_line l JOIN proc.po_revision v ON v.id = l.revision_id
    WHERE v.po_id = ${orderId} AND v.status = 'approved' ORDER BY l.position`;
  const got = await receivedByLine(db, orderId);
  const zero = { accepted: '0', onHold: '0', rejected: '0', returned: '0', counted: '0' };
  return lines.map((l) => {
    const r = got.get(l.lineKey) ?? zero;
    const owed = dec(l.ordered) - dec(r.counted);
    return {
      ...l,
      accepted: r.accepted,
      onHold: r.onHold,
      rejected: r.rejected,
      returned: r.returned,
      outstanding: fmt(owed > 0n ? owed : 0n, 4),
    };
  });
}
