// HTTP client. The access token lives in memory only. When it expires (401) the client refreshes once — concurrent
// requests share that single refresh — and retries. Browser refresh tokens are an HttpOnly cookie the page cannot
// read; the desktop keeps its refresh token in the OS keychain via the preload bridge.
import { showErrorDialog } from '@aerolith/ui';
import { saveStarted, setUnsaved } from '../lib/unsaved';
import { apiBase, clientKind, desktop } from '../platform';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
    /** The server's reference for this request, to quote to support. */
    readonly ref: string | null = null,
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

/**
 * The last requests this app made, for a support request's diagnostics (docs/wave9-plan.md step 9b.2): when, the
 * method, the path without its query, the status and the server's reference. Never bodies, headers or tokens.
 */
export interface RequestRecord {
  at: string;
  method: string;
  path: string;
  status: number;
  ref: string | null;
}
export const RECENT_REQUESTS_MAX = 10;
const recent: RequestRecord[] = [];

export function recordRequest(r: RequestRecord): void {
  recent.push({
    at: r.at,
    method: r.method,
    path: r.path.split(/[?#]/)[0]!,
    status: r.status,
    ref: r.ref,
  });
  if (recent.length > RECENT_REQUESTS_MAX) recent.splice(0, recent.length - RECENT_REQUESTS_MAX);
}

/** Newest last; copies, so the caller cannot change the record. */
export const recentRequests = (): RequestRecord[] => recent.map((r) => ({ ...r }));

export function clearRecentRequests(): void {
  recent.length = 0;
}

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
    init: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string } = {},
  ): Promise<T> {
    return this.parse<T>(await this.authed(path, init));
  }

  /** Sends a file (multipart/form-data) in the field `file`. */
  upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.request<T>(path, { method: 'POST', body: form });
  }

  /** Fetches a file the API streams (exports, reports), with the name the server suggests. */
  async download(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ blob: Blob; fileName: string }> {
    const res = await this.authed(path, init);
    if (!res.ok) throw await this.toError(res);
    return { blob: await res.blob(), fileName: fileNameOf(res) ?? 'download' };
  }

  /** One request; on 401 refreshes the session once and retries. */
  private async authed(
    path: string,
    init: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string },
  ): Promise<Response> {
    const auth = init.auth ?? true;
    const changes = (init.method ?? (init.body === undefined ? 'GET' : 'POST')) !== 'GET';
    if (changes) saveStarted();
    let res = await this.send(path, init, auth);
    if (res.status === 401 && auth) {
      const refreshed = await this.refresh();
      if (!refreshed) {
        this.onSessionLost();
        return res;
      }
      res = await this.send(path, init, auth);
    }
    // Something was saved: what was typed is no longer at risk (step 9a.4).
    if (res.ok && changes) setUnsaved(false);
    return res;
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
    init: { method?: string; body?: unknown; idempotencyKey?: string },
    auth: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'x-aerolith-client': clientKind() };
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
    const form = init.body instanceof FormData;
    // FormData sets its own multipart content type with the boundary.
    if (init.body !== undefined && !form) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const at = new Date().toISOString();
    try {
      const res = await this.fetchImpl(`${apiBase()}${path}`, {
        method,
        headers,
        ...(init.body === undefined
          ? {}
          : { body: form ? (init.body as FormData) : JSON.stringify(init.body) }),
        credentials: 'same-origin',
      });
      recordRequest({ at, method, path, status: res.status, ref: res.headers.get('x-request-id') });
      return res;
    } catch {
      recordRequest({ at, method, path, status: 0, ref: null });
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
    const err = new ApiError(
      res.status,
      typeof body.code === 'string' ? body.code : undefined,
      body,
      res.headers.get('x-request-id'),
    );
    // A fault on the server is not the person's to fix: say so where it cannot be missed, with the reference.
    if (res.status >= 500 && res.status !== 503)
      showErrorDialog({
        title: 'Something went wrong on the server',
        message: 'What you asked for was not done. Nothing you entered was lost from this screen.',
        advice:
          'Try again in a minute. If it happens again, send the reference below to your administrator or support.',
        reference: err.ref ?? undefined,
      });
    return err;
  }
}

/** The file name from Content-Disposition, preferring the UTF-8 form. */
export function fileNameOf(res: Response): string | null {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      // fall through to the plain name
    }
  }
  return /filename="([^"]+)"/i.exec(cd)?.[1] ?? null;
}

/** Hands a downloaded file to the browser (or the desktop app's save dialog). */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const api = new ApiClient();
