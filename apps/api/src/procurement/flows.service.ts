// Where a purchase stands (docs/wave9-plan.md step 9a.7): from any of its documents — a requisition, an order, a goods
// receipt or a supplier's bill — the chain requisition → order → receipt → bill → payment, each stage done, the one
// it waits on, not yet, or not applicable, with the documents at each stage that the person may open.
//
// Read only. The document asked about is checked as its own screen checks it (the project's team for requisitions,
// orders and receipts; the accounts permission for bills). Of the others, those the person may not see are counted,
// not listed.
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { orderProgress } from './receipt-progress.js';

export type PurchaseFlowKind = 'requisition' | 'order' | 'receipt' | 'bill';
export type StepKey = 'requisition' | 'order' | 'receipt' | 'bill' | 'payment';
export type StepState = 'done' | 'current' | 'todo' | 'na';

export interface FlowDoc {
  id: string;
  number: string;
  href: string;
  /** This stage's work is done for this document (approved, issued, posted, paid). */
  done: boolean;
  /** The document the strip is shown on. */
  here: boolean;
}
export interface FlowStep {
  key: StepKey;
  label: string;
  state: StepState;
  /** The stage of the document the strip is shown on. */
  here: boolean;
  docs: FlowDoc[];
  /** Documents at this stage the person may not open. */
  hidden: number;
}

const LABEL: Record<StepKey, string> = {
  requisition: 'Requisition',
  order: 'Order',
  receipt: 'Goods receipt',
  bill: 'Supplier bill',
  payment: 'Payment',
};

interface Raw {
  id: string;
  number: string;
  done: boolean;
  project_id: string | null;
}

/**
 * Each stage's state from whether it applies and whether it is complete: complete ones are done, the first applicable
 * one not complete is where the purchase stands, the rest are not yet.
 */
export function stepStates(steps: { applies: boolean; complete: boolean }[]): StepState[] {
  let current = false;
  return steps.map((s) => {
    if (!s.applies) return 'na';
    if (s.complete) return 'done';
    if (current) return 'todo';
    current = true;
    return 'current';
  });
}

