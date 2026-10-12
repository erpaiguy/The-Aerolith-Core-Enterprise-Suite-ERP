// Safety in a real tenant database (docs/wave3-plan.md step 15), and the Wave 3 exit check for 3c: a pilot site's
// September (staff attendance, contract labour musters, a safety inspection and a cube test), incidents investigated to
// closure, permits to work issued only with their precautions and never to oneself, a toolbox talk, and the month's
// man-hours and injury rates worked by hand.
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

describe.skipIf(!controlUrl || !adminUrl)('safety and the 3c exit check (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-hse-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'hse-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  let projectId: string;
  let siteId: string;
  let e2: string;
  const w = new Map<string, string>();
  const put = (url: string, payload: object, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'PUT', url: `/api${url}`, payload, headers });
  const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}`;
  const at = (hoursFromNow: number) =>
    new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();

  it("records a pilot site's September: attendance, musters, quality", async () => {
    const entityId = (await ok<{ companies: { id: string }[] }>(get('/tenant/companies')))
      .companies[0]!.id;
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    await ok(
      post('/tenant/hr/calendars', { entityId, name: 'Sites', workWeek: 63, isDefault: true }),
    );
    e2 = (
      await ok<{ id: string }>(
        post('/tenant/hr/employees', {
          entityId,
          code: 'E002',
          name: 'Anil Wagh',
          joinedOn: '2026-04-01',
        }),
      )
    ).id;
    await ok(
      post(`/tenant/hr/employees/${e2}/deployments`, { from: '2026-09-01', projectId, siteId }),
    );
    // Anil: present 1–5 September, half the 7th: 44 hours.
    for (let d = 1; d <= 5; d++)
      await ok(
        post(
          `/tenant/hr/sites/${siteId}/attendance`,
          { date: day(d), marks: [{ employeeId: e2, status: 'present' }] },
          worker,
        ),
      );
    await ok(
      post(
        `/tenant/hr/sites/${siteId}/attendance`,
        { date: day(7), marks: [{ employeeId: e2, status: 'half_day' }] },
        worker,
      ),
    );
    // Contract labour: Ramesh 1–5 (2 hours' overtime on the 2nd): 42; Sunita 1–3 and half the 4th: 28.
    const party = (
      await ok<{ id: string }>(
        post('/tenant/parties', { name: 'Shree Labour Supply', isClient: false, isVendor: true }),
      )
    ).id;
    await ok(put(`/tenant/labour/contractors/${party}`, { licenceNo: 'CLRA/27/9' }, manager));
    for (const [name, skill, rate] of [
      ['Ramesh Pawar', 'skilled', '750'],
      ['Sunita Jadhav', 'unskilled', '500'],
    ] as const) {
      const list = await ok<{ id: string; name: string }[]>(
        post(
          `/tenant/labour/contractors/${party}/workers`,
          { name, trade: 'Mason', skill, dailyWage: rate, joinedOn: '2026-08-01' },
          manager,
        ),
      );
      w.set(name.split(' ')[0]!, list.find((x) => x.name === name)!.id);
    }
    for (let d = 1; d <= 5; d++) {
      const marks: object[] = [
        { workerId: w.get('Ramesh'), status: 'present', overtimeHours: d === 2 ? 2 : 0 },
      ];
      if (d <= 4)
        marks.push({ workerId: w.get('Sunita'), status: d === 4 ? 'half_day' : 'present' });
      await ok(
        post(
          `/tenant/labour/sites/${siteId}/muster`,
          { date: day(d), partyId: party, marks },
          worker,
        ),
      );
    }
    // Quality on the same site that month: a safety inspection checklist and a cube test.
    const tpl = await ok<{ id: string; name: string }[]>(
      post(
        '/tenant/quality/checklist-templates',
        {
          name: 'Weekly site safety',
          workType: 'Safety',
          items: [
            { text: 'Edges guarded', kind: 'yes_no' },
            { text: 'Fire extinguishers charged', kind: 'yes_no' },
          ],
        },
        manager,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/checklists`,
        {
          templateId: tpl[0]!.id,
          siteId,
          doneOn: day(5),
          location: 'Block A',
          answers: [{ answer: 'yes' }, { answer: 'yes' }],
        },
        worker,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/tests`,
        {
          kind: 'cube',
          sampledOn: day(1),
          testedOn: day(29),
          spec: { grade: 'M25' },
          results: { age: 28, cubes: [27, 26, 28] },
        },
        worker,
      ),
    );
  });

  it('investigates incidents to closure', async () => {
    const report = (b: object) =>
      ok<{ id: string; number: string }>(
        post(`/tenant/projects/${projectId}/incidents`, { siteId, ...b }, worker),
      );
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/incidents`,
          {
            occurredAt: '2026-09-02T09:00:00+05:30',
            kind: 'first_aid',
            description: 'Cut finger',
            daysLost: 2,
          },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'days_lost' });
    const lti = await report({
      occurredAt: '2026-09-03T10:30:00+05:30',
      kind: 'lost_time',
      location: 'Block A scaffold',
      description: 'Slipped on the scaffold board, sprained ankle',
      workerId: w.get('Sunita'),
      daysLost: 3,
    });
    expect(lti.number).toBe('INC-001');
    await report({
      occurredAt: '2026-09-04T15:00:00+05:30',
      kind: 'first_aid',
      description: 'Dust in the eye',
      employeeId: e2,
    });
    const nm = await report({
      occurredAt: '2026-09-05T11:00:00+05:30',
      kind: 'near_miss',
      description: 'A brick fell from the second floor',
    });
    expect((await post(`/tenant/incidents/${lti.id}/close`, {}, manager)).json()).toMatchObject({
      code: 'not_investigated',
    });
    const inv = await ok<{ actions: { id: string }[]; status: string }>(
      post(
        `/tenant/incidents/${lti.id}/investigation`,
        {
          rootCause: 'Board not fixed; no toe board',
          actions: [
            {
              action: 'Fix boards and toe boards on every lift',
              owner: 'Site engineer',
              dueOn: day(6),
            },
          ],
        },
        worker,
      ),
    );
    expect(inv.status).toBe('investigated');
    expect((await post(`/tenant/incidents/${lti.id}/close`, {}, manager)).json()).toMatchObject({
      code: 'actions_open',
    });
    await ok(
      post(`/tenant/incident-actions/${inv.actions[0]!.id}/done`, { doneOn: day(6) }, worker),
    );
    expect((await post(`/tenant/incidents/${lti.id}/close`, {}, worker)).statusCode).toBe(403);
    expect(await ok(post(`/tenant/incidents/${lti.id}/close`, {}, manager))).toMatchObject({
      status: 'closed',
    });
    expect(await ok(post(`/tenant/incidents/${nm.id}/close`, {}, manager))).toMatchObject({
      status: 'closed',
    });
  });

  it('issues permits to work only with their precautions, and not to oneself', async () => {
    const ask = (b: object, as = worker) =>
      post(
        `/tenant/projects/${projectId}/permits`,
        {
          siteId,
          kind: 'hot_work',
          location: 'Block A terrace',
          work: 'Welding the water tank stand',
          ...b,
        },
        as,
      );
    expect((await ask({ validFrom: at(1), validTo: at(14) })).json()).toMatchObject({
      code: 'bad_validity',
    });
    const p = await ok<{ id: string; number: string; precautions: { text: string }[] }>(
      ask({ validFrom: at(1), validTo: at(5) }),
    );
    expect(p.number).toBe('PTW-001');
    expect(p.precautions).toHaveLength(4);
    expect(
      (await post(`/tenant/permits/${p.id}/issue`, { confirmed: [true, true, true, true] }, worker))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          `/tenant/permits/${p.id}/issue`,
          { confirmed: [true, true, true, false] },
          manager,
        )
      ).json(),
    ).toMatchObject({
      code: 'precautions',
    });
    expect(
      await ok(
        post(`/tenant/permits/${p.id}/issue`, { confirmed: [true, true, true, true] }, manager),
      ),
    ).toMatchObject({ status: 'issued' });
    expect(
      await ok(post(`/tenant/permits/${p.id}/close`, { note: 'Work done, area checked' }, worker)),
    ).toMatchObject({ status: 'closed' });
    // The manager's own request is someone else's to issue; a request whose time has passed cannot be issued.
    const own = await ok<{ id: string }>(
      ask({ kind: 'height', validFrom: at(1), validTo: at(3) }, manager),
    );
    expect(
      (
        await post(
          `/tenant/permits/${own.id}/issue`,
          { confirmed: [true, true, true, true] },
          manager,
        )
      ).json(),
    ).toMatchObject({
      code: 'own_request',
    });
    const late = await ok<{ id: string }>(
      ask({ kind: 'excavation', validFrom: at(-6), validTo: at(-2) }),
    );
    expect(
      (
        await post(
          `/tenant/permits/${late.id}/issue`,
          { confirmed: [true, true, true, true] },
          manager,
        )
      ).json(),
    ).toMatchObject({
      code: 'expired',
    });
  });

  it('records a toolbox talk and works the month’s rates (the Wave 3 exit check, 3c)', async () => {
    await ok(
      post(
        `/tenant/projects/${projectId}/toolbox-talks`,
        {
          siteId,
          heldOn: day(1),
          topic: 'Working at height',
          speaker: 'Safety officer',
          employeeIds: [e2],
          workerIds: [w.get('Ramesh'), w.get('Sunita')],
          others: 3,
        },
        worker,
      ),
    );
    const reg = await ok<{
      incidents: { number: string; status: string }[];
      permits: unknown[];
      toolboxTalks: { attendance: number }[];
      inspections: { template: string; result: string }[];
    }>(get(`/tenant/projects/${projectId}/safety`, manager));
    expect(reg.incidents.map((i) => [i.number, i.status])).toEqual([
      ['INC-003', 'closed'],
      ['INC-002', 'open'],
      ['INC-001', 'closed'],
    ]);
    expect(reg.toolboxTalks[0]!.attendance).toBe(6);
    expect(reg.inspections).toEqual([
      expect.objectContaining({ template: 'Weekly site safety', result: 'passed' }),
    ]);
    // Man-hours: staff 44 (Anil) + contract labour 70 (Ramesh 42, Sunita 28) = 114. One lost-time injury of 3 days:
    // 1 × 1,000,000 ÷ 114 = 8,771.93; 3 × 1,000,000 ÷ 114 = 26,315.79.
    expect(
      await ok(
        get(
          `/tenant/projects/${projectId}/safety/statistics?from=2026-09-01&to=2026-09-30`,
          manager,
        ),
      ),
    ).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      staffHours: 44,
      labourHours: 70,
      manHours: 114,
      lostTimeInjuries: 1,
      daysLost: 3,
      frequencyRate: 8771.93,
      severityRate: 26315.79,
      byKind: { lost_time: 1, first_aid: 1, near_miss: 1 },
    });
    // The quality side of the month: the cube test passed.
    const q = await ok<{ tests: { outcome: string }[] }>(
      get(`/tenant/projects/${projectId}/quality`, manager),
    );
    expect(q.tests.map((x) => x.outcome)).toEqual(['passed']);
  });
});
