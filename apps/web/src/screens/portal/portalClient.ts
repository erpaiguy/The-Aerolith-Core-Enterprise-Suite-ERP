// The portal's own connection (docs/wave6-plan.md step 5): a portal user is not staff, so they never touch the staff
// session. The access token lives in memory; the refresh token is an HttpOnly cookie on /api/portal/auth, renewed
// with the client header as for staff.
import { ApiError, fileNameOf } from '../../api/client';

export interface PortalUser {
  id: string;
  name: string;
  email: string;
  kind: 'vendor' | 'subcontractor' | 'client';
  party: string;
}

export interface PortalSession {
  accessToken: string;
  user: PortalUser;
  licence: { state: string; featuresUnlocked: boolean };
}

async function toError(res: Response) {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty body
  }
  return new ApiError(res.status, typeof body.code === 'string' ? body.code : undefined, body);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'network_error', {});
  }
}

export class PortalClient {
  private token: string | null = null;
  private refreshing: Promise<PortalSession | null> | null = null;
  onSignedOut: () => void = () => {};

  constructor(readonly tenant: string) {}

  set(session: PortalSession | null) {
    this.token = session?.accessToken ?? null;
  }

  async auth(path: string, body: object): Promise<PortalSession> {
    const res = await send(`/api/portal/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aerolith-client': 'browser' },
      body: JSON.stringify({ tenant: this.tenant, ...body }),
    });
    if (!res.ok) throw await toError(res);
    const s = (await res.json()) as PortalSession;
    this.set(s);
    return s;
  }

  /** Single flight; null when there is no session to resume. */
  refresh(): Promise<PortalSession | null> {
    this.refreshing ??= this.auth('refresh', {})
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 0) throw err;
        this.set(null);
        return null;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  async signOut() {
    if (this.token)
      await send('/api/portal/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
      }).catch(() => undefined);
    this.set(null);
  }

  private async authed(path: string, init: RequestInit = {}): Promise<Response> {
    const go = () =>
      send(`/api/portal${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
      });
    let res = await go();
    if (res.status === 401) {
      if (!(await this.refresh())) {
        this.onSignedOut();
        return res;
      }
      res = await go();
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.authed(path);
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: object = {}): Promise<T> {
    const res = await this.authed(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file);
    const res = await this.authed(path, { method: 'POST', body: form });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  async blob(path: string): Promise<{ blob: Blob; fileName: string }> {
    const res = await this.authed(path);
    if (!res.ok) throw await toError(res);
    return { blob: await res.blob(), fileName: fileNameOf(res) ?? 'download' };
  }
}
