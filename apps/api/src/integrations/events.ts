// Webhook events (docs/wave6-plan.md step 6). Written in the caller's transaction, one delivery per subscribed
// webhook, so a change that rolls back sends nothing; the webhook worker sends them afterwards.
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

export const EVENTS = [
  'order.issued',
  'receipt.posted',
  'bill.certified',
  'portal.submission',
] as const;
export type WebhookEvent = (typeof EVENTS)[number] | 'ping';

export async function emit(tx: TransactionSql, event: WebhookEvent, data: Record<string, unknown>) {
  const eventId = randomUUID();
  const payload = { id: eventId, event, occurredAt: new Date().toISOString(), data };
  await tx`
    INSERT INTO platform.webhook_delivery (webhook_id, event_id, event, payload)
    SELECT id, ${eventId}, ${event}, ${tx.json(JSON.parse(JSON.stringify(payload)))}
    FROM platform.webhook WHERE active AND ${event} = ANY(events)`;
}
