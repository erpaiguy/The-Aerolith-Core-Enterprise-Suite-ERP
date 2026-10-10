// The company's tender settings in a real tenant database (docs/wave1-plan.md step 13): its own bid/no-bid criteria
// and document checklist (admin only), the calendar's date range, and user names.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
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

describe.skipIf(!controlUrl || !adminUrl)('tender settings (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: Record<string, string>;
  let tenderId: string;

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  async function staff(username: string, role: 'manager' | 'worker') {
    const created = (
      await post('/tenant/users', { username, displayName: username, role }, t.admin)
    ).json<{ temporaryPassword: string }>();
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
    return { authorization: `Bearer ${await login('Bar-Bending-Yard-44')}` };
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
      RATE_LIMIT_SCALE: '200',
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'settings-admin@example.in');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    worker = await staff('ramesh', 'worker');

    tenderId = (
      await ok<{ id: string }>(post('/tenant/tenders', { title: 'Ward building, Washim' }))
    ).id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  type Settings = {
    criteria: { key: string; label: string; weight: number }[];
    checklist: { envelope: string; title: string; required: boolean }[];
    criteriaCustomised: boolean;
    checklistCustomised: boolean;
  };

  it('scores bids on the company criteria, set by the admin', async () => {
    const built = await ok<Settings>(get('/tenant/tender-settings', worker));
    expect(built.criteria).toHaveLength(8);
    expect(built.criteriaCustomised).toBe(false);
    const mine = [
      { key: 'strategic_fit', label: 'Strategic fit for us', weight: 3 },
      { label: 'Repeat client', weight: 2 },
    ];
    expect(
      (await post('/tenant/tender-settings/bid-criteria', { criteria: mine }, worker)).statusCode,
    ).toBe(403);
    const s = await ok<Settings>(post('/tenant/tender-settings/bid-criteria', { criteria: mine }));
    expect(s.criteria).toEqual([
      { key: 'strategic_fit', label: 'Strategic fit for us', weight: 3 },
      { key: 'repeat_client', label: 'Repeat client', weight: 2 },
    ]);
    expect(s.criteriaCustomised).toBe(true);
    const t = await ok<{ defaultCriteria: object[] }>(get(`/tenant/tenders/${tenderId}`));
    expect(t.defaultCriteria).toEqual(s.criteria);

    // Scored on the old list: refused. On the new: (3 × 1 + 2 × 0) ÷ 5 = 60.
    const old = await post(`/tenant/tenders/${tenderId}/decision`, {
      criteria: built.criteria.map((c) => ({ key: c.key, weight: c.weight, score: 3 })),
      decision: 'bid',
      reason: '',
    });
    expect(old.json()).toMatchObject({ code: 'invalid_criteria' });
    const scored = await ok<{ decisions: { score: string; criteria: { label: string }[] }[] }>(
      post(`/tenant/tenders/${tenderId}/decision`, {
        criteria: [
          { key: 'strategic_fit', weight: 3, score: 5 },
          { key: 'repeat_client', weight: 2, score: 1 },
        ],
        decision: 'bid',
        reason: '',
      }),
    );
    expect(Number(scored.decisions[0]!.score)).toBe(60);
    expect(scored.decisions[0]!.criteria.map((c) => c.label)).toEqual([
      'Strategic fit for us',
      'Repeat client',
    ]);

    expect(
      (
        await post('/tenant/tender-settings/bid-criteria', {
          criteria: [{ label: 'Nothing', weight: 0 }],
        })
      ).statusCode,
    ).toBe(400);
    const reset = await ok<Settings>(
      post('/tenant/tender-settings/bid-criteria', { criteria: null }),
    );
    expect(reset.criteria).toHaveLength(8);
    expect(reset.criteriaCustomised).toBe(false);
  });

  it("adds the company's own checklist to a tender", async () => {
    const items = [
      { envelope: 'technical', title: 'ISO 9001 certificate', required: false },
      { envelope: 'financial', title: 'Price bid on the BOQ format', required: true },
    ];
    const dup = await post('/tenant/tender-settings/checklist', {
      items: [...items, { ...items[0], title: 'iso 9001 CERTIFICATE' }],
    });
    expect(dup.json()).toMatchObject({ code: 'duplicate_item' });
    await ok(post('/tenant/tender-settings/checklist', { items }));
    expect(
      (await ok<{ added: number }>(post(`/tenant/tenders/${tenderId}/checklist/standard`))).added,
    ).toBe(2);
    const work = await ok<{ checklist: { title: string; envelope: string }[] }>(
      get(`/tenant/tenders/${tenderId}/work`),
    );
    expect(work.checklist.map((c) => c.title).sort()).toEqual([
      'ISO 9001 certificate',
      'Price bid on the BOQ format',
    ]);
  });

  it('gives the calendar the dates of a month', async () => {
    await db`UPDATE tender.tender SET submission_due_at = '2027-01-15T06:30:00Z', prebid_at = '2027-02-02T05:30:00Z'
      WHERE id = ${tenderId}`;
    const jan = await ok<{ kind: string; at: string }[]>(
      get('/tenant/tender-agenda?from=2027-01-01&to=2027-01-31'),
    );
    expect(jan.map((x) => x.kind)).toEqual(['submission']);
    const feb = await ok<{ kind: string }[]>(
      get('/tenant/tender-agenda?from=2027-02-01&to=2027-02-28'),
    );
    expect(feb.map((x) => x.kind)).toEqual(['prebid']);
    expect((await get('/tenant/tender-agenda?from=2027-01-01&to=2027-06-30')).statusCode).toBe(400);
    expect((await get('/tenant/tender-agenda?from=2027-01-01')).statusCode).toBe(400);
  });

  it('lets each user change their own name, and the admin anyone', async () => {
    await ok(post('/tenant/me/name', { displayName: 'Anil Deshmukh' }));
    expect((await ok<{ displayName: string }>(get('/auth/me'))).displayName).toBe('Anil Deshmukh');
    await ok(post('/tenant/me/name', { displayName: 'Kavita J.' }, worker));
    const users = await ok<{ id: string; displayName: string; username: string }[]>(
      get('/tenant/users'),
    );
    const kavita = users.find((u) => u.username === 'ramesh')!;
    expect(kavita.displayName).toBe('Kavita J.');
    await ok(post(`/tenant/users/${kavita.id}/name`, { displayName: 'Kavita Joshi' }));
    expect((await ok<{ displayName: string }>(get('/auth/me', worker))).displayName).toBe(
      'Kavita Joshi',
    );
    expect(
      (await post(`/tenant/users/${kavita.id}/name`, { displayName: 'X Y' }, worker)).statusCode,
    ).toBe(403);
    expect((await post('/tenant/me/name', { displayName: ' ' })).statusCode).toBe(400);
  });
});
