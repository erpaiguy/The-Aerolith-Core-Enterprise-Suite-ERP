// The basic v1 inbox (docs/04-features.md P6): notifications, personal reminders and "waiting on me" counts.
// Chat, to-do lists and richer productivity features are v2 (Wave 7).
import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { waitingCount, waitingOn } from '../approvals/approval.service.js';
import { waitingReviews } from '../dms/review.service.js';
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
    const [items, upcoming, [unread], pending, approvals, reviews, [dms]] = await Promise.all([
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
      waitingReviews(db, claims),
      // Sign-offs on my turn, and drawing revisions sent to me not yet acknowledged (docs/wave5-plan.md steps 4-5).
      db<{ signoffs: number; receipts: number }[]>`
        SELECT
          (SELECT count(*)::int FROM dms.signoff_signer g JOIN dms.signoff s ON s.id = g.signoff_id
            WHERE g.user_id = ${claims.sub} AND g.status = 'waiting' AND s.status = 'open'
              AND g.position = (SELECT min(position) FROM dms.signoff_signer x
                WHERE x.signoff_id = s.id AND x.status = 'waiting')) AS signoffs,
          (SELECT count(*)::int FROM dms.distribution_receipt
            WHERE user_id = ${claims.sub} AND acknowledged_at IS NULL) AS receipts`,
    ]);
    return {
      items,
      upcoming,
      unread: unread?.n ?? 0,
      pending: {
        passwordResets: pending[0]?.n ?? 0,
        approvals,
        reviews,
        signoffs: dms?.signoffs ?? 0,
        receipts: dms?.receipts ?? 0,
      },
    };
  }

  /**
   * My work (docs/wave7-plan.md step 7a.7): what waits on this person, by kind. Approvals waiting on them (leave among
   * them), RFIs assigned to them, bills on the projects they lead, orders still to receive and NCRs open on their
   * projects, and their CRM follow-ups due within a week. At most 20 of each, with the full count.
   */
  async myWork(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const mine = db`SELECT project_id FROM proj.member WHERE user_id = ${claims.sub}`;
    const led = db`SELECT project_id FROM proj.member WHERE user_id = ${claims.sub} AND role = 'lead'`;
    const proj = db`json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project`;
    const today = db`(now() AT TIME ZONE 'Asia/Kolkata')::date`;
    const section = async (
      rows: Promise<Record<string, unknown>[]>,
      count: Promise<{ n: number }[]>,
    ) => {
      const [items, [c]] = await Promise.all([rows, count]);
      return { count: c?.n ?? 0, items };
    };
    const [approvals, rfis, bills, orders, ncrs, followUps, actions, findings] = await Promise.all([
      section(
        db`SELECT r.id, r.doc_type AS "docType", r.title, r.amount::text AS amount,
            r.submitted_at AS "submittedAt", u.display_name AS "submittedBy"
          FROM platform.approval_request r JOIN platform."user" u ON u.id = r.submitted_by
          WHERE r.id IN (${waitingOn(db, claims)}) ORDER BY r.submitted_at LIMIT 20`,
        db`SELECT count(*)::int AS n FROM (${waitingOn(db, claims)}) w`,
      ),
      section(
        db`SELECT r.id, r.number, r.subject, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn",
            r.due_on < ${today} AS overdue, ${proj}
          FROM dms.rfi r JOIN proj.project p ON p.id = r.project_id
          WHERE r.assigned_to = ${claims.sub} AND r.status = 'open' ORDER BY r.due_on LIMIT 20`,
        db`SELECT count(*)::int AS n FROM dms.rfi WHERE assigned_to = ${claims.sub} AND status = 'open'`,
      ),
      // Subcontract bills waiting to be certified on the projects they lead.
      section(
        db`SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, y.name AS subcontractor,
            b.figures->>'net' AS net, ${proj}
          FROM acc.subcontract_bill b JOIN proc.purchase_order o ON o.id = b.order_id
          JOIN proj.project p ON p.id = o.project_id JOIN platform.party y ON y.id = o.party_id
          WHERE b.status = 'pending' AND o.project_id IN (${led}) ORDER BY b.upto LIMIT 20`,
        db`SELECT count(*)::int AS n FROM acc.subcontract_bill b JOIN proc.purchase_order o ON o.id = b.order_id
          WHERE b.status = 'pending' AND o.project_id IN (${led})`,
      ),
      // Purchase orders out with suppliers on their projects: goods still to come in.
      section(
        db`SELECT o.id, o.number, y.name AS supplier, o.status, ${proj}
          FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id
          JOIN platform.party y ON y.id = o.party_id
          WHERE o.kind = 'purchase' AND o.status IN ('issued', 'acknowledged') AND o.project_id IN (${mine})
          ORDER BY o.number LIMIT 20`,
        db`SELECT count(*)::int AS n FROM proc.purchase_order
          WHERE kind = 'purchase' AND status IN ('issued', 'acknowledged') AND project_id IN (${mine})`,
      ),
      // NCRs not closed: raised by them, or on the projects they lead.
      section(
        db`SELECT n.id, n.number, n.description, n.status, to_char(n.due_on, 'YYYY-MM-DD') AS "dueOn", ${proj}
          FROM qa.ncr n JOIN proj.project p ON p.id = n.project_id
          WHERE n.status <> 'closed' AND (n.created_by = ${claims.sub} OR n.project_id IN (${led}))
          ORDER BY n.due_on NULLS LAST, n.created_at LIMIT 20`,
        db`SELECT count(*)::int AS n FROM qa.ncr
          WHERE status <> 'closed' AND (created_by = ${claims.sub} OR project_id IN (${led}))`,
      ),
      section(
        db`SELECT i.id, i.follow_up AS "followUp", to_char(i.follow_up_on, 'YYYY-MM-DD') AS "dueOn",
            l.id AS "leadId", l.title AS lead
          FROM crm.interaction i JOIN crm.lead l ON l.id = i.lead_id
          WHERE l.owner_id = ${claims.sub} AND i.follow_up_done_at IS NULL
            AND i.follow_up_on <= ${today} + 7
          ORDER BY i.follow_up_on LIMIT 20`,
        db`SELECT count(*)::int AS n FROM crm.interaction i JOIN crm.lead l ON l.id = i.lead_id
          WHERE l.owner_id = ${claims.sub} AND i.follow_up_done_at IS NULL AND i.follow_up_on <= ${today} + 7`,
      ),
      // Meeting actions on them, open (docs/wave7-plan.md step 7d.1).
      section(
        db`SELECT x.id, x.description, to_char(x.due_on, 'YYYY-MM-DD') AS "dueOn", x.due_on < ${today} AS overdue,
            m.id AS "meetingId", m.number AS meeting, ${proj}
          FROM proj.meeting_action x JOIN proj.meeting m ON m.id = x.meeting_id
          JOIN proj.project p ON p.id = m.project_id
          WHERE x.owner_id = ${claims.sub} AND x.status = 'open' ORDER BY x.due_on LIMIT 20`,
        db`SELECT count(*)::int AS n FROM proj.meeting_action WHERE owner_id = ${claims.sub} AND status = 'open'`,
      ),
      // Safety findings on them, open (docs/wave7-plan.md step 7d.5).
      section(
        db`SELECT f.id, f.observation, f.severity, to_char(f.due_on, 'YYYY-MM-DD') AS "dueOn", f.due_on < ${today} AS overdue,
            w.id AS "walkId", w.number AS walk, ${proj}
          FROM hse.walk_finding f JOIN hse.site_walk w ON w.id = f.walk_id
          JOIN proj.project p ON p.id = w.project_id
          WHERE f.owner_id = ${claims.sub} AND f.status = 'open' ORDER BY f.due_on LIMIT 20`,
        db`SELECT count(*)::int AS n FROM hse.walk_finding WHERE owner_id = ${claims.sub} AND status = 'open'`,
      ),
    ]);
    return { approvals, rfis, bills, orders, ncrs, followUps, actions, findings };
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
