// The risk register (docs/wave4-plan.md step 6) in a real tenant database: three risks with mitigation actions (one
// overdue), sorted by score with expected values; the heat map and top risks; contingency of ₹5,00,000 drawn down
// ₹1,20,000 on a risk that occurred, a drawdown beyond what remains refused; the scales changed and the expected value
// following; a company risk.
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
import { readyTenant } from './helpers/tenant.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('risk register (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-risk-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'risk-admin@example.in');
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

  it('scores risks, maps them and draws contingency down', async () => {
    const projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Akola' }, manager))
    ).id;
    const yesterday = new Date(Date.now() - 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
    type Reg = {
      id?: string;
      risks: {
        id: string;
        number: string;
        score: number;
        band: string;
        expectedValue: string;
        status: string;
        rowVersion: number;
        actions: { id: string; overdue: boolean }[];
      }[];
      heatMap: number[][];
      top: { number: string }[];
      openExpectedValue: string;
      contingency: { held: string; drawn: string; remaining: string } | null;
    };
    const raise = (body: object, as = manager) =>
      post(`/tenant/projects/${projectId}/risks`, body, as);
    expect(
      (await raise({ category: 'site', event: 'Nope', probability: 1, impact: 1 }, worker))
        .statusCode,
    ).toBe(404);
    // Likely (75%) × major: 16, high; ₹2,00,000 → ₹1,50,000 expected.
    const a = await ok<Reg>(
      raise({
        category: 'design',
        cause: 'Structural drawings for block B not issued',
        event: 'Columns of block B held up',
        effect: 'Idle formwork gang, delay to the slab cycle',
        probability: 4,
        impact: 4,
        costImpact: '200000',
        timeImpact: 20,
      }),
    );
    // Possible (50%) × severe: 15, high; ₹3,00,000 → ₹1,50,000.
    const b = await ok<Reg>(
      raise({
        category: 'commercial',
        event: 'Steel price rises beyond the escalation clause',
        probability: 3,
        impact: 5,
        costImpact: '300000',
      }),
    );
    // Rare (5%) × minor: 2, low; ₹40,000 → ₹2,000.
    await ok(
      raise({
        category: 'safety',
        event: 'Scaffold collapse at the stair core',
        probability: 1,
        impact: 2,
        costImpact: '40000',
      }),
    );
    await ok(
      post(
        `/tenant/risks/${a.id}/actions`,
        { action: 'Escalate the drawings to the engineer', dueOn: yesterday },
        manager,
      ),
    );
    let reg = await ok<Reg>(
      post(
        `/tenant/risks/${b.id}/actions`,
        { action: 'Book steel for the superstructure now', dueOn: null },
        manager,
      ),
    );
    expect(reg.risks.map((r) => [r.number, r.score, r.band, r.expectedValue])).toEqual([
      ['R-001', 16, 'high', '150000.00'],
      ['R-002', 15, 'high', '150000.00'],
      ['R-003', 2, 'low', '2000.00'],
    ]);
    expect(reg.risks.find((r) => r.number === 'R-001')!.actions.map((x) => x.overdue)).toEqual([
      true,
    ]);
    expect(reg.heatMap).toEqual([
      [0, 0, 1, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(reg.openExpectedValue).toBe('302000.00');

    // Contingency ₹5,00,000. The drawings risk occurs: ₹1,20,000 drawn; ₹4,00,000 more is beyond what remains.
    await ok(post(`/tenant/projects/${projectId}/contingency`, { held: '500000' }, manager));
    expect(
      (
        await post(`/tenant/risks/${a.id}/draws`, { amount: '120000', date: '2026-10-01' }, manager)
      ).json(),
    ).toMatchObject({
      code: 'not_occurred',
    });
    const r1 = reg.risks.find((r) => r.number === 'R-001')!;
    await ok(
      post(
        `/tenant/risks/${a.id}`,
        {
          category: 'design',
          event: 'Columns of block B held up',
          probability: 4,
          impact: 4,
          costImpact: '200000',
          timeImpact: 20,
          status: 'occurred',
          rowVersion: r1.rowVersion,
        },
        manager,
      ),
    );
    reg = await ok<Reg>(
      post(
        `/tenant/risks/${a.id}/draws`,
        { amount: '120000', date: '2026-10-01', note: 'Idle gang, 3 weeks' },
        manager,
      ),
    );
    expect(reg.contingency).toMatchObject({
      held: '500000.00',
      drawn: '120000.00',
      remaining: '380000.00',
    });
    expect(
      (
        await post(`/tenant/risks/${a.id}/draws`, { amount: '400000', date: '2026-10-02' }, manager)
      ).json(),
    ).toMatchObject({
      code: 'beyond_contingency',
    });
    expect(
      (await post(`/tenant/projects/${projectId}/contingency`, { held: '100000' }, manager)).json(),
    ).toMatchObject({
      code: 'below_drawn',
    });
    // Occurred risks leave the heat map and the expected value: 1,50,000 + 2,000.
    expect(reg.openExpectedValue).toBe('152000.00');
    expect(reg.top.map((t) => t.number)).toEqual(['R-002', 'R-003']);

    // The company calls "possible" 40%: the steel risk is now ₹1,20,000 expected.
    const scales = {
      probability: [
        { level: 1, label: 'Rare', pct: 5 },
        { level: 2, label: 'Unlikely', pct: 20 },
        { level: 3, label: 'Possible', pct: 40 },
        { level: 4, label: 'Likely', pct: 75 },
        { level: 5, label: 'Almost certain', pct: 95 },
      ],
      impact: ['Negligible', 'Minor', 'Moderate', 'Major', 'Severe'].map((label, i) => ({
        level: i + 1,
        label,
      })),
    };
    expect((await post('/tenant/risk-scales', scales, worker)).statusCode).toBe(403);
    await ok(post('/tenant/risk-scales', scales, manager));
    reg = await ok<Reg>(get(`/tenant/projects/${projectId}/risks`, manager));
    expect(reg.risks.find((r) => r.number === 'R-002')!.expectedValue).toBe('120000.00');

    // A company risk, numbered on its own.
    const co = await ok<Reg>(
      post(
        '/tenant/risks',
        {
          category: 'regulatory',
          event: 'GST rate on works contracts changes',
          probability: 2,
          impact: 3,
        },
        manager,
      ),
    );
    expect(co.risks.map((r) => r.number)).toEqual(['R-001']);
    expect(co.contingency).toBeNull();
  });
});
