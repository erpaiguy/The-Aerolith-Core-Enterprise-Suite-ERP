// Tender programmes in a real tenant database (docs/wave1-plan.md step 11): a programme built by edits, dates worked
// by hand on the site calendar (Mon–Sat), a loop of links refused with nothing saved, indenting, moving and deleting,
// calendars changing the dates, codes swapped in one edit, permissions, and the time a large programme takes.
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

interface Act {
  id: string;
  parentId: string | null;
  depth: number;
  kind: string;
  code: string;
  name: string;
  duration: number;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateFinish: string | null;
  totalFloat: number | null;
  critical: boolean;
}
interface Plan {
  id: string;
  rowVersion: number;
  startOn: string;
  finishOn: string;
  duration: number;
  calendarId: string;
  calendars: { id: string; name: string; workWeek: number; holidays: string[] }[];
  activities: Act[];
  links: { pred: string; succ: string; type: string; lag: number }[];
}

describe.skipIf(!controlUrl || !adminUrl)('tender programmes (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let db: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let worker: Record<string, string>;
  let tenderId: string;
  let plan: Plan;
  const ids: Record<string, string> = {};

  const post = (url: string, payload: object = {}, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, headers });
  const get = (url: string, headers: Record<string, string> = t.admin) =>
    app.inject({ method: 'GET', url: `/api${url}`, headers });
  const ok = async <T>(p: Promise<{ statusCode: number; body: string; json: <U>() => U }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  const edit = async (ops: object[]) => {
    const r = await ok<{ idMap: Record<string, string>; plan: Plan }>(
      post(`/tenant/programmes/${plan.id}/changes`, { rowVersion: plan.rowVersion, ops }),
    );
    Object.assign(ids, r.idMap);
    plan = r.plan;
    return r;
  };
  const by = (codeOrName: string) =>
    plan.activities.find((a) => a.code === codeOrName || a.name === codeOrName)!;

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
      RATE_LIMIT_SCALE: '50',
      PUBLIC_API_URL: 'https://api.example.in',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'programme-admin@example.in');
    worker = await staff('vinod', 'worker');
    db = await app.get(TenantConnections).forTenant(t.tenantId);
    tenderId = (
      await ok<{ id: string }>(post('/tenant/tenders', { title: 'Girls hostel, Amravati' }))
    ).id;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await control?.end();
    await server?.end();
  });

  it('starts a programme with a site and an office calendar, national holidays included', async () => {
    plan = await ok<Plan>(
      post(`/tenant/tenders/${tenderId}/programmes`, {
        name: 'Submission programme',
        startOn: '2026-11-02',
      }),
    );
    expect(plan.calendars.map((c) => c.name)).toEqual(['Office (Mon–Fri)', 'Site (Mon–Sat)']);
    const site = plan.calendars.find((c) => c.name.startsWith('Site'))!;
    expect(plan.calendarId).toBe(site.id);
    expect(site.workWeek).toBe(63);
    expect(site.holidays).toContain('2027-01-26');
    expect(plan.activities).toEqual([]);
  });

  it('builds the programme by edits and schedules it on working days', async () => {
    const r = await edit([
      { op: 'insert', tempId: 't1', parentId: null, afterId: null, name: 'Civil works' },
      {
        op: 'insert',
        tempId: 't2',
        parentId: 't1',
        afterId: null,
        name: 'Excavation',
        duration: 5,
      },
      { op: 'insert', tempId: 't3', parentId: 't1', afterId: 't2', name: 'Footings', duration: 4 },
      {
        op: 'insert',
        tempId: 't4',
        parentId: 't1',
        afterId: 't3',
        name: 'Plinth complete',
        duration: 0,
      },
      { op: 'insert', tempId: 't5', parentId: null, afterId: 't1', name: 'Survey', duration: 2 },
      { op: 'link', pred: 't2', succ: 't3', type: 'FS', lag: 0 },
      { op: 'link', pred: 't3', succ: 't4', type: 'FS', lag: 0 },
      { op: 'link', pred: 't5', succ: 't4', type: 'FS', lag: 0 },
    ]);
    expect(Object.keys(r.idMap).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(plan.activities.map((a) => [a.code, a.depth, a.kind, a.name])).toEqual([
      ['A1000', 0, 'summary', 'Civil works'],
      ['A1010', 1, 'task', 'Excavation'],
      ['A1020', 1, 'task', 'Footings'],
      ['A1030', 1, 'milestone', 'Plinth complete'],
      ['A1040', 0, 'task', 'Survey'],
    ]);
    expect(by('Excavation')).toMatchObject({ earlyStart: '2026-11-02', earlyFinish: '2026-11-06' });
    // Sat 7th, (Sunday) Mon 9th, Tue 10th, Wed 11th.
    expect(by('Footings')).toMatchObject({ earlyStart: '2026-11-07', earlyFinish: '2026-11-11' });
    expect(by('Plinth complete')).toMatchObject({ earlyStart: '2026-11-11', critical: true });
    // Survey (Mon 2nd–Tue 3rd) could finish on the 11th: Wed 4th to Wed 11th is 7 working days.
    expect(by('Survey')).toMatchObject({
      totalFloat: 7,
      lateFinish: '2026-11-11',
      critical: false,
    });
    expect(by('Civil works')).toMatchObject({
      earlyStart: '2026-11-02',
      earlyFinish: '2026-11-11',
      duration: 9,
    });
    expect(plan).toMatchObject({ finishOn: '2026-11-11', duration: 9 });
  });

  it('refuses a loop of links, naming the activities, and saves nothing', async () => {
    const res = await post(`/tenant/programmes/${plan.id}/changes`, {
      rowVersion: plan.rowVersion,
      ops: [{ op: 'link', pred: ids.t4, succ: ids.t2, type: 'FS', lag: 0 }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'link_loop' });
    expect(res.json<{ activities: string[] }>().activities.sort()).toEqual([
      'A1010',
      'A1020',
      'A1030',
    ]);
    const now = await ok<Plan>(get(`/tenant/programmes/${plan.id}`));
    expect(now.rowVersion).toBe(plan.rowVersion);
    expect(now.links).toHaveLength(3);
    // Links on a summary, and making a linked task a summary, are refused too.
    expect(
      (
        await post(`/tenant/programmes/${plan.id}/changes`, {
          rowVersion: plan.rowVersion,
          ops: [{ op: 'link', pred: ids.t1, succ: ids.t5, type: 'FS', lag: 0 }],
        })
      ).json(),
    ).toMatchObject({ code: 'bad_link' });
    expect(
      (
        await post(`/tenant/programmes/${plan.id}/changes`, {
          rowVersion: plan.rowVersion,
          ops: [{ op: 'move', id: ids.t4, parentId: ids.t3, afterId: null }],
        })
      ).json(),
    ).toMatchObject({ code: 'summary_has_links', activities: ['A1020'] });
  });

  it('recalculates on every change, and refuses a stale edit', async () => {
    const stale = plan.rowVersion;
    await edit([
      { op: 'update', id: ids.t2, duration: 6 },
      { op: 'link', pred: ids.t2, succ: ids.t3, type: 'FS', lag: 1 },
    ]);
    // Excavation now ends Sat 7th; a day's lag takes Mon 9th, so footings run Tue 10th to Fri 13th.
    expect(by('Excavation').earlyFinish).toBe('2026-11-07');
    expect(by('Footings')).toMatchObject({ earlyStart: '2026-11-10', earlyFinish: '2026-11-13' });
    const res = await post(`/tenant/programmes/${plan.id}/changes`, {
      rowVersion: stale,
      ops: [{ op: 'update', id: ids.t2, name: 'x' }],
    });
    expect(res.statusCode).toBe(409);
  });

  it('moves the dates when a calendar changes, and follows an activity on another calendar', async () => {
    const site = plan.calendars.find((c) => c.name.startsWith('Site'))!;
    const office = plan.calendars.find((c) => c.name.startsWith('Office'))!;
    plan = await ok<Plan>(
      post(`/tenant/programmes/${plan.id}/calendars/${site.id}`, {
        rowVersion: plan.rowVersion,
        name: site.name,
        workWeek: site.workWeek,
        holidays: [...site.holidays, '2026-11-04'],
      }),
    );
    // A holiday on Wed 4th: six days of excavation end Mon 9th.
    expect(by('Excavation').earlyFinish).toBe('2026-11-09');
    await edit([{ op: 'update', id: ids.t5, calendarId: office.id, duration: 7 }]);
    // Survey in the office (Mon–Fri, no holiday on the 4th): seven working days end Tue 10th.
    expect(by('Survey')).toMatchObject({ earlyStart: '2026-11-02', earlyFinish: '2026-11-10' });
  });

  it('indents, moves and deletes rows; a summary takes its rows with it', async () => {
    await edit([
      { op: 'insert', tempId: 't6', parentId: null, afterId: ids.t5, name: 'Finishes' },
      { op: 'insert', tempId: 't7', parentId: 't6', afterId: null, name: 'Plaster', duration: 3 },
      { op: 'move', id: ids.t5, parentId: 't6', afterId: 't7' },
    ]);
    expect(plan.activities.map((a) => [a.name, a.depth])).toEqual([
      ['Civil works', 0],
      ['Excavation', 1],
      ['Footings', 1],
      ['Plinth complete', 1],
      ['Finishes', 0],
      ['Plaster', 1],
      ['Survey', 1],
    ]);
    expect(by('Finishes').kind).toBe('summary');
    await edit([{ op: 'delete', id: ids.t6 }]);
    expect(plan.activities.map((a) => a.name)).toEqual([
      'Civil works',
      'Excavation',
      'Footings',
      'Plinth complete',
    ]);
    expect(plan.links).toHaveLength(2);
  });

  it('swaps two activity IDs in one edit, and refuses a duplicate', async () => {
    await edit([
      { op: 'update', id: ids.t2, code: 'A1020' },
      { op: 'update', id: ids.t3, code: 'A1010' },
    ]);
    expect(by('Excavation').code).toBe('A1020');
    expect(by('Footings').code).toBe('A1010');
    const dup = await post(`/tenant/programmes/${plan.id}/changes`, {
      rowVersion: plan.rowVersion,
      ops: [{ op: 'update', id: ids.t4, code: 'a1010' }],
    });
    expect(dup.statusCode).toBe(409);
  });

  it('lets everyone read and only programme roles edit; programmes are archived, never deleted', async () => {
    expect((await get(`/tenant/programmes/${plan.id}`, worker)).statusCode).toBe(200);
    expect(
      (
        await post(
          `/tenant/programmes/${plan.id}/changes`,
          { rowVersion: plan.rowVersion, ops: [{ op: 'delete', id: ids.t2 }] },
          worker,
        )
      ).statusCode,
    ).toBe(403);
    plan = await ok<Plan>(post(`/tenant/programmes/${plan.id}/archive`, { archived: true }));
    expect(
      (
        await post(`/tenant/programmes/${plan.id}/changes`, {
          rowVersion: plan.rowVersion,
          ops: [{ op: 'delete', id: ids.t2 }],
        })
      ).json(),
    ).toMatchObject({ code: 'programme_archived' });
    plan = await ok<Plan>(post(`/tenant/programmes/${plan.id}/archive`, { archived: false }));
    await expect(db`DELETE FROM sched.plan`).rejects.toThrow(/permission denied/);
    const events = await db<{ kind: string }[]>`
      SELECT kind FROM tender.tender_event WHERE tender_id = ${tenderId} AND kind LIKE 'programme%'`;
    expect(events.map((e) => e.kind)).toEqual([
      'programme_created',
      'programme_archived',
      'programme_restored',
    ]);
  });

  it('builds and edits a programme of 5,000 activities in reasonable time', async () => {
    const big = await ok<Plan>(
      post(`/tenant/tenders/${tenderId}/programmes`, { name: 'Large', startOn: '2026-11-02' }),
    );
    const ops: object[] = [];
    for (let i = 0; i < 5000; i++) {
      ops.push({
        op: 'insert',
        tempId: `t${i}`,
        parentId: null,
        afterId: i ? `t${i - 1}` : null,
        name: `Activity ${i}`,
        duration: (i % 7) + 1,
      });
      if (i) ops.push({ op: 'link', pred: `t${i - 1}`, succ: `t${i}`, type: 'FS', lag: 0 });
    }
    let t0 = performance.now();
    const built = await ok<{ plan: Plan; idMap: Record<string, string> }>(
      post(`/tenant/programmes/${big.id}/changes`, {
        rowVersion: big.rowVersion,
        ops: ops.slice(0, 5000),
      }),
    );
    const built2 = await ok<{ plan: Plan; idMap: Record<string, string> }>(
      post(`/tenant/programmes/${big.id}/changes`, {
        rowVersion: built.plan.rowVersion,
        ops: ops.slice(5000).map((o) => {
          const x = o as {
            op: string;
            tempId?: string;
            afterId?: string | null;
            pred?: string;
            succ?: string;
          };
          const real = (id: string | null | undefined) => (id ? (built.idMap[id] ?? id) : id);
          return x.op === 'insert'
            ? { ...x, afterId: real(x.afterId) }
            : { ...x, pred: real(x.pred), succ: real(x.succ) };
        }),
      }),
    );
    const buildMs = performance.now() - t0;
    expect(built2.plan.activities).toHaveLength(5000);
    t0 = performance.now();
    const first = built2.plan.activities[0]!;
    const one = await ok<{ plan: Plan }>(
      post(`/tenant/programmes/${big.id}/changes`, {
        rowVersion: built2.plan.rowVersion,
        ops: [{ op: 'update', id: first.id, duration: first.duration + 1 }],
      }),
    );
    const editMs = performance.now() - t0;
    // Every activity after the first moves a day.
    const last = one.plan.activities.at(-1)!;
    expect(last.earlyFinish! > built2.plan.activities.at(-1)!.earlyFinish!).toBe(true);
    console.error(
      `programme 5,000 activities: build ${buildMs.toFixed(0)} ms, one edit ${editMs.toFixed(0)} ms`,
    );
    expect(editMs).toBeLessThan(5000);
  }, 120_000);

  const uploadFile = (name: string, body: string) => {
    const boundary = `----aerolith${randomBytes(6).toString('hex')}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      Buffer.from(body),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: `/api/tenant/tenders/${tenderId}/programmes/import`,
      payload,
      headers: { ...t.admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };

  it('exports a programme as MS Project XML, XER and Excel, and imports each file back as a new programme', async () => {
    const source = await ok<Plan>(get(`/tenant/programmes/${plan.id}`));
    for (const [format, type, ext] of [
      ['mspdi', 'application/xml', 'xml'],
      ['xer', 'text/plain', 'xer'],
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ] as const) {
      const res = await get(`/tenant/programmes/${plan.id}/export?format=${format}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(type);
      expect(res.headers['content-disposition']).toContain(`Submission programme.${ext}`);
      if (format === 'xlsx') continue;
      const r = await ok<{
        plan: Plan;
        report: { warnings: string[]; finish: string; fileFinish: string };
      }>(uploadFile(`back.${ext}`, res.body));
      // The same activities, links and dates, recalculated here.
      expect(r.report.warnings).toEqual([]);
      expect(r.report.finish).toBe(source.finishOn);
      expect(r.report.fileFinish).toBe(source.finishOn);
      const rows = (p: Plan) =>
        [...p.activities]
          .map((a) => [a.code, a.kind, a.duration, a.earlyStart, a.earlyFinish, a.totalFloat])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      expect(rows(r.plan)).toEqual(rows(source));
      expect(r.plan.links).toHaveLength(source.links.length);
    }
  });

  it('refuses a file that is neither, and one whose links loop, creating nothing', async () => {
    const before = (await ok<unknown[]>(get(`/tenant/tenders/${tenderId}/programmes`))).length;
    const bad = await uploadFile('plan.mpp', 'binary stuff');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'unreadable_programme' });
    const loop = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project">
      <StartDate>2026-11-02T08:00:00</StartDate><MinutesPerDay>480</MinutesPerDay><Tasks>
      <Task><UID>1</UID><ID>1</ID><Name>A</Name><OutlineLevel>1</OutlineLevel><Duration>PT8H0M0S</Duration>
        <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type></PredecessorLink></Task>
      <Task><UID>2</UID><ID>2</ID><Name>B</Name><OutlineLevel>1</OutlineLevel><Duration>PT8H0M0S</Duration>
        <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink></Task>
      </Tasks></Project>`;
    const looped = await uploadFile('loop.xml', loop);
    expect(looped.statusCode).toBe(422);
    expect(looped.json()).toMatchObject({ code: 'link_loop' });
    expect((await ok<unknown[]>(get(`/tenant/tenders/${tenderId}/programmes`))).length).toBe(
      before,
    );
  });
});
