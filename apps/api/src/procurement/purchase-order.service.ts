// Purchase and work orders (docs/04-features.md R3, docs/wave2b-plan.md step 4): what a project buys, from whom, at
// what rate, delivered where and when, on what terms. Made from the vendors chosen in a project's enquiry, or written
// directly. Rates are before GST and GST is added on top (owner decision, 11 Oct 2026): CGST + SGST when the
// supplier's state (the first two digits of its GSTIN) is the site's, IGST across states, none charged by a supplier
// without a GSTIN.
//
// An order is a series of revisions. Revision 0 is the order as issued; an amendment is a later one, a copy of the
// one in force, changed with a reason. Each is approved under the approval rules (for its total, an amendment for
// what it adds) before it is in force. Once issued, the supplier's acknowledgement is recorded; an amendment needs a
// new one. An order is cancelled with a reason, or closed when done.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { ApprovalService, indiaToday, type Outcome } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { cents, fromCents } from '../project/money.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt, mul } from '../rates/decimal.js';
import { RfqService } from '../rfq/rfq.service.js';
import { nextNumber } from '../tender/numbering.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
export const PURCHASE_ORDER = 'purchase_order';
export type OrderKind = 'purchase' | 'work';
export type OrderStatus = 'draft' | 'issued' | 'acknowledged' | 'closed' | 'cancelled';
export type RevisionStatus =
  'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded' | 'discarded';
export type Supply = 'intra' | 'inter' | 'unregistered';

export interface OrderLineInput {
  resourceId: string | null;
  rfqLineId?: string | null;
  description: string;
  hsn: string | null;
  unit: string;
  qty: string;
  rate: string;
  gstPct: string;
}

export interface RevisionInput {
  siteId: string | null;
  deliverBy: string | null;
  paymentTerms: string;
  deliveryTerms: string;
  otherTerms: string;
  reason: string;
  lines: OrderLineInput[];
}

/** Within the state, across states, or a supplier without a GSTIN (who charges none). Null: no place of supply yet. */
export function supplyOf(gstin: string | null, siteState: string | null): Supply | null {
  if (!gstin) return 'unregistered';
  if (!siteState) return null;
  return gstin.slice(0, 2) === siteState ? 'intra' : 'inter';
}

/** A line's amount and GST, each rounded to the paisa as an invoice would show it. */
export function lineTax(qty: string, rate: string, gstPct: string, supply: Supply | null) {
  const amount = fmt(mul(dec(qty), dec(rate)), 2);
  const tax = (pct: string) => fmt(mul(dec(amount), dec(pct)) / 100n, 2);
  const half = String(Number(gstPct) / 2);
  return {
    amount,
    cgst: supply === 'intra' ? tax(half) : '0.00',
    sgst: supply === 'intra' ? tax(half) : '0.00',
    igst: supply === 'inter' ? tax(gstPct) : '0.00',
  };
}

const OPEN: RevisionStatus[] = ['draft', 'submitted', 'rejected'];
const EDITABLE: RevisionStatus[] = ['draft', 'rejected'];
const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this order. Reload to see their changes.',
  });

interface OrderRow {
  id: string;
  project_id: string;
  kind: OrderKind;
  number: string;
  party_id: string;
  status: OrderStatus;
  row_version: number;
}
interface RevisionRow {
  id: string;
  po_id: string;
  revision: number;
  status: RevisionStatus;
  total: string;
  row_version: number;
}

