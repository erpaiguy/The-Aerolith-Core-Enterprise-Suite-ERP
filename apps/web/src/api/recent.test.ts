// The last requests the API client saw, for a support request's diagnostics (docs/wave9-plan.md step 9b.2): at most
// ten, newest last, with the method, path without its query, status and reference — never bodies or tokens.
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiClient,
  RECENT_REQUESTS_MAX,
  clearRecentRequests,
  recentRequests,
  recordRequest,
} from './client';

const reply = (status: number, ref: string | null) =>
  new Response(status === 204 ? null : JSON.stringify({ secret: 'body-data' }), {
    status,
    headers: ref ? { 'x-request-id': ref } : {},
  });

afterEach(clearRecentRequests);

describe('recent requests', () => {
  it('records each response with its reference, and no body, headers or token', async () => {
    const client = new ApiClient((async () => reply(200, 'K7P2QX9M4A')) as typeof fetch);
    client.setAccessToken('very-secret-token');
    await client.request('/api/tenant/orders?q=Sharma', {
      method: 'POST',
      body: { password: 'pw' },
    });
    const [r, ...rest] = recentRequests();
    expect(rest).toEqual([]);
    expect(r).toEqual({
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      method: 'POST',
      path: '/api/tenant/orders',
      status: 200,
      ref: 'K7P2QX9M4A',
    });
    expect(JSON.stringify(recentRequests())).not.toMatch(/secret|Sharma|pw|password/);
  });

  it('records failures and requests that got no answer', async () => {
    const client = new ApiClient((async () => reply(404, 'NOTFOUND01')) as typeof fetch);
    await expect(client.request('/api/a')).rejects.toThrow();
    const offline = new ApiClient((async () => {
      throw new TypeError('offline');
    }) as typeof fetch);
    await expect(offline.request('/api/b')).rejects.toThrow();
    expect(recentRequests().map((r) => [r.method, r.path, r.status, r.ref])).toEqual([
      ['GET', '/api/a', 404, 'NOTFOUND01'],
      ['GET', '/api/b', 0, null],
    ]);
  });

  it('keeps only the last ten, newest last', () => {
    for (let i = 1; i <= 15; i++)
      recordRequest({ at: `t${i}`, method: 'GET', path: `/api/${i}`, status: 200, ref: `R${i}` });
    const list = recentRequests();
    expect(RECENT_REQUESTS_MAX).toBe(10);
    expect(list).toHaveLength(10);
    expect(list[0]!.path).toBe('/api/6');
    expect(list.at(-1)!.path).toBe('/api/15');
  });

  it('hands out copies', () => {
    recordRequest({ at: 't', method: 'GET', path: '/api/x', status: 200, ref: 'R' });
    recentRequests()[0]!.path = '/changed';
    expect(recentRequests()[0]!.path).toBe('/api/x');
  });
});
