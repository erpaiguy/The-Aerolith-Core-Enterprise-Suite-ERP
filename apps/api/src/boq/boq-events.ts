// A BOQ's activity goes to its owner's log: the tender's for an estimate, the project's for a contract BOQ or budget
// (docs/wave2a-plan.md step 2). One of the two statements writes a row; the other finds no owner and writes none.
import type { TransactionSql } from 'postgres';

export async function boqEvent(
  tx: TransactionSql,
  boqId: string,
  kind: string,
  data: Record<string, unknown>,
  actorId: string,
) {
  const json = tx.json(JSON.parse(JSON.stringify(data)));
  await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
    SELECT tender_id, ${kind}, ${json}, ${actorId} FROM est.boq WHERE id = ${boqId} AND tender_id IS NOT NULL`;
  await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
    SELECT project_id, ${kind}, ${json}, ${actorId} FROM est.boq WHERE id = ${boqId} AND project_id IS NOT NULL`;
}
