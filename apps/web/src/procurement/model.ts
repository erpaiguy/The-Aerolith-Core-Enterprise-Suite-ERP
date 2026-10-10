// Purchase requisitions as the screens see them (docs/wave2b-plan.md step 1).
import type { Approval } from '../approvals/model';

export type RequisitionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

export const REQUISITION_STATUS: Record<RequisitionStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
export const REQUISITION_TONE: Record<
  RequisitionStatus,
  'neutral' | 'warning' | 'success' | 'danger' | 'accent'
> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};

export interface RequisitionLine {
  position: number;
  resourceId: string | null;
  resourceCode: string | null;
  description: string;
  unit: string;
  qty: string;
  rate: string | null;
  amount: string | null;
  neededBy: string | null;
  notes: string;
  boqCode: string | null;
  boqDescription: string | null;
  wbsCode: string | null;
  wbsName: string | null;
}

export interface RequisitionHead {
  id: string;
  number: string;
  title: string;
  status: RequisitionStatus;
  statusReason: string | null;
  amount: string;
  neededBy: string | null;
  notes: string;
  site: { id: string; name: string } | null;
  project: { id: string; number: string; name: string };
  createdBy: string | null;
  createdAt: string;
  rowVersion: number;
}

export interface Requisition extends RequisitionHead {
  lines: RequisitionLine[];
  approval: Approval | null;
  mayEdit: boolean;
  maySubmit: boolean;
  mayCancel: boolean;
}

export interface RequisitionRow {
  id: string;
  number: string;
  title: string;
  status: RequisitionStatus;
  amount: string;
  neededBy: string | null;
  createdAt: string;
  createdBy: string | null;
  project: { id: string; number: string; name: string };
  lines: number;
}
