// Delivery follow-up (docs/wave8-plan.md step 8e.2): an order line's instalments, the buyer's expediting notes, the
// deliveries overdue across projects, and the lead time from requisition to order to receipt.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { audit } from '../tender/tender-records.js';
import { daysBetween, slotsAgainst } from './delivery-rules.js';
import { orderProgress } from './receipt-progress.js';

type Db = Sql | TransactionSql;
const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

@Injectable()
export class DeliveryService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
  ) {}

  private async order(db: Db, claims: TenantClaims, id: string, write: boolean) {
    const [o] = await db<
      { project_id: string; status: string; deliver_by: string | null; tolerance: string }[]
    >`
      SELECT o.project_id, o.status, o.receipt_tolerance_pct::text AS tolerance,
        (SELECT to_char(v.deliver_by, 'YYYY-MM-DD') FROM proc.po_revision v WHERE v.po_id = o.id AND v.status = 'approved')
          AS deliver_by
      FROM proc.purchase_order o WHERE o.id = ${id}`;
    if (!o) throw new NotFoundException({ code: 'order_not_found' });
    const a = await this.projects.access(db, claims, o.project_id);
    if (write) {
      if (!a.canEdit && a.role !== 'member')
        throw new ForbiddenException({
          code: 'forbidden',
          message: "Only the project's team follows up its orders.",
        });
      if (!(await this.permissions.can(claims, 'purchase.edit')))
        throw new ForbiddenException({ code: 'permission_denied', permission: 'purchase.edit' });
    }
    return o;
  }

  /** The order's lines in force with their instalments set against what came, and the expediting notes. */
  async followUp(claims: TenantClaims, orderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, claims, orderId, false);
    const today = indiaToday();
    const lines = await orderProgress(db, orderId);
    const slots = await db<{ lineKey: string; dueOn: string; qty: string; note: string }[]>`
      SELECT line_key AS "lineKey", to_char(due_on, 'YYYY-MM-DD') AS "dueOn", qty::text, note
      FROM proc.delivery_schedule WHERE po_id = ${orderId} ORDER BY due_on`;
    const notes = await db`
      SELECT n.id, to_char(n.noted_on, 'YYYY-MM-DD') AS "notedOn", n.note,
        to_char(n.promised_on, 'YYYY-MM-DD') AS "promisedOn", u.display_name AS by
      FROM proc.expedite_note n LEFT JOIN platform."user" u ON u.id = n.created_by
      WHERE n.po_id = ${orderId} ORDER BY n.noted_on DESC, n.created_at DESC`;
    return {
      orderId,
      deliverBy: o.deliver_by,
      receiptTolerancePct: o.tolerance,
      lines: lines.map((l) => {
        const mine = slots.filter((s) => s.lineKey === l.lineKey);
        const counted = slotsAgainst(mine, fmt(dec(l.accepted) + dec(l.onHold), 4), today);
        return {
          lineKey: l.lineKey,
          position: l.position,
          description: l.description,
          unit: l.unit,
          ordered: l.ordered,
          outstanding: l.outstanding,
          schedule: counted.map((c, i) => ({ ...c, note: mine[i]?.note ?? '' })),
        };
      }),
      notes,
      mayEdit: await this.mayEdit(db, claims, o.project_id),
    };
  }

  /** The projects a person can see: all with `projects.all`, else those whose team they are on. */
  private seen(db: Db, claims: TenantClaims, seesAll: boolean) {
    return seesAll
      ? db`TRUE`
      : db`p.id IN (SELECT project_id FROM proj.member WHERE user_id = ${claims.sub})`;
  }

  private async mayEdit(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    return (
      (a.canEdit || a.role === 'member') && (await this.permissions.can(claims, 'purchase.edit'))
    );
  }

  /** Replaces a line's instalments; together they may not be more than the line in force. */
  async setSchedule(
    claims: TenantClaims,
    orderId: string,
    lineKey: string,
    slots: { dueOn: string; qty: string; note: string }[],
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, claims, orderId, true);
    if (o.status === 'cancelled' || o.status === 'closed')
      throw new BadRequestException({ code: 'order_closed', message: 'The order is closed.' });
    const line = (await orderProgress(db, orderId)).find((l) => l.lineKey === lineKey);
    if (!line)
      throw new BadRequestException({
        code: 'no_such_line',
        message: 'Not a line of the order in force.',
      });
    const total = slots.reduce((s, x) => s + dec(x.qty), 0n);
    if (total > dec(line.ordered))
      throw new BadRequestException({
        code: 'over_ordered',
        message: `The instalments come to more than the ${line.ordered} ${line.unit} ordered.`,
      });
    if (new Set(slots.map((s) => s.dueOn)).size !== slots.length)
      throw new BadRequestException({
        code: 'same_day',
        message: 'One instalment a day per line.',
      });
    await db.begin(async (tx) => {
      await tx`DELETE FROM proc.delivery_schedule WHERE po_id = ${orderId} AND line_key = ${lineKey}`;
      for (const s of slots)
        await tx`
          INSERT INTO proc.delivery_schedule (po_id, line_key, due_on, qty, note, created_by)
          VALUES (${orderId}, ${lineKey}, ${s.dueOn}, ${s.qty}, ${s.note}, ${claims.sub})`;
      await audit(tx, claims.sub, 'order.schedule', 'purchase_order', orderId, { lineKey, slots });
    });
    return this.followUp(claims, orderId);
  }

  async addNote(
    claims: TenantClaims,
    orderId: string,
    input: { note: string; promisedOn: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.order(db, claims, orderId, true);
    await db`
      INSERT INTO proc.expedite_note (po_id, noted_on, note, promised_on, created_by)
      VALUES (${orderId}, ${indiaToday()}, ${input.note}, ${input.promisedOn}, ${claims.sub})`;
    return this.followUp(claims, orderId);
  }

  /** How far receipts may run past the order: weighbridge loads of sand and aggregate (step 8e.3). */
  async setTolerance(claims: TenantClaims, orderId: string, pct: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, claims, orderId, true);
    if (o.status === 'cancelled' || o.status === 'closed')
      throw new BadRequestException({ code: 'order_closed', message: 'The order is closed.' });
    await db.begin(async (tx) => {
      await tx`UPDATE proc.purchase_order SET receipt_tolerance_pct = ${pct}, row_version = row_version + 1
        WHERE id = ${orderId}`;
      await audit(tx, claims.sub, 'order.tolerance', 'purchase_order', orderId, { pct });
    });
    return { receiptTolerancePct: Number(pct).toFixed(2) };
  }

  /** Instalments past their day and not fully come, and orders past their delivery date with no instalments. */
  async overdue(claims: TenantClaims, q: { projectId?: string | undefined }) {
    const db = await this.tenants.forTenant(claims.ten);
    const today = indiaToday();
    if (q.projectId) await this.projects.access(db, claims, q.projectId);
    const seen = this.seen(db, claims, await this.permissions.can(claims, 'projects.all'));
    const orders = await db<
      {
        id: string;
        number: string;
        projectId: string;
        project: string;
        party: string;
        deliverBy: string | null;
        promisedOn: string | null;
      }[]
    >`
      SELECT o.id, o.number, p.id AS "projectId", p.number AS project, pa.name AS party,
        to_char(v.deliver_by, 'YYYY-MM-DD') AS "deliverBy",
        (SELECT to_char(n.promised_on, 'YYYY-MM-DD') FROM proc.expedite_note n WHERE n.po_id = o.id
          ORDER BY n.noted_on DESC, n.created_at DESC LIMIT 1) AS "promisedOn"
      FROM proc.purchase_order o
      JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
      JOIN proj.project p ON p.id = o.project_id
      JOIN platform.party pa ON pa.id = o.party_id
      WHERE o.kind = 'purchase' AND o.status IN ('issued', 'acknowledged')
        ${q.projectId ? db`AND o.project_id = ${q.projectId}` : db``}
        AND (v.deliver_by < ${today}
          OR EXISTS (SELECT 1 FROM proc.delivery_schedule s WHERE s.po_id = o.id AND s.due_on < ${today}))
        AND ${seen}
      ORDER BY coalesce(v.deliver_by, ${today}::date), o.number`;
    const rows = [];
    for (const o of orders) {
      const f = await this.followUp(claims, o.id).catch(() => null);
      if (!f) continue;
      const late = f.lines.flatMap((l) =>
        l.schedule.length
          ? l.schedule
              .filter((s) => s.state === 'overdue')
              .map((s) => ({
                description: l.description,
                unit: l.unit,
                dueOn: s.dueOn,
                short: s.short,
              }))
          : o.deliverBy && o.deliverBy < today && dec(l.outstanding) > 0n
            ? [
                {
                  description: l.description,
                  unit: l.unit,
                  dueOn: o.deliverBy,
                  short: l.outstanding,
                },
              ]
            : [],
      );
      if (late.length)
        rows.push({
          ...o,
          late,
          daysLate: Math.max(...late.map((x) => daysBetween(x.dueOn, today) ?? 0)),
        });
    }
    return rows;
  }

  /**
   * Lead times of the orders made in a period: requisition raised and approved, order issued (its first approval),
   * first and last receipt; days between, and the average by supplier.
   */
  async leadTimes(
    claims: TenantClaims,
    q: { from: string; to: string; projectId?: string | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (q.projectId) await this.projects.access(db, claims, q.projectId);
    const seen = this.seen(db, claims, await this.permissions.can(claims, 'projects.all'));
    const rows = await db<
      {
        id: string;
        number: string;
        project: string;
        party: string;
        raised: string | null;
        approved: string | null;
        ordered: string;
        firstReceipt: string | null;
        lastReceipt: string | null;
      }[]
    >`
      WITH ord AS (
        SELECT o.id, o.number, p.number AS project, pa.name AS party,
          (SELECT min(v.approved_at) FROM proc.po_revision v WHERE v.po_id = o.id) AS issued_at
        FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id JOIN platform.party pa ON pa.id = o.party_id
        WHERE o.kind = 'purchase' AND o.status <> 'cancelled'
          ${q.projectId ? db`AND o.project_id = ${q.projectId}` : db``}
          AND ${seen}
      ),
      req AS (
        SELECT DISTINCT o.id AS po_id, r.id AS requisition_id, r.created_at
        FROM ord o
        JOIN proc.po_revision v ON v.po_id = o.id
        JOIN proc.po_line l ON l.revision_id = v.id
        JOIN proc.rfq_requisition_line x ON x.rfq_line_id = l.rfq_line_id
        JOIN proc.requisition r ON r.id = x.requisition_id
      )
      SELECT o.id, o.number, o.project, o.party,
        (SELECT to_char(min(q.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') FROM req q WHERE q.po_id = o.id)
          AS raised,
        (SELECT to_char(max(a.decided_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') FROM req q
          JOIN platform.approval_request a ON a.doc_id = q.requisition_id AND a.status = 'approved'
          WHERE q.po_id = o.id) AS approved,
        to_char(o.issued_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS ordered,
        (SELECT to_char(min(g.received_on), 'YYYY-MM-DD') FROM proc.goods_receipt g
          WHERE g.po_id = o.id AND g.status = 'posted') AS "firstReceipt",
        (SELECT to_char(max(g.received_on), 'YYYY-MM-DD') FROM proc.goods_receipt g
          WHERE g.po_id = o.id AND g.status = 'posted') AS "lastReceipt"
      FROM ord o
      WHERE o.issued_at IS NOT NULL
        AND (o.issued_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${q.from} AND ${q.to}
      ORDER BY o.issued_at`;
    const orders = rows.map((r) => ({
      ...r,
      toApprove: daysBetween(r.raised, r.approved),
      toOrder: daysBetween(r.approved ?? r.raised, r.ordered),
      toDeliver: daysBetween(r.ordered, r.firstReceipt),
      total: daysBetween(r.raised ?? r.ordered, r.firstReceipt),
    }));
    const avg = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x !== null);
      return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null;
    };
    const parties = [...new Set(orders.map((o) => o.party))].sort();
    return {
      ...q,
      orders,
      bySupplier: parties.map((party) => {
        const mine = orders.filter((o) => o.party === party);
        return {
          party,
          orders: mine.length,
          toOrder: avg(mine.map((o) => o.toOrder)),
          toDeliver: avg(mine.map((o) => o.toDeliver)),
          total: avg(mine.map((o) => o.total)),
        };
      }),
      average: {
        toApprove: avg(orders.map((o) => o.toApprove)),
        toOrder: avg(orders.map((o) => o.toOrder)),
        toDeliver: avg(orders.map((o) => o.toDeliver)),
        total: avg(orders.map((o) => o.total)),
      },
    };
  }
}
