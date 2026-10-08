export type Role = 'admin' | 'manager' | 'worker';
export type LicenceState = 'active' | 'grace' | 'read_only' | 'suspended' | 'revoked';

export interface Entitlement {
  lic: string;
  ten: string;
  tier: string;
  seats: number;
  state: LicenceState;
  ends: string;
  exp: number;
}

export interface ActivationResult {
  token: string;
  entitlement: Entitlement;
  featuresUnlocked: boolean;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export type LoginResult =
  | {
      status: 'ok';
      accessToken: string;
      refreshToken?: string;
      user: SessionUser;
      mustChangePassword: boolean;
      licence: { state: LicenceState; featuresUnlocked: boolean };
    }
  | { status: 'mfa_required' }
  | { status: 'mfa_enrollment_required'; enrollmentToken: string };

export interface Me extends SessionUser {
  mustChangePassword: boolean;
  licence: { state: LicenceState; featuresUnlocked: boolean };
}

export interface InboxItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  dueAt: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Inbox {
  items: InboxItem[];
  upcoming: InboxItem[];
  unread: number;
  pending: { passwordResets: number };
}

export interface OwnerNotice {
  id: string;
  kind: string;
  title: string;
  body: string;
  created_at: string;
}

export interface TenantUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'deactivated';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ResetRequest {
  id: string;
  requestedAt: string;
  deviceLabel: string | null;
  userId: string;
  username: string;
  displayName: string;
}

// --- Tenders (docs/wave1-plan.md step 1) ---

export const TENDER_STATUSES = [
  'lead',
  'evaluating',
  'bidding',
  'submitted',
  'won',
  'lost',
  'no_bid',
  'withdrawn',
  'cancelled',
] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

export interface Party {
  id: string;
  name: string;
  isClient: boolean;
  isVendor: boolean;
  isSubcontractor: boolean;
  gstin: string | null;
  pan: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string;
  rowVersion: number;
}

export interface Person {
  id: string;
  displayName: string;
  role: Role;
}

export interface TenderSummary {
  id: string;
  number: string;
  title: string;
  status: TenderStatus;
  clientRef: string | null;
  vertical: string;
  location: string | null;
  estimatedValue: string | null;
  submissionDueAt: string | null;
  updatedAt: string;
  client: { id: string; name: string } | null;
  owner: { id: string; displayName: string } | null;
  latestScore: string | null;
}

export interface Criterion {
  key: string;
  label: string;
  weight: number;
  score: number;
}

export interface TenderDetail extends TenderSummary {
  source: string;
  portalUrl: string | null;
  emdAmount: string | null;
  tenderFee: string | null;
  publishedOn: string | null;
  prebidAt: string | null;
  openingAt: string | null;
  bidValidityDays: number | null;
  statusReason: string | null;
  description: string;
  createdAt: string;
  rowVersion: number;
  allowedMoves: TenderStatus[];
  canDecide: boolean;
  defaultCriteria: Omit<Criterion, 'score'>[];
  decisions: {
    id: string;
    criteria: Criterion[];
    score: string;
    decision: 'bid' | 'no_bid';
    reason: string;
    decidedAt: string;
    decidedBy: string;
  }[];
  events: {
    id: string;
    kind: string;
    data: Record<string, unknown>;
    createdAt: string;
    actor: string | null;
  }[];
}
