// The approval engine as the screens see it (docs/wave2b-plan.md step 1).
import { useState } from 'react';
import { describeError } from '../lib/format';

export type Approver = 'project_lead' | 'manager' | 'admin' | 'user';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ApprovalStep {
  level: number;
  approver: Approver;
  approverName: string;
  label: string;
  minAmount: string;
  status: 'waiting' | 'pending' | 'approved' | 'rejected';
  toAdmins: boolean;
  actedBy: string | null;
  onBehalfOf: string | null;
  actedAt: string | null;
  comment: string | null;
}

export interface ApprovalEvent {
  id: string;
  kind:
    | 'submitted'
    | 'approved'
    | 'rejected'
    | 'withdrawn'
    | 'commented'
    | 'to_admins'
    | 'no_approval_needed';
  level: number | null;
  actor: string | null;
  onBehalfOf: string | null;
  comment: string | null;
  at: string;
}

export interface Approval {
  id: string;
  docType: string;
  docLabel: string;
  docId: string;
  link: string;
  title: string;
  amount: string;
  status: ApprovalStatus;
  level: number | null;
  submittedBy: string;
  submittedAt: string;
  decidedAt: string | null;
  project: { id: string; number: string; name: string } | null;
  steps: ApprovalStep[];
  events: ApprovalEvent[];
  mayAct: boolean;
  actingFor: string | null;
  mayWithdraw: boolean;
}

export interface ApprovalRow {
  id: string;
  docType: string;
  docLabel: string;
  docId: string;
  link: string | null;
  title: string;
  amount: string;
  status: ApprovalStatus;
  level: number | null;
  levels: number;
  submittedBy: string;
  submittedAt: string;
  decidedAt: string | null;
  project: { id: string; number: string; name: string } | null;
}

export const APPROVAL_STATUS: Record<ApprovalStatus, string> = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};
export const APPROVAL_TONE: Record<ApprovalStatus, 'neutral' | 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
};

export const EVENT_TEXT: Record<ApprovalEvent['kind'], string> = {
  submitted: 'submitted it',
  approved: 'approved',
  rejected: 'rejected',
  withdrawn: 'withdrew it',
  commented: 'commented',
  to_admins: 'No one else could approve this level, so it went to the admins',
  no_approval_needed: 'No approval rule applies to this amount: approved',
};

/** A button's work: busy while it runs, the error if it fails, then `onDone`. */
export function useRun(onDone: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onDone();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, error };
}
