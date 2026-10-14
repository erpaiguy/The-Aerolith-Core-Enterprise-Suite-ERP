// Company-wide registers and search in a real tenant database (docs/wave7-plan.md steps 7a.3, 7a.6 and 7a.7): every
// register answers; rows from every project a person can see, none from the others; filters; search kept the same way;
// each person's work.
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

describe.skipIf(!controlUrl || !adminUrl)('company-wide registers (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let lata: { id: string; headers: Record<string, string> };
  let projectId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-reg-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'reg-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    lata = await staff('lata', 'worker');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('lists records across the projects a person can see, with filters', async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    const other = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'School, Akola' }, manager))
    ).id;
    await ok(
      post(
        `/tenant/projects/${projectId}/rfis`,
        {
          subject: 'Column C4 size',
          question: 'C4 is 300 on plan, 350 in schedule?',
          assignedTo: workerId,
        },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/ncrs`,
        { description: 'Honeycombing at column C4' },
        manager,
      ),
    );
    await ok(
      post(`/tenant/projects/${other}/ncrs`, { description: 'Cover blocks missing' }, manager),
    );

    // Every register answers, empty or not.
    for (const kind of [
      'daily-reports',
      'client-bills',
      'subcontract-bills',
      'drawings',
      'rfis',
      'inspections',
      'ncrs',
      'stock-issues',
      'stock-transfers',
    ]) {
      const res = await get(`/tenant/registers/${kind}`);
      expect(res.statusCode, `${kind}: ${res.body}`).toBe(200);
      expect(res.json()).toMatchObject({ kind, limited: false });
    }
    expect((await get('/tenant/registers/payslips')).statusCode).toBe(400);
    expect((await get('/tenant/registers/ncrs?from=yesterday')).statusCode).toBe(400);

    interface Rows {
      rows: { number: string; status: string; project: { id: string; name: string } }[];
    }
    const ncrs = (url: string, h: Record<string, string> = t.admin) =>
      ok<Rows>(get(`/tenant/registers/ncrs${url}`, h)).then((r) =>
        r.rows.map((n) => n.project.name).sort(),
      );
    expect(await ncrs('')).toEqual(['Hostel, Washim', 'School, Akola']);
    expect(await ncrs(`?projectId=${other}`)).toEqual(['School, Akola']);
    expect(await ncrs('?q=honeycomb')).toEqual(['Hostel, Washim']);
    expect(await ncrs('?q=akola')).toEqual(['School, Akola']);
    expect(await ncrs('?status=closed')).toEqual([]);
    expect(await ncrs('?from=2000-01-01&to=2000-12-31')).toEqual([]);
    // The worker sees only the project whose team they are on; someone off every team sees nothing.
    expect(await ncrs('', worker)).toEqual(['Hostel, Washim']);
    expect(await ncrs('', lata.headers)).toEqual([]);
    const rfis = await ok<Rows>(get('/tenant/registers/rfis', worker));
    expect(rfis.rows.map((r) => [r.number, r.status, r.project.id])).toEqual([
      ['RFI-001', 'open', projectId],
    ]);
    expect((await ok<Rows>(get('/tenant/registers/rfis', lata.headers))).rows).toEqual([]);
  });

  it('searches projects, tenders, parties, employees and numbers, kept to what each may see', async () => {
    interface Hit {
      kind: string;
      label: string;
      projectId: string | null;
    }
    const find = (q: string, h: Record<string, string> = t.admin) =>
      ok<{ hits: Hit[] }>(get(`/tenant/search?q=${encodeURIComponent(q)}`, h)).then((r) =>
        r.hits.map((x) => `${x.kind}: ${x.label}`).sort(),
      );
    expect((await get('/tenant/search?q=a')).statusCode).toBe(400);
    expect(await find('washim')).toEqual([expect.stringMatching(/^project: .* Hostel, Washim$/)]);
    expect(await find('honeycomb')).toEqual([
      expect.stringMatching(/^ncr: NCR-\d+ Honeycombing at column C4$/),
    ]);
    expect(await find('RFI-001')).toEqual(['rfi: RFI-001 Column C4 size']);
    // The worker sees their own project's records, nothing of the other; someone off every team, neither.
    expect(await find('ncr', worker)).toEqual([expect.stringMatching(/^ncr: .*Honeycombing/)]);
    expect(await find('akola', worker)).toEqual([]);
    expect(await find('washim', lata.headers)).toEqual([]);
    // Parties for everyone; employees only with HR rights.
    await ok(
      post('/tenant/parties', { name: 'Vidarbha Cement Traders', isClient: false, isVendor: true }),
    );
    expect(await find('vidarbha', worker)).toEqual(['party: Vidarbha Cement Traders']);
  });

  it("lists each person's work: RFIs assigned, NCRs raised, nothing of others", async () => {
    interface Section {
      count: number;
      items: { number?: string }[];
    }
    type Work = Record<'approvals' | 'rfis' | 'bills' | 'orders' | 'ncrs' | 'followUps', Section>;
    const work = (h: Record<string, string>) => ok<Work>(get('/tenant/my-work', h));
    const raju = await work(worker);
    expect(raju.rfis.count).toBe(1);
    expect(raju.rfis.items.map((r) => r.number)).toEqual(['RFI-001']);
    expect(raju.ncrs.count).toBe(0);
    const suresh = await work(manager);
    expect(suresh.ncrs.count).toBe(2);
    expect(suresh.rfis.count).toBe(0);
    const none = await work(lata.headers);
    for (const s of Object.values(none)) expect(s).toEqual({ count: 0, items: [] });
  });
});
