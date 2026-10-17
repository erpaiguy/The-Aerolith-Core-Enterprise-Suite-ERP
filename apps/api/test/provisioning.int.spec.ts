// Provisioning end to end with the local Postgres stand-in, tenant isolation, the migration orchestrator, and the
// Supabase onboarding flow against a fake Supabase API. Needs TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL
// (a superuser on a throwaway server: the test drops tenant_* databases and t*_app / t*_migrator roles).
import 'reflect-metadata';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { open, seal } from '../src/crypto/secretbox.js';
import { migrate, migrationFiles, TENANT_MIGRATIONS } from '../src/db/migrate.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { signInOperator } from './helpers/operator.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);
let owner: Record<string, string> = {};

describe.skipIf(!controlUrl || !adminUrl)('tenant provisioning (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let fakeSupabase: FastifyInstance;
  const supabaseCalls: { method: string; url: string; auth?: string; body?: unknown }[] = [];
  const opened: Sql[] = [];

  const post = (path: string, payload: unknown = {}, headers: Record<string, string> = owner) =>
    app.inject({ method: 'POST', url: `/api${path}`, payload: payload as object, headers });
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api${path}`, headers });
  const newTenant = async (email: string) =>
    (await post('/owner/tenants', { email, tenantName: `Tenant ${email}` })).json<{
      tenantId: string;
    }>().tenantId;
  const secrets = async (tenantId: string) =>
    (
      await control<
        { app_url_secret: string; migrator_url_secret: string; external_ref: string }[]
      >`
      SELECT app_url_secret, migrator_url_secret, external_ref FROM core.tenant_db WHERE tenant_id = ${tenantId}`
    )[0]!;
  const connect = (url: string) => {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    opened.push(sql);
    return sql;
  };
  const provisioning = () => app.get(ProvisioningService);

  beforeAll(async () => {
    control = postgres(controlUrl!, { onnotice: () => {} });
    server = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    for (const { datname } of await server<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname LIKE 'tenant\\_t%'`) {
      await server.unsafe(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
    for (const { rolname } of await server<
      { rolname: string }[]
    >`SELECT rolname FROM pg_roles WHERE rolname ~ '^t[0-9a-f]{12}_(app|migrator)$'`) {
      await server.unsafe(`DROP ROLE "${rolname}"`);
    }
    await control`DROP SCHEMA IF EXISTS core CASCADE`;
    await control`DROP SCHEMA IF EXISTS aerolith_meta CASCADE`;
    await migrate(control);

    fakeSupabase = Fastify();
    fakeSupabase.addHook('onRequest', async (req) => {
      supabaseCalls.push({
        method: req.method,
        url: req.url,
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      });
    });
    fakeSupabase.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    fakeSupabase.post('/v1/oauth/token', async (req, reply) => {
      const body = req.body as Record<string, string>;
      if (body.code !== 'good-code' || !body.code_verifier)
        return reply.code(400).send({ error: 'invalid_grant' });
      return {
        access_token: 'sb-access-token',
        refresh_token: 'sb-refresh-token',
        expires_in: 3600,
      };
    });
    fakeSupabase.get('/v1/organizations', async () => [
      { id: 'org-personal', name: 'Personal' },
      { id: 'org-company', name: 'Sharma Builders' },
    ]);
    fakeSupabase.post('/v1/projects', async (req) => {
      supabaseCalls.at(-1)!.body = req.body;
      return { id: 'abcdefghijklmnopqrst', status: 'COMING_UP', region: 'ap-south-1' };
    });
    fakeSupabase.get('/v1/projects/:ref', async () => ({
      id: 'abcdefghijklmnopqrst',
      status: 'COMING_UP',
    }));
    const fakeUrl = await fakeSupabase.listen({ port: 0, host: '127.0.0.1' });

    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      RATE_LIMIT_SCALE: '100',
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      SUPABASE_API_URL: fakeUrl,
      SUPABASE_OAUTH_CLIENT_ID: 'test-client',
      SUPABASE_OAUTH_CLIENT_SECRET: 'test-secret',
      PUBLIC_API_URL: 'http://api.test',
      WEBSITE_URL: 'http://site.test',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    owner = (await signInOperator(app)).headers;
  });

  afterAll(async () => {
    await Promise.all(opened.map((s) => s.end()));
    await app?.close();
    await fakeSupabase?.close();
    await control?.end();
    await server?.end();
  });

  let tenantA = '';
  let tenantB = '';

  it('provisions a tenant database through every state to ready', async () => {
    tenantA = await newTenant('a@provision.in');
    const registered = await post(`/owner/tenants/${tenantA}/provision`, {
      provider: 'local_postgres',
    });
    expect(registered.json()).toMatchObject({ status: 'creating', provider: 'local_postgres' });
    expect(
      (await post(`/owner/tenants/${tenantA}/provision`, { provider: 'local_postgres' }))
        .statusCode,
    ).toBe(409);

    const settled = await provisioning().runUntilSettled(tenantA);
    expect(settled).toMatchObject({
      status: 'ready',
      schemaVersion: migrationFiles(TENANT_MIGRATIONS).at(-1),
      lastError: null,
    });
    expect((await get(`/owner/tenants/${tenantA}/database`, owner)).json()).toMatchObject({
      status: 'ready',
    });

    tenantB = await newTenant('b@provision.in');
    await post(`/owner/tenants/${tenantB}/provision`, { provider: 'local_postgres' });
    expect(await provisioning().runUntilSettled(tenantB)).toMatchObject({ status: 'ready' });
  }, 60_000); // Provisioning runs every tenant migration; the count grows wave by wave.

  it('stores only sealed credentials', async () => {
    const s = await secrets(tenantA);
    expect(s.app_url_secret.startsWith('v1.')).toBe(true);
    expect(s.app_url_secret).not.toContain('postgres://');
    expect(open(s.app_url_secret, ENC)).toContain('_app:');
  });

  it('gives the app role data access but no DDL and no audit tampering', async () => {
    const appA = connect(open((await secrets(tenantA)).app_url_secret, ENC));
    expect(await appA`SELECT name FROM platform.entity`).toEqual([{ name: 'Main entity' }]);
    await appA`INSERT INTO platform."user" (username, display_name, role) VALUES ('ravi', 'Ravi', 'manager')`;
    await expect(
      appA`INSERT INTO platform."user" (username, display_name, role) VALUES ('RAVI', 'Dup', 'worker')`,
    ).rejects.toThrow(/duplicate key/);
    await expect(appA.unsafe('CREATE TABLE platform.evil (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(appA.unsafe('CREATE TABLE public.evil (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await appA`INSERT INTO platform.audit_log (action, entity) VALUES ('test', 'x')`;
    await expect(appA`UPDATE platform.audit_log SET action = 'forged'`).rejects.toThrow(
      /permission denied/,
    );
    await expect(appA`DELETE FROM platform.audit_log`).rejects.toThrow(/permission denied/);
    await expect(appA`DROP SCHEMA platform CASCADE`).rejects.toThrow(/must be owner/);
  });

  it("isolates tenants: A's credentials cannot open B's database", async () => {
    const a = new URL(open((await secrets(tenantA)).app_url_secret, ENC));
    a.pathname = `/${(await secrets(tenantB)).external_ref}`;
    const crossed = connect(a.toString());
    await expect(crossed`SELECT 1`).rejects.toThrow(/permission denied for database/);
    const am = new URL(open((await secrets(tenantA)).migrator_url_secret, ENC));
    am.pathname = a.pathname;
    await expect(connect(am.toString())`SELECT 1`).rejects.toThrow(
      /permission denied for database/,
    );
  });

  it('rolls out new migrations to every tenant and pauses on failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aerolith-mig-'));
    cpSync(TENANT_MIGRATIONS, dir, { recursive: true });
    writeFileSync(join(dir, '9990_probe.sql'), 'CREATE TABLE platform.probe (id int PRIMARY KEY);');

    const first = (
      await post('/owner/migrations/rollout', { concurrency: 2, failureThreshold: 1 })
    ).json();
    expect(first).toMatchObject({ status: 'completed', counts: { up_to_date: 2 } });

    const orchestrator = (await import('../src/provisioning/orchestrator.js'))
      .MigrationOrchestrator;
    const run = await app.get(orchestrator).rollout({ dir, concurrency: 2, failureThreshold: 1 });
    expect(run).toMatchObject({
      status: 'completed',
      targetVersion: '9990_probe.sql',
      counts: { applied: 2 },
    });
    const appB = connect(open((await secrets(tenantB)).app_url_secret, ENC));
    expect(await appB`SELECT count(*)::int AS n FROM platform.probe`).toEqual([{ n: 0 }]); // default privileges apply

    // Break tenant A's migrator credentials; with threshold 1 and concurrency 1, B must not be attempted.
    writeFileSync(join(dir, '9991_probe2.sql'), 'CREATE TABLE platform.probe2 (id int);');
    const bad = new URL(open((await secrets(tenantA)).migrator_url_secret, ENC));
    bad.password = 'wrong-password';
    await control`UPDATE core.tenant_db SET migrator_url_secret = ${seal(bad.toString(), ENC)} WHERE tenant_id = ${tenantA}`;
    const paused = await app
      .get(orchestrator)
      .rollout({ dir, concurrency: 1, failureThreshold: 1 });
    expect(paused).toMatchObject({ status: 'paused', counts: { failed: 1, not_attempted: 1 } });
    const results =
      await control`SELECT tenant_id, result FROM core.migration_run_tenant WHERE run_id = ${paused.runId} ORDER BY result`;
    expect(results).toEqual([
      { tenant_id: tenantA, result: 'failed' },
      { tenant_id: tenantB, result: 'not_attempted' },
    ]);
    await expect(appB`SELECT 1 FROM platform.probe2`).rejects.toThrow(/does not exist/);
  });

  it('runs the Supabase onboarding flow: link, consent, organisation choice, project creation', async () => {
    const tenantC = await newTenant('c@onboard.in');
    const link = (await post(`/owner/tenants/${tenantC}/onboarding-link`)).json<{ url: string }>();
    expect(link.url.startsWith('http://site.test/onboarding?token=')).toBe(true);
    const token = new URL(link.url).searchParams.get('token')!;
    expect((await get(`/onboarding/status?token=${token}`)).json()).toEqual({
      status: 'awaiting_consent',
    });

    const authorize = await get(`/onboarding/supabase/authorize?token=${token}`);
    expect(authorize.statusCode).toBe(302);
    const consent = new URL(authorize.headers.location as string);
    expect(consent.pathname).toBe('/v1/oauth/authorize');
    expect(consent.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/onboarding/supabase/callback',
    );
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    const state = consent.searchParams.get('state')!;

    const denied = await get('/onboarding/supabase/callback?error=access_denied');
    expect(denied.headers.location).toBe('http://site.test/onboarding/status?error=consent_denied');

    const cb = await get(`/onboarding/supabase/callback?code=good-code&state=${state}`);
    expect(cb.headers.location).toBe('http://site.test/onboarding/status');
    const replay = await get(`/onboarding/supabase/callback?code=good-code&state=${state}`);
    expect(replay.headers.location).toBe(
      'http://site.test/onboarding/status?error=oauth_state_invalid',
    );

    const status = (await get(`/onboarding/status?token=${token}`)).json<{
      status: string;
      organisations: { id: string }[];
    }>();
    expect(status.status).toBe('awaiting_org');
    expect(status.organisations.map((o) => o.id)).toEqual(['org-personal', 'org-company']);

    const unknown = await post(
      '/onboarding/supabase/organisation',
      { token, organisationId: 'org-other' },
      {},
    );
    expect(unknown.statusCode).toBe(400);
    const chosen = await post(
      '/onboarding/supabase/organisation',
      { token, organisationId: 'org-company' },
      {},
    );
    expect(chosen.json()).toEqual({ status: 'creating' });

    // One provisioning step: the project is requested in the tenant's organisation, in Mumbai, and is still coming up.
    const after = await provisioning().runUntilSettled(tenantC);
    expect(after.status).toBe('creating');
    const create = supabaseCalls.find((c) => c.method === 'POST' && c.url === '/v1/projects')!;
    expect(create.auth).toBe('Bearer sb-access-token');
    expect(create.body).toMatchObject({
      organization_slug: 'org-company',
      region_selection: { type: 'specific', code: 'ap-south-1' },
    });
    expect((create.body as { db_pass: string }).db_pass.length).toBeGreaterThanOrEqual(24);

    const [row] = await control<
      { external_ref: string; oauth_secret: string; admin_secret: string }[]
    >`
      SELECT external_ref, oauth_secret, admin_secret FROM core.tenant_db WHERE tenant_id = ${tenantC}`;
    expect(row!.external_ref).toBe('abcdefghijklmnopqrst');
    expect(row!.oauth_secret).not.toContain('sb-access-token');
    expect(open(row!.admin_secret, ENC)).toBe((create.body as { db_pass: string }).db_pass);

    expect((await get('/onboarding/status?token=not-a-real-token-at-all')).statusCode).toBe(404);
  });
});
