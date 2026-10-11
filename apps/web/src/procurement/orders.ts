// Purchase and work orders as the screens see them (docs/wave2b-plan.md step 4). Rates are before GST; GST is added
// on top: CGST + SGST within the site's state, IGST across states, none from a supplier without a GSTIN.
import type { Approval } from '../approvals/model';

export type OrderKind = 'purchase' | 'work';
export type OrderStatus = 'draft' | 'issued' | 'acknowledged' | 'closed' | 'cancelled';
export type OrderRevisionStatus =
  'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded' | 'discarded';
export type Supply = 'intra' | 'inter' | 'unregistered';

type Tone = 'neutral' | 'warning' | 'success' | 'danger' | 'accent';

export const ORDER_KIND: Record<OrderKind, string> = {
  purchase: 'Purchase order',
  work: 'Work order',
};
export const ORDER_STATUS: Record<OrderStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  acknowledged: 'Acknowledged',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
export const ORDER_TONE: Record<OrderStatus, Tone> = {
  draft: 'neutral',
  issued: 'accent',
  acknowledged: 'success',
  closed: 'neutral',
  cancelled: 'danger',
};
export const REVISION_STATUS: Record<OrderRevisionStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  approved: 'In force',
  rejected: 'Rejected',
  superseded: 'Superseded',
  discarded: 'Discarded',
};
export const REVISION_TONE: Record<OrderRevisionStatus, Tone> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'success',
  rejected: 'danger',
  superseded: 'neutral',
  discarded: 'neutral',
};
export const SUPPLY: Record<Supply, string> = {
  intra: 'Within the state: CGST + SGST',
  inter: 'Across states: IGST',
  unregistered: 'Supplier without a GSTIN: no GST',
};

export interface OrderLine {
  position: number;
  resourceId: string | null;
  resourceCode: string | null;
  rfqLineId: string | null;
  description: string;
  hsn: string | null;
  unit: string;
  qty: string;
  rate: string;
  gstPct: string;
  amount: string;
  cgst: string;
  sgst: string;
  igst: string;
}

export interface OrderRevision {
  id: string;
  revision: number;
  status: OrderRevisionStatus;
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
  lines: OrderLine[];
}

export interface OrderHead {
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
}

export interface Order extends OrderHead {
  inForce: OrderRevision | null;
  open: OrderRevision | null;
  revisions: {
    id: string;
    revision: number;
    status: OrderRevisionStatus;
    reason: string;
    total: string;
    approvedAt: string | null;
  }[];
  approval: Approval | null;
  mayEdit: boolean;
  mayAmend: boolean;
  mayAcknowledge: boolean;
  mayCancel: boolean;
  mayClose: boolean;
}

export interface OrderRow {
  id: string;
  kind: OrderKind;
  number: string;
  status: OrderStatus;
  vendor: string;
  project: { id: string; number: string; name: string };
  total: string | null;
  deliverBy: string | null;
  openStatus: OrderRevisionStatus | null;
  openRevision: number | null;
  createdAt: string;
}

/** What an approver sees: the order, the revision put up, and the one in force it would replace. */
export interface OrderApprovalDoc {
  order: OrderHead;
  revision: OrderRevision;
  inForce: OrderRevision | null;
}

/** A line's amount and GST as typed, rounded to the paisa as the server does (half a rate each side within a state). */
export function draftTax(qty: string, rate: string, gstPct: string, supply: Supply | null) {
  const q = Number(qty);
  const r = Number(rate);
  const g = supply === 'unregistered' ? 0 : Number(gstPct);
  if (!qty || !rate || !Number.isFinite(q) || !Number.isFinite(r) || !Number.isFinite(g))
    return null;
  const amount = Math.round(q * r * 100) / 100;
  const tax = (pct: number) => Math.round(amount * pct + 1e-9) / 100;
  return {
    amount,
    cgst: supply === 'intra' ? tax(g / 2) : 0,
    sgst: supply === 'intra' ? tax(g / 2) : 0,
    igst: supply === 'inter' ? tax(g) : 0,
  };
}

/** Within the state, across states, or a supplier without a GSTIN. Null: no place of supply yet. */
export function supplyOf(gstin: string | null, siteState: string | null): Supply | null {
  if (!gstin) return 'unregistered';
  if (!siteState) return null;
  return gstin.slice(0, 2) === siteState ? 'intra' : 'inter';
}
