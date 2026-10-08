// Document numbering series (docs/04-features.md P7). Call inside the transaction that saves the document: the counter
// row stays locked until commit, and a rollback returns the number, so the series has no gaps.
import type { TransactionSql } from 'postgres';
import { financialYear, formatNumber } from './tender-rules.js';

export async function nextNumber(
  tx: TransactionSql,
  docType: string,
  entityId: string,
  prefix: string,
  at: Date,
): Promise<string> {
  const fy = financialYear(at);
  const [row] = await tx<{ prefix: string; padding: number; n: number }[]>`
    INSERT INTO platform.numbering_series (doc_type, entity_id, fy, prefix, next_no)
    VALUES (${docType}, ${entityId}, ${fy}, ${prefix}, 2)
    ON CONFLICT (doc_type, entity_id, fy) DO UPDATE SET next_no = platform.numbering_series.next_no + 1
    RETURNING prefix, padding, next_no - 1 AS n`;
  return formatNumber(row!.prefix, fy, row!.n, row!.padding);
}
