// Transmittal records shared outside the transmittal service: the distribution matrix (step 4) drafts them too.
import type { TransactionSql } from 'postgres';

export type Purpose = 'information' | 'review' | 'construction' | 'record';

/** A new draft transmittal, numbered TR-001… per project (also made by the distribution matrix, step 4). */
export async function newTransmittal(
  tx: TransactionSql,
  projectId: string,
  createdBy: string,
  header: {
    subject: string;
    party_id: string | null;
    recipient: string;
    email: string | null;
    purpose: Purpose;
    response_days: number | null;
    notes: string;
  },
) {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`transmittal:${projectId}`}))`;
  const [n] = await tx<{ n: number }[]>`
    SELECT count(*)::int + 1 AS n FROM dms.transmittal WHERE project_id = ${projectId}`;
  const [t] = await tx<{ id: string; number: string }[]>`
    INSERT INTO dms.transmittal ${tx({
      ...header,
      project_id: projectId,
      number: `TR-${String(n!.n).padStart(3, '0')}`,
      created_by: createdBy,
    })} RETURNING id, number`;
  return t!.id;
}