@Injectable()
export class FlowService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
  ) {}

  async purchase(claims: TenantClaims, kind: PurchaseFlowKind, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const seen = new Map<string, boolean>();
    const mayProject = async (projectId: string | null) => {
      if (!projectId) return false;
      if (!seen.has(projectId))
        seen.set(
          projectId,
          await this.projects.access(db, claims, projectId).then(
            () => true,
            () => false,
          ),
        );
      return seen.get(projectId)!;
    };
    const mayAccounts = await this.permissions.can(claims, 'accounts.view');
    const notFound = () => new NotFoundException({ code: 'not_found' });

    // The document asked about, checked as its own screen does, and the orders it belongs to.
    let orderIds: string[];
    let requisitions: Raw[] | null = null;
    let anchorBill: string | null = null;
    if (kind === 'requisition') {
      const [r] = await db<Raw[]>`
        SELECT id, number, status = 'approved' AS done, project_id FROM proc.requisition WHERE id = ${id}`;
      if (!r) throw notFound();
      await this.projects.access(db, claims, r.project_id!);
      requisitions = [r];
      orderIds = (
        await db<{ id: string }[]>`
          SELECT po_id AS id FROM proc.po_requisition_line WHERE requisition_id = ${id}
          UNION
          SELECT v.po_id FROM proc.rfq_requisition_line x
          JOIN proc.po_line l ON l.rfq_line_id = x.rfq_line_id
          JOIN proc.po_revision v ON v.id = l.revision_id
          WHERE x.requisition_id = ${id} AND v.status <> 'discarded'`
      ).map((o) => o.id);
    } else if (kind === 'order') {
      const [o] = await db<{ project_id: string }[]>`
        SELECT project_id FROM proc.purchase_order WHERE id = ${id}`;
      if (!o) throw notFound();
      await this.projects.access(db, claims, o.project_id);
      orderIds = [id];
    } else if (kind === 'receipt') {
      const [g] = await db<{ project_id: string; po_id: string }[]>`
        SELECT project_id, po_id FROM proc.goods_receipt WHERE id = ${id}`;
      if (!g) throw notFound();
      await this.projects.access(db, claims, g.project_id);
      orderIds = [g.po_id];
    } else {
      if (!mayAccounts)
        throw new ForbiddenException({
          code: 'forbidden',
          message: 'Payables need the accounts permission.',
        });
      const [b] = await db<{ order_id: string | null }[]>`
        SELECT order_id FROM acc.vendor_bill WHERE id = ${id}`;
      if (!b) throw notFound();
      orderIds = b.order_id ? [b.order_id] : [];
      anchorBill = id;
    }

    // The documents at each stage.
    const orders = await db<(Raw & { kind: 'purchase' | 'work'; status: string })[]>`
      SELECT id, number, kind, status, status IN ('issued', 'acknowledged', 'closed') AS done, project_id
      FROM proc.purchase_order WHERE id = ANY(${orderIds}::uuid[]) ORDER BY number`;
    requisitions ??= await db<Raw[]>`
      SELECT q.id, q.number, q.status = 'approved' AS done, q.project_id FROM proc.requisition q
      WHERE q.id IN (
        SELECT requisition_id FROM proc.po_requisition_line WHERE po_id = ANY(${orderIds}::uuid[])
        UNION
        SELECT x.requisition_id FROM proc.po_line l
        JOIN proc.po_revision v ON v.id = l.revision_id
        JOIN proc.rfq_requisition_line x ON x.rfq_line_id = l.rfq_line_id
        WHERE v.po_id = ANY(${orderIds}::uuid[]) AND v.status <> 'discarded')
      ORDER BY q.number`;
    const receipts = await db<Raw[]>`
      SELECT id, number, status = 'posted' AS done, project_id FROM proc.goods_receipt
      WHERE po_id = ANY(${orderIds}::uuid[]) AND (status = 'posted' OR id = ${id})
      ORDER BY received_on, number`;
    const bills = await db<(Raw & { posted: boolean; outstanding: string })[]>`
      SELECT b.id, b.bill_no AS number, b.status = 'posted' AS done, b.status = 'posted' AS posted, b.project_id,
        (b.payable
          - coalesce((SELECT sum(l.amount) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
              WHERE l.bill_id = b.id AND r.status = 'paid'), 0)
          - coalesce((SELECT sum(a.amount) FROM acc.advance_application a WHERE a.bill_id = b.id), 0)
          - coalesce((SELECT sum(d.total) FROM acc.debit_note d WHERE d.bill_id = b.id), 0))::text AS outstanding
      FROM acc.vendor_bill b
      WHERE (b.order_id = ANY(${orderIds}::uuid[]) AND b.status <> 'cancelled') OR b.id = ${anchorBill}
      ORDER BY b.bill_date, b.created_at`;
    const billIds = bills.map((b) => b.id);
    const runs = await db<Raw[]>`
      SELECT DISTINCT r.id, r.number, r.status = 'paid' AS done, NULL::uuid AS project_id
      FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
      WHERE l.bill_id = ANY(${billIds}::uuid[]) AND r.status <> 'cancelled'
      ORDER BY r.number`;

    // Whether each stage applies and is complete.
    const live = orders.filter((o) => o.status !== 'cancelled');
    const purchase = live.filter((o) => o.kind === 'purchase');
    let receivedAll = purchase.length > 0;
    for (const o of purchase) {
      if (o.status === 'closed') continue;
      const lines = await orderProgress(db, o.id);
      if (!lines.length || lines.some((l) => Number(l.outstanding) > 0)) receivedAll = false;
    }
    const posted = bills.filter((b) => b.posted);
    const facts: Record<StepKey, { applies: boolean; complete: boolean }> = {
      requisition: {
        applies: requisitions.length > 0,
        complete: requisitions.some((r) => r.done),
      },
      order: { applies: kind !== 'bill' || orders.length > 0, complete: live.some((o) => o.done) },
      receipt: {
        // Work orders are measured and billed, not received; a bill without an order has nothing to receive.
        applies: orders.length === 0 ? kind !== 'bill' : live.length === 0 || purchase.length > 0,
        complete: receipts.some((g) => g.done) && receivedAll,
      },
      bill: {
        applies: true,
        complete: posted.length > 0 && posted.length === bills.length,
      },
      payment: {
        applies: true,
        complete: posted.length > 0 && posted.every((b) => Number(b.outstanding) <= 0),
      },
    };
    const keys: StepKey[] = ['requisition', 'order', 'receipt', 'bill', 'payment'];
    const states = stepStates(keys.map((k) => facts[k]));
    const docsOf: Record<StepKey, Raw[]> = {
      requisition: requisitions,
      order: orders,
      receipt: receipts,
      bill: bills,
      payment: runs,
    };
    const href: Record<StepKey, (id: string) => string> = {
      requisition: (x) => `/requisitions/${x}`,
      order: (x) => `/orders/${x}`,
      receipt: (x) => `/receipts/${x}`,
      bill: (x) => `/accounts/vendor-bills/${x}`,
      payment: (x) => `/accounts/payment-runs/${x}`,
    };
    const steps: FlowStep[] = [];
    for (const [i, key] of keys.entries()) {
      const docs: FlowDoc[] = [];
      let hidden = 0;
      for (const d of docsOf[key]) {
        const may =
          key === 'bill' || key === 'payment' ? mayAccounts : await mayProject(d.project_id);
        if (!may) {
          hidden++;
          continue;
        }
        docs.push({
          id: d.id,
          number: d.number,
          href: href[key](d.id),
          done: d.done,
          here: key === kind && d.id === id,
        });
      }
      steps.push({ key, label: LABEL[key], state: states[i]!, here: key === kind, docs, hidden });
    }
    return { steps };
  }
}
