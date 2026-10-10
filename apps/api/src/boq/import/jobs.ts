// Import job state shared with the BOQ engine, kept apart from the import service so the engine can depend on it
// (and the import service on the engine) without a module cycle.
import type { Sql, TransactionSql } from 'postgres';

/** A job that has not reported progress for this long was interrupted (server restart). */
export const STALE_MINUTES = 15;

/** True while an import into this BOQ is running (interactive edits are refused meanwhile). */
export async function importRunning(db: Sql | TransactionSql, boqId: string): Promise<boolean> {
  const [r] = await db`SELECT 1 FROM platform.import_job WHERE kind = 'boq' AND target_id = ${boqId}
    AND status = 'importing' AND updated_at > now() - make_interval(mins => ${STALE_MINUTES})`;
  return Boolean(r);
}
