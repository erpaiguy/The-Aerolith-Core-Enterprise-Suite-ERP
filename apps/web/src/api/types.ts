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
