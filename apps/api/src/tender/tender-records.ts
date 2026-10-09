// Writes shared by the tender services (docs/wave1-plan.md steps 1 and 8): the activity log, the audit log, and the
// reminders that hang off a tender's EMD, bank guarantees and checklist. Plain functions inside the caller's
// transaction, so no service depends on another for them.
import type { TransactionSql } from 'postgres';
import { istMorning, securityReminders } from './tender-rules.js';

export async function event(
  tx: TransactionSql,
  tenderId: string,
  kind: string,
  data: Record<string, unknown>,
  actorId: string,
) {
  await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
    VALUES (${tenderId}, ${kind}, ${tx.json(JSON.parse(JSON.stringify(data)))}, ${actorId})`;
}

export async function audit(
  tx: TransactionSql,
  actorId: string,
  action: string,
  entity: string,
  entityId: string,
  data: Record<string, unknown>,
) {
  await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
    VALUES (${actorId}, ${action}, ${entity}, ${entityId}, ${tx.json(JSON.parse(JSON.stringify(data)))})`;
}

/** Replaces the future expiry reminders of one bank guarantee (or FDR, bond); they go to the tender's owner. */
export async function rescheduleSecurity(tx: TransactionSql, securityId: string, now: Date) {
  const source = `security:${securityId}`;
  await tx`DELETE FROM platform.notification WHERE source = ${source} AND due_at > ${now}`;
  const [s] = await tx<
    {
      tender_id: string;
      number: string;
      owner_id: string | null;
      form: string;
      status: string;
      valid_until: string | null;
      amount: string;
      bank: string | null;
    }[]
  >`SELECT s.tender_id, t.number, t.owner_id, s.form, s.status, s.valid_until::text, s.amount::text, s.bank
    FROM tender.security_instrument s JOIN tender.tender t ON t.id = s.tender_id WHERE s.id = ${securityId}`;
  if (!s?.owner_id) return;
  const plans = securityReminders(
    {
      form: s.form,
      status: s.status,
      validUntil: s.valid_until,
      amount: s.amount,
      bank: s.bank,
    },
    { number: s.number },
    now,
  );
  for (const p of plans)
    await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
      VALUES (${s.owner_id}, 'security_expiry', ${p.title}, ${`/tenders/${s.tender_id}`}, ${p.dueAt}, ${source})`;
}

/**
 * The tender is lost, cancelled, withdrawn or not bid: every EMD still with the client should come back. One
 * reminder per instrument, due now, to the tender's owner.
 */
export async function remindEmdReturn(tx: TransactionSql, tenderId: string, now: Date) {
  const held = await tx<
    {
      id: string;
      number: string;
      owner_id: string | null;
      amount: string;
      form: string;
      instrument_no: string | null;
    }[]
  >`SELECT s.id, t.number, t.owner_id, s.amount::text, s.form, s.instrument_no
    FROM tender.security_instrument s JOIN tender.tender t ON t.id = s.tender_id
    WHERE s.tender_id = ${tenderId} AND s.purpose = 'emd' AND s.status = 'submitted' AND s.form <> 'exempt'`;
  for (const s of held) {
    if (!s.owner_id) continue;
    const source = `security-return:${s.id}`;
    await tx`DELETE FROM platform.notification WHERE source = ${source} AND read_at IS NULL`;
    await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
      VALUES (${s.owner_id}, 'security_return',
        ${`Ask for the EMD of tender ${s.number} back: ₹${s.amount}${s.instrument_no ? `, ${s.instrument_no}` : ''}`},
        ${`/tenders/${tenderId}`}, ${now}, ${source})`;
  }
}

/** Replaces the reminder of one checklist item: the day before it is due, to whoever it is assigned to. */
export async function rescheduleChecklistItem(tx: TransactionSql, itemId: string, now: Date) {
  const source = `checklist:${itemId}`;
  await tx`DELETE FROM platform.notification WHERE source = ${source} AND due_at > ${now}`;
  const [c] = await tx<
    {
      tender_id: string;
      number: string;
      title: string;
      status: string;
      due_on: string | null;
      user_id: string | null;
    }[]
  >`SELECT c.tender_id, t.number, c.title, c.status, c.due_on::text, coalesce(c.assignee_id, t.owner_id) AS user_id
    FROM tender.checklist_item c JOIN tender.tender t ON t.id = c.tender_id WHERE c.id = ${itemId}`;
  if (!c?.user_id || !c.due_on || c.status !== 'pending') return;
  const dueAt = istMorning(c.due_on, 1);
  if (dueAt <= now) return;
  await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
    VALUES (${c.user_id}, 'checklist_due', ${`Due tomorrow for tender ${c.number}: ${c.title}`},
      ${`/tenders/${c.tender_id}`}, ${dueAt}, ${source})`;
}
