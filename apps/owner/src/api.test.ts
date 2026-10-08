import { describe, expect, it, vi } from 'vitest';
import { ApiError, OwnerApi } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('OwnerApi', () => {
  it('refreshes once through the owner cookie for concurrent 401s and retries each request', async () => {
    let refreshes = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const auth = (init?.headers as Record<string, string>).authorization;
      if (path === '/api/owner/auth/refresh') {
        refreshes++;
        expect(init?.body).toBe('{}');
        expect((init?.headers as Record<string, string>)['x-aerolith-client']).toBe('browser');
        await new Promise((r) => setTimeout(r, 5));
        return json(200, { accessToken: 'fresh', mustChangePassword: false });
      }
      return auth === 'Bearer fresh' ? json(200, { path }) : json(401, { code: 'invalid_token' });
    });
    const client = new OwnerApi(fetchImpl as typeof fetch);
    client.setAccessToken('stale');
    const results = await Promise.all([
      client.get<{ path: string }>('/api/owner/a'),
      client.get<{ path: string }>('/api/owner/b'),
    ]);
    expect(results.map((r) => r.path)).toEqual(['/api/owner/a', '/api/owner/b']);
    expect(refreshes).toBe(1);
  });

  it('reports a lost session when the refresh fails', async () => {
    const fetchImpl = vi.fn(async () => json(401, { code: 'session_expired' }));
    const client = new OwnerApi(fetchImpl as typeof fetch);
    const lost = vi.fn();
    client.onSessionLost = lost;
    await expect(client.get('/api/owner/overview')).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledOnce();
  });

  it('turns network failures into a network_error', async () => {
    const client = new OwnerApi((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(client.get('/api/owner/overview')).rejects.toMatchObject({
      code: 'network_error',
    });
  });
});
