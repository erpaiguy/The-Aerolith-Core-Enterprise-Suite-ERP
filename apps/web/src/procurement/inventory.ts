// Stores and stock as the screens see them (docs/wave2b-plan.md step 6).
import type { Approval } from '../approvals/model';

export type MoveKind =
  | 'receipt'
  | 'receipt_cancelled'
  | 'issue'
  | 'issue_return'
  | 'transfer_out'
  | 'transfer_in'
  | 'transfer_back'
  | 'adjustment';

export const MOVE_KIND: Record<MoveKind, string> = {
  receipt: 'Received',
  receipt_cancelled: 'Receipt cancelled',
  issue: 'Issued',
  issue_return: 'Back from site',
  transfer_out: 'Sent',
  transfer_in: 'Transferred in',
  transfer_back: 'Transfer cancelled',
  adjustment: 'Stock take',
};

export interface StoreRow {
  id: string;
  name: string;
  active: boolean;
  project: { id: string; number: string; name: string };
  site: { id: string; name: string };
  value: string;
  items: number;
  below: number;
}

export interface StockLine {
  resourceId: string;
  code: string;
  name: string;
  unit: string;
  qty: string;
  value: string;
  rate: string | null;
  reorderLevel: string | null;
  below: boolean;
}

export interface Move {
  id: string;
  movedOn: string;
  kind: MoveKind;
  code?: string;
  name?: string;
  unit?: string;
  qty: string;
  value: string;
  docType: 'goods_receipt' | 'stock_issue' | 'stock_transfer' | 'stock_count';
  docId: string;
  docNumber: string;
  wbsCode?: string | null;
  by?: string | null;
  balanceQty?: string;
  balanceValue?: string;
}

export interface Store {
  id: string;
  name: string;
  active: boolean;
  project: { id: string; number: string; name: string };
  site: { id: string; name: string };
  valuation: 'average' | 'fifo';
  stock: StockLine[];
  moves: Move[];
  transfers: {
    id: string;
    number: string;
    status: string;
    sentOn: string;
    incoming: boolean;
    fromStore: string;
    toStore: string;
  }[];
  openCount: { id: string; number: string; status: string } | null;
  mayIssue: boolean;
  mayManage: boolean;
}

export interface Issue {
  id: string;
  number: string;
  issuedOn: string;
  issuedTo: string;
  purpose: string;
  store: { id: string; name: string };
  project: { id: string; number: string; name: string };
  wbs: { code: string; name: string };
  issuedBy: string | null;
  lines: {
    position: number;
    resourceId: string;
    code: string;
    name: string;
    unit: string;
    qty: string;
    value: string;
    boqCode: string | null;
    returned: string;
  }[];
  mayReturn: boolean;
}

export interface Transfer {
  id: string;
  number: string;
  status: 'in_transit' | 'received' | 'cancelled';
  sentOn: string;
  receivedOn: string | null;
  note: string;
  vehicleNo: string | null;
  transporter: string | null;
  ewayBillNo: string | null;
  fromStore: { id: string; name: string; project: string };
  toStore: { id: string; name: string; project: string };
  sentBy: string | null;
  receivedBy: string | null;
  lines: {
    position: number;
    code: string;
    name: string;
    unit: string;
    qty: string;
    value: string;
    /** What arrived and what was lost on the road (step 8e.3). */
    receivedQty: string | null;
    lostQty: string;
    lostValue: string;
    lossReason: string | null;
  }[];
  mayReceive: boolean;
  mayCancel: boolean;
}

export type CountStatus = 'draft' | 'submitted' | 'posted' | 'rejected' | 'discarded';
export const COUNT_STATUS: Record<CountStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  posted: 'Posted',
  rejected: 'Rejected',
  discarded: 'Discarded',
};

export interface StockCount {
  id: string;
  number: string;
  status: CountStatus;
  statusReason: string | null;
  countedOn: string;
  notes: string;
  rowVersion: number;
  store: { id: string; name: string };
  project: { id: string; number: string; name: string };
  lines: {
    resourceId: string;
    code: string;
    name: string;
    unit: string;
    bookQty: string;
    countedQty: string;
    unitCost: string;
    reason: string;
    difference: string;
    value: string;
  }[];
  approval: Approval | null;
  mayEdit: boolean;
}

export const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const trimZeros = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);
