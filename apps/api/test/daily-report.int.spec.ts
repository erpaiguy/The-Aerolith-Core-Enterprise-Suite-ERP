// Daily site reports in a real tenant database (docs/wave2b-plan.md step 7): a day's report built up over several
// saves, photos, what came and was issued that day pulled from the receipts and issue slips, submitted, acknowledged
// by the lead, corrected with a reason; the next evening's reminder; yesterday's crew carried forward; the days
// without a report; weekly man-days, equipment hours and hindrances worked by hand; kept to the project's team.
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

describe.skipIf(!controlUrl || !adminUrl)('daily site reports (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let workerId: string;
  let projectId: string;
  let lata: { id: string; headers: Record<string, string> };

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-dsr-test-')),
      DOCUMENT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-dsr-files-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'dsr-admin@example.in');
    // More people than a trial's one manager and one worker.
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('test10', 'Test', 10, NULL)
      ON CONFLICT DO NOTHING`;
    await control`UPDATE core.licence SET tier_id = 'test10', seat_cap = 10 WHERE id = ${t.licenceId}`;
    const m = await staff('suresh', 'manager');
    const w = await staff('raju', 'worker');
    [manager, worker, workerId] = [m.headers, w.headers, w.id];
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    lata = await staff('lata', 'worker');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  interface Report {
    id: string;
    reportDate: string;
    status: string;
    rowVersion: number;
    manpower: { trade: string; contractor: string | null; headcount: number }[];
    equipment: { name: string; hoursWorked: string; hoursIdle: string }[];
    hindrances: { cause: string; hours: string }[];
    photos: { id: string; caption: string }[];
    events: { kind: string; comment: string | null }[];
    received: { number: string; description: string; accepted: string }[];
    issued: { number: string; wbsCode: string; name: string; qty: string }[];
    mayEdit: boolean;
    mayAcknowledge: boolean;
    mayCorrect: boolean;
  }
  type Headers = Record<string, string>;

  let siteId: string;
  let contractor: string;
  let monday: Report;
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  const save = (r: Report, body: object, as: Headers = worker) =>
    post(`/tenant/daily-reports/${r.id}`, { rowVersion: r.rowVersion, ...body }, as);
  const photo = (r: Report, bytes: Buffer, caption: string, as: Headers = worker) => {
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="site.jpg"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n',
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: `/api/tenant/daily-reports/${r.id}/photos?caption=${encodeURIComponent(caption)}`,
      payload,
      headers: { ...as, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };
  const crew = (mason: number) => ({
    manpower: [
      { trade: 'Mason', headcount: mason },
      { trade: 'Helper', partyId: contractor, headcount: 10 },
    ],
  });

  it("builds a day's report over several saves, with photos and the day's receipts and issues", async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: lata.id, role: 'viewer' }, manager),
    );
    siteId = (
      await ok<{ sites: { id: string }[] }>(
        post(`/tenant/projects/${projectId}/sites`, { name: 'Washim', stateCode: '27' }, manager),
      )
    ).sites[0]!.id;
    await ok(
      post(`/tenant/projects/${projectId}/wbs`, { code: 'SUB', name: 'Substructure' }, manager),
    );
    contractor = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Shinde Labour Supply',
          isClient: false,
          isSubcontractor: true,
        }),
      )
    ).id;
    // Cement ordered, 100 bags received on Monday 5 October and 10 issued to the substructure the same day.
    const cement = (
      await ok<{ id: string }>(
        post('/tenant/resources', {
          code: 'CEM',
          name: 'Cement OPC 53',
          kind: 'material',
          unit: 'bag',
          rate: '400',
          effectiveFrom: '2026-01-01',
        }),
      )
    ).id;
    const vendor = (
      await ok<{ id: string }>(
        post('/tenant/parties', {
          name: 'Vidarbha Cement Traders',
          isClient: false,
          isVendor: true,
          gstin: '27AAACV1234F1Z5',
        }),
      )
    ).id;
    const o = await ok<{ open: { id: string; rowVersion: number } }>(
      post(
        `/tenant/projects/${projectId}/orders`,
        {
          kind: 'purchase',
          partyId: vendor,
          siteId,
          lines: [
            {
              resourceId: cement,
              description: 'Cement OPC 53',
              unit: 'bag',
              qty: '100',
              rate: '390',
              gstPct: '28',
            },
          ],
        },
        manager,
      ),
    );
    const po = await ok<{ id: string; progress: { lineKey: string }[] }>(
      post(
        `/tenant/order-revisions/${o.open.id}/submit`,
        { rowVersion: o.open.rowVersion },
        manager,
      ),
    );
    const grn = await ok<{ store: { id: string } }>(
      post(
        `/tenant/orders/${po.id}/receipts`,
        {
          receivedOn: '2026-10-05',
          challanNo: 'VCT/441',
          lines: [{ lineKey: po.progress[0]!.lineKey, qty: '100' }],
        },
        worker,
      ),
    );
    await ok(
      post(
        `/tenant/stores/${grn.store.id}/issues`,
        {
          issuedOn: '2026-10-05',
          wbsCode: 'SUB',
          issuedTo: 'Mason gang',
          lines: [{ resourceId: cement, qty: '10' }],
        },
        worker,
      ),
    );

    // Not tomorrow; not by a viewer.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/daily-reports`,
          { siteId, reportDate: '2099-01-01' },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'in_future' });
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/daily-reports`,
          { siteId, reportDate: '2026-10-05' },
          lata.headers,
        )
      ).json(),
    ).toMatchObject({ code: 'forbidden' });
    monday = await ok<Report>(
      post(
        `/tenant/projects/${projectId}/daily-reports`,
        { siteId, reportDate: '2026-10-05' },
        worker,
      ),
    );
    expect(monday).toMatchObject({ status: 'draft', manpower: [], mayEdit: true });
    // The same site and day again: the one already there.
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/daily-reports`,
          { siteId, reportDate: '2026-10-05' },
          worker,
        )
      ).json(),
    ).toMatchObject({ code: 'report_exists', id: monday.id });
    // The receipt and the issue of that day are on it without typing.
    expect(monday.received).toEqual([
      expect.objectContaining({
        number: expect.stringMatching(/^GRN\//),
        description: 'Cement OPC 53',
        accepted: '100.0000',
      }),
    ]);
    expect(monday.issued).toEqual([
      expect.objectContaining({
        number: expect.stringMatching(/^ISS\//),
        wbsCode: 'SUB',
        qty: '10.0000',
      }),
    ]);

    // Morning: weather and the crew. Afternoon: the mixer and a power cut.
    const morning = await ok<Report>(save(monday, { weatherAm: 'clear', ...crew(6) }));
    expect(morning.manpower).toEqual([
      expect.objectContaining({ trade: 'Mason', contractor: null, headcount: 6 }),
      expect.objectContaining({
        trade: 'Helper',
        contractor: 'Shinde Labour Supply',
        headcount: 10,
      }),
    ]);
    // A phone still holding the morning's version is told, not allowed to overwrite.
    expect((await save(monday, { notes: 'old' })).json()).toMatchObject({ code: 'stale_row' });
    monday = await ok<Report>(
      save(morning, {
        weatherAm: 'clear',
        weatherPm: 'cloudy',
        ...crew(6),
        equipment: [
          {
            name: 'Concrete mixer',
            ownership: 'own',
            hoursWorked: '7',
            hoursIdle: '1',
            idleReason: 'No power',
          },
        ],
        work: [{ description: 'Plinth beam concreting, grid A-C', qty: '4.5', unit: 'cum' }],
        hindrances: [
          { cause: 'power_water', description: 'MSEB shutdown', hours: '1', account: 'neutral' },
        ],
        safety: 'Toolbox talk on shuttering',
      }),
    );
    expect(monday.equipment).toEqual([
      expect.objectContaining({ name: 'Concrete mixer', hoursWorked: '7.0', hoursIdle: '1.0' }),
    ]);

    // Photos: pictures only.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048)]);
    expect((await photo(monday, Buffer.from('not a picture at all'), 'x')).json()).toMatchObject({
      code: 'not_a_photo',
    });
    monday = await ok<Report>(photo(monday, jpeg, 'Plinth beam, grid B'));
    expect(monday.photos).toEqual([expect.objectContaining({ caption: 'Plinth beam, grid B' })]);
    const img = await get(
      `/tenant/daily-reports/${monday.id}/photos/${monday.photos[0]!.id}`,
      lata.headers,
    );
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(img.rawPayload, jpeg)).toBe(0);

    // A photo kept in the outbox with no signal comes in JSON with when and where it was taken (step 8d.4); the
    // outbox's retry with the same key does not add it twice.
    const inline = {
      caption: 'Column C4 shuttering',
      takenAt: '2026-10-12T09:15:00+05:30',
      latitude: 18.52043,
      longitude: 73.856743,
      accuracyM: 12,
      photo: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    };
    const key = { ...worker, 'idempotency-key': `dsr-photo-${randomBytes(8).toString('hex')}` };
    await ok(post(`/tenant/daily-reports/${monday.id}/photos/inline`, inline, key));
    const again = await ok<Report & { photos: { latitude: number | null; takenAt: string }[] }>(
      post(`/tenant/daily-reports/${monday.id}/photos/inline`, inline, key),
    );
    expect(again.photos).toHaveLength(2);
    expect(again.photos[1]).toMatchObject({
      caption: 'Column C4 shuttering',
      latitude: 18.52043,
      longitude: 73.856743,
      accuracyM: 12,
    });
    expect(new Date(again.photos[1]!.takenAt).toISOString()).toBe('2026-10-12T03:45:00.000Z');
    expect(
      (
        await post(
          `/tenant/daily-reports/${monday.id}/photos/inline`,
          { ...inline, longitude: null },
          worker,
        )
      ).statusCode,
    ).toBe(400);
    monday = await ok<Report>(
      post(`/tenant/daily-reports/${monday.id}/photos/${again.photos[1]!.id}/remove`, {}, worker),
    );
    expect(monday.photos).toHaveLength(1);
  });

  it('is submitted, acknowledged by the lead, and corrected with a reason', async () => {
    monday = await ok<Report>(
      post(`/tenant/daily-reports/${monday.id}/submit`, { rowVersion: monday.rowVersion }, worker),
    );
    expect(monday).toMatchObject({ status: 'submitted', mayEdit: false, mayCorrect: true });
    expect((await save(monday, { notes: 'late' })).json()).toMatchObject({ code: 'not_draft' });
    expect(
      (await photo(monday, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'late')).json(),
    ).toMatchObject({
      code: 'not_draft',
    });
    // The worker may not acknowledge; the manager leads the project and may.
    expect(
      (await post(`/tenant/daily-reports/${monday.id}/acknowledge`, {}, worker)).json(),
    ).toMatchObject({
      code: 'forbidden',
    });
    monday = await ok<Report>(
      post(`/tenant/daily-reports/${monday.id}/acknowledge`, { comment: 'Seen' }, manager),
    );
    expect(monday.status).toBe('acknowledged');
    // The mixer's idle hours were wrong: corrected (with a reason), changed and submitted again.
    expect(
      (await post(`/tenant/daily-reports/${monday.id}/correct`, { reason: '' }, worker)).statusCode,
    ).toBe(400);
    monday = await ok<Report>(
      post(
        `/tenant/daily-reports/${monday.id}/correct`,
        { reason: 'Mixer idle 2 h, not 1' },
        worker,
      ),
    );
    expect(monday).toMatchObject({ status: 'draft', mayEdit: true });
    monday = await ok<Report>(
      save(monday, {
        weatherAm: 'clear',
        weatherPm: 'cloudy',
        ...crew(6),
        equipment: [
          {
            name: 'Concrete mixer',
            ownership: 'own',
            hoursWorked: '6',
            hoursIdle: '2',
            idleReason: 'No power',
          },
        ],
        hindrances: [
          { cause: 'power_water', description: 'MSEB shutdown', hours: '2', account: 'neutral' },
        ],
      }),
    );
    monday = await ok<Report>(
      post(`/tenant/daily-reports/${monday.id}/submit`, { rowVersion: monday.rowVersion }, worker),
    );
    expect(monday.events.map((e) => [e.kind, e.comment])).toEqual([
      ['submitted', null],
      ['acknowledged', 'Seen'],
      ['corrected', 'Mixer idle 2 h, not 1'],
      ['submitted', null],
    ]);
    // Its photo stayed.
    expect(monday.photos).toHaveLength(1);
  });

  it('carries the crew forward, reminds the next evening, and lists the days without a report', async () => {
    // Tuesday starts from Monday's crew and plant (hours blank); 8 masons today, rain for 3 hours.
    let tuesday = await ok<Report>(
      post(
        `/tenant/projects/${projectId}/daily-reports`,
        { siteId, reportDate: '2026-10-06' },
        worker,
      ),
    );
    expect(tuesday.manpower.map((m) => [m.trade, m.headcount])).toEqual([
      ['Mason', 6],
      ['Helper', 10],
    ]);
    expect(tuesday.equipment).toEqual([
      expect.objectContaining({ name: 'Concrete mixer', hoursWorked: '0.0' }),
    ]);
    tuesday = await ok<Report>(
      save(tuesday, {
        weatherAm: 'rain',
        rainHours: '3',
        ...crew(8),
        equipment: [{ name: 'Concrete mixer', ownership: 'own', hoursWorked: '5', hoursIdle: '0' }],
        hindrances: [
          { cause: 'rain', description: 'Morning rain', hours: '3', account: 'neutral' },
        ],
      }),
    );
    await ok(
      post(
        `/tenant/daily-reports/${tuesday.id}/submit`,
        { rowVersion: tuesday.rowVersion },
        worker,
      ),
    );
    // The week before: 4 masons on Monday 28 September (a draft is left out of the figures).
    let earlier = await ok<Report>(
      post(
        `/tenant/projects/${projectId}/daily-reports`,
        { siteId, reportDate: '2026-09-28' },
        worker,
      ),
    );
    earlier = await ok<Report>(
      save(earlier, {
        manpower: [{ trade: 'Mason', headcount: 4 }],
        hindrances: [
          {
            cause: 'drawings',
            description: 'Footing drawing awaited',
            hours: '4',
            account: 'client',
          },
        ],
      }),
    );
    await ok(
      post(
        `/tenant/daily-reports/${earlier.id}/submit`,
        { rowVersion: earlier.rowVersion },
        worker,
      ),
    );
    await ok(
      post(
        `/tenant/projects/${projectId}/daily-reports`,
        { siteId, reportDate: '2026-09-29' },
        worker,
      ),
    );

    // The site was set up today: today is the only day it is missing a report.
    let l = await ok<{ missing: { site: { name: string }; days: string[] }[]; reports: unknown[] }>(
      get(`/tenant/projects/${projectId}/daily-reports`, worker),
    );
    expect(l.missing).toEqual([
      { site: expect.objectContaining({ name: 'Washim' }), days: [today] },
    ]);
    expect(l.reports).toHaveLength(4);
    let t = await ok<Report>(
      post(`/tenant/projects/${projectId}/daily-reports`, { siteId, reportDate: today }, worker),
    );
    t = await ok<Report>(save(t, crew(5)));
    await ok(post(`/tenant/daily-reports/${t.id}/submit`, { rowVersion: t.rowVersion }, worker));
    l = await ok(get(`/tenant/projects/${projectId}/daily-reports`, worker));
    expect(l.missing).toEqual([]);
    // Tomorrow 7 pm in India (13:30 UTC), for the one who submitted.
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const [reminder] = await db<{ due_at: Date; title: string }[]>`
      SELECT due_at, title FROM platform.notification WHERE kind = 'dsr_reminder' AND user_id = ${workerId}`;
    expect(reminder).toMatchObject({ title: 'Daily report for Washim' });
    expect(reminder!.due_at.toISOString()).toBe(
      `${tomorrow.toISOString().slice(0, 10)}T13:30:00.000Z`,
    );
  });

  it('adds up man-days, equipment hours and hindrances by week', async () => {
    const s = await ok<{
      manpower: { week: string; trade: string; manDays: number }[];
      equipment: { week: string; name: string; worked: string; idle: string }[];
      hindrances: { cause: string; account: string; hours: string; days: number }[];
    }>(
      get(
        `/tenant/projects/${projectId}/daily-reports/summary?from=2026-09-28&to=2026-10-11`,
        worker,
      ),
    );
    // Week of 28 Sep: 4 masons (the 29th is a draft). Week of 5 Oct: masons 6 + 8, helpers 10 + 10.
    expect(s.manpower.map((m) => [m.week, m.trade, m.manDays])).toEqual([
      ['2026-09-28', 'Mason', 4],
      ['2026-10-05', 'Helper', 20],
      ['2026-10-05', 'Mason', 14],
    ]);
    // The mixer: 6 + 5 hours worked, 2 + 0 idle.
    expect(s.equipment.map((e) => [e.week, e.name, e.worked, e.idle])).toEqual([
      ['2026-10-05', 'Concrete mixer', '11.0', '2.0'],
    ]);
    // Drawings 4 h (client's account), rain 3 h, the power cut 2 h.
    expect(s.hindrances.map((h) => [h.cause, h.account, h.hours, h.days])).toEqual([
      ['drawings', 'client', '4.0', 1],
      ['rain', 'neutral', '3.0', 1],
      ['power_water', 'neutral', '2.0', 1],
    ]);
  });

  it("keeps reports to the project's team", async () => {
    expect((await get(`/tenant/daily-reports/${monday.id}`, lata.headers)).statusCode).toBe(200);
    await db`DELETE FROM proj.member WHERE project_id = ${projectId} AND user_id = ${lata.id}`;
    expect((await get(`/tenant/daily-reports/${monday.id}`, lata.headers)).statusCode).toBe(404);
    expect(
      (await get(`/tenant/daily-reports/${monday.id}/photos/${monday.photos[0]!.id}`, lata.headers))
        .statusCode,
    ).toBe(404);
  });
});
