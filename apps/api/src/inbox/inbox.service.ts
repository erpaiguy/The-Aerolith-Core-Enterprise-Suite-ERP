// The basic v1 inbox (docs/04-features.md P6): notifications, personal reminders and "waiting on me" counts.
// Chat, to-do lists and richer productivity features are v2 (Wave 7).
import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { waitingCount } from '../approvals/approval.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

const ITEM_COLUMNS =
  'id, kind, title, body, link, due_at AS "dueAt", read_at AS "readAt", created_at AS "createdAt"';

@Injectable()
export class InboxService {
  constructor(private readonly tenants: TenantConnections) {}

  /**
   * Due items (no due date, or due now) newest first, upcoming reminders soonest first, unread count, and pending
   * actions. Broadcast rows (user_id NULL) are shown to everyone and are not marked read per user.
   */
  async inbox(claims: TenantClaims, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    const mine = db`(user_id = ${claims.sub} OR user_id IS NULL)`;
    const [items, upcoming, [unread], pending, approvals] = await Promise.all([
      db.unsafe(
        `SELECT ${ITEM_COLUMNS} FROM platform.notification WHERE (user_id = $1 OR user_id IS NULL)
        AND (due_at IS NULL OR due_at <= $2) ORDER BY coalesce(due_at, created_at) DESC LIMIT 100`,
        [claims.sub, now],
      ),
      db.unsafe(
        `SELECT ${ITEM_COLUMNS} FROM platform.notification WHERE user_id = $1 AND due_at > $2
        ORDER BY due_at LIMIT 50`,
        [claims.sub, now],
      ),
      db<{ n: number }[]>`SELECT count(*)::int AS n FROM platform.notification
        WHERE ${mine} AND read_at IS NULL AND (due_at IS NULL OR due_at <= ${now})`,
      claims.role === 'admin'
        ? db<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM platform.password_reset_request WHERE status = 'pending'`
        : Promise.resolve([{ n: 0 }]),
      waitingCount(db, claims),
    ]);
    return {
      items,
      upcoming,
      unread: unread?.n ?? 0,
      pending: { passwordResets: pending[0]?.n ?? 0, approvals },
    };
  }

  async markRead(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [row] = await db`UPDATE platform.notification SET read_at = coalesce(read_at, now())
      WHERE id = ${id} AND user_id = ${claims.sub} RETURNING id`;
    if (!row) throw new NotFoundException({ code: 'notification_not_found' });
    return { id, read: true };
  }

  async markAllRead(claims: TenantClaims, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db`UPDATE platform.notification SET read_at = now()
      WHERE user_id = ${claims.sub} AND read_at IS NULL AND (due_at IS NULL OR due_at <= ${now}) RETURNING id`;
    return { marked: rows.length };
  }

  /** A personal reminder: appears in the inbox when it falls due. */
  async addReminder(
    claims: TenantClaims,
    input: { title: string; body: string; dueAt: Date; link: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [row] = await db.unsafe(
      `INSERT INTO platform.notification (user_id, kind, title, body, link, due_at)
       VALUES ($1, 'reminder', $2, $3, $4, $5) RETURNING ${ITEM_COLUMNS}`,
      [claims.sub, input.title, input.body, input.link, input.dueAt],
    );
    return row;
  }

  async deleteReminder(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [row] =
      await db`DELETE FROM platform.notification WHERE id = ${id} AND user_id = ${claims.sub} AND kind = 'reminder' RETURNING id`;
    if (!row) throw new NotFoundException({ code: 'reminder_not_found' });
    return { id, deleted: true };
  }
}
