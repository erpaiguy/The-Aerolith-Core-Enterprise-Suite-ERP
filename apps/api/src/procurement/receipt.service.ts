// Goods receipts (docs/04-features.md R4, docs/wave2b-plan.md step 5): what came against a purchase order, at which
// site, on which challan. Each line is accepted at the gate (less anything rejected there) or held for inspection,
// then accepted and rejected. Rejected goods go back to the supplier on a return, and are still owed. An order whose
// every line has come and been accepted is closed; cancelling a receipt (a mistake) reopens it.
//
// What is accepted becomes stock in step 6 (inventory); until then a receipt is the record of what came.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { indiaToday } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import { emit } from '../integrations/events.js';
import { audit } from '../tender/tender-records.js';
import { linkedDocuments } from '../documents/links.js';
import { InventoryService } from './inventory.service.js';
import { orderProgress } from './receipt-progress.js';
import { reverseIn, stockIn, valuation, paise } from './stock-ledger.js';

type Db = Sql | TransactionSql;

export interface ReceiptInput {
  receivedOn: string;
  siteId: string | null;
  challanNo: string;
  challanDate: string | null;
  invoiceNo: string | null;
  vehicleNo: string | null;
  /** The store it goes into; by default the site's only store (made if it has none). */
  storeId: string | null;
  notes: string;
  lines: { lineKey: string; qty: string; rejected: string; reason: string | null; hold: boolean }[];
}

export interface ReturnInput {
  returnedOn: string;
  reference: string | null;
  reason: string;
  lines: { position: number; qty: string }[];
}

interface OrderRow {
  id: string;
  project_id: string;
  kind: 'purchase' | 'work';
  number: string;
  status: string;
  acknowledged_on: string | null;
  closed_on_receipt: boolean;
}
interface ReceiptRow {
  id: string;
  project_id: string;
  po_id: string;
  number: string;
  status: 'posted' | 'cancelled';
}

const q4 = (v: bigint) => fmt(v, 4);

