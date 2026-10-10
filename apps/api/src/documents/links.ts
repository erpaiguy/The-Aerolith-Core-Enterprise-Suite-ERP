// Documents linked to what they belong to (migration 0019): a vendor's quote on an RFQ, a checklist item, an
// addendum. Read by the RFQ and tender pages; documents in restricted folders appear only to users who may see them.
import type { Sql, TransactionSql } from 'postgres';

export type LinkKind = 'rfq_vendor' | 'checklist_item' | 'addendum';
export interface LinkedDocument {
  id: string;
  name: string;
  versionNo: number;
}

/** targetId -> the live documents linked to it. */
export async function linkedDocuments(
  db: Sql | TransactionSql,
  kind: LinkKind,
  targetIds: string[],
  seeRestricted: boolean,
): Promise<Map<string, LinkedDocument[]>> {
  const out = new Map<string, LinkedDocument[]>();
  if (targetIds.length === 0) return out;
  const rows = await db<(LinkedDocument & { targetId: string })[]>`
    SELECT l.target_id AS "targetId", d.id, d.name, d.version_no AS "versionNo"
    FROM doc.document_link l JOIN doc.document d ON d.id = l.document_id
    LEFT JOIN doc.folder f ON f.id = d.folder_id
    WHERE l.target_kind = ${kind} AND l.target_id = ANY(${targetIds}) AND d.deleted_at IS NULL
      ${seeRestricted ? db`` : db`AND (f.id IS NULL OR NOT f.restricted)`}
    ORDER BY lower(d.name)`;
  for (const { targetId, ...d } of rows) out.set(targetId, [...(out.get(targetId) ?? []), d]);
  return out;
}

export const rfqVendorTarget = (rfqId: string, partyId: string) => `${rfqId}/${partyId}`;
