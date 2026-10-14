// Meetings and correspondence in a real tenant database (docs/wave7-plan.md steps 7d.1 and 7d.2): minutes with
// actions owned by the team and closed by them; letters in and out, numbered, answered and closed; kept to the team.
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

describe.skipIf(!controlUrl || !adminUrl)('meetings and correspondence (integration)', () => {
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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-mtg-test-')),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'mtg-admin@example.in');
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

  it('records minutes with actions for the team, closed by their owners and in their work', async () => {
    projectId = (
      await ok<{ id: string }>(post('/tenant/projects', { name: 'Hostel, Washim' }, manager))
    ).id;
    await ok(
      post(`/tenant/projects/${projectId}/team`, { userId: workerId, role: 'member' }, manager),
    );
    interface Meeting {
      id: string;
      number: string;
      actions: { id: string; description: string; owner: string; status: string }[];
    }
    // An action for someone off the team is refused; someone off the team cannot record.
    const body = {
      title: 'Site progress review',
      heldOn: '2026-10-05',
      place: 'Site office',
      attendees: 'Suresh (PM), Raju (engineer), client EE',
      minutes: 'Slab 2 behind by a week.',
      decisions: 'Night shift for slab 2.',
      actions: [
        { description: 'Arrange lights for night work', ownerId: workerId, dueOn: '2026-10-08' },
      ],
    };
    expect(
      (await post(`/tenant/projects/${projectId}/meetings`, body, lata.headers)).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/tenant/projects/${projectId}/meetings`,
          {
            ...body,
            actions: [{ ...body.actions[0], ownerId: lata.id }],
          },
          manager,
        )
      ).json(),
    ).toMatchObject({ code: 'not_on_project' });
    const m = await ok<Meeting>(post(`/tenant/projects/${projectId}/meetings`, body, manager));
    expect(m.number).toBe('MOM-001');
    expect(m.actions.map((a) => [a.description, a.owner, a.status])).toEqual([
      ['Arrange lights for night work', 'raju', 'open'],
    ]);
    // In Raju's work until done; Lata (off the team) cannot close it; Raju does.
    let work = await ok<{ actions: { count: number } }>(get('/tenant/my-work', worker));
    expect(work.actions.count).toBe(1);
    expect(
      (await post(`/tenant/meeting-actions/${m.actions[0]!.id}/done`, {}, lata.headers)).statusCode,
    ).toBe(404);
    const done = await ok<Meeting>(
      post(`/tenant/meeting-actions/${m.actions[0]!.id}/done`, { note: 'Fitted' }, worker),
    );
    expect(done.actions[0]!.status).toBe('done');
    work = await ok<{ actions: { count: number } }>(get('/tenant/my-work', worker));
    expect(work.actions.count).toBe(0);
    expect(
      (
        await ok<{ meetings: { open: number }[] }>(
          get(`/tenant/projects/${projectId}/meetings`, worker),
        )
      ).meetings,
    ).toEqual([expect.objectContaining({ open: 0 })]);
  });

  it('keeps letters in and out, numbered, answered and closed', async () => {
    interface Letters {
      letters: {
        id: string;
        number: string;
        status: string;
        answeredBy: string | null;
        replyToNumber: string | null;
      }[];
    }
    const inbound = await ok<Letters>(
      post(
        `/tenant/projects/${projectId}/letters`,
        {
          direction: 'in',
          letterDate: '2026-10-06',
          party: 'Executive Engineer, PWD Washim',
          reference: 'EE/WSM/2026/411',
          subject: 'Slow progress on slab 2',
          replyBy: '2026-10-10',
        },
        worker,
      ),
    );
    const letter = inbound.letters[0]!;
    expect([letter.number, letter.status]).toEqual(['IN-001', 'open']);
    const after = await ok<Letters>(
      post(
        `/tenant/projects/${projectId}/letters`,
        {
          direction: 'out',
          letterDate: '2026-10-08',
          party: 'Executive Engineer, PWD Washim',
          subject: 'Re: Slow progress on slab 2',
          replyTo: letter.id,
        },
        manager,
      ),
    );
    const byNo = Object.fromEntries(after.letters.map((l) => [l.number, l]));
    expect(byNo['OUT-001']).toMatchObject({ replyToNumber: 'IN-001' });
    expect(byNo['IN-001']).toMatchObject({ status: 'closed', answeredBy: 'OUT-001' });
    const ins = await ok<Letters>(
      get(`/tenant/projects/${projectId}/letters?direction=in`, worker),
    );
    expect(ins.letters.map((l) => l.number)).toEqual(['IN-001']);
    expect((await get(`/tenant/projects/${projectId}/letters`, lata.headers)).statusCode).toBe(404);
  });
});