@Injectable()
export class PurchaseOrderService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
    private readonly rfqs: RfqService,
  ) {}

  onModuleInit() {
    this.approvals.register(PURCHASE_ORDER, {
      label: 'Purchase order',
      projectScoped: true,
      link: (revisionId) => `/orders/revision/${revisionId}`,
      decided: (tx, id, outcome, claims, comment) => this.decided(tx, id, outcome, claims, comment),
      summary: (db, id) => this.revisionSummary(db, id),
      canSee: async (db, claims, id) => {
        const [r] = await db<{ project_id: string }[]>`
          SELECT o.project_id FROM proc.po_revision v JOIN proc.purchase_order o ON o.id = v.po_id
          WHERE v.id = ${id}`;
        if (!r) return false;
        return this.projects.access(db, claims, r.project_id).then(
          () => true,
          () => false,
        );
      },
    });
  }

  /** The project's team (lead or member, or those who edit projects) with `purchase.edit` makes and changes orders. */
  private async mayOrder(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) orders for it.",
      });
    if (!(await this.permissions.can(claims, 'purchase.edit')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'purchase.edit' });
  }

  private async order(db: Db, id: string, lock = false) {
    const [o] = lock
      ? await db<OrderRow[]>`SELECT * FROM proc.purchase_order WHERE id = ${id} FOR UPDATE`
      : await db<OrderRow[]>`SELECT * FROM proc.purchase_order WHERE id = ${id}`;
    if (!o) throw new NotFoundException({ code: 'order_not_found' });
    return o;
  }

  private async revisionRow(db: Db, id: string, lock = false) {
    const [r] = lock
      ? await db<RevisionRow[]>`SELECT * FROM proc.po_revision WHERE id = ${id} FOR UPDATE`
      : await db<RevisionRow[]>`SELECT * FROM proc.po_revision WHERE id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'order_not_found' });
    return r;
  }

  // --- writing a revision ---

  /** Checks the site and lines, works out amounts and GST, and replaces the revision's lines and totals. */
  private async write(tx: TransactionSql, o: OrderRow, revisionId: string, input: RevisionInput) {
    let siteState: string | null = null;
    if (input.siteId) {
      const [s] = await tx<{ state_code: string | null }[]>`
        SELECT state_code FROM proj.site WHERE id = ${input.siteId} AND project_id = ${o.project_id}`;
      if (!s)
        throw new BadRequestException({
          code: 'site_not_found',
          message: "Choose one of the project's sites.",
        });
      siteState = s.state_code;
    }
    const [v] = await tx<{ gstin: string | null }[]>`
      SELECT gstin FROM platform.party WHERE id = ${o.party_id}`;
    const supply = supplyOf(v!.gstin, siteState);
    const resIds = [
      ...new Set(input.lines.map((l) => l.resourceId).filter((x): x is string => !!x)),
    ];
    if (resIds.length) {
      const found = await tx<{ id: string }[]>`
        SELECT id FROM est.resource WHERE id = ANY(${resIds}::uuid[])`;
      if (found.length !== resIds.length)
        throw new BadRequestException({ code: 'resource_not_found' });
    }
    const lines = input.lines.map((l, i) => ({
      revision_id: revisionId,
      position: i + 1,
      resource_id: l.resourceId,
      rfq_line_id: l.rfqLineId ?? null,
      description: l.description,
      hsn: l.hsn,
      unit: l.unit,
      qty: l.qty,
      rate: l.rate,
      gst_pct: supply === 'unregistered' ? '0' : l.gstPct,
      ...lineTax(l.qty, l.rate, supply === 'unregistered' ? '0' : l.gstPct, supply),
    }));
    await tx`DELETE FROM proc.po_line WHERE revision_id = ${revisionId}`;
    if (lines.length) await tx`INSERT INTO proc.po_line ${tx(lines)}`;
    const sum = (k: 'amount' | 'cgst' | 'sgst' | 'igst') =>
      lines.reduce((s, l) => s + cents(l[k]), 0n);
    const [subtotal, cgst, sgst, igst] = [sum('amount'), sum('cgst'), sum('sgst'), sum('igst')];
    await tx`
      UPDATE proc.po_revision SET site_id = ${input.siteId}, deliver_by = ${input.deliverBy},
        payment_terms = ${input.paymentTerms}, delivery_terms = ${input.deliveryTerms},
        other_terms = ${input.otherTerms}, reason = ${input.reason}, supply = ${supply},
        subtotal = ${fromCents(subtotal)}, cgst = ${fromCents(cgst)}, sgst = ${fromCents(sgst)},
        igst = ${fromCents(igst)}, total = ${fromCents(subtotal + cgst + sgst + igst)}
      WHERE id = ${revisionId}`;
  }

  private async newOrder(
    tx: TransactionSql,
    claims: TenantClaims,
    projectId: string,
    head: { kind: OrderKind; partyId: string; rfqId: string | null },
    input: RevisionInput,
  ) {
    const [p] = await tx<{ entity_id: string }[]>`
      SELECT entity_id FROM proj.project WHERE id = ${projectId}`;
    const [party] =
      await tx`SELECT 1 FROM platform.party WHERE id = ${head.partyId} AND deleted_at IS NULL`;
    if (!party) throw new BadRequestException({ code: 'vendor_not_found' });
    const number = await nextNumber(
      tx,
      head.kind === 'work' ? 'work_order' : 'purchase_order',
      p!.entity_id,
      head.kind === 'work' ? 'WO' : 'PO',
      new Date(),
    );
    const [o] = await tx<OrderRow[]>`
      INSERT INTO proc.purchase_order (project_id, kind, number, party_id, rfq_id, created_by, updated_by)
      VALUES (${projectId}, ${head.kind}, ${number}, ${head.partyId}, ${head.rfqId}, ${claims.sub}, ${claims.sub})
      RETURNING *`;
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO proc.po_revision (po_id, revision, created_by, updated_by)
      VALUES (${o!.id}, 0, ${claims.sub}, ${claims.sub}) RETURNING id`;
    await this.write(tx, o!, r!.id, input);
    await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
      VALUES (${projectId}, 'order_created', ${tx.json({ number, rfqId: head.rfqId })}, ${claims.sub})`;
    await audit(tx, claims.sub, 'order.create', 'purchase_order', o!.id, { number });
    return o!.id;
  }

  /** An order written directly (no enquiry). */
  async create(
    claims: TenantClaims,
    projectId: string,
    head: { kind: OrderKind; partyId: string },
    input: RevisionInput,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayOrder(db, claims, projectId);
    const id = await db.begin((tx) =>
      this.newOrder(tx, claims, projectId, { ...head, rfqId: null }, input),
    );
    return this.get(claims, id);
  }

  /**
   * Draft orders from a project's enquiry: one per vendor chosen, with the lines chosen for them at the rate before
   * GST (and the GST rate they quoted), delivered to the site the requisitions asked for. Lines already on a live
   * order are left out.
   */
  async fromRfq(claims: TenantClaims, rfqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const rfq = await this.rfqs.get(claims, rfqId);
    if (!rfq.projectId)
      throw new ConflictException({
        code: 'not_for_tender',
        message: "A tender's enquiry prices the estimate; orders come from a project's.",
      });
    await this.mayOrder(db, claims, rfq.projectId);
    const ordered = new Set(
      (
        await db<{ rfq_line_id: string }[]>`
          SELECT DISTINCT l.rfq_line_id FROM proc.po_line l
          JOIN proc.po_revision v ON v.id = l.revision_id
          JOIN proc.purchase_order o ON o.id = v.po_id
          WHERE o.rfq_id = ${rfqId} AND o.status <> 'cancelled' AND v.status <> 'discarded'
            AND l.rfq_line_id IS NOT NULL`
      ).map((x) => x.rfq_line_id),
    );
    const chosen = rfq.lines.filter((l) => l.selected && !ordered.has(l.id));
    if (!chosen.length)
      throw new ConflictException({
        code: 'nothing_to_order',
        message: 'Choose a vendor for the lines first (lines already ordered are left out).',
      });
    const [site] = await db<{ site_id: string | null }[]>`
      SELECT q.site_id FROM proc.rfq_requisition_line x JOIN tender.rfq_line l ON l.id = x.rfq_line_id
      JOIN proc.requisition q ON q.id = x.requisition_id
      WHERE l.rfq_id = ${rfqId} AND q.site_id IS NOT NULL LIMIT 1`;
    const ids: string[] = [];
    await db.begin(async (tx) => {
      for (const v of rfq.vendors) {
        const mine = chosen.filter((l) => l.selected!.partyId === v.partyId);
        if (!mine.length || !v.quote) continue;
        const gst = v.quote.gstMode === 'exempt' ? '0' : v.quote.gstPct;
        ids.push(
          await this.newOrder(
            tx,
            claims,
            rfq.projectId!,
            { kind: rfq.kind === 'work' ? 'work' : 'purchase', partyId: v.partyId, rfqId },
            {
              siteId: site?.site_id ?? null,
              deliverBy: null,
              paymentTerms: '',
              deliveryTerms: '',
              otherTerms: v.quote.terms ? `As quoted: ${v.quote.terms}` : '',
              reason: '',
              lines: mine.map((l) => ({
                resourceId: l.resourceId,
                rfqLineId: l.id,
                description: l.description,
                hsn: null,
                unit: l.unit ?? 'nos',
                qty: l.qty ?? '1',
                rate: fmt(dec(l.selected!.basic), 4),
                gstPct: gst,
              })),
            },
          ),
        );
      }
    });
    return { orders: await Promise.all(ids.map((id) => this.get(claims, id))) };
  }

  /** Changes a draft (or rejected) revision: terms, delivery and lines. */
  async update(claims: TenantClaims, revisionId: string, rowVersion: number, input: RevisionInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.revisionRow(db, revisionId);
    const o = await this.order(db, r.po_id);
    await this.mayOrder(db, claims, o.project_id);
    if (!EDITABLE.includes(r.status))
      throw new ConflictException({
        code: 'not_editable',
        message:
          r.status === 'submitted'
            ? 'It is waiting for approval: withdraw it to change it.'
            : 'An order in force is changed by an amendment.',
      });
    await db.begin(async (tx) => {
      const [u] = await tx`
        UPDATE proc.po_revision SET status = 'draft', status_reason = NULL, updated_at = now(),
          updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${revisionId} AND row_version = ${rowVersion} AND status IN ('draft', 'rejected') RETURNING id`;
      if (!u) throw stale();
      await this.write(tx, o, revisionId, input);
      await audit(tx, claims.sub, 'order.update', 'po_revision', revisionId, {
        lines: input.lines.length,
      });
    });
    return this.get(claims, o.id);
  }

  /**
   * Sends a revision for approval: revision 0 for its total, an amendment for what it adds to the order in force.
   * With no rule for that amount it is in force at once.
   */
  async submit(claims: TenantClaims, revisionId: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.revisionRow(db, revisionId);
    const o = await this.order(db, r0.po_id);
    await this.mayOrder(db, claims, o.project_id);
    await db.begin(async (tx) => {
      await this.order(tx, o.id, true);
      const r = await this.revisionRow(tx, revisionId, true);
      if (r.row_version !== rowVersion) throw stale();
      if (!EDITABLE.includes(r.status))
        throw new ConflictException({
          code: 'not_submittable',
          message: 'This cannot be submitted.',
        });
      const [check] = await tx<{ lines: number; supply: Supply | null; site: boolean }[]>`
        SELECT (SELECT count(*)::int FROM proc.po_line WHERE revision_id = v.id) AS lines, v.supply,
          v.site_id IS NOT NULL AS site
        FROM proc.po_revision v WHERE v.id = ${revisionId}`;
      if (!check!.lines)
        throw new BadRequestException({ code: 'no_lines', message: 'Add what is ordered first.' });
      if (!check!.site || check!.supply === null)
        throw new BadRequestException({
          code: 'no_place_of_supply',
          message: check!.site
            ? "The site has no GST state code: set it on the project's page, so GST can be worked out."
            : 'Say which site it is delivered to: that decides the GST.',
        });
      const [inForce] = await tx<{ total: string }[]>`
        SELECT total::text FROM proc.po_revision WHERE po_id = ${o.id} AND status = 'approved'`;
      const delta = inForce ? cents(r.total) - cents(inForce.total) : cents(r.total);
      const [v] = await tx<
        { name: string }[]
      >`SELECT name FROM platform.party WHERE id = ${o.party_id}`;
      const res = await this.approvals.submit(tx, claims, {
        docType: PURCHASE_ORDER,
        docId: revisionId,
        projectId: o.project_id,
        title: `${o.number}${r.revision ? ` amendment ${r.revision}` : ''} · ${v!.name}`,
        amount: fromCents(delta > 0n ? delta : 0n),
      });
      await tx`UPDATE proc.po_revision SET status = 'submitted', status_reason = NULL, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${revisionId}`;
      if (res.status === 'approved') await this.putInForce(tx, revisionId, claims);
      await audit(tx, claims.sub, 'order.submit', 'po_revision', revisionId, {
        status: res.status,
      });
    });
    return this.get(claims, o.id);
  }

  /** The revision is in force: the order is issued (again, after an amendment: the supplier acknowledges anew). */
  private async putInForce(tx: TransactionSql, revisionId: string, claims: TenantClaims) {
    const r = await this.revisionRow(tx, revisionId);
    await tx`UPDATE proc.po_revision SET status = 'superseded', row_version = row_version + 1
      WHERE po_id = ${r.po_id} AND status = 'approved'`;
    await tx`UPDATE proc.po_revision SET status = 'approved', approved_at = now(), row_version = row_version + 1
      WHERE id = ${revisionId}`;
    const [o] = await tx<{ project_id: string; number: string }[]>`
      UPDATE proc.purchase_order SET status = 'issued', acknowledged_on = NULL, acknowledged_ref = NULL,
        updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
      WHERE id = ${r.po_id} RETURNING project_id, number`;
    await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
      VALUES (${o!.project_id}, 'order_issued', ${tx.json({ number: o!.number, revision: r.revision })},
        ${claims.sub})`;
  }

  private async decided(
    tx: TransactionSql,
    revisionId: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ) {
    if (outcome === 'approved') await this.putInForce(tx, revisionId, claims);
    else
      await tx`UPDATE proc.po_revision SET status = ${outcome === 'rejected' ? 'rejected' : 'draft'},
        status_reason = ${outcome === 'rejected' ? comment : null}, row_version = row_version + 1
        WHERE id = ${revisionId}`;
  }

  // --- after issue ---

  /** An amendment: a copy of the revision in force, to change and submit with a reason. */
  async amend(claims: TenantClaims, orderId: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    await this.mayOrder(db, claims, o.project_id);
    await db.begin(async (tx) => {
      const cur = await this.order(tx, orderId, true);
      if (cur.status !== 'issued' && cur.status !== 'acknowledged')
        throw new ConflictException({
          code: 'not_amendable',
          message: 'Only an issued order is amended; a draft is simply changed.',
        });
      const [open] = await tx`SELECT 1 FROM proc.po_revision WHERE po_id = ${orderId}
        AND status IN ('draft', 'submitted', 'rejected')`;
      if (open)
        throw new ConflictException({
          code: 'revision_open',
          message: 'An amendment is already being worked on.',
        });
      const [f] = await tx<{ id: string; revision: number }[]>`
        SELECT id, revision FROM proc.po_revision WHERE po_id = ${orderId} AND status = 'approved'`;
      const [n] = await tx<{ next: number }[]>`
        SELECT max(revision) + 1 AS next FROM proc.po_revision WHERE po_id = ${orderId}`;
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO proc.po_revision (po_id, revision, reason, site_id, deliver_by, payment_terms, delivery_terms,
          other_terms, supply, subtotal, cgst, sgst, igst, total, created_by, updated_by)
        SELECT po_id, ${n!.next}, ${reason}, site_id, deliver_by, payment_terms, delivery_terms, other_terms, supply,
          subtotal, cgst, sgst, igst, total, ${claims.sub}, ${claims.sub}
        FROM proc.po_revision WHERE id = ${f!.id}
        RETURNING id`;
      await tx`
        INSERT INTO proc.po_line (revision_id, position, resource_id, rfq_line_id, description, hsn, unit, qty, rate,
          gst_pct, amount, cgst, sgst, igst)
        SELECT ${r!.id}, position, resource_id, rfq_line_id, description, hsn, unit, qty, rate, gst_pct, amount,
          cgst, sgst, igst
        FROM proc.po_line WHERE revision_id = ${f!.id}`;
      await audit(tx, claims.sub, 'order.amend', 'purchase_order', orderId, {
        revision: n!.next,
        reason,
      });
    });
    return this.get(claims, orderId);
  }

  /** Throws away an amendment (or a draft order's revision 0: the order is then cancelled, its number kept). */
  async discard(claims: TenantClaims, revisionId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.revisionRow(db, revisionId);
    const o = await this.order(db, r.po_id);
    await this.mayOrder(db, claims, o.project_id);
    if (!EDITABLE.includes(r.status) || r.revision === 0)
      throw new ConflictException({
        code: 'not_discardable',
        message:
          r.revision === 0
            ? 'Cancel the order instead: its number stays on the record.'
            : 'Withdraw it from approval first.',
      });
    await db.begin(async (tx) => {
      await tx`UPDATE proc.po_revision SET status = 'discarded', row_version = row_version + 1 WHERE id = ${revisionId}`;
      await audit(tx, claims.sub, 'order.discard_amendment', 'po_revision', revisionId, {});
    });
    return this.get(claims, o.id);
  }

  /** The supplier accepted the order (by letter, email or signed copy), recorded with their reference. */
  async acknowledge(
    claims: TenantClaims,
    orderId: string,
    input: { on: string; reference: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    await this.mayOrder(db, claims, o.project_id);
    if (input.on > indiaToday())
      throw new BadRequestException({ code: 'in_future', message: 'Not a date in the future.' });
    await db.begin(async (tx) => {
      const [u] =
        await tx`UPDATE proc.purchase_order SET status = 'acknowledged', acknowledged_on = ${input.on},
          acknowledged_ref = ${input.reference || null}, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1
        WHERE id = ${orderId} AND status = 'issued' RETURNING id`;
      if (!u)
        throw new ConflictException({
          code: 'not_issued',
          message: 'Only an issued order is acknowledged.',
        });
      await audit(tx, claims.sub, 'order.acknowledge', 'purchase_order', orderId, input);
    });
    return this.get(claims, orderId);
  }

  /** Cancelled (with a reason), whatever stage; a revision waiting for approval is withdrawn. */
  async cancel(claims: TenantClaims, orderId: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    await this.mayOrder(db, claims, o.project_id);
    await db.begin(async (tx) => {
      const cur = await this.order(tx, orderId, true);
      if (cur.status === 'cancelled' || cur.status === 'closed')
        throw new ConflictException({
          code: `already_${cur.status}`,
          message: `It is already ${cur.status}.`,
        });
      const open = await tx<{ id: string }[]>`
        SELECT id FROM proc.po_revision WHERE po_id = ${orderId} AND status IN ('draft', 'submitted', 'rejected')`;
      for (const r of open) await this.approvals.withdrawFor(tx, claims, PURCHASE_ORDER, r.id);
      await tx`UPDATE proc.po_revision SET status = 'discarded', row_version = row_version + 1
        WHERE po_id = ${orderId} AND status IN ('draft', 'submitted', 'rejected')`;
      await tx`UPDATE proc.purchase_order SET status = 'cancelled', status_reason = ${reason}, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${orderId}`;
      await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
        VALUES (${cur.project_id}, 'order_cancelled', ${tx.json({ number: cur.number, reason })}, ${claims.sub})`;
      await audit(tx, claims.sub, 'order.cancel', 'purchase_order', orderId, { reason });
    });
    return this.get(claims, orderId);
  }

  /** Done with: nothing more is expected under it. (Goods receipt, step 5, will close orders received in full.) */
  async close(claims: TenantClaims, orderId: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    await this.mayOrder(db, claims, o.project_id);
    await db.begin(async (tx) => {
      const [open] = await tx`SELECT 1 FROM proc.po_revision WHERE po_id = ${orderId}
        AND status IN ('draft', 'submitted', 'rejected')`;
      if (open)
        throw new ConflictException({
          code: 'revision_open',
          message: 'An amendment is being worked on: finish or discard it first.',
        });
      const [u] =
        await tx`UPDATE proc.purchase_order SET status = 'closed', status_reason = ${reason},
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${orderId} AND status IN ('issued', 'acknowledged') RETURNING id`;
      if (!u)
        throw new ConflictException({
          code: 'not_issued',
          message: 'Only an issued order is closed.',
        });
      await audit(tx, claims.sub, 'order.close', 'purchase_order', orderId, { reason });
    });
    return this.get(claims, orderId);
  }

  // --- reading ---

  private async revisionDetail(db: Db, revisionId: string) {
    const [h] = await db<
      {
        id: string;
        revision: number;
        status: RevisionStatus;
        statusReason: string | null;
        reason: string;
        site: { id: string; name: string; stateCode: string | null; address: string | null } | null;
        deliverBy: string | null;
        paymentTerms: string;
        deliveryTerms: string;
        otherTerms: string;
        supply: Supply | null;
        subtotal: string;
        cgst: string;
        sgst: string;
        igst: string;
        total: string;
        approvedAt: string | null;
        rowVersion: number;
      }[]
    >`
      SELECT v.id, v.revision, v.status, v.status_reason AS "statusReason", v.reason,
        CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name,
          'stateCode', s.state_code, 'address', s.address) END AS site,
        to_char(v.deliver_by, 'YYYY-MM-DD') AS "deliverBy", v.payment_terms AS "paymentTerms",
        v.delivery_terms AS "deliveryTerms", v.other_terms AS "otherTerms", v.supply,
        v.subtotal::text AS subtotal, v.cgst::text AS cgst, v.sgst::text AS sgst, v.igst::text AS igst,
        v.total::text AS total, v.approved_at AS "approvedAt", v.row_version AS "rowVersion"
      FROM proc.po_revision v LEFT JOIN proj.site s ON s.id = v.site_id WHERE v.id = ${revisionId}`;
    const lines = await db`
      SELECT l.position, l.resource_id AS "resourceId", r.code AS "resourceCode", l.rfq_line_id AS "rfqLineId",
        l.description, l.hsn, l.unit, l.qty::text AS qty, l.rate::text AS rate, l.gst_pct::text AS "gstPct",
        l.amount::text AS amount, l.cgst::text AS cgst, l.sgst::text AS sgst, l.igst::text AS igst
      FROM proc.po_line l LEFT JOIN est.resource r ON r.id = l.resource_id
      WHERE l.revision_id = ${revisionId} ORDER BY l.position`;
    return { ...h!, lines };
  }

  private async head(db: Db, orderId: string) {
    const [h] = await db<
      {
        id: string;
        kind: OrderKind;
        number: string;
        status: OrderStatus;
        statusReason: string | null;
        acknowledgedOn: string | null;
        acknowledgedRef: string | null;
        project: { id: string; number: string; name: string };
        vendor: {
          id: string;
          name: string;
          gstin: string | null;
          address: string | null;
          email: string | null;
          phone: string | null;
        };
        buyer: { name: string; gstin: string | null };
        rfq: { id: string; number: string } | null;
        createdBy: string | null;
        createdAt: string;
        rowVersion: number;
      }[]
    >`
      SELECT o.id, o.kind, o.number, o.status, o.status_reason AS "statusReason",
        to_char(o.acknowledged_on, 'YYYY-MM-DD') AS "acknowledgedOn", o.acknowledged_ref AS "acknowledgedRef",
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', v.id, 'name', v.name, 'gstin', v.gstin, 'address', v.address, 'email', v.email,
          'phone', v.phone) AS vendor,
        json_build_object('name', e.name, 'gstin', e.gstin) AS buyer,
        CASE WHEN q.id IS NULL THEN NULL ELSE json_build_object('id', q.id, 'number', q.number) END AS rfq,
        u.display_name AS "createdBy", o.created_at AS "createdAt", o.row_version AS "rowVersion"
      FROM proc.purchase_order o
      JOIN proj.project p ON p.id = o.project_id
      JOIN platform.entity e ON e.id = p.entity_id
      JOIN platform.party v ON v.id = o.party_id
      LEFT JOIN tender.rfq q ON q.id = o.rfq_id
      LEFT JOIN platform."user" u ON u.id = o.created_by
      WHERE o.id = ${orderId}`;
    if (!h) throw new NotFoundException({ code: 'order_not_found' });
    return h;
  }

  /** What an approver sees of a revision: the order and the revision, against the one in force. */
  private async revisionSummary(db: Db, revisionId: string) {
    const r = await this.revisionRow(db, revisionId);
    const [inForce] = await db<{ id: string }[]>`
      SELECT id FROM proc.po_revision WHERE po_id = ${r.po_id} AND status = 'approved' AND id <> ${revisionId}`;
    return {
      order: await this.head(db, r.po_id),
      revision: await this.revisionDetail(db, revisionId),
      inForce: inForce ? await this.revisionDetail(db, inForce.id) : null,
    };
  }

  async get(claims: TenantClaims, orderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    const a = await this.projects.access(db, claims, o.project_id);
    const mayOrder =
      (a.canEdit || a.role === 'member') && (await this.permissions.can(claims, 'purchase.edit'));
    const revisions = await db<
      {
        id: string;
        revision: number;
        status: RevisionStatus;
        reason: string;
        total: string;
        approvedAt: string | null;
      }[]
    >`
      SELECT id, revision, status, reason, total::text AS total, approved_at AS "approvedAt"
      FROM proc.po_revision WHERE po_id = ${orderId} ORDER BY revision DESC`;
    const inForce = revisions.find((r) => r.status === 'approved');
    const open = revisions.find((r) => OPEN.includes(r.status));
    const live = o.status !== 'cancelled' && o.status !== 'closed';
    return {
      ...(await this.head(db, orderId)),
      inForce: inForce ? await this.revisionDetail(db, inForce.id) : null,
      open: open ? await this.revisionDetail(db, open.id) : null,
      revisions,
      approval: open
        ? await this.approvals.latestFor(db, claims, PURCHASE_ORDER, open.id)
        : inForce
          ? await this.approvals.latestFor(db, claims, PURCHASE_ORDER, inForce.id)
          : null,
      mayEdit: mayOrder && live && !!open && EDITABLE.includes(open.status),
      mayAmend: mayOrder && (o.status === 'issued' || o.status === 'acknowledged') && !open,
      mayAcknowledge: mayOrder && o.status === 'issued',
      mayCancel: mayOrder && live,
      mayClose: mayOrder && (o.status === 'issued' || o.status === 'acknowledged') && !open,
    };
  }

  /** The order a revision belongs to (for an approval's link). */
  async orderOfRevision(claims: TenantClaims, revisionId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.revisionRow(db, revisionId);
    return this.get(claims, r.po_id);
  }

  async list(
    claims: TenantClaims,
    q: { projectId?: string | undefined; status?: string | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (q.projectId) await this.projects.access(db, claims, q.projectId);
    const all = claims.role === 'admin' || (await this.permissions.can(claims, 'projects.all'));
    return db`
      SELECT o.id, o.kind, o.number, o.status, v.name AS vendor,
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        coalesce(f.total, w.total)::text AS total, to_char(coalesce(f.deliver_by, w.deliver_by), 'YYYY-MM-DD')
          AS "deliverBy",
        w.status AS "openStatus", w.revision AS "openRevision", o.created_at AS "createdAt"
      FROM proc.purchase_order o
      JOIN proj.project p ON p.id = o.project_id
      JOIN platform.party v ON v.id = o.party_id
      LEFT JOIN proc.po_revision f ON f.po_id = o.id AND f.status = 'approved'
      LEFT JOIN proc.po_revision w ON w.po_id = o.id AND w.status IN ('draft', 'submitted', 'rejected')
      WHERE ${
        all
          ? db`true`
          : db`EXISTS (SELECT 1 FROM proj.member m WHERE m.project_id = o.project_id AND m.user_id = ${claims.sub})`
      }
        ${q.projectId ? db`AND o.project_id = ${q.projectId}` : db``}
        ${
          q.status === 'open'
            ? db`AND o.status IN ('draft', 'issued', 'acknowledged')`
            : q.status
              ? db`AND o.status = ${q.status}`
              : db``
        }
      ORDER BY o.created_at DESC LIMIT 500`;
  }
}
