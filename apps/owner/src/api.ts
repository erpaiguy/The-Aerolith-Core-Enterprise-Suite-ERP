// HTTP client for the owner console. The access token lives in memory only; the refresh token is an HttpOnly cookie
// scoped to /api/owner/auth that this page cannot read. On a 401 the client refreshes once (concurrent requests share
// that refresh) and retries.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : (code ?? `HTTP ${status}`));
  }
}

export interface Session {
  accessToken: string;
  mustChangePassword: boolean;
}

type Fetch = typeof fetch;

export class OwnerApi {
  private accessToken: string | null = null;
  private refreshing: Promise<Session | null> | null = null;
  /** Called when the session can no longer be refreshed (signed out, revoked, idle timeout). */
  onSessionLost: () => void = () => {};

  constructor(private readonly fetchImpl: Fetch = (...args) => fetch(...args)) {}

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const auth = init.auth ?? true;
    const res = await this.send(path, init, auth);
    if (res.status === 401 && auth) {
      const refreshed = await this.refresh();
      if (!refreshed) {
        this.onSessionLost();
        throw await toError(res);
      }
      return parse<T>(await this.send(path, init, auth));
    }
    return parse<T>(res);
  }

  /** Single-flight: concurrent callers wait on the same refresh. Returns null when the session is gone. */
  refresh(): Promise<Session | null> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<Session | null> {
    const res = await this.send('/api/owner/auth/refresh', { method: 'POST', body: {} }, false);
    if (!res.ok) {
      this.accessToken = null;
      return null;
    }
    const result = (await res.json()) as Session;
    this.accessToken = result.accessToken;
    return result;
  }

  private async send(
    path: string,
    init: { method?: string; body?: unknown },
    auth: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'x-aerolith-client': 'browser' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    try {
      return await this.fetchImpl(path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'network_error', {});
    }
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function toError(res: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty or non-JSON body
  }
  return new ApiError(res.status, typeof body.code === 'string' ? body.code : undefined, body);
}

export const api = new OwnerApi();

// --- Response shapes (apps/api/src/owner) ---

export type LicenceState = 'active' | 'grace' | 'read_only' | 'suspended' | 'revoked';
export type OperatorRole = 'owner' | 'support' | 'read_only';

export interface Operator {
  id: string;
  email: string;
  displayName: string;
  role: OperatorRole;
  mfaEnabled: boolean;
  recoveryCodesLeft: number;
}

export interface TenantSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  ownerEmail: string;
  licence: {
    id: string;
    kind: string;
    tierId: string;
    state: LicenceState;
    endsAt: string;
    seatCap: number;
    keyLast4: string;
    activeDevices: number;
  } | null;
  database: { status: string; provider: string; schemaVersion: string | null } | null;
}

export interface TenantDetail extends TenantSummary {
  licences: {
    id: string;
    kind: string;
    tierId: string;
    status: string;
    keyLast4: string;
    startsAt: string;
    endsAt: string;
  }[];
}

export interface LicenceDetail {
  id: string;
  kind: string;
  state: LicenceState;
  seat_cap: number;
  portal_cap: number;
  max_devices: number;
  starts_at: string;
  ends_at: string;
  grace_days: number;
  devices: {
    id: string;
    platform: string;
    label: string | null;
    first_seen_at: string;
    last_seen_at: string;
    revoked_at: string | null;
  }[];
  events: { kind: string; actor: string; data: Record<string, unknown>; created_at: string }[];
}

export interface DatabaseStatus {
  status: string;
  provider: string;
  schemaVersion: string | null;
  lastError: string | null;
  attempts?: number;
}

export interface Overview {
  tenants: number;
  licenceStates: Record<string, number>;
  databases: Record<string, number>;
  trialsEndingSoon: { id: string; name: string; endsAt: string }[];
  email: { failedLast7Days: number; queued: number; sentLastDay: number };
}

export interface EmailRow {
  id: string;
  to: string;
  template: string;
  subject: string | null;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface Suppression {
  email: string;
  reason: string;
  detail: string;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  action: string;
  target: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface MigrationRun {
  id: string;
  targetVersion: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  results: Record<string, number>;
}
