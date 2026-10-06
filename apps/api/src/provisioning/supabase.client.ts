// Supabase OAuth + Management API client.
//
// UNVERIFIED AGAINST THE LIVE API: endpoint paths and payload shapes follow Supabase's public Management API
// documentation as understood at the time of writing. Verify end to end with a registered OAuth app before relying
// on it (docs/infra-existing-stack.md §5). Everything Supabase-specific is isolated in this file.
import { createHash, randomBytes } from 'node:crypto';

export interface SupabaseOAuthConfig {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface SupabaseOrganisation {
  id: string;
  name: string;
}

export interface SupabaseProject {
  id: string;
  status: string;
  region?: string;
}

export interface PoolerConfig {
  db_host: string;
  db_port: number;
  db_name: string;
  pool_mode: 'session' | 'transaction' | string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SupabaseApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`Supabase API ${path} failed with ${status}`);
  }
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export class SupabaseClient {
  constructor(
    private readonly config: SupabaseOAuthConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authorizeUrl(state: string, codeChallenge: string): string {
    const url = new URL('/v1/oauth/authorize', this.config.apiUrl);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  exchangeCode(code: string, verifier: string): Promise<OAuthTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: verifier,
    });
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  listOrganisations(accessToken: string): Promise<SupabaseOrganisation[]> {
    return this.api<SupabaseOrganisation[]>(accessToken, 'GET', '/v1/organizations');
  }

  createProject(
    accessToken: string,
    p: { name: string; organisationId: string; region: string; dbPassword: string },
  ): Promise<SupabaseProject> {
    return this.api<SupabaseProject>(accessToken, 'POST', '/v1/projects', {
      name: p.name,
      organization_id: p.organisationId,
      region: p.region,
      db_pass: p.dbPassword,
    });
  }

  getProject(accessToken: string, ref: string): Promise<SupabaseProject> {
    return this.api<SupabaseProject>(accessToken, 'GET', `/v1/projects/${encodeURIComponent(ref)}`);
  }

  async getPooler(accessToken: string, ref: string): Promise<PoolerConfig[]> {
    const res = await this.api<PoolerConfig[] | PoolerConfig>(
      accessToken,
      'GET',
      `/v1/projects/${encodeURIComponent(ref)}/config/database/pooler`,
    );
    return Array.isArray(res) ? res : [res];
  }

  private async token(params: Record<string, string>): Promise<OAuthTokens> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    );
    const res = await this.fetchImpl(new URL('/v1/oauth/token', this.config.apiUrl).toString(), {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new SupabaseApiError(res.status, await res.text(), '/v1/oauth/token');
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
  }

  private async api<T>(
    accessToken: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.config.apiUrl).toString(), {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new SupabaseApiError(res.status, await res.text(), path);
    return (await res.json()) as T;
  }
}

/** Maps Supabase project status values to our provider status. Unknown values count as still creating. */
export function mapProjectStatus(status: string): 'creating' | 'ready' | 'paused' | 'failed' {
  switch (status) {
    case 'ACTIVE_HEALTHY':
      return 'ready';
    case 'INACTIVE':
    case 'PAUSING':
    case 'PAUSED':
      return 'paused';
    case 'INIT_FAILED':
    case 'REMOVED':
    case 'GOING_DOWN':
      return 'failed';
    default:
      return 'creating';
  }
}
