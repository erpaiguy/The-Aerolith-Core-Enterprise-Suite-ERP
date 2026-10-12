// The CRM (docs/wave6-plan.md step 1) in a real tenant database: a referred lead with a contact, interactions and a
// follow-up (noticed and reminded), qualified and converted to a tender with a new client party, the tender won and
// the lead with it; a second lead lost; the pipeline counted by hand; who may write.
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

describe.skipIf(!controlUrl || !adminUrl)('CRM (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-crm-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'crm-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  type Lead = {
    id: string;
    number: string;
    stage: string;
    probability: number;
    weighted: string;
    tenderId: string | null;
    partyId: string | null;
    rowVersion: number;
    interactions: { id: string; kind: string; followUpOn: string | null }[];
  };

  it('takes a lead from referral to a won tender, and counts the pipeline', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const tomorrow = new Date(Date.now() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
    const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
    // Workers read but do not write by default.
    expect(
      (await post('/tenant/crm/leads', { title: 'Nope', organisation: 'Nobody Ltd' }, worker))
        .statusCode,
    ).toBe(403);
    let a = await ok<Lead>(
      post(
        '/tenant/crm/leads',
        {
          title: 'Hostel block for the engineering college',
          organisation: 'Shivaji Shikshan Sanstha',
          source: 'referral',
          segment: 'buildings',
          location: 'Amravati',
          value: '42000000',
          expectedMonth: month,
        },
        manager,
      ),
    );
    expect([a.number, a.stage, a.probability, a.weighted]).toEqual([
      'LD-001',
      'new',
      10,
      '4200000.00',
    ]);
    // Only a qualified lead becomes a tender.
    expect((await post(`/tenant/crm/leads/${a.id}/convert`, {}, manager)).json()).toMatchObject({
      code: 'not_qualified',
    });
    // A meeting with a follow-up tomorrow: noticed now, reminded at 09:00.
    a = await ok<Lead>(
      post(
        `/tenant/crm/leads/${a.id}/interactions`,
        {
          kind: 'meeting',
          happenedAt: new Date(Date.now() - 3600_000).toISOString(),
          summary: 'Met the secretary; 400 beds, G+4',
          followUpOn: tomorrow,
          followUp: 'Send the company profile',
        },
        manager,
      ),
    );
    const notes = await db<{ kind: string }[]>`
      SELECT kind FROM platform.notification WHERE source = ${`follow-up:${a.interactions[0]!.id}`} ORDER BY due_at NULLS FIRST`;
    expect(notes.map((n) => n.kind)).toEqual(['follow_up', 'follow_up_due']);
    expect(
      (
        await post(
          `/tenant/crm/leads/${a.id}/interactions`,
          {
            kind: 'call',
            happenedAt: new Date(Date.now() + 86_400_000).toISOString(),
            summary: 'x',
          },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'in_future' });
    expect(await ok<{ id: string }[]>(get('/tenant/crm/follow-ups', manager))).toHaveLength(1);
    await ok(post(`/tenant/crm/follow-ups/${a.interactions[0]!.id}/done`, {}, manager));
    expect(await ok(get('/tenant/crm/follow-ups', manager))).toEqual([]);
    const [left] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM platform.notification WHERE source = ${`follow-up:${a.interactions[0]!.id}`}`;
    expect(left!.n).toBe(0);

    // Qualified at 50%; converted: a new client party and a tender.
    a = await ok<Lead>(
      post(
        `/tenant/crm/leads/${a.id}`,
        {
          title: 'Hostel block for the engineering college',
          organisation: 'Shivaji Shikshan Sanstha',
          source: 'referral',
          location: 'Amravati',
          value: '42000000',
          probability: 50,
          expectedMonth: month,
          rowVersion: a.rowVersion,
        },
        manager,
      ),
    );
    a = await ok<Lead>(post(`/tenant/crm/leads/${a.id}/stage`, { stage: 'qualified' }, manager));
    expect([a.stage, a.probability]).toEqual(['qualified', 50]);
    a = await ok<Lead>(post(`/tenant/crm/leads/${a.id}/convert`, {}, manager));
    expect(a.stage).toBe('tender');
    const [tender] = await db<
      { title: string; client: string; estimated_value: string; description: string }[]
    >`
      SELECT t.title, p.name AS client, t.estimated_value::text, t.description FROM tender.tender t
      JOIN platform.party p ON p.id = t.client_id WHERE t.id = ${a.tenderId}`;
    expect(tender).toMatchObject({
      title: 'Hostel block for the engineering college',
      client: 'Shivaji Shikshan Sanstha',
      estimated_value: '42000000.00',
    });
    expect(tender!.description).toContain('From lead LD-001');
    expect(
      (await post(`/tenant/crm/leads/${a.id}/stage`, { stage: 'won' }, manager)).json(),
    ).toMatchObject({
      code: 'converted',
    });
    // The tender is won: so is the lead.
    await db`UPDATE tender.tender SET status = 'won' WHERE id = ${a.tenderId}`;
    a = await ok<Lead>(get(`/tenant/crm/leads/${a.id}`, manager));
    expect([a.stage, a.probability, a.weighted]).toEqual(['won', 100, '42000000.00']);

    // A second lead, from a website enquiry, lost; a lost lead needs a reason.
    const b = await ok<Lead>(
      post(
        '/tenant/crm/leads',
        {
          title: 'Showroom interiors',
          partyId: a.partyId,
          source: 'website',
          segment: 'interiors',
          value: '1500000',
        },
        manager,
      ),
    );
    expect(
      (await post(`/tenant/crm/leads/${b.id}/stage`, { stage: 'lost' }, manager)).json(),
    ).toMatchObject({
      code: 'reason_needed',
    });
    await ok(post(`/tenant/crm/leads/${b.id}/stage`, { stage: 'lost', reason: 'Price' }, manager));
    // A third, open in negotiation at the stage's 60%.
    const c = await ok<Lead>(
      post(
        '/tenant/crm/leads',
        {
          title: 'Warehouse, MIDC',
          organisation: 'Vidarbha Logistics',
          source: 'referral',
          value: '20000000',
          expectedMonth: month,
        },
        manager,
      ),
    );
    await ok(post(`/tenant/crm/leads/${c.id}/stage`, { stage: 'negotiation' }, manager));
    // A contact for the client.
    await ok(
      post(
        '/tenant/crm/contacts',
        { partyId: a.partyId, name: 'R. Deshmukh', role: 'Secretary' },
        manager,
      ),
    );
    expect(
      (await ok<{ name: string }[]>(get(`/tenant/crm/contacts?partyId=${a.partyId}`, manager))).map(
        (x) => x.name,
      ),
    ).toEqual(['R. Deshmukh']);

    // The pipeline: open = the warehouse only (value 2 cr, weighted 1.2 cr); referral 1 won of 1 closed.
    const p = await ok<{
      totals: { open: number; value: string; weighted: string };
      byStage: { stage: string; count: number; value: string }[];
      byMonth: { month: string; weighted: string }[];
      bySource: { source: string; leads: number; won: number; winRate: number | null }[];
    }>(get('/tenant/crm/pipeline', worker));
    expect(p.totals).toEqual({ open: 1, value: '20000000.00', weighted: '12000000.00' });
    expect(p.byStage.find((s) => s.stage === 'won')).toMatchObject({
      count: 1,
      value: '42000000.00',
    });
    expect(p.byMonth[0]).toEqual({ month, count: 1, weighted: '12000000.00' });
    expect(p.bySource).toEqual([
      { source: 'referral', leads: 2, won: 1, closed: 1, winRate: 100 },
      { source: 'website', leads: 1, won: 0, closed: 1, winRate: 0 },
    ]);
    // Going cold: the warehouse, untouched for 31 days.
    await db`UPDATE crm.lead SET created_at = now() - interval '31 days' WHERE id = ${c.id}`;
    const cold = await ok<{ goingCold: { number: string }[] }>(
      get('/tenant/crm/pipeline', manager),
    );
    expect(cold.goingCold.map((x) => x.number)).toEqual(['LD-003']);
  });
});
