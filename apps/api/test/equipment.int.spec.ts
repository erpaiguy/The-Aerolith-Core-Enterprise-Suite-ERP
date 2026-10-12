// Equipment and fleet in a real tenant database (docs/wave3-plan.md step 10), every figure by hand: an own excavator
// moved between projects, a crane hired by the hour with a monthly minimum and a mixer hired by the month; September's
// log sheets (refusals for overlapping readings, a machine not on a project, a stranger); fuel against the norm;
// maintenance falling due by days and not yet by hours; the daily report showing the logs; the month costed.
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

describe.skipIf(!controlUrl || !adminUrl)('equipment and fleet (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-eqp-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'eqp-admin@example.in');
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

  let entityId: string;
  let p1: string;
  let p2: string;
  let s1: string;
  let s2: string;
  let ex: string;
  let crane: string;
  let mixer: string;
  const put = (url: string, payload: object) => post(url, payload, manager);

  it('registers own and hired machines, allocates them and keeps their log sheets', async () => {
    const company = (
      await ok<{ companies: { id: string; rowVersion: number }[] }>(get('/tenant/companies'))
    ).companies[0]!;
    entityId = company.id;
    await ok(
      post(`/tenant/companies/${entityId}`, {
        name: 'Amravati Roads Pvt Ltd',
        gstin: '27AAACA7777R1Z2',
        booksFrom: '2026-04-01',
        rowVersion: company.rowVersion,
      }),
    );
    p1 = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Ring road, Amravati' }, manager))
    ).id;
    p2 = (await ok<{ id: string }>(post('/tenant/projects', { name: 'Flyover, Badnera' }, manager)))
      .id;
    s1 = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${p1}/sites`, { name: 'Ring road', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    s2 = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${p2}/sites`, { name: 'Flyover', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    const supplier = async (name: string, gstin: string) =>
      (
        await ok<{ id: string }>(
          post('/tenant/parties', { name, isClient: false, isVendor: true, gstin }),
        )
      ).id;
    const cranes = await supplier('Vidarbha Cranes', '27AAAFV1111C1Z5');
    const mixers = await supplier('Akola Mixers', '27AAAFA2222M1Z5');
    const add = (body: object, as = manager) =>
      post('/tenant/equipment', { entityId, ...body }, as);
    expect(
      (
        await add(
          { code: 'EX-01', name: 'Excavator 20 t', category: 'excavator', ownership: 'own' },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await add({
          code: 'CR-07',
          name: 'Crane 40 t',
          category: 'crane',
          ownership: 'hired',
          partyId: cranes,
        })
      ).json(),
    ).toMatchObject({ code: 'hire_terms' });
    ex = (
      await ok<{ id: string }>(
        add({
          code: 'EX-01',
          name: 'Excavator 20 t',
          category: 'excavator',
          ownership: 'own',
          internalRate: '1500',
          fuelNorm: '12',
        }),
      )
    ).id;
    crane = (
      await ok<{ id: string }>(
        add({
          code: 'CR-07',
          name: 'Crane 40 t',
          category: 'crane',
          ownership: 'hired',
          partyId: cranes,
          hireBasis: 'hour',
          hireRate: '2000',
          minHours: '200',
          operatorBy: 'hirer',
        }),
      )
    ).id;
    mixer = (
      await ok<{ id: string }>(
        add({
          code: 'TM-03',
          name: 'Transit mixer',
          category: 'mixer',
          ownership: 'hired',
          partyId: mixers,
          hireBasis: 'month',
          hireRate: '60000',
        }),
      )
    ).id;
    // The excavator on the ring road from 1 September, the flyover from the 16th; the crane on the ring road; the mixer
    // on the flyover from the 11th.
    const allocate = (id: string, date: string, projectId: string, siteId: string) =>
      post(`/tenant/equipment/${id}/allocate`, { date, projectId, siteId }, manager);
    await ok(allocate(ex, '2026-09-01', p1, s1));
    await ok(allocate(ex, '2026-09-16', p2, s2));
    await ok(allocate(crane, '2026-09-01', p1, s1));
    await ok(allocate(mixer, '2026-09-11', p2, s2));
    expect((await allocate(mixer, '2026-09-11', p1, s2)).json()).toMatchObject({
      code: 'not_this_project',
    });

    const log = (id: string, body: object, as = manager) =>
      post(`/tenant/equipment/${id}/logs`, body, as);
    await ok(
      log(ex, {
        date: '2026-09-01',
        startReading: '1000',
        endReading: '1008',
        operator: 'Sakharam',
      }),
    );
    await ok(log(ex, { date: '2026-09-02', startReading: '1008', endReading: '1016.5' }));
    await ok(
      log(ex, {
        date: '2026-09-16',
        startReading: '1016.5',
        endReading: '1026.5',
        idleHours: '2',
        idleReason: 'No diesel',
      }),
    );
    expect(
      (await log(ex, { date: '2026-09-20', startReading: '1020', endReading: '1022' })).json(),
    ).toMatchObject({
      code: 'reading_overlap',
    });
    expect(
      (await log(ex, { date: '2026-09-03', worked: '20', idleHours: '5' })).json(),
    ).toMatchObject({ code: 'over_a_day' });
    expect((await log(mixer, { date: '2026-09-05', worked: '6' })).json()).toMatchObject({
      code: 'not_allocated',
    });
    expect((await log(crane, { date: '2026-09-05', worked: '9' }, worker)).statusCode).toBe(404);
    await ok(log(crane, { date: '2026-09-05', worked: '9' }));
    await ok(log(crane, { date: '2026-09-06', worked: '8', breakdownHours: '3' }));
    // A move before the last log sheet is refused.
    expect((await allocate(ex, '2026-09-02', p2, s2)).json()).toMatchObject({
      code: 'logged_after',
    });

    // The ring road's daily report for 1 September shows the excavator's log.
    const dr = await ok<{ id: string }>(
      post(
        `/tenant/projects/${p1}/daily-reports`,
        { siteId: s1, reportDate: '2026-09-01' },
        manager,
      ),
    );
    const r = await ok<{ equipmentLogs: { code: string; worked: string }[] }>(
      get(`/tenant/daily-reports/${dr.id}`, manager),
    );
    expect(r.equipmentLogs.map((l) => [l.code, l.worked])).toEqual([['EX-01', '8.0']]);
  });

  it('weighs fuel against the norm and keeps maintenance', async () => {
    // 400 litres for 26.5 hours: 15.09 an hour against 12, 25.8% over.
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const [store] = await db<{ id: string }[]>`
      INSERT INTO proc.store (project_id, site_id, name) VALUES (${p1}, ${s1}, 'Ring road store') RETURNING id`;
    const [wbs] = await db<
      { id: string }[]
    >`INSERT INTO proj.wbs (project_id, code, name) VALUES (${p1}, 'EQ', 'Equipment') RETURNING id`;
    const [hsd] = await db<{ id: string }[]>`
      INSERT INTO est.resource (code, name, kind, unit) VALUES ('HSD', 'High speed diesel', 'material', 'litre') RETURNING id`;
    const [issue] = await db<{ id: string }[]>`
      INSERT INTO proc.stock_issue (project_id, store_id, number, issued_on, wbs_id, issued_to, equipment_id)
      VALUES (${p1}, ${store!.id}, 'ISS/2026-27/0901', '2026-09-10', ${wbs!.id}, 'Sakharam', ${ex}) RETURNING id`;
    await db`INSERT INTO proc.stock_issue_line (issue_id, position, resource_id, qty, value) VALUES (${issue!.id}, 1, ${hsd!.id}, 400, 36000)`;
    const f = await ok<{
      rows: {
        code: string;
        worked: string;
        litres: string;
        perUnit: string;
        offPct: number;
        flagged: boolean;
      }[];
    }>(get(`/tenant/equipment/fuel?entityId=${entityId}&from=2026-09-01&to=2026-09-30`, manager));
    expect(f.rows.find((x) => x.code === 'EX-01')).toMatchObject({
      worked: '26.5',
      litres: '400.00',
      perUnit: '15.09',
      offPct: 25.8,
      flagged: true,
    });

    // An oil change every 250 hours from 800 (due at 1,050; the meter is at 1,026.5); an inspection every 15 days from
    // 1 September (due on the 16th).
    await ok(
      put(`/tenant/equipment/${ex}/maintenance-plans`, {
        name: 'Oil change',
        everyHours: '250',
        fromDate: '2026-09-01',
        fromReading: '800',
      }),
    );
    await ok(
      put(`/tenant/equipment/${ex}/maintenance-plans`, {
        name: 'Inspection',
        everyDays: 15,
        fromDate: '2026-09-01',
      }),
    );
    type Due = {
      reading: string;
      plans: {
        id: string;
        name: string;
        dueAtReading: string | null;
        dueOn: string | null;
        due: boolean;
      }[];
    };
    let m = await ok<Due>(get(`/tenant/equipment/${ex}/maintenance?asOf=2026-09-30`, manager));
    expect([m.reading, m.plans.map((p) => [p.name, p.dueAtReading, p.dueOn, p.due])]).toEqual([
      '1026.5',
      [
        ['Inspection', null, '2026-09-16', true],
        ['Oil change', '1050.0', null, false],
      ],
    ]);
    // Inspected on the 17th: due again on 2 October.
    await ok(
      put(`/tenant/equipment/${ex}/maintenance-records`, {
        planId: m.plans[0]!.id,
        kind: 'service',
        doneOn: '2026-09-17',
        reading: '1026.5',
        description: 'Monthly inspection, hoses replaced',
        cost: '4500',
      }),
    );
    m = await ok<Due>(get(`/tenant/equipment/${ex}/maintenance?asOf=2026-09-30`, manager));
    expect(m.plans.map((p) => [p.name, p.dueOn, p.due])).toEqual([
      ['Inspection', '2026-10-02', false],
      ['Oil change', null, false],
    ]);
  });

  it('costs September: own hours charged to projects, the hire bills from the log sheets', async () => {
    // Excavator: 16.5 hours on the ring road (24,750) and 10 on the flyover (15,000) at 1,500.
    // Crane: 17 hours at 2,000 (34,000) and the 183 short of 200 (3,66,000): 4,00,000.
    // Mixer: 20 of September's 30 days on the flyover: 40,000.
    const pre = await ok<{
      internalTotal: string;
      own: { equipment: string; qty: string; amount: string }[];
      hired: { equipment: string; total: string; lines: { qty: string; amount: string }[] }[];
    }>(get(`/tenant/equipment/costing?entityId=${entityId}&month=2026-09`, manager));
    expect(pre.internalTotal).toBe('39750.00');
    expect(pre.own.map((o) => [o.equipment, o.qty, o.amount])).toEqual([
      ['EX-01', '16.5', '24750.00'],
      ['EX-01', '10.0', '15000.00'],
    ]);
    expect(
      pre.hired.map((h) => [h.equipment, h.total, h.lines.map((l) => [l.qty, l.amount])]),
    ).toEqual([
      [
        'CR-07',
        '400000.00',
        [
          ['17.0', '34000.00'],
          ['183.0', '366000.00'],
        ],
      ],
      ['TM-03', '40000.00', [['1', '40000.00']]],
    ]);
    expect(
      (await post('/tenant/equipment/costing', { entityId, month: '2026-09' }, worker)).statusCode,
    ).toBe(403);
    const done = await ok<{
      done: { voucher: string; hireBills: { billNo: string; total: string }[] };
    }>(post('/tenant/equipment/costing', { entityId, month: '2026-09' }, manager));
    expect(done.done.voucher).toBe('JV/2026-27/0001');
    // With GST at 18%: 4,72,000 and 47,200.
    expect(done.done.hireBills.map((b) => [b.billNo, b.total])).toEqual([
      ['HIRE/CR-07/2026-09', '472000.00'],
      ['HIRE/TM-03/2026-09', '47200.00'],
    ]);
    expect(
      (await post('/tenant/equipment/costing', { entityId, month: '2026-09' }, manager)).json(),
    ).toMatchObject({
      code: 'month_costed',
    });
  });
});
