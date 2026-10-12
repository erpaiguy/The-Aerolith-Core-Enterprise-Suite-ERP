// HR in a real tenant database (docs/wave3-plan.md step 11), every figure by hand: designations that add permissions
// and approve leave; employees with the DPDP rule for Aadhaar and masked PAN and bank numbers; calendars and
// deployment; a site's register, a biometric file and the phone; leave counted on working days, refused over the
// balance and against attendance; September's days for payroll; the year's leave carried forward.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
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

describe.skipIf(!controlUrl || !adminUrl)('HR (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let rajuId: string;
  let sureshId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-hr-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'hr-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker] = [m.headers, w.headers];
    [sureshId, rajuId] = [m.id, w.id];
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  let entityId: string;
  let projectId: string;
  let siteId: string;
  let hrManager: string;
  let timeKeeper: string;
  let siteEngineer: string;
  let sites: string;
  let suresh: string;
  let raju: string;
  let meena: string;
  let el: string;
  let cl: string;
  let lop: string;
  const put = (url: string, payload: object, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'PUT', url: `/api${url}`, payload, headers });
  const upload = (content: string) => {
    const boundary = '----hr' + Math.random().toString(16).slice(2);
    return app.inject({
      method: 'POST',
      url: `/api/tenant/hr/attendance/import?entityId=${entityId}`,
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="punches.csv"\r\n` +
          `Content-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`,
      ),
      headers: { ...t.admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };

  it('keeps designations, calendars and employees, with the DPDP rule and masked numbers', async () => {
    entityId = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies'))).companies[0]!
      .id;
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Ring road, Amravati' }, manager))
    ).id;
    siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(
          `/tenant/projects/${projectId}/sites`,
          { name: 'Ring road', stateCode: '27' },
          manager,
        ),
      )
    ).sites[0]!.id;

    // Designations: only HR (here the admin) keeps them; a manager may not by default.
    expect((await get(`/tenant/hr/employees?entityId=${entityId}`, worker)).statusCode).toBe(403);
    expect(
      (await post('/tenant/hr/designations', { name: 'HR manager' }, manager)).statusCode,
    ).toBe(403);
    expect(
      (
        await post('/tenant/hr/designations', { name: 'Clerk', permissions: ['hr.everything'] })
      ).json(),
    ).toMatchObject({ code: 'unknown_permission' });
    hrManager = (
      await ok<{ id: string }>(
        post('/tenant/hr/designations', { name: 'HR manager', permissions: ['hr.edit'] }),
      )
    ).id;
    timeKeeper = (
      await ok<{ id: string }>(
        post('/tenant/hr/designations', { name: 'Time keeper', permissions: ['hr.view'] }),
      )
    ).id;
    siteEngineer = (
      await ok<{ id: string }>(post('/tenant/hr/designations', { name: 'Site engineer' }))
    ).id;
    expect((await post('/tenant/hr/designations', { name: 'site ENGINEER' })).json()).toMatchObject(
      {
        code: 'designation_exists',
      },
    );

    // Calendars: the head office works Monday to Friday; the sites Monday to Saturday; 2 October off for both.
    const head = await ok<{ id: string; name: string }[]>(
      post('/tenant/hr/calendars', {
        entityId,
        name: 'Head office',
        workWeek: 31,
        isDefault: true,
      }),
    );
    const all = await ok<{ id: string; name: string; isDefault: boolean }[]>(
      post('/tenant/hr/calendars', { entityId, name: 'Sites', workWeek: 63 }),
    );
    sites = all.find((c) => c.name === 'Sites')!.id;
    expect(all.find((c) => c.name === 'Head office')!.isDefault).toBe(true);
    await ok(
      put(`/tenant/hr/calendars/${head[0]!.id}/holidays`, {
        day: '2026-10-02',
        name: 'Gandhi Jayanti',
      }),
    );
    const withHoliday = await ok<{ id: string; holidays: { day: string; name: string }[] }[]>(
      put(`/tenant/hr/calendars/${sites}/holidays`, { day: '2026-10-02', name: 'Gandhi Jayanti' }),
    );
    expect(withHoliday.find((c) => c.id === sites)!.holidays).toEqual([
      { day: '2026-10-02', name: 'Gandhi Jayanti' },
    ]);
    expect(
      await ok(
        put(`/tenant/hr/sites/${siteId}`, {
          calendarId: sites,
          latitude: '20.9374',
          longitude: '77.7796',
          radiusM: 150,
        }),
      ),
    ).toMatchObject({ calendar: 'Sites', latitude: '20.937400', radiusM: 150 });

    // Employees. Aadhaar: never the full number, and its last four only with consent.
    const base = { entityId, kind: 'staff', joinedOn: '2024-01-10' };
    expect(
      (
        await post('/tenant/hr/employees', {
          ...base,
          code: 'E001',
          name: 'Suresh Patil',
          aadhaarLast4: '123456789012',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post('/tenant/hr/employees', {
          ...base,
          code: 'E001',
          name: 'Suresh Patil',
          aadhaarLast4: '9012',
        })
      ).json(),
    ).toMatchObject({ code: 'aadhaar_consent' });
    suresh = (
      await ok<{ id: string }>(
        post('/tenant/hr/employees', {
          ...base,
          code: 'E001',
          name: 'Suresh Patil',
          designationId: hrManager,
          department: 'Administration',
          userId: sureshId,
          pan: 'abcps1234k',
          uan: '100200300400',
          aadhaarLast4: '9012',
          aadhaarConsentOn: '2024-01-10',
          bankAccount: '123456789012',
          bankIfsc: 'sbin0001234',
          bankName: 'State Bank of India',
        }),
      )
    ).id;
    raju = (
      await ok<{ id: string }>(
        post('/tenant/hr/employees', {
          ...base,
          code: 'E002',
          name: 'Raju Shinde',
          kind: 'worker',
          joinedOn: '2026-03-20',
          designationId: timeKeeper,
          managerId: suresh,
          userId: rajuId,
          esiNumber: '3100123456',
        }),
      )
    ).id;
    meena = (
      await ok<{ id: string }>(
        post('/tenant/hr/employees', {
          ...base,
          code: 'E003',
          name: 'Meena Kale',
          joinedOn: '2025-06-01',
          designationId: siteEngineer,
          managerId: suresh,
          pan: 'BKLPK4321M',
        }),
      )
    ).id;
    expect(
      (await post('/tenant/hr/employees', { ...base, code: 'e003', name: 'Another Meena' })).json(),
    ).toMatchObject({ code: 'employee_exists' });
    expect(
      (
        await post('/tenant/hr/employees', {
          ...base,
          code: 'E004',
          name: 'Raju again',
          userId: rajuId,
        })
      ).json(),
    ).toMatchObject({ code: 'user_taken' });

    // A designation adds to the role: the time keeper (a worker) now sees the employees; the HR manager keeps them.
    expect(await ok<string[]>(get('/tenant/permissions/mine', worker))).toContain('hr.view');
    const list = await ok<{ code: string; designation: string; manager: string | null }[]>(
      get(`/tenant/hr/employees?entityId=${entityId}`, worker),
    );
    expect(list.map((e) => [e.code, e.designation, e.manager])).toEqual([
      ['E001', 'HR manager', null],
      ['E002', 'Time keeper', 'Suresh Patil'],
      ['E003', 'Site engineer', 'Suresh Patil'],
    ]);
    // Without hr.edit the PAN and the account show their last four only; HR and the employee see them in full.
    expect(await ok(get(`/tenant/hr/employees/${suresh}`, worker))).toMatchObject({
      pan: '••••••234K',
      bankAccount: '••••••••9012',
      bankIfsc: 'SBIN0001234',
      aadhaarLast4: '9012',
      masked: true,
    });
    expect(await ok(get(`/tenant/hr/employees/${suresh}`, manager))).toMatchObject({
      pan: 'ABCPS1234K',
      bankAccount: '123456789012',
      masked: false,
    });
    expect(await ok(get(`/tenant/hr/employees/${raju}`, worker))).toMatchObject({ masked: false });
    // A masked number sent back unchanged changes nothing; an old version is refused.
    const m = await ok<{ rowVersion: number; pan: string }>(
      get(`/tenant/hr/employees/${meena}`, worker),
    );
    expect(m.pan).toBe('••••••321M');
    expect(
      await ok(
        put(
          `/tenant/hr/employees/${meena}`,
          { pan: m.pan, grade: 'E2', rowVersion: m.rowVersion },
          manager,
        ),
      ),
    ).toMatchObject({ pan: 'BKLPK4321M', grade: 'E2' });
    expect(
      (
        await put(
          `/tenant/hr/employees/${meena}`,
          { grade: 'E3', rowVersion: m.rowVersion },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'stale' });

    // Deployment: from a date, never before joining, never behind the last.
    expect(
      (
        await post(`/tenant/hr/employees/${raju}/deployments`, {
          from: '2026-03-01',
          projectId,
          siteId,
        })
      ).json(),
    ).toMatchObject({ code: 'not_in_service' });
    for (const id of [raju, meena])
      await ok(
        post(`/tenant/hr/employees/${id}/deployments`, { from: '2026-09-01', projectId, siteId }),
      );
    expect(
      (
        await post(`/tenant/hr/employees/${meena}/deployments`, {
          from: '2026-08-15',
          projectId: null,
        })
      ).json(),
    ).toMatchObject({ code: 'deployment_after' });
    expect(
      (
        await ok<{ deployments: { from: string; site: string }[] }>(
          get(`/tenant/hr/employees/${meena}`),
        )
      ).deployments,
    ).toEqual([expect.objectContaining({ from: '2026-09-01', site: 'Ring road' })]);
  });

  it("marks a site's register, imports a device's punches and the phone's", async () => {
    // Raju sees the register (his designation) but marks it only once on the project's team.
    const marks = {
      date: '2026-09-07',
      marks: [
        { employeeId: raju, status: 'present', inTime: '09:00', outTime: '18:00' },
        {
          employeeId: meena,
          status: 'half_day',
          inTime: '09:00',
          outTime: '13:00',
          note: 'Left for the bank',
        },
      ],
    };
    expect((await post(`/tenant/hr/sites/${siteId}/attendance`, marks, worker)).statusCode).toBe(
      404,
    );
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: rajuId, role: 'member' }, manager),
    );
    expect(
      (
        await post(
          `/tenant/hr/sites/${siteId}/attendance`,
          { date: '2026-09-07', marks: [{ employeeId: suresh, status: 'present' }] },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'not_deployed' });
    expect(
      (
        await post(
          `/tenant/hr/sites/${siteId}/attendance`,
          { ...marks, date: '2099-01-01' },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'future_day' });
    const register = await ok<{
      rows: { code: string; status: string; inTime: string; day: string }[];
    }>(post(`/tenant/hr/sites/${siteId}/attendance`, marks, worker));
    expect(register.rows.map((r) => [r.code, r.day, r.status, r.inTime])).toEqual([
      ['E002', 'work', 'present', '09:00'],
      ['E003', 'work', 'half_day', '09:00'],
    ]);

    // The device's file: a full day, a short day, a single punch, a day already on the register, a stranger.
    const res = await ok<{
      imported: number;
      problems: { code: string; day: string; reason: string }[];
    }>(
      upload(
        [
          'Emp Code,Name,Date,Time',
          'E002,Raju,08/09/2026,08:58',
          'E002,Raju,08/09/2026,17:30',
          'E003,Meena,08/09/2026,09:00',
          'E003,Meena,08/09/2026,12:00',
          'E002,Raju,09/09/2026,09:10',
          'E003,Meena,07/09/2026,09:30',
          'E999,Who,08/09/2026,09:00',
        ].join('\n'),
      ),
    );
    expect(res.imported).toBe(3);
    expect(res.problems).toEqual([
      { code: 'E003', day: '2026-09-07', reason: 'Already marked on the register or the phone' },
      { code: 'E999', day: '2026-09-08', reason: 'No such employee' },
    ]);
    const day8 = await ok<{
      rows: { code: string; status: string; source: string; flag: string | null }[];
    }>(get(`/tenant/hr/sites/${siteId}/attendance?date=2026-09-09`, worker));
    expect(day8.rows.map((r) => [r.code, r.status, r.source, r.flag])).toEqual([
      ['E002', 'present', 'biometric', 'single_punch'],
      ['E003', null, null, null],
    ]);

    // The phone: Raju 1.4 km from the site (flagged), out again within four hours (a half day); Suresh at the head
    // office, which has no location.
    const away = await ok<{ today: { status: string; flag: string; distanceM: number } }>(
      post(
        '/tenant/hr/attendance/me',
        { action: 'in', latitude: 20.95, longitude: 77.7796 },
        worker,
      ),
    );
    expect(away.today).toMatchObject({ status: 'present', flag: 'outside_site', distanceM: 1401 });
    expect(
      (
        await post(
          '/tenant/hr/attendance/me',
          { action: 'in', latitude: 20.9374, longitude: 77.7796 },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'already_marked' });
    expect(
      (
        await ok<{ today: { status: string; outTime: string | null } }>(
          post(
            '/tenant/hr/attendance/me',
            { action: 'out', latitude: 20.9374, longitude: 77.7796 },
            worker,
          ),
        )
      ).today,
    ).toMatchObject({ status: 'half_day' });
    expect(
      (
        await ok<{ today: { flag: string } }>(
          post(
            '/tenant/hr/attendance/me',
            { action: 'in', latitude: 20.9, longitude: 77.7 },
            manager,
          ),
        )
      ).today.flag,
    ).toBe('no_site_location');
    expect(
      (await post('/tenant/hr/attendance/me', { action: 'in', latitude: 1, longitude: 1 })).json(),
    ).toMatchObject({ code: 'not_an_employee' });
  });

  it('takes leave through its designation approver, counting working days only', async () => {
    const types = await ok<{ id: string; code: string }[]>(
      post('/tenant/hr/leave-types', { code: 'cl', name: 'Casual leave', daysPerYear: 12 }),
    );
    cl = types.find((x) => x.code === 'CL')!.id;
    el = (
      await ok<{ id: string; code: string }[]>(
        post('/tenant/hr/leave-types', {
          code: 'EL',
          name: 'Earned leave',
          daysPerYear: '15',
          accrual: 'monthly',
          carryForwardMax: '30',
        }),
      )
    ).find((x) => x.code === 'EL')!.id;
    lop = (
      await ok<{ id: string; code: string }[]>(
        post('/tenant/hr/leave-types', { code: 'LOP', name: 'Loss of pay', paid: false }),
      )
    ).find((x) => x.code === 'LOP')!.id;
    await ok(
      put(`/tenant/hr/employees/${meena}/leave-openings`, {
        year: 2026,
        leaveTypeId: el,
        days: '5',
      }),
    );
    // Leave goes to whoever holds "HR manager".
    expect(
      (
        await post('/tenant/approval-rules/leave_application', {
          rules: [{ minAmount: '0', approver: 'designation', designationId: randomUUID() }],
        })
      ).json(),
    ).toMatchObject({ code: 'designation_not_found' });
    const rules = await ok<{ types: { docType: string; rules: { designationName: string }[] }[] }>(
      post('/tenant/approval-rules/leave_application', {
        rules: [{ minAmount: '0', approver: 'designation', designationId: hrManager }],
      }),
    );
    expect(rules.types.find((x) => x.docType === 'leave_application')!.rules).toEqual([
      expect.objectContaining({ approver: 'designation', designationName: 'HR manager' }),
    ]);

    // HR applies for Meena (no sign-in): 28 September to 3 October is five working days (2 October a holiday, 4th a
    // Sunday not asked); 5 opening + 12.5 accrued by October.
    const meenaLeave = await ok<{ id: string; days: string; status: string }>(
      post('/tenant/hr/leave', {
        employeeId: meena,
        leaveTypeId: el,
        from: '2026-09-28',
        to: '2026-10-03',
        reason: 'Sister’s wedding',
      }),
    );
    expect(meenaLeave).toMatchObject({ days: '5.0', status: 'pending' });
    const waiting = await ok<{ id: string; title: string }[]>(
      get('/tenant/approvals?view=waiting', manager),
    );
    const request = waiting.find((w) => w.title.startsWith('Meena Kale'))!;
    expect(request.title).toBe('Meena Kale: Earned leave, 2026-09-28 to 2026-10-03');
    expect((await get('/tenant/approvals?view=waiting', worker)).json()).toEqual([]);
    expect(
      (
        await ok<{ steps: { approverName: string }[] }>(
          get(`/tenant/approvals/${request.id}`, manager),
        )
      ).steps[0]!.approverName,
    ).toBe('HR manager');
    await ok(post(`/tenant/approvals/${request.id}/approve`, {}, manager));
    expect(await ok(get(`/tenant/hr/leave/${meenaLeave.id}`))).toMatchObject({
      status: 'approved',
    });
    expect(
      (
        await post(
          `/tenant/hr/sites/${siteId}/attendance`,
          { date: '2026-09-29', marks: [{ employeeId: meena, status: 'present' }] },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'on_leave' });

    // Raju applies for himself: not on a day he worked; a half day; not more than he has (10 for joining in March, less
    // the half: 9.5, against 11 working days); not twice; unpaid leave needs no balance; one withdrawn.
    const apply = (b: object) => post('/tenant/hr/leave', { leaveTypeId: cl, ...b }, worker);
    expect((await apply({ from: '2026-09-07', to: '2026-09-07' })).json()).toMatchObject({
      code: 'attended',
    });
    const half = await ok<{ id: string; days: string }>(
      apply({ from: '2026-09-14', to: '2026-09-14', halfDay: true }),
    );
    expect(half.days).toBe('0.5');
    expect((await apply({ from: '2026-09-15', to: '2026-09-26' })).json()).toMatchObject({
      code: 'not_enough_leave',
      message: 'Casual leave: 9.5 days available by 2026-09-26, 11.0 asked.',
    });
    expect((await apply({ from: '2026-09-14', to: '2026-09-14' })).json()).toMatchObject({
      code: 'leave_overlaps',
    });
    const unpaid = await ok<{ id: string; days: string }>(
      apply({ leaveTypeId: lop, from: '2026-09-22', to: '2026-09-22' }),
    );
    const dropped = await ok<{ id: string }>(apply({ from: '2026-09-24', to: '2026-09-24' }));
    expect(await ok(post(`/tenant/hr/leave/${dropped.id}/withdraw`, {}, worker))).toMatchObject({
      status: 'withdrawn',
    });
    for (const w of await ok<{ id: string; title: string }[]>(
      get('/tenant/approvals?view=waiting', manager),
    ))
      await ok(post(`/tenant/approvals/${w.id}/approve`, {}, manager));
    expect(await ok(get(`/tenant/hr/leave/${half.id}`, worker))).toMatchObject({
      status: 'approved',
    });
    expect(await ok(get(`/tenant/hr/leave/${unpaid.id}`, worker))).toMatchObject({
      status: 'approved',
    });

    const balances = await ok<{ balances: Record<string, string | boolean | null>[] }>(
      get(`/tenant/hr/employees/${meena}/leave?year=2026&asOf=2026-10-31`, manager),
    );
    expect(balances.balances.find((b) => b.code === 'EL')).toMatchObject({
      opening: '5.0',
      accrued: '12.5',
      taken: '5.0',
      pending: '0.0',
      available: '12.5',
    });
    expect(
      (
        await ok<{ balances: Record<string, string | null>[] }>(
          get(`/tenant/hr/employees/${raju}/leave?year=2026&asOf=2026-10-31`, worker),
        )
      ).balances.map((b) => [b.code, b.accrued, b.taken, b.available]),
    ).toEqual([
      ['CL', '10.0', '0.5', '9.5'],
      ['EL', '10.0', '0.0', '10.0'],
      ['LOP', '0.0', '1.0', null],
    ]);
    expect((await get(`/tenant/hr/employees/${meena}/leave?year=2026`, worker)).statusCode).toBe(
      200,
    );
  });

  it("works out September's days, then carries the year's leave forward", async () => {
    const month = await ok<{
      days: string[];
      rows: (Record<string, string | number> & { codes: string[] })[];
    }>(get(`/tenant/hr/attendance/month?entityId=${entityId}&month=2026-09`));
    expect(month.days).toHaveLength(30);
    const byCode = Object.fromEntries(month.rows.map((r) => [r.code, r]));
    // Suresh, at the head office (Monday to Friday): 22 working days with nothing marked, 8 weekend days.
    expect(byCode.E001).toMatchObject({
      present: '0',
      weeklyOffs: '8',
      absent: '22.0',
      payable: '8.0',
    });
    // Raju (Monday to Saturday at the site): 3 days present (one flagged), half a day's casual leave and half absent,
    // a day unpaid, 4 Sundays; 26 working days, so 21.5 absent and 7.5 payable.
    expect(byCode.E002).toMatchObject({
      present: '3',
      halfDays: '0',
      paidLeave: '0.5',
      unpaidLeave: '1.0',
      weeklyOffs: '4',
      absent: '21.5',
      payable: '7.5',
      daysInService: '30',
      flagged: 1,
    });
    expect([6, 7, 13, 21, 23].map((i) => byCode.E002!.codes[i])).toEqual(['P', 'P', 'L', 'U', 'A']);
    expect(byCode.E002!.codes[5]).toBe('WO');
    // Meena: two half days, three days' earned leave (28–30), 4 Sundays; 21 + 1 absent; payable 1 + 3 + 4.
    expect(byCode.E003).toMatchObject({
      present: '0',
      halfDays: '2',
      paidLeave: '3.0',
      absent: '22.0',
      payable: '8.0',
    });
    expect(byCode.E003!.codes.slice(27)).toEqual(['L', 'L', 'L']);

    // The year closed: earned leave carried (up to 30), casual leave not at all.
    const carried = await ok<{
      rows: { code: string; leave: string; closing: string; carried: string }[];
    }>(post('/tenant/hr/leave/carry-forward', { entityId, year: 2026 }));
    expect(carried.rows).toEqual([
      { code: 'E001', leave: 'EL', closing: '15.0', carried: '15.0' },
      { code: 'E002', leave: 'EL', closing: '12.5', carried: '12.5' },
      { code: 'E003', leave: 'EL', closing: '15.0', carried: '15.0' },
    ]);
    expect(
      (
        await ok<{ balances: Record<string, string | boolean>[] }>(
          get(`/tenant/hr/employees/${meena}/leave?year=2027&asOf=2027-01-01`),
        )
      ).balances.find((b) => b.code === 'EL'),
    ).toMatchObject({ opening: '15.0', carried: true, accrued: '1.0' });
    expect(
      (await post('/tenant/hr/leave/carry-forward', { entityId, year: 2026 }, worker)).statusCode,
    ).toBe(403);
  });
});
