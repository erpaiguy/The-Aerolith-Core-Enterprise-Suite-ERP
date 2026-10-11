// Procurement reports (docs/wave2b-plan.md step 9): requisition to order to receipt, open orders, material
// reconciliation (with wastage against the norms) and supplier performance. Read-only, over what steps 1-7 recorded,
// kept to the projects the user sees.
import { Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { indiaToday } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt, type Dec } from '../rates/decimal.js';

const q4 = (v: Dec) => fmt(v, 4);
/** `= project`, every project, or the projects the user is on. */
const inScope = (
  db: Sql,
  claims: TenantClaims,
  s: { projectId: string | undefined; all: boolean },
) =>
  s.projectId
    ? db`= ${s.projectId}`
    : s.all
      ? db`IS NOT NULL`
      : db`IN (SELECT m.project_id FROM proj.member m WHERE m.user_id = ${claims.sub})`;
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type Stage =
  'not_asked' | 'asked' | 'part_ordered' | 'ordered' | 'part_received' | 'received';

@Injectable()
export class ProcurementReportService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * The projects in scope: one (if the user sees it), or all they see. Returns what the fragment needs, not the
   * fragment: an async function cannot return one (awaiting it would run it).
   */
  private async scope(db: Sql, claims: TenantClaims, projectId: string | undefined) {
    if (projectId) {
      await this.projects.access(db, claims, projectId);
      return { projectId, all: false };
    }
    const all = claims.role === 'admin' || (await this.permissions.can(claims, 'projects.all'));
    return { projectId: undefined, all };
  }

  /**
   * Each line of the project's approved requisitions: asked in which enquiries, ordered on which orders, received;
   * what is still to come, since when, and whether it is past its date. An enquiry line asking for several
   * requisitions' lines shares what was ordered and received against it among them in requisition order.
   */
  async requisitions(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const today = indiaToday();
    const lines = await db<
      {
        requisitionId: string;
        number: string;
        title: string;
        position: number;
        description: string;
        unit: string;
        qty: string;
        neededBy: string | null;
        approvedOn: string | null;
      }[]
    >`
      SELECT q.id AS "requisitionId", q.number, q.title, l.position, l.description, l.unit, l.qty::text AS qty,
        to_char(coalesce(l.needed_by, q.needed_by), 'YYYY-MM-DD') AS "neededBy",
        (SELECT to_char(a.decided_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') FROM platform.approval_request a
          WHERE a.doc_type = 'purchase_requisition' AND a.doc_id = q.id AND a.status = 'approved'
          ORDER BY a.decided_at DESC LIMIT 1) AS "approvedOn"
      FROM proc.requisition q JOIN proc.requisition_line l ON l.requisition_id = q.id
      WHERE q.project_id = ${projectId} AND q.status = 'approved'
      ORDER BY q.number, l.position`;
    const links = await db<
      { requisitionId: string; position: number; rfqLineId: string; qty: string; rfq: string }[]
    >`
      SELECT x.requisition_id AS "requisitionId", x.position, x.rfq_line_id AS "rfqLineId", x.qty::text AS qty,
        r.number AS rfq
      FROM proc.rfq_requisition_line x JOIN tender.rfq_line rl ON rl.id = x.rfq_line_id
      JOIN tender.rfq r ON r.id = rl.rfq_id JOIN proc.requisition q ON q.id = x.requisition_id
      WHERE r.project_id = ${projectId} AND r.status <> 'cancelled'
      ORDER BY q.number, x.position`;
    // What each enquiry line got: ordered in force on live orders, and accepted against those order lines.
    const got = await db<
      { rfqLineId: string; ordered: string; received: string; orders: string[] }[]
    >`
      SELECT l.rfq_line_id AS "rfqLineId", sum(l.qty)::text AS ordered,
        coalesce(sum((SELECT sum(g.accepted_qty) FROM proc.grn_line g JOIN proc.goods_receipt gr ON gr.id = g.receipt_id
          WHERE gr.po_id = o.id AND gr.status = 'posted' AND g.line_key = l.line_key)), 0)::text AS received,
        array_agg(DISTINCT o.number) AS orders
      FROM proc.po_line l JOIN proc.po_revision v ON v.id = l.revision_id AND v.status = 'approved'
      JOIN proc.purchase_order o ON o.id = v.po_id AND o.status <> 'cancelled'
      WHERE o.project_id = ${projectId} AND l.rfq_line_id IS NOT NULL
      GROUP BY l.rfq_line_id`;
    // Share each enquiry line's ordered and received among its requisition lines, first come first served.
    const left = new Map(
      got.map((g) => [g.rfqLineId, { o: dec(g.ordered), r: dec(g.received), n: g.orders }]),
    );
    const per = new Map<
      string,
      { asked: Dec; ordered: Dec; received: Dec; rfqs: Set<string>; orders: Set<string> }
    >();
    for (const x of links) {
      const k = `${x.requisitionId} ${x.position}`;
      const p = per.get(k) ?? {
        asked: 0n,
        ordered: 0n,
        received: 0n,
        rfqs: new Set(),
        orders: new Set(),
      };
      const want = dec(x.qty);
      const g = left.get(x.rfqLineId);
      p.asked += want;
      p.rfqs.add(x.rfq);
      if (g) {
        const o = g.o < want ? g.o : want;
        const r = g.r < want ? g.r : want;
        g.o -= o;
        g.r -= r;
        p.ordered += o;
        p.received += r;
        if (o > 0n) g.n.forEach((n) => p.orders.add(n));
      }
      per.set(k, p);
    }
    return {
      today,
      lines: lines.map((l) => {
        const p = per.get(`${l.requisitionId} ${l.position}`);
        const qty = dec(l.qty);
        const [asked, ordered, received] = [p?.asked ?? 0n, p?.ordered ?? 0n, p?.received ?? 0n];
        const stage: Stage =
          received >= qty
            ? 'received'
            : received > 0n
              ? 'part_received'
              : ordered >= qty
                ? 'ordered'
                : ordered > 0n
                  ? 'part_ordered'
                  : asked > 0n
                    ? 'asked'
                    : 'not_asked';
        const open = stage !== 'received';
        return {
          ...l,
          asked: q4(asked),
          ordered: q4(ordered),
          received: q4(received),
          outstanding: q4(received < qty ? qty - received : 0n),
          stage,
          enquiries: [...(p?.rfqs ?? [])],
          orders: [...(p?.orders ?? [])],
          ageDays: open && l.approvedOn ? days(l.approvedOn, today) : null,
          late: open && !!l.neededBy && l.neededBy < today,
        };
      }),
    };
  }

  /** What suppliers still owe on issued purchase orders, line by line, with how late it is. */
  async openOrders(claims: TenantClaims, projectId?: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const scope = inScope(db, claims, await this.scope(db, claims, projectId));
    const today = indiaToday();
    const rows = await db<
      {
        orderId: string;
        number: string;
        project: { id: string; number: string; name: string };
        vendor: string;
        description: string;
        unit: string;
        ordered: string;
        received: string;
        rate: string;
        deliverBy: string | null;
      }[]
    >`
      WITH got AS (
        SELECT gr.po_id, g.line_key, sum(g.accepted_qty + CASE WHEN g.inspection = 'hold' THEN g.qty ELSE 0 END) AS qty
        FROM proc.grn_line g JOIN proc.goods_receipt gr ON gr.id = g.receipt_id AND gr.status = 'posted'
        GROUP BY gr.po_id, g.line_key
      )
      SELECT o.id AS "orderId", o.number, json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        pt.name AS vendor, l.description, l.unit, l.qty::text AS ordered, coalesce(got.qty, 0)::text AS received,
        l.rate::text AS rate, to_char(v.deliver_by, 'YYYY-MM-DD') AS "deliverBy"
      FROM proc.purchase_order o
      JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
      JOIN proc.po_line l ON l.revision_id = v.id
      JOIN proj.project p ON p.id = o.project_id JOIN platform.party pt ON pt.id = o.party_id
      LEFT JOIN got ON got.po_id = o.id AND got.line_key = l.line_key
      WHERE o.project_id ${scope} AND o.kind = 'purchase' AND o.status IN ('issued', 'acknowledged')
        AND l.qty > coalesce(got.qty, 0)
      ORDER BY v.deliver_by NULLS LAST, o.number, l.position`;
    const lines = rows.map((r) => {
      const owed = dec(r.ordered) - dec(r.received);
      return {
        ...r,
        outstanding: q4(owed),
        value: fmt((owed * dec(r.rate)) / 10n ** 12n, 2),
        daysLate: r.deliverBy && r.deliverBy < today ? days(r.deliverBy, today) : 0,
      };
    });
    const bySupplier = new Map<
      string,
      { vendor: string; lines: number; late: number; value: Dec }
    >();
    for (const l of lines) {
      const s = bySupplier.get(l.vendor) ?? { vendor: l.vendor, lines: 0, late: 0, value: 0n };
      s.lines++;
      if (l.daysLate > 0) s.late++;
      s.value += dec(l.value);
      bySupplier.set(l.vendor, s);
    }
    return {
      today,
      lines,
      suppliers: [...bySupplier.values()]
        .sort((a, b) =>
          b.value > a.value ? 1 : b.value < a.value ? -1 : a.vendor.localeCompare(b.vendor),
        )
        .map((s) => ({ ...s, value: fmt(s.value, 2) })),
    };
  }

  /**
   * Material by material: budget, requisitioned, ordered, received, issued, in stock; and what the measured work
   * should have taken by the budget's norms (measured quantity × norm per BOQ item), against what was issued: the
   * wastage.
   */
  async materials(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const rows = await db<
      {
        resourceId: string;
        code: string;
        name: string;
        unit: string;
        budget: string | null;
        requisitioned: string;
        ordered: string;
        received: string;
        issued: string;
        inStock: string;
        theoretical: string | null;
      }[]
    >`
      WITH budget AS (
        SELECT l.resource_id, l.qty FROM proj.material_budget_line l
        JOIN proj.material_budget b ON b.id = l.budget_id WHERE b.project_id = ${projectId} AND b.status = 'approved'
      ), req AS (
        SELECT l.resource_id, sum(l.qty) AS qty FROM proc.requisition_line l
        JOIN proc.requisition q ON q.id = l.requisition_id
        WHERE q.project_id = ${projectId} AND q.status = 'approved' AND l.resource_id IS NOT NULL GROUP BY 1
      ), ord AS (
        SELECT l.resource_id, sum(l.qty) AS qty FROM proc.po_line l
        JOIN proc.po_revision v ON v.id = l.revision_id AND v.status = 'approved'
        JOIN proc.purchase_order o ON o.id = v.po_id AND o.status <> 'cancelled'
        WHERE o.project_id = ${projectId} AND l.resource_id IS NOT NULL GROUP BY 1
      ), rec AS (
        SELECT g.resource_id, sum(g.accepted_qty) AS qty FROM proc.grn_line g
        JOIN proc.goods_receipt r ON r.id = g.receipt_id AND r.status = 'posted'
        WHERE r.project_id = ${projectId} AND g.resource_id IS NOT NULL GROUP BY 1
      ), iss AS (
        SELECT m.resource_id, -sum(m.qty) AS qty FROM proc.stock_move m JOIN proc.store s ON s.id = m.store_id
        WHERE s.project_id = ${projectId} AND m.kind IN ('issue', 'issue_return') GROUP BY 1
      ), stock AS (
        SELECT b.resource_id, sum(b.qty) AS qty FROM proc.stock_balance b JOIN proc.store s ON s.id = b.store_id
        WHERE s.project_id = ${projectId} GROUP BY 1
      ), measured AS (
        SELECT line_key, sum(qty) AS qty FROM proj.measurement WHERE project_id = ${projectId} GROUP BY 1
      ), theory AS (
        SELECT n.resource_id, round(sum(n.per_unit * m.qty), 4) AS qty FROM proj.material_norm n
        JOIN measured m ON m.line_key = n.line_key WHERE n.project_id = ${projectId} GROUP BY 1
      ), ids AS (
        SELECT resource_id FROM budget UNION SELECT resource_id FROM req UNION SELECT resource_id FROM ord
        UNION SELECT resource_id FROM rec UNION SELECT resource_id FROM iss UNION SELECT resource_id FROM stock
      )
      SELECT x.id AS "resourceId", x.code, x.name, x.unit, budget.qty::text AS budget,
        coalesce(req.qty, 0)::text AS requisitioned, coalesce(ord.qty, 0)::text AS ordered,
        coalesce(rec.qty, 0)::text AS received, coalesce(iss.qty, 0)::text AS issued,
        coalesce(stock.qty, 0)::text AS "inStock", theory.qty::text AS theoretical
      FROM ids JOIN est.resource x ON x.id = ids.resource_id
      LEFT JOIN budget ON budget.resource_id = ids.resource_id LEFT JOIN req ON req.resource_id = ids.resource_id
      LEFT JOIN ord ON ord.resource_id = ids.resource_id LEFT JOIN rec ON rec.resource_id = ids.resource_id
      LEFT JOIN iss ON iss.resource_id = ids.resource_id LEFT JOIN stock ON stock.resource_id = ids.resource_id
      LEFT JOIN theory ON theory.resource_id = ids.resource_id
      WHERE x.kind = 'material'
      ORDER BY x.code`;
    return {
      lines: rows.map((r) => {
        const t = r.theoretical === null ? null : dec(r.theoretical);
        const waste = t === null ? null : dec(r.issued) - t;
        return {
          ...r,
          wastage: waste === null ? null : q4(waste),
          // Over the theoretical quantity, as a percentage to one decimal.
          wastagePct: waste === null || !t ? null : fmt((waste * 100n * 10n ** 12n) / t, 1),
        };
      }),
    };
  }

  /**
   * Each supplier: what was ordered from them, how much of what came was on time and how much was rejected (by value
   * at the order rate), and what their order rates were against the lowest quote on the same enquiry lines.
   */
  async suppliers(claims: TenantClaims, projectId?: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const scope = inScope(db, claims, await this.scope(db, claims, projectId));
    const rows = await db<
      {
        partyId: string;
        vendor: string;
        orders: number;
        orderedValue: string;
        receiptLines: number;
        onTime: number;
        dated: number;
        receivedValue: string;
        rejectedValue: string;
        paid: string | null;
        l1: string | null;
      }[]
    >`
      WITH live AS (
        SELECT o.id, o.party_id, v.id AS revision_id, v.total, v.deliver_by FROM proc.purchase_order o
        JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
        WHERE o.project_id ${scope} AND o.status <> 'cancelled'
      ), recv AS (
        SELECT live.party_id, count(*)::int AS lines,
          count(*) FILTER (WHERE live.deliver_by IS NOT NULL AND gr.received_on <= live.deliver_by)::int AS on_time,
          count(*) FILTER (WHERE live.deliver_by IS NOT NULL)::int AS dated,
          sum(g.qty * l.rate) AS received_value, sum(g.rejected_qty * l.rate) AS rejected_value
        FROM live JOIN proc.goods_receipt gr ON gr.po_id = live.id AND gr.status = 'posted'
        JOIN proc.grn_line g ON g.receipt_id = gr.id
        JOIN proc.po_line l ON l.revision_id = live.revision_id AND l.line_key = g.line_key
        GROUP BY live.party_id
      ), quoted AS (
        -- The lowest rate before GST quoted on each enquiry line.
        SELECT ql.line_id, min(CASE WHEN q.gst_mode = 'included' THEN ql.rate / (1 + q.gst_pct / 100) ELSE ql.rate END)
          AS l1
        FROM tender.rfq_quote_line ql JOIN tender.rfq_quote q ON q.id = ql.quote_id GROUP BY ql.line_id
      ), price AS (
        SELECT live.party_id, sum(l.qty * l.rate) AS paid, sum(l.qty * quoted.l1) AS l1
        FROM live JOIN proc.po_line l ON l.revision_id = live.revision_id
        JOIN quoted ON quoted.line_id = l.rfq_line_id GROUP BY live.party_id
      )
      SELECT pt.id AS "partyId", pt.name AS vendor, count(live.id)::int AS orders,
        sum(live.total)::text AS "orderedValue", coalesce(recv.lines, 0) AS "receiptLines",
        coalesce(recv.on_time, 0) AS "onTime", coalesce(recv.dated, 0) AS dated,
        coalesce(round(recv.received_value, 2), 0)::text AS "receivedValue",
        coalesce(round(recv.rejected_value, 2), 0)::text AS "rejectedValue",
        round(price.paid, 2)::text AS paid, round(price.l1, 2)::text AS l1
      FROM live JOIN platform.party pt ON pt.id = live.party_id
      LEFT JOIN recv ON recv.party_id = live.party_id LEFT JOIN price ON price.party_id = live.party_id
      GROUP BY pt.id, pt.name, recv.lines, recv.on_time, recv.dated, recv.received_value, recv.rejected_value,
        price.paid, price.l1
      ORDER BY sum(live.total) DESC, pt.name`;
    const pct = (a: Dec, b: Dec) => (b === 0n ? null : fmt((a * 100n * 10n ** 12n) / b, 1));
    return {
      suppliers: rows.map((r) => ({
        ...r,
        onTimePct: pct(dec(String(r.onTime)), dec(String(r.dated))),
        rejectedPct: pct(dec(r.rejectedValue), dec(r.receivedValue)),
        overL1Pct:
          r.paid === null || r.l1 === null ? null : pct(dec(r.paid) - dec(r.l1), dec(r.l1)),
      })),
    };
  }
}
