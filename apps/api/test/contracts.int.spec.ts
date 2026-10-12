// Contracts and claims (docs/wave4-plan.md step 5) in a real tenant database: the client contract; a performance
// guarantee reminded 30 and 7 days before it expires, rescheduled when extended and dropped when returned; an
// obligation overdue and a notice to answer on the calendar; an extension of time from three hindrances (two on one
// day counted once, a short one not at all), granted in part and moving completion; a claim settled for less.
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

describe.skipIf(!controlUrl || !adminUrl)('contracts and claims (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-contracts-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'contracts-admin@example.in');
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

  it('keeps contracts, securities, the calendar, extensions and claims', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const day = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
    const zp = (await ok<{ id: string }>(post('/tenant/parties', { name: 'Zilla Parishad Akola' })))
      .id;
    const projectId = (
      await ok<{ id: string }>(
        post('/tenant/projects', { name: 'Hostel, Akola', clientId: zp }, manager),
      )
    ).id;
    const siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Akola', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    type Reg = {
      contracts: { id: string; party: string; completionOn: string; dlpEnds: string }[];
      securities: { id: string; validUntil: string; status: string; rowVersion: number }[];
      obligations: { id: string }[];
      eots: {
        id: string;
        number: string;
        daysClaimed: number;
        basis: { byCause: Record<string, number> };
        status: string;
        daysGranted: number | null;
      }[];
      claims: { id: string; number: string; status: string; settledAmount: string | null }[];
      calendar: { date: string; kind: string; what: string; overdue: boolean }[];
    };
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/contracts`,
          { kind: 'client', reference: 'X', title: 'Nope' },
          worker,
        )
      ).statusCode,
    ).toBe(404);
    const created = await ok<Reg & { id: string }>(
      post(
        `/tenant/projects/${projectId}/contracts`,
        {
          kind: 'client',
          reference: 'ZP/AKL/2026/14',
          title: 'Construction of a 100-bed hostel',
          value: '1000000',
          signedOn: '2026-04-10',
          startOn: '2026-04-20',
          completionOn: '2027-03-31',
          dlpMonths: 12,
          ldPctPerWeek: '0.5',
          ldCapPct: '10',
        },
        manager,
      ),
    );
    const contractId = created.id;
    expect(created.contracts[0]).toMatchObject({
      party: 'Zilla Parishad Akola',
      dlpEnds: '2028-03-31',
    });

    // The performance guarantee, ₹50,000, valid for 60 more days: reminded 30 and 7 days before.
    const reminders = async () =>
      (
        await db<{ due: string; title: string }[]>`
          SELECT to_char(due_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS due, title FROM platform.notification
          WHERE source LIKE 'contract-security:%' ORDER BY due_at`
      ).map((r) => r.due);
    let reg = await ok<Reg>(
      post(
        `/tenant/contracts/${contractId}/securities`,
        {
          kind: 'performance',
          issuer: 'SBI Akola',
          number: 'BG/0042',
          amount: '50000',
          validUntil: day(60),
        },
        manager,
      ),
    );
    expect(await reminders()).toEqual([day(30), day(53)]);
    // Extended by 30 days: the reminders move with it.
    const bg = reg.securities[0]!;
    await ok<Reg>(
      post(
        `/tenant/contract-securities/${bg.id}`,
        { validUntil: day(90), status: 'held', rowVersion: bg.rowVersion },
        manager,
      ),
    );
    expect(await reminders()).toEqual([day(60), day(83)]);

    // An obligation already overdue, and a notice to answer in 10 days.
    await ok<Reg>(
      post(
        `/tenant/contracts/${contractId}/obligations`,
        { title: 'Submit the monthly progress report', clause: 'GCC 12', dueOn: day(-1) },
        manager,
      ),
    );
    reg = await ok<Reg>(
      post(
        `/tenant/contracts/${contractId}/notices`,
        {
          direction: 'received',
          subject: 'Slow progress on block B',
          clause: 'GCC 45',
          dated: day(0),
          reference: 'EE/AKL/171',
          replyBy: day(10),
        },
        manager,
      ),
    );
    expect(reg.calendar.map((c) => [c.kind, c.date, c.overdue])).toEqual([
      ['obligation', day(-1), true],
      ['notice', day(10), false],
      ['security', day(90), false],
      ['completion', '2027-03-31', false],
      ['dlp', '2028-03-31', false],
    ]);

    // Hindrances in September: on the 3rd drawings (3 h, client) and rain (2 h, neutral), one day; on the 4th a client
    // decision of 3 h, not a day; on the 5th 8 h of rain, a day; on the 6th the contractor's own labour, not counted.
    const report = async (reportDate: string, hindrances: object[]) => {
      const r = await ok<{ id: string; rowVersion: number }>(
        post(`/tenant/projects/${projectId}/daily-reports`, { siteId, reportDate }, manager),
      );
      const s = await ok<{ rowVersion: number }>(
        post(`/tenant/daily-reports/${r.id}`, { rowVersion: r.rowVersion, hindrances }, manager),
      );
      await ok(post(`/tenant/daily-reports/${r.id}/submit`, { rowVersion: s.rowVersion }, manager));
    };
    await report('2026-09-03', [
      {
        cause: 'drawings',
        description: 'Column schedule for block B awaited',
        hours: '3',
        account: 'client',
      },
      { cause: 'rain', description: 'Rain', hours: '2', account: 'neutral' },
    ]);
    await report('2026-09-04', [
      {
        cause: 'client_decision',
        description: 'Tile colour not chosen',
        hours: '3',
        account: 'client',
      },
    ]);
    await report('2026-09-05', [
      { cause: 'rain', description: 'Heavy rain', hours: '8', account: 'neutral' },
    ]);
    await report('2026-09-06', [
      { cause: 'labour', description: 'Masons absent', hours: '8', account: 'contractor' },
    ]);
    expect(
      await ok(
        get(`/tenant/contracts/${contractId}/eot-basis?from=2026-09-01&to=2026-09-30`, manager),
      ),
    ).toMatchObject({
      days: 2,
      byCause: { drawings: 1, rain: 1 },
      dates: ['2026-09-03', '2026-09-05'],
    });
    reg = await ok<Reg>(
      post(
        `/tenant/contracts/${contractId}/eots`,
        { from: '2026-09-01', to: '2026-09-30' },
        manager,
      ),
    );
    const eot = reg.eots[0]!;
    expect([eot.number, eot.daysClaimed, eot.basis.byCause]).toEqual([
      'EOT-01',
      2,
      { drawings: 1, rain: 1 },
    ]);
    await ok(post(`/tenant/eots/${eot.id}`, { action: 'submit' }, manager));
    expect(
      (
        await post(
          `/tenant/eots/${eot.id}`,
          { action: 'decide', daysGranted: 3, reference: 'X', date: '2026-10-10' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'more_than_claimed' });
    // One day granted: completion moves to 1 April.
    reg = await ok<Reg>(
      post(
        `/tenant/eots/${eot.id}`,
        { action: 'decide', daysGranted: 1, reference: 'EE/AKL/180', date: '2026-10-10' },
        manager,
      ),
    );
    expect([reg.eots[0]!.status, reg.eots[0]!.daysGranted, reg.contracts[0]!.completionOn]).toEqual(
      ['granted', 1, '2027-04-01'],
    );

    // A claim for prolongation of ₹2,00,000 on the extension, settled for ₹1,20,000.
    reg = await ok<Reg>(
      post(
        `/tenant/contracts/${contractId}/claims`,
        {
          kind: 'prolongation',
          title: 'Site overheads for the extended period',
          amount: '200000',
          evidence: 'EOT-01',
          eotId: eot.id,
        },
        manager,
      ),
    );
    const cl = reg.claims[0]!;
    expect(cl.number).toBe('CL-01');
    await ok(post(`/tenant/claims/${cl.id}/status`, { status: 'submitted' }, manager));
    await ok(post(`/tenant/claims/${cl.id}/status`, { status: 'negotiation' }, manager));
    expect(
      (
        await post(
          `/tenant/claims/${cl.id}/status`,
          { status: 'settled', settledAmount: '250000', date: '2026-10-11' },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'more_than_claimed' });
    reg = await ok<Reg>(
      post(
        `/tenant/claims/${cl.id}/status`,
        { status: 'settled', settledAmount: '120000', date: '2026-10-11' },
        manager,
      ),
    );
    expect([reg.claims[0]!.status, reg.claims[0]!.settledAmount]).toEqual(['settled', '120000.00']);

    // The guarantee returned: no reminders left.
    const held = reg.securities[0]!;
    await ok(
      post(
        `/tenant/contract-securities/${held.id}`,
        { validUntil: held.validUntil, status: 'returned', rowVersion: held.rowVersion },
        manager,
      ),
    );
    expect(await reminders()).toEqual([]);
  });
});
