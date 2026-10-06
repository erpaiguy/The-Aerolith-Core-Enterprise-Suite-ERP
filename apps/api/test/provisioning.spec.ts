import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newTenantRoles, rolePrefixFor } from '../src/provisioning/bootstrap.js';
import { classifyError, runBounded } from '../src/provisioning/orchestrator.js';
import { backoffMs } from '../src/provisioning/provisioning.service.js';
import {
  mapProjectStatus,
  newPkce,
  SupabaseClient,
  type FetchLike,
} from '../src/provisioning/supabase.client.js';

describe('Supabase client', () => {
  const config = {
    apiUrl: 'https://api.example.test',
    clientId: 'cid',
    clientSecret: 'csecret',
    redirectUri: 'https://app.test/cb',
  };
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fake: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth/token'))
      return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    if (url.endsWith('/v1/projects'))
      return Response.json({ id: 'ref123', status: 'COMING_UP' }, { status: 201 });
    if (url.endsWith('/v1/organizations')) return new Response('nope', { status: 401 });
    return new Response('not found', { status: 404 });
  };
  const client = new SupabaseClient(config, fake);

  it('builds a PKCE authorize URL', () => {
    const url = new URL(client.authorizeUrl('st', 'ch'));
    expect(url.origin + url.pathname).toBe('https://api.example.test/v1/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://app.test/cb',
      response_type: 'code',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges a code with client authentication and the PKCE verifier', async () => {
    const tokens = await client.exchangeCode('the-code', 'the-verifier');
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    const call = calls.at(-1)!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(call.init?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://app.test/cb',
      code_verifier: 'the-verifier',
    });
  });

  it('creates projects in the requested organisation and region', async () => {
    await client.createProject('at', {
      name: 'n',
      organisationId: 'org1',
      region: 'ap-south-1',
      dbPassword: 'pw',
    });
    const call = calls.at(-1)!;
    expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer at');
    expect(JSON.parse(String(call.init?.body))).toEqual({
      name: 'n',
      organization_slug: 'org1',
      db_pass: 'pw',
      region_selection: { type: 'specific', code: 'ap-south-1' },
    });
  });

  it('surfaces API errors with status', async () => {
    await expect(client.listOrganisations('at')).rejects.toMatchObject({ status: 401 });
  });

  it('maps project states', () => {
    expect(mapProjectStatus('ACTIVE_HEALTHY')).toBe('ready');
    expect(mapProjectStatus('COMING_UP')).toBe('creating');
    expect(mapProjectStatus('INACTIVE')).toBe('paused');
    expect(mapProjectStatus('INIT_FAILED')).toBe('failed');
    expect(mapProjectStatus('SOMETHING_NEW')).toBe('creating');
  });

  it('derives the PKCE challenge from the verifier', () => {
    const { verifier, challenge } = newPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('provisioning helpers', () => {
  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoffMs(50)).toBe(600_000);
  });

  it('names tenant roles safely and uniquely', () => {
    const prefix = rolePrefixFor('3f9a1c2b-4d5e-4f60-8a7b-9c0d1e2f3a4b');
    expect(prefix).toBe('t3f9a1c2b4d5e');
    const roles = newTenantRoles(prefix);
    expect(roles).toMatchObject({ migrator: 't3f9a1c2b4d5e_migrator', app: 't3f9a1c2b4d5e_app' });
    expect(roles.appPassword).not.toBe(roles.migratorPassword);
  });

  it('classifies connection failures as unreachable', () => {
    expect(classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      'unreachable',
    );
    expect(classifyError(new Error('syntax error'))).toBe('failed');
  });

  it('runs with bounded concurrency and stops starting work when told to', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const skipped: number[] = [];
    await runBounded(
      [1, 2, 3, 4, 5, 6],
      2,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        done.push(n);
        inFlight--;
      },
      () => done.length >= 3,
      async (n) => void skipped.push(n),
    );
    expect(peak).toBe(2);
    expect(done.length + skipped.length).toBe(6);
    expect(skipped.length).toBeGreaterThan(0);
  });
});
