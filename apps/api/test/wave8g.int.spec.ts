// Wave 8g in a real tenant database (docs/wave8-plan.md): the platform — two-factor sign-in for staff, backups and
// the audit export, the daily reminder digest, finer permissions.
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
import { timeStep, totpCode } from '../src/auth/totp.js';
import { appendFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { readBackup, type Event } from '../src/backup/backup-file.js';
import { BackupService, backupDue } from '../src/backup/backup.service.js';
import { renderEmail } from '../src/email/templates.js';
import { DigestService } from '../src/inbox/digest.service.js';
import { DEFAULT_CRITERIA } from '../src/tender/tender-rules.js';
import { ROLES } from '../src/accounts/accounts-rules.js';
import { TenantConnections } from '../src/provisioning/tenant-connections.js';
import { readyTenant } from './helpers/tenant.js';
import { unzip } from './helpers/zip.js';

const controlUrl = process.env.TEST_CONTROL_DATABASE_URL;
const adminUrl = process.env.TEST_LOCAL_PG_ADMIN_URL;
if (process.env.CI && (!controlUrl || !adminUrl))
  throw new Error('TEST_CONTROL_DATABASE_URL and TEST_LOCAL_PG_ADMIN_URL are required in CI');

const ENC = randomBytes(32);

describe.skipIf(!controlUrl || !adminUrl)('wave 8g: platform (integration)', () => {
  let app: NestFastifyApplication;
  let control: Sql;
  let server: Sql;
  let t: Awaited<ReturnType<typeof readyTenant>>;
  let manager: Record<string, string>;
  let worker: Record<string, string>;
  let backupDir: string;

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
      IMPORT_DIR: await mkdtemp(join(tmpdir(), 'aerolith-w8g-test-')),
      BACKUP_DIR: (backupDir = await mkdtemp(join(tmpdir(), 'aerolith-w8g-backups-'))),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    t = await readyTenant(app, control, ENC, 'w8g-admin@example.in');
    // Five people: more than a trial's one manager and one worker.
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

  const signIn = (identifier: string, password: string, code?: string) =>
    post(
      '/auth/login',
      {
        entitlementToken: t.entitlement,
        identifier,
        password,
        client: 'desktop',
        ...(code ? { code } : {}),
      },
      {},
    );
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('lets staff set up an authenticator, asks for it at sign-in, and makes it compulsory when the company says', async () => {
    // suresh (a manager, who posts to the books) sets it up.
    const start = await ok<{ secret: string; otpauthUri: string }>(
      post('/auth/two-factor/start', {}, manager),
    );
    expect(start.otpauthUri).toMatch(/^otpauth:\/\/totp\/.*suresh/);
    expect(
      (await post('/auth/two-factor/confirm', { code: '000000' }, manager)).json(),
    ).toMatchObject({
      code: 'invalid_code',
    });
    const step = timeStep(new Date());
    const { recoveryCodes } = await ok<{ recoveryCodes: string[] }>(
      post('/auth/two-factor/confirm', { code: totpCode(start.secret, step) }, manager),
    );
    expect(recoveryCodes).toHaveLength(10);

    // Signing in now asks for a code; the one just used is not taken twice; a recovery code works once.
    expect((await signIn('suresh', 'Bar-Bending-Yard-44')).json()).toEqual({
      status: 'mfa_required',
    });
    expect(
      (await signIn('suresh', 'Bar-Bending-Yard-44', totpCode(start.secret, step))).statusCode,
    ).toBe(401);
    const viaRecovery = await signIn('suresh', 'Bar-Bending-Yard-44', recoveryCodes[0]);
    expect(viaRecovery.json()).toMatchObject({ status: 'ok', mustSetUpMfa: false });
    expect((await signIn('suresh', 'Bar-Bending-Yard-44', recoveryCodes[0])).statusCode).toBe(401);
    expect(
      await ok<{ enabled: boolean; recoveryCodesLeft: number }>(get('/auth/two-factor', manager)),
    ).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 9,
    });

    // The company requires it: a second manager must set it up before anything else; the worker need not.
    expect((await post('/auth/two-factor/policy', { requireMfa: true }, manager)).statusCode).toBe(
      403,
    );
    expect((await post('/auth/two-factor/policy', { requireMfa: true }, worker)).statusCode).toBe(
      403,
    );
    await ok(post('/auth/two-factor/policy', { requireMfa: true }));
    const created = await ok<{ id: string; temporaryPassword: string }>(
      post('/tenant/users', { username: 'meena', displayName: 'Meena', role: 'manager' }),
    );
    const first = (await ok<{ accessToken: string }>(signIn('meena', created.temporaryPassword)))
      .accessToken;
    await ok(
      post(
        '/auth/change-password',
        { currentPassword: created.temporaryPassword, newPassword: 'Shuttering-Plate-19' },
        bearer(first),
      ),
    );
    const meena = await ok<{ accessToken: string; mustSetUpMfa: boolean }>(
      signIn('meena', 'Shuttering-Plate-19'),
    );
    expect(meena.mustSetUpMfa).toBe(true);
    expect((await get('/tenant/projects', bearer(meena.accessToken))).json()).toMatchObject({
      code: 'mfa_setup_required',
    });
    expect(
      (await ok<{ requiredNow: boolean }>(get('/auth/two-factor', bearer(meena.accessToken))))
        .requiredNow,
    ).toBe(true);
    const w = await ok<{ mustSetUpMfa: boolean; accessToken: string }>(
      signIn('raju', 'Bar-Bending-Yard-44'),
    );
    expect(w.mustSetUpMfa).toBe(false);
    expect((await get('/tenant/projects', bearer(w.accessToken))).statusCode).toBe(200);

    // suresh may not turn his off while the company requires it.
    expect(
      (await post('/auth/two-factor/disable', { code: recoveryCodes[1] }, manager)).json(),
    ).toMatchObject({ code: 'mfa_required_by_company' });
    const users = await ok<{ username: string; enabled: boolean }[]>(get('/auth/two-factor/users'));
    expect(users.filter((u) => u.enabled).map((u) => u.username)).toEqual(['suresh']);
    await ok(post('/auth/two-factor/policy', { requireMfa: false }));
  });

  it('nightly backup is due once a day after its hour (IST)', () => {
    const at = (iso: string) => new Date(iso);
    const s = { enabled: true, hour: 2 };
    expect(backupDue(s, null, at('2026-10-16T20:00:00Z'))).toBe(false); // 01:30 IST
    expect(backupDue(s, null, at('2026-10-16T21:00:00Z'))).toBe(true); // 02:30 IST
    expect(backupDue(s, at('2026-10-16T20:45:00Z'), at('2026-10-16T23:00:00Z'))).toBe(false);
    expect(backupDue(s, at('2026-10-15T21:00:00Z'), at('2026-10-16T23:00:00Z'))).toBe(true);
    expect(backupDue({ ...s, enabled: false }, null, at('2026-10-16T23:00:00Z'))).toBe(false);
  });

  it('takes a backup, proves it by restoring it, keeps only so many, and exports the books for auditors', async () => {
    type Backup = {
      id: string;
      status: string;
      trigger: string;
      tables: number;
      rows: string;
      checkOk: boolean | null;
      checkNote: string | null;
    };
    type Overview = {
      settings: { enabled: boolean; hour: number; keep: number };
      canCheck: boolean;
      backups: Backup[];
    };
    // Something awkward to carry: a name with a quote, a comma and a line break.
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    await db`INSERT INTO platform.party (name, is_vendor) VALUES (${'Shree "Ganesh", Steel\nTraders'}, true)`;

    expect((await get('/tenant/backups', manager)).statusCode).toBe(403);
    expect((await post('/tenant/backups', {}, manager)).statusCode).toBe(403);
    const first = await ok<Overview>(get('/tenant/backups'));
    expect(first).toMatchObject({ settings: { enabled: true, hour: 2, keep: 14 }, canCheck: true });

    const taken = await ok<Overview>(post('/tenant/backups'));
    const b = taken.backups[0]!;
    expect(b).toMatchObject({ status: 'done', trigger: 'manual', checkOk: true });
    expect(b.checkNote).toMatch(/every table matched/);
    expect(b.tables).toBeGreaterThan(100);

    // The file reads back whole: the party is in it, sequences are carried, the trailer closes it.
    const file = await get(`/tenant/backups/${b.id}/file`);
    expect(file.statusCode).toBe(200);
    const events: Event[] = [];
    for await (const e of readBackup(Readable.from([gunzipSync(file.rawPayload)]))) events.push(e);
    const header = events[0] as Extract<Event, { kind: 'header' }>;
    expect(header.header.tenantId).toBe(t.tenantId);
    expect(header.header.migrations).toContain('0112_backup.sql');
    const party = Buffer.concat(
      events.flatMap((e) => (e.kind === 'chunk' && e.table === 'platform.party' ? [e.bytes] : [])),
    ).toString();
    expect(party).toContain('"Shree ""Ganesh"", Steel\nTraders"');
    expect(events.at(-1)!.kind).toBe('trailer');

    // A file changed on disk fails its check.
    const svc = app.get(BackupService);
    const [row] = await db<{ file_name: string }[]>`
      SELECT file_name FROM platform.backup WHERE id = ${b.id}`;
    const file_name = row!.file_name;
    await appendFile(join(backupDir, t.tenantId, file_name), 'x');
    const bad = await ok<Overview>(post(`/tenant/backups/${b.id}/check`));
    expect(bad.backups[0]).toMatchObject({ checkOk: false });
    expect(bad.backups[0]!.checkNote).toMatch(/changed since it was taken/);

    // Nightly: due after 02:00 IST, taken and checked, and only one kept.
    await ok(post('/tenant/backups/settings', { enabled: true, hour: 2, keep: 1 }));
    // A fixed 03:30 IST, so the test does not depend on the hour it runs at.
    expect(await svc.runDue(t.tenantId, new Date('2026-10-17T22:00:00Z'))).toBe(true);
    const after = await ok<Overview>(get('/tenant/backups'));
    expect(after.backups.map((x) => [x.trigger, x.status, x.checkOk])).toEqual([
      ['schedule', 'done', true],
    ]);

    // The audit export: the books and their records as CSV, a trial balance, never a password hash.
    const zip = await get('/tenant/audit-export?asOf=2026-10-17');
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const entries = unzip(zip.rawPayload);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        'README.txt',
        'acc/voucher.csv',
        'acc/voucher_line.csv',
        'platform/party.csv',
        'platform/users.csv',
        'platform/audit_log.csv',
      ]),
    );
    expect([...entries.keys()].some((k) => k.startsWith('trial-balance/'))).toBe(true);
    expect(entries.get('platform/users.csv')!.toString()).not.toMatch(/password|totp/);
    expect([...entries.keys()].some((k) => /session|idempotency|api_key|webhook/.test(k))).toBe(
      false,
    );
    expect((await get('/tenant/audit-export?asOf=2026-10-17', manager)).statusCode).toBe(403);
  }, 300_000);

  it('sends each person one morning digest: overdue, due this week, waiting on them, expiring', async () => {
    type Section = { title: string; lines: string[]; more: number };
    const svc = app.get(DigestService);
    const morning = new Date('2026-10-17T03:00:00Z'); // 08:30 IST
    const tender = (
      await ok<{ id: string }>(
        post('/tenant/tenders', { title: 'Bridge at Karanja', estimatedValue: '5000000' }),
      )
    ).id;
    await ok(post(`/tenant/tenders/${tender}/status`, { to: 'evaluating' }));
    await ok(
      post(`/tenant/tenders/${tender}/decision`, {
        criteria: DEFAULT_CRITERIA.map((c) => ({ key: c.key, weight: c.weight, score: 4 })),
        decision: 'bid',
      }),
    );
    await ok(
      post(`/tenant/tenders/${tender}/securities`, {
        form: 'bank_guarantee',
        amount: '50000',
        bank: 'State Bank of India, Washim',
        instrumentNo: 'BG/0077/26',
        issuedOn: '2026-09-01',
        validUntil: '2026-10-27',
        status: 'issued',
      }),
    );
    await ok(
      post('/tenant/reminders', { title: 'Renew the CAR policy', dueAt: '2026-10-16T05:00:00Z' }),
    );
    await ok(
      post('/tenant/reminders', { title: 'Site visit with the EE', dueAt: '2026-10-21T05:00:00Z' }),
    );

    // No address, no email; an address is needed to turn it on.
    expect(await svc.runDue(t.tenantId, morning)).toBe(0);
    expect((await post('/tenant/me/digest', { email: '', enabled: true })).json()).toMatchObject({
      code: 'email_needed',
    });
    const mine = await ok<{ email: string; enabled: boolean; preview: Section[] }>(
      post('/tenant/me/digest', { email: 'Accounts.Head@Example.in', enabled: true }),
    );
    expect(mine.email).toBe('accounts.head@example.in');

    // Not before 07:00 IST; then once a day.
    expect(await svc.runDue(t.tenantId, new Date('2026-10-17T00:30:00Z'))).toBe(0);
    expect(await svc.runDue(t.tenantId, morning)).toBe(1);
    expect(await svc.runDue(t.tenantId, morning)).toBe(0);
    const [mail] = await control<{ to_email: string; data: { sections: Section[] } }[]>`
      SELECT to_email, data FROM core.email_outbox WHERE template = 'daily_digest'
      ORDER BY created_at DESC LIMIT 1`;
    expect(mail!.to_email).toBe('accounts.head@example.in');
    const byTitle = new Map(mail!.data.sections.map((x) => [x.title, x.lines]));
    expect(byTitle.get('Overdue and due today')).toEqual(
      expect.arrayContaining([expect.stringContaining('Renew the CAR policy')]),
    );
    expect(byTitle.get('Coming up this week')).toEqual(
      expect.arrayContaining([expect.stringContaining('Site visit with the EE')]),
    );
    expect(byTitle.get('Expiring in 30 days, or lapsed')).toEqual([
      'Expires 27 Oct: EMD ₹50,000, Bridge at Karanja',
    ]);
    const email = renderEmail(
      { template: 'daily_digest', data: mail!.data as unknown as Record<string, unknown> },
      { productName: 'Aerolith Core', websiteUrl: 'https://app.example.in', supportEmail: null },
    );
    expect(email.subject).toMatch(/^Your day: \d+ things for 17 Oct$/);
    expect(email.text).toContain('  - Expires 27 Oct: EMD ₹50,000, Bridge at Karanja');
    expect(email.html).toContain('<li>Renew the CAR policy');

    // A worker with an address but nothing for them gets no email; turned off, none either.
    await ok(post('/tenant/me/digest', { email: 'raju@example.in', enabled: true }, worker));
    const next = new Date('2026-10-18T03:00:00Z');
    expect(await svc.runDue(t.tenantId, next)).toBe(1);
    const [raju] = await control<{ n: number }[]>`
      SELECT count(*)::int AS n FROM core.email_outbox WHERE to_email = 'raju@example.in'`;
    expect(raju!.n).toBe(0);
    await ok(post('/tenant/me/digest', { email: 'accounts.head@example.in', enabled: false }));
    expect(await svc.runDue(t.tenantId, new Date('2026-10-19T03:00:00Z'))).toBe(0);
  });

  it("custom roles replace a role's permissions; salaries and bank details stay hidden without the right to see them", async () => {
    type Profile = {
      id: string;
      name: string;
      permissions: string[];
      rowVersion: number;
      users: { name: string }[];
    };
    const users = await ok<{ id: string; username: string }[]>(get('/tenant/users'));
    const rajuId = users.find((u) => u.username === 'raju')!.id;
    const adminId = users.find(
      (u) => u.username !== 'raju' && u.username !== 'suresh' && u.username !== 'meena',
    )!.id;
    const mine = (h: Record<string, string>) => ok<string[]>(get('/tenant/permissions/mine', h));
    expect(await mine(worker)).toEqual(['documents.edit', 'stores.receive', 'attendance.mark']);

    // A vendor with a bank account: the worker sees only its last four digits.
    const party = await ok<{ id: string }>(
      post('/tenant/parties', {
        name: 'Kale Earthmovers',
        isVendor: true,
        bankAccountNo: '30112233445',
        bankIfsc: 'SBIN0001234',
      }),
    );
    const bankOf = async (h: Record<string, string>) =>
      (await ok<{ id: string; bankAccountNo: string | null }[]>(get('/tenant/parties', h))).find(
        (p) => p.id === party.id,
      )!.bankAccountNo;
    expect(await bankOf(worker)).toBe('•••••••3445');
    expect(await bankOf(t.admin)).toBe('30112233445');

    // Only admins keep profiles; a profile's permissions replace the worker's role's.
    expect(
      (
        await post(
          '/tenant/permissions/profiles',
          { name: 'Site accounts', permissions: [] },
          manager,
        )
      ).statusCode,
    ).toBe(403);
    let profiles = await ok<Profile[]>(
      post('/tenant/permissions/profiles', {
        name: 'Site accounts',
        description: 'Reads the books at site',
        permissions: ['accounts.view', 'sales.view', 'accounts.view'],
      }),
    );
    const site = profiles[0]!;
    expect(site.permissions).toEqual(['accounts.view', 'sales.view']);
    expect(
      (
        await post('/tenant/permissions/profiles', { name: 'site ACCOUNTS', permissions: [] })
      ).json(),
    ).toMatchObject({ code: 'name_taken' });
    expect(
      (
        await post('/tenant/permissions/profiles/assign', { userId: adminId, profileId: site.id })
      ).json(),
    ).toMatchObject({ code: 'admin_unlimited' });
    profiles = await ok<Profile[]>(
      post('/tenant/permissions/profiles/assign', { userId: rajuId, profileId: site.id }),
    );
    expect(profiles[0]!.users.map((u) => u.name)).toEqual(['raju']);
    expect(await mine(worker)).toEqual(['accounts.view', 'sales.view']);
    expect(await bankOf(worker)).toBe('30112233445');
    expect((await post(`/tenant/permissions/profiles/${site.id}/delete`)).json()).toMatchObject({
      code: 'profile_in_use',
    });

    // Edited, it changes at once; taken away, the role's permissions are back.
    await ok(
      post(`/tenant/permissions/profiles/${site.id}`, {
        name: 'Site accounts',
        permissions: ['accounts.view'],
        rowVersion: site.rowVersion,
      }),
    );
    expect(await mine(worker)).toEqual(['accounts.view']);
    expect(
      (
        await post(`/tenant/permissions/profiles/${site.id}`, {
          name: 'Site accounts',
          permissions: [],
          rowVersion: site.rowVersion,
        })
      ).json(),
    ).toMatchObject({ code: 'stale_row' });
    await ok(post('/tenant/permissions/profiles/assign', { userId: rajuId, profileId: null }));
    expect(await mine(worker)).toEqual(['documents.edit', 'stores.receive', 'attendance.mark']);
    expect(await ok<Profile[]>(post(`/tenant/permissions/profiles/${site.id}/delete`))).toEqual([]);

    // Seeing sales and payroll are permissions of their own, apart from changing them.
    const nowhere = '00000000-0000-4000-8000-000000000000';
    expect((await get(`/tenant/projects/${nowhere}/sales`, worker)).json()).toMatchObject({
      permission: 'sales.view',
    });
    expect((await get(`/tenant/payroll/runs?entityId=${nowhere}`, manager)).json()).toMatchObject({
      permission: 'payroll.view',
    });
    await ok(
      post('/tenant/permissions', { role: 'manager', permission: 'payroll.view', granted: true }),
    );
    expect((await get(`/tenant/payroll/runs?entityId=${nowhere}`, manager)).statusCode).not.toBe(
      403,
    );
    expect(
      (await post('/tenant/payroll/runs', { entityId: nowhere, month: '2026-09' }, manager)).json(),
    ).toMatchObject({ permission: 'payroll.run' });
    await ok(
      post('/tenant/permissions', { role: 'manager', permission: 'payroll.view', granted: false }),
    );
  });

  it('every account role resolves to an account in a new company (debug D-5)', async () => {
    const db = await app.get(TenantConnections).forTenant(t.tenantId);
    const keys = (
      await db<{ system_key: string }[]>`
      SELECT system_key FROM acc.account WHERE system_key IS NOT NULL`
    ).map((r) => r.system_key);
    const missing = Object.entries(ROLES)
      .filter(([, r]) => !keys.includes(r.key))
      .map(([role]) => role);
    expect(missing).toEqual([]);
  });

  it('the admin sets a staff email for the morning email (debug D-12)', async () => {
    const users = await ok<{ id: string; username: string; email: string | null }[]>(
      get('/tenant/users'),
    );
    const suresh = users.find((u) => u.username === 'suresh')!;
    expect(
      (await post(`/tenant/users/${suresh.id}/email`, { email: 'x@y.in' }, manager)).statusCode,
    ).toBe(403);
    expect(
      (await post(`/tenant/users/${suresh.id}/email`, { email: 'not an email' })).statusCode,
    ).toBe(400);
    await ok(post(`/tenant/users/${suresh.id}/email`, { email: ' Suresh.Patil@Example.in ' }));
    const after = await ok<{ id: string; email: string | null }[]>(get('/tenant/users'));
    expect(after.find((u) => u.id === suresh.id)!.email).toBe('suresh.patil@example.in');
    expect((await ok<{ email: string | null }>(get('/tenant/me/digest', manager))).email).toBe(
      'suresh.patil@example.in',
    );
    await ok(post(`/tenant/users/${suresh.id}/email`, { email: '' }));
  });
});
