import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  delete window.aerolithDesktop;
});

describe('ApiClient', () => {
  it('refreshes once for concurrent 401s and retries each request', async () => {
    let refreshes = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const auth = (init?.headers as Record<string, string>).authorization;
      if (path === '/api/auth/refresh') {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return json(200, {
          accessToken: 'fresh',
          mustChangePassword: false,
          licence: { state: 'active', featuresUnlocked: true },
        });
      }
      return auth === 'Bearer fresh' ? json(200, { path }) : json(401, { code: 'invalid_token' });
    });
    const client = new ApiClient(fetchImpl as typeof fetch);
    client.setAccessToken('stale');
    const results = await Promise.all([
      client.request<{ path: string }>('/api/a'),
      client.request<{ path: string }>('/api/b'),
      client.request<{ path: string }>('/api/c'),
    ]);
    expect(results.map((r) => r.path)).toEqual(['/api/a', '/api/b', '/api/c']);
    expect(refreshes).toBe(1);
  });

  it('sends the browser client header and no refresh token from script', async () => {
    const fetchImpl = vi.fn(async () => json(401, {}));
    const client = new ApiClient(fetchImpl as typeof fetch);
    await client.refresh();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-aerolith-client']).toBe('browser');
    expect(init.body).toBe('{}');
    expect(init.credentials).toBe('same-origin');
  });

  it('uses the desktop keychain token and stores the rotated one', async () => {
    const stored: (string | null)[] = [];
    window.aerolithDesktop = {
      apiBaseUrl: 'https://api.example.in',
      platform: 'windows',
      appVersion: '0.1.0',
      deviceId: async () => 'device',
      getRefreshToken: async () => 'rt1.old',
      setRefreshToken: async (t) => void stored.push(t),
    };
    const fetchImpl = vi.fn(async () =>
      json(200, {
        accessToken: 'a',
        refreshToken: 'rt1.new',
        mustChangePassword: false,
        licence: {},
      }),
    );
    const client = new ApiClient(fetchImpl as typeof fetch);
    await client.refresh();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.in/api/auth/refresh');
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'rt1.old' });
    expect(stored).toEqual(['rt1.new']);
  });

  it('reports a lost session when refresh fails, and surfaces API error codes', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url) === '/api/auth/refresh'
        ? json(401, { code: 'session_revoked' })
        : json(401, { code: 'invalid_token' }),
    );
    const client = new ApiClient(fetchImpl as typeof fetch);
    const lost = vi.fn();
    client.onSessionLost = lost;
    client.setAccessToken('stale');
    await expect(client.request('/api/x')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_token',
    });
    expect(lost).toHaveBeenCalledOnce();
  });

  it('turns network failures into a network_error', async () => {
    const client = new ApiClient((async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(client.request('/api/x', { auth: false })).rejects.toEqual(
      new ApiError(0, 'network_error', {}),
    );
  });
});
