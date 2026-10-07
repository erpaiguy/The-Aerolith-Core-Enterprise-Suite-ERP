// HTTP client. The access token lives in memory only. When it expires (401) the client refreshes once — concurrent
// requests share that single refresh — and retries. Browser refresh tokens are an HttpOnly cookie the page cannot
// read; the desktop keeps its refresh token in the OS keychain via the preload bridge.
import { apiBase, clientKind, desktop } from '../platform';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : (code ?? `HTTP ${status}`));
  }
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  mustChangePassword: boolean;
  licence: { state: string; featuresUnlocked: boolean };
}

type Fetch = typeof fetch;

export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<RefreshResult | null> | null = null;
  /** Called when the session can no longer be refreshed (signed out, revoked, expired). */
  onSessionLost: () => void = () => {};

  constructor(private readonly fetchImpl: Fetch = (...args) => fetch(...args)) {}

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  get hasAccessToken(): boolean {
    return this.accessToken !== null;
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
        throw await this.toError(res);
      }
      return this.parse<T>(await this.send(path, init, auth));
    }
    return this.parse<T>(res);
  }

  /** Single-flight: concurrent callers wait on the same refresh. Returns null when the session is gone. */
  refresh(): Promise<RefreshResult | null> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<RefreshResult | null> {
    const bridge = desktop();
    let body: Record<string, string> = {};
    if (bridge) {
      const token = await bridge.getRefreshToken();
      if (!token) return null;
      body = { refreshToken: token };
    }
    const res = await this.send('/api/auth/refresh', { method: 'POST', body }, false);
    if (!res.ok) {
      this.accessToken = null;
      if (bridge && (res.status === 401 || res.status === 403)) await bridge.setRefreshToken(null);
      return null;
    }
    const result = (await res.json()) as RefreshResult;
    this.accessToken = result.accessToken;
    if (bridge && result.refreshToken) await bridge.setRefreshToken(result.refreshToken);
    return result;
  }

  private async send(
    path: string,
    init: { method?: string; body?: unknown },
    auth: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'x-aerolith-client': clientKind() };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    try {
      return await this.fetchImpl(`${apiBase()}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'network_error', {});
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async toError(res: Response): Promise<ApiError> {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // empty or non-JSON body
    }
    return new ApiError(res.status, typeof body.code === 'string' ? body.code : undefined, body);
  }
}

export const api = new ApiClient();
