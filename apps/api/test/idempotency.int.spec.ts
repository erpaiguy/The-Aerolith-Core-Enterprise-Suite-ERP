// Idempotent writes in a real tenant database (docs/wave6-plan.md step 4): a phone that lost signal sends the same
// form again with the key it made. The same key twice makes one daily report and returns the first answer; a save
// repeated with a stale row version is answered from the first save, not refused; another person's same key is
// their own; a key reused on another route is refused; a refusal is not kept, so the person can fix and resend.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { migrate } from '../src/db/migrate.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('idempotent writes (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;

  const post = (url: string, payload: object, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };

  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ id: string; temporaryPassword: string }>();
    const login = (password: string) =>
      post(
        '/auth/login',
        { entitlementToken: t.entitlement, identifier: username, password, client: 'desktop' },
        {},
      ).then((r) => r.json<{ accessToken: string }>().accessToken);
    const first = await login(created.temporaryPassword);
    await post(
      '/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: 'Bar-Bending-Yard-44' },
      { authorization: `Bearer ${first}` },
    );
    return {
      id: created.id,
      headers: { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` },
    };
  }

  beforeAll(async () => {
    control = postgres(controlUrl!, { onnotice: () => {} });
    server = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    for (const { datname } of await server<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname LIKE 'tenant\\_t%'`) {
      await server.unsafe(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
    await control`DROP SCHEMA IF EXISTS core CASCADE`;
    await control`DROP SCHEMA IF EXISTS aerolith_meta CASCADE`;
    await migrate(control);
    Object.assign(process.env, {
      CONTROL_DATABASE_URL: controlUrl,
      CONTROL_PLANE_ENC_KEY: ENC.toString('base64'),
      LOCAL_PG_ADMIN_URL: adminUrl,
      RATE_LIMIT_SCALE: '50',
      PUBLIC_API_URL: 'https://api.example.in',
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-idem-test-')),
      DOCUMENT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-idem-files-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'idem-admin@example.in');
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(post(`/tenant/projects/${projectId}/team`, { userId: w.id, role: 'member' }, manager));
    siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  let projectId: string;
  let siteId: string;
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const key = () => randomBytes(16).toString('hex');
  interface Report {
    id: string;
    rowVersion: number;
    manpower: { trade: string; headcount: number }[];
  }
  let made: Report;

  it('makes one report however many times the phone sends it, and answers each time alike', async () => {
    const k = key();
    const create = (headers: Record<string, string>, idem?: string) =>
      post(
        `/tenant/projects/${projectId}/daily-reports`,
        { siteId, reportDate: today },
        idem ? { ...headers, 'idempotency-key': idem } : headers,
      );
    const first = await create(worker, k);
    expect(first.statusCode).toBeLessThan(300);
    const again = await create(worker, k);
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    made = first.json<Report>();
    const [count] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM proj.daily_report WHERE site_id = ${siteId}`;
    expect(count?.n).toBe(1);
    // Without the key the same form is refused: the report exists.
    expect((await create(worker)).json<{ code: string }>().code).toBe('report_exists');

    // Another person's same key is theirs: it runs, is refused, and the refusal is not kept.
    const theirs = await create(manager, k);
    expect(theirs.statusCode).toBe(409);
    expect(theirs.json<{ code: string }>().code).toBe('report_exists');
    expect((await create(manager, k)).json<{ code: string }>().code).toBe('report_exists');

    // The worker's key used for something else is refused.
    const r = first.json<Report>();
    const reused = await post(
      `/tenant/daily-reports/${r.id}`,
      { rowVersion: r.rowVersion, manpower: [] },
      { ...worker, 'idempotency-key': k },
    );
    expect(reused.statusCode).toBe(409);
    expect(reused.json<{ code: string }>().code).toBe('idempotency_key_reused');
  });

  it('answers a repeated save from the first, where the stale row version would refuse it', async () => {
    const r = made;
    const k = key();
    const save = () =>
      post(
        `/tenant/daily-reports/${r.id}`,
        { rowVersion: r.rowVersion, manpower: [{ trade: 'Mason', headcount: 6 }] },
        { ...worker, 'idempotency-key': k },
      );
    const first = await save();
    expect(first.statusCode).toBeLessThan(300);
    const again = await save();
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.json<Report>().rowVersion).toBe(first.json<Report>().rowVersion);
    // Without the key the stale version is refused.
    const stale = await post(
      `/tenant/daily-reports/${r.id}`,
      { rowVersion: r.rowVersion, manpower: [{ trade: 'Mason', headcount: 6 }] },
      worker,
    );
    expect(stale.statusCode).toBe(409);
  });

  it('refuses a key that is not one', async () => {
    const res = await post(
      `/tenant/projects/${projectId}/daily-reports`,
      { siteId, reportDate: today },
      { ...worker, 'idempotency-key': 'short' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('bad_idempotency_key');
  });
});
