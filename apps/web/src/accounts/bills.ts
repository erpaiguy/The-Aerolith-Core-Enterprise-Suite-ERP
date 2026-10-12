// Client RA bills on screen (docs/wave3-plan.md step 2): the API's shapes and the bill's labels.

export interface EscalationTerms {
  factor: string;
  components: { key: string; name: string; sharePct: string; baseIndex: string }[];
}
export interface BillTerms {
  gstPct: string;
  retentionPct: string;
  retentionCap: string | null;
  advanceAmount: string;
  advanceRecoveryPct: string;
  escalation: EscalationTerms | null;
  rowVersion?: number | null;
}
export interface Figures {
  lines: { lineKey: string; thisQty: string; amount: string }[];
  gross: string;
  escalation: { key: string; name: string; amount: string }[];
  escalationTotal: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  invoiceTotal: string;
  retention: string;
  advanceRecovery: string;
  advanceLeftAfter: string;
  otherDeductions: string;
  net: string;
}
export type BillStatus = 'draft' | 'pending' | 'submitted' | 'certified' | 'cancelled';
export const BILL_STATUS: Record<BillStatus, string> = {
  draft: 'Draft',
  pending: 'Waiting for approval',
  submitted: 'With the client',
  certified: 'Certified',
  cancelled: 'Cancelled',
};
export const BILL_TONE = {
  draft: 'neutral',
  pending: 'warning',
  submitted: 'accent',
  certified: 'success',
  cancelled: 'danger',
} as const;

export interface ProjectBills {
  client: string | null;
  company: string;
  gstin: string | null;
  terms: BillTerms;
  bills: {
    id: string;
    raNo: number;
    upto: string;
    status: BillStatus;
    statusReason: string | null;
    invoiceNo: string | null;
    certifiedOn: string | null;
    gross: string | null;
    invoiceTotal: string | null;
    net: string | null;
    site: string;
  }[];
  mayBill: boolean;
}

export interface ClientBill {
  id: string;
  raNo: number;
  upto: string;
  status: BillStatus;
  statusReason: string | null;
  terms: BillTerms;
  indices: Record<string, string>;
  intra: boolean;
  submitted: Figures | null;
  certified: Figures | null;
  figures: Figures | null;
  clientRef: string;
  certifiedOn: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  voucherId: string | null;
  rowVersion: number;
  project: { id: string; number: string; name: string };
  site: { id: string; name: string; stateCode: string | null; address: string | null };
  company: { id: string; name: string; legalName: string; gstin: string | null; address: string };
  client: { id: string; name: string; gstin: string | null; address: string | null } | null;
  lines: {
    lineKey: string;
    position: number;
    code: string | null;
    description: string;
    unit: string | null;
    rate: string;
    contractQty: string | null;
    prevQty: string;
    measuredQty: string;
    cumQty: string;
    certQty: string | null;
  }[];
  deductions: {
    position: number;
    description: string;
    amount: string;
    account: { id: string; code: string; name: string };
  }[];
  receipts: { id: string; receivedOn: string; amount: string; voucher: string }[];
  approval: { id: string; status: string } | null;
  mayEdit: boolean;
  maySubmit: boolean;
  mayCertify: boolean;
  mayCancel: boolean;
}