@Injectable()
export class ReceiptService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Accepted lines of library materials go into the receipt's store at the order rate before GST (the input credit
   * is not a cost); typed-in lines are received but not stocked.
   */
  private async stockAccepted(
    tx: TransactionSql,
    claims: TenantClaims,
    r: { id: string; number: string; po_id: string; store_id: string | null },
    lines: { line_key: string; resource_id: string | null; accepted: string }[],
    on: string,
  ) {
    const stocked = lines.filter((l) => l.resource_id && dec(l.accepted) > 0n);
    if (!stocked.length) return;
    if (!r.store_id)
      throw new BadRequestException({
        code: 'choose_store',
        message: 'The site has more than one store: say which one it goes into.',
      });
    const method = await valuation(tx);
    for (const l of stocked) {
      const [rate] = await tx<{ rate: string }[]>`
        SELECT l.rate::text AS rate FROM proc.po_line l JOIN proc.po_revision v ON v.id = l.revision_id
        WHERE v.po_id = ${r.po_id} AND v.status = 'approved' AND l.line_key = ${l.line_key}`;
      const qty = dec(l.accepted);
      await stockIn(
        tx,
        method,
        {
          storeId: r.store_id,
          resourceId: l.resource_id!,
          on,
          kind: 'receipt',
          docType: 'goods_receipt',
          docId: r.id,
          docNumber: r.number,
          userId: claims.sub,
        },
        qty,
        paise((qty * dec(rate?.rate ?? '0')) / 10n ** 12n),
      );
    }
  }

  /** The project's team (lead or member, or those who edit projects) with `stores.receive`. */
  async mayReceive(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    return (
      (a.canEdit || a.role === 'member' || a.role === 'lead') &&
      (await this.permissions.can(claims, 'stores.receive'))
    );
  }

  private async mustReceive(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member' && a.role !== 'lead')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) receives goods for it.",
      });
    if (!(await this.permissions.can(claims, 'stores.receive')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'stores.receive' });
  }

  private async receipt(db: Db, id: string, lock = false) {
    const [r] = lock
      ? await db<ReceiptRow[]>`SELECT * FROM proc.goods_receipt WHERE id = ${id} FOR UPDATE`
      : await db<ReceiptRow[]>`SELECT * FROM proc.goods_receipt WHERE id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'receipt_not_found' });
    return r;
  }

  private async order(db: Db, id: string, lock = false) {
    const [o] = lock
      ? await db<OrderRow[]>`SELECT * FROM proc.purchase_order WHERE id = ${id} FOR UPDATE`
      : await db<OrderRow[]>`SELECT * FROM proc.purchase_order WHERE id = ${id}`;
    if (!o) throw new NotFoundException({ code: 'order_not_found' });
    return o;
  }

  /**
   * Everything ordered has come and been accepted, and no amendment is being worked on: the order is closed. A
   * receipt cancelled afterwards reopens it.
   */
  private async closeIfDone(tx: TransactionSql, orderId: string, claims: TenantClaims) {
    const o = await this.order(tx, orderId, true);
    if (o.status !== 'issued' && o.status !== 'acknowledged') return;
    const [open] = await tx`SELECT 1 FROM proc.po_revision WHERE po_id = ${orderId}
      AND status IN ('draft', 'submitted', 'rejected')`;
    if (open) return;
    const lines = await orderProgress(tx, orderId);
    if (!lines.length || lines.some((l) => dec(l.outstanding) > 0n || dec(l.onHold) > 0n)) return;
    await tx`UPDATE proc.purchase_order SET status = 'closed', status_reason = 'Received in full',
        closed_on_receipt = true, updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
      WHERE id = ${orderId}`;
    await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
      VALUES (${o.project_id}, 'order_closed', ${tx.json({ number: o.number, reason: 'Received in full' })},
        ${claims.sub})`;
  }

  /** A receipt against an issued purchase order: nothing beyond what is still owed (amend the order for more). */
  async receive(claims: TenantClaims, orderId: string, input: ReceiptInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const o0 = await this.order(db, orderId);
    await this.mustReceive(db, claims, o0.project_id);
    if (input.receivedOn > indiaToday())
      throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
    const id = await db.begin(async (tx) => {
      const o = await this.order(tx, orderId, true);
      if (o.kind !== 'purchase')
        throw new ConflictException({
          code: 'work_order',
          message: 'Work is measured, not received: work orders are billed on measurement.',
        });
      if (o.status !== 'issued' && o.status !== 'acknowledged')
        throw new ConflictException({
          code: 'not_receivable',
          message:
            o.status === 'draft'
              ? 'The order is not issued yet.'
              : `The order is ${o.status}: nothing more is expected under it.`,
        });
      if (!input.lines.length)
        throw new BadRequestException({ code: 'no_lines', message: 'Say what came.' });
      const owed = new Map((await orderProgress(tx, orderId)).map((l) => [l.lineKey, l]));
      const seen = new Set<string>();
      const lines = input.lines.map((l, i) => {
        const p = owed.get(l.lineKey);
        if (!p) throw new BadRequestException({ code: 'line_not_on_order' });
        if (seen.has(l.lineKey))
          throw new BadRequestException({
            code: 'duplicate_line',
            message: `${p.description} is twice on the receipt.`,
          });
        seen.add(l.lineKey);
        const qty = dec(l.qty);
        const rejected = l.hold ? 0n : dec(l.rejected);
        if (qty > dec(p.outstanding))
          throw new ConflictException({
            code: 'over_order',
            message: `${p.description}: ${Number(p.outstanding)} ${p.unit} is still owed, not ${Number(l.qty)}. Amend the order for more.`,
          });
        if (rejected > qty)
          throw new BadRequestException({
            code: 'rejected_over_received',
            message: `${p.description}: more rejected than came.`,
          });
        if (rejected > 0n && !l.reason?.trim())
          throw new BadRequestException({
            code: 'reason_needed',
            message: `${p.description}: say why it was rejected.`,
          });
        return {
          position: i + 1,
          line_key: l.lineKey,
          resource_id: p.resourceId,
          description: p.description,
          unit: p.unit,
          qty: q4(qty),
          inspection: l.hold ? 'hold' : 'gate',
          accepted_qty: q4(l.hold ? 0n : qty - rejected),
          rejected_qty: q4(rejected),
          rejection_reason: rejected > 0n ? l.reason!.trim() : null,
        };
      });
      let siteId = input.siteId;
      if (siteId) {
        const [s] =
          await tx`SELECT 1 FROM proj.site WHERE id = ${siteId} AND project_id = ${o.project_id}`;
        if (!s)
          throw new BadRequestException({
            code: 'site_not_found',
            message: "Choose one of the project's sites.",
          });
      } else {
        const [f] = await tx<{ site_id: string | null }[]>`
          SELECT site_id FROM proc.po_revision WHERE po_id = ${orderId} AND status = 'approved'`;
        siteId = f?.site_id ?? null;
      }
      const storeId = lines.some((l) => l.resource_id)
        ? await this.inventory.storeForReceipt(tx, claims, o.project_id, siteId, input.storeId)
        : null;
      const [p] = await tx<{ entity_id: string }[]>`
        SELECT entity_id FROM proj.project WHERE id = ${o.project_id}`;
      const number = await nextNumber(tx, 'goods_receipt', p!.entity_id, 'GRN', new Date());
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO proc.goods_receipt (project_id, po_id, number, site_id, store_id, received_on, challan_no,
          challan_date, invoice_no, vehicle_no, notes, created_by, updated_by)
        VALUES (${o.project_id}, ${orderId}, ${number}, ${siteId}, ${storeId}, ${input.receivedOn}, ${input.challanNo},
          ${input.challanDate}, ${input.invoiceNo}, ${input.vehicleNo}, ${input.notes}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      await tx`INSERT INTO proc.grn_line ${tx(lines.map((l) => ({ ...l, receipt_id: r!.id })))}`;
      await emit(tx, 'receipt.posted', {
        receiptId: r!.id,
        number,
        orderId,
        projectId: o.project_id,
        receivedOn: input.receivedOn,
        challanNo: input.challanNo,
      });
      await this.stockAccepted(
        tx,
        claims,
        { id: r!.id, number, po_id: orderId, store_id: storeId },
        lines.map((l) => ({
          line_key: l.line_key,
          resource_id: l.resource_id,
          accepted: l.accepted_qty,
        })),
        input.receivedOn,
      );
      await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
        VALUES (${o.project_id}, 'goods_received', ${tx.json({ number, order: o.number })}, ${claims.sub})`;
      await audit(tx, claims.sub, 'receipt.create', 'goods_receipt', r!.id, {
        number,
        order: o.number,
        lines: lines.length,
      });
      await this.closeIfDone(tx, orderId, claims);
      return r!.id;
    });
    return this.get(claims, id);
  }

  /** The held lines inspected: what is accepted and what rejected (with why), adding up to what came. */
  async inspect(
    claims: TenantClaims,
    receiptId: string,
    input: {
      lines: { position: number; accepted: string; rejected: string; reason: string | null }[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.receipt(db, receiptId);
    await this.mustReceive(db, claims, r0.project_id);
    await db.begin(async (tx) => {
      const r = await this.receipt(tx, receiptId, true);
      if (r.status !== 'posted')
        throw new ConflictException({ code: 'receipt_cancelled', message: 'It is cancelled.' });
      const accepted: { line_key: string; resource_id: string | null; accepted: string }[] = [];
      for (const l of input.lines) {
        const [g] = await tx<
          {
            qty: string;
            inspection: string;
            description: string;
            line_key: string;
            resource_id: string | null;
          }[]
        >`
          SELECT qty::text AS qty, inspection, description, line_key, resource_id FROM proc.grn_line
          WHERE receipt_id = ${receiptId} AND position = ${l.position} FOR UPDATE`;
        if (!g) throw new BadRequestException({ code: 'line_not_found' });
        if (g.inspection !== 'hold')
          throw new ConflictException({
            code: 'not_on_hold',
            message: `${g.description} is not waiting for inspection.`,
          });
        const [a, x] = [dec(l.accepted), dec(l.rejected)];
        if (a + x !== dec(g.qty))
          throw new BadRequestException({
            code: 'does_not_add_up',
            message: `${g.description}: accepted and rejected make ${fmt(a + x, 4, 0)}, but ${fmt(dec(g.qty), 4, 0)} came.`,
          });
        if (x > 0n && !l.reason?.trim())
          throw new BadRequestException({
            code: 'reason_needed',
            message: `${g.description}: say why it was rejected.`,
          });
        await tx`UPDATE proc.grn_line SET inspection = 'inspected', accepted_qty = ${q4(a)},
            rejected_qty = ${q4(x)}, rejection_reason = ${x > 0n ? l.reason!.trim() : null},
            inspected_at = now(), inspected_by = ${claims.sub}
          WHERE receipt_id = ${receiptId} AND position = ${l.position}`;
        accepted.push({ line_key: g.line_key, resource_id: g.resource_id, accepted: q4(a) });
      }
      // A receipt from before stores existed finds its store now.
      const [head] = await tx<{ store_id: string | null; site_id: string | null }[]>`
        SELECT store_id, site_id FROM proc.goods_receipt WHERE id = ${receiptId}`;
      let storeId = head!.store_id;
      if (!storeId && accepted.some((l) => l.resource_id)) {
        storeId = await this.inventory.storeForReceipt(
          tx,
          claims,
          r.project_id,
          head!.site_id,
          null,
        );
        if (storeId)
          await tx`UPDATE proc.goods_receipt SET store_id = ${storeId} WHERE id = ${receiptId}`;
      }
      await this.stockAccepted(
        tx,
        claims,
        { id: r.id, number: r.number, po_id: r.po_id, store_id: storeId },
        accepted,
        indiaToday(),
      );
      await tx`UPDATE proc.goods_receipt SET updated_at = now(), updated_by = ${claims.sub},
        row_version = row_version + 1 WHERE id = ${receiptId}`;
      await audit(tx, claims.sub, 'receipt.inspect', 'goods_receipt', receiptId, {
        lines: input.lines.length,
      });
      await this.closeIfDone(tx, r.po_id, claims);
    });
    return this.get(claims, receiptId);
  }

  /** Rejected goods sent back to the supplier: no more than was rejected and not yet returned. */
  async returnGoods(claims: TenantClaims, receiptId: string, input: ReturnInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.receipt(db, receiptId);
    await this.mustReceive(db, claims, r0.project_id);
    if (input.returnedOn > indiaToday())
      throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
    await db.begin(async (tx) => {
      const r = await this.receipt(tx, receiptId, true);
      if (r.status !== 'posted')
        throw new ConflictException({ code: 'receipt_cancelled', message: 'It is cancelled.' });
      if (!input.lines.length)
        throw new BadRequestException({ code: 'no_lines', message: 'Say what goes back.' });
      for (const l of input.lines) {
        const [g] = await tx<{ description: string; unit: string; left: string }[]>`
          SELECT g.description, g.unit, (g.rejected_qty - coalesce((SELECT sum(x.qty) FROM proc.goods_return_line x
              JOIN proc.goods_return t ON t.id = x.return_id
              WHERE t.receipt_id = g.receipt_id AND x.position = g.position), 0))::text AS left
          FROM proc.grn_line g WHERE g.receipt_id = ${receiptId} AND g.position = ${l.position}`;
        if (!g) throw new BadRequestException({ code: 'line_not_found' });
        if (dec(l.qty) > dec(g.left))
          throw new ConflictException({
            code: 'over_rejected',
            message: `${g.description}: ${fmt(dec(g.left), 4, 0)} ${g.unit} is rejected and not yet returned.`,
          });
      }
      const [p] = await tx<{ entity_id: string }[]>`
        SELECT entity_id FROM proj.project WHERE id = ${r.project_id}`;
      const number = await nextNumber(tx, 'goods_return', p!.entity_id, 'RTV', new Date());
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO proc.goods_return (receipt_id, number, returned_on, reference, reason, created_by)
        VALUES (${receiptId}, ${number}, ${input.returnedOn}, ${input.reference}, ${input.reason}, ${claims.sub})
        RETURNING id`;
      await tx`INSERT INTO proc.goods_return_line ${tx(
        input.lines.map((l) => ({ return_id: t!.id, position: l.position, qty: q4(dec(l.qty)) })),
      )}`;
      await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
        VALUES (${r.project_id}, 'goods_returned', ${tx.json({ number, receipt: r.number })}, ${claims.sub})`;
      await audit(tx, claims.sub, 'receipt.return', 'goods_receipt', receiptId, { number });
    });
    return this.get(claims, receiptId);
  }

  /** A receipt made in error, cancelled with a reason; its goods are owed again (and a closed order reopened). */
  async cancel(claims: TenantClaims, receiptId: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.receipt(db, receiptId);
    await this.mustReceive(db, claims, r0.project_id);
    await db.begin(async (tx) => {
      const o = await this.order(tx, r0.po_id, true);
      const r = await this.receipt(tx, receiptId, true);
      if (r.status !== 'posted')
        throw new ConflictException({
          code: 'receipt_cancelled',
          message: 'It is already cancelled.',
        });
      const [ret] =
        await tx`SELECT 1 FROM proc.goods_return WHERE receipt_id = ${receiptId} LIMIT 1`;
      if (ret)
        throw new ConflictException({
          code: 'has_returns',
          message: 'Goods from it went back to the supplier: it stays on the record.',
        });
      // What it put into stock comes out again; refused if it has since been issued.
      const moves = await tx<{ id: string; store_id: string; resource_id: string }[]>`
        SELECT id::text AS id, store_id, resource_id FROM proc.stock_move
        WHERE doc_type = 'goods_receipt' AND doc_id = ${receiptId} AND kind = 'receipt' ORDER BY id`;
      const method = await valuation(tx);
      for (const m of moves)
        await reverseIn(tx, method, m.id, {
          storeId: m.store_id,
          resourceId: m.resource_id,
          on: indiaToday(),
          kind: 'receipt_cancelled',
          docType: 'goods_receipt',
          docId: receiptId,
          docNumber: r.number,
          userId: claims.sub,
        }).catch((e: unknown) => {
          if (e instanceof ConflictException)
            throw new ConflictException({
              code: 'stock_used',
              message:
                'Material from it has already been issued from the store: it stays on the record.',
            });
          throw e;
        });
      await tx`UPDATE proc.goods_receipt SET status = 'cancelled', status_reason = ${reason}, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${receiptId}`;
      if (o.status === 'closed' && o.closed_on_receipt)
        await tx`UPDATE proc.purchase_order
          SET status = ${o.acknowledged_on ? 'acknowledged' : 'issued'}, status_reason = NULL,
            closed_on_receipt = false, updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
          WHERE id = ${o.id}`;
      await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
        VALUES (${r.project_id}, 'receipt_cancelled', ${tx.json({ number: r.number, reason })}, ${claims.sub})`;
      await audit(tx, claims.sub, 'receipt.cancel', 'goods_receipt', receiptId, { reason });
    });
    return this.get(claims, receiptId);
  }

  // --- reading ---

  async get(claims: TenantClaims, receiptId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.receipt(db, receiptId);
    const access = await this.projects.access(db, claims, r.project_id);
    const may = await this.mayReceive(db, claims, r.project_id);
    const [h] = await db`
      SELECT g.id, g.number, g.status, g.status_reason AS "statusReason",
        to_char(g.received_on, 'YYYY-MM-DD') AS "receivedOn", g.challan_no AS "challanNo",
        to_char(g.challan_date, 'YYYY-MM-DD') AS "challanDate", g.invoice_no AS "invoiceNo",
        g.vehicle_no AS "vehicleNo", g.notes,
        json_build_object('id', o.id, 'number', o.number, 'status', o.status) AS "order",
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', v.id, 'name', v.name, 'gstin', v.gstin) AS vendor,
        CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name) END AS site,
        CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object('id', st.id, 'name', st.name) END AS store,
        u.display_name AS "receivedBy", g.created_at AS "createdAt", g.row_version AS "rowVersion"
      FROM proc.goods_receipt g
      JOIN proc.purchase_order o ON o.id = g.po_id
      JOIN proj.project p ON p.id = g.project_id
      JOIN platform.party v ON v.id = o.party_id
      LEFT JOIN proj.site s ON s.id = g.site_id
      LEFT JOIN proc.store st ON st.id = g.store_id
      LEFT JOIN platform."user" u ON u.id = g.created_by
      WHERE g.id = ${receiptId}`;
    const lines = await db<{ inspection: string; rejected: string; returned: string }[]>`
      SELECT g.position, g.line_key AS "lineKey", (g.resource_id IS NOT NULL) AS stocked, g.description, g.unit, g.qty::text AS qty, g.inspection,
        g.accepted_qty::text AS accepted, g.rejected_qty::text AS rejected, g.rejection_reason AS "rejectionReason",
        coalesce((SELECT sum(x.qty) FROM proc.goods_return_line x JOIN proc.goods_return t ON t.id = x.return_id
          WHERE t.receipt_id = g.receipt_id AND x.position = g.position), 0)::text AS returned,
        u.display_name AS "inspectedBy", g.inspected_at AS "inspectedAt"
      FROM proc.grn_line g LEFT JOIN platform."user" u ON u.id = g.inspected_by
      WHERE g.receipt_id = ${receiptId} ORDER BY g.position`;
    const returns = await db`
      SELECT t.id, t.number, to_char(t.returned_on, 'YYYY-MM-DD') AS "returnedOn", t.reference, t.reason,
        coalesce(json_agg(json_build_object('position', x.position, 'qty', x.qty::text) ORDER BY x.position)
          FILTER (WHERE x.position IS NOT NULL), '[]') AS lines
      FROM proc.goods_return t LEFT JOIN proc.goods_return_line x ON x.return_id = t.id
      WHERE t.receipt_id = ${receiptId} GROUP BY t.id ORDER BY t.created_at`;
    const documents =
      (
        await linkedDocuments(
          db,
          'goods_receipt',
          [receiptId],
          await this.permissions.can(claims, 'pricing.edit'),
        )
      ).get(receiptId) ?? [];
    const posted = r.status === 'posted';
    return {
      ...h!,
      lines,
      returns,
      documents,
      // The challan and test certificates go into the project's documents: its team, with documents.edit.
      mayAttach:
        (access.canEdit || access.role === 'lead' || access.role === 'member') &&
        (await this.permissions.can(claims, 'documents.edit')),
      mayInspect: may && posted && lines.some((l) => l.inspection === 'hold'),
      mayReturn: may && posted && lines.some((l) => dec(l.rejected) > dec(l.returned)),
      mayCancel: may && posted && returns.length === 0,
    };
  }

  /** An order's receipts, for its page. */
  async forOrder(db: Db, orderId: string) {
    return db`
      SELECT g.id, g.number, g.status, to_char(g.received_on, 'YYYY-MM-DD') AS "receivedOn",
        g.challan_no AS "challanNo",
        (SELECT count(*)::int FROM proc.grn_line l WHERE l.receipt_id = g.id AND l.inspection = 'hold') AS held
      FROM proc.goods_receipt g WHERE g.po_id = ${orderId} ORDER BY g.received_on DESC, g.created_at DESC`;
  }

  /** Receipts across the projects I am on (or one project's). */
  async list(
    claims: TenantClaims,
    q: { projectId?: string | undefined; held?: boolean | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (q.projectId) await this.projects.access(db, claims, q.projectId);
    const all = claims.role === 'admin' || (await this.permissions.can(claims, 'projects.all'));
    return db`
      SELECT g.id, g.number, g.status, to_char(g.received_on, 'YYYY-MM-DD') AS "receivedOn",
        g.challan_no AS "challanNo", o.number AS "orderNumber", o.id AS "orderId", v.name AS vendor,
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        (SELECT count(*)::int FROM proc.grn_line l WHERE l.receipt_id = g.id) AS lines,
        (SELECT count(*)::int FROM proc.grn_line l WHERE l.receipt_id = g.id AND l.inspection = 'hold') AS held
      FROM proc.goods_receipt g
      JOIN proc.purchase_order o ON o.id = g.po_id
      JOIN proj.project p ON p.id = g.project_id
      JOIN platform.party v ON v.id = o.party_id
      WHERE ${
        all
          ? db`true`
          : db`EXISTS (SELECT 1 FROM proj.member m WHERE m.project_id = g.project_id AND m.user_id = ${claims.sub})`
      }
        ${q.projectId ? db`AND g.project_id = ${q.projectId}` : db``}
        ${
          q.held
            ? db`AND g.status = 'posted' AND EXISTS (SELECT 1 FROM proc.grn_line l WHERE l.receipt_id = g.id
                AND l.inspection = 'hold')`
            : db``
        }
      ORDER BY g.received_on DESC, g.created_at DESC LIMIT 500`;
  }
}
